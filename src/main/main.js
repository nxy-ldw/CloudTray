'use strict';
/**
 * main.js —— 应用入口
 *
 * 负责：数据目录解析、单实例、托盘、设置窗口、便签/待办、全部 IPC 路由。
 */

const fs = require('fs');
const path = require('path');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  shell,
  screen,
  clipboard,
  nativeTheme
} = require('electron');

const { Store, newId, pickEnum, clamp } = require('./store');
const { I18n, detectSystemLang } = require('./i18n');
const { Logger } = require('./logger');
const paths = require('./paths');
const shellInt = require('./shell');
const fsops = require('./fsops');
const grid = require('./grid');
const { WindowManager } = require('./wins');
const { StickyManager } = require('./stickies');
const { Updater } = require('./updater');
const { exportDiagnostics, defaultDiagnosticsName } = require('./diagnostics');

/* ------------------------------------------------------------------ *
 * 启动参数
 * ------------------------------------------------------------------ */

const argv = process.argv.slice(1);
function argValue(flag) {
  const idx = argv.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
  if (idx < 0) return null;
  const cur = argv[idx];
  if (cur.includes('=')) return cur.slice(cur.indexOf('=') + 1);
  return argv[idx + 1] !== undefined ? argv[idx + 1] : '';
}
const CLI_CREATE_ORGANIZER = argv.includes('--create-organizer') || argv.some((a) => a.startsWith('--create-organizer='));
const CLI_FOLDER_PATH = argValue('--create-organizer');
const CLI_PORTABLE = argv.includes('--portable');
const CLI_INSTALLED = argv.includes('--installed');

/* ------------------------------------------------------------------ *
 * 单实例
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/* ------------------------------------------------------------------ *
 * 全局上下文
 * ------------------------------------------------------------------ */

const ctx = {
  store: null,
  i18n: null,
  logger: null,
  manager: null,
  stickies: null,
  updater: null,
  settingsWin: null,
  tray: null,
  dataRoot: '',
  edition: '安装版',
  startTime: Date.now()
};

app.setAppUserModelId('com.cloudtray.desktop');
app.commandLine.appendSwitch('enable-features', 'WinrtClipboard');

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function isPortableEdition() {
  return ctx.edition === '便携版';
}

function t(key, params) {
  return ctx.i18n.t(key, params);
}

function broadcastSettingsChanged(section) {
  if (ctx.settingsWin && !ctx.settingsWin.isDestroyed()) {
    ctx.settingsWin.webContents.send('settings:changed', {
      section,
      config: ctx.store.data,
      strings: ctx.i18n.pack(ctx.store.data.system.language)
    });
  }
}

function notifyItemsChanged() {
  if (ctx.settingsWin && !ctx.settingsWin.isDestroyed()) {
    ctx.settingsWin.webContents.send('items:changed', {
      items: ctx.store.data.items,
      live: ctx.manager ? ctx.manager.describeLiveWindows() : []
    });
  }
}

/* ------------------------------------------------------------------ *
 * 便签 / 待办
 * ------------------------------------------------------------------ */

function createSticky(kind, options) {
  const opts = options || {};
  const name = ctx.store.uniqueName(opts.name || (kind === 'note' ? t('sticky.note') : t('sticky.todo')));
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const count = ctx.store.listItems(kind).length;
  const width = kind === 'note' ? 260 : 280;
  const height = kind === 'note' ? 240 : 300;
  const x = Math.round(wa.x + wa.width - width - 40 - (count % 6) * 28);
  const y = Math.round(wa.y + 60 + (count % 6) * 28);

  const item = ctx.store.addItem({
    kind,
    name,
    bounds: { x, y, width, height },
    storagePath: path.join(ctx.dataRoot, kind === 'note' ? 'notes' : 'todos')
  });
  ctx.stickies.create(item);
  notifyItemsChanged();
  return item;
}

/* ------------------------------------------------------------------ *
 * 收纳窗口创建
 * ------------------------------------------------------------------ */

function validateStorageCandidate(target, exceptId) {
  const reserved = [ctx.dataRoot, ctx.store.defaultStorageRoot(), paths.desktopDir()];
  const res = paths.validateStoragePath(target, reserved);
  if (!res.ok) return res;
  for (const it of ctx.store.data.items) {
    if (it.id === exceptId) continue;
    if (!it.storagePath) continue;
    if (paths.pathsOverlap(res.path, it.storagePath)) {
      return { ok: false, reason: 'overlap', other: it.name };
    }
  }
  return res;
}

function createOrganizer(spec) {
  const config = ctx.store.data;
  const kind = pickEnum(spec.kind, ['organizer', 'station', 'dock'], 'organizer');
  const base = kind === 'station' ? t('station.defaultName') : kind === 'dock' ? t('dock.defaultName') : t('org.defaultName');
  const name = ctx.store.uniqueName(String(spec.name || '').trim() || base);

  // 保存目录：显式指定 > 默认根目录下的同名文件夹
  let storagePath = spec.storagePath || '';
  if (!storagePath) {
    const root = ctx.store.effectiveStorageRoot();
    fs.mkdirSync(root, { recursive: true });
    storagePath = paths.uniqueDirName(root, name);
  }
  storagePath = path.resolve(storagePath);

  if (kind !== 'station') {
    const check = validateStorageCandidate(storagePath, null);
    if (!check.ok) {
      return { ok: false, reason: check.reason, other: check.other };
    }
  }

  fs.mkdirSync(storagePath, { recursive: true });

  const item = ctx.store.addItem({
    kind,
    name,
    storagePath,
    placement: kind === 'organizer' ? pickEnum(spec.placement, ['floating', 'positioned'], 'floating') : 'floating',
    expansion: pickEnum(spec.expansion, ['collapsible', 'alwaysExpanded'], 'collapsible'),
    contentMode: pickEnum(spec.contentMode, ['icon', 'compactList'], 'icon'),
    rows: clamp(spec.rows, 1, 12),
    columns: clamp(spec.columns, 1, 12),
    edge: pickEnum(spec.edge, ['left', 'top', 'right', 'bottom'], 'left'),
    orientation: pickEnum(spec.orientation, ['horizontal', 'vertical'], 'horizontal'),
    iconSize: clamp(spec.iconSize, 24, 96),
    spacing: clamp(spec.spacing, 0, 48),
    displayId: spec.displayId === undefined ? null : spec.displayId,
    bounds: spec.bounds || null
  });

  // 中转站同一边缘唯一
  if (kind === 'station') {
    const clash = ctx.store
      .listItems('station')
      .find((s) => s.id !== item.id && s.edge === item.edge && String(s.displayId) === String(item.displayId));
    if (clash) {
      ctx.store.removeItem(item.id);
      return { ok: false, reason: 'edgeOccupied' };
    }
  }

  const st = ctx.manager.create(item);
  if (spec.expansion === 'alwaysExpanded') {
    setTimeout(() => ctx.manager.setExpanded(item.id, true), 220);
  }
  void st;
  notifyItemsChanged();
  return { ok: true, item };
}

/** 从资源管理器右键菜单进入：把一个文件夹变成收纳窗 */
function createOrganizerFromFolder(folderPath) {
  if (!folderPath) return { ok: false, reason: 'noPath' };
  const resolved = path.resolve(folderPath);
  if (!fsops.dirExists(resolved)) return { ok: false, reason: 'missing' };

  const existing = ctx.store.data.items.find(
    (it) => it.storagePath && path.resolve(it.storagePath).toLowerCase() === resolved.toLowerCase()
  );
  if (existing) return { ok: false, reason: 'alreadyExists', item: existing };

  for (const it of ctx.store.data.items) {
    if (!it.storagePath) continue;
    if (paths.pathsOverlap(resolved, it.storagePath)) {
      return { ok: false, reason: 'overlap', item: it };
    }
  }

  const item = ctx.store.addItem({
    kind: 'organizer',
    name: ctx.store.uniqueName(path.basename(resolved) || t('org.defaultName')),
    storagePath: resolved,
    placement: 'floating',
    expansion: 'collapsible',
    contentMode: 'icon',
    rows: 3,
    columns: 4
  });
  ctx.manager.create(item);
  notifyItemsChanged();
  return { ok: true, item };
}

/* ------------------------------------------------------------------ *
 * 托盘
 * ------------------------------------------------------------------ */

function trayImage() {
  const candidates = [
    path.join(process.resourcesPath || '', 'assets', 'tray.png'),
    path.join(__dirname, '..', '..', 'assets', 'tray.png')
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const img = nativeImage.createFromPath(c);
        if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
      }
    } catch (_) {
      /* 继续尝试 */
    }
  }
  // 兜底：使用应用图标
  try {
    const ico = nativeImage.createFromPath(path.join(process.resourcesPath || '', 'assets', 'icon.png'));
    if (!ico.isEmpty()) return ico.resize({ width: 16, height: 16 });
  } catch (_) {
    /* 忽略 */
  }
  return nativeImage.createEmpty();
}

function buildTray() {
  const img = trayImage();
  if (img.isEmpty()) return;
  ctx.tray = new Tray(img);
  ctx.tray.setToolTip(t('app.name'));

  const rebuild = () => {
    if (!ctx.tray) return;
    const menu = Menu.buildFromTemplate([
      { label: t('tray.openConsole'), click: () => openSettings() },
      { type: 'separator' },
      { label: t('tray.newOrganizer'), click: () => createOrganizer({ kind: 'organizer' }) },
      { label: t('tray.showAll'), click: () => ctx.manager.showAll() },
      { label: t('tray.hideAll'), click: () => ctx.manager.hideAll() },
      { type: 'separator' },
      {
        label: t('system.startup'),
        type: 'checkbox',
        checked: ctx.store.data.system.launchAtStartup,
        click: (mi) => applyLaunchAtStartup(mi.checked)
      },
      { type: 'separator' },
      { label: t('tray.exit'), click: () => quitApp() }
    ]);
    ctx.tray.setContextMenu(menu);
  };

  rebuild();
  ctx.tray.on('double-click', () => openSettings());
  ctx.trayRebuild = rebuild;
}

/* ------------------------------------------------------------------ *
 * 设置窗口
 * ------------------------------------------------------------------ */

/**
 * 打开总控台
 * @param {string} [section] 直接定位到某个板块
 */
function openSettings(section) {
  if (ctx.settingsWin && !ctx.settingsWin.isDestroyed()) {
    ctx.settingsWin.show();
    ctx.settingsWin.focus();
    if (section) {
      ctx.settingsWin.webContents
        .executeJavaScript(
          `try{localStorage.setItem('tuckdesk.section', ${JSON.stringify(section)});location.reload();}catch(e){}`
        )
        .catch(() => {});
    }
    return;
  }

  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const width = Math.min(1120, Math.round(wa.width * 0.86));
  const height = Math.min(760, Math.round(wa.height * 0.88));

  ctx.settingsWin = new BrowserWindow({
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    minWidth: 880,
    minHeight: 560,
    frame: false,
    backgroundColor: '#00000000',
    transparent: false,
    roundedCorners: true,
    show: false,
    title: t('app.name'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  ctx.settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  ctx.settingsWin.webContents.on('console-message', (event) => {
    const level = typeof event.level === 'number' ? event.level : event.level;
    if (level === 'error' || level === 3 || level === 'warning' || level === 2) {
      ctx.logger.error('设置界面控制台', {
        level,
        message: event.message,
        line: event.lineNumber,
        source: event.sourceId
      });
    }
  });
  ctx.settingsWin.webContents.on('render-process-gone', (_e, details) => {
    ctx.logger.error('设置界面渲染进程异常', details.reason);
  });
  ctx.settingsWin.once('ready-to-show', () => ctx.settingsWin.show());
  ctx.settingsWin.on('closed', () => {
    ctx.settingsWin = null;
  });
}

/* ------------------------------------------------------------------ *
 * 系统集成应用
 * ------------------------------------------------------------------ */

async function applyLaunchAtStartup(enabled) {
  const exe = app.getPath('exe');
  const res = await shellInt.setLaunchAtStartup(enabled, exe, isPortableEdition() ? '--portable' : '--installed');
  if (res.ok) {
    ctx.store.patch('system', { launchAtStartup: enabled });
  } else {
    ctx.logger.error('开机启动设置失败', res.detail);
  }
  if (ctx.trayRebuild) ctx.trayRebuild();
  return res;
}

async function applyContextMenu(which, enabled) {
  const exe = app.getPath('exe');
  const res = await shellInt.setContextMenu(which, enabled, exe, {
    folder: t('system.menuCommand.folder'),
    desktop: t('system.menuCommand.desktop'),
    icon: `"${exe}",0`
  });
  if (res.ok) {
    ctx.store.patch('system', which === 'folder' ? { folderContextMenu: enabled } : { desktopContextMenu: enabled });
  } else {
    ctx.logger.error('右键菜单注册失败', { which, detail: res.detail });
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * 剪贴板
 * ------------------------------------------------------------------ */

function readClipboardFiles() {
  const out = [];
  try {
    const raw = clipboard.read('FileNameW');
    if (raw) {
      const cleaned = raw.replace(/\u0000+$/, '');
      for (const p of cleaned.split('\u0000')) {
        if (p && fs.existsSync(p)) out.push(p);
      }
    }
  } catch (_) {
    /* 非文件剪贴板 */
  }
  if (out.length === 0) {
    try {
      const raw = clipboard.read('FileName');
      if (raw) {
        for (const p of raw.split('\u0000')) {
          if (p && fs.existsSync(p)) out.push(p);
        }
      }
    } catch (_) {
      /* 忽略 */
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIpc() {
  /* ---------- 引导 ---------- */
  ipcMain.handle('app:bootstrap', async () => {
    const exe = app.getPath('exe');
    const [folderState, desktopState] = await Promise.all([
      shellInt.getContextMenuState('folder', exe),
      shellInt.getContextMenuState('desktop', exe)
    ]);

    return {
      version: app.getVersion(),
      name: t('app.name'),
      edition: ctx.edition,
      platform: process.platform,
      dataRoot: ctx.dataRoot,
      configPath: ctx.store.configPath,
      defaultStorageRoot: ctx.store.defaultStorageRoot(),
      effectiveStorageRoot: ctx.store.effectiveStorageRoot(),
      config: ctx.store.data,
      strings: ctx.i18n.pack(ctx.store.data.system.language),
      releases: ctx.updater ? ctx.updater.bundled().releases : [],
      languages: [
        { id: 'zh-CN', label: '简体中文' },
        { id: 'en-US', label: 'English' },
        { id: 'ja-JP', label: '日本語' }
      ],
      displays: screen.getAllDisplays().map((d, i) => ({
        id: d.id,
        index: i + 1,
        width: d.bounds.width,
        height: d.bounds.height,
        primary: d.id === screen.getPrimaryDisplay().id
      })),
      menuStates: { folder: folderState, desktop: desktopState },
      performanceProfiles: [
        { id: 'powerSaver', label: t('system.perf.powerSaver'), desc: t('system.perf.powerSaver.desc') },
        { id: 'balanced', label: t('system.perf.balanced'), desc: t('system.perf.balanced.desc') },
        { id: 'highPerformance', label: t('system.perf.highPerformance'), desc: t('system.perf.highPerformance.desc') }
      ]
    };
  });

  ipcMain.handle('app:setLanguage', (_e, lang) => {
    const next = ctx.i18n.setLanguage(lang);
    ctx.store.patch('system', { language: next });
    ctx.manager.broadcastAll();
    ctx.stickies.pushAll();
    if (ctx.trayRebuild) ctx.trayRebuild();
    return { ok: true, language: next, strings: ctx.i18n.pack(next) };
  });

  /* ---------- 设置读写 ---------- */
  ipcMain.handle('settings:patch', (_e, section, values) => {
    const allowed = ['system', 'display', 'contextMenu', 'interaction', 'theme', 'update'];
    if (!allowed.includes(section)) return { ok: false, error: 'bad section' };
    if (section === 'theme' && values && typeof values === 'object') {
      for (const key of Object.keys(values)) {
        if (!ctx.store.data.theme[key]) continue;
        const cur = ctx.store.data.theme[key];
        const inc = values[key] || {};
        ctx.store.data.theme[key] = {
          color: /^#[0-9a-fA-F]{6}$/.test(inc.color || '') ? inc.color.toUpperCase() : cur.color,
          mode: inc.mode === 'solid' || inc.mode === 'glass' ? inc.mode : cur.mode,
          opacity: inc.opacity === undefined ? cur.opacity : clamp(inc.opacity, 0, 1),
          blur: inc.blur === undefined ? cur.blur : Math.round(clamp(inc.blur, 0, 60))
        };
      }
      ctx.store.save();
    } else {
      ctx.store.patch(section, values || {});
    }

    if (section === 'display' || section === 'interaction') {
      ctx.manager.resizeAll();
      ctx.manager.broadcastAll();
      ctx.stickies.setAlwaysOnTop(ctx.store.data.display.noteAlwaysOnTop);
    }
    if (section === 'theme') {
      ctx.manager.reapplyThemeIfNeeded();
      ctx.manager.broadcastAll();
    }
    broadcastSettingsChanged(section);
    return { ok: true, config: ctx.store.data };
  });

  ipcMain.handle('settings:openPath', (_e, target) => {
    if (!target || !fs.existsSync(target)) return { ok: false };
    shell.openPath(target);
    return { ok: true };
  });

  ipcMain.handle('settings:revealPath', (_e, target) => {
    shell.showItemInFolder(target);
    return { ok: true };
  });

  ipcMain.handle('settings:pickFolder', async (_e, opts) => {
    const o = opts || {};
    const res = await dialog.showOpenDialog(ctx.settingsWin || undefined, {
      title: o.title || t('common.browse'),
      defaultPath: o.defaultPath || ctx.store.effectiveStorageRoot(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: o.buttonLabel || t('common.browse')
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, path: res.filePaths[0] };
  });

  ipcMain.handle('settings:setDefaultStorage', (_e, target) => {
    if (!target) {
      ctx.store.patch('system', { defaultStoragePath: '' });
      return { ok: true, path: ctx.store.defaultStorageRoot() };
    }
    const check = paths.validateStoragePath(target, [ctx.dataRoot, paths.desktopDir()]);
    if (!check.ok) return { ok: false, reason: check.reason };
    fs.mkdirSync(check.path, { recursive: true });
    ctx.store.patch('system', { defaultStoragePath: check.path });
    return { ok: true, path: check.path };
  });

  /* ---------- 诊断 ---------- */
  ipcMain.handle('settings:exportDiagnostics', async () => {
    const suggested = defaultDiagnosticsName();
    const res = await dialog.showSaveDialog(ctx.settingsWin || undefined, {
      title: t('system.diagnosticsExport'),
      defaultPath: path.join(paths.desktopDir(), suggested),
      filters: [{ name: 'ZIP', extensions: ['zip'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const out = await exportDiagnostics(
        {
          dataRoot: ctx.dataRoot,
          configPath: ctx.store.configPath,
          store: ctx.store,
          manager: ctx.manager,
          logger: ctx.logger,
          edition: ctx.edition,
          startTime: ctx.startTime
        },
        res.filePath
      );
      return out;
    } catch (err) {
      ctx.logger.error('诊断包导出失败', String(err.message || err));
      return { ok: false, error: String(err.message || err) };
    }
  });

  /* ---------- 右键菜单 / 启动 ---------- */
  ipcMain.handle('shell:setStartup', (_e, enabled) => applyLaunchAtStartup(!!enabled));
  ipcMain.handle('shell:setContextMenu', (_e, which, enabled) => applyContextMenu(which, !!enabled));
  ipcMain.handle('shell:menuStates', async () => ({
    folder: await shellInt.getContextMenuState('folder', app.getPath('exe')),
    desktop: await shellInt.getContextMenuState('desktop', app.getPath('exe'))
  }));

  /* ---------- 更新 ---------- */
  ipcMain.handle('update:check', async () => {
    const res = await ctx.updater.check(ctx.store.data.update.feedUrl || '');
    ctx.store.data.update.lastCheck = res.checkedAt;
    ctx.store.data.update.latestVersion = res.latest;
    ctx.store.data.update.lastStatus = res.status;
    const hit = (res.notes || []).find((n) => n.version === res.latest);
    ctx.store.data.update.latestNotes = hit ? hit.notes : [];
    ctx.store.save();
    broadcastSettingsChanged('update');
    return res;
  });

  /* ---------- 窗口条目 ---------- */
  ipcMain.handle('items:create', (_e, spec) => createOrganizer(spec || {}));

  ipcMain.handle('items:update', (_e, id, values) => {
    const item = ctx.store.updateItem(id, values || {});
    if (!item) return { ok: false };
    const st = ctx.manager.get(id);
    if (st) {
      ctx.manager.resizeAll();
      ctx.manager.pushState(id);
    }
    const sw = ctx.stickies.live.get(id);
    if (sw) ctx.stickies.pushState(id);
    notifyItemsChanged();
    return { ok: true, item };
  });

  /**
   * 删除收纳窗 / 中转站 / Dock 栏
   *
   * 保存目录里还有内容时先问用户怎么处理：整个文件夹移到桌面，或只删窗口、
   * 文件留在原路径。这样删除不会悄悄丢掉用户的文件。
   * @param {string} id
   * @param {{moveToDesktop?:boolean, silent?:boolean}} [options]
   */
  ipcMain.handle('items:delete', async (e, id, options) => {
    /* 对话框挂在发起删除的那个窗口上，避免弹到别的窗口后面 */
    const parent = BrowserWindow.fromWebContents(e.sender) || ctx.settingsWin || undefined;
    return deleteItem(id, options, parent);
  });

  ipcMain.handle('items:duplicate', (_e, id) => {
    const src = ctx.store.getItem(id);
    if (!src) return { ok: false };
    if (src.kind === 'station') return { ok: false, reason: 'noDuplicateStation' };
    if (src.kind === 'dock') {
      const copy = ctx.store.addItem({
        ...src,
        id: newId('dock'),
        name: ctx.store.uniqueName(`${src.name}${t('org.copySuffix')}`),
        bounds: src.bounds ? { ...src.bounds, x: src.bounds.x + 28, y: src.bounds.y + 28 } : null
      });
      ctx.manager.create(copy);
      notifyItemsChanged();
      return { ok: true, item: copy };
    }
    const base = ctx.store.effectiveStorageRoot();
    fs.mkdirSync(base, { recursive: true });
    const name = ctx.store.uniqueName(`${src.name}${t('org.copySuffix')}`);
    const dest = paths.uniqueDirName(base, name);
    try {
      fs.mkdirSync(dest, { recursive: true });
      if (src.storagePath && fsops.dirExists(src.storagePath)) {
        fs.cpSync(src.storagePath, dest, { recursive: true, errorOnExist: false, force: false });
      }
    } catch (err) {
      ctx.logger.error('复制收纳窗失败', String(err.message || err));
      return { ok: false, error: String(err.message || err) };
    }
    const copy = ctx.store.addItem({
      ...src,
      id: newId('organizer'),
      name,
      storagePath: dest,
      bounds: src.bounds ? { ...src.bounds, x: src.bounds.x + 28, y: src.bounds.y + 28 } : null,
      containedBy: null
    });
    ctx.manager.create(copy);
    notifyItemsChanged();
    return { ok: true, item: copy };
  });

  ipcMain.handle('items:openStorage', (_e, id) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false };
    if (!item.storagePath || !fsops.dirExists(item.storagePath)) {
      return { ok: false, reason: 'missing' };
    }
    shell.openPath(item.storagePath);
    return { ok: true };
  });

  ipcMain.handle('items:recreateStorage', (_e, id) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false };
    try {
      fs.mkdirSync(item.storagePath, { recursive: true });
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
    ctx.manager.pushState(id);
    notifyItemsChanged();
    return { ok: true };
  });

  ipcMain.handle('items:pickStorage', async (_e, opts) => {
    const o = opts || {};
    const res = await dialog.showOpenDialog(ctx.settingsWin || undefined, {
      title: t('org.pickStorage'),
      defaultPath: o.defaultPath || ctx.store.effectiveStorageRoot(),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: t('common.browse')
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const check = validateStorageCandidate(res.filePaths[0], o.exceptId);
    if (!check.ok) return { ok: false, reason: check.reason, other: check.other };
    return { ok: true, path: check.path };
  });

  ipcMain.handle('items:activate', (_e, id) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false };
    if (item.kind === 'note' || item.kind === 'todo') {
      ctx.stickies.create(item);
      return { ok: true };
    }
    if (!ctx.manager.get(id)) ctx.manager.create(item);
    const st = ctx.manager.get(id);
    if (st) st.win.showInactive();
    ctx.store.updateItem(id, { visible: true });
    notifyItemsChanged();
    return { ok: true };
  });

  ipcMain.handle('stickies:create', (_e, kind, options) => ({ ok: true, item: createSticky(kind, options) }));
  ipcMain.handle('stickies:save', (_e, id, data) => ctx.stickies.save(id, data));
  ipcMain.handle('stickies:close', (_e, id) => {
    ctx.stickies.close(id);
    return { ok: true };
  });
  ipcMain.handle('stickies:get', (_e, id) => {
    const item = ctx.store.getItem(id);
    if (!item) return null;
    return {
      item,
      content: ctx.stickies.readContent(item),
      strings: ctx.i18n.pack(ctx.store.data.system.language),
      alwaysOnTop: ctx.store.data.display.noteAlwaysOnTop
    };
  });

  /* ---------- 表面窗口（收纳窗/中转站/Dock） ---------- */
  ipcMain.handle('surface:init', (_e, id) => ctx.manager.context(id));

  ipcMain.handle('surface:setExpanded', (_e, id, expanded) => {
    ctx.manager.setExpanded(id, !!expanded);
    return { ok: true };
  });

  ipcMain.handle('surface:itemsCount', (_e, id, count) => ctx.manager.setItemCount(id, count));

  ipcMain.handle('surface:dragStart', (_e, id) => ctx.manager.beginDrag(id));
  ipcMain.handle('surface:dragEnd', (_e, id) => ctx.manager.endDrag(id));

  ipcMain.handle('surface:list', async (_e, id, options) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false, items: [] };
    const res = await fsops.listDirectory(item.storagePath, options || {});
    if (!res.ok) {
      ctx.logger.warn('读取收纳目录失败', { id, dir: item.storagePath, error: res.error });
      return res;
    }
    const iconPaths = res.items.slice(0, 400).map((i) => i.path);
    const icons = await fsops.getIcons(iconPaths, 'normal');
    return { ...res, icons };
  });

  ipcMain.handle('surface:open', async (_e, target) => {
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) {
        const res = await fsops.openPath(target);
        return res;
      }
      const res = await fsops.openPath(target);
      if (!res.ok) ctx.logger.warn('打开失败', { target, error: res.error });
      return res;
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('surface:reveal', (_e, target) => fsops.revealPath(target));

  ipcMain.handle('surface:trash', async (_e, targets) => {
    const res = await fsops.trash(targets || []);
    if (!res.ok) ctx.logger.warn('删除到回收站失败', res.failures);
    return res;
  });

  ipcMain.handle('surface:createFolder', (_e, id, name) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false, reason: 'missing' };
    return fsops.createFolder(item.storagePath, name || t('ctx.newFolder'));
  });

  ipcMain.handle('surface:rename', (_e, target, newName) => fsops.rename(target, newName));

  ipcMain.handle('surface:import', (_e, id, sources, mode) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false, reason: 'missing' };
    return fsops.importEntries(sources || [], item.storagePath, mode === 'copy' ? 'copy' : 'move');
  });

  ipcMain.handle('surface:addViaDialog', async (_e, id, kind) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false, reason: 'missing' };
    const res = await dialog.showOpenDialog(ctx.settingsWin || undefined, {
      title: kind === 'folder' ? t('ctx.addFolder') : t('ctx.addFile'),
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const out = await fsops.importEntries(res.filePaths, item.storagePath, 'move');
    return out;
  });

  ipcMain.handle('surface:paste', async (_e, id, mode) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false, reason: 'missing' };
    const files = readClipboardFiles();
    if (files.length) {
      const out = await fsops.importEntries(files, item.storagePath, mode === 'copy' ? 'copy' : 'move');
      return { ...out, kind: 'files' };
    }
    const img = clipboard.readImage();
    if (img && !img.isEmpty()) {
      const name = `粘贴的图片 ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
      const res = await fsops.createFile(item.storagePath, name, img.toPNG());
      return { ok: res.ok, kind: 'image', created: res };
    }
    const text = clipboard.readText();
    if (text) {
      const res = await fsops.createFile(item.storagePath, `粘贴的文本 ${Date.now()}.txt`, text);
      return { ok: res.ok, kind: 'text', created: res };
    }
    return { ok: false, reason: 'empty' };
  });

  ipcMain.handle('surface:setName', (_e, id, name) => {
    const clean = String(name || '').trim();
    if (!clean) return { ok: false, reason: 'empty' };
    const item = ctx.store.updateItem(id, { name: clean });
    ctx.manager.pushState(id);
    notifyItemsChanged();
    return { ok: true, item };
  });

  ipcMain.handle('surface:toggleNameHidden', (_e, id) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false };
    const next = !item.nameHidden;
    ctx.store.updateItem(id, { nameHidden: next });
    ctx.manager.resizeAll();
    ctx.manager.pushState(id);
    notifyItemsChanged();
    return { ok: true, nameHidden: next };
  });

  ipcMain.handle('surface:thumbnail', (_e, target, size) => fsops.getThumbnail(target, size || 64));

  ipcMain.handle('surface:copyText', (_e, text) => {
    clipboard.writeText(String(text === undefined || text === null ? '' : text));
    return { ok: true };
  });

  /* 把项目拖出到资源管理器 */
  ipcMain.on('surface:startDrag', async (e, target) => {
    if (!target) return;
    try {
      let icon = await app.getFileIcon(target, { size: 'normal' });
      if (!icon || icon.isEmpty()) {
        icon = nativeImage.createFromPath(path.join(process.resourcesPath || '', 'assets', 'icon.png'));
      }
      e.sender.startDrag({ file: target, icon });
    } catch (err) {
      ctx.logger.warn('启动拖动失败', { target, error: String(err.message || err) });
    }
  });

  ipcMain.handle('surface:menu', (_e, id, target) => {
    const item = ctx.store.getItem(id);
    if (!item) return { ok: false };
    const cm = ctx.store.data.contextMenu;
    const template = [];

    /* 针对具体项目的操作 */
    if (target) {
      template.push({ label: t('common.open'), click: () => shell.openPath(target) });
      template.push({ label: t('ctx.reveal'), click: () => shell.showItemInFolder(target) });
      template.push({
        label: t('common.rename'),
        click: () => askRenderer(id, { cmd: 'menu:renameItem', target })
      });
      template.push({
        label: t('ctx.copyFile'),
        click: () => askRenderer(id, { cmd: 'menu:copyItem', target })
      });
      template.push({ type: 'separator' });
      template.push({
        label: t('common.delete'),
        click: () => askRenderer(id, { cmd: 'menu:trashItem', target })
      });
      template.push({ type: 'separator' });
    }

    if (item.kind === 'organizer') {
      if (cm.addItem) {
        template.push({
          label: t('ctx.addItem'),
          submenu: [
            { label: t('ctx.addFile'), click: () => openAddDialog(id, 'file') },
            { label: t('ctx.addFolder'), click: () => openAddDialog(id, 'folder') }
          ]
        });
      }
      if (cm.newFolder) template.push({ label: t('ctx.newFolder'), click: () => askRenderer(id, 'menu:newFolder') });
      if (cm.newNote) template.push({ label: t('ctx.newNote'), click: () => createSticky('note') });
      if (cm.newTodo) template.push({ label: t('ctx.newTodo'), click: () => createSticky('todo') });
      if (cm.paste) template.push({ label: t('ctx.paste'), click: () => askRenderer(id, 'menu:paste') });
    }

    const windowOps = [];
    if (cm.rename) windowOps.push({ label: t('ctx.rename'), click: () => askRenderer(id, 'menu:renameWindow') });
    if (cm.duplicate && item.kind !== 'station') {
      windowOps.push({ label: t('ctx.duplicate'), click: () => askRenderer(id, 'menu:duplicate') });
    }
    if (cm.togglePlacement && item.kind === 'organizer') {
      windowOps.push({
        label: `${t('ctx.togglePlacement')}（${item.placement === 'floating' ? t('org.mode.floating') : t('org.mode.positioned')}）`,
        click: () => askRenderer(id, 'menu:togglePlacement')
      });
    }
    if (cm.toggleContent && item.kind !== 'dock') {
      windowOps.push({
        label: `${t('ctx.toggleContent')}（${item.contentMode === 'icon' ? t('ctx.contentIcon') : t('ctx.contentCompact')}）`,
        click: () => askRenderer(id, 'menu:toggleContent')
      });
    }
    if (cm.toggleExpansion && item.kind !== 'dock') {
      windowOps.push({
        label: `${t('ctx.toggleExpansion')}（${item.expansion === 'collapsible' ? t('org.expansion.collapsible') : t('org.expansion.alwaysExpanded')}）`,
        click: () => askRenderer(id, 'menu:toggleExpansion')
      });
    }
    if (cm.hideName) {
      windowOps.push({
        label: t('ctx.hideName'),
        type: 'checkbox',
        checked: !!item.nameHidden,
        click: () => askRenderer(id, 'menu:toggleNameHidden')
      });
    }
    if (windowOps.length) {
      if (template.length) template.push({ type: 'separator' });
      template.push(...windowOps);
    }

    const tail = [];
    if (cm.openStorage) tail.push({ label: t('ctx.openStorage'), click: () => askRenderer(id, 'menu:openStorage') });
    if (cm.settings) tail.push({ label: t('ctx.settings'), click: () => openSettings() });
    if (cm.remove) tail.push({ label: t('ctx.remove'), click: () => askRenderer(id, 'menu:deleteWindow') });
    if (tail.length) {
      if (template.length) template.push({ type: 'separator' });
      template.push(...tail);
    }

    const win = ctx.manager.get(id);
    if (!win) return { ok: false };
    Menu.buildFromTemplate(template).popup({ window: win.win });
    return { ok: true };
  });

  /* ---------- 设置窗口按钮 ---------- */
  ipcMain.handle('win:minimize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.minimize();
  });
  ipcMain.handle('win:close', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.close();
  });
  ipcMain.handle('app:quit', () => quitApp());
  ipcMain.handle('app:openSettings', () => openSettings());
  ipcMain.handle('app:showAbout', () => {
    dialog.showMessageBox(ctx.settingsWin || undefined, {
      type: 'info',
      title: t('app.name'),
      message: `${t('app.name')} ${app.getVersion()}`,
      detail: `${t('app.tagline')}\n\n${t('about.dataRoot')}：${ctx.dataRoot}\n${t('update.edition')}：${ctx.edition}`,
      buttons: [t('common.confirm')]
    });
  });
}

function askRenderer(id, command) {
  const st = ctx.manager.get(id);
  if (st && st.ready) st.win.webContents.send('surface:command', command);
}
async function openAddDialog(id, kind) {
  const item = ctx.store.getItem(id);
  if (!item) return;
  const res = await dialog.showOpenDialog(ctx.settingsWin || undefined, {
    title: kind === 'folder' ? t('ctx.addFolder') : t('ctx.addFile'),
    properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
  });
  if (res.canceled || !res.filePaths.length) return;
  await fsops.importEntries(res.filePaths, item.storagePath, 'move');
  const st = ctx.manager.get(id);
  if (st && st.ready) st.win.webContents.send('surface:refresh');
}

/**
 * 删除收纳窗 / 中转站 / Dock 栏
 *
 * 保存目录里还有内容时先问用户怎么处理：整个文件夹移到桌面，或只删窗口、
 * 文件留在原路径。这样删除不会悄悄丢掉用户的文件。
 *
 * @param {string} id
 * @param {{moveToDesktop?:boolean, silent?:boolean}} [options]
 * @param {Electron.BrowserWindow} [parent] 对话框的父窗口
 */
async function deleteItem(id, options, parent) {
  const item = ctx.store.getItem(id);
  if (!item) return { ok: false, reason: 'missing' };
  const opts = options || {};

  const dir = item.storagePath;
  const hasDir = Boolean(dir) && fsops.dirExists(dir);
  const count = hasDir ? await fsops.countEntries(dir) : 0;
  let moveToDesktop = opts.moveToDesktop === true;

  if (hasDir && count > 0 && !opts.silent) {
    const res = await dialog.showMessageBox(parent || undefined, {
      type: 'question',
      noLink: true,
      buttons: [t('delete.moveToDesktop'), t('delete.keepFiles'), t('common.cancel')],
      defaultId: 0,
      cancelId: 2,
      message: t('delete.title', item.name),
      detail: t('delete.message', [path.basename(dir), count])
    });
    if (res.response === 2) return { ok: false, canceled: true };
    moveToDesktop = res.response === 0;
  }

  let movedTo = null;
  let sourceRetained = false;
  if (hasDir && count > 0 && moveToDesktop) {
    const moved = await fsops.moveEntry(dir, paths.desktopDir());
    if (!moved.ok) {
      ctx.logger.error('删除窗口时移动到桌面失败', { id, dir, reason: moved.reason });
      // 文件没能安全转移就保留窗口，避免用户以为文件已经在桌面上了
      return { ok: false, reason: 'moveFailed', message: t('delete.moveFailed') };
    }
    movedTo = moved.path;
    sourceRetained = moved.sourceRetained === true;
    if (sourceRetained) ctx.logger.warn('内容已复制到桌面，但原目录未能删除', { id, dir, movedTo });
  }

  ctx.manager.destroy(id);
  ctx.store.removeItem(id);
  notifyItemsChanged();

  let message;
  if (!hasDir || count === 0) message = t('delete.doneEmpty', item.name);
  else if (movedTo) message = t('delete.doneMoved', item.name);
  else message = t('delete.doneKept', item.name);
  if (sourceRetained) message += ` ${t('delete.sourceRetained')}`;

  return { ok: true, movedTo, message };
}

/* ------------------------------------------------------------------ *
 * 退出
 * ------------------------------------------------------------------ */

function quitApp() {
  ctx.manager.quitting = true;
  ctx.stickies.quitting = true;
  ctx.manager.destroyAll();
  ctx.stickies.destroyAll();
  if (ctx.tray) {
    ctx.tray.destroy();
    ctx.tray = null;
  }
  app.quit();
}

/* ------------------------------------------------------------------ *
 * 启动流程
 * ------------------------------------------------------------------ */

app.on('second-instance', (_e, commandLine) => {
  const idx = commandLine.findIndex((a) => a === '--create-organizer');
  if (idx >= 0 && commandLine[idx + 1]) {
    createOrganizerFromFolder(commandLine[idx + 1]);
  }
  openSettings();
});

app.on('window-all-closed', (e) => {
  // 托盘常驻，不随窗口关闭而退出
  e.preventDefault();
});

app.whenReady().then(async () => {
  /* 数据目录 */
  const exeDir = path.dirname(app.getPath('exe'));
  const forceMode = CLI_PORTABLE ? 'portable' : CLI_INSTALLED ? 'installed' : undefined;
  ctx.dataRoot = paths.resolveDataRoot({
    exeDir,
    userDataDir: app.getPath('userData'),
    isPackaged: app.isPackaged,
    forceMode
  });
  fs.mkdirSync(ctx.dataRoot, { recursive: true });
  ctx.edition = ctx.dataRoot.startsWith(exeDir) ? '便携版' : '安装版';

  /* 从旧名字（收纳桌面 / TuckDesk）的数据目录迁移，避免改名后设置与内容丢失 */
  if (ctx.edition === '安装版') {
    const appData = app.getPath('appData');
    const migrated = paths.migrateLegacyData(ctx.dataRoot, [
      path.join(appData, '收纳桌面'),
      path.join(appData, 'tuckdesk'),
      path.join(appData, 'TuckDesk')
    ]);
    ctx.migratedFrom = migrated;
  }

  ctx.logger = new Logger(path.join(ctx.dataRoot, 'logs'));
  if (ctx.migratedFrom) {
    ctx.logger.info('已从旧数据目录迁移', { from: ctx.migratedFrom, to: ctx.dataRoot });
  }
  ctx.store = new Store(ctx.dataRoot);
  ctx.store.load();

  if (!ctx.store.data.system.language || ctx.store.data.system.language === 'zh-CN') {
    // 首次运行按系统语言初始化
    if (!fs.existsSync(ctx.store.configPath)) {
      ctx.store.data.system.language = detectSystemLang();
      ctx.store.save();
    }
  }

  ctx.i18n = new I18n(ctx.store.data.system.language);

  ctx.manager = new WindowManager({
    store: ctx.store,
    i18n: ctx.i18n,
    logger: ctx.logger,
    onRequestSettings: openSettings,
    onItemsChanged: notifyItemsChanged
  });

  ctx.stickies = new StickyManager({
    store: ctx.store,
    i18n: ctx.i18n,
    logger: ctx.logger,
    dataRoot: ctx.dataRoot,
    onItemsChanged: notifyItemsChanged
  });

  ctx.updater = new Updater({
    currentVersion: app.getVersion(),
    bundledFeedPath: app.isPackaged
      ? path.join(process.resourcesPath, 'update-feed.json')
      : path.join(__dirname, '..', '..', 'resources', 'update-feed.json'),
    logger: ctx.logger
  });

  registerIpc();

  /* 性能档位影响后台检查频率 */
  const profile = ctx.store.data.system.performanceProfile;
  if (profile === 'powerSaver') {
    app.commandLine.appendSwitch('disable-renderer-backgrounding', 'false');
  }

  /* 恢复窗口 */
  ctx.manager.restoreAll();
  ctx.stickies.restoreAll();

  buildTray();

  /* 写入安装信息，方便诊断 */
  shellInt.writeAppRegistration(app.getPath('exe'), app.getVersion()).catch(() => {});

  /* 资源管理器右键菜单进入 */
  if (CLI_CREATE_ORGANIZER) {
    const result = createOrganizerFromFolder(CLI_FOLDER_PATH);
    if (!result.ok && CLI_FOLDER_PATH) {
      const key =
        result.reason === 'alreadyExists'
          ? 'org.menuAlready'
          : result.reason === 'overlap'
            ? 'org.menuOverlap'
            : 'org.menuFailed';
      dialog.showMessageBox({
        type: 'warning',
        title: t('app.name'),
        message: t(key),
        detail: CLI_FOLDER_PATH,
        buttons: [t('common.confirm')]
      });
    }
  } else if (ctx.store.data.items.length === 0) {
    /* 首次运行：建一个示例收纳窗并打开总控台 */
    const root = ctx.store.effectiveStorageRoot();
    fs.mkdirSync(root, { recursive: true });
    createOrganizer({ kind: 'organizer', name: t('org.defaultName'), rows: 3, columns: 4 });
  }

  openSettings();

  /* 自动检查更新 */
  if (ctx.store.data.update.autoCheck) {
    const last = ctx.store.data.update.lastCheck ? Date.parse(ctx.store.data.update.lastCheck) : 0;
    if (Date.now() - last > 24 * 3600 * 1000) {
      setTimeout(() => {
        ctx.updater
          .check(ctx.store.data.update.feedUrl || '')
          .then((res) => {
            ctx.store.data.update.lastCheck = res.checkedAt;
            ctx.store.data.update.latestVersion = res.latest;
            ctx.store.data.update.lastStatus = res.status;
            ctx.store.save();
            broadcastSettingsChanged('update');
          })
          .catch(() => {});
      }, 6000);
    }
  }

  nativeTheme.on('updated', () => ctx.manager.broadcastAll());
});

process.on('uncaughtException', (err) => {
  if (ctx.logger) ctx.logger.error('未捕获异常', String((err && err.stack) || err));
});

process.on('unhandledRejection', (reason) => {
  if (ctx.logger) ctx.logger.error('未处理的 Promise 拒绝', String(reason));
});

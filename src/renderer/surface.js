'use strict';
/**
 * surface.js —— 收纳窗 / 中转站 / Dock 栏 的行为
 *
 * 同一个页面通过 ?kind= 与 ?id= 区分形态，全部外观由主题设置驱动。
 */

/* el / ico / hexToRgb 等来自 common/ui.js（在页面脚本之前加载） */

const params = new URLSearchParams(location.search);
const KIND = params.get('kind') || 'organizer';
const ID = params.get('id') || '';

const dom = {
  entryIcon: document.getElementById('entry-icon'),
  entryName: document.getElementById('entry-name'),
  entryCount: document.getElementById('entry-count'),
  dockStrip: document.getElementById('dock-strip'),
  dockHint: document.getElementById('dock-hint'),
  panelTitle: document.getElementById('panel-title'),
  panelBody: document.getElementById('panel-body'),
  btnCollapse: document.getElementById('btn-collapse'),
  btnSettings: document.getElementById('btn-settings'),
  toast: document.getElementById('toast')
};

let state = null;
let entries = [];
let icons = {};
let expanded = false;
let hoverTimer = null;
let leaveTimer = null;
let dragging = false;
let dragMoved = false;
let dragStart = { x: 0, y: 0 };
let ctxTarget = null;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function T(key, p1, p2) {
  const pack = (state && state.strings) || {};
  let text = pack[key];
  if (text === undefined) return key;
  const ps = [p1, p2];
  return String(text).replace(/\{(\d)\}/g, (m, i) => (ps[Number(i)] !== undefined ? String(ps[Number(i)]) : m));
}

let toastTimer = null;
function say(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 2600);
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 无系统图标时用首字母色块兜底 */
function letterTile(name) {
  const ch = (String(name || '?').trim()[0] || '?').toUpperCase();
  const palette = ['#2563EB', '#7C3AED', '#DB2777', '#DC2626', '#EA580C', '#CA8A04', '#16A34A', '#0891B2'];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const bg = palette[hash % palette.length];
  return el('div', { class: 'tile-letter', style: { background: bg }, text: ch });
}

function iconNode(entry, size) {
  const dataUrl = icons[entry.path];
  if (dataUrl) {
    return el('img', { src: dataUrl, alt: '', draggable: 'false' });
  }
  if (entry.isDir) {
    const wrap = el('div', { class: 'tile-letter', style: { background: 'var(--surface-accent)' } });
    wrap.appendChild(ico('folder', size || 18));
    return wrap;
  }
  return letterTile(entry.name);
}

/* ------------------------------------------------------------------ *
 * 外观
 * ------------------------------------------------------------------ */

function applyAppearance() {
  if (!state) return;
  const themeKey = KIND === 'organizer' ? 'organizer' : KIND;
  const t = state.config.theme[themeKey] || state.config.theme.organizer;
  const d = state.config.display;

  const body = document.body;
  body.className = '';
  body.classList.add(`kind-${KIND}`);
  body.classList.add(`mode-${t.mode}`);
  /* 展开/收缩由状态机维护，这里必须保留，否则重绘外观会把面板一起抹掉 */
  body.classList.toggle('expanded', expanded);
  body.classList.toggle('collapsed', !expanded);

  const light = luminance(t.color) > 0.62;
  const fg = light ? 'rgba(17,24,39,0.94)' : 'rgba(255,255,255,0.96)';
  const accentFg = t.color;

  /* 玻璃模式下，模糊强度越高 → 底色越淡 → 磨砂越明显 */
  const blurFactor = t.mode === 'glass' ? 1 - (t.blur / 60) * 0.4 : 1;
  const alpha = Math.max(0, Math.min(1, t.opacity * blurFactor));
  const borderAlpha = Math.min(0.5, 0.14 + alpha * 0.16);

  const root = document.documentElement.style;
  root.setProperty('--surface-bg', `rgba(${hexToRgb(t.color).r},${hexToRgb(t.color).g},${hexToRgb(t.color).b},${alpha})`);
  root.setProperty('--surface-fg', fg);
  root.setProperty('--surface-accent', light ? '#1D4ED8' : '#FFFFFF');
  root.setProperty('--surface-accent-soft', light ? 'rgba(29,78,216,.16)' : 'rgba(255,255,255,.18)');
  root.setProperty('--surface-hover', light ? 'rgba(17,24,39,.09)' : 'rgba(255,255,255,.16)');
  root.setProperty('--surface-border', light ? `rgba(17,24,39,${borderAlpha})` : `rgba(255,255,255,${borderAlpha})`);
  root.setProperty('--surface-shadow', '0 6px 26px rgba(15,23,42,.24)');
  root.setProperty('--surface-blur', t.mode === 'glass' ? `blur(${Math.round((t.blur / 60) * 22)}px) saturate(140%)` : 'none');
  root.setProperty('--surface-sheen', t.mode === 'glass' ? '1' : '0');
  void accentFg;

  /* 尺寸相关 */
  const item = state.item;
  const entryIcon = KIND === 'organizer' ? Math.round(34 * (d.uniformEntrySize || 1)) : 30;
  root.setProperty('--entry-icon', `${entryIcon}px`);
  root.setProperty('--entry-name-size', `${Math.round(12 * (d.compactNameScale || 0.9) * (d.uniformEntrySize || 1))}px`);
  root.setProperty('--expanded-name-size', `${Math.round(13 * (d.expandedNameScale || 1))}px`);
  root.setProperty('--tile-icon', `${Math.round((item.contentMode === 'icon' ? 36 : 16) * (item.itemScale || 1))}px`);
  root.setProperty('--row-h', `${Math.round(30 * (item.canvasScale || 1) * (item.itemScale || 1))}px`);
  root.setProperty('--cols', String(item.columns || 4));
  root.setProperty('--dock-icon', `${item.iconSize || 44}px`);
  root.setProperty('--dock-gap', `${item.spacing === undefined ? 10 : item.spacing}px`);
  root.setProperty('--radius-surface', KIND === 'dock' ? '16px' : '14px');
  root.setProperty('--magnify', String(d.compactHoverMagnification ? state.config.interaction.hoverMagnificationScale : 1));

  body.classList.toggle('hide-collapse', !!d.hideCollapseIndicator);
  body.classList.toggle('no-count', !d.showItemCount);
  body.classList.toggle('name-hidden', !!item.nameHidden);
  body.classList.toggle('edge-glow', !!d.edgeGlow && KIND === 'organizer');
  body.classList.toggle('hover-magnify', !!state.config.interaction.compactHoverMagnification);
  body.classList.toggle('dock-magnify', !!state.config.interaction.dockHoverMagnification);
  body.classList.toggle('vertical', item.orientation === 'vertical');
  if (KIND === 'station') {
    body.classList.add(`edge-${item.edge}`);
  }

  document.title = item.name;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function renderEntry() {
  const item = state.item;
  dom.entryIcon.textContent = '';
  if (KIND === 'dock') return;

  if (entries.length > 0 && KIND === 'organizer' && icons[entries[0].path]) {
    // 用第一个项目的图标作为入口标识，更直观
    const img = el('img', { src: icons[entries[0].path], alt: '', draggable: 'false' });
    dom.entryIcon.appendChild(img);
  } else {
    dom.entryIcon.appendChild(ico(KIND === 'station' ? 'station' : 'organizer', 30));
  }
  dom.entryName.textContent = item.name;
  dom.entryCount.textContent = String(entries.length);
  dom.entryCount.style.display = entries.length ? '' : 'none';
}

function renderPanel() {
  const item = state.item;
  dom.panelTitle.textContent = '';
  dom.panelTitle.appendChild(document.createTextNode(item.name));
  dom.panelTitle.appendChild(el('span', { class: 'cnt', text: T('org.count', entries.length) }));

  dom.panelBody.textContent = '';

  if (!state.storageExists) {
    dom.panelBody.appendChild(el('div', { class: 'empty-hint', text: T('org.missing') }));
    return;
  }
  if (entries.length === 0) {
    dom.panelBody.appendChild(el('div', { class: 'empty-hint', text: T('dock.emptyHint') }));
    return;
  }

  if (item.contentMode === 'compactList' || KIND === 'station') {
    const list = el('div', { class: 'list' });
    entries.forEach((entry) => list.appendChild(renderRow(entry)));
    dom.panelBody.appendChild(list);
  } else {
    const grid = el('div', { class: 'grid' });
    entries.forEach((entry) => grid.appendChild(renderTile(entry)));
    dom.panelBody.appendChild(grid);
  }
}

function bindItemEvents(node, entry) {
  node.addEventListener('dblclick', () => openEntry(entry));
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctxTarget = entry;
    window.tuck.surface.nativeMenu(ID, entry.path);
  });
  node.addEventListener('dragstart', (e) => {
    e.preventDefault();
    window.tuck.surface.startDrag(entry.path);
  });
  node.draggable = true;
}

function renderTile(entry) {
  const node = el('div', { class: 'tile', title: entry.name }, [
    el('div', { class: 'tile-img' }, [iconNode(entry, 22)]),
    el('div', { class: 'tile-name', text: entry.name })
  ]);
  bindItemEvents(node, entry);
  return node;
}

function renderRow(entry) {
  const node = el('div', { class: 'row-item', title: entry.name }, [
    el('div', { class: 'ri' }, [iconNode(entry, 14)]),
    el('div', { class: 'rn', text: entry.name }),
    el('div', { class: 'rs', text: entry.isDir ? '' : formatSize(entry.size) })
  ]);
  bindItemEvents(node, entry);
  return node;
}

function renderDock() {
  const strip = dom.dockStrip;
  [...strip.querySelectorAll('.dock-item, .dock-empty')].forEach((n) => n.remove());
  if (entries.length === 0) {
    strip.appendChild(el('div', { class: 'dock-empty', text: T('dock.emptyHint') }));
    return;
  }
  entries.forEach((entry) => {
    const node = el('div', { class: 'dock-item', title: entry.name }, [iconNode(entry, 26)]);
    bindItemEvents(node, entry);
    strip.appendChild(node);
  });
}

/* ------------------------------------------------------------------ *
 * 数据
 * ------------------------------------------------------------------ */

async function refresh() {
  if (!state) return;
  const res = await window.tuck.surface.list(ID, { sort: 'name' });
  if (res && res.ok) {
    entries = res.items || [];
    icons = res.icons || {};
    state.storageExists = res.dirExists !== false;
  } else {
    entries = [];
    icons = {};
    state.storageExists = false;
  }
  renderEntry();
  if (expanded) renderPanel();
  renderDock();
  window.tuck.surface.reportCount(ID, entries.length);
}

/* ------------------------------------------------------------------ *
 * 展开 / 收缩
 * ------------------------------------------------------------------ */

function setExpanded(next) {
  if (!state) return;
  const item = state.item;
  if (item.expansion === 'alwaysExpanded') next = true;
  if (expanded === next) return;
  expanded = next;
  document.body.classList.toggle('expanded', expanded);
  document.body.classList.toggle('collapsed', !expanded);
  if (expanded) {
    renderPanel();
    refresh();
  }
  window.tuck.surface.setExpanded(ID, expanded);
}

function scheduleHoverExpand() {
  if (!state || expanded) return;
  if (!state.config.interaction.expandOnHover) return;
  if (leaveTimer) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
  }
  const delay = state.config.interaction.hoverExpandDelay || 0;
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    setExpanded(true);
  }, delay);
}

function scheduleCollapse() {
  if (hoverTimer) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  if (!state || !expanded) return;
  if (state.item.expansion === 'alwaysExpanded') return;
  if (!state.config.interaction.collapseOnPointerLeave) return;
  if (leaveTimer) clearTimeout(leaveTimer);
  const delay =
    KIND === 'station' ? state.config.interaction.stationCollapseDelay : state.config.interaction.pointerLeaveCollapseDelay;
  leaveTimer = setTimeout(() => {
    leaveTimer = null;
    setExpanded(false);
  }, delay);
}

/* ------------------------------------------------------------------ *
 * 拖动
 * ------------------------------------------------------------------ */

/**
 * 拖动
 *
 * 使用指针事件 + setPointerCapture：即使指针在拖动过程中移出窗口，
 * pointerup 依然会送回被捕获的元素。之前用 mousedown/document.mouseup，
 * 一旦指针离开窗口就再也收不到 mouseup，主进程的拖动循环会一直跑下去
 * （表现为窗口自己变大并满屏乱跑）。
 */
function installDrag(node) {
  if (!node) return;

  const finish = () => {
    if (dragging) endDrag(node === document.getElementById('entry'));
  };

  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('button, input, textarea')) return;
    dragging = true;
    dragMoved = false;
    dragStart = { x: e.screenX, y: e.screenY };
    try {
      node.setPointerCapture(e.pointerId);
    } catch (_) {
      /* 捕获失败时退回 document 级 mouseup */
    }
    window.tuck.surface.dragStart(ID);
  });

  node.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (Math.abs(e.screenX - dragStart.x) > 3 || Math.abs(e.screenY - dragStart.y) > 3) dragMoved = true;
  });

  node.addEventListener('pointerup', (e) => {
    try {
      node.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* 忽略 */
    }
    finish();
  });

  node.addEventListener('pointercancel', finish);
  node.addEventListener('lostpointercapture', finish);
}

/** 兜底：指针事件未送达时也要结束拖动 */
function installDragSafety() {
  window.addEventListener('blur', () => {
    if (dragging) endDrag(null);
  });
  document.addEventListener('mouseup', () => {
    // pointerup 未送达时的最后一道保险
    if (dragging) setTimeout(() => endDrag(null), 0);
  });
}

/**
 * 结束拖动
 * @param {boolean} isEntryClick 是否在入口上完成了一次「点击」（未移动）
 */
function endDrag(isEntryClick) {
  if (!dragging) return;
  dragging = false;
  window.tuck.surface.dragEnd(ID);
  if (!dragMoved && isEntryClick && state) {
    const item = state.item;
    if (item.kind === 'organizer' && item.expansion !== 'alwaysExpanded') {
      setExpanded(!expanded);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 右键菜单命令
 * ------------------------------------------------------------------ */

async function runCommand(command) {
  if (!state) return;

  /* 针对具体项目的对象指令 */
  if (command && typeof command === 'object') {
    const target = command.target;
    if (command.cmd === 'menu:renameItem') {
      const name = await window.UI.promptDialog(T('common.rename'), String(target).split(/[\\/]/).pop());
      if (name === null) return;
      const res = await window.tuck.surface.rename(target, name.trim());
      if (res && res.ok) {
        say(T('toast.saved'));
        refresh();
      } else {
        say(T('toast.failed', (res && res.reason) || ''));
      }
      return;
    }
    if (command.cmd === 'menu:copyItem') {
      await window.tuck.surface.copyText(target);
      say(T('toast.copied'));
      return;
    }
    if (command.cmd === 'menu:trashItem') {
      const ok = await window.UI.confirmDialog(T('org.deleteConfirm', String(target).split(/[\\/]/).pop()), T('common.delete'));
      if (!ok) return;
      const res = await window.tuck.surface.trash([target]);
      if (res && res.ok) refresh();
      else say(T('toast.failed', ''));
      return;
    }
    return;
  }

  const item = state.item;
  switch (command) {
    case 'menu:newFolder': {
      const name = await window.UI.promptDialog(T('ctx.newFolder'), T('ctx.newFolder'));
      if (name === null) return;
      const res = await window.tuck.surface.createFolder(ID, name.trim() || T('ctx.newFolder'));
      if (res && res.ok) {
        say(T('toast.saved'));
        refresh();
      } else {
        say(T('toast.failed', (res && res.reason) || ''));
      }
      break;
    }
    case 'menu:paste': {
      const res = await window.tuck.surface.paste(ID, 'move');
      if (res && res.ok) {
        say(T('toast.saved'));
        refresh();
      } else {
        say(T('toast.failed', (res && res.reason) || ''));
      }
      break;
    }
    case 'menu:renameWindow': {
      const name = await window.UI.promptDialog(T('common.rename'), item.name);
      if (name === null) return;
      const res = await window.tuck.surface.setName(ID, name.trim());
      if (res && res.ok) say(T('toast.saved'));
      else say(T('org.nameRequired'));
      break;
    }
    case 'menu:duplicate': {
      const res = await window.tuck.items.duplicate(ID);
      if (res && res.ok) say(T('org.duplicated', res.item.name));
      else say(T('station.noDuplicate'));
      break;
    }
    case 'menu:togglePlacement': {
      const next = item.placement === 'floating' ? 'positioned' : 'floating';
      await window.tuck.items.update(ID, { placement: next });
      break;
    }
    case 'menu:toggleContent': {
      const next = item.contentMode === 'icon' ? 'compactList' : 'icon';
      await window.tuck.items.update(ID, { contentMode: next });
      break;
    }
    case 'menu:toggleExpansion': {
      const next = item.expansion === 'collapsible' ? 'alwaysExpanded' : 'collapsible';
      await window.tuck.items.update(ID, { expansion: next });
      if (next === 'alwaysExpanded') setExpanded(true);
      break;
    }
    case 'menu:toggleNameHidden': {
      await window.tuck.surface.toggleNameHidden(ID);
      break;
    }
    case 'menu:openStorage': {
      const res = await window.tuck.items.openStorage(ID);
      if (!res || !res.ok) say(T('org.missing'));
      break;
    }
    case 'menu:deleteWindow': {
      // 主进程会询问保存目录里的内容如何处理
      const res = await window.tuck.items.remove(ID, {});
      if (res && res.canceled) break;
      if (res && res.ok) say(res.message || '');
      else say((res && res.message) || T('toast.failed', ''));
      break;
    }
    default:
      break;
  }
}

/* ------------------------------------------------------------------ *
 * 打开项目
 * ------------------------------------------------------------------ */

async function openEntry(entry) {
  const res = await window.tuck.surface.open(entry.path);
  if (res && !res.ok) say(T('toast.openFailed', entry.name));
}

/* ------------------------------------------------------------------ *
 * 拖放导入
 * ------------------------------------------------------------------ */

function installDrop() {
  const root = document.getElementById('root');

  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  ['dragenter', 'dragover'].forEach((type) =>
    root.addEventListener(type, (e) => {
      stop(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      document.body.classList.add('dragover');
    })
  );
  ['dragleave', 'dragend'].forEach((type) =>
    root.addEventListener(type, (e) => {
      stop(e);
      if (e.relatedTarget === null || !root.contains(e.relatedTarget)) {
        document.body.classList.remove('dragover');
      }
    })
  );
  root.addEventListener('drop', async (e) => {
    stop(e);
    document.body.classList.remove('dragover');
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (!files.length) return;
    const paths = files.map((f) => window.tuck.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const mode = e.ctrlKey ? 'copy' : 'move';
    const res = await window.tuck.surface.importPaths(ID, paths, mode);
    if (res && res.ok) {
      say(mode === 'copy' ? T('toast.copied') : T('toast.saved'));
      refresh();
    } else {
      say(T('toast.failed', (res && res.reason) || ''));
    }
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function boot() {
  state = await window.tuck.surface.init(ID);
  if (!state) return;

  applyAppearance();

  const initialExpanded = state.item.expansion === 'alwaysExpanded' ? true : false;
  expanded = false;
  document.body.classList.add('collapsed');
  if (initialExpanded) {
    // 等窗口尺寸调整完成再切换，避免闪动
    setTimeout(() => setExpanded(true), 120);
  }

  await refresh();

  /* 头部按钮 */
  dom.btnCollapse.textContent = '';
  dom.btnCollapse.appendChild(ico('check', 14));
  dom.btnCollapse.title = T('window.collapse');
  dom.btnCollapse.addEventListener('click', (e) => {
    e.stopPropagation();
    setExpanded(false);
  });
  dom.btnSettings.textContent = '';
  dom.btnSettings.appendChild(ico('settings', 14));
  dom.btnSettings.title = T('ctx.settings');
  dom.btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    window.tuck.openSettings();
  });

  installDrag(document.getElementById('entry'));
  installDrag(document.getElementById('panel-head'));
  installDrag(dom.dockStrip);
  installDragSafety();
  installDrop();

  /* 悬浮展开 / 离开收缩 */
  const root = document.getElementById('root');
  root.addEventListener('mouseenter', scheduleHoverExpand);
  root.addEventListener('mouseleave', scheduleCollapse);

  /* 点击窗口外自动收缩 */
  window.addEventListener('blur', () => {
    if (state && state.config.interaction.collapseOutside) {
      setTimeout(() => {
        if (!document.hasFocus()) setExpanded(false);
      }, 120);
    }
  });

  /* 空白处右键 → 窗口菜单 */
  root.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    ctxTarget = null;
    window.tuck.surface.nativeMenu(ID, null);
  });

  /* 滚轮直接收缩 */
  root.addEventListener('wheel', (e) => {
    if (expanded && e.deltaY > 24 && e.ctrlKey) setExpanded(false);
  }, { passive: true });

  /* 主进程指令 */
  window.tuck.surface.onCommand((command) => runCommand(command));
  window.tuck.surface.onRefresh(() => refresh());

  /* 状态更新 */
  window.tuck.surface.onState((next) => {
    if (!next) return;
    const modeChanged =
      state.config.theme.organizer.mode !== next.config.theme.organizer.mode ||
      state.config.theme.station.mode !== next.config.theme.station.mode ||
      state.config.theme.dock.mode !== next.config.theme.dock.mode;
    state = next;
    applyAppearance();
    if (expanded) renderPanel();
    renderEntry();
    renderDock();
    if (modeChanged) refresh();
  });

  /* 定期刷新，反映外部对目录的改动；间隔随性能档位调整 */
  const profile = (state.config.system && state.config.system.performanceProfile) || 'balanced';
  const interval = profile === 'powerSaver' ? 15000 : profile === 'highPerformance' ? 3000 : 6000;
  setInterval(() => refresh(), interval);
}

boot().catch((err) => {
  document.body.textContent = `加载失败：${err && err.message}`;
});

/* 供主进程菜单查询当前右键目标（保留引用，避免被回收） */
window.__ctxTarget = () => ctxTarget;

'use strict';
/**
 * diagnostics.js —— 本地诊断包
 *
 * 生成一个 ZIP，内含纯文本 / JSON 便于人工阅读与修改：
 *   diagnostics.json     结构化总览
 *   config.json          当前配置副本（可直接编辑后放回数据目录）
 *   windows.json         收纳窗 / 中转站 / Dock 栏清单
 *   app.log              最近的失败、超时与异常记录
 *   说明.txt             各文件的用途与修改指引
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, screen } = require('electron');
const { zipFromRecord } = require('./zip');

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function bytesToText(n) {
  if (!Number.isFinite(n)) return '未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/** 汇总运行环境 */
function collectEnvironment(ctx) {
  const displays = screen.getAllDisplays().map((d, idx) => ({
    index: idx,
    id: d.id,
    label: d.label || '',
    primary: d.id === screen.getPrimaryDisplay().id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    rotation: d.rotation
  }));

  let disk = null;
  try {
    const st = fs.statfsSync(ctx.dataRoot);
    disk = { freeBytes: st.bavail * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch (_) {
    disk = null;
  }

  return {
    generatedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: app.getLocale(),
    systemLocale: app.getSystemLocale ? app.getSystemLocale() : '',
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      edition: ctx.edition,
      exePath: app.getPath('exe'),
      dataRoot: ctx.dataRoot,
      configPath: ctx.configPath,
      userData: app.getPath('userData'),
      startTime: ctx.startTime ? new Date(ctx.startTime).toISOString() : null,
      uptimeSeconds: ctx.startTime ? Math.round((Date.now() - ctx.startTime) / 1000) : null
    },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
      modules: process.versions.modules
    },
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: (os.cpus()[0] || {}).model || '',
      totalMemory: bytesToText(os.totalmem()),
      freeMemory: bytesToText(os.freemem()),
      hostname: os.hostname(),
      uptime: `${Math.round(os.uptime() / 3600)} 小时`
    },
    displays,
    disk
  };
}

/** 生成人类可读的说明文件 */
function buildReadme(ctx, env) {
  const lines = [
    '收纳桌面 —— 本地诊断包',
    '==================================================',
    '',
    `生成时间：${env.generatedAt}`,
    `程序版本：${env.app.version}（${env.app.edition}）`,
    `数据目录：${env.app.dataRoot}`,
    '',
    '本压缩包内全部为纯文本 / JSON，可直接用记事本打开查看和修改。',
    '不包含任何文件正文，也不会自动上传；是否分享完全由你决定。',
    '',
    '文件说明',
    '--------------------------------------------------',
    'diagnostics.json  运行环境总览：系统、显示器、磁盘、运行库版本。',
    'config.json       当前全部设置与窗口定义。',
    'windows.json      收纳窗 / 中转站 / Dock 栏的清单与状态。',
    'app.log           最近的失败、超时与异常中断记录（UTC 时间）。',
    '说明.txt          本文件。',
    '',
    '如何修改设置',
    '--------------------------------------------------',
    `1. 关闭「收纳桌面」。`,
    `2. 编辑本包内的 config.json。`,
    `3. 把它放回数据目录：${ctx.configPath}`,
    '   （建议先把原文件改名为 config.json.bak 备份）。',
    '4. 重新启动程序。',
    '',
    '常见字段',
    '--------------------------------------------------',
    'system.performanceProfile   powerSaver | balanced | highPerformance',
    'system.language             zh-CN | en-US | ja-JP',
    'display.compactNameScale    0.6 ~ 1.0（收起名称大小）',
    'display.expandedNameScale   0.6 ~ 1.0（展开后名称大小）',
    'display.uniformEntrySize    0.6 ~ 1.4（统一入口大小）',
    'theme.organizer / station / dock / settings',
    '                            { color, mode: glass|solid, opacity: 0~1, blur: 0~60 }',
    'items[]                     每个收纳窗 / 中转站 / Dock 栏的定义',
    '',
    '如果程序无法启动',
    '--------------------------------------------------',
    '把 config.json 改名或删除，程序会用默认设置重新生成一份。',
    ''
  ];
  return lines.join('\r\n');
}

/**
 * 导出诊断包
 * @param {object} ctx  { dataRoot, configPath, store, manager, logger, edition, startTime }
 * @param {string} targetPath 目标 .zip 路径
 */
async function exportDiagnostics(ctx, targetPath) {
  const env = collectEnvironment(ctx);

  const windows = {
    generatedAt: env.generatedAt,
    total: ctx.store.data.items.length,
    organizers: ctx.store.data.items.filter((i) => i.kind === 'organizer'),
    stations: ctx.store.data.items.filter((i) => i.kind === 'station'),
    docks: ctx.store.data.items.filter((i) => i.kind === 'dock'),
    liveWindows: ctx.manager ? ctx.manager.describeLiveWindows() : []
  };

  const config = safeReadJson(ctx.configPath) || ctx.store.data;

  const record = {
    'diagnostics.json': `${JSON.stringify(env, null, 2)}\r\n`,
    'config.json': `${JSON.stringify(config, null, 2)}\r\n`,
    'windows.json': `${JSON.stringify(windows, null, 2)}\r\n`,
    'app.log': ctx.logger ? ctx.logger.tail(4 * 1024 * 1024) : '（无日志）',
    '说明.txt': buildReadme(ctx, env)
  };

  const buf = zipFromRecord(record);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buf);
  return { ok: true, path: targetPath, size: buf.length, files: Object.keys(record) };
}

/** 生成诊断包默认文件名 */
function defaultDiagnosticsName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}`;
  return `收纳桌面-诊断包-${stamp}.zip`;
}

module.exports = { exportDiagnostics, defaultDiagnosticsName, collectEnvironment };

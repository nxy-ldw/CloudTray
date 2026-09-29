'use strict';
/**
 * shell.js —— Windows 资源管理器集成
 *
 * 通过 HKCU 下的注册表项注册：
 *   · 文件夹右键菜单  HKCU\Software\Classes\Directory\shell\<key>
 *   · 桌面右键菜单    HKCU\Software\Classes\DesktopBackground\Shell\<key>
 * 以及开机启动（HKCU\...\Run）。全部写在当前用户下，无需管理员权限。
 * 启用/禁用通过备份并删除键值实现，可完全还原。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'CloudTray';
const FOLDER_KEY = 'HKCU\\Software\\Classes\\Directory\\shell\\CloudTrayOrganizer';
const DESKTOP_KEY = 'HKCU\\Software\\Classes\\DesktopBackground\\Shell\\CloudTrayOrganizer';

const APP_REG_KEY = 'HKCU\\Software\\CloudTray';

function run(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

/** 读取注册表值，不存在返回 null */
async function regQuery(key, value) {
  const args = value ? ['query', key, '/v', value] : ['query', key];
  const res = await run(args);
  if (!res.ok) return null;
  return res.stdout;
}

async function regAdd(key, value, data, type) {
  const args = ['add', key];
  if (value) args.push('/v', value);
  else args.push('/ve');
  args.push('/t', type || 'REG_SZ', '/d', data, '/f');
  return run(args);
}

async function regDelete(key, value) {
  const args = ['delete', key];
  if (value) args.push('/v', value, '/f');
  else args.push('/f');
  return run(args);
}

/* ------------------------------------------------------------------ *
 * 开机启动
 * ------------------------------------------------------------------ */

async function setLaunchAtStartup(enabled, exePath, args) {
  if (!enabled) {
    await regDelete(RUN_KEY, RUN_VALUE);
    return { ok: true };
  }
  const cmd = args ? `"${exePath}" ${args}` : `"${exePath}"`;
  const res = await regAdd(RUN_KEY, RUN_VALUE, cmd);
  return { ok: res.ok, detail: res.stderr };
}

async function getLaunchAtStartup() {
  const out = await regQuery(RUN_KEY, RUN_VALUE);
  return !!out;
}

/* ------------------------------------------------------------------ *
 * 资源管理器右键菜单
 * ------------------------------------------------------------------ */

/**
 * @param {'folder'|'desktop'} which
 * @param {boolean} enabled
 * @param {string} exePath
 * @param {{folder:string, desktop:string, icon:string}} [labels] 菜单文案，由 i18n 提供
 */
async function setContextMenu(which, enabled, exePath, labels) {
  const key = which === 'folder' ? FOLDER_KEY : DESKTOP_KEY;
  const text = labels || {};
  if (!enabled) {
    await regDelete(key);
    return { ok: true };
  }

  const cmd = which === 'folder' ? `"${exePath}" --create-organizer "%1"` : `"${exePath}" --create-organizer`;
  const label = which === 'folder' ? text.folder || 'Organizer' : text.desktop || 'New organizer';

  const steps = [
    ['add', key, '/ve', '/t', 'REG_SZ', '/d', label, '/f'],
    ['add', key, '/v', 'Icon', '/t', 'REG_SZ', '/d', text.icon || `"${exePath}",0`, '/f'],
    ...(which === 'folder' ? [['add', key, '/v', 'MultiSelectModel', '/t', 'REG_SZ', '/d', 'Single', '/f']] : []),
    ['add', `${key}\\command`, '/ve', '/t', 'REG_SZ', '/d', cmd, '/f']
  ];

  let ok = true;
  let detail = '';
  for (const s of steps) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run(s);
    if (!r.ok) {
      ok = false;
      detail = r.stderr;
      break;
    }
  }
  if (!ok) return { ok, detail };
  return { ok: true };
}

/** 判断当前注册状态：'enabled' | 'broken' | 'other' | 'disabled' */
async function getContextMenuState(which, exePath) {
  const key = which === 'folder' ? FOLDER_KEY : DESKTOP_KEY;
  const out = await regQuery(`${key}\\command`);
  if (!out) return 'disabled';
  const lower = out.toLowerCase();
  if (lower.includes(exePath.toLowerCase())) return 'enabled';
  if (lower.includes('cloudtray') || lower.includes('tuckdesk') || out.includes('云屉') || out.includes('收纳桌面')) {
    return 'other';
  }
  return 'broken';
}

/* ------------------------------------------------------------------ *
 * 应用注册信息（用于诊断与卸载提示）
 * ------------------------------------------------------------------ */

async function writeAppRegistration(exePath, version) {
  await regAdd(APP_REG_KEY, 'InstallPath', exePath);
  await regAdd(APP_REG_KEY, 'Version', version);
}

async function readAppRegistration() {
  const p = await regQuery(APP_REG_KEY, 'InstallPath');
  const v = await regQuery(APP_REG_KEY, 'Version');
  const pick = (s) => {
    if (!s) return null;
    const m = s.match(/REG_SZ\s+(.+)\s*$/m);
    return m ? m[1].trim() : null;
  };
  return { installPath: pick(p), version: pick(v) };
}

module.exports = {
  setLaunchAtStartup,
  getLaunchAtStartup,
  setContextMenu,
  getContextMenuState,
  writeAppRegistration,
  readAppRegistration,
  RUN_KEY,
  RUN_VALUE,
  FOLDER_KEY,
  DESKTOP_KEY
};

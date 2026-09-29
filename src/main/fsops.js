'use strict';
/**
 * fsops.js —— 收纳窗口所需的文件系统操作
 *
 * 一律使用绝对路径；删除走系统回收站（shell.trashItem），避免误删无法恢复。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { shell, app, nativeImage } = require('electron');

const HIDDEN_ATTR = 0x2;
const SYSTEM_ATTR = 0x4;

/** 目录是否可读 */
async function ensureDir(dir) {
  try {
    const st = await fsp.stat(dir);
    if (st.isDirectory()) return true;
    return false;
  } catch (_) {
    try {
      await fsp.mkdir(dir, { recursive: true });
      return true;
    } catch (__) {
      return false;
    }
  }
}

/** 读取目录内容（不含隐藏/系统文件），返回渲染层需要的元数据 */
async function listDirectory(dir, options) {
  const opts = options || {};
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: err.code || String(err), items: [], dirExists: false };
  }

  for (const entry of entries) {
    if (!opts.showHidden && (entry.name.startsWith('.') || entry.name === 'desktop.ini')) continue;
    const full = path.join(dir, entry.name);
    let st = null;
    try {
      st = await fsp.lstat(full);
    } catch (_) {
      continue;
    }
    if (!opts.showHidden) {
      // Windows 隐藏属性：读取失败时按可见处理
      try {
        const attrs = st.attributes !== undefined ? st.attributes : 0;
        if (attrs & (HIDDEN_ATTR | SYSTEM_ATTR)) continue;
      } catch (_) {
        /* 忽略 */
      }
    }
    out.push({
      name: entry.name,
      path: full,
      isDir: st.isDirectory(),
      isLink: st.isSymbolicLink(),
      size: st.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
      ext: st.isDirectory() ? '' : path.extname(entry.name).toLowerCase()
    });
  }

  if (opts.sort !== 'name-desc') {
    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    });
  } else {
    out.sort((a, b) => b.mtime - a.mtime);
  }

  return { ok: true, items: out, dirExists: true };
}

/** 批量取系统图标，返回 dataURL 映射 */
async function getIcons(paths, size) {
  const result = {};
  const iconSize = size === 'large' ? 'large' : size === 'small' ? 'small' : 'normal';
  await Promise.all(
    paths.map(async (p) => {
      /* 快捷方式取目标程序的图标：
         直接对 .lnk 取图标只会得到一模一样的通用箭头图标，
         Dock 栏里一排图标将无法区分 */
      if (/\.lnk$/i.test(p)) {
        try {
          const link = shell.readShortcutLink(p);
          if (link && link.target) {
            const targetIcon = await app.getFileIcon(link.target, { size: iconSize });
            if (targetIcon && !targetIcon.isEmpty()) {
              result[p] = targetIcon.toDataURL();
              return;
            }
          }
        } catch (_) {
          /* 快捷方式损坏或指向不存在的目标，退回通用图标 */
        }
      }
      try {
        const img = await app.getFileIcon(p, { size: iconSize });
        if (img && !img.isEmpty()) result[p] = img.toDataURL();
      } catch (_) {
        /* 无图标时由渲染层回退到内置图标 */
      }
    })
  );
  return result;
}

/** 缩略图（用于图片文件） */
async function getThumbnail(filePath, maxSize) {
  try {
    const img = await nativeImage.createThumbnailFromPath(filePath, {
      width: maxSize || 64,
      height: maxSize || 64
    });
    if (img && !img.isEmpty()) return img.toDataURL();
  } catch (_) {
    /* 系统无法生成缩略图 */
  }
  return null;
}

async function openPath(target) {
  const err = await shell.openPath(target);
  return err ? { ok: false, error: err } : { ok: true };
}

function revealPath(target) {
  shell.showItemInFolder(target);
  return { ok: true };
}

/** 删除到回收站 */
async function trash(paths) {
  const failures = [];
  for (const p of paths) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await shell.trashItem(p);
    } catch (err) {
      failures.push({ path: p, error: String((err && err.message) || err) });
    }
  }
  return { ok: failures.length === 0, failures };
}

const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

function validateName(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, reason: 'empty' };
  if (n.length > 200) return { ok: false, reason: 'tooLong' };
  if (INVALID_NAME.test(n)) return { ok: false, reason: 'invalid' };
  if (/[. ]$/.test(n)) return { ok: false, reason: 'trailing' };
  if (RESERVED.has(n.toUpperCase().split('.')[0])) return { ok: false, reason: 'reserved' };
  return { ok: true, name: n };
}

/** 在目录内新建文件夹，自动避让重名 */
async function createFolder(dir, desiredName) {
  const check = validateName(desiredName);
  if (!check.ok) return { ok: false, reason: check.reason };
  const okDir = await ensureDir(dir);
  if (!okDir) return { ok: false, reason: 'noDir' };

  let target = path.join(dir, check.name);
  let i = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${check.name} ${i}`);
    i += 1;
    if (i > 500) return { ok: false, reason: 'conflict' };
  }
  try {
    await fsp.mkdir(target, { recursive: false });
    return { ok: true, path: target, name: path.basename(target) };
  } catch (err) {
    return { ok: false, reason: String(err.code || err) };
  }
}

/** 新建空文件 */
async function createFile(dir, desiredName, content) {
  const check = validateName(desiredName);
  if (!check.ok) return { ok: false, reason: check.reason };
  await ensureDir(dir);
  let target = path.join(dir, check.name);
  let i = 2;
  while (fs.existsSync(target)) {
    const ext = path.extname(check.name);
    target = path.join(dir, `${check.name.slice(0, check.name.length - ext.length)} ${i}${ext}`);
    i += 1;
    if (i > 500) return { ok: false, reason: 'conflict' };
  }
  try {
    await fsp.writeFile(target, content === undefined ? '' : content, 'utf8');
    return { ok: true, path: target, name: path.basename(target) };
  } catch (err) {
    return { ok: false, reason: String(err.code || err) };
  }
}

/** 重命名（同目录内改名） */
async function rename(oldPath, newName) {
  const check = validateName(newName);
  if (!check.ok) return { ok: false, reason: check.reason };
  const dir = path.dirname(oldPath);
  const target = path.join(dir, check.name);
  if (target.toLowerCase() === oldPath.toLowerCase()) {
    return { ok: true, path: oldPath, unchanged: true };
  }
  if (fs.existsSync(target)) return { ok: false, reason: 'exists' };
  try {
    await fsp.rename(oldPath, target);
    return { ok: true, path: target, name: check.name };
  } catch (err) {
    return { ok: false, reason: String(err.code || err) };
  }
}

/** 复制单个条目（文件或目录），存在同名时自动编号 */
async function copyEntry(src, destDir, desiredName) {
  const name = desiredName || path.basename(src);
  let target = path.join(destDir, name);
  if (path.resolve(target).toLowerCase() === path.resolve(src).toLowerCase()) {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let i = 2;
    while (fs.existsSync(path.join(destDir, `${stem} ${i}${ext}`))) i += 1;
    target = path.join(destDir, `${stem} ${i}${ext}`);
  } else {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let i = 2;
    while (fs.existsSync(target)) {
      target = path.join(destDir, `${stem} ${i}${ext}`);
      i += 1;
      if (i > 500) return { ok: false, reason: 'conflict' };
    }
  }
  try {
    await fsp.cp(src, target, { recursive: true, errorOnExist: false, force: false });
    return { ok: true, path: target, name: path.basename(target) };
  } catch (err) {
    return { ok: false, reason: String(err.code || err) };
  }
}

/** 移动条目；跨盘时自动退化为复制后删除 */
async function moveEntry(src, destDir) {
  const name = path.basename(src);
  let target = path.join(destDir, name);
  if (path.resolve(target).toLowerCase() === path.resolve(src).toLowerCase()) {
    return { ok: true, path: src, unchanged: true };
  }
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let i = 2;
  while (fs.existsSync(target)) {
    target = path.join(destDir, `${stem} ${i}${ext}`);
    i += 1;
    if (i > 500) return { ok: false, reason: 'conflict' };
  }
  try {
    await fsp.rename(src, target);
    return { ok: true, path: target, name: path.basename(target) };
  } catch (err) {
    if (err.code !== 'EXDEV') return { ok: false, reason: String(err.code || err) };
  }
  // 跨卷：复制后删除源
  try {
    await fsp.cp(src, target, { recursive: true, errorOnExist: false, force: false });
  } catch (err) {
    return { ok: false, reason: String(err.code || err) };
  }
  try {
    await fsp.rm(src, { recursive: true, force: true });
  } catch (_) {
    return { ok: true, path: target, name: path.basename(target), sourceRetained: true };
  }
  return { ok: true, path: target, name: path.basename(target), crossVolume: true };
}

/**
 * 导入若干条目到目标目录
 * @param {string[]} sources
 * @param {string} destDir
 * @param {'move'|'copy'} mode
 */
async function importEntries(sources, destDir, mode) {
  const okDir = await ensureDir(destDir);
  if (!okDir) return { ok: false, reason: 'noDir', results: [] };
  const results = [];
  for (const src of sources) {
    if (!src) continue;
    if (path.resolve(src).toLowerCase() === path.resolve(destDir).toLowerCase()) {
      results.push({ src, ok: false, reason: 'self' });
      continue;
    }
    if (path.resolve(destDir).toLowerCase().startsWith(`${path.resolve(src).toLowerCase()}\\`)) {
      results.push({ src, ok: false, reason: 'recursive' });
      continue;
    }
    if (!fs.existsSync(src)) {
      results.push({ src, ok: false, reason: 'missing' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const r = mode === 'copy' ? await copyEntry(src, destDir) : await moveEntry(src, destDir);
    results.push({ src, ...r });
  }
  return { ok: results.every((r) => r.ok), results };
}

/** 统计目录内的条目数 */
async function countEntries(dir) {
  try {
    const entries = await fsp.readdir(dir);
    return entries.filter((n) => !n.startsWith('.') && n !== 'desktop.ini').length;
  } catch (_) {
    return 0;
  }
}

/**
 * 统计目录内的条目数（同步版）
 * 创建 Dock / 中转站窗口时要在建窗之前就知道数量，
 * 否则会先按错误的尺寸出现、等渲染层上报后再缩一次，看起来就是“跳一下”。
 */
function countEntriesSync(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'desktop.ini').length;
  } catch (_) {
    return 0;
  }
}

/** 目录是否存在 */
function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

module.exports = {
  ensureDir,
  listDirectory,
  getIcons,
  getThumbnail,
  openPath,
  revealPath,
  trash,
  validateName,
  createFolder,
  createFile,
  rename,
  copyEntry,
  moveEntry,
  importEntries,
  countEntries,
  countEntriesSync,
  dirExists
};

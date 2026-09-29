'use strict';
/**
 * paths.js —— 数据根目录与保存目录解析
 *
 * 便携版（程序目录可写）把数据放在程序旁的 data 目录，随压缩包一起搬走；
 * 安装版放在 %APPDATA%，避免写到 Program Files。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 探测程序目录是否可写，用于判定便携模式 */
function probeWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.exeDir        可执行文件所在目录
 * @param {string} opts.userDataDir   Electron 默认用户数据目录
 * @param {boolean} opts.isPackaged   是否已打包
 * @param {string} [opts.forceMode]   'portable' | 'installed' | undefined
 */
function resolveDataRoot(opts) {
  const { exeDir, userDataDir, isPackaged, forceMode } = opts;

  if (forceMode === 'portable') return path.join(exeDir, 'data');
  if (forceMode === 'installed') return userDataDir;

  // 便携版安装包会设置 PORTABLE_EXECUTABLE_DIR
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  }

  if (!isPackaged) return userDataDir;

  // 安装版：安装器写下的标记文件，数据固定放用户数据目录，卸载时保留
  if (fs.existsSync(path.join(exeDir, 'installed.marker'))) return userDataDir;

  // 便携版：程序目录可写时，数据放程序旁的 data 目录
  const beside = path.join(exeDir, 'data');
  if (fs.existsSync(beside) || probeWritable(beside)) return beside;

  return userDataDir;
}

/**
 * 从旧版本的数据目录迁移设置与内容
 *
 * 程序更名后用户数据目录随之改变（%APPDATA%\收纳桌面 → %APPDATA%\云屉）。
 * 若新目录还没有配置，就把旧目录里的内容整体搬过来，避免用户的收纳窗、
 * 中转站与偏好设置凭空消失。已存在的文件不会被覆盖。
 *
 * @param {string} targetRoot 新的数据根目录
 * @param {string[]} legacyRoots 候选旧目录，按优先级排列
 * @returns {string|null} 实际迁移来源，未迁移则为 null
 */
function migrateLegacyData(targetRoot, legacyRoots) {
  if (fs.existsSync(path.join(targetRoot, 'config.json'))) return null;

  for (const legacy of legacyRoots) {
    if (!legacy || path.resolve(legacy) === path.resolve(targetRoot)) continue;
    if (!fs.existsSync(path.join(legacy, 'config.json'))) continue;
    try {
      fs.mkdirSync(targetRoot, { recursive: true });
      for (const entry of fs.readdirSync(legacy)) {
        // 浏览器缓存一类的目录没有迁移价值
        if (/^(Cache|Code Cache|GPUCache|GPUPersistentCache|BlobStorage|blob_storage|Dawn.*Cache|GrShaderCache|ShaderCache|Network|Local Storage|Session Storage|Dictionaries|Shared Dictionary|logs?)$/i.test(entry)) {
          continue;
        }
        const from = path.join(legacy, entry);
        const to = path.join(targetRoot, entry);
        if (fs.existsSync(to)) continue;
        fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
      }
      rewriteStoragePaths(path.join(targetRoot, 'config.json'), legacy, targetRoot);
      return legacy;
    } catch (_) {
      // 迁移失败不应影响启动，继续尝试下一个候选目录
    }
  }
  return null;
}

/**
 * 把配置里指向旧数据目录的保存路径改写到新目录
 *
 * 配置里的 storagePath 是绝对路径。整体拷贝目录后若不改写，窗口仍然指向旧位置，
 * 迁移过来的内容等于白拷，用户一旦清理旧目录收纳窗就会失效。
 */
function rewriteStoragePaths(configPath, legacyRoot, targetRoot) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return;
  }
  const oldPrefix = path.resolve(legacyRoot).toLowerCase();
  const rebase = (value) => {
    if (typeof value !== 'string' || !value) return value;
    if (path.resolve(value).toLowerCase().startsWith(oldPrefix)) {
      return path.join(targetRoot, path.relative(path.resolve(legacyRoot), path.resolve(value)));
    }
    return value;
  };

  let touched = 0;
  if (raw.system && typeof raw.system.defaultStoragePath === 'string') {
    const next = rebase(raw.system.defaultStoragePath);
    if (next !== raw.system.defaultStoragePath) {
      raw.system.defaultStoragePath = next;
      touched += 1;
    }
  }
  if (Array.isArray(raw.items)) {
    for (const item of raw.items) {
      if (!item || typeof item.storagePath !== 'string') continue;
      const next = rebase(item.storagePath);
      if (next !== item.storagePath) {
        item.storagePath = next;
        touched += 1;
      }
    }
  }
  if (touched > 0) {
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf8');
  }
}

/** 桌面目录 */
function desktopDir() {  const candidates = [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), '桌面')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

/** 回收站可用性探测：SExtended 需要 shell，这里只做存在性判断 */
function isWindows() {
  return process.platform === 'win32';
}

/** 校验用户选择的存储路径是否可用 */
function validateStoragePath(target, reservedRoots) {
  if (!target || typeof target !== 'string') {
    return { ok: false, reason: 'empty' };
  }
  const resolved = path.resolve(target);
  if (!path.isAbsolute(resolved)) {
    return { ok: false, reason: 'relative' };
  }
  const root = path.parse(resolved).root;
  if (resolved === root) {
    return { ok: false, reason: 'driveRoot' };
  }
  const home = os.homedir();
  const homeSubdirs = ['Desktop', '桌面', 'Documents', '文档', 'Downloads', '下载', 'Pictures', '图片', 'Music', 'Videos'];
  if (resolved.toLowerCase() === home.toLowerCase()) {
    return { ok: false, reason: 'home' };
  }
  for (const sub of homeSubdirs) {
    if (resolved.toLowerCase() === path.join(home, sub).toLowerCase()) {
      return { ok: false, reason: 'shellFolder' };
    }
  }
  for (const r of reservedRoots || []) {
    if (!r) continue;
    const rr = path.resolve(r);
    if (resolved.toLowerCase() === rr.toLowerCase()) {
      return { ok: false, reason: 'reserved' };
    }
  }
  return { ok: true, path: resolved };
}

/** 判断两个路径是否重叠（互为父子或相同） */
function pathsOverlap(a, b) {
  if (!a || !b) return false;
  const na = path.resolve(a).toLowerCase().replace(/[\\/]+$/, '');
  const nb = path.resolve(b).toLowerCase().replace(/[\\/]+$/, '');
  if (na === nb) return true;
  return na.startsWith(`${nb}\\`) || nb.startsWith(`${na}\\`);
}

/** 生成不冲突的目录名 */
function uniqueDirName(parent, base) {
  let candidate = path.join(parent, base);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${base} ${i}`);
    i += 1;
    if (i > 999) break;
  }
  return candidate;
}

/** 生成不冲突的文件名 */
function uniqueFileName(parent, base) {
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let candidate = path.join(parent, base);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${stem} ${i}${ext}`);
    i += 1;
    if (i > 999) break;
  }
  return candidate;
}

module.exports = {
  resolveDataRoot,
  probeWritable,
  migrateLegacyData,
  desktopDir,
  isWindows,
  validateStoragePath,
  pathsOverlap,
  uniqueDirName,
  uniqueFileName
};

'use strict';
/**
 * postinstall.js
 *
 * electron@44 的 npm 包不再自带 postinstall 脚本，需要手工触发它自带的
 * install.js 来下载并解压 Electron 运行时。这里做存在性判断，保证在
 * 只安装生产依赖（没有 electron）时也不会让整个 install 失败。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const installer = path.join(electronDir, 'install.js');

if (!fs.existsSync(installer)) {
  console.log('[postinstall] 未安装 electron，跳过运行时下载。');
  process.exit(0);
}

const marker = path.join(electronDir, 'path.txt');
const distDir = path.join(electronDir, 'dist');
if (fs.existsSync(marker) && fs.existsSync(distDir)) {
  console.log('[postinstall] Electron 运行时已就绪。');
  process.exit(0);
}

console.log('[postinstall] 正在下载 Electron 运行时…');
const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', cwd: electronDir });
process.exit(result.status === null ? 1 : result.status);

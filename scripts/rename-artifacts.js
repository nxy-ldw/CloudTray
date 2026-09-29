'use strict';
/**
 * rename-artifacts.js —— 把 ASCII 构建产物改名成中文交付名
 *
 * electron-builder 的 zip 目标通过 7za 打包，而 7za 在中文代码页下无法正确处理
 * 非 ASCII 的命令行参数，因此构建期使用 ASCII 文件名，构建后再改回中文。
 *
 * 同时为便携版补一个 data 目录说明文件，并把中文名版本的体积信息打印出来。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;

function move(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.rmSync(to, { force: true });
  fs.renameSync(from, to);
  return true;
}

function sizeText(file) {
  const mb = fs.statSync(file).size / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function main() {
  const results = [];

  const setupFrom = path.join(DIST, `CloudTray-${version}-Setup.exe`);
  const setupTo = path.join(DIST, `云屉-${version}-安装包.exe`);
  if (move(setupFrom, setupTo)) results.push(['安装包', setupTo]);

  const zipFrom = path.join(DIST, `CloudTray-${version}-x64.zip`);
  const zipTo = path.join(DIST, `云屉-${version}-便携版-x64.zip`);
  if (move(zipFrom, zipTo)) results.push(['便携版压缩包', zipTo]);

  if (results.length === 0) {
    console.log('[rename] 未找到可改名的产物，请先运行 electron-builder。');
    return;
  }

  console.log('');
  console.log('构建产物');
  console.log('────────────────────────────────────────────────────────');
  for (const [label, file] of results) {
    console.log(`${label.padEnd(12, '　')} ${path.basename(file)}  (${sizeText(file)})`);
  }
  console.log('────────────────────────────────────────────────────────');
  console.log(`解压目录      ${path.join(DIST, 'win-unpacked')}`);
  console.log('');
}

main();

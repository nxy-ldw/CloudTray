'use strict';
/**
 * grid.js —— 定位模式的桌面网格
 *
 * 把显示器工作区切成固定步距的格子，为定位模式收纳窗挑选一个既不压住桌面图标、
 * 也不与其它定位窗重叠的位置。读取不到桌面图标时不报错，退化为纯避让算法。
 */

const path = require('path');
const { execFile } = require('child_process');

const CELL = 8; // 吸附步距（DIP）

/** 把数值吸附到步距 */
function snap(value, step) {
  const s = step || CELL;
  return Math.round(value / s) * s;
}

/**
 * 依据入口尺寸计算格子尺寸
 * @param {number} unit 统一入口大小倍率
 */
function cellSize(unit) {
  const base = 76;
  const size = Math.round(base * (unit || 1));
  return Math.max(48, snap(size, 4));
}

/**
 * 读取桌面图标位置（尽力而为；失败返回空数组）
 * 通过 PowerShell 调用 Shell.Application，仅在需要时执行一次并缓存。
 */
let desktopIconCache = { at: 0, rects: [] };

function readDesktopIcons(timeoutMs) {
  const now = Date.now();
  if (now - desktopIconCache.at < 15000) return Promise.resolve(desktopIconCache.rects);

  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$sh = New-Object -ComObject Shell.Application',
    '$f = $sh.NameSpace(0)',
    'if ($f -ne $null) {',
    '  $out = @()',
    '  foreach ($i in $f.Items()) {',
    '    $p = Split-Path $i.Path -Parent',
    '    if ($p -eq [Environment]::GetFolderPath("Desktop")) {',
    '      $out += [pscustomobject]@{ x=$i.Position.X; y=$i.Position.Y; n=$i.Name }',
    '    }',
    '  }',
    '  $out | ConvertTo-Json -Compress',
    '}'
  ].join('\n');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs || 4000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          desktopIconCache = { at: Date.now(), rects: [] };
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          const rects = list.map((it) => ({
            x: Number(it.x) || 0,
            y: Number(it.y) || 0,
            name: String(it.n || '')
          }));
          desktopIconCache = { at: Date.now(), rects };
          resolve(rects);
        } catch (_) {
          desktopIconCache = { at: Date.now(), rects: [] };
          resolve([]);
        }
      }
    );
  });
}

function rectsOverlap(a, b, pad) {
  const p = pad || 0;
  return !(
    a.x + a.width + p <= b.x ||
    b.x + b.width + p <= a.x ||
    a.y + a.height + p <= b.y ||
    b.y + b.height + p <= a.y
  );
}

/**
 * 为尺寸 w×h 的窗口寻找一个空闲位置
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {{width:number,height:number}} size
 * @param {Array<{x:number,y:number,width:number,height:number}>} occupied
 * @param {Array<{x:number,y:number,name:string}>} [icons]
 * @returns {{x:number,y:number}|null}
 */
function findFreeSlot(workArea, size, occupied, icons) {
  const stepX = snap(size.width + 16, 8);
  const stepY = snap(size.height + 16, 8);
  const cols = Math.max(1, Math.floor((workArea.width - 16) / stepX));
  const rows = Math.max(1, Math.floor((workArea.height - 16) / stepY));

  const iconRects = (icons || []).map((ic, idx) => ({
    x: workArea.x + ic.x,
    y: workArea.y + ic.y,
    width: 76,
    height: 96,
    idx
  }));

  const candidates = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const rect = {
        x: snap(workArea.x + 8 + c * stepX, 8),
        y: snap(workArea.y + 8 + r * stepY, 8),
        width: size.width,
        height: size.height
      };
      let score = 0;
      let blocked = false;
      for (const occ of occupied) {
        if (rectsOverlap(rect, occ, 6)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      for (const ic of iconRects) {
        if (rectsOverlap(rect, ic, 4)) score += 1;
      }
      candidates.push({ rect, score, r, c });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score || a.r - b.r || b.c - a.c);
  return { x: candidates[0].rect.x, y: candidates[0].rect.y };
}

/** 与屏幕边缘和其它窗口对齐 */
function alignRect(rect, workArea, others, threshold) {
  const t = threshold || 10;
  const out = { ...rect };
  const vTargets = [workArea.x, workArea.x + workArea.width - rect.width];
  const hTargets = [workArea.y, workArea.y + workArea.height - rect.height];

  for (const o of others || []) {
    vTargets.push(o.x, o.x + o.width, o.x + o.width - rect.width, o.x - rect.width);
    hTargets.push(o.y, o.y + o.height, o.y + o.height - rect.height, o.y - rect.height);
  }

  let bestDx = null;
  for (const t2 of vTargets) {
    const d = t2 - out.x;
    if (Math.abs(d) <= t && (bestDx === null || Math.abs(d) < Math.abs(bestDx))) bestDx = d;
  }
  let bestDy = null;
  for (const t2 of hTargets) {
    const d = t2 - out.y;
    if (Math.abs(d) <= t && (bestDy === null || Math.abs(d) < Math.abs(bestDy))) bestDy = d;
  }
  if (bestDx !== null) out.x += bestDx;
  if (bestDy !== null) out.y += bestDy;
  return out;
}

module.exports = { CELL, snap, cellSize, findFreeSlot, alignRect, readDesktopIcons, rectsOverlap };

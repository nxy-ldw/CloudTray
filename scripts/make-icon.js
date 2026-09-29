'use strict';
/**
 * make-icon.js —— 生成应用图标（纯 JS，无第三方依赖）
 *
 * 输出：
 *   build/icon.ico              256×256 多尺寸 ICO，供 electron-builder 使用
 *   assets/icon.png             256×256 PNG，供托盘与运行时使用
 *   src/renderer/assets/icon-64.png  设置界面标题栏使用
 *
 * 图形：圆角方块 + 蓝紫渐变 + 2×2 白色网格，呼应「收纳成格」的产品含义。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // 超采样倍数

/* ------------------------------------------------------------------ *
 * PNG 编码
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** rgba: Uint8Array(size*size*4) → PNG Buffer */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ------------------------------------------------------------------ *
 * 绘制
 * ------------------------------------------------------------------ */

function makeCanvas(size) {
  return { size, data: new Float64Array(size * size * 4) };
}

/** 圆角矩形覆盖度（点是否在内部，带 1px 羽化） */
function insideRoundRect(px, py, x, y, w, h, r) {
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  const d = Math.sqrt(dx * dx + dy * dy);
  return d <= r + 0.5 ? Math.min(1, Math.max(0, r + 0.5 - d)) : 0;
}

function fillRoundRect(canvas, x, y, w, h, r, colorFn) {
  const { size, data } = canvas;
  for (let py = Math.floor(y - 1); py < Math.ceil(y + h + 1); py += 1) {
    if (py < 0 || py >= size) continue;
    for (let px = Math.floor(x - 1); px < Math.ceil(x + w + 1); px += 1) {
      if (px < 0 || px >= size) continue;
      const cov = insideRoundRect(px + 0.5, py + 0.5, x, y, w, h, r);
      if (cov <= 0) continue;
      const [cr, cg, cb, ca] = colorFn(px + 0.5, py + 0.5);
      const idx = (py * size + px) * 4;
      const srcA = ca * cov;
      const dstA = data[idx + 3];
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) continue;
      data[idx] = (cr * srcA + data[idx] * dstA * (1 - srcA)) / outA;
      data[idx + 1] = (cg * srcA + data[idx + 1] * dstA * (1 - srcA)) / outA;
      data[idx + 2] = (cb * srcA + data[idx + 2] * dstA * (1 - srcA)) / outA;
      data[idx + 3] = outA;
    }
  }
}

/** 用给定的绘制函数渲染某个尺寸（含超采样） */
function render(size, draw) {
  const big = size * SS;
  const canvas = makeCanvas(big);
  draw(canvas, big);
  // 盒式降采样
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const idx = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          const alpha = canvas.data[idx + 3];
          r += canvas.data[idx] * alpha;
          g += canvas.data[idx + 1] * alpha;
          b += canvas.data[idx + 2] * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const GRAD_FROM = [59, 130, 246]; // #3B82F6
const GRAD_TO = [139, 92, 246]; // #8B5CF6

function draw(canvas, size) {
  const u = size / 100; // 以 100 为设计基准
  const radius = 22 * u;

  /* 底色：斜向渐变 */
  fillRoundRect(canvas, 0, 0, size, size, radius, (px, py) => {
    const t = Math.min(1, Math.max(0, (px / size) * 0.45 + (py / size) * 0.75 - 0.1));
    return [
      GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t,
      GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t,
      GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t,
      1
    ];
  });

  /* 顶部高光 */
  fillRoundRect(canvas, 0, 0, size, size, radius, (px, py) => {
    const t = Math.max(0, 1 - py / (size * 0.85));
    return [255, 255, 255, t * t * 0.2];
  });

  /* 2×2 收纳格 */
  const pad = 24 * u;
  const gap = 7 * u;
  const cell = (size - pad * 2 - gap) / 2;
  const cellR = 6 * u;
  const tiles = [
    [pad, pad],
    [pad + cell + gap, pad],
    [pad, pad + cell + gap],
    [pad + cell + gap, pad + cell + gap]
  ];
  tiles.forEach(([tx, ty], i) => {
    const alpha = i === 3 ? 0.55 : 0.95;
    fillRoundRect(canvas, tx, ty, cell, cell, cellR, (px, py) => {
      const t = Math.min(1, Math.max(0, (py - ty) / cell));
      const v = 255 - t * 26;
      return [v, v, v, alpha];
    });
  });
}

/* ------------------------------------------------------------------ *
 * ICO 容器（PNG 内嵌，Vista+ 支持）
 * ------------------------------------------------------------------ */

function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirSize = 16 * count;
  let offset = 6 + dirSize;
  const dir = Buffer.alloc(dirSize);
  entries.forEach((entry, i) => {
    const b = i * 16;
    dir[b] = entry.size >= 256 ? 0 : entry.size; // 256 记作 0
    dir[b + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[b + 2] = 0; // 调色板
    dir[b + 3] = 0;
    dir.writeUInt16LE(1, b + 4); // color planes
    dir.writeUInt16LE(32, b + 6); // bpp
    dir.writeUInt32LE(entry.data.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += entry.data.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function main() {
  const pngs = new Map();
  for (const size of SIZES) {
    pngs.set(size, encodePng(render(size, draw), size));
  }

  /* ICO */
  ensureDir(path.join(ROOT, 'build'));
  const ico = buildIco(SIZES.map((size) => ({ size, data: pngs.get(size) })));
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), ico);

  /* 运行时 PNG */
  ensureDir(path.join(ROOT, 'assets'));
  fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), pngs.get(256));
  fs.writeFileSync(path.join(ROOT, 'assets', 'tray.png'), pngs.get(32));

  /* 设置界面用图 */
  const rendererAssets = path.join(ROOT, 'src', 'renderer', 'assets');
  ensureDir(rendererAssets);
  fs.writeFileSync(path.join(rendererAssets, 'icon-64.png'), pngs.get(64));
  fs.writeFileSync(path.join(rendererAssets, 'icon-256.png'), pngs.get(256));

  const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
  console.log(`[icon] build/icon.ico            ${kb(ico.length)}  (${SIZES.join(', ')})`);
  console.log(`[icon] assets/icon.png            ${kb(pngs.get(256).length)}  (256×256)`);
  console.log(`[icon] assets/tray.png            ${kb(pngs.get(32).length)}  (32×32)`);
  console.log(`[icon] src/renderer/assets/*.png  ${kb(pngs.get(64).length)} / ${kb(pngs.get(256).length)}`);
}

main();

'use strict';
/** note.js —— 便签窗口 */

const params = new URLSearchParams(location.search);
const ID = params.get('id') || '';

const COLORS = [
  { id: 'sun', bg: '#FDE68A', fg: '#422006' },
  { id: 'rain', bg: '#BFDBFE', fg: '#0C2D52' },
  { id: 'graphite', bg: '#334155', fg: '#F1F5F9' },
  { id: 'wheat', bg: '#F5E6C8', fg: '#422006' },
  { id: 'cloud', bg: '#F1F5F9', fg: '#0F172A' },
  { id: 'ink', bg: '#111827', fg: '#E5E7EB' }
];

const dom = {
  title: document.getElementById('title'),
  swatches: document.getElementById('swatches'),
  editor: document.getElementById('editor'),
  status: document.getElementById('status'),
  counter: document.getElementById('counter'),
  close: document.getElementById('btn-close')
};

let state = null;
let data = { title: '', html: '', color: '#FDE68A', ruled: true };
let saveTimer = null;

function T(key) {
  const pack = (state && state.strings) || {};
  return pack[key] !== undefined ? pack[key] : key;
}

function applyColor() {
  document.documentElement.style.setProperty('--note-bg', data.color);
  const c = COLORS.find((x) => x.bg.toLowerCase() === String(data.color).toLowerCase());
  const fg = c ? c.fg : luminanceFg(data.color);
  document.documentElement.style.setProperty('--note-fg', fg);
  [...dom.swatches.children].forEach((n) => {
    n.classList.toggle('active', n.dataset.color.toLowerCase() === String(data.color).toLowerCase());
  });
  document.body.classList.toggle('ruled', data.ruled !== false);
}

function luminanceFg(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return '#111827';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#111827' : '#F8FAFC';
}

function scheduleSave() {
  dom.status.textContent = '…';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 420);
}

async function save() {
  saveTimer = null;
  data.html = dom.editor.value;
  data.title = dom.title.textContent.trim() || data.title;
  const res = await window.tuck.stickies.save(ID, data);
  dom.status.textContent = res && res.ok ? '' : '!';
  updateCounter();
}

function updateCounter() {
  const text = dom.editor.value;
  dom.counter.textContent = `${text.length} 字`;
}

function buildSwatches() {
  COLORS.forEach((c) => {
    const sw = document.createElement('div');
    sw.className = 'sw';
    sw.style.background = c.bg;
    sw.dataset.color = c.bg;
    sw.title = c.id;
    sw.addEventListener('click', () => {
      data.color = c.bg;
      applyColor();
      scheduleSave();
    });
    dom.swatches.appendChild(sw);
  });
}

async function boot() {
  state = await window.tuck.stickies.get(ID);
  if (!state) return;
  data = Object.assign({ title: '', html: '', color: '#FDE68A', ruled: true }, state.content || {});
  if (state.item && state.item.name) data.title = data.title || state.item.name;

  document.title = data.title;
  dom.title.textContent = data.title;
  dom.editor.value = data.html || '';
  buildSwatches();
  applyColor();
  updateCounter();

  dom.editor.addEventListener('input', () => {
    updateCounter();
    scheduleSave();
  });

  dom.title.addEventListener('click', () => {
    const next = window.prompt(T('common.rename'), dom.title.textContent);
    if (next === null) return;
    const name = next.trim();
    if (!name) return;
    dom.title.textContent = name;
    data.title = name;
    scheduleSave();
  });

  dom.close.addEventListener('click', async () => {
    await save();
    window.tuck.stickies.close(ID);
  });

  /* 标题为纯文本编辑，避免富文本注入 */
  dom.title.addEventListener('blur', () => {
    data.title = dom.title.textContent.trim() || data.title;
  });

  window.tuck.stickies.onState((payload) => {
    if (!payload || !payload.item || payload.item.id !== ID) return;
    if (payload.item.name && payload.item.name !== data.title) {
      data.title = payload.item.name;
      dom.title.textContent = data.title;
    }
  });

  window.addEventListener('beforeunload', () => {
    if (saveTimer) save();
  });
}

boot().catch((err) => {
  document.body.textContent = `加载失败：${err && err.message}`;
});

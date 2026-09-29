'use strict';
/** todo.js —— 待办窗口 */

const params = new URLSearchParams(location.search);
const ID = params.get('id') || '';

const COLORS = [
  { id: 'rain', bg: '#BFDBFE', fg: '#0C2D52' },
  { id: 'sun', bg: '#FDE68A', fg: '#422006' },
  { id: 'cloud', bg: '#F1F5F9', fg: '#0F172A' },
  { id: 'graphite', bg: '#334155', fg: '#F1F5F9' },
  { id: 'ink', bg: '#111827', fg: '#E5E7EB' }
];

const dom = {
  title: document.getElementById('title'),
  swatches: document.getElementById('swatches'),
  list: document.getElementById('list'),
  add: document.getElementById('add'),
  addBtn: document.getElementById('btn-add'),
  status: document.getElementById('status'),
  counter: document.getElementById('counter'),
  close: document.getElementById('btn-close')
};

let state = null;
let data = { title: '', color: '#BFDBFE', items: [], separators: true };
let saveTimer = null;

function T(key) {
  const pack = (state && state.strings) || {};
  return pack[key] !== undefined ? pack[key] : key;
}

function luminanceFg(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return '#0F172A';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#0F172A' : '#F8FAFC';
}

function applyColor() {
  document.documentElement.style.setProperty('--note-bg', data.color);
  document.documentElement.style.setProperty('--note-fg', luminanceFg(data.color));
  [...dom.swatches.children].forEach((n) => {
    n.classList.toggle('active', n.dataset.color.toLowerCase() === String(data.color).toLowerCase());
  });
  document.body.classList.toggle('separators', data.separators !== false);
}

function scheduleSave() {
  dom.status.textContent = '…';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 360);
}

async function save() {
  saveTimer = null;
  data.title = dom.title.textContent.trim() || data.title;
  const res = await window.tuck.stickies.save(ID, data);
  dom.status.textContent = res && res.ok ? '' : '!';
  updateCounter();
}

function updateCounter() {
  const done = data.items.filter((i) => i.done).length;
  dom.counter.textContent = `${data.items.length - done} / ${data.items.length}`;
}

function render() {
  dom.list.textContent = '';
  if (data.items.length === 0) {
    dom.list.appendChild(Object.assign(document.createElement('div'), { className: 'empty', textContent: '暂无待办' }));
  }
  data.items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `ti${item.done ? ' done' : ''}`;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!item.done;
    cb.addEventListener('change', () => {
      data.items[index].done = cb.checked;
      render();
      scheduleSave();
    });

    const txt = document.createElement('div');
    txt.className = 'txt';
    txt.textContent = item.text;
    txt.addEventListener('click', () => startEdit(txt, index));

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = T('common.delete');
    del.addEventListener('click', () => {
      data.items.splice(index, 1);
      render();
      scheduleSave();
    });

    row.append(cb, txt, del);
    dom.list.appendChild(row);
  });
  updateCounter();
}

function startEdit(node, index) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = data.items[index].text;
  input.style.width = '100%';
  node.replaceWith(input);
  input.focus();
  input.select();

  const commit = (save_) => {
    const text = input.value.trim();
    if (save_ && text) data.items[index].text = text;
    if (save_ && !text) data.items.splice(index, 1);
    render();
    if (save_) scheduleSave();
  };
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      input.removeEventListener('blur', commit);
      commit(false);
    }
  });
}

function addItem() {
  const text = dom.add.value.trim();
  if (!text) return;
  data.items.push({ text, done: false });
  dom.add.value = '';
  render();
  scheduleSave();
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
  data = Object.assign({ title: '', color: '#BFDBFE', items: [], separators: true }, state.content || {});
  if (!Array.isArray(data.items)) data.items = [];
  if (state.item && state.item.name) data.title = data.title || state.item.name;

  document.title = data.title;
  dom.title.textContent = data.title;
  buildSwatches();
  applyColor();
  render();

  dom.addBtn.addEventListener('click', addItem);
  dom.add.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addItem();
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

'use strict';
/**
 * ui.js —— 渲染层通用小工具
 *
 * 以普通脚本方式加载（先于页面脚本），因此下列函数在页面中直接可用；
 * 同时通过 window.UI 暴露一份命名空间，便于按需取用。
 * 所有 DOM 一律用 createElement 构建，避免 innerHTML 拼接带来的转义问题。
 */

/** 创建元素：el('div', {class:'x'}, [child, 'text']) */
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        // 事件名区分大小写：onClick -> click，onDblClick -> dblclick
        node.addEventListener(k.slice(2).toLowerCase(), v);
      }
      else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (children) {
    for (const c of [].concat(children)) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 简易图标：返回 svg 元素 */
function icon(pathData, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size || 17);
  svg.setAttribute('height', size || 17);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [].concat(pathData)) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const ICONS = {
  system: ['M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z', 'M9 12l2 2 4-4'],
  display: ['M3 5h18v11H3z', 'M8 20h8', 'M12 16v4'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h10'],
  interaction: ['M9 3v4', 'M15 3v4', 'M6 7h12v6a6 6 0 01-6 6 6 6 0 01-6-6z', 'M12 19v2'],
  theme: ['M12 3a9 9 0 100 18 3 3 0 003-3 3 3 0 013-3h1a2 2 0 002-2 9 9 0 00-9-10z', 'M7.5 11.5h.01', 'M11 8h.01', 'M15.5 9.5h.01'],
  organizer: ['M3 5h7v6H3z', 'M14 5h7v6h-7z', 'M3 13h7v6H3z', 'M14 13h7v6h-7z'],
  station: ['M4 4h16v4H4z', 'M4 10h16v4H4z', 'M4 16h16v4H4z'],
  dock: ['M3 15h18', 'M5 15V9a2 2 0 012-2h1a2 2 0 012 2v6', 'M12 15V7a2 2 0 012-2h1a2 2 0 012 2v8'],
  update: ['M12 3v12', 'M7 10l5 5 5-5', 'M4 20h16'],
  folder: ['M3 6h6l2 2h10v10H3z'],
  plus: ['M12 5v14', 'M5 12h14'],
  open: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5'],
  trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13'],
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  refresh: ['M20 11a8 8 0 10-2 6', 'M20 5v6h-6'],
  edit: ['M4 20h4L19 9l-4-4L4 16z'],
  eye: ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z', 'M12 15a3 3 0 100-6 3 3 0 000 6z'],
  check: ['M4 12l5 5L20 6'],
  warn: ['M12 4l9 16H3z', 'M12 10v5', 'M12 17h.01'],
  info: ['M12 21a9 9 0 100-18 9 9 0 000 18z', 'M12 11v5', 'M12 8h.01'],
  settings: ['M12 15a3 3 0 100-6 3 3 0 000 6z', 'M19 12a7 7 0 00-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 00-1.7-1L14.5 3h-4l-.4 2.5a7 7 0 00-1.7 1l-2.3-1-2 3.4L4 11a7 7 0 000 2l-2 1.5 2 3.4 2.3-1a7 7 0 001.7 1l.4 2.5h4l.4-2.5a7 7 0 001.7-1l2.3 1 2-3.4-2-1.5c.06-.33.1-.66.1-1z'],
  note: ['M5 4h14v12l-4 4H5z', 'M15 20v-4h4'],
  todo: ['M4 6l2 2 3-3', 'M4 14l2 2 3-3', 'M12 7h8', 'M12 15h8']
};

function ico(name, size) {
  return icon(ICONS[name] || ICONS.info, size);
}

/* ------------------------------ 吐司 ------------------------------ */

let toastHost = null;
function toast(message, kind, ms) {
  if (!toastHost) {
    toastHost = document.getElementById('toasts');
    if (!toastHost) {
      toastHost = el('div', { id: 'toasts' });
      document.body.appendChild(toastHost);
    }
  }
  const node = el('div', { class: `toast ${kind || ''}`, text: String(message) });
  toastHost.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .18s, transform .18s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 200);
  }, ms || 3200);
}

/* ------------------------------ 控件工厂 ------------------------------ */

function row(title, desc, control) {
  return el('div', { class: 'row' }, [
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title', text: title }),
      desc ? el('div', { class: 'row-desc', text: desc }) : null
    ]),
    el('div', { class: 'row-control' + (control && control.wide ? ' wide' : '') }, control ? control.nodes : null)
  ]);
}

/** 开关：返回 { nodes, set } */
function toggle(checked, onChange, disabled) {
  const input = el('input', { type: 'checkbox' });
  input.checked = !!checked;
  input.disabled = !!disabled;
  input.addEventListener('change', () => onChange(input.checked));
  const nodes = [el('label', { class: 'switch' }, [input, el('span', { class: 'track' }), el('span', { class: 'thumb' })])];
  nodes.set = (v) => {
    input.checked = !!v;
  };
  return { nodes, input, set: nodes.set };
}

/** 滑块：返回 { nodes, set } */
function slider(value, min, max, step, format, onChange) {
  const input = el('input', { type: 'range', min, max, step });
  input.value = value;
  const label = el('span', { class: 'slider-value', text: format(value) });
  let timer = null;
  input.addEventListener('input', () => {
    label.textContent = format(Number(input.value));
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange(Number(input.value)), 90);
  });
  const nodes = [el('div', { class: 'slider-row', wide: true }, [input, label])];
  nodes.set = (v) => {
    input.value = v;
    label.textContent = format(Number(v));
  };
  return { nodes, input, set: nodes.set };
}

/** 分段控件：返回 { nodes, set } */
function segmented(options, value, onChange) {
  const buttons = [];
  const wrap = el('div', { class: 'segmented' });
  const setActive = (v) => {
    buttons.forEach((b, i) => b.classList.toggle('active', options[i].id === v));
  };
  options.forEach((opt) => {
    const b = el('button', {
      type: 'button',
      text: opt.label,
      title: opt.title || opt.label,
      onClick: () => {
        setActive(opt.id);
        onChange(opt.id);
      }
    });
    buttons.push(b);
    wrap.appendChild(b);
  });
  setActive(value);
  return { nodes: [wrap], set: setActive };
}

/** 下拉框 */
function select(options, value, onChange) {
  const node = el('select');
  options.forEach((o) => node.appendChild(el('option', { value: o.id, text: o.label })));
  node.value = value;
  node.addEventListener('change', () => onChange(node.value));
  return { nodes: [node], node, set: (v) => { node.value = v; } };
}

function button(label, onClick, kind) {
  return el('button', { class: `btn ${kind || ''}`, type: 'button', text: label, onClick });
}

function card(title, bodyNodes, headExtra) {
  return el('div', { class: 'card' }, [
    title ? el('div', { class: 'card-head' }, [el('h3', { text: title }), headExtra || null]) : null,
    el('div', { class: 'card-body' }, bodyNodes)
  ]);
}

function pageHead(title, subtitle) {
  return el('div', { class: 'page-head' }, [el('h2', { text: title }), el('p', { text: subtitle })]);
}

/** 简易确认框（避免使用阻塞式 confirm） */
function confirmDialog(message, okLabel) {
  return new Promise((resolve) => {
    const back = el('div', {
      style: {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,0,0,.42)',
        display: 'grid',
        placeItems: 'center',
        zIndex: '9500'
      }
    });
    const box = el('div', {
      class: 'card',
      style: { width: '380px', padding: '18px', boxShadow: 'var(--shadow-lg)' }
    }, [
      el('div', { style: { lineHeight: '1.65', marginBottom: '16px' }, text: message }),
      el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, [
        button(okLabel === undefined ? '取消' : '取消', () => done(false)),
        button(okLabel || '确定', () => done(true), 'primary')
      ])
    ]);
    function done(v) {
      back.remove();
      resolve(v);
    }
    back.appendChild(box);
    back.addEventListener('click', (e) => {
      if (e.target === back) done(false);
    });
    document.body.appendChild(back);
  });
}

/** 输入框弹窗 */
function promptDialog(title, initial, placeholder) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value: initial || '', placeholder: placeholder || '' });
    const back = el('div', {
      style: {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,0,0,.42)',
        display: 'grid',
        placeItems: 'center',
        zIndex: '9500'
      }
    });
    const done = (v) => {
      back.remove();
      resolve(v);
    };
    const box = el('div', { class: 'card', style: { width: '400px', padding: '18px', boxShadow: 'var(--shadow-lg)' } }, [
      el('div', { style: { fontWeight: '600', marginBottom: '10px' }, text: title }),
      input,
      el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } }, [
        button('取消', () => done(null)),
        button('确定', () => done(input.value), 'primary')
      ])
    ]);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(null);
    });
    back.appendChild(box);
    back.addEventListener('click', (e) => {
      if (e.target === back) done(null);
    });
    document.body.appendChild(back);
    setTimeout(() => input.focus(), 30);
  });
}

/* ------------------------------ 颜色工具 ------------------------------ */

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return { r: 59, g: 130, b: 246 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

window.UI = {
  el,
  ico,
  icon,
  ICONS,
  toast,
  row,
  toggle,
  slider,
  segmented,
  select,
  button,
  card,
  pageHead,
  confirmDialog,
  promptDialog,
  hexToRgb,
  rgbToHex,
  rgba
};

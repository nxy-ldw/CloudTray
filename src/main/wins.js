'use strict';
/**
 * wins.js —— 窗口管理器
 *
 * 负责收纳窗、中转站、Dock 栏、便签与待办的创建、定位、展开收缩与主题下发。
 * 三类收纳窗口共用同一个渲染页面（surface.html），通过 kind 参数区分形态。
 */

const path = require('path');
const fs = require('fs');
const { BrowserWindow, screen, shell } = require('electron');
const grid = require('./grid');
const fsops = require('./fsops');
const { newId, normalizeItem } = require('./store');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

/* 入口与内容尺寸基准（DIP） */
const ENTRY_BASE = 74;
const NAME_BASE = 15;
const ICON_CELL = 84;
const ROW_HEIGHT = 34;
const EXPANDED_PAD = 12;
const HEADER_HEIGHT = 34;
const STATION_THICKNESS = 64;
const DOCK_PAD = 8;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 依据窗口条目与全局设置计算折叠态尺寸
 * @param {object} item
 * @param {object} config
 * @param {number} [count] 实际内容数量（Dock 需要按它伸缩）
 */
function computeEntrySize(item, config, count) {
  const unit = config.display.uniformEntrySize || 1;

  if (item.kind === 'dock') {
    const icon = item.iconSize;
    const gap = item.spacing;
    const n = Math.max(1, count === undefined ? (item.itemOrder || []).length : count);
    const thickness = Math.round((icon + DOCK_PAD * 2 + 8) * unit);
    const length = Math.round((DOCK_PAD * 2 + n * icon + Math.max(0, n - 1) * gap + 12) * unit);
    return item.orientation === 'vertical'
      ? { width: thickness, height: clamp(length, 60, 1400) }
      : { width: clamp(length, 60, 1800), height: thickness };
  }

  if (item.kind === 'station') {
    // 折叠态是一条贴边窄条：厚度固定，长度适中
    const thickness = Math.round(STATION_THICKNESS * unit);
    const length = Math.round(152 * unit);
    return item.edge === 'left' || item.edge === 'right'
      ? { width: thickness, height: length }
      : { width: length, height: thickness };
  }

  const size = Math.round(ENTRY_BASE * unit);
  const nameScale = config.display.compactNameScale || 0.9;
  const nameH = item.nameHidden ? 0 : Math.round(NAME_BASE * nameScale * 1.9);
  return { width: size, height: size + nameH };
}

/** 展开态尺寸 */
function computeExpandedSize(item, config, count) {
  const unit = config.display.uniformEntrySize || 1;
  const canvas = item.canvasScale || 1;
  const cols = item.columns;
  const rows = item.rows;

  if (item.kind === 'station') {
    const along = Math.round(
      (HEADER_HEIGHT + rows * Math.round(ROW_HEIGHT * canvas) + EXPANDED_PAD * 2) * unit
    );
    const depth = Math.round(274 * canvas * unit);
    return item.edge === 'left' || item.edge === 'right'
      ? { width: depth, height: clamp(along, 160, 1100) }
      : { width: clamp(along, 220, 1400), height: depth };
  }

  if (item.kind === 'dock') {
    return computeEntrySize(item, config, count);
  }

  if (item.contentMode === 'compactList') {
    const width = Math.round(272 * canvas * unit);
    const height = Math.round((HEADER_HEIGHT + rows * Math.round(ROW_HEIGHT * canvas) + EXPANDED_PAD) * unit);
    return { width: clamp(width, 180, 720), height: clamp(height, 120, 1200) };
  }
  const cell = Math.round(ICON_CELL * item.itemScale * unit);
  const width = Math.round((cols * cell + EXPANDED_PAD * 2) * canvas);
  const height = Math.round((HEADER_HEIGHT + rows * cell + EXPANDED_PAD) * canvas);
  return { width: clamp(width, 140, 1400), height: clamp(height, 120, 1200) };
}

class WindowManager {
  /**
   * @param {object} deps
   * @param {import('./store').Store} deps.store
   * @param {import('./i18n').I18n} deps.i18n
   * @param {import('./logger').Logger} deps.logger
   */
  constructor(deps) {
    this.store = deps.store;
    this.i18n = deps.i18n;
    this.logger = deps.logger;
    /** @type {Map<string, {item:object, win:BrowserWindow, expanded:boolean, ready:boolean, bounds:object}>} */
    this.live = new Map();
    this.drag = null;
    this.dragTimer = null;
    this.onRequestSettings = deps.onRequestSettings || (() => {});
    this.onItemsChanged = deps.onItemsChanged || (() => {});
    this.quitting = false;
    /** 设置 TUCKDESK_TRACE_BOUNDS=1 可记录每次窗口几何变更的来源 */
    this.traceBounds = !!process.env.TUCKDESK_TRACE_BOUNDS;
  }

  /* ------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------ */

  /** 启动时恢复全部窗口 */
  restoreAll() {
    for (const item of this.store.listItems()) {
      if (item.kind === 'note' || item.kind === 'todo') continue;
      try {
        this.create(item);
      } catch (err) {
        this.logger.error('恢复窗口失败', { id: item.id, name: item.name, error: String(err.message || err) });
      }
    }
  }

  /**
   * 依据条目规格创建窗口
   * @param {object} item
   */
  create(item) {
    if (this.live.has(item.id)) return this.live.get(item.id);

    const config = this.store.data;
    const themeEntry = config.theme[item.kind === 'organizer' ? 'organizer' : item.kind] || config.theme.organizer;
    const glass = themeEntry.mode === 'glass';

    /* 建窗之前就把内容数量数出来：Dock 的尺寸取决于图标个数，
       若先按 0 个估算、等渲染层上报后再缩放，开一次就跳一下 */
    const initialCount = item.storagePath && fsops.dirExists(item.storagePath)
      ? fsops.countEntriesSync(item.storagePath)
      : 0;
    const entry = computeEntrySize(item, config, initialCount);
    const initial = this.resolveInitialBounds(item, entry, config);

    const win = new BrowserWindow({
      x: initial.x,
      y: initial.y,
      width: initial.width,
      height: initial.height,
      minWidth: 48,
      minHeight: 40,
      frame: false,
      transparent: !glass,
      backgroundColor: '#00000000',
      backgroundMaterial: glass ? 'acrylic' : undefined,
      roundedCorners: true,
      useContentSize: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      show: false,
      acceptFirstMouse: true,
      title: item.name,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false
      }
    });

    if (glass) {
      try {
        win.setBackgroundMaterial('acrylic');
      } catch (_) {
        /* Windows 10 等不支持时静默降级到半透明纯色 */
      }
    }

    const state = { item, win, expanded: false, ready: false, bounds: initial, glass, itemCount: initialCount };
    this.live.set(item.id, state);

    const query = new URLSearchParams({
      kind: item.kind,
      id: item.id,
      v: String(Date.now())
    });
    win.loadFile(path.join(RENDERER, 'surface.html'), { search: `?${query.toString()}` });

    win.webContents.once('did-finish-load', () => {
      state.ready = true;
      this.pushState(item.id);
      if (item.visible !== false) win.showInactive();
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      this.logger.error('渲染进程异常退出', { id: item.id, reason: details.reason });
    });

    win.on('closed', () => {
      this.live.delete(item.id);
    });

    // 兜底：拖动过程中窗口失去焦点（例如 Alt+Tab），结束拖动
    win.on('blur', () => {
      if (this.drag && this.drag.id === item.id) this.endDrag();
    });

    // 阻止关闭：收纳窗只能通过删除操作移除
    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        win.hide();
        this.store.updateItem(item.id, { visible: false });
        this.onItemsChanged();
      }
    });

    return state;
  }

  /** 计算窗口初始位置 */
  resolveInitialBounds(item, size, config) {
    const displays = screen.getAllDisplays();
    let display = displays[0];
    if (item.displayId !== null && item.displayId !== undefined) {
      display = displays.find((d) => String(d.id) === String(item.displayId)) || display;
    } else if (item.bounds) {
      display = screen.getDisplayNearestPoint({ x: item.bounds.x, y: item.bounds.y }) || display;
    }
    const wa = display.workArea;

    if (item.kind === 'station') {
      // 贴边：垂直轴锁定在屏幕边缘，沿边位置沿用用户上次摆放的坐标
      const vertical = item.edge === 'left' || item.edge === 'right';
      const along = item.bounds ? (vertical ? item.bounds.y : item.bounds.x) : null;
      return this.placeStation(item, size, wa, along);
    }

    if (item.kind === 'dock') {
      // 位置由用户拖动决定，恢复上次保存的坐标；没有记录时才用默认贴底居中
      let x;
      let y;
      if (item.bounds) {
        x = clamp(item.bounds.x, wa.x, wa.x + wa.width - size.width);
        y = clamp(item.bounds.y, wa.y, wa.y + wa.height - size.height);
      } else if (item.orientation === 'vertical') {
        x = wa.x + wa.width - size.width - 24;
        y = wa.y + (wa.height - size.height) / 2;
      } else {
        x = wa.x + (wa.width - size.width) / 2;
        y = wa.y + wa.height - size.height - 16;
      }
      return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
    }

    // 收纳窗
    if (item.placement === 'positioned' && !item.bounds) {
      const occupied = this.positionedRects(item.id);
      const slot = grid.findFreeSlot(wa, size, occupied, []);
      if (slot) return { x: slot.x, y: slot.y, width: size.width, height: size.height };
    }

    if (item.bounds) {
      const b = item.bounds;
      return {
        x: clamp(b.x, wa.x - size.width + 40, wa.x + wa.width - 40),
        y: clamp(b.y, wa.y, wa.y + wa.height - 40),
        width: size.width,
        height: size.height
      };
    }

    const occupied = this.positionedRects(item.id);
    const slot = grid.findFreeSlot(wa, size, occupied, []);
    if (slot) return { x: slot.x, y: slot.y, width: size.width, height: size.height };
    return {
      x: Math.round(wa.x + wa.width / 2 - size.width / 2),
      y: Math.round(wa.y + wa.height / 2 - size.height / 2),
      width: size.width,
      height: size.height
    };
  }

  /**
   * 读取窗口当前几何。
   *
   * 优先用我们自己记录的值：setBounds 用的是「内容尺寸」，而 getBounds 返回的是
   * 「窗口尺寸」，两者相差一条不可见的调整边框（约 2px）。混用会让位置逐个来回漂移，
   * 所以内部一律以 applyBounds 记录的内容矩形为准。
   */
  currentRect(st) {
    if (st && st.bounds && Number.isFinite(st.bounds.x) && Number.isFinite(st.bounds.width)) {
      return { ...st.bounds };
    }
    const b = st.win.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  /**
   * 所有窗口几何变更的唯一出口，便于排查“窗口自己变大/乱跑”一类问题
   * @param {object} st live 状态
   * @param {{x:number,y:number,width:number,height:number}} rect
   * @param {string} reason 触发来源
   */
  applyBounds(st, rect, reason) {
    if (!st || !st.win || st.win.isDestroyed()) return;
    const target = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
    try {
      st.win.setBounds(target);
      st.bounds = target;
      if (this.traceBounds) {
        const b = st.win.getBounds();
        this.logger.info('GEOM', {
          reason,
          id: st.item.id,
          set: `${target.width}x${target.height}@${target.x},${target.y}`,
          got: `${b.width}x${b.height}@${b.x},${b.y}`,
          expanded: st.expanded
        });
      }
    } catch (err) {
      this.logger.warn('设置窗口位置失败', { reason, id: st.item.id, error: String(err.message || err) });
    }
  }

  /**
   * 计算中转站的贴边位置
   * 垂直轴锁定在屏幕边缘；沿边坐标沿用传入值，缺省时居中。
   * @param {object} item
   * @param {{width:number,height:number}} size
   * @param {{x:number,y:number,width:number,height:number}} wa 工作区
   * @param {number|null} along 沿边坐标
   */
  placeStation(item, size, wa, along) {
    const vertical = item.edge === 'left' || item.edge === 'right';
    const hasAlong = typeof along === 'number' && Number.isFinite(along);
    let x;
    let y;
    if (vertical) {
      x = item.edge === 'left' ? wa.x : wa.x + wa.width - size.width;
      y = hasAlong ? clamp(along, wa.y, wa.y + wa.height - size.height) : wa.y + (wa.height - size.height) / 2;
    } else {
      y = item.edge === 'top' ? wa.y : wa.y + wa.height - size.height;
      x = hasAlong ? clamp(along, wa.x, wa.x + wa.width - size.width) : wa.x + (wa.width - size.width) / 2;
    }
    return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height };
  }

  /**
   * 其它窗口占据的矩形，用于避让与吸附 */
  positionedRects(exceptId) {
    const out = [];
    for (const [id, st] of this.live) {
      if (id === exceptId) continue;
      out.push(this.currentRect(st));
    }
    return out;
  }

  destroy(id) {
    const st = this.live.get(id);
    if (!st) return;
    this.live.delete(id);
    try {
      st.win.destroy();
    } catch (_) {
      /* 忽略 */
    }
  }

  destroyAll() {
    this.quitting = true;
    for (const id of [...this.live.keys()]) this.destroy(id);
  }

  get(id) {
    return this.live.get(id) || null;
  }

  /* ------------------------------------------------------------ *
   * 展开 / 收缩
   * ------------------------------------------------------------ */

  setExpanded(id, expanded) {
    const st = this.live.get(id);
    if (!st) return;
    if (this.traceBounds) {
      const stack = (new Error().stack || '').split('\n').slice(2, 6).join(' <- ').replace(/\s+/g, ' ');
      this.logger.info('EXPAND call', { id, expanded, wasExpanded: st.expanded, stack });
    }
    const item = this.store.getItem(id) || st.item;
    const config = this.store.data;

    if (item.expansion === 'alwaysExpanded' && !expanded) {
      // 展开模式不允许收缩
      return;
    }

    if (expanded && config.interaction.exclusiveExpansion) {
      for (const [otherId, other] of this.live) {
        if (otherId !== id && other.expanded) this.setExpanded(otherId, false);
      }
    }

    const size = expanded
      ? computeExpandedSize(item, config, st.itemCount)
      : computeEntrySize(item, config, st.itemCount);
    const cur = this.currentRect(st);

    let target;
    if (expanded) {
      // 记录折叠态锚点
      st.collapsedBounds = { ...cur };
      if (config.interaction.rememberExpandedPosition && st.expandedBounds) {
        target = { ...st.expandedBounds };
      } else {
        target = this.anchorExpand(item, cur, size);
      }
    } else {
      if (config.interaction.rememberExpandedPosition && st.expanded) {
        st.expandedBounds = { ...cur };
      }
      target = st.collapsedBounds ? { ...st.collapsedBounds } : { ...cur, width: size.width, height: size.height };
      target.width = size.width;
      target.height = size.height;
    }

    st.expanded = expanded;
    this.applyBounds(st, target, expanded ? 'setExpanded:expand' : 'setExpanded:collapse');
    this.pushState(id);
  }

  /**
   * 展开时保持入口锚点不动：按贴边方向向外生长
   */
  anchorExpand(item, cur, size) {
    const display = screen.getDisplayNearestPoint({ x: cur.x, y: cur.y });
    const wa = display.workArea;

    if (item.kind === 'station') {
      switch (item.edge) {
        case 'top':
          return { x: clamp(cur.x, wa.x, wa.x + wa.width - size.width), y: wa.y, ...size };
        case 'right':
          return { x: wa.x + wa.width - size.width, y: clamp(cur.y, wa.y, wa.y + wa.height - size.height), ...size };
        case 'bottom':
          return {
            x: clamp(cur.x, wa.x, wa.x + wa.width - size.width),
            y: wa.y + wa.height - size.height,
            ...size
          };
        case 'left':
        default:
          return { x: wa.x, y: clamp(cur.y, wa.y, wa.y + wa.height - size.height), ...size };
      }
    }

    if (item.kind === 'dock') {
      return {
        x: clamp(cur.x + cur.width - size.width, wa.x, wa.x + wa.width - size.width),
        y: clamp(cur.y + cur.height - size.height, wa.y, wa.y + wa.height - size.height),
        ...size
      };
    }

    // 收纳窗：默认向右下展开，越界时向左上翻折
    let x = cur.x + cur.width - size.width >= wa.x ? cur.x : cur.x;
    let y = cur.y;
    if (x + size.width > wa.x + wa.width) x = wa.x + wa.width - size.width;
    if (y + size.height > wa.y + wa.height) y = wa.y + wa.height - size.height;
    x = clamp(x, wa.x, wa.x + wa.width - size.width);
    y = clamp(y, wa.y, wa.y + wa.height - size.height);
    return { x, y, ...size };
  }

  previewExpand(id) {
    const st = this.live.get(id);
    if (!st) return null;
    const item = this.store.getItem(id) || st.item;
    return computeExpandedSize(item, this.store.data, st.itemCount);
  }

  /**
   * 渲染层报告实际内容数量：Dock 需要据此伸缩窗口
   * @returns {{ok:boolean, resized?:boolean}}
   */
  setItemCount(id, count) {
    const st = this.live.get(id);
    if (!st) return { ok: false };
    const n = Math.max(0, Number(count) || 0);
    if (st.itemCount === n) return { ok: true, resized: false };
    st.itemCount = n;
    if (st.item.kind !== 'dock') return { ok: true, resized: false };
    this.resizeOne(id);
    return { ok: true, resized: true };
  }

  /* ------------------------------------------------------------ *
   * 拖动（主进程按光标轮询，便于吸附对齐）
   * ------------------------------------------------------------ */

  /**
   * 开始拖动
   *
   * 偏移量一律由主进程自己算：光标位置与窗口矩形都取自主进程，
   * 避免渲染层传来的 screenX 与主进程坐标系因 DPI 缩放而不一致 ——
   * 一旦偏差导致指针落到窗口外，渲染层就收不到 mouseup，
   * 拖动循环会永远跑下去并把窗口越撑越大。
   * @param {string} id
   */
  beginDrag(id) {
    const st = this.live.get(id);
    if (!st) return { ok: false };
    this.endDrag();

    const bounds = this.currentRect(st);
    const pt = screen.getCursorScreenPoint();

    this.drag = {
      id,
      offsetX: pt.x - bounds.x,
      offsetY: pt.y - bounds.y,
      /* 拖动期间尺寸固定：窗口的内容尺寸与窗口尺寸存在差值，
         若每拍都从 getBounds() 读回尺寸再设回去，会形成 +1px 的自我放大循环 */
      size: { width: bounds.width, height: bounds.height },
      others: this.positionedRects(id),
      startedAt: Date.now(),
      lastMoveAt: Date.now()
    };
    if (this.traceBounds) {
      this.logger.info('DRAG begin', { id, offset: { x: this.drag.offsetX, y: this.drag.offsetY }, size: this.drag.size });
    }
    const tick = () => {
      if (!this.drag) return;
      const d = this.drag;
      const live = this.live.get(d.id);
      if (!live) {
        this.endDrag();
        return;
      }
      /* 安全网：指针长时间不动说明 mouseup 已经丢失，最长再等 9 秒收尾；
         正常拖动即使中途停顿也不会被误伤（120 秒硬上限）。 */
      const now = Date.now();
      if (now - d.startedAt > 120000) {
        this.logger.warn('拖动超过硬上限，已强制结束', { id: d.id });
        this.endDrag();
        return;
      }
      if (now - d.lastMoveAt > 9000) {
        this.logger.warn('拖动期间指针长时间静止，判定为丢失 mouseup，已结束拖动', { id: d.id });
        this.endDrag();
        return;
      }
      const pt = screen.getCursorScreenPoint();
      const b = this.currentRect(live);
      if (pt.x !== d.lastX || pt.y !== d.lastY) {
        d.lastX = pt.x;
        d.lastY = pt.y;
        d.lastMoveAt = now;
      }
      let nx = pt.x - d.offsetX;
      let ny = pt.y - d.offsetY;
      const display = screen.getDisplayNearestPoint(pt);
      const wa = display.workArea;
      if (this.store.data.interaction.windowAlignment) {
        const rect = grid.alignRect(
          { x: nx, y: ny, width: d.size.width, height: d.size.height },
          wa,
          d.others,
          12
        );
        nx = rect.x;
        ny = rect.y;
      }
      /* 始终留出可抓取的部分，避免窗口被拖到屏幕外再也点不到 */
      nx = clamp(nx, wa.x - d.size.width + 48, wa.x + wa.width - 48);
      ny = clamp(ny, wa.y, wa.y + wa.height - 32);
      if (nx !== b.x || ny !== b.y) {
        this.applyBounds(live, { x: nx, y: ny, width: d.size.width, height: d.size.height }, 'dragTick');
      }
      this.dragTimer = setTimeout(tick, 16);
    };
    this.dragTimer = setTimeout(tick, 16);
    return { ok: true };
  }

  endDrag() {
    if (this.dragTimer) {
      clearTimeout(this.dragTimer);
      this.dragTimer = null;
    }
    if (!this.drag) return { ok: true };
    const { id } = this.drag;
    this.drag = null;
    const st = this.live.get(id);
    if (!st) return { ok: true };
    const b = this.currentRect(st);

    const item = this.store.getItem(id);
    if (!item) return { ok: true };

    // 定位模式：吸附到网格并避让
    if (item.kind === 'organizer' && item.placement === 'positioned') {
      const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
      const slot = grid.findFreeSlot(display.workArea, b, this.positionedRects(id), []);
      if (slot) {
        this.applyBounds(st, { x: slot.x, y: slot.y, width: b.width, height: b.height }, 'dragEnd:snap');
      }
    }
    if (item.kind === 'station') {
      const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
      const wa = display.workArea;
      const distances = [
        { edge: 'left', d: Math.abs(b.x - wa.x) },
        { edge: 'top', d: Math.abs(b.y - wa.y) },
        { edge: 'right', d: Math.abs(b.x + b.width - (wa.x + wa.width)) },
        { edge: 'bottom', d: Math.abs(b.y + b.height - (wa.y + wa.height)) }
      ].sort((p, q) => p.d - q.d);
      const edge = distances[0].edge;
      this.store.updateItem(id, { edge, displayId: display.id });
      /* 换了贴边方向，宽高随之互换；立刻按新尺寸归位，
         否则要等到下一次设置变更才跳一下 */
      st.item = this.store.getItem(id) || st.item;
      this.resizeOne(id);
    }

    const finalBounds = this.currentRect(st);
    this.store.updateItem(id, { bounds: finalBounds });
    this.pushState(id);
    return { ok: true, bounds: finalBounds };
  }

  /* ------------------------------------------------------------ *
   * 状态下发
   * ------------------------------------------------------------ */

  /** 组装渲染层所需的完整上下文 */
  context(id) {
    const st = this.live.get(id);
    if (!st) return null;
    const item = this.store.getItem(id) || st.item;
    const config = this.store.data;

    const dir = item.storagePath;
    return {
      item,
      config: {
        display: config.display,
        interaction: config.interaction,
        contextMenu: config.contextMenu,
        theme: config.theme,
        system: { language: config.system.language, performanceProfile: config.system.performanceProfile }
      },
      strings: this.i18n.pack(config.system.language),
      storageExists: fsops.dirExists(dir),
      expanded: st.expanded
    };
  }

  pushState(id) {
    const st = this.live.get(id);
    if (!st || !st.ready) return;
    const ctx = this.context(id);
    if (!ctx) return;
    try {
      st.win.webContents.send('surface:state', ctx);
    } catch (_) {
      /* 窗口可能正在销毁 */
    }
  }

  /** 向所有窗口广播状态（设置变化后调用） */
  broadcastAll() {
    for (const id of this.live.keys()) {
      this.pushState(id);
      this.reapplyLayer(id);
    }
  }

  /** 主题背景模式变化时需要重建窗口（transparent 在创建后不可改） */
  reapplyThemeIfNeeded() {
    const config = this.store.data;
    for (const [id, st] of [...this.live]) {
      const item = this.store.getItem(id) || st.item;
      const key = item.kind === 'organizer' ? 'organizer' : item.kind;
      const wantGlass = config.theme[key] && config.theme[key].mode === 'glass';
      if (Boolean(st.glass) !== Boolean(wantGlass)) {
        const bounds = this.currentRect(st);
        const expanded = st.expanded;
        this.destroy(id);
        const fresh = this.create(item);
        this.applyBounds(fresh, bounds, 'themeRebuild');
        if (expanded) setTimeout(() => this.setExpanded(id, true), 60);
      }
    }
  }

  reapplyLayer(id) {
    const st = this.live.get(id);
    if (!st) return;
    const item = this.store.getItem(id) || st.item;
    try {
      if (item.kind === 'note' || item.kind === 'todo') {
        st.win.setAlwaysOnTop(this.store.data.display.noteAlwaysOnTop, 'screen-saver');
      } else {
        st.win.setAlwaysOnTop(false);
      }
    } catch (_) {
      /* 忽略 */
    }
  }

  /* ------------------------------------------------------------ *
   * 尺寸重算（设置变动后）
   * ------------------------------------------------------------ */

  /** 重算单个窗口尺寸，保持锚点不变 */
  resizeOne(id) {
    const st = this.live.get(id);
    if (!st) return;
    const config = this.store.data;
    const item = this.store.getItem(id) || st.item;
    const size = st.expanded
      ? computeExpandedSize(item, config, st.itemCount)
      : computeEntrySize(item, config, st.itemCount);
    const b = this.currentRect(st);
    if (b.width === size.width && b.height === size.height) return;

    const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
    const wa = display.workArea;
    let target;

    if (item.kind === 'station') {
      // 垂直轴锁边，沿边坐标保持不变，避免每次重算都跳回屏幕中央
      const vertical = item.edge === 'left' || item.edge === 'right';
      target = this.placeStation(item, size, wa, vertical ? b.y : b.x);
    } else if (item.kind === 'dock') {
      // Dock 的位置完全由用户决定：以中心为锚点缩放，再夹回工作区
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      target = {
        x: Math.round(clamp(cx - size.width / 2, wa.x, wa.x + wa.width - size.width)),
        y: Math.round(clamp(cy - size.height / 2, wa.y, wa.y + wa.height - size.height)),
        width: size.width,
        height: size.height
      };
    } else {
      target = { x: b.x, y: b.y, width: size.width, height: size.height };
    }

    this.applyBounds(st, target, 'resizeOne');
  }

  resizeAll() {
    for (const id of this.live.keys()) this.resizeOne(id);
  }

  /** 统一入口大小：把所有窗口的 settings 中的倍率归一 */
  applyUniformEntrySize(scale) {
    this.store.patch('display', { uniformEntrySize: clamp(scale, 0.6, 1.4) });
    this.resizeAll();
    this.broadcastAll();
  }

  showAll() {
    for (const [id, st] of this.live) {
      try {
        st.win.showInactive();
      } catch (_) {
        /* 忽略 */
      }
      this.store.updateItem(id, { visible: true });
    }
    this.onItemsChanged();
  }

  hideAll() {
    for (const [id, st] of this.live) {
      try {
        st.win.hide();
      } catch (_) {
        /* 忽略 */
      }
      this.store.updateItem(id, { visible: false });
    }
    this.onItemsChanged();
  }

  /** 供诊断包使用 */
  describeLiveWindows() {
    const out = [];
    for (const [id, st] of this.live) {
      const item = this.store.getItem(id);
      out.push({
        id,
        name: item ? item.name : st.item.name,
        kind: item ? item.kind : st.item.kind,
        expanded: st.expanded,
        visible: (() => {
          try {
            return st.win.isVisible();
          } catch (_) {
            return false;
          }
        })(),
        bounds: (() => {
          try {
            return st.win.getBounds();
          } catch (_) {
            return null;
          }
        })()
      });
    }
    return out;
  }
}

module.exports = {
  WindowManager,
  computeEntrySize,
  computeExpandedSize,
  ENTRY_BASE,
  ICON_CELL,
  ROW_HEIGHT,
  HEADER_HEIGHT,
  STATION_THICKNESS
};

'use strict';
/**
 * store.js —— 「收纳桌面」配置存储
 *
 * 单一 JSON 文件承载全部九个板块的设置与窗口定义，便于用户直接查看和手工修改。
 * 读取时对未知字段做丢弃、对缺失字段做补全，保证旧配置升级后依然可用。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 默认值：字段顺序即设置界面的呈现顺序
 * ------------------------------------------------------------------ */

const DEFAULT_THEME_ENTRY = {
  color: '#3B82F6',
  mode: 'glass', // glass | solid
  opacity: 0.82, // 0 ~ 1
  blur: 28 // 0 ~ 60
};

function defaultConfig() {
  return {
    version: CONFIG_VERSION,

    /* 系统 */
    system: {
      launchAtStartup: false,
      folderContextMenu: false,
      desktopContextMenu: false,
      performanceProfile: 'balanced', // powerSaver | balanced | highPerformance
      language: 'zh-CN', // zh-CN | en-US | ja-JP
      defaultStoragePath: '' // 空 = 使用默认目录
    },

    /* 显示 */
    display: {
      hideCollapseIndicator: false,
      noteAlwaysOnTop: true,
      edgeGlow: true,
      compactNameScale: 0.9, // 0.6 ~ 1.0
      expandedNameScale: 1.0, // 0.6 ~ 1.0
      uniformEntrySize: 1.0, // 0.6 ~ 1.4
      showItemCount: true,
      trayIcon: true
    },

    /* 右键菜单：控制收纳窗口右键菜单中出现哪些项目 */
    contextMenu: {
      addItem: true,
      newFolder: true,
      newNote: true,
      newTodo: true,
      paste: true,
      rename: true,
      duplicate: true,
      togglePlacement: true,
      toggleContent: true,
      toggleExpansion: true,
      hideName: true,
      openStorage: true,
      settings: true,
      remove: true
    },

    /* 交互 */
    interaction: {
      collapseOutside: false,
      expandOnHover: true,
      collapseOnPointerLeave: true,
      hoverExpandDelay: 320, // ms
      pointerLeaveCollapseDelay: 420, // ms
      stationCollapseDelay: 700, // ms
      stationActivationDistance: 24, // DIP
      stationHoverDelay: 260, // ms
      windowAlignment: true,
      rememberExpandedPosition: true,
      exclusiveExpansion: false,
      compactHoverMagnification: true,
      dockHoverMagnification: true,
      hoverMagnificationScale: 1.25 // 1.0 ~ 1.6
    },

    /* 主题 */
    theme: {
      organizer: { ...DEFAULT_THEME_ENTRY },
      station: { ...DEFAULT_THEME_ENTRY, color: '#8B5CF6' },
      dock: { ...DEFAULT_THEME_ENTRY, color: '#0EA5E9' },
      settings: { ...DEFAULT_THEME_ENTRY, color: '#2563EB', mode: 'solid', opacity: 1 }
    },

    /* 窗口定义 */
    items: [],

    /* 更新 */
    update: {
      autoCheck: true,
      feedUrl: '',
      lastCheck: null,
      latestVersion: null,
      latestNotes: '',
      lastStatus: 'idle'
    }
  };
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 解析配置文件。
 * 记事本等编辑器保存 UTF-8 时会写入 BOM，PowerShell 的 Set-Content 也会，
 * 直接 JSON.parse 会抛错。这里统一剥掉 BOM 与首尾空白，让手工修改更省心。
 */
function parseConfig(text) {
  const clean = String(text).replace(/^\uFEFF/, '').trim();
  if (!clean) return {};
  return JSON.parse(clean);
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

/** 数值取值：缺失或非法时退回默认值，再做范围收敛 */
function num(v, def, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

/** 用 schema 的形状清洗 raw：只保留 schema 中存在的键，缺失的取默认值 */
function mergeShape(schema, raw) {
  if (!isPlainObject(raw)) return Array.isArray(schema) ? [] : { ...schema };
  const out = {};
  for (const key of Object.keys(schema)) {
    const def = schema[key];
    const val = raw[key];
    if (Array.isArray(def)) {
      out[key] = Array.isArray(val) ? val.slice() : [];
    } else if (isPlainObject(def)) {
      out[key] = mergeShape(def, val);
    } else if (typeof def === 'number') {
      out[key] = Number.isFinite(Number(val)) ? Number(val) : def;
    } else if (typeof def === 'boolean') {
      out[key] = typeof val === 'boolean' ? val : def;
    } else if (val === null || val === undefined) {
      out[key] = def;
    } else if (typeof val === typeof def) {
      out[key] = val;
    } else {
      out[key] = def;
    }
  }
  return out;
}

function normalizeThemeEntry(entry, fallback) {
  const base = { ...DEFAULT_THEME_ENTRY, ...(fallback || {}) };
  const out = {
    color: /^#[0-9a-fA-F]{6}$/.test(String(entry && entry.color)) ? String(entry.color).toUpperCase() : base.color,
    mode: entry && entry.mode === 'solid' ? 'solid' : 'glass',
    opacity: clamp(entry && entry.opacity, 0, 1),
    blur: Math.round(clamp(entry && entry.blur, 0, 60))
  };
  return out;
}

const ENUMS = {
  performanceProfile: ['powerSaver', 'balanced', 'highPerformance'],
  language: ['zh-CN', 'en-US', 'ja-JP'],
  placement: ['floating', 'positioned'],
  expansion: ['collapsible', 'alwaysExpanded'],
  contentMode: ['icon', 'compactList'],
  edge: ['left', 'top', 'right', 'bottom'],
  orientation: ['horizontal', 'vertical'],
  kind: ['organizer', 'station', 'dock', 'note', 'todo']
};

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/* ------------------------------------------------------------------ *
 * 窗口条目
 * ------------------------------------------------------------------ */

function normalizeItem(raw, defaults) {
  if (!isPlainObject(raw)) return null;
  const kind = pickEnum(raw.kind, ENUMS.kind, 'organizer');
  const id = typeof raw.id === 'string' && raw.id ? raw.id : newId(kind);
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : defaultItemName(kind);

  const item = {
    id,
    kind,
    name,
    storagePath: typeof raw.storagePath === 'string' ? raw.storagePath : '',
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    visible: raw.visible !== false,
    nameHidden: raw.nameHidden === true,
    locked: raw.locked === true,
    displayId: raw.displayId === undefined ? null : raw.displayId,
    bounds: isPlainObject(raw.bounds)
      ? {
          x: Math.round(num(raw.bounds.x, 0, -20000, 20000)),
          y: Math.round(num(raw.bounds.y, 0, -20000, 20000)),
          width: Math.round(num(raw.bounds.width, 200, 40, 8000)),
          height: Math.round(num(raw.bounds.height, 200, 30, 8000))
        }
      : null,
    /* 收纳窗 */
    placement: pickEnum(raw.placement, ENUMS.placement, defaults.placement),
    expansion: pickEnum(raw.expansion, ENUMS.expansion, 'collapsible'),
    contentMode: pickEnum(raw.contentMode, ENUMS.contentMode, 'icon'),
    rows: Math.round(num(raw.rows, 3, 1, 12)),
    columns: Math.round(num(raw.columns, 4, 1, 12)),
    compactScale: num(raw.compactScale, 1, 0.6, 1.6),
    canvasScale: num(raw.canvasScale, 1, 0.6, 1.6),
    itemScale: num(raw.itemScale, 1, 0.6, 1.6),
    containedBy: typeof raw.containedBy === 'string' ? raw.containedBy : null,
    itemOrder: Array.isArray(raw.itemOrder) ? raw.itemOrder.filter((s) => typeof s === 'string') : [],
    /* 中转站 */
    edge: pickEnum(raw.edge, ENUMS.edge, 'left'),
    /* Dock */
    orientation: pickEnum(raw.orientation, ENUMS.orientation, 'horizontal'),
    iconSize: Math.round(num(raw.iconSize, 48, 24, 96)),
    spacing: Math.round(num(raw.spacing, 12, 0, 48))
  };
  return item;
}

function defaultItemName(kind) {
  switch (kind) {
    case 'station':
      return '中转站';
    case 'dock':
      return 'Dock 栏';
    case 'note':
      return '便签';
    case 'todo':
      return '待办';
    default:
      return '收纳窗';
  }
}

function newId(kind) {
  const prefix = { organizer: 'org', station: 'sta', dock: 'dck', note: 'nte', todo: 'tdo' }[kind] || 'itm';
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

class Store {
  /**
   * @param {string} dataRoot 用户数据根目录
   */
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.configPath = path.join(dataRoot, 'config.json');
    this.logDir = path.join(dataRoot, 'logs');
    this.data = defaultConfig();
    this._saveTimer = null;
    this._listeners = new Set();
  }

  load() {
    let raw = null;
    try {
      if (fs.existsSync(this.configPath)) {
        raw = parseConfig(fs.readFileSync(this.configPath, 'utf8'));
      }
    } catch (err) {
      // 配置损坏时保留现场，避免用户数据被静默覆盖
      try {
        const backup = `${this.configPath}.broken-${Date.now()}`;
        fs.copyFileSync(this.configPath, backup);
      } catch (_) {
        /* 忽略 */
      }
      raw = null;
    }

    const merged = mergeShape(defaultConfig(), raw || {});

    /* 枚举与数值范围二次校正 */
    merged.version = CONFIG_VERSION;
    merged.system.performanceProfile = pickEnum(
      merged.system.performanceProfile,
      ENUMS.performanceProfile,
      'balanced'
    );
    merged.system.language = pickEnum(merged.system.language, ENUMS.language, 'zh-CN');
    merged.display.compactNameScale = clamp(merged.display.compactNameScale, 0.6, 1.0);
    merged.display.expandedNameScale = clamp(merged.display.expandedNameScale, 0.6, 1.0);
    merged.display.uniformEntrySize = clamp(merged.display.uniformEntrySize, 0.6, 1.4);
    merged.interaction.hoverExpandDelay = Math.round(clamp(merged.interaction.hoverExpandDelay, 0, 3000));
    merged.interaction.pointerLeaveCollapseDelay = Math.round(
      clamp(merged.interaction.pointerLeaveCollapseDelay, 0, 3000)
    );
    merged.interaction.stationCollapseDelay = Math.round(clamp(merged.interaction.stationCollapseDelay, 0, 5000));
    merged.interaction.stationActivationDistance = Math.round(
      clamp(merged.interaction.stationActivationDistance, 0, 400)
    );
    merged.interaction.stationHoverDelay = Math.round(clamp(merged.interaction.stationHoverDelay, 0, 3000));
    merged.interaction.hoverMagnificationScale = clamp(merged.interaction.hoverMagnificationScale, 1.0, 1.6);

    for (const key of ['organizer', 'station', 'dock', 'settings']) {
      merged.theme[key] = normalizeThemeEntry(merged.theme[key], DEFAULT_THEME_ENTRY);
    }

    const defaults = { placement: 'floating' };
    merged.items = (Array.isArray(merged.items) ? merged.items : [])
      .map((it) => normalizeItem(it, defaults))
      .filter(Boolean);

    this.data = merged;
    return this.data;
  }

  save() {
    const dir = path.dirname(this.configPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, this.configPath);
    } catch (_) {
      fs.copyFileSync(tmp, this.configPath);
      try {
        fs.unlinkSync(tmp);
      } catch (__) {
        /* 忽略 */
      }
    }
  }

  /** 合并式更新某个板块，并落盘 + 通知订阅者 */
  patch(section, values) {
    if (!isPlainObject(this.data[section])) return this.data;
    Object.assign(this.data[section], values);
    this.save();
    this.emit(section);
    return this.data[section];
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit(section) {
    for (const fn of this._listeners) {
      try {
        fn(section, this.data);
      } catch (_) {
        /* 订阅者异常不影响主流程 */
      }
    }
  }

  /* --------------------------- 窗口条目 --------------------------- */

  listItems(kind) {
    if (!kind) return this.data.items.slice();
    return this.data.items.filter((it) => it.kind === kind);
  }

  getItem(id) {
    return this.data.items.find((it) => it.id === id) || null;
  }

  findByName(name) {
    return this.data.items.find((it) => it.name === name) || null;
  }

  addItem(raw) {
    const item = normalizeItem(raw, { placement: 'floating' });
    if (!item) throw new Error('invalid item');
    this.data.items.push(item);
    this.save();
    this.emit('items');
    return item;
  }

  updateItem(id, values) {
    const idx = this.data.items.findIndex((it) => it.id === id);
    if (idx < 0) return null;
    const merged = { ...this.data.items[idx], ...values, updatedAt: Date.now() };
    const fresh = normalizeItem(merged, { placement: this.data.items[idx].placement });
    this.data.items[idx] = fresh;
    this.save();
    this.emit('items');
    return fresh;
  }

  removeItem(id) {
    const idx = this.data.items.findIndex((it) => it.id === id);
    if (idx < 0) return null;
    const [removed] = this.data.items.splice(idx, 1);
    // 释放被它收纳的子窗
    for (const it of this.data.items) {
      if (it.containedBy === id) it.containedBy = null;
    }
    this.save();
    this.emit('items');
    return removed;
  }

  /** 生成不与现有窗口重名的名称 */
  uniqueName(base) {
    const taken = new Set(this.data.items.map((it) => it.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base} ${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base} ${Date.now()}`;
  }

  /* --------------------------- 路径 --------------------------- */

  /** 默认收纳根目录（用户未自定义时使用） */
  defaultStorageRoot() {
    return path.join(this.dataRoot, 'Organizers');
  }

  effectiveStorageRoot() {
    const custom = (this.data.system.defaultStoragePath || '').trim();
    return custom || this.defaultStorageRoot();
  }
}

module.exports = {
  Store,
  CONFIG_VERSION,
  DEFAULT_THEME_ENTRY,
  defaultConfig,
  normalizeThemeEntry,
  normalizeItem,
  newId,
  clamp,
  pickEnum,
  ENUMS
};

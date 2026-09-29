'use strict';
/**
 * stickies.js —— 便签与待办窗口
 *
 * 两者都是独立的小窗，内容保存在数据目录下的 notes/ 与 todos/ 中，
 * 通过 data 字段持久化到 config.items 里以便记住位置与尺寸。
 */

const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

const DEFAULTS = {
  note: { width: 260, height: 240 },
  todo: { width: 280, height: 300 }
};

class StickyManager {
  constructor(deps) {
    this.store = deps.store;
    this.i18n = deps.i18n;
    this.logger = deps.logger;
    this.dataRoot = deps.dataRoot;
    this.onItemsChanged = deps.onItemsChanged || (() => {});
    /** @type {Map<string, BrowserWindow>} */
    this.live = new Map();
    this.quitting = false;
  }

  contentDir(kind) {
    const dir = path.join(this.dataRoot, kind === 'note' ? 'notes' : 'todos');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  contentPath(item) {
    return path.join(this.contentDir(item.kind), `${item.id}.json`);
  }

  readContent(item) {
    try {
      return JSON.parse(fs.readFileSync(this.contentPath(item), 'utf8'));
    } catch (_) {
      return item.kind === 'note'
        ? { title: item.name, html: '', color: '#FDE68A' }
        : { title: item.name, color: '#93C5FD', items: [] };
    }
  }

  writeContent(item, data) {
    try {
      fs.writeFileSync(this.contentPath(item), JSON.stringify(data, null, 2), 'utf8');
      return { ok: true };
    } catch (err) {
      this.logger.error('便签/待办保存失败', { id: item.id, error: String(err.message || err) });
      return { ok: false, error: String(err.message || err) };
    }
  }

  restoreAll() {
    for (const item of this.store.listItems()) {
      if (item.kind !== 'note' && item.kind !== 'todo') continue;
      try {
        this.create(item);
      } catch (err) {
        this.logger.error('恢复便签/待办失败', { id: item.id, error: String(err.message || err) });
      }
    }
  }

  create(item) {
    if (this.live.has(item.id)) {
      const w = this.live.get(item.id);
      w.showInactive();
      return w;
    }
    const size = DEFAULTS[item.kind] || DEFAULTS.note;
    const b = item.bounds || {};
    const win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width || size.width,
      height: b.height || size.height,
      minWidth: 180,
      minHeight: 140,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      roundedCorners: true,
      resizable: true,
      movable: true,
      skipTaskbar: true,
      hasShadow: true,
      show: false,
      title: item.name,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    });

    this.live.set(item.id, win);

    const query = new URLSearchParams({ kind: item.kind, id: item.id });
    win.loadFile(path.join(RENDERER, `${item.kind}.html`), { search: `?${query.toString()}` });

    win.webContents.once('did-finish-load', () => {
      win.showInactive();
      this.pushState(item.id);
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      this.logger.error('便签/待办渲染进程异常', { id: item.id, reason: details.reason });
    });

    win.on('moved', () => {
      try {
        const cur = win.getBounds();
        this.store.updateItem(item.id, { bounds: cur });
      } catch (_) {
        /* 忽略 */
      }
    });

    win.on('closed', () => {
      this.live.delete(item.id);
    });

    return win;
  }

  pushState(id) {
    const win = this.live.get(id);
    if (!win) return;
    const item = this.store.getItem(id);
    if (!item) return;
    const payload = {
      item,
      content: this.readContent(item),
      strings: this.i18n.pack(this.store.data.system.language),
      alwaysOnTop: this.store.data.display.noteAlwaysOnTop
    };
    try {
      win.webContents.send('sticky:state', payload);
    } catch (_) {
      /* 忽略 */
    }
  }

  pushAll() {
    for (const id of this.live.keys()) this.pushState(id);
  }

  setAlwaysOnTop(enabled) {
    for (const win of this.live.values()) {
      try {
        win.setAlwaysOnTop(enabled, 'screen-saver');
      } catch (_) {
        /* 忽略 */
      }
    }
  }

  save(id, data) {
    const item = this.store.getItem(id);
    if (!item) return { ok: false, error: 'missing' };
    const res = this.writeContent(item, data);
    if (res.ok && data && typeof data.title === 'string' && data.title.trim() && data.title !== item.name) {
      const name = this.store.uniqueName(data.title.trim());
      this.store.updateItem(id, { name });
      this.onItemsChanged();
    }
    return res;
  }

  close(id) {
    const win = this.live.get(id);
    if (win) {
      this.quitting = true;
      win.destroy();
      this.live.delete(id);
      this.quitting = false;
    }
    this.store.removeItem(id);
    try {
      fs.unlinkSync(path.join(this.contentDir(id.startsWith('tdo') ? 'todo' : 'note'), `${id}.json`));
    } catch (_) {
      /* 文件可能已不存在 */
    }
    this.onItemsChanged();
  }

  destroyAll() {
    this.quitting = true;
    for (const [id, win] of [...this.live]) {
      try {
        win.destroy();
      } catch (_) {
        /* 忽略 */
      }
      this.live.delete(id);
    }
  }

  describeLive() {
    const out = [];
    for (const [id, win] of this.live) {
      const item = this.store.getItem(id);
      out.push({
        id,
        name: item ? item.name : '',
        kind: item ? item.kind : '',
        bounds: (() => {
          try {
            return win.getBounds();
          } catch (_) {
            return null;
          }
        })()
      });
    }
    return out;
  }
}

module.exports = { StickyManager };

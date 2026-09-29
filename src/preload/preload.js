'use strict';
/**
 * preload.js —— 渲染层与主进程之间的唯一通道
 *
 * 全部通过 contextBridge 暴露白名单方法，渲染层拿不到 Node 能力。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** 事件订阅辅助 */
function on(channel, handler) {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('tuck', {
  /* 引导 */
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  setLanguage: (lang) => ipcRenderer.invoke('app:setLanguage', lang),
  quit: () => ipcRenderer.invoke('app:quit'),
  openSettings: () => ipcRenderer.invoke('app:openSettings'),
  showAbout: () => ipcRenderer.invoke('app:showAbout'),

  /* 设置 */
  settings: {
    patch: (section, values) => ipcRenderer.invoke('settings:patch', section, values),
    openPath: (target) => ipcRenderer.invoke('settings:openPath', target),
    revealPath: (target) => ipcRenderer.invoke('settings:revealPath', target),
    pickFolder: (opts) => ipcRenderer.invoke('settings:pickFolder', opts),
    setDefaultStorage: (target) => ipcRenderer.invoke('settings:setDefaultStorage', target),
    exportDiagnostics: () => ipcRenderer.invoke('settings:exportDiagnostics'),
    onChange: (handler) => on('settings:changed', handler)
  },

  /* 系统集成 */
  shell: {
    setStartup: (enabled) => ipcRenderer.invoke('shell:setStartup', enabled),
    setContextMenu: (which, enabled) => ipcRenderer.invoke('shell:setContextMenu', which, enabled),
    menuStates: () => ipcRenderer.invoke('shell:menuStates')
  },

  /* 窗口条目 */
  items: {
    create: (spec) => ipcRenderer.invoke('items:create', spec),
    update: (id, values) => ipcRenderer.invoke('items:update', id, values),
    remove: (id, options) => ipcRenderer.invoke('items:delete', id, options),
    duplicate: (id) => ipcRenderer.invoke('items:duplicate', id),
    openStorage: (id) => ipcRenderer.invoke('items:openStorage', id),
    recreateStorage: (id) => ipcRenderer.invoke('items:recreateStorage', id),
    pickStorage: (opts) => ipcRenderer.invoke('items:pickStorage', opts),
    activate: (id) => ipcRenderer.invoke('items:activate', id),
    onChange: (handler) => on('items:changed', handler)
  },

  /* 页面级窗口控制 */
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    close: () => ipcRenderer.invoke('win:close')
  },

  /* 收纳窗 / 中转站 / Dock 栏 */
  surface: {
    init: (id) => ipcRenderer.invoke('surface:init', id),
    setExpanded: (id, expanded) => ipcRenderer.invoke('surface:setExpanded', id, expanded),
    reportCount: (id, count) => ipcRenderer.invoke('surface:itemsCount', id, count),
    dragStart: (id, offset) => ipcRenderer.invoke('surface:dragStart', id, offset),
    dragEnd: (id) => ipcRenderer.invoke('surface:dragEnd', id),
    list: (id, options) => ipcRenderer.invoke('surface:list', id, options),
    open: (target) => ipcRenderer.invoke('surface:open', target),
    reveal: (target) => ipcRenderer.invoke('surface:reveal', target),
    trash: (targets) => ipcRenderer.invoke('surface:trash', targets),
    createFolder: (id, name) => ipcRenderer.invoke('surface:createFolder', id, name),
    rename: (target, newName) => ipcRenderer.invoke('surface:rename', target, newName),
    importPaths: (id, sources, mode) => ipcRenderer.invoke('surface:import', id, sources, mode),
    addViaDialog: (id, kind) => ipcRenderer.invoke('surface:addViaDialog', id, kind),
    paste: (id, mode) => ipcRenderer.invoke('surface:paste', id, mode),
    setName: (id, name) => ipcRenderer.invoke('surface:setName', id, name),
    toggleNameHidden: (id) => ipcRenderer.invoke('surface:toggleNameHidden', id),
    thumbnail: (target, size) => ipcRenderer.invoke('surface:thumbnail', target, size),
    nativeMenu: (id, target) => ipcRenderer.invoke('surface:menu', id, target || null),
    startDrag: (target) => ipcRenderer.send('surface:startDrag', target),
    copyText: (text) => ipcRenderer.invoke('surface:copyText', text),
    onState: (handler) => on('surface:state', handler),
    onCommand: (handler) => on('surface:command', handler),
    onRefresh: (handler) => on('surface:refresh', handler)
  },

  /* 便签 / 待办 */
  stickies: {
    create: (kind, options) => ipcRenderer.invoke('stickies:create', kind, options),
    save: (id, data) => ipcRenderer.invoke('stickies:save', id, data),
    close: (id) => ipcRenderer.invoke('stickies:close', id),
    get: (id) => ipcRenderer.invoke('stickies:get', id),
    onState: (handler) => on('sticky:state', handler)
  },

  /* 更新 */
  update: {
    check: () => ipcRenderer.invoke('update:check')
  },

  /* 拖放：把 File 对象换回真实路径 */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (_) {
      return file && file.path ? file.path : '';
    }
  }
});

'use strict';
/**
 * i18n.js —— 极简多语言支持
 *
 * 语言包为扁平的 `key -> 文案` 映射。渲染层通过 preload 暴露的 API 取得整包，
 * 以便在页面内做即时切换，无需重新加载窗口。
 */

const path = require('path');

const SUPPORTED = ['zh-CN', 'en-US', 'ja-JP'];
const FALLBACK = 'zh-CN';

const cache = new Map();

function loadPack(lang) {
  if (cache.has(lang)) return cache.get(lang);
  let pack;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    pack = require(path.join(__dirname, 'locales', `${lang}.js`));
  } catch (_) {
    pack = null;
  }
  if (!pack) {
    if (lang !== FALLBACK) return loadPack(FALLBACK);
    pack = {};
  }
  cache.set(lang, pack);
  return pack;
}

/** 语言偏好归一化：zh、zh-Hans、zh-CN 均归到 zh-CN */
function normalizeLang(input) {
  const raw = String(input || '').replace('_', '-');
  if (!raw) return FALLBACK;
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) {
    return /tw|hk|mo|hant/.test(lower) ? FALLBACK : 'zh-CN';
  }
  if (lower.startsWith('ja')) return 'ja-JP';
  if (lower.startsWith('en')) return 'en-US';
  const exact = SUPPORTED.find((s) => s.toLowerCase() === lower);
  return exact || FALLBACK;
}

/** 依据操作系统语言猜测默认语言 */
function detectSystemLang() {
  const candidates = [];
  if (process.env.LC_ALL) candidates.push(process.env.LC_ALL);
  if (process.env.LANG) candidates.push(process.env.LANG);
  try {
    // app.getLocale() 由调用方注入，避免此处依赖 electron 生命周期
    candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch (_) {
    /* 忽略 */
  }
  for (const c of candidates) {
    const n = normalizeLang(c);
    if (n) return n;
  }
  return FALLBACK;
}

class I18n {
  constructor(lang) {
    this.lang = normalizeLang(lang);
  }

  setLanguage(lang) {
    this.lang = normalizeLang(lang);
    return this.lang;
  }

  /** 取整包（含回退语言补全），供渲染层使用 */
  pack(lang) {
    const target = loadPack(normalizeLang(lang || this.lang));
    const base = loadPack(FALLBACK);
    return { ...base, ...target };
  }

  t(key, params) {
    const target = loadPack(this.lang);
    const base = loadPack(FALLBACK);
    let text = target[key] !== undefined ? target[key] : base[key];
    if (text === undefined) return key;
    if (params !== undefined && params !== null) {
      /* 语言包统一使用 {0} {1} 位置占位符；同时兼容 {name} 命名占位符 */
      const list = Array.isArray(params) ? params : [params];
      const named = typeof params === 'object' && !Array.isArray(params) ? params : null;
      text = String(text).replace(/\{(\w+)\}/g, (m, name) => {
        if (/^\d+$/.test(name)) {
          const i = Number(name);
          return list[i] !== undefined ? String(list[i]) : m;
        }
        return named && Object.prototype.hasOwnProperty.call(named, name) ? String(named[name]) : m;
      });
    }
    return text;
  }
}

module.exports = { I18n, normalizeLang, detectSystemLang, SUPPORTED, FALLBACK };

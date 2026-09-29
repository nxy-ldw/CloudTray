'use strict';
/**
 * updater.js —— 版本检查
 *
 * 优先请求自定义更新源（返回上述结构的 JSON）；失败或未配置时回退到程序内置的
 * 版本清单。全程只读，不下载也不安装，符合“只在此处提示”的约定。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const TIMEOUT = 12000;
const MAX_BYTES = 512 * 1024;

/** 版本号比较：返回 1 / 0 / -1 */
function compareVersion(a, b) {
  const pa = String(a || '0')
    .split(/[.\-+]/)
    .map((s) => parseInt(s, 10) || 0);
  const pb = String(b || '0')
    .split(/[.\-+]/)
    .map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchJson(url, redirects) {
  const depth = redirects || 0;
  return new Promise((resolve, reject) => {
    if (depth > 4) {
      reject(new Error('too many redirects'));
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(new Error('invalid url'));
      return;
    }
    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.get(
      parsed,
      {
        timeout: TIMEOUT,
        headers: {
          'user-agent': 'TuckDesk-Updater',
          accept: 'application/json, text/plain, */*'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchJson(new URL(res.headers.location, parsed).toString(), depth + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy();
            reject(new Error('response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(new Error('invalid json'));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', (err) => reject(new Error(err.code || err.message)));
  });
}

/** 读取内置版本清单 */
function readBundledFeed(feedPath) {
  try {
    return JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  } catch (_) {
    return { latest: null, releases: [] };
  }
}

/** 把任意来源的 JSON 归一化为统一结构 */
function normalizeFeed(raw, fallback) {
  if (!raw || typeof raw !== 'object') return fallback;
  // 兼容 GitHub Releases API 的返回
  if (raw.tag_name || raw.name) {
    const version = String(raw.tag_name || raw.name || '').replace(/^v/i, '');
    return {
      latest: version || fallback.latest,
      releases: [
        {
          version: version || fallback.latest,
          date: (raw.published_at || '').slice(0, 10) || '',
          channel: raw.prerelease ? '预览版' : '正式版',
          url: raw.html_url || '',
          notes: String(raw.body || '')
            .split(/\r?\n/)
            .map((s) => s.replace(/^[-*#\s]+/, '').trim())
            .filter(Boolean)
            .slice(0, 40)
        },
        ...(fallback.releases || [])
      ]
    };
  }
  const releases = Array.isArray(raw.releases) ? raw.releases : fallback.releases || [];
  return {
    latest: raw.latest || (releases[0] && releases[0].version) || fallback.latest,
    releases
  };
}

class Updater {
  /**
   * @param {object} opts
   * @param {string} opts.currentVersion
   * @param {string} opts.bundledFeedPath
   * @param {import('./logger').Logger} opts.logger
   */
  constructor(opts) {
    this.currentVersion = opts.currentVersion;
    this.bundledFeedPath = opts.bundledFeedPath;
    this.logger = opts.logger;
  }

  /** 取内置清单（永远可用） */
  bundled() {
    return normalizeFeed(readBundledFeed(this.bundledFeedPath), { latest: this.currentVersion, releases: [] });
  }

  /**
   * @param {string} [feedUrl]
   * @returns {Promise<object>} 检查结果
   */
  async check(feedUrl) {
    const fallback = this.bundled();
    const base = {
      current: this.currentVersion,
      latest: fallback.latest || this.currentVersion,
      notes: fallback.releases,
      checkedAt: new Date().toISOString(),
      source: 'bundled',
      status: 'latest',
      error: null
    };

    if (!feedUrl) {
      base.status = compareVersion(base.latest, this.currentVersion) > 0 ? 'available' : 'latest';
      return base;
    }

    try {
      const raw = await fetchJson(feedUrl);
      const feed = normalizeFeed(raw, fallback);
      base.latest = feed.latest || this.currentVersion;
      base.notes = feed.releases && feed.releases.length ? feed.releases : fallback.releases;
      base.source = 'remote';
      base.status = compareVersion(base.latest, this.currentVersion) > 0 ? 'available' : 'latest';
      return base;
    } catch (err) {
      const message = String((err && err.message) || err);
      if (this.logger) this.logger.warn('更新检查失败', { url: feedUrl, error: message });
      base.status = 'failed';
      base.error = message;
      return base;
    }
  }
}

module.exports = { Updater, compareVersion, normalizeFeed };

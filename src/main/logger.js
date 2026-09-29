'use strict';
/**
 * logger.js —— 轻量滚动日志
 *
 * 只记录失败、超时与异常中断（含 UTC 时间），正常操作不落盘，避免日志膨胀。
 * 单文件上限 4 MiB，保留 5 个历史文件；同时保留内存环形缓冲供诊断包使用。
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 5;
const MEMORY_LINES = 400;

class Logger {
  constructor(logDir) {
    this.logDir = logDir;
    this.file = path.join(logDir, 'app.log');
    this.memory = [];
    this.enabled = true;
    this._ready = false;
  }

  ensure() {
    if (this._ready) return true;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      this._ready = true;
    } catch (_) {
      this._ready = false;
    }
    return this._ready;
  }

  rotateIfNeeded() {
    try {
      const st = fs.statSync(this.file);
      if (st.size < MAX_BYTES) return;
      for (let i = MAX_FILES - 1; i >= 1; i -= 1) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch (_) {
      /* 文件不存在或无法滚动，忽略 */
    }
  }

  write(level, message, detail) {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${
      detail ? ` | ${typeof detail === 'string' ? detail : safeJson(detail)}` : ''
    }`;
    this.memory.push(line);
    if (this.memory.length > MEMORY_LINES) this.memory.shift();
    if (!this.enabled || !this.ensure()) return;
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, `${line}\r\n`, 'utf8');
    } catch (_) {
      /* 落盘失败不影响运行 */
    }
  }

  info(msg, detail) {
    this.write('info', msg, detail);
  }

  warn(msg, detail) {
    this.write('warn', msg, detail);
  }

  error(msg, detail) {
    this.write('error', msg, detail);
  }

  /** 读取最近的日志文本（含历史文件），用于诊断包 */
  tail(maxBytes) {
    const limit = maxBytes || MAX_BYTES;
    const parts = [];
    try {
      for (let i = MAX_FILES; i >= 1; i -= 1) {
        const f = i === 0 ? this.file : `${this.file}.${i}`;
        if (!fs.existsSync(f)) continue;
        parts.push(`===== ${path.basename(f)} =====`);
        parts.push(fs.readFileSync(f, 'utf8'));
      }
      if (fs.existsSync(this.file)) {
        parts.push('===== app.log =====');
        parts.push(fs.readFileSync(this.file, 'utf8'));
      }
    } catch (_) {
      /* 忽略 */
    }
    if (parts.length === 0) {
      parts.push('（本次运行尚未记录任何失败事件）');
      if (this.memory.length) {
        parts.push('===== 内存缓冲 =====');
        parts.push(this.memory.join('\r\n'));
      }
    }
    let text = parts.join('\r\n');
    if (Buffer.byteLength(text, 'utf8') > limit) {
      text = Buffer.from(text, 'utf8').subarray(-limit).toString('utf8');
      text = `（仅保留末尾 ${Math.round(limit / 1024)} KiB）\r\n${text}`;
    }
    return text;
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

module.exports = { Logger };

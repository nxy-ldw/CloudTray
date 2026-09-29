'use strict';
/**
 * zip.js —— 零依赖 ZIP 打包器
 *
 * 仅实现导出诊断包所需的最小功能：deflate 压缩、UTF-8 文件名、标准中央目录。
 * 生成的压缩包可被 Windows 资源管理器、7-Zip 等直接打开。
 */

const zlib = require('zlib');

/* CRC32 查表 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS 时间/日期编码 */
function dosDateTime(date) {
  const d = date || new Date();
  const year = Math.max(1980, d.getFullYear());
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const day = ((year - 1980) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date: day };
}

class ZipWriter {
  constructor() {
    this.chunks = [];
    this.entries = [];
    this.offset = 0;
  }

  /**
   * 追加一个文件
   * @param {string} name    包内路径，使用 / 分隔
   * @param {Buffer|string} data
   * @param {boolean} [store] true 则不压缩（适合已压缩内容）
   */
  add(name, data, store) {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(content);
    const { time, date } = dosDateTime(new Date());

    let method = 0;
    let body = content;
    if (!store) {
      const deflated = zlib.deflateRawSync(content, { level: 9 });
      if (deflated.length < content.length) {
        method = 8;
        body = deflated;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 通用位标记：UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    this.chunks.push(local, nameBuf, body);
    this.entries.push({
      nameBuf,
      crc,
      compressedSize: body.length,
      uncompressedSize: content.length,
      method,
      time,
      date,
      offset: this.offset
    });
    this.offset += local.length + nameBuf.length + body.length;
    return this;
  }

  /** 追加目录条目（部分解压工具需要） */
  addDirectory(name) {
    const normalized = name.replace(/\\/g, '/').replace(/\/?$/, '/');
    if (this.entries.some((e) => e.nameBuf.toString('utf8') === normalized)) return this;
    const nameBuf = Buffer.from(normalized, 'utf8');
    const { time, date } = dosDateTime(new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(0, 18);
    local.writeUInt32LE(0, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    this.chunks.push(local, nameBuf);
    this.entries.push({
      nameBuf,
      crc: 0,
      compressedSize: 0,
      uncompressedSize: 0,
      method: 0,
      time,
      date,
      offset: this.offset
    });
    this.offset += local.length + nameBuf.length;
    return this;
  }

  /** 生成完整压缩包 */
  toBuffer() {
    const central = [];
    let centralSize = 0;
    for (const e of this.entries) {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0); // 中央目录签名
      head.writeUInt16LE(20, 4); // 生成版本
      head.writeUInt16LE(20, 6); // 解压所需版本
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(e.method, 10);
      head.writeUInt16LE(e.time, 12);
      head.writeUInt16LE(e.date, 14);
      head.writeUInt32LE(e.crc, 16);
      head.writeUInt32LE(e.compressedSize, 20);
      head.writeUInt32LE(e.uncompressedSize, 24);
      head.writeUInt16LE(e.nameBuf.length, 28);
      head.writeUInt16LE(0, 30); // extra
      head.writeUInt16LE(0, 32); // comment
      head.writeUInt16LE(0, 34); // disk
      head.writeUInt16LE(0, 36); // internal attrs
      head.writeUInt32LE(0, 38); // external attrs
      head.writeUInt32LE(e.offset, 42);
      central.push(head, e.nameBuf);
      centralSize += head.length + e.nameBuf.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(this.offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...this.chunks, ...central, end]);
  }
}

/** 便捷函数：把 { 路径: 内容 } 打成压缩包 */
function zipFromRecord(record) {
  const zip = new ZipWriter();
  const dirs = new Set();
  for (const name of Object.keys(record)) {
    const parts = name.replace(/\\/g, '/').split('/');
    parts.pop();
    let acc = '';
    for (const p of parts) {
      acc += `${p}/`;
      dirs.add(acc);
    }
  }
  for (const d of [...dirs].sort()) zip.addDirectory(d);
  for (const [name, content] of Object.entries(record)) zip.add(name, content);
  return zip.toBuffer();
}

module.exports = { ZipWriter, zipFromRecord, crc32 };

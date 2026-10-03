/**
 * Deterministic ZIP (stored method) writer for project export archives.
 *
 * Transport-free core used only by the export worker. Reference: PKWARE APPNOTE
 * 4.3.7 (local file header), 4.3.12 (central directory), 4.3.16 (end of central
 * directory). Everything here stays far below the ZIP64 thresholds (single
 * archive ≤ 100 MiB, ≤ 65535 entries), so no ZIP64 records are ever written.
 *
 * Properties:
 *   - method 0 (stored): file bytes go into the archive verbatim while the CRC
 *     is computed incrementally with `zlib.crc32`;
 *   - every entry uses a fixed DOS timestamp (1980-01-01), so the same file set
 *     always produces byte-identical archives;
 *   - ASCII-only entry names are enforced by the caller, extra fields and
 *     comments are never written;
 *   - a hard byte limit aborts the archive instead of growing without bounds.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

export const ZIP_METHOD_STORED = 0;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION_NEEDED = 20;
// 1980-01-01 00:00:00 in MS-DOS format: deterministic archives.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function isSafeZipName(name) {
  return typeof name === 'string' && SAFE_NAME_RE.test(name) && !name.includes('..') && !name.endsWith('/');
}

export class ZipLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipLimitError';
    this.code = 'output_too_large';
    this.status = 413;
  }
}

/**
 * Sequential ZIP writer. Files are added one at a time (never aggregated), and
 * the output file is written directly so memory stays bounded by one entry.
 */
export function createZipWriter(targetPath, { maxBytes }) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error('createZipWriter 需要明确的 maxBytes');
  let handle = null;
  let offset = 0;
  let entries = 0;
  const central = [];

  // Exact overhead: 46 bytes + name per central entry, 22 bytes EOCD.
  function currentCentralBytes() {
    return central.reduce((sum, entry) => sum + 46 + entry.nameBuf.length, 0);
  }

  /** Check the projected FINAL archive size: data + central directory + EOCD. */
  function account(byteCount, pendingNameLength = 0) {
    const projected = offset + byteCount + currentCentralBytes() + (pendingNameLength > 0 ? 46 + pendingNameLength : 0) + 22;
    if (projected > maxBytes) {
      throw new ZipLimitError(`导出文件包超过 ${maxBytes} 字节上限`);
    }
  }

  async function write(buffer) {
    // FileHandle.write may perform partial writes; loop until fully written.
    let written = 0;
    while (written < buffer.length) {
      const result = await handle.write(buffer, written, buffer.length - written, offset + written);
      if (!result.bytesWritten) throw new Error('zip 写入失败');
      written += result.bytesWritten;
    }
    offset += buffer.length;
  }

  return {
    async open() {
      handle = await fs.promises.open(targetPath, 'w');
    },

    /**
     * Add one stored entry. `buffer` must hold the exact file bytes.
     * @param {string} name ASCII path inside the archive
     * @param {Buffer} buffer file content
     */
    async add(name, buffer) {
      if (!handle) throw new Error('zip writer 未打开');
      if (!isSafeZipName(name)) throw new Error(`不安全的 ZIP 路径：${String(name).slice(0, 80)}`);
      if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
      if (entries >= 65535) throw new ZipLimitError('导出文件包条目过多');
      const crc = zlib.crc32(buffer);
      const nameBuf = Buffer.from(name, 'latin1');
      const header = Buffer.alloc(30);
      header.writeUInt32LE(LOCAL_SIG, 0);
      header.writeUInt16LE(VERSION_NEEDED, 4);
      header.writeUInt16LE(0, 6); // flags: no data descriptor, UTF-8 not needed (ASCII)
      header.writeUInt16LE(ZIP_METHOD_STORED, 8);
      header.writeUInt16LE(DOS_TIME, 10);
      header.writeUInt16LE(DOS_DATE, 12);
      header.writeUInt32LE(crc >>> 0, 14);
      header.writeUInt32LE(buffer.length, 18);
      header.writeUInt32LE(buffer.length, 22);
      header.writeUInt16LE(nameBuf.length, 26);
      header.writeUInt16LE(0, 28);
      // Reserve the full projected archive (this entry + its central record).
      account(30 + nameBuf.length + buffer.length, nameBuf.length);
      await write(Buffer.concat([header, nameBuf]));
      await write(buffer);
      central.push({ name, nameBuf, crc: crc >>> 0, size: buffer.length, offset: offset - buffer.length - header.length - nameBuf.length });
      entries += 1;
      return { path: name, bytes: buffer.length, crc32: crc >>> 0 };
    },

    /** Write the central directory + EOCD and close the file. */
    async finish() {
      if (!handle) throw new Error('zip writer 未打开');
      account(0, 0); // exact remaining central directory + EOCD budget
      const cdStart = offset;
      for (const entry of central) {
        const record = Buffer.alloc(46);
        record.writeUInt32LE(CENTRAL_SIG, 0);
        record.writeUInt16LE(0x0314, 4); // made by: UNIX, spec 2.0
        record.writeUInt16LE(VERSION_NEEDED, 6);
        record.writeUInt16LE(0, 8);
        record.writeUInt16LE(ZIP_METHOD_STORED, 10);
        record.writeUInt16LE(DOS_TIME, 12);
        record.writeUInt16LE(DOS_DATE, 14);
        record.writeUInt32LE(entry.crc, 16);
        record.writeUInt32LE(entry.size, 20);
        record.writeUInt32LE(entry.size, 24);
        record.writeUInt16LE(entry.nameBuf.length, 28);
        record.writeUInt16LE(0, 30); // extra length
        record.writeUInt16LE(0, 32); // comment length
        record.writeUInt16LE(0, 34); // disk number
        record.writeUInt16LE(0, 36); // internal attrs
        record.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: regular file 0644 (unsigned)
        record.writeUInt32LE(entry.offset, 42);
        await write(Buffer.concat([record, entry.nameBuf]));
      }
      const cdSize = offset - cdStart;
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(EOCD_SIG, 0);
      eocd.writeUInt16LE(0, 4);
      eocd.writeUInt16LE(0, 6);
      eocd.writeUInt16LE(entries, 8);
      eocd.writeUInt16LE(entries, 10);
      eocd.writeUInt32LE(cdSize, 12);
      eocd.writeUInt32LE(cdStart, 16);
      eocd.writeUInt16LE(0, 20);
      await write(eocd);
      await handle.close();
      handle = null;
      return { bytes: offset, entries };
    },

    /** Abort: close and remove the partial file (never registered as output). */
    async abort() {
      if (handle) {
        await handle.close().catch(() => {});
        handle = null;
      }
      await fs.promises.rm(targetPath, { force: true }).catch(() => {});
    },
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { STORE_SCHEMA_VERSION } from './constants.mjs';
import {
  AppError,
  REPO_ROOT,
  atomicWriteJson,
  assertSafeSha256,
  isSafeId,
  isSafeSha256,
  nowIso,
  sha256Hex,
} from './util.mjs';

export class CorruptStoreError extends Error {
  constructor(filePath, detail) {
    super(`store.json 数据损坏（${detail}）。已保留原文件，不会静默覆盖: ${filePath}`);
    this.name = 'CorruptStoreError';
    this.code = 'corrupt_store';
    this.status = 500;
    this.filePath = filePath;
  }
}

function emptyState() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: 0,
    updatedAt: nowIso(),
    cases: [],
  };
}

function corrupt(filePath, detail) {
  throw new CorruptStoreError(filePath, detail);
}

function validateCaseShape(c, filePath, index) {
  const at = `cases[${index}]`;
  if (!c || typeof c !== 'object' || Array.isArray(c)) corrupt(filePath, `${at} 不是对象`);
  if (typeof c.id !== 'string' || !isSafeId(c.id)) corrupt(filePath, `${at}.id 不合法`);
  if (!Number.isInteger(c.revision) || c.revision < 0) corrupt(filePath, `${at}.revision 不是非负整数`);
  if (typeof c.question !== 'string') corrupt(filePath, `${at}.question 不是字符串`);
  if (!Number.isInteger(c.width) || c.width < 1) corrupt(filePath, `${at}.width 不合法`);
  if (!Number.isInteger(c.height) || c.height < 1) corrupt(filePath, `${at}.height 不合法`);
  if (!Array.isArray(c.attachments)) corrupt(filePath, `${at}.attachments 不是数组`);
  for (const [i, att] of c.attachments.entries()) {
    if (!att || typeof att !== 'object') corrupt(filePath, `${at}.attachments[${i}] 不是对象`);
    if (!isSafeSha256(att.sha256)) corrupt(filePath, `${at}.attachments[${i}].sha256 不合法`);
  }
  if (c.candidate !== null && c.candidate !== undefined) {
    if (typeof c.candidate !== 'object' || Array.isArray(c.candidate)) {
      corrupt(filePath, `${at}.candidate 不是对象`);
    }
    if (!isSafeSha256(c.candidate.sha256)) corrupt(filePath, `${at}.candidate.sha256 不合法`);
  }
  if (c.review !== null && c.review !== undefined && (typeof c.review !== 'object' || Array.isArray(c.review))) {
    corrupt(filePath, `${at}.review 不是对象`);
  }
  if (c.golden !== null && c.golden !== undefined && (typeof c.golden !== 'object' || Array.isArray(c.golden))) {
    corrupt(filePath, `${at}.golden 不是对象`);
  }
}

function validateStateShape(state, filePath) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    corrupt(filePath, '根节点不是对象');
  }
  if (state.schemaVersion !== STORE_SCHEMA_VERSION) {
    corrupt(filePath, `不支持的 schemaVersion: ${state.schemaVersion}`);
  }
  if (!Number.isInteger(state.revision) || state.revision < 0) {
    corrupt(filePath, 'revision 不是非负整数');
  }
  if (!Array.isArray(state.cases)) {
    corrupt(filePath, 'cases 不是数组');
  }
  const seen = new Set();
  state.cases.forEach((c, index) => {
    validateCaseShape(c, filePath, index);
    if (seen.has(c.id)) corrupt(filePath, `case id 重复: ${c.id}`);
    seen.add(c.id);
  });
  return state;
}

export class Store {
  constructor({ dataDir }) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new Error('Store 需要 dataDir');
    }
    this.dataDir = path.resolve(dataDir);
    this.storePath = path.join(this.dataDir, 'store.json');
    this.blobsDir = path.join(this.dataDir, 'blobs');
    this.state = null;
    this.loadError = null;
    this._queue = Promise.resolve();
  }

  get revision() {
    return this.state ? this.state.revision : 0;
  }

  // Local data is private by default: 0700 directories, 0600 files.
  async ensureDataDir() {
    await fs.promises.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(this.blobsDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await fs.promises.chmod(this.dataDir, 0o700).catch(() => {});
      await fs.promises.chmod(this.blobsDir, 0o700).catch(() => {});
    }
  }

  async load({ force = false } = {}) {
    if (this.state && !force) return this.state;
    this.loadError = null;
    await this.ensureDataDir();
    let raw;
    try {
      raw = await fs.promises.readFile(this.storePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.state = emptyState();
        return this.state;
      }
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.loadError = new CorruptStoreError(this.storePath, `JSON 解析失败: ${err.message}`);
      throw this.loadError;
    }
    try {
      this.state = validateStateShape(parsed, this.storePath);
    } catch (err) {
      this.loadError = err;
      throw err;
    }
    return this.state;
  }

  async init() {
    try {
      await this.load();
    } catch (err) {
      this.loadError = err;
    }
  }

  ensureLoaded() {
    if (!this.state) {
      if (this.loadError) throw this.loadError;
      throw new AppError('store_not_loaded', '存储尚未初始化', 500);
    }
  }

  listCases() {
    this.ensureLoaded();
    return this.state.cases;
  }

  getCase(id) {
    this.ensureLoaded();
    return this.state.cases.find((c) => c.id === id) ?? null;
  }

  // Serialize all mutations and only commit the draft after the atomic write
  // succeeds, so a failed disk write cannot leave in-memory state ahead of disk.
  async mutate(fn) {
    const run = async () => {
      if (!this.state) await this.load();
      const draft = structuredClone(this.state);
      const result = await fn(draft);
      draft.revision = this.state.revision + 1;
      draft.updatedAt = nowIso();
      await atomicWriteJson(this.storePath, draft);
      this.state = draft;
      return result;
    };
    const next = this._queue.then(run, run);
    // Keep the queue chain healthy even if this mutation rejects.
    this._queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  blobPath(sha256) {
    assertSafeSha256(sha256, 'blob sha256');
    return path.join(this.blobsDir, sha256.slice(0, 2), sha256);
  }

  async putBlob(buffer) {
    const sha256 = sha256Hex(buffer);
    const target = this.blobPath(sha256);
    await this.ensureDataDir();
    try {
      await fs.promises.access(target, fs.constants.R_OK);
      return { sha256, size: buffer.length };
    } catch {
      // fall through to write
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
      handle = await fs.promises.open(tmp, 'w', 0o600);
      await handle.writeFile(buffer);
      await handle.sync();
    } finally {
      if (handle) await handle.close();
    }
    try {
      await fs.promises.rename(tmp, target);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
    return { sha256, size: buffer.length };
  }

  async getBlob(sha256) {
    const target = this.blobPath(sha256);
    let buffer;
    try {
      buffer = await fs.promises.readFile(target);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    if (sha256Hex(buffer) !== sha256) {
      throw new AppError('corrupt_blob', `blob 内容与 hash 不匹配: ${sha256}`, 500);
    }
    return buffer;
  }

  async hasBlob(sha256) {
    try {
      await fs.promises.access(this.blobPath(sha256), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  // Collect every blob hash referenced by the store so exports and diagnostics
  // can detect missing/extra files.
  referencedBlobs() {
    this.ensureLoaded();
    const refs = new Set();
    for (const c of this.state.cases) {
      for (const att of c.attachments ?? []) if (att?.sha256) refs.add(att.sha256);
      if (c.candidate?.sha256) refs.add(c.candidate.sha256);
    }
    return refs;
  }
}

export function defaultDataDir() {
  const override = process.env.IMSTAGE_EVAL_DATA_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(REPO_ROOT, '.local', 'eval');
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_DIR = path.resolve(MODULE_DIR, '..');
export const REPO_ROOT = path.resolve(PACKAGE_DIR, '..', '..');

import { AppError, fail } from '../../../packages/schema/errors.mjs';
export { AppError, fail };

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix = 'c') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256Base64(input) {
  return `sha256:${sha256Hex(input)}`;
}

// Stable stringify with recursively sorted object keys. This is the canonical
// byte form used for every fingerprint and hash in the app.
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v === undefined) continue;
      out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

export function parseBase64(value, field = 'data') {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_base64', `${field} 必须是 base64 字符串`, 422);
  }
  const cleaned = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    fail('invalid_base64', `${field} 不是合法 base64`, 422);
  }
  const buf = Buffer.from(cleaned, 'base64');
  // Re-encode check catches truncated/invalid base64 that Buffer silently accepts.
  const roundTrip = buf.toString('base64').replace(/=+$/, '');
  if (roundTrip !== cleaned.replace(/=+$/, '')) {
    fail('invalid_base64', `${field} 不是合法 base64`, 422);
  }
  return buf;
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function isSafeId(id) {
  return typeof id === 'string' && SAFE_ID_RE.test(id);
}

export function assertSafeId(id, label = 'id') {
  if (!isSafeId(id)) {
    fail('unsafe_id', `${label} 不合法（只允许字母、数字、下划线、连字符）`, 422);
  }
  return id;
}

export function isSafeSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function assertSafeSha256(value, label = 'sha256') {
  if (!isSafeSha256(value)) {
    fail('invalid_hash', `${label} 不是合法 sha256`, 422);
  }
  return value;
}

// Resolve child under baseDir and refuse to escape it. Throws AppError.
export function safeJoin(baseDir, ...parts) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...parts);
  const rel = path.relative(base, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('unsafe_path', `路径超出允许的输出目录: ${parts.join('/')}`, 422);
  }
  return target;
}

export function clampText(value, max, label, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('missing_field', `${label} 不能为空`, 422);
    return '';
  }
  if (typeof value !== 'string') fail('invalid_field', `${label} 必须是字符串`, 422);
  const trimmed = value.trim();
  if (required && trimmed.length === 0) fail('missing_field', `${label} 不能为空`, 422);
  if (trimmed.length > max) fail('too_long', `${label} 超过 ${max} 字符上限`, 422);
  return trimmed;
}

export function enumValue(value, allowed, label, { required = true, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('missing_field', `${label} 不能为空`, 422);
    return fallback;
  }
  if (!allowed.includes(value)) {
    fail('invalid_enum', `${label} 只能是: ${allowed.join(', ')}`, 422);
  }
  return value;
}

export function intValue(value, label, { min, max, required = true, fallback = undefined } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('missing_field', `${label} 不能为空`, 422);
    return fallback;
  }
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) {
    fail('invalid_number', `${label} 必须是整数`, 422);
  }
  if (min !== undefined && num < min) fail('out_of_range', `${label} 不能小于 ${min}`, 422);
  if (max !== undefined && num > max) fail('out_of_range', `${label} 不能大于 ${max}`, 422);
  return num;
}

export function ratioValue(value, label, fallback = undefined) {
  if (value === undefined || value === null || value === '') {
    if (fallback === undefined) fail('missing_field', `${label} 不能为空`, 422);
    return fallback;
  }
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    fail('invalid_number', `${label} 必须是有限数字`, 422);
  }
  if (num < 0 || num > 0.05) {
    fail('out_of_range', `${label} 必须在 0 到 0.05 之间`, 422);
  }
  return num;
}

export async function readJsonFile(filePath) {
  let raw;
  try {
    raw = await fs.promises.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') fail('not_found', `文件不存在: ${filePath}`, 404);
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail('malformed_json', `JSON 解析失败: ${filePath}`, 422);
  }
}

// Atomic JSON write: write temp in same directory, fsync, then rename.
// Mirrors https://nodejs.org/docs/latest-v22.x/api/fs.html#fspromisesrenameoldpath-newpath
export async function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let handle;
  try {
    handle = await fs.promises.open(tmpPath, 'w', 0o600);
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    if (handle) await handle.close();
  }
  try {
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    await fs.promises.rm(tmpPath, { force: true });
    throw err;
  }
  // Best-effort directory fsync so the rename is durable across crashes.
  try {
    const dirHandle = await fs.promises.open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory fsync is not supported on every platform; ignore.
  }
}

export async function atomicWriteJson(filePath, value) {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function uidFromRequest(req) {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function toErrorMessage(err) {
  if (err instanceof AppError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out;
  }
  return value;
}

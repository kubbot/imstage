// Screenshot-edit benchmark: authenticated dataset pack/unpack.
//
// packDataset({datasetDir, outputFile, keyHex})       -> AES-256-GCM bundle
// unpackDataset({inputFile, outputDir, keyHex})       -> validated dataset dir
//
// Security properties:
// - AES-256-GCM with a random 12-byte nonce and an authenticated, versioned
//   header; the 32-byte key comes only from IMSTAGE_EVAL_DATASET_KEY (or an
//   explicit argument) and is never logged or returned.
// - the plaintext archive is gzipped JSON: manifest + exactly the referenced
//   files, each with path/sha256/base64. No arbitrary extra files.
// - every archive path is relative, traversal/symlink free, and unique.
// - decryption and the FULL archive validation happen before any file write.
// - outputDir must be a new/empty child; failures only clean up the staging
//   directory this function created, never a pre-existing directory.
// - wrong key / tampering fails closed with a generic error code.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fail, sha256Hex, atomicWriteFile } from '../util.mjs';
import {
  assertSafeRelativePath,
  listReferencedFileDescriptors,
  loadVerifiedFile,
  readDataset,
  validateManifest,
} from './dataset.mjs';

export const DATASET_KEY_ENV = 'IMSTAGE_EVAL_DATASET_KEY';
export const BUNDLE_MAGIC = Buffer.from('IMSB', 'latin1');
export const BUNDLE_VERSION = 1;
export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_KIND = 'imstage-screenshot-edit-bundle';
export const HEADER_BYTES = 5; // 4 magic + 1 version
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const KEY_BYTES = 32;
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
export const MAX_ARCHIVE_JSON_BYTES = 50 * 1024 * 1024;
export const MAX_ARCHIVE_FILES = 200;

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;

export function resolveDatasetKey(keyHex, env = process.env) {
  const value = keyHex ?? env?.[DATASET_KEY_ENV];
  if (value === undefined || value === null || value === '') {
    fail('dataset_key_missing', `缺少数据集密钥（环境变量 ${DATASET_KEY_ENV}）`, 500, {
      reasonCode: 'dataset_key_missing',
    });
  }
  if (typeof value !== 'string' || !HEX_KEY_RE.test(value)) {
    fail('dataset_key_invalid', `${DATASET_KEY_ENV} 必须是 32 字节 hex（64 位）`, 500, {
      reasonCode: 'dataset_key_invalid',
    });
  }
  const key = Buffer.from(value, 'hex');
  if (key.length !== KEY_BYTES) {
    fail('dataset_key_invalid', `${DATASET_KEY_ENV} 必须是 32 字节 hex`, 500, { reasonCode: 'dataset_key_invalid' });
  }
  return key;
}

function buildHeader() {
  const header = Buffer.alloc(HEADER_BYTES);
  BUNDLE_MAGIC.copy(header, 0);
  header.writeUInt8(BUNDLE_VERSION, 4);
  return header;
}

/** Encrypt an archive object. Exported for tests that craft malformed archives. */
export function sealArchive(archive, key) {
  const plaintext = Buffer.from(JSON.stringify(archive), 'utf8');
  if (plaintext.length > MAX_ARCHIVE_JSON_BYTES) {
    fail('archive_too_large', `归档 JSON 超过 ${MAX_ARCHIVE_JSON_BYTES} 字节上限`, 500, {
      reasonCode: 'archive_too_large',
    });
  }
  const gzipped = zlib.gzipSync(plaintext, { level: 9 });
  const header = buildHeader();
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(gzipped), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, nonce, tag, ciphertext]);
}

/** Decrypt a bundle. Exported for tests. */
export function openArchive(bundle, key) {
  if (!Buffer.isBuffer(bundle) || bundle.length < HEADER_BYTES + NONCE_BYTES + TAG_BYTES) {
    fail('dataset_decrypt_failed', '数据集包不完整', 422, { reasonCode: 'dataset_decrypt_failed' });
  }
  if (bundle.length > MAX_BUNDLE_BYTES) {
    fail('bundle_too_large', `数据集包超过 ${MAX_BUNDLE_BYTES} 字节上限`, 422, { reasonCode: 'bundle_too_large' });
  }
  const header = bundle.subarray(0, HEADER_BYTES);
  if (!header.subarray(0, 4).equals(BUNDLE_MAGIC) || header.readUInt8(4) !== BUNDLE_VERSION) {
    fail('dataset_decrypt_failed', '数据集包头不合法', 422, { reasonCode: 'dataset_decrypt_failed' });
  }
  const nonce = bundle.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const tag = bundle.subarray(HEADER_BYTES + NONCE_BYTES, HEADER_BYTES + NONCE_BYTES + TAG_BYTES);
  const ciphertext = bundle.subarray(HEADER_BYTES + NONCE_BYTES + TAG_BYTES);
  let gzipped;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    gzipped = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Wrong key or tampered bytes: generic, non-oracular failure.
    fail('dataset_decrypt_failed', '数据集解密失败（密钥错误或内容被篡改）', 422, {
      reasonCode: 'dataset_decrypt_failed',
    });
  }
  let plaintext;
  try {
    plaintext = zlib.gunzipSync(gzipped, {maxOutputLength:MAX_ARCHIVE_JSON_BYTES});
  } catch {
    fail('dataset_archive_invalid', '数据集归档无法解压', 422, { reasonCode: 'dataset_archive_invalid' });
  }
  if (plaintext.length > MAX_ARCHIVE_JSON_BYTES) {
    fail('archive_too_large', `归档 JSON 超过 ${MAX_ARCHIVE_JSON_BYTES} 字节上限`, 422, {
      reasonCode: 'archive_too_large',
    });
  }
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    fail('dataset_archive_invalid', '数据集归档 JSON 解析失败', 422, { reasonCode: 'dataset_archive_invalid' });
  }
}

function parseBase64Strict(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('dataset_archive_invalid', `${label} 不是合法 base64`, 422, { reasonCode: 'dataset_archive_invalid' });
  }
  const cleaned = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    fail('dataset_archive_invalid', `${label} 不是合法 base64`, 422, { reasonCode: 'dataset_archive_invalid' });
  }
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) {
    fail('dataset_archive_invalid', `${label} 不是合法 base64`, 422, { reasonCode: 'dataset_archive_invalid' });
  }
  return buffer;
}

export async function packDataset({ datasetDir, outputFile, keyHex, env = process.env } = {}) {
  const key = resolveDatasetKey(keyHex, env);
  if (typeof outputFile !== 'string' || outputFile.length === 0) {
    fail('missing_field', 'outputFile 不能为空', 422, { field: 'outputFile' });
  }
  const resolved = await readDataset(datasetDir);
  const descriptors = resolved.referencedFiles;
  const files = [];
  for (const descriptor of descriptors) {
    const isManifest = descriptor.relPath === resolved.manifestName;
    const buffer = await loadVerifiedFile({
      datasetDir: resolved.datasetDir,
      relPath: descriptor.relPath,
      sha256: descriptor.sha256,
      label: descriptor.label,
      maxBytes: isManifest ? MAX_ARCHIVE_JSON_BYTES : 8 * 1024 * 1024,
    });
    files.push({ path: descriptor.relPath, sha256: sha256Hex(buffer), base64: buffer.toString('base64') });
  }
  const archive = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: BUNDLE_KIND,
    manifest: resolved.manifestName,
    files,
  };
  const plaintext = Buffer.from(JSON.stringify(archive), 'utf8');
  if (plaintext.length > MAX_ARCHIVE_JSON_BYTES) {
    fail('archive_too_large', `归档 JSON 超过 ${MAX_ARCHIVE_JSON_BYTES} 字节上限`, 422, {
      reasonCode: 'archive_too_large',
    });
  }
  const sealed = sealArchive(archive, key);
  if (sealed.length > MAX_BUNDLE_BYTES) {
    fail('bundle_too_large', `数据集包超过 ${MAX_BUNDLE_BYTES} 字节上限`, 422, { reasonCode: 'bundle_too_large' });
  }
  await atomicWriteFile(outputFile, sealed);
  return { outputFile, bytes: sealed.length, files: files.length };
}

function validateArchive(archive) {
  if (!archive || typeof archive !== 'object' || Array.isArray(archive)) {
    fail('dataset_archive_invalid', '归档必须是对象', 422, { reasonCode: 'dataset_archive_invalid' });
  }
  const allowedTop = new Set(['schemaVersion', 'kind', 'manifest', 'files']);
  for (const key of Object.keys(archive)) {
    if (!allowedTop.has(key)) {
      fail('dataset_archive_invalid', `归档含未知字段: ${key}`, 422, { reasonCode: 'dataset_archive_invalid' });
    }
  }
  if (archive.schemaVersion !== BUNDLE_SCHEMA_VERSION || archive.kind !== BUNDLE_KIND) {
    fail('dataset_archive_invalid', '归档版本或类型不合法', 422, { reasonCode: 'dataset_archive_invalid' });
  }
  assertSafeRelativePath(archive.manifest, 'archive.manifest');
  if (!Array.isArray(archive.files) || archive.files.length === 0) {
    fail('dataset_archive_invalid', '归档 files 不能为空', 422, { reasonCode: 'dataset_archive_invalid' });
  }
  if (archive.files.length > MAX_ARCHIVE_FILES) {
    fail('dataset_archive_invalid', `归档文件数超过 ${MAX_ARCHIVE_FILES}`, 422, { reasonCode: 'dataset_archive_invalid' });
  }
  const seen = new Set();
  const decoded = [];
  let totalBytes = 0;
  for (const [index, entry] of archive.files.entries()) {
    const label = `archive.files[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail('dataset_archive_invalid', `${label} 必须是对象`, 422, { reasonCode: 'dataset_archive_invalid' });
    }
    const allowedEntry = new Set(['path', 'sha256', 'base64']);
    for (const key of Object.keys(entry)) {
      if (!allowedEntry.has(key)) {
        fail('dataset_archive_invalid', `${label} 含未知字段: ${key}`, 422, { reasonCode: 'dataset_archive_invalid' });
      }
    }
    assertSafeRelativePath(entry.path, `${label}.path`);
    if (seen.has(entry.path)) {
      fail('dataset_archive_invalid', `归档含重复路径: ${entry.path}`, 422, { reasonCode: 'dataset_archive_invalid' });
    }
    seen.add(entry.path);
    if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      fail('dataset_archive_invalid', `${label}.sha256 不合法`, 422, { reasonCode: 'dataset_archive_invalid' });
    }
    const buffer = parseBase64Strict(entry.base64, `${label}.base64`);
    totalBytes += buffer.length;
    if (totalBytes > MAX_ARCHIVE_JSON_BYTES) {
      fail('archive_too_large', `归档解码后超过 ${MAX_ARCHIVE_JSON_BYTES} 字节上限`, 422, {
        reasonCode: 'archive_too_large',
      });
    }
    if (sha256Hex(buffer) !== entry.sha256) {
      fail('dataset_archive_invalid', `${label} 内容哈希不匹配`, 422, { reasonCode: 'dataset_archive_invalid' });
    }
    decoded.push({ path: entry.path, buffer });
  }
  return decoded;
}

export async function unpackDataset({ inputFile, outputDir, keyHex, env = process.env } = {}) {
  const key = resolveDatasetKey(keyHex, env);
  if (typeof inputFile !== 'string' || inputFile.length === 0) {
    fail('missing_field', 'inputFile 不能为空', 422, { field: 'inputFile' });
  }
  if (typeof outputDir !== 'string' || outputDir.length === 0) {
    fail('missing_field', 'outputDir 不能为空', 422, { field: 'outputDir' });
  }
  let bundle;
  try {
    bundle = await fs.promises.readFile(inputFile);
  } catch (err) {
    if (err.code === 'ENOENT') fail('not_found', `数据集包不存在: ${inputFile}`, 404);
    throw err;
  }
  const archive = openArchive(bundle, key);

  // --- Full validation BEFORE any write. ---
  const decoded = validateArchive(archive);
  const byPath = new Map(decoded.map((entry) => [entry.path, entry.buffer]));
  const manifestBuffer = byPath.get(archive.manifest);
  if (!manifestBuffer) {
    fail('dataset_archive_invalid', '归档缺少 manifest 文件', 422, { reasonCode: 'dataset_archive_invalid' });
  }
  let manifestRaw;
  try {
    manifestRaw = JSON.parse(manifestBuffer.toString('utf8'));
  } catch {
    fail('dataset_archive_invalid', '归档 manifest JSON 解析失败', 422, { reasonCode: 'dataset_archive_invalid' });
  }
  const manifest = validateManifest(manifestRaw);
  const descriptors = listReferencedFileDescriptors(manifest, archive.manifest);
  const expectedPaths = new Set(descriptors.map((descriptor) => descriptor.relPath));
  if (expectedPaths.size !== byPath.size) {
    fail('dataset_archive_invalid', '归档包含未引用或多出文件', 422, { reasonCode: 'dataset_archive_invalid' });
  }
  for (const descriptor of descriptors) {
    const buffer = byPath.get(descriptor.relPath);
    if (!buffer) {
      fail('dataset_archive_invalid', `归档缺少引用文件: ${descriptor.relPath}`, 422, {
        reasonCode: 'dataset_archive_invalid',
      });
    }
    if (descriptor.sha256 && sha256Hex(buffer) !== descriptor.sha256) {
      fail('dataset_archive_invalid', `引用文件哈希与 manifest 不一致: ${descriptor.relPath}`, 422, {
        reasonCode: 'dataset_archive_invalid',
      });
    }
  }

  // --- Output directory must be a new/empty child. ---
  const target = path.resolve(outputDir);
  let targetExists = false;
  try {
    const stat = await fs.promises.lstat(target);
    if (stat.isSymbolicLink()) {
      fail('output_symlink', 'outputDir 不能是符号链接', 422, { reasonCode: 'output_symlink' });
    }
    if (!stat.isDirectory()) {
      fail('output_not_directory', 'outputDir 已存在且不是目录', 422, { reasonCode: 'output_not_directory' });
    }
    const entries = await fs.promises.readdir(target);
    if (entries.length > 0) {
      fail('output_not_empty', 'outputDir 必须是空目录或不存在', 422, { reasonCode: 'output_not_empty' });
    }
    targetExists = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const parent = path.dirname(target);
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = path.join(parent, `.${path.basename(target)}.staging-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fs.promises.mkdir(staging, { recursive: false, mode: 0o700 });
    for (const entry of decoded) {
      const destination = path.join(staging, ...entry.path.replace(/\\/g, '/').split('/'));
      await fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(destination, entry.buffer, { mode: 0o600, flag: 'wx' });
    }
    if (targetExists) await fs.promises.rmdir(target);
    await fs.promises.rename(staging, target);
  } catch (err) {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return {
    outputDir: target,
    manifestPath: path.join(target, archive.manifest),
    fileCount: decoded.length,
  };
}

export default { packDataset, unpackDataset, resolveDatasetKey, sealArchive, openArchive };

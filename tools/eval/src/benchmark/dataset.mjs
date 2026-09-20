// Screenshot-edit benchmark: dataset manifest loading and path/asset integrity.
//
// The parent owns the private dataset content. This module only defines and
// enforces the schema plus strict filesystem safety:
//   * dataset paths are relative, inside the dataset directory, symlink-free,
//     and contain no traversal segments;
//   * every referenced file is hashed and dimension-checked before any paid
//     provider call;
//   * the manifest is validated end-to-end for bounds, uniqueness and the
//     expected-edit schema.
//
// It never reads a path outside the explicit dataset directory and never writes
// anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { MAX_PNG_BYTES, MAX_PIXELS, MAX_PNG_DIMENSION } from '../constants.mjs';
import { fail, isSafeId, isSafeSha256, sha256Hex, canonicalJson } from '../util.mjs';
import { decodePng } from '../png.mjs';
import { readImageDimensions } from '../generation.mjs';
import {
  DIFFICULTIES,
  IMS,
  MAX_ASSETS,
  MAX_CASES,
  MAX_EDITS_PER_CASE,
  SURFACES,
  validateBox,
  validateEdit,
} from './plan.mjs';

export const DATASET_SCHEMA_VERSION = 1;
export const DATASET_KIND = 'imstage-screenshot-edit-dataset';
export const MANIFEST_FILE_NAMES = Object.freeze(['manifest.json', 'dataset.json']);
export const ALLOWED_SOURCE_MIME = Object.freeze(['image/png', 'image/jpeg']);
export const ALLOWED_PROVENANCE = Object.freeze(['imagegen', 'deterministic-map']);
export const MAX_DESCRIPTION_LENGTH = 1000;
export const MAX_TITLE_LENGTH = 300;
export const MAX_TASK_LENGTH = 4000;
export const MAX_ANSWER_LENGTH = 4000;

function assertBoundString(value, label, max, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('missing_field', `${label} 不能为空`, 422, { field: label, reasonCode: 'missing_field' });
    return '';
  }
  if (typeof value !== 'string') {
    fail('invalid_field', `${label} 必须是字符串`, 422, { field: label, reasonCode: 'invalid_field' });
  }
  const trimmed = value.trim();
  if (required && trimmed.length === 0) {
    fail('missing_field', `${label} 不能为空`, 422, { field: label, reasonCode: 'missing_field' });
  }
  if (trimmed.length > max) {
    fail('too_long', `${label} 超过 ${max} 字符上限`, 422, { field: label, reasonCode: 'too_long' });
  }
  return trimmed;
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    fail('invalid_enum', `${label} 必须是 ${allowed.join(', ')}`, 422, { field: label, reasonCode: 'invalid_enum' });
  }
  return value;
}

function assertInt(value, label, { min, max }) {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
    fail('invalid_number', `${label} 必须是整数`, 422, { field: label, reasonCode: 'invalid_number' });
  }
  if (value < min || value > max) {
    fail('out_of_range', `${label} 必须在 ${min}..${max} 之间`, 422, { field: label, reasonCode: 'out_of_range' });
  }
  return value;
}

function assertDimensions(width, height, label) {
  if (width * height > MAX_PIXELS) {
    fail('out_of_range', `${label} 超过 ${MAX_PIXELS} 像素上限`, 422, { field: label, reasonCode: 'too_many_pixels' });
  }
}

function normalizeMime(mime, label) {
  const value = String(mime ?? '').toLowerCase();
  const normalized = value === 'image/jpg' ? 'image/jpeg' : value;
  if (!ALLOWED_SOURCE_MIME.includes(normalized)) {
    fail('unsupported_image', `${label} 只支持 PNG/JPEG`, 422, { field: label, reasonCode: 'unsupported_mime' });
  }
  return normalized;
}

function validateFileRef(raw, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_field', `${label} 必须是对象`, 422, { field: label, reasonCode: 'invalid_field' });
  }
  const file = assertBoundString(raw.file, `${label}.file`, 400);
  assertSafeRelativePath(file, `${label}.file`);
  const mime = normalizeMime(raw.mime, `${label}.mime`);
  const width = assertInt(raw.width, `${label}.width`, { min: 1, max: MAX_PNG_DIMENSION });
  const height = assertInt(raw.height, `${label}.height`, { min: 1, max: MAX_PNG_DIMENSION });
  assertDimensions(width, height, label);
  if (!isSafeSha256(raw.sha256)) {
    fail('invalid_hash', `${label}.sha256 不是合法 sha256`, 422, { field: `${label}.sha256`, reasonCode: 'invalid_hash' });
  }
  return { file, mime, width, height, sha256: raw.sha256 };
}

function validateAsset(raw, index) {
  const label = `assets[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_field', `${label} 必须是对象`, 422, { field: label, reasonCode: 'invalid_field' });
  }
  if (!isSafeId(raw.id)) {
    fail('unsafe_id', `${label}.id 不合法`, 422, { field: `${label}.id`, reasonCode: 'unsafe_id' });
  }
  const ref = validateFileRef(raw, label);
  const description = assertBoundString(raw.description, `${label}.description`, MAX_DESCRIPTION_LENGTH);
  const provenance = assertEnum(raw.provenance, ALLOWED_PROVENANCE, `${label}.provenance`);
  return { id: raw.id, ...ref, description, provenance };
}

function validateExpected(raw, { label, assetIds }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_field', `${label} 必须是对象`, 422, { field: label, reasonCode: 'invalid_field' });
  }
  const answer = assertBoundString(raw.answer, `${label}.answer`, MAX_ANSWER_LENGTH);
  if (!Array.isArray(raw.edits) || raw.edits.length === 0) {
    fail('missing_field', `${label}.edits 至少需要 1 个编辑`, 422, { field: `${label}.edits`, reasonCode: 'missing_edits' });
  }
  if (raw.edits.length > MAX_EDITS_PER_CASE) {
    fail('too_many_edits', `${label}.edits 超过 ${MAX_EDITS_PER_CASE} 上限`, 422, {
      field: `${label}.edits`,
      reasonCode: 'too_many_edits',
    });
  }
  const seen = new Set();
  const warnings = [];
  const edits = raw.edits.map((edit, index) => {
    const normalized = validateEdit(edit, {
      label: `${label}.edits[${index}]`,
      mode: 'expected',
      authorizedAssetIds: assetIds,
      warnings,
    });
    if (seen.has(normalized.id)) {
      fail('duplicate_id', `${label}.edits 含重复 id: ${normalized.id}`, 422, {
        field: `${label}.edits`,
        reasonCode: 'duplicate_id',
      });
    }
    seen.add(normalized.id);
    return normalized;
  });
  const preserveRegions = [];
  if (raw.preserveRegions !== undefined && raw.preserveRegions !== null) {
    if (!Array.isArray(raw.preserveRegions)) {
      fail('invalid_field', `${label}.preserveRegions 必须是数组`, 422, { field: `${label}.preserveRegions` });
    }
    raw.preserveRegions.forEach((box, index) => {
      preserveRegions.push(validateBox(box, `${label}.preserveRegions[${index}]`));
    });
  }
  let minScore = 0.8;
  if (raw.minScore !== undefined && raw.minScore !== null) {
    if (typeof raw.minScore !== 'number' || !Number.isFinite(raw.minScore) || raw.minScore < 0 || raw.minScore > 1) {
      fail('invalid_number', `${label}.minScore 必须在 0..1 之间`, 422, { field: `${label}.minScore` });
    }
    minScore = raw.minScore;
  }
  return { answer, edits, preserveRegions, minScore, warnings };
}

function validateCase(raw, index, assetIdSet) {
  const label = `cases[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_field', `${label} 必须是对象`, 422, { field: label, reasonCode: 'invalid_field' });
  }
  if (!isSafeId(raw.id)) {
    fail('unsafe_id', `${label}.id 不合法`, 422, { field: `${label}.id`, reasonCode: 'unsafe_id' });
  }
  const title = assertBoundString(raw.title, `${label}.title`, MAX_TITLE_LENGTH);
  if (!DIFFICULTIES.includes(raw.difficulty)) {
    fail('invalid_enum', `${label}.difficulty 必须是 1..5`, 422, { field: `${label}.difficulty`, reasonCode: 'invalid_difficulty' });
  }
  const im = assertEnum(raw.im, IMS, `${label}.im`);
  const surface = assertEnum(raw.surface, SURFACES, `${label}.surface`);

  if (!raw.source || typeof raw.source !== 'object' || Array.isArray(raw.source)) {
    fail('invalid_field', `${label}.source 必须是对象`, 422, { field: `${label}.source`, reasonCode: 'invalid_field' });
  }
  const source = validateFileRef(raw.source, `${label}.source`);
  const task = assertBoundString(raw.task, `${label}.task`, MAX_TASK_LENGTH);
  if (raw.analysis === undefined || raw.analysis === null || typeof raw.analysis !== 'object' || Array.isArray(raw.analysis)) {
    fail('invalid_field', `${label}.analysis 必须是对象`, 422, { field: `${label}.analysis`, reasonCode: 'invalid_field' });
  }
  const analysis = raw.analysis;

  if (!Array.isArray(raw.assetIds)) {
    fail('invalid_field', `${label}.assetIds 必须是数组`, 422, { field: `${label}.assetIds`, reasonCode: 'invalid_field' });
  }
  const assetIds = [];
  const assetSeen = new Set();
  for (const id of raw.assetIds) {
    if (!isSafeId(id)) {
      fail('unsafe_id', `${label}.assetIds 含不合法 id`, 422, { field: `${label}.assetIds`, reasonCode: 'unsafe_id' });
    }
    if (assetSeen.has(id)) {
      fail('duplicate_id', `${label}.assetIds 含重复 id: ${id}`, 422, { field: `${label}.assetIds`, reasonCode: 'duplicate_id' });
    }
    if (!assetIdSet.has(id)) {
      fail('missing_asset', `${label}.assetIds 引用了不存在的素材: ${id}`, 422, {
        field: `${label}.assetIds`,
        reasonCode: 'missing_asset',
      });
    }
    assetSeen.add(id);
    assetIds.push(id);
  }

  const expected = validateExpected(raw.expected, { label: `${label}.expected`, assetIds });
  if (raw.referenceStatus !== 'proposed') {
    fail('invalid_reference_status', `${label}.referenceStatus 必须为 proposed（不自动批准金标）`, 422, {
      field: `${label}.referenceStatus`,
      reasonCode: 'invalid_reference_status',
    });
  }
  return {
    id: raw.id,
    title,
    difficulty: raw.difficulty,
    im,
    surface,
    source,
    task,
    analysis,
    assetIds,
    expected,
    referenceStatus: 'proposed',
  };
}

export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_manifest', 'manifest 必须是对象', 422, { reasonCode: 'invalid_manifest' });
  }
  if (raw.schemaVersion !== DATASET_SCHEMA_VERSION) {
    fail('invalid_manifest', `schemaVersion 必须是 ${DATASET_SCHEMA_VERSION}`, 422, {
      field: 'schemaVersion',
      reasonCode: 'invalid_schema_version',
    });
  }
  if (raw.kind !== DATASET_KIND) {
    fail('invalid_manifest', `kind 必须是 ${DATASET_KIND}`, 422, { field: 'kind', reasonCode: 'invalid_kind' });
  }
  if (!isSafeId(raw.id)) {
    fail('unsafe_id', 'manifest.id 不合法', 422, { field: 'id', reasonCode: 'unsafe_id' });
  }
  const version = assertInt(raw.version, 'version', { min: 1, max: 1_000_000 });
  if (raw.private !== true) {
    fail('dataset_not_private', '私有数据集必须显式标记 private: true', 422, {
      field: 'private',
      reasonCode: 'dataset_not_private',
    });
  }
  if (!Array.isArray(raw.assets)) {
    fail('invalid_manifest', 'assets 必须是数组', 422, { field: 'assets', reasonCode: 'invalid_manifest' });
  }
  if (raw.assets.length > MAX_ASSETS) {
    fail('too_many_assets', `assets 超过 ${MAX_ASSETS} 上限`, 422, { field: 'assets', reasonCode: 'too_many_assets' });
  }
  const assets = [];
  const assetIds = new Set();
  raw.assets.forEach((asset, index) => {
    const normalized = validateAsset(asset, index);
    if (assetIds.has(normalized.id)) {
      fail('duplicate_id', `assets 含重复 id: ${normalized.id}`, 422, { field: 'assets', reasonCode: 'duplicate_id' });
    }
    assetIds.add(normalized.id);
    assets.push(normalized);
  });

  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    fail('empty_dataset', 'cases 不能为空', 422, { field: 'cases', reasonCode: 'empty_dataset' });
  }
  if (raw.cases.length > MAX_CASES) {
    fail('too_many_cases', `cases 超过 ${MAX_CASES} 上限`, 422, { field: 'cases', reasonCode: 'too_many_cases' });
  }
  const cases = [];
  const caseIds = new Set();
  raw.cases.forEach((caseData, index) => {
    const normalized = validateCase(caseData, index, assetIds);
    if (caseIds.has(normalized.id)) {
      fail('duplicate_id', `cases 含重复 id: ${normalized.id}`, 422, { field: 'cases', reasonCode: 'duplicate_id' });
    }
    caseIds.add(normalized.id);
    cases.push(normalized);
  });

  return {
    schemaVersion: DATASET_SCHEMA_VERSION,
    kind: DATASET_KIND,
    id: raw.id,
    version,
    private: true,
    assets,
    cases,
  };
}

// ---------------------------------------------------------------------------
// Filesystem safety.
// ---------------------------------------------------------------------------

function hasTraversal(relPath) {
  if (relPath.includes('\0')) return true;
  if (path.isAbsolute(relPath)) return true;
  if (/^[A-Za-z]:[\\/]/.test(relPath)) return true;
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.length === 0) return true;
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..');
}

export function assertSafeRelativePath(relPath, label = 'path') {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 400) {
    fail('unsafe_path', `${label} 必须是非空相对路径`, 422, { field: label, reasonCode: 'unsafe_path' });
  }
  if (hasTraversal(relPath)) {
    fail('unsafe_path', `${label} 含绝对路径、盘符或 .. 片段`, 422, { field: label, reasonCode: 'unsafe_path' });
  }
  return relPath;
}

async function assertNotSymlink(target, label, { expectFile = true } = {}) {
  let stat;
  try {
    stat = await fs.promises.lstat(target);
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail('missing_file', `${label} 不存在`, 422, { field: label, reasonCode: 'missing_file' });
    }
    throw err;
  }
  if (stat.isSymbolicLink()) {
    fail('unsafe_path', `${label} 不能是符号链接`, 422, { field: label, reasonCode: 'symlink' });
  }
  if (expectFile) {
    if (!stat.isFile()) {
      fail('unsafe_path', `${label} 必须是普通文件`, 422, { field: label, reasonCode: 'not_a_file' });
    }
  } else if (!stat.isDirectory()) {
    fail('unsafe_path', `${label} 的父级必须是目录`, 422, { field: label, reasonCode: 'not_a_file' });
  }
  return stat;
}

/**
 * Resolve a manifest-relative path under datasetDir, rejecting traversal,
 * symlinked components and escapes. Returns the absolute file path.
 */
export async function resolveDatasetFile(datasetDir, relPath, label = 'file') {
  assertSafeRelativePath(relPath, label);
  const realRoot = await fs.promises.realpath(datasetDir);
  const candidate = path.resolve(realRoot, relPath);
  const rel = path.relative(realRoot, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('unsafe_path', `${label} 超出数据集目录`, 422, { field: label, reasonCode: 'unsafe_path' });
  }
  // Walk each component and refuse symlinks anywhere on the path.
  const segments = rel.split(path.sep);
  let cursor = realRoot;
  for (let i = 0; i < segments.length; i += 1) {
    cursor = path.join(cursor, segments[i]);
    await assertNotSymlink(cursor, label, { expectFile: i === segments.length - 1 });
  }
  const real = await fs.promises.realpath(candidate);
  const realRel = path.relative(realRoot, real);
  if (realRel === '' || realRel.startsWith('..') || path.isAbsolute(realRel)) {
    fail('unsafe_path', `${label} 解析后超出数据集目录`, 422, { field: label, reasonCode: 'unsafe_path' });
  }
  return real;
}

async function resolveDatasetRoot(datasetDir) {
  if (typeof datasetDir !== 'string' || datasetDir.length === 0) {
    fail('missing_field', 'datasetDir 不能为空', 422, { field: 'datasetDir', reasonCode: 'missing_field' });
  }
  let stat;
  try {
    stat = await fs.promises.stat(datasetDir);
  } catch (err) {
    if (err.code === 'ENOENT') fail('not_found', `数据集目录不存在: ${datasetDir}`, 404);
    throw err;
  }
  if (!stat.isDirectory()) {
    fail('invalid_dataset', `数据集路径不是目录: ${datasetDir}`, 422, { reasonCode: 'invalid_dataset' });
  }
  return fs.promises.realpath(datasetDir);
}

async function findManifest(realDir) {
  for (const name of MANIFEST_FILE_NAMES) {
    const candidate = path.join(realDir, name);
    try {
      const stat = await fs.promises.lstat(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return name;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  fail('not_found', `数据集缺少 ${MANIFEST_FILE_NAMES.join(' 或 ')}`, 422, { reasonCode: 'missing_manifest' });
}

/** Read a referenced file and verify its declared hash and byte budget. */
export async function loadVerifiedFile({ datasetDir, relPath, sha256, label = 'file', maxBytes = MAX_PNG_BYTES }) {
  const filePath = await resolveDatasetFile(datasetDir, relPath, label);
  const buffer = await fs.promises.readFile(filePath);
  if (buffer.length === 0) {
    fail('empty_file', `${label} 为空文件`, 422, { field: label, reasonCode: 'empty_file' });
  }
  if (buffer.length > maxBytes) {
    fail('file_too_large', `${label} 超过 ${maxBytes} 字节上限`, 422, { field: label, reasonCode: 'file_too_large' });
  }
  if (sha256 && sha256Hex(buffer) !== sha256) {
    fail('source_hash_mismatch', `${label} 哈希与 manifest 不一致`, 422, {
      field: label,
      reasonCode: 'source_hash_mismatch',
    });
  }
  return buffer;
}

/**
 * Files referenced by a manifest: manifest file + asset files + case sources.
 * Deduplicated and path-safe. `sha256` is null for the manifest itself.
 */
export function listReferencedFileDescriptors(manifest, manifestName = MANIFEST_FILE_NAMES[0]) {
  const out = [];
  const seen = new Set();
  const push = (relPath, sha256, label) => {
    assertSafeRelativePath(relPath, label);
    if (seen.has(relPath)) {
      fail('duplicate_path', `数据集引用了重复文件: ${relPath}`, 422, { field: relPath, reasonCode: 'duplicate_path' });
    }
    seen.add(relPath);
    out.push({ relPath, sha256: sha256 ?? null, label });
  };
  push(manifestName, null, 'manifest');
  for (const asset of manifest.assets) push(asset.file, asset.sha256, `asset:${asset.id}`);
  for (const caseData of manifest.cases) push(caseData.source.file, caseData.source.sha256, `case:${caseData.id}`);
  return out;
}

export function computeDatasetInputHash(manifest) {
  return sha256Hex(canonicalJson(manifest));
}

/**
 * Load and fully validate a dataset directory.
 *
 * Every referenced file is read once for hash/dimension validation before any
 * provider call; buffers are released afterwards and re-verified on demand via
 * `loadVerifiedFile`.
 *
 * @returns {Promise<{datasetDir:string, manifestPath:string, manifest:object, assets:Map, cases:object[], datasetInputHash:string, referencedFiles:object[]}>}
 */
export async function readDataset(datasetDir) {
  const realDir = await resolveDatasetRoot(datasetDir);
  const manifestName = await findManifest(realDir);
  let raw;
  try {
    raw = JSON.parse(await fs.promises.readFile(path.join(realDir, manifestName), 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) {
      fail('malformed_json', 'manifest JSON 解析失败', 422, { reasonCode: 'malformed_json' });
    }
    throw err;
  }
  const manifest = validateManifest(raw);
  const referencedFiles = listReferencedFileDescriptors(manifest, manifestName);

  const assets = new Map();
  for (const asset of manifest.assets) {
    const buffer = await loadVerifiedFile({
      datasetDir: realDir,
      relPath: asset.file,
      sha256: asset.sha256,
      label: `asset:${asset.id}`,
    });
    let dims;
    try {
      dims = asset.mime === 'image/png' ? decodePng(buffer) : readImageDimensions(buffer, asset.mime);
    } catch (err) {
      fail('invalid_image', `素材 ${asset.id} 无法解析: ${err.message}`, 422, {
        field: asset.id,
        reasonCode: 'invalid_image',
      });
    }
    if (dims.width !== asset.width || dims.height !== asset.height) {
      fail('dimension_mismatch', `素材 ${asset.id} 实际尺寸 ${dims.width}x${dims.height} 与 manifest 不一致`, 422, {
        field: asset.id,
        reasonCode: 'dimension_mismatch',
      });
    }
    assets.set(asset.id, { ...asset, filePath: path.resolve(realDir, asset.file) });
  }

  const cases = [];
  for (const caseData of manifest.cases) {
    const buffer = await loadVerifiedFile({
      datasetDir: realDir,
      relPath: caseData.source.file,
      sha256: caseData.source.sha256,
      label: `case:${caseData.id}.source`,
    });
    let dims;
    try {
      dims = caseData.source.mime === 'image/png' ? decodePng(buffer) : readImageDimensions(buffer, caseData.source.mime);
    } catch (err) {
      fail('invalid_image', `用例 ${caseData.id} 源图无法解析: ${err.message}`, 422, {
        field: caseData.id,
        reasonCode: 'invalid_image',
      });
    }
    if (dims.width !== caseData.source.width || dims.height !== caseData.source.height) {
      fail('dimension_mismatch', `用例 ${caseData.id} 源图实际尺寸 ${dims.width}x${dims.height} 与 manifest 不一致`, 422, {
        field: caseData.id,
        reasonCode: 'dimension_mismatch',
      });
    }
    cases.push({ ...caseData, source: { ...caseData.source, filePath: path.resolve(realDir, caseData.source.file) } });
  }

  return {
    datasetDir: realDir,
    manifestPath: path.join(realDir, manifestName),
    manifestName,
    manifest,
    assets,
    cases,
    datasetInputHash: computeDatasetInputHash(manifest),
    referencedFiles,
  };
}

export default { readDataset, validateManifest };

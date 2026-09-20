import fs from 'node:fs';
import path from 'node:path';
import { ACTUAL_MANIFEST_SCHEMA_VERSION, MAX_PNG_BYTES, PNG_MATCH_THRESHOLD, SCHEMA_VERSION } from './constants.mjs';
import { fail, isSafeId, parseBase64, safeJoin } from './util.mjs';
import { isPng } from './png.mjs';
import { comparePngBuffers } from './compare.mjs';

export function validateActualManifest(raw, baseDir) {
  if (!raw || typeof raw !== 'object') fail('invalid_manifest', 'actual manifest 必须是对象', 422);
  if (raw.kind !== 'imstage-eval-actual-manifest') {
    fail('invalid_manifest', 'actual.kind 必须是 imstage-eval-actual-manifest', 422);
  }
  if (raw.schemaVersion !== ACTUAL_MANIFEST_SCHEMA_VERSION) {
    fail('unsupported_manifest_version', `不支持的 actual.schemaVersion: ${raw.schemaVersion}`, 422);
  }
  if (!Array.isArray(raw.cases)) fail('invalid_manifest', 'actual.cases 必须是数组', 422);
  const seen = new Set();
  const cases = raw.cases.map((entry, index) => {
    const label = `actual.cases[${index}]`;
    if (!entry || typeof entry !== 'object') fail('invalid_manifest', `${label} 格式错误`, 422);
    if (typeof entry.caseId !== 'string' || entry.caseId.length === 0) {
      fail('invalid_manifest', `${label} 缺少 caseId`, 422);
    }
    if (seen.has(entry.caseId)) {
      fail('invalid_manifest', `${label} caseId 重复: ${entry.caseId}`, 422);
    }
    seen.add(entry.caseId);
    if (typeof entry.inputFingerprint !== 'string' || !entry.inputFingerprint.startsWith('sha256:')) {
      fail('invalid_manifest', `${label} 缺少合法的 inputFingerprint`, 422);
    }
    let buffer = null;
    if (typeof entry.pngBase64 === 'string' && entry.pngBase64.length > 0) {
      buffer = parseBase64(entry.pngBase64, `${label} pngBase64`);
    } else if (typeof entry.pngPath === 'string' && entry.pngPath.length > 0) {
      const resolved = path.resolve(baseDir, entry.pngPath);
      buffer = null;
      return { caseId: entry.caseId, inputFingerprint: entry.inputFingerprint, pngPath: resolved };
    } else {
      fail('invalid_manifest', `${label} 必须提供 pngBase64 或 pngPath`, 422);
    }
    return { caseId: entry.caseId, inputFingerprint: entry.inputFingerprint, buffer };
  });
  return {
    schemaVersion: ACTUAL_MANIFEST_SCHEMA_VERSION,
    kind: 'imstage-eval-actual-manifest',
    generatedAt: raw.generatedAt ?? null,
    cases,
  };
}

function modalitiesFor(goldCase) {
  const kinds = new Set((goldCase.attachments ?? []).map((a) => a.kind));
  if (kinds.size === 0) kinds.add('text');
  return [...kinds].sort();
}

function emptyBucket() {
  return { total: 0, pass: 0, fail: 0, missing: 0, malformed: 0, stale: 0, extra: 0 };
}

function addToBreakdown(bucketRoot, key, status) {
  if (!bucketRoot[key]) bucketRoot[key] = emptyBucket();
  bucketRoot[key].total += 1;
  bucketRoot[key][status] += 1;
}

export function buildReport({ goldBundle, actualManifest, results, outDir, generatedAt, error, extraActual = [] }) {
  const summary = emptyBucket();
  summary.failed = 0;
  for (const r of results) {
    summary.total += 1;
    summary[r.status] += 1;
  }
  summary.failed = summary.total - summary.pass;
  summary.extra = extraActual.length;
  const emptyGoldenSet = goldBundle.cases.length === 0;
  const breakdown = {
    targetIM: {},
    surface: {},
    inputLanguage: {},
    outputKind: {},
    modality: {},
  };
  for (const r of results) {
    addToBreakdown(breakdown.targetIM, r.targetIM ?? 'unknown', r.status);
    addToBreakdown(breakdown.surface, r.surface ?? 'unknown', r.status);
    addToBreakdown(breakdown.inputLanguage, r.inputLanguage ?? 'unknown', r.status);
    addToBreakdown(breakdown.outputKind, r.outputKind ?? 'unknown', r.status);
    for (const m of r.modalities ?? ['text']) addToBreakdown(breakdown.modality, m, r.status);
  }
  const ok = !error && !emptyGoldenSet && summary.failed === 0 && summary.total > 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'imstage-eval-report',
    generatedAt,
    outDir,
    threshold: PNG_MATCH_THRESHOLD,
    goldSource: goldBundle.generator ?? null,
    actualSource: actualManifest.generator ?? null,
    ok,
    emptyGoldenSet,
    error: error ?? null,
    summary,
    extraActual,
    breakdown,
    results,
  };
}

// A diagnostic report is always written when --out is known, even if the gold
// or actual JSON is unreadable. CI uploads this file on failure.
export function buildErrorReport({ outDir, error, generatedAt }) {
  const summary = emptyBucket();
  summary.failed = 0;
  return {
    schemaVersion: SCHEMA_VERSION,
    kind: 'imstage-eval-report',
    generatedAt,
    outDir,
    threshold: PNG_MATCH_THRESHOLD,
    goldSource: null,
    actualSource: null,
    ok: false,
    emptyGoldenSet: false,
    error: String(error ?? 'unknown error'),
    summary,
    extraActual: [],
    breakdown: { targetIM: {}, surface: {}, inputLanguage: {}, outputKind: {}, modality: {} },
    results: [],
  };
}

export async function writeErrorReport({ outDir, error, generatedAt = new Date().toISOString() }) {
  const report = buildErrorReport({ outDir: path.resolve(outDir), error, generatedAt });
  await fs.promises.mkdir(report.outDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(report.outDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await fs.promises.writeFile(path.join(report.outDir, 'report.md'), renderMarkdown(report));
  return report;
}

export async function evaluateGolden({ goldBundle, actualManifest, outDir, writeArtifacts = true }) {
  const generatedAt = new Date().toISOString();
  const outDirResolved = path.resolve(outDir);
  const results = [];
  const diffsDir = path.join(outDirResolved, 'diffs');

  const actualByCase = new Map();
  for (const c of actualManifest.cases) actualByCase.set(c.caseId, c);
  const goldIds = new Set(goldBundle.cases.map((c) => c.bundleCaseId));
  const extraActual = actualManifest.cases
    .map((c) => c.caseId)
    .filter((id) => !goldIds.has(id));

  for (const goldCase of goldBundle.cases) {
    const base = {
      caseId: goldCase.bundleCaseId,
      targetIM: goldCase.targetIM,
      surface: goldCase.surface,
      inputLanguage: goldCase.inputLanguage,
      outputKind: goldCase.outputKind,
      modalities: modalitiesFor(goldCase),
      maxDiffRatio: goldCase.maxDiffRatio,
      width: goldCase.goldenPng.width,
      height: goldCase.goldenPng.height,
      inputFingerprint: goldCase.inputFingerprint,
    };
    const actual = actualByCase.get(goldCase.bundleCaseId);
    if (!actual) {
      results.push({ ...base, status: 'missing', reason: 'actual_missing' });
      continue;
    }
    if (actual.inputFingerprint !== goldCase.inputFingerprint) {
      results.push({
        ...base,
        status: 'stale',
        reason: 'input_fingerprint_mismatch',
        actualInputFingerprint: actual.inputFingerprint,
      });
      continue;
    }
    let actualBuffer = actual.buffer;
    if (!actualBuffer && actual.pngPath) {
      try {
        const stat = await fs.promises.stat(actual.pngPath);
        if (stat.size > MAX_PNG_BYTES) {
          results.push({
            ...base,
            status: 'malformed',
            reason: 'actual_too_large',
            detail: `文件 ${stat.size} 字节，超过 ${MAX_PNG_BYTES} 字节上限`,
          });
          continue;
        }
        actualBuffer = await fs.promises.readFile(actual.pngPath);
      } catch (err) {
        results.push({ ...base, status: 'malformed', reason: 'actual_unreadable', detail: err.message });
        continue;
      }
    }
    if (!actualBuffer || !isPng(actualBuffer)) {
      results.push({ ...base, status: 'malformed', reason: 'actual_not_png' });
      continue;
    }
    const comparison = comparePngBuffers({
      goldBuffer: goldCase.goldenPng.buffer,
      actualBuffer,
      maxDiffRatio: goldCase.maxDiffRatio,
      produceDiff: true,
    });
    if (comparison.status === 'malformed') {
      results.push({ ...base, status: 'malformed', reason: comparison.reason, detail: comparison.detail });
      continue;
    }
    if (comparison.status === 'fail') {
      const result = {
        ...base,
        status: 'fail',
        reason: comparison.reason,
        diffPixels: comparison.diffPixels,
        diffRatio: comparison.diffRatio,
        actualWidth: comparison.actualWidth,
        actualHeight: comparison.actualHeight,
      };
      if (writeArtifacts && isSafeId(goldCase.bundleCaseId) && comparison.diffPng) {
        const diffPath = safeJoin(diffsDir, `${goldCase.bundleCaseId}.png`);
        await fs.promises.mkdir(diffsDir, { recursive: true });
        await fs.promises.writeFile(diffPath, comparison.diffPng);
        result.diffFile = path.relative(outDirResolved, diffPath);
      } else if (!isSafeId(goldCase.bundleCaseId)) {
        result.diffFile = null;
        result.diffSkipped = 'unsafe_case_id';
      }
      results.push(result);
      continue;
    }
    results.push({
      ...base,
      status: 'pass',
      reason: comparison.reason,
      diffPixels: comparison.diffPixels,
      diffRatio: comparison.diffRatio,
      actualWidth: comparison.width,
      actualHeight: comparison.height,
    });
  }

  const report = buildReport({
    goldBundle,
    actualManifest,
    results,
    outDir: outDirResolved,
    generatedAt,
    extraActual,
  });
  if (writeArtifacts) {
    await fs.promises.mkdir(outDirResolved, { recursive: true });
    await fs.promises.writeFile(
      path.join(outDirResolved, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await fs.promises.writeFile(path.join(outDirResolved, 'report.md'), renderMarkdown(report));
  }
  return { report, outDir: outDirResolved };
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push('# IMStage PNG 金标评测报告');
  lines.push('');
  lines.push(`- 生成时间: ${report.generatedAt}`);
  lines.push(`- 阈值 (pixelmatch threshold): ${report.threshold}`);
  lines.push(`- 结论: ${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push('- 性质: 确定性像素对比，不代表真实模型或渲染器的质量评测。');
  if (report.emptyGoldenSet) lines.push('- 错误: 金标集合为空（零个 golden case）');
  if (report.error) lines.push(`- 错误: ${report.error}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 指标 | 数量 |');
  lines.push('| --- | --- |');
  lines.push(`| 金标用例 | ${report.summary.total} |`);
  lines.push(`| 通过 | ${report.summary.pass} |`);
  lines.push(`| 像素/尺寸失败 | ${report.summary.fail} |`);
  lines.push(`| 缺失 | ${report.summary.missing} |`);
  lines.push(`| 损坏/非法 | ${report.summary.malformed} |`);
  lines.push(`| 过期(指纹不匹配) | ${report.summary.stale} |`);
  lines.push(`| 额外(actual 中未被金标引用) | ${report.summary.extra ?? 0} |`);
  lines.push('');
  if (report.extraActual && report.extraActual.length > 0) {
    lines.push(`未匹配的 actual caseId: ${report.extraActual.join(', ')}`);
    lines.push('');
  }
  for (const [dim, buckets] of Object.entries(report.breakdown)) {
    const keys = Object.keys(buckets);
    if (keys.length === 0) continue;
    lines.push(`## 按 ${dim} 拆分`);
    lines.push('');
    lines.push('| 值 | 总数 | 通过 | 失败 | 缺失 | 损坏 | 过期 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const key of keys) {
      const b = buckets[key];
      lines.push(`| ${key} | ${b.total} | ${b.pass} | ${b.fail} | ${b.missing} | ${b.malformed} | ${b.stale} |`);
    }
    lines.push('');
  }
  lines.push('## 逐用例结果');
  lines.push('');
  lines.push('| caseId | 状态 | 原因 | 差异比 | 容差 | 宽×高 | diff |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of report.results) {
    const ratio = r.diffRatio === null || r.diffRatio === undefined ? '-' : r.diffRatio.toFixed(6);
    const dims = `${r.actualWidth ?? r.width ?? '-'}×${r.actualHeight ?? r.height ?? '-'}`;
    lines.push(
      `| ${r.caseId} | ${r.status} | ${r.reason} | ${ratio} | ${r.maxDiffRatio} | ${dims} | ${r.diffFile ?? '-'} |`,
    );
  }
  lines.push('');
  lines.push('> 差异图仅对安全 caseId 输出。缺失、损坏与过期用例不会被计为通过。');
  lines.push('');
  return `${lines.join('\n')}`;
}

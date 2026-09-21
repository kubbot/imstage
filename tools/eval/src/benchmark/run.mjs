import { callDeepSeekAgent, collectAssetRegistry } from './agent.mjs';
// Screenshot-edit benchmark runner.
//
// runDataset({datasetDir, outDir, env, limit, resume, generatePlan, renderPlan})
// drives the whole benchmark:
//   1. read + fully validate the private dataset (hashes/dimensions, no
//      provider call before every source and asset is verified),
//   2. ask the model once per case (concurrency 1, no retries) with ONLY the
//      task, the source image data block, authorized asset metadata and the
//      output schema. Expected edits, analysis, reference PNGs and the exact
//      expected boxes are never sent to the model,
//   3. render the returned plan over the original screenshot with the shared
//      deterministic renderer,
//   4. score it against the curated expected plan,
//   5. write a SANITIZED public report.json/report.md plus PRIVATE per-case
//      JSON/PNG, and optional offline expected/<caseId>.png references.
//
// Public artifacts contain case ids, difficulty, scores, error codes, timing
// and token usage only. Task text, raw model answers, source text, original
// filenames, asset images, prompts and keys never leave the private files.

import fs from 'node:fs';
import path from 'node:path';
import { AI_DEFAULT_BASE_URL, AI_DEFAULT_MODEL } from '../constants.mjs';
import { AppError, atomicWriteJson, canonicalJson, fail, nowIso, sha256Hex, toErrorMessage } from '../util.mjs';
import { loadVerifiedFile, readDataset } from './dataset.mjs';
import { planFromExpected, planFromModel } from './plan.mjs';
import { renderEditPlan } from './render.mjs';
import { decodePng } from '../png.mjs';
import { scorePlan } from './score.mjs';

export { readDataset, loadVerifiedFile };

export const BENCHMARK_PROMPT_VERSION = 'screenshot-agent-v5';
export const BENCHMARK_RUNTIME_VERSION = 'agent-edit-render-score-v9';
export const BENCHMARK_MAX_TOKENS = 7000;
export const BENCHMARK_TIMEOUT_MS = 90_000;
export const DEFAULT_LIMIT = 11;
export const MAX_LIMIT = 11;
export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_KIND = 'imstage-screenshot-edit-report';

// ---------------------------------------------------------------------------
// Provider configuration + request building.
// ---------------------------------------------------------------------------

export function resolveBenchmarkAiConfig(env = process.env) {
  const apiKey = String(env.IMSTAGE_AI_API_KEY ?? env.DEEPSEEK_API_KEY ?? '').trim();
  const baseUrlRaw = String(env.IMSTAGE_AI_BASE_URL ?? AI_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const model = String(env.IMSTAGE_AI_MODEL ?? AI_DEFAULT_MODEL).trim() || AI_DEFAULT_MODEL;
  const baseUrl = /^https?:\/\//i.test(baseUrlRaw) ? baseUrlRaw : AI_DEFAULT_BASE_URL;
  return {
    configured: apiKey.length > 0,
    apiKey,
    baseUrl,
    model,
    maxTokens: BENCHMARK_MAX_TOKENS,
    timeoutMs: BENCHMARK_TIMEOUT_MS,
    disableThinking: true,
  };
}

export function buildPlanSystemPrompt(request) {
  return [
    '你是 IMStage 截图编辑模型。输入是一张真实 IM 截图和一条编辑任务。',
    '只输出一个 JSON 对象，不要输出解释、Markdown 或代码块。',
    '输出形状固定为：',
    '{',
    `  "schemaVersion": 1,`,
    `  "im": "${request.im}",`,
    `  "surface": "${request.surface}",`,
    `  "width": ${request.width}, "height": ${request.height},`,
    '  "edits": [Edit],',
    '  "warnings": ["可选的不确定说明"]',
    '}',
    'Edit 固定形状：',
    '{',
    `  "id": "安全 id（字母/数字/下划线/连字符）",`,
    `  "kind": "text | image",`,
    `  "box": [x, y, width, height],  // 归一化到 0..1000，完全落在源图内`,
    `  "background": "#RRGGBB", "color": "#RRGGBB",`,
    `  "text": "仅 text 编辑，纯文本，可含换行",           // text 必填`,
    `  "assetId": "仅 image 编辑，必须是本次授权的素材 id",  // image 必填`,
    `  "fontSize": 10..160  // text 可选，实际源图像素，默认 16`,
    `  "fontWeight": 400|500|600|700, "align": "left|center|right",`,
    `  "radius": 0..80, "fit": "cover|contain"`,
    '}',
    '规则：',
    '- 只允许上述字段；不要输出 url、src、path、file、html、css、style、script、base64 或任何远程地址。',
    '- 每个编辑必须完全落在源图 0..1000 的归一化坐标内，宽高为正。',
    `- image 编辑只能引用本次授权的素材 id：${request.assets.map((asset) => asset.id).join(', ') || '(无)'}。`,
    '- 保持源截图尺寸不变，文字只写在 box 内，不要遮住任务未要求修改的区域。',
    '- 任务里出现的 URL 只作为文字内容，不会被访问。',
    '- text 编辑覆盖完整旧文字区域，但不要覆盖气泡边缘；用接近原字号的实际像素字号，禁止默认微小字号。\n- image 编辑的 box 必须精确匹配原图片槽位边界。不得扩大、移动或改变宽高。\n- 看不清的内容不要编造，在 warnings 中说明。',
  ].join('\n');
}

export function buildPlanUserContent(request) {
  const content = [
    {
      type: 'text',
      text: `${request.task}\n\n[约束]\n- IM: ${request.im}\n- 设备: ${request.surface}\n- 源图尺寸: ${request.width}x${request.height}\n- 授权素材: ${request.assets.map((asset) => `${asset.id}(${asset.mime}, ${asset.width}x${asset.height}, ${asset.description})`).join(', ') || '无'}`,
    },
  ];
  content.push({ type: 'image_url', image_url: { url: `data:${request.source.mime};base64,${request.source.dataBase64}` } });
  return content;
}

/**
 * Build the model request: task + source image block + authorized asset
 * metadata + size/schema. Never includes expected/analysis/reference data.
 */
export function buildPlanRequest({ caseData, sourceBuffer, assets = [] }) {
  const assetMeta = assets.map((asset) => ({
    id: asset.id,
    mime: asset.mime,
    width: asset.metadata?.width ?? caseData.source.width,
    height: asset.metadata?.height ?? caseData.source.height,
    description: asset.metadata?.description ?? '',
  }));
  const request = {
    caseId: caseData.id,
    task: caseData.task,
    im: caseData.im,
    surface: caseData.surface,
    width: caseData.source.width,
    height: caseData.source.height,
    source: {
      mime: caseData.source.mime,
      dataBase64: sourceBuffer.toString('base64'),
      width: caseData.source.width,
      height: caseData.source.height,
    },
    assets: assetMeta,
  };
  return request;
}

export function buildProviderRequestBody(config, request) {
  return {
    model: config.model,
    messages: [
      { role: 'system', content: buildPlanSystemPrompt(request) },
      { role: 'user', content: buildPlanUserContent(request) },
    ],
    max_tokens: config.maxTokens ?? BENCHMARK_MAX_TOKENS,
    response_format: { type: 'json_object' },
    stream: false,
    thinking: { type: 'disabled' },
  };
}

function mapHttpStatus(status) {
  if (status === 401 || status === 403) return new AppError('ai_auth_failed', 'AI 鉴权失败', 502);
  if (status === 402 || status === 429) return new AppError('ai_quota_exceeded', 'AI 额度不足或请求过于频繁', 429);
  if (status === 400 || status === 422) return new AppError('ai_rejected_request', 'AI 拒绝了本次请求', 502);
  if (status >= 500) return new AppError('ai_provider_error', 'AI 服务返回错误', 502);
  return new AppError('ai_provider_error', `AI 服务返回异常状态 (${status})`, 502);
}

/**
 * Default `generatePlan` seam: one native fetch call, no retries, 90s timeout,
 * thinking disabled. Usage and model are captured for the report.
 */
export async function callDeepSeekPlan({ config, request, signal, fetchImpl = fetch }) {
  if (!config || config.configured !== true) {
    throw new AppError('ai_not_configured', '未配置 AI（需要 IMSTAGE_AI_API_KEY 或 DEEPSEEK_API_KEY）', 503);
  }
  const url = `${config.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('ai_timeout')), config.timeoutMs ?? BENCHMARK_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('request_aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(buildProviderRequestBody(config, request)),
      signal: controller.signal,
    });
    if (!response.ok) throw mapHttpStatus(response.status);
    let data;
    try {
      data = await response.json();
    } catch {
      throw new AppError('ai_invalid_response', 'AI 返回的不是合法 JSON', 502);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new AppError('ai_empty_response', 'AI 未返回可用内容', 502);
    }
    const usage = data?.usage && typeof data.usage === 'object' ? data.usage : null;
    return { rawContent: content, model: typeof data?.model === 'string' ? data.model : config.model, usage };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new AppError('request_aborted', '请求已取消', 499);
      throw new AppError('ai_timeout', `AI 请求超时（${Math.round((config.timeoutMs ?? BENCHMARK_TIMEOUT_MS) / 1000)} 秒）`, 504);
    }
    throw new AppError('ai_unreachable', 'AI 服务不可达', 502);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function stripCodeFences(value) {
  const trimmed = String(value ?? '').trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export function parsePlanResponse(rawContent, { caseData, authorizedAssetIds = caseData?.assetIds ?? null } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFences(rawContent));
  } catch {
    throw new AppError('plan_invalid_json', '模型未返回合法 JSON', 502);
  }
  try {
    const { plan, warnings } = planFromModel(parsed, { authorizedAssetIds });
    return { plan, warnings };
  } catch (err) {
    if (err instanceof AppError) {
      throw new AppError('plan_invalid', `模型 plan 不合法: ${err.message}`, 502, { reasonCode: err.code, field: err.details?.field });
    }
    throw err;
  }
}

/**
 * Resolve the runtime-returned asset registry at the runner boundary.
 *
 * `generated.assets` / `assetRegistry` is the full runtime registry (with
 * preprovided assets included); `generatedAssets` is the legacy/partial list.
 * Every entry is re-validated for shape, decodable bytes and preprovided
 * ownership before it can be rendered or scored, even when an injected seam
 * returns it. Model-claimed ids never enter this path by themselves.
 */
async function resolveRuntimeAssets(generated, inputAssets, signal) {
  const registrySource = Array.isArray(generated?.assets) && generated.assets.length
    ? generated.assets
    : Array.isArray(generated?.assetRegistry) && generated.assetRegistry.length
      ? generated.assetRegistry
      : Array.isArray(generated?.generatedAssets)
        ? generated.generatedAssets
        : [];
  if (registrySource.length === 0) return { registry: [], generated: [], provenance: {} };
  return collectAssetRegistry({ reference: { assets: registrySource }, inputAssets, signal, strict: true });
}

/** Merge verified input assets with generated assets, de-duplicating by id. */
function mergeRenderAssets(inputAssets, generatedAssets) {
  const merged = [];
  const seen = new Set();
  for (const asset of [...inputAssets, ...generatedAssets]) {
    if (!asset || typeof asset.id !== 'string' || seen.has(asset.id) || !Buffer.isBuffer(asset.buffer)) continue;
    seen.add(asset.id);
    merged.push({ id: asset.id, mime: asset.mime, buffer: asset.buffer });
  }
  return merged;
}

/**
 * Render a partial plan from a failed runtime when it is still renderable.
 * Returns the validated plan plus whether a PNG was produced; it never throws so
 * the failure record is always written with unmistakable error status.
 */
async function renderPartialRecord({ callRender, caseData, sourceBuffer, inputAssets, partial, outRoot }) {
  try {
    const partialAssets = Array.isArray(partial.assets)
      ? partial.assets
      : Array.isArray(partial.generatedAssets)
        ? partial.generatedAssets
        : [];
    const registry = await collectAssetRegistry({
      reference: { assets: partialAssets },
      inputAssets,
      strict: false,
    });
    const generatedIds = registry.generated.map((asset) => asset.id);
    const authorizedAssetIds = new Set([...caseData.assetIds, ...generatedIds]);
    const { plan } = parsePlanResponse(JSON.stringify(partial.plan), { caseData, authorizedAssetIds });
    const renderAssets = mergeRenderAssets(inputAssets, registry.generated);
    const rendered = await renderCase({ callRender, caseData, sourceBuffer, assets: renderAssets, plan });
    await fs.promises.writeFile(path.join(outRoot, 'private', `${caseData.id}.png`), rendered.buffer, { mode: 0o600 });
    return {
      plan,
      rendered: true,
      pngSha256: sha256Hex(rendered.buffer),
      generatedIds,
      provenance: registry.provenance,
    };
  } catch {
    return {
      plan: partial.plan ?? null,
      rendered: false,
      generatedIds: [],
      provenance: partial.provenance ?? {},
    };
  }
}

// ---------------------------------------------------------------------------
// Errors + hashing helpers.
// ---------------------------------------------------------------------------

const SAFE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

export function safeErrorCode(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return SAFE_CODE_RE.test(code) ? code : 'internal_error';
}

export function computeCaseInputHash(caseData) {
  return sha256Hex(
    canonicalJson({
      id: caseData.id,
      task: caseData.task,
      im: caseData.im,
      surface: caseData.surface,
      source: {mime:caseData.source.mime, sha256:caseData.source.sha256, width:caseData.source.width, height:caseData.source.height},
      expected: caseData.expected,
      difficulty: caseData.difficulty,
      analysis: caseData.analysis,
      assetIds: caseData.assetIds,
    }),
  );
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const pick = (key) => (Number.isFinite(usage[key]) ? usage[key] : undefined);
  const normalized = {
    promptTokens: pick('prompt_tokens') ?? pick('promptTokens') ?? null,
    completionTokens: pick('completion_tokens') ?? pick('completionTokens') ?? null,
    totalTokens: pick('total_tokens') ?? pick('totalTokens') ?? null,
  };
  if (normalized.promptTokens === null && normalized.completionTokens === null && normalized.totalTokens === null) return null;
  return normalized;
}

// ---------------------------------------------------------------------------
// Offline expected references.
// ---------------------------------------------------------------------------

async function loadCaseAssets(resolved, caseData) {
  const assets = [];
  for (const assetId of caseData.assetIds) {
    const asset = resolved.assets.get(assetId);
    if (!asset) {
      fail('missing_asset', `用例 ${caseData.id} 缺少素材 ${assetId}`, 422, { reasonCode: 'missing_asset' });
    }
    const buffer = await loadVerifiedFile({
      datasetDir: resolved.datasetDir,
      relPath: asset.file,
      sha256: asset.sha256,
      label: `asset:${asset.id}`,
    });
    assets.push({ id: asset.id, mime: asset.mime, buffer, metadata: asset });
  }
  return assets;
}

async function loadCaseSource(resolved, caseData) {
  return loadVerifiedFile({
    datasetDir: resolved.datasetDir,
    relPath: caseData.source.file,
    sha256: caseData.source.sha256,
    label: `case:${caseData.id}.source`,
  });
}

async function ensureOutDirs(outRoot, { privateDir = false, expectedDir = false } = {}) {
  await fs.promises.mkdir(outRoot, { recursive: true, mode: 0o700 });
  if (privateDir) await fs.promises.mkdir(path.join(outRoot, 'private'), { recursive: true, mode: 0o700 });
  if (expectedDir) await fs.promises.mkdir(path.join(outRoot, 'expected'), { recursive: true, mode: 0o700 });
}

/**
 * Render the curated expected plans offline (no provider). This is a PROPOSED
 * reference, never an auto-approved golden.
 */
export async function renderExpectedDataset({ datasetDir, outDir, renderPlan } = {}) {
  if (typeof outDir !== 'string' || outDir.length === 0) {
    fail('missing_out_dir', 'outDir 不能为空', 422, { field: 'outDir' });
  }
  const resolved = await readDataset(datasetDir);
  const outRoot = path.resolve(outDir);
  if (isInside(outRoot, resolved.datasetDir)) {
    fail('unsafe_path', 'outDir 不能位于数据集目录内', 422, { reasonCode: 'unsafe_path' });
  }
  const callRender = renderPlan ?? renderEditPlan;
  await ensureOutDirs(outRoot, { expectedDir: true });
  const failures = [];
  let rendered = 0;
  for (const caseData of resolved.cases) {
    await fs.promises.rm(path.join(outRoot,'expected',`${caseData.id}.png`),{force:true});
    await fs.promises.rm(path.join(outRoot,'expected',`${caseData.id}.json`),{force:true});
    try {
      const sourceBuffer = await loadCaseSource(resolved, caseData);
      const assets = await loadCaseAssets(resolved, caseData);
      const plan = planFromExpected(caseData);
      const output = await callRender({
        sourceBuffer,
        sourceMime: caseData.source.mime,
        width: caseData.source.width,
        height: caseData.source.height,
        plan,
        assets,
      });
      if (!output?.buffer) fail('render_failed', '预期图渲染未返回 PNG', 502, { reasonCode: 'render_failed' });
      await fs.promises.writeFile(path.join(outRoot, 'expected', `${caseData.id}.png`), output.buffer,{mode:0o600});
      await atomicWriteJson(path.join(outRoot,'expected',`${caseData.id}.json`),{binding:{datasetInputHash:resolved.datasetInputHash,caseInputHash:computeCaseInputHash(caseData),runtimeVersion:BENCHMARK_RUNTIME_VERSION},pngSha256:sha256Hex(output.buffer),proposed:true});
      rendered += 1;
    } catch (err) {
      failures.push({ caseId: caseData.id, errorCode: safeErrorCode(err) });
    }
  }
  const result = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: 'imstage-screenshot-edit-expected-refs',
    generatedAt: nowIso(),
    dataset: { id: resolved.manifest.id, version: resolved.manifest.version, inputHash: resolved.datasetInputHash },
    counts: { casesTotal: resolved.cases.length, rendered, failed: failures.length },
    failures,
    proposed: true,
    ok: failures.length === 0 && rendered === resolved.cases.length,
  };
  await atomicWriteJson(path.join(outRoot, 'expected-report.json'), result);
  return { ...result, outDir: outRoot };
}

// ---------------------------------------------------------------------------
// Resume.
// ---------------------------------------------------------------------------

async function readPriorResult({ outRoot, resolved, caseData, config, promptVersion, usingSeam, renderSeam }) {
  const privatePath = path.join(outRoot, 'private', `${caseData.id}.json`);
  let record;
  try {
    record = JSON.parse(await fs.promises.readFile(privatePath, 'utf8'));
  } catch {
    return null;
  }
  if (!record || typeof record !== 'object') return null;
  const binding = record.binding;
  if (!binding) return null;
  if (binding.datasetInputHash !== resolved.datasetInputHash) return null;
  if (binding.caseInputHash !== computeCaseInputHash(caseData)) return null;
  if (binding.model !== config.model) return null;
  if (binding.provider !== config.baseUrl || binding.runtimeVersion !== BENCHMARK_RUNTIME_VERSION || binding.offlineProvider !== usingSeam || binding.offlineRenderer !== renderSeam) return null;
  if (binding.promptVersion !== promptVersion) return null;
  if (!record.plan || !record.score) return null;
  const pngPath = path.join(outRoot, 'private', `${caseData.id}.png`);
  try {
    const stat = await fs.promises.lstat(pngPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) return null;
    const bytes=await fs.promises.readFile(pngPath);
    if(sha256Hex(bytes)!==record.pngSha256)return null;
    const image=decodePng(bytes);
    if(image.width!==caseData.source.width||image.height!==caseData.source.height)return null;
  } catch {
    return null;
  }
  return record;
}

// ---------------------------------------------------------------------------
// Main runner.
// ---------------------------------------------------------------------------

async function renderCase({ callRender, caseData, sourceBuffer, assets, plan }) {
  return callRender({
    sourceBuffer,
    sourceMime: caseData.source.mime,
    width: caseData.source.width,
    height: caseData.source.height,
    plan,
    assets,
  });
}

async function baselineSourcePng({ callRender, caseData, sourceBuffer, assets }) {
  if (caseData.source.mime === 'image/png') return sourceBuffer;
  const emptyPlan = {
    schemaVersion: 1,
    im: caseData.im,
    surface: caseData.surface,
    width: caseData.source.width,
    height: caseData.source.height,
    edits: [],
    warnings: [],
  };
  const rendered = await renderCase({ callRender, caseData, sourceBuffer, assets, plan: emptyPlan });
  return rendered.buffer;
}

function publicCaseEntry(result) {
  return {
    caseId: result.caseId,
    difficulty: result.difficulty,
    status: result.status,
    passed: result.passed,
    score: result.score,
    errorCode: result.errorCode ?? null,
    durationMs: result.durationMs,
    usage: result.usage ?? null,
    checks: (result.checks ?? []).map((entry) => ({
      id: entry.id,
      passed: entry.passed,
      score: entry.score,
      reasonCode: entry.reasonCode,
    })),
  };
}

function renderReportMarkdown(report) {
  const lines = [
    '# IMStage 截图编辑基准报告',
    '',
    `- 数据集: ${report.dataset?.id ?? 'unavailable'} v${report.dataset?.version ?? '?'}`,
    `- 模型: ${report.model} / prompt ${report.promptVersion}`,
    `- 生成时间: ${report.generatedAt}`,
    `- 结论: ${report.ok ? 'PASS' : 'FAIL'}${report.subset ? '（子集，未覆盖全套，绝不代表全套通过）' : ''}`,
    `- 用例: ${report.counts.casesPassed}/${report.counts.casesAttempted} 通过，共 ${report.counts.casesTotal}`,
    '- 说明: 自动分数只覆盖尺寸/语义/几何/像素保持，审美与真实 IM 一致性仍需人工复核。',
    '',
    '| case | 难度 | 状态 | 分数 | 错误码 | 用时(ms) | tokens |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of report.cases) {
    const tokens = entry.usage?.totalTokens ?? '';
    lines.push(
      `| ${entry.caseId} | ${entry.difficulty} | ${entry.status} | ${entry.score ?? ''} | ${entry.errorCode ?? ''} | ${entry.durationMs} | ${tokens} |`,
    );
  }
  lines.push('');
  lines.push('## 分布');
  lines.push('');
  for (const [im, stats] of Object.entries(report.byIM)) {
    lines.push(`- IM ${im}: ${stats.passed}/${stats.attempted} 通过`);
  }
  for (const [difficulty, stats] of Object.entries(report.byDifficulty)) {
    lines.push(`- 难度 ${difficulty}: ${stats.passed}/${stats.attempted} 通过`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

/**
 * @param {object} options
 * @param {string} options.datasetDir
 * @param {string} options.outDir
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.limit]
 * @param {boolean} [options.resume]
 * @param {Function} [options.generatePlan] injected provider seam ({config, request, signal})
 * @param {Function} [options.renderPlan] injected renderer seam
 * @param {boolean} [options.writeExpected] also render expected/<caseId>.png offline
 * @returns {Promise<object>} sanitized report
 */
export async function runDataset({
  datasetDir,
  outDir,
  env = process.env,
  limit = DEFAULT_LIMIT,
  resume = false,
  generatePlan,
  renderPlan,
  writeExpected = false,
} = {}) {
  if (typeof outDir !== 'string' || outDir.length === 0) {
    fail('missing_out_dir', 'outDir 不能为空', 422, { field: 'outDir' });
  }
  const resolved = await readDataset(datasetDir);
  const outRoot = path.resolve(outDir);
  if (isInside(outRoot, resolved.datasetDir)) {
    fail('unsafe_path', 'outDir 不能位于数据集目录内', 422, { reasonCode: 'unsafe_path' });
  }

  const config = resolveBenchmarkAiConfig(env);
  const promptVersion = BENCHMARK_PROMPT_VERSION;
  const usingSeam = typeof generatePlan === 'function';
  const callGenerate = generatePlan ?? callDeepSeekAgent;
  const callRender = renderPlan ?? renderEditPlan;

  const requestedLimit = Number.isInteger(limit) ? limit : DEFAULT_LIMIT;
  const effectiveLimit = Math.max(1, Math.min(requestedLimit, MAX_LIMIT, resolved.cases.length));
  const selected = resolved.cases.slice(0, effectiveLimit);
  const subset = selected.length < resolved.cases.length;

  await ensureOutDirs(outRoot, { privateDir: true, expectedDir: writeExpected });
  const startedAt = nowIso();
  const results = [];
  let providerCalls = 0;
  let resumeReused = 0;
  let expectedRendered = 0;

  for (const caseData of selected) {
    const caseStarted = Date.now();
    let prior = null;
    if (resume) prior = await readPriorResult({ outRoot, resolved, caseData, config, promptVersion, usingSeam, renderSeam:!!renderPlan });
    if (prior) {
      resumeReused += 1;
      results.push({
        caseId: caseData.id,
        difficulty: caseData.difficulty,
        im: caseData.im,
        surface: caseData.surface,
        status: prior.status ?? (prior.passed ? 'pass' : 'fail'),
        passed: prior.passed === true,
        score: prior.score?.score ?? prior.score,
        errorCode: prior.errorCode ?? null,
        durationMs: 0,
        usage: prior.usage ?? null,
        checks: prior.score?.checks ?? prior.checks ?? [],
        internal: prior,
      });
      continue;
    }

    await fs.promises.rm(path.join(outRoot, 'private', `${caseData.id}.png`), {force:true});
    await fs.promises.rm(path.join(outRoot, 'private', `${caseData.id}.json`), {force:true});
    if(writeExpected){
      await fs.promises.rm(path.join(outRoot,'expected',`${caseData.id}.png`),{force:true});
      await fs.promises.rm(path.join(outRoot,'expected',`${caseData.id}.json`),{force:true});
    }
    let sourceBuffer = null;
    let assets = [];
    try {
      sourceBuffer = await loadCaseSource(resolved, caseData);
      assets = await loadCaseAssets(resolved, caseData);

      if (writeExpected) {
        const expectedPlan = planFromExpected(caseData);
        const expectedOutput = await renderCase({ callRender, caseData, sourceBuffer, assets, plan: expectedPlan });
        await fs.promises.writeFile(path.join(outRoot, 'expected', `${caseData.id}.png`), expectedOutput.buffer,{mode:0o600});
        await atomicWriteJson(path.join(outRoot,'expected',`${caseData.id}.json`),{binding:{datasetInputHash:resolved.datasetInputHash,caseInputHash:computeCaseInputHash(caseData),runtimeVersion:BENCHMARK_RUNTIME_VERSION},pngSha256:sha256Hex(expectedOutput.buffer),proposed:true});
        expectedRendered += 1;
      }

      if (!usingSeam && config.configured !== true) {
        throw new AppError('ai_not_configured', '未配置 AI（需要 IMSTAGE_AI_API_KEY 或 DEEPSEEK_API_KEY）', 503);
      }
      const request = buildPlanRequest({ caseData, sourceBuffer, assets });
      providerCalls += 1;
      const sourcePng = await baselineSourcePng({ callRender, caseData, sourceBuffer, assets });
      const generated = await callGenerate({ config, request, assets, env, signal: undefined });
      if (!generated || typeof generated.rawContent !== 'string' || generated.rawContent.length === 0) {
        throw new AppError('ai_empty_response', '模型未返回内容', 502);
      }
      const model = typeof generated.model === 'string' && generated.model ? generated.model : config.model;
      const usage = normalizeUsage(generated.usage);

      // Accept generated assets ONLY from the actual runtime-returned registry
      // with validated image bytes and ownership. A static case allowlist or a
      // model-claimed id that never entered the registry is not sufficient.
      const runtimeAssets = await resolveRuntimeAssets(generated, assets, undefined);
      const generatedIds = runtimeAssets.generated.map((asset) => asset.id);
      const conflicts = generatedIds.filter((id) => caseData.assetIds.includes(id));
      if (conflicts.length > 0) {
        throw new AppError(
          'asset_ownership_violation',
          `生成素材复用了预置素材 id: ${conflicts.join(', ')}`,
          502,
          { reasonCode: 'asset_ownership_violation' },
        );
      }
      const authorizedAssetIds = new Set([...caseData.assetIds, ...generatedIds]);
      const { plan, warnings } = parsePlanResponse(generated.rawContent, { caseData, authorizedAssetIds });
      const renderAssets = mergeRenderAssets(assets, runtimeAssets.generated);
      const caseDataForScore =
        generatedIds.length > 0 ? { ...caseData, assetIds: [...caseData.assetIds, ...generatedIds] } : caseData;

      const rendered = await renderCase({ callRender, caseData, sourceBuffer, assets: renderAssets, plan });
      const score = scorePlan(caseDataForScore, plan, {
        sourcePng,
        actualPng: rendered.buffer,
        renderInfo: rendered,
      });

      const privateRecord = {
        caseId: caseData.id,
        binding: {
          datasetInputHash: resolved.datasetInputHash,
          caseInputHash: computeCaseInputHash(caseData),
          model: config.model,
          promptVersion,
          provider:config.baseUrl, runtimeVersion:BENCHMARK_RUNTIME_VERSION, offlineProvider:usingSeam, offlineRenderer:!!renderPlan,
        },
        im: caseData.im,
        surface: caseData.surface,
        width: caseData.source.width,
        height: caseData.source.height,
        difficulty: caseData.difficulty,
        task: caseData.task,
        sourceAnalysis: caseData.analysis,
        expected: caseData.expected,
        plan,
        warnings: [...warnings, ...(plan.warnings ?? [])],
        rawAnswer: generated.rawContent,
        toolTrace:generated.trace || [],
        generatedAssetIds: generatedIds,
        assetProvenance: runtimeAssets.provenance,
        pngSha256:sha256Hex(rendered.buffer),
        providerModel: model,
        usage,
        renderInfo: { textFits: rendered.textFits, patches: rendered.patches },
        score,
        status: score.passed ? 'pass' : 'fail',
        passed: score.passed,
        errorCode: null,
        durationMs: Date.now() - caseStarted,
        finishedAt: nowIso(),
      };
      await fs.promises.writeFile(path.join(outRoot, 'private', `${caseData.id}.png`), rendered.buffer,{mode:0o600});
      await atomicWriteJson(path.join(outRoot, 'private', `${caseData.id}.json`), privateRecord);
      results.push({
        caseId: caseData.id,
        difficulty: caseData.difficulty,
        im: caseData.im,
        surface: caseData.surface,
        status: privateRecord.status,
        passed: privateRecord.passed,
        score: score.score,
        errorCode: null,
        durationMs: privateRecord.durationMs,
        usage,
        checks: score.checks,
      });
    } catch (err) {
      const errorCode = safeErrorCode(err);
      let partialRecord = null;
      if (err && err.partial && err.partial.plan && sourceBuffer) {
        partialRecord = await renderPartialRecord({
          callRender,
          caseData,
          sourceBuffer,
          inputAssets: assets,
          partial: err.partial,
          outRoot,
        });
      }
      const privateRecord = {
        caseId: caseData.id,
        binding: {
          datasetInputHash: resolved.datasetInputHash,
          caseInputHash: computeCaseInputHash(caseData),
          model: config.model,
          promptVersion,
          provider:config.baseUrl, runtimeVersion:BENCHMARK_RUNTIME_VERSION, offlineProvider:usingSeam, offlineRenderer:!!renderPlan,
        },
        im: caseData.im,
        surface: caseData.surface,
        width: caseData.source.width,
        height: caseData.source.height,
        difficulty: caseData.difficulty,
        task: caseData.task,
        sourceAnalysis: caseData.analysis,
        errorCode,
        errorMessage: toErrorMessage(err),
        toolTrace:err.trace || [],
        ...(partialRecord
          ? {
              partial: true,
              plan: partialRecord.plan,
              partialRender: partialRecord.rendered,
              partialPngSha256: partialRecord.pngSha256 ?? null,
              generatedAssetIds: partialRecord.generatedIds,
              assetProvenance: partialRecord.provenance,
            }
          : {}),
        status: 'error',
        passed: false,
        durationMs: Date.now() - caseStarted,
        finishedAt: nowIso(),
      };
      await atomicWriteJson(path.join(outRoot, 'private', `${caseData.id}.json`), privateRecord).catch(() => {});
      results.push({
        caseId: caseData.id,
        difficulty: caseData.difficulty,
        im: caseData.im,
        surface: caseData.surface,
        status: 'error',
        passed: false,
        score: null,
        errorCode,
        durationMs: privateRecord.durationMs,
        usage: null,
        checks: [],
      });
    }
  }

  const casesPassed = results.filter((entry) => entry.status === 'pass').length;
  const casesFailed = results.length - casesPassed;
  const byIM = {};
  const byDifficulty = {};
  for (const entry of results) {
    byIM[entry.im] = byIM[entry.im] ?? { attempted: 0, passed: 0 };
    byIM[entry.im].attempted += 1;
    if (entry.status === 'pass') byIM[entry.im].passed += 1;
    const key = String(entry.difficulty);
    byDifficulty[key] = byDifficulty[key] ?? { attempted: 0, passed: 0 };
    byDifficulty[key].attempted += 1;
    if (entry.status === 'pass') byDifficulty[key].passed += 1;
  }
  const errorCodes = {};
  for (const entry of results) {
    if (!entry.errorCode) continue;
    errorCodes[entry.errorCode] = (errorCodes[entry.errorCode] ?? 0) + 1;
  }

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runtimeVersion: BENCHMARK_RUNTIME_VERSION,
    kind: REPORT_KIND,
    generatedAt: nowIso(),
    startedAt,
    dataset: { id: resolved.manifest.id, version: resolved.manifest.version, inputHash: resolved.datasetInputHash },
    model: config.model,
    promptVersion,
    subset,
    limit: effectiveLimit,
    offlineProvider: usingSeam,
    counts: {
      casesTotal: resolved.cases.length,
      casesAttempted: results.length,
      casesPassed,
      casesFailed,
      providerCalls,
      resumeReused,
      expectedRendered,
    },
    byIM,
    byDifficulty,
    errorCodes,
    humanReviewRequired: true,
    ok: !subset && results.length === resolved.cases.length && casesFailed === 0,
    notice:
      '自动分数只覆盖尺寸/语义/几何/像素保持；不构成审美或真实 IM 一致性的完整通过，需人工复核。',
    cases: results.map(publicCaseEntry),
  };

  await atomicWriteJson(path.join(outRoot, 'report.json'), report);
  await fs.promises.writeFile(path.join(outRoot, 'report.md'), renderReportMarkdown(report));
  return { ...report, outDir: outRoot };
}

/**
 * Write a sanitized failure report for dataset-level errors (no paths, no task).
 */
export async function writeFailureReport({ outDir, errorCode }) {
  if (typeof outDir !== 'string' || outDir.length === 0) return null;
  const outRoot = path.resolve(outDir);
  await ensureOutDirs(outRoot, {});
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: REPORT_KIND,
    generatedAt: nowIso(),
    dataset: null,
    model: null,
    promptVersion: BENCHMARK_PROMPT_VERSION,
    subset: false,
    offlineProvider: false,
    counts: { casesTotal: 0, casesAttempted: 0, casesPassed: 0, casesFailed: 0, providerCalls: 0, resumeReused: 0 },
    byIM: {},
    byDifficulty: {},
    errorCodes: { [errorCode]: 1 },
    humanReviewRequired: true,
    ok: false,
    notice: '数据集级错误，未执行任何用例。',
    cases: [],
  };
  await atomicWriteJson(path.join(outRoot, 'report.json'), report);
  await fs.promises.writeFile(path.join(outRoot, 'report.md'), renderReportMarkdown(report));
  return { ...report, outDir: outRoot, errorCode };
}

export default runDataset;

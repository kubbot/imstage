import fs from 'node:fs';
import path from 'node:path';
import {
  APP_VERSION,
  DEFAULT_MAX_DIFF_RATIO,
  HOST,
  INPUT_LANGUAGES,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_CANDIDATE_BYTES,
  MAX_DIFF_RATIO_LIMIT,
  MAX_GENERATION_IMAGES,
  MAX_GENERATION_IMAGE_BYTES,
  MAX_JSON_BODY_BYTES,
  MAX_CASES,
  MAX_PIXELS,
  OUTPUT_KINDS,
  PNG_MATCH_THRESHOLD,
  PREVIEWABLE_AUDIO_MIME,
  PREVIEWABLE_IMAGE_MIME,
  PREVIEWABLE_VIDEO_MIME,
  RUBRIC_VERSION,
  SURFACES,
  TARGET_IMS,
  VERDICTS,
  SCORE_FIELDS,
  SCORE_VALUES,
  SURFACE_DIMENSIONS,
} from './constants.mjs';
import {
  AppError,
  fail,
  isSafeId,
  newId,
  nowIso,
  parseBase64,
  ratioValue,
  toErrorMessage,
} from './util.mjs';
import { CorruptStoreError } from './store.mjs';
import { decodePng } from './png.mjs';
import {
  assertPixelBudget,
  buildGoldenRecord,
  buildReviewRecord,
  normalizeAttachmentInput,
  validateCaseInput,
  validateReviewInput,
} from './validate.mjs';
import { candidateIsCurrent, computeInputFingerprint, goldenIsCurrent, isExportableGolden, reviewIsCurrent } from './fingerprint.mjs';
import { exportBundle, importBundle } from './bundle.mjs';
import { buildStarterCases } from './fixtures.mjs';
import {
  AI_PROMPT_VERSION,
  callDeepSeekScene,
  detectLanguage,
  normalizeGenerationInput,
  parseSceneResponse,
  publicGenerationStatus,
  resolveAiConfig,
  scenePlainText,
} from './generation.mjs';
import { renderScenePng } from './render.mjs';
import { createDatasetApi } from './dataset-api.mjs';
import { GenerationLedger } from './generation-ledger.mjs';
import { RENDERER_VERSION } from '../../../packages/renderer/renderSceneHtml.mjs';

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendError(res, err) {
  if (res.writableEnded || res.destroyed) {
    res.destroy();
    return;
  }
  const status = err instanceof AppError ? err.status : err instanceof CorruptStoreError ? 500 : 500;
  const code = err.code ?? 'internal_error';
  const message = toErrorMessage(err);
  sendJson(res, status, {
    error: message,
    code,
    ...(err.details ? { details: err.details } : {}),
    ...(err instanceof CorruptStoreError ? { corrupt: true, filePath: err.filePath } : {}),
  });
}

async function readBody(req, limit = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      fail('body_too_large', `请求体超过 ${limit} 字节上限`, 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req, limit = MAX_JSON_BODY_BYTES) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    fail('unsupported_media_type', 'JSON 变更请求必须使用 Content-Type: application/json', 415);
  }
  const raw = await readBody(req, limit);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail('invalid_body', '请求体必须是 JSON 对象', 400);
    }
    return parsed;
  } catch (err) {
    if (err instanceof AppError) throw err;
    fail('malformed_json', `请求体 JSON 解析失败: ${err.message}`, 400);
  }
}

function checkHost(req, { host, getPort }) {
  const headerHost = req.headers.host;
  if (!headerHost) fail('invalid_host', '缺少 Host 头', 403);
  let parsed;
  try {
    parsed = new URL(`http://${headerHost}`);
  } catch {
    fail('invalid_host', `Host 头不合法: ${headerHost}`, 403);
  }
  const hostname = parsed.hostname;
  const port = parsed.port || '80';
  const expectedPort = String(getPort() ?? '');
  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    fail('invalid_host', `只允许本机 Host，收到: ${hostname}`, 403);
  }
  if (expectedPort && port !== expectedPort) {
    fail('invalid_host', `Host 端口不匹配，期望 ${expectedPort}，收到 ${port}`, 403);
  }
}

function checkSameOrigin(req, { host, getPort }) {
  const expectedPort = String(getPort() ?? '');
  const allowedHosts = new Set([host, '127.0.0.1', 'localhost', '[::1]', '::1']);
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    fail('cross_site', `拒绝跨站请求 (Sec-Fetch-Site: ${site})`, 403);
  }
  const origin = req.headers.origin;
  if (!origin) {
    fail('missing_origin', '变更请求必须携带同源 Origin 头', 403);
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    fail('invalid_origin', `Origin 头不合法: ${origin}`, 403);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('invalid_origin', `Origin 协议不合法: ${parsed.protocol}`, 403);
  }
  if (parsed.protocol !== 'http:') {
    fail('invalid_origin', '本机服务仅接受 http Origin', 403);
  }
  if (!allowedHosts.has(parsed.hostname) && !ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    fail('invalid_origin', `Origin 主机不合法: ${parsed.hostname}`, 403);
  }
  if (expectedPort && (parsed.port || '80') !== expectedPort) {
    fail('invalid_origin', `Origin 端口不匹配: ${parsed.port || '80'}`, 403);
  }
  return parsed;
}

function assertRevision(draft, body) {
  const expected = body?.revision;
  if (expected === undefined || expected === null) {
    fail('missing_revision', '变更请求必须携带 revision（乐观并发控制）', 428);
  }
  if (!Number.isInteger(expected)) {
    fail('invalid_revision', 'revision 必须是整数', 422);
  }
  if (expected !== draft.revision) {
    const err = new AppError('revision_conflict', `revision 冲突：期望 ${expected}，当前 ${draft.revision}`, 409);
    err.details = { expected, actual: draft.revision };
    throw err;
  }
}

function findCaseIndex(draft, id) {
  if (!isSafeId(id)) fail('unsafe_id', 'case id 不合法', 422);
  const index = draft.cases.findIndex((c) => c.id === id);
  if (index < 0) fail('not_found', `找不到用例: ${id}`, 404);
  return index;
}

function decorateCase(caseData) {
  const inputFingerprint = computeInputFingerprint(caseData);
  return {
    ...caseData,
    computed: {
      inputFingerprint,
      candidateCurrent: candidateIsCurrent(caseData),
      reviewCurrent: reviewIsCurrent(caseData),
      goldenCurrent: goldenIsCurrent(caseData),
      exportable: isExportableGolden(caseData),
    },
  };
}

function revokeForCaseChange(caseData, { inputChanged, toleranceChanged, visibilityChanged }) {
  if (inputChanged) {
    caseData.review = null;
    caseData.golden = null;
  } else if (toleranceChanged || visibilityChanged) {
    caseData.golden = null;
  }
  return caseData;
}

function buildCaseRecord(validated, timestamp) {
  return {
    id: validated.id ?? newId('c'),
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    question: validated.question,
    inputLanguage: validated.inputLanguage,
    targetIM: validated.targetIM,
    surface: validated.surface,
    outputKind: validated.outputKind,
    width: validated.width,
    height: validated.height,
    notes: validated.notes ?? '',
    maxDiffRatio: validated.maxDiffRatio ?? DEFAULT_MAX_DIFF_RATIO,
    synthetic: validated.synthetic === true,
    attachments: validated.attachments ?? [],
    candidate: null,
    review: null,
    golden: null,
  };
}

function previewMode(mime) {
  if (PREVIEWABLE_IMAGE_MIME.has(mime)) return 'image';
  if (PREVIEWABLE_VIDEO_MIME.has(mime)) return 'video';
  if (PREVIEWABLE_AUDIO_MIME.has(mime)) return 'audio';
  return 'none';
}

function sendStatic(res, publicDir, relPath) {
  const base = path.resolve(publicDir);
  const target = path.resolve(base, relPath);
  if (!target.startsWith(`${base}${path.sep}`) && target !== base) {
    fail('unsafe_path', '静态资源路径不合法', 403);
  }
  return fs.promises.readFile(target).then((buffer) => {
    const ext = path.extname(target).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8',
    };
    res.writeHead(200, {
      'Content-Type': types[ext] ?? 'application/octet-stream',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    res.end(buffer);
  });
}

async function serveBlob(res, store, sha256, { mime, filename, inline }) {
  const buffer = await store.getBlob(sha256);
  if (!buffer) fail('not_found', '二进制内容不存在或已被删除', 404);
  const safeName = String(filename ?? 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
  });
  res.end(buffer);
}

export function createApp({
  store,
  publicDir,
  host = HOST,
  getPort,
  aiConfig,
  generateScene,
  renderScene,
} = {}) {
  const handleDataset = createDatasetApi({dataDir: store.dataDir, sendJson, readJsonBody});
  // One concurrent generation at a time; requestId is also idempotent.
  const generationState = { active: false, inFlight: new Set() };
  const generationLedger = new GenerationLedger({ dataDir: store.dataDir });
  const callGenerate = generateScene ?? callDeepSeekScene;
  const callRender = renderScene ?? renderScenePng;

  function currentAiConfig() {
    return aiConfig ?? resolveAiConfig();
  }

  async function handleGeneration(req, res, body) {
    const requestId = body?.requestId;
    if (typeof requestId !== 'string' || !isSafeId(requestId)) {
      fail('invalid_request_id', 'requestId 必须是 1-80 位安全字符串（字母、数字、下划线、连字符）', 422);
    }
    const expectedRevision = body?.revision;
    if (!Number.isInteger(expectedRevision)) {
      fail('invalid_revision', 'revision 必须是整数', 422);
    }
    // All image bytes/dimensions/count/total are validated here, before any
    // provider network call can be made.
    const request = normalizeGenerationInput(body?.input);

    await store.load();

    // A duplicate in this process is an in-flight conflict, not an unknown
    // durable outcome; check it before consulting the ledger.
    if (generationState.inFlight.has(requestId)) {
      fail('request_in_progress', '相同 requestId 的生成正在进行中', 409);
    }

    // Recover the commit -> ledger-complete crash window, including cases
    // generated before the recovery ledger existed. Never replay a saved case.
    const existing = store.listCases().find((c) => c.generation?.requestId === requestId);
    if (existing) {
      if (existing.generation.inputHash !== request.inputHash) fail('request_id_conflict', 'requestId 已用于不同的输入，请使用新的 requestId', 409);
      // Complete recovery before returning, so deleting this case cannot later
      // resurrect it from a model_ready entry after a commit-window crash.
      const recovery = await generationLedger.read(requestId);
      if (recovery?.status !== 'completed' || recovery.caseId !== existing.id) {
        await generationLedger.begin(requestId, request.inputHash);
        await generationLedger.complete(requestId, request.inputHash, existing.id);
      }
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(existing), warnings: existing.generation.warnings || [] });
    }
    const config = currentAiConfig();
    // Durable ledger: exact-once provider calls are impossible across crashes,
    // so a begun but unconfirmed attempt is refused instead of re-paid.
    const entry = await generationLedger.read(requestId);
    if (entry && entry.inputHash !== request.inputHash) {
      fail('request_id_conflict', 'requestId 已用于不同的输入，请使用新的 requestId', 409);
    }
    if (entry?.status === 'completed') {
      const committed = store.getCase(entry.caseId);
      if (!committed) {
        fail('generation_not_found', '该 requestId 的生成结果已被删除，请使用新的 requestId 重新生成', 404);
      }
      return sendJson(res, 200, {
        revision: store.revision,
        case: decorateCase(committed),
        warnings: Array.isArray(committed.generation?.warnings) ? committed.generation.warnings : [],
      });
    }
    if (entry?.status === 'started') {
      fail(
        'generation_outcome_unknown',
        '上一次生成已开始但未确认结果，为避免重复付费不会自动重试；请使用新的 requestId 重新生成',
        409,
      );
    }
    // A brand-new attempt must have usable provider configuration before we
    // mark the attempt in the ledger (injected generators are always usable).
    if (!entry && !generateScene && config.configured !== true) {
      fail('ai_not_configured', '未配置 AI（需要 IMSTAGE_AI_API_KEY 或 DEEPSEEK_API_KEY）', 503);
    }
    // Pre-generation revision check: never pay for a stale request. A cached
    // model_ready retry still requires the caller's current revision.
    if (expectedRevision !== store.revision) {
      const err = new AppError(
        'revision_conflict',
        `revision 冲突：期望 ${expectedRevision}，当前 ${store.revision}`,
        409,
      );
      err.details = { expected: expectedRevision, actual: store.revision };
      throw err;
    }
    if (generationState.inFlight.has(requestId)) {
      fail('request_in_progress', '相同 requestId 的生成正在进行中', 409);
    }
    if (generationState.active) {
      fail('generation_busy', '已有生成任务在进行中，请稍后重试', 409);
    }

    if (store.listCases().length >= MAX_CASES) fail('too_many_cases', '用例数量超过上限，请先整理已有记录', 422);
    generationState.active = true;
    generationState.inFlight.add(requestId);
    const controller = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded) controller.abort(new Error('client_disconnect'));
    };
    res.on('close', onClientClose);

    try {
      let rawContent;
      let model;
      if (entry?.status === 'model_ready') {
        // Reuse the cached provider result: no second paid model call.
        rawContent = entry.rawContent;
        model = entry.model || config.model;
      } else {
        // Persist attempt-start BEFORE the provider call so an interrupted run
        // is never silently re-paid.
        await generationLedger.begin(requestId, request.inputHash);
        const generated = await callGenerate({ config, request, signal: controller.signal });
        rawContent = generated?.rawContent;
        model = generated?.model ?? config.model;
        if (typeof rawContent !== 'string' || rawContent.length === 0) {
          fail('ai_empty_response', 'AI 未返回可用内容', 502);
        }
        // Cache the provider result BEFORE rendering/commit so a renderer or
        // revision failure can be retried without another model call.
        await generationLedger.recordModel(requestId, request.inputHash, { rawContent, model });
      }
      if (controller.signal.aborted) fail('request_aborted', '请求已取消', 499);
      const { scene, warnings } = parseSceneResponse(rawContent, {
        assetCount: request.images.length,
        expectedPlatform: request.targetIM,
      });
      if (controller.signal.aborted) fail('request_aborted', '请求已取消', 499);

      const dims = SURFACE_DIMENSIONS[request.surface] ?? SURFACE_DIMENSIONS.ios;
      const assets = request.images.map((img) => ({ mime: img.mime, dataBase64: img.dataBase64 }));
      const rendered = await callRender(scene, {
        surface: request.surface,
        width: dims.width,
        height: dims.height,
        outputKind: request.outputKind,
        assets,
        signal: controller.signal,
      });
      if (controller.signal.aborted) fail('request_aborted', '请求已取消', 499);

      // Validate the rendered PNG truthfully before persisting anything.
      const buffer = rendered?.buffer;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        fail('render_failed', '渲染器未返回 PNG 数据', 502);
      }
      // Fully decode the rendered PNG (CRC/IDAT/IEND) before persisting it.
      let header;
      try {
        header = decodePng(buffer);
      } catch (err) {
        fail('render_invalid_png', `渲染输出不是完整合法 PNG: ${err.message}`, 502);
      }
      if (header.width !== dims.width) {
        fail('render_dimension_mismatch', `渲染宽度 ${header.width} 与期望 ${dims.width} 不一致`, 502);
      }
      if (request.outputKind === 'screenshot' && header.height !== dims.height) {
        fail('render_dimension_mismatch', `普通截图高度 ${header.height} 与期望 ${dims.height} 不一致`, 502);
      }
      if (header.width * header.height > MAX_PIXELS) {
        fail('output_too_large', `输出 PNG 像素超过 ${MAX_PIXELS} 上限`, 422);
      }

      for (const image of request.images) await store.putBlob(image.buffer);
      await store.putBlob(buffer);
      // Cancellation is honoured before the serialized commit; a commit that
      // already reached disk cannot be rolled back (documented limitation).
      if (controller.signal.aborted) fail('request_aborted', '请求已取消', 499);

      const timestamp = nowIso();
      const language = detectLanguage(request.text || scenePlainText(scene));
      const notesBase = `AI 生成 (${model})`;
      const notes = (warnings.length ? `${notesBase}：${warnings.join(' | ')}` : notesBase).slice(0, 4000);
      const created = await store.mutate((draft) => {
        if (controller.signal.aborted) fail('request_aborted', '请求已取消', 499);
        // Serialized post-generation revision check: never overwrite concurrent edits.
        assertRevision(draft, { revision: expectedRevision });
        if (draft.cases.length >= MAX_CASES) fail('too_many_cases', '用例数量超过上限', 422);
        if (draft.cases.some((c) => c?.generation?.requestId === requestId)) {
          fail('request_id_conflict', 'requestId 已存在', 409);
        }
        const caseData = {
          id: newId('c'),
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
          question: request.text || '[图片输入] 复现截图中的对话',
          inputLanguage: language,
          targetIM: request.targetIM,
          surface: request.surface,
          outputKind: request.outputKind,
          width: header.width,
          height: header.height,
          notes,
          maxDiffRatio: DEFAULT_MAX_DIFF_RATIO,
          synthetic: request.synthetic === true,
          attachments: request.images.map((image) => ({
            id: newId('att'),
            name: image.name,
            kind: 'image',
            mime: image.mime,
            size: image.size,
            sha256: image.sha256,
            addedAt: timestamp,
            synthetic: request.synthetic === true,
          })),
          candidate: {
            id: newId('cand'),
            name: `${requestId}.png`,
            mime: 'image/png',
            size: buffer.length,
            sha256: sha256OfBuffer(buffer),
            width: header.width,
            height: header.height,
            uploadedAt: timestamp,
            inputFingerprint: null,
            synthetic: request.synthetic === true,
            provenance: {
              kind: 'ai-generated',
              model,
              promptVersion: AI_PROMPT_VERSION,
              rendererVersion: RENDERER_VERSION,
              generatedAt: timestamp,
            },
          },
          review: null,
          golden: null,
          generation: {
            requestId,
            inputHash: request.inputHash,
            input: {
              text: request.text,
              targetIM: request.targetIM,
              surface: request.surface,
              outputKind: request.outputKind,
              synthetic: request.synthetic === true,
            },
            model,
            language,
            promptVersion: AI_PROMPT_VERSION,
            rendererVersion: RENDERER_VERSION,
            imageCount: request.images.length,
            scene,
            warnings,
            createdAt: timestamp,
          },
        };
        caseData.candidate.inputFingerprint = computeInputFingerprint(caseData);
        draft.cases.push(caseData);
        return caseData;
      });

      await generationLedger.complete(requestId, request.inputHash, created.id);
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(created), warnings });
    } finally {
      res.off?.('close', onClientClose);
      generationState.inFlight.delete(requestId);
      generationState.active = false;
    }
  }

  async function routeApi(req, res, url) {
    const method = req.method.toUpperCase();
    const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const rest = segments.slice(1);

    if (method === 'GET' && rest.length === 1 && rest[0] === 'health') {
      let storeOk = true;
      let storeError = null;
      try {
        await store.load();
      } catch (err) {
        storeOk = false;
        storeError = toErrorMessage(err);
      }
      return sendJson(res, storeOk ? 200 : 503, {
        ok: storeOk,
        name: 'imstage-eval',
        version: APP_VERSION,
        revision: store.revision,
        store: { ok: storeOk, error: storeError },
      });
    }

    if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
      return sendJson(res, 200, {
        version: APP_VERSION,
        rubricVersion: RUBRIC_VERSION,
        threshold: PNG_MATCH_THRESHOLD,
        defaultMaxDiffRatio: DEFAULT_MAX_DIFF_RATIO,
        maxDiffRatioLimit: MAX_DIFF_RATIO_LIMIT,
        maxAttachments: MAX_ATTACHMENTS,
        maxAttachmentBytes: MAX_ATTACHMENT_BYTES,
        maxCandidateBytes: MAX_CANDIDATE_BYTES,
        maxPixels: MAX_PIXELS,
        maxGenerationImages: MAX_GENERATION_IMAGES,
        maxGenerationImageBytes: MAX_GENERATION_IMAGE_BYTES,
        surfaceDimensions: SURFACE_DIMENSIONS,
        generationDefaults: { targetIM: 'wechat', surface: 'ios', outputKind: 'screenshot' },
        targetIMs: TARGET_IMS,
        surfaces: SURFACES,
        inputLanguages: INPUT_LANGUAGES,
        outputKinds: OUTPUT_KINDS,
        scoreFields: SCORE_FIELDS,
        scoreValues: SCORE_VALUES,
        verdicts: VERDICTS,
        rubric: {
          content: { 0: '内容错误或缺失', 1: '部分正确但有明显问题', 2: '内容正确' },
          imFidelity: { 0: '平台风格明显不符', 1: '部分相似', 2: '基本符合目标 IM 风格' },
          layout: { 0: '布局错乱', 1: '布局基本可用但有偏差', 2: '布局正确' },
          completeness: { 0: '缺失大量要求', 1: '部分完整', 2: '完整' },
        },
        previewModes: { image: [...PREVIEWABLE_IMAGE_MIME], video: [...PREVIEWABLE_VIDEO_MIME], audio: [...PREVIEWABLE_AUDIO_MIME] },
      });
    }

    if (method === 'GET' && rest.length === 1 && rest[0] === 'store') {
      await store.load();
      return sendJson(res, 200, {
        schemaVersion: store.state.schemaVersion,
        revision: store.state.revision,
        updatedAt: store.state.updatedAt,
        cases: store.listCases().map(decorateCase),
      });
    }

    if (method === 'GET' && rest.length === 1 && rest[0] === 'generation') {
      return sendJson(res, 200, publicGenerationStatus(currentAiConfig()));
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'generate') {
      const body = await readJsonBody(req);
      return handleGeneration(req, res, body);
    }

    if (method === 'GET' && rest.length === 1 && rest[0] === 'starter') {
      const starters = buildStarterCases().map(({ case: c, note }) => ({
        id: c.id,
        question: c.question,
        inputLanguage: c.inputLanguage,
        targetIM: c.targetIM,
        surface: c.surface,
        outputKind: c.outputKind,
        width: c.width,
        height: c.height,
        note,
      }));
      return sendJson(res, 200, { starters });
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'starter') {
      const body = await readJsonBody(req);
      const starters = buildStarterCases();
      for (const s of starters) await store.putBlob(s.candidateBuffer);
      const ids = await store.mutate((draft) => {
        assertRevision(draft, body);
        if (draft.cases.length + starters.length > MAX_CASES) {
          fail('too_many_cases', `加载后将超过 ${MAX_CASES} 条用例上限`, 422);
        }
        const created = [];
        for (const s of starters) {
          const timestamp = nowIso();
          const id = newId('c');
          const caseData = {
            ...s.case,
            id,
            revision: 1,
            createdAt: timestamp,
            updatedAt: timestamp,
            candidate: {
              ...s.case.candidate,
              id: newId('cand'),
              name: `${id}.png`,
              uploadedAt: timestamp,
            },
          };
          caseData.candidate.inputFingerprint = computeInputFingerprint(caseData);
          draft.cases.push(caseData);
          created.push(id);
        }
        return created;
      });
      return sendJson(res, 200, { revision: store.revision, imported: ids });
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'cases') {
      const body = await readJsonBody(req);
      const validated = validateCaseInput(body.case ?? body, { partial: false });
      const attachments = Array.isArray(body.case?.attachments) ? body.case.attachments : Array.isArray(body.attachments) ? body.attachments : [];
      if (attachments.length > MAX_ATTACHMENTS) {
        fail('too_many_attachments', `附件数量超过 ${MAX_ATTACHMENTS}`, 422);
      }
      const normalized = [];
      for (const att of attachments) {
        const parsed = normalizeAttachmentInput(att);
        normalized.push(parsed);
      }
      for (const att of normalized) await store.putBlob(att.buffer);
      const created = await store.mutate((draft) => {
        assertRevision(draft, body);
        if (draft.cases.length >= MAX_CASES) fail('too_many_cases', '用例数量超过上限', 422);
        const timestamp = nowIso();
        const caseData = buildCaseRecord(validated, timestamp);
        caseData.attachments = normalized.map((att) => ({
          id: newId('att'),
          name: att.name,
          kind: att.kind,
          mime: att.mime,
          size: att.buffer.length,
          sha256: sha256OfBuffer(att.buffer),
          addedAt: timestamp,
          synthetic: caseData.synthetic,
        }));
        draft.cases.push(caseData);
        return caseData;
      });
      return sendJson(res, 201, { revision: store.revision, case: decorateCase(created) });
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'export') {
      const body = await readJsonBody(req);
      const scope = body.scope === 'synthetic' ? 'synthetic' : 'private';
      const caseIds = Array.isArray(body.caseIds) ? body.caseIds : null;
      await store.load();
      const bundle = await exportBundle({ store, scope, caseIds });
      return sendJson(res, 200, bundle);
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'import') {
      const body = await readJsonBody(req);
      const ids = await importBundle({
        rawBundle: body.bundle,
        store,
        expectedRevision: body.revision,
      });
      return sendJson(res, 200, { revision: store.revision, imported: ids });
    }

    return routeCaseRoutes(req, res, rest, method);
  }

  async function routeCaseRoutes(req, res, rest, method) {
    // /api/cases/:id[/sub[/subId]]
    if (rest[0] !== 'cases') return false;
    const caseId = rest[1];
    if (!caseId) fail('not_found', '缺少 case id', 404);
    const sub = rest[2];
    const subId = rest[3];

    if (method === 'GET' && rest.length === 2) {
      await store.load();
      const caseData = store.getCase(caseId);
      if (!caseData) fail('not_found', `找不到用例: ${caseId}`, 404);
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(caseData) });
    }

    if (method === 'PUT' && rest.length === 2) {
      const body = await readJsonBody(req);
      const patch = validateCaseInput(body.case ?? body, { partial: true });
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const before = draft.cases[index];
        const beforeFp = computeInputFingerprint(before);
        const merged = { ...before, ...patch, updatedAt: nowIso(), revision: (before.revision ?? 1) + 1 };
        assertPixelBudget(merged.width, merged.height);
        const afterFp = computeInputFingerprint(merged);
        revokeForCaseChange(merged, {
          inputChanged: beforeFp !== afterFp,
          toleranceChanged: before.maxDiffRatio !== merged.maxDiffRatio,
          visibilityChanged: before.synthetic !== merged.synthetic,
        });
        draft.cases[index] = merged;
        return merged;
      });
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(updated) });
    }

    if (method === 'DELETE' && rest.length === 2) {
      const body = await readJsonBody(req);
      const removed = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const [caseData] = draft.cases.splice(index, 1);
        return caseData;
      });
      return sendJson(res, 200, { revision: store.revision, deleted: removed.id });
    }

    if (method === 'POST' && sub === 'attachments' && rest.length === 3) {
      const body = await readJsonBody(req);
      const parsed = normalizeAttachmentInput(body);
      await store.putBlob(parsed.buffer);
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const caseData = draft.cases[index];
        if ((caseData.attachments?.length ?? 0) >= MAX_ATTACHMENTS) {
          fail('too_many_attachments', `附件数量超过 ${MAX_ATTACHMENTS}`, 422);
        }
        const beforeFp = computeInputFingerprint(caseData);
        caseData.attachments = [
          ...(caseData.attachments ?? []),
          {
            id: newId('att'),
            name: parsed.name,
            kind: parsed.kind,
            mime: parsed.mime,
            size: parsed.buffer.length,
            sha256: sha256OfBuffer(parsed.buffer),
            addedAt: nowIso(),
            synthetic: caseData.synthetic === true,
          },
        ];
        caseData.updatedAt = nowIso();
        caseData.revision = (caseData.revision ?? 1) + 1;
        revokeForCaseChange(caseData, { inputChanged: beforeFp !== computeInputFingerprint(caseData) });
        return caseData;
      });
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(updated) });
    }

    if (method === 'DELETE' && sub === 'attachments' && subId) {
      const body = await readJsonBody(req);
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const caseData = draft.cases[index];
        const attIndex = (caseData.attachments ?? []).findIndex((a) => a.id === subId);
        if (attIndex < 0) fail('not_found', `找不到附件: ${subId}`, 404);
        const beforeFp = computeInputFingerprint(caseData);
        caseData.attachments.splice(attIndex, 1);
        caseData.updatedAt = nowIso();
        caseData.revision = (caseData.revision ?? 1) + 1;
        revokeForCaseChange(caseData, { inputChanged: beforeFp !== computeInputFingerprint(caseData) });
        return caseData;
      });
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(updated) });
    }

    if (method === 'POST' && sub === 'candidate' && rest.length === 3) {
      const body = await readJsonBody(req);
      const mime = String(body.mime ?? 'image/png').toLowerCase();
      if (mime !== 'image/png') fail('unsafe_mime', '候选输出必须是 image/png', 422);
      const buffer = parseBase64(body.dataBase64, '候选 PNG');
      if (buffer.length > MAX_CANDIDATE_BYTES) {
        fail('file_too_large', `候选 PNG 超过 ${MAX_CANDIDATE_BYTES} 字节上限`, 422);
      }
      let decoded;
      try {
        decoded = decodePng(buffer);
      } catch (err) {
        fail('invalid_png', `候选 PNG 校验失败: ${err.message}`, 422);
      }
      await store.putBlob(buffer);
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const caseData = draft.cases[index];
        caseData.candidate = {
          id: newId('cand'),
          name: String(body.name ?? `${caseId}.png`).slice(0, 200),
          mime: 'image/png',
          size: buffer.length,
          sha256: sha256OfBuffer(buffer),
          width: decoded.width,
          height: decoded.height,
          uploadedAt: nowIso(),
          inputFingerprint: computeInputFingerprint(caseData),
          synthetic: body.synthetic === true || caseData.synthetic === true,
        };
        const dimsMismatch =
          decoded.width !== caseData.width || decoded.height !== caseData.height;
        caseData.review = null;
        caseData.golden = null;
        caseData.updatedAt = nowIso();
        caseData.revision = (caseData.revision ?? 1) + 1;
        return { caseData, dimsMismatch };
      });
      return sendJson(res, 200, {
        revision: store.revision,
        case: decorateCase(updated.caseData),
        dimensionsMatchCase: !updated.dimsMismatch,
      });
    }

    if (method === 'DELETE' && sub === 'candidate' && rest.length === 3) {
      const body = await readJsonBody(req);
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const caseData = draft.cases[index];
        caseData.candidate = null;
        caseData.review = null;
        caseData.golden = null;
        caseData.updatedAt = nowIso();
        caseData.revision = (caseData.revision ?? 1) + 1;
        return caseData;
      });
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(updated) });
    }

    if (method === 'PUT' && sub === 'review' && rest.length === 3) {
      const body = await readJsonBody(req);
      const review = validateReviewInput(body.review ?? body);
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const caseData = draft.cases[index];
        const record = buildReviewRecord(caseData, review, nowIso());
        const previousGolden = caseData.golden;
        caseData.review = record;
        if (
          previousGolden &&
          (record.verdict !== 'good' || previousGolden.reviewFingerprint !== record.fingerprint)
        ) {
          caseData.golden = null;
        }
        caseData.updatedAt = nowIso();
        caseData.revision = (caseData.revision ?? 1) + 1;
        return caseData;
      });
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(updated) });
    }

    if (method === 'DELETE' && sub === 'review' && rest.length === 3) {
      const body = await readJsonBody(req);
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const caseData = draft.cases[index];
        caseData.review = null;
        caseData.golden = null;
        caseData.updatedAt = nowIso();
        caseData.revision = (caseData.revision ?? 1) + 1;
        return caseData;
      });
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(updated) });
    }

    if (method === 'POST' && sub === 'golden' && rest.length === 3) {
      const body = await readJsonBody(req);
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const caseData = draft.cases[index];
        caseData.golden = buildGoldenRecord(caseData, nowIso());
        caseData.updatedAt = nowIso();
        caseData.revision = (caseData.revision ?? 1) + 1;
        return caseData;
      });
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(updated) });
    }

    if (method === 'DELETE' && sub === 'golden' && rest.length === 3) {
      const body = await readJsonBody(req);
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const caseData = draft.cases[index];
        caseData.golden = null;
        caseData.updatedAt = nowIso();
        caseData.revision = (caseData.revision ?? 1) + 1;
        return caseData;
      });
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(updated) });
    }

    if (method === 'GET' && sub === 'candidate.png' && rest.length === 3) {
      await store.load();
      const caseData = store.getCase(caseId);
      if (!caseData?.candidate) fail('not_found', '该用例没有候选 PNG', 404);
      return serveBlob(res, store, caseData.candidate.sha256, {
        mime: 'image/png',
        filename: caseData.candidate.name,
        inline: true,
      });
    }

    if (method === 'GET' && sub === 'attachments' && subId && rest[4] === 'raw') {
      await store.load();
      const caseData = store.getCase(caseId);
      if (!caseData) fail('not_found', `找不到用例: ${caseId}`, 404);
      const att = (caseData.attachments ?? []).find((a) => a.id === subId);
      if (!att) fail('not_found', `找不到附件: ${subId}`, 404);
      return serveBlob(res, store, att.sha256, {
        mime: att.mime,
        filename: att.name,
        inline: previewMode(att.mime) !== 'none',
      });
    }

    if (method === 'POST' && sub === 'maxdiff' && rest.length === 3) {
      const body = await readJsonBody(req);
      const next = ratioValue(body.maxDiffRatio, 'maxDiffRatio', DEFAULT_MAX_DIFF_RATIO);
      const updated = await store.mutate((draft) => {
        assertRevision(draft, body);
        const index = findCaseIndex(draft, caseId);
        const caseData = draft.cases[index];
        caseData.maxDiffRatio = next;
        caseData.golden = null; // tolerance participates in the golden binding
        caseData.updatedAt = nowIso();
        caseData.revision = (caseData.revision ?? 1) + 1;
        return caseData;
      });
      return sendJson(res, 200, { revision: store.revision, case: decorateCase(updated) });
    }

    return false;
  }

  async function route(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? `${host}:4421`}`);
      checkHost(req, { host, getPort });

      if (url.pathname.startsWith('/api/')) {
        const method = req.method.toUpperCase();
        if (MUTATING_METHODS.has(method)) {
          checkSameOrigin(req, { host, getPort });
        } else if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
          fail('method_not_allowed', `不支持的方法: ${method}`, 405);
        }
        if(url.pathname==='/api/device-fidelity'&&method==='GET'){sendJson(res,200,JSON.parse(fs.readFileSync(new URL('../fixtures/device-fidelity.json',import.meta.url),'utf8')));return;}
        if (await handleDataset(req, res, url)) return;
        const handled = await routeApi(req, res, url);
        if (handled === false) fail('not_found', `未知 API: ${method} ${url.pathname}`, 404);
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
        if (rel.includes('..')) fail('unsafe_path', '路径不合法', 403);
        try {
          await sendStatic(res, publicDir, rel);
        } catch (err) {
          if (err instanceof AppError) throw err;
          if (err.code === 'ENOENT') fail('not_found', `找不到资源: ${url.pathname}`, 404);
          throw err;
        }
        return;
      }
      fail('method_not_allowed', `不支持的方法: ${req.method}`, 405);
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, err);
    }
  }

  return {
    handle: route,
    // Exposed for tests that drive the API without a real socket.
    exportBundle,
    importBundle,
  };
}

// Local helper: content hash for stored blobs.
import crypto from 'node:crypto';

function sha256OfBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export { buildStarterCases };

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

export function createApp({ store, publicDir, host = HOST, getPort }) {
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

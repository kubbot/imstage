import {
  ATTACHMENT_KINDS,
  BUNDLE_SCHEMA_VERSION,
  DEFAULT_MAX_DIFF_RATIO,
  INPUT_LANGUAGES,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_CANDIDATE_BYTES,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PIXELS,
  MAX_PNG_DIMENSION,
  MAX_QUESTION_LENGTH,
  MAX_REASON_LENGTH,
  OUTPUT_KINDS,
  PNG_MATCH_THRESHOLD,
  RUBRIC_VERSION,
  SAFE_MIME,
  SCORE_FIELDS,
  SCORE_VALUES,
  SURFACES,
  TARGET_IMS,
  VERDICTS,
} from './constants.mjs';
import {
  AppError,
  clampText,
  enumValue,
  fail,
  intValue,
  isSafeId,
  isSafeSha256,
  parseBase64,
  ratioValue,
  sha256Hex,
} from './util.mjs';
import { decodePng, parsePngHeader } from './png.mjs';
import {
  computeGoldenFingerprint,
  computeInputFingerprint,
  computeReviewFingerprint,
  reviewIsCurrent,
} from './fingerprint.mjs';

export function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function validateMimeAndKind(mime, declaredKind, buffer, { maxBytes, label }) {
  const mimeKind = SAFE_MIME[mime];
  if (!mimeKind) {
    fail('unsafe_mime', `${label} 使用了不支持的 MIME 类型: ${mime}`, 422);
  }
  if (declaredKind !== undefined && declaredKind !== null && declaredKind !== '') {
    if (!ATTACHMENT_KINDS.includes(declaredKind)) {
      fail('invalid_enum', `${label} kind 只能是: ${ATTACHMENT_KINDS.join(', ')}`, 422);
    }
    if (declaredKind !== mimeKind) {
      fail('kind_mime_mismatch', `${label} kind (${declaredKind}) 与 MIME (${mime}) 不一致`, 422);
    }
  }
  if (buffer.length > maxBytes) {
    fail('file_too_large', `${label} 超过 ${maxBytes} 字节上限`, 422);
  }
  if (mimeKind === 'image') {
    const sniffed = sniffImageMime(buffer);
    if (sniffed !== mime) {
      fail('mime_sniff_mismatch', `${label} 声明为 ${mime}，但文件内容不是该格式`, 422);
    }
    if (mime === 'image/png') {
      try {
        parsePngHeader(buffer);
      } catch (err) {
        fail('invalid_png', `${label} PNG 头不合法: ${err.message}`, 422);
      }
    }
  }
  return mimeKind;
}

export function normalizeAttachmentInput(raw, { maxBytes = MAX_ATTACHMENT_BYTES } = {}) {
  if (!raw || typeof raw !== 'object') fail('invalid_attachment', '附件必须是对象', 422);
  const name = clampText(raw.name, MAX_NAME_LENGTH, '附件名称', { required: true });
  const mime = clampText(raw.mime, 200, '附件 MIME', { required: true }).toLowerCase();
  const buffer = parseBase64(raw.dataBase64, '附件内容');
  const kind = validateMimeAndKind(mime, raw.kind, buffer, {
    maxBytes,
    label: `附件 ${name}`,
  });
  return { name, mime, kind, buffer };
}

export function assertPixelBudget(width, height) {
  if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
    if (width * height > MAX_PIXELS) {
      fail('out_of_range', `width × height 不能超过 ${MAX_PIXELS} 像素`, 422);
    }
  }
}

// Partial validation keeps the distinction between "field absent" and "field
// explicitly cleared". Required fields reject an explicit blank instead of
// silently ignoring it; optional free-text like notes can be cleared with "".
export function validateCaseInput(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== 'object') fail('invalid_case', 'case 必须是对象', 422);
  const out = {};
  const present = (key) => raw[key] !== undefined && raw[key] !== null;
  const include = (key) => !partial || present(key);

  if (include('question')) {
    out.question = clampText(raw.question, MAX_QUESTION_LENGTH, 'question', { required: true });
  }
  if (include('inputLanguage')) {
    out.inputLanguage = enumValue(raw.inputLanguage, INPUT_LANGUAGES, 'inputLanguage');
  }
  if (include('targetIM')) {
    out.targetIM = enumValue(raw.targetIM, TARGET_IMS, 'targetIM');
  }
  if (include('surface')) {
    out.surface = enumValue(raw.surface, SURFACES, 'surface');
  }
  if (include('outputKind')) {
    out.outputKind = enumValue(raw.outputKind, OUTPUT_KINDS, 'outputKind');
  }
  if (include('width')) {
    out.width = intValue(raw.width, 'width', { min: 1, max: MAX_PNG_DIMENSION });
  }
  if (include('height')) {
    out.height = intValue(raw.height, 'height', { min: 1, max: MAX_PNG_DIMENSION });
  }
  assertPixelBudget(out.width, out.height);
  if (include('notes')) {
    // Optional: an explicit "" clears the notes.
    out.notes = clampText(raw.notes, MAX_NOTES_LENGTH, 'notes');
  }
  if (!partial || present('synthetic')) {
    out.synthetic = raw.synthetic === true;
  }
  if (present('maxDiffRatio')) {
    out.maxDiffRatio = ratioValue(raw.maxDiffRatio, 'maxDiffRatio');
  } else if (!partial) {
    out.maxDiffRatio = DEFAULT_MAX_DIFF_RATIO;
  }
  return out;
}

export function validateReviewInput(raw) {
  if (!raw || typeof raw !== 'object') fail('invalid_review', 'review 必须是对象', 422);
  const scoresRaw = raw.scores && typeof raw.scores === 'object' ? raw.scores : {};
  const scores = {};
  for (const field of SCORE_FIELDS) {
    const value = scoresRaw[field];
    if (value === undefined || value === null || value === '') {
      scores[field] = null;
    } else {
      const num = typeof value === 'string' ? Number(value) : value;
      if (!SCORE_VALUES.includes(num)) {
        fail('invalid_score', `${field} 评分只能是 0、1 或 2`, 422);
      }
      scores[field] = num;
    }
  }
  const verdict = enumValue(raw.verdict, VERDICTS, 'verdict');
  const reason = clampText(raw.reason ?? '', MAX_REASON_LENGTH, 'reason');
  if (verdict === 'bad' && reason.length === 0) {
    fail('missing_reason', '判定为 bad 时必须填写原因', 422);
  }
  if (verdict === 'good' || verdict === 'bad') {
    for (const field of SCORE_FIELDS) {
      if (scores[field] === null) {
        fail('missing_score', `判定为 ${verdict} 时必须填写全部四项评分`, 422);
      }
    }
  }
  return {
    scores,
    verdict,
    reason,
    status: verdict === 'unreviewed' ? 'unreviewed' : 'reviewed',
    rubricVersion: RUBRIC_VERSION,
  };
}

export function buildReviewRecord(caseData, validatedReview, timestamp) {
  const inputFingerprint = computeInputFingerprint(caseData);
  const candidate = caseData.candidate;
  if (!candidate) fail('no_candidate', '没有候选输出，无法保存评审', 409);
  if (candidate.inputFingerprint !== inputFingerprint) {
    fail('stale_candidate', '输入或目标已变更，候选输出已过期，请重新上传后再评审', 409);
  }
  const fingerprint = computeReviewFingerprint({
    inputFingerprint,
    candidateSha256: candidate.sha256,
    scores: validatedReview.scores,
    verdict: validatedReview.verdict,
    reason: validatedReview.reason,
    rubricVersion: validatedReview.rubricVersion,
  });
  return {
    status: validatedReview.status,
    scores: validatedReview.scores,
    verdict: validatedReview.verdict,
    reason: validatedReview.reason,
    rubricVersion: validatedReview.rubricVersion,
    candidateSha256: candidate.sha256,
    inputFingerprint,
    fingerprint,
    reviewedAt: timestamp,
  };
}

export function buildGoldenRecord(caseData, timestamp) {
  const review = caseData.review;
  const candidate = caseData.candidate;
  if (!review || review.verdict !== 'good' || review.status !== 'reviewed') {
    fail('review_required', '只有已评审且判定为 good 的输出才能设为金标', 409);
  }
  if (!candidate) fail('no_candidate', '没有候选输出，无法设为金标', 409);
  if (candidate.width !== caseData.width || candidate.height !== caseData.height) {
    fail(
      'dimension_mismatch',
      `候选 PNG 尺寸 ${candidate.width}×${candidate.height} 与用例声明 ${caseData.width}×${caseData.height} 不一致，不能设为金标`,
      409,
    );
  }
  const inputFingerprint = computeInputFingerprint(caseData);
  if (candidate.inputFingerprint !== inputFingerprint) {
    fail('stale_candidate', '输入或目标已变更，候选输出已过期，不能设为金标', 409);
  }
  if (!reviewIsCurrent(caseData)) {
    fail('stale_review', '评审与当前候选/输入不匹配，请重新评审', 409);
  }
  const maxDiffRatio = ratioValue(caseData.maxDiffRatio, 'maxDiffRatio', DEFAULT_MAX_DIFF_RATIO);
  const fingerprint = computeGoldenFingerprint({
    inputFingerprint,
    candidateSha256: candidate.sha256,
    maxDiffRatio,
    reviewFingerprint: review.fingerprint,
  });
  return {
    approved: true,
    approvedAt: timestamp,
    fingerprint,
    candidateSha256: candidate.sha256,
    inputFingerprint,
    maxDiffRatio,
    reviewFingerprint: review.fingerprint,
  };
}

function decodeBundleAttachment(raw, label) {
  if (!raw || typeof raw !== 'object') fail('invalid_bundle', `${label} 附件格式错误`, 422);
  const name = clampText(raw.name, MAX_NAME_LENGTH, `${label} 附件名`, { required: true });
  const mime = clampText(raw.mime, 200, `${label} MIME`, { required: true }).toLowerCase();
  const buffer = parseBase64(raw.base64, `${label} 附件内容`);
  const kind = validateMimeAndKind(mime, raw.kind, buffer, {
    maxBytes: MAX_ATTACHMENT_BYTES,
    label: `${label} 附件 ${name}`,
  });
  const sha256 = sha256Hex(buffer);
  if (!isSafeSha256(raw.sha256) || raw.sha256 !== sha256) {
    fail('bundle_hash_mismatch', `${label} 附件 ${name} sha256 缺失或不匹配`, 422);
  }
  return { name, kind, mime, size: buffer.length, sha256, buffer };
}

function decodeBundleGolden(rawCase, base, label) {
  const goldenRaw = rawCase.goldenPng;
  if (!goldenRaw || typeof goldenRaw !== 'object') {
    fail('invalid_bundle', `${label} 缺少 goldenPng`, 422);
  }
  const goldenBuffer = parseBase64(goldenRaw.base64, `${label} goldenPng`);
  if (goldenBuffer.length > MAX_CANDIDATE_BYTES) {
    fail('file_too_large', `${label} goldenPng 超过 ${MAX_CANDIDATE_BYTES} 字节上限`, 422);
  }
  let decoded;
  try {
    decoded = decodePng(goldenBuffer);
  } catch (err) {
    fail('invalid_png', `${label} goldenPng 解码失败: ${err.message}`, 422);
  }
  const goldenSha = sha256Hex(goldenBuffer);
  if (!isSafeSha256(goldenRaw.sha256) || goldenRaw.sha256 !== goldenSha) {
    fail('bundle_hash_mismatch', `${label} goldenPng sha256 缺失或不匹配`, 422);
  }
  if (decoded.width !== base.width || decoded.height !== base.height) {
    fail(
      'bundle_dimension_mismatch',
      `${label} 声明 ${base.width}×${base.height}，但 goldenPng 实际为 ${decoded.width}×${decoded.height}`,
      422,
    );
  }
  if (goldenRaw.width !== undefined && goldenRaw.width !== decoded.width) {
    fail('bundle_dimension_mismatch', `${label} goldenPng.width 与解码尺寸不一致`, 422);
  }
  if (goldenRaw.height !== undefined && goldenRaw.height !== decoded.height) {
    fail('bundle_dimension_mismatch', `${label} goldenPng.height 与解码尺寸不一致`, 422);
  }
  return { buffer: goldenBuffer, sha256: goldenSha, width: decoded.width, height: decoded.height };
}

export function validateBundle(rawBundle, { requireSafeIds = false } = {}) {
  if (!rawBundle || typeof rawBundle !== 'object') fail('invalid_bundle', 'bundle 必须是对象', 422);
  if (rawBundle.kind !== 'imstage-eval-golden-bundle') {
    fail('invalid_bundle', 'bundle.kind 必须是 imstage-eval-golden-bundle', 422);
  }
  if (rawBundle.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    fail('unsupported_bundle_version', `不支持的 bundle.schemaVersion: ${rawBundle.schemaVersion}`, 422);
  }
  const scope = enumValue(rawBundle.scope, ['private', 'synthetic'], 'bundle.scope');
  if (
    rawBundle.threshold !== undefined &&
    rawBundle.threshold !== null &&
    rawBundle.threshold !== PNG_MATCH_THRESHOLD
  ) {
    fail('unsupported_threshold', `不支持的 bundle.threshold: ${rawBundle.threshold}（必须为 0.1）`, 422);
  }
  if (!Array.isArray(rawBundle.cases)) fail('invalid_bundle', 'bundle.cases 必须是数组', 422);

  const seenIds = new Set();
  const cases = rawBundle.cases.map((rawCase, index) => {
    const label = `bundle.cases[${index}]`;
    if (!rawCase || typeof rawCase !== 'object') fail('invalid_bundle', `${label} 格式错误`, 422);
    const base = validateCaseInput(rawCase);

    const rawId = rawCase.bundleCaseId;
    if (typeof rawId !== 'string' || rawId.length === 0) {
      fail('invalid_bundle', `${label} 缺少 bundleCaseId`, 422);
    }
    if (requireSafeIds && !isSafeId(rawId)) {
      fail('unsafe_id', `${label} 的 bundleCaseId 不合法`, 422);
    }
    const bundleCaseId = clampText(rawId, MAX_NAME_LENGTH, `${label} caseId`, { required: true });
    if (seenIds.has(bundleCaseId)) {
      fail('duplicate_case_id', `${label} bundleCaseId 重复: ${bundleCaseId}`, 422);
    }
    seenIds.add(bundleCaseId);

    const attachmentsRaw = Array.isArray(rawCase.attachments) ? rawCase.attachments : [];
    if (attachmentsRaw.length > MAX_ATTACHMENTS) {
      fail('too_many_attachments', `${label} 附件数量超过 ${MAX_ATTACHMENTS}`, 422);
    }
    const attachments = attachmentsRaw.map((att) => decodeBundleAttachment(att, label));
    const caseForFingerprint = { ...base, attachments };
    const inputFingerprint = computeInputFingerprint(caseForFingerprint);
    if (!rawCase.inputFingerprint || rawCase.inputFingerprint !== inputFingerprint) {
      fail('bundle_stale_fingerprint', `${label} 的 inputFingerprint 与内容不匹配`, 422);
    }

    const golden = decodeBundleGolden(rawCase, base, label);
    const maxDiffRatio = ratioValue(rawCase.maxDiffRatio, `${label} maxDiffRatio`, DEFAULT_MAX_DIFF_RATIO);

    // Strict score validation: only 0/1/2 numbers, all four present.
    const scores = {};
    for (const field of SCORE_FIELDS) {
      const value = rawCase.scores?.[field];
      if (typeof value !== 'number' || !SCORE_VALUES.includes(value)) {
        fail('invalid_score', `${label} 的 ${field} 必须是 0、1 或 2 的数字`, 422);
      }
      scores[field] = value;
    }
    const verdict = enumValue(rawCase.verdict, ['good'], `${label} verdict`);
    const reason = clampText(rawCase.reason ?? '', MAX_REASON_LENGTH, `${label} reason`);
    const rubricVersion = rawCase.rubricVersion ?? RUBRIC_VERSION;
    if (rubricVersion !== RUBRIC_VERSION) {
      fail('unsupported_rubric', `${label} 不支持的 rubricVersion: ${rubricVersion}`, 422);
    }
    const reviewFingerprint = computeReviewFingerprint({
      inputFingerprint,
      candidateSha256: golden.sha256,
      scores,
      verdict,
      reason,
      rubricVersion,
    });
    if (rawCase.reviewFingerprint !== undefined && rawCase.reviewFingerprint !== reviewFingerprint) {
      fail('bundle_review_mismatch', `${label} reviewFingerprint 与评审内容不匹配`, 422);
    }
    return {
      bundleCaseId,
      ...base,
      maxDiffRatio,
      attachments,
      inputFingerprint,
      goldenPng: golden,
      review: {
        scores,
        verdict,
        reason,
        status: 'reviewed',
        rubricVersion,
        candidateSha256: golden.sha256,
        inputFingerprint,
        fingerprint: reviewFingerprint,
        reviewedAt: rawCase.reviewedAt ?? null,
      },
      goldenFingerprint: computeGoldenFingerprint({
        inputFingerprint,
        candidateSha256: golden.sha256,
        maxDiffRatio,
        reviewFingerprint,
      }),
      synthetic: rawCase.synthetic === true,
      rubricVersion,
    };
  });

  if (scope === 'synthetic' && cases.some((c) => c.synthetic !== true)) {
    fail('bundle_scope_mismatch', 'scope=synthetic 的 bundle 不能包含未标记为合成的用例', 422);
  }

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: 'imstage-eval-golden-bundle',
    scope,
    generatedAt: rawBundle.exportedAt ?? null,
    generator: rawBundle.generator ?? null,
    threshold: PNG_MATCH_THRESHOLD,
    cases,
  };
}

export function assert(condition, code, message, status = 400) {
  if (!condition) throw new AppError(code, message, status);
}

// AI-assisted conversation generation.
//
// Pipeline: user sentence and/or screenshots -> OpenAI-compatible DeepSeek
// vision request -> validated conversation scene -> deterministic renderer.
//
// This module owns everything up to (not including) rendering:
// - explicit generation defaults and provider configuration (server-side only)
// - strict pre-network validation of images (bytes / dimensions / count / total)
// - the prompt that distinguishes the requested target platform from the
//   screenshot's source IM
// - the native-fetch provider call and its safe, actionable error mapping
//
// It never logs or returns API keys or raw provider response bodies, and it
// never fabricates a canned scene when the provider fails.

import {
  AI_DEFAULT_BASE_URL,
  AI_DEFAULT_MODEL,
  AI_MAX_TOKENS,
  AI_PROMPT_VERSION,
  AI_TIMEOUT_MS,
  GENERATION_DEFAULTS,
  GENERATION_OUTPUT_KINDS,
  GENERATION_SURFACES,
  GENERATION_TARGET_IMS,
  MAX_GENERATION_IMAGES,
  MAX_GENERATION_IMAGE_BYTES,
  MAX_GENERATION_TOTAL_IMAGE_BYTES,
  MAX_PIXELS,
  MAX_PNG_DIMENSION,
  MAX_QUESTION_LENGTH,
} from './constants.mjs';
import { AppError, canonicalJson, clampText, fail, sha256Hex } from './util.mjs';
import { normalizeAttachmentInput } from './validate.mjs';
import { decodePng, parsePngHeader } from './png.mjs';
import {
  ConversationSchemaError,
  scenePlainText,
  validateConversationScene,
} from '../../../packages/schema/conversation.mjs';

export { AI_PROMPT_VERSION };

// ---------------------------------------------------------------------------
// Configuration (process env only; credentials are never browser-controlled).
// ---------------------------------------------------------------------------

export function resolveAiConfig(env = process.env) {
  const apiKey = String(env.IMSTAGE_AI_API_KEY ?? env.DEEPSEEK_API_KEY ?? '').trim();
  const baseUrlRaw = String(env.IMSTAGE_AI_BASE_URL ?? AI_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  const model = String(env.IMSTAGE_AI_MODEL ?? AI_DEFAULT_MODEL).trim() || AI_DEFAULT_MODEL;
  const baseUrl = /^https?:\/\//i.test(baseUrlRaw) ? baseUrlRaw : AI_DEFAULT_BASE_URL;
  const disableThinking =
    env.IMSTAGE_AI_THINKING_DISABLED === undefined
      ? /deepseek/i.test(`${baseUrl} ${model}`)
      : env.IMSTAGE_AI_THINKING_DISABLED !== '0' && env.IMSTAGE_AI_THINKING_DISABLED !== 'false';
  return {
    configured: apiKey.length > 0,
    apiKey,
    baseUrl,
    model,
    maxTokens: AI_MAX_TOKENS,
    timeoutMs: AI_TIMEOUT_MS,
    disableThinking,
  };
}

export function publicGenerationStatus(config) {
  return {
    configured: config.configured === true,
    model: config.model || AI_DEFAULT_MODEL,
    images: true,
    defaults: { ...GENERATION_DEFAULTS },
  };
}

// ---------------------------------------------------------------------------
// Input normalization + image validation (all before any network call).
// ---------------------------------------------------------------------------

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 >= buffer.length) break;
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buffer.length) break;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  fail('invalid_image', '无法解析 JPEG 尺寸', 422);
}

function webpDimensions(buffer) {
  const fourcc = buffer.subarray(12, 16).toString('latin1');
  if (fourcc === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)),
      height: 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)),
    };
  }
  if (fourcc === 'VP8 ' && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  fail('invalid_image', '无法解析 WebP 尺寸', 422);
}

export function readImageDimensions(buffer, mime) {
  let dims;
  if (mime === 'image/png') {
    const header = parsePngHeader(buffer);
    dims = { width: header.width, height: header.height };
  } else if (mime === 'image/gif') {
    if (buffer.length < 10) fail('invalid_image', 'GIF 文件不完整', 422);
    dims = { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  } else if (mime === 'image/jpeg') {
    dims = jpegDimensions(buffer);
  } else if (mime === 'image/webp') {
    dims = webpDimensions(buffer);
  } else {
    fail('unsupported_image', `不支持的图片类型: ${mime}`, 422);
  }
  if (!Number.isInteger(dims.width) || !Number.isInteger(dims.height) || dims.width < 1 || dims.height < 1) {
    fail('invalid_image', '图片尺寸不合法', 422);
  }
  if (dims.width > MAX_PNG_DIMENSION || dims.height > MAX_PNG_DIMENSION) {
    fail('image_too_large', `图片单边不能超过 ${MAX_PNG_DIMENSION} 像素`, 422);
  }
  if (dims.width * dims.height > MAX_PIXELS) {
    fail('image_too_large', `图片像素总数不能超过 ${MAX_PIXELS}`, 422);
  }
  return dims;
}

function generationEnum(value, allowed, label, fallback) {
  const resolved = value === undefined || value === null || value === '' ? fallback : value;
  if (!allowed.includes(resolved)) {
    fail('invalid_enum', `${label} 只能是: ${allowed.join(', ')}`, 422);
  }
  return resolved;
}

/**
 * Validate the untrusted `input` field and prepare it for the provider call.
 * Throws AppError (422) before any network access on bad input.
 */
export function normalizeGenerationInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    fail('invalid_input', 'input 必须是对象', 422);
  }
  const text = clampText(rawInput.text ?? '', MAX_QUESTION_LENGTH, 'input.text');
  const imagesRaw = rawInput.images === undefined || rawInput.images === null ? [] : rawInput.images;
  if (!Array.isArray(imagesRaw)) fail('invalid_input', 'input.images 必须是数组', 422);
  if (imagesRaw.length > MAX_GENERATION_IMAGES) {
    fail('too_many_images', `最多提供 ${MAX_GENERATION_IMAGES} 张图片`, 422);
  }
  if (text.length === 0 && imagesRaw.length === 0) {
    fail('missing_input', '请提供一句话或 1-3 张图片', 422);
  }

  const images = [];
  let totalBytes = 0;
  for (const raw of imagesRaw) {
    const att = normalizeAttachmentInput(raw, { maxBytes: MAX_GENERATION_IMAGE_BYTES });
    if (att.kind !== 'image') {
      fail('unsupported_image', `只接受图片输入，收到: ${att.mime}`, 422);
    }
    if (att.buffer.length > MAX_GENERATION_IMAGE_BYTES) {
      fail('image_too_large', `单张图片超过 ${MAX_GENERATION_IMAGE_BYTES} 字节上限`, 422);
    }
    totalBytes += att.buffer.length;
    if (totalBytes > MAX_GENERATION_TOTAL_IMAGE_BYTES) {
      fail('images_too_large', `图片总大小超过 ${MAX_GENERATION_TOTAL_IMAGE_BYTES} 字节上限`, 422);
    }
    const dims = readImageDimensions(att.buffer, att.mime);
    if (att.mime === 'image/png') {
      // A 33-byte PNG header is syntactically valid but not a decodable image.
      // Fully decode before any provider call so truncated/corrupt PNGs fail.
      try {
        decodePng(att.buffer);
      } catch (err) {
        fail('invalid_image', `PNG 解码失败: ${err.message}`, 422);
      }
    }
    images.push({
      name: att.name,
      mime: att.mime,
      kind: 'image',
      width: dims.width,
      height: dims.height,
      size: att.buffer.length,
      buffer: att.buffer,
      sha256: sha256Hex(att.buffer),
      dataBase64: att.buffer.toString('base64'),
    });
  }

  const targetIM = generationEnum(rawInput.targetIM, GENERATION_TARGET_IMS, 'input.targetIM', GENERATION_DEFAULTS.targetIM);
  const surface = generationEnum(rawInput.surface, GENERATION_SURFACES, 'input.surface', GENERATION_DEFAULTS.surface);
  const outputKind = generationEnum(rawInput.outputKind, GENERATION_OUTPUT_KINDS, 'input.outputKind', GENERATION_DEFAULTS.outputKind);
  const synthetic = rawInput.synthetic === true;

  const inputHash = sha256Hex(
    canonicalJson({
      text,
      images: images.map((img) => ({ name: img.name, mime: img.mime, sha256: img.sha256 })),
      targetIM,
      surface,
      outputKind,
      synthetic,
    }),
  );

  return { text, images, targetIM, surface, outputKind, synthetic, inputHash, totalBytes };
}

// ---------------------------------------------------------------------------
// Language detection (automatic; the caller never selects a language).
// ---------------------------------------------------------------------------

export function detectLanguage(text) {
  const value = String(text ?? '');
  const cjk = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  if (cjk > 0 && cjk >= latin) return 'zh-CN';
  if (latin > 0) return 'en';
  return 'other';
}

// ---------------------------------------------------------------------------
// Prompt construction.
// ---------------------------------------------------------------------------

export function buildSceneSystemPrompt(request) {
  const assetCount = request.images.length;
  const assetLine =
    assetCount > 0
      ? `本次调用附带 ${assetCount} 张真实图片（assetIndex 0 到 ${assetCount - 1}）。图片消息只能通过 assetIndex 引用这些图片；不要引用任何未提供的图片、URL 或文件路径。`
      : '本次调用没有附带图片。不要生成 type 为 image 的消息。';
  return [
    '你是 IMStage 的对话结构生成器。把用户提供的一句话或截图转换成结构化对话 JSON。',
    '只输出一个 JSON 对象，不要输出解释、Markdown 或代码块。',
    '',
    '输出对象固定形状：',
    '{',
    '  "scene": {',
    '    "title": "会话标题",',
    '    "platform": "wechat | telegram | whatsapp",',
    '    "deviceTime": "HH:MM", "date": "YYYY-MM-DD 或空字符串",',
    '    "selfId": "参与者 id",',
    '    "participants": [{"id": "安全 id", "name": "昵称"}],',
    '    "messages": [{"id": "安全 id", "participantId": "参与者 id", "type": "text|image|system|location", "text": "...", "time": "HH:MM", "assetIndex": 0}],',
    '    "watermark": ""',
    '  },',
    '  "warnings": ["可选的不确定说明"]',
    '}',
    '',
    `目标平台是 ${request.targetIM}。截图内容可能来自其他 IM，必须使用目标平台（${request.targetIM}）的风格与结构，不要照抄截图的来源平台。`,
    `设备界面: ${request.surface}；输出类型: ${request.outputKind}。`,
    assetLine,
    '规则：',
    '- 只使用给定 JSON 字段，不要新增字段；id 只用字母、数字、下划线、连字符。',
    '- participantId 必须引用已声明的参与者；系统消息的 participantId 可为空字符串。',
    '- 图片消息必须带 assetIndex；文字消息不要带 assetIndex。',
    '- 忠实还原可读内容；看不清的文字不要编造，用简短占位符并在 warnings 中说明不确定性。',
    '- 文字描述要求创作场景时，按要求生成自然的对话；没有指定消息数量时，普通截图优先 4-6 条简短消息。',
    '- 截图复现任务忠实保留可读消息，不额外虚构；用户明确要求续写或改写时可按要求创作。',
    '- text 字段不得包含 HTML、脚本、事件处理属性或远程 URL。',
  ].join('\n');
}

export function buildSceneUserContent(request) {
  const assetCount = request.images.length;
  const instruction = request.text
    ? request.text
    : '未提供文字说明。请识别截图中可见的对话内容，并以目标平台风格复现为结构化对话 JSON。';
  const constraints = [
    '',
    '[本次要求]',
    `- 目标平台: ${request.targetIM}`,
    `- 设备界面: ${request.surface}`,
    `- 输出类型: ${request.outputKind}`,
    `- 可用图片数量: ${assetCount}${assetCount > 0 ? `（assetIndex 0..${assetCount - 1}）` : ''}`,
  ].join('\n');
  const content = [{ type: 'text', text: `${instruction}\n${constraints}` }];
  for (const image of request.images) {
    content.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.dataBase64}` } });
  }
  return content;
}

export function buildProviderRequestBody(config, request) {
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: buildSceneSystemPrompt(request) },
      { role: 'user', content: buildSceneUserContent(request) },
    ],
    max_tokens: config.maxTokens ?? AI_MAX_TOKENS,
    response_format: { type: 'json_object' },
    stream: false,
  };
  // DeepSeek supports disabling the reasoning/thinking pass; keep it off so the
  // response stays a single JSON object.
  if (config.disableThinking) body.thinking = { type: 'disabled' };
  return body;
}

// ---------------------------------------------------------------------------
// Provider call (native fetch, OpenAI-compatible /chat/completions).
// ---------------------------------------------------------------------------

function mapHttpStatus(status) {
  if (status === 401 || status === 403) {
    return new AppError('ai_auth_failed', 'AI 鉴权失败，请检查 API Key 配置', 502);
  }
  if (status === 402 || status === 429) {
    return new AppError('ai_quota_exceeded', 'AI 额度不足或请求过于频繁，请稍后重试', 429);
  }
  if (status === 400 || status === 422) {
    return new AppError('ai_rejected_request', 'AI 拒绝了本次请求（可能是模型或参数不受支持）', 502);
  }
  if (status >= 500) {
    return new AppError('ai_provider_error', 'AI 服务返回错误，请稍后重试', 502);
  }
  return new AppError('ai_provider_error', `AI 服务返回异常状态 (${status})`, 502);
}

/**
 * Default `generateScene` seam: calls the provider and returns raw content.
 * Tests inject their own implementation, so no live paid/model calls are made
 * in the unit suite.
 */
export async function callDeepSeekScene({ config, request, signal, fetchImpl = fetch }) {
  if (!config || config.configured !== true) {
    throw new AppError('ai_not_configured', '未配置 AI（需要 IMSTAGE_AI_API_KEY 或 DEEPSEEK_API_KEY）', 503);
  }
  const url = `${config.baseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('ai_timeout')), config.timeoutMs ?? AI_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason ?? new Error('request_aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
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
    return { rawContent: content, model: typeof data?.model === 'string' ? data.model : config.model };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (controller.signal.aborted) {
      if (signal?.aborted) throw new AppError('request_aborted', '请求已取消', 499);
      throw new AppError('ai_timeout', `AI 请求超时（${Math.round((config.timeoutMs ?? AI_TIMEOUT_MS) / 1000)} 秒）`, 504);
    }
    throw new AppError('ai_unreachable', 'AI 服务不可达，请检查网络或 Base URL', 502);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------------------
// Response parsing + scene validation.
// ---------------------------------------------------------------------------

function stripCodeFences(value) {
  const trimmed = String(value ?? '').trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function collectWarnings(parsed) {
  const items = [];
  for (const key of ['warnings', 'uncertainty', 'uncertainties', 'notes']) {
    const value = parsed?.[key];
    if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string') items.push(entry);
    } else if (typeof value === 'string' && value.trim()) {
      items.push(value);
    }
  }
  return items
    .map((w) => w.trim().slice(0, 500))
    .filter((w) => w.length > 0)
    .slice(0, 20);
}

/**
 * Parse the raw provider content into a validated scene.
 * @returns {{ scene: object, warnings: string[] }}
 */
export function parseSceneResponse(rawContent, { assetCount = 0, expectedPlatform } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFences(rawContent));
  } catch {
    throw new AppError('ai_invalid_json', 'AI 未返回合法 JSON', 502);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('ai_invalid_scene', 'AI 返回的 scene 不是 JSON 对象', 502);
  }
  const warnings = collectWarnings(parsed);
  const candidateScene = parsed.scene && typeof parsed.scene === 'object' ? parsed.scene : parsed;
  if (expectedPlatform && candidateScene.platform && candidateScene.platform !== expectedPlatform) {
    warnings.push(`已按显式选择覆盖 AI 返回的平台 (${candidateScene.platform} -> ${expectedPlatform})`);
  }
  try {
    const scene = validateConversationScene(candidateScene, { assetCount, expectedPlatform });
    return { scene, warnings };
  } catch (err) {
    if (err instanceof ConversationSchemaError) {
      throw new AppError('ai_invalid_scene', `AI 返回的 scene 不合法: ${err.message}`, 502, { reason: err.code });
    }
    throw err;
  }
}

export { scenePlainText };

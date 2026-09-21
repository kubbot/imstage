/**
 * IMStage Agent — server-only configuration.
 *
 * Everything here is read from the process environment (or injected overrides
 * in tests). Secrets never leave this module: the public capability response is
 * built by `capabilitiesFromConfig` and only exposes booleans plus the model id.
 */

export const DEFAULT_AGENT_MODEL = 'deepseek-flash';
export const DEFAULT_AGENT_BASE_URL = 'https://api.deepseek.com';
export const AGENT_CHAT_PATH = '/chat/completions';
export const AGENT_IMAGE_PATH = '/images/generations';

/**
 * Image provider selection. `openai` keeps the existing OpenAI-compatible
 * `/images/generations` + `/images/edits` behaviour; `tencent-wand` uses the
 * Tencent TokenHub WAND-Vega async task API. An unknown value fails closed
 * (image generation is reported as not configured) instead of silently
 * falling back to another provider.
 */
export const IMAGE_PROVIDER_OPENAI = 'openai';
export const IMAGE_PROVIDER_TENCENT_WAND = 'tencent-wand';
export const DEFAULT_IMAGE_PROVIDER = IMAGE_PROVIDER_OPENAI;
export const IMAGE_PROVIDERS = Object.freeze([IMAGE_PROVIDER_OPENAI, IMAGE_PROVIDER_TENCENT_WAND]);

/** Domestic TokenHub base; the create/task paths are appended by the client. */
export const DEFAULT_TENCENT_IMAGE_BASE_URL = 'https://tokenhub.tencentmaas.com/v1';

/**
 * Bounded async polling for the Tencent WAND-Vega task API. The provider polls
 * every 3 s until `completed`/a terminal failure, and never resubmits a task.
 */
export const AGENT_IMAGE_POLL_INTERVAL_MS = 3_000;
export const AGENT_IMAGE_TASK_DEADLINE_MS = 120_000;
/** Cap for the completed-image COS download (decoded bytes). */
export const AGENT_IMAGE_MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

export const AGENT_DEADLINE_MS = 120_000;
export const AGENT_MAX_ROUNDS = 8;
export const AGENT_MAX_TOOL_CALLS = 24;
export const AGENT_MAX_PROMPT_CHARS = 4000;
export const AGENT_MAX_ATTACHMENTS = 3;
export const AGENT_MAX_HISTORY = 12;
export const AGENT_MAX_HISTORY_CHARS = 4000;
/** Bounded inline PNG/JPEG/WebP data URL, kept in sync with `isLocalImage`. */
export const AGENT_MAX_ATTACHMENT_CHARS = 6 * 1024 * 1024;
export const AGENT_MAX_ATTACHMENT_TOTAL_CHARS = 18 * 1024 * 1024;
export const AGENT_MAX_ASSISTANT_CHARS = 8000;
export const AGENT_MAX_TOOL_DETAIL_CHARS = 500;
export const AGENT_MAX_IMAGE_PROMPT_CHARS = 1200;
export const AGENT_MAX_SCENE_CONTEXT_CHARS = 48 * 1024;
export const AGENT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const AGENT_MAX_IMAGE_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Request body cap for POST /api/agent/run (16 MiB scene + up to 18 MiB attachments). */
export const AGENT_BODY_LIMIT = 40 * 1024 * 1024;

/**
 * Explicit scene resource limits, enforced for both the incoming scene and
 * every proposed mutation. They keep the provider context and every emitted
 * scene event bounded and reject a runaway model turn with useful feedback.
 */
export const AGENT_MAX_SCENE_MESSAGES = 200;
export const AGENT_MAX_SCENE_PARTICIPANTS = 20;
export const AGENT_MAX_SCENE_TEXT_CHARS = 4000;
export const AGENT_MAX_SCENE_ID_CHARS = 128;
export const AGENT_MAX_SCENE_NAME_CHARS = 120;
export const AGENT_MAX_SCENE_DATE_CHARS = 80;
export const AGENT_MAX_SCENE_TIME_CHARS = 20;
export const AGENT_MAX_SCENE_TITLE_CHARS = 200;
export const AGENT_MAX_SCENE_WATERMARK_CHARS = 200;

export const DEFAULT_AGENT_LIMITS = Object.freeze({
  activeGlobal: 4,
  activePerUser: 1,
  rate: Object.freeze({ windowMs: 10 * 60 * 1000, max: 20, maxKeys: 10_000 }),
});

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Normalize an OpenAI-compatible base URL. Returns `null` for missing or
 * non-http(s) values so a bad environment degrades to "not configured"
 * instead of ever producing an arbitrary outbound request.
 */
export function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function mergeLimits(overrides) {
  const rate = overrides?.rate ?? {};
  return {
    activeGlobal: positiveInt(overrides?.activeGlobal, DEFAULT_AGENT_LIMITS.activeGlobal),
    activePerUser: positiveInt(overrides?.activePerUser, DEFAULT_AGENT_LIMITS.activePerUser),
    rate: {
      windowMs: positiveInt(rate.windowMs, DEFAULT_AGENT_LIMITS.rate.windowMs),
      max: positiveInt(rate.max, DEFAULT_AGENT_LIMITS.rate.max),
      maxKeys: positiveInt(rate.maxKeys, DEFAULT_AGENT_LIMITS.rate.maxKeys),
    },
  };
}

/**
 * Resolve the effective agent configuration.
 *
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [overrides] Test/integration overrides. Recognised keys:
 *   `apiKey`, `baseUrl`, `model`, `imageProvider`, `imageApiKey`, `imageBaseUrl`,
 *   `imageModel`, `deadlineMs`, `maxRounds`, `maxCalls`, `imageDeadlineMs`,
 *   `imagePollIntervalMs`, `limits`.
 */
export function resolveAgentConfig(env = {}, overrides = {}) {
  const apiKey = firstNonEmpty(overrides.apiKey, env.IMSTAGE_AI_API_KEY, env.DEEPSEEK_API_KEY);
  const baseUrl = normalizeBaseUrl(
    firstNonEmpty(overrides.baseUrl, env.IMSTAGE_AI_BASE_URL, DEFAULT_AGENT_BASE_URL),
  );
  const model = firstNonEmpty(overrides.model, env.IMSTAGE_AI_MODEL, DEFAULT_AGENT_MODEL);

  const imageApiKey = firstNonEmpty(overrides.imageApiKey, env.IMSTAGE_IMAGE_API_KEY);
  const requestedImageProvider = firstNonEmpty(overrides.imageProvider, env.IMSTAGE_IMAGE_PROVIDER);
  const imageProvider = requestedImageProvider ?? DEFAULT_IMAGE_PROVIDER;
  // Unknown providers fail closed: no outbound image request is ever made.
  const imageProviderValid = IMAGE_PROVIDERS.includes(imageProvider);
  const imageBaseUrl = normalizeBaseUrl(
    firstNonEmpty(overrides.imageBaseUrl, env.IMSTAGE_IMAGE_BASE_URL) ??
      (imageProviderValid && imageProvider === IMAGE_PROVIDER_TENCENT_WAND
        ? DEFAULT_TENCENT_IMAGE_BASE_URL
        : null),
  );
  const imageModel = firstNonEmpty(overrides.imageModel, env.IMSTAGE_IMAGE_MODEL);

  const configured = Boolean(apiKey) && Boolean(baseUrl);
  const imageConfigured = imageProviderValid && Boolean(imageApiKey && imageBaseUrl && imageModel);

  return {
    apiKey,
    baseUrl,
    model,
    configured,
    imageProvider,
    imageProviderValid,
    imageApiKey,
    imageBaseUrl,
    imageModel,
    imageConfigured,
    deadlineMs: positiveInt(overrides.deadlineMs, AGENT_DEADLINE_MS),
    maxRounds: positiveInt(overrides.maxRounds, AGENT_MAX_ROUNDS),
    maxCalls: positiveInt(overrides.maxCalls, AGENT_MAX_TOOL_CALLS),
    imageDeadlineMs: positiveInt(overrides.imageDeadlineMs, AGENT_IMAGE_TASK_DEADLINE_MS),
    imagePollIntervalMs: positiveInt(overrides.imagePollIntervalMs, AGENT_IMAGE_POLL_INTERVAL_MS),
    maxImageDownloadBytes: positiveInt(overrides.maxImageDownloadBytes, AGENT_IMAGE_MAX_DOWNLOAD_BYTES),
    maxResponseBytes: positiveInt(overrides.maxResponseBytes, AGENT_MAX_RESPONSE_BYTES),
    maxImageResponseBytes: positiveInt(overrides.maxImageResponseBytes, AGENT_MAX_IMAGE_RESPONSE_BYTES),
    limits: mergeLimits(overrides.limits),
  };
}

/** Public, non-secret capability descriptor. */
export function capabilitiesFromConfig(config, hasChatProvider = false, hasImageProvider = false) {
  return {
    configured: hasChatProvider || Boolean(config?.configured),
    model: typeof config?.model === 'string' && config.model ? config.model : DEFAULT_AGENT_MODEL,
    imageConfigured: hasImageProvider || Boolean(config?.imageConfigured),
  };
}

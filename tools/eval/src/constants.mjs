// Shared constants for the IMStage evaluation lab.
// Keep every bound explicit so server, CLI and tests agree.

export const APP_NAME = 'imstage-eval';
export const APP_VERSION = '0.1.0';

export const HOST = '127.0.0.1';
export const PORT = 4421;

export const SCHEMA_VERSION = 1;
export const STORE_SCHEMA_VERSION = 1;
export const BUNDLE_SCHEMA_VERSION = 1;
export const ACTUAL_MANIFEST_SCHEMA_VERSION = 1;
export const RUBRIC_VERSION = 'v1';

// Fixed pixelmatch sensitivity. Requirement: threshold fixed at 0.1.
export const PNG_MATCH_THRESHOLD = 0.1;
// Per-case tolerance. Default 0.005, validated finite within [0, 0.05].
export const DEFAULT_MAX_DIFF_RATIO = 0.005;
export const MAX_DIFF_RATIO_LIMIT = 0.05;

// PNG decode guards applied before pngjs allocates pixel buffers.
export const MAX_PIXELS = 8_000_000;
export const MAX_PNG_DIMENSION = 20_000;
export const MAX_PNG_BYTES = 8 * 1024 * 1024;
export const MIN_PNG_BYTES = 33; // 8 magic + IHDR chunk

// Upload / body bounds.
export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_CANDIDATE_BYTES = 8 * 1024 * 1024;
export const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024;
export const MAX_QUESTION_LENGTH = 4000;
export const MAX_NOTES_LENGTH = 8000;
export const MAX_REASON_LENGTH = 4000;
export const MAX_NAME_LENGTH = 200;
export const MAX_CASES = 2000;

export const TARGET_IMS = ['wechat', 'telegram', 'whatsapp', 'custom'];
export const SURFACES = ['ios', 'android', 'desktop', 'web'];
export const INPUT_LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'other'];
export const OUTPUT_KINDS = ['screenshot', 'long-screenshot'];
export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'other'];
export const SCORE_FIELDS = ['content', 'imFidelity', 'layout', 'completeness'];
export const SCORE_VALUES = [0, 1, 2];
export const VERDICTS = ['good', 'bad', 'unreviewed'];

// Only these MIME types are accepted for raw attachments and candidates.
export const SAFE_MIME = Object.freeze({
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
  'audio/mp4': 'audio',
  'audio/webm': 'audio',
  'application/pdf': 'other',
  'text/plain': 'other',
  'application/octet-stream': 'other',
});

// Preview is limited to safe raster images and bounded media containers.
export const PREVIEWABLE_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
export const PREVIEWABLE_VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
export const PREVIEWABLE_AUDIO_MIME = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'audio/webm',
]);

export const CASE_FILTER_KEYS = ['q', 'targetIM', 'surface', 'inputLanguage', 'outputKind', 'status'];

// ---------------------------------------------------------------------------
// AI-assisted generation (sentence/screenshot -> target IM result).
// ---------------------------------------------------------------------------

// Explicit generation defaults (used when the caller omits them).
// ios/android default to a phone viewport, desktop/web to a wider one.
export const SURFACE_DIMENSIONS = Object.freeze({
  ios: Object.freeze({ width: 390, height: 844 }),
  android: Object.freeze({ width: 390, height: 844 }),
  desktop: Object.freeze({ width: 720, height: 900 }),
  web: Object.freeze({ width: 720, height: 900 }),
});

export const GENERATION_DEFAULTS = Object.freeze({
  targetIM: 'wechat',
  surface: 'ios',
  outputKind: 'screenshot',
});
export const GENERATION_TARGET_IMS = Object.freeze(['wechat', 'telegram', 'whatsapp']);
export const GENERATION_SURFACES = SURFACES;
export const GENERATION_OUTPUT_KINDS = OUTPUT_KINDS;

// Generation input bounds. Images are validated (bytes/dimensions/count/total)
// before any provider network call is made.
export const MAX_GENERATION_IMAGES = 3;
export const MAX_GENERATION_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_GENERATION_TOTAL_IMAGE_BYTES = 3 * MAX_GENERATION_IMAGE_BYTES;

export const AI_DEFAULT_BASE_URL = 'https://api.deepseek.com';
export const AI_DEFAULT_MODEL = 'deepseek-flash';
export const AI_MAX_TOKENS = 4500;
export const AI_TIMEOUT_MS = 60_000;
export const AI_PROMPT_VERSION = 'v1';

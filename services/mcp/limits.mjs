// Explicit, shared bounds for the IMStage MCP adapter.
//
// Every number here is enforced in the MCP layer *in addition to* the shared
// `validateScene` contract from apps/web/src/studio/model.ts. The MCP server is
// a network-facing surface, so it re-checks counts, identifier shapes, text
// lengths, uploaded image size and request body size before anything reaches
// SQLite or Playwright.

export const MCP_SERVER_NAME = 'imstage-mcp';
export const MCP_SERVER_VERSION = '0.1.0';

/** Loopback-only HTTP port. Never binds a public interface. */
export const DEFAULT_MCP_PORT = 4421;
export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/healthz';

/** HTTP bearer auth. */
export const TOKEN_MIN_LENGTH = 16;
export const TOKEN_MAX_LENGTH = 256;

/** Request body bound (scene JSON, possibly with inline base64 images). */
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

/** Bounds on the caller-supplied scene. */
export const SCENE_LIMITS = Object.freeze({
  titleMax: 120,
  watermarkMax: 200,
  dateMax: 40,
  deviceTimeMax: 40,
  participantsMin: 1,
  participantsMax: 12,
  messagesMin: 1,
  messagesMax: 120,
  nameMax: 60,
  idMax: 64,
  textMax: 2000,
  timeMax: 40,
  /** At most this many distinct uploaded data-URI assets per scene. */
  assetsMax: 8,
  /** Upper bound for a single data: URI (avatar, image message, background). */
  assetDataUriMax: 2 * 1024 * 1024,
  /** Idempotency keys are opaque caller strings, kept short and printable. */
  idempotencyKeyMax: 128,
});

/** Stable identifier shape shared by scene, participant and message ids. */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Scene ids are always server-generated: `scn_` + 32 hex chars. */
export const SCENE_ID_RE = /^scn_[0-9a-f]{32}$/;
export const EPHEMERAL_SCENE_ID_RE = /^eph_[0-9a-f]{32}$/;

/** Render bounds. Chromium is expensive, so both jobs and pixels are capped. */
export const RENDER_LIMITS = Object.freeze({
  maxConcurrent: 1,
  maxQueued: 8,
  timeoutMs: 30_000,
  widthMin: 200,
  widthMax: 1200,
  heightMin: 200,
  heightMax: 20_000,
  maxPixels: 4_000_000,
  maxPngBytes: 6 * 1024 * 1024,
});

/** How many rendered PNG artifacts to retain for widget download resources. */
export const MAX_STORED_RENDERS = 50;

/** Playwright surfaces the deterministic renderer supports. */
export const RENDER_SURFACES = Object.freeze(['ios', 'android', 'desktop']);
export const RENDER_OUTPUT_KINDS = Object.freeze(['screenshot', 'long-screenshot']);

/** Platforms and static message cards implemented by the shared Web SceneView. */
export const SUPPORTED_PLATFORMS = Object.freeze(['wechat', 'xiaohongshu', 'imessage', 'whatsapp', 'slack', 'instagram']);
export const NATIVE_MESSAGE_TYPES = Object.freeze(['text', 'image', 'location', 'system', 'contact', 'transfer', 'voice', 'video', 'link', 'album']);

/** Resource MIME for MCP Apps widgets. */
export const WIDGET_MIME_TYPE = 'text/html;profile=mcp-app';

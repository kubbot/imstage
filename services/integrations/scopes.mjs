// Shared constants for the account-owned ChatGPT/MCP connection backend.
//
// Keeping the scope set and the token/request lifetimes in one module lets the
// OAuth provider, the personal-token store and the MCP resource server agree on
// exactly what a token is allowed to do and for how long.

/** Scene scope: the six account scene tools (create/get/update/render/list). */
export const SCENE_SCOPE = 'imstage.scenes';

/**
 * Project scope: account project/scenario/template/content-batch tools.
 * Project tools require BOTH scopes. Grants are never silently upgraded: a
 * credential created before this scope existed keeps its scenes-only grant and
 * keeps seeing exactly the six scene tools until the user re-authorizes.
 */
export const PROJECT_SCOPE = 'imstage.projects';

/** Every scope this resource server understands. */
export const SUPPORTED_SCOPES = Object.freeze([SCENE_SCOPE, PROJECT_SCOPE]);

/** The scope the /api/mcp resource server requires on every call. */
export const REQUIRED_SCOPE = SCENE_SCOPE;

/** Scopes required by the account project/automation tools. */
export const PROJECT_TOOL_SCOPES = Object.freeze([SCENE_SCOPE, PROJECT_SCOPE]);

/** Scopes required by the six legacy account scene tools. */
export const SCENE_TOOL_SCOPES = Object.freeze([SCENE_SCOPE]);

/** Short-lived access tokens (OAuth 2.1 recommends short-lived for public clients). */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
/** Public clients MUST receive rotating refresh tokens. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Authorization codes are single-use and short-lived. */
export const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Pending consent requests expire quickly and are never reused. */
export const PENDING_REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutes
/** Consent approval requires a session created within this window. */
export const RECENT_SESSION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Whether `granted` covers every scope `required` needs. Used for per-tool
 * filtering *and* for handler-level guards on direct invocation.
 */
export function hasScopes(granted, required) {
  const set = new Set(Array.isArray(granted) ? granted : []);
  return (Array.isArray(required) ? required : [required]).every((scope) => set.has(scope));
}

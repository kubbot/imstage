// Shared constants for the account-owned ChatGPT/MCP connection backend.
//
// Keeping the scope set and the token/request lifetimes in one module lets the
// OAuth provider, the personal-token store and the MCP resource server agree on
// exactly what a token is allowed to do and for how long.

/**
 * One coarse scope is enough for the current tool surface: every account MCP
 * tool reads/writes only the authenticated account's own scenes. Unsupported
 * scopes requested by a client are rejected explicitly (`invalid_scope`) rather
 * than silently dropped.
 */
export const SUPPORTED_SCOPES = Object.freeze(['imstage.scenes']);

/** The scope the /api/mcp resource server requires on every call. */
export const REQUIRED_SCOPE = 'imstage.scenes';

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

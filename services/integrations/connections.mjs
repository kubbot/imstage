// Account-owned connections: personal access tokens + the account view of
// OAuth grant families.
//
// A "connection" is one grant family (`oauth_grants` row): either an OAuth
// authorization or a user-created personal token. Deleting a connection removes
// the family and every access/refresh token in it, so a deleted connection can
// never authenticate again. Every statement is scoped by `user_id`.
//
// Personal tokens:
//   - server-generated 32-byte opaque secret, returned exactly once
//   - only the SHA-256 hash is persisted; the plaintext is never stored/logged
//   - bounded lifetime (default 90 days)
//   - read/write scope on the caller's own scenes

import { SUPPORTED_SCOPES as SCOPES } from './scopes.mjs';
import {
  dateISO,
  newOpaqueId,
  newOpaqueToken,
  sha256Hex,
  withTransaction,
} from './util.mjs';
import { integrationError } from './errors.mjs';

export const PERSONAL_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const PERSONAL_TOKEN_NAME_MAX = 60;
export const MAX_CONNECTIONS_PER_USER = 100;

/** Stable scope set shared by OAuth grants and personal tokens. */
export const SUPPORTED_SCOPES = SCOPES;

export function validateTokenName(raw) {
  if (typeof raw !== 'string') {
    throw integrationError(400, 'invalid_request', 'name 必须是字符串');
  }
  const name = raw.trim();
  if (name.length < 1 || name.length > PERSONAL_TOKEN_NAME_MAX) {
    throw integrationError(400, 'invalid_name', `名称长度需为 1-${PERSONAL_TOKEN_NAME_MAX} 个字符`);
  }
  return name;
}

/**
 * Connection lifecycle status shown to the account owner.
 *
 * `awaiting_auth`  the grant exists but no token has ever been validated
 * `authenticated`  a token was validated (touchGrant), tools not discovered yet
 * `connected`      `tools/list` succeeded against this grant
 *
 * `last_used_at` alone is only token validation, so it must never be presented
 * as a working client connection.
 */
export const CONNECTION_STATUS = Object.freeze({
  AWAITING_AUTH: 'awaiting_auth',
  AUTHENTICATED: 'authenticated',
  CONNECTED: 'connected',
});

export function connectionItemFromRow(row) {
  const lastUsedAt = row.last_used_at ?? null;
  const toolsDiscoveredAt = row.tools_discovered_at ?? null;
  const status = toolsDiscoveredAt
    ? CONNECTION_STATUS.CONNECTED
    : lastUsedAt
      ? CONNECTION_STATUS.AUTHENTICATED
      : CONNECTION_STATUS.AWAITING_AUTH;
  return {
    id: row.id,
    clientName: row.client_name,
    createdAt: row.created_at,
    lastUsedAt,
    toolsDiscoveredAt,
    status,
    scopes: JSON.parse(row.scopes_json || '[]'),
    kind: row.source === 'token' ? 'token' : 'oauth',
  };
}

export function listConnections(db, userId) {
  const rows = db
    .prepare(
      `SELECT id, source, client_name, scopes_json, created_at, last_used_at, tools_discovered_at
       FROM oauth_grants
       WHERE user_id = ? AND revoked_at IS NULL
       ORDER BY created_at DESC, id ASC`,
    )
    .all(userId);
  return rows.map(connectionItemFromRow);
}

export function getConnectionRow(db, userId, grantId) {
  if (typeof grantId !== 'string' || grantId.length < 1 || grantId.length > 128) return null;
  return db
    .prepare('SELECT * FROM oauth_grants WHERE user_id = ? AND id = ?')
    .get(userId, grantId);
}

function insertGrant(db, { id, userId, source, clientId, clientName, resource, scopes, nowMs }) {
  db.prepare(
    `INSERT INTO oauth_grants
       (id, user_id, source, client_id, client_name, resource, scopes_json, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(
    id,
    userId,
    source,
    clientId ?? null,
    clientName,
    resource ?? null,
    JSON.stringify(scopes),
    dateISO(nowMs),
  );
}

function insertToken(db, { tokenHash, grantId, userId, kind, clientId, expiresAtMs, nowMs }) {
  db.prepare(
    `INSERT INTO oauth_tokens
       (token_hash, grant_id, user_id, kind, client_id, expires_at_ms, created_at, revoked_at, rotated_at, replaced_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(tokenHash, grantId, userId, kind, clientId ?? null, expiresAtMs, dateISO(nowMs));
}

export function countActiveConnections(db, userId) {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM oauth_grants WHERE user_id = ? AND revoked_at IS NULL')
    .get(userId);
  return Number(row.total);
}

/**
 * Create a personal access token connection. Returns the plaintext token once;
 * only its hash is stored.
 */
export function createPersonalToken(db, { userId, name, resource, nowMs, ttlMs = PERSONAL_TOKEN_TTL_MS }) {
  if (countActiveConnections(db, userId) >= MAX_CONNECTIONS_PER_USER) {
    throw integrationError(429, 'connection_limit_reached', `最多允许 ${MAX_CONNECTIONS_PER_USER} 个连接`);
  }
  const token = newOpaqueToken();
  const tokenHash = sha256Hex(token);
  const grantId = newOpaqueId('con_');
  const expiresAtMs = nowMs + ttlMs;
  withTransaction(db, () => {
    insertGrant(db, {
      id: grantId,
      userId,
      source: 'token',
      clientId: null,
      clientName: name,
      resource,
      scopes: SUPPORTED_SCOPES,
      nowMs,
    });
    insertToken(db, {
      tokenHash,
      grantId,
      userId,
      kind: 'access',
      clientId: null,
      expiresAtMs,
      nowMs,
    });
  });
  const row = getConnectionRow(db, userId, grantId);
  return { token, connection: connectionItemFromRow(row) };
}

/**
 * Delete one connection and immediately invalidate every token in its family.
 * Owner-scoped: a foreign or unknown id returns `false` (the API maps it to 404).
 */
export function deleteConnection(db, userId, grantId) {
  return withTransaction(db, () => {
    const row = db
      .prepare('SELECT id FROM oauth_grants WHERE user_id = ? AND id = ?')
      .get(userId, grantId);
    if (!row) return false;
    db.prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND grant_id = ?').run(userId, grantId);
    db.prepare('DELETE FROM oauth_grants WHERE user_id = ? AND id = ?').run(userId, grantId);
    return true;
  });
}

/**
 * Revoke every connection family and token for a user, and burn any
 * unredeemed authorization codes / pending consent requests bound to them
 * (e.g. password change). Intentionally does not open its own transaction so
 * callers can run it inside the account API's password-change transaction;
 * statements are idempotent.
 */
export function revokeAllForUser(db, userId) {
  db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM oauth_codes WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM oauth_requests WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM oauth_grants WHERE user_id = ?').run(userId);
}

/* ------------------------------------------------------------------ */
/* Grant family + token primitives shared with the OAuth provider       */
/* ------------------------------------------------------------------ */

export function newGrantId() {
  return newOpaqueId('con_');
}

export function createGrantFamily(db, { userId, source, clientId, clientName, resource, scopes, nowMs }) {
  const id = newGrantId();
  insertGrant(db, { id, userId, source, clientId, clientName, resource, scopes, nowMs });
  return id;
}

export function issueToken(db, { grantId, userId, kind, clientId, ttlMs, nowMs }) {
  const token = newOpaqueToken();
  insertToken(db, {
    tokenHash: sha256Hex(token),
    grantId,
    userId,
    kind,
    clientId,
    expiresAtMs: nowMs + ttlMs,
    nowMs,
  });
  return token;
}

export function revokeGrant(db, grantId) {
  db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').run(grantId);
  db.prepare('UPDATE oauth_grants SET revoked_at = ? WHERE id = ?').run(dateISO(Date.now()), grantId);
}

export function touchGrant(db, grantId, nowMs) {
  db.prepare('UPDATE oauth_grants SET last_used_at = ? WHERE id = ?').run(dateISO(nowMs), grantId);
}

/**
 * Record evidence of a successful MCP `tools/list` for a grant. Called only
 * after the MCP server actually returned a tool list, never on mere token
 * validation. Owner-scoped and idempotent (keeps the first discovery time).
 *
 * @returns {boolean} whether an active, owned grant was updated
 */
export function markConnectionDiscovery(db, userId, grantId, nowMs) {
  if (typeof userId !== 'string' || userId === '' || typeof grantId !== 'string' || grantId === '') {
    return false;
  }
  const result = db
    .prepare(
      `UPDATE oauth_grants
       SET tools_discovered_at = COALESCE(tools_discovered_at, ?)
       WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    )
    .run(dateISO(nowMs), grantId, userId);
  return Number(result.changes) === 1;
}

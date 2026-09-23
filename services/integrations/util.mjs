// Small shared helpers for the account integration layer.
//
// These intentionally mirror the account API's own helpers (`dateISO`,
// `hashToken`, transaction wrapper) without importing `services/api/server.mjs`,
// which would create a circular import. Behaviour must stay identical:
// timestamps are always UTC ISO strings and transactions use IMMEDIATE.

import crypto from 'node:crypto';

export function dateISO(ms) {
  return new Date(ms).toISOString();
}

export function sha256Hex(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 32 random bytes, URL-safe: 43 characters, same shape as the session token. */
export function newOpaqueToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function newOpaqueId(prefix) {
  return `${prefix}${crypto.randomBytes(24).toString('base64url')}`;
}

export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error wins */
    }
    throw error;
  }
}

export function isUniqueConstraintError(error) {
  return Boolean(
    error &&
      error.code === 'ERR_SQLITE_ERROR' &&
      typeof error.message === 'string' &&
      /UNIQUE constraint failed/i.test(error.message),
  );
}

export function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

#!/usr/bin/env node
/**
 * IMStage — local / self-hosted API server.
 *
 * Scope of this module (see services/api/README.md):
 *   - account registration / login / logout / password change
 *   - opaque server-side sessions stored as token hashes in SQLite
 *   - owned scene persistence with optimistic revisions
 *   - optional static serving of the built web app from `distDir`
 *
 * It intentionally implements no OAuth, no email verification, no password
 * reset, no billing and no CORS. It is not a Vercel/edge backend: it uses
 * `node:sqlite`, `node:crypto` and the native `node:http` server only.
 *
 * Node >= 22.18 is required (native type stripping is used to import the
 * shared scene model from `apps/web/src/studio/model.ts`).
 */

import http from 'node:http';
import { isIP } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { validateScene } from '../../apps/web/src/studio/model.ts';
import { instantiateTemplate } from '../../packages/schema/templates.ts';
import * as projects from '../projects/index.mjs';
import * as contacts from '../contacts/index.mjs';
import {withContactLibrary} from '../contacts/runtime.mjs';
import {
  installTemplateSchema,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  TemplateError,
} from '../templates/store.mjs';
import {
  AGENT_BODY_LIMIT,
  createAgentLimiter,
  createAgentRuntime,
  resolveAgentConfig,
  serializeAgentEvent,
  validateAgentInput,
  writeNdjsonLine,
  finishNdjsonResponse,
} from '../agent/index.mjs';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { installIntegrationSchema } from '../integrations/schema.mjs';
import { IntegrationError } from '../integrations/errors.mjs';
import {
  createPersonalToken,
  deleteConnection,
  listConnections,
  markConnectionDiscovery,
  revokeAllForUser,
  validateTokenName,
} from '../integrations/connections.mjs';
import { createOAuthIntegration } from '../integrations/oauth.mjs';
import { createAccountMcpServer } from '../integrations/account-mcp.mjs';
import { REQUIRED_SCOPE, RECENT_SESSION_MS } from '../integrations/scopes.mjs';
import { createRenderService, resolveChromiumExecutable } from '../mcp/render.mjs';

const scryptAsync = promisify(crypto.scrypt);

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

export const SESSION_COOKIE = 'imstage_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, fixed
export const AUTH_BODY_LIMIT = 16 * 1024; // 16 KiB
export const SCENE_BODY_LIMIT = 16 * 1024 * 1024; // 16 MiB
export const PROJECT_BODY_LIMIT = 64 * 1024; // 64 KiB (name + rules)
export const BATCH_BODY_LIMIT = 16 * 1024 * 1024; // variants may carry bounded embedded images
/** Contact library: 100 contacts plus local avatars; still strictly bounded. */
export const CONTACT_BODY_LIMIT = 12 * 1024 * 1024; // 12 MiB
/** Single source of truth lives in `services/projects/model.mjs`. */
export const MAX_SCENES_PER_USER = projects.MAX_SCENES_PER_USER;
export const REQUEST_MARKER_HEADER = 'x-imstage-request';
export const REQUEST_MARKER_VALUE = '1';

/** OWASP-recommended scrypt work factor: N=2^15, r=8, p=3. */
export const SCRYPT_PARAMS = Object.freeze({
  N: 32768,
  r: 8,
  p: 3,
  keylen: 64,
  maxmem: 64 * 1024 * 1024, // matches `maxmem:64MiB`
});

/**
 * A precomputed hash for an unknown random passphrase. Used to give the
 * "user does not exist" branch exactly the same scrypt cost as a real
 * verification, so login timing never reveals whether an email is registered.
 * The passphrase is random and never stored anywhere.
 */
const DUMMY_PASSWORD_HASH =
  'scrypt$32768$8$3$s0/if6VkGDWwgjnI24Cxrw==$Zle4GroaoUqpVLIMtzk8b/LO0GXbOEIyJtLBVM1jMzSDZRnpMTkhbPRWu/l+ecJ4FSMDXB84MQc2G7BMAFjWhw==';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const AUTH_DEADLINE_MS = 15_000;
const SCENE_DEADLINE_MS = 30_000;
const AGENT_READ_DEADLINE_MS = 30_000;
const CONTACT_READ_DEADLINE_MS = 30_000;

const API_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
});

const STATIC_SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
});

const DEFAULT_RATE_LIMITS = Object.freeze({
  ip: { windowMs: 10 * 60 * 1000, max: 300, maxKeys: 10_000 },
  email: { windowMs: 10 * 60 * 1000, max: 10, maxKeys: 20_000 },
  user: { windowMs: 10 * 60 * 1000, max: 20, maxKeys: 10_000 },
  // Account-owned ChatGPT/MCP connections. Every OAuth endpoint, connection
  // management call and MCP request is bounded per client IP (and the MCP
  // endpoint is additionally bounded by the authenticated account).
  oauth: { windowMs: 10 * 60 * 1000, max: 120, maxKeys: 10_000 },
  oauthToken: { windowMs: 10 * 60 * 1000, max: 180, maxKeys: 10_000 },
  oauthRegister: { windowMs: 60 * 60 * 1000, max: 30, maxKeys: 10_000 },
  connections: { windowMs: 10 * 60 * 1000, max: 60, maxKeys: 20_000 },
  mcp: { windowMs: 10 * 60 * 1000, max: 600, maxKeys: 20_000 },
});

/** Bounds for the account-owned /api/mcp surface. */
export const ACCOUNT_MCP_BODY_LIMIT = 12 * 1024 * 1024; // 12 MiB (scene JSON + inline images)
export const ACCOUNT_MCP_DEADLINE_MS = 60_000;

/* ------------------------------------------------------------------ */
/* Small utilities                                                    */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, code, message, headers = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEmail(value) {
  return String(value).trim().toLowerCase();
}

export function remoteIp(req, trustLoopbackProxy = false) {
  const peer = req.socket?.remoteAddress ?? 'unknown';
  // Opt-in only: the local reverse proxy MUST overwrite X-Real-IP. Never
  // interpret arbitrary forwarding chains or accept this from non-loopback.
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const forwarded = req.headers?.['x-real-ip'];
  if (trustLoopbackProxy && loopback && typeof forwarded === 'string' && isIP(forwarded)) {
    return forwarded;
  }
  return peer;
}

function isUniqueConstraintError(err) {
  return Boolean(
    err &&
      err.code === 'ERR_SQLITE_ERROR' &&
      typeof err.message === 'string' &&
      /UNIQUE constraint failed/i.test(err.message),
  );
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function dateISO(ms) {
  return new Date(ms).toISOString();
}

function isLoopbackHost(host) {
  const value = String(host).trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return (
    value === '127.0.0.1' ||
    value === '::1' ||
    value === '0:0:0:0:0:0:0:1' ||
    value === 'localhost'
  );
}

function normalizeOrigin(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`IMSTAGE_APP_ORIGIN is not a valid URL: ${String(raw)}`);
  }
  if (url.origin === 'null') {
    throw new Error(`IMSTAGE_APP_ORIGIN must be an absolute origin: ${String(raw)}`);
  }
  return url.origin;
}

function parseAbsolutePort(value, fallback) {
  const raw = value === undefined || value === null || value === '' ? fallback : value;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`IMSTAGE_API_PORT must be an integer between 0 and 65535, got: ${String(raw)}`);
  }
  return port;
}

/* ------------------------------------------------------------------ */
/* Password hashing (async scrypt + bounded concurrency)               */
/* ------------------------------------------------------------------ */

function encodePasswordHash(salt, derived) {
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

function decodePasswordHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  let salt;
  let hash;
  try {
    salt = Buffer.from(parts[4], 'base64');
    hash = Buffer.from(parts[5], 'base64');
  } catch {
    return null;
  }
  if (salt.length < 16 || hash.length === 0) return null;
  if (N <= 1 || r <= 0 || p <= 0) return null;
  // Guard against an attacker-controlled stored record requesting absurd work.
  if (N > SCRYPT_PARAMS.N || r > SCRYPT_PARAMS.r || p > SCRYPT_PARAMS.p) return null;
  return { N, r, p, salt, hash };
}

class Semaphore {
  constructor(limit) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : 1;
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    return new Promise((resolve, reject) => {
      if (this.active >= this.limit && this.queue.length >= 16) { reject(new HttpError(429, 'busy', '账号服务繁忙，请稍后重试', { 'Retry-After': '5' })); return; }
      const tryAcquire = () => {
        if (this.active < this.limit) {
          this.active += 1;
          resolve();
          return;
        }
        this.queue.push(tryAcquire);
      };
      tryAcquire();
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

async function hashPassword(password, semaphore) {
  return semaphore.run(async () => {
    const salt = crypto.randomBytes(16);
    const derived = await scryptAsync(Buffer.from(password, 'utf8'), salt, SCRYPT_PARAMS.keylen, {
      N: SCRYPT_PARAMS.N,
      r: SCRYPT_PARAMS.r,
      p: SCRYPT_PARAMS.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    });
    return encodePasswordHash(salt, derived);
  });
}

async function verifyPassword(password, stored, semaphore) {
  const parsed = decodePasswordHash(stored);
  if (!parsed) return false;
  return semaphore.run(async () => {
    const derived = await scryptAsync(Buffer.from(password, 'utf8'), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_PARAMS.maxmem,
    });
    return derived.length === parsed.hash.length && crypto.timingSafeEqual(derived, parsed.hash);
  });
}

/* ------------------------------------------------------------------ */
/* Bounded fixed-window rate limiting                                  */
/* ------------------------------------------------------------------ */

class FixedWindowLimiter {
  constructor({ windowMs, max, maxKeys }) {
    this.windowMs = Math.max(1, Number(windowMs) || 1);
    this.max = Math.max(1, Number(max) || 1);
    this.maxKeys = Math.max(1, Number(maxKeys) || 1);
    this.buckets = new Map();
  }

  consume(key, nowMs) {
    let bucket = this.buckets.get(key);
    if (!bucket || nowMs >= bucket.resetAt) {
      bucket = { count: 0, resetAt: nowMs + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    this.#prune(nowMs);
    if (bucket.count > this.max) {
      return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - nowMs) };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  #prune(nowMs) {
    if (this.buckets.size <= this.maxKeys) return;
    for (const [key, bucket] of this.buckets) {
      if (nowMs >= bucket.resetAt) this.buckets.delete(key);
      if (this.buckets.size <= this.maxKeys) return;
    }
    // Still oversized (all buckets live): drop the oldest inserted keys.
    const excess = this.buckets.size - this.maxKeys;
    let removed = 0;
    for (const key of this.buckets.keys()) {
      if (removed >= excess) break;
      this.buckets.delete(key);
      removed += 1;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort (e.g. exotic filesystems) */
    }
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS scenes (
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      id            TEXT NOT NULL,
      title         TEXT NOT NULL,
      platform      TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      revision      INTEGER NOT NULL,
      scene_json    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_scenes_user_updated ON scenes(user_id, updated_at DESC);
  `);

  // Account-owned ChatGPT/MCP connection tables (OAuth clients, grants, tokens,
  // consent requests, owner-scoped idempotency and PNG cache). Additive only.
  installIntegrationSchema(db);

  // Projects add tables only (no data reset, no scene migration required for
  // existing accounts): scenes associate through `scene_projects`.
  projects.installProjectSchema(db);

  // Account-scoped contact library. Additive migration only; existing accounts
  // simply read the empty default until they PUT a library.
  db.exec(contacts.CONTACT_SCHEMA_SQL);

  // Reusable templates are account-scoped and stored separately from scenes.
  // Additive table only: no scene/project migration or rewrite is performed.
  installTemplateSchema(db);

  if (dbPath !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.chmodSync(`${dbPath}${suffix}`, 0o600);
      } catch {
        /* file may not exist yet */
      }
    }
  }
  return db;
}

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback failure, original error wins */
    }
    throw err;
  }
}

function createSessionRow(db, userId, nowMs) {
  db.prepare('DELETE FROM sessions WHERE expires_at_ms <= ?').run(nowMs);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 19)').run(userId, userId);
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const id = crypto.randomUUID();
  const expiresAtMs = nowMs + SESSION_TTL_MS;
  db.prepare(
    'INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at_ms) VALUES (?, ?, ?, ?, ?)',
  ).run(id, userId, tokenHash, dateISO(nowMs), expiresAtMs);
  return { token, expiresAtMs };
}

function toPublicUser(row) {
  return { id: row.id, email: row.email, name: row.name };
}

/* ------------------------------------------------------------------ */
/* Cookies / sessions                                                  */
/* ------------------------------------------------------------------ */

function readSessionToken(req) {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

function sessionCookieAttributes(config, expiresAtMs) {
  const attributes = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    `Expires=${new Date(expiresAtMs).toUTCString()}`,
  ];
  if (config.secureCookie) attributes.push('Secure');
  return attributes;
}

function setSessionCookie(res, config, token, expiresAtMs) {
  res.setHeader(
    'Set-Cookie',
    [`${SESSION_COOKIE}=${token}`, ...sessionCookieAttributes(config, expiresAtMs)].join('; '),
  );
}

function clearSessionCookie(res, config) {
  const attributes = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (config.secureCookie) attributes.push('Secure');
  res.setHeader('Set-Cookie', [`${SESSION_COOKIE}=`, ...attributes].join('; '));
}

function loadSession(ctx, req) {
  const token = readSessionToken(req);
  if (!token) return null;
  const row = ctx.db
    .prepare(
      `SELECT s.id AS session_id, s.user_id, s.expires_at_ms, s.created_at, u.email, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(hashToken(token));
  if (!row) return null;
  if (Number(row.expires_at_ms) <= ctx.nowMs()) {
    ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
    return null;
  }
  return {
    sessionId: row.session_id,
    user: { id: row.user_id, email: row.email, name: row.name },
    createdAtMs: Date.parse(row.created_at),
  };
}

function requireSession(ctx, req) {
  const session = loadSession(ctx, req);
  if (!session) {
    throw new HttpError(401, 'unauthorized', '请先登录');
  }
  const expectedUser = req.headers['x-imstage-user'];
  if (expectedUser !== undefined && expectedUser !== session.user.id) {
    throw new HttpError(401, 'account_changed', '当前登录账号已改变，请重新打开作品。');
  }
  return session;
}

function recheckSession(ctx, req, expected) {
  if (requireSession(ctx, req).sessionId !== expected.sessionId) throw new HttpError(401, 'unauthorized', '登录已失效，请重新登录');
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function sendJson(req, res, status, body, extraHeaders = undefined) {
  if (res.headersSent) return;
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers = {
    ...API_SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    ...(extraHeaders ?? {}),
  };
  // If the request body was never fully consumed (early auth/origin/limit
  // rejection), the connection cannot be reused safely for another request.
  // Drain the remainder (bounded) so the client can still read this response,
  // then force the socket closed.
  const methodHasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
  if (methodHasBody && !req.readableEnded) {
    headers.Connection = 'close';
    res.once('finish', () => {
      try {
        req.resume();
      } catch {
        /* ignore */
      }
      const timer = setTimeout(() => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      }, 2_000);
      timer.unref?.();
    });
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function drainRequest(req, maxBytes, deadlineMs) {
  return new Promise((resolve) => {
    if (req.readableEnded) {
      resolve();
      return;
    }
    let total = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', finish);
      req.off('error', finish);
      req.off('aborted', finish);
      resolve();
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        finish();
      }
    };
    const timer = setTimeout(() => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      finish();
    }, deadlineMs);
    timer.unref?.();
    req.on('data', onData);
    req.on('end', finish);
    req.on('error', finish);
    req.on('aborted', finish);
    req.resume();
  });
}

async function sendError(req, res, ctx, err) {
  if (res.headersSent) {
    try {
      res.destroy();
    } catch {
      /* ignore */
    }
    return;
  }
  // If we are rejecting before the body was read (bad origin, missing session,
  // too many requests, ...), drain what is in flight first so the client can
  // actually read the error instead of seeing a connection reset.
  const methodHasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
  if (methodHasBody && !req.readableEnded) {
    try {
      await drainRequest(req, SCENE_BODY_LIMIT + 8 * 1024 * 1024, 5_000);
    } catch {
      /* best effort */
    }
  }
  if (res.headersSent) return;
  if (err instanceof HttpError || err instanceof IntegrationError || err instanceof projects.ProjectsError || err instanceof contacts.ContactsError || err instanceof TemplateError) {
    sendJson(req, res, err.status, { error: { code: err.code, message: err.message } }, err.headers);
    return;
  }
  ctx.logger.error('[imstage-api] unexpected error:', err?.stack ?? err);
  sendJson(req, res, 500, { error: { code: 'internal_error', message: '服务器内部错误' } });
}

function requireJsonContentType(req) {
  const raw = req.headers['content-type'];
  const value = typeof raw === 'string' ? raw.split(';')[0].trim().toLowerCase() : '';
  if (value !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', '请求体必须是 application/json');
  }
}

function guardMutation(req, config) {
  const rawOrigin = req.headers.origin;
  if (typeof rawOrigin !== 'string' || rawOrigin.trim() === '') {
    throw new HttpError(403, 'origin_required', '缺少 Origin 请求头');
  }
  let origin;
  try {
    origin = new URL(rawOrigin).origin;
  } catch {
    throw new HttpError(403, 'origin_mismatch', '请求来源不被允许');
  }
  if (origin !== config.appOrigin) {
    throw new HttpError(403, 'origin_mismatch', '请求来源不被允许');
  }
  const marker = req.headers[REQUEST_MARKER_HEADER];
  const markerValue = Array.isArray(marker) ? marker[0] : marker;
  if (markerValue !== REQUEST_MARKER_VALUE) {
    throw new HttpError(403, 'request_marker_required', '缺少必要的请求标记');
  }
}

function readBody(req, limit, deadlineMs) {
  // Bodies up to `limit` are buffered. Bodies above the limit are not stored but
  // are drained up to a hard cap so the client can always read the 413 response;
  // anything above the cap is rejected immediately and the socket is closed.
  const hardCap = limit + 4 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > hardCap) {
      reject(new HttpError(413, 'payload_too_large', '请求体过大'));
      return;
    }

    const chunks = [];
    let total = 0;
    let oversize = false;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };
    const tooLarge = () => new HttpError(413, 'payload_too_large', '请求体过大');
    const onData = (chunk) => {
      total += chunk.length;
      if (total > hardCap) {
        finish(tooLarge());
        return;
      }
      if (total > limit) {
        if (!oversize) {
          oversize = true;
          chunks.length = 0; // stop retaining data once over the limit
        }
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (oversize) finish(tooLarge());
      else finish(null, Buffer.concat(chunks, total));
    };
    const onError = () => finish(new HttpError(400, 'bad_request', '请求读取失败'));
    const onAborted = () => finish(new HttpError(400, 'bad_request', '请求已中断'));

    const timer = setTimeout(
      () => finish(new HttpError(408, 'request_timeout', '请求处理超时')),
      deadlineMs,
    );

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

async function readJsonBody(req, limit, deadlineMs) {
  const buffer = await readBody(req, limit, deadlineMs);
  if (buffer.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new HttpError(400, 'invalid_request', '请求体必须是 JSON 对象');
  }
  return parsed;
}

function rateLimitedError(retryAfterMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new HttpError(429, 'rate_limited', '请求过于频繁，请稍后再试', {
    'Retry-After': String(retryAfterSeconds),
  });
}

function throttleAuth(ctx, req, email) {
  const ip = remoteIp(req, ctx.config.trustLoopbackProxy);
  const ipResult = ctx.limiters.ip.consume(`ip:${ip}`, ctx.nowMs());
  if (!ipResult.allowed) throw rateLimitedError(ipResult.retryAfterMs);
  const emailKey = normalizeEmail(email).slice(0, 254);
  const emailResult = ctx.limiters.email.consume(`email:${emailKey}`, ctx.nowMs());
  if (!emailResult.allowed) throw rateLimitedError(emailResult.retryAfterMs);
}

function throttleUser(ctx, userId) {
  const result = ctx.limiters.user.consume(`user:${userId}`, ctx.nowMs());
  if (!result.allowed) throw rateLimitedError(result.retryAfterMs);
}

/* ------------------------------------------------------------------ */
/* Account validation                                                  */
/* ------------------------------------------------------------------ */

function validateRegistration(body) {
  const { name, email, password } = body;
  if (typeof name !== 'string' || typeof email !== 'string' || typeof password !== 'string') {
    throw new HttpError(400, 'invalid_request', '请完整填写名称、邮箱和密码');
  }
  const trimmedName = name.trim();
  if (trimmedName.length < 1 || trimmedName.length > 60) {
    throw new HttpError(400, 'invalid_name', '名称长度需为 1-60 个字符');
  }
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail.length > 254 || !EMAIL_RE.test(normalizedEmail)) {
    throw new HttpError(400, 'invalid_email', '邮箱格式不正确');
  }
  // Password is intentionally not trimmed and accepts any character set.
  if (password.length < 12 || password.length > 128) {
    throw new HttpError(400, 'invalid_password', '密码长度需为 12-128 个字符');
  }
  return { name: trimmedName, email: normalizedEmail, password };
}

function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new HttpError(400, 'invalid_password', '新密码长度需为 12-128 个字符');
  }
}

function uniformCredentialError() {
  return new HttpError(401, 'invalid_credentials', '邮箱或密码不正确');
}

/* ------------------------------------------------------------------ */
/* Auth routes                                                         */
/* ------------------------------------------------------------------ */

async function handleRegister(ctx, req, res) {
  guardMutation(req, ctx.config);
  requireJsonContentType(req);
  const body = await readJsonBody(req, AUTH_BODY_LIMIT, AUTH_DEADLINE_MS);
  const { name, email, password } = validateRegistration(body);

  throttleAuth(ctx, req, email);

  // Hash before the uniqueness check so duplicate registrations cost the same.
  const passwordHash = await hashPassword(password, ctx.semaphore);
  const nowMs = ctx.nowMs();
  const userId = crypto.randomUUID();

  let sessionToken;
  let sessionExpiresAtMs;
  let user;
  try {
    const result = withTransaction(ctx.db, () => {
      const existing = ctx.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) {
        throw new HttpError(409, 'email_taken', '该邮箱已注册');
      }
      ctx.db
        .prepare(
          'INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(userId, email, name, passwordHash, dateISO(nowMs));
      const session = createSessionRow(ctx.db, userId, nowMs);
      return { user: { id: userId, email, name }, session };
    });
    user = result.user;
    sessionToken = result.session.token;
    sessionExpiresAtMs = result.session.expiresAtMs;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isUniqueConstraintError(err)) {
      throw new HttpError(409, 'email_taken', '该邮箱已注册');
    }
    throw err;
  }

  setSessionCookie(res, ctx.config, sessionToken, sessionExpiresAtMs);
  sendJson(req, res, 200, { user });
}

async function handleLogin(ctx, req, res) {
  guardMutation(req, ctx.config);
  requireJsonContentType(req);
  const body = await readJsonBody(req, AUTH_BODY_LIMIT, AUTH_DEADLINE_MS);
  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    throw new HttpError(400, 'invalid_request', '请输入邮箱和密码');
  }
  const email = normalizeEmail(body.email);
  const password = body.password;

  throttleAuth(ctx, req, email);

  const row = ctx.db
    .prepare('SELECT id, email, name, password_hash FROM users WHERE email = ?')
    .get(email);
  // Always pay one scrypt verification, even for unknown accounts.
  const ok = await verifyPassword(password, row ? row.password_hash : DUMMY_PASSWORD_HASH, ctx.semaphore);
  if (!row || !ok) throw uniformCredentialError();

  // A concurrent password change must not allow the old credential to create a new session.
  const current = ctx.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(row.id);
  if (current?.password_hash !== row.password_hash) throw uniformCredentialError();
  const nowMs = ctx.nowMs();
  const { token, expiresAtMs } = createSessionRow(ctx.db, row.id, nowMs);
  setSessionCookie(res, ctx.config, token, expiresAtMs);
  sendJson(req, res, 200, { user: toPublicUser(row) });
}

async function handleLogout(ctx, req, res) {
  guardMutation(req, ctx.config);
  requireJsonContentType(req);
  await readJsonBody(req, AUTH_BODY_LIMIT, AUTH_DEADLINE_MS);

  if (loadSession(ctx, req)) requireSession(ctx, req);
  const token = readSessionToken(req);
  if (token) {
    ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  clearSessionCookie(res, ctx.config);
  sendJson(req, res, 200, { ok: true });
}

async function handlePasswordChange(ctx, req, res) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, AUTH_BODY_LIMIT, AUTH_DEADLINE_MS);

  if (typeof body.currentPassword !== 'string') {
    throw new HttpError(400, 'invalid_request', '请输入当前密码');
  }
  validateNewPassword(body.newPassword);

  throttleUser(ctx, session.user.id);

  const row = ctx.db
    .prepare('SELECT password_hash FROM users WHERE id = ?')
    .get(session.user.id);
  const ok = await verifyPassword(body.currentPassword, row?.password_hash, ctx.semaphore);
  if (!row || !ok) {
    throw new HttpError(401, 'invalid_credentials', '当前密码不正确');
  }

  const newHash = await hashPassword(body.newPassword, ctx.semaphore);
  withTransaction(ctx.db, () => {
    recheckSession(ctx, req, session);
    const result = ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?').run(newHash, session.user.id, row.password_hash);
    if (result.changes !== 1) throw new HttpError(409, 'password_changed', '密码已经改变，请重新登录');
    // Revoke every session, including the caller's: re-login is required.
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(session.user.id);
    // Changing the password also revokes every ChatGPT/MCP connection and
    // token for this account, so old credentials can never keep API access.
    revokeAllForUser(ctx.db, session.user.id);
  });

  clearSessionCookie(res, ctx.config);
  sendJson(req, res, 200, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Scene routes                                                        */
/* ------------------------------------------------------------------ */

function parseSceneId(raw) {
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const normalized = decoded.toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

function sceneItemFromRow(row) {
  return {
    id: row.id,
    scene: JSON.parse(row.scene_json),
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

function handleSceneList(ctx, req, res) {
  const session = requireSession(ctx, req);
  const rows = ctx.db
    .prepare(
      `SELECT id, title, platform, message_count, revision, updated_at
       FROM scenes WHERE user_id = ?
       ORDER BY updated_at DESC, id ASC`,
    )
    .all(session.user.id);
  const items = rows.map((row) => ({
    id: row.id,
    title: row.title,
    platform: row.platform,
    messageCount: Number(row.message_count),
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  }));
  sendJson(req, res, 200, { items });
}

function handleSceneGet(ctx, req, res, sceneId) {
  const session = requireSession(ctx, req);
  const row = ctx.db
    .prepare('SELECT id, scene_json, revision, updated_at FROM scenes WHERE user_id = ? AND id = ?')
    .get(session.user.id, sceneId);
  if (!row) throw new HttpError(404, 'not_found', '场景不存在');
  sendJson(req, res, 200, { item: {...sceneItemFromRow(row),projectIds:ctx.db.prepare('SELECT project_id FROM scene_projects WHERE user_id=? AND scene_id=?').all(session.user.id,sceneId).map(r=>r.project_id)} });
}

async function handleScenePut(ctx, req, res, sceneId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, SCENE_BODY_LIMIT, SCENE_DEADLINE_MS);

  const revision = body.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new HttpError(400, 'invalid_revision', 'revision 必须是不小于 0 的整数');
  }

  const validation = validateScene(body.scene);
  if (!validation.ok || !validation.scene) {
    const detail = validation.errors.slice(0, 3).join('；');
    throw new HttpError(
      400,
      'validation_error',
      detail ? `场景数据无效：${detail}` : '场景数据无效',
    );
  }
  const projectId=body.projectId ? projects.validateProjectId(body.projectId) : null;
  if(projectId&&!projects.getProjectContext(ctx.db,session.user.id,projectId))throw new HttpError(404,'not_found','项目不存在');
  const attach=()=>{if(body.projectId === '')ctx.db.prepare('DELETE FROM scene_projects WHERE user_id=? AND scene_id=?').run(session.user.id,sceneId);else if(projectId)ctx.db.prepare('INSERT INTO scene_projects(user_id,scene_id,project_id,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,scene_id) DO UPDATE SET project_id=excluded.project_id').run(session.user.id,sceneId,projectId,dateISO(ctx.nowMs()));};
  const scene = validation.scene;
  if (scene.id.toLowerCase() !== sceneId) {
    throw new HttpError(400, 'invalid_request', '场景 id 与请求路径不一致');
  }
  scene.id = sceneId;

  const nowMs = ctx.nowMs();
  const updatedAt = dateISO(nowMs);
  const sceneJson = JSON.stringify(scene);
  const messageCount = scene.messages.length;
  const userId = session.user.id;

  const item = withTransaction(ctx.db, () => {
    recheckSession(ctx, req, session);
    if (revision === 0) {
      const existing = ctx.db
        .prepare('SELECT revision FROM scenes WHERE user_id = ? AND id = ?')
        .get(userId, sceneId);
      if (existing) {
        throw new HttpError(409, 'conflict', '场景已存在，请重新加载');
      }
      const count = ctx.db
        .prepare('SELECT COUNT(*) AS total FROM scenes WHERE user_id = ?')
        .get(userId);
      if (Number(count.total) >= MAX_SCENES_PER_USER) {
        throw new HttpError(409, 'scene_limit_reached', `每个用户最多保存 ${MAX_SCENES_PER_USER} 个场景`);
      }
      try {
        ctx.db
          .prepare(
            `INSERT INTO scenes (user_id, id, title, platform, message_count, revision, scene_json, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(userId, sceneId, scene.title, scene.platform, messageCount, sceneJson, updatedAt);
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          throw new HttpError(409, 'conflict', '场景已存在，请重新加载');
        }
        throw err;
      }
      attach();
      return { id: sceneId, scene, updatedAt, revision: 1 };
    }

    const result = ctx.db
      .prepare(
        `UPDATE scenes
         SET title = ?, platform = ?, message_count = ?, revision = revision + 1, scene_json = ?, updated_at = ?
         WHERE user_id = ? AND id = ? AND revision = ?`,
      )
      .run(scene.title, scene.platform, messageCount, sceneJson, updatedAt, userId, sceneId, revision);

    if (result.changes === 0) {
      const exists = ctx.db
        .prepare('SELECT revision FROM scenes WHERE user_id = ? AND id = ?')
        .get(userId, sceneId);
      if (exists) {
        throw new HttpError(409, 'revision_conflict', '场景已更新，请刷新后重试');
      }
      throw new HttpError(404, 'not_found', '场景不存在');
    }

    attach();
    return { id: sceneId, scene, updatedAt, revision: revision + 1 };
  });

  sendJson(req, res, 200, { item });
}

async function handleSceneDelete(ctx, req, res, sceneId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, AUTH_BODY_LIMIT, AUTH_DEADLINE_MS);

  const revision = body.revision;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new HttpError(400, 'invalid_revision', 'revision 必须是不小于 0 的整数');
  }

  const userId = session.user.id;
  const result = withTransaction(ctx.db, () => {
    recheckSession(ctx, req, session);
    const row = ctx.db
      .prepare('SELECT revision FROM scenes WHERE user_id = ? AND id = ?')
      .get(userId, sceneId);
    if (!row) throw new HttpError(404, 'not_found', '场景不存在');
    if (Number(row.revision) !== revision) {
      throw new HttpError(409, 'revision_conflict', '场景已更新，请刷新后重试');
    }
    return ctx.db.prepare('DELETE FROM scenes WHERE user_id = ? AND id = ?').run(userId, sceneId);
  });
  if (result.changes === 0) throw new HttpError(404, 'not_found', '场景不存在');
  sendJson(req, res, 200, { ok: true });
}

/* ------------------------------------------------------------------ */
/* Contact library routes                                              */
/* ------------------------------------------------------------------ */

function contactLibraryPayload(state) {
  return {
    revision: state.revision,
    contacts: state.contacts,
    selfContactId: state.selfContactId,
    autoSave: state.autoSave,
  };
}

function handleContactLibraryGet(ctx, req, res) {
  const session = requireSession(ctx, req);
  const state = contacts.getContactLibrary(ctx.db, session.user.id);
  sendJson(req, res, 200, contactLibraryPayload(state));
}

async function handleContactLibraryPut(ctx, req, res) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, CONTACT_BODY_LIMIT, CONTACT_READ_DEADLINE_MS);
  // Structural bounds first (cheap), then actually decode every avatar with
  // sharp before anything is written. `X-IMStage-User` is rechecked after the
  // async decode so a concurrent account switch can never write the wrong row.
  const input = contacts.normalizeContactLibraryInput(body);
  await contacts.validateContactAvatars(input.contacts,{trustedAvatars:new Set(contacts.getContactLibrary(ctx.db,session.user.id).contacts.map(c=>c.avatar))});
  recheckSession(ctx, req, session);
  const state = contacts.putContactLibrary(ctx.db, {
    userId: session.user.id,
    revision: input.revision,
    contacts: input.contacts,
    selfContactId: input.selfContactId,
    autoSave: input.autoSave,
    nowMs: ctx.nowMs(),
  });
  sendJson(req, res, 200, contactLibraryPayload(state));
}

/* ------------------------------------------------------------------ */
/* Project routes                                                      */
/* ------------------------------------------------------------------ */

function handleProjectList(ctx, req, res) {
  const session = requireSession(ctx, req);
  const items = projects.listProjects(ctx.db, session.user.id);
  sendJson(req, res, 200, { items });
}

async function handleProjectCreate(ctx, req, res) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, PROJECT_BODY_LIMIT, AUTH_DEADLINE_MS);
  const name = projects.validateProjectName(body.name);
  const rules = projects.validateProjectRules(body.rules, '');
  const platform = projects.validateProjectPlatform(body.platform, projects.DEFAULT_PROJECT_PLATFORM);
  recheckSession(ctx, req, session);
  const item = projects.createProject(ctx.db, {
    userId: session.user.id,
    projectId: crypto.randomUUID(),
    name,
    rules,
    platform,
    nowMs: ctx.nowMs(),
  });
  sendJson(req, res, 200, { item });
}

function handleProjectGet(ctx, req, res, projectId) {
  const session = requireSession(ctx, req);
  const item = projects.getProjectItem(ctx.db, session.user.id, projectId);
  if (!item) throw new HttpError(404, 'not_found', '项目不存在');
  const scenes = projects.listProjectScenes(ctx.db, session.user.id, projectId);
  sendJson(req, res, 200, { item, scenes });
}

async function handleProjectUpdate(ctx, req, res, projectId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, PROJECT_BODY_LIMIT, AUTH_DEADLINE_MS);
  const revision = projects.parseRevision(body.revision);
  const existing = projects.getProjectRow(ctx.db, session.user.id, projectId);
  if (!existing) throw new HttpError(404, 'not_found', '项目不存在');
  const name = body.name === undefined ? existing.name : projects.validateProjectName(body.name);
  const rules = body.rules === undefined
    ? existing.rules
    : projects.validateProjectRules(body.rules, existing.rules);
  const platform = body.platform === undefined
    ? existing.platform
    : projects.validateProjectPlatform(body.platform, existing.platform);
  recheckSession(ctx, req, session);
  const item = projects.updateProject(ctx.db, {
    userId: session.user.id,
    projectId,
    name,
    rules,
    platform,
    revision,
    nowMs: ctx.nowMs(),
  });
  sendJson(req, res, 200, { item });
}

async function handleProjectDelete(ctx, req, res, projectId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, PROJECT_BODY_LIMIT, AUTH_DEADLINE_MS);
  const revision = projects.parseRevision(body.revision);
  const activeJobs = ctx.db
    .prepare(
      "SELECT id FROM batch_jobs WHERE user_id = ? AND project_id = ? AND status IN ('queued', 'running')",
    )
    .all(session.user.id, projectId);
  recheckSession(ctx, req, session);
  const result = projects.deleteProject(ctx.db, {
    userId: session.user.id,
    projectId,
    revision,
    nowMs: ctx.nowMs(),
  });
  for (const job of activeJobs) ctx.projects.queue.cancel(job.id);
  sendJson(req, res, 200, { ok: true, detachedScenes: result.detachedScenes });
}

async function handleProjectAttachScene(ctx, req, res, projectId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, PROJECT_BODY_LIMIT, AUTH_DEADLINE_MS);
  const sceneId = typeof body.sceneId === 'string' ? parseSceneId(body.sceneId) : null;
  if (!sceneId) throw new HttpError(400, 'invalid_scene_id', 'sceneId 无效');
  recheckSession(ctx, req, session);
  const result = projects.attachScene(ctx.db, {
    userId: session.user.id,
    projectId,
    sceneId,
    nowMs: ctx.nowMs(),
  });
  sendJson(req, res, 200, { ok: true, alreadyAttached: result.alreadyAttached });
}

async function handleProjectDetachScene(ctx, req, res, projectId, sceneId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  await readJsonBody(req, PROJECT_BODY_LIMIT, AUTH_DEADLINE_MS);
  recheckSession(ctx, req, session);
  const result = projects.detachScene(ctx.db, {
    userId: session.user.id,
    projectId,
    sceneId,
  });
  sendJson(req, res, 200, { ok: true, detached: result.detached });
}

function handleBatchList(ctx, req, res, projectId) {
  const session = requireSession(ctx, req);
  if (!projects.getProjectContext(ctx.db, session.user.id, projectId)) {
    throw new HttpError(404, 'not_found', '项目不存在');
  }
  const items = projects.listBatchJobs(ctx.db, session.user.id, projectId, 20);
  sendJson(req, res, 200, { items });
}

function handleBatchGet(ctx, req, res, projectId, jobId) {
  const session = requireSession(ctx, req);
  const item = projects.getJobDetail(ctx.db, session.user.id, projectId, jobId);
  if (!item) throw new HttpError(404, 'not_found', '生成任务不存在');
  sendJson(req, res, 200, { item });
}

async function handleBatchCreate(ctx, req, res, projectId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, BATCH_BODY_LIMIT, AUTH_DEADLINE_MS);
  const project = projects.getProjectContext(ctx.db, session.user.id, projectId);
  if (!project) throw new HttpError(404, 'not_found', '项目不存在');
  const clientBatchId = projects.validateClientBatchId(body.clientBatchId);

  // Idempotent submit is resolved *before* current-template/new-job validation:
  // a retried request with the same bounded key returns the job created by the
  // first attempt even if the template was later updated or deleted, so queued
  // frozen work is never lost to a new validation pass.
  if (clientBatchId) {
    const existing = projects.findJobByClientId(ctx.db, session.user.id, projectId, clientBatchId);
    if (existing) {
      sendJson(req, res, 200, { item: projects.jobDetail(ctx.db, existing), deduplicated: true });
      return;
    }
  }

  const tasks = projects.buildBatchTasks(body, project.platform);

  // Freeze an optional reusable template and validate every item's variables
  // against it *before* any job/task row is written.
  let template = null;
  const rawTemplateId = body.templateId;
  if (rawTemplateId !== undefined && rawTemplateId !== null && rawTemplateId !== '') {
    const detail = getTemplate(ctx.db, session.user.id, rawTemplateId);
    if (body.templateRevision !== undefined && body.templateRevision !== null) {
      if (!Number.isSafeInteger(body.templateRevision) || body.templateRevision < 1) {
        throw new HttpError(400, 'invalid_revision', 'templateRevision 必须是正整数');
      }
      if (body.templateRevision !== detail.revision) {
        throw new HttpError(409, 'revision_conflict', '模板已更新，请刷新后重新提交');
      }
    }
    for (const task of tasks) {
      const values = task.values ?? {};
      if (Object.keys(values).length === 0) continue;
      const checked = instantiateTemplate(detail.definition, values, crypto.randomUUID());
      if (!checked.ok) {
        throw new HttpError(400, 'invalid_values', `变体「${task.name || task.prompt.slice(0, 20)}」的变量不合法：${checked.errors.slice(0, 3).join('；')}`);
      }
    }
    // A screenshot-reference template renders the source image and its edit
    // layer; it cannot be converted to another platform by switching labels.
    const sourcePlatform = detail.definition.scene.reference?.plan?.im;
    if (sourcePlatform && tasks.some((task) => task.platform !== sourcePlatform)) {
      throw new HttpError(400, 'reference_platform_mismatch', `保留原截图的模板只能使用源平台（${sourcePlatform}）生成，不能切换到其他平台。`);
    }
    template = { id: detail.id, revision: detail.revision, definition: detail.definition };
  } else if (tasks.some((task) => Object.keys(task.values ?? {}).length > 0)) {
    throw new HttpError(400, 'invalid_variants', '提供变量值时必须同时指定 templateId');
  }

  if (!ctx.agent.runtime.capabilities.configured) {
    throw new HttpError(503, 'ai_not_configured', 'AI 服务尚未配置，无法运行批量生成');
  }

  if (projects.countActiveJobs(ctx.db, session.user.id) >= projects.MAX_ACTIVE_BATCH_JOBS) {
    throw new HttpError(429, 'batch_limit_reached', '同时进行的批量生成任务过多，请等待或取消后再试');
  }

  recheckSession(ctx, req, session);
  let job;
  try {
    job = projects.createBatchJob(ctx.db, {
      userId: session.user.id,
      projectId,
      sessionId: session.sessionId,
      rules: project.rules,
      tasks,
      clientBatchId,
      template,
      nowMs: ctx.nowMs(),
    });
  } catch (err) {
    if (clientBatchId && isUniqueConstraintError(err)) {
      const existing = projects.findJobByClientId(ctx.db, session.user.id, projectId, clientBatchId);
      if (existing) {
        sendJson(req, res, 200, { item: projects.jobDetail(ctx.db, existing), deduplicated: true });
        return;
      }
    }
    throw err;
  }
  ctx.projects.queue.start();
  ctx.projects.queue.wake();
  sendJson(req, res, 200, { item: job, deduplicated: false });
}

async function handleBatchCancel(ctx, req, res, projectId, jobId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  await readJsonBody(req, PROJECT_BODY_LIMIT, AUTH_DEADLINE_MS);
  recheckSession(ctx, req, session);
  const item = projects.markJobCancelRequested(ctx.db, {
    userId: session.user.id,
    projectId,
    jobId,
    reason: '用户已取消',
    nowMs: ctx.nowMs(),
  });
  ctx.projects.queue.cancel(jobId);
  sendJson(req, res, 200, { item });
}

async function handleBatchRetry(ctx, req, res, projectId, jobId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  await readJsonBody(req, PROJECT_BODY_LIMIT, AUTH_DEADLINE_MS);
  const existing = projects.getJobRow(ctx.db, session.user.id, projectId, jobId);
  if (!existing) throw new HttpError(404, 'not_found', '生成任务不存在');
  if (!ctx.agent.runtime.capabilities.configured) {
    throw new HttpError(503, 'ai_not_configured', 'AI 服务尚未配置，无法运行批量生成');
  }
  const priorRetry=projects.findJobByClientId(ctx.db,session.user.id,projectId,'retry-'+jobId);
  if(priorRetry){recheckSession(ctx,req,session);sendJson(req,res,200,{item:projects.jobDetail(ctx.db,priorRetry)});return;}
  if (projects.countActiveJobs(ctx.db, session.user.id) >= projects.MAX_ACTIVE_BATCH_JOBS) {
    throw new HttpError(429, 'batch_limit_reached', '同时进行的批量生成任务过多，请等待或取消后再试');
  }
  recheckSession(ctx, req, session);
  const item = projects.createRetryJob(ctx.db, {
    userId: session.user.id,
    projectId,
    jobId,
    sessionId: session.sessionId,
    nowMs: ctx.nowMs(),
  });
  ctx.projects.queue.start();
  ctx.projects.queue.wake();
  sendJson(req, res, 200, { item });
}

/* ------------------------------------------------------------------ */
/* Template routes                                                     */
/* ------------------------------------------------------------------ */

function templateDefinitionFrom(body) {
  if (body.template !== undefined) return body.template;
  const rest = { ...body };
  delete rest.revision;
  return rest;
}

function handleTemplateList(ctx, req, res) {
  const session = requireSession(ctx, req);
  sendJson(req, res, 200, { items: listTemplates(ctx.db, session.user.id) });
}

function handleTemplateGet(ctx, req, res, templateId) {
  const session = requireSession(ctx, req);
  sendJson(req, res, 200, { item: getTemplate(ctx.db, session.user.id, templateId) });
}

async function handleTemplateCreate(ctx, req, res) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, SCENE_BODY_LIMIT, SCENE_DEADLINE_MS);
  const definition = templateDefinitionFrom(body);
  recheckSession(ctx, req, session);
  const item = createTemplate(ctx.db, session.user.id, definition);
  sendJson(req, res, 200, { item });
}

async function handleTemplateUpdate(ctx, req, res, templateId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, SCENE_BODY_LIMIT, SCENE_DEADLINE_MS);
  const definition = templateDefinitionFrom(body);
  recheckSession(ctx, req, session);
  const item = updateTemplate(ctx.db, session.user.id, templateId, body.revision, definition);
  sendJson(req, res, 200, { item });
}

async function handleTemplateDelete(ctx, req, res, templateId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, AUTH_BODY_LIMIT, AUTH_DEADLINE_MS);
  recheckSession(ctx, req, session);
  const result = deleteTemplate(ctx.db, session.user.id, templateId, body.revision);
  sendJson(req, res, 200, { ok: true, id: result.id });
}

async function handleTemplateInstantiate(ctx, req, res, templateId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, SCENE_BODY_LIMIT, SCENE_DEADLINE_MS);
  recheckSession(ctx, req, session);
  // Ownership is checked by the owner-scoped store read; a foreign id never
  // leaks and instantiating never writes the template or a cloud scene.
  const detail = getTemplate(ctx.db, session.user.id, templateId);
  const result = instantiateTemplate(detail.definition, body.values ?? {}, crypto.randomUUID());
  if (!result.ok) {
    throw new HttpError(400, 'invalid_values', `变量不合法：${result.errors.slice(0, 3).join('；')}`);
  }
  sendJson(req, res, 200, { scene: result.value, templateId: detail.id, templateRevision: detail.revision, mode: detail.mode });
}

/* ------------------------------------------------------------------ */
/* Agent routes                                                        */
/* ------------------------------------------------------------------ */

/**
 * Stream a bounded tool-calling agent run as NDJSON.
 *
 * The response is only switched to NDJSON after auth, CSRF, input validation
 * and the concurrency/rate leases have all succeeded, so early failures stay
 * regular JSON errors. The lease is always released (finish, error or client
 * disconnect) and the in-flight provider call is cancelled on disconnect.
 */
async function handleAgentRun(ctx, req, res) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, AGENT_BODY_LIMIT, AGENT_READ_DEADLINE_MS);
  // The session may have been revoked or replaced while the body was read.
  recheckSession(ctx, req, session);

  const validation = validateAgentInput(body);
  if (!validation.ok) {
    throw new HttpError(400, validation.code, validation.message);
  }
  const input = validation.value;

  // Optional project context. Rules are loaded server-side from a project that
  // belongs to the caller, so an Agent prompt can never borrow another
  // account's (or another project's) rules. The user prompt length was already
  // validated above; the project rules are appended as a separate block.
  if (body.projectId !== undefined && body.projectId !== null && body.projectId !== '') {
    const projectId = projects.validateProjectId(body.projectId);
    const context = projects.getProjectContext(ctx.db, session.user.id, projectId);
    if (!context) throw new HttpError(404, 'not_found', '项目不存在');
    if (typeof context.rules === 'string' && context.rules.trim() !== '') {
      input.prompt = projects.buildTaskPrompt(context.rules, input.prompt);
    }
  }

  const runtime = ctx.agent.runtime;
  if (!runtime.capabilities.configured) {
    throw new HttpError(503, 'ai_not_configured', 'AI 服务尚未配置，无法运行 Agent');
  }

  const lease = ctx.agent.limiter.tryStart(session.user.id, ctx.nowMs());
  if (!lease.ok) throw rateLimitedError(lease.retryAfterMs);

  const controller = new AbortController();
  const onClientClose = () => controller.abort();
  res.on('close', onClientClose);

  // Absolute whole-run deadline: registered before the run starts so it also
  // bounds the very first emit and every backpressure wait. On expiry every
  // pending write wait aborts, the socket is finished/destroyed boundedly and
  // the active lease is always released below.
  const deadlineMs = ctx.agent.config.deadlineMs;
  const deadlineMessage = `生成超过 ${Math.max(1, Math.ceil(deadlineMs / 1000))} 秒上限，已停止。`;
  let deadlineHit = false;
  const deadlineTimer = setTimeout(() => {
    deadlineHit = true;
    controller.abort();
  }, deadlineMs);

  try {
    res.writeHead(200, {
      ...API_SECURITY_HEADERS,
      'Content-Type': 'application/x-ndjson; charset=utf-8',
    });

    const writeEvent = (event) =>
      writeNdjsonLine(res, serializeAgentEvent(event), controller.signal, { deadlineMessage });

    await runtime.run({
      ...input,
      signal: controller.signal,
      onEvent: writeEvent,
      userId: session.user.id,
    });
  } finally {
    clearTimeout(deadlineTimer);
    res.off('close', onClientClose);
    lease.release();
    finishNdjsonResponse(res, {
      deadlineHit,
      timeoutLine: deadlineHit
        ? serializeAgentEvent({ type: 'error', message: deadlineMessage })
        : undefined,
      destroyDelayMs: 500,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Account ChatGPT/MCP connections                                     */
/* ------------------------------------------------------------------ */

function throttleBucket(ctx, limiterName, key) {
  const result = ctx.limiters[limiterName].consume(key, ctx.nowMs());
  if (!result.allowed) throw rateLimitedError(result.retryAfterMs);
}

function connectionIpKey(ctx, req, limiterName) {
  return `${limiterName}:${remoteIp(req, ctx.config.trustLoopbackProxy)}`;
}

/**
 * Public connection bootstrap. The advertised URL is derived *only* from the
 * configured `appOrigin`; the request `Host` header is never trusted, so a
 * spoofed Host can never change the discovery document.
 */
function handleConnectionsConfig(ctx, req, res) {
  sendJson(req, res, 200, {
    mcpUrl: `${ctx.config.appOrigin}/api/mcp`,
    authorizationSupported: true,
    directoryUrl: null,
    manualSetupRequired: true,
    // RFC 8252 native-app loopback redirects are supported in every
    // environment by default; the UI uses this to offer the Codex CLI flow
    // truthfully and to fall back to a personal token when disabled.
    loopbackRedirectsSupported: ctx.config.allowLoopbackRedirects === true,
  });
}

function handleConnectionsList(ctx, req, res) {
  const session = requireSession(ctx, req);
  sendJson(req, res, 200, { items: listConnections(ctx.db, session.user.id) });
}

async function handleConnectionTokenCreate(ctx, req, res) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, AUTH_BODY_LIMIT, AUTH_DEADLINE_MS);
  const name = validateTokenName(body.name);
  throttleBucket(ctx, 'connections', `connections:${session.user.id}`);
  recheckSession(ctx, req, session);
  const { token, connection } = createPersonalToken(ctx.db, {
    userId: session.user.id,
    name,
    resource: ctx.oauth.resourceUrl.href,
    nowMs: ctx.nowMs(),
  });
  // The plaintext token is returned exactly once and never logged or stored.
  sendJson(req, res, 200, { token, connection });
}

async function handleConnectionDelete(ctx, req, res, grantId) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  await readJsonBody(req, AUTH_BODY_LIMIT, AUTH_DEADLINE_MS);
  throttleBucket(ctx, 'connections', `connections:${session.user.id}`);
  recheckSession(ctx, req, session);
  const deleted = deleteConnection(ctx.db, session.user.id, grantId);
  if (!deleted) throw new HttpError(404, 'not_found', '连接不存在');
  sendJson(req, res, 200, { ok: true });
}

function handleOauthConsentGet(ctx, req, res, requestId) {
  const session = requireSession(ctx, req);
  throttleBucket(ctx, 'connections', connectionIpKey(ctx, req, 'connections'));
  const consent = ctx.oauth.getConsent({
    requestId,
    userId: session.user.id,
    recheck: () => recheckSession(ctx, req, session),
  });
  sendJson(req, res, 200, consent);
}

async function handleOauthConsentPost(ctx, req, res) {
  guardMutation(req, ctx.config);
  const session = requireSession(ctx, req);
  requireJsonContentType(req);
  const body = await readJsonBody(req, AUTH_BODY_LIMIT, AUTH_DEADLINE_MS);
  throttleBucket(ctx, 'connections', `connections:${session.user.id}`);
  const requestId = body.requestId;
  if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 128) {
    throw new HttpError(400, 'invalid_request', 'requestId 无效');
  }
  if (typeof body.approved !== 'boolean') {
    throw new HttpError(400, 'invalid_request', 'approved 必须是布尔值');
  }
  // `decideConsent` re-checks the session inside its transaction so a concurrent
  // account change can never approve for one user while writing another.
  const result = ctx.oauth.decideConsent({
    requestId,
    approved: body.approved,
    session,
    recheck: () => recheckSession(ctx, req, session),
  });
  sendJson(req, res, 200, { redirectUrl: result.redirectUrl });
}

function applyOAuthThrottle(ctx, req, pathname) {
  let limiter = 'oauth';
  if (pathname === '/api/oauth/register') limiter = 'oauthRegister';
  else if (pathname === '/api/oauth/token') limiter = 'oauthToken';
  throttleBucket(ctx, limiter, connectionIpKey(ctx, req, limiter));
}

/* ------------------------------------------------------------------ */
/* Account MCP resource server (/api/mcp)                              */
/* ------------------------------------------------------------------ */

function sendMcpJsonRpcError(req, res, status, code, message, extraHeaders = undefined) {
  if (res.headersSent) return;
  const body = JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
  const headers = {
    ...API_SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Expose-Headers': 'WWW-Authenticate',
    ...(extraHeaders ?? {}),
  };
  // If an unauthenticated POST body was never read, drain it (bounded) so the
  // client can read the 401/403 instead of seeing a connection reset.
  const methodHasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
  if (methodHasBody && !req.readableEnded) {
    headers.Connection = 'close';
    res.once('finish', () => {
      try {
        req.resume();
      } catch {
        /* ignore */
      }
    });
  }
  res.writeHead(status, headers);
  res.end(body);
}

function mcpBearerChallenge(ctx, errorCode, description) {
  const parts = [`Bearer error="${errorCode}"`];
  if (description) parts.push(`error_description="${description}"`);
  parts.push(`resource_metadata="${ctx.oauth.prmUrl}"`);
  parts.push(`scope="${REQUIRED_SCOPE}"`);
  return parts.join(', ');
}

/**
 * Capture a bounded JSON body from a ServerResponse without changing the bytes
 * sent. Used to record MCP tool discovery only after a real successful
 * `tools/list` response, so "connected" is evidence, not an assumption.
 */
function observeJsonResponse(res, onBody) {
  const chunks = [];
  let total = 0;
  const capture = (chunk, encoding) => {
    if (chunk === undefined || chunk === null || total >= 64 * 1024) return;
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    chunks.push(buffer);
    total += buffer.length;
  };
  const originalWrite = res.write;
  const originalEnd = res.end;
  res.write = function write(chunk, encoding, callback) {
    capture(chunk, encoding);
    return originalWrite.call(this, chunk, encoding, callback);
  };
  res.end = function end(chunk, encoding, callback) {
    capture(chunk, encoding);
    return originalEnd.call(this, chunk, encoding, callback);
  };
  res.once('finish', () => {
    if (Number(res.statusCode) >= 400 || total === 0) return;
    try {
      onBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      /* non-JSON or partial body: no discovery evidence */
    }
  });
}

/**
 * Authenticated, owner-scoped MCP endpoint.
 *
 * Every call verifies the bearer access token (issuer/resource/scopes/expiry/
 * revocation), derives the owning account from the token, and only then builds
 * an MCP server whose store and renderer cache are scoped to that account.
 */
async function handleAccountMcp(ctx, req, res) {
  const rawOrigin = req.headers.origin;
  if (typeof rawOrigin === 'string' && rawOrigin.trim() !== '') {
    let origin = null;
    try {
      origin = new URL(rawOrigin).origin;
    } catch {
      origin = null;
    }
    if (origin !== ctx.config.appOrigin) {
      sendMcpJsonRpcError(req, res, 403, -32000, 'origin_not_allowed');
      return;
    }
  }

  throttleBucket(ctx, 'mcp', connectionIpKey(ctx, req, 'mcp'));

  const header = req.headers.authorization;
  let auth = null;
  let presentedToken = null;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) {
      presentedToken = match[1];
      try {
        auth = await ctx.oauth.provider.verifyAccessToken(presentedToken);
      } catch (error) {
        if (!(error instanceof InvalidTokenError)) throw error;
        auth = null;
      }
    }
  }
  if (!auth) {
    sendMcpJsonRpcError(req, res, 401, -32001, 'unauthorized', {
      'WWW-Authenticate': mcpBearerChallenge(ctx, 'invalid_token'),
    });
    return;
  }
  if (!auth.scopes.includes(REQUIRED_SCOPE)) {
    sendMcpJsonRpcError(req, res, 403, -32003, 'insufficient_scope', {
      'WWW-Authenticate': mcpBearerChallenge(ctx, 'insufficient_scope', 'missing scope'),
    });
    return;
  }
  const userId = auth.extra?.userId;
  if (typeof userId !== 'string' || userId === '') {
    sendMcpJsonRpcError(req, res, 401, -32001, 'unauthorized', {
      'WWW-Authenticate': mcpBearerChallenge(ctx, 'invalid_token'),
    });
    return;
  }

  throttleBucket(ctx, 'mcp', `mcp:user:${userId}`);

  let parsedBody;
  if (req.method === 'POST') {
    let raw;
    try {
      raw = await readBody(req, ACCOUNT_MCP_BODY_LIMIT, ACCOUNT_MCP_DEADLINE_MS);
    } catch (error) {
      if (error instanceof HttpError) {
        sendMcpJsonRpcError(req, res, error.status, -32000, error.code);
        return;
      }
      throw error;
    }
    if (raw.length > 0) {
      try {
        parsedBody = JSON.parse(raw.toString('utf8'));
      } catch {
        sendMcpJsonRpcError(req, res, 400, -32700, 'invalid_json');
        return;
      }
    }
  } else if (req.method !== 'GET' && req.method !== 'DELETE') {
    sendMcpJsonRpcError(req, res, 405, -32601, 'method_not_allowed');
    return;
  }

  // Re-verify the credential after reading the body and before any tool can run.
  // A revoke or password change that lands while the (possibly 12 MiB) body is
  // in flight must still block the delayed request.
  try {
    const rechecked = await ctx.oauth.provider.verifyAccessToken(presentedToken);
    if (rechecked.extra?.userId !== userId || !rechecked.scopes.includes(REQUIRED_SCOPE)) throw new InvalidTokenError('access token 授权已变化');
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      sendMcpJsonRpcError(req, res, 401, -32001, 'unauthorized', {
        'WWW-Authenticate': mcpBearerChallenge(ctx, 'invalid_token'),
      });
      return;
    }
    throw error;
  }

  // Record tool-discovery evidence only after a real successful `tools/list`.
  // `last_used_at` is set by token validation alone, so the list status would
  // otherwise claim a working client before the MCP handshake ever ran.
  if (parsedBody?.method === 'tools/list') {
    const grantId = auth.extra?.grantId;
    observeJsonResponse(res, (payload) => {
      const tools = payload?.result?.tools;
      if (!Array.isArray(tools) || tools.length === 0) return;
      try {
        markConnectionDiscovery(ctx.db, userId, grantId, ctx.nowMs());
      } catch (error) {
        ctx.logger.warn?.('[imstage-api] failed to record MCP tool discovery:', error?.message ?? error);
      }
    });
  }

  const mcpServer = ctx.mcp.createServer(userId, {
    // Also re-checked after the slow render step completes, so an in-flight
    // render cannot persist or return a PNG for a now-revoked account.
    authorizeCheck: async () => {
      const info = await ctx.oauth.provider.verifyAccessToken(presentedToken);
      if (info.extra?.userId !== userId || !info.scopes.includes(REQUIRED_SCOPE)) throw new InvalidTokenError('access token 授权已变化');
    },
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await mcpServer.connect(transport);
  res.once('close', () => {
    void transport.close();
    void mcpServer.close();
  });
  await transport.handleRequest(req, res, parsedBody);
}

/* ------------------------------------------------------------------ */
/* Static file serving (built web app)                                 */
/* ------------------------------------------------------------------ */

async function statFile(filePath) {
  try {
    const info = await fs.promises.stat(filePath);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

async function serveStatic(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }
  if (!ctx.config.distDir || !ctx.config.distRoot) {
    throw new HttpError(404, 'not_found', '资源不存在');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://internal').pathname);
  } catch {
    throw new HttpError(400, 'bad_request', '请求路径无效');
  }
  if (pathname.includes('\0')) throw new HttpError(400, 'bad_request', '请求路径无效');

  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  // Reject dotfiles and any traversal attempt before touching the filesystem.
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) {
    throw new HttpError(404, 'not_found', '资源不存在');
  }

  let target = path.join(ctx.config.distRoot, ...segments);
  const rootWithSep = ctx.config.distRoot.endsWith(path.sep)
    ? ctx.config.distRoot
    : ctx.config.distRoot + path.sep;
  if (target !== ctx.config.distRoot && !target.startsWith(rootWithSep)) {
    throw new HttpError(404, 'not_found', '资源不存在');
  }

  let resolvedTarget = target;
  try {
    resolvedTarget = await fs.promises.realpath(target);
  } catch {
    resolvedTarget = null;
  }

  let info = resolvedTarget ? await statFile(resolvedTarget) : null;
  if (!info) {
    // SPA fallback: only for non-API GET/HEAD routes.
    const indexPath = path.join(ctx.config.distRoot, 'index.html');
    let resolvedIndex;
    try {
      resolvedIndex = await fs.promises.realpath(indexPath);
    } catch {
      resolvedIndex = null;
    }
    info = resolvedIndex ? await statFile(resolvedIndex) : null;
    if (!info) throw new HttpError(404, 'not_found', '资源不存在');
    resolvedTarget = resolvedIndex;
  }

  if (resolvedTarget !== ctx.config.distRoot && !resolvedTarget.startsWith(rootWithSep)) throw new HttpError(404, 'not_found', '资源不存在');
  const extension = path.extname(resolvedTarget).toLowerCase();
  const contentType = MIME_TYPES[extension] ?? 'application/octet-stream';
  const cacheControl = extension === '.html' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, {
    ...STATIC_SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': info.size,
    'Cache-Control': cacheControl,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(resolvedTarget);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  }).catch((err) => {
    if (!res.headersSent) throw err;
    res.destroy();
  });
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

async function route(ctx, req, res) {
  if (typeof req.url !== 'string' || req.url.length === 0) {
    throw new HttpError(400, 'bad_request', '请求无效');
  }
  let pathname;
  try {
    pathname = new URL(req.url, 'http://internal').pathname;
  } catch {
    throw new HttpError(400, 'bad_request', '请求路径无效');
  }
  const method = req.method ?? 'GET';

  if (pathname === '/api/health') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    sendJson(req, res, 200, { status: 'ready' });
    return;
  }

  if (pathname === '/api/auth/session') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    const session = loadSession(ctx, req);
    sendJson(req, res, 200, { user: session ? session.user : null });
    return;
  }

  if (pathname === '/api/auth/register' || pathname === '/api/auth/login') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    if (pathname.endsWith('/register')) await handleRegister(ctx, req, res);
    else await handleLogin(ctx, req, res);
    return;
  }

  if (pathname === '/api/auth/logout') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    await handleLogout(ctx, req, res);
    return;
  }

  if (pathname === '/api/auth/password') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    await handlePasswordChange(ctx, req, res);
    return;
  }

  if (pathname === '/api/projects') {
    if (method === 'GET') {
      handleProjectList(ctx, req, res);
      return;
    }
    if (method === 'POST') {
      await handleProjectCreate(ctx, req, res);
      return;
    }
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }

  const projectJobMatch = /^\/api\/projects\/([^/]+)\/batch-jobs\/([^/]+)(?:\/(cancel|retry))?$/.exec(pathname);
  if (projectJobMatch) {
    const projectId = projects.validateProjectId(projectJobMatch[1]);
    const jobId = projects.validateJobId(projectJobMatch[2]);
    const action = projectJobMatch[3];
    if (action === 'cancel') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
      await handleBatchCancel(ctx, req, res, projectId, jobId);
      return;
    }
    if (action === 'retry') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
      await handleBatchRetry(ctx, req, res, projectId, jobId);
      return;
    }
    if (method === 'GET') {
      handleBatchGet(ctx, req, res, projectId, jobId);
      return;
    }
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }

  const projectBatchMatch = /^\/api\/projects\/([^/]+)\/batch-jobs$/.exec(pathname);
  if (projectBatchMatch) {
    const projectId = projects.validateProjectId(projectBatchMatch[1]);
    if (method === 'GET') {
      handleBatchList(ctx, req, res, projectId);
      return;
    }
    if (method === 'POST') {
      await handleBatchCreate(ctx, req, res, projectId);
      return;
    }
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }

  const projectScenesMatch = /^\/api\/projects\/([^/]+)\/scenes(?:\/([^/]+))?$/.exec(pathname);
  if (projectScenesMatch) {
    const projectId = projects.validateProjectId(projectScenesMatch[1]);
    const rawSceneId = projectScenesMatch[2];
    if (rawSceneId === undefined) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
      await handleProjectAttachScene(ctx, req, res, projectId);
      return;
    }
    const sceneId = parseSceneId(rawSceneId);
    if (!sceneId) throw new HttpError(404, 'not_found', '作品不存在');
    if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    await handleProjectDetachScene(ctx, req, res, projectId, sceneId);
    return;
  }

  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
  if (projectMatch) {
    const projectId = projects.validateProjectId(projectMatch[1]);
    if (method === 'GET') {
      handleProjectGet(ctx, req, res, projectId);
      return;
    }
    if (method === 'PUT') {
      await handleProjectUpdate(ctx, req, res, projectId);
      return;
    }
    if (method === 'DELETE') {
      await handleProjectDelete(ctx, req, res, projectId);
      return;
    }
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }

  if (pathname === '/api/templates') {
    if (method === 'GET') {
      handleTemplateList(ctx, req, res);
      return;
    }
    if (method === 'POST') {
      await handleTemplateCreate(ctx, req, res);
      return;
    }
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }

  const templateInstantiateMatch = /^\/api\/templates\/([^/]+)\/instantiate$/.exec(pathname);
  if (templateInstantiateMatch) {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    await handleTemplateInstantiate(ctx, req, res, templateInstantiateMatch[1]);
    return;
  }

  const templateMatch = /^\/api\/templates\/([^/]+)$/.exec(pathname);
  if (templateMatch) {
    const templateId = templateMatch[1];
    if (method === 'GET') {
      handleTemplateGet(ctx, req, res, templateId);
      return;
    }
    if (method === 'PUT') {
      await handleTemplateUpdate(ctx, req, res, templateId);
      return;
    }
    if (method === 'DELETE') {
      await handleTemplateDelete(ctx, req, res, templateId);
      return;
    }
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }

  if (pathname === '/api/scenes') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    handleSceneList(ctx, req, res);
    return;
  }

  const sceneMatch = /^\/api\/scenes\/([^/]+)$/.exec(pathname);
  if (sceneMatch) {
    const sceneId = parseSceneId(sceneMatch[1]);
    if (!sceneId) throw new HttpError(404, 'not_found', '场景不存在');
    if (method === 'GET') {
      handleSceneGet(ctx, req, res, sceneId);
      return;
    }
    if (method === 'PUT') {
      await handleScenePut(ctx, req, res, sceneId);
      return;
    }
    if (method === 'DELETE') {
      await handleSceneDelete(ctx, req, res, sceneId);
      return;
    }
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }

  if (pathname === '/api/contact-library') {
    if (method === 'GET') {
      handleContactLibraryGet(ctx, req, res);
      return;
    }
    if (method === 'PUT') {
      await handleContactLibraryPut(ctx, req, res);
      return;
    }
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }

  if (pathname === '/api/agent/capabilities') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    // Public, non-secret status so the UI can explain whether AI is configured.
    sendJson(req, res, 200, ctx.agent.runtime.capabilities);
    return;
  }

  if (pathname === '/api/agent/render') {
    if(method!=='POST') throw new HttpError(405,'method_not_allowed','方法不被允许');
    guardMutation(req,ctx.config);const session=requireSession(ctx,req);requireJsonContentType(req);
    const body=await readJsonBody(req,AGENT_BODY_LIMIT,AGENT_READ_DEADLINE_MS);recheckSession(ctx,req,session);
    const validation=validateAgentInput({prompt:'render',scene:body.scene});
    if(!validation.ok||!validation.value.scene.reference) throw new HttpError(400,'invalid_scene','需要有效截图编辑文档');
    const lease=ctx.agent.limiter.tryStart(session.user.id,ctx.nowMs());if(!lease.ok)throw rateLimitedError(lease.retryAfterMs);
    const controller=new AbortController();const close=()=>controller.abort();res.on('close',close);const timer=setTimeout(close,40000);
    try {const {renderReference}=await import('../agent/screenshot-tools.mjs');const output=await renderReference(validation.value.scene.reference,controller.signal);recheckSession(ctx,req,session);if(!controller.signal.aborted){res.writeHead(200,{'Content-Type':'image/png','Content-Length':output.buffer.length,'Cache-Control':'no-store'});res.end(output.buffer);}}
    finally {clearTimeout(timer);res.off('close',close);lease.release();}
    return;
  }

  if (pathname === '/api/agent/run') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    await handleAgentRun(ctx, req, res);
    return;
  }

  if (pathname === '/api/connections/config') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    handleConnectionsConfig(ctx, req, res);
    return;
  }

  if (pathname === '/api/connections') {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    handleConnectionsList(ctx, req, res);
    return;
  }

  if (pathname === '/api/connections/tokens') {
    if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    await handleConnectionTokenCreate(ctx, req, res);
    return;
  }

  const connectionMatch = /^\/api\/connections\/([^/]+)$/.exec(pathname);
  if (connectionMatch) {
    const grantId = connectionMatch[1];
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(grantId)) throw new HttpError(404, 'not_found', '连接不存在');
    if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed', '方法不被允许');
    await handleConnectionDelete(ctx, req, res, grantId);
    return;
  }

  if (pathname === '/api/oauth/consent') {
    if (method === 'GET') {
      const requestId = new URL(req.url, 'http://internal').searchParams.get('request');
      handleOauthConsentGet(ctx, req, res, requestId);
      return;
    }
    if (method === 'POST') {
      await handleOauthConsentPost(ctx, req, res);
      return;
    }
    throw new HttpError(405, 'method_not_allowed', '方法不被允许');
  }

  if (pathname === '/api/mcp' || pathname === '/api/mcp/') {
    await handleAccountMcp(ctx, req, res);
    return;
  }

  const normalizedPath =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (ctx.oauth.paths.has(normalizedPath)) {
    applyOAuthThrottle(ctx, req, normalizedPath);
    ctx.oauth.app(req, res);
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    // Unknown API endpoints are never served as SPA fallback.
    throw new HttpError(404, 'not_found', '接口不存在');
  }

  await serveStatic(ctx, req, res);
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function resolveConfig(options) {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? env.IMSTAGE_DATA_DIR ?? '.local/app';
  const dbPath = options.dbPath ?? path.join(dataDir, 'imstage.db');
  const appOrigin = normalizeOrigin(options.appOrigin ?? env.IMSTAGE_APP_ORIGIN ?? 'http://127.0.0.1:4417');
  const host = options.host ?? env.IMSTAGE_API_HOST ?? '127.0.0.1';
  const port = parseAbsolutePort(options.port ?? env.IMSTAGE_API_PORT, 4419);
  const distDir = options.distDir ?? env.IMSTAGE_DIST_DIR ?? 'dist';
  const nodeEnv = options.nodeEnv ?? env.NODE_ENV ?? 'development';

  if (!isLoopbackHost(host)) {
    throw new Error(`IMStage API must bind to a loopback host, refusing to use: ${String(host)}`);
  }

  const originUrl = new URL(appOrigin);
  if (nodeEnv === 'production') {
    if (originUrl.protocol !== 'https:' && !isLoopbackHost(originUrl.hostname)) {
      throw new Error(
        'Refusing to start: IMSTAGE_APP_ORIGIN must use https (or be a loopback origin) when NODE_ENV=production',
      );
    }
  }

  const now = typeof options.now === 'function' ? options.now : () => new Date();
  const nowMs = () => {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(ms)) throw new Error('now() must return a Date or a finite timestamp');
    return ms;
  };

  const rateLimit = {
    ip: { ...DEFAULT_RATE_LIMITS.ip, ...(options.rateLimit?.ip ?? {}) },
    email: { ...DEFAULT_RATE_LIMITS.email, ...(options.rateLimit?.email ?? {}) },
    user: { ...DEFAULT_RATE_LIMITS.user, ...(options.rateLimit?.user ?? {}) },
    oauth: { ...DEFAULT_RATE_LIMITS.oauth, ...(options.rateLimit?.oauth ?? {}) },
    oauthToken: { ...DEFAULT_RATE_LIMITS.oauthToken, ...(options.rateLimit?.oauthToken ?? {}) },
    oauthRegister: { ...DEFAULT_RATE_LIMITS.oauthRegister, ...(options.rateLimit?.oauthRegister ?? {}) },
    connections: { ...DEFAULT_RATE_LIMITS.connections, ...(options.rateLimit?.connections ?? {}) },
    mcp: { ...DEFAULT_RATE_LIMITS.mcp, ...(options.rateLimit?.mcp ?? {}) },
  };

  let distRoot = null;
  if (distDir) {
    const absolute = path.resolve(distDir);
    try {
      distRoot = fs.realpathSync(absolute);
    } catch {
      distRoot = null;
    }
  }

  return {
    dbPath,
    dataDir,
    appOrigin,
    host,
    port,
    distDir,
    distRoot,
    nodeEnv,
    trustLoopbackProxy: options.trustLoopbackProxy === true || env.IMSTAGE_TRUST_LOOPBACK_PROXY === '1',
    secureCookie: originUrl.protocol === 'https:',
    now,
    nowMs,
    hashConcurrency: Number.isInteger(options.hashConcurrency) && options.hashConcurrency > 0
      ? options.hashConcurrency
      : 4,
    rateLimit,
    allowLoopbackRedirects:
      options.allowLoopbackRedirects === undefined
        ? true
        : options.allowLoopbackRedirects === true,
    recentSessionMs:
      Number.isInteger(options.recentSessionMs) && options.recentSessionMs > 0
        ? options.recentSessionMs
        : RECENT_SESSION_MS,
    logger: options.logger ?? console,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the API application without starting to listen.
 *
 * @param {object} [options]
 * @param {string} [options.dbPath]      SQLite file path (or ':memory:').
 * @param {string} [options.dataDir]     Directory used when dbPath is omitted.
 * @param {string} [options.appOrigin]   Browser origin allowed for mutations.
 * @param {number} [options.port]        Preferred port (0 picks a free port).
 * @param {string} [options.host]        Loopback bind host.
 * @param {string} [options.distDir]     Built web app directory for static serving.
 * @param {() => Date|number} [options.now] Injectable clock (expiry tests).
 * @returns {{ server: http.Server, close: () => Promise<void>, db: DatabaseSync, config: object }}
 *
 * The returned `server` is created but not listening: call
 * `server.listen(config.port, config.host)` yourself, or use `start()`.
 */
export function createApp(options = {}) {
  const config = resolveConfig(options);
  const db = openDatabase(config.dbPath);
  const semaphore = new Semaphore(config.hashConcurrency);
  const limiters = {
    ip: new FixedWindowLimiter(config.rateLimit.ip),
    email: new FixedWindowLimiter(config.rateLimit.email),
    user: new FixedWindowLimiter(config.rateLimit.user),
    oauth: new FixedWindowLimiter(config.rateLimit.oauth),
    oauthToken: new FixedWindowLimiter(config.rateLimit.oauthToken),
    oauthRegister: new FixedWindowLimiter(config.rateLimit.oauthRegister),
    connections: new FixedWindowLimiter(config.rateLimit.connections),
    mcp: new FixedWindowLimiter(config.rateLimit.mcp),
  };
  const agentConfig = resolveAgentConfig(options.env ?? process.env, options.agent ?? {});
  const agentRuntime = withContactLibrary(createAgentRuntime(agentConfig, {
    ...(options.agent ?? {}),
    logger: config.logger,
  }),{db,nowMs:config.nowMs});
  const agentLimiter = createAgentLimiter(agentConfig.limits);
  const batchQueue = projects.createBatchQueue({
    db,
    agent: { runtime: agentRuntime, limiter: agentLimiter },
    nowMs: config.nowMs,
    logger: config.logger,
    ...(options.projects ?? {}),
  });
  // Truthful restart recovery runs before the worker may claim any job: a
  // queued/running job from a previous process is marked interrupted, never
  // silently resumed as if it had succeeded.
  projects.markInterruptedJobs(db, config.nowMs());
  batchQueue.start();

  // Renderer is created once per process. Tests inject a deterministic stub, so
  // ordinary test runs never launch Chromium.
  let executablePath;
  try {
    executablePath = resolveChromiumExecutable(options.env ?? process.env) ?? undefined;
  } catch (error) {
    config.logger.warn?.(
      `[imstage-api] Chromium 不可用，/api/mcp 渲染将在调用时失败：${error?.message ?? error}`,
    );
    executablePath = undefined;
  }
  const renderService =
    options.renderService ?? createRenderService({ executablePath, maxConcurrent: 1 });
  const oauth = createOAuthIntegration({
    db,
    appOrigin: config.appOrigin,
    nowMs: config.nowMs,
    allowLoopbackRedirects: config.allowLoopbackRedirects,
    recentSessionMs: config.recentSessionMs,
    logger: config.logger,
  });
  const ctx = {
    config,
    db,
    semaphore,
    limiters,
    nowMs: config.nowMs,
    logger: config.logger,
    agent: { config: agentConfig, runtime: agentRuntime, limiter: agentLimiter },
    projects: { queue: batchQueue },
    oauth,
    mcp: {
      renderService,
      createServer: (userId, { authorizeCheck = null } = {}) =>
        createAccountMcpServer({
          db,
          userId,
          renderService,
          logger: config.logger,
          appOrigin: config.appOrigin,
          authorizeCheck,
        }),
    },
  };

  const server = http.createServer((req, res) => {
    route(ctx, req, res).catch((err) => {
      sendError(req, res, ctx, err).catch(() => {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await batchQueue.stop();
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      const timer = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      }, 1_000);
      timer.unref?.();
    });
    try {
      db.close();
    } catch {
      /* already closed */
    }
  };

  return { server, close, db, config };
}

/**
 * Convenience wrapper: build the app and start listening.
 *
 * @returns {Promise<{server, close, db, config, port}>}
 */
export async function start(options = {}) {
  const app = createApp(options);
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    app.server.once('error', onError);
    app.server.listen(app.config.port, app.config.host, () => {
      app.server.removeListener('error', onError);
      resolve();
    });
  });
  const address = app.server.address();
  app.port = typeof address === 'object' && address !== null ? address.port : app.config.port;
  return app;
}

export { HttpError, resolveConfig };

/* ------------------------------------------------------------------ */
/* CLI entry                                                           */
/* ------------------------------------------------------------------ */

async function main() {
  const app = await start();
  const { config } = app;
  config.logger.log(
    `IMStage API ready on http://${config.host}:${app.port} (app origin: ${config.appOrigin})`,
  );

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    config.logger.log(`IMStage API stopping (${signal})`);
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

const isDirectRun =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error('[imstage-api] failed to start:', err?.message ?? err);
    process.exit(1);
  });
}

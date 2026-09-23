// Account-owned OAuth 2.1 authorization server for /api/mcp.
//
// This is the authorization-server half of the ChatGPT/MCP connection flow. It
// deliberately reuses the official MCP SDK's OAuth machinery rather than
// re-implementing protocol handling:
//   - `authorizationHandler`  validates client/redirect/response_type/PKCE and
//     splits pre-redirect vs. post-redirect errors per OAuth 2.1
//   - `tokenHandler`          validates grants, runs S256 PKCE verification via
//     `pkce-challenge`, and shapes standard token responses/errors
//   - `clientRegistrationHandler` performs RFC 7591 dynamic client registration
//   - `revocationHandler`     performs RFC 7009 token revocation
//   - `redirectUriMatches`    RFC 8252 redirect comparison
//   - `createOAuthMetadata`   base RFC 8414 metadata document
//
// The SDK handlers are mounted here at the project's stable `/api/oauth/*`
// paths. The SDK's own `mcpAuthRouter` assumes the authorization server is
// mounted at the origin root (`new URL('/authorize', issuer)`), so the four
// endpoint URLs in the metadata document are overridden to the real mounted
// paths; everything else comes from the SDK.
//
// Deviations that are product requirements, not protocol shortcuts:
//   - the authorization endpoint never issues a code directly. It records a
//     short-lived pending request and redirects the browser to the Web app
//     consent route. A code is only minted after an authenticated, recent
//     Web session explicitly approves (`POST /api/oauth/consent`).
//   - only public clients (`token_endpoint_auth_method=none`) are registered.
//   - unsupported scopes and a `resource` that is not this MCP server are
//     rejected with standard OAuth errors.
//   - no client URL is ever fetched (no CIMD support, so no SSRF surface).
//
// Owner scoping and revocation:
//   - a grant family belongs to exactly one `users.id`
//   - access/refresh tokens are stored as SHA-256 hashes and checked for
//     revocation/expiry on every call
//   - refresh rotation marks the old token; replay revokes the whole family
//   - authorization code reuse revokes the family minted from that code

import crypto from 'node:crypto';
import express from 'express';

import { authorizationHandler, redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';

import { integrationError } from './errors.mjs';
import {
  createGrantFamily,
  issueToken,
  revokeGrant,
  touchGrant,
} from './connections.mjs';
import {
  ACCESS_TOKEN_TTL_MS,
  CODE_TTL_MS,
  PENDING_REQUEST_TTL_MS,
  RECENT_SESSION_MS,
  REFRESH_TOKEN_TTL_MS,
  SUPPORTED_SCOPES,
} from './scopes.mjs';
import {
  dateISO,
  newOpaqueId,
  newOpaqueToken,
  parseJsonArray,
  sha256Hex,
  withTransaction,
} from './util.mjs';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Tights bounds for every untrusted OAuth string that reaches SQLite. */
const FIELD_LIMITS = Object.freeze({
  client_id: 256,
  redirect_uri: 2048,
  code_challenge: 128,
  code_challenge_method: 16,
  response_type: 32,
  scope: 512,
  state: 1024,
  resource: 2048,
  code: 512,
  code_verifier: 256,
  refresh_token: 512,
  grant_type: 64,
  token: 512,
  token_type_hint: 64,
});

function fieldsWithinLimit(source, spec) {
  for (const [name, max] of Object.entries(spec)) {
    const value = source?.[name];
    if (typeof value === 'string' && value.length > max) return false;
  }
  return true;
}

const SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Pragma': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
});

const AS_ALIASES = Object.freeze([
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-authorization-server/api/oauth',
  '/api/.well-known/oauth-authorization-server',
]);

const PRM_ALIASES = Object.freeze([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/api/mcp',
  '/api/.well-known/oauth-protected-resource',
]);

function normalizeResource(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash) return null;
  const href = url.href;
  return href.endsWith('/') && url.pathname !== '/' ? href.slice(0, -1) : href;
}

function buildRedirect(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.href;
}

function clientFromRow(row) {
  return {
    client_id: row.client_id,
    client_name: row.client_name ?? undefined,
    redirect_uris: parseJsonArray(row.redirect_uris_json),
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    grant_types: parseJsonArray(row.grant_types_json),
    response_types: parseJsonArray(row.response_types_json),
    scope: row.scope ?? undefined,
    client_id_issued_at: Number(row.client_id_issued_at),
  };
}

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {string} options.appOrigin configured application origin (never a Host header)
 * @param {() => number} options.nowMs injectable clock
 * @param {boolean} [options.allowLoopbackRedirects] allow controlled `http://` loopback redirect URIs. RFC 8252 §7.3 requires native clients on the same machine to use these, so this defaults to enabled in every environment (including production); only the explicit loopback host allowlist is accepted.
 * @param {number} [options.recentSessionMs] max age of a session allowed to approve consent
 * @param {Console} [options.logger]
 */
export function createOAuthIntegration({
  db,
  appOrigin,
  nowMs,
  allowLoopbackRedirects = true,
  recentSessionMs = RECENT_SESSION_MS,
  logger = console,
}) {
  const origin = new URL(appOrigin).origin;
  const resourceUrl = new URL(`${origin}/api/mcp`);
  const issuerUrl = new URL(`${origin}/api/oauth`);
  const prmUrl = `${origin}/api/.well-known/oauth-protected-resource`;
  const scopesSupported = [...SUPPORTED_SCOPES];

  /* ---------------------------------------------------------------- */
  /* Dynamic client registration store (RFC 7591)                      */
  /* ---------------------------------------------------------------- */

  function validateRedirectUri(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
      throw new InvalidClientMetadataError('redirect_uri 无效');
    }
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new InvalidClientMetadataError('redirect_uri 不是合法 URL');
    }
    // Fragments and URL credentials are never valid redirect targets, and
    // rejecting them first keeps scheme/host parsing unambiguous.
    if (url.hash !== '') throw new InvalidClientMetadataError('redirect_uri 不能包含 fragment');
    if (url.username !== '' || url.password !== '') {
      throw new InvalidClientMetadataError('redirect_uri 不能包含用户信息');
    }
    if (url.hostname === '') throw new InvalidClientMetadataError('redirect_uri 缺少主机名');
    if (url.protocol === 'https:') return url.href;
    // RFC 8252 §7.3 native-app loopback redirects: only the exact loopback
    // hosts below, any local port, no arbitrary HTTP host or DNS suffix.
    const hostname = url.hostname.toLowerCase();
    if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname) && allowLoopbackRedirects) {
      return url.href;
    }
    throw new InvalidClientMetadataError(
      'redirect_uri 必须是 https（仅允许 localhost / 127.0.0.1 / [::1] 的 HTTP 回环回调）',
    );
  }

  const clientsStore = {
    getClient(clientId) {
      if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 256) return undefined;
      const row = db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId);
      return row ? clientFromRow(row) : undefined;
    },
    registerClient(client) {
      if (client.token_endpoint_auth_method !== 'none' || client.client_secret) {
        throw new InvalidClientMetadataError('仅支持公共客户端（token_endpoint_auth_method=none）');
      }
      const redirects = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
      if (redirects.length < 1) throw new InvalidClientMetadataError('redirect_uris 至少需要一个');
      if (redirects.length > 10) throw new InvalidClientMetadataError('redirect_uris 最多 10 个');
      const validated = redirects.map((uri) => validateRedirectUri(uri));
      const grantTypes = Array.isArray(client.grant_types)
        ? client.grant_types
        : ['authorization_code', 'refresh_token'];
      if (grantTypes.some((grant) => !['authorization_code', 'refresh_token'].includes(grant))) {
        throw new InvalidClientMetadataError('仅支持 authorization_code 与 refresh_token 授权类型');
      }
      const responseTypes = Array.isArray(client.response_types) ? client.response_types : ['code'];
      if (responseTypes.some((type) => type !== 'code')) {
        throw new InvalidClientMetadataError('仅支持 response_type=code');
      }
      const clientId =
        typeof client.client_id === 'string' && client.client_id.length > 0
          ? client.client_id
          : crypto.randomUUID();
      const clientName =
        typeof client.client_name === 'string' && client.client_name.trim() !== ''
          ? client.client_name.trim().slice(0, 120)
          : 'MCP 客户端';
      const issuedAt = Math.floor(nowMs() / 1000);
      // Bound table growth: drop long-idle clients that never produced a
      // connection. Clients with an active/known grant are always retained.
      db.prepare(
        `DELETE FROM oauth_clients
         WHERE created_at < ?
           AND client_id NOT IN (SELECT client_id FROM oauth_grants WHERE client_id IS NOT NULL)`,
      ).run(dateISO(nowMs() - 90 * 24 * 60 * 60 * 1000));
      db.prepare(
        `INSERT INTO oauth_clients
           (client_id, client_name, redirect_uris_json, token_endpoint_auth_method, grant_types_json, response_types_json, scope, client_id_issued_at, created_at)
         VALUES (?, ?, ?, 'none', ?, ?, ?, ?, ?)`,
      ).run(
        clientId,
        clientName,
        JSON.stringify(validated),
        JSON.stringify(grantTypes),
        JSON.stringify(responseTypes),
        scopesSupported.join(' '),
        issuedAt,
        dateISO(nowMs()),
      );
      return {
        ...client,
        client_id: clientId,
        client_id_issued_at: issuedAt,
        client_name: clientName,
        redirect_uris: validated,
        token_endpoint_auth_method: 'none',
        grant_types: grantTypes,
        response_types: responseTypes,
        scope: scopesSupported.join(' '),
        client_secret: undefined,
      };
    },
  };

  /* ---------------------------------------------------------------- */
  /* Authorization server provider                                     */
  /* ---------------------------------------------------------------- */

  function normalizeScopes(requested) {
    if (!Array.isArray(requested) || requested.length === 0) return [...scopesSupported];
    const unique = [...new Set(requested)];
    for (const scope of unique) {
      if (!scopesSupported.includes(scope)) {
        throw new InvalidScopeError(`不支持的 scope：${scope}`);
      }
    }
    return unique;
  }

  function issueTokenPair({ grantId, userId, clientId, scopes, nowMs: at }) {
    const accessToken = issueToken(db, {
      grantId,
      userId,
      kind: 'access',
      clientId,
      ttlMs: ACCESS_TOKEN_TTL_MS,
      nowMs: at,
    });
    const refreshToken = issueToken(db, {
      grantId,
      userId,
      kind: 'refresh',
      clientId,
      ttlMs: REFRESH_TOKEN_TTL_MS,
      nowMs: at,
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }

  const provider = {
    get clientsStore() {
      return clientsStore;
    },

    async authorize(client, params, res) {
      if (typeof params.state === 'string' && params.state.length > FIELD_LIMITS.state) {
        throw new InvalidRequestError('state 超出长度限制');
      }
      if (
        typeof params.redirectUri !== 'string' ||
        params.redirectUri.length === 0 ||
        params.redirectUri.length > FIELD_LIMITS.redirect_uri
      ) {
        throw new InvalidRequestError('redirect_uri 无效');
      }
      if (
        typeof params.codeChallenge !== 'string' ||
        params.codeChallenge.length < 20 ||
        params.codeChallenge.length > FIELD_LIMITS.code_challenge
      ) {
        throw new InvalidRequestError('code_challenge 不合法');
      }
      // RFC 8707: the token must be bound to this exact MCP resource.
      const resource = normalizeResource(params.resource?.href);
      if (resource !== resourceUrl.href) {
        throw new InvalidTargetError(`resource 必须是 ${resourceUrl.href}`);
      }
      const scopes = normalizeScopes(params.scopes);
      if (scopes.length > 8) throw new InvalidScopeError('scope 数量过多');
      const id = newOpaqueId('oar_');
      const at = nowMs();
      // Opportunistic cleanup of expired pending requests/codes keeps the
      // tables bounded without a background job.
      db.prepare('DELETE FROM oauth_requests WHERE expires_at_ms <= ?').run(at);
      db.prepare('DELETE FROM oauth_codes WHERE expires_at_ms <= ?').run(at);
      db.prepare(
        `INSERT INTO oauth_requests
           (id, client_id, redirect_uri, code_challenge, state, resource, scopes_json, created_at, expires_at_ms, consumed_at, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        id,
        client.client_id,
        params.redirectUri,
        params.codeChallenge,
        params.state ?? null,
        resource,
        JSON.stringify(scopes),
        dateISO(at),
        at + PENDING_REQUEST_TTL_MS,
      );
      // Never auto-issue a code; the Web app must collect explicit consent.
      res.redirect(302, `${origin}/#/connect/authorize?request=${encodeURIComponent(id)}`);
    },

    async challengeForAuthorizationCode(client, code) {
      if (typeof code !== 'string' || code.length < 20 || code.length > FIELD_LIMITS.code) {
        throw new InvalidGrantError('authorization code 无效');
      }
      const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(sha256Hex(code));
      if (!row || row.client_id !== client.client_id) {
        throw new InvalidGrantError('authorization code 无效');
      }
      if (Number(row.expires_at_ms) <= nowMs()) {
        db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(row.code_hash);
        throw new InvalidGrantError('authorization code 已过期');
      }
      return row.code_challenge;
    },

    async exchangeAuthorizationCode(client, code, _codeVerifier, redirectUri, resource) {
      if (typeof code !== 'string' || code.length < 20 || code.length > FIELD_LIMITS.code) {
        throw new InvalidGrantError('authorization code 无效');
      }
      const codeHash = sha256Hex(code);
      const at = nowMs();
      // Reuse of a redeemed code means it leaked. The family revocation must be
      // committed before we throw, so it runs outside the exchange transaction
      // that the `invalid_grant` error would otherwise roll back.
      const prior = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash);
      if (prior && prior.client_id === client.client_id && prior.used_at) {
        if (prior.grant_id) revokeGrant(db, prior.grant_id);
        throw new InvalidGrantError('authorization code 已被使用');
      }
      return withTransaction(db, () => {
        const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash);
        if (!row || row.client_id !== client.client_id) {
          throw new InvalidGrantError('authorization code 无效');
        }
        if (row.used_at) {
          throw new InvalidGrantError('authorization code 已被使用');
        }
        if (Number(row.expires_at_ms) <= at) {
          db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(codeHash);
          throw new InvalidGrantError('authorization code 已过期');
        }
        if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
          throw new InvalidGrantError('redirect_uri 与授权请求不一致');
        }
        if (resource !== undefined && normalizeResource(resource?.href) !== row.resource) {
          throw new InvalidGrantError('resource 与授权请求不一致');
        }
        const claimed = db
          .prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL')
          .run(dateISO(at), codeHash);
        if (Number(claimed.changes) !== 1) {
          throw new InvalidGrantError('authorization code 已被使用');
        }
        const grantId = createGrantFamily(db, {
          userId: row.user_id,
          source: 'oauth',
          clientId: row.client_id,
          clientName: client.client_name || 'MCP 客户端',
          resource: row.resource,
          scopes: parseJsonArray(row.scopes_json),
          nowMs: at,
        });
        db.prepare('UPDATE oauth_codes SET grant_id = ? WHERE code_hash = ?').run(grantId, codeHash);
        return issueTokenPair({
          grantId,
          userId: row.user_id,
          clientId: row.client_id,
          scopes: parseJsonArray(row.scopes_json),
          nowMs: at,
        });
      });
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      if (
        typeof refreshToken !== 'string' ||
        refreshToken.length < 20 ||
        refreshToken.length > FIELD_LIMITS.refresh_token
      ) {
        throw new InvalidGrantError('refresh token 无效');
      }
      const tokenHash = sha256Hex(refreshToken);
      const at = nowMs();
      // Refresh replay: the rotated token must never be reusable, and the
      // revocation must be committed before the `invalid_grant` throw.
      const prior = db
        .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
        .get(tokenHash);
      if (prior && prior.client_id === client.client_id && (prior.revoked_at || prior.rotated_at)) {
        revokeGrant(db, prior.grant_id);
        throw new InvalidGrantError('refresh token 已被轮换，授权已撤销');
      }
      return withTransaction(db, () => {
        const row = db
          .prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
          .get(tokenHash);
        if (!row || row.client_id !== client.client_id) {
          throw new InvalidGrantError('refresh token 无效');
        }
        const grant = db.prepare('SELECT * FROM oauth_grants WHERE id = ?').get(row.grant_id);
        if (!grant || grant.revoked_at) {
          throw new InvalidGrantError('refresh token 已失效');
        }
        if (row.revoked_at || row.rotated_at) {
          throw new InvalidGrantError('refresh token 已被轮换，授权已撤销');
        }
        if (Number(row.expires_at_ms) <= at) {
          throw new InvalidGrantError('refresh token 已过期');
        }
        if (resource !== undefined && normalizeResource(resource?.href) !== (grant.resource ?? resourceUrl.href)) {
          throw new InvalidGrantError('resource 与授权请求不一致');
        }
        const grantedScopes = parseJsonArray(grant.scopes_json);
        if (Array.isArray(scopes) && scopes.length > 0) {
          for (const scope of scopes) {
            if (!grantedScopes.includes(scope)) throw new InvalidScopeError(`请求的 scope 超出原授权：${scope}`);
          }
        }
        const tokens = issueTokenPair({
          grantId: row.grant_id,
          userId: row.user_id,
          clientId: row.client_id,
          scopes: grantedScopes,
          nowMs: at,
        });
        db.prepare('UPDATE oauth_tokens SET rotated_at = ?, replaced_by = ? WHERE token_hash = ?').run(
          dateISO(at),
          sha256Hex(tokens.refresh_token),
          tokenHash,
        );
        return tokens;
      });
    },

    async verifyAccessToken(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 512) {
        throw new InvalidTokenError('access token 无效');
      }
      const row = db
        .prepare(
          `SELECT t.*, g.revoked_at AS grant_revoked, g.resource AS grant_resource, g.scopes_json AS grant_scopes
           FROM oauth_tokens t JOIN oauth_grants g ON g.id = t.grant_id
           WHERE t.token_hash = ? AND t.kind = 'access'`,
        )
        .get(sha256Hex(token));
      if (!row) throw new InvalidTokenError('access token 无效');
      if (row.revoked_at || row.grant_revoked) throw new InvalidTokenError('access token 已撤销');
      if (Number(row.expires_at_ms) <= nowMs()) throw new InvalidTokenError('access token 已过期');
      // Opaque tokens are only ever issued by this server's own database, so
      // "issuer" validity means the row exists above; the audience/resource
      // binding is still re-checked explicitly on every call.
      const grantResource = row.grant_resource;
      if (normalizeResource(grantResource) !== resourceUrl.href) {
        throw new InvalidTokenError('access token 资源不匹配');
      }
      touchGrant(db, row.grant_id, nowMs());
      return {
        token,
        clientId: row.client_id ?? 'imstage-personal-token',
        scopes: parseJsonArray(row.grant_scopes),
        expiresAt: Math.floor(Number(row.expires_at_ms) / 1000),
        resource: new URL(grantResource),
        extra: { userId: row.user_id, grantId: row.grant_id },
      };
    },

    async revokeToken(client, request) {
      if (
        typeof request?.token !== 'string' ||
        request.token.length < 20 ||
        request.token.length > FIELD_LIMITS.token
      ) {
        return; // out-of-shape tokens are treated as unknown per RFC 7009
      }
      const tokenHash = sha256Hex(request.token);
      const row = db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(tokenHash);
      if (!row) return; // RFC 7009: unknown tokens are a successful no-op
      if (row.client_id && row.client_id !== client.client_id) return;
      if (row.kind === 'refresh') {
        revokeGrant(db, row.grant_id);
        return;
      }
      db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?').run(
        dateISO(nowMs()),
        tokenHash,
      );
    },
  };

  /* ---------------------------------------------------------------- */
  /* Consent: session-bound explicit approval                          */
  /* ---------------------------------------------------------------- */

  function loadRequestRow(requestId) {
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 128) return null;
    return db.prepare('SELECT * FROM oauth_requests WHERE id = ?').get(requestId);
  }

  function assertCurrentRedirect(uri) {
    try { validateRedirectUri(uri); } catch {
      throw integrationError(400, 'invalid_request', '回调地址不再有效，请回到客户端重新连接');
    }
  }

  function pendingIsUsable(row) {
    return Boolean(row) && !row.consumed_at && Number(row.expires_at_ms) > nowMs();
  }

  function getConsent({ requestId, userId, recheck }) {
    // Binding the pending request to the first authenticated viewer makes an
    // account change mid-flow fail closed (another account can no longer read
    // or approve it), and lets password change invalidate it by user id.
    return withTransaction(db, () => {
      if (typeof recheck === 'function') recheck();
      const row = loadRequestRow(requestId);
      if (!pendingIsUsable(row)) throw integrationError(404, 'invalid_request', '授权请求不存在或已过期');
      if (row.user_id && row.user_id !== userId) {
        throw integrationError(404, 'invalid_request', '授权请求不存在或已过期');
      }
      if (!row.user_id) {
        const claimed = db
          .prepare('UPDATE oauth_requests SET user_id = ? WHERE id = ? AND user_id IS NULL')
          .run(userId, row.id);
        if (Number(claimed.changes) !== 1) {
          throw integrationError(409, 'invalid_request', '授权请求已被处理');
        }
      }
      assertCurrentRedirect(row.redirect_uri);
      const client = clientsStore.getClient(row.client_id);
      if (!client) throw integrationError(404, 'invalid_request', '授权请求的客户端不存在');
      return {
        requestId: row.id,
        clientName: client.client_name || 'MCP 客户端',
        scopes: parseJsonArray(row.scopes_json),
        redirectHost: new URL(row.redirect_uri).host,
      };
    });
  }

  function decideConsent({ requestId, approved, session, recheck }) {
    if (typeof approved !== 'boolean') throw integrationError(400, 'invalid_request', 'approved 必须是布尔值');
    const at = nowMs();
    if (!Number.isFinite(session.createdAtMs) || at - session.createdAtMs > recentSessionMs) {
      throw integrationError(401, 'reauthentication_required', '请重新登录后再授权');
    }
    return withTransaction(db, () => {
      // Re-verify the caller's session inside the transaction so an account
      // change between the read and the write can never approve for user A
      // while writing user B.
      recheck();
      const row = loadRequestRow(requestId);
      if (!pendingIsUsable(row)) throw integrationError(404, 'invalid_request', '授权请求不存在或已过期');
      if (row.user_id && row.user_id !== session.user.id) {
        throw integrationError(404, 'invalid_request', '授权请求不存在或已过期');
      }
      assertCurrentRedirect(row.redirect_uri);
      const client = clientsStore.getClient(row.client_id);
      if (!client) throw integrationError(400, 'invalid_request', '授权请求的客户端不存在');
      if (!client.redirect_uris.some((registered) => redirectUriMatches(row.redirect_uri, registered))) {
        throw integrationError(400, 'invalid_request', 'redirect_uri 未被该客户端注册');
      }
      const claimed = db
        .prepare('UPDATE oauth_requests SET consumed_at = ?, user_id = ? WHERE id = ? AND consumed_at IS NULL')
        .run(dateISO(at), session.user.id, row.id);
      if (Number(claimed.changes) !== 1) {
        throw integrationError(409, 'invalid_request', '授权请求已被处理');
      }
      if (!approved) {
        return {
          redirectUrl: buildRedirect(row.redirect_uri, {
            error: 'access_denied',
            error_description: '用户拒绝授权',
            state: row.state,
          }),
        };
      }
      const code = newOpaqueToken();
      db.prepare(
        `INSERT INTO oauth_codes
           (code_hash, client_id, user_id, redirect_uri, resource, scopes_json, code_challenge, grant_id, created_at, expires_at_ms, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
      ).run(
        sha256Hex(code),
        row.client_id,
        session.user.id,
        row.redirect_uri,
        row.resource,
        row.scopes_json,
        row.code_challenge,
        dateISO(at),
        at + CODE_TTL_MS,
      );
      return { redirectUrl: buildRedirect(row.redirect_uri, { code, state: row.state }) };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Discovery documents                                               */
  /* ---------------------------------------------------------------- */

  const metadata = createOAuthMetadata({ provider, issuerUrl, baseUrl: issuerUrl, scopesSupported });
  metadata.authorization_endpoint = `${origin}/api/oauth/authorize`;
  metadata.token_endpoint = `${origin}/api/oauth/token`;
  metadata.registration_endpoint = `${origin}/api/oauth/register`;
  metadata.revocation_endpoint = `${origin}/api/oauth/revoke`;
  metadata.response_types_supported = ['code'];
  metadata.grant_types_supported = ['authorization_code', 'refresh_token'];
  metadata.token_endpoint_auth_methods_supported = ['none'];
  metadata.revocation_endpoint_auth_methods_supported = ['none'];
  metadata.code_challenge_methods_supported = ['S256'];
  metadata.scopes_supported = scopesSupported;
  metadata.service_documentation = `${origin}/#/docs`;

  const protectedResourceMetadata = {
    resource: resourceUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: scopesSupported,
    resource_name: 'IMStage 场景创作',
    resource_documentation: `${origin}/#/docs`,
    bearer_methods_supported: ['header'],
  };

  /* ---------------------------------------------------------------- */
  /* Express mounting of the SDK handlers                              */
  /* ---------------------------------------------------------------- */

  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use((req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    next();
  });

  const serveMetadata = (payload) => (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(payload);
  };
  app.get([...AS_ALIASES], serveMetadata(metadata));
  app.get([...PRM_ALIASES], serveMetadata(protectedResourceMetadata));

  // Every request body is parsed here with an explicit small limit before the
  // SDK handler runs (the SDK's own parsers then skip, since `req.body` is set).
  const urlencodedSmall = express.urlencoded({ extended: false, limit: '64kb' });
  const jsonSmall = express.json({ limit: '64kb' });

  const authorizeQueryGuard = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      next();
      return;
    }
    const params = req.method === 'POST' ? req.body : req.query;
    if (
      !fieldsWithinLimit(params, {
        client_id: FIELD_LIMITS.client_id,
        redirect_uri: FIELD_LIMITS.redirect_uri,
        code_challenge: FIELD_LIMITS.code_challenge,
        code_challenge_method: FIELD_LIMITS.code_challenge_method,
        response_type: FIELD_LIMITS.response_type,
        scope: FIELD_LIMITS.scope,
        state: FIELD_LIMITS.state,
        resource: FIELD_LIMITS.resource,
      })
    ) {
      res.status(400).json({ error: 'invalid_request', error_description: '授权请求参数超出长度限制' });
      return;
    }
    // Validate before the SDK can redirect errors. Its loopback matcher only
    // compares scheme/host/path/query and does not enforce our current policy.
    const client = typeof params?.client_id === 'string' ? clientsStore.getClient(params.client_id) : null;
    const redirect = params?.redirect_uri ?? (client?.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined);
    if (redirect !== undefined) {
      try { validateRedirectUri(redirect); } catch {
        res.status(400).json({ error: 'invalid_request', error_description: '回调地址无效，请回到客户端重新连接' });
        return;
      }
    }
    next();
  };

  const tokenBodyGuard = (req, res, next) => {
    if (
      !fieldsWithinLimit(req.body, {
        client_id: FIELD_LIMITS.client_id,
        code: FIELD_LIMITS.code,
        code_verifier: FIELD_LIMITS.code_verifier,
        redirect_uri: FIELD_LIMITS.redirect_uri,
        refresh_token: FIELD_LIMITS.refresh_token,
        resource: FIELD_LIMITS.resource,
        grant_type: FIELD_LIMITS.grant_type,
        scope: FIELD_LIMITS.scope,
      })
    ) {
      res.status(400).json({ error: 'invalid_request', error_description: '令牌请求参数超出长度限制' });
      return;
    }
    next();
  };

  const revokeBodyGuard = (req, res, next) => {
    if (
      !fieldsWithinLimit(req.body, {
        client_id: FIELD_LIMITS.client_id,
        token: FIELD_LIMITS.token,
        token_type_hint: FIELD_LIMITS.token_type_hint,
      })
    ) {
      res.status(400).json({ error: 'invalid_request', error_description: '撤销请求参数超出长度限制' });
      return;
    }
    next();
  };

  app.use('/api/oauth/authorize', urlencodedSmall, authorizeQueryGuard, authorizationHandler({ provider, rateLimit: false }));
  app.use('/api/oauth/token', urlencodedSmall, tokenBodyGuard, tokenHandler({ provider, rateLimit: false }));
  app.use(
    '/api/oauth/register',
    jsonSmall,
    clientRegistrationHandler({ clientsStore, rateLimit: false, clientSecretExpirySeconds: 0 }),
  );
  app.use(
    '/api/oauth/revoke',
    urlencodedSmall,
    revokeBodyGuard,
    revocationHandler({ provider, rateLimit: false }),
  );

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use((error, req, res, _next) => {
    // Map body-parser/client errors to standard OAuth-shaped JSON; only log
    // unexpected (5xx) failures and never log request bodies or field values.
    const rawStatus = Number.isInteger(error?.status)
      ? error.status
      : Number.isInteger(error?.statusCode)
        ? error.statusCode
        : 500;
    const status = rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (status >= 500) {
      logger.error('[imstage-oauth] unhandled error', { name: error?.name ?? 'Error' });
      res.status(500).json({ error: 'server_error', error_description: '服务器内部错误' });
      return;
    }
    res.status(status).json({ error: 'invalid_request', error_description: '请求格式或大小不合法' });
  });

  const paths = new Set([
    '/api/oauth/authorize',
    '/api/oauth/token',
    '/api/oauth/register',
    '/api/oauth/revoke',
    ...AS_ALIASES,
    ...PRM_ALIASES,
  ]);

  return {
    app,
    paths,
    provider,
    clientsStore,
    metadata,
    protectedResourceMetadata,
    prmUrl,
    resourceUrl,
    issuerUrl,
    origin,
    getConsent,
    decideConsent,
  };
}

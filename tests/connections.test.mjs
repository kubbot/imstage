// Account-owned ChatGPT/MCP connection backend tests.
//
// Covers the frozen frontend contract and the OAuth 2.1 resource-server
// requirements end to end against a real (loopback) API process:
//   - discovery metadata + public connection config (never Host-derived)
//   - session-required connection management
//   - exact redirect rejection, PKCE mismatch, single-use codes
//   - consent CSRF/account-change/reuse safeguards and recent-session gate
//   - audience/scope rejection, resource echo
//   - access expiry, refresh rotation/replay, revoke, password revoke
//   - two-user isolation (scenes, idempotency, render cache)
//   - MCP create -> Web read -> Web write -> MCP read -> MCP update -> render
//   - tool metadata (securitySchemes, annotations) and no instance tools
//   - standalone /mcp instance server still behaves unchanged
//
// All storage is temporary; the renderer is an injected deterministic stub, so
// no Chromium launches and no real account or network write happens.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { start } from '../services/api/server.mjs';
import { startMcpServer } from '../services/mcp/server.mjs';
import { resolveMcpConfig } from '../services/mcp/config.mjs';
import { EXAMPLE_CREATE_SCENE } from '../services/mcp/scene.mjs';

const APP_ORIGIN = 'http://127.0.0.1:4417';
const REDIRECT_URI = 'http://127.0.0.1:4555/callback';
const RESOURCE = `${APP_ORIGIN}/api/mcp`;
const PASSWORD = 'password-123456';
const QUIET = { log() {}, warn() {}, error() {}, debug() {} };

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'imstage-connections-'));
const activeApps = new Set();

// A valid 1x1 PNG so render results stay decodable without launching Chromium.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_1X1_BASE64 = PNG_1X1.toString('base64');

function stubRenderService() {
  const calls = [];
  return {
    calls,
    async render(options) {
      calls.push(options);
      return {
        buffer: PNG_1X1,
        width: 1,
        height: 1,
        bytes: PNG_1X1.length,
        sha256: crypto.createHash('sha256').update(PNG_1X1).digest('hex'),
        pngBase64: PNG_1X1_BASE64,
      };
    },
  };
}

async function makeApp(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'case-'));
  const app = await start({
    dbPath: path.join(dir, 'imstage.db'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-missing'),
    logger: QUIET,
    renderService: stubRenderService(),
    ...overrides,
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}`, dir };
}

test.after(async () => {
  for (const app of activeApps) {
    try {
      await app.close();
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let emailSeq = 0;
function uniqueEmail(prefix) {
  emailSeq += 1;
  return `${prefix}-${process.pid}-${emailSeq}@example.com`;
}

function mutationHeaders(cookie, extras = {}) {
  const headers = {
    'content-type': 'application/json',
    origin: APP_ORIGIN,
    'x-imstage-request': '1',
    ...extras,
  };
  if (cookie) headers.cookie = cookie;
  return headers;
}

function cookieFrom(res, name = 'imstage_session') {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${name}=([^;]*)`).exec(setCookie);
  return match && match[1] !== '' ? `${name}=${match[1]}` : null;
}

async function register(base, prefix) {
  const email = uniqueEmail(prefix);
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify({ name: '连接测试用户', email, password: PASSWORD }),
  });
  assert.equal(res.status, 200, await res.text());
  return { email, cookie: cookieFrom(res) };
}

async function login(base, email, password = PASSWORD) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, await res.text());
  return cookieFrom(res);
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(base, { redirectUris = [REDIRECT_URI], name = 'Test Client' } = {}) {
  const res = await fetch(`${base}/api/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      client_name: name,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body;
}

function authorizeUrl(base, { clientId, redirectUri = REDIRECT_URI, challenge, scope, resource, state = 'state-1' }) {
  const url = new URL(`${base}/api/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (scope !== undefined && scope !== null) url.searchParams.set('scope', scope);
  if (resource !== undefined && resource !== null) url.searchParams.set('resource', resource);
  return url;
}

function requestIdFrom(location) {
  // The consent request id lives in the hash fragment (#/connect/authorize?request=...),
  // so URL.searchParams would not see it.
  const match = /[?&]request=([^&]+)/.exec(String(location ?? ''));
  return match ? decodeURIComponent(match[1]) : null;
}

async function getConsent(base, cookie, requestId) {
  const res = await fetch(`${base}/api/oauth/consent?request=${encodeURIComponent(requestId)}`, {
    headers: cookie ? { cookie } : {},
  });
  return { res, body: await res.json() };
}

async function postConsent(base, cookie, payload, extraHeaders = {}) {
  const res = await fetch(`${base}/api/oauth/consent`, {
    method: 'POST',
    headers: mutationHeaders(cookie, extraHeaders),
    body: JSON.stringify(payload),
  });
  return { res, body: await res.json() };
}

async function exchangeCode(base, { code, verifier, clientId, redirectUri = REDIRECT_URI, resource = RESOURCE }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource,
  });
  const res = await fetch(`${base}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  return { res, body: await res.json() };
}

async function refreshTokens(base, { refreshToken, clientId, resource = RESOURCE }) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource,
  });
  const res = await fetch(`${base}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  return { res, body: await res.json() };
}

/** Run authorize -> consent -> token exchange and return the tokens. */
async function obtainTokens(base, cookie, options = {}) {
  const client = options.client ?? (await registerClient(base, { redirectUris: [options.redirectUri ?? REDIRECT_URI] }));
  const { verifier, challenge } = pkce();
  const authorizeRes = await fetch(
    authorizeUrl(base, {
      clientId: client.client_id,
      redirectUri: options.redirectUri ?? REDIRECT_URI,
      challenge,
      scope: options.scope ?? 'imstage.scenes',
      resource: options.resource ?? RESOURCE,
      state: options.state ?? 'state-abc',
    }),
    { redirect: 'manual' },
  );
  assert.equal(authorizeRes.status, 302, await authorizeRes.text());
  const requestId = requestIdFrom(authorizeRes.headers.get('location'));
  const approval = await postConsent(base, cookie, { requestId, approved: true });
  assert.equal(approval.res.status, 200, JSON.stringify(approval.body));
  const code = new URL(approval.body.redirectUrl).searchParams.get('code');
  const exchanged = await exchangeCode(base, {
    code,
    verifier,
    clientId: client.client_id,
    redirectUri: options.redirectUri ?? REDIRECT_URI,
    resource: options.resource ?? RESOURCE,
  });
  assert.equal(exchanged.res.status, 200, JSON.stringify(exchanged.body));
  return { client, verifier, tokens: exchanged.body, requestId, authorizeRes };
}

async function connectMcp(base, token) {
  const client = new Client({ name: 'imstage-connections-test', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function mcp(base, token, message) {
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
}

function toolError(result) {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error;
}

function scene(id, overrides = {}) {
  return {
    id,
    title: '测试场景',
    platform: 'wechat',
    deviceTime: '09:41',
    date: '今天 09:41',
    selfId: 'p1',
    participants: [{ id: 'p1', name: '小林' }],
    messages: [{ id: 'm1', participantId: 'p1', type: 'text', text: '你好', time: '09:41' }],
    watermark: '',
    ...overrides,
  };
}

async function webGetScene(base, cookie, sceneId) {
  const res = await fetch(`${base}/api/scenes/${sceneId}`, { headers: { cookie } });
  return { res, body: await res.json() };
}

async function webPutScene(base, cookie, sceneId, value, revision) {
  const res = await fetch(`${base}/api/scenes/${sceneId}`, {
    method: 'PUT',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ revision, scene: value }),
  });
  return { res, body: await res.json() };
}

function createSceneArgument(overrides = {}) {
  return { ...structuredClone(EXAMPLE_CREATE_SCENE), ...overrides };
}

/** Raw GET with a spoofed Host header (fetch/undici forbids overriding Host). */
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* Main suite                                                          */
/* ------------------------------------------------------------------ */

test('account-owned ChatGPT/MCP connections', async (t) => {
  const { app, base } = await makeApp();
  const alice = await register(base, 'alice');
  const bob = await register(base, 'bob');

  await t.test('public config is derived only from the configured app origin', async () => {
    const res = await fetch(`${base}/api/connections/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      mcpUrl: `${APP_ORIGIN}/api/mcp`,
      authorizationSupported: true,
      directoryUrl: null,
      manualSetupRequired: true,
    });

    // A spoofed Host header must not change the advertised public URL.
    const spoofed = await rawGet(`${base}/api/connections/config`, { host: 'evil.example' });
    assert.equal(spoofed.status, 200);
    assert.equal(JSON.parse(spoofed.body).mcpUrl, `${APP_ORIGIN}/api/mcp`);
  });

  await t.test('discovery documents are served on every documented alias', async () => {
    const prmAliases = [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/api/mcp',
      '/api/.well-known/oauth-protected-resource',
    ];
    const asAliases = [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/api/oauth',
      '/api/.well-known/oauth-authorization-server',
    ];

    const prms = [];
    for (const alias of prmAliases) {
      const res = await fetch(base + alias);
      assert.equal(res.status, 200, alias);
      assert.match(res.headers.get('cache-control') ?? '', /no-store/);
      prms.push(await res.json());
    }
    for (const prm of prms) {
      assert.equal(prm.resource, RESOURCE);
      assert.deepEqual(prm.authorization_servers, [`${APP_ORIGIN}/api/oauth`]);
      assert.deepEqual(prm.scopes_supported, ['imstage.scenes']);
    }

    const metadataDocs = [];
    for (const alias of asAliases) {
      const res = await fetch(base + alias);
      assert.equal(res.status, 200, alias);
      metadataDocs.push(await res.json());
    }
    for (const doc of metadataDocs) {
      assert.equal(doc.issuer, `${APP_ORIGIN}/api/oauth`);
      assert.equal(doc.authorization_endpoint, `${APP_ORIGIN}/api/oauth/authorize`);
      assert.equal(doc.token_endpoint, `${APP_ORIGIN}/api/oauth/token`);
      assert.equal(doc.registration_endpoint, `${APP_ORIGIN}/api/oauth/register`);
      assert.equal(doc.revocation_endpoint, `${APP_ORIGIN}/api/oauth/revoke`);
      assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
      assert.deepEqual(doc.token_endpoint_auth_methods_supported, ['none']);
      assert.deepEqual(doc.grant_types_supported, ['authorization_code', 'refresh_token']);
      assert.ok(!doc.client_id_metadata_document_supported, 'no CIMD advertised (no client URL fetch)');
    }
  });

  await t.test('unauthenticated /api/mcp returns 401 with a resource_metadata challenge', async () => {
    const res = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /Bearer/);
    assert.match(challenge, /resource_metadata="http:\/\/127\.0\.0\.1:4417\/api\/\.well-known\/oauth-protected-resource"/);
    assert.match(challenge, /error="invalid_token"/);
  });

  await t.test('connection management requires a session', async () => {
    assert.equal((await fetch(`${base}/api/connections`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/connections/tokens`, {
          method: 'POST',
          headers: mutationHeaders(null),
          body: JSON.stringify({ name: 'x' }),
        })
      ).status,
      401,
    );
    assert.equal((await fetch(`${base}/api/oauth/consent?request=deadbeefdeadbeef`)).status, 401);
  });

  await t.test('dynamic registration rejects unsafe redirect URIs', async () => {
    const nonLoopbackHttp = await fetch(`${base}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://example.com/cb'], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(nonLoopbackHttp.status, 400);
    assert.equal((await nonLoopbackHttp.json()).error, 'invalid_client_metadata');

    const confidential = await fetch(`${base}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'client_secret_post' }),
    });
    assert.equal(confidential.status, 400);
  });

  await t.test('authorize rejects an unregistered redirect locally (never redirects)', async () => {
    const client = await registerClient(base, { redirectUris: ['https://client.example/cb'] });
    const { challenge } = pkce();
    const res = await fetch(
      authorizeUrl(base, {
        clientId: client.client_id,
        redirectUri: 'https://evil.example/cb',
        challenge,
        resource: RESOURCE,
      }),
      { redirect: 'manual' },
    );
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('location'), null);
    assert.equal((await res.json()).error, 'invalid_request');
  });

  await t.test('consent is explicit, session-bound and single-use', async () => {
    const client = await registerClient(base);
    const { verifier, challenge } = pkce();
    const authorizeRes = await fetch(
      authorizeUrl(base, {
        clientId: client.client_id,
        challenge,
        resource: RESOURCE,
        state: 'state-consent',
      }),
      { redirect: 'manual' },
    );
    assert.equal(authorizeRes.status, 302);
    const location = authorizeRes.headers.get('location');
    assert.match(location, /^http:\/\/127\.0\.0\.1:4417\/#\/connect\/authorize\?request=/);
    assert.doesNotMatch(location, /token|code=/);
    const requestId = requestIdFrom(location);

    const consent = await getConsent(base, alice.cookie, requestId);
    assert.equal(consent.res.status, 200);
    assert.deepEqual(Object.keys(consent.body).sort(), ['clientName', 'redirectHost', 'requestId', 'scopes']);
    assert.equal(consent.body.requestId, requestId);
    assert.equal(consent.body.clientName, 'Test Client');
    assert.equal(consent.body.redirectHost, '127.0.0.1:4555');
    assert.deepEqual(consent.body.scopes, ['imstage.scenes']);

    // GET binds the pending request to the first authenticated viewer and never
    // approves; it stays usable and still requires an explicit POST.
    assert.equal((await getConsent(base, alice.cookie, requestId)).res.status, 200);

    // A different account can no longer read or approve the bound request.
    assert.equal((await getConsent(base, bob.cookie, requestId)).res.status, 404);
    const foreignApprove = await postConsent(base, bob.cookie, { requestId, approved: true });
    assert.equal(foreignApprove.res.status, 404);

    // CSRF: cookie-authenticated approval needs Origin + request marker.
    const noOrigin = await fetch(`${base}/api/oauth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: alice.cookie },
      body: JSON.stringify({ requestId, approved: true }),
    });
    assert.equal(noOrigin.status, 403);

    // Account-change guard: a mismatched account header is rejected.
    const changed = await postConsent(base, alice.cookie, { requestId, approved: true }, { 'x-imstage-user': 'someone-else' });
    assert.equal(changed.res.status, 401);
    assert.equal(changed.body.error.code, 'account_changed');

    // The bound account's explicit approval mints the code.
    const approved = await postConsent(base, alice.cookie, { requestId, approved: true });
    assert.equal(approved.res.status, 200);
    const redirectUrl = new URL(approved.body.redirectUrl);
    assert.equal(redirectUrl.origin, 'http://127.0.0.1:4555');
    assert.equal(redirectUrl.searchParams.get('state'), 'state-consent');
    const code = redirectUrl.searchParams.get('code');
    assert.ok(code);

    // The request is consumed: nobody can approve or re-read it again.
    const again = await postConsent(base, alice.cookie, { requestId, approved: true });
    assert.equal(again.res.status, 404);
    assert.equal((await getConsent(base, alice.cookie, requestId)).res.status, 404);

    // The code belongs to the bound/approving account (alice), not bob.
    const exchanged = await exchangeCode(base, { code, verifier, clientId: client.client_id });
    assert.equal(exchanged.res.status, 200, JSON.stringify(exchanged.body));
    const aliceConnections = await (await fetch(`${base}/api/connections`, { headers: { cookie: alice.cookie } })).json();
    assert.equal(aliceConnections.items.length, 1);
    assert.equal(aliceConnections.items[0].kind, 'oauth');
    const bobConnections = await (await fetch(`${base}/api/connections`, { headers: { cookie: bob.cookie } })).json();
    assert.equal(bobConnections.items.length, 0);
  });

  await t.test('PKCE mismatch is rejected and a correct exchange still succeeds', async () => {
    const client = await registerClient(base);
    const { verifier, challenge } = pkce();
    const wrong = pkce();
    const authorizeRes = await fetch(
      authorizeUrl(base, { clientId: client.client_id, challenge, resource: RESOURCE }),
      { redirect: 'manual' },
    );
    const requestId = requestIdFrom(authorizeRes.headers.get('location'));
    const approved = await postConsent(base, alice.cookie, { requestId, approved: true });
    const code = new URL(approved.body.redirectUrl).searchParams.get('code');

    const bad = await exchangeCode(base, { code, verifier: wrong.verifier, clientId: client.client_id });
    assert.equal(bad.res.status, 400);
    assert.equal(bad.body.error, 'invalid_grant');

    const good = await exchangeCode(base, { code, verifier, clientId: client.client_id });
    assert.equal(good.res.status, 200, JSON.stringify(good.body));
  });

  await t.test('authorization code is single-use and reuse revokes the minted family', async () => {
    const client = await registerClient(base);
    const { verifier, challenge } = pkce();
    const authorizeRes = await fetch(
      authorizeUrl(base, { clientId: client.client_id, challenge, resource: RESOURCE }),
      { redirect: 'manual' },
    );
    const requestId = requestIdFrom(authorizeRes.headers.get('location'));
    const approved = await postConsent(base, alice.cookie, { requestId, approved: true });
    const code = new URL(approved.body.redirectUrl).searchParams.get('code');

    const first = await exchangeCode(base, { code, verifier, clientId: client.client_id });
    assert.equal(first.res.status, 200);
    const accessToken = first.body.access_token;

    const reuse = await exchangeCode(base, { code, verifier, clientId: client.client_id });
    assert.equal(reuse.res.status, 400);
    assert.equal(reuse.body.error, 'invalid_grant');

    // Reuse is treated as a leak: the tokens already minted are revoked.
    const afterReuse = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: '{}',
    });
    assert.equal(afterReuse.status, 401);
  });

  await t.test('audience and scope are validated with standard OAuth errors', async () => {
    const client = await registerClient(base);
    const { verifier, challenge } = pkce();

    const wrongAudience = await fetch(
      authorizeUrl(base, { clientId: client.client_id, challenge, resource: 'https://other.example/mcp' }),
      { redirect: 'manual' },
    );
    assert.equal(wrongAudience.status, 302);
    const audienceError = new URL(wrongAudience.headers.get('location'));
    assert.equal(audienceError.origin, 'http://127.0.0.1:4555');
    assert.equal(audienceError.searchParams.get('error'), 'invalid_target');
    assert.equal(audienceError.searchParams.get('state'), 'state-1');

    const badScope = await fetch(
      authorizeUrl(base, { clientId: client.client_id, challenge, resource: RESOURCE, scope: 'admin' }),
      { redirect: 'manual' },
    );
    assert.equal(badScope.status, 302);
    assert.equal(new URL(badScope.headers.get('location')).searchParams.get('error'), 'invalid_scope');

    // A valid authorization request exchanged with the wrong resource fails.
    const ok = await fetch(
      authorizeUrl(base, { clientId: client.client_id, challenge, resource: RESOURCE }),
      { redirect: 'manual' },
    );
    const requestId = requestIdFrom(ok.headers.get('location'));
    const approved = await postConsent(base, alice.cookie, { requestId, approved: true });
    const code = new URL(approved.body.redirectUrl).searchParams.get('code');
    const mismatched = await exchangeCode(base, {
      code,
      verifier,
      clientId: client.client_id,
      resource: 'https://other.example/mcp',
    });
    assert.equal(mismatched.res.status, 400);
    assert.equal(mismatched.body.error, 'invalid_grant');
  });

  await t.test('denial returns a validated redirect with access_denied and state', async () => {
    const client = await registerClient(base);
    const { challenge } = pkce();
    const authorizeRes = await fetch(
      authorizeUrl(base, { clientId: client.client_id, challenge, resource: RESOURCE, state: 'deny-state' }),
      { redirect: 'manual' },
    );
    const requestId = requestIdFrom(authorizeRes.headers.get('location'));
    const denied = await postConsent(base, alice.cookie, { requestId, approved: false });
    assert.equal(denied.res.status, 200);
    const url = new URL(denied.body.redirectUrl);
    assert.equal(url.origin, 'http://127.0.0.1:4555');
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('state'), 'deny-state');
    assert.equal(url.searchParams.get('code'), null);
  });

  await t.test('personal tokens are hashed, owner-scoped, listable and revocable', async () => {
    const created = await fetch(`${base}/api/connections/tokens`, {
      method: 'POST',
      headers: mutationHeaders(alice.cookie),
      body: JSON.stringify({ name: 'CLI 客户端' }),
    });
    assert.equal(created.status, 200);
    const { token, connection } = await created.json();
    assert.equal(typeof token, 'string');
    assert.ok(token.length >= 32);
    assert.equal(connection.kind, 'token');
    assert.equal(connection.clientName, 'CLI 客户端');
    assert.deepEqual(connection.scopes, ['imstage.scenes']);
    assert.equal(connection.lastUsedAt, null);

    // The name is bounded at 60 characters.
    const tooLong = await fetch(`${base}/api/connections/tokens`, {
      method: 'POST',
      headers: mutationHeaders(alice.cookie),
      body: JSON.stringify({ name: 'n'.repeat(61) }),
    });
    assert.equal(tooLong.status, 400);
    assert.equal((await tooLong.json()).error.code, 'invalid_name');

    // The token authenticates against /api/mcp.
    const client = await connectMcp(base, token);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'imstage_create_scene'));

    const list = await (await fetch(`${base}/api/connections`, { headers: { cookie: alice.cookie } })).json();
    const item = list.items.find((entry) => entry.id === connection.id);
    assert.ok(item, 'token connection appears in the list');
    assert.ok(item.lastUsedAt, 'use updates lastUsedAt');
    const serialized = JSON.stringify(list);
    assert.ok(!serialized.includes(token), 'list never exposes the plaintext token');
    assert.equal(Object.hasOwn(item, 'token'), false);

    const deleted = await fetch(`${base}/api/connections/${connection.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(alice.cookie),
      body: '{}',
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { ok: true });

    const afterDelete = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    assert.equal(afterDelete.status, 401, 'deleted token is invalidated immediately');

    const secondDelete = await fetch(`${base}/api/connections/${connection.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(alice.cookie),
      body: '{}',
    });
    assert.equal(secondDelete.status, 404);
  });

  await t.test('safe Origin policy and owner-scoped deletion', async () => {
    const created = await fetch(`${base}/api/connections/tokens`, {
      method: 'POST',
      headers: mutationHeaders(alice.cookie),
      body: JSON.stringify({ name: 'Origin token' }),
    });
    assert.equal(created.status, 200);
    const { token, connection } = await created.json();

    const hostileOrigin = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', Authorization: `Bearer ${token}` },
      body: '{}',
    });
    assert.equal(hostileOrigin.status, 403);

    const sameOrigin = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: APP_ORIGIN,
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
    assert.notEqual(sameOrigin.status, 403);
    assert.notEqual(sameOrigin.status, 401);

    // A foreign account can never delete it.
    const foreign = await fetch(`${base}/api/connections/${connection.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(bob.cookie),
      body: '{}',
    });
    assert.equal(foreign.status, 404);

    const cleanup = await fetch(`${base}/api/connections/${connection.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(alice.cookie),
      body: '{}',
    });
    assert.equal(cleanup.status, 200);
  });

  await t.test('MCP exposes only the account tools with OAuth securitySchemes', async () => {
    const { tokens } = await obtainTokens(base, alice.cookie);
    const init = await mcp(base, tokens.access_token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    });
    assert.equal(init.res.status, 200, JSON.stringify(init.body));
    const listed = await mcp(base, tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(listed.res.status, 200, JSON.stringify(listed.body));
    const names = listed.body.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'imstage_create_scene',
      'imstage_get_capabilities',
      'imstage_get_scene',
      'imstage_list_scenes',
      'imstage_render_scene',
      'imstage_update_scene',
    ]);
    for (const tool of listed.body.result.tools) {
      assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['imstage.scenes'] }], tool.name);
      assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', tool.name);
      assert.equal(tool.annotations.openWorldHint, false, tool.name);
      assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    }
    const renderTool = listed.body.result.tools.find((tool) => tool.name === 'imstage_render_scene');
    assert.equal(renderTool.annotations.readOnlyHint, true);
    assert.ok(renderTool._meta?.ui?.resourceUri);
    const updateTool = listed.body.result.tools.find((tool) => tool.name === 'imstage_update_scene');
    assert.equal(updateTool.annotations.readOnlyHint, false);
  });

  await t.test('hidden instance tools are not callable and never touch shared state', async () => {
    const { tokens } = await obtainTokens(base, alice.cookie);
    const client = await connectMcp(base, tokens.access_token);
    const hidden = [
      'imstage_create_project',
      'imstage_list_projects',
      'imstage_get_project',
      'imstage_update_project',
      'imstage_create_template',
      'imstage_list_templates',
      'imstage_get_template',
      'imstage_update_template',
      'imstage_create_batch',
      'imstage_get_batch',
      'imstage_list_batches',
    ];
    const scenesBefore = Number(app.db.prepare('SELECT COUNT(*) AS total FROM scenes').get().total);
    for (const name of hidden) {
      const error = toolError(await client.callTool({ name, arguments: {} }));
      assert.equal(error.code, 'invalid_request', name);
      assert.match(error.message, /未知工具/, name);
    }
    assert.equal(Number(app.db.prepare('SELECT COUNT(*) AS total FROM scenes').get().total), scenesBefore);
    for (const table of ['mcp_projects', 'mcp_batches', 'mcp_batch_items']) {
      const row = app.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      assert.equal(row, undefined, `${table} must not exist in the account database`);
    }
  });

  await t.test('tokens bound to another audience are rejected', async () => {
    const created = await fetch(`${base}/api/connections/tokens`, {
      method: 'POST',
      headers: mutationHeaders(bob.cookie),
      body: JSON.stringify({ name: '错 audiences' }),
    });
    assert.equal(created.status, 200, 'token name length is bounded at 60');
    const { token, connection } = await created.json();
    app.db.prepare('UPDATE oauth_grants SET resource = ? WHERE id = ?').run('https://other.example/mcp', connection.id);
    const probe = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: '{}',
    });
    assert.equal(probe.status, 401, 'wrong-audience token rejected');
    app.db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').run(connection.id);
    app.db.prepare('DELETE FROM oauth_grants WHERE id = ?').run(connection.id);
  });

  await t.test('oversized OAuth fields are rejected before hashing or storage', async () => {
    const client = await registerClient(base);
    const { challenge } = pkce();
    const longState = 's'.repeat(2000);
    const authorizeRes = await fetch(
      authorizeUrl(base, { clientId: client.client_id, challenge, resource: RESOURCE, state: longState }),
      { redirect: 'manual' },
    );
    assert.equal(authorizeRes.status, 400);
    assert.equal(authorizeRes.headers.get('location'), null);
    assert.equal((await authorizeRes.json()).error, 'invalid_request');

    const tokenRes = await fetch(`${base}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'x'.repeat(600),
        code_verifier: 'v'.repeat(300),
        client_id: client.client_id,
      }),
    });
    assert.equal(tokenRes.status, 400);
    assert.equal((await tokenRes.json()).error, 'invalid_request');
  });

  await t.test('MCP create -> Web read -> Web write -> MCP read -> MCP update -> render', async () => {
    const { tokens } = await obtainTokens(base, alice.cookie);
    const client = await connectMcp(base, tokens.access_token);

    const created = await client.callTool({
      name: 'imstage_create_scene',
      arguments: { scene: createSceneArgument(), idempotencyKey: 'create-flow-1' },
    });
    assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
    const sceneId = created.structuredContent.sceneId;
    assert.match(sceneId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Web-compatible UUID');
    assert.equal(created.structuredContent.revision, 1);
    assert.equal(created.structuredContent.webUrl, `${APP_ORIGIN}/#/workspace?scene=${sceneId}`);

    // The Web list/get must see the MCP-created scene.
    const webGet = await webGetScene(base, alice.cookie, sceneId);
    assert.equal(webGet.res.status, 200);
    assert.equal(webGet.body.item.revision, 1);
    assert.equal(webGet.body.item.scene.title, EXAMPLE_CREATE_SCENE.title);

    // A Web edit must be read back by MCP.
    const webScene = { ...webGet.body.item.scene, title: '网页改过的标题' };
    const webPut = await webPutScene(base, alice.cookie, sceneId, webScene, 1);
    assert.equal(webPut.res.status, 200, JSON.stringify(webPut.body));
    assert.equal(webPut.body.item.revision, 2);

    const mcpRead = await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId } });
    assert.equal(mcpRead.structuredContent.revision, 2);
    assert.equal(mcpRead.structuredContent.scene.title, '网页改过的标题');
    assert.equal(mcpRead.structuredContent.webUrl, `${APP_ORIGIN}/#/workspace?scene=${sceneId}`);

    // An MCP patch must be visible to the Web reload.
    const updated = await client.callTool({
      name: 'imstage_update_scene',
      arguments: {
        sceneId,
        expectedRevision: 2,
        patch: { set: { title: 'MCP 改过的标题' } },
        idempotencyKey: 'update-flow-1',
      },
    });
    assert.notEqual(updated.isError, true, JSON.stringify(updated.structuredContent));
    assert.equal(updated.structuredContent.revision, 3);

    const reload = await webGetScene(base, alice.cookie, sceneId);
    assert.equal(reload.body.item.revision, 3);
    assert.equal(reload.body.item.scene.title, 'MCP 改过的标题');

    // Deterministic render through the injected stub.
    const rendered = await client.callTool({
      name: 'imstage_render_scene',
      arguments: { sceneId, surface: 'ios', width: 390, outputKind: 'long-screenshot' },
    });
    assert.notEqual(rendered.isError, true, JSON.stringify(rendered.structuredContent));
    assert.equal(rendered.structuredContent.sceneId, sceneId);
    assert.equal(rendered.structuredContent.webUrl, `${APP_ORIGIN}/#/workspace?scene=${sceneId}`);
    assert.ok(rendered.structuredContent.renderId);
    assert.equal(rendered.structuredContent.width, 1);
    assert.ok(rendered.content.some((block) => block.type === 'image'));
    assert.equal(rendered.structuredContent.ephemeral, false);

    const listed = await client.callTool({ name: 'imstage_list_scenes', arguments: { limit: 10 } });
    const entry = listed.structuredContent.items.find((item) => item.sceneId === sceneId);
    assert.ok(entry);
    assert.equal(entry.revision, 3);
    assert.equal(entry.webUrl, `${APP_ORIGIN}/#/workspace?scene=${sceneId}`);
    assert.equal(Object.hasOwn(entry, 'scene'), false, 'list omits full scene JSON');
  });

  await t.test('idempotent create/update retries still succeed after a later edit', async () => {
    const { tokens } = await obtainTokens(base, bob.cookie);
    const client = await connectMcp(base, tokens.access_token);
    const bobUserId = app.db.prepare('SELECT id FROM users WHERE email = ?').get(bob.email).id;
    const countScenes = () =>
      Number(app.db.prepare('SELECT COUNT(*) AS total FROM scenes WHERE user_id = ?').get(bobUserId).total);

    const created = await client.callTool({
      name: 'imstage_create_scene',
      arguments: { scene: createSceneArgument(), idempotencyKey: 'retry-create' },
    });
    assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
    const sceneId = created.structuredContent.sceneId;
    const scenesAfterCreate = countScenes();

    const firstUpdate = await client.callTool({
      name: 'imstage_update_scene',
      arguments: { sceneId, expectedRevision: 1, patch: { set: { title: '第一次修改' } }, idempotencyKey: 'retry-update' },
    });
    assert.equal(firstUpdate.structuredContent.revision, 2);

    // A later edit without an idempotency key bumps the revision further, so the
    // original revision is no longer the current scene.
    const laterUpdate = await client.callTool({
      name: 'imstage_update_scene',
      arguments: { sceneId, expectedRevision: 2, patch: { set: { title: '后续修改' } } },
    });
    assert.equal(laterUpdate.structuredContent.revision, 3);

    // Retrying the original create must not duplicate or fail.
    const createRetry = await client.callTool({
      name: 'imstage_create_scene',
      arguments: { scene: createSceneArgument(), idempotencyKey: 'retry-create' },
    });
    assert.notEqual(createRetry.isError, true, JSON.stringify(createRetry.structuredContent));
    assert.equal(createRetry.structuredContent.deduplicated, true);
    assert.equal(createRetry.structuredContent.sceneId, sceneId);
    assert.equal(createRetry.structuredContent.revision, 1);
    assert.equal(createRetry.structuredContent.latestRevision, 3);

    // Retrying the original update must not bump the revision again.
    const updateRetry = await client.callTool({
      name: 'imstage_update_scene',
      arguments: { sceneId, expectedRevision: 1, patch: { set: { title: '第一次修改' } }, idempotencyKey: 'retry-update' },
    });
    assert.notEqual(updateRetry.isError, true, JSON.stringify(updateRetry.structuredContent));
    assert.equal(updateRetry.structuredContent.deduplicated, true);
    assert.equal(updateRetry.structuredContent.revision, 2);
    assert.equal(updateRetry.structuredContent.latestRevision, 3);

    const finalRead = await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId } });
    assert.equal(finalRead.structuredContent.revision, 3);
    assert.equal(finalRead.structuredContent.scene.title, '后续修改');
    assert.equal(countScenes(), scenesAfterCreate, 'no duplicate scene from create retry');
  });

  await t.test('two accounts are isolated across scenes, idempotency and render cache', async () => {
    const aliceTokens = await obtainTokens(base, alice.cookie);
    const bobTokens = await obtainTokens(base, bob.cookie);
    const aliceClient = await connectMcp(base, aliceTokens.tokens.access_token);
    const bobClient = await connectMcp(base, bobTokens.tokens.access_token);

    const created = await aliceClient.callTool({
      name: 'imstage_create_scene',
      arguments: { scene: createSceneArgument(), idempotencyKey: 'shared-key' },
    });
    const sceneId = created.structuredContent.sceneId;

    // Same idempotency key for a different account is a different namespace.
    const bobCreated = await bobClient.callTool({
      name: 'imstage_create_scene',
      arguments: { scene: createSceneArgument({ title: 'Bob 的场景' }), idempotencyKey: 'shared-key' },
    });
    assert.notEqual(bobCreated.isError, true, JSON.stringify(bobCreated.structuredContent));
    assert.notEqual(bobCreated.structuredContent.sceneId, sceneId);

    // Alice's scene is invisible to Bob.
    assert.equal(toolError(await bobClient.callTool({ name: 'imstage_get_scene', arguments: { sceneId } })).code, 'scene_not_found');
    assert.equal(
      toolError(await bobClient.callTool({ name: 'imstage_update_scene', arguments: { sceneId, expectedRevision: 1, patch: { set: { title: 'x' } } } })).code,
      'scene_not_found',
    );
    const bobList = await bobClient.callTool({ name: 'imstage_list_scenes', arguments: {} });
    const bobSceneIds = bobList.structuredContent.items.map((item) => item.sceneId);
    assert.ok(bobSceneIds.includes(bobCreated.structuredContent.sceneId), 'bob sees his own scene');
    assert.ok(!bobSceneIds.includes(sceneId), "bob never sees alice's scene");

    // Alice re-reads her own scene and the render cache is owner-scoped.
    const rendered = await aliceClient.callTool({ name: 'imstage_render_scene', arguments: { sceneId } });
    assert.notEqual(rendered.isError, true);
    const renderId = rendered.structuredContent.renderId;
    const ownResource = await aliceClient.readResource({ uri: `imstage://renders/${renderId}.png` });
    assert.equal(ownResource.contents[0].mimeType, 'image/png');
    await assert.rejects(
      () => bobClient.readResource({ uri: `imstage://renders/${renderId}.png` }),
      /渲染不存在|not found/i,
    );
  });

  await t.test('refresh rotation, replay revocation, revoke and password revoke', async () => {
    // A refresh token only works for the client it was issued to.
    const wrongClient = await registerClient(base, { name: 'wrong-refresh-client' });
    const issued = await obtainTokens(base, alice.cookie);
    const wrongHolder = await refreshTokens(base, {
      refreshToken: issued.tokens.refresh_token,
      clientId: wrongClient.client_id,
    });
    assert.equal(wrongHolder.res.status, 400);

    const { client, tokens: first } = await obtainTokens(base, alice.cookie);
    const refreshed = await refreshTokens(base, { refreshToken: first.refresh_token, clientId: client.client_id });
    assert.equal(refreshed.res.status, 200, JSON.stringify(refreshed.body));
    assert.ok(refreshed.body.access_token);
    assert.ok(refreshed.body.refresh_token);

    // Replaying the rotated refresh token revokes the whole family.
    const replay = await refreshTokens(base, { refreshToken: first.refresh_token, clientId: client.client_id });
    assert.equal(replay.res.status, 400);
    assert.equal(replay.body.error, 'invalid_grant');
    for (const token of [refreshed.body.access_token, refreshed.body.refresh_token]) {
      const probe = await fetch(`${base}/api/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      assert.equal(probe.status, 401, 'family revoked after replay');
    }
    // The replacement refresh token must also be dead at the token endpoint.
    const replacementReplay = await refreshTokens(base, {
      refreshToken: refreshed.body.refresh_token,
      clientId: client.client_id,
    });
    assert.equal(replacementReplay.res.status, 400);
    assert.equal(replacementReplay.body.error, 'invalid_grant');

    // RFC 7009 revocation.
    const revocable = await obtainTokens(base, alice.cookie);
    const revokeRes = await fetch(`${base}/api/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: revocable.tokens.refresh_token,
        token_type_hint: 'refresh_token',
        client_id: revocable.client.client_id,
      }),
    });
    assert.equal(revokeRes.status, 200);
    const revokedProbe = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${revocable.tokens.access_token}` },
      body: '{}',
    });
    assert.equal(revokedProbe.status, 401);

    // Password change revokes every remaining connection, session and any
    // approved-but-unredeemed authorization code.
    const preChange = await obtainTokens(base, alice.cookie);
    const pendingClient = await registerClient(base, { name: 'pending-code-client' });
    const pendingPkce = pkce();
    const pendingAuthorize = await fetch(
      authorizeUrl(base, { clientId: pendingClient.client_id, challenge: pendingPkce.challenge, resource: RESOURCE }),
      { redirect: 'manual' },
    );
    const pendingRequestId = requestIdFrom(pendingAuthorize.headers.get('location'));
    const pendingApproval = await postConsent(base, alice.cookie, { requestId: pendingRequestId, approved: true });
    assert.equal(pendingApproval.res.status, 200);
    const pendingCode = new URL(pendingApproval.body.redirectUrl).searchParams.get('code');
    assert.ok(pendingCode);

    const beforeChange = await (await fetch(`${base}/api/connections`, { headers: { cookie: alice.cookie } })).json();
    assert.ok(beforeChange.items.length >= 1);
    const change = await fetch(`${base}/api/auth/password`, {
      method: 'POST',
      headers: mutationHeaders(alice.cookie),
      body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'new-password-987654' }),
    });
    assert.equal(change.status, 200);
    const passwordProbe = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${preChange.tokens.access_token}` },
      body: '{}',
    });
    assert.equal(passwordProbe.status, 401);
    assert.equal((await fetch(`${base}/api/connections`, { headers: { cookie: alice.cookie } })).status, 401);

    // The unredeemed code cannot mint a fresh grant after the password change.
    const burned = await exchangeCode(base, {
      code: pendingCode,
      verifier: pendingPkce.verifier,
      clientId: pendingClient.client_id,
    });
    assert.equal(burned.res.status, 400);
    assert.equal(burned.body.error, 'invalid_grant');
  });
});

/* ------------------------------------------------------------------ */
/* Mid-flight revocation                                               */
/* ------------------------------------------------------------------ */

test('revocation while an MCP body is uploading prevents a delayed write', async () => {
  const { app, base } = await makeApp();
  const user = await register(base, 'delayed-body');
  const { tokens } = await obtainTokens(base, user.cookie);
  const userId = app.db.prepare('SELECT id FROM users WHERE email = ?').get(user.email).id;
  const grant = app.db.prepare('SELECT id FROM oauth_grants WHERE user_id = ?').get(userId);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'imstage_create_scene', arguments: { scene: createSceneArgument() },
  } });
  let request;
  const response = new Promise((resolve, reject) => {
    request = http.request(`${base}/api/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.access_token}`,
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    request.on('error', reject);
    request.write(body.slice(0, 1));
  });
  try {
    let authenticated = false;
    for (let i = 0; i < 100; i++) {
      authenticated = Boolean(app.db.prepare('SELECT last_used_at FROM oauth_grants WHERE id = ?').get(grant.id)?.last_used_at);
      if (authenticated) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(authenticated, true, 'first credential check happened before revocation');
    const revoke = await fetch(`${base}/api/connections/${grant.id}`, { method: 'DELETE', headers: mutationHeaders(user.cookie), body: '{}' });
    assert.equal(revoke.status, 200);
    request.end(body.slice(1));
    assert.equal(await response, 401);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS total FROM scenes WHERE user_id = ?').get(userId).total, 0);
  } finally {
    request.destroy();
  }
});

test('in-flight render is rejected when authorization is revoked', async () => {
  let appRef = null;
  let revokedUserId = null;
  const renderService = {
    async render() {
      // Simulate a revoke/password change landing while Chromium is working.
      appRef.db.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').run(revokedUserId);
      appRef.db.prepare('DELETE FROM oauth_grants WHERE user_id = ?').run(revokedUserId);
      return {
        buffer: PNG_1X1,
        width: 1,
        height: 1,
        bytes: PNG_1X1.length,
        sha256: crypto.createHash('sha256').update(PNG_1X1).digest('hex'),
        pngBase64: PNG_1X1_BASE64,
      };
    },
  };
  const { app, base } = await makeApp({ renderService });
  appRef = app;
  const user = await register(base, 'midrender');
  revokedUserId = app.db.prepare('SELECT id FROM users WHERE email = ?').get(user.email).id;
  const { tokens } = await obtainTokens(base, user.cookie);
  const client = await connectMcp(base, tokens.access_token);

  const created = await client.callTool({ name: 'imstage_create_scene', arguments: { scene: createSceneArgument() } });
  assert.notEqual(created.isError, true, JSON.stringify(created.structuredContent));
  const sceneId = created.structuredContent.sceneId;

  const rendersBefore = Number(app.db.prepare('SELECT COUNT(*) AS total FROM mcp_renders WHERE user_id = ?').get(revokedUserId).total);
  const rendered = await client.callTool({ name: 'imstage_render_scene', arguments: { sceneId } });
  assert.equal(rendered.isError, true);
  assert.equal(rendered.structuredContent.error.code, 'unauthorized');
  const rendersAfter = Number(app.db.prepare('SELECT COUNT(*) AS total FROM mcp_renders WHERE user_id = ?').get(revokedUserId).total);
  assert.equal(rendersAfter, rendersBefore, 'revoked render is never persisted');

  // The next request is rejected at the transport layer.
  const after = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` },
    body: '{}',
  });
  assert.equal(after.status, 401);
});

/* ------------------------------------------------------------------ */
/* Clock-dependent behavior                                            */
/* ------------------------------------------------------------------ */

test('token expiry, refresh expiry, and recent-session gate', async (t) => {
  let clock = Date.now();
  const { base } = await makeApp({ now: () => new Date(clock), recentSessionMs: 60_000 });
  const user = await register(base, 'clock');

  await t.test('consent approval requires a recent session', async () => {
    const client = await registerClient(base);
    const { challenge } = pkce();
    const authorizeRes = await fetch(
      authorizeUrl(base, { clientId: client.client_id, challenge, resource: RESOURCE }),
      { redirect: 'manual' },
    );
    const requestId = requestIdFrom(authorizeRes.headers.get('location'));
    clock += 5 * 60 * 1000; // older than the configured 60s recent-session window
    const denied = await postConsent(base, user.cookie, { requestId, approved: true });
    assert.equal(denied.res.status, 401);
    assert.equal(denied.body.error.code, 'reauthentication_required');
    // Nothing was issued.
    assert.equal((await getConsent(base, user.cookie, requestId)).res.status, 200);
  });

  await t.test('access tokens expire and refresh tokens can be rotated once', async () => {
    // The previous subtest moved the clock past the 60s recent-session window,
    // so start a fresh session for the rest of this flow.
    const cookie = await login(base, user.email);
    const { client, tokens } = await obtainTokens(base, cookie);
    const ok = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` },
      body: '{}',
    });
    assert.notEqual(ok.status, 401);

    clock += 2 * 60 * 60 * 1000; // 2 hours: access token (1h) expired
    const expired = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` },
      body: '{}',
    });
    assert.equal(expired.status, 401);

    const refreshed = await refreshTokens(base, { refreshToken: tokens.refresh_token, clientId: client.client_id });
    assert.equal(refreshed.res.status, 200, JSON.stringify(refreshed.body));

    clock += 31 * 24 * 60 * 60 * 1000; // 31 days: refresh token (30d) expired
    const stale = await refreshTokens(base, { refreshToken: refreshed.body.refresh_token, clientId: client.client_id });
    assert.equal(stale.res.status, 400);
    assert.equal(stale.body.error, 'invalid_grant');
  });
});

/* ------------------------------------------------------------------ */
/* Bounded rates                                                       */
/* ------------------------------------------------------------------ */

test('OAuth and MCP request rates are bounded', async (t) => {
  const { base } = await makeApp({
    rateLimit: {
      oauthRegister: { windowMs: 60_000, max: 2, maxKeys: 100 },
      mcp: { windowMs: 60_000, max: 2, maxKeys: 100 },
    },
  });

  await t.test('dynamic registration is rate limited', async () => {
    const first = await fetch(`${base}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(first.status, 201);
    const second = await fetch(`${base}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(second.status, 201);
    const third = await fetch(`${base}/api/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(third.status, 429);
    assert.ok(third.headers.get('retry-after'));
  });

  await t.test('/api/mcp is rate limited before authentication', async () => {
    const responses = [];
    for (let i = 0; i < 3; i += 1) {
      responses.push(
        await fetch(`${base}/api/mcp`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
    }
    assert.deepEqual(responses.map((res) => res.status), [401, 401, 429]);
  });
});

/* ------------------------------------------------------------------ */
/* Standalone instance MCP compatibility                               */
/* ------------------------------------------------------------------ */

test('standalone /mcp instance server is unchanged', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'standalone-'));
  const token = 'standalone-token-1234567890';
  const handle = await startMcpServer({
    config: {
      ...resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir, IMSTAGE_MCP_TOKEN: token, IMSTAGE_MCP_PORT: '0' }),
    },
    logger: QUIET,
  });
  try {
    const client = new Client({ name: 'standalone-check', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes('imstage_create_batch'), 'instance batch tools preserved');
    assert.ok(names.includes('imstage_create_template'), 'instance template tools preserved');
    assert.ok(names.includes('imstage_create_project'), 'instance project tools preserved');
    assert.equal(names.length, 16);

    const created = await client.callTool({
      name: 'imstage_create_scene',
      arguments: { scene: createSceneArgument() },
    });
    assert.match(created.structuredContent.sceneId, /^scn_[0-9a-f]{32}$/, 'instance ids unchanged');
    assert.equal(created.structuredContent.webUrl, undefined, 'standalone results have no webUrl');
  } finally {
    await handle.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { start } from '../services/api/server.mjs';

const CLIENT = '1234567890-api-fixture.apps.googleusercontent.com';
const ORIGIN = 'http://127.0.0.1:4417';
const PASSWORD = 'synthetic-password-2026';

function cookiesFrom(headers, jar) {
  for (const raw of headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const at = pair.indexOf('=');
    if (/;\s*Max-Age=0(?:;|$)/i.test(raw)) jar.delete(pair.slice(0, at));
    else jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}

async function fixture(t, overrides = {}) {
  const root = path.resolve(process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir());
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'imstage-google-api-'));
  const tokens = new Map(), logs = [];
  const app = await start({
    port: 0, appOrigin: ORIGIN, dbPath: path.join(dir, 'imstage.db'), distDir: null,
    googleClientId: CLIENT,
    googleVerifyToken: async credential => {
      const value = tokens.get(credential);
      if (!value) throw new Error('Unknown synthetic Google credential');
      return typeof value === 'function' ? value() : value;
    },
    logger: { log() {}, error: (...items) => logs.push(items.map(String).join(' ')) },
    ...overrides,
  });
  t.after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.port}`;
  function client() {
    const jar = new Map();
    const context = crypto.randomBytes(32).toString('base64url');
    async function request(route, data, { headers = {}, captureCookies = true } = {}) {
      const h = { origin: ORIGIN, 'content-type': 'application/json', 'x-imstage-request': '1', 'x-imstage-auth-context': context,
        cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...headers };
      const response = await fetch(base + route, { method: data === undefined ? 'GET' : 'POST', headers: h, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      const body = await response.json();
      if (captureCookies) cookiesFrom(response.headers, jar);
      return { response, body, status: response.status };
    }
    return { jar, context, request };
  }
  function token(flow, changes = {}) {
    const credential = 'synthetic-' + crypto.randomUUID();
    tokens.set(credential, { iss: 'https://accounts.google.com', aud: CLIENT, sub: 'google-api-sub', email: 'google-owner@example.test', email_verified: true,
      name: 'Google Owner', nonce: flow.nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...changes });
    return credential;
  }
  async function challenge(c, intent = 'signin', extra = {}) {
    const result = await c.request('/api/auth/google/challenge', { intent, ...extra });
    assert.equal(result.status, 200);
    assert.ok(result.body.flowId);
    assert.ok(result.body.nonce);
    return result.body;
  }
  const ready = await client().request('/api/auth/google/config');
  assert.equal(ready.status, 200, 'Google config endpoint must exist');
  return { app, base, dbPath: app.config.dbPath, client, token, tokens, logs, challenge };
}

async function passwordAccount(c, email = 'password-owner@example.test') {
  const result = await c.request('/api/auth/register', { name: 'Password Owner', email, password: PASSWORD });
  assert.equal(result.status, 200);
  return result.body.user;
}

async function googleAccount(f, c, changes = {}) {
  const flow = await f.challenge(c);
  const result = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow, changes), termsAccepted: true });
  assert.equal(result.status, 200);
  return result.body.user;
}

test('unconfigured Google stays unavailable without breaking password login', async t => {
  const f = await fixture(t, { googleClientId: '' });
  const c = f.client();
  const config = await c.request('/api/auth/google/config');
  assert.equal(config.body.enabled, false);
  const denied = await c.request('/api/auth/google/challenge', { intent: 'signin' });
  assert.equal(denied.status, 503);
  const user = await passwordAccount(c);
  assert.equal((await c.request('/api/auth/session')).body.user.id, user.id);
});

test('new Google users must accept terms before an account and session are created', async t => {
  const f = await fixture(t), c = f.client(), flow = await f.challenge(c);
  const verified = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow) });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.registrationRequired, true);
  assert.equal(verified.body.profile.email, 'google-owner@example.test');
  assert.equal((await c.request('/api/auth/session')).body.user, null);
  assert.equal((await c.request('/api/auth/google/register', { flowId: flow.flowId, termsAccepted: false })).status, 400);
  const registered = await c.request('/api/auth/google/register', { flowId: flow.flowId, name: 'Consenting Owner', termsAccepted: true });
  assert.equal(registered.status, 200);
  assert.equal(registered.body.user.name, 'Consenting Owner');
  assert.equal((await c.request('/api/auth/session')).body.user.id, registered.body.user.id);
  const methods = (await c.request('/api/auth/methods')).body;
  assert.equal(methods.password, false);
  assert.equal(methods.google.linked, true);
});

test('Google-only accounts reject passwords and cannot remove their only login method', async t => {
  const f = await fixture(t), c = f.client();
  const user = await googleAccount(f, c);
  const invalidPassword = await c.request('/api/auth/login', { email: user.email, password: PASSWORD });
  assert.equal(invalidPassword.status, 401);
  assert.equal(invalidPassword.body.error.code, 'invalid_credentials');
  assert.equal((await c.request('/api/auth/session')).body.user.id, user.id);
  const unlink = await c.request('/api/auth/google/unlink', { password: PASSWORD });
  assert.equal(unlink.status, 409);
  assert.equal(unlink.body.error.code, 'google_last_signin_method');
});

test('returning Google subject keeps its account when the verified email changes', async t => {
  const f = await fixture(t), c = f.client();
  const user = await googleAccount(f, c);
  await c.request('/api/auth/logout', {});
  const flow = await f.challenge(c);
  const result = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow, { email: 'renamed-google@example.test' }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.id, user.id);
  assert.equal(result.body.user.email, user.email);
});

test('a matching Workspace Google email signs into the password account and preserves existing works', async t => {
  const f = await fixture(t), c = f.client();
  const user = await passwordAccount(c, 'google-owner@example.test');
  const id = crypto.randomUUID();
  const scene = { id, title: 'Existing synthetic work', platform: 'wechat', deviceTime: '09:41', date: '今天', selfId: 'me', participants: [{ id: 'me', name: 'Owner' }], messages: [{ id: 'm1', participantId: 'me', type: 'text', text: 'Preserved', time: '09:41' }], watermark: 'AI生成 / 虚构' };
  const saved = await fetch(f.base + '/api/scenes/' + id, { method: 'PUT', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-imstage-request': '1', 'x-imstage-user': user.id, cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: JSON.stringify({ scene, revision: 0 }) });
  assert.equal(saved.status, 200);
  await c.request('/api/auth/logout', {});
  let flow = await f.challenge(c);
  const merged = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow, { hd: 'example.test' }) });
  assert.equal(merged.status, 200);
  assert.deepEqual(merged.body.user, user);
  assert.equal((await c.request('/api/auth/session')).body.user.id, user.id);
  const methods = (await c.request('/api/auth/methods')).body;
  assert.equal(methods.google.linked, true);
  assert.equal(methods.password, true);
  await c.request('/api/auth/logout', {});
  const passwordLogin = await c.request('/api/auth/login', { email: user.email, password: PASSWORD });
  assert.equal(passwordLogin.status, 200);
  assert.equal(passwordLogin.body.user.id, user.id);
  await c.request('/api/auth/logout', {});
  flow = await f.challenge(c);
  const returning = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow) });
  assert.equal(returning.status, 200);
  assert.equal(returning.body.user.id, user.id);
  assert.equal((await c.request('/api/auth/session')).body.user.id, user.id);
  const read = await fetch(f.base + '/api/scenes/' + id, { headers: { 'x-imstage-user': user.id, cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).item.scene.title, scene.title);
});

test('a matching Gmail account signs in without a hosted-domain claim', async t => {
  const f = await fixture(t), c = f.client();
  const user = await passwordAccount(c, 'google-owner@gmail.com');
  await c.request('/api/auth/logout', {});
  const flow = await f.challenge(c);
  const result = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow, { email: user.email }) });
  assert.equal(result.status, 200);
  assert.equal(result.body.user.id, user.id);
});

for (const [label, claim] of [['absent', undefined], ['empty', ''], ['non-string', 123], ['mismatched', 'other.test']]) {
  test(`a verified third-party email with ${label} hosted domain cannot bind a password account`, async t => {
    const f = await fixture(t), c = f.client();
    const user = await passwordAccount(c, 'google-owner@example.test');
    await c.request('/api/auth/logout', {});
    let flow = await f.challenge(c);
    const denied = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow, { hd: claim }) });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.error.code, 'google_account_link_required');
    assert.equal(c.jar.has('imstage_session'), false);
    assert.equal((await c.request('/api/auth/session')).body.user, null);
    const login = await c.request('/api/auth/login', { email: user.email, password: PASSWORD });
    assert.equal(login.body.user.id, user.id);
    assert.equal((await c.request('/api/auth/methods')).body.google.linked, false);
    if (label === 'absent') {
      flow = await f.challenge(c, 'link', { password: PASSWORD });
      const linked = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow) });
      assert.equal(linked.status, 200);
      assert.equal(linked.body.user.id, user.id);
      await c.request('/api/auth/logout', {});
      assert.equal((await googleAccount(f, c)).id, user.id);
    }
  });
}

for (const [label, claims, expected] of [['third-party', {}, 409], ['Workspace', { hd: 'example.test' }, 200]]) {
  test(`pending ${label} registration rechecks email authority if a password account appears`, async t => {
    const f = await fixture(t), c = f.client(), other = f.client();
    const flow = await f.challenge(c);
    const pending = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow, claims) });
    assert.equal(pending.body.registrationRequired, true);
    assert.deepEqual(Object.keys(pending.body.profile).sort(), ['email', 'name']);
    const owner = await passwordAccount(other, 'google-owner@example.test');
    const result = await c.request('/api/auth/google/register', { flowId: flow.flowId, termsAccepted: true });
    assert.equal(result.status, expected);
    if (expected === 409) {
      assert.equal(result.body.error.code, 'google_account_link_required');
      assert.equal((await c.request('/api/auth/session')).body.user, null);
      assert.equal((await other.request('/api/auth/methods')).body.google.linked, false);
    } else assert.equal(result.body.user.id, owner.id);
  });
}

test('an unverified matching Google email cannot link or create a session', async t => {
  const f = await fixture(t), c = f.client();
  const user = await passwordAccount(c, 'google-owner@example.test');
  await c.request('/api/auth/logout', {});
  const flow = await f.challenge(c);
  const rejected = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow, { email_verified: false }) });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.error.code, 'google_invalid_identity');
  assert.equal(c.jar.has('imstage_session'), false);
  assert.equal((await c.request('/api/auth/session')).body.user, null);
  const login = await c.request('/api/auth/login', { email: user.email, password: PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.id, user.id);
  assert.equal((await c.request('/api/auth/methods')).body.google.linked, false);
});

test('Google identity already belonging to another user cannot replace a password account', async t => {
  const f = await fixture(t), a = f.client(), b = f.client();
  const google = await googleAccount(f, b);
  const password = await passwordAccount(a);
  const flow = await f.challenge(a, 'link', { password: PASSWORD });
  const result = await a.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow) });
  assert.equal(result.status, 409);
  assert.equal((await a.request('/api/auth/session')).body.user.id, password.id);
  assert.equal((await b.request('/api/auth/session')).body.user.id, google.id);
});

test('Google mutations preserve Origin and JSON guards', async t => {
  const f = await fixture(t), c = f.client();
  assert.equal((await c.request('/api/auth/google/challenge', { intent: 'signin' }, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.request('/api/auth/google/challenge', { intent: 'signin' }, { headers: { 'content-type': 'text/plain' } })).status, 415);
});

test('credential replay fails and malformed identity is not logged', async t => {
  const f = await fixture(t), c = f.client(), flow = await f.challenge(c);
  const credential = f.token(flow);
  const success = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential, termsAccepted: true });
  assert.equal(success.status, 200);
  assert.notEqual((await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential, termsAccepted: true })).status, 200);
  assert.equal((await c.request('/api/auth/session')).body.user.id, success.body.user.id);
  await c.request('/api/auth/logout', {});
  const fresh = await f.challenge(c), invalid = 'synthetic-credential-must-not-appear-in-logs';
  assert.equal((await c.request('/api/auth/google/credential', { flowId: fresh.flowId, credential: invalid })).status, 401);
  assert.equal(f.logs.join('\n').includes(invalid), false);
});

test('logout during verification invalidates the pending Google identity', async t => {
  const f = await fixture(t), c = f.client(), flow = await f.challenge(c);
  const credential = f.token(flow);
  const claims = f.tokens.get(credential);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.tokens.set(credential, async () => { enter(); await gate; return claims; });
  const pending = c.request('/api/auth/google/credential', { flowId: flow.flowId, credential, termsAccepted: true });
  await entered;
  assert.equal((await c.request('/api/auth/logout', {})).status, 200);
  release();
  assert.equal((await pending).status, 409);
  assert.equal((await c.request('/api/auth/session')).body.user, null);
});

test('logout before a first challenge cookie arrives still invalidates that flow', async t => {
  const f = await fixture(t), c = f.client();
  const delayed = await c.request('/api/auth/google/challenge', { intent: 'signin' }, { captureCookies: false });
  assert.equal(delayed.status, 200);
  await c.request('/api/auth/logout', {});
  cookiesFrom(delayed.response.headers, c.jar);
  const result = await c.request('/api/auth/google/credential', { flowId: delayed.body.flowId, credential: f.token(delayed.body), termsAccepted: true });
  assert.ok([400, 409].includes(result.status));
  assert.equal((await c.request('/api/auth/session')).body.user, null);
});

test('a late password cookie cannot authenticate after logout', async t => {
  const f = await fixture(t), c = f.client();
  const user = await passwordAccount(c);
  await c.request('/api/auth/logout', {});
  const delayed = await c.request('/api/auth/login', { email: user.email, password: PASSWORD }, { captureCookies: false });
  assert.equal(delayed.status, 200);
  await c.request('/api/auth/logout', {});
  cookiesFrom(delayed.response.headers, c.jar);
  assert.equal((await c.request('/api/auth/session')).body.user, null);
});

test('late password response cannot restore the earlier account after Google sign-in', async t => {
  const f = await fixture(t), c = f.client();
  const password = await passwordAccount(c);
  await c.request('/api/auth/logout', {});
  const delayed = await c.request('/api/auth/login', { email: password.email, password: PASSWORD }, { captureCookies: false });
  const google = await googleAccount(f, c);
  assert.notEqual(google.id, password.id);
  cookiesFrom(delayed.response.headers, c.jar);
  assert.equal((await c.request('/api/auth/session')).body.user, null);
});

test('a delayed challenge body cannot start a flow after logout', async t => {
  const f = await fixture(t), c = f.client();
  const body = JSON.stringify({ intent: 'signin' });
  const arrived = new Promise(resolve => f.app.server.once('request', resolve));
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(f.base + '/api/auth/google/challenge', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-imstage-request': '1', 'x-imstage-auth-context': c.context, 'content-length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.flushHeaders();
  });
  t.after(() => req.destroy());
  await arrived;
  await c.request('/api/auth/logout', {});
  req.end(body);
  assert.equal(await response, 409);
});

test('a delayed password body cannot log in after logout', async t => {
  const f = await fixture(t), c = f.client();
  const user = await passwordAccount(c);
  await c.request('/api/auth/logout', {});
  const body = JSON.stringify({ email: user.email, password: PASSWORD });
  const arrived = new Promise(resolve => f.app.server.once('request', resolve));
  let req;
  const pending = new Promise((resolve, reject) => {
    req = http.request(f.base + '/api/auth/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-imstage-request': '1', 'x-imstage-auth-context': c.context, 'content-length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.flushHeaders();
  });
  t.after(() => req.destroy());
  await arrived;
  await c.request('/api/auth/logout', {});
  req.end(body);
  assert.equal(await pending, 409);
  assert.equal((await c.request('/api/auth/session')).body.user, null);
});

test('nonce cookie is protected and session cookie survives simultaneous flow-cookie clearing', async t => {
  const f = await fixture(t, { appOrigin: 'https://app.example.test' });
  const jar = new Map(), context = crypto.randomBytes(32).toString('base64url');
  async function post(route, body) {
    const r = await fetch(f.base + route, { method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json', 'x-imstage-request': '1', 'x-imstage-auth-context': context, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: JSON.stringify(body) });
    cookiesFrom(r.headers, jar);return { r, body: await r.json() };
  }
  const challenge = await post('/api/auth/google/challenge', { intent: 'signin' });
  assert.equal(challenge.r.status, 200);
  assert.equal(challenge.body.cookieToken, undefined);
  const nonceCookie = challenge.r.headers.getSetCookie().find(value => value.includes('imstage_g_'));
  assert.match(nonceCookie, /HttpOnly/);assert.match(nonceCookie, /SameSite=Strict/);assert.match(nonceCookie, /Secure/);assert.match(nonceCookie, /Path=\/api\/auth/);
  const result = await post('/api/auth/google/credential', { flowId: challenge.body.flowId, credential: f.token(challenge.body), termsAccepted: true });
  assert.equal(result.r.status, 200);
  assert.ok(jar.get('imstage_session'));
  assert.ok(result.r.headers.getSetCookie().length >= 2);
});

test('password-proved unlink revokes sessions while preserving the password account', async t => {
  const f = await fixture(t), c = f.client();
  const user = await passwordAccount(c);
  const flow = await f.challenge(c, 'link', { password: PASSWORD });
  assert.equal((await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow) })).status, 200);
  assert.equal((await c.request('/api/auth/google/unlink', { password: 'wrong' })).status, 401);
  assert.equal((await c.request('/api/auth/session')).body.user.id, user.id);
  assert.equal((await c.request('/api/auth/google/unlink', { password: PASSWORD })).status, 200);
  assert.equal((await c.request('/api/auth/session')).body.user, null);
  assert.equal((await c.request('/api/auth/login', { email: user.email, password: PASSWORD })).body.user.id, user.id);
  assert.equal((await c.request('/api/auth/methods')).body.google.linked, false);
});

test('pending consent survives reload and Google registration ignores a forged client email', async t => {
  const f = await fixture(t), c = f.client(), flow = await f.challenge(c);
  await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential: f.token(flow) });
  const config = (await c.request('/api/auth/google/config')).body;
  assert.equal(config.pending.flowId, flow.flowId);
  assert.equal(config.pending.profile.email, 'google-owner@example.test');
  const registered = await c.request('/api/auth/google/register', { flowId: flow.flowId, termsAccepted: true, email: 'forged@example.test' });
  assert.equal(registered.body.user.email, 'google-owner@example.test');
  const other = f.client();
  assert.equal((await other.request('/api/auth/google/config')).body.pending, null);
});

test('Google outage returns a safe error and leaves password sign-in available', async t => {
  const f = await fixture(t), c = f.client();
  const user = await passwordAccount(c);
  await c.request('/api/auth/logout', {});
  const flow = await f.challenge(c);
  const credential = f.token(flow);
  f.tokens.set(credential, () => { throw new Error('private-' + credential); });
  const failed = await c.request('/api/auth/google/credential', { flowId: flow.flowId, credential });
  assert.equal(failed.status, 401);
  assert.equal(failed.body.error.code, 'google_invalid_identity');
  assert.ok(!JSON.stringify(f.logs).includes(credential));
  assert.equal((await c.request('/api/auth/login', { email: user.email, password: PASSWORD })).body.user.id, user.id);
});

test('challenge limits are independent of password sign-in and metadata writes are bounded', async t => {
  const f = await fixture(t, { rateLimit: { google: { max: 1 } } }), c = f.client();
  await f.challenge(c);
  assert.equal((await c.request('/api/auth/google/challenge', { intent: 'signin' })).status, 429);
  assert.ok((await passwordAccount(c)).id);
});

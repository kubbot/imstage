/**
 * Integration tests for the local/self-hosted IMStage API.
 *
 * Run with: node --test tests/auth-api.test.mjs
 *
 * Test artifacts live in an explicitly scoped sub-directory under
 * IMSTAGE_ARTIFACT_DIR (or the OS temp dir when it is not provided) and only
 * that sub-directory is removed on teardown. No global temp cleanup happens.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp, start } from '../services/api/server.mjs';

/* ------------------------------------------------------------------ */
/* Scoped runtime directory                                            */
/* ------------------------------------------------------------------ */

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-auth-api-'));

const APP_ORIGIN = 'http://127.0.0.1:4417';
const activeApps = new Set();

function caseDir(label) {
  return fs.mkdtempSync(path.join(RUNTIME_ROOT, `${label}-`));
}

async function makeApp(overrides = {}) {
  const dir = caseDir('case');
  const app = await start({
    dbPath: path.join(dir, 'imstage.db'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
    ...overrides,
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}`, dir, dbPath: app.config.dbPath };
}

after(async () => {
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
function uniqueEmail(prefix = 'user') {
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

function cookieAttributes(res) {
  return (res.headers.get('set-cookie') ?? '').split(';').map((part) => part.trim());
}

async function json(res) {
  return res.json();
}

async function post(base, route, body, { cookie, headers } = {}) {
  return fetch(base + route, {
    method: 'POST',
    headers: mutationHeaders(cookie, headers),
    body: JSON.stringify(body),
  });
}

async function register(base, { name = '测试用户', email, password = 'password-123456', headers } = {}) {
  const res = await post(base, '/api/auth/register', { name, email, password }, { headers });
  const body = await json(res);
  return { res, body, cookie: cookieFrom(res) };
}

async function login(base, { email, password, headers } = {}) {
  const res = await post(base, '/api/auth/login', { email, password }, { headers });
  const body = await json(res);
  return { res, body, cookie: cookieFrom(res) };
}

async function session(base, cookie) {
  const res = await fetch(`${base}/api/auth/session`, {
    headers: cookie ? { cookie } : {},
  });
  return { res, body: await json(res) };
}

function sceneFixture(id, overrides = {}) {
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

async function putScene(base, cookie, id, scene, revision) {
  const res = await fetch(`${base}/api/scenes/${id}`, {
    method: 'PUT',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ scene, revision }),
  });
  return { res, body: await json(res) };
}

async function deleteScene(base, cookie, id, revision) {
  const res = await fetch(`${base}/api/scenes/${id}`, {
    method: 'DELETE',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ revision }),
  });
  return { res, body: await json(res) };
}

/* ------------------------------------------------------------------ */
/* Shared app                                                          */
/* ------------------------------------------------------------------ */

let shared;

before(async () => {
  shared = await makeApp();
});

/* ------------------------------------------------------------------ */
/* Health / headers                                                    */
/* ------------------------------------------------------------------ */

test('GET /api/health reports ready with no-store security headers', async () => {
  const res = await fetch(`${shared.base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { status: 'ready' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

/* ------------------------------------------------------------------ */
/* Registration / session                                              */
/* ------------------------------------------------------------------ */

test('registration normalizes the email, establishes a session, and never leaks the hash', async () => {
  const email = uniqueEmail('register');
  const { res, body, cookie } = await register(shared.base, {
    name: ' 小林 ',
    email: `  ${email.toUpperCase()}  `,
  });

  assert.equal(res.status, 200);
  assert.equal(body.user.email, email);
  assert.equal(body.user.name, '小林');
  assert.equal(typeof body.user.id, 'string');
  assert.equal(body.user.password, undefined);
  assert.equal(body.user.passwordHash, undefined);
  assert.ok(cookie, 'registration returns a session cookie');

  const attrs = cookieAttributes(res);
  assert.ok(attrs.includes('HttpOnly'), 'cookie is HttpOnly');
  assert.ok(attrs.includes('SameSite=Lax'), 'cookie is SameSite=Lax');
  assert.ok(attrs.includes('Path=/'), 'cookie is scoped to /');
  assert.ok(attrs.includes('Max-Age=604800'), 'cookie has a fixed 7 day expiry');
  assert.ok(!attrs.includes('Secure'), 'cookie is not Secure for an http origin');

  const current = await session(shared.base, cookie);
  assert.equal(current.res.status, 200);
  assert.deepEqual(current.body.user, body.user);
});

test('registration validates name, email and password bounds', async () => {
  for (const [payload, code] of [
    [{ name: '', email: uniqueEmail('n'), password: 'password-123456' }, 'invalid_name'],
    [{ name: 'x'.repeat(61), email: uniqueEmail('n'), password: 'password-123456' }, 'invalid_name'],
    [{ name: 'ok', email: 'not-an-email', password: 'password-123456' }, 'invalid_email'],
    [{ name: 'ok', email: uniqueEmail('p'), password: 'short-pass' }, 'invalid_password'],
    [{ name: 'ok', email: uniqueEmail('p'), password: 'x'.repeat(129) }, 'invalid_password'],
  ]) {
    const res = await post(shared.base, '/api/auth/register', payload);
    assert.equal(res.status, 400, `expected 400 for ${code}`);
    assert.equal((await json(res)).error.code, code);
  }
});

test('duplicate registration is rejected without leaking a session', async () => {
  const email = uniqueEmail('dupe');
  const first = await register(shared.base, { email });
  assert.equal(first.res.status, 200);

  const second = await register(shared.base, { email });
  assert.equal(second.res.status, 409);
  assert.deepEqual(second.body, {
    error: { code: 'email_taken', message: '该邮箱已注册' },
  });
  assert.equal(second.cookie, null);
});

test('passwords are not trimmed', async () => {
  const email = uniqueEmail('trim');
  const password = '  spaced-pass-123  ';
  const created = await register(shared.base, { email, password });
  assert.equal(created.res.status, 200);

  const trimmedAttempt = await login(shared.base, { email, password: password.trim() });
  assert.equal(trimmedAttempt.res.status, 401);

  const exact = await login(shared.base, { email, password });
  assert.equal(exact.res.status, 200);
});

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

test('login succeeds with the right password and returns a uniform credential error otherwise', async () => {
  const email = uniqueEmail('login');
  const password = 'correct-password-123';
  await register(shared.base, { email, password });

  const good = await login(shared.base, { email, password });
  assert.equal(good.res.status, 200);
  assert.equal(good.body.user.email, email);
  assert.ok(good.cookie);

  const badPassword = await login(shared.base, { email, password: 'wrong-password-123' });
  const unknownUser = await login(shared.base, { email: uniqueEmail('missing'), password });

  assert.equal(badPassword.res.status, 401);
  assert.equal(unknownUser.res.status, 401);
  const expected = { error: { code: 'invalid_credentials', message: '邮箱或密码不正确' } };
  assert.deepEqual(badPassword.body, expected);
  assert.deepEqual(unknownUser.body, expected);
});

/* ------------------------------------------------------------------ */
/* Logout                                                              */
/* ------------------------------------------------------------------ */

test('logout revokes the server session and clears the cookie', async () => {
  const email = uniqueEmail('logout');
  const { cookie } = await register(shared.base, { email });
  assert.ok(cookie);

  const res = await post(shared.base, '/api/auth/logout', {}, { cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
  assert.match(cookieAttributes(res).join(';'), /Max-Age=0/);

  const after = await session(shared.base, cookie);
  assert.equal(after.body.user, null);
});

test('logout is idempotent and does not require a session', async () => {
  const res = await post(shared.base, '/api/auth/logout', {});
  assert.equal(res.status, 200);
  assert.deepEqual(await json(res), { ok: true });
});

/* ------------------------------------------------------------------ */
/* Password change                                                     */
/* ------------------------------------------------------------------ */

test('password change revokes ALL sessions and requires re-login', async () => {
  const email = uniqueEmail('pw');
  const oldPassword = 'old-password-1234';
  const newPassword = 'new-password-1234';

  const first = await register(shared.base, { email, password: oldPassword });
  const second = await login(shared.base, { email, password: oldPassword });
  const cookieA = first.cookie;
  const cookieB = second.cookie;
  assert.notEqual(cookieA, cookieB);

  const wrongCurrent = await post(
    shared.base,
    '/api/auth/password',
    { currentPassword: 'not-the-password', newPassword },
    { cookie: cookieA },
  );
  assert.equal(wrongCurrent.status, 401);
  assert.equal((await json(wrongCurrent)).error.code, 'invalid_credentials');

  const changed = await post(
    shared.base,
    '/api/auth/password',
    { currentPassword: oldPassword, newPassword },
    { cookie: cookieA },
  );
  assert.equal(changed.status, 200);
  assert.deepEqual(await json(changed), { ok: true });

  assert.equal((await session(shared.base, cookieA)).body.user, null);
  assert.equal((await session(shared.base, cookieB)).body.user, null);

  const oldLogin = await login(shared.base, { email, password: oldPassword });
  assert.equal(oldLogin.res.status, 401);
  const newLogin = await login(shared.base, { email, password: newPassword });
  assert.equal(newLogin.res.status, 200);
});

test('password change validates the new password length', async () => {
  const email = uniqueEmail('pwlen');
  const { cookie } = await register(shared.base, { email });
  const res = await post(
    shared.base,
    '/api/auth/password',
    { currentPassword: 'password-123456', newPassword: 'too-short' },
    { cookie },
  );
  assert.equal(res.status, 400);
  assert.equal((await json(res)).error.code, 'invalid_password');
});

/* ------------------------------------------------------------------ */
/* Persistence across restart                                          */
/* ------------------------------------------------------------------ */

test('users and sessions survive a server restart', async () => {
  const dir = caseDir('restart');
  const dbPath = path.join(dir, 'imstage.db');
  const email = uniqueEmail('restart');
  const password = 'restart-password-123';

  const appOne = await start({
    dbPath,
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
  });
  activeApps.add(appOne);
  const baseOne = `http://127.0.0.1:${appOne.port}`;

  const created = await register(baseOne, { email, password });
  assert.equal(created.res.status, 200);
  const cookie = created.cookie;
  await appOne.close();

  const appTwo = await start({
    dbPath,
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
  });
  activeApps.add(appTwo);
  const baseTwo = `http://127.0.0.1:${appTwo.port}`;

  const restored = await session(baseTwo, cookie);
  assert.equal(restored.body.user.email, email);

  const relogin = await login(baseTwo, { email, password });
  assert.equal(relogin.res.status, 200);
});

/* ------------------------------------------------------------------ */
/* Expiry (injected clock)                                             */
/* ------------------------------------------------------------------ */

test('sessions expire after exactly 7 days and are not extended by use', async () => {
  let clockMs = Date.parse('2026-01-01T00:00:00.000Z');
  const { base } = await makeApp({ now: () => new Date(clockMs) });
  const email = uniqueEmail('expiry');
  const { cookie } = await register(base, { email });

  assert.equal((await session(base, cookie)).body.user.email, email);

  clockMs += 6 * 24 * 60 * 60 * 1000;
  assert.equal((await session(base, cookie)).body.user.email, email, 'still valid before expiry');

  clockMs += 2 * 24 * 60 * 60 * 1000; // t0 + 8 days
  const expired = await session(base, cookie);
  assert.equal(expired.body.user, null, 'expired after fixed 7 day window');

  const relogin = await login(base, { email, password: 'password-123456' });
  assert.equal(relogin.res.status, 200);
});

/* ------------------------------------------------------------------ */
/* CSRF: Origin + custom header                                        */
/* ------------------------------------------------------------------ */

test('mutations require a matching Origin and the custom request header', async () => {
  const email = uniqueEmail('origin');
  const password = 'password-123456';
  await register(shared.base, { email, password });

  const body = JSON.stringify({ email, password });

  const noOrigin = await fetch(`${shared.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-imstage-request': '1' },
    body,
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await json(noOrigin)).error.code, 'origin_required');

  const badOrigin = await fetch(`${shared.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'x-imstage-request': '1' },
    body,
  });
  assert.equal(badOrigin.status, 403);
  assert.equal((await json(badOrigin)).error.code, 'origin_mismatch');

  const noMarker = await fetch(`${shared.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP_ORIGIN },
    body,
  });
  assert.equal(noMarker.status, 403);
  assert.equal((await json(noMarker)).error.code, 'request_marker_required');

  const badMarker = await fetch(`${shared.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP_ORIGIN, 'x-imstage-request': 'yes' },
    body,
  });
  assert.equal(badMarker.status, 403);
  assert.equal((await json(badMarker)).error.code, 'request_marker_required');

  // Reads are not mutations and do not require the marker.
  const read = await fetch(`${shared.base}/api/auth/session`);
  assert.equal(read.status, 200);
});

test('mutations reject non-JSON content types', async () => {
  const res = await fetch(`${shared.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: APP_ORIGIN, 'x-imstage-request': '1' },
    body: JSON.stringify({ email: uniqueEmail('ct'), password: 'password-123456' }),
  });
  assert.equal(res.status, 415);
  assert.equal((await json(res)).error.code, 'unsupported_media_type');
});

test('auth bodies over 16 KiB are rejected with 413', async () => {
  const res = await post(shared.base, '/api/auth/register', {
    name: 'ok',
    email: uniqueEmail('big'),
    password: 'x'.repeat(20_000),
  });
  assert.equal(res.status, 413);
  assert.equal((await json(res)).error.code, 'payload_too_large');
});

test('scene bodies over 16 MiB are rejected with 413', async () => {
  const email = uniqueEmail('bigscene');
  const { cookie } = await register(shared.base, { email });
  const id = crypto.randomUUID();
  const scene = sceneFixture(id, {
    messages: [
      {
        id: 'm1',
        participantId: 'p1',
        type: 'text',
        text: 'a'.repeat(17 * 1024 * 1024),
        time: '09:41',
      },
    ],
  });
  const res = await fetch(`${shared.base}/api/scenes/${id}`, {
    method: 'PUT',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ scene, revision: 0 }),
  });
  assert.equal(res.status, 413);
  assert.equal((await json(res)).error.code, 'payload_too_large');
});

test('early rejections with a large body still return a readable JSON error', async () => {
  const { base } = await makeApp();
  const id = crypto.randomUUID();
  const scene = sceneFixture(id, {
    messages: [
      {
        id: 'm1',
        participantId: 'p1',
        type: 'text',
        text: 'a'.repeat(17 * 1024 * 1024),
        time: '09:41',
      },
    ],
  });
  const body = JSON.stringify({ scene, revision: 0 });

  const unauthenticated = await fetch(`${base}/api/scenes/${id}`, {
    method: 'PUT',
    headers: mutationHeaders(null),
    body,
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await json(unauthenticated)).error.code, 'unauthorized');

  const badOrigin = await fetch(`${base}/api/scenes/${id}`, {
    method: 'PUT',
    headers: { ...mutationHeaders(null), origin: 'http://evil.example' },
    body,
  });
  assert.equal(badOrigin.status, 403);
  assert.equal((await json(badOrigin)).error.code, 'origin_mismatch');
});

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

test('scenes are created, listed, fetched, updated and deleted with revisions', async () => {
  const email = uniqueEmail('scenes');
  const { cookie } = await register(shared.base, { email });
  const id = crypto.randomUUID();

  const created = await putScene(shared.base, cookie, id, sceneFixture(id), 0);
  assert.equal(created.res.status, 200);
  assert.equal(created.body.item.id, id);
  assert.equal(created.body.item.revision, 1);
  assert.match(created.body.item.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(created.body.item.scene.title, '测试场景');

  const list = await fetch(`${shared.base}/api/scenes`, { headers: { cookie } });
  assert.equal(list.status, 200);
  const listBody = await json(list);
  assert.equal(listBody.items.length, 1);
  assert.deepEqual(
    Object.keys(listBody.items[0]).sort(),
    ['id', 'messageCount', 'platform', 'revision', 'title', 'updatedAt'].sort(),
  );
  assert.equal(listBody.items[0].messageCount, 1);

  const fetched = await fetch(`${shared.base}/api/scenes/${id}`, { headers: { cookie } });
  assert.equal(fetched.status, 200);
  assert.equal((await json(fetched)).item.revision, 1);

  const updated = await putScene(
    shared.base,
    cookie,
    id,
    sceneFixture(id, { title: '改过的标题' }),
    1,
  );
  assert.equal(updated.res.status, 200);
  assert.equal(updated.body.item.revision, 2);
  assert.equal(updated.body.item.scene.title, '改过的标题');

  // Stale revision conflicts.
  const staleUpdate = await putScene(shared.base, cookie, id, sceneFixture(id), 1);
  assert.equal(staleUpdate.res.status, 409);
  assert.equal(staleUpdate.body.error.code, 'revision_conflict');

  // Re-creating an existing id conflicts; the UI treats that as "already saved".
  const recreate = await putScene(shared.base, cookie, id, sceneFixture(id), 0);
  assert.equal(recreate.res.status, 409);
  assert.equal(recreate.body.error.code, 'conflict');

  const staleDelete = await deleteScene(shared.base, cookie, id, 1);
  assert.equal(staleDelete.res.status, 409);
  assert.equal(staleDelete.body.error.code, 'revision_conflict');

  const deleted = await deleteScene(shared.base, cookie, id, 2);
  assert.equal(deleted.res.status, 200);
  assert.deepEqual(deleted.body, { ok: true });

  const gone = await fetch(`${shared.base}/api/scenes/${id}`, { headers: { cookie } });
  assert.equal(gone.status, 404);
  assert.equal((await json(gone)).error.code, 'not_found');
});

test('scene validation rejects invalid data and remote asset URLs', async () => {
  const email = uniqueEmail('validate');
  const { cookie } = await register(shared.base, { email });

  const badPlatformId = crypto.randomUUID();
  const badPlatform = await putScene(
    shared.base,
    cookie,
    badPlatformId,
    sceneFixture(badPlatformId, { platform: 'myspace' }),
    0,
  );
  assert.equal(badPlatform.res.status, 400);
  assert.equal(badPlatform.body.error.code, 'validation_error');

  const remoteId = crypto.randomUUID();
  const remoteAsset = sceneFixture(remoteId, {
    participants: [{ id: 'p1', name: '小林', avatar: 'https://evil.example/avatar.png' }],
  });
  const remote = await putScene(shared.base, cookie, remoteId, remoteAsset, 0);
  assert.equal(remote.res.status, 400);
  assert.equal(remote.body.error.code, 'validation_error');

  const mismatchId = crypto.randomUUID();
  const mismatch = await putScene(
    shared.base,
    cookie,
    mismatchId,
    sceneFixture(crypto.randomUUID()),
    0,
  );
  assert.equal(mismatch.res.status, 400);
  assert.equal(mismatch.body.error.code, 'invalid_request');

  const missingId = await putScene(shared.base, cookie, mismatchId, { foo: 'bar' }, 0);
  assert.equal(missingId.res.status, 400);
  assert.equal(missingId.body.error.code, 'validation_error');

  const badRevision = await putScene(shared.base, cookie, mismatchId, sceneFixture(mismatchId), -1);
  assert.equal(badRevision.res.status, 400);
  assert.equal(badRevision.body.error.code, 'invalid_revision');
});

test('scenes are isolated per owner and never leak across users', async () => {
  const owner = await register(shared.base, { email: uniqueEmail('owner') });
  const other = await register(shared.base, { email: uniqueEmail('other') });
  const id = crypto.randomUUID();

  const created = await putScene(shared.base, owner.cookie, id, sceneFixture(id), 0);
  assert.equal(created.res.status, 200);

  const otherGet = await fetch(`${shared.base}/api/scenes/${id}`, { headers: { cookie: other.cookie } });
  assert.equal(otherGet.status, 404);

  const otherPut = await putScene(shared.base, other.cookie, id, sceneFixture(id), 1);
  assert.equal(otherPut.res.status, 404);

  const otherDelete = await deleteScene(shared.base, other.cookie, id, 1);
  assert.equal(otherDelete.res.status, 404);

  const otherList = await fetch(`${shared.base}/api/scenes`, { headers: { cookie: other.cookie } });
  assert.deepEqual((await json(otherList)).items, []);

  // Unauthenticated access is rejected.
  const anonymous = await fetch(`${shared.base}/api/scenes`);
  assert.equal(anonymous.status, 401);
});

test('creating more than 100 scenes per user is rejected', async () => {
  const email = uniqueEmail('limit');
  const { cookie } = await register(shared.base, { email });

  for (let i = 0; i < 100; i += 1) {
    const id = crypto.randomUUID();
    const res = await putScene(shared.base, cookie, id, sceneFixture(id, { title: `场景 ${i}` }), 0);
    assert.equal(res.res.status, 200, `scene ${i} should be created`);
  }

  const overflowId = crypto.randomUUID();
  const overflow = await putScene(shared.base, cookie, overflowId, sceneFixture(overflowId), 0);
  assert.equal(overflow.res.status, 409);
  assert.equal(overflow.body.error.code, 'scene_limit_reached');
});

/* ------------------------------------------------------------------ */
/* Rate limiting                                                       */
/* ------------------------------------------------------------------ */

test('repeated auth attempts are throttled per normalized email with 429', async () => {
  const { base } = await makeApp({
    rateLimit: {
      email: { max: 2, windowMs: 60_000 },
      ip: { max: 1000, windowMs: 60_000 },
    },
  });
  const email = uniqueEmail('rate');

  for (let i = 0; i < 2; i += 1) {
    const res = await login(base, { email, password: 'wrong-password-123' });
    assert.equal(res.res.status, 401, `attempt ${i} should be 401`);
  }

  const limited = await login(base, { email: email.toUpperCase(), password: 'wrong-password-123' });
  assert.equal(limited.res.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.ok(Number(limited.res.headers.get('retry-after')) >= 1);
});

test('auth attempts are also throttled per remote IP', async () => {
  const { base } = await makeApp({
    rateLimit: {
      email: { max: 1000, windowMs: 60_000 },
      ip: { max: 1, windowMs: 60_000 },
    },
  });

  const first = await login(base, { email: uniqueEmail('ip1'), password: 'wrong-password-123' });
  assert.equal(first.res.status, 401);

  const second = await login(base, { email: uniqueEmail('ip2'), password: 'wrong-password-123' });
  assert.equal(second.res.status, 429);
  assert.equal(second.body.error.code, 'rate_limited');
});

/* ------------------------------------------------------------------ */
/* Configuration safety + cookie Secure                                */
/* ------------------------------------------------------------------ */

test('createApp refuses non-loopback binds and unsafe production origins', () => {
  assert.throws(
    () =>
      createApp({
        dbPath: ':memory:',
        host: '0.0.0.0',
        appOrigin: APP_ORIGIN,
        distDir: null,
        logger: { log() {}, error() {} },
      }),
    /loopback/i,
  );
  assert.throws(
    () =>
      createApp({
        dbPath: ':memory:',
        appOrigin: 'http://example.com',
        nodeEnv: 'production',
        distDir: null,
        logger: { log() {}, error() {} },
      }),
    /https/i,
  );
  // A loopback http origin is allowed even in production.
  const app = createApp({
    dbPath: ':memory:',
    appOrigin: APP_ORIGIN,
    nodeEnv: 'production',
    distDir: null,
    logger: { log() {}, error() {} },
  });
  assert.ok(app.server);
});

test('an HTTPS app origin marks the session cookie Secure', async () => {
  const httpsOrigin = 'https://imstage.example';
  const { base } = await makeApp({ appOrigin: httpsOrigin });
  const email = uniqueEmail('secure');
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: httpsOrigin,
      'x-imstage-request': '1',
    },
    body: JSON.stringify({ name: '安全', email, password: 'password-123456' }),
  });
  assert.equal(res.status, 200);
  assert.ok(cookieAttributes(res).includes('Secure'), 'cookie must be Secure over https');
});

/* ------------------------------------------------------------------ */
/* Static serving                                                      */
/* ------------------------------------------------------------------ */

test('static serving only exposes dist assets, falls back for SPA routes and never for API', async () => {
  const dir = caseDir('static');
  const distDir = path.join(dir, 'dist');
  fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>IMStage</title>');
  fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("imstage");');
  fs.writeFileSync(path.join(distDir, '.secret'), 'do not serve');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside');

  const { base } = await makeApp({ distDir });

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await index.text(), /IMStage/);

  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);

  const spaFallback = await fetch(`${base}/studio/some/deep/route`);
  assert.equal(spaFallback.status, 200);
  assert.match(await spaFallback.text(), /IMStage/);

  const dotfile = await fetch(`${base}/.secret`);
  assert.equal(dotfile.status, 404);

  const traversal = await fetch(`${base}/%2e%2e%2foutside.txt`);
  assert.equal(traversal.status, 404);

  const unknownApi = await fetch(`${base}/api/does-not-exist`);
  assert.equal(unknownApi.status, 404);
  assert.equal((await json(unknownApi)).error.code, 'not_found');
  assert.equal(unknownApi.headers.get('cache-control'), 'no-store');

  const head = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('concurrent password changes cannot both commit and old login cannot outlive change', async () => {
  const {base}=await makeApp(); const email=uniqueEmail(); const account=await register(base,{email});
  const responses=await Promise.all(['new-password-alpha','new-password-bravo'].map(newPassword => post(base,'/api/auth/password',{currentPassword:'password-123456',newPassword},{cookie:account.cookie})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);
  assert.equal((await session(base,account.cookie)).body.user,null);
});

test('stale browser identity never writes or reads the newly signed-in account', async () => {
  const {base}=await makeApp(); const a=await register(base,{email:uniqueEmail()}); const b=await register(base,{email:uniqueEmail()});
  const res=await fetch(`${base}/api/scenes`,{headers:{cookie:b.cookie,'x-imstage-user':a.body.user.id}});
  assert.equal(res.status,401); assert.equal((await res.json()).error.code,'account_changed');
});

test('static symlinks cannot disclose files outside the build directory', async () => {
  const dir=caseDir('symlink'); const dist=path.join(dir,'dist'); fs.mkdirSync(dist); fs.writeFileSync(path.join(dist,'index.html'),'public');
  const secret=path.join(dir,'private.txt'); fs.writeFileSync(secret,'private'); fs.symlinkSync(secret,path.join(dist,'outside.txt'));
  const {base}=await makeApp({distDir:dist}); const res=await fetch(`${base}/outside.txt`); assert.equal(res.status,404); assert.ok(!(await res.text()).includes('private'));
});

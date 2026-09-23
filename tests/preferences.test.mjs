/**
 * Creator preferences (GET-44/45/46) — focused tests.
 *
 * Covers the account-scoped preferences API (new/legacy users, save/skip,
 * optimistic revisions, isolation), hostile avatar inputs and rectangular
 * proportional crops, the deterministic local portrait generator, the shared
 * Web/MCP default fill with explicit overrides preserved, mark on/off render
 * fingerprints, and the agent's mark preservation on full scene replacement.
 *
 * No network/provider call is made: avatars are generated locally with sharp and
 * the MCP surface is exercised over an in-memory transport.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { start, createApp } from '../services/api/server.mjs';
import { createAccountMcpServer } from '../services/integrations/account-mcp.mjs';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createImstageMcpServer } from '../services/mcp/server.mjs';
import { openStore } from '../services/mcp/store.mjs';
import { computeRenderId, resolveRenderConfig } from '../services/mcp/render.mjs';
import { prepareCreateScene } from '../services/mcp/scene.mjs';
import { createScene, validateScene } from '../apps/web/src/studio/model.ts';
import { applyFictionalMark, newSceneWatermark } from '../packages/schema/fictional-mark.mjs';
import { applySceneDefaults, sceneDefaultsSummary } from '../services/preferences/defaults.mjs';
import { createPreferencesReader } from '../services/preferences/index.mjs';
import { processAvatar, generateFictionalPortrait } from '../services/preferences/image.mjs';

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-prefs-'));
const APP_ORIGIN = 'http://127.0.0.1:4417';
const activeApps = new Set();

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

let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `prefs-${process.pid}-${emailSeq}@example.com`;
}

async function makeApp() {
  const dir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'case-'));
  const app = await start({
    dbPath: path.join(dir, 'imstage.db'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {}, warn() {} },
    env: {},
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}` };
}

function mutationHeaders(cookie, extras = {}) {
  const headers = { 'content-type': 'application/json', origin: APP_ORIGIN, 'x-imstage-request': '1', ...extras };
  if (cookie) headers.cookie = cookie;
  return headers;
}

function cookieFrom(res) {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = /imstage_session=([^;]*)/.exec(setCookie);
  return match && match[1] !== '' ? `imstage_session=${match[1]}` : null;
}

async function register(base, overrides = {}) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify({ name: '偏好用户', email: uniqueEmail(), password: 'password-123456', ...overrides }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return { cookie: cookieFrom(res), user: body.user };
}

async function request(base, pathname, { method = 'GET', cookie, body, headers } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: mutationHeaders(cookie, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function getPreferences(base, cookie) {
  const res = await request(base, '/api/preferences', { cookie });
  return { res, body: await res.json().catch(() => null) };
}

async function putPreferences(base, cookie, body) {
  const res = await request(base, '/api/preferences', { method: 'PUT', cookie, body });
  return { res, body: await res.json().catch(() => null) };
}

async function pngDataUri({ width, height, format = 'png' } = {}) {
  const buffer = await sharp({ create: { width, height, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .toFormat(format)
    .toBuffer();
  const mime = format === 'jpg' ? 'jpeg' : format;
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

/** Non-uniform source so different crop regions really differ. */
async function patternedPngDataUri(width, height) {
  const buffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      buffer[offset] = Math.round((x * 255) / width);
      buffer[offset + 1] = Math.round((y * 255) / height);
      buffer[offset + 2] = Math.round(((x + y) * 255) / (width + height));
    }
  }
  const png = await sharp(buffer, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/* ------------------------------------------------------------------ */
/* Shared mark + default helpers                                       */
/* ------------------------------------------------------------------ */

test('fictional mark keeps custom watermarks and only clears its own label', () => {
  assert.equal(applyFictionalMark('', true), '虚构对话');
  assert.equal(applyFictionalMark('虚构对话', false), '');
  assert.equal(applyFictionalMark('我的品牌', false), '我的品牌');
  assert.equal(applyFictionalMark('我的品牌', true), '我的品牌');
  assert.equal(newSceneWatermark(true), '虚构对话');
  assert.equal(newSceneWatermark(false), '');
});

test('shared defaults fill only missing keys and never overwrite explicit intent', () => {
  const defaults = { myAvatar: 'data:image/png;base64,ME', otherAvatar: 'data:image/png;base64,OTHER', showFictionalMark: true };
  const raw = { selfId: 'me', participants: [{ id: 'me', name: '我' }, { id: 'other', name: '对方' }] };
  const filled = applySceneDefaults(raw, defaults);
  assert.equal(filled.participants[0].avatar, defaults.myAvatar);
  assert.equal(filled.participants[1].avatar, defaults.otherAvatar);
  assert.equal(filled.watermark, '虚构对话');
  // The original value is never mutated.
  assert.equal(raw.participants[0].avatar, undefined);
  assert.equal(raw.watermark, undefined);

  const explicit = applySceneDefaults({ selfId: 'me', watermark: '', participants: [{ id: 'me', name: '我', avatar: '' }] }, defaults);
  assert.equal(explicit.watermark, '', 'explicit empty watermark survives');
  assert.equal(explicit.participants[0].avatar, '', 'explicit empty avatar survives');

  const off = applySceneDefaults({ selfId: 'me', participants: [{ id: 'x', name: 'X' }] }, { ...defaults, showFictionalMark: false });
  assert.equal(off.watermark, '');
  assert.equal(off.participants[0].avatar, defaults.otherAvatar);

  const summary = sceneDefaultsSummary({ myAvatar: 'data:image/png;base64,AAAA', otherAvatar: null, showFictionalMark: true, markLabel: '虚构对话' });
  assert.equal(summary.myAvatarConfigured, true);
  assert.equal(summary.otherAvatarConfigured, false);
  assert.equal(JSON.stringify(summary).includes('AAAA'), false, 'summary never leaks avatar bytes');
});

test('agent reconstruction keeps the prior mark; targeted updates can change it', async () => {
  const { executeTool } = await import('../services/agent/tools.mjs');
  const original = { ...createScene(), watermark: '虚构对话' };
  const rewritten = { ...structuredClone(original), title: '新的标题' };
  delete rewritten.watermark;
  const kept = await executeTool('create_scene', { scene: rewritten }, { scene: original });
  assert.equal(kept.ok, true);
  assert.equal(kept.scene.watermark, '虚构对话');

  const rebuilt = await executeTool('create_scene', { scene: { ...rewritten, watermark: '' } }, { scene: original });
  assert.equal(rebuilt.scene.watermark, '虚构对话');
  const cleared = await executeTool('update_element', { targetId: '@scene', patch: { watermark: '' } }, { scene: original });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.scene.watermark, '');
});

test('mark on/off changes the shared renderer content fingerprint (no stale cache)', () => {
  const base = { ...createScene(), id: 'scene-fingerprint' };
  const options = resolveRenderConfig({ surface: 'ios', width: 390, height: 844, outputKind: 'long-screenshot' });
  const on = computeRenderId({ scene: { ...base, watermark: '虚构对话' }, ...options, rendererVersion: 'v' });
  const off = computeRenderId({ scene: { ...base, watermark: '' }, ...options, rendererVersion: 'v' });
  assert.notEqual(on, off);
  assert.equal(computeRenderId({ scene: { ...base, watermark: '虚构对话' }, ...options, rendererVersion: 'v' }), on);
});

/* ------------------------------------------------------------------ */
/* Avatar image pipeline                                               */
/* ------------------------------------------------------------------ */

test('portrait generator is deterministic, seeded and decodable', async () => {
  const first = await generateFictionalPortrait('seed-a');
  const second = await generateFictionalPortrait('seed-a');
  const other = await generateFictionalPortrait('seed-b');
  assert.equal(first, second);
  assert.notEqual(first, other);
  const metadata = await sharp(Buffer.from(first.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 256);
});

test('rectangular avatars are proportionally square-cropped to 256 without stretching', async () => {
  const source = await patternedPngDataUri(400, 200);
  const center = await processAvatar(source);
  assert.equal(center.width, 256);
  assert.equal(center.height, 256);
  const cropped = await processAvatar(source, { crop: { left: 0, top: 0, width: 200, height: 200 } });
  assert.equal(cropped.width, 256);
  assert.equal(cropped.height, 256);
  assert.notEqual(cropped.dataUri, center.dataUri, 'different source regions produce different avatars');
});

test('remote URLs, SVG, forged headers and pixel bombs are rejected', async () => {
  await assert.rejects(() => processAvatar('https://example.com/a.png'), /本地 png/);
  await assert.rejects(() => processAvatar('data:image/svg+xml;base64,PHN2Zy8+'), /本地 png/);
  await assert.rejects(() => processAvatar('data:image/png;base64,AAAA'), /无法解码/);
  const png = await pngDataUri({ width: 32, height: 32 });
  await assert.rejects(() => processAvatar(png.replace('image/png', 'image/webp')), /声明格式/);
  const bomb = await pngDataUri({ width: 3000, height: 3000 });
  await assert.rejects(() => processAvatar(bomb), /像素|尺寸/);
});

test('a header-valid but truncated image is mapped to 400, not a raw 500', async () => {
  const png = await pngDataUri({ width: 64, height: 64 });
  const base64 = png.split(',')[1];
  const truncated = `data:image/png;base64,${Buffer.from(base64, 'base64').subarray(0, 40).toString('base64')}`;
  await assert.rejects(() => processAvatar(truncated), (error) => error && error.status === 400 && error.code === 'invalid_avatar');
});

/* ------------------------------------------------------------------ */
/* HTTP API                                                            */
/* ------------------------------------------------------------------ */

test('new registration is pending; legacy accounts are never auto-prompted', async () => {
  const { app, base } = await makeApp();
  const { cookie, user } = await register(base);
  const fresh = await getPreferences(base, cookie);
  assert.equal(fresh.res.status, 200);
  assert.equal(fresh.body.item.onboardingStatus, 'pending');
  assert.equal(fresh.body.item.revision, 1);
  assert.equal(fresh.body.item.showFictionalMark, true);
  assert.equal(fresh.body.item.onboardingShown, false);

  // Simulate a pre-migration account: no preferences row at all.
  app.db.prepare('DELETE FROM account_preferences WHERE user_id = ?').run(user.id);
  const legacy = await getPreferences(base, cookie);
  assert.equal(legacy.body.item.onboardingStatus, 'legacy');
  assert.equal(legacy.body.item.revision, 0);
});

test('a skipped/unconfigured account has a stable built-in other avatar in Web and MCP defaults', async () => {
  const { app, base } = await makeApp();
  const { cookie, user } = await register(base);
  const first = await getPreferences(base, cookie);
  const derived = first.body.item.otherAvatar;
  assert.match(derived, /^data:image\/png;base64,/);

  // Skip: complete onboarding without saving any personalization.
  const skipped = await putPreferences(base, cookie, { revision: 1, onboardingStatus: 'completed' });
  assert.equal(skipped.res.status, 200);
  assert.equal(skipped.body.item.otherAvatar, derived, 'skip keeps the same built-in avatar');
  const reloaded = await getPreferences(base, cookie);
  assert.equal(reloaded.body.item.otherAvatar, derived, 'stable across reads/reloads');

  // The account MCP trusted defaults resolve the exact same bytes (parity).
  const reader = createPreferencesReader(app.db);
  const resolved = await reader.get(user.id);
  assert.equal(resolved.otherAvatar, derived);
  const fill = applySceneDefaults(
    { selfId: 'me', participants: [{ id: 'me', name: '我' }, { id: 'other', name: '对方' }] },
    { myAvatar: resolved.myAvatar, otherAvatar: resolved.otherAvatar, showFictionalMark: resolved.showFictionalMark, markLabel: resolved.markLabel },
  );
  assert.equal(fill.participants.find((p) => p.id === 'other').avatar, derived);
});

test('save and skip both complete onboarding and store avatars + mark', async () => {
  const { base } = await makeApp();
  const { cookie } = await register(base);
  const my = await pngDataUri({ width: 300, height: 180 });
  const other = await generateFictionalPortrait('other-1');
  const saved = await putPreferences(base, cookie, { revision: 1, myAvatar: my, otherAvatar: other, showFictionalMark: false, onboardingStatus: 'completed' });
  assert.equal(saved.res.status, 200);
  assert.equal(saved.body.item.revision, 2);
  assert.equal(saved.body.item.onboardingStatus, 'completed');
  assert.equal(saved.body.item.showFictionalMark, false);
  assert.match(saved.body.item.myAvatar, /^data:image\/(png|webp);base64,/);
  assert.equal(saved.body.item.myAvatar, saved.body.item.myAvatar);
  const meta = await sharp(Buffer.from(saved.body.item.myAvatar.split(',')[1], 'base64')).metadata();
  assert.equal(meta.width, 256);
  assert.equal(meta.height, 256);

  const reread = await getPreferences(base, cookie);
  assert.equal(reread.body.item.revision, 2);
  assert.equal(reread.body.item.showFictionalMark, false);
});

test('saved preferences never rewrite existing scenes', async () => {
  const { base } = await makeApp();
  const { cookie } = await register(base);
  const scene = { ...createScene(), id: '11111111-1111-4111-8111-111111111111', watermark: '旧标记' };
  const created = await request(base, `/api/scenes/${scene.id}`, { method: 'PUT', cookie, body: { scene, revision: 0 } });
  assert.equal(created.status, 200);

  const saved = await putPreferences(base, cookie, { revision: 1, showFictionalMark: true, myAvatar: await pngDataUri({ width: 20, height: 20 }) });
  assert.equal(saved.res.status, 200);

  const read = await request(base, `/api/scenes/${scene.id}`, { cookie });
  const body = await read.json();
  assert.equal(body.item.scene.watermark, '旧标记');
  assert.equal(body.item.scene.participants.some((p) => p.avatar), false);
});

test('per-account isolation and concurrent revision conflicts', async () => {
  const { base } = await makeApp();
  const a = await register(base);
  const b = await register(base);
  const first = await putPreferences(base, a.cookie, { revision: 1, showFictionalMark: false, onboardingStatus: 'completed' });
  assert.equal(first.res.status, 200);

  const bPrefs = await getPreferences(base, b.cookie);
  assert.equal(bPrefs.body.item.showFictionalMark, true, 'account B keeps its own defaults');
  assert.equal(bPrefs.body.item.revision, 1);

  // A stale write for account A is rejected; account B is unaffected.
  const conflict = await putPreferences(base, a.cookie, { revision: 1, showFictionalMark: true });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.body.error.code, 'revision_conflict');
  const afterConflict = await getPreferences(base, a.cookie);
  assert.equal(afterConflict.body.item.showFictionalMark, false);
  assert.equal(afterConflict.body.item.revision, 2);
});

test('preferences require a session, origin and matching account header', async () => {
  const { base } = await makeApp();
  const { cookie, user } = await register(base);
  const noSession = await fetch(`${base}/api/preferences`, { headers: { origin: APP_ORIGIN } });
  assert.equal(noSession.status, 401);
  const noOrigin = await fetch(`${base}/api/preferences`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ revision: 1 }) });
  assert.equal(noOrigin.status, 403);
  const wrongUser = await request(base, '/api/preferences', { method: 'PUT', cookie, body: { revision: 1 }, headers: { 'x-imstage-user': 'not-the-owner' } });
  assert.equal(wrongUser.status, 401);
  assert.equal(typeof user.id, 'string');
});

test('events are allowlisted, deduped, and never carry avatar content', async () => {
  const { base } = await makeApp();
  const { cookie } = await register(base);
  for (const name of ['onboarding_shown', 'onboarding_saved', 'onboarding_skipped']) {
    const res = await request(base, '/api/preferences/events', { method: 'POST', cookie, body: { name } });
    assert.equal(res.status, 200, name);
  }
  const first = await request(base, '/api/preferences/events', { method: 'POST', cookie, body: { name: 'first_artwork_completed' } });
  const firstBody = await first.json();
  assert.equal(firstBody.event.recorded, true);
  const duplicate = await request(base, '/api/preferences/events', { method: 'POST', cookie, body: { name: 'first_artwork_completed' } });
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.event.recorded, false);
  assert.equal(duplicateBody.event.deduplicated, true);

  const rejected = await request(base, '/api/preferences/events', { method: 'POST', cookie, body: { name: 'avatar_uploaded', avatar: 'data:image/png;base64,AAAA' } });
  assert.equal(rejected.status, 400);

  const shown = await getPreferences(base, cookie);
  assert.equal(shown.body.item.onboardingShown, true);
});

test('account-once events cannot be deduped around with a client-supplied key', async () => {
  const { base } = await makeApp();
  const { cookie } = await register(base);
  // A client key is no longer part of the contract and is rejected outright.
  const freeform = await request(base, '/api/preferences/events', { method: 'POST', cookie, body: { name: 'first_artwork_completed', dedupeKey: 'retry-1' } });
  assert.equal(freeform.status, 400);
  assert.equal((await freeform.json()).error.code, 'unknown_field');
  // Concurrent/account-once retries are deduped by the server, regardless of
  // anything the client sends.
  const a = await request(base, '/api/preferences/events', { method: 'POST', cookie, body: { name: 'first_artwork_completed' } });
  const b = await request(base, '/api/preferences/events', { method: 'POST', cookie, body: { name: 'first_artwork_completed' } });
  assert.equal((await a.json()).event.recorded, true);
  assert.equal((await b.json()).event.recorded, false);
  const summary = await request(base, '/api/preferences/events', { cookie });
  assert.equal(summary.status, 200);
  const items = (await summary.json()).items;
  const first = items.find((item) => item.name === 'first_artwork_completed');
  assert.equal(first.count, 1);
});

test('avatar decode failure through the preferences API is a 400 that changes nothing', async () => {
  const { base } = await makeApp();
  const { cookie } = await register(base);
  const png = await pngDataUri({ width: 64, height: 64 });
  const truncated = `data:image/png;base64,${Buffer.from(png.split(',')[1], 'base64').subarray(0, 40).toString('base64')}`;
  const rejected = await putPreferences(base, cookie, { revision: 1, myAvatar: truncated });
  assert.equal(rejected.res.status, 400);
  assert.equal(rejected.body.error.code, 'invalid_avatar');
  const after = await getPreferences(base, cookie);
  assert.equal(after.body.item.revision, 1);
  assert.equal(after.body.item.myAvatar, null);
});

test('contact library stays empty after preferences save (no avatar disclosure)', async () => {
  const { base } = await makeApp();
  const { cookie } = await register(base);
  await putPreferences(base, cookie, { revision: 1, myAvatar: await pngDataUri({ width: 24, height: 24 }) });
  const library = await request(base, '/api/contact-library', { cookie });
  const body = await library.json();
  assert.deepEqual(body.contacts, []);
  assert.equal(body.selfContactId, null);
});

/* ------------------------------------------------------------------ */
/* MCP default fill over an in-memory transport                        */
/* ------------------------------------------------------------------ */

async function withMcpClient(run) {
  const dataDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'mcp-'));
  const store = openStore({ dataDir });
  const defaults = {
    myAvatar: await pngDataUri({ width: 16, height: 16 }),
    otherAvatar: await generateFictionalPortrait('mcp-other'),
    showFictionalMark: true,
    markLabel: '虚构对话',
  };
  const server = createImstageMcpServer({
    store,
    renderService: {},
    logger: { log() {}, warn() {}, error() {} },
    defaultSceneFill: async (raw) => applySceneDefaults(raw, defaults),
    sceneIdFactory: (() => { let n = 0; return () => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${(n += 1)}`; })(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'prefs-test', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client, defaults);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    store.close();
  }
}

test('MCP new scenes receive account defaults while explicit overrides survive', async () => {
  await withMcpClient(async (client, defaults) => {
    const baseScene = { ...structuredClone(createScene()), id: undefined, title: 'MCP 默认', platform: 'wechat', selfId: 'me', participants: [{ id: 'me', name: '我' }, { id: 'other', name: '对方' }], messages: [{ id: 'm-1', participantId: 'me', type: 'text', text: '你好', time: '09:41' }], watermark: undefined };
    delete baseScene.id;
    delete baseScene.watermark;
    const created = await client.callTool({ name: 'imstage_create_scene', arguments: { scene: baseScene } });
    const payload = created.structuredContent;
    assert.equal(payload.scene.participants.find((p) => p.id === 'me').avatar, defaults.myAvatar);
    assert.equal(payload.scene.participants.find((p) => p.id === 'other').avatar, defaults.otherAvatar);
    assert.equal(payload.scene.watermark, '虚构对话');

    const explicit = await client.callTool({
      name: 'imstage_create_scene',
      arguments: { scene: { ...structuredClone(baseScene), watermark: '', participants: [{ id: 'me', name: '我', avatar: '' }, { id: 'other', name: '对方' }] } },
    });
    assert.equal(explicit.structuredContent.scene.watermark, '');
    // An explicit empty avatar is not replaced by the account default; the
    // canonicalizer simply drops the empty key (semantically "no avatar").
    assert.equal(Boolean(explicit.structuredContent.scene.participants.find((p) => p.id === 'me').avatar), false);
  });
});

test('standalone MCP with no account defaults keeps system behaviour', () => {
  const scene = { ...createScene(), id: 'scene-system', selfId: 'me', participants: [{ id: 'me', name: '我' }, { id: 'other', name: '对方' }], messages: [{ id: 'm-1', participantId: 'me', type: 'text', text: '你好', time: '09:41' }], watermark: '' };
  const prepared = prepareCreateScene({ ...scene, id: undefined });
  const validation = validateScene(prepared);
  assert.equal(validation.ok, true);
  assert.equal(validation.scene.watermark, '', 'no account claim, no injected account mark');
  assert.equal(validation.scene.participants.some((p) => p.avatar), false);
});

/* ------------------------------------------------------------------ */
/* MCP render -> first_artwork_completed evidence                      */
/* ------------------------------------------------------------------ */

async function withRenderMcpServer({ renderService, authorizeCheck = null }, run) {
  const dataDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'mcp-render-'));
  const store = openStore({ dataDir });
  let events = 0;
  const server = createImstageMcpServer({
    store,
    renderService,
    logger: { log() {}, warn() {}, error() {} },
    authorizeCheck,
    onRenderSuccess: () => { events += 1; },
    sceneIdFactory: () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(events).padStart(12, '0')}`,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'render-test', version: '0.0.1' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await run(client, () => events);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    store.close();
  }
}

const RENDER_SCENE = { ...createScene(), selfId: 'me', participants: [{ id: 'me', name: '我' }], messages: [{ id: 'm-1', participantId: 'me', type: 'text', text: '渲染测试', time: '09:41' }], watermark: '虚构对话' };

function stubRender() {
  return async () => ({ pngBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'), sha256: 'a'.repeat(64), bytes: 8, width: 100, height: 200 });
}

test('MCP records first_artwork only after a real successful render', async () => {
  await withRenderMcpServer({ renderService: { render: stubRender() } }, async (client, events) => {
    const result = await client.callTool({ name: 'imstage_render_scene', arguments: { scene: { ...RENDER_SCENE, id: undefined } } });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.equal(events(), 1);
  });
});

test('MCP does not count a failed render', async () => {
  await withRenderMcpServer({ renderService: { render: async () => { throw new Error('render_failed'); } } }, async (client, events) => {
    const result = await client.callTool({ name: 'imstage_render_scene', arguments: { scene: { ...RENDER_SCENE, id: undefined } } });
    assert.equal(result.isError, true);
    assert.equal(events(), 0);
  });
});

test('MCP does not count a render whose post-render authorization was revoked', async () => {
  let calls = 0;
  const authorizeCheck = async () => {
    calls += 1;
    if (calls >= 2) throw new Error('revoked');
  };
  await withRenderMcpServer({ renderService: { render: stubRender() }, authorizeCheck }, async (client, events) => {
    const result = await client.callTool({ name: 'imstage_render_scene', arguments: { scene: { ...RENDER_SCENE, id: undefined } } });
    assert.equal(result.isError, true);
    assert.equal(events(), 0);
  });
});

for (const name of ['imstage_create_scene', 'imstage_get_capabilities']) {
  test(`${name} rejects authorization revoked while account defaults are pending`, async () => {
    const app = createApp({ dbPath: ':memory:', env: {}, distDir: '/nonexistent', logger: { log() {}, warn() {}, error() {} } });
    const userId = 'revocation-test';
    app.db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)')
      .run(userId, 'revocation@example.test', 'Synthetic', 'not-a-login', new Date().toISOString());
    let allowed = true, checks = 0, release, started;
    const began = new Promise((resolve) => { started = resolve; });
    const server = createAccountMcpServer({
      db: app.db, userId, renderService: {}, appOrigin: 'https://example.test', logger: { warn() {}, error() {} },
      authorizeCheck: async () => { checks++; if (!allowed) throw new InvalidTokenError('revoked'); },
      readPreferences: async () => {
        started();
        await new Promise((resolve) => { release = resolve; });
        return { myAvatar: null, otherAvatar: null, showFictionalMark: true };
      },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'revocation-test', version: '1' });
    await server.connect(st); await client.connect(ct);
    try {
      const scene = { ...RENDER_SCENE }; delete scene.id;
      const pending = client.callTool({ name, arguments: name === 'imstage_create_scene' ? { scene } : {} });
      await began; allowed = false; release();
      const result = await pending;
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'unauthorized');
      assert.equal(checks, 2);
      assert.equal(app.db.prepare('SELECT count(*) as n FROM scenes WHERE user_id=?').get(userId).n, 0);
    } finally { await client.close(); await server.close(); await app.close(); }
  });
}

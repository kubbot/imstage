/**
 * HTTP integration tests for the account-scoped persistent contact library.
 *
 * Coverage:
 *   - default empty library for a new account;
 *   - optimistic revision create/increment and 409 on stale writes;
 *   - per-account isolation and session/CSRF/identity pinning;
 *   - default (self) contact must reference an existing contact, deletion invalid;
 *   - structural/unknown-field validation and the 100-contact ceiling;
 *   - avatar must be a local decodable png/jpeg/webp data URI within the pixel
 *     and total-byte ceilings; remote URLs, SVG and forged headers rejected;
 *   - persistence across a server restart / database reopen;
 *   - contact metadata and avatar bytes are never logged.
 *
 * Avatars are generated locally with `sharp`; no provider/network call is made.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import sharp from 'sharp';

import { start } from '../services/api/server.mjs';
import { validateContactAvatars } from '../services/contacts/index.mjs';

/* ------------------------------------------------------------------ */
/* Scoped runtime directory                                            */
/* ------------------------------------------------------------------ */

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-contacts-'));

const APP_ORIGIN = 'http://127.0.0.1:4417';
const activeApps = new Set();

function caseDir(label) {
  return fs.mkdtempSync(path.join(RUNTIME_ROOT, `${label}-`));
}

async function makeApp({ logger, dbPath } = {}) {
  const dir = caseDir('case');
  const app = await start({
    dbPath: dbPath ?? path.join(dir, 'imstage.db'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: logger ?? { log() {}, error() {} },
    env: {},
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
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `contacts-${process.pid}-${emailSeq}@example.com`;
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

async function register(base) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify({ name: '联系人用户', email: uniqueEmail(), password: 'password-123456' }),
  });
  assert.equal(res.status, 200);
  return cookieFrom(res);
}

async function request(base, pathname, { method = 'GET', cookie, body, rawBody, headers } = {}) {
  return fetch(`${base}${pathname}`, {
    method,
    headers: mutationHeaders(cookie, headers),
    body: rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body),
  });
}

async function getLibrary(base, cookie, headers) {
  const res = await request(base, '/api/contact-library', { cookie, headers });
  return { res, body: await res.json().catch(() => null) };
}

async function putLibrary(base, cookie, body, { headers } = {}) {
  const res = await request(base, '/api/contact-library', { method: 'PUT', cookie, body, headers });
  return { res, body: await res.json().catch(() => null) };
}

const EMPTY_LIBRARY = { revision: 0, contacts: [], selfContactId: null, autoSave: true };

function contact(id, overrides = {}) {
  return { id, name: '联系人', subtitle: '', ...overrides };
}

/* ------------------------------------------------------------------ */
/* Avatar fixtures                                                     */
/* ------------------------------------------------------------------ */

async function avatar(format = 'png', width = 16, height = 16) {
  const data = await sharp({ create: { width, height, channels: 3, background: '#457aff' } })
    .toFormat(format)
    .toBuffer();
  const mime = format === 'jpg' ? 'jpeg' : format;
  return `data:image/${mime};base64,${data.toString('base64')}`;
}

/** Incompressible image whose decoded byte size is predictable (~1.43 MiB). */
async function noiseAvatar(size = 690) {
  const raw = crypto.randomBytes(size * size * 3);
  const data = await sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return `data:image/png;base64,${data.toString('base64')}`;
}

/* ------------------------------------------------------------------ */
/* Shared app                                                          */
/* ------------------------------------------------------------------ */

let shared;

before(async () => {
  shared = await makeApp();
});

/* ------------------------------------------------------------------ */
/* Defaults / revision                                                 */
/* ------------------------------------------------------------------ */

test('GET /api/contact-library returns the empty default for a fresh account', async () => {
  const cookie = await register(shared.base);
  const { res, body } = await getLibrary(shared.base, cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(body, EMPTY_LIBRARY);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('PUT creates then increments revisions and round-trips contacts in order', async () => {
  const cookie = await register(shared.base);
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();

  const created = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: [contact(a, { name: ' 小林 ', subtitle: '同事' })],
    selfContactId: null,
    autoSave: false,
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.revision, 1);
  assert.equal(created.body.selfContactId, null);
  assert.equal(created.body.autoSave, false);
  assert.deepEqual(created.body.contacts, [
    { id: a, name: '小林', subtitle: '同事', avatar: null },
  ]);

  const updated = await putLibrary(shared.base, cookie, {
    revision: 1,
    contacts: [contact(b, { name: '阿强' }), contact(a, { name: '小林' })],
    selfContactId: b,
    autoSave: true,
  });
  assert.equal(updated.res.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.revision, 2);
  assert.equal(updated.body.selfContactId, b);
  assert.equal(updated.body.autoSave, true);
  assert.deepEqual(
    updated.body.contacts.map((item) => item.id),
    [b, a],
  );

  const read = await getLibrary(shared.base, cookie);
  assert.deepEqual(read.body, updated.body);
});

test('stale revisions return 409 and never mutate committed state', async () => {
  const cookie = await register(shared.base);
  const a = crypto.randomUUID();
  const first = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: [contact(a, { name: '小林' })],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(first.res.status, 200);

  const stale = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: [contact(a, { name: '被覆盖' })],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(stale.res.status, 409);
  assert.equal(stale.body.error.code, 'revision_conflict');

  const future = await putLibrary(shared.base, cookie, {
    revision: 5,
    contacts: [],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(future.res.status, 409);
  assert.equal(future.body.error.code, 'revision_conflict');

  const read = await getLibrary(shared.base, cookie);
  assert.equal(read.body.revision, 1);
  assert.equal(read.body.contacts[0].name, '小林');
});

/* ------------------------------------------------------------------ */
/* Isolation / auth / CSRF                                             */
/* ------------------------------------------------------------------ */

test('contact libraries are isolated per account and require a session', async () => {
  const owner = await register(shared.base);
  const other = await register(shared.base);
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();

  const ownerPut = await putLibrary(shared.base, owner, {
    revision: 0,
    contacts: [contact(a, { name: '甲方联系人' })],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(ownerPut.res.status, 200);

  const otherRead = await getLibrary(shared.base, other);
  assert.deepEqual(otherRead.body, EMPTY_LIBRARY);

  const otherPut = await putLibrary(shared.base, other, {
    revision: 0,
    contacts: [contact(b, { name: '乙方联系人' })],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(otherPut.res.status, 200);

  const ownerRead = await getLibrary(shared.base, owner);
  assert.deepEqual(
    ownerRead.body.contacts.map((item) => item.id),
    [a],
  );
  assert.equal(ownerRead.body.revision, 1);

  const anonymousGet = await request(shared.base, '/api/contact-library');
  assert.equal(anonymousGet.status, 401);
  const anonymousPut = await putLibrary(shared.base, null, {
    revision: 0,
    contacts: [],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(anonymousPut.res.status, 401);
});

test('PUT enforces Origin, request marker and identity pinning', async () => {
  const a = await register(shared.base);
  const b = await register(shared.base);
  const id = crypto.randomUUID();
  const payload = {
    revision: 0,
    contacts: [contact(id, { name: '小林' })],
    selfContactId: null,
    autoSave: true,
  };

  const noOrigin = await fetch(`${shared.base}/api/contact-library`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-imstage-request': '1', cookie: a },
    body: JSON.stringify(payload),
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).error.code, 'origin_required');

  const badOrigin = await fetch(`${shared.base}/api/contact-library`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'x-imstage-request': '1', cookie: a },
    body: JSON.stringify(payload),
  });
  assert.equal(badOrigin.status, 403);
  assert.equal((await badOrigin.json()).error.code, 'origin_mismatch');

  const noMarker = await fetch(`${shared.base}/api/contact-library`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie: a },
    body: JSON.stringify(payload),
  });
  assert.equal(noMarker.status, 403);
  assert.equal((await noMarker.json()).error.code, 'request_marker_required');

  // B's cookie paired with A's pinned identity must not read or write A's data.
  const pinnedRead = await getLibrary(shared.base, b, { 'x-imstage-user': a });
  assert.equal(pinnedRead.res.status, 401);
  assert.equal(pinnedRead.body.error.code, 'account_changed');
  const pinnedPut = await putLibrary(shared.base, b, payload, { headers: { 'x-imstage-user': a } });
  assert.equal(pinnedPut.res.status, 401);
  assert.equal(pinnedPut.body.error.code, 'account_changed');
});

/* ------------------------------------------------------------------ */
/* Default (self) contact                                              */
/* ------------------------------------------------------------------ */

test('selfContactId must reference an existing contact and default deletion is invalid', async () => {
  const cookie = await register(shared.base);
  const a = crypto.randomUUID();
  const missing = crypto.randomUUID();

  const notFound = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: [contact(a, { name: '小林' })],
    selfContactId: missing,
    autoSave: true,
  });
  assert.equal(notFound.res.status, 400);
  assert.equal(notFound.body.error.code, 'invalid_self_contact');

  const set = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: [contact(a, { name: '小林' })],
    selfContactId: a,
    autoSave: true,
  });
  assert.equal(set.res.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.selfContactId, a);

  // Removing the referenced default while leaving selfContactId set is rejected.
  const deleted = await putLibrary(shared.base, cookie, {
    revision: 1,
    contacts: [],
    selfContactId: a,
    autoSave: true,
  });
  assert.equal(deleted.res.status, 400);
  assert.equal(deleted.body.error.code, 'invalid_self_contact');

  const read = await getLibrary(shared.base, cookie);
  assert.equal(read.body.revision, 1);
  assert.equal(read.body.selfContactId, a);
  assert.equal(read.body.contacts.length, 1);

  // Clearing the default and keeping the contact is allowed.
  const cleared = await putLibrary(shared.base, cookie, {
    revision: 1,
    contacts: [contact(a, { name: '小林' })],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(cleared.res.status, 200);
  assert.equal(cleared.body.selfContactId, null);
  assert.equal(cleared.body.revision, 2);
});

/* ------------------------------------------------------------------ */
/* Structural validation                                               */
/* ------------------------------------------------------------------ */

test('malformed bodies and unknown fields are rejected', async () => {
  const cookie = await register(shared.base);
  const id = crypto.randomUUID();
  const valid = {
    revision: 0,
    contacts: [contact(id, { name: '小林' })],
    selfContactId: null,
    autoSave: true,
  };

  const cases = [
    [{ ...valid, extra: true }, 'unknown_field'],
    [{ ...valid, revision: -1 }, 'invalid_revision'],
    [{ ...valid, revision: 1.5 }, 'invalid_revision'],
    [{ ...valid, contacts: 'nope' }, 'invalid_contacts'],
    [{ ...valid, autoSave: 'yes' }, 'invalid_auto_save'],
    [{ ...valid, selfContactId: 'not-a-uuid' }, 'invalid_self_contact'],
    [{ ...valid, contacts: [{ ...contact(id, { name: '小林' }), extra: 1 }] }, 'unknown_field'],
    [{ ...valid, contacts: [{ id: 'nope', name: '小林' }] }, 'invalid_contact_id'],
    [{ ...valid, contacts: [{ id, name: '   ' }] }, 'invalid_contact_name'],
    [{ ...valid, contacts: [{ id, name: 'x'.repeat(101) }] }, 'invalid_contact_name'],
    [{ ...valid, contacts: [{ id, name: '小林', subtitle: 'x'.repeat(201) }] }, 'invalid_contact_subtitle'],
    [{ ...valid, contacts: [{ id, name: '小林', avatar: 5 }] }, 'invalid_avatar'],
    [
      {
        ...valid,
        contacts: [contact(id, { name: '小林' }), contact(id, { name: '重复' })],
      },
      'duplicate_contact_id',
    ],
  ];

  for (const [body, code] of cases) {
    const { res, body: data } = await putLibrary(shared.base, cookie, body);
    assert.equal(res.status, 400, `expected 400 for ${code}`);
    assert.equal(data.error.code, code, JSON.stringify(data));
  }
});

test('duplicate contact ids are rejected case-insensitively', async () => {
  const cookie = await register(shared.base);
  const id = crypto.randomUUID();
  const upper = id.toUpperCase();
  assert.notEqual(id, upper);
  const { res, body } = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: [contact(id, { name: '小写' }), contact(upper, { name: '大写' })],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'duplicate_contact_id');
});

test('at most 100 contacts are accepted', async () => {
  const cookie = await register(shared.base);
  const make = (count) =>
    Array.from({ length: count }, (_, i) => contact(crypto.randomUUID(), { name: `联系人 ${i}` }));

  const ok = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: make(100),
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(ok.res.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.contacts.length, 100);

  const tooMany = await putLibrary(shared.base, cookie, {
    revision: 1,
    contacts: make(101),
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(tooMany.res.status, 400);
  assert.equal(tooMany.body.error.code, 'too_many_contacts');
});

test('contact library bodies over 12 MiB are rejected with 413', async () => {
  const cookie = await register(shared.base);
  const huge = {
    revision: 0,
    contacts: [{ id: crypto.randomUUID(), name: 'x'.repeat(13 * 1024 * 1024) }],
    selfContactId: null,
    autoSave: true,
  };
  const res = await request(shared.base, '/api/contact-library', {
    method: 'PUT',
    cookie,
    rawBody: JSON.stringify(huge),
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'payload_too_large');
});

/* ------------------------------------------------------------------ */
/* Avatar validation                                                   */
/* ------------------------------------------------------------------ */

test('avatars accept local png/jpeg/webp and round-trip through GET', async () => {
  const cookie = await register(shared.base);
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const png = await avatar('png');
  const jpeg = await avatar('jpeg');
  const webp = await avatar('webp');

  const { res, body } = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: [
      contact(ids[0], { name: 'PNG', avatar: png }),
      contact(ids[1], { name: 'JPEG', avatar: jpeg }),
      contact(ids[2], { name: 'WEBP', avatar: webp }),
    ],
    selfContactId: ids[0],
    autoSave: true,
  });
  assert.equal(res.status, 200, JSON.stringify(body));

  const read = await getLibrary(shared.base, cookie);
  assert.equal(read.body.contacts[0].avatar, png);
  assert.equal(read.body.contacts[1].avatar, jpeg);
  assert.equal(read.body.contacts[2].avatar, webp);
});

test('remote URLs, SVG and forged image headers are rejected', async () => {
  const cookie = await register(shared.base);
  const forged = `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64')}`;
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;

  const candidates = [
    'https://example.com/avatar.png',
    '/local/avatar.png',
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    svg,
    forged,
    '',
  ];

  for (const candidate of candidates) {
    const { res, body } = await putLibrary(shared.base, cookie, {
      revision: 0,
      contacts: [contact(crypto.randomUUID(), { name: '头像', avatar: candidate })],
      selfContactId: null,
      autoSave: true,
    });
    assert.equal(res.status, 400, `expected 400 for ${candidate.slice(0, 32)}`);
    assert.equal(body.error.code, 'invalid_avatar');
  }
});

test('avatars above 2 MiB encoded or 4 million pixels are rejected', async () => {
  const cookie = await register(shared.base);

  const oversized = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;
  const oversizeRes = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: [contact(crypto.randomUUID(), { name: '太大', avatar: oversized })],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(oversizeRes.res.status, 400);
  assert.equal(oversizeRes.body.error.code, 'invalid_avatar');

  const big = await avatar('png', 2100, 2100); // 4.41M pixels
  const pixelRes = await putLibrary(shared.base, cookie, {
    revision: 0,
    contacts: [contact(crypto.randomUUID(), { name: '像素过多', avatar: big })],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(pixelRes.res.status, 400);
  assert.equal(pixelRes.body.error.code, 'invalid_avatar');
});

test('total decoded avatar bytes above 8 MiB are rejected', async () => {
  const images = [];
  for (let i = 0; i < 6; i += 1) images.push(await noiseAvatar());

  // Each encoded string stays under the per-avatar 2 MiB ceiling but the six
  // decoded images exceed the 8 MiB library-wide budget.
  for (const image of images) {
    assert.ok(image.length <= 2 * 1024 * 1024, 'fixture stays under per-avatar limit');
  }

  const contacts = images.map((image, index) => ({
    id: crypto.randomUUID(),
    name: `噪声 ${index}`,
    avatar: image,
  }));
  await assert.rejects(
    validateContactAvatars(contacts),
    (error) => error.status === 400 && error.code === 'invalid_avatar',
  );

  // Five of the same images decode to under 8 MiB and pass.
  await validateContactAvatars(contacts.slice(0, 5));
});

/* ------------------------------------------------------------------ */
/* Restart / reopen                                                    */
/* ------------------------------------------------------------------ */

test('contact library survives a server restart and keeps revision checks', async () => {
  const dir = caseDir('restart');
  const dbPath = path.join(dir, 'imstage.db');
  const avatarData = await avatar('png');

  const appOne = await start({
    dbPath,
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
    env: {},
  });
  activeApps.add(appOne);
  const baseOne = `http://127.0.0.1:${appOne.port}`;

  const cookie = await register(baseOne);
  const id = crypto.randomUUID();
  const written = await putLibrary(baseOne, cookie, {
    revision: 0,
    contacts: [contact(id, { name: '小林', subtitle: '同事', avatar: avatarData })],
    selfContactId: id,
    autoSave: false,
  });
  assert.equal(written.res.status, 200, JSON.stringify(written.body));
  const session = cookie;
  await appOne.close();

  const appTwo = await start({
    dbPath,
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
    env: {},
  });
  activeApps.add(appTwo);
  const baseTwo = `http://127.0.0.1:${appTwo.port}`;

  const restored = await getLibrary(baseTwo, session);
  assert.equal(restored.res.status, 200);
  assert.equal(restored.body.revision, 1);
  assert.equal(restored.body.selfContactId, id);
  assert.equal(restored.body.autoSave, false);
  assert.deepEqual(restored.body.contacts, [
    { id, name: '小林', subtitle: '同事', avatar: avatarData },
  ]);

  const stale = await putLibrary(baseTwo, session, {
    revision: 0,
    contacts: [],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(stale.res.status, 409);

  const next = await putLibrary(baseTwo, session, {
    revision: 1,
    contacts: [contact(id, { name: '小林' })],
    selfContactId: null,
    autoSave: true,
  });
  assert.equal(next.res.status, 200);
  assert.equal(next.body.revision, 2);
  await appTwo.close();
});

test('contact tables persist on disk and reopen with a fresh DatabaseSync', async () => {
  const dir = caseDir('db-reopen');
  const dbPath = path.join(dir, 'imstage.db');
  const id = crypto.randomUUID();

  const { base, app } = await makeApp({ dbPath });
  const cookie = await register(base);
  const written = await putLibrary(base, cookie, {
    revision: 0,
    contacts: [contact(id, { name: '持久化联系人' })],
    selfContactId: id,
    autoSave: true,
  });
  assert.equal(written.res.status, 200);
  await app.close();

  const db = new DatabaseSync(dbPath);
  try {
    const library = db.prepare('SELECT revision, self_contact_id, auto_save FROM contact_libraries').get();
    assert.equal(Number(library.revision), 1);
    assert.equal(library.self_contact_id, id);
    assert.equal(Number(library.auto_save), 1);
    const rows = db.prepare('SELECT id, name FROM contacts WHERE user_id = (SELECT user_id FROM contact_libraries)').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, id);
    assert.equal(rows[0].name, '持久化联系人');
  } finally {
    db.close();
  }
});

/* ------------------------------------------------------------------ */
/* Logging hygiene                                                     */
/* ------------------------------------------------------------------ */

test('contact metadata and avatar bytes are never logged', async () => {
  const logged = [];
  const logger = {
    log: (...args) => logged.push(args.map((value) => String(value)).join(' ')),
    error: (...args) => logged.push(args.map((value) => String(value)).join(' ')),
  };
  const { base } = await makeApp({ logger });
  const cookie = await register(base);
  logged.length = 0;

  const secretName = `秘密联系人-${crypto.randomUUID()}`;
  const avatarData = await avatar('png');
  const id = crypto.randomUUID();
  const written = await putLibrary(base, cookie, {
    revision: 0,
    contacts: [contact(id, { name: secretName, subtitle: '机密副标题', avatar: avatarData })],
    selfContactId: id,
    autoSave: true,
  });
  assert.equal(written.res.status, 200);
  const read = await getLibrary(base, cookie);
  assert.equal(read.res.status, 200);

  const output = logged.join('\n');
  assert.ok(!output.includes(secretName), 'contact name must not be logged');
  assert.ok(!output.includes('机密副标题'), 'contact subtitle must not be logged');
  assert.ok(!output.includes(avatarData.slice(0, 64)), 'avatar bytes must not be logged');
});

test('an SVG disguised as a PNG data URI is rejected even if sharp can decode it', async()=>{
 const forged='data:image/png;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="red"/></svg>').toString('base64');
 await assert.rejects(validateContactAvatars([{avatar:forged}]),error=>error.code==='invalid_avatar');
});

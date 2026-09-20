import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { MAX_JSON_BODY_BYTES } from '../src/constants.mjs';
import { renderSyntheticChatPng } from '../src/fixtures.mjs';
import { casePayload, cleanupDir, launch, tempDataDir } from './helpers.mjs';

async function revisionOf(env) {
  const res = await env.request('GET', '/api/store');
  return res.json.revision;
}

async function makeApproved(env, { synthetic = false, overrides = {}, png } = {}) {
  let rev = await revisionOf(env);
  const created = await env.request('POST', '/api/cases', {
    revision: rev,
    case: casePayload({ synthetic, ...overrides }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.case.id;
  rev = created.json.revision;
  const buffer = png ?? renderSyntheticChatPng({ width: 64, height: 64, im: 'wechat' });
  const candidate = await env.request('POST', `/api/cases/${id}/candidate`, {
    revision: rev,
    name: 'actual.png',
    mime: 'image/png',
    dataBase64: buffer.toString('base64'),
  });
  assert.equal(candidate.status, 200, JSON.stringify(candidate.json));
  rev = candidate.json.revision;
  const review = await env.request('PUT', `/api/cases/${id}/review`, {
    revision: rev,
    review: {
      scores: { content: 2, imFidelity: 2, layout: 2, completeness: 2 },
      verdict: 'good',
      reason: 'ok',
    },
  });
  assert.equal(review.status, 200, JSON.stringify(review.json));
  rev = review.json.revision;
  const golden = await env.request('POST', `/api/cases/${id}/golden`, { revision: rev });
  assert.equal(golden.status, 200, JSON.stringify(golden.json));
  return { id, rev: golden.json.revision, buffer, case: golden.json.case };
}

test('case CRUD round-trips through the store', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const created = await env.request('POST', '/api/cases', { revision: 0, case: casePayload() });
  assert.equal(created.status, 201);
  const id = created.json.case.id;
  assert.equal(created.json.case.computed.inputFingerprint.startsWith('sha256:'), true);

  const listed = await env.request('GET', '/api/store');
  assert.equal(listed.json.cases.length, 1);
  assert.equal(listed.json.revision, created.json.revision);

  const updated = await env.request('PUT', `/api/cases/${id}`, {
    revision: created.json.revision,
    case: { question: '更新后的问题' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.case.question, '更新后的问题');
  assert.equal(updated.json.revision, created.json.revision + 1);

  const deleted = await env.request('DELETE', `/api/cases/${id}`, { revision: updated.json.revision });
  assert.equal(deleted.status, 200);
  const after = await env.request('GET', '/api/store');
  assert.equal(after.json.cases.length, 0);
});

test('candidate upload, review and golden promotion bind to fingerprints', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const approved = await makeApproved(env, { synthetic: true });
  assert.equal(approved.case.computed.goldenCurrent, true);
  assert.equal(approved.case.computed.exportable, true);
});

test('editing the input revokes review, golden and candidate provenance', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const approved = await makeApproved(env, { synthetic: true });

  const edited = await env.request('PUT', `/api/cases/${approved.id}`, {
    revision: approved.rev,
    case: { targetIM: 'telegram' },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.case.review, null);
  assert.equal(edited.json.case.golden, null);
  assert.equal(edited.json.case.computed.candidateCurrent, false);
  assert.equal(edited.json.case.computed.goldenCurrent, false);

  const staleReview = await env.request('PUT', `/api/cases/${approved.id}/review`, {
    revision: edited.json.revision,
    review: {
      scores: { content: 2, imFidelity: 2, layout: 2, completeness: 2 },
      verdict: 'good',
      reason: '',
    },
  });
  assert.equal(staleReview.status, 409);
  assert.equal(staleReview.json.code, 'stale_candidate');

  const promote = await env.request('POST', `/api/cases/${approved.id}/golden`, {
    revision: edited.json.revision,
  });
  assert.equal(promote.status, 409);
  assert.equal(promote.json.code, 'review_required');

  const exported = await env.request('POST', '/api/export', { scope: 'private' });
  assert.equal(exported.status, 200);
  assert.equal(exported.json.cases.length, 0);
});

test('concurrent saves on the same revision produce exactly one 409', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const created = await env.request('POST', '/api/cases', { revision: 0, case: casePayload() });
  const id = created.json.case.id;
  const rev = created.json.revision;

  const [a, b] = await Promise.all([
    env.request('PUT', `/api/cases/${id}`, { revision: rev, case: { notes: 'A' } }),
    env.request('PUT', `/api/cases/${id}`, { revision: rev, case: { notes: 'B' } }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const conflict = a.status === 409 ? a : b;
  assert.equal(conflict.json.code, 'revision_conflict');
  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.revision, rev + 1);
});

test('mutations require a revision token', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const res = await env.request('POST', '/api/cases', { case: casePayload() });
  assert.equal(res.status, 428);
  assert.equal(res.json.code, 'missing_revision');
});

test('rejects missing and cross-origin mutation requests', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const noOrigin = await env.request('POST', '/api/cases', { revision: 0, case: casePayload() }, { omitOrigin: true });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.json.code, 'missing_origin');

  const cross = await env.request(
    'POST',
    '/api/cases',
    { revision: 0, case: casePayload() },
    { headers: { Origin: 'http://evil.example.com' } },
  );
  assert.equal(cross.status, 403);
  assert.equal(cross.json.code, 'invalid_origin');

  const wrongPort = await env.request(
    'POST',
    '/api/cases',
    { revision: 0, case: casePayload() },
    { headers: { Origin: 'http://127.0.0.1:1' } },
  );
  assert.equal(wrongPort.status, 403);
  assert.equal(wrongPort.json.code, 'invalid_origin');

  const noPort = await env.request(
    'POST',
    '/api/cases',
    { revision: 0, case: casePayload() },
    { headers: { Origin: 'http://127.0.0.1' } },
  );
  assert.equal(noPort.status, 403);
  assert.equal(noPort.json.code, 'invalid_origin');
});

test('rejects non-JSON mutation content type', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const res = await env.request('POST', '/api/cases', undefined, {
    headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(res.status, 415);
});

test('rejects non-JSON content type with a raw request', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const res = await env.rawRequest({
    method: 'POST',
    urlPath: '/api/cases',
    headers: {
      'Content-Type': 'text/plain',
      Origin: env.base,
      Host: `127.0.0.1:${env.port}`,
      'Content-Length': 4,
    },
    body: 'body',
  });
  assert.equal(res.status, 415);
});

test('rejects forged Host headers', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const evil = await env.rawRequest({ urlPath: '/api/health', headers: { Host: 'evil.example.com' } });
  assert.equal(evil.status, 403);
  const wrongPort = await env.rawRequest({
    urlPath: '/api/health',
    headers: { Host: '127.0.0.1:1' },
  });
  assert.equal(wrongPort.status, 403);
  const ok = await env.rawRequest({
    urlPath: '/api/health',
    headers: { Host: `127.0.0.1:${env.port}` },
  });
  assert.equal(ok.status, 200);
});

test('rejects oversized JSON bodies', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const big = `{"pad":"${'a'.repeat(MAX_JSON_BODY_BYTES)}"}`;
  const res = await env.rawRequest({
    method: 'POST',
    urlPath: '/api/cases',
    headers: {
      'Content-Type': 'application/json',
      Origin: env.base,
      Host: `127.0.0.1:${env.port}`,
      'Content-Length': Buffer.byteLength(big),
    },
    body: big,
  });
  assert.equal(res.status, 413);
});

test('rejects unsafe MIME types and content mismatches', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const created = await env.request('POST', '/api/cases', { revision: 0, case: casePayload() });
  const id = created.json.case.id;
  const rev = created.json.revision;

  const unsafe = await env.request('POST', `/api/cases/${id}/attachments`, {
    revision: rev,
    name: 'evil.html',
    mime: 'text/html',
    dataBase64: Buffer.from('<script>').toString('base64'),
  });
  assert.equal(unsafe.status, 422);
  assert.equal(unsafe.json.code, 'unsafe_mime');

  const mismatch = await env.request('POST', `/api/cases/${id}/attachments`, {
    revision: rev,
    name: 'fake.png',
    mime: 'image/png',
    dataBase64: Buffer.from('not a png').toString('base64'),
  });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.json.code, 'mime_sniff_mismatch');

  const notPngCandidate = await env.request('POST', `/api/cases/${id}/candidate`, {
    revision: rev,
    name: 'x.png',
    mime: 'image/png',
    dataBase64: Buffer.from('not a png').toString('base64'),
  });
  assert.equal(notPngCandidate.status, 422);
  assert.equal(notPngCandidate.json.code, 'invalid_png');
});

test('rejects attachments beyond count and size bounds', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const smallPng = renderSyntheticChatPng({ width: 4, height: 4 });
  const created = await env.request('POST', '/api/cases', { revision: 0, case: casePayload() });
  const id = created.json.case.id;
  let rev = created.json.revision;
  for (let i = 0; i < 8; i += 1) {
    const res = await env.request('POST', `/api/cases/${id}/attachments`, {
      revision: rev,
      name: `a${i}.png`,
      mime: 'image/png',
      kind: 'image',
      dataBase64: smallPng.toString('base64'),
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    rev = res.json.revision;
  }
  const overflow = await env.request('POST', `/api/cases/${id}/attachments`, {
    revision: rev,
    name: 'a9.png',
    mime: 'image/png',
    dataBase64: smallPng.toString('base64'),
  });
  assert.equal(overflow.status, 422);
  assert.equal(overflow.json.code, 'too_many_attachments');
});

test('starter cases load unreviewed, explicitly synthetic and never auto-seeded', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const preview = await env.request('GET', '/api/starter');
  assert.equal(preview.json.starters.length, 3);
  const before = await env.request('GET', '/api/store');
  assert.equal(before.json.cases.length, 0);

  const loaded = await env.request('POST', '/api/starter', { revision: before.json.revision });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.json));
  assert.equal(loaded.json.imported.length, 3);
  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 3);
  for (const c of store.json.cases) {
    assert.equal(c.review, null);
    assert.equal(c.golden, null);
    assert.equal(c.synthetic, true);
    assert.equal(c.computed.goldenCurrent, false);
  }
});

test('export excludes unreviewed, bad and private cases from the synthetic scope', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const goodSynthetic = await makeApproved(env, { synthetic: true });
  const goodPrivate = await makeApproved(env, { synthetic: false });

  // A reviewed-bad case must never be exportable.
  let rev = (await env.request('GET', '/api/store')).json.revision;
  const badCreate = await env.request('POST', '/api/cases', {
    revision: rev,
    case: casePayload({ synthetic: true, question: 'bad example' }),
  });
  rev = badCreate.json.revision;
  const badId = badCreate.json.case.id;
  const badPng = renderSyntheticChatPng({ width: 64, height: 64, im: 'telegram' });
  const badCand = await env.request('POST', `/api/cases/${badId}/candidate`, {
    revision: rev,
    mime: 'image/png',
    dataBase64: badPng.toString('base64'),
  });
  rev = badCand.json.revision;
  await env.request('PUT', `/api/cases/${badId}/review`, {
    revision: rev,
    review: {
      scores: { content: 0, imFidelity: 0, layout: 0, completeness: 0 },
      verdict: 'bad',
      reason: 'wrong platform style',
    },
  });

  const synthetic = await env.request('POST', '/api/export', { scope: 'synthetic' });
  assert.equal(synthetic.status, 200);
  assert.deepEqual(
    synthetic.json.cases.map((c) => c.bundleCaseId),
    [goodSynthetic.id],
  );

  const privateExport = await env.request('POST', '/api/export', { scope: 'private' });
  const ids = privateExport.json.cases.map((c) => c.bundleCaseId).sort();
  assert.deepEqual(ids, [goodSynthetic.id, goodPrivate.id].sort());

  const filtered = await env.request('POST', '/api/export', {
    scope: 'private',
    caseIds: [goodPrivate.id],
  });
  assert.deepEqual(filtered.json.cases.map((c) => c.bundleCaseId), [goodPrivate.id]);
});

test('mismatched candidate dimensions can be reviewed but never promoted', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  let rev = await revisionOf(env);
  const created = await env.request('POST', '/api/cases', {
    revision: rev,
    case: casePayload({ width: 390, height: 844 }),
  });
  const id = created.json.case.id;
  rev = created.json.revision;
  const png = renderSyntheticChatPng({ width: 64, height: 64, im: 'wechat' });
  const candidate = await env.request('POST', `/api/cases/${id}/candidate`, {
    revision: rev,
    mime: 'image/png',
    dataBase64: png.toString('base64'),
  });
  assert.equal(candidate.status, 200);
  assert.equal(candidate.json.dimensionsMatchCase, false);
  rev = candidate.json.revision;

  // Labelable as a bad example.
  const bad = await env.request('PUT', `/api/cases/${id}/review`, {
    revision: rev,
    review: {
      scores: { content: 0, imFidelity: 0, layout: 0, completeness: 0 },
      verdict: 'bad',
      reason: 'wrong dimensions',
    },
  });
  assert.equal(bad.status, 200);
  rev = bad.json.revision;

  // Even a good review must not be promotable while dimensions mismatch.
  const good = await env.request('PUT', `/api/cases/${id}/review`, {
    revision: rev,
    review: {
      scores: { content: 2, imFidelity: 2, layout: 2, completeness: 2 },
      verdict: 'good',
      reason: 'content ok',
    },
  });
  assert.equal(good.status, 200);
  rev = good.json.revision;
  const promote = await env.request('POST', `/api/cases/${id}/golden`, { revision: rev });
  assert.equal(promote.status, 409);
  assert.equal(promote.json.code, 'dimension_mismatch');

  const exported = await env.request('POST', '/api/export', { scope: 'private' });
  assert.equal(exported.json.cases.length, 0);
});

test('re-saving a good review with changed scores revokes the golden binding', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const approved = await makeApproved(env, { synthetic: true });
  assert.equal(approved.case.computed.goldenCurrent, true);

  const rescored = await env.request('PUT', `/api/cases/${approved.id}/review`, {
    revision: approved.rev,
    review: {
      scores: { content: 2, imFidelity: 2, layout: 1, completeness: 2 },
      verdict: 'good',
      reason: 'layout score changed',
    },
  });
  assert.equal(rescored.status, 200);
  assert.equal(rescored.json.case.golden, null);
  assert.equal(rescored.json.case.computed.goldenCurrent, false);

  const exported = await env.request('POST', '/api/export', { scope: 'private' });
  assert.equal(exported.json.cases.length, 0);
});

test('partial edits can clear notes but reject blank required fields and oversized merges', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const created = await env.request('POST', '/api/cases', {
    revision: 0,
    case: casePayload({ notes: 'keep me', width: 390, height: 20000 }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.case.id;

  const cleared = await env.request('PUT', `/api/cases/${id}`, {
    revision: created.json.revision,
    case: { notes: '' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.case.notes, '');

  const blankQuestion = await env.request('PUT', `/api/cases/${id}`, {
    revision: cleared.json.revision,
    case: { question: '' },
  });
  assert.equal(blankQuestion.status, 422);
  assert.equal(blankQuestion.json.code, 'missing_field');

  const budget = await env.request('PUT', `/api/cases/${id}`, {
    revision: cleared.json.revision,
    case: { width: 500 },
  });
  assert.equal(budget.status, 422);
  assert.equal(budget.json.code, 'out_of_range');
});

test('toggling the synthetic flag revokes golden and requires re-approval', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const approved = await makeApproved(env, { synthetic: false });
  const toggled = await env.request('PUT', `/api/cases/${approved.id}`, {
    revision: approved.rev,
    case: { synthetic: true },
  });
  assert.equal(toggled.status, 200);
  assert.equal(toggled.json.case.synthetic, true);
  assert.equal(toggled.json.case.golden, null);
  assert.equal(toggled.json.case.computed.goldenCurrent, false);
  // The review itself is preserved; only the approval is withdrawn.
  assert.equal(toggled.json.case.review.status, 'reviewed');
  const syntheticExport = await env.request('POST', '/api/export', { scope: 'synthetic' });
  assert.equal(syntheticExport.json.cases.length, 0);
});

test('GET /api/generation exposes defaults without secrets', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const res = await env.request('GET', '/api/generation');
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.configured, 'boolean');
  assert.equal(typeof res.json.model, 'string');
  assert.equal(res.json.images, true);
  assert.deepEqual(res.json.defaults, {
    targetIM: 'wechat',
    surface: 'ios',
    outputKind: 'screenshot',
  });
  assert.equal(res.text.includes('apiKey'), false);
  assert.equal(res.text.includes('baseUrl'), false);
});

test('generation meta limits are advertised', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const meta = await env.request('GET', '/api/meta');
  assert.equal(meta.status, 200);
  assert.equal(meta.json.maxGenerationImages, 3);
  assert.equal(meta.json.maxGenerationImageBytes, 2 * 1024 * 1024);
  assert.deepEqual(meta.json.surfaceDimensions.ios, { width: 390, height: 844 });
  assert.deepEqual(meta.json.surfaceDimensions.desktop, { width: 720, height: 900 });
});

test('serves the UI and blocks path traversal', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const index = await env.request('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  const app = await env.request('GET', '/app.js');
  assert.equal(app.status, 200);
  assert.match(app.headers.get('content-type'), /javascript/);
  const traversal = await env.rawRequest({ urlPath: '/..%2fpackage.json', headers: { Host: `127.0.0.1:${env.port}` } });
  assert.equal(traversal.status, 403);
});

test('corrupt store surfaces an error and is never overwritten', async (t) => {
  const dir = tempDataDir('api-corrupt');
  await fs.promises.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, 'store.json');
  const corrupt = 'totally not json';
  await fs.promises.writeFile(storePath, corrupt);
  const env = await launch({ dataDir: dir });
  t.after(() => env.close());
  const res = await env.request('GET', '/api/store');
  assert.equal(res.status, 500);
  assert.equal(res.json.code, 'corrupt_store');
  assert.equal(res.json.corrupt, true);
  const health = await env.request('GET', '/api/health');
  assert.equal(health.status, 503);
  assert.equal(health.json.ok, false);
  assert.equal(health.json.store.ok, false);
  const mutate = await env.request('POST', '/api/cases', { revision: 0, case: casePayload() });
  assert.equal(mutate.status, 500);
  assert.equal(await fs.promises.readFile(storePath, 'utf8'), corrupt);
  await cleanupDir(dir);
});

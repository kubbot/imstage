import assert from 'node:assert/strict';
import test from 'node:test';
import { exportBundle, importBundle } from '../src/bundle.mjs';
import { Store } from '../src/store.mjs';
import { renderSyntheticChatPng } from '../src/fixtures.mjs';
import { casePayload, cleanupDir, launch, tempDataDir } from './helpers.mjs';

async function buildApprovedWithAttachment(env, synthetic = true) {
  let rev = (await env.request('GET', '/api/store')).json.revision;
  const created = await env.request('POST', '/api/cases', {
    revision: rev,
    case: casePayload({ synthetic, question: 'bundle roundtrip case' }),
  });
  const id = created.json.case.id;
  rev = created.json.revision;

  const inputPng = renderSyntheticChatPng({ width: 8, height: 8, im: 'wechat', variant: 1 });
  const attached = await env.request('POST', `/api/cases/${id}/attachments`, {
    revision: rev,
    name: 'input.png',
    mime: 'image/png',
    kind: 'image',
    dataBase64: inputPng.toString('base64'),
  });
  assert.equal(attached.status, 200, JSON.stringify(attached.json));
  rev = attached.json.revision;

  const candidatePng = renderSyntheticChatPng({ width: 64, height: 64, im: 'wechat' });
  const candidate = await env.request('POST', `/api/cases/${id}/candidate`, {
    revision: rev,
    mime: 'image/png',
    dataBase64: candidatePng.toString('base64'),
  });
  rev = candidate.json.revision;

  const review = await env.request('PUT', `/api/cases/${id}/review`, {
    revision: rev,
    review: {
      scores: { content: 2, imFidelity: 1, layout: 2, completeness: 2 },
      verdict: 'good',
      reason: 'roundtrip',
    },
  });
  rev = review.json.revision;
  const golden = await env.request('POST', `/api/cases/${id}/golden`, { revision: rev });
  return { id, rev: golden.json.revision, candidatePng, inputPng };
}

test('export -> import -> export round-trips golden data and hashes', async (t) => {
  const envA = await launch();
  const envB = await launch();
  t.after(async () => {
    await envA.close();
    await envB.close();
  });

  const approved = await buildApprovedWithAttachment(envA, true);
  const exported = await envA.request('POST', '/api/export', { scope: 'private' });
  assert.equal(exported.status, 200);
  assert.equal(exported.json.cases.length, 1);
  const original = exported.json.cases[0];
  assert.equal(original.synthetic, true);
  assert.equal(original.goldenPng.sha256.length, 64);
  assert.equal(original.attachments.length, 1);
  assert.equal(typeof original.reviewFingerprint, 'string');

  const imported = await envB.request('POST', '/api/import', {
    bundle: exported.json,
    revision: 0,
  });
  assert.equal(imported.status, 200, JSON.stringify(imported.json));
  assert.equal(imported.json.imported.length, 1);

  const storeB = await envB.request('GET', '/api/store');
  assert.equal(storeB.json.cases.length, 1);
  const caseB = storeB.json.cases[0];
  assert.equal(caseB.computed.goldenCurrent, true);
  assert.equal(caseB.computed.candidateCurrent, true);
  assert.equal(caseB.attachments[0].sha256, original.attachments[0].sha256);
  // Imported cases receive fresh IDs.
  assert.notEqual(caseB.id, approved.id);

  const reexported = await envB.request('POST', '/api/export', { scope: 'private' });
  const again = reexported.json.cases[0];
  assert.equal(again.inputFingerprint, original.inputFingerprint);
  assert.equal(again.goldenPng.sha256, original.goldenPng.sha256);
  assert.equal(again.maxDiffRatio, original.maxDiffRatio);
  assert.equal(again.synthetic, true);
  assert.deepEqual(again.scores, original.scores);
  assert.equal(again.attachments[0].sha256, original.attachments[0].sha256);
  assert.equal(again.goldenPng.base64, original.goldenPng.base64);
  assert.equal(again.reviewFingerprint, original.reviewFingerprint);
});

test('imports always create new ids and require a current revision', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  const approved = await buildApprovedWithAttachment(env, true);
  const bundle = (await env.request('POST', '/api/export', { scope: 'private' })).json;

  let rev = (await env.request('GET', '/api/store')).json.revision;
  const first = await env.request('POST', '/api/import', { bundle, revision: rev });
  assert.equal(first.status, 200, JSON.stringify(first.json));
  let store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 2);

  const second = await env.request('POST', '/api/import', { bundle, revision: store.json.revision });
  assert.equal(second.status, 200);
  store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 3, 'no destructive overwrite path');
  // All three cases have distinct ids.
  assert.equal(new Set(store.json.cases.map((c) => c.id)).size, 3);
  assert.ok(store.json.cases.every((c) => c.computed.goldenCurrent));

  const missing = await env.request('POST', '/api/import', { bundle });
  assert.equal(missing.status, 428);
  assert.equal(missing.json.code, 'missing_revision');

  const stale = await env.request('POST', '/api/import', { bundle, revision: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'revision_conflict');

  const original = store.json.cases.find((c) => c.id === approved.id);
  assert.equal(original.computed.goldenCurrent, true, 'existing case untouched');
});

test('rejects tampered, unsupported and non-strict bundles', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  await buildApprovedWithAttachment(env, true);
  const bundle = (await env.request('POST', '/api/export', { scope: 'private' })).json;
  const rev = (await env.request('GET', '/api/store')).json.revision;

  const attempts = [
    ['bad fingerprint', (b) => (b.cases[0].inputFingerprint = `sha256:${'0'.repeat(64)}`), 'bundle_stale_fingerprint'],
    ['bad png', (b) => (b.cases[0].goldenPng.base64 = Buffer.from('garbage').toString('base64')), 'invalid_png'],
    ['bad version', (b) => (b.schemaVersion = 999), 'unsupported_bundle_version'],
    ['bad kind', (b) => (b.kind = 'nope'), 'invalid_bundle'],
    ['unsupported threshold', (b) => (b.threshold = 0.5), 'unsupported_threshold'],
    ['duplicate id', (b) => b.cases.push(structuredClone(b.cases[0])), 'duplicate_case_id'],
    ['unsafe id', (b) => (b.cases[0].bundleCaseId = 'a/b'), 'unsafe_id'],
    ['missing bundle case id', (b) => delete b.cases[0].bundleCaseId, 'invalid_bundle'],
    ['score too large', (b) => (b.cases[0].scores.content = 99), 'invalid_score'],
    ['score negative', (b) => (b.cases[0].scores.layout = -3), 'invalid_score'],
    ['score string', (b) => (b.cases[0].scores.imFidelity = 'good'), 'invalid_score'],
    ['score null', (b) => (b.cases[0].scores.completeness = null), 'invalid_score'],
    ['unknown rubric', (b) => (b.cases[0].rubricVersion = 'v999'), 'unsupported_rubric'],
    ['missing golden hash', (b) => delete b.cases[0].goldenPng.sha256, 'bundle_hash_mismatch'],
    ['missing attachment hash', (b) => delete b.cases[0].attachments[0].sha256, 'bundle_hash_mismatch'],
    ['bad verdict', (b) => (b.cases[0].verdict = 'bad'), 'invalid_enum'],
    ['bad review fingerprint', (b) => (b.cases[0].reviewFingerprint = `sha256:${'0'.repeat(64)}`), 'bundle_review_mismatch'],
  ];
  for (const [name, mutate, expectedCode] of attempts) {
    const bad = structuredClone(bundle);
    mutate(bad);
    const res = await env.request('POST', '/api/import', { bundle: bad, revision: rev });
    assert.equal(res.status, 422, `${name}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.code, expectedCode, `${name}: ${JSON.stringify(res.json)}`);
  }
  // Nothing was imported.
  assert.equal((await env.request('GET', '/api/store')).json.cases.length, 1);
});

test('synthetic scope refuses bundles that contain private cases', async (t) => {
  const env = await launch();
  t.after(() => env.close());
  await buildApprovedWithAttachment(env, false);
  const bundle = (await env.request('POST', '/api/export', { scope: 'private' })).json;
  assert.equal(bundle.cases[0].synthetic, false);
  const forced = { ...structuredClone(bundle), scope: 'synthetic' };
  const rev = (await env.request('GET', '/api/store')).json.revision;
  const res = await env.request('POST', '/api/import', { bundle: forced, revision: rev });
  assert.equal(res.status, 422);
  assert.equal(res.json.code, 'bundle_scope_mismatch');
});

test('exportBundle/importBundle work at the store level and require revision', async () => {
  const dir = tempDataDir('bundle-store');
  try {
    const store = new Store({ dataDir: dir });
    await store.load();
    const bundle = await exportBundle({ store, scope: 'private' });
    assert.equal(bundle.cases.length, 0);
    await assert.rejects(
      () => importBundle({ rawBundle: { ...bundle, cases: [] }, store }),
      /导入必须携带整数 revision/,
    );
    const ids = await importBundle({
      rawBundle: { ...bundle, cases: [] },
      store,
      expectedRevision: 0,
    });
    assert.deepEqual(ids, []);
  } finally {
    await cleanupDir(dir);
  }
});

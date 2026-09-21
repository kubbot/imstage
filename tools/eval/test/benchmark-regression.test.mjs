// Independent review regressions. All images, text and model answers are
// synthetic; no provider, browser or real dataset is used by this suite.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { encodePng, decodePng } from '../src/png.mjs';
import { sha256Hex } from '../src/util.mjs';
import { readDataset } from '../src/benchmark/dataset.mjs';
import { runDataset, renderExpectedDataset, writeFailureReport } from '../src/benchmark/run.mjs';
import { createDatasetApi } from '../src/dataset-api.mjs';

const PACKAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
const ROOT = path.resolve(process.env.IMSTAGE_EVAL_TEST_DIR ?? os.tmpdir());
const ENV = Object.freeze({ IMSTAGE_AI_MODEL: 'synthetic-offline-model' });
const PRIVATE_MARKER = 'SYNTHETIC_PRIVATE_REVIEW_SENTINEL';

// This answer is deliberately authored separately from the grading fixture.
// The provider never sees, closes over, or derives anything from expected.
const FIXED_RESPONSE = JSON.stringify({
  schemaVersion: 1, im: 'wechat', surface: 'ios', width: 80, height: 80,
  edits: [{ id: 'label', kind: 'text', box: [100, 100, 600, 300], text: 'READY',
    background: '#FFFFFF', color: '#111111', fontSize: 12, fontWeight: 400, align: 'left' }],
  warnings: [],
});

function providerProbe() {
  const calls = [];
  const generatePlan = async (args) => {
    calls.push(args);
    assert.equal(args.request.task, 'Replace the label in [100,100,600,300] with READY.');
    return { rawContent: FIXED_RESPONSE, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  };
  return { calls, generatePlan };
}

// A deterministic raster seam for runner tests, not evidence of text rendering.
// Paints a small mark inside the answer box so preservation changes are real.
function renderSynthetic({ sourceBuffer, width, height, plan }) {
  const source = decodePng(sourceBuffer);
  const data = Buffer.from(source.data);
  if (plan.edits.length) {
    for (let y = 12; y < 18; y += 1) for (let x = 12; x < 30; x += 1) {
      const offset = (y * width + x) * 4;
      data[offset] = 17; data[offset + 1] = 17; data[offset + 2] = 17;
    }
  }
  return { buffer: encodePng({ width, height, data }), width, height,
    textFits: plan.edits.filter((edit) => edit.kind === 'text').map((edit) => ({ id: edit.id, fits: true })),
    patches: [], warnings: [] };
}

async function fixture(t, { asset = false, analysis = { observed: [], unchanged: [], risks: [] } } = {}) {
  await fs.mkdir(ROOT, { recursive: true });
  const root = await fs.mkdtemp(path.join(ROOT, 'benchmark-regression-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const datasetDir = path.join(root, 'dataset');
  const outDir = path.join(root, 'output');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(datasetDir); await fs.mkdir(dataDir);
  const png = encodePng({ width: 80, height: 80, data: Buffer.alloc(80 * 80 * 4, 255) });
  await fs.writeFile(path.join(datasetDir, 'source.png'), png);
  const manifest = {
    schemaVersion: 1, kind: 'imstage-screenshot-edit-dataset', id: 'synthetic-regression',
    version: 1, private: true, assets: [], cases: [{
      id: 'C01', title: 'Synthetic review case', difficulty: 1, im: 'wechat', surface: 'ios',
      source: { file: 'source.png', mime: 'image/png', width: 80, height: 80, sha256: sha256Hex(png) },
      task: 'Replace the label in [100,100,600,300] with READY.', analysis, assetIds: [],
      expected: {
        answer: PRIVATE_MARKER,
        edits: [{ id: 'label', kind: 'text', box: [100, 100, 600, 300], text: 'READY',
          background: '#FFFFFF', color: '#111111', fontSize: 12, fontWeight: 400, align: 'left' }],
        preserveRegions: [], minScore: 0.8,
      }, referenceStatus: 'proposed',
    }],
  };
  if (asset) {
    await fs.writeFile(path.join(datasetDir, 'asset.png'), png);
    manifest.assets.push({ id: 'asset1', file: 'asset.png', mime: 'image/png', width: 80, height: 80,
      sha256: sha256Hex(png), description: 'Synthetic asset', provenance: 'deterministic-map' });
    manifest.cases[0].assetIds.push('asset1');
  }
  const save = () => fs.writeFile(path.join(datasetDir, 'manifest.json'), JSON.stringify(manifest));
  await save();
  const run = (options = {}) => runDataset({ datasetDir, outDir, env: ENV, renderPlan: renderSynthetic, ...options });
  const api = createDatasetApi({ datasetDir, outDir, dataDir,
    readJsonBody: async (req) => req.body,
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
  });
  const request = async (route = '/api/dataset', body) => {
    const res = { writeHead(status) { this.status = status; }, end(bytes) { this.body = bytes; } };
    await api({ method: body ? 'POST' : 'GET', body }, res, new URL(route, 'http://localhost'));
    return res.body;
  };
  return { root, datasetDir, outDir, dataDir, manifest, png, save, run, request };
}

test('benchmark provider seam receives only public request data, never grading answers', async (t) => {
  const f = await fixture(t, { analysis: { observed: [PRIVATE_MARKER], unchanged: [], risks: [] } });
  const p = providerProbe();
  const report = await f.run({ generatePlan: p.generatePlan });
  assert.equal(report.ok, true);
  assert.equal(p.calls.length, 1);
  assert.equal(Object.hasOwn(p.calls[0], 'caseData'), false);
  assert.equal(JSON.stringify(p.calls[0]).includes(PRIVATE_MARKER), false);
  for (const file of ['report.json', 'report.md']) {
    assert.equal((await fs.readFile(path.join(f.outDir, file), 'utf8')).includes(PRIVATE_MARKER), false);
  }
});

const manifestChanges = [
  ['expected text', (m) => { m.cases[0].expected.edits[0].text = 'DIFFERENT'; }, false],
  ['grading threshold', (m) => { m.cases[0].expected.minScore = 1; }],
  ['preserved region', (m) => { m.cases[0].expected.preserveRegions = [[0, 0, 1000, 1000]]; }, false],
  ['dataset version', (m) => { m.version += 1; }],
  ['analysis', (m) => { m.cases[0].analysis.observed.push('new observation'); }],
  ['asset metadata', (m) => { m.assets[0].description = 'updated asset description'; }],
];
for (const [label, mutate, shouldPass] of manifestChanges) {
  test(`resume invalidates the previous result after changing ${label}`, async (t) => {
    const f = await fixture(t, { asset: true });
    const p = providerProbe();
    assert.equal((await f.run({ generatePlan: p.generatePlan })).ok, true);
    const same = await f.run({ generatePlan: p.generatePlan, resume: true });
    assert.equal(same.counts.resumeReused, 1);
    assert.equal(p.calls.length, 1);
    mutate(f.manifest); await f.save();
    const changed = await f.run({ generatePlan: p.generatePlan, resume: true });
    assert.equal(changed.counts.resumeReused, 0);
    assert.equal(p.calls.length, 2, 'stale cache must force a new provider call');
    if (shouldPass !== undefined) assert.equal(changed.ok, shouldPass);
  });
}

for (const kind of ['corrupt', 'different-valid']) {
  test(`resume invalidates a ${kind} PNG despite an unchanged score record`, async (t) => {
    const f = await fixture(t); const p = providerProbe();
    assert.equal((await f.run({ generatePlan: p.generatePlan })).ok, true);
    await fs.writeFile(path.join(f.outDir, 'private', 'C01.png'), kind === 'corrupt' ? Buffer.from('not png') : f.png);
    const report = await f.run({ generatePlan: p.generatePlan, resume: true });
    assert.equal(report.counts.resumeReused, 0);
    assert.equal(p.calls.length, 2);
    assert.equal(report.ok, true);
  });
}

test('resume invalidates a different provider endpoint using the same model name', async (t) => {
  const f = await fixture(t); const p = providerProbe();
  await f.run({ generatePlan: p.generatePlan, env: { ...ENV, IMSTAGE_AI_BASE_URL: 'https://first.invalid/v1' } });
  const report = await f.run({ generatePlan: p.generatePlan, resume: true,
    env: { ...ENV, IMSTAGE_AI_BASE_URL: 'https://second.invalid/v1' } });
  assert.equal(report.counts.resumeReused, 0);
  assert.equal(p.calls.length, 2);
});

test('native resume never reports an offline provider fixture as a real model pass', async (t) => {
  const f = await fixture(t); const p = providerProbe();
  await f.run({ generatePlan: p.generatePlan });
  // Explicitly empty credentials: a cache miss must fail before any network.
  const report = await f.run({ resume: true, env: { ...ENV, IMSTAGE_AI_API_KEY: '', DEEPSEEK_API_KEY: '' } });
  assert.equal(report.ok, false);
  assert.equal(report.counts.resumeReused, 0);
  assert.equal(report.counts.providerCalls, 0);
});

test('failed actual and expected reruns remove stale images and reject their review hashes', async (t) => {
  const f = await fixture(t); const p = providerProbe();
  await f.run({ generatePlan: p.generatePlan, writeExpected: true });
  const initial = await f.request();
  const actualHash = initial.cases[0].variants.actual.hash;
  assert.ok(initial.cases[0].variants.expected);
  await f.request('/api/dataset/C01/review', { revision: 0, kind: 'actual', hash: actualHash, verdict: 'good', note: '' });
  const fail = () => { throw Object.assign(new Error('synthetic failure'), { code: 'ai_provider_error' }); };
  assert.equal((await f.run({ generatePlan: fail })).ok, false);
  const expected = await renderExpectedDataset({ datasetDir: f.datasetDir, outDir: f.outDir, renderPlan: fail });
  assert.equal(expected.ok, false);
  const current = await f.request();
  assert.equal(current.cases[0].variants.actual, null);
  assert.equal(current.cases[0].variants.expected, null);
  await assert.rejects(f.request('/api/dataset/C01/image/actual'));
  await assert.rejects(f.request('/api/dataset/C01/review', {
    revision: 1, kind: 'actual', hash: actualHash, verdict: 'golden', note: '',
  }));
  for (const dir of ['private', 'expected']) {
    await assert.rejects(fs.stat(path.join(f.outDir, dir, 'C01.png')), { code: 'ENOENT' });
  }
});

test('dataset API hides old generation records and invalidates golden after version drift', async (t) => {
  const f = await fixture(t); const p = providerProbe();
  await f.run({ generatePlan: p.generatePlan, writeExpected: true });
  const initial = await f.request(); const hash = initial.cases[0].variants.actual.hash;
  await f.request('/api/dataset/C01/review', { revision: 0, kind: 'actual', hash, verdict: 'good', note: '' });
  await f.request('/api/dataset/C01/review', { revision: 1, kind: 'actual', hash, verdict: 'golden', note: '' });
  f.manifest.version += 1; await f.save();
  const current = await f.request();
  assert.equal(current.cases[0].variants.actual, null);
  assert.equal(current.cases[0].variants.expected, null);
  assert.notEqual(current.cases[0].run?.passed, true);
  assert.notEqual(current.report?.ok, true);
  await assert.rejects(f.request('/api/dataset/C01/image/actual'));
  await assert.rejects(f.request('/api/dataset/C01/review', { revision: 2, kind: 'actual', hash, verdict: 'golden', note: '' }));
});

test('failed inline expected rendering also removes the previous expected image', async (t) => {
  const f = await fixture(t); const p = providerProbe();
  await f.run({ generatePlan: p.generatePlan, writeExpected: true });
  const initial = await f.request();
  const hash = initial.cases[0].variants.expected.hash;
  await f.request('/api/dataset/C01/review', { revision: 0, kind: 'expected', hash, verdict: 'good', note: '' });
  const report = await f.run({ generatePlan: p.generatePlan, writeExpected: true,
    renderPlan: () => { throw Object.assign(new Error('synthetic render failure'), { code: 'render_failed' }); },
  });
  assert.equal(report.ok, false);
  assert.equal(p.calls.length, 1, 'expected rendering failed before a second provider call');
  const current = await f.request();
  assert.equal(current.cases[0].variants.expected, null);
  await assert.rejects(f.request('/api/dataset/C01/review', { revision: 1, kind: 'expected', hash, verdict: 'golden', note: '' }));
});

for (const kind of ['actual', 'expected']) {
  test(`dataset API rejects a replaced ${kind} PNG instead of minting a fresh review hash`, async (t) => {
    const f = await fixture(t); const p = providerProbe();
    await f.run({ generatePlan: p.generatePlan, writeExpected: true });
    const initial = await f.request(); const hash = initial.cases[0].variants[kind].hash;
    await f.request('/api/dataset/C01/review', { revision: 0, kind, hash, verdict: 'good', note: '' });
    await fs.writeFile(path.join(f.outDir, kind === 'actual' ? 'private' : 'expected', 'C01.png'), f.png);
    const current = await f.request();
    assert.equal(current.cases[0].variants[kind], null);
    await assert.rejects(f.request(`/api/dataset/C01/image/${kind}`));
    await assert.rejects(f.request('/api/dataset/C01/review', { revision: 1, kind, hash, verdict: 'golden', note: '' }));
  });
}

for (const kind of ['source', 'asset']) {
  test(`a header-only ${kind} PNG with a matching hash fails before the provider`, async (t) => {
    const f = await fixture(t, { asset: true }); const p = providerProbe();
    const header = f.png.subarray(0, 33);
    const ref = kind === 'source' ? f.manifest.cases[0].source : f.manifest.assets[0];
    await fs.writeFile(path.join(f.datasetDir, ref.file), header);
    ref.sha256 = sha256Hex(header); await f.save();
    await assert.rejects(readDataset(f.datasetDir));
    await assert.rejects(f.run({ generatePlan: p.generatePlan }));
    assert.equal(p.calls.length, 0);
  });
}

test('dataset-level failure replaces both JSON and Markdown PASS reports', async (t) => {
  const f = await fixture(t); const p = providerProbe();
  await f.run({ generatePlan: p.generatePlan });
  const report = await writeFailureReport({ outDir: f.outDir, errorCode: 'malformed_json' });
  assert.equal(report.ok, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.outDir, 'report.json'), 'utf8')).ok, false);
  const markdown = await fs.readFile(path.join(f.outDir, 'report.md'), 'utf8');
  assert.match(markdown, /FAIL/);
  assert.doesNotMatch(markdown, /PASS/);
});

for (const command of ['validate', 'pack', 'render-expected', 'run']) {
  test(`CLI ${command} never prints malformed manifest text to public logs`, async (t) => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.datasetDir, 'manifest.json'), PRIVATE_MARKER);
    const result = spawnSync(process.execPath, [path.join(PACKAGE_DIR, 'benchmark.mjs'), command,
      '--dataset', f.datasetDir, '--out', f.outDir, '--bundle', path.join(f.root, 'bundle.enc')], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, IMSTAGE_AI_API_KEY: '', DEEPSEEK_API_KEY: '', IMSTAGE_EVAL_DATASET_KEY: '11'.repeat(32) },
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.equal(output.includes(PRIVATE_MARKER), false);
    assert.equal(output.includes('SYNTHETIC'), false, 'JSON parser snippets must also stay private');
    if (command === 'run') {
      assert.equal(JSON.parse(await fs.readFile(path.join(f.outDir, 'report.json'), 'utf8')).ok, false);
      assert.match(await fs.readFile(path.join(f.outDir, 'report.md'), 'utf8'), /FAIL/);
    }
  });
}

for (const analysis of [{ note: 'synthetic note' }, { observed: {}, unchanged: 'synthetic text', risks: 1 }]) {
test(`dataset UI renders schema-valid analysis ${JSON.stringify(analysis)}`, async (t) => {
  const f = await fixture(t, { analysis });
  const data = await f.request();
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: false, textContent: '', disabled: false,
      setAttribute() {}, removeAttribute() {}, replaceChildren() {}, append() {}, showModal() {}, close() {},
    });
    return elements.get(id);
  };
  const sandbox = {
    document: { getElementById: element, createElement: () => element(Symbol()),
      querySelector: element, querySelectorAll: () => [] },
    location: { hash: '#C01' }, history: { replaceState() {} }, window: { addEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => data }),
  };
  const script = await fs.readFile(path.join(PACKAGE_DIR, 'public', 'dataset.js'), 'utf8');
  vm.runInNewContext(`${script}\nglobalThis.reviewTestSettled = load();`, sandbox);
  await sandbox.reviewTestSettled;
  assert.equal(element('dataset-error').hidden, true, element('dataset-error').textContent);
  assert.equal(element('content').hidden, false);
});
}


test('dataset hides reports produced by a different runtime', async (t) => {
  const f = await fixture(t);
  await f.run({ generatePlan: providerProbe().generatePlan });
  assert.ok((await f.request()).report);
  const file = path.join(f.outDir, 'report.json');
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  report.runtimeVersion = 'obsolete-runtime';
  await fs.writeFile(file, JSON.stringify(report));
  assert.equal((await f.request()).report, null);
});

test('failed run partial PNG is visible but cannot receive a quality approval', async (t) => {
  const f = await fixture(t);
  await f.run({ generatePlan: providerProbe().generatePlan });
  const file = path.join(f.outDir, 'private', 'C01.json');
  const record = JSON.parse(await fs.readFile(file, 'utf8'));
  record.status = 'error'; record.partial = true; record.partialRender = true;
  record.partialPngSha256 = record.pngSha256;
  delete record.pngSha256;
  await fs.writeFile(file, JSON.stringify(record));
  const actual = (await f.request()).cases[0].variants.actual;
  assert.equal(actual.partial, true);
  assert.equal(actual.review, null);
  await assert.rejects(f.request('/api/dataset/C01/review', {
    kind: 'actual', verdict: 'good', note: '', revision: 0, hash: actual.hash,
  }), error => error.code === 'partial_output');
  record.partialPngSha256 = 'wrong-hash';
  await fs.writeFile(file, JSON.stringify(record));
  assert.equal((await f.request()).cases[0].variants.actual, null);
});

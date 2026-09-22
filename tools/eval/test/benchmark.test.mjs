// Tests for the screenshot-edit benchmark subsystem.
//
// Everything here is synthetic and offline:
// - fixtures are generated PNGs under IMSTAGE_EVAL_TEST_DIR;
// - provider calls are injected seams, never the real DeepSeek endpoint;
// - rendering uses an injected seam for flow tests, and the real Chromium
//   renderer only when a local executable is actually available (otherwise the
//   browser tests are skipped so CI without a browser stays green).
//
// The suite verifies: schema/path/symlink safety, hash-before-provider,
// expected-data exclusion from model requests, renderer escaping/geometry/text
// fit, scorer independence and required failures, resume drift rejection,
// report sanitization and crypto pack/unpack fail-closed behavior.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PACKAGE_DIR, sha256Hex, canonicalJson } from '../src/util.mjs';
import { encodePng, decodePng } from '../src/png.mjs';
import {
  boxToPixels,
  planFromExpected,
  planFromModel,
  validateEdit,
  validatePlan,
} from '../src/benchmark/plan.mjs';
import {
  MANIFEST_FILE_NAMES,
  readDataset,
  validateManifest,
} from '../src/benchmark/dataset.mjs';
import { buildEditPlanHtml, renderEditPlan, FONT_STACK } from '../src/benchmark/render.mjs';
import { scorePlan } from '../src/benchmark/score.mjs';
import { packDataset, unpackDataset, resolveDatasetKey, sealArchive, openArchive } from '../src/benchmark/crypto.mjs';
import { buildProviderRequestBody, renderExpectedDataset, runDataset, safeErrorCode } from '../src/benchmark/run.mjs';

const TEST_ROOT = process.env.IMSTAGE_EVAL_TEST_DIR
  ? path.resolve(process.env.IMSTAGE_EVAL_TEST_DIR)
  : '/private/tmp/ai-test-imstage-screenshot-dataset.p75qqS';
const BENCHMARK_CLI = path.join(PACKAGE_DIR, 'benchmark.mjs');

let seq = 0;
function tempDir(label) {
  seq += 1;
  const dir = path.join(TEST_ROOT, `${label}-${process.pid}-${Date.now()}-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function cleanup(dir) {
  if (dir && path.resolve(dir).startsWith(path.resolve(TEST_ROOT))) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Synthetic image + dataset helpers.
// ---------------------------------------------------------------------------

function makePng(width, height, painter) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = painter(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return encodePng({ width, height, data });
}

function gradientPng(width, height) {
  return makePng(width, height, (x, y) => [(x * 7 + y) % 256, (y * 5) % 256, (x * 3) % 256, 255]);
}

function solidPng(width, height, color) {
  return makePng(width, height, () => color);
}

const SECRET_ANSWER = 'EXPECTED-ANSWER-SECRET-9f3a';
const SECRET_EDIT_TEXT = 'SECRET-EDIT-TEXT-71bc';

function baseExpected() {
  return {
    answer: SECRET_ANSWER,
    edits: [
      {
        id: 'e1',
        kind: 'text',
        box: [100, 100, 800, 200],
        text: SECRET_EDIT_TEXT,
        background: '#FFFFFF',
        color: '#111111',
        fontSize: 40,
        fontWeight: 600,
        align: 'left',
      },
      {
        id: 'e2',
        kind: 'image',
        box: [100, 400, 500, 300],
        assetId: 'a1',
        background: '#000000',
        fit: 'cover',
        radius: 12,
      },
    ],
    preserveRegions: [[0, 0, 1000, 60]],
    minScore: 0.8,
  };
}

/**
 * Write a small valid dataset. Returns { dir, manifest, sourceBuffers, assetBuffer }.
 */
function writeFixture(dir, { cases = 2, asset = true, mutateManifest } = {}) {
  const assetBuffer = solidPng(32, 32, [10, 200, 30, 255]);
  const files = {};
  const manifestAssets = [];
  if (asset) {
    files['assets/a1.png'] = assetBuffer;
    manifestAssets.push({
      id: 'a1',
      file: 'assets/a1.png',
      mime: 'image/png',
      width: 32,
      height: 32,
      sha256: sha256Hex(assetBuffer),
      description: 'synthetic badge',
      provenance: 'deterministic-map',
    });
  }
  const manifestCases = [];
  const sourceBuffers = new Map();
  for (let i = 0; i < cases; i += 1) {
    const id = `C${String(i + 1).padStart(2, '0')}`;
    const width = 200;
    const height = 400;
    const buffer = gradientPng(width, height);
    const rel = `cases/${id}.png`;
    files[rel] = buffer;
    sourceBuffers.set(id, buffer);
    const expected = baseExpected();
    if (!asset) {
      expected.edits = expected.edits.filter((edit) => edit.kind !== 'image');
    }
    manifestCases.push({
      id,
      title: `合成用例 ${id}`,
      difficulty: ((i % 5) + 1),
      im: i % 2 === 0 ? 'wechat' : 'instagram',
      surface: i % 2 === 0 ? 'ios' : 'desktop',
      source: { file: rel, mime: 'image/png', width, height, sha256: sha256Hex(buffer) },
      task: `把某个标签改成 LOADING-${id} https://example.invalid/x`,
      analysis: { note: 'synthetic-analysis-marker-42', expectedEdits: 2 },
      assetIds: asset ? ['a1'] : [],
      expected,
      referenceStatus: 'proposed',
    });
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'imstage-screenshot-edit-dataset',
    id: 'chat-screenshot-edits-v1',
    version: 1,
    private: true,
    assets: manifestAssets,
    cases: manifestCases,
  };
  if (typeof mutateManifest === 'function') mutateManifest(manifest);
  for (const [rel, buffer] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { dir, manifest, sourceBuffers, assetBuffer };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function throwsCode(fn, code) {
  const codes = Array.isArray(code) ? code : [code];
  assert.throws(fn, (err) => {
    assert.ok(
      codes.includes(err.code),
      `expected error code ${codes.join('|')}, got ${err.code}: ${err.message}`,
    );
    return true;
  });
}

// A renderer seam: copies the source pixels, paints each plan edit's box, and
// reports text fit. Preservation therefore passes when edits stay inside the
// expected boxes.
function fakeRenderer({ sourceBuffer, width, height, plan }) {
  const decoded = decodePng(sourceBuffer);
  const data = Buffer.from(decoded.data);
  for (const edit of plan.edits) {
    const rect = boxToPixels(edit.box, width, height);
    const [r, g, b] = edit.kind === 'text' ? [255, 255, 255] : [0, 0, 0];
    for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(height, Math.ceil(rect.y + rect.height)); y += 1) {
      for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(width, Math.ceil(rect.x + rect.width)); x += 1) {
        const i = (y * width + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
  }
  return {
    buffer: encodePng({ width, height, data }),
    width,
    height,
    textFits: plan.edits
      .filter((edit) => edit.kind === 'text')
      .map((edit) => ({ id: edit.id, fits: true, fontSize: edit.fontSize, overflowPx: 0 })),
    patches: plan.edits.map((edit) => ({ id: edit.id, kind: edit.kind, ...boxToPixels(edit.box, width, height) })),
    warnings: [],
  };
}

// Provider seam that answers with the curated expected plan (worst-case
// "oracle" used only to exercise the pipeline end-to-end offline).
function expectedPlanProvider({ request, caseData: _caseData }) {
  return {
    rawContent: JSON.stringify(expectedPlanForRequest(request)),
    model: 'seam-model',
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

// The seam only sees `request`; reconstruct the plan from the request's case id.
function expectedPlanForRequest(request) {
  const caseId = request.caseId;
  const fixtureCase = PLAN_SOURCE.get(caseId);
  return {
    schemaVersion: 1,
    im: fixtureCase.im,
    surface: fixtureCase.surface,
    width: fixtureCase.source.width,
    height: fixtureCase.source.height,
    edits: deepClone(fixtureCase.expected.edits),
    warnings: [],
  };
}

const PLAN_SOURCE = new Map();

function providerFromManifest(manifest) {
  PLAN_SOURCE.clear();
  for (const caseData of manifest.cases) PLAN_SOURCE.set(caseData.id, caseData);
  return expectedPlanProvider;
}

// ---------------------------------------------------------------------------
// Browser availability (real renderer tests only).
// ---------------------------------------------------------------------------

async function detectBrowser() {
  try {
    const { chromium } = await import('playwright');
    const { resolveChromiumExecutable } = await import('../src/render.mjs');
    const executablePath = resolveChromiumExecutable();
    const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), timeout: 15_000 });
    await browser.close();
    return executablePath ?? null;
  } catch {
    return null;
  }
}
const BROWSER = await detectBrowser();
const browserSkip = BROWSER === null ? { skip: 'no local Chromium/Chrome available' } : {};

// ---------------------------------------------------------------------------
// Schema + dataset loading.
// ---------------------------------------------------------------------------

test('validateManifest accepts a well-formed synthetic manifest', () => {
  const dir = tempDir('manifest-ok');
  try {
    const { manifest } = writeFixture(dir);
    const normalized = validateManifest(manifest);
    assert.equal(normalized.cases.length, 2);
    assert.equal(normalized.assets.length, 1);
    assert.equal(normalized.cases[0].referenceStatus, 'proposed');
  } finally {
    cleanup(dir);
  }
});

test('validateManifest enforces bounds, ids and provenance', () => {
  const dir = tempDir('manifest-bad');
  try {
    const { manifest } = writeFixture(dir);
    const clone = deepClone(manifest);

    const dup = deepClone(manifest);
    dup.cases[1].id = dup.cases[0].id;
    throwsCode(() => validateManifest(dup), 'duplicate_id');

    const empty = deepClone(manifest);
    empty.cases = [];
    throwsCode(() => validateManifest(empty), 'empty_dataset');

    const notPrivate = deepClone(manifest);
    notPrivate.private = false;
    throwsCode(() => validateManifest(notPrivate), 'dataset_not_private');

    const badProvenance = deepClone(manifest);
    badProvenance.assets[0].provenance = 'unknown';
    throwsCode(() => validateManifest(badProvenance), 'invalid_enum');

    const badBox = deepClone(manifest);
    badBox.cases[0].expected.edits[0].box = [900, 100, 400, 200];
    throwsCode(() => validateManifest(badBox), 'invalid_box');

    const badAssetRef = deepClone(manifest);
    badAssetRef.cases[0].expected.edits[1].assetId = 'not-authorised';
    throwsCode(() => validateManifest(badAssetRef), ['unauthorized_asset', 'invalid_asset']);

    const tooManyCases = deepClone(manifest);
    tooManyCases.cases = Array.from({ length: 51 }, (_, i) => ({ ...deepClone(manifest.cases[0]), id: `X${i}` }));
    throwsCode(() => validateManifest(tooManyCases), 'too_many_cases');

    const tooManyEdits = deepClone(manifest);
    tooManyEdits.cases[0].expected.edits = Array.from({ length: 129 }, (_, i) => ({
      ...deepClone(manifest.cases[0].expected.edits[0]),
      id: `E${i}`,
    }));
    throwsCode(() => validateManifest(tooManyEdits), 'too_many_edits');

    const approved = deepClone(manifest);
    approved.cases[0].referenceStatus = 'approved';
    throwsCode(() => validateManifest(approved), 'invalid_reference_status');
  } finally {
    cleanup(dir);
  }
});

test('readDataset verifies every file hash and dimension before anything else', async () => {
  const dir = tempDir('read-ok');
  try {
    const { manifest } = writeFixture(dir);
    const resolved = await readDataset(dir);
    assert.equal(resolved.manifest.id, 'chat-screenshot-edits-v1');
    assert.equal(resolved.cases.length, 2);
    assert.equal(resolved.assets.size, 1);
    assert.ok(resolved.datasetInputHash.length === 64);
    assert.equal(resolved.manifestName, MANIFEST_FILE_NAMES[0]);
    assert.equal(resolved.referencedFiles.length, 1 + manifest.assets.length + manifest.cases.length);
  } finally {
    cleanup(dir);
  }
});

test('readDataset rejects tampered source content (hash mismatch)', async () => {
  const dir = tempDir('read-tamper');
  try {
    writeFixture(dir);
    const sourcePath = path.join(dir, 'cases', 'C01.png');
    const tampered = gradientPng(200, 400);
    tampered[tampered.length - 1] ^= 0xff;
    fs.writeFileSync(sourcePath, tampered);
    await assert.rejects(() => readDataset(dir), (err) => err.code === 'source_hash_mismatch');
  } finally {
    cleanup(dir);
  }
});

test('readDataset rejects traversal, absolute paths and symlinked files', async () => {
  const dir = tempDir('read-paths');
  try {
    const { manifest } = writeFixture(dir);
    const traversal = deepClone(manifest);
    traversal.cases[0].source.file = '../outside.png';
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(traversal));
    await assert.rejects(() => readDataset(dir), (err) => err.code === 'unsafe_path');

    const absolute = deepClone(manifest);
    absolute.cases[0].source.file = path.join(dir, 'cases', 'C01.png');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(absolute));
    await assert.rejects(() => readDataset(dir), (err) => err.code === 'unsafe_path');

    // Symlink: valid hash/dimensions but the manifest path is a symlink.
    const symlinkDir = tempDir('read-symlink');
    try {
      writeFixture(symlinkDir);
      const linkPath = path.join(symlinkDir, 'cases', 'link.png');
      fs.symlinkSync(path.join(symlinkDir, 'cases', 'C01.png'), linkPath);
      const symlinkManifest = JSON.parse(fs.readFileSync(path.join(symlinkDir, 'manifest.json'), 'utf8'));
      symlinkManifest.cases[0].source.file = 'cases/link.png';
      fs.writeFileSync(path.join(symlinkDir, 'manifest.json'), JSON.stringify(symlinkManifest));
      await assert.rejects(() => readDataset(symlinkDir), (err) => err.code === 'unsafe_path');
    } finally {
      cleanup(symlinkDir);
    }
  } finally {
    cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Plan validation + escaping.
// ---------------------------------------------------------------------------

test('model plan rejects dangerous/unknown fields and strips inert ones', () => {
  const good = {
    schemaVersion: 1,
    im: 'wechat',
    surface: 'ios',
    width: 200,
    height: 400,
    edits: [
      {
        id: 'e1',
        kind: 'text',
        box: [10, 10, 100, 100],
        text: 'hi',
        background: '#ffffff',
        color: '#111111',
        reason: 'why not',
        textVariants: ['hey'],
        minIoU: 0.1,
      },
    ],
    warnings: [],
    reasoning: 'some chain of thought',
  };
  const { plan, warnings } = planFromModel(good, { authorizedAssetIds: ['a1'] });
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].textVariants, undefined);
  assert.equal(plan.edits[0].minIoU, undefined);
  assert.equal(plan.edits[0].background, '#FFFFFF');
  assert.ok(warnings.some((w) => w.includes('stripped_scoring_field')));
  assert.ok(warnings.some((w) => w.includes('stripped_field:reasoning')));

  for (const key of ['imageUrl', 'src', 'path', 'html', 'script', 'file', 'style']) {
    const bad = deepClone(good);
    bad.edits[0][key] = 'http://evil.example/x.png';
    throwsCode(() => planFromModel(bad, { authorizedAssetIds: ['a1'] }), 'unknown_field');
  }

  const noSchema = deepClone(good);
  delete noSchema.schemaVersion;
  throwsCode(() => planFromModel(noSchema), 'invalid_plan');
});

test('plan validation rejects out-of-frame boxes, bad colors, unauthorized assets and duplicate ids', () => {
  const edit = (overrides) => ({
    id: 'e1',
    kind: 'text',
    box: [10, 10, 100, 100],
    text: 'x',
    background: '#FFFFFF',
    color: '#000000',
    ...overrides,
  });
  throwsCode(() => validateEdit(edit({ box: [-1, 0, 100, 100] })), 'invalid_box');
  throwsCode(() => validateEdit(edit({ box: [0, 0, 0, 100] })), 'invalid_box');
  throwsCode(() => validateEdit(edit({ box: [900, 0, 200, 100] })), 'invalid_box');
  throwsCode(() => validateEdit(edit({ background: 'red' })), 'invalid_color');
  throwsCode(() => validateEdit(edit({ fontSize: 9 })), 'out_of_range');
  throwsCode(() => validateEdit(edit({ fontSize: 400 })), 'out_of_range');
  throwsCode(() => validateEdit(edit({ kind: 'image', text: 'no' })), 'invalid_edit');
  const imageEdit = {
    id: 'e1',
    kind: 'image',
    box: [0, 0, 10, 10],
    assetId: 'zzz',
    background: '#FFFFFF',
    color: '#000000',
  };
  throwsCode(() => validateEdit(imageEdit, { authorizedAssetIds: ['a1'] }), 'unauthorized_asset');
  throwsCode(
    () =>
      validatePlan(
        {
          schemaVersion: 1,
          im: 'wechat',
          surface: 'ios',
          width: 200,
          height: 400,
          edits: [edit({}), edit({})],
          warnings: [],
        },
        { mode: 'model' },
      ),
    'duplicate_id',
  );
});

test('buildEditPlanHtml escapes text/HTML and emits exact patch geometry', () => {
  const plan = validatePlan(
    {
      schemaVersion: 1,
      im: 'wechat',
      surface: 'ios',
      width: 200,
      height: 400,
      edits: [
        {
          id: 't1',
          kind: 'text',
          box: [100, 100, 800, 200], // -> x=20,y=40,w=160,h=80
          text: '<script>alert(1)</script>\nline2 & "quoted"',
          background: '#FFFFFF',
          color: '#111111',
          fontSize: 20,
        },
      ],
      warnings: [],
    },
    { mode: 'render' },
  ).plan;
  const html = buildEditPlanHtml(plan, {
    width: 200,
    height: 400,
    sourceDataUri: 'data:image/png;base64,AAAA',
    assetDataUris: new Map(),
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('left:20px'));
  assert.ok(html.includes('top:40px'));
  assert.ok(html.includes('width:160px'));
  assert.ok(html.includes('height:80px'));
  assert.ok(!/https?:\/\//.test(html));
  const rect = boxToPixels([100, 100, 800, 200], 200, 400);
  assert.deepEqual(rect, { x: 20, y: 40, width: 160, height: 80 });

  // The font stack must survive inside a double-quoted style attribute.
  assert.ok(!FONT_STACK.includes('"'));
  assert.ok(FONT_STACK.includes("'Noto Sans CJK SC'"));
  assert.ok(FONT_STACK.includes("'Noto Sans Cyrillic'"));
  assert.ok(html.includes("font-family:-apple-system"));
});

// ---------------------------------------------------------------------------
// Renderer (browser-gated).
// ---------------------------------------------------------------------------

test('renderEditPlan keeps exact source dimensions and reports text fit', browserSkip, async () => {
  const dir = tempDir('render-fit');
  try {
    const width = 220;
    const height = 420;
    const source = gradientPng(width, height);
    const asset = solidPng(24, 24, [200, 40, 40, 255]);
    const plan = {
      schemaVersion: 1,
      im: 'wechat',
      surface: 'ios',
      width,
      height,
      warnings: [],
      edits: [
        {
          id: 'fit',
          kind: 'text',
          box: [50, 100, 900, 100],
          text: '短文本',
          background: '#FFFFFF',
          color: '#000000',
          fontSize: 40,
          align: 'center',
        },
        {
          id: 'overflow',
          kind: 'text',
          box: [50, 400, 300, 60],
          text: '这是一段非常非常非常长的文字用来制造溢出'.repeat(3),
          background: '#FFEEDD',
          color: '#000000',
          fontSize: 60,
        },
        {
          id: 'frame',
          kind: 'image',
          box: [500, 100, 400, 300],
          assetId: 'a1',
          background: '#000000',
          fit: 'cover',
          radius: 20,
        },
      ],
    };
    const out = await renderEditPlan({
      sourceBuffer: source,
      sourceMime: 'image/png',
      width,
      height,
      plan,
      assets: [{ id: 'a1', mime: 'image/png', buffer: asset }],
      executablePath: BROWSER ?? undefined,
    });
    assert.equal(out.width, width);
    assert.equal(out.height, height);
    const decoded = decodePng(out.buffer);
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    const overflow = out.textFits.find((entry) => entry.id === 'overflow');
    assert.equal(overflow.fits, false);
    assert.ok(overflow.overflowPx > 0);
    assert.ok(overflow.fontSize >= 12);
    const fit = out.textFits.find((entry) => entry.id === 'fit');
    assert.equal(fit.fits, true);
    const frame = out.patches.find((entry) => entry.id === 'frame');
    assert.ok(Math.abs(frame.x - 110) < 0.01);
    assert.ok(Math.abs(frame.width - 88) < 0.01);
    assert.ok(Math.abs(frame.height - 126) < 0.01);

    // Outside every patch the original pixels must survive byte-for-byte.
    const sourceDecoded = decodePng(source);
    const corner = (5 * width + 5) * 4;
    assert.deepEqual(
      Array.from(decoded.data.subarray(corner, corner + 4)),
      Array.from(sourceDecoded.data.subarray(corner, corner + 4)),
    );
  } finally {
    cleanup(dir);
  }
});

test('renderEditPlan rejects empty source, dimension mismatch and unauthorized assets', browserSkip, async () => {
  const source = gradientPng(120, 200);
  await assert.rejects(
    () => renderEditPlan({ sourceBuffer: Buffer.alloc(0), sourceMime: 'image/png', width: 120, height: 200, plan: emptyPlan(120, 200), assets: [] }),
    (err) => err.code === 'empty_source',
  );
  await assert.rejects(
    () => renderEditPlan({ sourceBuffer: source, sourceMime: 'image/png', width: 121, height: 200, plan: emptyPlan(121, 200), assets: [], executablePath: BROWSER ?? undefined }),
    (err) => err.code === 'dimension_mismatch',
  );
  const plan = {
    schemaVersion: 1,
    im: 'wechat',
    surface: 'ios',
    width: 120,
    height: 200,
    warnings: [],
    edits: [{ id: 'i1', kind: 'image', box: [0, 0, 100, 100], assetId: 'a1', background: '#000000', fit: 'cover' }],
  };
  await assert.rejects(
    () => renderEditPlan({ sourceBuffer: source, sourceMime: 'image/png', width: 120, height: 200, plan, assets: [], executablePath: BROWSER ?? undefined }),
    (err) => err.code === 'unauthorized_asset' || err.code === 'invalid_asset',
  );
});

function emptyPlan(width, height) {
  return { schemaVersion: 1, im: 'wechat', surface: 'ios', width, height, edits: [], warnings: [] };
}

// ---------------------------------------------------------------------------
// Scorer.
// ---------------------------------------------------------------------------

function caseDataForScoring({ asset = true } = {}) {
  const width = 200;
  const height = 400;
  const expected = baseExpected();
  if (!asset) expected.edits = expected.edits.filter((edit) => edit.kind !== 'image');
  return {
    id: 'C01',
    title: 't',
    difficulty: 2,
    im: 'wechat',
    surface: 'ios',
    source: { file: 'x.png', mime: 'image/png', width, height, sha256: 'a'.repeat(64) },
    task: 'task',
    analysis: {},
    assetIds: asset ? ['a1'] : [],
    expected,
    referenceStatus: 'proposed',
  };
}

function planFor(caseData, mutate) {
  const plan = JSON.parse(JSON.stringify(planFromExpected(caseData)));
  if (mutate) mutate(plan);
  return plan;
}

test('scorePlan passes an identical plan and never mutates inputs', () => {
  const caseData = caseDataForScoring();
  const before = canonicalJson(caseData);
  const plan = planFor(caseData);
  const planBefore = canonicalJson(plan);
  const result = scorePlan(caseData, plan);
  assert.equal(result.passed, true);
  assert.equal(result.humanReviewRequired, true);
  assert.ok(result.score >= 0.8);
  assert.equal(result.counts.missing, 0);
  assert.equal(result.counts.extra, 0);
  assert.equal(canonicalJson(caseData), before, 'case data must not be mutated');
  assert.equal(canonicalJson(plan), planBefore, 'actual plan must not be mutated');
  assert.equal(result.checks.find((c) => c.id === 'preservation').passed, null);
});

test('scorePlan fails manipulated boxes, text, assets and extra/empty edits', () => {
  const caseData = caseDataForScoring();

  const badBox = planFor(caseData, (plan) => {
    plan.edits[0].box = [50, 700, 100, 80];
  });
  const badBoxResult = scorePlan(caseData, badBox);
  assert.equal(badBoxResult.passed, false);
  assert.ok(
    badBoxResult.checks.some((c) => c.reasonCode === 'box_iou_below_min' || c.reasonCode === 'missing_and_extra_edits'),
  );

  const badText = planFor(caseData, (plan) => {
    plan.edits[0].text = 'totally different';
  });
  const badTextResult = scorePlan(caseData, badText);
  assert.equal(badTextResult.passed, false);
  assert.equal(badTextResult.counts.missing >= 1, true);

  const badAsset = planFor(caseData, (plan) => {
    const image = plan.edits.find((edit) => edit.kind === 'image');
    image.assetId = 'evil';
  });
  const badAssetResult = scorePlan(caseData, badAsset);
  assert.equal(badAssetResult.passed, false);
  assert.equal(badAssetResult.checks[0].id, 'plan_valid');
  assert.equal(badAssetResult.checks[0].reasonCode, 'invalid_plan');

  const extra = planFor(caseData);
  extra.edits.push({ ...extra.edits[0], id: 'extra1' });
  const extraResult = scorePlan(caseData, extra);
  assert.equal(extraResult.passed, false);
  assert.equal(extraResult.counts.extra, 1);

  const empty = planFor(caseData, (plan) => {
    plan.edits = [];
  });
  const emptyResult = scorePlan(caseData, empty);
  assert.equal(emptyResult.passed, false);
  assert.ok(emptyResult.checks.some((c) => c.reasonCode === 'empty_edits'));

  const noEdits = { schemaVersion: 1, im: 'wechat', surface: 'ios', width: 200, height: 400, edits: [], warnings: [] };
  assert.equal(scorePlan(caseData, noEdits).passed, false);
});

test('scorePlan enforces dimensions, platform and device', () => {
  const caseData = caseDataForScoring();
  const wrongSize = planFor(caseData, (plan) => {
    plan.width = 201;
  });
  assert.equal(scorePlan(caseData, wrongSize).passed, false);
  assert.ok(scorePlan(caseData, wrongSize).checks.some((c) => c.reasonCode === 'dimension_mismatch'));

  const wrongPlatform = planFor(caseData, (plan) => {
    plan.im = 'whatsapp';
  });
  assert.equal(scorePlan(caseData, wrongPlatform).passed, false);
  assert.ok(scorePlan(caseData, wrongPlatform).checks.some((c) => c.reasonCode === 'platform_mismatch'));

  const wrongSurface = planFor(caseData, (plan) => {
    plan.surface = 'desktop';
  });
  assert.equal(scorePlan(caseData, wrongSurface).passed, false);
  assert.ok(scorePlan(caseData, wrongSurface).checks.some((c) => c.reasonCode === 'surface_mismatch'));
});

test('scorePlan enforces the 2-source-pixel image frame tolerance', () => {
  const caseData = caseDataForScoring();
  const shifted = planFor(caseData, (plan) => {
    const image = plan.edits.find((edit) => edit.kind === 'image');
    image.box = [image.box[0] + 20, image.box[1], image.box[2], image.box[3]]; // +4 source px
  });
  const result = scorePlan(caseData, shifted);
  assert.equal(result.passed, false);
  const imageGeometryFailure = result.checks.some(
    (entry) =>
      entry.reasonCode === 'image_frame_geometry' ||
      (entry.details?.missingDetail ?? []).some((detail) => detail.reasonCode === 'image_frame_geometry'),
  );
  assert.ok(imageGeometryFailure, JSON.stringify(result.checks));

  const withinTolerance = planFor(caseData, (plan) => {
    const image = plan.edits.find((edit) => edit.kind === 'image');
    image.box = [image.box[0] + 5, image.box[1], image.box[2], image.box[3]]; // 1 source px
  });
  assert.equal(scorePlan(caseData, withinTolerance, { renderInfo: { textFits: [] } }).passed, true);
});

test('scorePlan pixel preservation is strict outside expected boxes and fails text overflow', () => {
  const caseData = caseDataForScoring();
  const width = caseData.source.width;
  const height = caseData.source.height;
  const source = gradientPng(width, height);

  // Edit exactly the expected box -> preservation passes.
  const planned = planFor(caseData);
  const edited = fakeRenderer({ sourceBuffer: source, width, height, plan: planned }).buffer;
  const ok = scorePlan(caseData, planned, {
    sourcePng: source,
    actualPng: edited,
    renderInfo: { textFits: [{ id: 'e1', fits: true, overflowPx: 0 }] },
  });
  assert.equal(ok.passed, true, JSON.stringify(ok.checks));
  assert.equal(ok.checks.find((c) => c.id === 'preservation').passed, true);

  // Change a block of pixels outside the expected boxes/preserve regions -> preservation fails.
  const damaged = Buffer.from(decodePng(source).data);
  for (let y = 360; y < 400; y += 1) {
    for (let x = 180; x < 200; x += 1) {
      const i = (y * width + x) * 4;
      damaged[i] = 0;
      damaged[i + 1] = 0;
      damaged[i + 2] = 0;
    }
  }
  const outside = scorePlan(caseData, planned, {
    sourcePng: source,
    actualPng: encodePng({ width, height, data: damaged }),
  });
  assert.equal(outside.passed, false);
  assert.equal(outside.checks.find((c) => c.id === 'preservation').passed, false);
  assert.equal(outside.checks.find((c) => c.id === 'preservation').reasonCode, 'outside_edit_regions_changed');

  // Change a pixel in a curated preserveRegion (top 60/1000 -> top 24px) -> fails.
  const preserved = Buffer.from(decodePng(source).data);
  const regionPx = (5 * width + 5) * 4;
  preserved[regionPx] = preserved[regionPx] ^ 0xff;
  const region = scorePlan(caseData, planned, {
    sourcePng: source,
    actualPng: encodePng({ width, height, data: preserved }),
  });
  assert.equal(region.passed, false);
  assert.equal(region.checks.find((c) => c.id === 'preservation').reasonCode, 'preserve_region_changed');

  // Text overflow reported by the renderer is a required failure.
  const overflow = scorePlan(caseData, planned, {
    sourcePng: source,
    actualPng: edited,
    renderInfo: { textFits: [{ id: 'e1', fits: false, overflowPx: 9 }] },
  });
  assert.equal(overflow.passed, false);
  assert.ok(overflow.checks.some((c) => c.id === 'text_fit' && c.reasonCode === 'text_overflow'));
});

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

test('runDataset (offline seams) writes sanitized report and private artifacts', async () => {
  const dir = tempDir('run-src');
  const out = tempDir('run-out');
  try {
    const { manifest } = writeFixture(dir, { cases: 2 });
    const provider = providerFromManifest(manifest);
    const captured = [];
    const seen = [];
    const generatePlan = (args) => {
      captured.push(JSON.stringify(args.request));
      return provider(args);
    };
    const report = await runDataset({
      datasetDir: dir,
      outDir: out,
      env: {},
      generatePlan,
      renderPlan: (args) => {
        seen.push(args.plan.edits.length);
        return fakeRenderer(args);
      },
    });
    assert.equal(report.ok, true, JSON.stringify(report.errorCodes));
    assert.equal(report.subset, false);
    assert.equal(report.counts.casesAttempted, 2);
    assert.equal(report.counts.casesPassed, 2);
    assert.equal(report.counts.providerCalls, 2);

    // The model request must include the task/image but never expected data.
    for (const payload of captured) {
      assert.ok(payload.includes('task'));
      assert.ok(!payload.includes(SECRET_ANSWER));
      assert.ok(!payload.includes(SECRET_EDIT_TEXT));
      assert.ok(!payload.includes('synthetic-analysis-marker-42'));
      assert.ok(!payload.includes('"expected"'));
      assert.ok(payload.includes('"dataBase64"'));
    }
    // The provider body must carry the image as a data URL block.
    const providerBody = buildProviderRequestBody({ model: 'seam-model' }, JSON.parse(captured[0]));
    const userContent = providerBody.messages[1].content;
    assert.ok(Array.isArray(userContent));
    assert.ok(userContent.some((part) => part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,')));

    const publicReport = fs.readFileSync(path.join(out, 'report.json'), 'utf8');
    assert.ok(!publicReport.includes(SECRET_ANSWER));
    assert.ok(!publicReport.includes(SECRET_EDIT_TEXT));
    assert.ok(!publicReport.includes('synthetic-analysis-marker-42'));
    assert.ok(!publicReport.includes('LOADING-C01'));
    assert.ok(!publicReport.includes('example.invalid'));
    assert.ok(!publicReport.includes('synthetic badge'));
    const publicMd = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    assert.ok(!publicMd.includes('LOADING-C01'));

    for (const caseId of ['C01', 'C02']) {
      const privatePath = path.join(out, 'private', `${caseId}.json`);
      assert.ok(fs.existsSync(privatePath));
      const privateRecord = JSON.parse(fs.readFileSync(privatePath, 'utf8'));
      assert.ok(privateRecord.rawAnswer.includes('e1'));
      assert.equal(privateRecord.expected.answer, SECRET_ANSWER);
      assert.ok(fs.existsSync(path.join(out, 'private', `${caseId}.png`)));
    }
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('runDataset marks a limited run as subset and never a full pass', async () => {
  const dir = tempDir('run-subset-src');
  const out = tempDir('run-subset-out');
  try {
    const { manifest } = writeFixture(dir, { cases: 3 });
    const report = await runDataset({
      datasetDir: dir,
      outDir: out,
      env: {},
      limit: 2,
      generatePlan: providerFromManifest(manifest),
      renderPlan: (args) => fakeRenderer(args),
    });
    assert.equal(report.subset, true);
    assert.equal(report.ok, false);
    assert.equal(report.counts.casesAttempted, 2);
    assert.equal(report.counts.casesTotal, 3);
    assert.equal(report.limit, 2);
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('runDataset continues after a failed case and reports a nonzero aggregate', async () => {
  const dir = tempDir('run-fail-src');
  const out = tempDir('run-fail-out');
  try {
    const { manifest } = writeFixture(dir, { cases: 2 });
    const provider = providerFromManifest(manifest);
    let calls = 0;
    const report = await runDataset({
      datasetDir: dir,
      outDir: out,
      env: {},
      generatePlan: (args) => {
        calls += 1;
        if (args.request.caseId === 'C01') {
          const err = new Error('provider down');
          err.code = 'ai_unreachable';
          throw err;
        }
        return provider(args);
      },
      renderPlan: (args) => fakeRenderer(args),
    });
    assert.equal(calls, 2);
    assert.equal(report.ok, false);
    assert.equal(report.counts.casesAttempted, 2);
    assert.equal(report.counts.casesPassed, 1);
    assert.equal(report.counts.casesFailed, 1);
    assert.equal(report.errorCodes.ai_unreachable, 1);
    assert.equal(report.cases.find((c) => c.caseId === 'C01').errorCode, 'ai_unreachable');
    const privateRecord = JSON.parse(fs.readFileSync(path.join(out, 'private', 'C01.json'), 'utf8'));
    assert.equal(privateRecord.errorCode, 'ai_unreachable');
    assert.ok(privateRecord.task.includes('LOADING-C01'), 'private record may keep the task');
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('runDataset without AI config fails closed before any network call', async () => {
  const dir = tempDir('run-noconfig-src');
  const out = tempDir('run-noconfig-out');
  try {
    writeFixture(dir, { cases: 1 });
    const report = await runDataset({ datasetDir: dir, outDir: out, env: {}, renderPlan: (args) => fakeRenderer(args) });
    assert.equal(report.ok, false);
    assert.equal(report.errorCodes.ai_not_configured, 1);
    assert.equal(report.counts.providerCalls, 0);
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('source hash mismatch prevents the provider from ever being called', async () => {
  const dir = tempDir('run-hash-src');
  const out = tempDir('run-hash-out');
  try {
    writeFixture(dir, { cases: 1 });
    const sourcePath = path.join(dir, 'cases', 'C01.png');
    const changed = gradientPng(200, 400);
    changed[changed.length - 1] ^= 0xff;
    fs.writeFileSync(sourcePath, changed);
    let called = false;
    await assert.rejects(
      () =>
        runDataset({
          datasetDir: dir,
          outDir: out,
          env: {},
          generatePlan: () => {
            called = true;
            return { rawContent: '{}', model: 'x' };
          },
          renderPlan: (args) => fakeRenderer(args),
        }),
      (err) => err.code === 'source_hash_mismatch',
    );
    assert.equal(called, false);
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('resume reuses only matching prior results and rejects drift', async () => {
  const dir = tempDir('run-resume-src');
  const out = tempDir('run-resume-out');
  try {
    const { manifest } = writeFixture(dir, { cases: 2 });
    const first = await runDataset({
      datasetDir: dir,
      outDir: out,
      env: {},
      generatePlan: providerFromManifest(manifest),
      renderPlan: (args) => fakeRenderer(args),
    });
    assert.equal(first.counts.providerCalls, 2);

    let secondCalls = 0;
    const second = await runDataset({
      datasetDir: dir,
      outDir: out,
      env: {},
      resume: true,
      generatePlan: () => {
        secondCalls += 1;
        throw new Error('must not be called');
      },
      renderPlan: (args) => fakeRenderer(args),
    });
    assert.equal(secondCalls, 0);
    assert.equal(second.counts.resumeReused, 2);
    assert.equal(second.ok, true);

    // Model drift invalidates the cache.
    let thirdCalls = 0;
    const provider = providerFromManifest(manifest);
    await runDataset({
      datasetDir: dir,
      outDir: out,
      env: { IMSTAGE_AI_MODEL: 'different-model', IMSTAGE_AI_API_KEY: 'test-key' },
      resume: true,
      generatePlan: (args) => {
        thirdCalls += 1;
        return provider(args);
      },
      renderPlan: (args) => fakeRenderer(args),
    });
    assert.equal(thirdCalls, 2, 'model change must invalidate resume');

    // Dataset drift (task change) invalidates the cache.
    const manifest2 = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    manifest2.cases[0].task = 'changed task';
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest2));
    let fourthCalls = 0;
    const provider4 = providerFromManifest(manifest2);
    await runDataset({
      datasetDir: dir,
      outDir: out,
      env: {},
      resume: true,
      generatePlan: (args) => {
        fourthCalls += 1;
        return provider4(args);
      },
      renderPlan: (args) => fakeRenderer(args),
    });
    assert.equal(fourthCalls, 2, 'task change must invalidate resume');
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('runDataset sanitizes provider keys out of public and private artifacts', async () => {
  const dir = tempDir('run-secret-src');
  const out = tempDir('run-secret-out');
  const secret = 'sk-test-secret-value-1234567890abcdef';
  try {
    const { manifest } = writeFixture(dir, { cases: 1 });
    await runDataset({
      datasetDir: dir,
      outDir: out,
      env: { IMSTAGE_AI_API_KEY: secret },
      generatePlan: providerFromManifest(manifest),
      renderPlan: (args) => fakeRenderer(args),
    });
    const reportText = fs.readFileSync(path.join(out, 'report.json'), 'utf8');
    assert.ok(!reportText.includes(secret), 'public report must not contain the provider key');
    for (const caseId of ['C01']) {
      const privateText = fs.readFileSync(path.join(out, 'private', `${caseId}.json`), 'utf8');
      assert.ok(!privateText.includes(secret), 'private record must not contain the provider key');
    }
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('renderExpectedDataset writes proposed references offline', async () => {
  const dir = tempDir('run-expected-src');
  const out = tempDir('run-expected-out');
  try {
    writeFixture(dir, { cases: 2 });
    const result = await renderExpectedDataset({
      datasetDir: dir,
      outDir: out,
      renderPlan: (args) => fakeRenderer(args),
    });
    assert.equal(result.ok, true);
    assert.equal(result.proposed, true);
    assert.equal(result.counts.rendered, 2);
    for (const caseId of ['C01', 'C02']) {
      const png = fs.readFileSync(path.join(out, 'expected', `${caseId}.png`));
      assert.equal(decodePng(png).width, 200);
    }
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

// ---------------------------------------------------------------------------
// Crypto.
// ---------------------------------------------------------------------------

test('packDataset/unpackDataset round-trips and never writes on wrong key', async () => {
  const dir = tempDir('crypto-src');
  const out = tempDir('crypto-out');
  const bundle = path.join(TEST_ROOT, `bundle-${process.pid}-${Date.now()}.imb`);
  const key = 'ab'.repeat(32);
  try {
    writeFixture(dir, { cases: 2 });
    const packed = await packDataset({ datasetDir: dir, outputFile: bundle, keyHex: key });
    assert.ok(packed.bytes > 0);
    assert.equal(packed.files, 1 + 1 + 2);

    const unpackedDir = path.join(out, 'restored');
    const unpacked = await unpackDataset({ inputFile: bundle, outputDir: unpackedDir, keyHex: key });
    assert.equal(unpacked.fileCount, 4);
    const restored = await readDataset(unpackedDir);
    assert.equal(restored.cases.length, 2);

    // Wrong key fails closed and leaves no output directory behind.
    const wrongDir = path.join(out, 'wrong');
    await assert.rejects(
      () => unpackDataset({ inputFile: bundle, outputDir: wrongDir, keyHex: 'cd'.repeat(32) }),
      (err) => err.code === 'dataset_decrypt_failed',
    );
    assert.equal(fs.existsSync(wrongDir), false);

    // Tampered ciphertext fails closed.
    const tampered = Buffer.from(fs.readFileSync(bundle));
    tampered[tampered.length - 1] ^= 0xff;
    const tamperPath = path.join(out, 'tampered.imb');
    fs.writeFileSync(tamperPath, tampered);
    await assert.rejects(
      () => unpackDataset({ inputFile: tamperPath, outputDir: path.join(out, 'tamper-out'), keyHex: key }),
      (err) => err.code === 'dataset_decrypt_failed',
    );

    // Non-empty output dir is refused and left untouched.
    const nonEmpty = path.join(out, 'nonempty');
    fs.mkdirSync(nonEmpty, { recursive: true });
    fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'keep');
    await assert.rejects(
      () => unpackDataset({ inputFile: bundle, outputDir: nonEmpty, keyHex: key }),
      (err) => err.code === 'output_not_empty',
    );
    assert.equal(fs.readFileSync(path.join(nonEmpty, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    cleanup(dir);
    cleanup(out);
    if (fs.existsSync(bundle)) fs.rmSync(bundle, { force: true });
  }
});

test('archive validation refuses traversal, duplicates and unexpected files before writing', async () => {
  const dir = tempDir('crypto-archive-src');
  const out = tempDir('crypto-archive-out');
  const key = Buffer.from('11'.repeat(32), 'hex');
  try {
    const { manifest } = writeFixture(dir, { cases: 1 });
    const manifestBuffer = fs.readFileSync(path.join(dir, 'manifest.json'));
    const sourceBuffer = fs.readFileSync(path.join(dir, 'cases', 'C01.png'));
    const assetBuffer = fs.readFileSync(path.join(dir, 'assets', 'a1.png'));
    const goodFiles = [
      { path: 'manifest.json', sha256: sha256Hex(manifestBuffer), base64: manifestBuffer.toString('base64') },
      { path: 'cases/C01.png', sha256: sha256Hex(sourceBuffer), base64: sourceBuffer.toString('base64') },
      { path: 'assets/a1.png', sha256: sha256Hex(assetBuffer), base64: assetBuffer.toString('base64') },
    ];
    const base = { schemaVersion: 1, kind: 'imstage-screenshot-edit-bundle', manifest: 'manifest.json' };

    const traversal = { ...base, files: [...goodFiles, { path: '../escape.png', sha256: sha256Hex(assetBuffer), base64: assetBuffer.toString('base64') }] };
    const dup = { ...base, files: [...goodFiles, { path: 'assets/a1.png', sha256: sha256Hex(assetBuffer), base64: assetBuffer.toString('base64') }] };
    const unexpected = { ...base, files: [...goodFiles, { path: 'assets/extra.png', sha256: sha256Hex(assetBuffer), base64: assetBuffer.toString('base64') }] };

    for (const [name, archive] of [['traversal', traversal], ['dup', dup], ['unexpected', unexpected]]) {
      const bundlePath = path.join(out, `${name}.imb`);
      fs.writeFileSync(bundlePath, sealArchive(archive, key));
      const target = path.join(out, `${name}-dir`);
      await assert.rejects(
        () => unpackDataset({ inputFile: bundlePath, outputDir: target, keyHex: key.toString('hex') }),
        (err) => err.code === 'dataset_archive_invalid' || err.code === 'unsafe_path',
        `${name} must be refused`,
      );
      assert.equal(fs.existsSync(target), false, `${name} must not write files`);
    }

    // Sanity: the well-formed archive opens.
    const goodBundle = path.join(out, 'good.imb');
    fs.writeFileSync(goodBundle, sealArchive({ ...base, files: goodFiles }, key));
    const archive = openArchive(fs.readFileSync(goodBundle), key);
    assert.equal(archive.files.length, 3);
    assert.ok(manifest.cases.length === 1);
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('resolveDatasetKey fails closed when missing or malformed', () => {
  assert.throws(() => resolveDatasetKey(undefined, {}), (err) => err.code === 'dataset_key_missing');
  assert.throws(() => resolveDatasetKey('not-hex', {}), (err) => err.code === 'dataset_key_invalid');
  assert.equal(resolveDatasetKey('00'.repeat(32), {}).length, 32);
});

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function runCliSafe(args, env = {}) {
  try {
    const stdout = execFileSync('node', [BENCHMARK_CLI, ...args], {
      cwd: PACKAGE_DIR,
      env: { ...process.env, ...env, IMSTAGE_EVAL_TEST_DIR: TEST_ROOT },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('CLI validate/report/run exit codes and subset semantics', async () => {
  const dir = tempDir('cli-src');
  const out = tempDir('cli-out');
  try {
    writeFixture(dir, { cases: 2 });

    const valid = runCliSafe(['validate', '--dataset', dir]);
    assert.equal(valid.status, 0, valid.stderr);

    const badDir = tempDir('cli-bad');
    fs.writeFileSync(path.join(badDir, 'manifest.json'), JSON.stringify({ schemaVersion: 1 }));
    const invalid = runCliSafe(['validate', '--dataset', badDir]);
    assert.notEqual(invalid.status, 0);
    cleanup(badDir);

    // No AI config: the run fails closed per case, writes a sanitized report,
    // and a limited run is explicitly subset (never a full pass).
    const runEnv = { IMSTAGE_AI_API_KEY: '' };
    const run = runCliSafe(['run', '--dataset', dir, '--out', out, '--limit', '1'], runEnv);
    assert.notEqual(run.status, 0);
    const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
    assert.equal(report.subset, true);
    assert.equal(report.ok, false);
    assert.equal(report.counts.casesAttempted, 1);
    assert.equal(report.errorCodes.ai_not_configured, 1);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('LOADING-C01'));
    assert.ok(!serialized.includes('example.invalid'));
    assert.ok(!serialized.includes(SECRET_ANSWER));

    const reportCli = runCliSafe(['report', '--out', out]);
    assert.notEqual(reportCli.status, 0);
    assert.ok(reportCli.stdout.includes('FAIL') || reportCli.stdout.includes('subset'));
  } finally {
    cleanup(dir);
    cleanup(out);
  }
});

test('safeErrorCode only exposes static lowercase codes', () => {
  assert.equal(safeErrorCode({ code: 'ai_timeout' }), 'ai_timeout');
  assert.equal(safeErrorCode({ code: 'ENOENT' }), 'internal_error');
  assert.equal(safeErrorCode(new Error('boom')), 'internal_error');
});

/**
 * Regression tests for benchmark Agent integrity.
 *
 * All fixtures are synthetic and offline: an injected plan seam, an injected
 * renderer seam and locally-encoded PNGs. No provider, browser or private
 * dataset is touched.
 *
 * Covers:
 *   - generated assets accepted only from the runtime registry with validated
 *     bytes and ownership (never a static allowlist or a model-claimed id),
 *   - partial scene + partial PNG preservation on a failed runtime,
 *   - unmistakable error/nonpass status for partial output.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { encodePng, decodePng } from '../src/png.mjs';
import { sha256Hex } from '../src/util.mjs';
import { boxToPixels } from '../src/benchmark/plan.mjs';
import { runDataset, BENCHMARK_RUNTIME_VERSION } from '../src/benchmark/run.mjs';
import { collectAssetRegistry, callDeepSeekAgent } from '../src/benchmark/agent.mjs';

const ROOT = path.resolve(process.env.IMSTAGE_EVAL_TEST_DIR ?? os.tmpdir());
const ENV = Object.freeze({ IMSTAGE_AI_MODEL: 'synthetic-agent-assets' });

function solidPng(width, height, color) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = color[3] ?? 255;
  }
  return encodePng({ width, height, data });
}

function dataUrl(buffer, mime = 'image/png') {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/** Deterministic raster seam: paints each edit box over the source pixels. */
function renderSynthetic({ sourceBuffer, width, height, plan }) {
  const source = decodePng(sourceBuffer);
  const data = Buffer.from(source.data);
  for (const edit of plan.edits) {
    const rect = boxToPixels(edit.box, width, height);
    for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(height, Math.ceil(rect.y + rect.height)); y += 1) {
      for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(width, Math.ceil(rect.x + rect.width)); x += 1) {
        const i = (y * width + x) * 4;
        data[i] = 17;
        data[i + 1] = 34;
        data[i + 2] = 51;
        data[i + 3] = 255;
      }
    }
  }
  return {
    buffer: encodePng({ width, height, data }),
    width,
    height,
    textFits: plan.edits.filter((edit) => edit.kind === 'text').map((edit) => ({ id: edit.id, fits: true })),
    patches: [],
    warnings: [],
  };
}

function textEdit() {
  return {
    id: 'label',
    kind: 'text',
    box: [100, 100, 600, 300],
    text: 'READY',
    background: '#FFFFFF',
    color: '#111111',
    fontSize: 12,
    fontWeight: 400,
    align: 'left',
  };
}

function planWith(edits, width = 80, height = 80) {
  return { schemaVersion: 1, im: 'wechat', surface: 'ios', width, height, edits, warnings: [] };
}

async function fixture(t, { asset = false } = {}) {
  await fs.mkdir(ROOT, { recursive: true });
  const root = await fs.mkdtemp(path.join(ROOT, 'benchmark-agent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const datasetDir = path.join(root, 'dataset');
  const outDir = path.join(root, 'output');
  await fs.mkdir(datasetDir);
  const source = solidPng(80, 80, [240, 240, 240]);
  await fs.writeFile(path.join(datasetDir, 'source.png'), source);
  const expectedEdits = [textEdit()];
  const manifest = {
    schemaVersion: 1,
    kind: 'imstage-screenshot-edit-dataset',
    id: 'synthetic-agent-assets',
    version: 1,
    private: true,
    assets: [],
    cases: [
      {
        id: 'C01',
        title: 'Synthetic agent asset case',
        difficulty: 1,
        im: 'wechat',
        surface: 'ios',
        source: { file: 'source.png', mime: 'image/png', width: 80, height: 80, sha256: sha256Hex(source) },
        task: 'Replace the label with READY.',
        analysis: {},
        assetIds: asset ? ['a1'] : [],
        expected: {
          answer: 'SYNTHETIC_ANSWER',
          edits: asset
            ? [
                ...expectedEdits,
                {
                  id: 'photo',
                  kind: 'image',
                  box: [100, 400, 500, 300],
                  assetId: 'a1',
                  background: '#000000',
                  fit: 'cover',
                  radius: 12,
                },
              ]
            : expectedEdits,
          preserveRegions: [],
          minScore: 0.8,
        },
        referenceStatus: 'proposed',
      },
    ],
  };
  let assetBuffer = null;
  if (asset) {
    assetBuffer = solidPng(32, 32, [10, 200, 30]);
    await fs.writeFile(path.join(datasetDir, 'asset.png'), assetBuffer);
    manifest.assets.push({
      id: 'a1',
      file: 'asset.png',
      mime: 'image/png',
      width: 32,
      height: 32,
      sha256: sha256Hex(assetBuffer),
      description: 'synthetic asset',
      provenance: 'deterministic-map',
    });
  }
  await fs.writeFile(path.join(datasetDir, 'manifest.json'), JSON.stringify(manifest));
  const run = (options = {}) =>
    runDataset({ datasetDir, outDir, env: ENV, renderPlan: renderSynthetic, ...options });
  return { root, datasetDir, outDir, source, assetBuffer, run };
}

/* ------------------------------------------------------------------ */
/* Registry unit tests                                                 */
/* ------------------------------------------------------------------ */

test('collectAssetRegistry distinguishes preprovided and generated provenance', async () => {
  const input = solidPng(4, 4, [1, 2, 3]);
  const generated = solidPng(6, 6, [4, 5, 6]);
  const out = await collectAssetRegistry({
    reference: {
      assets: [
        { id: 'a1', dataUrl: dataUrl(input), description: 'pre' },
        { id: 'g1', dataUrl: dataUrl(generated), description: 'gen' },
      ],
    },
    inputAssets: [{ id: 'a1', mime: 'image/png', buffer: input }],
  });
  assert.deepEqual(out.provenance, { a1: 'preprovided', g1: 'generated' });
  assert.deepEqual(out.generated.map((asset) => asset.id), ['g1']);
  assert.equal(out.registry.find((asset) => asset.id === 'a1').provenance, 'preprovided');
});

test('collectAssetRegistry rejects a rewritten preprovided asset (ownership)', async () => {
  const input = solidPng(4, 4, [1, 2, 3]);
  const rewritten = solidPng(4, 4, [9, 9, 9]);
  await assert.rejects(
    () =>
      collectAssetRegistry({
        reference: { assets: [{ id: 'a1', dataUrl: dataUrl(rewritten) }] },
        inputAssets: [{ id: 'a1', mime: 'image/png', buffer: input }],
      }),
    (error) => error.code === 'asset_ownership_violation',
  );
});

test('collectAssetRegistry rejects undecodable generated bytes and duplicate ids', async () => {
  await assert.rejects(
    () =>
      collectAssetRegistry({
        reference: { assets: [{ id: 'g1', dataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl' }] },
        inputAssets: [],
      }),
    (error) => error.code === 'invalid_generated_asset',
  );
  await assert.rejects(
    () =>
      collectAssetRegistry({
        reference: {
          assets: [
            { id: 'g1', dataUrl: dataUrl(solidPng(4, 4, [1, 1, 1])) },
            { id: 'g1', dataUrl: dataUrl(solidPng(4, 4, [2, 2, 2])) },
          ],
        },
        inputAssets: [],
      }),
    (error) => error.code === 'duplicate_generated_asset',
  );
});

test('collectAssetRegistry lenient mode drops invalid generated assets', async () => {
  const generated = solidPng(4, 4, [7, 8, 9]);
  const out = await collectAssetRegistry({
    reference: {
      assets: [
        { id: 'g-good', dataUrl: dataUrl(generated) },
        { id: 'g-bad', dataUrl: 'data:image/png;base64,bm90IGFuIGltYWdl' },
      ],
    },
    inputAssets: [],
    strict: false,
  });
  assert.deepEqual(out.generated.map((asset) => asset.id), ['g-good']);
  assert.equal(out.provenance['g-bad'], undefined);
});

test('callDeepSeekAgent attaches a validated partial registry when the runtime fails', async (t) => {
  const f = await fixture(t, { asset: true });
  const request = {
    caseId: 'C01',
    task: 'Replace the label with READY.',
    im: 'wechat',
    surface: 'ios',
    width: 80,
    height: 80,
    source: { mime: 'image/png', dataBase64: f.source.toString('base64'), width: 80, height: 80 },
    assets: [],
  };
  const inputAssets = [{ id: 'a1', mime: 'image/png', buffer: f.assetBuffer, metadata: {} }];
  const chatProvider = {
    async complete() {
      return { content: '我建议直接改文字。', toolCalls: [], finishReason: 'stop' };
    },
  };
  await assert.rejects(
    () =>
      callDeepSeekAgent({
        config: { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', model: 'synthetic' },
        request,
        assets: inputAssets,
        env: ENV,
        deps: { chatProvider },
      }),
    (error) => {
      assert.equal(error.code, 'no_mutation');
      assert.ok(error.partial, 'a failed runtime must expose its partial scene');
      assert.equal(error.partial.provenance.a1, 'preprovided');
      assert.equal(error.partial.plan.schemaVersion, 1);
      assert.equal(error.partial.mutations, 0);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ */
/* Runner: generated asset registry                                    */
/* ------------------------------------------------------------------ */

test('runDataset accepts a generated asset only from the runtime registry', async (t) => {
  const f = await fixture(t, { asset: false });
  const genPng = solidPng(24, 24, [200, 50, 40]);
  const report = await f.run({
    generatePlan: async () => ({
      rawContent: JSON.stringify(planWith([textEdit(), {
        id: 'photo', kind: 'image', box: [100, 400, 500, 300],
        assetId: 'gen1', background: '#000000', fit: 'cover', radius: 12,
      }])),
      generatedAssets: [{ id: 'gen1', mime: 'image/png', buffer: genPng }],
    }),
  });
  const entry = report.cases.find((item) => item.caseId === 'C01');
  assert.equal(entry.errorCode, null, 'the runtime asset must pass plan validation');
  assert.equal(entry.status, 'fail', 'an extra image edit still fails the semantic check, not the runtime');
  const record = JSON.parse(await fs.readFile(path.join(f.outDir, 'private', 'C01.json'), 'utf8'));
  assert.equal(record.assetProvenance.gen1, 'generated');
  assert.deepEqual(record.generatedAssetIds, ['gen1']);
  assert.equal(record.plan.edits.find((edit) => edit.id === 'photo').assetId, 'gen1');
});

test('runDataset rejects a model-claimed asset id that never entered the registry', async (t) => {
  const f = await fixture(t, { asset: false });
  const genPng = solidPng(24, 24, [200, 50, 40]);
  const report = await f.run({
    generatePlan: async () => ({
      rawContent: JSON.stringify(planWith([textEdit(), {
        id: 'photo', kind: 'image', box: [100, 400, 500, 300],
        assetId: 'ghost', background: '#000000', fit: 'cover', radius: 12,
      }])),
      // The registry only contains a different id; `ghost` is model-claimed.
      generatedAssets: [{ id: 'gen1', mime: 'image/png', buffer: genPng }],
    }),
  });
  const entry = report.cases.find((item) => item.caseId === 'C01');
  assert.equal(report.ok, false);
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorCode, 'plan_invalid');
  await assert.rejects(fs.stat(path.join(f.outDir, 'private', 'C01.png')), { code: 'ENOENT' });
});

test('runDataset rejects a generated asset that rewrites a preprovided id', async (t) => {
  const f = await fixture(t, { asset: true });
  const forged = solidPng(32, 32, [9, 9, 9]);
  const report = await f.run({
    generatePlan: async () => ({
      rawContent: JSON.stringify(planWith([textEdit(), {
        id: 'photo', kind: 'image', box: [100, 400, 500, 300],
        assetId: 'a1', background: '#000000', fit: 'cover', radius: 12,
      }])),
      generatedAssets: [{ id: 'a1', mime: 'image/png', buffer: forged }],
    }),
  });
  const entry = report.cases.find((item) => item.caseId === 'C01');
  assert.equal(report.ok, false);
  assert.equal(entry.errorCode, 'asset_ownership_violation');
  await assert.rejects(fs.stat(path.join(f.outDir, 'private', 'C01.png')), { code: 'ENOENT' });
});

test('runDataset rejects an undecodable generated asset instead of rendering it', async (t) => {
  const f = await fixture(t, { asset: false });
  const report = await f.run({
    generatePlan: async () => ({
      rawContent: JSON.stringify(planWith([textEdit(), {
        id: 'photo', kind: 'image', box: [100, 400, 500, 300],
        assetId: 'gen1', background: '#000000', fit: 'cover', radius: 12,
      }])),
      generatedAssets: [{ id: 'gen1', mime: 'image/png', buffer: Buffer.from('not an image') }],
    }),
  });
  const entry = report.cases.find((item) => item.caseId === 'C01');
  assert.equal(entry.status, 'error');
  assert.equal(entry.errorCode, 'invalid_generated_asset');
  await assert.rejects(fs.stat(path.join(f.outDir, 'private', 'C01.png')), { code: 'ENOENT' });
});

/* ------------------------------------------------------------------ */
/* Runner: partial output                                              */
/* ------------------------------------------------------------------ */

function partialError(partial) {
  const error = new Error('Agent 未完成任务');
  error.code = 'agent_incomplete';
  error.partial = partial;
  return error;
}

test('runDataset renders a partial PNG on a failed runtime and marks unmistakable nonpass', async (t) => {
  const f = await fixture(t, { asset: true });
  const report = await f.run({
    generatePlan: async () => {
      throw partialError({
        reason: 'max_rounds',
        plan: planWith([textEdit(), {
          id: 'photo', kind: 'image', box: [100, 400, 500, 300],
          assetId: 'a1', background: '#000000', fit: 'cover', radius: 12,
        }]),
        assets: [{ id: 'a1', mime: 'image/png', buffer: f.assetBuffer }],
        generatedAssets: [],
        provenance: { a1: 'preprovided' },
        mutations: 1,
      });
    },
  });

  assert.equal(report.ok, false);
  const entry = report.cases.find((item) => item.caseId === 'C01');
  assert.equal(entry.status, 'error');
  assert.equal(entry.passed, false);
  assert.equal(entry.errorCode, 'agent_incomplete');

  const record = JSON.parse(await fs.readFile(path.join(f.outDir, 'private', 'C01.json'), 'utf8'));
  assert.equal(record.status, 'error');
  assert.equal(record.passed, false);
  assert.equal(record.partial, true);
  assert.equal(record.partialRender, true);
  assert.equal(record.plan.edits.length, 2);
  assert.equal(record.assetProvenance.a1, 'preprovided');

  const png = await fs.readFile(path.join(f.outDir, 'private', 'C01.png'));
  assert.equal(decodePng(png).width, 80);
  assert.equal(record.partialPngSha256, sha256Hex(png));
  assert.equal(record.binding.runtimeVersion, BENCHMARK_RUNTIME_VERSION);
});

test('a partial failure record is never resumed as a passing result', async (t) => {
  const f = await fixture(t, { asset: false });
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw partialError({ reason: 'max_rounds', plan: planWith([textEdit()]), assets: [], mutations: 1 });
  };
  const first = await f.run({ generatePlan: failing });
  assert.equal(first.counts.casesPassed, 0);
  assert.equal(calls, 1);

  const second = await f.run({
    resume: true,
    generatePlan: async () => {
      calls += 1;
      return { rawContent: JSON.stringify(planWith([textEdit()])) };
    },
  });
  assert.equal(calls, 2, 'a partial record must not be reused by resume');
  assert.equal(second.counts.resumeReused, 0);
  assert.equal(second.counts.casesPassed, 1);
});

test('runDataset preserves an unrenderable partial plan without a false PNG', async (t) => {
  const f = await fixture(t, { asset: false });
  const report = await f.run({
    generatePlan: async () => {
      throw partialError({
        reason: 'max_rounds',
        plan: planWith([{
          id: 'photo', kind: 'image', box: [100, 400, 500, 300],
          assetId: 'ghost', background: '#000000', fit: 'cover', radius: 12,
        }]),
        assets: [],
        mutations: 1,
      });
    },
  });
  const entry = report.cases.find((item) => item.caseId === 'C01');
  assert.equal(entry.status, 'error');
  assert.equal(entry.passed, false);

  const record = JSON.parse(await fs.readFile(path.join(f.outDir, 'private', 'C01.json'), 'utf8'));
  assert.equal(record.partial, true);
  assert.equal(record.partialRender, false);
  assert.equal(record.plan.edits[0].assetId, 'ghost');
  await assert.rejects(fs.stat(path.join(f.outDir, 'private', 'C01.png')), { code: 'ENOENT' });
});

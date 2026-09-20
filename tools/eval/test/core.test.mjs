import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { comparePngBuffers } from '../src/compare.mjs';
import { encodePng } from '../src/png.mjs';
import { buildReport, evaluateGolden, validateActualManifest, writeErrorReport } from '../src/core.mjs';
import { computeInputFingerprint } from '../src/fingerprint.mjs';
import { assertSafeId, isSafeId, ratioValue, safeJoin } from '../src/util.mjs';
import { validateBundle, validateCaseInput, validateReviewInput } from '../src/validate.mjs';
import { DEFAULT_MAX_DIFF_RATIO, MAX_PIXELS } from '../src/constants.mjs';
import { buildHarness } from '../src/fixtures.mjs';

function solid(r, g, b, width = 64, height = 64) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return encodePng({ width, height, data });
}

function solidWithPixelsChanged(r, g, b, changes, width = 64, height = 64) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  for (let i = 0; i < changes; i += 1) {
    data[i * 4] = 255 - r;
    data[i * 4 + 1] = 255 - g;
    data[i * 4 + 2] = 255 - b;
  }
  return encodePng({ width, height, data });
}

test('comparePngBuffers passes identical images and fails altered ones', () => {
  const gold = solid(200, 210, 205);
  const identical = comparePngBuffers({ goldBuffer: gold, actualBuffer: gold, maxDiffRatio: 0.005 });
  assert.equal(identical.status, 'pass');
  assert.equal(identical.diffRatio, 0);

  const onePixel = comparePngBuffers({
    goldBuffer: gold,
    actualBuffer: solidWithPixelsChanged(200, 210, 205, 1),
    maxDiffRatio: 0.005,
  });
  assert.equal(onePixel.status, 'pass');
  assert.ok(onePixel.diffRatio > 0 && onePixel.diffRatio < 0.005);

  const altered = comparePngBuffers({
    goldBuffer: gold,
    actualBuffer: solid(10, 20, 30),
    maxDiffRatio: 0.005,
  });
  assert.equal(altered.status, 'fail');
  assert.equal(altered.reason, 'pixel_difference');
  assert.equal(altered.diffRatio, 1);
  assert.ok(Buffer.isBuffer(altered.diffPng));
});

test('comparePngBuffers reports dimension mismatch and malformed input', () => {
  const gold = solid(1, 2, 3, 64, 64);
  const wrongDims = solid(1, 2, 3, 32, 64);
  const mismatch = comparePngBuffers({ goldBuffer: gold, actualBuffer: wrongDims, maxDiffRatio: 0.005 });
  assert.equal(mismatch.status, 'fail');
  assert.equal(mismatch.reason, 'dimension_mismatch');

  const malformed = comparePngBuffers({ goldBuffer: gold, actualBuffer: Buffer.from('nope'), maxDiffRatio: 0.005 });
  assert.equal(malformed.status, 'malformed');
});

test('report breaks results down by IM, surface, language, modality and output kind', () => {
  const report = buildReport({
    goldBundle: { cases: [{}, {}], generator: 'x' },
    actualManifest: { generator: 'y' },
    results: [
      { caseId: 'a', status: 'pass', targetIM: 'wechat', surface: 'ios', inputLanguage: 'zh-CN', outputKind: 'screenshot', modalities: ['text'], maxDiffRatio: 0.005 },
      { caseId: 'b', status: 'fail', targetIM: 'wechat', surface: 'android', inputLanguage: 'en', outputKind: 'long-screenshot', modalities: ['image', 'text'], maxDiffRatio: 0.005 },
    ],
    outDir: '/tmp/out',
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(report.ok, false);
  assert.equal(report.summary.total, 2);
  assert.equal(report.summary.pass, 1);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.breakdown.targetIM.wechat.total, 2);
  assert.equal(report.breakdown.surface.ios.pass, 1);
  assert.equal(report.breakdown.inputLanguage.en.fail, 1);
  assert.equal(report.breakdown.outputKind['long-screenshot'].total, 1);
  assert.equal(report.breakdown.modality.image.total, 1);
  assert.equal(report.breakdown.modality.text.total, 2);
});

test('evaluateGolden closes the loop on the harness fixtures', async () => {
  const harness = buildHarness();
  const actual = validateActualManifest(harness.actual.altered, process.cwd());
  const { report } = await evaluateGolden({
    goldBundle: validateBundle(harness.goldBundle),
    actualManifest: actual,
    outDir: pathForTest(),
    writeArtifacts: false,
  });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, 'fail');
  assert.equal(report.results[0].reason, 'pixel_difference');
});

function pathForTest() {
  return new URL('../../.local/eval-test/core-out', import.meta.url).pathname;
}

test('safe ids and safeJoin block path escapes', () => {
  assert.equal(isSafeId('case_123-abc'), true);
  assert.equal(isSafeId('../evil'), false);
  assert.equal(isSafeId('a/b'), false);
  assert.throws(() => assertSafeId('../evil'), /不合法/);
  assert.throws(() => safeJoin('/base', '..', 'escape.png'), /超出/);
  assert.equal(safeJoin('/base', 'diffs', 'ok.png'), '/base/diffs/ok.png');
});

test('numeric and case validation enforce bounds', () => {
  assert.equal(ratioValue(0.005, 'maxDiffRatio'), 0.005);
  assert.equal(ratioValue(undefined, 'maxDiffRatio', DEFAULT_MAX_DIFF_RATIO), DEFAULT_MAX_DIFF_RATIO);
  assert.throws(() => ratioValue(0.06, 'maxDiffRatio'), /0 到 0.05/);
  assert.throws(() => ratioValue(Number.NaN, 'maxDiffRatio'), /有限数字/);
  assert.throws(() => ratioValue('abc', 'maxDiffRatio'), /有限数字/);

  const ok = validateCaseInput({
    question: 'q',
    inputLanguage: 'zh-CN',
    targetIM: 'wechat',
    surface: 'ios',
    outputKind: 'screenshot',
    width: 390,
    height: 844,
  });
  assert.equal(ok.width, 390);
  assert.throws(
    () =>
      validateCaseInput({
        question: 'q',
        inputLanguage: 'zh-CN',
        targetIM: 'wechat',
        surface: 'ios',
        outputKind: 'screenshot',
        width: 4000,
        height: 4000,
      }),
    /像素/,
  );
  assert.throws(
    () =>
      validateCaseInput({
        question: 'q',
        inputLanguage: 'klingon',
        targetIM: 'wechat',
        surface: 'ios',
        outputKind: 'screenshot',
        width: 10,
        height: 10,
      }),
    /inputLanguage/,
  );
});

test('review validation requires scores for a verdict and a reason for bad', () => {
  assert.throws(
    () =>
      validateReviewInput({
        scores: { content: 2, imFidelity: null, layout: 2, completeness: 2 },
        verdict: 'good',
      }),
    /全部四项评分/,
  );
  assert.throws(
    () =>
      validateReviewInput({
        scores: { content: 0, imFidelity: 0, layout: 0, completeness: 0 },
        verdict: 'bad',
        reason: '',
      }),
    /原因/,
  );
  const unreviewed = validateReviewInput({ scores: {}, verdict: 'unreviewed' });
  assert.equal(unreviewed.status, 'unreviewed');
  const bad = validateReviewInput({
    scores: { content: 0, imFidelity: 1, layout: 0, completeness: 2 },
    verdict: 'bad',
    reason: 'wrong tone',
  });
  assert.equal(bad.status, 'reviewed');
});

test('MAX_PIXELS constant matches the documented eight million limit', () => {
  assert.equal(MAX_PIXELS, 8_000_000);
});

test('validateBundle rejects declared dimensions that disagree with the golden PNG', () => {
  const harness = buildHarness();
  const bad = structuredClone(harness.goldBundle);
  bad.cases[0].width = 390;
  bad.cases[0].height = 844;
  bad.cases[0].inputFingerprint = computeInputFingerprint({ ...bad.cases[0], attachments: [] });
  assert.throws(() => validateBundle(bad), /声明/);
});

test('actual manifest rejects duplicate case ids', () => {
  const harness = buildHarness();
  const dup = structuredClone(harness.actual.identical);
  dup.cases.push(structuredClone(dup.cases[0]));
  assert.throws(() => validateActualManifest(dup, process.cwd()), /重复/);
});

test('evaluateGolden reports extra actual ids that the golden set does not reference', async () => {
  const harness = buildHarness();
  const actual = structuredClone(harness.actual.identical);
  actual.cases.push({
    caseId: 'extra-case',
    inputFingerprint: harness.inputFingerprint,
    pngBase64: harness.buffers.goldBuffer.toString('base64'),
  });
  const { report } = await evaluateGolden({
    goldBundle: validateBundle(harness.goldBundle),
    actualManifest: validateActualManifest(actual, process.cwd()),
    outDir: pathForTest(),
    writeArtifacts: false,
  });
  assert.deepEqual(report.extraActual, ['extra-case']);
  assert.equal(report.summary.extra, 1);
});

test('writeErrorReport always writes JSON and Markdown diagnostics', async () => {
  const dir = new URL('../../.local/eval-test/core-err', import.meta.url).pathname;
  await fs.promises.rm(dir, { recursive: true, force: true });
  try {
    const report = await writeErrorReport({ outDir: dir, error: 'boom' });
    assert.equal(report.ok, false);
    const json = JSON.parse(await fs.promises.readFile(path.join(dir, 'report.json'), 'utf8'));
    assert.equal(json.error, 'boom');
    assert.equal(json.ok, false);
    const md = await fs.promises.readFile(path.join(dir, 'report.md'), 'utf8');
    assert.match(md, /boom/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

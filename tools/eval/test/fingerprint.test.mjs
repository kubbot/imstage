import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateIsCurrent,
  computeGoldenFingerprint,
  computeInputFingerprint,
  computeReviewFingerprint,
  goldenIsCurrent,
  isExportableGolden,
  reviewIsCurrent,
} from '../src/fingerprint.mjs';
import { RUBRIC_VERSION } from '../src/constants.mjs';

function baseCase(overrides = {}) {
  return {
    question: '生成微信截图',
    inputLanguage: 'zh-CN',
    targetIM: 'wechat',
    surface: 'ios',
    outputKind: 'screenshot',
    width: 64,
    height: 64,
    notes: 'notes',
    maxDiffRatio: 0.005,
    attachments: [],
    ...overrides,
  };
}

function withBinding(overrides = {}) {
  const base = baseCase(overrides);
  const inputFingerprint = computeInputFingerprint(base);
  const candidate = {
    sha256: 'a'.repeat(64),
    inputFingerprint,
    width: base.width,
    height: base.height,
  };
  const scores = { content: 2, imFidelity: 2, layout: 2, completeness: 2 };
  const reason = 'looks right';
  const reviewFingerprint = computeReviewFingerprint({
    inputFingerprint,
    candidateSha256: candidate.sha256,
    scores,
    verdict: 'good',
    reason,
    rubricVersion: RUBRIC_VERSION,
  });
  const goldenFingerprint = computeGoldenFingerprint({
    inputFingerprint,
    candidateSha256: candidate.sha256,
    maxDiffRatio: base.maxDiffRatio,
    reviewFingerprint,
  });
  return {
    ...base,
    candidate,
    review: {
      status: 'reviewed',
      scores,
      verdict: 'good',
      reason,
      rubricVersion: RUBRIC_VERSION,
      candidateSha256: candidate.sha256,
      inputFingerprint,
      fingerprint: reviewFingerprint,
    },
    golden: {
      approved: true,
      fingerprint: goldenFingerprint,
      candidateSha256: candidate.sha256,
      inputFingerprint,
      maxDiffRatio: base.maxDiffRatio,
      reviewFingerprint,
    },
  };
}

test('input fingerprint is stable for identical input', () => {
  assert.equal(computeInputFingerprint(baseCase()), computeInputFingerprint(baseCase()));
});

test('input fingerprint changes when question or target IM changes', () => {
  const base = computeInputFingerprint(baseCase());
  assert.notEqual(base, computeInputFingerprint(baseCase({ question: 'different' })));
  assert.notEqual(base, computeInputFingerprint(baseCase({ targetIM: 'telegram' })));
  assert.notEqual(base, computeInputFingerprint(baseCase({ width: 65 })));
});

test('input fingerprint changes when attachment hash changes', () => {
  const base = computeInputFingerprint(baseCase());
  const withAttachment = computeInputFingerprint(
    baseCase({
      attachments: [{ name: 'a.png', kind: 'image', mime: 'image/png', sha256: 'b'.repeat(64), size: 10 }],
    }),
  );
  assert.notEqual(base, withAttachment);
});

test('a fully bound case is current and exportable', () => {
  const c = withBinding();
  assert.equal(candidateIsCurrent(c), true);
  assert.equal(reviewIsCurrent(c), true);
  assert.equal(goldenIsCurrent(c), true);
  assert.equal(isExportableGolden(c), true);
});

test('changing the input invalidates candidate, review and golden', () => {
  const c = withBinding();
  const edited = { ...c, question: 'changed expectation' };
  assert.equal(candidateIsCurrent(edited), false);
  assert.equal(reviewIsCurrent(edited), false);
  assert.equal(goldenIsCurrent(edited), false);
  assert.equal(isExportableGolden(edited), false);
});

test('a tampered review fingerprint is rejected', () => {
  const c = withBinding();
  const tampered = { ...c, review: { ...c.review, verdict: 'bad' } };
  assert.equal(reviewIsCurrent(tampered), false);
  assert.equal(goldenIsCurrent(tampered), false);
});

test('golden requires a good verdict', () => {
  const c = withBinding();
  const bad = { ...c, review: { ...c.review, verdict: 'bad' } };
  assert.equal(goldenIsCurrent(bad), false);
});

test('changing the tolerance invalidates the golden binding', () => {
  const c = withBinding();
  const retuned = { ...c, maxDiffRatio: 0.02, golden: { ...c.golden, maxDiffRatio: 0.02 } };
  assert.equal(goldenIsCurrent(retuned), false);
});

test('changing a good score good->good invalidates review and golden', () => {
  const c = withBinding();
  const rescored = { ...c, review: { ...c.review, scores: { ...c.review.scores, layout: 1 } } };
  assert.equal(reviewIsCurrent(rescored), false);
  assert.equal(goldenIsCurrent(rescored), false);
  assert.equal(isExportableGolden(rescored), false);
});

test('changing the review reason invalidates review and golden', () => {
  const c = withBinding();
  const reworded = { ...c, review: { ...c.review, reason: 'different reason' } };
  assert.equal(reviewIsCurrent(reworded), false);
  assert.equal(goldenIsCurrent(reworded), false);
});

test('candidate PNG dimensions must match the declared case size', () => {
  const c = withBinding();
  const mismatched = { ...c, candidate: { ...c.candidate, width: 32, height: 32 } };
  assert.equal(goldenIsCurrent(mismatched), false);
  assert.equal(isExportableGolden(mismatched), false);
});

test('a legacy golden without reviewFingerprint is not exportable', () => {
  const c = withBinding();
  const legacy = { ...c, golden: { ...c.golden } };
  delete legacy.golden.reviewFingerprint;
  assert.equal(goldenIsCurrent(legacy), false);
});

test('candidate without provenance is not current', () => {
  const c = { ...baseCase(), candidate: { sha256: 'a'.repeat(64) } };
  assert.equal(candidateIsCurrent(c), false);
});

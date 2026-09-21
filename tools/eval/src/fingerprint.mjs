import { RUBRIC_VERSION } from './constants.mjs';
import { canonicalJson, sha256Base64 } from './util.mjs';

// Fields that define the human expectation for a case. Changing any of them
// invalidates candidate provenance, saved review and golden approval.
function inputPayload(caseData) {
  const attachments = Array.isArray(caseData.attachments) ? caseData.attachments : [];
  return {
    question: caseData.question ?? '',
    inputLanguage: caseData.inputLanguage ?? '',
    targetIM: caseData.targetIM ?? '',
    surface: caseData.surface ?? '',
    outputKind: caseData.outputKind ?? '',
    width: caseData.width ?? null,
    height: caseData.height ?? null,
    notes: caseData.notes ?? '',
    attachments: attachments
      .map((att) => ({
        name: att.name ?? '',
        kind: att.kind ?? '',
        mime: att.mime ?? '',
        sha256: att.sha256 ?? '',
        size: att.size ?? null,
      }))
      .sort((a, b) => {
        if (a.sha256 !== b.sha256) return a.sha256 < b.sha256 ? -1 : 1;
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        return 0;
      }),
  };
}

export function computeInputFingerprint(caseData) {
  return sha256Base64(`imstage-eval:input:v1:${canonicalJson(inputPayload(caseData))}`);
}

// Review fingerprint binds the meaningful review content: all four scores, the
// verdict, the reason, the rubric version and the candidate/input bindings.
export function computeReviewFingerprint({
  inputFingerprint,
  candidateSha256,
  scores,
  verdict,
  reason = '',
  rubricVersion = RUBRIC_VERSION,
}) {
  const payload = {
    inputFingerprint,
    candidateSha256,
    rubricVersion,
    verdict,
    reason: String(reason ?? '').trim(),
    scores: {
      content: scores?.content ?? null,
      imFidelity: scores?.imFidelity ?? null,
      layout: scores?.layout ?? null,
      completeness: scores?.completeness ?? null,
    },
  };
  return sha256Base64(`imstage-eval:review:v2:${canonicalJson(payload)}`);
}

// Golden fingerprint binds the tolerance AND the review fingerprint, so any
// review content change (even good -> good) invalidates the approval.
export function computeGoldenFingerprint({
  inputFingerprint,
  candidateSha256,
  maxDiffRatio,
  reviewFingerprint,
}) {
  return sha256Base64(
    `imstage-eval:golden:v2:${canonicalJson({
      inputFingerprint,
      candidateSha256,
      maxDiffRatio,
      reviewFingerprint: reviewFingerprint ?? null,
    })}`,
  );
}

function candidateDimensionsMatch(caseData) {
  const candidate = caseData?.candidate;
  if (!candidate) return false;
  return candidate.width === caseData.width && candidate.height === caseData.height;
}

export function candidateIsCurrent(caseData) {
  const candidate = caseData?.candidate;
  if (!candidate || !candidate.sha256 || !candidate.inputFingerprint) return false;
  return candidate.inputFingerprint === computeInputFingerprint(caseData);
}

export function reviewIsCurrent(caseData) {
  const review = caseData?.review;
  const candidate = caseData?.candidate;
  if (!review || !candidate) return false;
  if (!candidateIsCurrent(caseData)) return false;
  if (review.candidateSha256 !== candidate.sha256) return false;
  if (review.inputFingerprint !== computeInputFingerprint(caseData)) return false;
  const expected = computeReviewFingerprint({
    inputFingerprint: review.inputFingerprint,
    candidateSha256: review.candidateSha256,
    scores: review.scores,
    verdict: review.verdict,
    reason: review.reason,
    rubricVersion: review.rubricVersion,
  });
  return review.fingerprint === expected;
}

export function goldenIsCurrent(caseData) {
  const golden = caseData?.golden;
  const candidate = caseData?.candidate;
  if (!golden || !golden.approved || !candidate) return false;
  // A golden whose PNG dimensions do not match the declared case size can
  // never be exported, even if it was somehow persisted.
  if (!candidateDimensionsMatch(caseData)) return false;
  if (!reviewIsCurrent(caseData)) return false;
  if (caseData.review.verdict !== 'good') return false;
  if (golden.candidateSha256 !== candidate.sha256) return false;
  if (golden.inputFingerprint !== computeInputFingerprint(caseData)) return false;
  if (golden.reviewFingerprint !== caseData.review.fingerprint) return false;
  const expected = computeGoldenFingerprint({
    inputFingerprint: golden.inputFingerprint,
    candidateSha256: golden.candidateSha256,
    maxDiffRatio: golden.maxDiffRatio,
    reviewFingerprint: golden.reviewFingerprint,
  });
  return golden.fingerprint === expected;
}

// A case is a usable golden baseline only when review, candidate and golden
// bindings are all current. This is the single source of truth for export.
export function isExportableGolden(caseData) {
  return goldenIsCurrent(caseData);
}

export { candidateDimensionsMatch };

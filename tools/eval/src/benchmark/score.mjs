// Screenshot-edit benchmark: deterministic scorer.
//
// scorePlan(caseData, actualPlan, {sourcePng, actualPng, renderInfo})
//   -> { passed, score, checks: [{id, passed, score, reasonCode, required}],
//        humanReviewRequired: true, ... }
//
// The scorer NEVER approves a reference: it only decides whether the model's
// plan preserves the source, edits the right regions and keeps exact geometry.
// It never copies the expected answer into the actual result and never looks at
// the reference PNG for a semantic/aesthetic verdict.
//
// Checks and weights (exported):
//   dimensions 0.1, semantic 0.5, geometry 0.2, preservation 0.2
// A failed required check fails the case regardless of the weighted score.
// Preservation compares the actual PNG against the source PNG *outside* the
// union of the curated expected edit boxes (+3px), using pixelmatch threshold
// 0.1 and a 0.003 outside-diff budget. Curated preserveRegions are stricter
// (zero differing pixels), covering status bars / payment cards etc.

import pixelmatch from 'pixelmatch';
import { decodePng } from '../png.mjs';
import {
  DEFAULT_MIN_IOU,
  DEFAULT_MIN_SCORE,
  boxToPixels,
  boxIoU,
  contentMatchesEdit,
  editMinIoU,
  planFromExpected,
  planFromModel,
  rectDeltaPx,
} from './plan.mjs';

export const CHECK_WEIGHTS = Object.freeze({
  dimensions: 0.1,
  semantic: 0.5,
  geometry: 0.2,
  preservation: 0.2,
});

export const PIXELMATCH_THRESHOLD = 0.1;
export const MAX_OUTSIDE_DIFF_RATIO = 0.003;
export const PRESERVE_REGION_MAX_DIFF = 0;
export const ALLOWED_REGION_PADDING = 3; // source pixels
export const IMAGE_RECT_TOLERANCE_PX = 2; // source pixels

function check(id, { passed, score, reasonCode, required = false, details = undefined }) {
  return { id, passed, score, reasonCode, required, ...(details ? { details } : {}) };
}

function mergeBoxes(boxes, width, height, pad = 0) {
  return boxes.map((box) => {
    const rect = boxToPixels(box, width, height);
    return {
      x0: Math.max(0, Math.floor(rect.x) - pad),
      y0: Math.max(0, Math.floor(rect.y) - pad),
      x1: Math.min(width, Math.ceil(rect.x + rect.width) + pad),
      y1: Math.min(height, Math.ceil(rect.y + rect.height) + pad),
    };
  });
}

function insideAny(rects, x, y) {
  for (const rect of rects) {
    if (x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1) return true;
  }
  return false;
}

function matchEdits(expectedEdits, actualEdits, width, height) {
  const used = new Set();
  const pairs = [];
  const missing = [];
  for (const expectedEdit of expectedEdits) {
    let bestIndex = -1;
    let bestIoU = -1;
    for (let i = 0; i < actualEdits.length; i += 1) {
      if (used.has(i)) continue;
      const actualEdit = actualEdits[i];
      if (!contentMatchesEdit(expectedEdit, actualEdit)) continue;
      const iou = boxIoU(expectedEdit.box, actualEdit.box);
      if (iou > bestIoU) {
        bestIoU = iou;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) {
      missing.push({ expected: expectedEdit, reasonCode: 'no_content_match' });
      continue;
    }
    const minIoU = editMinIoU(expectedEdit);
    if (bestIoU + 1e-9 < minIoU) {
      missing.push({
        expected: expectedEdit,
        actual: actualEdits[bestIndex],
        reasonCode: 'box_iou_below_min',
        iou: Number(bestIoU.toFixed(4)),
        minIoU,
      });
      continue;
    }
    if (expectedEdit.kind === 'image') {
      const delta = rectDeltaPx(expectedEdit.box, actualEdits[bestIndex].box, width, height);
      if (delta > IMAGE_RECT_TOLERANCE_PX) {
        missing.push({
          expected: expectedEdit,
          actual: actualEdits[bestIndex],
          reasonCode: 'image_frame_geometry',
          deltaPx: Number(delta.toFixed(2)),
          tolerancePx: IMAGE_RECT_TOLERANCE_PX,
        });
        continue;
      }
    }
    used.add(bestIndex);
    pairs.push({ expected: expectedEdit, actual: actualEdits[bestIndex], iou: bestIoU });
  }
  const extra = actualEdits.filter((_, index) => !used.has(index));
  return { pairs, missing, extra };
}

function computePreservation({ caseData, sourceBuffer, actualBuffer }) {
  const width = caseData.source.width;
  const height = caseData.source.height;
  let source;
  let actual;
  try {
    source = decodePng(sourceBuffer);
  } catch (err) {
    return {
      passed: false,
      score: 0,
      reasonCode: 'source_png_unreadable',
      details: { error: err.message },
    };
  }
  try {
    actual = decodePng(actualBuffer);
  } catch (err) {
    return {
      passed: false,
      score: 0,
      reasonCode: 'actual_png_unreadable',
      details: { error: err.message },
    };
  }
  if (source.width !== width || source.height !== height || actual.width !== width || actual.height !== height) {
    return {
      passed: false,
      score: 0,
      reasonCode: 'preservation_dimensions_mismatch',
      details: {
        source: [source.width, source.height],
        actual: [actual.width, actual.height],
        expected: [width, height],
      },
    };
  }

  const diff = Buffer.alloc(width * height * 4);
  pixelmatch(source.data, actual.data, diff, width, height, {
    threshold: PIXELMATCH_THRESHOLD,
    diffMask: true,
  });

  const allowed = mergeBoxes(caseData.expected.edits.map((edit) => edit.box), width, height, ALLOWED_REGION_PADDING);
  let outsideTotal = 0;
  let outsideDiff = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (insideAny(allowed, x, y)) continue;
      outsideTotal += 1;
      if (diff[(y * width + x) * 4 + 3] > 0) outsideDiff += 1;
    }
  }
  const outsideDiffRatio = outsideTotal === 0 ? 0 : outsideDiff / outsideTotal;

  const preserveRegions = Array.isArray(caseData.expected.preserveRegions) ? caseData.expected.preserveRegions : [];
  const regionResults = [];
  let regionFailed = false;
  for (const region of mergeBoxes(preserveRegions, width, height, 0)) {
    let total = 0;
    let changed = 0;
    for (let y = region.y0; y < region.y1; y += 1) {
      for (let x = region.x0; x < region.x1; x += 1) {
        total += 1;
        if (diff[(y * width + x) * 4 + 3] > 0) changed += 1;
      }
    }
    const ok = changed <= PRESERVE_REGION_MAX_DIFF;
    if (!ok) regionFailed = true;
    regionResults.push({ total, changed, maxChanged: PRESERVE_REGION_MAX_DIFF, passed: ok });
  }

  const outsideOk = outsideDiffRatio <= MAX_OUTSIDE_DIFF_RATIO + 1e-12;
  const passed = outsideOk && !regionFailed;
  let reasonCode = 'preserved';
  if (!outsideOk) reasonCode = 'outside_edit_regions_changed';
  else if (regionFailed) reasonCode = 'preserve_region_changed';
  return {
    passed,
    score: passed ? 1 : 0,
    reasonCode,
    details: {
      width,
      height,
      outsideTotal,
      outsideDiff,
      outsideDiffRatio: Number(outsideDiffRatio.toFixed(6)),
      maxOutsideDiffRatio: MAX_OUTSIDE_DIFF_RATIO,
      pixelmatchThreshold: PIXELMATCH_THRESHOLD,
      preserveRegions: regionResults,
    },
  };
}

function failResult(reasonCode, details) {
  return {
    passed: false,
    score: 0,
    checks: [check('plan_valid', { passed: false, score: 0, reasonCode, required: true, details })],
    humanReviewRequired: true,
    minScore: DEFAULT_MIN_SCORE,
    weights: CHECK_WEIGHTS,
  };
}

/**
 * @param {object} caseData validated dataset case (source/im/surface/expected/assetIds)
 * @param {object} actualPlan model answer plan
 * @param {object} [options]
 * @param {Buffer} [options.sourcePng] PNG representation of the untouched source
 * @param {Buffer} [options.actualPng] rendered actual PNG
 * @param {object} [options.renderInfo] renderer output ({textFits})
 */
export function scorePlan(caseData, actualPlan, options = {}) {
  if (!caseData || typeof caseData !== 'object' || !caseData.source || !caseData.expected || !Array.isArray(caseData.expected.edits)) {
    return failResult('invalid_case', { reasonCode: 'invalid_case' });
  }
  const width = caseData.source.width;
  const height = caseData.source.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return failResult('invalid_case_dimensions', { reasonCode: 'invalid_case_dimensions' });
  }

  let expectedEdits;
  try {
    expectedEdits = planFromExpected(caseData).edits;
  } catch (err) {
    return failResult('invalid_expected_plan', { error: err.message, reasonCode: 'invalid_expected_plan' });
  }
  if (expectedEdits.length === 0) {
    return failResult('empty_expected_edits', { reasonCode: 'empty_expected_edits' });
  }

  let plan;
  try {
    plan = planFromModel(actualPlan, { authorizedAssetIds: caseData.assetIds ?? null }).plan;
  } catch (err) {
    return failResult('invalid_plan', { error: err.message, reasonCode: 'invalid_plan' });
  }

  const { pairs, missing, extra } = matchEdits(expectedEdits, plan.edits, width, height);

  // --- dimensions / platform / device ---
  const dimResults = {
    width: plan.width === width,
    height: plan.height === height,
    platform: plan.im === caseData.im,
    device: plan.surface === caseData.surface,
  };
  const dimPassed = Object.values(dimResults).every(Boolean);
  const dimScore = Object.values(dimResults).filter(Boolean).length / 4;
  let dimReason = 'dimensions_ok';
  if (!dimPassed) {
    if (!dimResults.width || !dimResults.height) dimReason = 'dimension_mismatch';
    else if (!dimResults.platform) dimReason = 'platform_mismatch';
    else dimReason = 'surface_mismatch';
  }
  const dimensionsCheck = check('dimensions', {
    passed: dimPassed,
    score: dimScore,
    reasonCode: dimReason,
    required: true,
    details: dimResults,
  });

  // --- semantic completeness ---
  let semanticReason = 'edits_match';
  if (plan.edits.length === 0) semanticReason = 'empty_edits';
  else if (missing.length > 0 && extra.length > 0) semanticReason = 'missing_and_extra_edits';
  else if (missing.length > 0) semanticReason = missing[0].reasonCode;
  else if (extra.length > 0) semanticReason = 'extra_edits';
  const semanticScore = Math.max(0, pairs.length - extra.length) / expectedEdits.length;
  const semanticCheck = check('semantic', {
    passed: missing.length === 0 && extra.length === 0,
    score: semanticScore,
    reasonCode: semanticReason,
    required: true,
    details: {
      expectedCount: expectedEdits.length,
      actualCount: plan.edits.length,
      matched: pairs.length,
      missing: missing.length,
      extra: extra.length,
      missingDetail: missing.map((m) => ({ id: m.expected.id, reasonCode: m.reasonCode, iou: m.iou })),
      extraIds: extra.map((e) => e.id),
    },
  });

  // --- geometry (partial credit; matching already enforces minIoU) ---
  const geometryScore = pairs.length > 0 ? pairs.reduce((sum, pair) => sum + pair.iou, 0) / pairs.length : 0;
  const geometryCheck = check('geometry', {
    passed: pairs.length > 0,
    score: geometryScore,
    reasonCode: pairs.length > 0 ? 'geometry_ok' : 'no_matched_edits',
    required: false,
    details: {
      pairs: pairs.map((pair) => ({
        id: pair.expected.id,
        kind: pair.expected.kind,
        iou: Number(pair.iou.toFixed(4)),
        minIoU: editMinIoU(pair.expected),
      })),
      defaultMinIoU: DEFAULT_MIN_IOU,
    },
  });

  // --- preservation (needs both buffers) ---
  let preservationCheck;
  const sourcePng = options.sourcePng;
  const actualPng = options.actualPng;
  if (Buffer.isBuffer(sourcePng) && Buffer.isBuffer(actualPng) && sourcePng.length > 0 && actualPng.length > 0) {
    const result = computePreservation({ caseData, sourceBuffer: sourcePng, actualBuffer: actualPng });
    preservationCheck = check('preservation', {
      passed: result.passed,
      score: result.score,
      reasonCode: result.reasonCode,
      required: true,
      details: result.details,
    });
  } else {
    preservationCheck = check('preservation', {
      passed: null,
      score: null,
      reasonCode: 'preservation_not_evaluated',
      required: false,
      details: { reasonCode: 'buffers_not_provided' },
    });
  }

  // --- text fit (needs renderer output) ---
  let textFitCheck;
  const textFits = options.renderInfo?.textFits;
  if (Array.isArray(textFits)) {
    const failed = textFits.filter((entry) => entry && entry.fits === false);
    textFitCheck = check('text_fit', {
      passed: failed.length === 0,
      score: textFits.length === 0 ? 1 : (textFits.length - failed.length) / textFits.length,
      reasonCode: failed.length === 0 ? 'text_fits' : 'text_overflow',
      required: true,
      details: { entries: textFits, overflowIds: failed.map((entry) => entry.id) },
    });
  } else {
    textFitCheck = check('text_fit', {
      passed: null,
      score: null,
      reasonCode: 'text_fit_not_evaluated',
      required: false,
    });
  }

  const checks = [dimensionsCheck, semanticCheck, geometryCheck, preservationCheck, textFitCheck];
  const scored = checks.filter(
    (entry) => entry.passed !== null && Object.prototype.hasOwnProperty.call(CHECK_WEIGHTS, entry.id),
  );
  const totalWeight = scored.reduce((sum, entry) => sum + CHECK_WEIGHTS[entry.id], 0);
  const score = totalWeight > 0 ? scored.reduce((sum, entry) => sum + CHECK_WEIGHTS[entry.id] * entry.score, 0) / totalWeight : 0;
  const minScore = typeof caseData.expected.minScore === 'number' ? caseData.expected.minScore : DEFAULT_MIN_SCORE;
  const requiredFailed = checks.filter((entry) => entry.required === true && entry.passed === false);
  const passed = requiredFailed.length === 0 && score >= minScore;

  return {
    passed,
    score: Number(score.toFixed(6)),
    checks,
    humanReviewRequired: true,
    minScore,
    weights: CHECK_WEIGHTS,
    requiredFailed: requiredFailed.map((entry) => entry.id),
    counts: {
      expectedEdits: expectedEdits.length,
      actualEdits: plan.edits.length,
      matched: pairs.length,
      missing: missing.length,
      extra: extra.length,
      invalidAssets: 0,
      textOverflow: Array.isArray(textFits) ? textFits.filter((entry) => entry.fits === false).length : null,
    },
  };
}

/** Weighted score helper, exported so callers can document/qa the formula. */
export function weightedScore(checks) {
  const scored = checks.filter(
    (entry) => entry.passed !== null && Object.prototype.hasOwnProperty.call(CHECK_WEIGHTS, entry.id),
  );
  const totalWeight = scored.reduce((sum, entry) => sum + CHECK_WEIGHTS[entry.id], 0);
  if (totalWeight === 0) return 0;
  return scored.reduce((sum, entry) => sum + CHECK_WEIGHTS[entry.id] * entry.score, 0) / totalWeight;
}

export { DEFAULT_MIN_IOU, DEFAULT_MIN_SCORE };
export default scorePlan;

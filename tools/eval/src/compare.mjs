import pixelmatch from 'pixelmatch';
import { PNG_MATCH_THRESHOLD } from './constants.mjs';
import { decodePng, encodePng } from './png.mjs';

// Deterministic PNG comparison. No randomness is involved.
// Returns a structured result; never throws for image-level problems so the
// evaluator can report explicit malformed/dimension failures.
export function comparePngBuffers({ goldBuffer, actualBuffer, maxDiffRatio, produceDiff = true }) {
  let gold;
  let actual;
  try {
    gold = decodePng(goldBuffer);
  } catch (err) {
    return { status: 'malformed', reason: 'gold_malformed', detail: err.message };
  }
  try {
    actual = decodePng(actualBuffer);
  } catch (err) {
    return { status: 'malformed', reason: 'actual_malformed', detail: err.message };
  }
  if (gold.width !== actual.width || gold.height !== actual.height) {
    return {
      status: 'fail',
      reason: 'dimension_mismatch',
      goldWidth: gold.width,
      goldHeight: gold.height,
      actualWidth: actual.width,
      actualHeight: actual.height,
      diffPixels: null,
      diffRatio: null,
    };
  }
  const width = gold.width;
  const height = gold.height;
  const diff = Buffer.alloc(width * height * 4);
  const diffPixels = pixelmatch(gold.data, actual.data, diff, width, height, {
    threshold: PNG_MATCH_THRESHOLD,
  });
  const totalPixels = width * height;
  const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels;
  const pass = diffRatio <= maxDiffRatio;
  return {
    status: pass ? 'pass' : 'fail',
    reason: pass ? 'within_tolerance' : 'pixel_difference',
    width,
    height,
    diffPixels,
    diffRatio,
    maxDiffRatio,
    diffPng: produceDiff ? encodePng({ width, height, data: diff }) : undefined,
  };
}

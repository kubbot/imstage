// Screenshot-edit benchmark: plan and edit schema validation.
//
// A "plan" is the model's or the reference's declarative edit description:
//   { schemaVersion: 1, im, surface, width, height, edits: [Edit], warnings: [] }
//
// Every edit is a bounded local patch over the ORIGINAL screenshot. There is no
// general paint primitive: text patches only carry an escaped literal string
// plus a bounded background/color/typography, image patches only reference an
// authorized local asset id. Paths, URLs, HTML, CSS and scripts are never part
// of the plan language; unknown fields are either stripped when provably inert
// or rejected.
//
// This module is pure (no fs/browser) so it can validate model output before
// any paid provider call, before rendering, and again inside the scorer.

import { fail, isSafeId } from '../util.mjs';
import { MAX_PIXELS } from '../constants.mjs';

export const PLAN_SCHEMA_VERSION = 1;

// Dataset bounds (shared with dataset.mjs).
export const MAX_CASES = 50;
export const MAX_ASSETS = 64;
export const MAX_EDITS_PER_CASE = 128;

// Normalized geometry: 0..1000 on both axes, positive width/height, wholly
// inside the source frame.
export const BOX_SCALE = 1000;
export const BOX_EPSILON = 1e-6;

export const IMS = Object.freeze(['wechat', 'whatsapp', 'instagram']);
export const SURFACES = Object.freeze(['ios', 'desktop']);
export const DIFFICULTIES = Object.freeze([1, 2, 3, 4, 5]);
export const EDIT_KINDS = Object.freeze(['text', 'image']);
export const FONT_WEIGHTS = Object.freeze([400, 500, 600, 700]);
export const ALIGNS = Object.freeze(['left', 'center', 'right']);
export const FITS = Object.freeze(['cover', 'contain']);

export const MIN_FONT_SIZE = 10; // source pixels, schema bound
export const MAX_FONT_SIZE = 160; // source pixels, schema bound
export const MIN_RENDER_FONT_SIZE = 12; // renderer never shrinks below this
export const MAX_RADIUS = 80; // actual source pixels
export const MAX_TEXT_LENGTH = 4000;
export const DEFAULT_FONT_SIZE = 16;
export const MAX_WARNINGS = 50;

export const DEFAULT_MIN_IOU = 0.5;
export const DEFAULT_MIN_SCORE = 0.8;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MODEL_EDIT_KEYS = new Set([
  'id',
  'kind',
  'box',
  'text',
  'assetId',
  'background',
  'color',
  'fontSize',
  'fontWeight',
  'align',
  'radius',
  'fit',
]);
const EXPECTED_EDIT_KEYS = new Set([...MODEL_EDIT_KEYS, 'textVariants', 'minIoU']);
const MODEL_PLAN_KEYS = new Set(['schemaVersion', 'im', 'surface', 'width', 'height', 'edits', 'warnings']);
const STRIP_EDIT_KEYS = new Set(['reason', 'reasoning', 'notes', 'note', 'confidence', 'comment', 'explanation']);
const STRIP_PLAN_KEYS = new Set([
  'reason',
  'reasoning',
  'notes',
  'note',
  'confidence',
  'comment',
  'explanation',
  'meta',
  'metadata',
  'analysis',
  'expectation',
  'expected',
]);

function assertFiniteNumber(value, label) {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    fail('invalid_number', `${label} 必须是有限数字`, 422, { field: label, reasonCode: 'invalid_number' });
  }
  return num;
}

function assertInteger(value, label, { min, max } = {}) {
  const num = assertFiniteNumber(value, label);
  if (!Number.isInteger(num)) {
    fail('invalid_number', `${label} 必须是整数`, 422, { field: label, reasonCode: 'invalid_number' });
  }
  if (min !== undefined && num < min) {
    fail('out_of_range', `${label} 不能小于 ${min}`, 422, { field: label, reasonCode: 'out_of_range' });
  }
  if (max !== undefined && num > max) {
    fail('out_of_range', `${label} 不能大于 ${max}`, 422, { field: label, reasonCode: 'out_of_range' });
  }
  return num;
}

export function validateBox(raw, label = 'box') {
  if (!Array.isArray(raw) || raw.length !== 4) {
    fail('invalid_box', `${label} 必须是 [x, y, width, height] 四元数组`, 422, {
      field: label,
      reasonCode: 'invalid_box',
    });
  }
  const box = raw.map((value, index) => assertFiniteNumber(value, `${label}[${index}]`));
  const [x, y, width, height] = box;
  if (x < 0 || y < 0 || x > BOX_SCALE || y > BOX_SCALE) {
    fail('invalid_box', `${label} 的 x/y 必须在 0..${BOX_SCALE} 之间`, 422, {
      field: label,
      reasonCode: 'box_out_of_frame',
    });
  }
  if (width <= 0 || height <= 0) {
    fail('invalid_box', `${label} 的宽高必须为正数`, 422, { field: label, reasonCode: 'box_not_positive' });
  }
  if (x + width > BOX_SCALE + BOX_EPSILON || y + height > BOX_SCALE + BOX_EPSILON) {
    fail('invalid_box', `${label} 必须完全落在源图范围内 (0..${BOX_SCALE})`, 422, {
      field: label,
      reasonCode: 'box_out_of_frame',
    });
  }
  // Clamp away float noise at the boundary so downstream pixel math is stable.
  return [
    Math.min(x, BOX_SCALE),
    Math.min(y, BOX_SCALE),
    Math.min(width, BOX_SCALE - Math.min(x, BOX_SCALE)),
    Math.min(height, BOX_SCALE - Math.min(y, BOX_SCALE)),
  ];
}

export function validatePreserveRegions(raw, label = 'preserveRegions') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('invalid_field', `${label} 必须是数组`, 422, { field: label });
  return raw.map((box, index) => validateBox(box, `${label}[${index}]`));
}

function validateHexColor(raw, label, warnings) {
  if (raw === undefined || raw === null || raw === '') {
    warnings.push(`missing_field:${label}`);
    return '#FFFFFF';
  }
  if (typeof raw !== 'string' || !HEX_COLOR_RE.test(raw)) {
    fail('invalid_color', `${label} 必须是 #RRGGBB`, 422, { field: label, reasonCode: 'invalid_color' });
  }
  return raw.toUpperCase();
}

function normalizeTextValue(value, label) {
  if (typeof value !== 'string') {
    fail('invalid_field', `${label} 必须是字符串`, 422, { field: label, reasonCode: 'invalid_text' });
  }
  if (value.length > MAX_TEXT_LENGTH) {
    fail('too_long', `${label} 超过 ${MAX_TEXT_LENGTH} 字符上限`, 422, { field: label, reasonCode: 'text_too_long' });
  }
  return value;
}

export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * Validate and normalize one edit.
 *
 * @param {object} raw
 * @param {object} options
 * @param {string} options.label
 * @param {'model'|'expected'|'render'} options.mode
 * @param {string[]|Set<string>|null} options.authorizedAssetIds
 * @param {string[]} options.warnings mutable collector
 */
export function validateEdit(raw, { label = 'edit', mode = 'model', authorizedAssetIds = null, warnings = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_edit', `${label} 必须是对象`, 422, { field: label, reasonCode: 'invalid_edit' });
  }
  const expectedMode = mode === 'expected' || mode === 'render';
  const allowed = expectedMode ? EXPECTED_EDIT_KEYS : MODEL_EDIT_KEYS;
  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) continue;
    if (STRIP_EDIT_KEYS.has(key)) {
      warnings.push(`stripped_field:${key}`);
      continue;
    }
    if (!expectedMode && (key === 'textVariants' || key === 'minIoU')) {
      // Scoring-only hints are never accepted from the model.
      warnings.push(`stripped_scoring_field:${key}`);
      continue;
    }
    fail('unknown_field', `${label} 含未知字段: ${key}`, 422, { field: key, reasonCode: 'unknown_field' });
  }

  const id = raw.id;
  if (!isSafeId(id)) {
    fail('unsafe_id', `${label}.id 不合法（字母、数字、下划线、连字符，1-80 位）`, 422, {
      field: 'id',
      reasonCode: 'unsafe_id',
    });
  }
  if (!EDIT_KINDS.includes(raw.kind)) {
    fail('invalid_enum', `${label}.kind 只能是 text 或 image`, 422, { field: 'kind', reasonCode: 'invalid_kind' });
  }
  const kind = raw.kind;
  const box = validateBox(raw.box, `${label}.box`);
  const background = validateHexColor(raw.background, `${label}.background`, warnings);
  const color = validateHexColor(raw.color, `${label}.color`, warnings);

  let text;
  let assetId;
  let textVariants;
  let minIoU;
  if (kind === 'text') {
    if (raw.assetId !== undefined && raw.assetId !== null && raw.assetId !== '') {
      fail('invalid_edit', `${label}: text 编辑不能带 assetId`, 422, { field: 'assetId', reasonCode: 'field_not_allowed' });
    }
    if (raw.text === undefined || raw.text === null) {
      fail('missing_field', `${label}.text 不能为空`, 422, { field: 'text', reasonCode: 'missing_text' });
    }
    text = normalizeTextValue(raw.text, `${label}.text`);
    if (expectedMode) {
      if (raw.textVariants !== undefined && raw.textVariants !== null) {
        if (!Array.isArray(raw.textVariants)) {
          fail('invalid_field', `${label}.textVariants 必须是字符串数组`, 422, { field: 'textVariants' });
        }
        textVariants = raw.textVariants.map((v, i) => normalizeTextValue(v, `${label}.textVariants[${i}]`));
      }
      if (raw.minIoU !== undefined && raw.minIoU !== null) {
        minIoU = assertFiniteNumber(raw.minIoU, `${label}.minIoU`);
        if (minIoU < 0 || minIoU > 1) {
          fail('out_of_range', `${label}.minIoU 必须在 0..1 之间`, 422, { field: 'minIoU' });
        }
      }
    }
  } else {
    if (raw.text !== undefined && raw.text !== null) {
      fail('invalid_edit', `${label}: image 编辑不能带 text`, 422, { field: 'text', reasonCode: 'field_not_allowed' });
    }
    if (!isSafeId(raw.assetId)) {
      fail('unsafe_id', `${label}.assetId 不合法`, 422, { field: 'assetId', reasonCode: 'unsafe_id' });
    }
    assetId = raw.assetId;
    if (authorizedAssetIds) {
      const allowedIds = authorizedAssetIds instanceof Set ? authorizedAssetIds : new Set(authorizedAssetIds);
      if (!allowedIds.has(assetId)) {
        fail('unauthorized_asset', `${label}.assetId 不在本用例授权素材中`, 422, {
          field: 'assetId',
          reasonCode: 'invalid_asset',
        });
      }
    }
  }

  let fontSize;
  if (raw.fontSize !== undefined && raw.fontSize !== null) {
    fontSize = assertFiniteNumber(raw.fontSize, `${label}.fontSize`);
    if (fontSize < MIN_FONT_SIZE || fontSize > MAX_FONT_SIZE) {
      fail('out_of_range', `${label}.fontSize 必须在 ${MIN_FONT_SIZE}..${MAX_FONT_SIZE} 源像素之间`, 422, {
        field: 'fontSize',
        reasonCode: 'out_of_range',
      });
    }
  }

  let fontWeight;
  if (raw.fontWeight !== undefined && raw.fontWeight !== null) {
    fontWeight = assertInteger(raw.fontWeight, `${label}.fontWeight`);
    if (!FONT_WEIGHTS.includes(fontWeight)) {
      fail('invalid_enum', `${label}.fontWeight 只能是 ${FONT_WEIGHTS.join(', ')}`, 422, { field: 'fontWeight' });
    }
  }

  let align;
  if (raw.align !== undefined && raw.align !== null) {
    if (!ALIGNS.includes(raw.align)) {
      fail('invalid_enum', `${label}.align 只能是 ${ALIGNS.join(', ')}`, 422, { field: 'align' });
    }
    align = raw.align;
  }

  let radius;
  if (raw.radius !== undefined && raw.radius !== null) {
    radius = assertFiniteNumber(raw.radius, `${label}.radius`);
    if (radius < 0 || radius > MAX_RADIUS) {
      fail('out_of_range', `${label}.radius 必须在 0..${MAX_RADIUS} 源像素之间`, 422, { field: 'radius' });
    }
  }

  let fit;
  if (raw.fit !== undefined && raw.fit !== null) {
    if (!FITS.includes(raw.fit)) {
      fail('invalid_enum', `${label}.fit 只能是 ${FITS.join(', ')}`, 422, { field: 'fit' });
    }
    fit = raw.fit;
  }

  const edit = { id, kind, box, background, color };
  if (kind === 'text') {
    edit.text = text;
    edit.fontSize = fontSize ?? DEFAULT_FONT_SIZE;
    edit.fontWeight = fontWeight ?? 400;
    edit.align = align ?? 'left';
  } else {
    edit.assetId = assetId;
    edit.fit = fit ?? 'cover';
  }
  if (radius !== undefined) edit.radius = radius;
  if (textVariants !== undefined) edit.textVariants = textVariants;
  if (minIoU !== undefined) edit.minIoU = minIoU;
  return edit;
}

/**
 * Validate a full plan.
 *
 * @param {object} raw
 * @param {object} options
 * @param {'model'|'expected'|'render'} options.mode
 * @param {string[]|Set<string>|null} options.authorizedAssetIds
 * @returns {{ plan: object, warnings: string[] }}
 */
export function validatePlan(raw, { mode = 'model', authorizedAssetIds = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('invalid_plan', 'plan 必须是对象', 422, { reasonCode: 'invalid_plan' });
  }
  const warnings = [];
  const expectedMode = mode === 'expected' || mode === 'render';
  for (const key of Object.keys(raw)) {
    if (MODEL_PLAN_KEYS.has(key)) continue;
    if (STRIP_PLAN_KEYS.has(key)) {
      warnings.push(`stripped_field:${key}`);
      continue;
    }
    fail('unknown_field', `plan 含未知字段: ${key}`, 422, { field: key, reasonCode: 'unknown_field' });
  }
  if (raw.schemaVersion !== PLAN_SCHEMA_VERSION) {
    fail('invalid_plan', `plan.schemaVersion 必须是 ${PLAN_SCHEMA_VERSION}`, 422, {
      field: 'schemaVersion',
      reasonCode: 'invalid_schema_version',
    });
  }
  if (!IMS.includes(raw.im)) {
    fail('invalid_enum', `plan.im 只能是 ${IMS.join(', ')}`, 422, { field: 'im', reasonCode: 'invalid_im' });
  }
  if (!SURFACES.includes(raw.surface)) {
    fail('invalid_enum', `plan.surface 只能是 ${SURFACES.join(', ')}`, 422, {
      field: 'surface',
      reasonCode: 'invalid_surface',
    });
  }
  const width = assertInteger(raw.width, 'plan.width', { min: 1, max: 20000 });
  const height = assertInteger(raw.height, 'plan.height', { min: 1, max: 20000 });
  if (width * height > MAX_PIXELS) {
    fail('out_of_range', 'plan 宽高像素超过 8MP 上限', 422, { field: 'width', reasonCode: 'out_of_range' });
  }
  if (!Array.isArray(raw.edits)) {
    fail('invalid_plan', 'plan.edits 必须是数组', 422, { field: 'edits', reasonCode: 'invalid_edits' });
  }
  if (raw.edits.length > MAX_EDITS_PER_CASE) {
    fail('too_many_edits', `plan.edits 超过 ${MAX_EDITS_PER_CASE} 上限`, 422, {
      field: 'edits',
      reasonCode: 'too_many_edits',
    });
  }
  const seen = new Set();
  const edits = raw.edits.map((edit, index) => {
    const normalized = validateEdit(edit, {
      label: `edits[${index}]`,
      mode,
      authorizedAssetIds,
      warnings,
    });
    if (seen.has(normalized.id)) {
      fail('duplicate_id', `plan.edits 含重复 id: ${normalized.id}`, 422, {
        field: 'id',
        reasonCode: 'duplicate_id',
      });
    }
    seen.add(normalized.id);
    return normalized;
  });

  let planWarnings = [];
  if (raw.warnings !== undefined && raw.warnings !== null) {
    if (!Array.isArray(raw.warnings)) {
      fail('invalid_field', 'plan.warnings 必须是字符串数组', 422, { field: 'warnings' });
    }
    planWarnings = raw.warnings
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim().slice(0, 500))
      .slice(0, MAX_WARNINGS);
  }

  return {
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      im: raw.im,
      surface: raw.surface,
      width,
      height,
      edits,
      warnings: planWarnings,
    },
    warnings: [...warnings, ...planWarnings],
  };
}

/**
 * Build a render-ready plan from a dataset case's curated expected edits.
 * `textVariants`/`minIoU` are preserved so the scorer can use them.
 */
export function planFromExpected(caseData) {
  const { plan } = validatePlan(
    {
      schemaVersion: PLAN_SCHEMA_VERSION,
      im: caseData.im,
      surface: caseData.surface,
      width: caseData.source.width,
      height: caseData.source.height,
      edits: caseData.expected.edits,
      warnings: [],
    },
    { mode: 'expected', authorizedAssetIds: caseData.assetIds ?? null },
  );
  return plan;
}

export function planFromModel(rawPlan, { authorizedAssetIds = null } = {}) {
  const { plan, warnings } = validatePlan(rawPlan, { mode: 'model', authorizedAssetIds });
  return { plan, warnings };
}

export function boxToPixels(box, width, height) {
  const [x, y, w, h] = box;
  return {
    x: (x / BOX_SCALE) * width,
    y: (y / BOX_SCALE) * height,
    width: (w / BOX_SCALE) * width,
    height: (h / BOX_SCALE) * height,
  };
}

export function boxIoU(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const left = Math.max(ax, bx);
  const top = Math.max(ay, by);
  const right = Math.min(ax + aw, bx + bw);
  const bottom = Math.min(ay + ah, by + bh);
  const interW = Math.max(0, right - left);
  const interH = Math.max(0, bottom - top);
  const intersection = interW * interH;
  const union = aw * ah + bw * bh - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

/** Max absolute side delta, in source pixels, between two normalized boxes. */
export function rectDeltaPx(a, b, width, height) {
  const pa = boxToPixels(a, width, height);
  const pb = boxToPixels(b, width, height);
  return Math.max(
    Math.abs(pa.x - pb.x),
    Math.abs(pa.y - pb.y),
    Math.abs(pa.width - pb.width),
    Math.abs(pa.height - pb.height),
  );
}

export function contentMatchesEdit(expectedEdit, actualEdit) {
  if (expectedEdit.kind !== actualEdit.kind) return false;
  if (expectedEdit.kind === 'image') return expectedEdit.assetId === actualEdit.assetId;
  const actual = normalizeText(actualEdit.text);
  if (actual === normalizeText(expectedEdit.text)) return true;
  const variants = Array.isArray(expectedEdit.textVariants) ? expectedEdit.textVariants : [];
  return variants.some((variant) => normalizeText(variant) === actual);
}

export function editMinIoU(edit) {
  return typeof edit.minIoU === 'number' ? edit.minIoU : DEFAULT_MIN_IOU;
}

export default { validatePlan, validateEdit, planFromExpected, planFromModel };

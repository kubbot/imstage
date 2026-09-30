/**
 * IMStage shared mandatory "AI生成 / 虚构" disclosure helpers.
 *
 * The disclosure is *unconditional* since the 2026-09-30 safety policy:
 * every rendered preview and every PNG export (including crops and MCP
 * renders) shows the mark, and it cannot be turned off through the UI, the
 * Agent, an import or the API. The rendering layer draws it from
 * `packages/schema/policy.mjs`; this module only keeps the historical helper
 * names working with the new "always on" semantics.
 *
 * `Scene.watermark` remains an optional *custom* note. It is never used to
 * carry (or hide) the mandatory disclosure any more.
 */

import { DISCLOSURE_SHORT, DISCLOSURE_TEXT } from './policy.mjs';

/** Historical name kept for stored data / callers; now the mandatory mark. */
export const FICTIONAL_MARK_LABEL = DISCLOSURE_SHORT;

/** Full bilingual disclosure text used on rendered frames and exports. */
export const MANDATORY_DISCLOSURE = DISCLOSURE_TEXT;

/** Legacy detection: a stored watermark equal to the old or new label. */
export function isFictionalMark(value, label = FICTIONAL_MARK_LABEL) {
  return typeof value === 'string' && (value === label || value === '虚构对话');
}

/**
 * Historical "apply an on/off intent" helper. The intent is ignored: the
 * disclosure cannot be disabled anywhere. The custom watermark is preserved
 * exactly as supplied.
 */
export function applyFictionalMark(watermark, _enabledIgnored, _label = FICTIONAL_MARK_LABEL) {
  return typeof watermark === 'string' ? watermark : '';
}

/** Switch state: the mark is always on. */
export function fictionalMarkOn(_watermark, _label = FICTIONAL_MARK_LABEL) {
  return true;
}

/** New scenes no longer store the mark in `watermark`; rendering adds it. */
export function newSceneWatermark(_enabled = true, _label = FICTIONAL_MARK_LABEL) {
  return '';
}

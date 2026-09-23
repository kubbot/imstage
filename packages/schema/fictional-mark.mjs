/**
 * IMStage shared "fictional conversation" mark helpers.
 *
 * The image mark is represented by the existing `Scene.watermark` string. These
 * helpers are deliberately tiny and framework-free so the Web editor, the
 * onboarding preview, the MCP default fill and the tests all agree on exactly
 * one definition of "the mark is on/off".
 *
 * Semantics that the UI and API rely on:
 *   - Turning the mark ON sets the fictional label only when nothing is shown.
 *     A custom (unrelated) watermark is never overwritten.
 *   - Turning the mark OFF clears only the exact fictional label. A custom
 *     watermark is preserved unless the user explicitly edits the watermark.
 */

/** Default image label. Kept in one place so the preview and export agree. */
export const FICTIONAL_MARK_LABEL = '虚构对话';

/** True when the string is exactly the fictional label (never a custom mark). */
export function isFictionalMark(value, label = FICTIONAL_MARK_LABEL) {
  return typeof value === 'string' && value === label;
}

/**
 * Apply an on/off intent to an existing watermark.
 *
 * @param {unknown} watermark current `Scene.watermark`
 * @param {boolean} enabled desired switch state
 * @param {string} label fictional label
 * @returns {string} the next watermark string
 */
export function applyFictionalMark(watermark, enabled, label = FICTIONAL_MARK_LABEL) {
  const current = typeof watermark === 'string' ? watermark : '';
  if (enabled) return current === '' ? label : current;
  return current === label ? '' : current;
}

/** Switch state: only the exact fictional label reads as "on". */
export function fictionalMarkOn(watermark, label = FICTIONAL_MARK_LABEL) {
  return isFictionalMark(watermark, label);
}

/** Watermark applied to a brand new scene that has no prior custom value. */
export function newSceneWatermark(enabled, label = FICTIONAL_MARK_LABEL) {
  return enabled ? label : '';
}

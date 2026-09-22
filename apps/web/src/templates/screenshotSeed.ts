/**
 * Session-scoped hand-off contract for the screenshot → template starter.
 * Kept framework-free so both the template library and the creator workspace
 * can read it without importing each other's component tree.
 *
 * The payload is read *without* consuming it. The caller clears only the exact
 * payload it successfully turned into a durable session, so a storage failure
 * keeps the uploaded image and the explicit reconstruct/preserve choice.
 */
export const TEMPLATE_SCREENSHOT_KEY = 'imstage.templates.screenshot';

/** Same bound the attachment pipeline accepts for one reference image. */
export const MAX_SCREENSHOT_CHARS = 6 * 1024 * 1024;

export type TemplateScreenshotMode = 'reconstruct' | 'preserve';

export interface ScreenshotSeed { source: string; mode: TemplateScreenshotMode }

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

function parseSeed(raw: unknown): ScreenshotSeed | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as { source?: unknown; mode?: unknown };
  if (typeof value.source !== 'string' || value.source.length > MAX_SCREENSHOT_CHARS || !DATA_URL.test(value.source)) return null;
  if (value.mode !== 'reconstruct' && value.mode !== 'preserve') return null;
  return { source: value.source, mode: value.mode };
}

/** Read (but never remove) the validated screenshot starter payload. */
export function readTemplateScreenshot(): ScreenshotSeed | null {
  try {
    const raw = sessionStorage.getItem(TEMPLATE_SCREENSHOT_KEY);
    if (!raw) return null;
    return parseSeed(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Remove the stored payload only when it is byte-identical to the one that was
 * read and durably persisted. A newer/foreign payload is left untouched.
 */
export function clearTemplateScreenshot(seed: ScreenshotSeed): void {
  try {
    const raw = sessionStorage.getItem(TEMPLATE_SCREENSHOT_KEY);
    if (!raw) return;
    const current = parseSeed(JSON.parse(raw));
    if (current && current.source === seed.source && current.mode === seed.mode) {
      sessionStorage.removeItem(TEMPLATE_SCREENSHOT_KEY);
    }
  } catch {
    /* cleanup is best effort; the durable session already exists */
  }
}

export function isTemplateScreenshotMode(value: unknown): value is TemplateScreenshotMode {
  return value === 'reconstruct' || value === 'preserve';
}

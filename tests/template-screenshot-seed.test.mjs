/**
 * Screenshot → template seed lifecycle.
 *
 * The payload must be read without being consumed, and only the exact payload
 * that was durably turned into a session may be cleared. A stale clear must
 * never remove a newer upload.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

globalThis.sessionStorage = new MemoryStorage();
const {
  TEMPLATE_SCREENSHOT_KEY,
  MAX_SCREENSHOT_CHARS,
  readTemplateScreenshot,
  clearTemplateScreenshot,
} = await import('../apps/web/src/templates/screenshotSeed.ts');

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dN4AAAAASUVORK5CYII=';
const write = (value) => sessionStorage.setItem(TEMPLATE_SCREENSHOT_KEY, JSON.stringify(value));

test('reading the seed never consumes it and clearing only removes the exact payload', () => {
  write({ source: IMAGE, mode: 'preserve' });
  const first = readTemplateScreenshot();
  assert.deepEqual(first, { source: IMAGE, mode: 'preserve' });
  assert.equal(readTemplateScreenshot()?.mode, 'preserve', 'read is non-destructive');
  clearTemplateScreenshot(first);
  assert.equal(readTemplateScreenshot(), null);

  // A newer payload that appeared after the read must survive a stale clear.
  write({ source: IMAGE, mode: 'reconstruct' });
  const stale = { source: IMAGE, mode: 'preserve' };
  write({ source: `${IMAGE.slice(0, -8)}AAAA=`, mode: 'preserve' });
  clearTemplateScreenshot(stale);
  assert.notEqual(readTemplateScreenshot(), null, 'a different upload is not removed');
});

test('invalid, hostile and oversized seeds are rejected without throwing', () => {
  for (const raw of [
    '{not json',
    JSON.stringify({ source: 'https://example.com/a.png', mode: 'preserve' }),
    JSON.stringify({ source: IMAGE, mode: 'convert' }),
    JSON.stringify({ source: 'data:image/svg+xml;base64,PHN2Zy8+', mode: 'preserve' }),
    JSON.stringify({ source: `data:image/png;base64,${'A'.repeat(MAX_SCREENSHOT_CHARS)}`, mode: 'preserve' }),
    JSON.stringify(null),
  ]) {
    sessionStorage.setItem(TEMPLATE_SCREENSHOT_KEY, raw);
    assert.equal(readTemplateScreenshot(), null, `should reject: ${raw.slice(0, 60)}`);
  }
  sessionStorage.removeItem(TEMPLATE_SCREENSHOT_KEY);
  assert.equal(readTemplateScreenshot(), null);
});

// Capture synthetic design evidence. Run with IMSTAGE_ARTIFACT_DIR set to a
// task-owned artifact directory; do not capture private user conversations.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const output = process.env.IMSTAGE_ARTIFACT_DIR;
if (!output) throw new Error('Set IMSTAGE_ARTIFACT_DIR to the task artifact directory.');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.IMSTAGE_BROWSER === 'chromium' ? undefined : 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const base = process.env.IMSTAGE_PREVIEW_URL || 'http://127.0.0.1:4417';
try {
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(base);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(output, `home-${theme}.png`) });
    await page.locator('.gallery-section').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `gallery-${theme}.png`) });
    await page.locator('.open-section').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `integration-${theme}.png`) });
    await page.goto(`${base}/#/studio`);
    await page.locator('.studio-phone').waitFor();
    await page.screenshot({ path: path.join(output, `studio-${theme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.screenshot({ path: path.join(output, 'home-mobile.png') });
  await page.getByRole('tab', { name: '实时画面' }).click();
  await page.locator('.creation-output-panel').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'home-mobile-preview.png') });
  await page.goto(`${base}/#/studio`);
  await page.getByRole('tab', { name: '预览', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'studio-mobile.png') });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Saved 11 screenshots to ${output}; no uncaught browser errors.`);
} finally { await browser.close(); }

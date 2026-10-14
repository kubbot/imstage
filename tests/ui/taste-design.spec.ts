import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { assertDisclosureInPng } from './pngEvidence';

test('quick editing reaches the downloaded PNG and continues without a model call', async ({ page }) => {
  const paidRequests: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/api/agent/')) paidRequests.push(request.url());
  });
  await page.goto('/?lang=en');
  await expect(page.getByTestId('hero-export')).toBeEnabled();
  await expect(page.locator('.journey-note-status')).toBeEmpty();
  const originalDownload = page.waitForEvent('download');
  await page.getByTestId('hero-export').click();
  const originalFile = test.info().outputPath('original-sample.png');
  await (await originalDownload).saveAs(originalFile);
  const reply = 'Friday is confirmed. Bring the notebook.';
  await page.getByLabel('Try a different reply', { exact: true }).fill(reply);
  await expect(page.locator('.journey-device')).toContainText(reply);
  await expect(page.locator('#journey-line')).toHaveValue(reply);
  await expect(page.locator('.journey-note-status')).toHaveText('Updated in the scene');

  const download = page.waitForEvent('download');
  await page.getByTestId('hero-export').click();
  const file = test.info().outputPath('edited-sample.png');
  await (await download).saveAs(file);
  await assertDisclosureInPng(file);
  const originalPixels = await sharp(originalFile).raw().toBuffer();
  const editedPixels = await sharp(file).raw().toBuffer();
  expect(editedPixels.length).toBe(originalPixels.length);
  let changed = 0;
  for (let i = 0; i < editedPixels.length; i++) if (editedPixels[i] !== originalPixels[i]) changed++;
  expect(changed, 'the real downloaded frame changes when the line is edited').toBeGreaterThan(1000);

  await page.locator('.journey-note-continue').click();
  await expect(page).toHaveURL(/#\/create\?.*handoff=/);
  await expect(page.locator('.agent-phone')).toContainText(reply);
  expect(paidRequests).toEqual([]);
});

test('short desktop keeps the product, quick edit and export action in view', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?lang=zh');
  await expect(page.getByTestId('hero-export')).toBeEnabled();
  await expect(page.getByTestId('hero-start')).toBeInViewport();
  await expect(page.getByTestId('hero-export')).toBeInViewport();
  await expect(page.getByLabel('试改一句', { exact: true })).toBeInViewport();
  const phone = (await page.locator('.journey-device').boundingBox())!;
  const note = (await page.locator('.journey-note').boundingBox())!;
  expect(phone.y + phone.height).toBeLessThanOrEqual(720);
  expect(note.x).toBeGreaterThanOrEqual(phone.x + phone.width);
});

test('choosing a scenario retains its button position and keyboard focus', async ({ page }) => {
  await page.goto('/?lang=zh');
  await expect(page.getByTestId('hero-export')).toBeEnabled();
  const choice = page.getByRole('button', { name: /周末看海/ });
  await choice.scrollIntoViewIfNeeded();
  await choice.focus();
  const before = (await choice.boundingBox())!;
  await choice.press('Enter');
  await expect(choice).toHaveAttribute('aria-pressed', 'true');
  await expect(choice).toBeFocused();
  const after = (await choice.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  expect(Math.abs(after.height - before.height)).toBeLessThan(2);
  await expect(page.locator('.mark-feature-name')).toHaveText('周末看海');
});

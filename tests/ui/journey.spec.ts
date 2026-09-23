import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

// The landing animation is an authored scene. Browsing/editing must not
// accidentally invoke a paid Agent request.
test('scroll chapters expose real editing and independent people without an AI call', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/agent/')) requests.push(request.url()); });
  await page.goto('/?lang=zh');
  await expect(page.getByTestId('hero-export')).toBeEnabled();
  await expect(page.locator('.mark-story-controls')).toHaveCount(0);
  // A quiet, localized chapter caption follows the sticky scene itself.
  const stageNote = page.locator('.journey-chapter-note');
  await expect(stageNote).toBeVisible();
  await expect(stageNote).toContainText('01 / 03');
  await expect(stageNote).toContainText('从一句话开始');
  const device = page.locator('.journey-device');
  await expect(device).toContainText('你到哪里了？');
  await page.locator('#journey-edit').scrollIntoViewIfNeeded();
  await expect(page.locator('.journey')).toHaveAttribute('data-journey-step', '1');
  await expect(stageNote).toContainText('02 / 03');
  await expect(stageNote).toContainText('每一处都能改');
  await page.getByLabel('改一句，画面随之改变', { exact: true }).fill('我看到你了，路灯旁边等我。');
  await expect(device).toContainText('我看到你了，路灯旁边等我。');
  await page.locator('#journey-projects').scrollIntoViewIfNeeded();
  await expect(page.locator('.journey')).toHaveAttribute('data-journey-step', '2');
  await expect(stageNote).toContainText('03 / 03');
  await expect(stageNote).toContainText('从一张到一组');
  expect(await page.locator('.journey-paper-back span').first().evaluate(element => getComputedStyle(element).writingMode)).toBe('horizontal-tb');
  const original = await device.locator('.scene-image img').getAttribute('src');
  await page.getByRole('button', { name: /02.*阿禾/ }).click();
  await expect(device).toContainText('阿禾');
  await expect(device).toContainText('我点好咖啡了');
  await expect.poll(() => device.locator('.scene-image img').getAttribute('src')).not.toBe(original);
  await page.locator('#journey-edit').scrollIntoViewIfNeeded();
  await expect(device).toContainText('我看到你了，路灯旁边等我。');
  expect(requests).toEqual([]);
});

test('English mobile and reduced motion retain editable examples without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?lang=en');
  await expect(page.getByTestId('hero-start')).toHaveText(/Send/);
  await expect(page.locator('.journey-chapter-note')).toContainText('Start with a line');
  await page.locator('#journey-edit').scrollIntoViewIfNeeded();
  await expect(page.locator('.journey-chapter-note')).toContainText('Make it yours');
  await page.getByLabel('Change a line. See it in the scene.', { exact: true }).fill('Wait by the bookshop. I can see you.');
  await expect(page.locator('#journey-edit .journey-mobile-preview')).toContainText('Wait by the bookshop. I can see you.');
  await expect(page.locator('.journey-device .scene-view')).toHaveAttribute('data-platform', 'whatsapp');
  expect(await page.locator('.journey-device').evaluate(element => getComputedStyle(element).transform)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#mark-scenarios').scrollIntoViewIfNeeded();
  await expect(page.locator('.mark-scenario')).toHaveCount(8);
  await expect(page.locator('#mark-scenarios')).toContainText('A thoughtful follow-up');
});

test('direct message selection opens its real field and export contains a valid PNG', async ({ page }) => {
  await page.goto('/?lang=en');
  await expect(page.getByTestId('hero-export')).toBeEnabled();
  await page.locator('.journey-device .scene-message-select').filter({ hasText: 'Where are you?' }).click();
  await expect(page.locator('#journey-line')).toHaveValue('Where are you?');
  await page.locator('#journey-line').fill('Are you near the corner?');
  await expect(page.locator('.journey-device')).toContainText('Are you near the corner?');
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('hero-export').click();
  const download = await downloaded;
  const file = await download.path();
  expect(file).toBeTruthy();
  const bytes = await fs.readFile(file!);
  expect([...bytes.subarray(0, 8)]).toEqual([137,80,78,71,13,10,26,10]);
  expect(bytes.readUInt32BE(16)).toBe(1206);
  expect(bytes.readUInt32BE(20)).toBe(2622);
});

test('sending an idea stages a fresh intent even when every example image fails', async ({ page }) => {
  await page.route('**/assets/people/**', route => route.abort());
  await page.route('**/assets/stories/**', route => route.abort());
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('imstage.marketing.handoff.')) (window as unknown as { stagedHandoff: unknown }).stagedHandoff = JSON.parse(value);
      return original.call(this, key, value);
    };
  });
  await page.goto('/?lang=en');
  await page.getByLabel('Your instruction', { exact: true }).fill('A support conversation about a delayed parcel.');
  await page.getByTestId('hero-start').click();
  await expect(page).toHaveURL(/#\/create\?/);
  const handoff = await page.evaluate(() => (window as unknown as { stagedHandoff: { scene: { messages: unknown[] }; intent: { status: string; prompt: string } } }).stagedHandoff);
  expect(handoff.scene.messages).toEqual([]);
  expect(handoff.intent.status).toBe('staged');
  expect(handoff.intent.prompt).toBe('A support conversation about a delayed parcel.');
});


test('a mobile variation continues with the selected person and photo', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('imstage.marketing.handoff.')) (window as unknown as { stagedHandoff: unknown }).stagedHandoff = JSON.parse(value);
      return original.call(this, key, value);
    };
  });
  await page.goto('/?lang=en');
  await expect(page.getByTestId('hero-export')).toBeEnabled();
  await page.locator('#journey-projects').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /02.*Ava/ }).click();
  const preview = page.locator('#journey-projects .journey-mobile-preview');
  await expect(preview).toContainText('Ava');
  const photo = await preview.locator('.scene-image img').getAttribute('src');
  await page.locator('#journey-projects .journey-mobile-action').click();
  await expect(page).toHaveURL(/#\/create\?/);
  const handoff = await page.evaluate(() => (window as unknown as { stagedHandoff: { scene: { selfId: string; participants: { id: string; name: string }[]; messages: { type: string; asset?: string }[] }; intent?: unknown } }).stagedHandoff);
  expect(handoff.scene.participants.find(person => person.id !== handoff.scene.selfId)?.name).toBe('Ava');
  expect(handoff.scene.messages.find(message => message.type === 'image')?.asset).toBe(photo);
  expect(handoff.intent).toBeUndefined();
});

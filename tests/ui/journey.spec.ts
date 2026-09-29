import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import { assertDisclosureInPng } from './pngEvidence';

// The landing animation is an authored synthetic sample. Browsing/editing must
// not accidentally invoke a paid Agent request. Since the 2026-09-30 safety
// change the hero is positioned as synthetic conversations for testing and
// evaluation (fixed context, controlled variants), and every export carries the
// mandatory AI生成 / 虚构 disclosure band.

test('scroll chapters expose real editing and controlled variants without an AI call', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/agent/')) requests.push(request.url()); });
  await page.goto('/?lang=zh');
  await expect(page.getByTestId('hero-export')).toBeEnabled();
  await expect(page.locator('.mark-story-controls')).toHaveCount(0);

  // The actual hero headline is the evaluation/test positioning.
  await expect(page.locator('.journey-intro h1')).toContainText('合成对话');
  await expect(page.locator('.journey-intro h1')).toContainText('用于测试与评测');

  // The mandatory disclosure band is rendered inside the hero frame viewport.
  const device = page.locator('.journey-device');
  const band = device.locator('.imstage-disclosure');
  await expect(band).toContainText('AI生成 / 虚构');
  // Measure in one animation frame so the landing entrance transform cannot
  // move the device between separate browser round trips.
  const { deviceBox, bandBox, belowStatus } = await device.evaluate(element => ({
    deviceBox: element.getBoundingClientRect().toJSON(),
    bandBox: element.querySelector('.imstage-disclosure')!.getBoundingClientRect().toJSON(),
    belowStatus: (() => {
      const band = element.querySelector<HTMLElement>('.imstage-disclosure')!;
      const status = element.querySelector<HTMLElement>('.scene-status')!;
      return band.offsetTop >= status.offsetTop + status.offsetHeight - 1;
    })(),
  }));
  // Layout offsets ignore the whole phone’s decorative rotation.
  expect(belowStatus).toBe(true);
  expect(bandBox.y).toBeGreaterThanOrEqual(deviceBox.y - 1);
  expect(bandBox.y + bandBox.height).toBeLessThanOrEqual(deviceBox.y + deviceBox.height + 1);

  const stageNote = page.locator('.journey-chapter-note');
  await expect(stageNote).toBeVisible();
  await expect(stageNote).toContainText('01 / 03');
  await expect(stageNote).toContainText('给出固定上下文');
  await expect(device).toContainText('这周末要不要一起去看展？');

  await page.locator('#journey-edit').scrollIntoViewIfNeeded();
  await expect(page.locator('.journey')).toHaveAttribute('data-journey-step', '1');
  await expect(stageNote).toContainText('02 / 03');
  await expect(stageNote).toContainText('按需修改措辞');
  await page.getByLabel('改一句，画面随之改变', { exact: true }).fill('这周末要不要一起去看评测展？');
  await expect(device).toContainText('这周末要不要一起去看评测展？');

  await page.locator('#journey-projects').scrollIntoViewIfNeeded();
  await expect(page.locator('.journey')).toHaveAttribute('data-journey-step', '2');
  await expect(stageNote).toContainText('03 / 03');
  await expect(stageNote).toContainText('生成可控变体');
  await page.getByRole('button', { name: /02.*样本 B/ }).click();
  await expect(device).toContainText('样本 B');
  await expect(device).toContainText('我周五之前给你一个确定的答复。');
  await page.locator('#journey-edit').scrollIntoViewIfNeeded();
  await expect(device).toContainText('这周末要不要一起去看评测展？');
  expect(requests).toEqual([]);
});

test('English mobile and reduced motion retain editable examples without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?lang=en');
  await expect(page.getByTestId('hero-start')).toHaveText(/Send/);
  await expect(page.locator('.journey-chapter-note')).toContainText('Fix the context');
  await page.locator('#journey-edit').scrollIntoViewIfNeeded();
  await expect(page.locator('.journey-chapter-note')).toContainText('Adjust the wording');
  await page.getByLabel('Change a line. See it in the scene.', { exact: true }).fill('Not sure yet — can I confirm on Friday?');
  await expect(page.locator('#journey-edit .journey-mobile-preview')).toContainText('Not sure yet — can I confirm on Friday?');
  // Generic IMStage skin only — no platform chrome in public output.
  await expect(page.locator('.journey-device .scene-view')).toHaveAttribute('data-skin', 'imstage-generic');
  expect(await page.locator('.journey-device').evaluate(element => getComputedStyle(element).transform)).toBe('none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#mark-scenarios').scrollIntoViewIfNeeded();
  await expect(page.locator('.mark-scenario')).toHaveCount(8);
  await expect(page.locator('#mark-scenarios')).toContainText('A thoughtful follow-up');
});

test('direct message selection opens its real field and export PNG carries the disclosure', async ({ page }) => {
  await page.goto('/?lang=en');
  await expect(page.getByTestId('hero-export')).toBeEnabled();
  await page.locator('.journey-device .scene-message-select').filter({ hasText: 'Want to see the exhibition this weekend?' }).click();
  await expect(page.locator('#journey-line')).toHaveValue('Want to see the exhibition this weekend?');
  await page.locator('#journey-line').fill('Want to see the evaluation exhibition this weekend?');
  await expect(page.locator('.journey-device')).toContainText('Want to see the evaluation exhibition this weekend?');
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('hero-export').click();
  const download = await downloaded;
  const file = await download.path();
  expect(file).toBeTruthy();
  const bytes = await fs.readFile(file!);
  expect(bytes.readUInt32BE(16)).toBe(1206);
  expect(bytes.readUInt32BE(20)).toBe(2622);
  // Real export evidence: the mandatory label is visible in the PNG itself.
  await assertDisclosureInPng(file!);
  await download.saveAs(test.info().outputPath('fictional-export.png'));
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

test('a mobile variation continues with the selected synthetic sample', async ({ page }) => {
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
  await page.getByRole('button', { name: /02.*Sample B/ }).click();
  const preview = page.locator('#journey-projects .journey-mobile-preview');
  await expect(preview).toContainText('Sample B');
  await page.locator('#journey-projects .journey-mobile-action').click();
  await expect(page).toHaveURL(/#\/create\?/);
  const handoff = await page.evaluate(() => (window as unknown as { stagedHandoff: { scene: { selfId: string; participants: { id: string; name: string }[]; messages: { type: string; text: string }[] }; intent?: unknown } }).stagedHandoff);
  expect(handoff.scene.participants.find(person => person.id !== handoff.scene.selfId)?.name).toBe('Sample B');
  // The sample is text-only synthetic content; no real-photo payload is staged.
  expect(handoff.scene.messages.some(message => message.type === 'image')).toBe(false);
  expect(handoff.intent).toBeUndefined();
});


test('public creator suggests synthetic tests and exposes no screenshot reconstruction entry', async ({ page }) => {
  await page.goto('/?lang=zh#/create');
  await expect(page.locator('.agent-ideas')).toBeVisible();
  await expect(page.locator('.agent-ideas')).not.toContainText(/截图|微信|红包|转账/);
  await expect(page.getByRole('button', { name: /截图重建|保留原截图/ })).toHaveCount(0);
  await expect(page.getByLabel('描述想生成的聊天', { exact: true })).toHaveAttribute('placeholder', '描述测试场景、角色与需要覆盖的情况…');
  await page.goto('/?lang=en#/create');
  await expect(page.locator('.agent-ideas')).not.toContainText(/screenshot|WhatsApp|WeChat/i);
});

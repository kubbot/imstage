import { test, expect, type Page } from '@playwright/test';
// Header navigation is localised; the workspace itself stays Chinese.
test.use({ locale: 'zh-CN' });

const pointerKey = 'imstage.sessions.active.guest.draft:';
async function openSessions(page: Page) {
  await page.getByRole('button', { name: '管理创作会话' }).click();
  await expect(page.getByLabel('创作会话列表')).toBeVisible();
}

test('a scenario handoff opens the English WhatsApp scene and keeps the previous session', async ({ page }) => {
  await page.goto('/#/create');
  await expect(page.getByRole('button', { name: '管理创作会话' })).toBeVisible();
  await page.getByLabel('描述想生成的聊天', { exact: true }).fill('不能被覆盖的会话');
  await expect(page.getByRole('button', { name: '管理创作会话' })).toContainText('已保存到本机');

  await page.goto('/#/create?new=1&lang=en&scenario=product');
  await expect(page.locator('.agent-phone .scene-view')).toHaveAttribute('data-platform', 'whatsapp');
  await expect(page.locator('.agent-phone')).toContainText('The home headline should wrap to two lines.');
  await expect(page.getByLabel('描述想生成的聊天', { exact: true })).toHaveValue('');
  // The explicit new-session parameter is consumed, not left in the URL.
  await expect(page).not.toHaveURL(/new=1/);

  await openSessions(page);
  await expect(page.getByRole('button', { name: '打开会话：不能被覆盖的会话', exact: true })).toBeVisible();
});

test('a plain English handoff starts a blank WhatsApp session instead of fabricating content', async ({ page }) => {
  await page.goto('/#/create?new=1&lang=en');
  await expect(page.locator('.agent-phone .scene-view')).toHaveAttribute('data-platform', 'whatsapp');
  await expect(page.locator('.agent-phone .scene-row')).toHaveCount(0);
  await expect(page.getByLabel('描述想生成的聊天', { exact: true })).toHaveValue('');
  await expect(page.locator('.agent-phone .scene-header-name')).toHaveText('Ava');
});

test('the new-session handoff is consumed: reloading resumes the same session', async ({ page }) => {
  await page.goto('/#/create?new=1&lang=en&scenario=coffee');
  await expect(page.locator('.agent-phone .scene-view')).toHaveAttribute('data-platform', 'whatsapp');
  const firstId = await page.evaluate((key) => sessionStorage.getItem(key), pointerKey);
  expect(firstId).toBeTruthy();
  await openSessions(page);
  const before = await page.locator('.session-item').count();
  await page.reload();
  await expect(page.getByRole('button', { name: '管理创作会话' })).toBeVisible();
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pointerKey)).toBe(firstId);
  await openSessions(page);
  expect(await page.locator('.session-item').count()).toBe(before);
});

test('the studio draft and PNG export keep working after using the landing demo', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '导出这张画面', exact: true })).toBeEnabled();
  await page.goto('/#/studio');
  await page.getByRole('textbox', { name: '文本内容', exact: true }).fill('首页之后仍然可以创作');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
  const file = testInfo.outputPath('studio-after-landing.png');
  await (await download).saveAs(file);
  const { readFile } = await import('node:fs/promises');
  const png = await readFile(file);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(720);
});

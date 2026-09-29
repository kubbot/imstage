/**
 * Safety-policy browser regression (2026-09-30 change).
 *
 * Real behavior coverage for the mandatory disclosure (including actual
 * downloaded PNG pixels), the consent gate at registration, the always-on mark
 * (no UI switch), the removed payment capabilities and the honest commercial
 * enquiry state. Assertions here must reflect the safety contract — the app is
 * never relaxed to satisfy an old expectation.
 */
import { test, expect } from '@playwright/test';
import { assertDisclosureInPng } from './pngEvidence';

test.use({ locale: 'zh-CN' });

const password = 'synthetic-safety-password-2026';

test('registration requires explicit terms consent and links the notices', async ({ page }) => {
  await page.goto('/#/register');
  await page.getByLabel('怎么称呼你').fill('安全验收');
  await page.getByLabel('邮箱', { exact: true }).fill(`safety-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill(password);

  // The submit button stays disabled until the consent box is checked.
  const submit = page.getByRole('button', { name: '创建账号', exact: true });
  await expect(submit).toBeDisabled();
  const consent = page.getByTestId('terms-consent');
  await expect(consent).not.toBeChecked();
  // Both notices are reachable from the registration form.
  await expect(page.locator('.auth-terms').getByRole('link', { name: '使用条款' })).toBeVisible();
  await expect(page.locator('.auth-terms').getByRole('link', { name: '隐私与留存' })).toBeVisible();

  await consent.check();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page).toHaveURL(/\/welcome/);
});

test('the mandatory mark has no UI switch and the API cannot disable it', async ({ page }) => {
  await page.goto('/#/register');
  const origin = new URL(page.url()).origin;
  const response = await page.request.post('/api/auth/register', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { email: `mark-${crypto.randomUUID()}@example.test`, name: '标记验收', password },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto('/#/welcome');
  await expect(page.locator('.prefs-preview .imstage-disclosure')).toContainText('AI生成 / 虚构');
  await expect(page.getByLabel('显示「虚构对话」标记')).toHaveCount(0);
  // API-level attempts to switch the mark off are rejected.
  const prefs = (await (await page.request.get('/api/preferences')).json()).item;
  const off = await page.request.put('/api/preferences', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { revision: prefs.revision, showFictionalMark: false },
  });
  expect(off.status()).toBe(400);
  // …and an import with disclosure-override fields still renders the mark.
  await page.goto('/#/studio');
  await expect(page.locator('.studio-canvas .imstage-disclosure')).toContainText('AI生成 / 虚构');
});

test('studio standard and long exports keep the disclosure, even scrolled', async ({ page }) => {
  await page.goto('/#/studio');
  await expect(page.locator('.studio-canvas .scene-view')).toBeVisible();
  // Scroll the message list before exporting: the export freezes the visible
  // crop and the header disclosure band must remain in the frame.
  await page.locator('.studio-canvas .scene-messages').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.studio-canvas .imstage-disclosure')).toBeInViewport();

  for (const mode of ['普通 360×640', '长截图']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
    const file = await (await download).path();
    expect(file).toBeTruthy();
    await assertDisclosureInPng(file!);
  }
});

test('the commercial section is an honest unavailable enquiry without a configured email', async ({ page }) => {
  await page.goto('/');
  await page.locator('#mark-open').scrollIntoViewIfNeeded();
  // This build has no verified business email configured: no mailto is invented.
  await expect(page.getByTestId('commercial-pending')).toBeVisible();
  await expect(page.getByTestId('commercial-mailto')).toHaveCount(0);
  await expect(page.getByTestId('commercial-contact')).toContainText(/数据集/);
  // GitHub is not presented as the commercial contact.
  await expect(page.locator('#mark-open').getByRole('link')).toHaveCount(0);
});

test('payment message types are gone from the public editor', async ({ page }) => {
  await page.goto('/#/studio');
  const options = await page.locator('select option').allInnerTexts();
  for (const banned of ['转账', '红包', '余额', 'Transfer', 'Red packet']) {
    expect(options.some((text) => text.includes(banned)), `${banned} must not be offered`).toBe(false);
  }
});

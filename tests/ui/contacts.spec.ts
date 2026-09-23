import { test, expect, type Page } from '@playwright/test';
// The people controls are bilingual; this suite asserts the Chinese copy.
test.use({ locale: 'zh-CN' });

async function ready(page: Page) {
  await page.goto('/#/create');
  const origin = new URL(page.url()).origin;
  const response = await page.request.post('/api/auth/register', { headers: { Origin: origin, 'X-IMStage-Request': '1' }, data: { email: `contact-${crypto.randomUUID()}@example.test`, name: '创作者', password: 'synthetic-contact-tests-2026' } });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('button', { name: '管理创作会话' })).toBeVisible();
}
async function openPanel(page: Page) {
  await page.getByRole('button', { name: '人物与头像', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '人物与头像', exact: true });
  await expect(panel).toBeVisible();
  return panel;
}
const contactNames = async (page: Page) => (await (await page.request.get('/api/contact-library')).json()).contacts.map((c: { name: string }) => c.name);

test('inline name edits autosave without a manual save button', async ({ page }) => {
  await ready(page);
  const panel = await openPanel(page);
  await panel.getByRole('button', { name: '新建另一个人物', exact: true }).click();
  const nameInput = panel.getByLabel(/^人物姓名：/).last();
  await nameInput.fill('林小满');
  await expect.poll(() => contactNames(page)).toContain('林小满');
  await expect(panel.getByRole('button', { name: '保存人物', exact: true })).toHaveCount(0);
  await expect(panel.locator('.contact-sync')).toContainText('已同步');
});

test('adding a person focuses the inline name and does not open avatar generation', async ({ page }) => {
  await ready(page);
  const panel = await openPanel(page);
  await panel.getByRole('button', { name: '新建另一个人物', exact: true }).click();
  await expect(panel.getByLabel('描述想生成的头像')).toHaveCount(0);
  const input = panel.getByLabel(/^人物姓名：/).last();
  await expect(input).toBeFocused();
});

test('a blank name keeps the local draft but is not written to the cloud', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: '人物与头像', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '人物与头像', exact: true });
  await panel.getByRole('button', { name: '新建另一个人物', exact: true }).click();
  const before = await contactNames(page);
  await panel.getByLabel(/^人物姓名：/).last().fill('');
  await expect(panel.locator('.contact-validation')).toContainText('人物姓名需为 1-100');
  await page.waitForTimeout(1200);
  expect(await contactNames(page)).toEqual(before);
});

test('offline edits are cached locally, survive reload and sync on retry', async ({ page }) => {
  await ready(page);
  const panel = await openPanel(page);
  await panel.getByRole('button', { name: '新建另一个人物', exact: true }).click();
  await page.route('**/api/contact-library', async route => {
    if (route.request().method() === 'PUT') return route.fulfill({ status: 503, json: { error: { message: '人物库暂不可用' } } });
    return route.continue();
  });
  await panel.getByLabel(/^人物姓名：/).last().fill('离线保存的人物');
  await expect(panel.locator('[role=alert]')).toContainText('人物库暂不可用');
  expect(await contactNames(page)).not.toContain('离线保存的人物');
  // Reload: the cached draft is restored against the known revision.
  await page.reload();
  await openPanel(page);
  await expect(page.getByRole('complementary', { name: '人物与头像' }).getByLabel(/^人物姓名：/).last()).toHaveValue('离线保存的人物');
  await page.unroute('**/api/contact-library');
  // Reconnect + retry writes the preserved local draft to the cloud.
  await expect(page.getByRole('complementary', { name: '人物与头像' }).getByRole('button', { name: '重试保存' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('complementary', { name: '人物与头像' }).getByRole('button', { name: '重试保存' }).click();
  await expect.poll(() => contactNames(page)).toContain('离线保存的人物');
});

test('a newer cloud revision is never overwritten by the cached edit', async ({ page }) => {
  await ready(page);
  const origin = new URL(page.url()).origin;
  const panel = await openPanel(page);
  await panel.getByRole('button', { name: '新建另一个人物', exact: true }).click();
  await panel.getByLabel(/^人物姓名：/).last().fill('本机待处理人物');
  await expect.poll(() => contactNames(page)).toContain('本机待处理人物');
  // Another client moves the cloud library ahead of the cached base revision.
  const current = await (await page.request.get('/api/contact-library')).json();
  const remote = await page.request.put('/api/contact-library', { headers: { Origin: origin, 'X-IMStage-Request': '1' }, data: { ...current, contacts: [...current.contacts, { id: crypto.randomUUID(), name: '另一个客户端的联系', avatar: null, subtitle: '' }] } });
  expect(remote.ok()).toBeTruthy();
  await panel.getByLabel(/^人物姓名：/).last().fill('本机冲突人物');
  await expect(panel.locator('.contact-error').filter({ hasText: '版本冲突' })).toBeVisible({ timeout: 10000 });
  const cloud = await (await page.request.get('/api/contact-library')).json();
  expect(cloud.contacts.map((c: { name: string }) => c.name)).toContain('另一个客户端的联系');
  expect(cloud.contacts.map((c: { name: string }) => c.name)).not.toContain('本机冲突人物');
  await panel.getByRole('button', { name: '使用云端版本' }).click();
  await expect(panel.locator('.contact-error').filter({ hasText: '版本冲突' })).toHaveCount(0, { timeout: 10000 });
  await expect(panel.getByLabel('人物姓名：本机冲突人物')).toHaveCount(0);
  await expect(panel.getByLabel('人物姓名：另一个客户端的联系')).toBeVisible();
});

test('a load failure offers a real retry and recovers', async ({ page }) => {
  await ready(page);
  await page.route('**/api/contact-library', route => route.fulfill({ status: 503, json: { error: { message: '人物库暂不可用' } } }));
  await page.reload();
  const panel = await openPanel(page);
  await expect(panel.locator('[role=alert]')).toContainText('人物库连接失败');
  await page.unroute('**/api/contact-library');
  await panel.getByRole('button', { name: '重新读取' }).click();
  await expect(panel.getByRole('button', { name: '重新读取' })).toHaveCount(0);
});

test('English people controls are usable', async ({ page }) => {
  await page.goto('/#/create?lang=en');
  const origin = new URL(page.url()).origin;
  await page.request.post('/api/auth/register', { headers: { Origin: origin, 'X-IMStage-Request': '1' }, data: { email: `contact-en-${crypto.randomUUID()}@example.test`, name: 'Creator', password: 'synthetic-contact-tests-2026' } });
  await page.reload();
  await page.getByRole('button', { name: 'People & avatars', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'People & avatars', exact: true });
  await expect(panel.getByRole('button', { name: 'Add another person', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save the people in this conversation', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Add another person', exact: true }).click();
  await expect(panel.getByLabel(/^Name：/).last()).toBeFocused();
});

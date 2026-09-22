import { test, expect, type Page } from '@playwright/test';

test.use({ locale: 'zh-CN' });

async function setup(page: Page) {
  await page.goto('/#/create?lang=zh');
  const origin = new URL(page.url()).origin;
  const response = await page.request.post('/api/auth/register', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { email: `contact-race-${crypto.randomUUID()}@example.test`, name: 'Creator', password: 'synthetic-race-tests-2026' },
  });
  expect(response.ok()).toBeTruthy();
  await page.reload();
  await page.getByRole('button', { name: '人物与头像', exact: true }).click();
  const panel = page.getByRole('complementary', { name: '人物与头像', exact: true });
  await panel.getByRole('button', { name: '新建另一个人物', exact: true }).click();
  return panel;
}

const names = async (page: Page) => (await (await page.request.get('/api/contact-library')).json()).contacts.map((person: { name: string }) => person.name);

test('edits during an in-flight save advance the revision and persist the newest name', async ({ page }) => {
  const panel = await setup(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let received!: () => void;
  const started = new Promise<void>(resolve => { received = resolve; });
  let writes = 0;
  await page.route('**/api/contact-library', async route => {
    if (route.request().method() !== 'PUT' || ++writes !== 1) return route.continue();
    const response = await route.fetch();
    received();
    await held;
    await route.fulfill({ response });
  });
  const input = panel.getByLabel(/^人物姓名：/).last();
  await input.fill('第一次改名');
  await started;
  await input.fill('保存期间继续编辑');
  // Exercise the queued dispatch, not just a second debounce after response.
  await page.waitForTimeout(950);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  release();
  await expect.poll(() => names(page)).toContain('保存期间继续编辑');
  await expect(panel.locator('.contact-sync')).toContainText('已同步');
  await expect(panel.locator('.contact-error')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '人物与头像', exact: true }).click();
  await expect(page.getByLabel('人物姓名：保存期间继续编辑')).toHaveValue('保存期间继续编辑');
});

test('cache and network failure warn before a hash navigation can discard a pending person', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.userId && value?.library) throw new DOMException('full', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await page.route('**/api/contact-library', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: { message: 'synthetic offline' } } }) : route.continue());
  const panel = await setup(page);
  await panel.getByLabel(/^人物姓名：/).last().fill('只在内存中的人物');
  await expect(panel.getByRole('alert').filter({ hasText: '本机缓存失败' })).toBeVisible();
  await expect(panel.getByRole('alert').filter({ hasText: 'synthetic offline' })).toBeVisible();
  const before = page.url();
  const dialog = page.waitForEvent('dialog');
  await page.getByRole('banner').getByRole('link', { name: '项目', exact: true }).click({ noWaitAfter: true });
  await (await dialog).dismiss();
  await expect(page).toHaveURL(before);
  await expect(panel.getByLabel('人物姓名：只在内存中的人物')).toHaveValue('只在内存中的人物');
});

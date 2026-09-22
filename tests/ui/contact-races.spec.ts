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

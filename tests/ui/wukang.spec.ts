import { test, expect, type Page } from '@playwright/test';
import { completeOnboarding } from './prefs';

test.use({ locale: 'zh-CN' });
const phone = (page: Page) => page.locator('.journey-device');
async function register(page: Page) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post('/api/auth/register', { headers: { Origin: origin, 'X-IMStage-Request': '1' }, data: {
    email: `handoff-${crypto.randomUUID()}@example.test`, name: 'Creator', password: 'synthetic-intent-password-2026',
  } });
  expect(response.ok()).toBeTruthy();
}
async function mockAgent(page: Page) {
  const requests: { prompt: string; scene: { messages: unknown[]; id: string } }[] = [];
  await page.route('**/api/agent/capabilities', route => route.fulfill({ json: { configured: true, model: 'test', imageConfigured: false } }));
  await page.route('**/api/agent/run', async route => {
    const data = route.request().postDataJSON(); requests.push(data);
    const scene = { ...data.scene, title: 'Test result', messages: [{ id: 'generated', participantId: data.scene.selfId, type: 'text', text: data.prompt, time: '09:41' }] };
    await route.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'scene', scene }, { type: 'assistant', text: 'Done' }, { type: 'done' }].map(x => JSON.stringify(x)).join('\n') + '\n' });
  });
  return requests;
}
async function submit(page: Page, prompt: string) {
  await page.getByLabel('你的指令', { exact: true }).fill(prompt);
  await page.getByTestId('hero-start').click();
}

test('signed-in Send dispatches the exact prompt once in a blank new session and reload does not repeat', async ({ page }) => {
  const requests = await mockAgent(page);
  await page.goto('/?lang=zh'); await register(page); await page.reload();
  await submit(page, '在武康路见面，请写两句自然的对话。');
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].prompt).toBe('在武康路见面，请写两句自然的对话。');
  expect(requests[0].scene.messages).toEqual([]);
  await expect(page.locator('.agent-phone')).toContainText('在武康路见面');
  await expect(page.getByRole('button', { name: '管理创作会话' })).toContainText('已保存到本机');
  await page.reload();
  await expect(page.locator('.agent-phone')).toContainText('在武康路见面');
  await page.waitForTimeout(1000);
  expect(requests).toHaveLength(1);
});

test('guest Send survives registration and starts only after account ownership resolves', async ({ page }) => {
  const requests = await mockAgent(page);
  await page.goto('/?lang=zh'); await submit(page, '给新用户写一段友好的欢迎对话');
  await expect(page.getByRole('link', { name: '登录创作 →', exact: true })).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole('link', { name: '登录创作 →', exact: true }).click();
  await page.getByRole('link', { name: '创建账号', exact: true }).click();
  await page.getByLabel('怎么称呼你').fill('Creator');
  await page.getByLabel('邮箱', { exact: true }).fill(`guest-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill('synthetic-intent-password-2026');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await completeOnboarding(page);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].prompt).toBe('给新用户写一段友好的欢迎对话');
  expect(requests[0].scene.messages).toEqual([]);
  await expect(page.locator('.agent-phone')).toContainText('给新用户写一段友好的欢迎对话');
});

test('running-intent persistence failure blocks the provider request', async ({ page }) => {
  const requests = await mockAgent(page);
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (value?.draft?.intent?.status === 'running') throw new DOMException('disk full', 'QuotaExceededError');
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
  });
  await page.goto('/?lang=zh'); await register(page); await page.reload();
  await submit(page, '必须先持久化再调用 AI');
  await expect(page.getByRole('alert').filter({ hasText: /保存|存储/ }).first()).toBeVisible();
  await page.waitForTimeout(1000);
  expect(requests).toHaveLength(0);
});

test('a failed provider run stays recoverable and never replays after refresh', async ({ page }) => {
  let calls = 0;
  await mockAgent(page);
  await page.route('**/api/agent/run', route => { calls++; return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'error', message: 'synthetic provider unavailable' }) + '\n' }); });
  await page.goto('/?lang=zh'); await register(page); await page.reload();
  await submit(page, '保留这条失败的创作请求');
  await expect(page.getByRole('alert').filter({ hasText: 'synthetic provider unavailable' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '重试发送', exact: true })).toBeVisible();
  await page.waitForTimeout(1000); expect(calls).toBe(1);
});

test('photo failure blocks example export and recovery restores the actual photo', async ({ page }) => {
  await page.route('**/assets/stories/wukang-evening.webp', route => route.fulfill({ status: 500, body: 'no image' }));
  await page.goto('/?lang=zh');
  await expect(page.getByRole('button', { name: '重新加载照片', exact: true })).toBeVisible();
  await expect(page.getByTestId('hero-export')).toBeDisabled();
  await expect(phone(page).locator('.scene-image img')).toHaveCount(0);
  await page.unroute('**/assets/stories/wukang-evening.webp');
  await page.getByRole('button', { name: '重新加载照片', exact: true }).click();
  await expect(phone(page).locator('.scene-image img')).toHaveAttribute('src', /^data:image\/webp;base64,/);
  await expect(page.getByTestId('hero-export')).toBeEnabled();
});

test('photo lightbox is keyboard accessible and restores focus', async ({ page }) => {
  await page.goto('/?lang=zh');
  const trigger = page.getByRole('button', { name: '查看示例照片', exact: true });
  await expect(trigger).toBeEnabled(); await trigger.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(trigger).toBeFocused();
});

test('unusable handoff storage retains the prompt without navigation or an AI call', async ({ page }) => {
  const requests = await mockAgent(page);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key.startsWith('imstage.marketing.handoff.')) throw new DOMException('full', 'QuotaExceededError'); return original.call(this, key, value); };
  });
  await page.goto('/?lang=zh'); await submit(page, '存储失败也要保留');
  await expect(page.locator('.mark-status').filter({ hasText: '浏览器无法暂存' })).toBeVisible();
  await expect(page.getByLabel('你的指令', { exact: true })).toHaveValue('存储失败也要保留');
  await expect(page).not.toHaveURL(/#\/create/); expect(requests).toHaveLength(0);
});

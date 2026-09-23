import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.use({ locale: 'zh-CN' });
async function config(page: Page) {
  await page.route('**/api/connections/config', route => route.fulfill({ json: {
    mcpUrl: `${new URL(route.request().url()).origin}/api/mcp`, authorizationSupported: true, directoryUrl: null, manualSetupRequired: true,
  } }));
}
async function signedIn(page: Page) {
  await page.route('**/api/auth/session', route => route.fulfill({ json: { user: { id: 'connection-user', name: '创作者', email: 'creator@example.test' } } }));
}

test('homepage focuses navigation and leads to an honest connection setup', async ({ page }) => {
  await config(page);
  await page.goto('/?lang=zh');
  const header = page.getByRole('banner');
  await expect(header.getByRole('link', { name: '项目', exact: true })).toHaveCount(0);
  await expect(header.getByRole('link', { name: '模板', exact: true })).toHaveCount(0);
  await expect(header.getByRole('link', { name: '使用与接入', exact: true })).toHaveCount(0);
  await expect(header.locator('.nav-github svg')).toHaveAttribute('width', '24');
  const bounds = await header.locator('.nav-github').boundingBox();
  expect(bounds?.width).toBeGreaterThanOrEqual(44);
  await page.locator('#chatgpt').getByRole('link', { name: '在 ChatGPT 中使用' }).click();
  await expect(page).toHaveURL(/#\/connect$/);
  await expect(page.getByLabel('连接地址', { exact: true })).toHaveValue(/\/api\/mcp$/);
  await page.getByText('没有看到添加入口？', { exact: true }).click();
  await expect(page.getByText(/当前需要手动添加/)).toBeVisible();
  await expect(page.getByRole('link', { name: '打开 ChatGPT', exact: true })).toHaveAttribute('href', 'https://chatgpt.com/plugins');
});

test('consent is preserved through login and registration navigation', async ({ page }) => {
  await page.goto('/?lang=zh#/connect/authorize?request=synthetic-request');
  await page.getByRole('link', { name: '登录并继续' }).click();
  await expect(page).toHaveURL(/next=%2Fconnect%2Fauthorize%3Frequest%3Dsynthetic-request/);
  await page.getByRole('link', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/register\?next=%2Fconnect%2Fauthorize%3Frequest%3Dsynthetic-request/);
});

test('consent requires an explicit decision and cancellation uses the backend validated return URL', async ({ page }) => {
  await signedIn(page);
  const decisions: unknown[] = [];
  await page.route('**/api/oauth/consent*', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { requestId: 'synthetic', clientName: 'ChatGPT', scopes: ['imstage.scenes'], redirectHost: 'chatgpt.com' } });
    decisions.push(route.request().postDataJSON());
    return route.fulfill({ json: { redirectUrl: 'https://chatgpt.com/connector/callback?error=access_denied&state=synthetic' } });
  });
  await page.route('https://chatgpt.com/connector/callback*', route => route.fulfill({ body: 'Returned to client' }));
  await page.goto('/?lang=zh#/connect/authorize?request=synthetic');
  await expect(page.getByRole('heading', { name: '允许连接你的 IMStage？' })).toBeVisible();
  await expect(page.getByText('creator@example.test', { exact: true })).toBeVisible();
  expect(decisions).toEqual([]);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page).toHaveURL(/chatgpt.com\/connector\/callback\?error=access_denied/);
  expect(decisions).toEqual([{ requestId: 'synthetic', approved: false }]);
});

test('token is shown once, never persisted, and revocation requires a deliberate click', async ({ page }) => {
  await config(page); await signedIn(page);
  let items: object[] = [];
  let revoked = false;
  await page.route('**/api/connections', route => route.fulfill({ json: { items } }));
  await page.route('**/api/connections/tokens', route => {
    const connection = { id: 'test-token', clientName: '测试客户端', kind: 'token', createdAt: new Date().toISOString(), lastUsedAt: null, scopes: ['imstage.scenes'] };
    items = [connection];
    return route.fulfill({ json: { token: 'synthetic-token-for-ui-test', connection } });
  });
  await page.route('**/api/connections/test-token', route => { revoked = true; items = []; return route.fulfill({ json: { ok: true } }); });
  await page.goto('/?lang=zh#/connect');
  await page.getByText('高级接入：个人访问令牌', { exact: true }).click();
  await page.getByLabel('令牌名称', { exact: true }).fill('测试客户端');
  await page.getByRole('button', { name: '生成令牌', exact: true }).click();
  await expect(page.locator('#connection-new-token')).toHaveValue('synthetic-token-for-ui-test');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('synthetic-token-for-ui-test');
  await page.reload();
  await expect(page.locator('#connection-new-token')).toHaveCount(0);
  await expect(page.getByText('测试客户端', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '断开', exact: true }).click();
  expect(revoked).toBe(false);
  await page.getByRole('button', { name: '确认断开', exact: true }).click();
  await expect(page.getByText('测试客户端', { exact: true })).toHaveCount(0);
  expect(revoked).toBe(true);
});

test('unavailable connection service shows recovery instead of a fabricated endpoint', async ({ page }) => {
  await page.route('**/api/connections/config', route => route.fulfill({ status: 503, json: { error: { message: '接入服务暂时不可用' } } }));
  await page.goto('/?lang=zh#/connect');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await expect(page.locator('#connection-url')).toHaveCount(0);
});

for (const language of ['zh', 'en']) test(`connection page works on mobile in ${language}, with reduced motion and keyboard access`, async ({ page }) => {
  await config(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/?lang=${language}#/connect`);
  await expect(page.locator('#connection-url')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations).toEqual([]);
});

test('client picker shows ChatGPT, Codex and other-client steps without inventing a one-click link', async ({ page }) => {
  await config(page);
  await page.goto('/?lang=zh#/connect');
  await expect(page.getByRole('radio', { name: /ChatGPT/ })).toBeChecked();
  await expect(page.locator('#connection-url')).toBeVisible();

  await page.getByRole('radio', { name: /Codex/ }).check();
  await expect(page.locator('.connection-command').filter({ hasText: 'codex mcp add imstage --url' })).toBeVisible();
  await expect(page.locator('.connection-command').filter({ hasText: 'codex mcp login imstage' })).toBeVisible();
  await expect(page).toHaveURL(/client=codex/);
  await expect(page.getByRole('link', { name: /一键|one-click/i })).toHaveCount(0);

  await page.getByRole('radio', { name: /其他客户端/ }).check();
  await expect(page.locator('#connection-url-other')).toHaveValue(/\/api\/mcp$/);
  await expect(page.getByText(/OAuth 2.1/).first()).toBeVisible();
  await expect(page.locator('#connection-url')).toHaveCount(0);

  await page.getByRole('radio', { name: /ChatGPT/ }).check();
  await expect(page.locator('#connection-url')).toBeVisible();
  await expect(page).toHaveURL(/#\/connect$/);
});

test('the selected client is preserved through the sign-in link', async ({ page }) => {
  await config(page);
  await page.goto('/?lang=zh#/connect');
  await page.getByRole('radio', { name: /Codex/ }).check();
  await page.getByRole('link', { name: '登录并继续' }).click();
  await expect(page).toHaveURL(/next=%2Fconnect%3Fclient%3Dcodex/);
});

test('connection status never claims success before tool discovery', async ({ page }) => {
  await config(page);
  await signedIn(page);
  const now = new Date().toISOString();
  await page.route('**/api/connections', route => route.fulfill({ json: { items: [
    { id: 'awaiting', clientName: '等待授权的客户端', kind: 'oauth', createdAt: now, lastUsedAt: null, toolsDiscoveredAt: null, status: 'awaiting_auth', scopes: ['imstage.scenes'] },
    { id: 'authenticated', clientName: '已认证的客户端', kind: 'oauth', createdAt: now, lastUsedAt: now, toolsDiscoveredAt: null, status: 'authenticated', scopes: ['imstage.scenes'] },
    { id: 'connected', clientName: '已发现的客户端', kind: 'oauth', createdAt: now, lastUsedAt: now, toolsDiscoveredAt: now, status: 'connected', scopes: ['imstage.scenes'] },
  ] } }));
  await page.goto('/?lang=zh#/connect');
  await expect(page.getByText('已授权，等待客户端连接')).toBeVisible();
  await expect(page.getByText('已认证，等待工具发现')).toBeVisible();
  await expect(page.getByText('已连接，工具已发现')).toBeVisible();
});

test('disabled loopback redirects steer native clients to the advanced token', async ({ page }) => {
  await page.route('**/api/connections/config', route => route.fulfill({ json: {
    mcpUrl: `${new URL(route.request().url()).origin}/api/mcp`, authorizationSupported: true, directoryUrl: null, manualSetupRequired: true, loopbackRedirectsSupported: false,
  } }));
  await signedIn(page);
  await page.route('**/api/connections', route => route.fulfill({ json: { items: [] } }));
  await page.goto('/?lang=zh#/connect');
  await page.getByRole('radio', { name: /Codex/ }).check();
  await expect(page.getByText(/未开启本地回环回调/)).toBeVisible();
  await expect(page.getByText('高级接入：个人访问令牌', { exact: true })).toBeVisible();
});

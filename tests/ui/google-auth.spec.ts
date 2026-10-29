import { test, expect, type Page } from '@playwright/test';

test.use({ locale: 'zh-CN' });
const clientId = '1234567890-browser-fixture.apps.googleusercontent.com';
const owner = { id: 'google-browser-owner', email: 'google@example.test', name: 'Google 测试用户' };
async function fixture(page: Page, options: { enabled?: boolean; sdkFails?: boolean; pending?: boolean; existing?: boolean; linked?: boolean; password?: boolean } = {}) {
  let user: typeof owner | null = options.existing ? owner : null;
  let linked = options.linked ?? !options.existing;
  const calls: Array<{ path: string; body: any; context: string | undefined }> = [];
  await page.route('https://accounts.google.com/gsi/client', async route => {
    if (options.sdkFails) { await route.abort(); return; }
    await route.fulfill({ contentType: 'text/javascript', body: `window.__gisHistory=[];window.google={accounts:{id:{initialize(config){window.__gis=config;window.__gisHistory.push(config);},renderButton(el,config){const b=document.createElement('button');b.textContent=config.locale==='en'?'Sign in with Google':'使用 Google 登录';b.onclick=()=>{};el.append(b);},cancel(){},disableAutoSelect(){}}}};` });
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api', '');
    const body = route.request().postDataJSON();
    calls.push({ path, body, context: route.request().headers()['x-imstage-auth-context'] });
    let data: any = {};
    if (path === '/auth/session') data = { user };
    else if (path === '/auth/google/config') data = { enabled: options.enabled !== false, clientId, pending: options.pending ? { flowId: 'pending-fixture', profile: { email: owner.email, name: owner.name } } : null };
    else if (path === '/auth/google/challenge') data = { flowId: crypto.randomUUID(), nonce: crypto.randomUUID(), clientId, expiresAtMs: Date.now() + 600000 };
    else if (path === '/auth/google/credential') data = { registrationRequired: true, flowId: body.flowId, profile: { email: owner.email, name: owner.name } };
    else if (path === '/auth/google/register') { user = owner; data = { user }; }
    else if (path === '/auth/methods') data = { password: options.password ?? true, google: { configured: true, linked, email: linked ? owner.email : null } };
    else if (path === '/auth/google/unlink') { linked = false; user = null; data = { ok: true }; }
    else if (path === '/auth/logout') { user = null; data = { ok: true }; }
    else if (path === '/preferences') data = { item: { revision: 1, onboardingStatus: 'legacy', onboardingShown: true } };
    else if (path === '/scenes') data = { items: [] };
    await route.fulfill({ json: data });
  });
  return calls;
}
async function credential(page: Page, index?: number) {
  await page.evaluate(index => { const w = window as any; (index === undefined ? w.__gis : w.__gisHistory[index]).callback({ credential: 'synthetic-browser-credential' }); }, index);
}

test('Google sign-in uses a fresh server nonce and explicit terms before registration', async ({ page }) => {
  const calls = await fixture(page);
  await page.goto('/#/login');
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  const challenge = calls.find(c => c.path.endsWith('/challenge'))!;
  expect(challenge.context).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await credential(page);
  await expect(page.getByTestId('google-registration')).toBeVisible();
  await expect(page.getByText(owner.email, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '同意并创建账号' })).toBeDisabled();
  await page.getByTestId('google-terms-consent').check();
  await page.getByRole('button', { name: '同意并创建账号' }).click();
  await expect(page).toHaveURL(/#\/workspace/);
  expect(calls.filter(c => c.path.endsWith('/google/register'))[0].body.termsAccepted).toBe(true);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain('synthetic-browser-credential');
});

test('unconfigured Google does not load the SDK or displace password login', async ({ page }) => {
  await fixture(page, { enabled: false });
  let sdk = false; page.on('request', r => { if (r.url().includes('/gsi/client')) sdk = true; });
  await page.goto('/#/login');
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toHaveCount(0);
  expect(sdk).toBe(false);
});

test('SDK failure offers retry while password controls remain usable', async ({ page }) => {
  await fixture(page, { sdkFails: true });
  await page.goto('/#/login');
  await expect(page.getByRole('alert')).toContainText('Google');
  await expect(page.getByRole('button', { name: '重试 Google 登录' })).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toBeEnabled();
});

test('pending registration resumes after reload without reusing an ID token', async ({ page }) => {
  const calls = await fixture(page, { pending: true });
  await page.goto('/#/register');
  await expect(page.getByTestId('google-registration')).toBeVisible();
  expect(calls.filter(c => c.path.endsWith('/challenge'))).toHaveLength(0);
  await page.reload();
  await expect(page.getByTestId('google-registration')).toBeVisible();
});

test('navigation cancels its flow and ignores an obsolete SDK callback', async ({ page }) => {
  const calls = await fixture(page);
  await page.goto('/#/login');
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__oldGoogleCallback = (window as any).__gis.callback; location.hash = '/studio'; });
  await expect(page).toHaveURL(/#\/studio/);
  await page.evaluate(() => (window as any).__oldGoogleCallback({ credential: 'obsolete-browser-credential' }));
  await expect.poll(() => calls.filter(c => c.path.endsWith('/cancel')).length).toBeGreaterThan(0);
  expect(calls.filter(c => c.path.endsWith('/credential'))).toHaveLength(0);
});

test('Google-only account displays its login method without an unusable password form', async ({ page }) => {
  await fixture(page, { existing: true, linked: true, password: false });
  await page.goto('/#/account');
  await expect(page.getByText('已关联 Google', { exact: true })).toBeVisible();
  await expect(page.getByLabel('当前密码', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '解除 Google 关联' })).toHaveCount(0);
});

test('password account requires proof before showing the Google link button', async ({ page }) => {
  const calls = await fixture(page, { existing: true, linked: false });
  await page.goto('/#/account');
  await expect(page.getByLabel('关联前确认当前密码')).toBeVisible();
  expect(calls.filter(c => c.path.endsWith('/challenge'))).toHaveLength(0);
  await page.getByLabel('关联前确认当前密码').fill('synthetic-password');
  await page.getByRole('button', { name: '开始关联 Google' }).click();
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  expect(calls.find(c => c.path.endsWith('/challenge'))!.body).toEqual({ intent: 'link', password: 'synthetic-password' });
});

test('first-time tabs resolve one durable browser context before authentication requests', async ({ page, context }) => {
  const a = await fixture(page);
  const other = await context.newPage(); const b = await fixture(other);
  await Promise.all([page.goto('/#/login'), other.goto('/#/login')]);
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  await expect(other.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  expect(a.find(c => c.path.endsWith('/challenge'))!.context).toEqual(b.find(c => c.path.endsWith('/challenge'))!.context);
});

test('leaving during credential verification cancels the flow and rejects a late success', async ({ page }) => {
  const calls = await fixture(page);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let received = false;
  await page.route('**/api/auth/google/credential', async route => { received = true; await gate; await route.fulfill({ json: { user: owner } }); });
  await page.goto('/#/login');
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  // Do not await an async SDK callback: its HTTP response is deliberately held.
  await page.evaluate(() => { void (window as any).__gis.callback({ credential: 'delayed-synthetic-credential' }); });
  await expect.poll(() => received).toBe(true);
  await page.getByRole('link', { name: /免登录试用编辑器|试用编辑器/ }).click();
  await expect.poll(() => calls.some(c => c.path.endsWith('/cancel'))).toBe(true);
  release();
  await expect(page).toHaveURL(/#\/studio/);
  await expect(page.getByRole('link', { name: '登录保存作品' })).toBeVisible();
});

test('blocked secure storage disables Google while keeping password sign-in available', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Synthetic blocked storage', 'SecurityError'); } }); });
  const calls = await fixture(page);
  await page.goto('/#/login');
  await expect(page.getByRole('alert')).toContainText('浏览器安全存储不可用');
  await expect(page.getByLabel('密码', { exact: true })).toBeEnabled();
  expect(calls.some(c => c.path.endsWith('/challenge'))).toBe(false);
});

test('Google consent is usable in English on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('imstage-locale', 'en'));
  await fixture(page);
  await page.goto('/#/login');
  await expect(page.getByRole('button', { name: 'Sign in with Google', exact: true })).toBeVisible();
  await credential(page);
  await expect(page.getByRole('button', { name: 'Accept and create account' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByTestId('google-terms-consent').focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Accept and create account' })).toBeEnabled();
});

test('Google remains usable after a rejected password attempt', async ({ page }) => {
  await fixture(page);
  await page.route('**/api/auth/login', route => route.fulfill({ status: 401, json: { error: { code: 'invalid_credentials', message: '邮箱或密码不正确' } } }));
  await page.goto('/#/login');
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  await page.getByLabel('邮箱', { exact: true }).fill('synthetic@example.test');
  await page.getByLabel('密码', { exact: true }).fill('wrong-synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确');
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
  await credential(page);
  await expect(page.getByTestId('google-registration')).toBeVisible();
});

test('a slow Google SDK cannot supersede a password login already in progress', async ({ page }) => {
  const calls = await fixture(page);
  let releaseSdk!: () => void, releasePassword!: () => void;
  const sdkGate = new Promise<void>(r => { releaseSdk = r; });
  const passwordGate = new Promise<void>(r => { releasePassword = r; });
  let passwordReceived = false;
  await page.route('https://accounts.google.com/gsi/client', async route => { await sdkGate; await route.fallback(); });
  await page.route('**/api/auth/login', async route => { passwordReceived = true; await passwordGate; await route.fulfill({ status: 401, json: { error: { code: 'invalid_credentials', message: '邮箱或密码不正确' } } }); });
  await page.goto('/#/login');
  await page.getByLabel('邮箱', { exact: true }).fill('synthetic@example.test');
  await page.getByLabel('密码', { exact: true }).fill('wrong-synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect.poll(() => passwordReceived).toBe(true);
  releaseSdk();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).google))).toBe(true);
  expect(calls.filter(c => c.path.endsWith('/challenge'))).toHaveLength(0);
  releasePassword();
  await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确');
  await expect(page.getByRole('button', { name: '使用 Google 登录', exact: true })).toBeVisible();
});

import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';

// The onboarding/settings copy under test is Chinese.
test.use({ locale: 'zh-CN' });

const password = 'synthetic-preferences-password-2026';

async function registerToOnboarding(page: Page, name = '偏好验收') {
  await page.goto('/#/register');
  await page.getByLabel('怎么称呼你').fill(name);
  await page.getByLabel('邮箱', { exact: true }).fill(`prefs-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole('heading', { name: '让对话更像你的作品' })).toBeVisible();
}

async function avatarPng(width = 240, height = 120) {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 210, g: 90, b: 60 } },
  })
    .composite([{ input: await sharp({ create: { width: 80, height: 80, channels: 3, background: { r: 20, g: 40, b: 200 } } }).png().toBuffer(), left: 10, top: 20 }])
    .png()
    .toBuffer();
  return { name: 'avatar.png', mimeType: 'image/png', buffer };
}

test('new registration enters one skippable onboarding; reload does not re-enter', async ({ page }) => {
  await registerToOnboarding(page);

  // Preview uses the real SceneView and shows the fictional mark by default.
  await expect(page.locator('.prefs-preview .scene-view')).toBeVisible();
  await expect(page.locator('.prefs-preview .scene-watermark')).toHaveText('虚构对话');

  // The switch reflects immediately in the preview.
  await page.getByLabel('显示「虚构对话」标记').uncheck();
  await expect(page.locator('.prefs-preview .scene-watermark')).toHaveCount(0);

  // Refresh recovers the in-progress draft instead of losing it.
  await page.reload();
  await expect(page.getByRole('heading', { name: '让对话更像你的作品' })).toBeVisible();
  await expect(page.getByLabel('显示「虚构对话」标记')).not.toBeChecked();

  // Skip finishes onboarding and returns to the preserved original target.
  await page.getByTestId('prefs-skip').click();
  await expect(page).toHaveURL(/#\/workspace/);

  // A later reload must not force onboarding again.
  await page.reload();
  await expect(page.getByRole('heading', { name: '偏好验收的创作空间' })).toBeVisible();
  await expect(page).not.toHaveURL(/welcome/);

  // Re-entry is explicit, from account settings.
  await page.goto('/#/account');
  await page.getByRole('link', { name: '头像与虚构标记偏好' }).click();
  await expect(page).toHaveURL(/welcome/);
  await expect(page.getByRole('heading', { name: '账号偏好' })).toBeVisible();
});

test('saved avatar and mark become the defaults for new scenes only', async ({ page }) => {
  await registerToOnboarding(page);

  // Upload + square crop before committing.
  await page.locator('input[type=file]').setInputFiles(await avatarPng());
  await expect(page.locator('.prefs-crop')).toBeVisible();
  await expect(page.locator('.prefs-crop-preview')).toHaveAttribute('src', /^data:image\/png;base64,/);
  // Pan/zoom controls are real accessible range inputs.
  await page.getByLabel('缩放').fill('150');
  await page.getByLabel('水平位置').fill('40');
  await page.locator('.prefs-crop-actions .btn-primary').click();
  await expect(page.locator('.prefs-crop')).toHaveCount(0);
  await expect(page.locator('.prefs-avatar img').first()).toHaveAttribute('src', /^data:image\/png;base64,/);

  await page.getByTestId('prefs-save').click();
  await expect(page).toHaveURL(/#\/workspace/);

  // A brand-new account scene inherits the saved defaults. The Agent response
  // is synthetic; only the scene defaults applied at creation are under test.
  await page.route('**/api/agent/run', async (route) => {
    const input = route.request().postDataJSON();
    const scene = { ...input.scene, messages: [{ id: 'm-defaults', participantId: input.scene.selfId, type: 'text', text: '默认设置已生效', time: '09:41' }] };
    await route.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'scene', scene }, { type: 'assistant', text: '已生成。' }, { type: 'done' }].map((value) => JSON.stringify(value)).join('\n') + '\n' });
  });
  await page.getByRole('link', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '描述想生成的聊天', exact: true }).fill('验证默认设置');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page).toHaveURL(/scene=[0-9a-f-]{36}/);
  const sceneId = new URLSearchParams(page.url().split('?')[1]).get('scene')!;
  await expect.poll(async () => {
    const response = await page.request.get(`/api/scenes/${sceneId}`);
    return response.status();
  }).toBe(200);
  const detail = await (await page.request.get(`/api/scenes/${sceneId}`)).json();
  expect(detail.item.scene.watermark).toBe('虚构对话');
  expect(detail.item.scene.participants.some((person: { avatar?: string }) => typeof person.avatar === 'string' && person.avatar.startsWith('data:image/'))).toBe(true);

  // Existing scenes are never rewritten by a later preferences change.
  await page.goto('/#/account');
  await page.getByRole('link', { name: '头像与虚构标记偏好' }).click();
  await page.getByLabel('显示「虚构对话」标记').uncheck();
  await page.getByTestId('prefs-save').click();
  await expect(page).toHaveURL(/#\/account/);
  const after = await (await page.request.get(`/api/scenes/${sceneId}`)).json();
  expect(after.item.scene.watermark).toBe('虚构对话');
});

test('a failed save keeps the draft and can be retried', async ({ page }) => {
  await registerToOnboarding(page);
  await page.getByLabel('显示「虚构对话」标记').uncheck();

  let fail = true;
  await page.route('**/api/preferences', async (route) => {
    if (route.request().method() === 'PUT' && fail) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal_error', message: '保存失败' } }) });
      return;
    }
    await route.continue();
  });

  await page.getByTestId('prefs-save').click();
  await expect(page.getByRole('alert')).toContainText(/保存|失败/);
  // The draft survives the failure.
  await expect(page.getByLabel('显示「虚构对话」标记')).not.toBeChecked();

  fail = false;
  await page.getByRole('alert').getByRole('button', { name: '重试' }).click();
  await expect(page).toHaveURL(/#\/workspace/);
});

test('a skipped account gets the same stable built-in other avatar in Web scenes', async ({ page }) => {
  await registerToOnboarding(page);
  await page.getByTestId('prefs-skip').click();
  await expect(page).toHaveURL(/#\/workspace/);
  const derived = (await (await page.request.get('/api/preferences')).json()).item.otherAvatar as string;
  expect(derived).toMatch(/^data:image\/png;base64,/);

  await page.route('**/api/agent/run', async (route) => {
    const input = route.request().postDataJSON();
    const scene = { ...input.scene, messages: [{ id: 'm-skip', participantId: input.scene.selfId, type: 'text', text: '跳过后开始创作', time: '09:41' }] };
    await route.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'scene', scene }, { type: 'done' }].map((value) => JSON.stringify(value)).join('\n') + '\n' });
  });
  await page.getByRole('link', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '描述想生成的聊天', exact: true }).fill('跳过后开始创作');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page).toHaveURL(/scene=[0-9a-f-]{36}/);
  const sceneId = new URLSearchParams(page.url().split('?')[1]).get('scene')!;
  await expect.poll(async () => (await page.request.get(`/api/scenes/${sceneId}`)).status()).toBe(200);
  const detail = await (await page.request.get(`/api/scenes/${sceneId}`)).json();
  const other = detail.item.scene.participants.find((person: { id: string }) => person.id !== detail.item.scene.selfId);
  expect(other.avatar).toBe(derived);

  // Reopening settings shows the same stable built-in avatar (no regeneration).
  await page.goto('/#/account');
  await page.getByRole('link', { name: '头像与虚构标记偏好' }).click();
  await page.waitForTimeout(900);
  expect(await page.getByTestId('prefs-other-avatar').locator('img').getAttribute('src')).toBe(derived);
});

test('signed-in manual Studio scenes inherit account defaults', async ({ page }) => {
  await registerToOnboarding(page);
  await page.getByTestId('prefs-save').click();
  await expect(page).toHaveURL(/#\/workspace/);
  await page.goto('/#/studio');
  await expect(page.locator('.studio-canvas .scene-view .scene-watermark')).toHaveText('虚构对话');
  await expect(page.locator('.studio-canvas .scene-view img.scene-avatar').first()).toBeVisible();
});

test('an authored handoff scene keeps its explicit empty mark and missing avatars', async ({ page }) => {
  await page.goto('/#/workspace');
  const origin = new URL(page.url()).origin;
  const registered = await page.request.post('/api/auth/register', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { email: `handoff-${crypto.randomUUID()}@example.test`, name: '交接用户', password: 'synthetic-handoff-password-2026' },
  });
  expect(registered.ok()).toBeTruthy();
  await page.request.put('/api/preferences', { headers: { Origin: origin, 'X-IMStage-Request': '1' }, data: { revision: 1, onboardingStatus: 'completed', showFictionalMark: true } });
  await page.reload();
  const token = crypto.randomUUID();
  const scene = { id: 'scene-handoff', title: '交接场景', platform: 'wechat', deviceTime: '09:41', date: '今天', selfId: 'me', participants: [{ id: 'me', name: '我' }, { id: 'other', name: '对方' }], messages: [{ id: 'm-1', participantId: 'me', type: 'text', text: '交接内容', time: '09:41' }], watermark: '' };
  await page.evaluate(({ key, payload }) => sessionStorage.setItem(key, JSON.stringify(payload)), { key: `imstage.marketing.handoff.${token}`, payload: { scene } });
  await page.goto(`/#/create?new=1&handoff=${token}`);
  await expect(page.locator('.agent-phone .scene-view')).toContainText('交接内容');
  await expect(page.locator('.agent-phone .scene-watermark')).toHaveCount(0);
  await expect(page.locator('.agent-phone .scene-view img.scene-avatar')).toHaveCount(0);
});

test('a delayed preferences GET never blocks OAuth consent rendering', async ({ page }) => {
  await page.goto('/#/workspace');
  const origin = new URL(page.url()).origin;
  const registered = await page.request.post('/api/auth/register', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { email: `oauthprefs-${crypto.randomUUID()}@example.test`, name: '连接验收', password: 'synthetic-oauth-prefs-2026' },
  });
  expect(registered.ok()).toBeTruthy();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/preferences', async (route) => { await gate; await route.continue(); });
  await page.route('**/api/oauth/consent*', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ json: { requestId: 'synthetic', clientName: 'ChatGPT', scopes: ['imstage.scenes'], redirectHost: 'chatgpt.com' } });
    }
    return route.continue();
  });
  await page.reload();
  await page.goto('/#/connect/authorize?request=synthetic-request');
  // The consent UI must render while the optional preferences GET is pending.
  await expect(page.getByRole('button', { name: '允许连接', exact: true })).toBeVisible({ timeout: 5000 });
  release();
});

test('onboarding page has no axe violations', async ({ page }) => {
  await registerToOnboarding(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(results.violations).toEqual([]);
});

test('reopening settings never regenerates or overwrites a saved other avatar', async ({ page }) => {
  await registerToOnboarding(page);
  // Replace the generated avatar with an uploaded one and save it.
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('prefs-upload-other').click();
  (await chooserPromise).setFiles(await avatarPng(120, 120));
  await page.locator('.prefs-crop-actions .btn-primary').click();
  await page.getByTestId('prefs-save').click();
  await expect(page).toHaveURL(/#\/workspace/);
  const saved = (await (await page.request.get('/api/preferences')).json()).item.otherAvatar as string;
  expect(saved).toMatch(/^data:image\/(png|webp);base64,/);

  // Reopen from settings; generation must not fire and the saved value stays.
  let portraitCalls = 0;
  await page.route('**/api/preferences/portrait', async (route) => {
    portraitCalls += 1;
    await route.continue();
  });
  await page.goto('/#/account');
  await page.getByRole('link', { name: '头像与虚构标记偏好' }).click();
  await expect(page.getByRole('heading', { name: '账号偏好' })).toBeVisible();
  await page.waitForTimeout(1200);
  expect(portraitCalls).toBe(0);
  expect(await page.getByTestId('prefs-other-avatar').locator('img').getAttribute('src')).toBe(saved);
  // Opening settings with a clean state must not auto-write a dirty draft.
  await expect(page.getByText('已从上次中断的地方恢复草稿。')).toHaveCount(0);
});

test('a slow generated portrait cannot overwrite a user upload', async ({ page }) => {
  await registerToOnboarding(page);
  await expect(page.getByTestId('prefs-other-avatar').locator('img')).toBeVisible();

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/preferences/portrait', async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: '换一个' }).click();
  // While the generated portrait is still in flight the user uploads their own.
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId('prefs-upload-other').click();
  await (await chooserPromise).setFiles(await avatarPng(100, 100));
  await page.locator('.prefs-crop-actions .btn-primary').click();
  const uploaded = await page.getByTestId('prefs-other-avatar').locator('img').getAttribute('src');
  await expect(page.getByRole('button', { name: '换一个', exact: true })).toBeEnabled();
  release();
  await page.waitForTimeout(900);
  expect(await page.getByTestId('prefs-other-avatar').locator('img').getAttribute('src')).toBe(uploaded);
  await expect(page.getByRole('button', { name: '换一个', exact: true })).toBeEnabled();
});

test('late account defaults do not overwrite edits in manual Studio', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/auth/session', (route) => route.fulfill({ json: { user: { id: 'late-preferences', name: '验收', email: 'late@example.test' } } }));
  await page.route('**/api/preferences', async (route) => {
    await gate;
    await route.fulfill({ json: { item: { revision: 1, myAvatar: null, otherAvatar: null, showFictionalMark: true, markLabel: '虚构对话', onboardingStatus: 'completed', onboardingVersion: 1, onboardingShown: true, updatedAt: null } } });
  });
  await page.goto('/#/studio');
  const watermark = page.getByLabel('水印（默认关闭）');
  await watermark.evaluate((element) => { element.closest('details')!.open = true; });
  await watermark.fill('用户编辑');
  await watermark.fill('');
  const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/preferences');
  release();
  await loaded;
  await expect(watermark).toHaveValue('');
  await expect(page.locator('.scene-watermark')).toHaveCount(0);
});

test('a migrated legacy local scene keeps its own empty mark and avatars', async ({ page }) => {
  await page.goto('/#/create');
  const origin = new URL(page.url()).origin;
  const registered = await page.request.post('/api/auth/register', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { email: `legacy-${crypto.randomUUID()}@example.test`, name: '旧草稿用户', password: 'synthetic-legacy-password-2026' },
  });
  expect(registered.ok()).toBeTruthy();
  await page.request.put('/api/preferences', { headers: { Origin: origin, 'X-IMStage-Request': '1' }, data: { revision: 1, onboardingStatus: 'completed', showFictionalMark: true } });
  const userId = (await (await page.request.get('/api/auth/session')).json()).user.id as string;
  const legacyScene = { id: 'scene-legacy', title: '旧草稿', platform: 'wechat', deviceTime: '09:41', date: '今天', selfId: 'me', participants: [{ id: 'me', name: '我' }, { id: 'other', name: '对方' }], messages: [{ id: 'm-1', participantId: 'me', type: 'text', text: '旧草稿内容', time: '09:41' }], watermark: '' };
  await page.evaluate(({ id, scene }) => {
    sessionStorage.setItem(`imstage.agent.${id}.draft`, JSON.stringify({ scene, prompt: '', editPrompt: '', turns: [], attachments: [], selected: '', projectId: '', full: false, scopeSelected: false, viewportTop: 0, generating: false, intent: null }));
  }, { id: userId, scene: legacyScene });
  await page.reload();
  await expect(page.locator('.agent-phone .scene-view')).toContainText('旧草稿内容');
  // The migrated scene keeps its own empty mark and missing avatars.
  await expect(page.locator('.agent-phone .scene-watermark')).toHaveCount(0);
  await expect(page.locator('.agent-phone .scene-view img.scene-avatar')).toHaveCount(0);
});

test('Web export records first_artwork_completed once', async ({ page }) => {
  await registerToOnboarding(page);
  await page.getByTestId('prefs-save').click();
  await expect(page).toHaveURL(/#\/workspace/);
  await page.route('**/api/agent/run', async (route) => {
    const input = route.request().postDataJSON();
    const scene = { ...input.scene, messages: [{ id: 'm-export', participantId: input.scene.selfId, type: 'text', text: '导出一张作品', time: '09:41' }] };
    await route.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'scene', scene }, { type: 'done' }].map((value) => JSON.stringify(value)).join('\n') + '\n' });
  });
  await page.getByRole('link', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '描述想生成的聊天', exact: true }).fill('导出一张作品');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.locator('.agent-phone .scene-view')).toContainText('导出一张作品');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
  await download;
  await expect.poll(async () => {
    const { items } = await (await page.request.get('/api/preferences/events')).json();
    return items.find((item: { name: string }) => item.name === 'first_artwork_completed')?.count ?? 0;
  }).toBe(1);
  // A second export must not fabricate a higher count.
  const second = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
  await second;
  const finalItems = (await (await page.request.get('/api/preferences/events')).json()).items;
  expect(finalItems.find((item: { name: string }) => item.name === 'first_artwork_completed').count).toBe(1);
});

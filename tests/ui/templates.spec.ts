import { test, expect } from '@playwright/test';
import { createScene } from '../../apps/web/src/studio/model';
import { completeOnboarding } from './prefs';
test.use({ locale: 'zh-CN' });

async function register(page: import('@playwright/test').Page, name: string) {
  await page.goto('/?lang=zh#/register');
  await page.getByLabel('怎么称呼你').fill(name);
  await page.getByLabel('邮箱', { exact: true }).fill(`template-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill('synthetic-template-password-2026');
  await page.getByTestId('terms-consent').check();await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await completeOnboarding(page);
  await expect(page.getByRole('heading', { name: `${name}的创作空间` })).toBeVisible();
}

async function saveScene(page: import('@playwright/test').Page) {
  const origin = new URL(page.url()).origin;
  const scene = { ...createScene('weekend'), id: crypto.randomUUID() };
  const saved = await page.request.put(`/api/scenes/${scene.id}`, {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { scene, revision: 0 },
  });
  expect(saved.status()).toBe(200);
  return scene;
}

async function createTemplate(page: import('@playwright/test').Page, scene: ReturnType<typeof createScene>, name = '复用模板') {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post('/api/templates', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { name, description: '', scene, variables: [] },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).item as { id: string; revision: number };
}

async function handoffKeys(page: import('@playwright/test').Page) {
  return page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('imstage.marketing.handoff.')));
}

test('account templates can be created, reused in a new session, renamed and deleted', async ({ page }) => {
  await register(page, '模板验收');
  const scene = await saveScene(page);

  await page.goto('/#/templates');
  await expect(page.getByRole('heading', { name: '可复用模板', exact: true })).toBeVisible();
  await page.getByLabel('来源画面').selectOption(scene.id);
  const createPanel = page.locator('.templates-columns');
  await expect(createPanel.getByLabel('模板名称')).toHaveValue(scene.title);
  await createPanel.getByLabel('模板名称').fill('客服支持模板');
  // Discoverable variables are selectable and relabelled.
  const variable = page.locator('.template-variable-row').first();
  await expect(variable).toBeVisible();
  await variable.getByRole('checkbox').check();
  await page.getByRole('button', { name: '从画面创建模板', exact: true }).click();
  await expect(page.locator('.template-card', { hasText: '客服支持模板' })).toBeVisible();

  // Reuse opens a genuinely new creator session with the instantiated scene.
  await page.locator('.template-card', { hasText: '客服支持模板' }).getByRole('button', { name: '使用模板' }).click();
  await expect(page).toHaveURL(/#\/create\?/);
  await expect(page.locator('.scene-view')).toBeVisible();
  await expect(page.getByLabel('描述想生成的聊天')).toBeVisible();

  // The previous session is preserved as a separate local session.
  await page.goto('/#/templates');
  await page.locator('.template-card', { hasText: '客服支持模板' }).getByRole('button', { name: /重命名/ }).click();
  await page.locator('.account-dialog').getByLabel('模板名称').fill('客服支持模板 · 2026');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page.locator('.template-card', { hasText: '客服支持模板 · 2026' })).toBeVisible();

  await page.locator('.template-card', { hasText: '客服支持模板 · 2026' }).getByRole('button', { name: /删除模板/ }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.getByRole('heading', { name: '还没有模板' })).toBeVisible();
});

test('the real-screenshot -> template starter is removed (safety)', async ({ page }) => {
  await register(page, '截图模板');
  await page.goto('/#/templates');
  // No upload entry for real screenshots and no reference editor anywhere.
  await expect(page.locator('.templates-shell input[type="file"]')).toHaveCount(0);
  await expect(page.getByLabel('保留原截图')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '在创作中打开', exact: true })).toHaveCount(0);
  await expect(page.locator('.template-shot')).toHaveCount(0);
});

test('a delayed instantiate response never hands off after the account changes', async ({ page }) => {
  let owner='owner-A', writes=0;
  let held: import('@playwright/test').Route | undefined;
  const privateScene={...createScene(),id:crypto.randomUUID(),title:'PRIVATE A TEMPLATE'};
  await page.route('**/api/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/api/auth/session')return route.fulfill({json:{user:{id:owner,name:owner,email:'synthetic@example.test'}}});
    if(pathname.endsWith('/instantiate')){held=route;return;}
    if(pathname==='/api/templates')return route.fulfill({json:{items:owner==='owner-A'?[{id:'template-A',name:'跨账号模板',description:'',mode:'structured',variableCount:0,revision:1}]:[]}});
    if(route.request().method()!=='GET')writes++;
    return route.fulfill({json:{items:[]}});
  });
  await page.goto('/?lang=zh#/templates');
  await page.locator('.template-card').getByRole('button',{name:'使用模板'}).click();
  await expect.poll(()=>Boolean(held)).toBe(true);
  owner='owner-B';
  await page.evaluate(()=>{(window as any).__sameDocument=true;window.dispatchEvent(new Event('focus'));});
  await expect(page.getByRole('heading',{name:'还没有模板'})).toBeVisible();
  await held!.fulfill({json:{scene:privateScene}});
  await page.waitForTimeout(1200);
  expect(await page.evaluate(()=>(window as any).__sameDocument)).toBe(true);
  expect(await handoffKeys(page)).toEqual([]);
  await expect(page).not.toHaveURL(/#\/create/);
  expect(writes).toBe(0);
});

test('template creation cannot smuggle a real-screenshot reference layer', async ({ page }) => {
  const { createScene } = await import('../../apps/web/src/studio/model');
  await register(page, '存储失败');
  const origin = new URL(page.url()).origin;
  const scene = {
    ...createScene(), id: crypto.randomUUID(),
    reference: {
      source: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dN4AAAAASUVORK5CYII=',
      assets: [],
      plan: { schemaVersion: 1, im: 'wechat', surface: 'ios', width: 1, height: 1, warnings: [], edits: [] },
    },
  };
  const res = await page.request.post('/api/templates', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { name: '截图模板', description: '', scene, variables: [] },
  });
  expect(res.status()).toBe(400);
  expect(JSON.stringify(await res.json())).toMatch(/已停用|disabled/);
});

test('legacy screenshot seeds never enter the creator workspace', async ({ page }) => {
  await register(page, '解码失败');
  await page.goto('/#/templates');
  await page.evaluate(() => {
    sessionStorage.setItem('imstage.templates.screenshot', JSON.stringify({ source: 'data:image/png;base64,AAAA', mode: 'preserve' }));
    location.hash = '/create?new=1&lang=zh&templateFlow=preserve';
  });
  await expect(page).toHaveURL(/#\/create\?new=1/);
  await expect(page.locator('iframe[title="原截图精确编辑画面"]')).toHaveCount(0);
  await expect(page.locator('.agent-phone .imstage-disclosure')).toContainText('AI生成 / 虚构');
  expect((await page.getByRole('status').allInnerTexts()).join('')).not.toMatch(/截图无法解码/);
});

test('template library is fully bilingual and keeps the public gallery signed out', async ({ page }) => {
  await page.goto('/?lang=en#/templates');
  // Signed out visitors still get the public marketing gallery, not the account library.
  await expect(page.locator('.templates-page h1')).toHaveText('One opening. Endless versions of yours.');

  await register(page, 'Bilingual');
  await saveScene(page);
  await page.goto('/?lang=en#/templates');
  await expect(page.getByRole('heading', { name: 'Reusable templates', exact: true })).toBeVisible();
  // Safety behavior: the screenshot -> template panel is gone in every locale.
  await expect(page.getByRole('heading', { name: 'Screenshot → template', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use template' })).toHaveCount(0); // no templates yet
  await expect(page.getByRole('button', { name: 'Support conversation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload screenshot', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No templates yet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '可复用模板' })).toHaveCount(0);
});

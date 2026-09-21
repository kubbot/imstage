import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const password = 'a-long-synthetic-password-2026';
const uniqueEmail = () => `ui-${crypto.randomUUID()}@example.test`;
async function register(page: Page) {
  await page.goto('/#/register');
  await page.getByLabel('怎么称呼你').fill('灵感创作者');
  const email = uniqueEmail();
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '灵感创作者的创作空间' })).toBeVisible();
  return email;
}
async function createWork(page: Page) {
  await page.route('**/api/agent/run', async route => {
    const input = route.request().postDataJSON();
    const scene = { ...input.scene, messages: [{id:'m-test', participantId:input.scene.selfId, type:'text',text:'今天的日落很好看。',time:'09:41'}] };
    await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene},{type:'assistant',text:'已生成。'},{type:'done'}].map(v=>JSON.stringify(v)).join('\n')+'\n'});
  });
  await page.getByRole('link', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '描述想生成的聊天', exact: true }).fill('今天的日落很好看。');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.locator('.agent-phone')).toContainText('今天的日落很好看。');
  await expect(page.getByRole('button',{name:'开始生成',exact:true})).toBeDisabled();
  await page.getByRole('button', { name: '保存作品', exact: true }).click();
  await expect(page).toHaveURL(/scene=[0-9a-f-]{36}/);
  await expect(page.getByText('已保存到账号 ·', { exact: false })).toBeVisible();
}

test('real registration, save, reopen, logout and password login', async ({ page }) => {
  const email = await register(page);
  await createWork(page);
  const savedURL = page.url();
  await page.getByRole('link', { name: '← 我的作品', exact: true }).click();
  await expect(page.getByRole('link', { name: '编辑 新的对话' })).toBeVisible();
  await page.getByRole('link', { name: '编辑 新的对话' }).click();
  await expect(page.locator('.agent-phone .scene-view')).toContainText('今天的日落很好看。');
  await page.goto('/#/account');
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/#\/login/);
  await page.goto(savedURL);
  await expect(page).toHaveURL(/#\/login\?next=/);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(savedURL);
  await expect(page.locator('.agent-phone .scene-view')).toContainText('今天的日落很好看。');
});

test('guest draft survives login and is only imported by explicit save', async ({ page }) => {
  await page.goto('/#/studio');
  await page.getByRole('textbox', { name: '文本内容', exact: true }).fill('原来的本机草稿');
  await page.getByRole('link', { name: '登录保存作品' }).click();
  await page.getByRole('link', { name: '创建账号', exact: true }).click();
  await page.getByLabel('怎么称呼你').fill('新账号');
  await page.getByLabel('邮箱', { exact: true }).fill(uniqueEmail());
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page).toHaveURL(/#\/studio$/);
  await expect(page.locator('.studio-canvas .scene-view')).toContainText('原来的本机草稿');
  expect((await (await page.request.get('/api/scenes')).json()).items).toHaveLength(0);
  await page.getByRole('button', { name: '保存到我的作品' }).click();
  await expect(page.getByRole('status').filter({hasText:'已保存到我的作品'})).toBeVisible();
  expect((await (await page.request.get('/api/scenes')).json()).items).toHaveLength(1);
});

test('unsaved account editing recovers on same-tab navigation, never writes guest draft', async ({ page }) => {
  await register(page); await createWork(page);
  const savedURL = page.url();
  await page.getByRole('button', {name:'选择消息：今天的日落很好看。',exact:true}).click();
  await expect(page.getByRole('textbox', {name:'消息文字',exact:true})).toBeVisible();
  await page.getByRole('textbox', { name: '消息文字', exact: true }).fill('还没保存，但可以恢复');
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).some(k => k.startsWith('imstage.account.')))).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('imstage.studio.draft.v1'))).toBeNull();
  await page.getByRole('link', { name: '← 我的作品', exact: true }).click();
  await expect(page.getByRole('heading', { name: '灵感创作者的创作空间' })).toBeVisible();
  await page.goto(savedURL);
  await expect(page.locator('.agent-phone .scene-view')).toContainText('还没保存，但可以恢复');
  await expect(page.getByRole('status').filter({hasText:'已恢复此标签页'})).toBeVisible();
  page.on('dialog', dialog => dialog.accept());
});

test('stale revision preserves edits and can save a separate copy', async ({ page }) => {
  await register(page); await createWork(page);
  const id = new URL(page.url().split('#')[1], 'http://unused').searchParams.get('scene');
  const result = await (await page.request.get(`/api/scenes/${id}`)).json();
  const origin = new URL(page.url()).origin;
  await page.request.put(`/api/scenes/${id}`, { headers: { Origin: origin, 'X-IMStage-Request': '1' }, data: { scene: { ...result.item.scene, title: '另一个窗口的标题' }, revision: result.item.revision } });
  await page.getByRole('button', {name:'选择消息：今天的日落很好看。',exact:true}).click();
  await expect(page.getByRole('textbox', {name:'消息文字',exact:true})).toBeVisible();
  await page.getByRole('textbox', { name: '消息文字', exact: true }).fill('保留当前修改');
  await page.getByRole('button', { name: '保存作品', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('版本已经改变');
  await page.getByRole('button', { name: '另存为新作品' }).click();
  await expect(page).not.toHaveURL(new RegExp(`scene=${id}`));
  await expect(page.locator('.agent-phone .scene-view')).toContainText('保留当前修改');
  expect((await (await page.request.get('/api/scenes')).json()).items).toHaveLength(2);
});

test('wrong current password does not log out; change invalidates old password', async ({ page }) => {
  const email = await register(page);
  await page.getByRole('link', { name: '账号设置', exact: true }).click();
  await page.getByLabel('当前密码').fill('incorrect');
  await page.getByLabel('新密码', { exact: true }).fill('replacement-password-2026');
  await page.getByRole('button', { name: '更新密码' }).click();
  await expect(page.getByRole('alert')).toContainText('当前密码不正确');
  await expect(page).toHaveURL(/#\/account$/);
  await page.getByLabel('当前密码').fill(password);
  await page.getByRole('button', { name: '更新密码' }).click();
  await expect(page).toHaveURL(/#\/login$/);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill('replacement-password-2026');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/#\/workspace$/);
});

test('different account cannot open another account scene; delete has cancel and readback', async ({ page }) => {
  await register(page); await createWork(page); const url = page.url();
  await page.goto('/#/account'); await page.getByRole('button', { name: '退出登录', exact: true }).click(); await expect(page).toHaveURL(/#\/login/);
  await register(page); await page.goto(url);
  await expect(page.getByRole('heading', { name: '暂时打不开这份作品' })).toBeVisible();
  await page.getByRole('link', { name: '返回我的作品' }).click();
  await createWork(page); await page.getByRole('link', { name: '← 我的作品', exact: true }).click();
  await page.getByRole('button', { name: '删除 新的对话' }).click();
  await page.getByRole('button', { name: '保留作品' }).click();
  await expect(page.getByRole('link', { name: '编辑 新的对话' })).toBeVisible();
  await page.getByRole('button', { name: '删除 新的对话' }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByRole('heading', { name: '还没有保存的作品' })).toBeVisible();
});

test('delayed login does not hijack navigation', async ({ page }) => {
  const email = await register(page); await page.goto('/#/account'); await page.getByRole('button',{name:'退出登录',exact:true}).click();
  let release: () => void = () => {}; const completed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/login', async route => { const response = await route.fetch(); const body = await response.body(); await new Promise(resolve => setTimeout(resolve, 800)); await route.fulfill({status:response.status(),headers:response.headers(),body}); release(); });
  await page.getByLabel('邮箱',{exact:true}).fill(email); await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click(); await page.getByRole('link',{name:'先试用编辑器',exact:false}).click();
  await expect(page).toHaveURL(/#\/studio$/); await completed; await page.waitForTimeout(100); await expect(page).toHaveURL(/#\/studio$/);
});

for (const theme of ['light','dark'] as const) test(`account pages accessible and responsive in ${theme}`, async ({ page }) => {
  await page.emulateMedia({colorScheme:theme});
  for(const width of [390, 1440]) {
    await page.setViewportSize({width,height:900});
    for(const route of ['login','register']) {
      await page.goto(`/#/${route}`); await expect(page.locator('h1')).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
      const result = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze(); expect(result.violations.map(v => ({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    }
  }
  await register(page); await page.setViewportSize({width:390,height:844});
  await expect(page.getByRole('link',{name:'账号设置',exact:true})).toBeVisible();
  for(const route of ['workspace','account']) {
    await page.goto(`/#/${route}`); await expect(page.locator('h1')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1)).toBe(true);
    const result = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze(); expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
  }
});

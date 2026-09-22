import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createScene } from '../../apps/web/src/studio/model';
test.use({ locale: 'zh-CN' });

async function ready(page: Page, long = false) {
  await page.goto('/#/create');
  const origin = new URL(page.url()).origin;
  const result = await page.request.post('/api/auth/register', { headers: { Origin: origin, 'X-IMStage-Request': '1' }, data: { email: `editor-${crypto.randomUUID()}@example.test`, name: '合成测试', password: 'synthetic-editor-password-2026' } });
  expect(result.ok()).toBeTruthy();
  const user = (await result.json()).user;
  const scene = { ...createScene(), deviceProfileId: 'macos-window', surface: 'desktop', title: '周末的美术馆', headerText: '小满', participants: [{ id: 'me', name: '我' }, { id: 'friend', name: '小满' }], selfId: 'me', messages: [
    { id: 'one', participantId: 'friend', type: 'text', text: '周六有空吗？想去看那个新展。', time: '10:06' },
    { id: 'two', participantId: 'me', type: 'text', text: '有空！看完展再找家咖啡馆坐坐？', time: '10:07' },
    { id: 'three', participantId: 'friend', type: 'text', text: '好呀，那我们下午两点见。', time: '10:08' },
  ] };
  if(long){scene.deviceProfileId='iphone-17-pro';scene.surface='ios';scene.messages=Array.from({length:25},(_,n)=>({id:`long-${n}`,participantId:n%2?'me':'friend',type:'text',text:`合成对话第 ${n+1} 条，今天去美术馆看展。`,time:`10:${String(n).padStart(2,'0')}`}));}
  await page.evaluate(({ user, scene }) => sessionStorage.setItem(`imstage.agent.${user.id}.draft`, JSON.stringify({ scene })), { user, scene });
  await page.route('**/api/agent/capabilities', r => r.fulfill({ json: { configured: true, model: '测试模型', imageConfigured: false } }));
  await page.reload(); await expect(page.locator('.agent-phone')).toContainText(long?'合成对话第 1 条':'周六有空吗');
}

test('canvas fits and properties, ordering, undo, redo and element navigator stay connected', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: '选择消息：周六有空吗？想去看那个新展。', exact: true }).click();
  await expect(page.getByLabel('消息文字', { exact: true })).toHaveValue('周六有空吗？想去看那个新展。');
  await page.getByLabel('消息文字', { exact: true }).fill('周六去看展吧。');
  await expect(page.locator('.agent-phone')).toContainText('周六去看展吧。');
  await page.getByRole('button', { name: '撤销上次修改' }).click();
  await expect(page.locator('.agent-phone')).toContainText('周六有空吗');
  await page.getByRole('button', { name: '重做上次修改' }).click();
  await expect(page.locator('.agent-phone')).toContainText('周六去看展吧。');
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await expect(page.locator('.agent-phone .scene-row')).toHaveCount(4);
  await page.getByRole('button', { name: '下移消息' }).click();
  await expect(page.locator('.agent-phone .scene-row').nth(2)).toContainText('周六去看展吧。');
  await page.getByRole('button', { name: '删除消息', exact: true }).click();
  await expect(page.locator('.agent-phone .scene-row')).toHaveCount(3);
  await page.getByRole('button', { name: '元素 3', exact: true }).click();
  await page.getByRole('button', { name: '画面与界面' }).click();
  await page.getByLabel('会话标题', { exact: true }).fill('周末计划');
  await expect(page.locator('.agent-phone .scene-header-name')).toHaveText('周末计划');
  await page.getByRole('button', { name: '小满 对方 · 左侧消息', exact: true }).click();
  await page.getByLabel('姓名', { exact: true }).fill('小夏');
  await expect(page.locator('.element-navigator')).toContainText('小夏');
  const fits = await page.evaluate(() => { const p = document.querySelector('.device-frame')!.getBoundingClientRect(); const c = document.querySelector('.agent-canvas')!.getBoundingClientRect(); return p.left >= c.left && p.right <= c.right && p.top >= c.top && p.bottom <= c.bottom; });
  expect(fits).toBeTruthy();
  await page.getByRole('button', { name: '放大画布' }).click();
  await page.getByRole('button', { name: '适应画布' }).click();
  await expect(page.getByRole('button', { name: '适应画布' })).toHaveText('适应');
});

test('left AI and right AI both send explicit selected-element targets and preserve other messages', async ({ page }) => {
  await ready(page);
  await page.route('**/api/agent/run', r => { const { scene, targetId, prompt } = r.request().postDataJSON(); return r.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'scene', scene: { ...scene, messages: scene.messages.map((m: {id:string}) => m.id === targetId ? { ...m, text: prompt } : m) } }, { type: 'done' }].map(e => JSON.stringify(e)).join('\n') + '\n' }); });
  await page.getByRole('button', { name: '选择消息：周六有空吗？想去看那个新展。', exact: true }).click();
  await page.getByRole('button', { name: '当前范围 · 整个对话 切换' }).click();
  await page.getByLabel('描述想生成的聊天', { exact: true }).fill('周六一起看展？');
  const first = page.waitForRequest('**/api/agent/run');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  expect((await first).postDataJSON().targetId).toBe('one');
  await expect(page.locator('.agent-phone')).toContainText('周六一起看展？');
  await page.getByRole('button', { name: 'AI 修改', exact: true }).click();
  await page.getByLabel('描述想怎样修改').fill('周六要不要一起去美术馆？');
  const second = page.waitForRequest('**/api/agent/run');
  await page.getByRole('button', { name: '发送修改', exact: true }).click();
  expect((await second).postDataJSON().targetId).toBe('one');
  await expect(page.locator('.agent-phone')).toContainText('周六要不要一起去美术馆？');
  await expect(page.locator('.agent-phone')).toContainText('有空！看完展再找家咖啡馆坐坐？');
});

for (const theme of ['light', 'dark'] as const) test(`editor ${theme}: responsive properties are reachable without clipped form or page overflow`, async ({ page }) => {
  await ready(page); await page.emulateMedia({ colorScheme: theme });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) { if (await page.getByRole('button', { name: '关闭 AI 编辑' }).isVisible()) await page.getByRole('button', { name: '关闭 AI 编辑' }).click(); await page.getByRole('button', { name: /渲染画面/ }).click(); }
    await page.getByRole('button', { name: '选择消息：周六有空吗？想去看那个新展。', exact: true }).click();
    await expect(page.getByLabel('消息文字', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '下移消息' }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(audit.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    await page.getByLabel('消息文字', { exact: true }).scrollIntoViewIfNeeded();
    await page.locator('.editor-properties').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `${process.env.IMSTAGE_ARTIFACT_DIR}/editor-${theme}-${width}.png` });
  }
});

test('keyboard selection, grouped typing undo and short viewport keep editing usable', async ({ page }) => {
  await ready(page);
  await page.setViewportSize({ width: 1440, height: 720 });
  const title = page.getByRole('button', { name: '编辑会话标题', exact: true });
  await title.focus(); await page.keyboard.press('Enter');
  await expect(page.getByLabel('会话标题', { exact: true })).toHaveValue('小满');
  await page.getByRole('button', { name: '编辑 小满 的头像', exact: true }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('姓名', { exact: true })).toHaveValue('小满');
  await page.getByRole('button', { name: '选择消息：周六有空吗？想去看那个新展。', exact: true }).click();
  const text = page.getByLabel('消息文字', { exact: true });
  await text.fill('新的'); await text.pressSequentially('周末计划', { delay: 30 });
  await page.getByRole('button', { name: '撤销上次修改' }).click();
  await expect(text).toHaveValue('周六有空吗？想去看那个新展。');
  const box = await page.getByRole('button', { name: '开始生成', exact: true }).boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);
});

test('element list scrolls to offscreen messages without changing screenshot mode', async ({ page }) => {
  await ready(page, true);
  await page.getByRole('button', { name: '元素 25', exact: true }).click();
  await page.locator('.element-item').filter({ hasText: '合成对话第 25 条' }).click();
  await expect(page.getByLabel('导出图片范围')).toHaveValue('standard');
  await expect(page.getByLabel('消息文字', { exact: true })).toContainText('合成对话第 25 条');
  await expect(page.getByRole('button', { name: '选择消息：合成对话第 25 条，今天去美术馆看展。', exact: true })).toBeInViewport();
});

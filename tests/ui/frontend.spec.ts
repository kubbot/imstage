import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
const draftKey = 'imstage.studio.draft.v1';
const phone = (page: Page) => page.locator('.studio-phone');
async function settings(page: Page) { await page.locator('summary').filter({ hasText: '场景设置' }).click(); }

test('system appearance follows changes; manual preference survives reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' }); await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('banner').getByRole('button', { name: '跟随系统', exact: true })).toHaveAttribute('aria-pressed','true');
  await page.emulateMedia({ colorScheme: 'light' }); await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.getByRole('banner').getByRole('button', { name: '深色', exact: true }).click();
  await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByRole('banner').getByRole('button', { name: '跟随系统', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
});

test('homepage edit changes only the selected reply; platform switching retains it', async ({ page }) => {
  await page.goto('/'); const rows = page.locator('.hero-device .scene-row'); const before = await rows.allTextContents();
  await page.getByRole('button', { name: '让回复更有松弛感' }).click();
  const after = await rows.allTextContents(); expect(after[0]).toBe(before[0]);expect(after[2]).toBe(before[2]);expect(after[1]).toContain('不赶路');
  await page.getByRole('button', { name:'小红书', exact:true }).click();
  await expect(page.locator('.hero-device .scene-view')).toHaveAttribute('data-platform','xiaohongshu');
  await expect(rows.nth(1)).toContainText('不赶路');
});

test('template filtering, empty recovery and selected scene entry', async ({ page }) => {
  await page.goto('/#/templates');await page.getByRole('button',{name:'教学示例',exact:true}).click();
  await expect(page.locator('.template-card')).toHaveCount(1);
  await page.getByRole('textbox',{name:'搜索场景'}).fill('不存在');await expect(page.getByText('没有找到这个场景')).toBeVisible();
  await page.getByRole('button',{name:'查看全部场景'}).click();await expect(page.locator('.template-card')).toHaveCount(3);
  await page.locator('.template-card.launch').click();await expect(phone(page)).toContainText('新品发布讨论组');
});

test('message edit is live, supports undo and reload, date is rendered independently', async ({ page }) => {
  await page.goto('/#/studio');const input=page.getByRole('textbox',{name:'文本内容',exact:true});const original=await input.inputValue();
  await input.fill('周五 18:30 见');await expect(phone(page)).toContainText('周五 18:30 见');
  await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(phone(page)).toContainText(original);
  await input.fill('只改这一句');await settings(page);await page.getByLabel('设备时间',{exact:true}).fill('21:10');await page.getByLabel('对话日期',{exact:true}).fill('2026-08-12');
  await expect(phone(page).locator('.scene-status-time')).toHaveText('21:10');await expect(phone(page).locator('.scene-date')).toHaveText('2026-08-12');
  await page.reload();await expect(phone(page)).toContainText('只改这一句');await expect(phone(page).locator('.scene-date')).toHaveText('2026-08-12');
});

test('new scene is blank and deletion is undoable', async ({ page }) => {
  await page.goto('/#/studio');await page.getByRole('button',{name:'新建场景',exact:true}).click();await expect(phone(page).locator('.scene-row')).toHaveCount(0);
  await page.getByRole('textbox',{name:'添加一条台词',exact:true}).fill('第一条合成消息');await page.getByRole('button',{name:'添加这条台词'}).click();await expect(phone(page)).toContainText('第一条合成消息');
  await page.getByRole('button',{name:'删除消息',exact:true}).click();await expect(phone(page).locator('.scene-row')).toHaveCount(0);
  await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(phone(page)).toContainText('第一条合成消息');
});

test('gallery selection protects an existing draft and template replacement can be undone', async ({ page }) => {
  await page.goto('/#/studio');await page.getByRole('textbox',{name:'文本内容',exact:true}).fill('不能丢失的草稿');
  await page.goto('/#/templates');await page.locator('.template-card.launch').click();await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'取消',exact:true}).click();await expect(phone(page)).toContainText('不能丢失的草稿');
  await page.goto('/#/templates');await page.locator('.template-card.launch').click();await page.getByRole('button',{name:'使用模板',exact:true}).click();await expect(phone(page)).toContainText('新品发布讨论组');
  await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(phone(page)).toContainText('不能丢失的草稿');
});

test('corrupt draft is preserved until explicit discard', async ({ page }) => {
  await page.goto('/');await page.evaluate(key=>localStorage.setItem(key,'{broken draft'),draftKey);await page.goto('/#/studio');
  await expect(page.getByRole('alert')).toContainText('无法读取');
  await page.getByRole('textbox',{name:'文本内容',exact:true}).fill('当前页仍能编辑');
  expect(await page.evaluate(key=>localStorage.getItem(key),draftKey)).toBe('{broken draft');
  await page.getByRole('button',{name:'删除损坏草稿',exact:true}).click();await page.getByRole('button',{name:'删除并继续',exact:true}).click();
  await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key),draftKey)).toContain('当前页仍能编辑');
});

test('cross-tab change pauses local writes and allows deliberate resolution', async ({ page, context }) => {
  await page.goto('/#/studio');await page.getByRole('textbox',{name:'文本内容',exact:true}).fill('本页内容');
  const other=await context.newPage();await other.goto('/');
  await other.evaluate(key=>{const data=JSON.parse(localStorage.getItem(key)!);data.scene.messages[0].text='另一页内容';localStorage.setItem(key,JSON.stringify(data));},draftKey);
  await expect(page.getByText('另一个标签页更新了本机草稿。',{exact:false})).toBeVisible();
  await page.getByRole('textbox',{name:'文本内容',exact:true}).fill('本页继续编辑');
  expect(await other.evaluate(key=>localStorage.getItem(key),draftKey)).toContain('另一页内容');
  await page.getByRole('button',{name:'保留当前并覆盖',exact:true}).click();
  await expect.poll(()=>other.evaluate(key=>localStorage.getItem(key),draftKey)).toContain('本页继续编辑');
  await other.close();
});

test('PNG export is a real image, supports full content and has correct dimensions', async ({ page }, testInfo) => {
  await page.goto('/#/studio');await settings(page);await page.getByLabel('水印（默认关闭）').fill('IMStage 合成演示');
  for(const mode of ['standard','full']) {
    if(mode==='full'){await page.getByRole('textbox',{name:'添加一条台词',exact:true}).fill('长图内容 '.repeat(100));await page.getByRole('button',{name:'添加这条台词'}).click();await page.getByRole('button',{name:'长截图',exact:true}).click();}
    const dl=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();const download=await dl;
    const file=testInfo.outputPath(`${mode}.png`);await download.saveAs(file);const png=await readFile(file);
    expect(png.subarray(1,4).toString()).toBe('PNG');expect(png.readUInt32BE(16)).toBe(720);
    if(mode==='standard')expect(png.readUInt32BE(20)).toBe(1280);else expect(png.readUInt32BE(20)).toBeGreaterThan(1280);
    expect(png.length).toBeGreaterThan(5000);
  }
});

test('unavailable storage does not crash or falsely report successful saving', async ({ page }) => {
  await page.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Disabled','SecurityError')}}));
  await page.goto('/#/studio');await expect(page.getByRole('alert')).toContainText('不可用');
  await page.getByRole('textbox',{name:'文本内容',exact:true}).fill('仍然可以编辑');await expect(phone(page)).toContainText('仍然可以编辑');
});

test('image upload decodes real local data and invalid uploads preserve the scene', async ({ page }) => {
  await page.goto('/#/studio');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const composer = page.locator('section').filter({has: page.getByRole('heading',{name:'添加一条台词',exact:true})});
  await composer.getByRole('combobox',{name:'类型',exact:true}).selectOption('image');
  await page.locator('input[type=file]').nth(2).setInputFiles({name:'fixture.png',mimeType:'image/png',buffer:png});
  await expect(composer.getByRole('button',{name:'更换图片'})).toBeVisible();
  await composer.getByRole('button',{name:'添加这条台词'}).click();
  await expect(phone(page).locator('.scene-image img')).toHaveCount(1);
  await page.locator('input[type=file]').nth(2).setInputFiles({name:'broken.png',mimeType:'image/png',buffer:Buffer.from('not a png')});
  await expect(page.getByRole('alert')).toContainText('无法解码');
  await expect(phone(page).locator('.scene-image img')).toHaveCount(1);
  await page.reload();await expect(phone(page).locator('.scene-image img')).toHaveCount(1);
});

test('export failures can retry without discarding the draft', async ({ page }) => {
  await page.goto('/#/studio');await page.getByRole('textbox',{name:'文本内容',exact:true}).fill('导出失败也保留');
  await page.evaluate(()=>{(window as any).originalToDataURL=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=()=>{throw new Error('synthetic export failure')};});
  await page.getByRole('button',{name:'导出 PNG',exact:true}).click();
  await expect(page.getByRole('button',{name:'重试导出'})).toBeVisible();await expect(phone(page)).toContainText('导出失败也保留');
  await page.evaluate(()=>{HTMLCanvasElement.prototype.toDataURL=(window as any).originalToDataURL});
  const dl=page.waitForEvent('download');await page.getByRole('button',{name:'重试导出'}).click();await dl;
});

test('JSON dialog is keyboard reachable and Escape restores focus', async ({ page }) => {
  await page.goto('/#/studio');const button=page.getByRole('button',{name:'场景 JSON',exact:true});
  await button.focus();await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'场景 JSON',exact:true})).toBeVisible();
  await expect(page.getByLabel('场景 JSON 内容')).toHaveValue(/messages/);
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'场景 JSON',exact:true})).not.toBeVisible();await expect(button).toBeFocused();
});

for(const width of [320,390,768,1440]) test(`responsive routes have no horizontal overflow at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});for(const route of ['','#/templates','#/docs','#/studio']){await page.goto('/'+route);await page.locator('h1').waitFor();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
  if(width<901){await page.getByRole('tab',{name:'预览',exact:true}).click();await expect(phone(page)).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
});

for(const theme of ['light','dark'] as const)test(`WCAG A/AA automated checks across frontend in ${theme}`,async({page})=>{
  await page.emulateMedia({colorScheme:theme});for(const route of ['','#/templates','#/docs','#/studio']){await page.goto('/'+route);await page.locator('h1').waitFor();const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();expect(result.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);}
});

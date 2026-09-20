import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
const key='imstage.studio.draft.v1';

test('prompt demo streams messages and resolves real image assets into one editable scene',async({page})=>{
  await page.goto('/#/create');
  await expect(page.getByRole('textbox',{name:'描述你想创作的场景'})).toHaveValue(/Elon Musk/);
  await page.getByRole('button',{name:'生成场景',exact:true}).click();
  await expect(page.getByRole('button',{name:'停止生成'})).toBeVisible();
  await expect(page.getByRole('button',{name:'导出 PNG',exact:true})).toBeDisabled();
  await expect(page.getByText('画面已经就绪',{exact:true})).toBeVisible({timeout:15000});
  const phone=page.locator('.creation-phone');
  await expect(phone.locator('.scene-row')).toHaveCount(6);
  await expect(phone).toContainText('火星 · 杰泽罗陨石坑');
  await expect(phone.locator('.scene-image img')).toHaveAttribute('src',/^data:image\/png;base64,/);
  await expect(phone.locator('img[alt="Elon Musk 的头像"]').first()).toHaveAttribute('src',/^data:image\/jpeg;base64,/);
  await page.getByRole('button',{name:'查看素材来源'}).click();
  await expect(page.locator('.creation-sources')).toContainText('并非实时同步');
  await expect(page.locator('.creation-sources')).toContainText('同行者为虚构人物');
});

test('stop interrupts the stream and keeps partial result stable',async({page})=>{
  await page.goto('/#/create'); await page.getByRole('button',{name:'生成场景',exact:true}).click();
  await expect(page.locator('.creation-phone .scene-row').first()).toBeVisible();
  await page.getByRole('button',{name:'停止生成'}).click();
  await expect(page.getByText('已暂停创作',{exact:true})).toBeVisible();
  const before=await page.locator('.creation-phone').innerText();
  await page.waitForTimeout(700);
  expect(await page.locator('.creation-phone').innerText()).toBe(before);
  await expect(page.getByRole('button',{name:'生成场景',exact:true})).toBeEnabled();
});

test('unrelated prompts never masquerade as generated Mars scenes',async({page})=>{
  await page.goto('/#/create');await page.getByRole('textbox',{name:'描述你想创作的场景'}).fill('和朋友明天去东京吃拉面');
  await page.getByRole('button',{name:'生成场景',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('示例模式演示');
  await expect(page.getByText('画面已经就绪',{exact:true})).toHaveCount(0);
});

test('live endpoint failure stays visible without silently falling back to demo',async({page})=>{
  let requests=0;await page.route('**/api/scenes/stream',route=>{requests++;return route.fulfill({status:503,body:'not configured'});});
  await page.goto('/#/create');await page.getByLabel('生成模式',{exact:true}).selectOption('live');
  await page.getByRole('textbox',{name:'描述你想创作的场景'}).fill('我们明天去东京');
  const original=await page.locator('.creation-phone').innerText();
  await page.getByRole('button',{name:'生成场景',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('真实生成服务尚未接入');
  expect(await page.locator('.creation-phone').innerText()).toBe(original);
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await expect.poll(()=>requests).toBe(2);
});

test('remote protocol fixture renders its result and does not claim X avatar provenance',async({page})=>{
  const scene={id:'tokyo',title:'东京见',platform:'wechat',deviceTime:'12:00',date:'明天',selfId:'me',participants:[{id:'me',name:'我'},{id:'friend',name:'朋友'}],messages:[],watermark:'虚构场景'};
  await page.route('**/api/scenes/stream',route=>route.fulfill({status:200,contentType:'application/x-ndjson',body:[{type:'scene',scene},{type:'message',message:{id:'one',participantId:'friend',type:'text',text:'拉面店见。',time:''}},{type:'done'}].map(JSON.stringify).join('\n')}));
  await page.goto('/#/create');await page.getByLabel('生成模式',{exact:true}).selectOption('live');
  await page.getByRole('button',{name:'生成场景',exact:true}).click();
  await expect(page.getByText('画面已经就绪',{exact:true})).toBeVisible({timeout:15000});
  await expect(page.locator('.creation-phone')).toContainText('拉面店见。');
  await page.getByRole('button',{name:'查看素材来源'}).click();
  await expect(page.locator('.creation-sources')).not.toContainText('@elonmusk');
});

test('handoff protects saved work and carries images into studio after explicit replacement',async({page})=>{
  await page.goto('/#/studio');await page.getByRole('textbox',{name:'文本内容',exact:true}).fill('这份草稿不能丢');
  const original=await page.evaluate(k=>localStorage.getItem(k),key);
  await page.goto('/#/create');await page.getByRole('button',{name:'编辑细节',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'保留已有草稿'})).toBeVisible();
  await page.getByRole('button',{name:'取消',exact:true}).click();
  expect(await page.evaluate(k=>localStorage.getItem(k),key)).toBe(original);
  await page.getByRole('button',{name:'编辑细节',exact:true}).click();await page.getByRole('button',{name:'使用当前场景',exact:true}).click();
  await expect(page).toHaveURL(/#\/studio$/); await expect(page.locator('.studio-phone')).toContainText('Elon Musk');
  await expect(page.locator('.studio-phone .scene-image img')).toHaveAttribute('src',/^data:image\/png;base64,/);
  await page.reload(); await expect(page.locator('.studio-phone')).toContainText('火星');
});

test('prompt PNG export is downloadable and both frames use the preview renderer',async({page},testInfo)=>{
  await page.goto('/#/create');
  for(const mode of ['standard','full']){
    await page.getByLabel('图片导出范围').selectOption(mode);
    const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();
    const download=await downloadPromise;const file=testInfo.outputPath(`prompt-${mode}.png`);await download.saveAs(file);
    const data=await readFile(file);expect(data.subarray(1,4).toString()).toBe('PNG');expect(data.readUInt32BE(16)).toBe(720);
    if(mode==='standard')expect(data.readUInt32BE(20)).toBe(1280);else expect(data.readUInt32BE(20)).toBeGreaterThanOrEqual(1280);
    await expect(page.getByRole('button',{name:'导出 PNG',exact:true})).toBeEnabled();
  }
});

test('mobile prompt and preview remain accessible and keep state across tabs',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/#/create');
  await expect(page.getByRole('textbox',{name:'描述你想创作的场景'})).toBeVisible();
  await page.getByRole('tab',{name:'实时画面'}).click();await expect(page.locator('.creation-phone')).toBeVisible();
  await page.locator('.creation-phone .scene-selectable').first().click();
  await expect(page.getByRole('textbox',{name:'当前消息内容'})).toBeVisible();
  await page.getByRole('textbox',{name:'当前消息内容'}).fill('火星见！');
  await page.getByRole('tab',{name:'实时画面'}).click();await expect(page.locator('.creation-phone')).toContainText('火星见！');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.getByRole('tab',{name:'写下场景'}).click();
  await page.getByRole('button',{name:'生成场景',exact:true}).click();
  await page.getByRole('tab',{name:'实时画面'}).click();
  await page.getByRole('button',{name:'停止画面生成'}).click();
  await page.getByRole('tab',{name:'写下场景'}).click();
  await expect(page.getByText('已暂停创作',{exact:true})).toBeVisible();
});

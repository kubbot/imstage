import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import fs from 'node:fs';
const fixture=JSON.parse(fs.readFileSync(new URL('../../tools/eval/fixtures/loan-anniversary.json',import.meta.url),'utf8'));

async function ready(page:Page, login=false) {
  await page.goto('/#/create?case=loan-anniversary');
  if(login) {
    const r=await page.request.post('/api/auth/register',{headers:{Origin:new URL(page.url()).origin,'X-IMStage-Request':'1'},data:{email:`timeline-${crypto.randomUUID()}@example.test`,name:'合成测试',password:'synthetic-case-password-2026'}});
    expect(r.ok()).toBeTruthy();await page.reload();
  }
  await expect(page.locator('.agent-phone')).toContainText('这笔借款结清了');
}
async function drop(page:Page,count=1,invalid=false) {
  const data=await sharp({create:{width:24,height:24,channels:3,background:'#b33f28'}}).png().toBuffer();
  await page.locator('.agent-chat').evaluate((el,{base64,count,invalid})=>{
    const dt=new DataTransfer();
    for(let i=0;i<count;i++)dt.items.add(new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],invalid?'bad.txt':`synthetic-${i}.png`,{type:invalid?'text/plain':'image/png'}));
    el.dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:dt}));
    el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));
  },{base64:data.toString('base64'),count,invalid});
}

test('iPhone timeline has two dates, editable historical dates and full PNG; sample preserves normal draft',async({page})=>{
  await page.goto('/#/create');
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('保留我的正常草稿');
  await page.getByRole('link',{name:/打开合成案例/}).click();
  const dates=page.locator('.agent-phone .scene-date');
  await expect(dates).toHaveText(['2025年9月21日','今天']);
  await page.getByRole('button',{name:`选择消息：${fixture.scene.messages[0].text}`,exact:true}).click();
  await expect(page.getByLabel('发送日期',{exact:true})).toHaveValue('2025-09-21');
  await page.reload();await expect(dates).toHaveText(['2025年9月21日','今天']);
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();
  const download=await downloaded;await download.saveAs(`${process.env.IMSTAGE_ARTIFACT_DIR}/loan-anniversary.png`);
  const meta=await sharp((await download.path())!).metadata();expect(meta.width).toBe(1206);expect(meta.height).toBeGreaterThan(1500);
  await page.getByLabel('导出图片范围').selectOption('standard');
  const standard=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();
  const standardMeta=await sharp((await(await standard).path())!).metadata();expect([standardMeta.width,standardMeta.height]).toEqual([1206,2622]);
  await page.goto('/#/create');await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('保留我的正常草稿');
});

test('drag reference: transfers to submitted turn immediately, targets selected message and clears on success',async({page})=>{
  await ready(page,true);await drop(page);
  await expect(page.locator('.agent-attachments img')).toHaveCount(1);
  await page.getByRole('button',{name:`选择消息：${fixture.scene.messages[0].text}`,exact:true}).click();
  await page.getByRole('button',{name:'当前范围 · 整个对话 切换'}).click();
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  await page.route('**/api/agent/run',async route=>{const {scene,targetId,attachments}=route.request().postDataJSON();expect(targetId).toBe('borrow');expect(attachments).toHaveLength(1);await gate;await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene:{...scene,messages:scene.messages.map((m:{id:string})=>m.id===targetId?{...m,text:'能借我500万元吗？明年今天还。'}:m)}},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});});
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('参考图片，调整这句话');
  await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await expect(page.locator('.agent-attachments img')).toHaveCount(0);await expect(page.locator('.agent-chat .agent-sent-attachments img')).toHaveCount(1);
  release();await expect(page.locator('.agent-phone')).toContainText('明年今天还。');await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('');
});

for(const mode of ['error','cancel'])test(`attachment restored on ${mode} with original prompt`,async({page})=>{
  await ready(page,true);await drop(page);
  await page.route('**/api/agent/run',async route=>{if(mode==='cancel')await new Promise(r=>setTimeout(r,1200));await route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'error',message:'合成失败测试'})+'\n'}).catch(()=>{});});
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('保留这张参考图');await page.getByRole('button',{name:'开始生成',exact:true}).click();
  if(mode==='cancel')await page.getByRole('button',{name:'停止生成',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText(mode==='cancel'?'已停止':'合成失败测试');await expect(page.locator('.agent-attachments img')).toHaveCount(1);await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('保留这张参考图');
});

test('invalid/extra dropped files preserve usable attachments; right AI leaves the left draft intact',async({page})=>{
  await ready(page,true);await drop(page);await drop(page,1,true);await expect(page.locator('.agent-attachments img')).toHaveCount(1);
  await drop(page,3);await expect(page.locator('.agent-attachments img')).toHaveCount(3);await expect(page.getByRole('alert')).toContainText('最多添加 3 张');
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('左侧未发送的需求');
  await page.getByRole('button',{name:`选择消息：${fixture.scene.messages[0].text}`,exact:true}).click();await page.getByRole('button',{name:'AI 修改',exact:true}).click();
  await page.route('**/api/agent/run',route=>{expect(route.request().postDataJSON().attachments).toEqual([]);return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'error',message:'合成局部失败'})+'\n'});});
  await page.getByLabel('描述想怎样修改').fill('局部改写');await page.getByRole('button',{name:'发送修改',exact:true}).click();await expect(page.getByRole('alert')).toContainText('合成局部失败');await expect(page.locator('.agent-attachments img')).toHaveCount(3);await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('左侧未发送的需求');
});

test('copy writes a real PNG clipboard payload with the same dimensions as download',async({page,context})=>{
  await ready(page);await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.getByRole('button',{name:'复制图片',exact:true}).click();await expect(page.getByRole('status')).toContainText('图片已复制');
  const result=await page.evaluate(async()=>{const entries=await navigator.clipboard.read();const png=await entries[0].getType('image/png');const bytes=new Uint8Array(await png.arrayBuffer());const bitmap=await createImageBitmap(png);return {signature:[...bytes.slice(0,8)],width:bitmap.width,height:bitmap.height};});
  expect(result.signature).toEqual([137,80,78,71,13,10,26,10]);expect(result.width).toBe(1206);expect(result.height).toBeGreaterThan(1500);
});

for(const reason of ['unavailable','denied'])test(`copy ${reason} offers the rendered image instead of false success`,async({page})=>{
  await ready(page);await page.evaluate(reason=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:reason==='unavailable'?undefined:{write:()=>Promise.reject(new DOMException('blocked','NotAllowedError'))}}),reason);
  await page.getByRole('button',{name:'复制图片',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'图片复制备选方式'})).toBeVisible();await expect(page.getByRole('status')).not.toContainText('图片已复制');
  const size=await page.getByRole('img',{name:'可长按复制的聊天图片'}).evaluate((img:HTMLImageElement)=>({width:img.naturalWidth,height:img.naturalHeight}));expect(size.width).toBe(1206);expect(size.height).toBeGreaterThan(1500);
});

test('iPhone viewport keeps canvas actions reachable',async({page})=>{
  await page.setViewportSize({width:402,height:874});await ready(page);
  await page.getByRole('button',{name:/渲染画面/}).click();await expect(page.getByRole('button',{name:'复制图片',exact:true})).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
  await page.screenshot({path:`${process.env.IMSTAGE_ARTIFACT_DIR}/loan-mobile-editor.png`});
});

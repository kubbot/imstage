import {test,expect,type Page} from '@playwright/test';
import sharp from 'sharp';
import fs from 'node:fs/promises';
const out=process.env.IMSTAGE_ARTIFACT_DIR!;
// SVG icon antialiasing can vary by one pixel between canvas rasterizations.
function mismatchFraction(a:Buffer,b:Buffer){expect(a.length).toBe(b.length);let n=0;for(let i=0;i<a.length;i+=4)if(!a.subarray(i,i+4).equals(b.subarray(i,i+4)))n++;return n/(a.length/4);}
async function ready(page:Page){
 const fixture=JSON.parse(await fs.readFile(new URL('../../tools/eval/fixtures/loan-anniversary.json',import.meta.url),'utf8'));
 const scene={...fixture.scene,messages:Array.from({length:22},(_,i)=>({id:`line-${i}`,participantId:i%2?'me':'achuan',type:'text',text:`合成消息 ${i+1}：这是一段用于验证可见窗口截取位置的对话。`,date:i<11?'2025-09-21':'2026-09-21',time:`10:${String(i).padStart(2,'0')}`}))};
 await page.addInitScript(scene=>sessionStorage.setItem('imstage.agent.guest.case-loan-anniversary',JSON.stringify({scene})),scene);
 await page.setViewportSize({width:1800,height:1400});await page.goto('/#/create?case=loan-anniversary');
 await page.getByLabel('导出图片范围').selectOption('standard');
 await expect(page.locator('.agent-phone .scene-row')).toHaveCount(22);
}
async function png(page:Page,name:string){const event=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();const download=await event;const file=`${out}/${name}.png`;await download.saveAs(file);return fs.readFile(file);}

test('drag at scaled zoom scrolls content, preserves chrome, suppresses selection and allows a subsequent click',async({page})=>{
 await ready(page);await page.getByRole('button',{name:'缩小画布'}).click();await page.getByRole('button',{name:'缩小画布'}).click();
 const region=page.getByRole('region',{name:'聊天内容，可滚动调整截取范围'});const header=await page.locator('.agent-phone .scene-header').boundingBox();const composer=await page.locator('.agent-phone .scene-composer').boundingBox();
 const r=(await region.boundingBox())!;const scale=await region.evaluate(el=>el.getBoundingClientRect().height/(el as HTMLElement).offsetHeight);
 await page.mouse.move(r.x+r.width/2,r.y+r.height*.7);await page.mouse.down();await page.mouse.move(r.x+r.width/2,r.y+r.height*.7-100,{steps:12});await page.mouse.up();
 await expect.poll(()=>region.evaluate(el=>el.scrollTop)).toBeGreaterThan(90/scale);
 expect(await page.locator('.scene-selectable.is-selected').count()).toBe(0);
 expect(await page.locator('.agent-phone .scene-header').boundingBox()).toEqual(header);expect(await page.locator('.agent-phone .scene-composer').boundingBox()).toEqual(composer);
 const before=await region.evaluate(el=>el.scrollTop);await page.mouse.wheel(0,220);await expect.poll(()=>region.evaluate(el=>el.scrollTop)).toBeGreaterThan(before);
 await region.evaluate(el=>el.scrollTop=0);await page.getByRole('button',{name:'选择消息：合成消息 1：这是一段用于验证可见窗口截取位置的对话。',exact:true}).click();await expect(page.getByLabel('消息文字',{exact:true})).toContainText('合成消息 1');
});

test('PNG and clipboard match the currently visible crop; full export still contains the whole conversation',async({page,context})=>{
 await ready(page);await expect(page.getByRole('complementary',{name:'Vibe Edit'})).toHaveCount(0);
 const region=page.getByRole('region',{name:'聊天内容，可滚动调整截取范围'});
 const top=await png(page,'crop-top');
 await region.evaluate(el=>el.scrollTop=543);
 const before=await region.evaluate(el=>el.scrollTop);
 await page.locator('.agent-phone .scene-view').screenshot({path:`${out}/crop-visible.png`});
 const cropped=await png(page,'crop-export');expect(await region.evaluate(el=>el.scrollTop)).toBe(before);
 const meta=await sharp(cropped).metadata();expect([meta.width,meta.height]).toEqual([1206,2622]);expect(cropped.equals(top)).toBeFalsy();
 // Compare the visible message interior, excluding the preview-only bezel.
 // A one-pixel blur removes browser-vs-PNG glyph antialiasing noise.
 const visible=await sharp(`${out}/crop-visible.png`).resize(402,874).extract({left:12,top:100,width:378,height:680}).blur(1).removeAlpha().raw().toBuffer();
 const decoded=await sharp(cropped).resize(402,874).extract({left:12,top:100,width:378,height:680}).blur(1).removeAlpha().raw().toBuffer();
 const error=visible.reduce((sum,p,i)=>sum+Math.abs(p-decoded[i]),0)/visible.length;expect(error).toBeLessThan(4);
 const wrong=await sharp(top).resize(402,874).extract({left:12,top:100,width:378,height:680}).blur(1).removeAlpha().raw().toBuffer();expect(visible.reduce((sum,p,i)=>sum+Math.abs(p-wrong[i]),0)/visible.length).toBeGreaterThan(20);
 const headA=await sharp(top).extract({left:0,top:0,width:1206,height:220}).raw().toBuffer();const headB=await sharp(cropped).extract({left:0,top:0,width:1206,height:220}).raw().toBuffer();expect(mismatchFraction(headA,headB)).toBeLessThan(.00001);
 const footA=await sharp(top).extract({left:0,top:2440,width:1206,height:182}).raw().toBuffer();const footB=await sharp(cropped).extract({left:0,top:2440,width:1206,height:182}).raw().toBuffer();expect(mismatchFraction(footA,footB)).toBeLessThan(.00001);
 await context.grantPermissions(['clipboard-read','clipboard-write']);await page.getByRole('button',{name:'复制图片',exact:true}).click();await expect(page.getByRole('status')).toContainText('图片已复制');
 const bytes=await page.evaluate(async()=>[...new Uint8Array(await(await(await navigator.clipboard.read())[0].getType('image/png')).arrayBuffer())]);
 const copied=await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer();expect(mismatchFraction(copied,await sharp(cropped).ensureAlpha().raw().toBuffer())).toBeLessThan(.00001);
 await fs.writeFile(`${out}/crop-copy.png`,Buffer.from(bytes));
 await page.getByLabel('导出图片范围').selectOption('full');const full=await png(page,'crop-full');expect((await sharp(full).metadata()).height).toBeGreaterThan(2622);
 await page.getByLabel('导出图片范围').selectOption('standard');await region.evaluate(el=>el.scrollTop=0);await page.getByLabel('导出图片范围').selectOption('full');expect(mismatchFraction(await sharp(await png(page,'crop-full-top')).ensureAlpha().raw().toBuffer(),await sharp(full).ensureAlpha().raw().toBuffer())).toBeLessThan(.00001);
});

test('message list reveals the selected row by scrolling while retaining standard mode',async({page})=>{
 await ready(page);await page.getByRole('button',{name:'元素 22',exact:true}).click();await page.locator('.element-item').filter({hasText:'合成消息 22：'}).click();
 await expect(page.getByLabel('导出图片范围')).toHaveValue('standard');await expect.poll(()=>page.locator('.agent-phone .scene-messages').evaluate(el=>el.scrollTop)).toBeGreaterThan(1000);
 await expect(page.getByRole('button',{name:'选择消息：合成消息 22：这是一段用于验证可见窗口截取位置的对话。',exact:true})).toBeInViewport();
});

test('phone touch gesture scrolls inside the fixed screenshot window',async({browser})=>{
 const context=await browser.newContext({viewport:{width:402,height:874},isMobile:true,hasTouch:true,deviceScaleFactor:3});const page=await context.newPage();
 try{
  // Keep the same isolated fixture, then exercise Chromium's native touch scrolling.
  await ready(page);await page.setViewportSize({width:402,height:874});
  await page.getByRole('button',{name:/渲染画面/}).click();
  const region=page.getByRole('region',{name:'聊天内容，可滚动调整截取范围'});const r=(await region.boundingBox())!;const header=await page.locator('.agent-phone .scene-header').boundingBox();
  const cdp=await context.newCDPSession(page);const x=r.x+r.width/2,y=r.y+r.height*.8;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let step=1;step<=10;step++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-r.height*.5*step/10}]});await page.waitForTimeout(16);}
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(()=>region.evaluate(el=>el.scrollTop)).toBeGreaterThan(80);
  await expect(page.getByLabel('导出图片范围')).toHaveValue('standard');expect(await page.locator('.agent-phone .scene-header').boundingBox()).toEqual(header);
  await page.screenshot({path:`${out}/crop-touch.png`});
 }finally{await context.close();}
});

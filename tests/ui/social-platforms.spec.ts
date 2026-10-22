import {test,expect} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {createScene,type Scene,type Platform} from '../../apps/web/src/studio/model';
import {renderStudioHtml} from '../../services/mcp/studio-html.mjs';
import {renderSceneHtml} from '../../packages/renderer/renderSceneHtml.mjs';
import {assertDisclosureInPng} from './pngEvidence';
test.use({locale:'zh-CN'});
const out=process.env.IMSTAGE_ARTIFACT_DIR||'.local/get217';
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function fixture(platform:Platform,kind:string):Scene{
 const s=createScene();return {...s,id:`synthetic-${platform}-${kind}`,platform,title:'合成评测 · 展览计划',headerText:'小满 · Synthetic',date:'2026年10月22日',surface:'ios',deviceProfileId:undefined,watermarkEnabled:true,participants:[{id:'me',name:'阿远'},{id:'friend',name:'小满'}],selfId:'me',messages:kind==='A'?[
 {id:'one',participantId:'friend',type:'text',text:'周六去看展吗？这是合成对话。',time:'10:06'},
 {id:'two',participantId:'me',type:'text',text:'好呀！See you at 14:00. ☀️',time:'10:07',quote:'周六去看展吗？'},
 {id:'three',participantId:'friend',type:'text',text:'门口见，记得带相机。',time:'10:08'}
 ]:kind==='B'?[
 {id:'one',participantId:'friend',type:'text',text:'中文换行与多语言边界。\nHello world — 日本語、한국어、العربية。\n'+ 'LongUnbrokenToken'.repeat(12),time:'10:06'},
 {id:'two',participantId:'me',type:'image',text:'合成媒体样本',asset:image,time:'10:07'},
 {id:'three',participantId:'friend',type:'album',text:'合成相册',items:[{id:'a',kind:'image',asset:image,caption:'样本 A'},{id:'b',kind:'image',asset:image,caption:'样本 B'}],time:'10:08'}
 ]:[
 {id:'one',participantId:'friend',type:'text',text:'这是一段长图合成验收。'+ '保留中文标点与段落，确保内容完整。'.repeat(16),time:'10:06'},
 {id:'state',participantId:'',type:'system',text:'合成状态：对话已开始',time:''},
 {id:'two',participantId:'me',type:'voice',text:'12秒',voiceTranscript:'合成文字稿：We will meet at the gallery.\n这不是实际音频转录。',time:'10:07'},
 {id:'three',participantId:'friend',type:'link',text:'展览指南 · Synthetic guide',subtitle:'合成链接卡片，无外部跳转',asset:image,time:'10:08'},
 {id:'end',participantId:'me',type:'text',text:'END · 全部内容已保留。',time:'10:09'}
 ]};
}
for(const platform of ['x','jike','threads','xiaohongshu'] as Platform[]){
 for(const kind of ['A','B','C']) test(`${platform} ${kind}: real editor select edit undo recover and PNG download`,async({page})=>{
  test.setTimeout(60000);await fs.mkdir(out,{recursive:true});const events:string[]=[];page.on('pageerror',e=>events.push(e.message));
  const scene=fixture('wechat',kind);await page.goto('/#/create');
  await page.evaluate(s=>sessionStorage.setItem('imstage.agent.guest.draft',JSON.stringify({scene:s})),scene);
  await page.reload();await expect(page.locator('.agent-phone')).toContainText(scene.messages[0].text);
  const selector=page.getByLabel('目标聊天平台',{exact:true});await selector.selectOption(platform);
  const view=page.locator('.agent-phone .scene-view');await expect(view).toHaveAttribute('data-platform',platform);
  await page.locator('.agent-phone [data-message-id="one"] .scene-message-select').click();
  const text=page.getByLabel('消息文字',{exact:true});await text.fill('编辑已生效 · Edited synthetic message');await text.blur();
  await expect(view).toContainText('编辑已生效');await page.getByRole('button',{name:'撤销上次修改',exact:true}).click();
  await expect(view).toContainText(scene.messages[0].text);await page.getByRole('button',{name:'关闭 AI 编辑',exact:true}).click();
  await expect(selector).toHaveValue(platform);await page.reload();await expect(selector).toHaveValue(platform);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();
  const exported=path.join(out,`${platform}-${kind}-editor-export.png`);await(await download).saveAs(exported);await assertDisclosureInPng(exported);
  const meta=await sharp(exported).metadata();expect(meta.width).toBeGreaterThanOrEqual(640);expect(events).toEqual([]);
  await page.screenshot({path:path.join(out,`${platform}-${kind}-editor-desktop.png`)});
  await page.setViewportSize({width:390,height:900});await page.getByRole('button',{name:/渲染画面/}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();await page.screenshot({path:path.join(out,`${platform}-${kind}-editor-mobile.png`)});
  await fs.writeFile(path.join(out,`${platform}-${kind}-editor-operations.json`),JSON.stringify({platform,seed:scene,actions:['seed synthetic local draft','select template','select message','edit text','assert edited output','undo','assert original','close edit','reload','assert platform restored','download PNG','verify PNG disclosure pixels','mobile viewport'],png:{width:meta.width,height:meta.height},errors:events},null,2));
 });
 for(const kind of ['A','B','C'])test(`${platform}: actual ${kind} shared and HTML renders`,async({page})=>{
  await fs.mkdir(out,{recursive:true});const scene=fixture(platform,kind),width=kind==='B'?320:390;
  await fs.writeFile(path.join(out,`${platform}-${kind}-input.json`),JSON.stringify(scene,null,2));
  for(const renderer of ['shared','html']){
   const html=renderer==='shared'?await renderStudioHtml(scene,{width,height:844,outputKind:'long-screenshot'}):renderSceneHtml(scene,{width,surface:'ios',outputKind:'long-screenshot'});
   await page.setViewportSize({width,height:900});await page.setContent(html);await page.evaluate(()=>document.fonts.ready);
   if(renderer==='shared' && ['x','threads'].includes(platform)){
    const header=await page.locator('.scene-header').evaluate(e=>{const title=e.querySelector('.scene-header-title')!.getBoundingClientRect(),menu=e.querySelector('.scene-header-more')!.getBoundingClientRect();return {width:title.width,sameRow:Math.abs(title.top-menu.top)<24};});expect(header.width).toBeGreaterThan(100);expect(header.sameRow).toBeTruthy();
   }
   if(kind==='A')await expect(rootOrDevice(page).locator(renderer==='shared'?'.scene-quote':'.quote')).toContainText(scene.messages.find(m=>m.quote)!.quote!);
   if(kind==='B')expect(await page.locator(renderer==='shared'?'.scene-album img':'.album img').count()).toBe(2);
   if(kind==='C')await expect(rootOrDevice(page)).toContainText('合成链接卡片，无外部跳转');
   const root=page.locator('.device');await expect(root).toContainText(kind==='C'?'END · 全部内容已保留。':kind==='B'?'LongUnbrokenToken':'门口见');
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);expect(overflow).toBeFalsy();
   if(renderer==='shared'){expect(await page.locator('.scene-messages').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBeTruthy();await expect(page.locator('.scene-view')).toHaveAttribute('data-platform',platform);}
   await root.screenshot({path:path.join(out,`${platform}-${kind}-${renderer}.png`)});
  }
 });
}

function rootOrDevice(page:import('@playwright/test').Page){return page.locator('.device');}

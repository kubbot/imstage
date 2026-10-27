import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import {createScene} from '../../apps/web/src/studio/model';
import {renderSceneHtml} from '../../packages/renderer/renderSceneHtml.mjs';
import {assertDisclosureInPng} from './pngEvidence';

test.use({locale:'zh-CN'});
const out=process.env.IMSTAGE_ARTIFACT_DIR||'.local/studio-chrome';
const scene={...createScene(),deviceProfileId:'iphone-15-pro',title:'合成排版验收',headerText:'小满',watermarkEnabled:true,participants:[{id:'me',name:'阿远'},{id:'achuan',name:'小满'}],selfId:'me',messages:[
 {id:'one',participantId:'achuan',type:'text' as const,text:'周六一起去看展吗？',time:'10:06'},
 {id:'two',participantId:'me',type:'text' as const,text:'好呀，下午两点见。\nSynthetic conversation.',time:'10:07'},
]};
async function ready(page:Page,width=1280,height=900){
 await fs.mkdir(out,{recursive:true});
 await page.setViewportSize({width,height});
 await page.addInitScript(s=>{if(sessionStorage.getItem('chrome-seeded'))return;sessionStorage.setItem('chrome-seeded','1');sessionStorage.setItem('imstage.agent.guest.draft',JSON.stringify({scene:s}));},scene);
 await page.goto('/#/create');await expect(page.locator('.agent-phone [data-message-id="one"]')).toBeAttached();
}

test('neutral Studio gives the preview most space and preserves saved panel widths',async({page})=>{
 await ready(page);
 const chat=page.locator('.agent-chat'),canvas=page.locator('.agent-render');
 expect((await chat.boundingBox())!.width).toBe(360);
 expect((await canvas.boundingBox())!.width).toBeGreaterThan((await chat.boundingBox())!.width*2);
 expect((await page.locator('.agent-render-toolbar').boundingBox())!.height).toBeLessThanOrEqual(64);
 await expect(page.locator('.agent-canvas-caption')).toBeInViewport({ratio:1});
 await page.screenshot({path:`${out}/studio-chrome-1280.png`});
 await page.evaluate(()=>localStorage.setItem('imstage.creation-width','480'));
 await page.reload();await expect.poll(async()=>(await chat.boundingBox())!.width).toBe(480);
 await page.getByRole('separator',{name:'调整创作区宽度'}).focus();await page.keyboard.press('Home');
 await expect.poll(async()=>(await chat.boundingBox())!.width).toBe(360);
});

test('site themes leave template typography, colours and downloaded PNG pixels intact',async({page})=>{
 test.setTimeout(90_000);const errors:string[]=[],paidRequests:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().includes('/api/agent/'))paidRequests.push(r.url());});
 await ready(page);await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
 await page.getByLabel('导出图片范围',{exact:true}).selectOption('standard');
 for(const platform of ['wechat','xiaohongshu','jike']){
  await page.getByLabel('目标聊天平台',{exact:true}).selectOption(platform);
  let reference:Buffer|undefined;
  for(const theme of [0,2,1]){
   await page.locator('.site-header .theme-picker button').nth(theme).click();
   expect(await page.locator('.agent-workspace').evaluate(e=>getComputedStyle(e).getPropertyValue('--surface').trim())).toBe('#202125');
   const root=page.locator('.agent-phone .scene-view');
   await expect(root).toHaveCSS('background-color',platform==='wechat'?'rgb(245, 245, 245)':platform==='jike'?'rgb(247, 248, 250)':'rgb(255, 255, 255)');
   await expect(root.locator('.scene-bubble').first()).toHaveCSS('font-size','16px');
   const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();
   const file=`${out}/studio-${platform}-theme-${theme}.png`;await(await download).saveAs(file);
   await assertDisclosureInPng(file);const meta=await sharp(file).metadata();expect([meta.width,meta.height]).toEqual([1179,2556]);
   const pixels=await sharp(file).ensureAlpha().raw().toBuffer();
   if(reference)expect(pixels.equals(reference),`${platform} pixels must not inherit site theme`).toBeTruthy();else reference=pixels;
  }
 }
 expect(errors).toEqual([]);expect(paidRequests).toEqual([]);
});

test('social background tokens reach standalone deterministic renders and custom backgrounds win',async({page})=>{
 for(const [platform,bg] of [['jike','rgb(247, 248, 250)'],['xiaohongshu','rgb(255, 255, 255)']] as const){
  await page.setContent(renderSceneHtml({...scene,platform},{width:393,height:852,surface:'ios',outputKind:'screenshot'}));
  await expect(page.locator('.scene-view')).toHaveCSS('background-color',bg);
  await page.setContent(renderSceneHtml({...scene,platform,layout:{kind:'custom',name:'合成自定义',background:'#ddffee'}},{width:393,surface:'ios',outputKind:'screenshot'}));
  await expect(page.locator('.scene-view')).toHaveCSS('background-color','rgb(221, 255, 238)');
 }
});

test('narrow preview, enlarged controls and empty state keep export and editing reachable',async({page})=>{
 await ready(page,390,844);await page.emulateMedia({reducedMotion:'reduce'});
 await page.getByRole('button',{name:'渲染画面',exact:true}).click();
 await expect(page.getByRole('button',{name:'导出 PNG',exact:true})).toBeInViewport();
 await expect(page.locator('.agent-canvas-caption')).toBeInViewport({ratio:1});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
 await page.screenshot({path:`${out}/studio-chrome-390.png`});
 // Enlarge UI text only; the artwork retains its explicitly selected pixel size.
 await page.locator('.agent-render-toolbar').evaluate(el=>{for(const n of el.querySelectorAll('button,select,.canvas-platform>span')){const e=n as HTMLElement;e.style.fontSize=`${parseFloat(getComputedStyle(e).fontSize)*2}px`;}});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
 await expect(page.getByRole('button',{name:'导出 PNG',exact:true})).toBeInViewport();
 await page.screenshot({path:`${out}/studio-chrome-text-200.png`});
 await page.getByRole('button',{name:'创作 Chat',exact:true}).click();await page.getByLabel('描述想生成的聊天',{exact:true}).fill('保留这个未发送草稿。');
 await expect(page.locator('.session-toggle small')).toHaveText('已保存到本机');await page.reload();
 await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('保留这个未发送草稿。');
 await page.getByRole('button',{name:'新建会话',exact:true}).click();
 await page.getByRole('button',{name:'渲染画面',exact:true}).click();await expect(page.getByRole('button',{name:'导出 PNG',exact:true})).toBeDisabled();
});

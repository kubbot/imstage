import { test, expect } from '@playwright/test';
import { createScene } from '../../apps/web/src/studio/model';
import { renderStudioHtml } from '../../services/mcp/studio-html.mjs';
import { renderSceneHtml } from '../../packages/renderer/renderSceneHtml.mjs';
import { markOnboarded } from './prefs';
import sharp from 'sharp';
test.use({locale:'zh-CN'});
const artifact=process.env.IMSTAGE_ARTIFACT_DIR || '.local';
function fixture(){const s=createScene();return {...s,platform:'whatsapp' as const,date:'Today',participants:[{id:'me',name:'我'},{id:'andrej',name:'Andrej Karpathy'}],selfId:'me',messages:[
 {id:'short',participantId:'me',type:'text' as const,text:'Code first?',time:'09:43'},
 {id:'long',participantId:'andrej',type:'text' as const,text:'Start small. Build a tiny neural network and understand every step. Then experiment with different inputs.',time:'09:44'},
 {id:'multiline',participantId:'me',type:'text' as const,text:'Yes.\nRead the code, change it, and test your assumptions.',time:'09:45'},
 {id:'untimed',participantId:'andrej',type:'text' as const,text:'Keep learning.',time:''},
]};}
for(const renderer of ['shared','html'] as const)test(`WhatsApp timestamp geometry: ${renderer}`,async({page})=>{
 const scene=fixture();
 await page.setContent(renderer==='shared'?await renderStudioHtml(scene,{width:390,height:844,outputKind:'screenshot'}):renderSceneHtml(scene,{width:390,surface:'ios'}));
 const bubbles=renderer==='shared'?'.scene-whatsapp-text':'.bubble-whatsapp-text';
 const meta=renderer==='shared'?'.scene-message-meta':'.meta';
 const text=renderer==='shared'?'.scene-message-text':'.bubble-text';
 const geometry=await page.locator(bubbles).evaluateAll((nodes,{meta,text})=>nodes.map(node=>{
  const m=node.querySelector(meta);const r=node.getBoundingClientRect();const span=node.querySelector(text)!;const range=document.createRange();range.selectNodeContents(span);const lines=Array.from(range.getClientRects()).filter(r=>r.width>0);const last=lines.at(-1)!;const mr=m?.getBoundingClientRect();
  return {hasMeta:!!m,inside:!mr||(mr.left>=r.left&&mr.right<=r.right+1&&mr.top>=r.top&&mr.bottom<=r.bottom+1),overlap:!!mr&&lines.some(l=>Math.min(l.right,mr.right)>Math.max(l.left,mr.left)+1&&Math.min(l.bottom,mr.bottom)>Math.max(l.top,mr.top)+1),sameLine:!!mr&&Math.min(last.bottom,mr.bottom)>Math.max(last.top,mr.top),text:span.textContent};
 }),{meta,text});
 expect(geometry).toHaveLength(4);expect(geometry.every(g=>g.inside&&!g.overlap)).toBeTruthy();expect(geometry[0].sameLine).toBeTruthy();expect(geometry[2].text).toContain('\n');expect(geometry[3].hasMeta).toBeFalsy();
 if(renderer==='shared'){
  await expect(page.locator('.is-other .scene-message-meta svg')).toHaveCount(0);
  await expect(page.locator('.is-self .scene-message-meta svg')).toHaveCount(2);
  await page.setContent(await renderStudioHtml({...scene,layout:{kind:'custom',name:'Custom'}},{width:390,height:844,outputKind:'screenshot'}));await expect(page.locator(bubbles)).toHaveCount(0);
  await page.setContent(await renderStudioHtml({...scene,platform:'wechat'},{width:390,height:844,outputKind:'screenshot'}));await expect(page.locator(bubbles)).toHaveCount(0);
 }
});
test('template tool stream selects WhatsApp in the real editor and exports PNG',async({page})=>{
 test.setTimeout(60000);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/#/create');const origin=new URL(page.url()).origin;
 const registration=await page.request.post('/api/auth/register',{headers:{Origin:origin,'X-IMStage-Request':'1'},data:{email:`whatsapp-${crypto.randomUUID()}@example.test`,name:'创作者',password:'synthetic-whatsapp-password-2026'}});expect(registration.ok()).toBeTruthy();await markOnboarded(page);
 await page.route('**/api/agent/capabilities',r=>r.fulfill({json:{configured:true,model:'test',imageConfigured:false}}));await page.reload();
 await page.route('**/api/agent/run',r=>{const {scene}=r.request().postDataJSON();const events=[{type:'tool',id:'select',name:'select_template',state:'running',detail:'正在选择聊天模板…'},{type:'scene',scene:{...scene,platform:'whatsapp'}},{type:'tool',id:'select',name:'select_template',state:'done',detail:'已选择 WhatsApp 模板'},{type:'scene',scene:{...fixture(),id:scene.id}},{type:'done'}];return r.fulfill({contentType:'application/x-ndjson',body:events.map(e=>JSON.stringify(e)).join('\n')+'\n'});});
 await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成一个 和 Andrej Karpathy 聊天的 Whatsapp');await page.getByRole('button',{name:'开始生成',exact:true}).click();
 await expect(page.getByLabel('目标聊天平台',{exact:true})).toHaveValue('whatsapp');await expect(page.locator('.agent-phone')).toContainText('Andrej Karpathy');await expect(page.locator('.agent-phone .scene-whatsapp-text')).toHaveCount(4);
 for(const width of [1440,390]){await page.setViewportSize({width,height:960});if(width===390)await page.getByRole('button',{name:/渲染画面/}).click();await page.screenshot({path:`${artifact}/whatsapp-editor-${width}.png`});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();}
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG'}).click();const file=await(await download).path();const png=await sharp(file!).metadata();expect(png.format).toBe('png');expect(png.width).toBeGreaterThan(300);await sharp(file!).toFile(`${artifact}/whatsapp-export.png`);
 expect(errors).toEqual([]);await page.reload();await expect(page.getByLabel('目标聊天平台',{exact:true})).toHaveValue('whatsapp');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {buildRenderWidgetHtml} from '../services/mcp/widget.mjs';
import {resolveChromiumExecutable} from '../services/mcp/render.mjs';
import {renderStudioHtml} from '../services/mcp/studio-html.mjs';
import {EXAMPLE_CREATE_SCENE,prepareCreateScene} from '../services/mcp/scene.mjs';
import {PLATFORMS} from '../apps/web/src/studio/model.ts';

test('shared Web render preserves all platforms, appearance, media cards and escaped text',async()=>{
 for(const platform of PLATFORMS){
  const scene=prepareCreateScene({...structuredClone(EXAMPLE_CREATE_SCENE),platform,background:'#dceeff',messages:[{id:'voice',participantId:'p-ayuan',type:'voice',text:'12 秒',time:'09:41'},{id:'transfer',participantId:'p-linxiaoman',type:'transfer',text:'演示卡片',time:'09:42'}]});
  const html=await renderStudioHtml(scene,{width:390,height:844,outputKind:'screenshot'});
  assert.ok(html.includes(`data-platform="${platform}"`));assert.ok(html.includes('演示卡片'));assert.ok(html.includes('scene-transfer'));assert.ok(html.includes('12 秒'));assert.ok(html.includes('#dceeff'));assert.equal(/<script/i.test(html),false);
 }
});

test('MCP Apps bridge actually displays the result, exports PNG and targets the same scene on follow-up',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage({viewport:{width:650,height:900}});const failures=[];page.on('pageerror',e=>failures.push(e.message));
  await page.setContent('<html><body></body></html>');
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await page.evaluate(({html,png})=>{
   window.bridgeCalls=[];
   const frame=document.createElement('iframe');frame.style.cssText='width:600px;height:800px';
   const result={structuredContent:{sceneId:'scn_'+ 'a'.repeat(32),revision:3,title:'咖啡约定',width:390,height:844,platform:'wechat'},_meta:{preview:{dataUri:'data:image/png;base64,'+png}}};
   window.pushResult=(r)=>frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:r},'*');
   addEventListener('message',e=>{const m=e.data;if(m?.jsonrpc!=='2.0')return;window.bridgeCalls.push(m);
    if(m.id!==undefined)frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:m.method==='ui/initialize'?{protocolVersion:'2026-01-26',hostCapabilities:{downloadFile:{}}}:{}},'*');
    if(m.method==='ui/notifications/initialized')window.pushResult(result);
   });
   frame.srcdoc=html;document.body.append(frame);
  },{html:buildRenderWidgetHtml(),png});
  const frame=page.frameLocator('iframe');await frame.locator('#preview-img').waitFor({state:'visible'});
  assert.equal(await frame.locator('#scene-title').innerText(),'咖啡约定');
  assert.equal(await frame.locator('#preview-img').evaluate(e=>e.naturalWidth),1);
  await frame.locator('#edit-input').fill('只把最后一句改得更轻松');await frame.locator('#edit-submit').click();
  await frame.locator('#status').filter({hasText:'已把修改'}).waitFor();
  await frame.locator('#download').click();await frame.locator('#status').filter({hasText:'宿主已接受'}).waitFor();
  const calls=await page.evaluate(()=>window.bridgeCalls);
  const message=calls.find(c=>c.method==='ui/message');assert.match(message.params.content[0].text,/revision 3/);assert.match(message.params.content[0].text,/scn_aaaa/);assert.match(message.params.content[0].text,/最后一句/);
  const download=calls.find(c=>c.method==='ui/download-file');assert.equal(download.params.contents[0].resource.blob,png);
  await page.evaluate(()=>window.pushResult({isError:true}));await frame.locator('#preview').waitFor({state:'hidden'});assert.deepEqual(failures,[]);
 }finally{await browser.close()}
});

test('ChatGPT Work metadata-only results load initially and on partial globals updates', async () => {
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try {
  const page=await browser.newPage();
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await page.addInitScript(({png})=>{
   window.exportCalls=[];
   window.openai={uploadFile:async(file)=>{window.exportCalls.push({type:'upload',mime:file.type,bytes:file.size});return {fileId:'file-test'};},getFileDownloadUrl:async()=>({downloadUrl:'https://files.example.test/artwork.png'}),openExternal:async(arg)=>window.exportCalls.push({type:'open',href:arg.href}),toolOutput:null,toolResponseMetadata:{preview:{dataUri:'data:image/png;base64,'+png},call_tool_result:{structuredContent:{sceneId:'scn_'+ 'b'.repeat(32),revision:3,title:'Work artwork'},content:[]}}};
  },{png});
  await page.goto('about:blank');
  await page.setContent(buildRenderWidgetHtml());
  await page.locator('#preview-img').waitFor({state:'visible'});
  assert.equal(await page.locator('#preview-img').evaluate(e=>e.naturalWidth),1);
  assert.equal(await page.locator('#scene-title').innerText(),'Work artwork');
  assert.match(await page.locator('#scene-meta').innerText(),/revision 3.*scn_bbbb/);
  await page.evaluate(()=>{
   const meta=structuredClone(window.openai.toolResponseMetadata);
   meta.call_tool_result.structuredContent.revision=4;
   meta.call_tool_result.structuredContent.title='Updated artwork';
   dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{toolResponseMetadata:meta}}}));
  });
  assert.equal(await page.locator('#scene-title').innerText(),'Updated artwork');
  assert.match(await page.locator('#scene-meta').innerText(),/revision 4/);
  await page.locator('#download').click();
  await page.locator('#status').filter({hasText:'已打开 PNG'}).waitFor();
  await page.locator('#download').click();
  await page.locator('#status').filter({hasText:'已打开 PNG'}).waitFor();
  const exports=await page.evaluate(()=>window.exportCalls);
  assert.equal(exports.filter(c=>c.type==='upload').length,1);
  assert.ok(exports[0].bytes>0);assert.equal(exports[0].mime,'image/png');
  assert.equal(exports.filter(c=>c.type==='open').length,2);
 } finally { await browser.close(); }
});

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
  await page.getByText('更多',{exact:true}).click();
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

test('result card fits complete artwork, moves technical data to details and clears stale exports',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage({viewport:{width:420,height:900}});
  const sharp=(await import('sharp')).default;
  const png=(await sharp({create:{width:390,height:1200,channels:4,background:'#dedbd7'}}).png().toBuffer()).toString('base64');
  await page.setContent(buildRenderWidgetHtml());
  const result={structuredContent:{sceneId:'synthetic-scene',revision:7,title:'完整长图',width:390,height:1200,webUrl:'https://imstage.org/#/workspace?scene=synthetic-scene'},_meta:{preview:{dataUri:'data:image/png;base64,'+png}}};
  await page.evaluate(r=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:r},'*'),result);
  await page.locator('#preview-img').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#preview-img').naturalHeight===1200);
  const info=await page.locator('#preview-img').evaluate(e=>({width:e.clientWidth,height:e.clientHeight,nw:e.naturalWidth,nh:e.naturalHeight}));
  assert.ok(info.height<=480);assert.ok(info.width<=390);assert.ok(Math.abs(info.width/info.height-390/1200)<0.01);
  assert.equal(await page.locator('#scene-meta').isVisible(),false);
  assert.equal(await page.locator('#long-hint').isVisible(),true);
  await page.getByRole('button',{name:'适合宽度',exact:true}).click();
  assert.equal(await page.locator('#preview').getAttribute('data-fit'),'width');
  assert.ok((await page.locator('#preview-img').boundingBox()).height>480);
  await page.getByText('更多',{exact:true}).click();
  assert.match(await page.locator('#scene-meta').innerText(),/revision 7/);
  await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{sceneId:'new-scene',revision:8,title:'缺少图像'}}},'*'));
  await page.locator('#preview').waitFor({state:'hidden'});
  assert.equal(await page.locator('#download').isVisible(),false);
  assert.equal(await page.locator('#preview-img').getAttribute('src'),null);
  assert.equal(await page.locator('#web-link').getAttribute('href'),null);
  assert.match(await page.locator('#status').innerText(),/未收到有效图片/);
  await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{isError:true}},'*'));
  await page.locator('#toolbar').waitFor({state:'hidden'});
 }finally{await browser.close();}
});

test('rejected follow-up retains the draft, re-enables retry and never silently sends twice',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.evaluate(html=>{
   window.messages=[];
   const f=document.createElement('iframe');document.body.append(f);
   addEventListener('message',e=>{const m=e.data;if(m?.jsonrpc!=='2.0'||m.id===undefined)return;
    if(m.method==='ui/message')window.messages.push(m);
    f.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:m.method==='ui/initialize'?{hostCapabilities:{}}:{isError:true}},'*');
    if(m.method==='ui/initialize')setTimeout(()=>f.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{sceneId:'s',revision:2,title:'草稿'}}},'*'),0);
   });f.srcdoc=html;
  },buildRenderWidgetHtml());
  const frame=page.frameLocator('iframe');await frame.locator('#edit-input').waitFor();
  await frame.locator('#edit-input').fill('保留头像，只改时间');await frame.locator('#edit-submit').click();
  await frame.locator('#status').filter({hasText:'输入已保留'}).waitFor();
  assert.equal(await frame.locator('#edit-input').inputValue(),'保留头像，只改时间');
  assert.equal(await frame.locator('#edit-submit').isEnabled(),true);
  assert.equal(await page.evaluate(()=>window.messages.length),1);
 }finally{await browser.close();}
});

test('host theme updates and repeated results cannot complete an edit; stale download errors cannot replace current state',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage({viewport:{width:420,height:900}});
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await page.goto('about:blank');
  await page.evaluate(png=>{window.openai={sendFollowUpMessage:async()=>{},uploadFile:()=>new Promise((_,reject)=>{window.rejectUpload=reject}),getFileDownloadUrl:async()=>{},openExternal:async()=>{},toolOutput:{sceneId:'s',revision:1,title:'作品'},toolResponseMetadata:{preview:{dataUri:'data:image/png;base64,'+png}}};},png);
  await page.setContent(buildRenderWidgetHtml());
  await page.locator('#edit-input').fill('改时间');await page.locator('#edit-submit').click();
  await page.locator('#status').filter({hasText:'等待作品更新'}).waitFor();
  await page.evaluate(()=>{dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{theme:'dark'}}}));dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{toolOutput:window.openai.toolOutput}}}));});
  assert.match(await page.locator('#status').innerText(),/等待作品更新/);assert.equal(await page.locator('#edit-submit').isDisabled(),true);
  for(const width of [320,420]){
   await page.setViewportSize({width,height:900});await page.locator('details.more').evaluate(e=>e.open=true);
   const box=await page.locator('.more-content').boundingBox();assert.ok(box.x>=0);assert.ok(box.x+box.width<=width);
  }
  await page.locator('details.more').evaluate(e=>e.open=false);
  await page.locator('#download').click();await page.waitForFunction(()=>typeof window.rejectUpload==='function');
  await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{isError:true}},'*'));
  await page.locator('#status').filter({hasText:'生成失败'}).waitFor();
  await page.evaluate(()=>window.rejectUpload(new Error('stale upload failed')));
  assert.match(await page.locator('#status').innerText(),/生成失败/);
 }finally{await browser.close();}
});

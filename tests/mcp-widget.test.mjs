import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {buildRenderWidgetHtml} from '../services/mcp/widget.mjs';
import {resolveChromiumExecutable} from '../services/mcp/render.mjs';
import {renderStudioHtml} from '../services/mcp/studio-html.mjs';
import {EXAMPLE_CREATE_SCENE,prepareCreateScene} from '../services/mcp/scene.mjs';
import {PLATFORMS} from '../apps/web/src/studio/model.ts';

test('shared Web render is the platform-template UI with the default watermark on every platform',async()=>{
 for(const platform of PLATFORMS){
  const scene=prepareCreateScene({...structuredClone(EXAMPLE_CREATE_SCENE),platform,background:'#dceeff',messages:[{id:'voice',participantId:'p-ayuan',type:'voice',text:'12 秒',time:'09:41'}]});
  const html=await renderStudioHtml(scene,{width:390,height:844,outputKind:'screenshot'});
  assert.ok(html.includes(`data-platform="${platform}"`),'the platform template is really selected');
  assert.ok(html.includes('AI生成 / 虚构'),'default-on watermark on every preview/export');
  assert.ok(html.includes('12 秒'));assert.ok(html.includes('#dceeff'));
  assert.equal(/scene-transfer/.test(html),false,'no payment cards');
  assert.equal(/<script/i.test(html),false);
 }
 // A user-chosen watermark-free scene really suppresses the mark.
 const off=prepareCreateScene({...structuredClone(EXAMPLE_CREATE_SCENE),watermarkEnabled:false});
 const offHtml=await renderStudioHtml(off,{width:390,height:844,outputKind:'screenshot'});
 assert.equal(offHtml.includes('AI生成 / 虚构'),false,'watermarkEnabled=false hides the mark');
 // Payment / transfer / red-packet messages are rejected, never rendered.
 assert.throws(()=>prepareCreateScene({...structuredClone(EXAMPLE_CREATE_SCENE),messages:[{id:'transfer',participantId:'p-linxiaoman',type:'transfer',text:'演示卡片',time:'09:42'}]}),/transfer|不支持|已移除|只能是/);
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
  assert.equal(await frame.locator('#edit-work').isVisible(),true);
  // The PNG download only appears after the current image really loaded.
  await frame.locator('#download').waitFor({state:'visible'});
  assert.match(await frame.locator('#save-state').innerText(),/已载入/);
  assert.equal(await frame.locator('#preview-img').evaluate(e=>e.naturalWidth),1);
  await frame.locator('#edit-input').fill('只把最后一句改得更轻松');await frame.locator('#edit-submit').click();
  await frame.locator('#status').filter({hasText:'已把修改'}).waitFor();
  await frame.locator('#download').click();await frame.locator('#status').filter({hasText:'宿主已接受'}).waitFor();
  const calls=await page.evaluate(()=>window.bridgeCalls);
  const message=calls.find(c=>c.method==='ui/message');assert.match(message.params.content[0].text,/revision 3/);assert.match(message.params.content[0].text,/scn_aaaa/);assert.match(message.params.content[0].text,/最后一句/);
  const download=calls.find(c=>c.method==='ui/download-file');assert.equal(download.params.contents[0].resource.blob,png);
  await page.evaluate(png=>window.pushResult({structuredContent:{sceneId:null,revision:null,title:'临时预览'},_meta:{preview:{dataUri:'data:image/png;base64,'+png}}}),png);
  await frame.locator('#scene-title').filter({hasText:'临时预览'}).waitFor();
  await frame.locator('#download').waitFor({state:'visible'});
  assert.equal(await frame.locator('#edit-work').isVisible(),false,'an ephemeral preview has no saved work to edit');
  assert.equal(await frame.locator('#edit-form').isVisible(),false);
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
  assert.equal(await page.locator('#scene-title').innerText(),'Work artwork');
  // Download is offered only once the current image has loaded.
  await page.locator('#download').waitFor({state:'visible'});
  assert.equal(await page.locator('#preview-img').evaluate(e=>e.naturalWidth),1);
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

test('long images open as a complete composition with opt-in reading',async()=>{
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
  await page.locator('#download').waitFor({state:'visible'});
  // The whole long artwork is visible before the user opts into reading.
  assert.equal(await page.locator('#preview').getAttribute('data-fit'),'height');
  assert.equal(await page.locator('#preview').evaluate(e=>e.scrollHeight>e.clientHeight),false);
  assert.equal(await page.locator('#long-hint').isVisible(),false);
  await page.getByText('查看尺寸',{exact:true}).click();
  await page.getByRole('button',{name:'展开阅读',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'展开阅读',exact:true}).getAttribute('aria-pressed'),'true');
  const wide=await page.locator('#preview-img').evaluate(e=>({width:e.clientWidth,height:e.clientHeight,nw:e.naturalWidth,nh:e.naturalHeight}));
  assert.ok(wide.height>480,'width-fit uses the column for reading');assert.ok(wide.width<=390);
  assert.ok(Math.abs(wide.width/wide.height-390/1200)<0.01);
  assert.equal(await page.locator('#scene-meta').isVisible(),false);
  assert.equal(await page.locator('#long-hint').isVisible(),true);
  // The complete-composition option is preserved.
  await page.getByRole('button',{name:'完整画面',exact:true}).click();
  assert.equal(await page.locator('#preview').getAttribute('data-fit'),'height');
  const fit=await page.locator('#preview-img').evaluate(e=>({width:e.clientWidth,height:e.clientHeight,nw:e.naturalWidth,nh:e.naturalHeight}));
  assert.ok(fit.height<=480);assert.ok(fit.width<=390);assert.ok(Math.abs(fit.width/fit.height-390/1200)<0.01);
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
  // Legacy globals theme is honoured while a pending edit stays pending.
  assert.equal(await page.evaluate(()=>document.documentElement.getAttribute('data-host-theme')),'dark');
  assert.match(await page.locator('#status').innerText(),/等待作品更新/);assert.equal(await page.locator('#edit-submit').isDisabled(),true);
  for(const width of [320,420]){
   await page.setViewportSize({width,height:900});await page.locator('details.more').evaluate(e=>e.open=true);
   const box=await page.locator('.more-content').boundingBox();assert.ok(box.x>=0);assert.ok(box.x+box.width<=width);
  }
  await page.locator('details.more').evaluate(e=>e.open=false);
  await page.locator('#download').waitFor({state:'visible'});
  await page.locator('#download').click();await page.waitForFunction(()=>typeof window.rejectUpload==='function');
  await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{isError:true}},'*'));
  await page.locator('#status').filter({hasText:'生成失败'}).waitFor();
  await page.evaluate(()=>window.rejectUpload(new Error('stale upload failed')));
  assert.match(await page.locator('#status').innerText(),/生成失败/);
 }finally{await browser.close();}
});

test('preview success and PNG download wait for the real image load; late events from older result epochs are rejected',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage({viewport:{width:420,height:900}});
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await page.setContent(buildRenderWidgetHtml());
  // Hold the image src assignment so the pre-load state is observable, then
  // release the real load: no timing races, no fake progress.
  await page.evaluate(()=>{window.__held=[];
   const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
   window.__releaseSrc=()=>{window.__held.forEach(({img,value})=>desc.set.call(img,value));window.__held=[];};
   Object.defineProperty(HTMLImageElement.prototype,'src',{configurable:true,get(){return desc.get.call(this);},set(value){window.__held.push({img:this,value});}});
  });
  await page.evaluate((png)=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{sceneId:'load-scene',revision:1,title:'等待载入',width:390,height:844},_meta:{preview:{dataUri:'data:image/png;base64,'+png}}}},'*'),png);
  await page.locator('#preview').waitFor({state:'visible'});
  // Rendered, not loaded: no preview success claim and no PNG offer yet.
  assert.match(await page.locator('#save-state').innerText(),/载入中/);
  assert.equal(await page.locator('#download').isVisible(),false);
  assert.equal(await page.locator('#preview').getAttribute('data-fit'),'height','a normal image keeps the complete-composition default');
  await page.evaluate(()=>window.__releaseSrc());
  await page.locator('#save-state').filter({hasText:'已载入'}).waitFor();
  await page.locator('#download').waitFor({state:'visible'});
  // A duplicate late event cannot re-open anything odd, and older epochs are
  // rejected entirely: an error result moves the epoch forward.
  await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{isError:true}},'*'));
  await page.locator('#save-state').filter({hasText:'生成未完成'}).waitFor();
  await page.evaluate(()=>{const img=document.getElementById('preview-img');img.dispatchEvent(new Event('load'));img.dispatchEvent(new Event('error'));});
  assert.match(await page.locator('#save-state').innerText(),/生成未完成/);
  assert.match(await page.locator('#status').innerText(),/生成失败/);
  assert.equal(await page.locator('#download').isVisible(),false);
  // The same holds when a newer result has no image at all.
  await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{sceneId:'no-image',revision:2,title:'没有图像'}}},'*'));
  await page.locator('#status').filter({hasText:'未收到有效图片'}).waitFor();
  await page.evaluate(()=>document.getElementById('preview-img').dispatchEvent(new Event('load')));
  assert.match(await page.locator('#save-state').innerText(),/预览未就绪/);
  assert.equal(await page.locator('#download').isVisible(),false);
 }finally{await browser.close();}
});

test('an image that fails to load never announces preview success or offers PNG',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage({viewport:{width:420,height:900}});
  await page.setContent(buildRenderWidgetHtml());
  // Regex-valid PNG payload that cannot decode: the honest failure path.
  await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{sceneId:'broken-scene',revision:1,title:'坏图'},_meta:{preview:{dataUri:'data:image/png;base64,AAAA'}}}},'*'));
  await page.locator('#status').filter({hasText:'图片无法显示'}).waitFor();
  assert.match(await page.locator('#save-state').innerText(),/预览未就绪/);
  assert.equal(await page.locator('#download').isVisible(),false);
  assert.equal(await page.locator('#preview').isVisible(),false);
  // A late load event after the settled failure cannot resurrect success.
  await page.evaluate(()=>document.getElementById('preview-img').dispatchEvent(new Event('load')));
  assert.match(await page.locator('#save-state').innerText(),/预览未就绪/);
  assert.equal(await page.locator('#download').isVisible(),false);
 }finally{await browser.close();}
});

test('MCP Apps hostContext theme drives the widget and unknown themes fall back to the system',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage();
  await page.setContent('<html><body></body></html>');
  await page.evaluate(html=>{
   window.bridgeCalls=[];
   const frame=document.createElement('iframe');frame.style.cssText='width:600px;height:600px';
   addEventListener('message',e=>{const m=e.data;if(m?.jsonrpc!=='2.0')return;window.bridgeCalls.push(m);
    if(m.id!==undefined)frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:m.method==='ui/initialize'?{protocolVersion:'2026-01-26',hostCapabilities:{downloadFile:{}},hostContext:{theme:'dark'}}:{}},'*');
   });
   window.pushContext=(hostContext)=>frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{hostContext}},'*');
   frame.srcdoc=html;document.body.append(frame);
  },buildRenderWidgetHtml());
  const theme=()=>page.evaluate(()=>document.querySelector('iframe').contentDocument.documentElement.getAttribute('data-host-theme'));
  await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.documentElement.getAttribute('data-host-theme')==='dark');
  assert.equal(await theme(),'dark','ui/initialize hostContext applies the theme');
  await page.evaluate(()=>window.pushContext({theme:'light'}));
  await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.documentElement.getAttribute('data-host-theme')==='light');
  await page.evaluate(()=>window.pushContext({theme:'system'}));
  await page.waitForFunction(()=>document.querySelector('iframe').contentDocument.documentElement.getAttribute('data-host-theme')===null,'system falls back to the media query');
  const calls=await page.evaluate(()=>window.bridgeCalls);
  assert.ok(calls.some(c=>c.method==='ui/initialize'),'capability detection still runs');
  assert.ok(calls.some(c=>c.method==='ui/notifications/initialized'),'the bridge handshake is completed');
 }finally{await browser.close();}
});

test('width-fit bounds the reading region for genuinely tall images and stays keyboard-scrollable',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage({viewport:{width:800,height:900}});
  const sharp=(await import('sharp')).default;
  const png=(await sharp({create:{width:390,height:10000,channels:4,background:'#dedbd7'}}).png().toBuffer()).toString('base64');
  await page.setContent(buildRenderWidgetHtml());
  await page.evaluate(r=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:r},'*'),{structuredContent:{sceneId:'tall-scene',revision:1,title:'超长图',width:390,height:10000},_meta:{preview:{dataUri:'data:image/png;base64,'+png}}});
  await page.locator('#download').waitFor({state:'visible'});
  assert.equal(await page.locator('#preview').getAttribute('data-fit'),'height');
  assert.equal(await page.locator('#preview').evaluate(e=>e.scrollHeight>e.clientHeight),false);
  await page.getByText('查看尺寸',{exact:true}).click();
  await page.getByRole('button',{name:'展开阅读',exact:true}).click();
  // The reading region is bounded; the controls stay close instead of being
  // pushed thousands of pixels down by the artwork.
  const region=await page.locator('#preview').boundingBox();
  assert.ok(region.height<=640,'bounded width-fit reading height');
  const image=await page.locator('#preview-img').boundingBox();
  assert.ok(image.width>600,'width-fit uses the available reading width, even for a narrower source PNG');
  assert.ok(image.height>5000,'the real tall artwork is not squashed');
  const download=await page.locator('#download').boundingBox();
  assert.ok(download.y+download.height<=900,'controls remain in the viewport');
  // The scroll region is keyboard-accessible.
  assert.equal(await page.locator('#preview').getAttribute('tabindex'),'0');
  await page.locator('#preview').focus();
  await page.keyboard.press('PageDown');
  await page.waitForFunction(()=>document.getElementById('preview').scrollTop>0,undefined,{timeout:5000});
  assert.ok(await page.locator('#preview').evaluate(e=>e.scrollTop)>0,'keyboard scrolling works');
  // Full-composition and original-size options are preserved.
  await page.getByRole('button',{name:'完整画面',exact:true}).click();
  assert.ok((await page.locator('#preview-img').boundingBox()).height<=480);
  await page.getByRole('button',{name:'原图大小',exact:true}).click();
  assert.ok((await page.locator('#preview-img').boundingBox()).height>5000);
  assert.equal(await page.locator('#preview').getAttribute('tabindex'),'0','the original-size region scrolls by keyboard too');
 }finally{await browser.close();}
});

test('a delayed image cannot overwrite a later edit waiting state, on success or error',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage({viewport:{width:420,height:900}});
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  // Fixture prelude runs before the widget script: a legacy send path that
  // always confirms, plus an image-src hook to delay the candidate PNG.
  const prelude='<script>window.openai={sendFollowUpMessage:async function(){}};window.__held=[];const desc=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");window.__release=function(){window.__held.forEach(function(e){desc.set.call(e.img,e.value);});window.__held=[];};Object.defineProperty(HTMLImageElement.prototype,"src",{configurable:true,get:function(){return desc.get.call(this);},set:function(value){window.__held.push({img:this,value:value});}});</script>';
  await page.setContent(prelude+buildRenderWidgetHtml());
  // Success race: edit B starts while the new result's PNG is still loading.
  await page.evaluate(png=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{sceneId:'race-1',revision:1,title:'第一版'},_meta:{preview:{dataUri:'data:image/png;base64,'+png}}}},'*'),png);
  await page.locator('#save-state').filter({hasText:'载入中'}).waitFor();
  await page.locator('#edit-input').fill('改一下语气');await page.locator('#edit-submit').click();
  await page.locator('#status').filter({hasText:'等待作品更新'}).waitFor();
  await page.evaluate(()=>window.__release());
  await page.locator('#download').waitFor({state:'visible'});
  assert.match(await page.locator('#save-state').innerText(),/已载入/,'image state still updates accurately');
  assert.match(await page.locator('#status').innerText(),/等待作品更新/,'the later edit keeps its waiting state');
  assert.equal(await page.locator('#edit-submit').isDisabled(),true);
  // Error race: the same holds when the delayed image fails to load.
  await page.evaluate(()=>window.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{structuredContent:{sceneId:'race-2',revision:2,title:'第二版'},_meta:{preview:{dataUri:'data:image/png;base64,AAAA'}}}},'*'));
  await page.locator('#save-state').filter({hasText:'载入中'}).waitFor();
  assert.equal(await page.locator('#edit-submit').isEnabled(),true);
  await page.locator('#edit-input').fill('再改一处');await page.locator('#edit-submit').click();
  await page.locator('#status').filter({hasText:'等待作品更新'}).waitFor();
  await page.evaluate(()=>window.__release());
  await page.locator('#save-state').filter({hasText:'预览未就绪'}).waitFor();
  assert.match(await page.locator('#status').innerText(),/等待作品更新/,'a late image error cannot replace the edit state');
  assert.equal(await page.locator('#download').isVisible(),false);
 }finally{await browser.close();}
});

test('standard hostContext theme outranks stale legacy window.openai.theme across metadata-only updates',async()=>{
 const browser=await chromium.launch({executablePath:resolveChromiumExecutable()||undefined});
 try{
  const page=await browser.newPage({viewport:{width:420,height:900}});
  const failures=[];page.on('pageerror',e=>failures.push(e.message));
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await page.setContent('<html><body></body></html>');
  // Use a real parent/iframe bridge, just like the other protocol test. Legacy
  // globals live inside the app; only the host answers initialization.
  await page.evaluate(html=>{
   const frame=document.createElement('iframe');frame.style.cssText='width:390px;height:800px';
   window.pushContext=h=>frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{hostContext:h}},'*');
   addEventListener('message',e=>{const m=e.data;
    if(e.source!==frame.contentWindow||m?.jsonrpc!=='2.0'||m.id===undefined||!m.method)return;
    frame.contentWindow.postMessage({jsonrpc:'2.0',id:m.id,result:m.method==='ui/initialize'?{hostCapabilities:{},hostContext:{theme:'dark'}}:{}},'*');
   });
   const legacy='<script>window.openai={theme:"light",toolOutput:null,toolResponseMetadata:null};</script>';
   frame.srcdoc=html.replace('<head>','<head>'+legacy);document.body.append(frame);
  },buildRenderWidgetHtml());
  const frame=page.frameLocator('iframe');
  await frame.locator('html[data-host-theme="dark"]').waitFor();
  await page.evaluate(png=>{
   const app=document.querySelector('iframe').contentWindow;
   app.dispatchEvent(new app.CustomEvent('openai:set_globals',{detail:{globals:{toolResponseMetadata:{preview:{dataUri:'data:image/png;base64,'+png},call_tool_result:{structuredContent:{sceneId:'hybrid-scene',revision:2,title:'混合宿主'},content:[]}}}}}));
  },png);
  await frame.locator('#scene-title').filter({hasText:'混合宿主'}).waitFor();
  assert.equal(await frame.locator('html').getAttribute('data-host-theme'),'dark','standard theme survives metadata-only globals updates');
  await page.evaluate(()=>window.pushContext({theme:'light'}));
  await frame.locator('html[data-host-theme="light"]').waitFor();
  assert.deepEqual(failures,[]);
 }finally{await browser.close();}
});

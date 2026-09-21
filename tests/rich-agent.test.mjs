import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createScene,validateScene} from '../apps/web/src/studio/model.ts';
import {executeTool} from '../services/agent/tools.mjs';
import {buildSceneContext,checkSceneLimits} from '../services/agent/scene-context.mjs';
import {createImageProvider} from '../services/agent/providers.mjs';
import {screenshotToolset,renderReference,verifyReferenceSources} from '../services/agent/screenshot-tools.mjs';
import {runAgent} from '../services/agent/run.mjs';
import {rememberFrame} from '../services/agent/image-slots.mjs';
const png=await sharp({create:{width:80,height:120,channels:3,background:'#eeeeee'}}).png().toBuffer();
const image='data:image/png;base64,'+png.toString('base64');
const doc={source:image,assets:[],plan:{schemaVersion:1,im:'wechat',surface:'ios',width:80,height:120,edits:[],warnings:[]}};
test('rich scene validates fields, persists through normalization and rejects arbitrary CSS',()=>{
 const scene={...createScene(),surface:'desktop',background:'#ffffff',appearance:{fontSize:18},composerText:'Сообщение',battery:17};scene.messages[0]={...scene.messages[0],type:'album',items:[{id:'i',kind:'video',caption:'景色',asset:image}],quote:'引用'};
 assert.deepEqual(validateScene(scene).scene,scene);assert.equal(validateScene({...scene,background:'url(https://example.com)'}).ok,false);
 assert.equal(validateScene({...scene,appearance:{fontSize:Infinity}}).ok,false);
});
test('invalid tool arguments are recoverable; model cannot inject a screenshot document',async()=>{
 const scene=createScene();for(const [name,args] of [['update_element',{targetId:42,patch:{name:'x'}}],['upsert_message',{message:{...scene.messages[0],items:[null]}}],['create_scene',{scene:{...scene,messages:[{...scene.messages[0],items:[null]}]}}]])assert.equal((await executeTool(name,args,{scene})).ok,false);
 const r=await executeTool('create_scene',{scene:{...scene,title:'new',reference:doc}},{scene});assert.equal(r.ok,true);assert.equal(r.scene.reference,undefined);
});
test('selected participant and background edits cannot alter messages or another person',async()=>{
 const scene=createScene(),id=scene.participants[1].id;const ctx={scene,targetId:`@participant:${id}`};
 const r=await executeTool('update_element',{targetId:`@participant:${id}`,patch:{name:'Alex'}},ctx);assert.equal(r.ok,true);assert.deepEqual(r.scene.messages,scene.messages);assert.equal(r.scene.participants[0].name,scene.participants[0].name);
 assert.equal((await executeTool('update_element',{targetId:'@scene',patch:{background:'#112233'}},ctx)).ok,false);
});
test('rich selected context remains valid JSON without leaking embedded image bytes',()=>{
 const scene=createScene();scene.messages[0]={...scene.messages[0],type:'album',subtitle:'长'.repeat(4000),quote:'长'.repeat(4000),items:Array.from({length:9},(_,i)=>({id:String(i),kind:'image',caption:'长'.repeat(4000),asset:image}))};
 const {text}=buildSceneContext(scene,49152,scene.messages[0].id);assert.ok(text.length<=49152);assert.ok(JSON.parse(text).messages.some(m=>m.id===scene.messages[0].id));assert.ok(!text.includes('base64,'));assert.equal(checkSceneLimits(scene),null);
});
test('image editing supplies reference bytes and explicit compatible response format',async()=>{
 let sent;const provider=createImageProvider({baseUrl:'https://images.example/v1',apiKey:'test',model:'compatible-image',fetchImpl:async(url,req)=>{sent={url,req};return new Response(JSON.stringify({data:[{b64_json:png.toString('base64')}]}));}});
 await provider.generate({prompt:'暖色',referenceImage:image});assert.ok(sent.url.endsWith('/images/edits'));assert.equal(sent.req.body.get('response_format'),'b64_json');assert.equal(sent.req.body.get('prompt'),'暖色');assert.deepEqual(Buffer.from(await sent.req.body.get('image').arrayBuffer()),png);assert.equal(sent.req.headers['content-type'],undefined);
});
test('screenshot layers are real validated mutations, selection cannot change another patch',async()=>{
 const scene={...createScene(),reference:doc};const edits=[{id:'a',kind:'text',box:[10,10,80,80],background:'#ffffff',color:'#000000',text:'Hi',fontSize:12}];
 const r=await screenshotToolset.execute('set_edits',{edits},{scene});assert.equal(r.ok,true);
 const bad=await screenshotToolset.execute('set_edits',{edits:[...edits,{...edits[0],id:'b'}]},{scene:r.scene,targetId:'@patch:a'});assert.equal(bad.ok,false);
 const output=await renderReference(r.scene.reference);assert.equal(output.width,80);assert.equal(output.height,120);assert.ok(output.buffer.length>0);
});
test('successful text mutation followed by failed required image is not a successful task',async()=>{
 const scene=createScene();let call=0;const provider={complete:async()=> ++call===1?{toolCalls:[{id:'a',name:'upsert_message',arguments:JSON.stringify({message:{...scene.messages[0],type:'image'}})}]}:call===2?{toolCalls:[{id:'b',name:'generate_image',arguments:JSON.stringify({kind:'message',targetId:scene.messages[0].id,prompt:'食物'})}]}:{toolCalls:[],content:'完成'}};
 const events=[];const r=await runAgent({scene,prompt:'配图',provider,onEvent:e=>events.push(e)});assert.equal(r.ok,false);assert.equal(events.at(-1).type,'error');assert.ok(!events.some(e=>e.type==='done'));
});

const textPatch = {id:'text',kind:'text',box:[0,0,1000,1000],background:'#eeeeee',color:'#000000',text:'Hi',fontSize:12};
const screenshotCall = (name,args={},id=name) => ({id,name,arguments:JSON.stringify(args)});

async function runScreenshotCalls(calls,{imageProvider={generate:async()=>({dataUrl:image})}}={}) {
 let rounds=0;
 const events=[];
 const scene={...createScene(),messages:[],reference:structuredClone(doc)};
 const provider={complete:async()=>++rounds===1?{toolCalls:calls}:{content:'完成',toolCalls:[]}};
 const result=await runAgent({scene,prompt:'修改聊天图片',provider,imageProvider,toolset:screenshotToolset,onEvent:event=>events.push(event)});
 return {result,events};
}

test('unused generated screenshot assets persist without counting as completed output',async t=>{
 for(const terminal of ['finish','assistant'])await t.test(terminal,async()=>{
  const calls=[screenshotCall('generate_image',{assetId:'food',prompt:'美食'}),screenshotCall('render_preview')];
  if(terminal==='finish')calls.push(screenshotCall('finish'));
  const {result,events}=await runScreenshotCalls(calls);
  assert.equal(result.ok,false);
  assert.equal(result.mutations,0);
  assert.equal(result.scene.reference.plan.edits.length,0);
  assert.equal(result.scene.reference.assets[0].id,'food');
  assert.ok(events.some(e=>e.type==='scene'&&e.scene.reference.assets.some(a=>a.id==='food')),'preserve generated media for a later placement');
  assert.ok(!events.some(e=>e.type==='done'));
 });
});

test('an earlier text edit cannot hide a generated image that was never placed',async()=>{
 const {result,events}=await runScreenshotCalls([
  screenshotCall('set_edits',{edits:[textPatch]}),
  screenshotCall('generate_image',{assetId:'food',prompt:'美食'}),
  screenshotCall('render_preview'),screenshotCall('finish'),
 ]);
 assert.equal(result.ok,false);
 assert.ok(!events.some(e=>e.type==='done'));
 assert.equal(result.scene.reference.assets.length,1);
});

test('generated screenshot image placed in a layer and previewed can complete',async()=>{
 const frame=rememberFrame(doc,{box:[0,0,1000,1000],pixels:[0,0,80,120],kind:'content_region'});
 const {result,events}=await runScreenshotCalls([
  screenshotCall('generate_image',{assetId:'food',prompt:'美食'}),
  screenshotCall('place_image',{id:'photo',assetId:'food',frameId:frame.frameId}),
  screenshotCall('render_preview'),screenshotCall('finish'),
 ]);
 assert.equal(result.ok,true);
 assert.equal(result.scene.reference.plan.edits[0].assetId,'food');
 assert.equal(events.filter(e=>e.type==='done').length,1);
});

test('screenshot provider failures prevent completion regardless of error wording',async()=>{
 const {result,events}=await runScreenshotCalls([
  screenshotCall('set_edits',{edits:[textPatch]}),
  screenshotCall('generate_image',{assetId:'food',prompt:'美食'}),
  screenshotCall('render_preview'),screenshotCall('finish'),
 ],{imageProvider:{generate:async()=>{throw new Error('无法连接图片服务，请检查网络或服务配置。');}}});
 assert.equal(result.ok,false);
 assert.equal(result.reason,'image_tools_failed');
 assert.ok(!events.some(e=>e.type==='done'));
});

test('reference source verification rejects physical dimensions beyond the declared plan',async()=>{
 const oversized=await sharp({create:{width:5000,height:4000,channels:3,background:'#ffffff'}}).png().toBuffer();
 await assert.rejects(verifyReferenceSources({...doc,source:'data:image/png;base64,'+oversized.toString('base64')}),/pixel limit/);
 await assert.rejects(verifyReferenceSources({...doc,plan:{...doc.plan,width:40}}),/实际尺寸/);
});

test('accepted WebP screenshot sources and assets render through PNG normalization',async()=>{
 const webp=await sharp(png).webp().toBuffer();
 const dataUrl='data:image/webp;base64,'+webp.toString('base64');
 const reference={...doc,source:dataUrl,assets:[{id:'photo',description:'sample',dataUrl}],plan:{...doc.plan,edits:[{id:'photo',kind:'image',assetId:'photo',box:[0,0,1000,1000],background:'#ffffff',color:'#000000'}]}};
 const output=await renderReference(reference);
 assert.equal(output.width,80);
 assert.equal(output.height,120);
 assert.equal(output.buffer.subarray(1,4).toString(),'PNG');
});

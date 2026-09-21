import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import {validateScene} from '../apps/web/src/studio/model.ts';
import {executeTool} from '../services/agent/tools.mjs';
import {runAgent} from '../services/agent/run.mjs';
import {buildInitialMessages} from '../services/agent/prompt.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('../tools/eval/fixtures/loan-anniversary.json',import.meta.url),'utf8'));
const png=await sharp({create:{width:200,height:100,channels:3,background:'#ee2266'}}).composite([{input:await sharp({create:{width:100,height:100,channels:3,background:'#118855'}}).png().toBuffer(),left:100,top:0}]).png().toBuffer();
const source='data:image/png;base64,'+png.toString('base64');
const args={kind:'avatar',targetId:'achuan',attachmentIndex:0,box:[500,0,500,1000]};
const context=()=>({scene:structuredClone(fixture.scene),attachments:[source],maxAttachmentChars:6*1024*1024});
const data=url=>Buffer.from(url.split(',')[1],'base64');
test('extract original pixels without invoking an image generator; emit labeled crop for visual verification',async()=>{
 const ctx=context();ctx.imageProvider={generate(){throw new Error('must not generate');}};
 const r=await executeTool('extract_image',args,ctx);assert.equal(r.ok,true);
 const avatar=r.scene.participants.find(p=>p.id==='achuan').avatar;
 const actual=await sharp(data(avatar)).raw().toBuffer();const expected=await sharp(png).extract({left:100,top:0,width:100,height:100}).raw().toBuffer();assert.deepEqual(actual,expected);
 assert.deepEqual(r.scene.messages,ctx.scene.messages);assert.equal(r.scene.participants[0].avatar,undefined);assert.equal(r.result.observation.provenance,'source');assert.equal(r.images[0],avatar);
});
test('invalid attachment, out-of-bounds and wrong selected participant never mutate or call provider',async()=>{
 for(const patch of [{attachmentIndex:4},{box:[990,0,100,100]},{box:[0,0,0,10]},{box:[500,0,100,1000]},{box:[NaN,0,50,50]}]){const ctx=context();const r=await executeTool('extract_image',{...args,...patch},ctx);assert.equal(r.ok,false);assert.equal(r.scene,ctx.scene);}
 const ctx={...context(),targetId:'@participant:me'};assert.equal((await executeTool('extract_image',args,ctx)).ok,false);
});
test('screenshot avatar generation refuses unrelated text-only generation; enhancement sends the cropped bytes',async()=>{
 let calls=0,request;const ctx=context();ctx.imageProvider={generate:async input=>{calls++;request=input;return {dataUrl:source};}};
 assert.equal((await executeTool('generate_image',{kind:'avatar',targetId:'achuan',prompt:'自然摄影人像'},ctx)).ok,false);assert.equal(calls,0);
 const crop=await executeTool('extract_image',args,ctx);ctx.scene=crop.scene;
 const r=await executeTool('generate_image',{kind:'avatar',targetId:'achuan',prompt:'提高一点清晰度'},ctx);assert.equal(r.ok,true);assert.equal(request.referenceImage,crop.scene.participants[1].avatar);assert.match(request.prompt,/保留同一人物/);
});
test('explicitly requested new avatar and ordinary text-only creation remain available',async()=>{
 for(const ctx of [context(),{...context(),attachments:[]}]){
 let request;ctx.imageProvider={generate:async input=>{request=input;return {dataUrl:source};}};
 assert.equal((await executeTool('generate_image',{kind:'avatar',targetId:'achuan',prompt:'用户要求换成全新插画',...(ctx.attachments.length?{newImage:true}:{})},ctx)).ok,true);assert.equal(request.referenceImage,undefined);
 }
});
test('runtime passes real attachments to crop tool and permits recovery after a missing-reference generation',async()=>{
 let round=0;const messages=[];
 const result=await runAgent({...context(),prompt:'按截图还原头像',onEvent:()=>{},provider:{complete:async input=>{messages.push(input.messages);round++;return round<=2?{content:'',finishReason:'tool_calls',toolCalls:[{id:`t${round}`,name:round===1?'generate_image':'extract_image',arguments:JSON.stringify(round===1?{kind:'avatar',targetId:'achuan',prompt:'头像'}:args)}]}:{content:'已保留原图',finishReason:'stop',toolCalls:[]};}}});
 assert.equal(result.ok,true);assert.ok(result.scene.participants[1].avatar);assert.ok(JSON.stringify(messages.at(-1)).includes('source'));
});
test('failed extraction cannot be followed by a false completion after a text change',async()=>{
 let round=0;const result=await runAgent({...context(),prompt:'按截图还原',onEvent:()=>{},provider:{complete:async()=>{round++;return round===1?{content:'',finishReason:'tool_calls',toolCalls:[{id:'title',name:'update_element',arguments:JSON.stringify({targetId:'@scene',patch:{title:'新标题'}})},{id:'badcrop',name:'extract_image',arguments:JSON.stringify({...args,attachmentIndex:9})}]}:{content:'完成了',finishReason:'stop',toolCalls:[]};}}});assert.equal(result.ok,false);assert.equal(result.reason,'image_tools_failed');
});
test('screenshot prompt prefers exact crop, identifies attachment index, and preserves source trust boundary',()=>{
 const messages=buildInitialMessages({scene:fixture.scene,prompt:'还原截图',attachments:[source]});assert.match(messages[0].content,/extract_image/);assert.match(messages[0].content,/不要一律改成人像/);assert.match(JSON.stringify(messages.at(-1)),/attachmentIndex=0/);assert.match(JSON.stringify(messages.at(-1)),/不可信素材/);
});

test('scoped extraction preserves every field outside the selected participant',async()=>{
 const ctx={...context(),targetId:'@participant:achuan'};ctx.scene=validateScene(ctx.scene).scene;const r=await executeTool('extract_image',args,ctx);assert.equal(r.ok,true);assert.deepEqual(r.scene.messages,ctx.scene.messages);assert.deepEqual(r.scene.participants[0],ctx.scene.participants[0]);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>executeTool('extract_image',args,{...ctx,signal:controller.signal}),{name:'AbortError'});
});

test('avatar localization snaps an approximate AI box to the complete original avatar pixels',async()=>{
 const screenshot=fs.readFileSync(new URL('../design/evidence/visible-crop/export.png',import.meta.url));
 const ctx={...context(),attachments:['data:image/png;base64,'+screenshot.toString('base64')]};
 const result=await executeTool('extract_image',{...args,box:[20,115,115,90]},ctx);
 assert.equal(result.ok,true);assert.equal(result.result.method,'source_avatar_component');assert.deepEqual(result.result.pixels,[36,318,120,120]);
 const expected=await sharp(screenshot).extract({left:36,top:318,width:120,height:120}).ensureAlpha().raw().toBuffer();
 const actual=await sharp(data(result.scene.participants[1].avatar)).ensureAlpha().raw().toBuffer();assert.deepEqual(actual,expected);
 // Choosing several different avatars cannot silently bind the first person.
 const ambiguous=await executeTool('extract_image',{...args,box:[0,100,140,800]},ctx);
 assert.equal(ambiguous.ok,false);assert.equal(ambiguous.scene,ctx.scene);assert.match(ambiguous.detail,/多个头像/);
 const missing=await executeTool('extract_image',{...args,box:[400,400,80,40]},ctx);
 assert.equal(missing.ok,false);assert.match(missing.detail,/检测到的头像区域/);
});

test('crop coordinates apply after EXIF rotation, preserving the displayed source pixels',async()=>{
 const oriented=await sharp(png).withMetadata({orientation:6}).jpeg().toBuffer();
 const ctx={...context(),attachments:['data:image/jpeg;base64,'+oriented.toString('base64')]};
 const result=await executeTool('extract_image',{...args,box:[0,500,1000,500]},ctx);assert.equal(result.ok,true);
 const expected=await sharp(oriented).rotate().raw().toBuffer({resolveWithObject:true});
 const bottom=await sharp(expected.data,{raw:expected.info}).extract({left:0,top:100,width:100,height:100}).raw().toBuffer();
 const actual=await sharp(data(result.scene.participants[1].avatar)).raw().toBuffer();assert.deepEqual(actual,bottom);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {validatePlan} from '../packages/schema/edit-plan.mjs';
import {buildEditPlanHtml} from '../packages/renderer/editPlanHtml.mjs';
import {componentFrame} from '../services/agent/frame-components.mjs';
import {revisionOf,normalizeRect,pixelRect} from '../services/agent/elements.mjs';
import {screenshotToolset,referenceScene} from '../services/agent/screenshot-tools.mjs';
const plan={schemaVersion:1,im:'whatsapp',surface:'ios',width:600,height:900,edits:[{id:'avatar',kind:'image',assetId:'portrait',box:[100,100,500,1000/3],background:'#ffffff',color:'#000000',mask:'circle'}],warnings:[]};
test('circle is a shape independent of source pixel radius',()=>{
 const p=validatePlan(plan,{authorizedAssetIds:['portrait']}).plan;
 const html=buildEditPlanHtml(p,{width:600,height:900,sourceDataUri:'data:image/png;base64,AA==',assetDataUris:new Map([['portrait','data:image/png;base64,AA==']])});
 assert.match(html,/border-radius:50%/);assert.throws(()=>validatePlan({...plan,edits:[{...plan.edits[0],mask:'url(evil)'}]}));
});
test('coordinate conversion stays in one explicit source frame',()=>{
 const r=[145,198,267,267];const roundtrip=pixelRect(normalizeRect(r,1206,2622),1206,2622);roundtrip.forEach((v,i)=>assert.ok(Math.abs(v-r[i])<1e-8));
});
test('render revision changes on asset bytes and edits, not only IDs',()=>{
 const r={plan,assets:[{id:'portrait',dataUrl:'data:image/png;base64,AA=='}]};const h=revisionOf(r);
 assert.notEqual(h,revisionOf({...r,assets:[{id:'portrait',dataUrl:'data:image/png;base64,BB=='}]}));
 assert.notEqual(h,revisionOf({...r,plan:{...plan,edits:[]}}));
});
test('inspect_render refuses an obsolete revision before rendering',async()=>{
 const source=await sharp({create:{width:120,height:240,channels:3,background:'#ededed'}}).png().toBuffer();
 const scene=referenceScene({im:'wechat',surface:'ios',width:120,height:240,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 const result=await screenshotToolset.execute('inspect_render',{revision:'old'},{scene});assert.equal(result.ok,false);assert.match(result.detail,/过期/);assert.equal(result.scene,scene);
});
test('component frame includes white photo interior, excludes nearby avatar',async()=>{
 const {data,info}=await sharp({create:{width:400,height:400,channels:3,background:'#ededed'}}).composite([{input:Buffer.from('<svg width="400" height="400"><rect x="100" y="75" width="180" height="210" fill="white"/><rect x="120" y="100" width="120" height="100" fill="#009966"/><rect x="315" y="75" width="35" height="35" fill="#0066aa"/></svg>')}]).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const found=componentFrame(data,400,400,info.channels,[103,78,278,286]);assert.deepEqual(found.pixels,[100,75,180,210]);
});

test('set_edits merges independent edits instead of silently losing earlier work',async()=>{
 const bytes=await sharp({create:{width:120,height:240,channels:3,background:'#ededed'}}).png().toBuffer();
 const scene=referenceScene({im:'wechat',surface:'ios',width:120,height:240,source:{mime:'image/png',dataBase64:bytes.toString('base64')}});
 const text=(id,y)=>({id,kind:'text',text:id,box:[100,y,400,100],background:'#ededed',color:'#111111',fontSize:12});
 const first=await screenshotToolset.execute('set_edits',{edits:[text('first',100)]},{scene});assert.equal(first.ok,true);
 const second=await screenshotToolset.execute('set_edits',{edits:[text('second',300)]},{scene:first.scene});assert.equal(second.ok,true);assert.deepEqual(second.scene.reference.plan.edits.map(e=>e.id),['first','second']);
 const repeated=await screenshotToolset.execute('set_edits',{edits:[text('same',100),text('same',200)]},{scene:second.scene});assert.equal(repeated.ok,false);assert.equal(repeated.scene,second.scene);
});

test('erase region is independent from the replacement layout, and restricted to text',()=>{
 const base={...plan,edits:[{id:'title',kind:'text',text:'A longer name',box:[50,50,500,100],eraseBox:[50,50,150,70],background:'#eeeeee',color:'#111111',fontSize:20}]};
 const normalized=validatePlan(base).plan;
 assert.deepEqual(normalized.edits[0].eraseBox,[50,50,150,70]);
 assert.throws(()=>validatePlan({...plan,edits:[{...plan.edits[0],eraseBox:[50,50,50,50]}]}));
 assert.throws(()=>validatePlan({...base,edits:[{...base.edits[0],eraseBox:[900,0,200,50]}]}));
 const html=buildEditPlanHtml(normalized,{width:600,height:900,sourceDataUri:'data:image/png;base64,AA=='});
 assert.match(html,/data-background-patch/);assert.match(html,/width:90px;height:63px/);assert.match(html,/background:transparent/);
});
test('delete_edits removes only requested layers and enforces selection',async()=>{
 const source=await sharp({create:{width:120,height:240,channels:3,background:'#ededed'}}).png().toBuffer();
 const scene=referenceScene({im:'wechat',surface:'ios',width:120,height:240,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 scene.reference.plan.edits=['first','second'].map((id,i)=>({id,kind:'text',text:id,box:[100,100+i*200,400,100],background:'#ededed',color:'#111111',fontSize:12}));
 const denied=await screenshotToolset.execute('delete_edits',{ids:['second']},{scene,targetId:'@patch:first'});assert.equal(denied.ok,false);assert.equal(denied.scene,scene);
 const removed=await screenshotToolset.execute('delete_edits',{ids:['first']},{scene,targetId:'@patch:first'});assert.equal(removed.ok,true);assert.deepEqual(removed.scene.reference.plan.edits.map(e=>e.id),['second']);
});

test('reordering identical edits is a no-op, not an Agent mutation',async()=>{
 const source=await sharp({create:{width:120,height:240,channels:3,background:'#ededed'}}).png().toBuffer();
 let scene=referenceScene({im:'wechat',surface:'ios',width:120,height:240,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 const first=await screenshotToolset.execute('set_edits',{edits:['a','b'].map((id,i)=>({id,kind:'text',text:id,box:[100,100+i*200,400,100],background:'#ededed',color:'#111111',fontSize:12}))},{scene});scene=first.scene;
 const next=await screenshotToolset.execute('set_edits',{edits:[...scene.reference.plan.edits].reverse()},{scene});assert.equal(next.ok,false);assert.match(next.detail,/没有实际/);assert.equal(next.scene,scene);
});
test('discarded image assets can be deleted but referenced assets cannot',async()=>{
 const source=await sharp({create:{width:120,height:240,channels:3,background:'#ededed'}}).png().toBuffer();
 const scene=referenceScene({im:'wechat',surface:'ios',width:120,height:240,source:{mime:'image/png',dataBase64:source.toString('base64')}},[{id:'discard',buffer:source,mime:'image/png'}]);
 const deleted=await screenshotToolset.execute('delete_assets',{ids:['discard']},{scene,generatedAssetIds:['discard']});assert.equal(deleted.ok,true);assert.equal(deleted.scene.reference.assets.length,0);
 scene.reference.plan.edits=[{id:'used',kind:'image',assetId:'discard',box:[10,10,100,100],background:'#ffffff',color:'#000000'}];
 const denied=await screenshotToolset.execute('delete_assets',{ids:['discard']},{scene,generatedAssetIds:['discard']});assert.equal(denied.ok,false);assert.equal(denied.scene,scene);
});

test('source search replaces repeated occurrences in one OCR line',async()=>{
 const {textEdits}=await import('../services/agent/elements.mjs');
 const source=await sharp(Buffer.from('<svg width="600" height="180"><rect width="600" height="180" fill="#eeeeee"/><text x="45" y="95" font-family="Arial" font-size="48">SEND SEND</text></svg>')).png().toBuffer();
 const scene=referenceScene({im:'wechat',surface:'ios',width:600,height:180,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 const edits=await textEdits(scene.reference,{search:'SEND',text:'DONE'});
 assert.equal(edits.map(e=>e.text).join(' ').match(/DONE/g)?.length,2);assert.equal(new Set(edits.map(e=>e.id)).size,edits.length);
});

test('image tools reject changing selected text into an image and moving a measured frame',async()=>{
 const bytes=await sharp(Buffer.from('<svg width="400" height="600"><rect width="400" height="600" fill="#ededed"/><rect x="80" y="100" width="230" height="190" fill="white"/><rect x="90" y="110" width="200" height="150" fill="#226644"/></svg>')).png().toBuffer();
 const scene=referenceScene({im:'wechat',surface:'ios',width:400,height:600,source:{mime:'image/png',dataBase64:bytes.toString('base64')}},[{id:'photo',buffer:bytes,mime:'image/png'}]);
 const frames=(await screenshotToolset.execute('list_content_frames',{}, {scene})).result.frames;assert.equal(frames.length,1);
 const context={scene,imageFrameBindings:new Map()};
 const placed=await screenshotToolset.execute('place_image',{id:'photo-layer',assetId:'photo',frameId:frames[0].frameId},context);assert.equal(placed.ok,true);
 const moved=await screenshotToolset.execute('set_edits',{edits:[{...placed.scene.reference.plan.edits[0],box:[10,10,400,400]}]},{...context,scene:placed.scene});assert.equal(moved.ok,false);assert.equal(moved.scene,placed.scene);
 scene.reference.plan.edits=[{id:'label',kind:'text',text:'Hi',box:[10,10,100,100],fontSize:12,background:'#eeeeee',color:'#111111'}];
 const denied=await screenshotToolset.execute('place_image',{id:'label',assetId:'photo',frameId:frames[0].frameId},{scene,targetId:'@patch:label'});assert.equal(denied.ok,false);assert.equal(denied.scene,scene);
 const inputDenied=await screenshotToolset.execute('delete_assets',{ids:['photo']},{scene,generatedAssetIds:[]});assert.equal(inputDenied.ok,false);
});

test('album detection recovers the complete receipt width from a partial approximate box',async()=>{
 const {measureAlbum}=await import('../services/agent/image-slots.mjs');
 const source=await sharp(Buffer.from('<svg width="600" height="1100"><rect width="600" height="1100" fill="#eee9de"/><rect x="90" y="240" width="420" height="460" fill="#775533"/><rect x="301" y="240" width="209" height="230" fill="#887766"/><path d="M300 240V700M300 470H510" stroke="#ffffff" stroke-width="2"/><rect x="90" y="700" width="420" height="40" fill="#d9fdd3"/></svg>')).png().toBuffer();
 const scene=referenceScene({im:'whatsapp',surface:'ios',width:600,height:1100,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 const album=await measureAlbum(scene.reference,normalizeRect([92,240,210,500],600,1100));
 assert.equal(album.footerPixels[0],90);assert.equal(album.footerPixels[2],420);assert.equal(album.slots[0].pixels[0],90);assert.ok(Math.abs(album.slots[1].pixels[0]-302)<3);
});

test('location media split preserves the white title area and ignores the card tail',async()=>{
 const {rememberFrame,measureCardImage}=await import('../services/agent/image-slots.mjs');
 const bytes=await sharp(Buffer.from('<svg width="500" height="650"><rect width="500" height="650" fill="#ededed"/><rect x="100" y="200" width="300" height="230" fill="white"/><path d="M400 220L412 230L400 240" fill="white"/><rect x="100" y="290" width="300" height="140" fill="#ade0ad"/><path d="M210 290V430" stroke="white" stroke-width="18"/></svg>')).png().toBuffer();
 const scene=referenceScene({im:'wechat',surface:'ios',width:500,height:650,source:{mime:'image/png',dataBase64:bytes.toString('base64')}});
 const card=rememberFrame(scene.reference,{kind:'content_region',pixels:[100,200,312,230],box:normalizeRect([100,200,312,230],500,650)});
 const image=await measureCardImage(scene.reference,card.frameId);assert.deepEqual(image.pixels,[100,290,300,140]);
});

test('message text frame excludes time and cannot later be moved with set_edits',async()=>{
 const {rememberFrame}=await import('../services/agent/image-slots.mjs');
 const bytes=await sharp({create:{width:400,height:600,channels:3,background:'#ffffff'}}).png().toBuffer();
 const scene=referenceScene({im:'whatsapp',surface:'ios',width:400,height:600,source:{mime:'image/png',dataBase64:bytes.toString('base64')}});
 const frame=rememberFrame(scene.reference,{kind:'message_text',box:[100,200,700,200],pixels:[40,120,280,120],textPixels:[50,130,260,65],background:'#ffffff'});
 const context={scene,textFrameBindings:new Map()};
 const edit=await screenshotToolset.execute('replace_message_text',{id:'body',frameId:frame.frameId,text:'Hello'},context);assert.equal(edit.ok,true);
 const moved=await screenshotToolset.execute('set_edits',{edits:[{...edit.scene.reference.plan.edits[0],box:[0,0,1000,1000]}]},{...context,scene:edit.scene});assert.equal(moved.ok,false);
 const updated=await screenshotToolset.execute('set_edits',{edits:[{...edit.scene.reference.plan.edits[0],text:'Hi'}]},{...context,scene:edit.scene});assert.equal(updated.ok,true);
});

test('protected receipt rejects source sampling which could copy receipt glyphs',()=>{
 const text={id:'body',kind:'text',text:'Hi',box:[0,0,1000,1000],metadataBox:[750,750,250,250],background:'#eeeeee',color:'#111111',fontSize:20,backgroundMode:'source'};
 assert.throws(()=>validatePlan({...plan,edits:[text]}),/背景采样/);
 assert.throws(()=>validatePlan({...plan,edits:[{...text,backgroundMode:'solid',metadataBox:[900,900,101,100]}]}));
});

test('semantic batch locks only replacements, leaving unrelated manual layers editable',async()=>{
 const source=await sharp(Buffer.from('<svg width="600" height="400"><rect width="600" height="400" fill="#eeeeee"/><text x="45" y="95" font-family="Arial" font-size="48">SEND</text></svg>')).png().toBuffer();
 let scene=referenceScene({im:'wechat',surface:'ios',width:600,height:400,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 const bindings=new Map(),exec=async(name,args)=>{const out=await screenshotToolset.execute(name,args,{scene,textFrameBindings:bindings});assert.equal(out.ok,true,out.detail);scene=out.scene;return out;};
 await exec('set_text',{id:'manual',text:'Note',box:[100,700,400,100],background:'#eeeeee',color:'#111111',fontSize:20});
 await exec('replace_texts',{changes:[{search:'SEND',text:'DONE'}]});
 assert.equal(bindings.has('manual'),false);
 await exec('set_text',{id:'manual',text:'Moved note',box:[150,800,400,100],background:'#eeeeee',color:'#111111',fontSize:20});
 assert.deepEqual(scene.reference.plan.edits.find(e=>e.id==='manual').box,[150,800,400,100]);
});

test('raw erasure rejects bottom-right-as-size mistakes before destroying adjacent controls',async()=>{
 const bytes=await sharp({create:{width:400,height:600,channels:3,background:'#ffffff'}}).png().toBuffer();
 const scene=referenceScene({im:'instagram',surface:'ios',width:400,height:600,source:{mime:'image/png',dataBase64:bytes.toString('base64')}});
 const out=await screenshotToolset.execute('set_text',{id:'name',text:'New name',box:[279,82,355,26],eraseBox:[279,82,448,106],background:'#ffffff',color:'#111111',fontSize:20},{scene});
 assert.equal(out.ok,false);assert.match(out.detail,/右下角坐标/);assert.equal(out.scene,scene);
});

test('legacy erasure geometry does not block unrelated edits but cannot be enlarged',async()=>{
 const source=await sharp(Buffer.from('<svg width="600" height="400"><rect width="600" height="400" fill="#eeeeee"/><text x="45" y="95" font-family="Arial" font-size="48">SEND</text></svg>')).png().toBuffer();
 const scene=referenceScene({im:'wechat',surface:'ios',width:600,height:400,source:{mime:'image/png',dataBase64:source.toString('base64')}});
 scene.reference.plan.edits=[{id:'legacy',kind:'text',text:'Note',box:[100,700,100,50],eraseBox:[100,700,300,150],background:'#eeeeee',color:'#111111',fontSize:20}];
 const changed=await screenshotToolset.execute('replace_texts',{changes:[{search:'SEND',text:'DONE'}]},{scene,textFrameBindings:new Map()});
 assert.equal(changed.ok,true,changed.detail);assert.deepEqual(changed.scene.reference.plan.edits[0].eraseBox,[100,700,300,150]);
 const enlarged=await screenshotToolset.execute('set_edits',{edits:[{...changed.scene.reference.plan.edits[0],eraseBox:[100,700,400,150]}]},{scene:changed.scene});
 assert.equal(enlarged.ok,false);assert.match(enlarged.detail,/右下角坐标/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {CONTACT_SCHEMA_SQL,getContactLibrary,putContactLibrary} from '../services/contacts/store.mjs';
import {withContactLibrary} from '../services/contacts/runtime.mjs';
import {createScene} from '../apps/web/src/studio/model.ts';
const meId='11111111-1111-4111-8111-111111111111';
function setup(t){const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users VALUES ('owner');"+CONTACT_SCHEMA_SQL);t.after(()=>db.close());return db;}
test('interactive/batch wrapper binds saved self even when model changes participant IDs, then persists counterpart',async t=>{
 const db=setup(t);const avatar='data:image/png;base64,'+(await sharp({create:{width:32,height:32,channels:3,background:'#638aa4'}}).png().toBuffer()).toString('base64');
 putContactLibrary(db,{userId:'owner',revision:0,contacts:[{id:meId,name:'默认我',subtitle:'',avatar}],selfContactId:meId,autoSave:true,nowMs:0});
 const original={...createScene(),selfId:'self',participants:[{id:'self',name:'我'},{id:'other',name:'阿远',avatar}],messages:[]};
 const events=[];let inputSelf;
 const runtime=withContactLibrary({capabilities:{configured:true},async run(input){inputSelf=input.scene.participants[0];const scene={...input.scene,selfId:'new-self',participants:[{id:'new-self',name:'模型误改姓名'},{id:'other',name:'阿远',avatar}],messages:[{id:'m',participantId:'new-self',text:'你好',time:'09:41',type:'text'}]};await input.onEvent({type:'scene',scene});await input.onEvent({type:'done'});return {ok:true,scene};}},{db,nowMs:()=>10});
 const result=await runtime.run({userId:'owner',scene:original,onEvent:e=>events.push(e),signal:new AbortController().signal});
 assert.equal(inputSelf.name,'默认我');assert.equal(result.scene.participants[0].avatar,avatar);assert.equal(events[0].scene.participants[0].name,'默认我');assert.equal(events.at(-1).type,'done');assert.equal(getContactLibrary(db,'owner').contacts.length,2);
});
test('failed or cancelled generation cannot add contacts and a portrait-only run stays unsaved',async t=>{
 const db=setup(t);const scene=createScene();
 for(const targetId of [undefined,'@participant:portrait']){
 const runtime=withContactLibrary({async run(input){await input.onEvent({type:'scene',scene});return {ok:false,scene};}},{db,nowMs:()=>1});
 await runtime.run({userId:'owner',scene,targetId,onEvent:()=>{},signal:new AbortController().signal});assert.equal(getContactLibrary(db,'owner').revision,0);
 }
});

test('actual project batch blankScene receives the account self identity',async t=>{
 const {blankScene}=await import('../services/projects/model.mjs');
 const db=setup(t);putContactLibrary(db,{userId:'owner',revision:0,contacts:[{id:meId,name:'批量默认人物',subtitle:'',avatar:null}],selfContactId:meId,autoSave:false,nowMs:0});
 let name;const runtime=withContactLibrary({async run(input){name=input.scene.participants.find(p=>p.id===input.scene.selfId).name;assert.equal(input.scene.deviceProfileId,'iphone-17-pro');return {ok:false,scene:input.scene};}},{db,nowMs:()=>1});
 await runtime.run({userId:'owner',scene:blankScene('wechat',crypto.randomUUID()),onEvent:()=>{}});assert.equal(name,'批量默认人物');
});

test('a disabled auto-save library neither validates nor stores generated people',async t=>{
 const db=setup(t);putContactLibrary(db,{userId:'owner',revision:0,contacts:[],selfContactId:null,autoSave:false,nowMs:0});
 const scene=createScene();scene.participants[0].avatar='invalid';const events=[];
 const runtime=withContactLibrary({async run(input){await input.onEvent({type:'scene',scene});await input.onEvent({type:'done'});return {ok:true,scene};}},{db,nowMs:()=>1});
 await runtime.run({userId:'owner',scene,onEvent:e=>events.push(e)});assert.equal(getContactLibrary(db,'owner').revision,1);assert.deepEqual(events.map(e=>e.type),['scene','done']);
});

/* ------------------------------------------------------------------ */
/* Contact-library thumbnail normalization (oversized generated avatars) */
/* ------------------------------------------------------------------ */
const MAX_AVATAR_CHARS=2*1024*1024;
/** Real valid noisy PNG above the 2 MiB per-contact encoded ceiling. */
async function noisyPngDataUrl(size=1024){
 const raw=Buffer.alloc(size*size*3);
 for(let offset=0;offset<raw.length;offset+=65536)crypto.getRandomValues(raw.subarray(offset,Math.min(offset+65536,raw.length)));
 const png=await sharp(raw,{raw:{width:size,height:size,channels:3}}).png().toBuffer();
 const dataUrl='data:image/png;base64,'+png.toString('base64');
 assert.ok(dataUrl.length>MAX_AVATAR_CHARS,'fixture must exceed the 2 MiB contact ceiling');
 return dataUrl;
}
function echoRuntime(scene,{beforeDone}={}){
 return {async run(input){await input.onEvent({type:'scene',scene});if(beforeDone)await beforeDone();await input.onEvent({type:'done'});return {ok:true,scene};}};
}
function personScene(avatar){
 return {...createScene(),selfId:'self',participants:[{id:'self',name:'林远'},{id:'other',name:'阿远',avatar}],messages:[{id:'m',participantId:'self',text:'你好',time:'09:41',type:'text'}]};
}

test('an oversized valid generated avatar saves as a bounded deterministic thumbnail while the scene keeps its bytes',async t=>{
 const db=setup(t);const oversized=await noisyPngDataUrl();
 const scene=personScene(oversized);const events=[];
 const runtime=withContactLibrary(echoRuntime(scene),{db,nowMs:()=>10});
 const result=await runtime.run({userId:'owner',scene,onEvent:e=>events.push(e),signal:new AbortController().signal});
 // The generation succeeds and never claims a false failure or warning.
 assert.deepEqual(events.map(e=>e.type),['scene','done']);
 assert.equal(result.ok,true);
 // The Scene avatar bytes are untouched.
 assert.equal(result.scene.participants[1].avatar,oversized);
 assert.equal(events[0].scene.participants[1].avatar,oversized);
 // The contact-library copy is a bounded deterministic PNG thumbnail.
 const saved=getContactLibrary(db,'owner').contacts.find(c=>c.name==='阿远');
 assert.ok(saved&&saved.avatar.startsWith('data:image/png;base64,'),'a thumbnail is stored');
 assert.ok(saved.avatar.length<=MAX_AVATAR_CHARS,'thumbnail stays under 2 MiB encoded');
 const meta=await sharp(Buffer.from(saved.avatar.split(',')[1],'base64')).metadata();
 assert.equal(meta.format,'png');
 assert.ok(meta.width<=256&&meta.height<=256,'thumbnail fits 256px');
 assert.ok(meta.width===256||meta.height===256,'the long edge fills the 256px bound');
 // Deterministic bytes: repeated normalization of the same original dedups.
 const {normalizeContactAvatar}=await import('../services/contacts/image.mjs');
 assert.equal(await normalizeContactAvatar(oversized),saved.avatar,'thumbnails are deterministic');
});

test('repeated saves of the SAME oversized original dedup through identical thumbnails',async t=>{
 const db=setup(t);const oversized=await noisyPngDataUrl();const scene=personScene(oversized);
 const runtime=withContactLibrary(echoRuntime(scene),{db,nowMs:()=>10});
 await runtime.run({userId:'owner',scene,onEvent:()=>{},signal:new AbortController().signal});
 assert.equal(getContactLibrary(db,'owner').contacts.length,2,'both people are retained once');
 const second=withContactLibrary(echoRuntime(scene),{db,nowMs:()=>20});
 await second.run({userId:'owner',scene,onEvent:()=>{},signal:new AbortController().signal});
 const library=getContactLibrary(db,'owner');
 assert.equal(library.contacts.length,2,'the second save must not add a duplicate');
});

test('already bounded avatars pass through byte-identical and invalid sources stay truthful failures',async t=>{
 const db=setup(t);const {normalizeContactAvatar}=await import('../services/contacts/image.mjs');
 const small='data:image/png;base64,'+(await sharp({create:{width:64,height:64,channels:3,background:'#445566'}}).png().toBuffer()).toString('base64');
 assert.equal(await normalizeContactAvatar(small),small,'bounded avatars are never re-encoded');
 const corruptOversized='data:image/png;base64,'+Buffer.alloc(2*1024*1024,7).toString('base64');
 for(const bad of ['https://remote.example/x.png','data:image/svg+xml;base64,PHN2Zy8+',corruptOversized,'data:image/png;base64,'+'A'.repeat(7*1024*1024)]){
  await assert.rejects(normalizeContactAvatar(bad),error=>error.code==='invalid_avatar');
 }
 // A corrupt generated avatar fails truthfully: warning shown, nothing saved.
 const scene=personScene(corruptOversized);const events=[];
 const runtime=withContactLibrary(echoRuntime(scene),{db,nowMs:()=>1});
 await runtime.run({userId:'owner',scene,onEvent:e=>events.push(e),signal:new AbortController().signal});
 assert.equal(getContactLibrary(db,'owner').contacts.length,0);
 assert.ok(events.some(e=>e.type==='assistant'&&/人物库保存未完成/.test(e.text)),'the server warning stays truthful');
});

test('a full contact library remains a truthful failure and never evicts existing contacts',async t=>{
 const db=setup(t);const oversized=await noisyPngDataUrl();
 const full=[];for(let i=0;i<100;i++)full.push({id:crypto.randomUUID(),name:`已有${i}`,subtitle:'',avatar:null});
 putContactLibrary(db,{userId:'owner',revision:0,contacts:full,selfContactId:null,autoSave:true,nowMs:0});
 const scene=personScene(oversized);const events=[];
 const runtime=withContactLibrary(echoRuntime(scene),{db,nowMs:()=>10});
 await runtime.run({userId:'owner',scene,onEvent:e=>events.push(e),signal:new AbortController().signal});
 const library=getContactLibrary(db,'owner');
 assert.equal(library.contacts.length,100,'capacity is never silently evicted');
 assert.equal(library.contacts[0].name,'已有0');
 assert.ok(events.some(e=>e.type==='assistant'&&/人物库保存未完成/.test(e.text)),'a full library reports the failure');
 assert.equal(events.some(e=>e.type==='assistant'&&/已存入/.test(e.text)),false,'it never claims saved');
});

test('an aborted run cannot make a late contact write',async t=>{
 const db=setup(t);const oversized=await noisyPngDataUrl();const scene=personScene(oversized);
 const controller=new AbortController();const events=[];
 const runtime=withContactLibrary(echoRuntime(scene,{beforeDone:()=>controller.abort()}),{db,nowMs:()=>10});
 await runtime.run({userId:'owner',scene,onEvent:e=>events.push(e),signal:controller.signal});
 assert.equal(getContactLibrary(db,'owner').revision,0,'nothing is written after abort');
 assert.equal(events.some(e=>e.type==='done'),false,'no completion is claimed');
 assert.equal(events.some(e=>e.type==='assistant'),false,'an aborted run shows no save warning');
});

test('concurrent user edits and default choice survive the append re-read',async t=>{
 const db=setup(t);const oversized=await noisyPngDataUrl();const scene=personScene(oversized);
 const mineId=crypto.randomUUID();
 // Wrap the handle so a concurrent manual edit lands exactly between the
 // first read and the final re-read before append.
 let reads=0;const realPrepare=db.prepare.bind(db);
 const shim={prepare(sql){if(/SELECT revision, self_contact_id/.test(sql)&&++reads===3){
   const current=getContactLibrary(db,'owner');
   putContactLibrary(db,{userId:'owner',revision:current.revision,contacts:[...current.contacts,{id:mineId,name:'手动联系人',subtitle:'',avatar:null}],selfContactId:mineId,autoSave:true,nowMs:5});
  }return realPrepare(sql);},exec:(sql)=>db.exec(sql)};
 const runtime=withContactLibrary(echoRuntime(scene),{db:shim,nowMs:()=>10});
 await runtime.run({userId:'owner',scene,onEvent:()=>{},signal:new AbortController().signal});
 const library=getContactLibrary(db,'owner');
 assert.equal(library.selfContactId,mineId,'the concurrent default choice survives');
 assert.deepEqual(library.contacts.map(c=>c.name),['手动联系人','林远','阿远'],'the concurrent edit is kept and the generated people appended');
 assert.equal(getContactLibrary(db,'owner').contacts.find(c=>c.name==='阿远').avatar.startsWith('data:image/png;base64,'),true);
});

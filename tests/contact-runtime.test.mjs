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

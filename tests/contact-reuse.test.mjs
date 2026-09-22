import test from 'node:test';
import assert from 'node:assert/strict';
import {createScene} from '../apps/web/src/studio/model.ts';
import {applySelfDefault,retainContacts,useContact} from '../apps/web/src/contacts/model.ts';
const avatar='data:image/png;base64,AAAA';
const me={id:'11111111-1111-4111-8111-111111111111',name:'默认我',avatar};
const library={revision:3,contacts:[me],selfContactId:me.id,autoSave:true};
const blank={...createScene(),selfId:'self',participants:[{id:'self',name:'我'},{id:'other',name:'对方'}],messages:[]};
test('default identity fills only fresh unspecified self, retaining sender IDs',()=>{
 const s=applySelfDefault(blank,library);assert.equal(s.participants[0].avatar,avatar);assert.equal(s.selfId,'self');assert.equal(s.participants[0].name,'默认我');
 const old=createScene();assert.equal(applySelfDefault(old,library),old);
 const manual=useContact(blank,'self',{...me,name:'手动人物'});assert.equal(applySelfDefault(manual,library),manual);
});
test('same name with different avatar remains separate; exact snapshots deduplicate across generations',()=>{
 const other={id:'o',name:'阿远',avatar};let count=0;
 const a=retainContacts(library,[other,other],()=>`new-${++count}`);assert.equal(a.contacts.length,2);
 const b=retainContacts(a,[{...other,id:'regenerated-id'},{...other,avatar:avatar+'A'}],()=>`new-${++count}`);assert.equal(b.contacts.length,3);assert.equal(b.selfContactId,me.id);assert.equal(library.contacts.length,1);
});
test('applying a contact copies identity, keeps message ownership and does not link mutable objects',()=>{
 const s=useContact(blank,'other',me);assert.equal(s.participants[1].id,'other');me.name='changed';assert.equal(s.participants[1].name,'默认我');me.name='默认我';
});

test('Agent create_scene retains selected device and matches an unambiguous saved avatar after ID changes',async()=>{
 const {executeTool}=await import('../services/agent/tools.mjs');
 const original={...createScene(),surface:'ios',deviceProfileId:'iphone-15-pro'};
 original.participants=original.participants.map(p=>({...p,avatar}));
 const candidate=structuredClone(original);delete candidate.deviceProfileId;candidate.surface='android';candidate.selfId=`new-${original.selfId}`;candidate.participants=candidate.participants.map(p=>({id:`new-${p.id}`,name:p.name}));candidate.messages=candidate.messages.map(m=>({...m,participantId:m.participantId?`new-${m.participantId}`:''}));
 const result=await executeTool('create_scene',{scene:candidate},{scene:original});assert.equal(result.ok,true);assert.equal(result.scene.deviceProfileId,'iphone-15-pro');assert.equal(result.scene.surface,'ios');assert.equal(result.scene.participants[0].avatar,avatar);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../services/agent/tools.mjs';
import { createScene } from '../apps/web/src/studio/model.ts';
const avatar='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const otherAvatar='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function seed(){return {...createScene(),selfId:'me',participants:[{id:'me',name:'我',avatar},{id:'other',name:'对方',avatar:otherAvatar}],messages:[],watermark:'虚构对话'};}
function rewritten(current){return {...current,selfId:'p-lin',participants:[{id:'p-lin',name:'小林'},{id:'p-yuan',name:'阿远'}],messages:[{id:'m-new',participantId:'p-lin',type:'text',text:'周末去喝咖啡吗？',time:'09:41'}]};}
test('first Agent story keeps chosen role avatars when actor IDs and names change',async()=>{
 const current=seed();const result=await executeTool('create_scene',{scene:rewritten(current)},{scene:current});
 assert.equal(result.ok,true);assert.deepEqual(result.scene.participants.map(p=>p.avatar),[avatar,otherAvatar]);
 const existing={...current,messages:[{id:'old',participantId:'me',type:'text',text:'已有对话',time:'09:40'}]};
 const changed=await executeTool('create_scene',{scene:rewritten(existing)},{scene:existing});
 assert.equal(changed.ok,true);assert.ok(changed.scene.participants.every(p=>!p.avatar),'existing actor avatars must not be assigned to unrelated new actors');
});
test('Agent content reconstruction cannot reset mark, while an explicit targeted edit can',async()=>{
 for(const currentMark of ['', '虚构对话','自定义水印']){
  const current={...seed(),watermark:currentMark};
  const wrong=currentMark?'':'虚构对话';
  const result=await executeTool('create_scene',{scene:{...rewritten(current),watermark:wrong}},{scene:current});
  assert.equal(result.ok,true);assert.equal(result.scene.watermark,currentMark);
  assert.equal(result.scene.title,current.title,'label must not be appended to title');
  const explicit=await executeTool('update_element',{targetId:'@scene',patch:{watermark:wrong}},{scene:result.scene});
  assert.equal(explicit.ok,true);assert.equal(explicit.scene.watermark,wrong);
 }
});

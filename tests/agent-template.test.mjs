import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene, PLATFORMS } from '../apps/web/src/studio/model.ts';
import { executeTool, AGENT_TOOL_SCHEMAS } from '../services/agent/tools.mjs';
import { runAgent } from '../services/agent/run.mjs';
const layout={kind:'custom',name:'旧布局',background:'#eeeeee'};
const avatar='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
function seed(){const s=createScene();return {...s,platform:'wechat',surface:'ios',deviceProfileId:'iphone-15-pro',layout,watermark:'自定义',watermarkEnabled:false,participants:s.participants.map(p=>({...p,avatar}))};}
test('select_template validates enums, preserves scene preferences/assets and exposes the complete catalog',async()=>{
 assert.deepEqual(AGENT_TOOL_SCHEMAS.find(t=>t.function.name==='select_template').function.parameters.properties.platform.enum,[...PLATFORMS]);
 for(const platform of PLATFORMS){
  const scene=seed();const changed=await executeTool('select_template',{platform},{scene});
  assert.equal(changed.ok,true);assert.equal(changed.scene.platform,platform);assert.equal(changed.scene.layout,undefined);
  const {platform:oldPlatform,layout:oldLayout,...before}=scene;const {platform:newPlatform,...after}=changed.scene;
  assert.deepEqual(after,before);assert.ok(scene.layout,'original remains unchanged');
 }
 for(const args of [{platform:'WhatsApp'},{platform:'telegram'},{platform:'whatsapp',watermarkEnabled:true},{},null]){
  const scene=seed();const result=await executeTool('select_template',args,{scene});assert.equal(result.ok,false);assert.equal(result.scene,scene);
 }
});
test('template changes are blocked for local targets, allowed for @scene, and truthful on no-op',async()=>{
 const scene=seed();
 for(const targetId of [scene.messages[1].id,`@participant:${scene.selfId}`,'missing']){
  const result=await executeTool('select_template',{platform:'whatsapp'},{scene,targetId});assert.equal(result.ok,false);assert.equal(result.scene,scene);
 }
 const global=await executeTool('select_template',{platform:'whatsapp'},{scene,targetId:'@scene'});assert.equal(global.ok,true);
 const again=await executeTool('select_template',{platform:'whatsapp'},{scene:global.scene});assert.equal(again.ok,false);assert.equal(again.scene,global.scene);
 const legacy=await executeTool('update_element',{targetId:'@scene',patch:{platform:'whatsapp'}},{scene});assert.equal(legacy.ok,true);assert.equal(legacy.scene.layout,undefined);
});
test('initial WhatsApp request selects its template before a full rebuild and survives scene events',async()=>{
 const scene=seed();scene.messages=[];
 const call=(name,args,id)=>({finishReason:'tool_calls',content:'',toolCalls:[{id,name,arguments:JSON.stringify(args)}]});
 const steps=[call('select_template',{platform:'whatsapp'},'select'),call('create_scene',{scene:{...scene,platform:'imstage',layout:undefined,title:'虚构 AI 学习对话',messages:[{id:'new',participantId:scene.selfId,type:'text',text:'Hi Andrej!',time:'09:41'}]}},'create'),{finishReason:'stop',content:'已生成虚构对话。',toolCalls:[]}];
 let round=0;const events=[];const provider={async complete({messages,tools}){assert.ok(tools.some(t=>t.function.name==='select_template'));assert.match(messages[0].content,/必须先 select_template/);return steps[round++];}};
 const result=await runAgent({prompt:'生成一个 和 Andrej Karpathy 聊天的 Whatsapp',scene,provider,onEvent:e=>events.push(e)});
 assert.equal(result.ok,true);assert.equal(result.scene.platform,'whatsapp');assert.equal(result.scene.watermarkEnabled,false);
 assert.deepEqual(events.filter(e=>e.type==='tool'&&e.state==='done').map(e=>e.name),['select_template','create_scene']);
 assert.equal(events.at(-1).type,'done');assert.equal(events.filter(e=>e.type==='scene').at(-1).scene.platform,'whatsapp');
});

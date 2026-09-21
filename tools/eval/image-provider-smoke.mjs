// Live acceptance: actual DeepSeek tools must generate and then edit an image.
// The report contains metrics only; generated pixels stay in memory.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createAgentRuntime,resolveAgentConfig} from '../../services/agent/index.mjs';
import {createScene} from '../../apps/web/src/studio/model.ts';
const out=process.argv[2];
const report={kind:'imstage-live-image-tools',ok:false,generated:false,edited:false,errorCode:null};
try {
 const config=resolveAgentConfig(process.env);
 if(!config.configured)throw Object.assign(new Error(),{code:'deepseek_not_configured'});
 if(!config.imageConfigured)throw Object.assign(new Error(),{code:'image_provider_not_configured'});
 let generationRequests=0,editRequests=0;
 const runtime=createAgentRuntime(config,{fetchImpl:async(url,init)=>{const route=new URL(String(url)).pathname;if(route.endsWith('/images/generations'))generationRequests++;if(route.endsWith('/images/edits'))editRequests++;return fetch(url,init);}});const base=createScene();
 const scene={...base,id:crypto.randomUUID(),messages:[{id:'image-smoke',participantId:base.selfId,type:'image',text:'合成图片验收',time:'09:41'}]};
 const firstTrace=[];
 const first=await runtime.run({scene,prompt:'调用 generate_image，为 image-smoke 生成一张白色背景上的红色苹果静物照片。只修改这一条图片消息。',targetId:'image-smoke',onEvent:e=>{if(e.type==='tool')firstTrace.push(e);}});
 report.generated=Boolean(generationRequests>0&&first.ok&&first.scene.messages[0]?.asset&&firstTrace.some(e=>e.name==='generate_image'&&e.state==='done'));
 if(!report.generated)throw Object.assign(new Error(),{code:'image_generation_incomplete'});
 const secondTrace=[];
 const second=await runtime.run({scene:first.scene,prompt:'对所选图片调用 generate_image，必须 edit=true 使用原图作为参考。把苹果改为绿色，保留构图和白色背景。',targetId:'image-smoke',onEvent:e=>{if(e.type==='tool')secondTrace.push(e);}});
 report.edited=Boolean(editRequests>0&&second.ok&&second.scene.messages[0]?.asset!==first.scene.messages[0].asset&&secondTrace.some(e=>e.name==='generate_image'&&e.state==='done'));
 if(!report.edited)throw Object.assign(new Error(),{code:'image_edit_incomplete'});
 report.ok=true;
}catch(error){report.errorCode=['deepseek_not_configured','image_provider_not_configured','image_generation_incomplete','image_edit_incomplete'].includes(error.code)?error.code:'live_image_tools_failed';}
if(out){await fs.mkdir(path.dirname(path.resolve(out)),{recursive:true});await fs.writeFile(out,JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;

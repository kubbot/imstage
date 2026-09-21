import { createAgentRuntime, resolveAgentConfig } from '../../../../services/agent/index.mjs';
import { referenceScene } from '../../../../services/agent/screenshot-tools.mjs';
// Only the task, source pixels and authorized assets enter the product Agent.
// No expected edits, answer text, preserved boxes or scores are exposed to it.
export async function callDeepSeekAgent({config,request,assets=[],signal,env=process.env}) {
 const runtime=createAgentRuntime(resolveAgentConfig(env,{apiKey:config.apiKey,baseUrl:config.baseUrl,model:config.model,maxRounds:12,maxCalls:40,deadlineMs:180000}));
 const scene=referenceScene(request,assets);const trace=[];
 const result=await runtime.run({prompt:request.task,scene,signal,onEvent:event=>{if(event.type==='tool'||event.type==='assistant')trace.push(event);}});
 if(!result.ok){const error=new Error(result.error || 'Agent 未完成任务');error.code=result.reason || 'agent_incomplete';error.trace=trace;throw error;}
 return {rawContent:JSON.stringify(result.scene.reference.plan),model:runtime.capabilities.model,trace,generatedAssets:result.scene.reference.assets.map(a=>({id:a.id,mime:a.dataUrl.slice(5,a.dataUrl.indexOf(';')),buffer:Buffer.from(a.dataUrl.split(',')[1],'base64')}))};
}

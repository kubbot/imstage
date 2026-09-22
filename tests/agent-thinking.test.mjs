import test from 'node:test';import assert from 'node:assert/strict';
import {createChatProvider} from '../services/agent/providers.mjs';
import {resolveAgentConfig} from '../services/agent/config.mjs';
test('DeepSeek thinking protocol round trips reasoning without putting it in final content',async()=>{
 const requests=[];const provider=createChatProvider({baseUrl:'https://api.deepseek.com',apiKey:'synthetic-key',model:'deepseek-flash',thinkingEnabled:true,fetchImpl:async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{content:'',reasoning_content:'private-provider-continuation',tool_calls:[{id:'t1',type:'function',function:{name:'read_elements',arguments:'{}'}}]}}]}));}});
 const result=await provider.complete({messages:[{role:'user',content:'synthetic task'}],tools:[]});assert.equal(result.reasoningContent,'private-provider-continuation');assert.equal(result.content,'');
 await provider.complete({messages:[{role:'assistant',content:'',reasoning_content:result.reasoningContent,tool_calls:[]},{role:'tool',tool_call_id:'t1',content:'{}'}],tools:[]});
 assert.deepEqual(requests[0].thinking,{type:'enabled'});assert.equal(requests[1].messages[0].reasoning_content,result.reasoningContent);
 assert.equal(resolveAgentConfig({IMSTAGE_AI_THINKING:'enabled'}).thinkingEnabled,true);assert.equal(resolveAgentConfig({}).thinkingEnabled,false);
});

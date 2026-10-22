import test from 'node:test';
import assert from 'node:assert/strict';
import { renderScenePng } from '../src/render.mjs';

const scene={id:'synthetic-render-boundary',platform:'x',title:'合成渲染边界',deviceTime:'09:41',date:'',selfId:'me',participants:[{id:'me',name:'合成参与者'}],messages:[{id:'short',participantId:'me',type:'text',text:'Synthetic short message',time:'10:00'}]};
const long={...scene,messages:Array.from({length:25},(_,i)=>({id:`m-${i}`,participantId:'me',type:'text',text:`${i} 合成长文，必须完整保留。`.repeat(5),time:'10:00'}))};

test('social real PNG honors a non-default screenshot height',async()=>{
 const result=await renderScenePng(scene,{width:390,height:600});
 assert.equal(result.width,390);assert.equal(result.height,600);
});
test('social real PNG refuses standard output that would hide scrolling content',async()=>{
 await assert.rejects(renderScenePng(long,{width:390,height:600}),e=>e.code==='output_too_tall');
});
test('social real long PNG expands to contain the same content',async()=>{
 const result=await renderScenePng(long,{width:390,height:600,outputKind:'long-screenshot'});
 assert.equal(result.width,390);assert.ok(result.height>600);
});

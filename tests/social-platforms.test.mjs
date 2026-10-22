import test from 'node:test';
import assert from 'node:assert/strict';
import {createScene, PLATFORMS, validateScene, serializeScene, parseSceneJson} from '../apps/web/src/studio/model.ts';
import {executeTool, AGENT_TOOL_SCHEMAS} from '../services/agent/tools.mjs';
import {SUPPORTED_PLATFORMS} from '../services/mcp/limits.mjs';
import {renderSceneHtml} from '../packages/renderer/renderSceneHtml.mjs';
const required=['x','jike','threads','xiaohongshu'];
for(const platform of required) test(`${platform}: scene round-trip, real template tool, MCP and deterministic render`,async()=>{
 assert.ok(PLATFORMS.includes(platform), `${platform} must be selectable`);
 assert.ok(SUPPORTED_PLATFORMS.includes(platform));
 assert.ok(AGENT_TOOL_SCHEMAS.find(t=>t.function.name==='select_template').function.parameters.properties.platform.enum.includes(platform));
 const seed={...createScene(), platform:'wechat', watermarkEnabled:true,layout:{kind:'custom',name:'old'}};
 const selected=await executeTool('select_template',{platform},{scene:seed});
 assert.equal(selected.ok,true);assert.equal(selected.scene.platform,platform);assert.equal(selected.scene.layout,undefined);
 assert.deepEqual(selected.scene.messages,seed.messages);assert.equal(selected.scene.watermarkEnabled,true);
 assert.equal(validateScene(selected.scene).ok,true);
 const restored=parseSceneJson(serializeScene(selected.scene));assert.equal(restored.ok,true);assert.equal(restored.scene.platform,platform);
 const html=renderSceneHtml(selected.scene,{surface:'ios',width:320});
 assert.ok(html.includes(`platform-${platform}`));assert.ok(html.includes('data-imstage-disclosure'));
});

test('social HTML preserves quotes, safe inline media, album captions and link subtitles',()=>{
 const base=createScene();const s={...base,platform:'x',messages:[
 {id:'q',participantId:base.selfId,type:'text',text:'正文',quote:'QUOTE_SENTINEL',time:'10:00'},
 {id:'i',participantId:base.selfId,type:'image',text:'IMAGE_SENTINEL',asset:'data:image/png;base64,AAAA',time:'10:00'},
 {id:'a',participantId:base.selfId,type:'album',text:'album',items:[{id:'item',kind:'image',asset:'data:image/png;base64,AAAA',caption:'ALBUM_SENTINEL'}],time:'10:00'},
 {id:'l',participantId:base.selfId,type:'link',text:'LINK_SENTINEL',subtitle:'SUBTITLE_SENTINEL',time:'10:00'}]};
 const html=renderSceneHtml(s,{width:320});
 for(const value of ['QUOTE_SENTINEL','ALBUM_SENTINEL','SUBTITLE_SENTINEL','src="data:image/png;base64,AAAA"'])assert.ok(html.includes(value),value);
 const hostile=renderSceneHtml({...s,messages:[{...s.messages[1],asset:'https://private.invalid/image.png'}]},{width:320});assert.equal(hostile.includes('src="https:'),false);
});

for(const type of ['image','location','voice'])test(`HTML preserves authored ${type} quotes`,()=>{
 const s=createScene();const html=renderSceneHtml({...s,platform:'threads',messages:[{id:'quoted',participantId:s.selfId,type,text:'合成内容',quote:`QUOTE_${type}`,time:'10:00'}]},{width:390});
 assert.ok(html.includes(`QUOTE_${type}`));
});

test('shared social HTML adapts indexed assets without remote resources or executable scene strings',()=>{
 const s=createScene();const uri='data:image/png;base64,AAAA';
 const scene={...s,platform:'x',headerText:'<script>unsafe()</script>',backgroundImage:'https://private.invalid/bg.png',participants:s.participants.map(p=>({...p,avatar:'https://private.invalid/avatar.png'})),messages:[{id:'image',participantId:s.selfId,type:'image',text:'Safe caption <img onerror="unsafe()">',time:'10:00',assetIndex:0},{id:'remote',participantId:s.selfId,type:'image',text:'Remote not loaded',time:'10:01',asset:'https://private.invalid/image.png'}]};
 delete scene.id;
 const html=renderSceneHtml(scene,{assets:[uri],width:320,outputKind:'long-screenshot'});
 const body=html.slice(html.indexOf('<body>'));
 assert.match(body,/src="data:image\/png;base64,AAAA"/);assert.match(body,/Safe caption &lt;img/);
 assert.doesNotMatch(body,/<script|src="https?:|private\.invalid|<img onerror=/);
 assert.equal(html,renderSceneHtml(scene,{assets:[uri],width:320,outputKind:'long-screenshot'}));
 assert.throws(()=>renderSceneHtml({...scene,messages:[{...scene.messages[0],assetIndex:1}]},{assets:[uri]}),/asset index/);
 assert.throws(()=>renderSceneHtml({...s,platform:'x',appearance:{color:'red; background:url(https://private.invalid)'}}),/Invalid social scene/);
});

test('social custom layouts keep canonical content, explicit appearance and watermark policy',()=>{
 const s={...createScene(),platform:'threads',layout:{kind:'custom',name:'合成自定义',incomingBackground:'#eeeeee'},appearance:{radius:0},messages:[{id:'payment',participantId:'',type:'transfer',text:'FORBIDDEN_PAYMENT_PAYLOAD',time:'10:00'}]};
 const html=renderSceneHtml(s);
 assert.match(html,/data-layout="custom"/);assert.match(html,/--scene-radius:0px/);assert.match(html,/data-imstage-disclosure="true"/);
 const body=html.slice(html.indexOf('<body>'));assert.doesNotMatch(body,/data-social-chat="true"|FORBIDDEN_PAYMENT_PAYLOAD/);
 assert.doesNotMatch(renderSceneHtml({...s,watermarkEnabled:false}).slice(html.indexOf('<body>')),/data-imstage-disclosure="true"/);
 assert.throws(()=>renderSceneHtml({...s,reference:{enabled:true}}),/Invalid social scene/);
});

test('social renderer retains the caller device profile override and validates it',()=>{
 const scene={...createScene(),platform:'jike',deviceProfileId:undefined};
 assert.match(renderSceneHtml(scene,{deviceProfileId:'ipad-window',width:1024}),/data-testid="scene-chat-list"/);
 assert.match(renderSceneHtml(scene,{surface:'web',deviceProfileId:'macos-window',width:960}),/data-device="macos-window"/);
 assert.throws(()=>renderSceneHtml(scene,{deviceProfileId:'invalid-profile'}),/Invalid social scene/);
});

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
 const s={...createScene(),platform:'x',messages:[
 {id:'q',participantId:'p1',type:'text',text:'正文',quote:'QUOTE_SENTINEL',time:'10:00'},
 {id:'i',participantId:'p1',type:'image',text:'IMAGE_SENTINEL',asset:'data:image/png;base64,AAAA',time:'10:00'},
 {id:'a',participantId:'p1',type:'album',text:'album',items:[{id:'item',kind:'image',asset:'data:image/png;base64,AAAA',caption:'ALBUM_SENTINEL'}],time:'10:00'},
 {id:'l',participantId:'p1',type:'link',text:'LINK_SENTINEL',subtitle:'SUBTITLE_SENTINEL',time:'10:00'}]};
 const html=renderSceneHtml(s,{width:320});
 for(const value of ['QUOTE_SENTINEL','ALBUM_SENTINEL','SUBTITLE_SENTINEL','src="data:image/png;base64,AAAA"'])assert.ok(html.includes(value),value);
 const hostile=renderSceneHtml({...s,messages:[{...s.messages[1],asset:'https://private.invalid/image.png'}]},{width:320});assert.equal(hostile.includes('src="https:'),false);
});

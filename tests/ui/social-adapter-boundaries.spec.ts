import {test,expect} from '@playwright/test';
import {createScene} from '../../apps/web/src/studio/model';
import {renderStudioHtml} from '../../services/mcp/studio-html.mjs';
import {renderSceneHtml} from '../../packages/renderer/renderSceneHtml.mjs';
test.describe.configure({timeout:90_000});
for(const platform of ['x','threads'] as const)test(`${platform} desktop header retains readable title and one row`,async({page})=>{
 const s={...createScene(),platform,surface:'desktop' as const,deviceProfileId:'macos-window',headerText:'桌面会话标题 · Synthetic desktop'};
 await page.setContent(await renderStudioHtml(s,{width:960,height:720,outputKind:'long-screenshot'}));
 const g=await page.locator('.scene-header').evaluate(e=>{const title=e.querySelector('.scene-header-title')!.getBoundingClientRect(),avatar=e.querySelector('.scene-avatar')!.getBoundingClientRect(),more=e.querySelector('.scene-header-more')!.getBoundingClientRect();return {width:title.width,avatarLeft:avatar.left,titleLeft:title.left,moreLeft:more.left,titleTop:title.top,moreTop:more.top};});
 expect(g.width).toBeGreaterThan(300);expect(g.avatarLeft).toBeLessThan(g.titleLeft);expect(g.moreLeft).toBeGreaterThan(g.titleLeft+g.width-1);expect(Math.abs(g.titleTop-g.moreTop)).toBeLessThan(28);
});
test('HTML empty album items stay inside their own grid cells',async({page})=>{
 const s=createScene();await page.setContent(renderSceneHtml({...s,platform:'x',messages:[{id:'album',participantId:s.selfId,type:'album',text:'合成待上传相册',time:'10:00',items:[{id:'a',kind:'image',caption:'样本A'},{id:'b',kind:'image',caption:'样本B'}]}]},{width:320,outputKind:'long-screenshot'}));
 await expect(page.locator('.scene-album-item')).toHaveCount(2);
 const fits=await page.locator('.scene-album-item').evaluateAll(nodes=>nodes.every(e=>{const box=e.getBoundingClientRect(),p=e.querySelector('.scene-album-media')!.getBoundingClientRect();return p.left>=box.left-1&&p.right<=box.right+1;}));expect(fits).toBeTruthy();
});
for(const radius of [0,40])test(`social explicit radius ${radius} controls all four bubble corners`,async({page})=>{
 const s={...createScene(),platform:'threads' as const,appearance:{radius},messages:createScene().messages.filter(m=>m.type==='text')};
 await page.setContent(await renderStudioHtml(s,{width:390,height:844,outputKind:'long-screenshot'}));
 const corners=await page.locator('.scene-bubble').evaluateAll(nodes=>nodes.map(e=>{const s=getComputedStyle(e);return [s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius];}));
 expect(corners.length).toBeGreaterThan(0);expect(corners.every(c=>c.every(v=>v===`${radius}px`))).toBeTruthy();
});

test('social album captions are visible beside their corresponding images',async({page})=>{
 const s=createScene();const image='data:image/png;base64,AAAA';
 await page.setContent(await renderStudioHtml({...s,platform:'x',messages:[{id:'album',participantId:s.selfId,type:'album',text:'合成相册',time:'10:00',items:[{id:'a',kind:'image',asset:image,caption:'样本 A'},{id:'b',kind:'image',asset:image,caption:'样本 B'}]}]},{width:320,height:844,outputKind:'long-screenshot'}));
 for(const caption of ['样本 A','样本 B'])await expect(page.locator('.scene-album').getByText(caption,{exact:true})).toBeVisible();
});

test('short social long exports keep the composer at the bottom in editor full mode',async({page})=>{
 const html=await renderStudioHtml({...createScene(),platform:'x',messages:createScene().messages.slice(0,1)},{width:390,height:844,outputKind:'long-screenshot'});
 await page.setContent(html);await page.locator('.device').evaluate(e=>e.setAttribute('data-mode','full'));
 const gap=await page.locator('.scene-view').evaluate(e=>e.getBoundingClientRect().bottom-e.querySelector('.scene-composer')!.getBoundingClientRect().bottom);
 expect(gap).toBeLessThanOrEqual(1);
});

test('social deterministic HTML shares the exact rendered scene with MCP',async()=>{
 const scene={...createScene(),platform:'threads' as const};
 const shared=await renderStudioHtml(scene,{width:390,height:844,outputKind:'long-screenshot'});
 const html=renderSceneHtml(scene,{width:390,surface:'ios',outputKind:'long-screenshot'});
 expect(html).toBe(shared);
});

import {test,expect,type Page} from '@playwright/test';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {createScene} from '../../apps/web/src/studio/model';
import { completeOnboarding } from './prefs';
// New sessions follow the browser language; this suite asserts Chinese WeChat
// defaults (message avatars, names), so it runs as a Chinese browser.
test.use({ locale: 'zh-CN' });
const artifact=process.env.IMSTAGE_ARTIFACT_DIR||'.local';
type Owner={origin:string;email:string;password:string};
const OWNER_PASSWORD='synthetic-contact-tests-2026';
async function registerOwner(page:Page):Promise<Owner> {
 await page.goto('/#/create');const origin=new URL(page.url()).origin;
 const email=`contacts-${crypto.randomUUID()}@example.test`;
 const r=await page.request.post('/api/auth/register',{headers:{Origin:origin,'X-IMStage-Request':'1'},data:{email,name:'创作者',password:OWNER_PASSWORD}});expect(r.ok()).toBeTruthy();
 expect((await page.request.put('/api/preferences',{headers:{Origin:origin,'X-IMStage-Request':'1'},data:{revision:1,onboardingStatus:'completed'}})).ok()).toBeTruthy();
 await page.reload();await expect(page.locator('.agent-identity-summary')).toContainText('尚未设置');
 return {origin,email,password:OWNER_PASSWORD};
}
async function ready(page:Page) { return (await registerOwner(page)).origin; }
async function generation(page:Page,changeIds=false) {
 const origin=new URL(page.url()).origin;
 await page.route('**/api/agent/run',async route=>{
 const {scene}=route.request().postDataJSON();const next={...scene,messages:[{id:'m1',participantId:scene.selfId,type:'text',text:'明天一起去看展吗？',time:'09:41'},{id:'m2',participantId:scene.participants[1].id,type:'text',text:'好呀，我们十点见。',time:'09:41'}]};
 if(changeIds){next.participants=next.participants.map((p:{id:string})=>({...p,id:`new-${p.id}`,avatar:undefined}));next.messages=next.messages.map((m:{participantId:string})=>({...m,participantId:`new-${m.participantId}`}));next.selfId=`new-${next.selfId}`;}
 await backendRetain(page,origin,next);
 await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene:next},{type:'assistant',text:'已生成'},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
 });
 await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成明天看展的对话');await page.getByRole('button',{name:'开始生成',exact:true}).click();
 // The backend retains people once per generation; the browser must not PUT a
 // duplicate capture and must not claim a save the backend never reported.
 await expect(page.locator('.agent-render-footer')).toContainText('画面已更新，可以继续说想改哪里。');
 await expect(page.locator('.agent-render-footer')).not.toContainText('人物与头像已存入');
}
const MAX_AVATAR_CHARS=2*1024*1024;
const library=async(page:Page)=>(await(await page.request.get('/api/contact-library')).json());
/** Real valid noisy PNG above the 2 MiB per-contact avatar ceiling. */
async function noisyAvatar():Promise<string>{
 const size=1024;const raw=Buffer.alloc(size*size*3);
 for(let offset=0;offset<raw.length;offset+=65536)crypto.getRandomValues(raw.subarray(offset,Math.min(offset+65536,raw.length)));
 const png=await sharp(raw,{raw:{width:size,height:size,channels:3}}).png().toBuffer();
 const dataUrl='data:image/png;base64,'+png.toString('base64');
 expect(dataUrl.length).toBeGreaterThan(MAX_AVATAR_CHARS);
 return dataUrl;
}
/**
 * Models the real backend auto-save lifecycle of services/contacts/runtime.mjs:
 * the run endpoint retains contact-library copies once (oversized avatars become
 * deterministic 256px PNG thumbnails; identical people dedup), while the browser
 * never issues its own autosave PUT.
 */
type ScenePerson={id:string;name:string;subtitle?:string;avatar?:string|null};
async function backendRetain(page:Page,origin:string,scene:{selfId:string;participants:ScenePerson[]}) {
 const current=await library(page);
 if(!current.autoSave)return;
 const self=current.contacts.find((c:ScenePerson)=>c.id===current.selfContactId);
 const people=scene.participants.map(p=>p.id===scene.selfId&&self&&!p.avatar?{...p,name:self.name,subtitle:self.subtitle||'',avatar:self.avatar||null}:p);
 const contacts=[...current.contacts];
 for(const person of people){
  const name=(person.name||'').trim();
  let avatar=person.avatar||null;
  if(avatar&&avatar.length>MAX_AVATAR_CHARS){
   const thumb=await sharp(Buffer.from(avatar.split(',')[1],'base64')).resize({width:256,height:256,fit:'inside',withoutEnlargement:true}).png({compressionLevel:9}).toBuffer();
   avatar='data:image/png;base64,'+thumb.toString('base64');
  }
  if(!name||contacts.some(c=>c.name.trim()===name&&(c.avatar||'')===(avatar||'')&&(c.subtitle||'')===(person.subtitle||'')))continue;
  if(contacts.length>=100)break;
  contacts.push({id:crypto.randomUUID(),name,subtitle:person.subtitle||'',avatar});
 }
 if(contacts.length===current.contacts.length)return;
 const res=await page.request.put('/api/contact-library',{headers:{Origin:origin,'X-IMStage-Request':'1'},data:{...current,contacts}});
 expect(res.ok()).toBeTruthy();
}
test('default avatar survives two fresh creations and contact deletion never mutates the existing scene',async({page})=>{
 await ready(page);await page.getByRole('button',{name:'人物与头像',exact:true}).click();
 const panel=page.getByRole('complementary',{name:'人物与头像',exact:true});
 await panel.getByRole('button',{name:'新建另一个人物',exact:true}).click();
 await panel.getByLabel(/^人物姓名：/).last().fill('林小满');
 const png=await sharp({create:{width:80,height:80,channels:3,background:'#6586aa'}}).png().toBuffer();
 const fileChooser=page.waitForEvent('filechooser');await panel.getByRole('button',{name:'上传头像：林小满',exact:true}).click();await(await fileChooser).setFiles({name:'portrait.png',mimeType:'image/png',buffer:png});await expect(panel.getByAltText('林小满的头像')).toBeVisible();
 await panel.getByRole('button',{name:'我的默认人物',exact:true}).click();await expect(panel.locator('.contact-sync')).toContainText('已同步');
 const first=(await(await page.request.get('/api/contact-library')).json()).contacts[0];expect(first.avatar).toContain('data:image/png');
 await page.getByRole('button',{name:'关闭人物库'}).click();await generation(page,true);
 await expect(page.locator('.agent-phone .is-self .scene-avatar')).toHaveAttribute('src',first.avatar);
 await page.getByRole('button', { name:'新建会话', exact:true }).click();
 await expect(page.locator('.agent-phone .scene-row')).toHaveCount(0);
 await expect(page.locator('.agent-identity-summary')).toContainText('林小满');
 await generation(page,true);await expect(page.locator('.agent-phone .is-self .scene-avatar')).toHaveAttribute('src',first.avatar);
 expect((await(await page.request.get('/api/contact-library')).json()).contacts).toHaveLength(2);
 await page.getByRole('button',{name:'人物与头像',exact:true}).click();await panel.getByRole('button',{name:'移除：林小满',exact:true}).click();await expect(panel.locator('.contact-row')).toHaveCount(1);
 await expect(page.locator('.agent-phone .is-self .scene-avatar')).toHaveAttribute('src',first.avatar);
});
for(const [id,width,height] of [['iphone-17-pro',1206,2622],['pixel-8',1080,2400],['macos-window',2000,1440]] as const) test(`device fidelity ${id}: exact export, same messages, no clipped composer`,async({page})=>{
 await ready(page);await generation(page);await page.getByLabel('截图设备',{exact:true}).selectOption(id);
 const phone=page.locator('.agent-phone');await expect(phone.locator('.scene-view')).toHaveAttribute('data-device',id);
 await expect(phone).toContainText('明天一起去看展吗？');await expect(phone).toContainText('好呀，我们十点见。');
 const geometry=await phone.evaluate(el=>{const root=el.getBoundingClientRect(),composer=el.querySelector('.scene-composer')!.getBoundingClientRect();return {inside:composer.top>root.top&&composer.bottom<=root.bottom,status:getComputedStyle(el.querySelector('.scene-status')!).display,composerHeight:composer.height};});expect(geometry.inside).toBeTruthy();expect(geometry.status==='none').toBe(id==='macos-window');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();const output=await download;const file=`${artifact}/fidelity-${id}.png`;await output.saveAs(file);const meta=await sharp(file).metadata();expect([meta.width,meta.height]).toEqual([width,height]);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:/渲染画面/}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('long screenshot grows with messages while preserving selected device width',async({page})=>{
 await ready(page);const scene={...createScene(),surface:'ios',deviceProfileId:'iphone-17-pro'};
 scene.messages=Array.from({length:25},(_,i)=>({...scene.messages[0],id:`long-${i}`,text:`第 ${i+1} 条：周末一起去看展，然后找一家咖啡馆聊聊天。`,time:`10:${String(i).padStart(2,'0')}`}));
 await page.route('**/api/agent/run',async route=>{await backendRetain(page,new URL(page.url()).origin,scene);await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});});
 await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成长对话');await page.getByRole('button',{name:'开始生成',exact:true}).click();await expect(page.locator('.agent-render-footer')).toContainText('画面已更新，可以继续说想改哪里。');
 await page.getByLabel('导出图片范围').selectOption('full');const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();const file=await(await download).path();const data=await readFile(file!);const meta=await sharp(data).metadata();expect(meta.width).toBe(1206);expect(meta.height).toBeGreaterThan(2622);
});

test('generated avatars autosave and a later provider failure preserves the saved image',async({page})=>{
 await ready(page);await page.getByRole('button',{name:'人物与头像',exact:true}).click();const panel=page.getByRole('complementary',{name:'人物与头像',exact:true});
 await panel.getByRole('button',{name:'新建另一个人物',exact:true}).click();await panel.getByLabel(/^人物姓名：/).last().fill('小满');
 await panel.getByRole('button',{name:'AI 生成头像：小满',exact:true}).click();await panel.getByLabel('描述想生成的头像',{exact:true}).fill('自然光头像');
 const avatar='data:image/png;base64,'+(await sharp({create:{width:64,height:64,channels:3,background:'#657f4a'}}).png().toBuffer()).toString('base64');
 await page.route('**/api/agent/run',async route=>{const {scene,targetId}=route.request().postDataJSON();expect(targetId).toBe('@participant:portrait');await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene:{...scene,participants:[{...scene.participants[0],avatar}]}},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});});
 await panel.getByRole('button',{name:'AI 生成头像',exact:true}).click();await expect(panel.getByAltText('小满的头像')).toBeVisible();
 const generated=await panel.getByAltText('小满的头像').getAttribute('src');expect(generated).toContain('data:image/png');
 const decoded=await sharp(Buffer.from(generated!.split(',')[1],'base64')).raw().toBuffer();expect([...decoded.slice(0,3)]).toEqual([101,127,74]);
 await expect.poll(async()=>(await(await page.request.get('/api/contact-library')).json()).contacts[0]?.avatar).toBe(generated);
 await page.unroute('**/api/agent/run');await page.route('**/api/agent/run',r=>r.fulfill({status:503,json:{error:{message:'生图服务不可用'}}}));
 await panel.getByRole('button',{name:'AI 生成头像',exact:true}).click();await expect(panel.getByRole('alert')).toContainText('生图服务不可用');await expect(panel.getByAltText('小满的头像')).toHaveAttribute('src',generated!);
 await page.reload();await page.getByRole('button',{name:'人物与头像',exact:true}).click();await expect(panel.getByAltText('小满的头像')).toHaveAttribute('src',generated!);
});

test('contact library outage cannot block core conversation generation',async({page})=>{
 await ready(page);await page.route('**/api/contact-library',r=>r.fulfill({status:503,json:{error:{message:'人物库暂不可用'}}}));await page.reload();await expect(page.locator('.agent-identity-summary')).toContainText('人物库连接失败');
 await page.route('**/api/agent/run',r=>{const {scene}=r.request().postDataJSON();return r.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene:{...scene,messages:[{id:'m',type:'text',participantId:scene.selfId,text:'核心创作继续可用',time:'09:41'}]}},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});});
 await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成一段聊天');await page.getByRole('button',{name:'开始生成',exact:true}).click();await expect(page.locator('.agent-phone')).toContainText('核心创作继续可用');
});

test('an oversized generated avatar auto-saves once as a thumbnail while the scene keeps its bytes',async({page})=>{
 const origin=await ready(page);const oversized=await noisyAvatar();let generationCount=0;
 await page.route('**/api/agent/run',async route=>{
  const {scene}=route.request().postDataJSON();
  const next={...scene,messages:[{id:'m1',participantId:scene.participants[1].id,type:'text',text:`明天美术馆见。合成轮次 ${++generationCount}`,time:'09:41'}],
   participants:scene.participants.map((p:ScenePerson,i:number)=>i===1?{...p,name:'阿远',avatar:oversized}:p)};
  await backendRetain(page,origin,next);
  await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene:next},{type:'assistant',text:'已生成'},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
 });
 await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成一句约见');await page.getByRole('button',{name:'开始生成',exact:true}).click();
 await expect(page.locator('.agent-render-footer')).toContainText('画面已更新，可以继续说想改哪里。');
 await expect(page.locator('.agent-render-footer')).not.toContainText('人物与头像已存入');
 const after=await library(page);
 const saved=after.contacts.find((c:ScenePerson)=>c.name==='阿远');
 expect(saved.avatar).toContain('data:image/png;base64,');
 expect(saved.avatar.length).toBeLessThanOrEqual(MAX_AVATAR_CHARS);
 const meta=await sharp(Buffer.from(saved.avatar.split(',')[1],'base64')).metadata();
 expect(meta.format).toBe('png');expect(Math.max(meta.width!,meta.height!)).toBeLessThanOrEqual(256);
 // The Scene keeps its original oversized avatar bytes untouched.
 expect((await page.locator('.agent-phone .scene-row').first().locator('.scene-avatar').getAttribute('src'))!.length).toBeGreaterThan(MAX_AVATAR_CHARS);
 // A repeated generation of the same people dedups: no second write.
 await page.getByLabel('描述想生成的聊天',{exact:true}).fill('再生成一次');await page.getByRole('button',{name:'开始生成',exact:true}).click();
 await expect(page.locator('.agent-render-footer')).toContainText('画面已更新，可以继续说想改哪里。');
 await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toBeEnabled();
 await expect.poll(async()=>(await library(page)).revision).toBe(after.revision);
});

test('manual scene capture stores a real bounded thumbnail with no duplicate autosave write',async({page})=>{
 await ready(page);const oversized=await noisyAvatar();
 await page.route('**/api/agent/run',async route=>{
  const {scene}=route.request().postDataJSON();
  const next={...scene,messages:[{id:'m1',participantId:scene.participants[1].id,type:'text',text:'这张照片给你。',time:'09:41'}],
   participants:scene.participants.map((p:ScenePerson,i:number)=>i===1?{...p,name:'阿远',avatar:oversized}:p)};
  await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene:next},{type:'assistant',text:'已生成'},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
 });
 await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成一句');await page.getByRole('button',{name:'开始生成',exact:true}).click();
 await expect(page.locator('.agent-render-footer')).toContainText('画面已更新，可以继续说想改哪里。');
 const before=await library(page);
 expect(before.contacts).toHaveLength(0);
 await page.getByRole('button',{name:'人物与头像',exact:true}).click();
 const panel=page.getByRole('complementary',{name:'人物与头像',exact:true});
 const capture=panel.getByRole('button',{name:'保存当前对话中的人物',exact:true});
 // A rapid double capture is replaced, never duplicated.
 await capture.click();await capture.click();
 await expect(panel.getByRole('status').filter({hasText:'当前人物已保存。'})).toBeVisible();
 await expect(capture).toBeEnabled();
 const after=await library(page);
 expect(after.revision).toBe(before.revision+1);
 const saved=after.contacts.find((c:ScenePerson)=>c.name==='阿远');
 expect(saved.avatar).toContain('data:image/png;base64,');
 expect(saved.avatar.length).toBeLessThanOrEqual(MAX_AVATAR_CHARS);
 const meta=await sharp(Buffer.from(saved.avatar.split(',')[1],'base64')).metadata();
 expect(meta.format).toBe('png');expect(Math.max(meta.width!,meta.height!)).toBeLessThanOrEqual(256);
 // The original Scene avatar is preserved, not replaced by the thumbnail.
 expect((await page.locator('.agent-phone .scene-row').first().locator('.scene-avatar').getAttribute('src'))!.length).toBeGreaterThan(MAX_AVATAR_CHARS);
 // Capturing identical content again is a no-op: still exactly one write.
 await capture.click();await expect(capture).toBeEnabled();
 await expect.poll(async()=>(await library(page)).revision).toBe(after.revision);
});

test('a manual capture after an owner change writes only into the new owner library',async({page})=>{
 test.setTimeout(60_000);
 const avatarA='data:image/png;base64,'+(await sharp({create:{width:64,height:64,channels:3,background:'#664422'}}).png().toBuffer()).toString('base64');
 const avatarB='data:image/png;base64,'+(await sharp({create:{width:64,height:64,channels:3,background:'#224466'}}).png().toBuffer()).toString('base64');
 let avatar=avatarA;
 await page.route('**/api/agent/run',async route=>{
  const {scene}=route.request().postDataJSON();
  const next={...scene,messages:[{id:'m1',participantId:scene.participants[1].id,type:'text',text:'你好。',time:'09:41'}],
   participants:scene.participants.map((p:ScenePerson,i:number)=>i===1?{...p,name:'阿远',avatar}:p)};
  await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene:next},{type:'assistant',text:'已生成'},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
 });
 const ownerA=await registerOwner(page);
 const capturePerson=async()=>{
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成一句');await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await expect(page.locator('.agent-render-footer')).toContainText('画面已更新，可以继续说想改哪里。');
  await page.getByRole('button',{name:'人物与头像',exact:true}).click();
  const panel=page.getByRole('complementary',{name:'人物与头像',exact:true});
  await panel.getByRole('button',{name:'保存当前对话中的人物',exact:true}).click();
  await expect(panel.getByRole('status').filter({hasText:'当前人物已保存。'})).toBeVisible();
 };
 await capturePerson();
 const libraryA=await library(page);
 expect(libraryA.contacts).toHaveLength(2);
 expect(libraryA.contacts.find((c:ScenePerson)=>c.name==='阿远').avatar).toBe(avatarA);
 // Switch owners in the same tab, then capture again as the new owner.
 await page.goto('/#/account');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await expect(page).toHaveURL(/#\/login/);
 await page.getByRole('link',{name:'创建账号',exact:true}).click();
 await page.getByLabel('怎么称呼你').fill('第二位创作者');
 await page.getByLabel('邮箱',{exact:true}).fill(`owner-b-${crypto.randomUUID()}@example.test`);
 await page.getByLabel('密码',{exact:true}).fill('synthetic-owner-tests-2026');
 await page.getByTestId('terms-consent').check();
 await page.getByRole('button',{name:'创建账号',exact:true}).click();
 await completeOnboarding(page);
 await page.goto('/#/create');
 avatar=avatarB;
 await capturePerson();
 const libraryB=await library(page);
 expect(libraryB.contacts).toHaveLength(2);
 expect(libraryB.contacts.find((c:ScenePerson)=>c.name==='阿远').avatar).toBe(avatarB);
 // Signing back in as the first owner: its library is untouched by owner B.
 await page.goto('/#/account');
 await page.getByRole('button',{name:'退出登录',exact:true}).click();
 await expect(page).toHaveURL(/#\/login/);
 await page.getByLabel('邮箱',{exact:true}).fill(ownerA.email);
 await page.getByLabel('密码',{exact:true}).fill(ownerA.password);
 await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page).not.toHaveURL(/#\/login/);
 await page.goto('/#/create');
 await expect(page.locator('.agent-phone')).toContainText('你好。');
 const finalA=await library(page);
 expect(finalA.contacts).toHaveLength(2);
 expect(finalA.contacts.find((c:ScenePerson)=>c.name==='阿远').avatar).toBe(avatarA);
});

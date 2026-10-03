import {test,expect,type Page} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {createScene} from '../../apps/web/src/studio/model';

test.use({locale:'zh-CN'});
async function setup(page:Page,width:number,height:number,autoSave=false){
 const origin=new URL(test.info().project.use.baseURL!).origin;
 const headers={Origin:origin,'X-IMStage-Request':'1'};
 const user=await page.request.post('/api/auth/register',{headers,data:{email:`capture-${crypto.randomUUID()}@example.test`,name:'合成验收',password:'Synthetic-Capture-2026!'}});expect(user.ok()).toBeTruthy();
 await page.request.put('/api/preferences',{headers,data:{revision:1,onboardingStatus:'completed'}});
 const lib=await(await page.request.get('/api/contact-library')).json();
 expect((await page.request.put('/api/contact-library',{headers,data:{...lib,autoSave}})).ok()).toBeTruthy();
 const bytes=await sharp(randomBytes(width*height*4),{raw:{width,height,channels:4}}).png().toBuffer();
 const avatar='data:image/png;base64,'+bytes.toString('base64');expect(avatar.length).toBeGreaterThan(2*1024*1024);
 const id=crypto.randomUUID();const scene={...createScene(),id,platform:'wechat' as const,title:'合成手动保存测试',selfId:'me',participants:[{id:'me',name:'合成自己'},{id:'friend',name:'合成朋友',avatar}],messages:[{id:'hello',participantId:'friend',type:'text' as const,text:'合成验收消息',time:'09:41'}]};
 const saved=await page.request.put(`/api/scenes/${id}`,{headers,data:{revision:0,scene}});expect(saved.ok(),await saved.text()).toBeTruthy();
 await page.goto(`/#/workspace?scene=${id}`);await expect(page.locator('.agent-phone')).toContainText('合成验收消息');
 await page.getByRole('button',{name:'人物与头像',exact:true}).click();
 const panel=page.getByRole('complementary',{name:'人物与头像',exact:true});await expect(panel.getByRole('button',{name:'保存当前对话中的人物',exact:true})).toBeEnabled();
 return {panel,avatar,id};
}

test('manual capture saves bounded extreme-aspect copies even with automatic retention disabled',async({page})=>{
 const {panel,avatar,id}=await setup(page,24000,20);
 await panel.getByRole('button',{name:'保存当前对话中的人物',exact:true}).click();
 await expect(panel.getByText('当前人物已保存。',{exact:true})).toBeVisible();
 const lib=await(await page.request.get('/api/contact-library')).json();expect(lib.autoSave).toBe(false);expect(lib.contacts).toHaveLength(2);
 const thumb=lib.contacts.find((p:{name:string})=>p.name==='合成朋友').avatar;
 expect(thumb.length).toBeLessThan(2*1024*1024);const meta=await sharp(Buffer.from(thumb.split(',')[1],'base64')).metadata();expect([meta.width,meta.height]).toEqual([256,1]);
 const saved=(await(await page.request.get(`/api/scenes/${id}`)).json()).item.scene;expect(saved.participants[1].avatar).toBe(avatar);
 await panel.getByRole('button',{name:'保存当前对话中的人物',exact:true}).click();await expect(panel.getByText('当前人物已保存。',{exact:true})).toBeVisible();
 await expect(panel.getByRole('button',{name:'保存当前对话中的人物',exact:true})).toBeEnabled();
 const again=await(await page.request.get('/api/contact-library')).json();expect(again.contacts).toHaveLength(2);expect(again.revision).toBe(lib.revision);
});

test('closing the people panel during avatar preparation releases the editor and fences the late write',async({page})=>{
 const {panel,avatar}=await setup(page,1024,1024);
 await page.evaluate(source=>{
  const state=window as unknown as {captureDecodeStarted:boolean;releaseCaptureDecode:()=>Promise<void>};
  const original=Image.prototype.decode;
  Image.prototype.decode=function(){if(this.src!==source)return original.call(this);state.captureDecodeStarted=true;return new Promise<void>(resolve=>{state.releaseCaptureDecode=()=>{Image.prototype.decode=original;return original.call(this).then(resolve);};});};
 },avatar);
 await panel.getByRole('button',{name:'保存当前对话中的人物',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as unknown as {captureDecodeStarted:boolean}).captureDecodeStarted)).toBe(true);
 const picker=page.locator('.agent-render-toolbar').getByLabel('目标聊天平台',{exact:true});await expect(picker).toBeDisabled();
 await page.getByRole('button',{name:'元素编辑',exact:true}).click();await expect(panel).toHaveCount(0);await expect(picker).toBeEnabled();
 await page.evaluate(()=>(window as unknown as {releaseCaptureDecode:()=>Promise<void>}).releaseCaptureDecode());
 await page.getByRole('button',{name:'人物与头像',exact:true}).click();await expect(panel.getByRole('button',{name:'保存当前对话中的人物',exact:true})).toBeEnabled();
 const lib=await(await page.request.get('/api/contact-library')).json();expect(lib.contacts).toHaveLength(0);
});

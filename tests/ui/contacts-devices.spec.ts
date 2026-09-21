import {test,expect,type Page} from '@playwright/test';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {createScene} from '../../apps/web/src/studio/model';
const artifact=process.env.IMSTAGE_ARTIFACT_DIR||'.local';
async function ready(page:Page) {
 await page.goto('/#/create');const origin=new URL(page.url()).origin;
 const r=await page.request.post('/api/auth/register',{headers:{Origin:origin,'X-IMStage-Request':'1'},data:{email:`contacts-${crypto.randomUUID()}@example.test`,name:'创作者',password:'synthetic-contact-tests-2026'}});expect(r.ok()).toBeTruthy();
 await page.reload();await expect(page.locator('.agent-identity-summary')).toContainText('尚未设置');
 return origin;
}
async function generation(page:Page,changeIds=false) {
 await page.route('**/api/agent/run',async route=>{
 const {scene}=route.request().postDataJSON();const next={...scene,messages:[{id:'m1',participantId:scene.selfId,type:'text',text:'明天一起去看展吗？',time:'09:41'},{id:'m2',participantId:scene.participants[1].id,type:'text',text:'好呀，我们十点见。',time:'09:41'}]};
 if(changeIds){next.participants=next.participants.map((p:{id:string})=>({...p,id:`new-${p.id}`,avatar:undefined}));next.messages=next.messages.map((m:{participantId:string})=>({...m,participantId:`new-${m.participantId}`}));next.selfId=`new-${next.selfId}`;}
 await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene:next},{type:'assistant',text:'已生成'},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'});
 });
 await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成明天看展的对话');await page.getByRole('button',{name:'开始生成',exact:true}).click();await expect(page.locator('.agent-render-footer')).toContainText('人物与头像已存入');
}
test('default avatar survives two fresh creations and contact deletion never mutates the existing scene',async({page})=>{
 await ready(page);await page.getByRole('button',{name:'人物与头像',exact:true}).click();
 const panel=page.getByRole('complementary',{name:'人物与头像',exact:true});
 await panel.getByLabel('人物姓名',{exact:true}).fill('林小满');
 const png=await sharp({create:{width:80,height:80,channels:3,background:'#6586aa'}}).png().toBuffer();
 await panel.locator('input[type=file]').setInputFiles({name:'portrait.png',mimeType:'image/png',buffer:png});await expect(panel.getByAltText('待保存的头像')).toBeVisible();
 await panel.getByRole('button',{name:'保存人物',exact:true}).click();await expect(panel.locator('.contact-row')).toContainText('我的默认人物');
 const first=(await(await page.request.get('/api/contact-library')).json()).contacts[0];expect(first.avatar).toContain('data:image/png');
 await page.getByRole('button',{name:'关闭人物库'}).click();await generation(page,true);
 await expect(page.locator('.agent-phone .is-self .scene-avatar')).toHaveAttribute('src',first.avatar);
 await page.evaluate(()=>{for(const key of Object.keys(sessionStorage))if(key.startsWith('imstage.agent.'))sessionStorage.removeItem(key);});await page.reload();await expect(page.locator('.agent-identity-summary')).toContainText('林小满');
 await generation(page,true);await expect(page.locator('.agent-phone .is-self .scene-avatar')).toHaveAttribute('src',first.avatar);
 expect((await(await page.request.get('/api/contact-library')).json()).contacts).toHaveLength(2);
 await page.getByRole('button',{name:'人物与头像',exact:true}).click();await panel.locator('.contact-row').filter({hasText:'林小满'}).getByRole('button',{name:'移除'}).click();await expect(panel.locator('.contact-row')).toHaveCount(1);
 await expect(page.locator('.agent-phone .is-self .scene-avatar')).toHaveAttribute('src',first.avatar);
});
for(const [id,width,height] of [['iphone-15-pro',1179,2556],['pixel-8',1080,2400],['macos-window',2000,1440]] as const) test(`device fidelity ${id}: exact export, same messages, no clipped composer`,async({page})=>{
 await ready(page);await generation(page);await page.getByLabel('截图设备',{exact:true}).selectOption(id);
 const phone=page.locator('.agent-phone');await expect(phone.locator('.scene-view')).toHaveAttribute('data-device',id);
 await expect(phone).toContainText('明天一起去看展吗？');await expect(phone).toContainText('好呀，我们十点见。');
 const geometry=await phone.evaluate(el=>{const root=el.getBoundingClientRect(),composer=el.querySelector('.scene-composer')!.getBoundingClientRect();return {inside:composer.top>root.top&&composer.bottom<=root.bottom,status:getComputedStyle(el.querySelector('.scene-status')!).display,composerHeight:composer.height};});expect(geometry.inside).toBeTruthy();expect(geometry.status==='none').toBe(id==='macos-window');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();const output=await download;const file=`${artifact}/fidelity-${id}.png`;await output.saveAs(file);const meta=await sharp(file).metadata();expect([meta.width,meta.height]).toEqual([width,height]);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:/渲染画面/}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
});
test('long screenshot grows with messages while preserving selected device width',async({page})=>{
 await ready(page);const scene={...createScene(),surface:'ios',deviceProfileId:'iphone-15-pro'};
 scene.messages=Array.from({length:25},(_,i)=>({...scene.messages[0],id:`long-${i}`,text:`第 ${i+1} 条：周末一起去看展，然后找一家咖啡馆聊聊天。`,time:`10:${String(i).padStart(2,'0')}`}));
 await page.route('**/api/agent/run',route=>route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene},{type:'done'}].map(e=>JSON.stringify(e)).join('\n')+'\n'}));
 await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成长对话');await page.getByRole('button',{name:'开始生成',exact:true}).click();await expect(page.locator('.agent-render-footer')).toContainText('人物与头像已存入');
 await page.getByLabel('导出图片范围').selectOption('full');const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();const file=await(await download).path();const data=await readFile(file!);const meta=await sharp(data).metadata();expect(meta.width).toBe(1179);expect(meta.height).toBeGreaterThan(2556);
});

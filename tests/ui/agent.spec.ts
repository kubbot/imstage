import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';
async function ready(page: Page) {
  await page.goto('/#/create');
  const origin = new URL(page.url()).origin;
  const response = await page.request.post('/api/auth/register', { headers:{ Origin:origin,'X-IMStage-Request':'1' }, data:{email:`agent-${crypto.randomUUID()}@example.test`,name:'创作者',password:'synthetic-agent-password-2026'} });
  expect(response.ok()).toBeTruthy();
  await page.route('**/api/agent/capabilities', route => route.fulfill({json:{configured:true,model:'deepseek-flash',imageConfigured:false}}));
  await page.reload(); await expect(page.getByRole('button',{name:'开始生成',exact:true})).toBeVisible();
}
async function generate(page: Page) {
  await page.route('**/api/agent/run', async route => {
    const {scene, targetId, prompt} = route.request().postDataJSON();
    const messages = targetId ? scene.messages.map((m: {id:string;text:string}) => m.id === targetId ? {...m,text:prompt} : m) : [{id:'m1',participantId:scene.selfId,type:'text',text:'周末一起去看展吗？',time:'09:41'},{id:'m2',participantId:scene.participants[1].id,type:'text',text:'好呀，上海见！',time:'09:42'}];
    const events = [{type:'tool',id:'call-1',name:'upsert_message',state:'running',detail:'正在编排消息'}, {type:'scene',scene:{...scene,messages}}, {type:'tool',id:'call-1',name:'upsert_message',state:'done',detail:'消息已更新'}, {type:'assistant',text:'已经更新画面，你可以继续修改。'}, {type:'done'}];
    await route.fulfill({contentType:'application/x-ndjson',body:events.map(v=>JSON.stringify(v)).join('\n')+'\n'});
  });
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('生成周末和朋友看展的两句聊天');
  await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await expect(page.locator('.agent-phone')).toContainText('上海见');
}
test('Agent creation, scoped Vibe Edit, undo and PNG export share the rendered scene', async ({page}) => {
  await ready(page); await generate(page);
  await page.getByRole('button',{name:'选择消息：周末一起去看展吗？',exact:true}).click();
  await expect(page.getByRole('complementary',{name:'Vibe Edit'})).toBeVisible();
  const request = page.waitForRequest('**/api/agent/run');
  await page.getByLabel('描述想怎样修改').fill('周末要不要一起去逛展？');
  await page.getByRole('button',{name:'发送修改',exact:true}).click();
  expect((await request).postDataJSON().targetId).toBe('m1');
  await expect(page.locator('.agent-phone')).toContainText('周末要不要一起去逛展？');
  await expect(page.locator('.agent-phone')).toContainText('好呀，上海见！');
  await page.getByRole('button',{name:'撤销上次修改'}).click();
  await expect(page.locator('.agent-phone')).toContainText('周末一起去看展吗？');
  await page.getByRole('button',{name:'关闭 AI 编辑'}).click();
  const download = page.waitForEvent('download'); await page.getByRole('button',{name:'导出 PNG'}).click();
  expect((await download).suggestedFilename()).toBe('imstage-1179x2556.png');
  await page.getByLabel('导出图片范围').selectOption('standard');
  const standardDownload=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG'}).click();
  const file=await(await standardDownload).path();const {data,info}=await sharp(file!).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  expect([info.width,info.height]).toEqual([1179,2556]);expect(data.at(-1)).toBe(255);
});
test('provider failure keeps previous scene and restores editable request', async ({page}) => {
  await ready(page); await generate(page);
  await page.route('**/api/agent/run', route => route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'error',message:'图片服务尚未配置'})+'\n'}));
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('加入一张美食照片'); await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('图片服务尚未配置');
  await expect(page.locator('.agent-phone')).toContainText('好呀，上海见！');
  await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('加入一张美食照片');
});
test('cancel and unmount cannot apply a late result', async ({page}) => {
  await ready(page); await generate(page);
  await page.route('**/api/agent/run', async route => { await new Promise(r=>setTimeout(r,1200)); await route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'error',message:'late failure'})+'\n'}).catch(()=>{}); });
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('继续写三句'); await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await page.getByRole('button',{name:'停止生成',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('已停止');
  await expect(page.locator('.agent-phone')).toContainText('上海见');
  await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await page.goto('/#/workspace'); await page.waitForTimeout(1300);
  await expect(page).toHaveURL(/#\/workspace$/);
  await expect(page.getByText('late failure')).toHaveCount(0);
});
for(const theme of ['light','dark'] as const) test(`Agent responsive and accessible ${theme}`, async ({page}) => {
  await ready(page); await generate(page);
  await page.emulateMedia({colorScheme:theme});
  for(const width of [390,1440]) {
    await page.setViewportSize({width,height:960});
    if(width===390) await page.getByRole('button',{name:/渲染画面/}).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
    await page.getByRole('button',{name:'选择消息：周末一起去看展吗？',exact:true}).click();
    await expect(page.getByLabel('描述想怎样修改')).toBeVisible();
    const axe = await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();
    expect(axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:`${process.env.IMSTAGE_ARTIFACT_DIR || '.local'}/agent-${theme}-${width}.png`});
    await page.getByRole('button',{name:'关闭 AI 编辑'}).click();
  }
});
test('account save and Agent generation cannot interrupt each other',async({page})=>{
  await ready(page); await page.goto('/#/workspace?scene=new');
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('请生成一句你好');
  let releaseSave:()=>void=()=>{}; const holdSave=new Promise<void>(resolve=>{releaseSave=resolve;});
  await page.route('**/api/scenes/*',async route=>{if(route.request().method()!=='PUT')return route.continue();await holdSave;await route.fulfill({response:await route.fetch()});});
  await page.getByRole('button',{name:'保存作品',exact:true}).click();
  await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'开始生成',exact:true})).toBeDisabled();
  releaseSave();await expect(page).toHaveURL(/scene=[0-9a-f-]{36}/);
  let releaseRun:()=>void=()=>{};const holdRun=new Promise<void>(resolve=>{releaseRun=resolve;});
  await page.route('**/api/agent/run',async route=>{const {scene}=route.request().postDataJSON();await holdRun;await route.fulfill({contentType:'application/x-ndjson',body:[{type:'scene',scene:{...scene,messages:[{id:'hello',participantId:scene.selfId,type:'text',text:'你好',time:''}]}},{type:'done'}].map(v=>JSON.stringify(v)).join('\n')+'\n'});});
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('请生成一句你好');await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await expect(page.getByRole('button',{name:'保存作品',exact:true})).toBeDisabled();
  releaseRun();await expect(page.locator('.agent-phone')).toContainText('你好');
  await expect(page.getByRole('button',{name:'保存作品',exact:true})).toBeEnabled();
});
test('guest login preserves the request and returns to Agent creation',async({page})=>{
  await page.goto('/#/create');await page.getByLabel('描述想生成的聊天',{exact:true}).fill('和朋友约周六看展');
  await page.getByRole('link',{name:'登录创作 →',exact:true}).click();
  await page.getByRole('link',{name:'创建账号',exact:true}).click();
  await page.getByLabel('怎么称呼你').fill('创作者');await page.getByLabel('邮箱',{exact:true}).fill(`guest-${crypto.randomUUID()}@example.test`);await page.getByLabel('密码',{exact:true}).fill('synthetic-agent-password-2026');
  await page.getByRole('button',{name:'创建账号',exact:true}).click();
  await expect(page).toHaveURL(/#\/create$/);await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('和朋友约周六看展');
});
test('unsaved Agent request in an account scene is protected when recovery storage fails',async({page})=>{
  await ready(page);await page.goto('/#/workspace?scene=new');
  await page.getByRole('button',{name:'保存作品',exact:true}).click();await expect(page).toHaveURL(/scene=[0-9a-f-]{36}/);
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('imstage.agent.'))throw new DOMException('full','QuotaExceededError');return original.call(this,k,v);};});
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('这条创作需求还没有提交');await expect(page.getByRole('alert')).toContainText('无法保存草稿');
  let dialogs=0;page.on('dialog',async d=>{dialogs++;await d.dismiss();});
  const before=page.url();await page.getByRole('link',{name:'使用与接入',exact:true}).click();
  await expect.poll(()=>dialogs).toBe(1);await expect(page).toHaveURL(before);await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('这条创作需求还没有提交');
});

test('one conversation uses platform-owned chrome and survives platform switching and export',async({page})=>{
  await ready(page);await generate(page);
  const phone=page.locator('.agent-phone');
  for(const platform of ['wechat','whatsapp','instagram']){
    await page.getByLabel('目标聊天平台',{exact:true}).selectOption(platform);
    await expect(phone.locator('.scene-view')).toHaveAttribute('data-platform',platform);
    await expect(phone).toContainText('周末一起去看展吗？');await expect(phone).toContainText('好呀，上海见！');
    expect(await phone.locator('.scene-row').count()).toBe(2);
    expect(await phone.locator('.scene-message-meta').count()).toBe(platform==='whatsapp'?2:0);
    expect(await phone.locator('.scene-line .scene-avatar').count()).toBe(platform==='wechat'?2:platform==='instagram'?1:0);
    await page.getByLabel('导出图片范围').selectOption('standard');
    const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG'}).click();
    const file=await(await downloaded).path();const info=await sharp(file!).metadata();expect([info.width,info.height]).toEqual([1179,2556]);
    await phone.screenshot({path:`${process.env.IMSTAGE_ARTIFACT_DIR||'.local'}/template-${platform}.png`});
  }
});

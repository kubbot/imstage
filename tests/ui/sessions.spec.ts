import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
const fixture=JSON.parse(fs.readFileSync(new URL('../../tools/eval/fixtures/loan-anniversary.json',import.meta.url),'utf8'));
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=';
async function seed(page:Page, long=false){
  await page.addInitScript(({scene,image})=>{if(sessionStorage.getItem('sessions-test-seeded'))return;sessionStorage.setItem('sessions-test-seeded','1');sessionStorage.setItem('imstage.agent.guest.draft',JSON.stringify({scene,prompt:'尚未发送的 A 草稿',attachments:[image]}));sessionStorage.setItem('imstage.agent.guest.draft.chat',JSON.stringify([{role:'user',id:'u',content:'周末计划'},{role:'assistant',id:'a',content:'A 的创作记录'}]));},{scene:long?{...fixture.scene,messages:Array.from({length:30},(_,i)=>({id:`scroll-${i}`,participantId:i%2?'me':'achuan',type:'text',text:`滚动位置合成验证，第 ${i+1} 条对话。`,time:'10:30'}))}:fixture.scene,image});
  await page.goto('/#/create');await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('周末计划');
}
async function open(page:Page){await page.getByRole('button',{name:'管理创作会话'}).click();await expect(page.getByLabel('创作会话列表')).toBeVisible();}
async function rename(page:Page,from:string,to:string){await open(page);await page.getByRole('button',{name:`重命名：${from}`,exact:true}).click();await page.getByLabel('会话名称',{exact:true}).fill(to);await page.getByRole('button',{name:'保存名称',exact:true}).click();await expect(page.getByRole('button',{name:`打开会话：${to}`,exact:true})).toBeVisible();await page.getByRole('button',{name:'关闭会话列表'}).click();}

test('migrates legacy, isolates full drafts and transcript, persists rename and switches without losing latest typing',async({page})=>{
  await seed(page);await rename(page,'周末计划','计划 A');
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('A 最新的未发送内容');
  await page.getByRole('button',{name:'新建会话',exact:true}).click();
  await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('');await expect(page.locator('.agent-attachments img')).toHaveCount(0);await expect(page.locator('.agent-transcript')).not.toContainText('A 的创作记录');
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('独立的 B 会话');await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('已保存到本机');
  await open(page);await page.getByRole('button',{name:'打开会话：计划 A',exact:true}).click();
  await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('A 最新的未发送内容');await expect(page.locator('.agent-attachments img')).toHaveCount(1);await expect(page.locator('.agent-transcript')).toContainText('A 的创作记录');await expect(page.locator('.agent-phone')).toContainText('这笔借款结清了');
  await page.reload();await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('计划 A');await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('A 最新的未发送内容');
  await open(page);await page.getByLabel('搜索会话').fill('不存在');await expect(page.getByLabel('创作会话列表')).toContainText('没有找到相关会话');await page.getByLabel('搜索会话').fill('独立的 B');await page.getByRole('button',{name:'打开会话：独立的 B 会话',exact:true}).click();await expect(page.locator('.agent-phone .scene-row')).toHaveCount(0);
});

test('copy and delete have explicit scope and deleting current falls back safely',async({page})=>{
  await seed(page);await open(page);await page.getByRole('button',{name:'复制当前会话',exact:true}).click();await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('周末计划 · 副本');
  await open(page);await page.getByRole('button',{name:'删除：周末计划 · 副本',exact:true}).click();await page.getByRole('button',{name:'保留会话',exact:true}).click();await expect(page.getByRole('button',{name:'打开会话：周末计划 · 副本',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'删除：周末计划 · 副本',exact:true}).click();await page.getByRole('button',{name:'确认删除会话',exact:true}).click();await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('周末计划');
  await open(page);await expect(page.getByRole('button',{name:'打开会话：周末计划 · 副本',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'打开会话：周末计划',exact:true})).toBeVisible();
});

test('two tabs detect stale writes and recover local edits as a separate conversation',async({page,context})=>{
  await seed(page);const other=await context.newPage();await other.goto('/#/create');await expect(other.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('尚未发送的 A 草稿');
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('标签页一的新内容');await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('已保存到本机');
  await other.getByLabel('描述想生成的聊天',{exact:true}).fill('标签页二保留的内容');await expect(other.getByRole('alert')).toContainText('其他标签页更新');
  await other.getByRole('button',{name:'另存为新会话',exact:true}).click();await expect(other.getByRole('button',{name:'管理创作会话'})).toContainText('副本');await expect(other.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('标签页二保留的内容');
  await page.reload();await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('标签页一的新内容');
});

test('failed storage blocks switching, retains draft and retries without claiming saved',async({page})=>{
  await seed(page);
  await page.evaluate(()=>{const put=IDBObjectStore.prototype.put;(window as any).__restorePut=()=>IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.put=function(){throw new DOMException('Synthetic quota failure','QuotaExceededError');};});
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('存储失败也要保留');await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('尚未保存');
  await page.getByRole('button',{name:'新建会话',exact:true}).click();await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('存储失败也要保留');
  // The failed create must settle before the storage method is restored, or the
  // retry could race a still-running action.
  await expect(page.getByRole('button',{name:'重试保存',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'新建会话',exact:true})).toBeEnabled();
  await expect(page.getByText('尚未保存',{exact:false})).toBeVisible();
  await page.evaluate(()=>(window as any).__restorePut());await page.getByRole('button',{name:'重试保存',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);await page.reload();await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('存储失败也要保留');
});

test('session list works on small screens in both themes and respects keyboard dismissal',async({page})=>{
  await seed(page);await page.setViewportSize({width:390,height:844});
  for(const theme of ['light','dark'] as const){await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.theme)).toBe(theme);await open(page);await expect(page.getByLabel('搜索会话')).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
    const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
    await page.screenshot({path:`${process.env.IMSTAGE_ARTIFACT_DIR}/sessions-${theme}-mobile.png`});await page.keyboard.press('Escape');await expect(page.getByLabel('创作会话列表')).toHaveCount(0);await expect(page.getByRole('button',{name:'管理创作会话'})).toBeFocused();
  }
});

test('account sessions are isolated and an active AI run must stop before starting another session',async({page})=>{
  await seed(page);const result=await page.request.post('/api/auth/register',{headers:{Origin:new URL(page.url()).origin,'X-IMStage-Request':'1'},data:{email:`session-${crypto.randomUUID()}@example.test`,name:'合成创作者',password:'synthetic-session-password-2026'}});expect(result.ok()).toBeTruthy();
  await page.reload();await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('');await open(page);await expect(page.getByRole('button',{name:'打开会话：周末计划',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'关闭会话列表'}).click();
  let release:()=>void=()=>{};const gate=new Promise<void>(r=>release=r);
  await page.route('**/api/agent/run',async route=>{await gate;await route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'error',message:'不应进入新会话的旧结果'})+'\n'}).catch(()=>{});});
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('本次 AI 需求');await page.getByRole('button',{name:'开始生成',exact:true}).click();await expect(page.getByRole('button',{name:'新建会话',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'停止生成',exact:true}).click();await expect(page.getByRole('button',{name:'新建会话',exact:true})).toBeEnabled();await page.getByRole('button',{name:'新建会话',exact:true}).click();release();
  await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('');await expect(page.getByRole('region',{name:'AI 创作记录',exact:true})).not.toContainText('本次 AI 需求');await expect(page.getByRole('region',{name:'AI 创作记录',exact:true})).not.toContainText('不应进入新会话');
});

test('switching preserves the visible screenshot crop and normal draft is separate from built-in case',async({page})=>{
  await seed(page,true);const region=page.getByRole('region',{name:'聊天内容，可滚动调整截取范围'});
  await region.evaluate(el=>{el.scrollTop=440;});await expect.poll(()=>region.evaluate(el=>el.scrollTop)).toBe(440);
  await page.getByRole('button',{name:'新建会话',exact:true}).click();await open(page);await page.getByRole('button',{name:'打开会话：周末计划',exact:true}).click();await expect.poll(()=>region.evaluate(el=>el.scrollTop)).toBe(440);
  await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('已保存到本机');await open(page);await page.screenshot({path:`${process.env.IMSTAGE_ARTIFACT_DIR}/sessions-desktop.png`});await page.getByRole('button',{name:'关闭会话列表'}).click();
  await page.goto('/#/create?case=loan-anniversary');await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('去年借款，今天归还');await page.goto('/#/create');await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('尚未发送的 A 草稿');
});

test('saving after switching back updates the same account work and still rejects remote revision conflicts',async({page})=>{
  await page.goto('/#/create');const response=await page.request.post('/api/auth/register',{headers:{Origin:new URL(page.url()).origin,'X-IMStage-Request':'1'},data:{email:`work-session-${crypto.randomUUID()}@example.test`,name:'合成测试',password:'synthetic-session-password-2026'}});expect(response.ok()).toBeTruthy();await page.reload();
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('保存关联测试');await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('保存关联测试');
  await page.getByRole('button',{name:'保存到我的作品',exact:true}).click();await expect(page.getByText('已保存到我的作品',{exact:false})).toBeVisible();const href=await page.getByRole('link',{name:'打开作品 →'}).getAttribute('href');
  await page.getByRole('button',{name:'新建会话',exact:true}).click();await open(page);await page.getByRole('button',{name:'打开会话：保存关联测试',exact:true}).click();await expect(page.getByRole('link',{name:'打开作品 →'})).toHaveAttribute('href',href!);
  await page.getByRole('button',{name:'编辑会话标题',exact:true}).click();await page.getByLabel('会话标题',{exact:true}).fill('新的作品标题');
  const updated=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/api/scenes/'));await page.getByRole('button',{name:'保存到我的作品',exact:true}).click();const saved=await(await updated).json();expect(saved.item.revision).toBe(2);expect(saved.item.id).toBe(href!.split('scene=')[1]);
  const all=await(await page.request.get('/api/scenes')).json();expect(all.items).toHaveLength(1);
  // A server-side edit in another client must not be silently overwritten by the local session.
  const remote=await page.request.put(`/api/scenes/${saved.item.id}`,{headers:{Origin:new URL(page.url()).origin,'X-IMStage-Request':'1'},data:{scene:{...saved.item.scene,title:'另一个客户端更新'},revision:2}});expect(remote.ok()).toBeTruthy();
  await page.getByLabel('会话标题',{exact:true}).fill('旧版本的本地编辑');await page.getByRole('button',{name:'保存到我的作品',exact:true}).click();await expect(page.locator('.account-save-message')).toContainText('更新');
  const unchanged=await(await page.request.get(`/api/scenes/${saved.item.id}`)).json();expect(unchanged.item.revision).toBe(3);expect(unchanged.item.scene.title).toBe('另一个客户端更新');
});

test('interrupted generation is restored as interrupted, not as an indefinitely running assistant',async({page})=>{
  await page.addInitScript(scene=>{sessionStorage.setItem('imstage.agent.guest.draft',JSON.stringify({scene,generating:true}));sessionStorage.setItem('imstage.agent.guest.draft.chat',JSON.stringify([{role:'user',id:'u',content:'中断案例'},{role:'assistant',id:'a',content:'正在理解你的想法…',tools:[{id:'t',name:'generate_image',state:'running',detail:'正在生成'}]}]));},fixture.scene);
  await page.goto('/#/create');await expect(page.getByRole('region',{name:'AI 创作记录',exact:true})).toContainText('上次生成已中断');await expect(page.getByRole('button',{name:'新建会话',exact:true})).toBeEnabled();await expect(page.locator('.agent-tools [data-state=running]')).toHaveCount(0);
});

test('login handoff creates a separate session even when that account already has an active session',async({page})=>{
  await page.goto('/#/create');const response=await page.request.post('/api/auth/register',{headers:{Origin:new URL(page.url()).origin,'X-IMStage-Request':'1'},data:{email:`handoff-${crypto.randomUUID()}@example.test`,name:'合成测试',password:'synthetic-session-password-2026'}});expect(response.ok()).toBeTruthy();await page.reload();
  await page.getByLabel('描述想生成的聊天',{exact:true}).fill('账号已有会话');await expect(page.getByRole('button',{name:'管理创作会话'})).toContainText('已保存到本机');
  await page.evaluate(({scene,image})=>sessionStorage.setItem('imstage.agent.login-handoff',JSON.stringify({scene,prompt:'访客登录前的输入',attachments:[image],turns:[{role:'user',id:'guest-u',content:'访客创作记录'}]})),{scene:fixture.scene,image});
  await page.reload();await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toHaveValue('访客登录前的输入');await expect(page.locator('.agent-attachments img')).toHaveCount(1);await open(page);await expect(page.getByRole('button',{name:'打开会话：账号已有会话',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'打开会话：访客创作记录',exact:true})).toBeVisible();
});

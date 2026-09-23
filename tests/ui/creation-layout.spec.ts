import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
test.use({ locale: 'zh-CN' });
const fixture=JSON.parse(fs.readFileSync(new URL('../../tools/eval/fixtures/loan-anniversary.json',import.meta.url),'utf8'));
async function ready(page:Page){
 await page.addInitScript(scene=>{if(sessionStorage.getItem('layout-seeded'))return;sessionStorage.setItem('layout-seeded','1');sessionStorage.setItem('imstage.agent.guest.draft',JSON.stringify({scene,prompt:'把这段对话写得更自然，保留原来的约定。'}));sessionStorage.setItem('imstage.agent.guest.draft.chat',JSON.stringify([{id:'u',role:'user',content:'编一段朋友约定一年后归还借款的故事。先展示去年的约定，再展示今天的兑现。'},{id:'a',role:'assistant',content:'已编排好两个时间段：去年的约定与今天的归还。\n你可以继续修改人物、消息和语气，也可以在右侧预览中点选具体内容。'}]));},fixture.scene);
 await page.goto('/#/create');await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toBeVisible();
}
test('creation gets primary space; properties open on selection and do not shrink it',async({page})=>{
 await ready(page);const left=page.locator('.agent-chat');expect((await left.boundingBox())!.width).toBe(480);
 await expect(page.getByRole('complementary',{name:'Vibe Edit'})).toHaveCount(0);await expect(page.getByLabel('当前项目')).toBeHidden();
 expect((await page.getByRole('region',{name:'AI 创作记录',exact:true}).boundingBox())!.height).toBeGreaterThan(360);
 await page.screenshot({path:`${process.env.IMSTAGE_ARTIFACT_DIR}/creation-primary.png`});
 await page.getByRole('button',{name:`选择消息：${fixture.scene.messages[0].text}`,exact:true}).click();await expect(page.getByLabel('消息文字',{exact:true})).toBeVisible();expect((await left.boundingBox())!.width).toBe(480);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
 await page.getByRole('button',{name:'关闭 AI 编辑'}).click();await expect(page.getByRole('complementary',{name:'Vibe Edit'})).toHaveCount(0);
});
test('drag, keyboard, expand and reset all resize the creation area and survive reload',async({page})=>{
 await ready(page);const separator=page.getByRole('separator',{name:'调整创作区宽度'});const box=(await separator.boundingBox())!;
 await page.mouse.move(box.x+box.width/2,box.y+80);await page.mouse.down();await page.mouse.move(box.x+box.width/2+100,box.y+80,{steps:8});await page.mouse.up();expect((await page.locator('.agent-chat').boundingBox())!.width).toBe(580);
 await separator.focus();await page.keyboard.press('ArrowLeft');await expect(separator).toHaveAttribute('aria-valuenow','556');
 await expect.poll(()=>page.evaluate(()=>localStorage.getItem('imstage.creation-width'))).toBe('556');await page.reload();expect((await page.locator('.agent-chat').boundingBox())!.width).toBe(556);
 await page.getByRole('button',{name:'恢复创作区宽度'}).click();await expect(separator).toHaveAttribute('aria-valuenow','480');await page.getByRole('button',{name:'拓宽创作区'}).click();await expect(separator).toHaveAttribute('aria-valuenow','640');
 await separator.dblclick();await expect(separator).toHaveAttribute('aria-valuenow','480');
 await page.getByRole('button',{name:'收起左侧面板'}).click();await expect(separator).toHaveCount(0);await page.getByRole('button',{name:'展开左侧面板'}).click();await expect(separator).toBeVisible();
});
for(const theme of ['light','dark'] as const)test(`short desktop, tablet and mobile keep composer reachable and accessible: ${theme}`,async({page})=>{
 await ready(page);await page.emulateMedia({colorScheme:theme});
 for(const [width,height] of [[1440,720],[1024,768],[390,844]]){
  await page.setViewportSize({width,height});const input=page.getByLabel('描述想生成的聊天',{exact:true});await expect(input).toBeInViewport();
  const dock=(await page.locator('.agent-input-dock').boundingBox())!;expect(dock.y+dock.height).toBeLessThanOrEqual(height+1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
  await page.locator('.creation-context > summary').click();await expect(page.getByLabel('当前项目')).toBeVisible();await page.locator('.creation-context > summary').click();
  const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();expect(audit.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
  await page.screenshot({path:`${process.env.IMSTAGE_ARTIFACT_DIR}/creation-${theme}-${width}.png`});
 }
});

test('generation errors never cover the composer or retry button on desktop and mobile',async({page})=>{
 await page.goto('/#/create');const response=await page.request.post('/api/auth/register',{headers:{Origin:new URL(page.url()).origin,'X-IMStage-Request':'1'},data:{email:`layout-${crypto.randomUUID()}@example.test`,name:'合成创作者',password:'synthetic-layout-password-2026'}});expect(response.ok()).toBeTruthy();await page.reload();
 let requests=0;await page.route('**/api/agent/run',route=>{requests++;return route.fulfill({contentType:'application/x-ndjson',body:JSON.stringify({type:'error',message:'模拟连接失败，修改需求后可继续重试。'})+'\n'});});
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:844});await page.getByLabel('描述想生成的聊天',{exact:true}).fill('保留我的输入，再试一次。');
  const before=requests;await page.getByRole('button',{name:'开始生成',exact:true}).click();await expect(page.getByRole('alert')).toContainText('模拟连接失败');
  const error=(await page.locator('.agent-error').boundingBox())!,body=(await page.locator('.agent-body').boundingBox())!;expect(error.y+error.height).toBeLessThanOrEqual(body.y+1);
  await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toBeInViewport();await page.getByRole('button',{name:'开始生成',exact:true}).click();await expect.poll(()=>requests).toBe(before+2);await expect(page.getByRole('alert')).toContainText('模拟连接失败');
 }
});

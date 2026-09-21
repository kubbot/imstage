import {test,expect} from '@playwright/test';
import {createScene} from '../../apps/web/src/studio/model';

test('project membership recovers, detaches and keeps element editing usable on mobile',async({page})=>{
 await page.goto('/#/register');
 await page.getByLabel('怎么称呼你').fill('项目验收');
 await page.getByLabel('邮箱',{exact:true}).fill(`project-${crypto.randomUUID()}@example.test`);
 await page.getByLabel('密码',{exact:true}).fill('synthetic-project-password-2026');
 await page.getByRole('button',{name:'创建账号',exact:true}).click();
 await expect(page.getByRole('heading',{name:'项目验收的创作空间'})).toBeVisible();
 await page.goto('/#/projects');await page.getByLabel('项目名称',{exact:true}).fill('周末旅行');
 await page.getByLabel('项目规则（可选，最多 4000 字）').fill('使用轻松的中文。');
 await page.getByRole('button',{name:'创建项目',exact:true}).click();
 await expect(page.getByRole('heading',{name:'周末旅行',exact:true})).toBeVisible();
 const projectId=new URLSearchParams(page.url().split('?')[1]).get('project')!;
 const origin=new URL(page.url()).origin;
 const scene={...createScene(),id:crypto.randomUUID()};
 scene.messages=[{id:'m-test',participantId:scene.selfId,type:'text',text:'周末见。',time:'09:41'}];
 const saved=await page.request.put('/api/scenes/'+scene.id,{headers:{Origin:origin,'X-IMStage-Request':'1'},data:{scene,revision:0,projectId}});
 expect(saved.status()).toBe(200);
 await page.goto('/#/workspace?scene='+scene.id);
 await expect(page.getByLabel('当前项目')).toHaveValue(projectId);
 const save=page.getByRole('button',{name:'保存作品',exact:true});await expect(save).toBeDisabled();
 await page.locator('.creation-context > summary').click();await page.getByLabel('当前项目').selectOption('');await expect(save).toBeEnabled();
 await page.reload();await expect(page.getByLabel('当前项目')).toHaveValue('');
 await save.click();await expect(save).toBeDisabled();
 expect((await(await page.request.get('/api/scenes/'+scene.id)).json()).item.projectIds).toEqual([]);
 await page.getByRole('button',{name:'选择消息：周末见。',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'消息文字',exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'消息文字',exact:true}).fill('可以自由编辑');
 await page.getByLabel('选中元素',{exact:true}).selectOption('@scene');
 await page.getByLabel('背景颜色',{exact:true}).fill('#cbded3');
 await page.getByLabel('会话标题',{exact:true}).fill('周末见面');
 await page.getByRole('button',{name:'关闭 AI 编辑'}).click();
 await expect(page.locator('.agent-phone')).toContainText('可以自由编辑');
 await expect(page.locator('.agent-phone')).toContainText('周末见面');
 await page.setViewportSize({width:390,height:900});
 await page.getByRole('button',{name:'渲染画面',exact:true}).click();
 await expect(page.locator('.agent-phone')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('reference preview and authenticated PNG export use the evaluation rendering path',async({page})=>{
 const {default:sharp}=await import('sharp');
 await page.goto('/#/create');const origin=new URL(page.url()).origin;
 const headers={Origin:origin,'X-IMStage-Request':'1'};
 expect((await page.request.post('/api/auth/register',{headers,data:{email:`reference-${crypto.randomUUID()}@example.test`,name:'截图验收',password:'synthetic-reference-password-2026'}})).status()).toBe(200);
 await page.reload();
 const source=await sharp({create:{width:360,height:640,channels:3,background:'#ededed'}}).png().toBuffer();
 const scene={...createScene(),id:crypto.randomUUID(),messages:[],reference:{source:'data:image/png;base64,'+source.toString('base64'),plan:{schemaVersion:1 as const,im:'wechat' as const,surface:'ios' as const,width:360,height:640,edits:[{id:'text',kind:'text' as const,box:[100,100,800,300] as [number,number,number,number],text:'Shared rendering · 同一画面',background:'#ffffff',color:'#111111',fontSize:26,fontWeight:400 as const,align:'left' as const}],warnings:[]},assets:[]}};
 expect((await page.request.put('/api/scenes/'+scene.id,{headers,data:{scene,revision:0}})).status()).toBe(200);
 await page.goto('/#/workspace?scene='+scene.id);
 const frame=page.frameLocator('iframe[title="原截图精确编辑画面"]');
 await expect(frame.locator('[data-edit-id="text"]')).toContainText('同一画面');
 const response=await page.request.post('/api/agent/render',{headers,data:{scene}});expect(response.status()).toBe(200);
 const exported=await response.body();
 // Rasterize the actual preview DOM at its native origin, excluding editor
 // framing and fractional CSS placement that otherwise add a screenshot row.
 const previewPage=await page.context().newPage();await previewPage.setViewportSize({width:360,height:640});
 await previewPage.setContent(await frame.locator('html').evaluate(el=>el.outerHTML));
 await previewPage.evaluate(()=>document.fonts.ready);
 const preview=await previewPage.screenshot();await previewPage.close();
 const expected=await sharp(exported).removeAlpha().raw().toBuffer();
 const actual=await sharp(preview).removeAlpha().raw().toBuffer();
 expect(actual.equals(expected)).toBe(true);
 await page.getByRole('button',{name:'选择编辑层：Shared rendering · 同一画面',exact:true}).click();
 await expect(page.getByRole('complementary',{name:'Vibe Edit'})).toBeVisible();
});

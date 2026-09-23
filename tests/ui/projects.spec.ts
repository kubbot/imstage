import {test,expect} from '@playwright/test';
import {createScene} from '../../apps/web/src/studio/model';
test.use({ locale: 'zh-CN' });

test('project membership recovers, detaches and keeps element editing usable on mobile',async({page})=>{
 await page.goto('/#/register');
 await page.getByLabel('怎么称呼你').fill('项目验收');
 await page.getByLabel('邮箱',{exact:true}).fill(`project-${crypto.randomUUID()}@example.test`);
 await page.getByLabel('密码',{exact:true}).fill('synthetic-project-password-2026');
 await page.getByRole('button',{name:'创建账号',exact:true}).click();
 await expect(page.getByRole('heading',{name:'项目验收的创作空间'})).toBeVisible();
 await page.goto('/#/projects');await page.getByLabel('项目名称',{exact:true}).fill('周末旅行');
 await page.getByLabel('项目规则',{exact:true}).fill('使用轻松的中文。');
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
 await page.locator('.creation-context > summary').click();await page.getByLabel('当前项目').selectOption('');
 // Autosave syncs the detach without a manual save button; wait for the PUT to land.
 await page.waitForResponse(r=>r.url().includes('/api/scenes/'+scene.id)&&r.request().method()==='PUT',{timeout:15000});
 await page.reload();await expect(page.getByLabel('当前项目')).toHaveValue('');
 await expect.poll(async()=>(await(await page.request.get('/api/scenes/'+scene.id)).json()).item.projectIds).toEqual([]);
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

test('structured variants reuse a frozen template and validate per-item values', async ({ page }) => {
  await page.goto('/#/register');
  await page.getByLabel('怎么称呼你').fill('变体验收');
  await page.getByLabel('邮箱', { exact: true }).fill(`variants-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill('synthetic-variants-password-2026');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '变体验收的创作空间' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin, 'X-IMStage-Request': '1' };

  const scene = { ...createScene('weekend'), id: crypto.randomUUID() };
  const templateResponse = await page.request.post('/api/templates', {
    headers,
    data: {
      name: '变体模板',
      description: '',
      scene,
      variables: [{ key: 'field_1', label: '人物姓名', type: 'text', target: { entity: 'participant', id: scene.participants[1].id, field: 'name' } }],
    },
  });
  expect(templateResponse.status()).toBe(200);

  await page.goto('/#/projects');
  await page.getByLabel('项目名称', { exact: true }).fill('变体项目');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '变体项目', exact: true })).toBeVisible();
  const projectId = new URLSearchParams(page.url().split('?')[1]).get('project')!;

  await page.getByRole('button', { name: '结构化变体', exact: true }).click();
  await expect(page.getByLabel('复用模板')).toHaveValue('');
  await page.getByLabel('复用模板').selectOption({ index: 1 });
  // The declared variable becomes an explicit per-variant field.
  await expect(page.getByLabel('人物姓名')).toBeVisible();
  await page.getByLabel('人物姓名').fill('Ava');
  await page.getByLabel('变体名称').fill('Ava 版本');
  await page.getByLabel('这次要生成什么').fill('生成 Ava 的对话');
  await expect(page.getByRole('button', { name: /开始批量生成 1/ })).toBeEnabled();
  // Explicit failure surfaces instead of silently dropping the row.
  await page.getByLabel('变体名称').fill('');
  await page.getByRole('button', { name: /开始批量生成/ }).click();
  await expect(page.locator('.project-batch [role="alert"]')).toContainText('每个变体都需要名称');
  await page.getByLabel('变体名称').fill('Ava 版本');
  await page.getByRole('button', { name: '添加变体', exact: true }).click();
  await expect(page.getByLabel('变体名称')).toHaveCount(2);
  expect(projectId).toBeTruthy();
});

test('custom declarative layout can be created, edited and survives reload', async ({ page }) => {
  await page.goto('/#/register');
  await page.getByLabel('怎么称呼你').fill('布局验收');
  await page.getByLabel('邮箱', { exact: true }).fill(`layout-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill('synthetic-layout-password-2026');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '布局验收的创作空间' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const scene = { ...createScene(), id: crypto.randomUUID(), headerText: '', platform: 'whatsapp' as const };
  const otherName = scene.participants.find(person => person.id !== scene.selfId)!.name;
  const saved = await page.request.put(`/api/scenes/${scene.id}`, {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { scene, revision: 0 },
  });
  expect(saved.status()).toBe(200);

  await page.goto(`/#/workspace?scene=${scene.id}`);
  await expect(page.locator('.scene-view')).toBeVisible();
  await expect(page.locator('.scene-header-name')).toHaveText(otherName);
  await page.getByRole('button', { name: 'Edit device status' }).click();
  await page.locator('.property-advanced > summary', { hasText: '自定义布局' }).click();
  await page.getByRole('button', { name: '创建中性自定义布局', exact: true }).click();
  await expect(page.locator('.scene-view[data-layout="custom"]')).toBeVisible();
  await expect(page.locator('.scene-header-name')).toHaveText(otherName);
  await page.getByLabel('布局名称').fill('中性格');
  await page.getByLabel('页头背景').fill('#101418');
  await page.getByLabel('页面背景').fill('#eef2f7');
  await page.getByLabel('我的气泡', { exact: true }).fill('#dde8dc');
  await expect(page.locator('.scene-view .scene-row.is-self .scene-bubble').first()).toHaveCSS('background-color', 'rgb(221, 232, 220)');
  await expect(page.locator('.scene-view .scene-row.is-self .scene-bubble-wrap').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('.scene-view[data-layout="custom"]')).toBeVisible();
  // The layout background must actually win over the platform default, not just
  // set an attribute: assert the computed chat background.
  await expect(page.locator('.scene-view[data-layout="custom"] .scene-messages')).toHaveCSS('background-color', 'rgb(238, 242, 247)');
  await expect(page.locator('.scene-view[data-layout="custom"] .scene-header')).toHaveCSS('background-color', 'rgb(16, 20, 24)');
  for (const platform of ['wechat', 'instagram', 'imessage', 'slack', 'xiaohongshu', 'whatsapp']) {
    await page.getByLabel('目标聊天平台', { exact: true }).selectOption(platform);
    await expect(page.locator('.scene-header-custom')).toHaveCSS('background-color', 'rgb(16, 20, 24)');
    await expect(page.locator('.scene-row.is-self .scene-bubble').first()).toHaveCSS('background-color', 'rgb(221, 232, 220)');
    await expect(page.locator('.scene-row.is-self .scene-bubble-wrap').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }

  await expect(page.locator('.scene-view[data-layout="custom"] .scene-message-meta').first()).toHaveCSS('font-size', '10px');
  await page.reload();
  await expect(page.locator('.scene-view[data-layout="custom"] .scene-messages')).toHaveCSS('background-color', 'rgb(238, 242, 247)');
  await page.getByRole('button', { name: 'Edit device status' }).click();
  await page.locator('.property-advanced > summary', { hasText: '自定义布局' }).click();
  await expect(page.getByLabel('布局名称')).toHaveValue('中性格');
  // Reset returns to the platform skin.
  await page.getByRole('button', { name: '恢复平台皮肤', exact: true }).click();
  await expect(page.locator('.scene-view[data-layout="custom"]')).toHaveCount(0);
});

test('screenshot templates pin the source platform and reject a switch with clear feedback', async ({ page }) => {
  const { default: sharp } = await import('sharp');
  await page.goto('/#/register');
  await page.getByLabel('怎么称呼你').fill('截图平台验收');
  await page.getByLabel('邮箱', { exact: true }).fill(`refplatform-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill('synthetic-reference-password-2026');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '截图平台验收的创作空间' })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin, 'X-IMStage-Request': '1' };

  const projectResponse = await page.request.post('/api/projects', { headers, data: { name: '截图项目', platform: 'wechat' } });
  expect(projectResponse.status()).toBe(200);
  const project = (await projectResponse.json()).item;

  const png = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#ededed' } }).png().toBuffer();
  const image = `data:image/png;base64,${png.toString('base64')}`;
  const referenceScene = {
    ...createScene('weekend'),
    id: crypto.randomUUID(),
    platform: 'wechat',
    reference: {
      source: image, assets: [],
      plan: { schemaVersion: 1, im: 'wechat', surface: 'ios', width: 600, height: 900, warnings: [], edits: [{ id: 'words', kind: 'text', text: '原图文字', box: [100, 400, 600, 100], fontSize: 16, background: '#ffffff', color: '#000000' }] },
    },
  };
  const templateResponse = await page.request.post('/api/templates', { headers, data: { name: '截图模板', description: '', scene: referenceScene, variables: [] } });
  expect(templateResponse.status()).toBe(200);

  await page.goto(`/#/projects?project=${project.id}`);
  await page.getByLabel('复用模板').selectOption({ index: 1 });
  await expect(page.getByText(/保留原截图的模板/)).toBeVisible();
  // The source platform is pinned; switching away is rejected, not converted.
  await expect(page.getByRole('checkbox', { name: '微信' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Slack' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Slack' }).check();
  await page.getByLabel('提示词', { exact: true }).fill('生成一段对话');
  await page.getByRole('button', { name: /开始批量生成/ }).click();
  await expect(page.locator('.project-batch [role="alert"]')).toContainText('源平台');
});

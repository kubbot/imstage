import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';

test.use({locale:'zh-CN'});
const out=process.env.IMSTAGE_ARTIFACT_DIR||'.local/get-283';

for(const width of [1440,768,390]){
 test(`connection to local creation has a clear next action at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});const errors:string[]=[],runs:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/connections/config',route=>route.fulfill({json:{mcpUrl:'https://imstage.example.test/api/mcp',authorizationSupported:true,manualSetupRequired:true}}));
  await page.route('**/api/agent/run',route=>{runs.push(route.request().url());return route.abort();});
  await page.goto('/?lang=zh#/connect');
  await expect(page.getByLabel('连接地址',{exact:true})).toBeVisible();
  await page.getByRole('radio',{name:/Codex/}).check();
  await expect(page.getByRole('heading',{name:'在终端添加 IMStage 连接'})).toBeVisible();
  await page.reload();await expect(page.getByRole('radio',{name:/Codex/})).toBeChecked();
  await page.getByRole('link',{name:'先在网页试做'}).click();await expect(page).toHaveURL(/#\/create/);
  await page.getByRole('button',{name:'元素 0',exact:true}).click();
  if(width===390)await page.getByRole('button',{name:'渲染画面',exact:true}).click();
  const start=page.getByRole('button',{name:'写下第一个场景',exact:true});
  await expect(start).toBeVisible();
  await expect(page.getByRole('button',{name:'导出 PNG',exact:true})).toBeDisabled();
  await start.click();
  await expect(page.getByLabel('描述想生成的聊天',{exact:true})).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();
  expect(errors).toEqual([]);expect(runs).toEqual([]);
 });
}

for(const width of [1440,390]){
 test(`optional preferences keep skip reachable before avatar setup at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.route('**/api/preferences/portrait',route=>route.fulfill({status:503,json:{error:'Synthetic provider unavailable'}}));
  await page.goto('/?lang=zh#/register');await page.getByLabel('怎么称呼你').fill('Studio 合成验收');
  await page.getByLabel('邮箱',{exact:true}).fill(`get283-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码',{exact:true}).fill('synthetic-get283-password');
  await page.getByTestId('terms-consent').check();await page.getByRole('button',{name:'创建账号',exact:true}).click();
  const skip=page.getByTestId('prefs-skip');await expect(skip).toBeInViewport({ratio:1});
  await expect(page.locator('.prefs-preview .scene-view')).toBeAttached();
  await expect(page.locator('.prefs-preview .imstage-disclosure')).toContainText('AI生成 / 虚构');
  expect((await new AxeBuilder({page}).include('.prefs-page').analyze()).violations).toEqual([]);
  await fs.mkdir(out,{recursive:true});await page.screenshot({path:`${out}/after-preferences-${width}.png`,fullPage:true});
  await skip.click();await expect(page).toHaveURL(/#\/workspace/);await page.reload();
  await expect(page).not.toHaveURL(/welcome/);
 });
}

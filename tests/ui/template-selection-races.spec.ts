import {test, expect, type Page} from '@playwright/test';
import {createScene} from '../../apps/web/src/studio/model';
test.use({locale:'en-US'});

async function setup(page:Page){
  await page.goto('/?lang=en#/register');
  const origin=new URL(page.url()).origin;
  const headers={Origin:origin,'X-IMStage-Request':'1'};
  const response=await page.request.post('/api/auth/register',{headers,data:{name:'Template selection',email:`selection-${crypto.randomUUID()}@example.test`,password:'synthetic-selection-password-2026'}});
  expect(response.ok()).toBe(true);
  const scenes=[{...createScene(),id:crypto.randomUUID(),title:'Source A'},{...createScene(),id:crypto.randomUUID(),title:'Source B'}];
  for(const scene of scenes)expect((await page.request.put('/api/scenes/'+scene.id,{headers,data:{scene,revision:0}})).ok()).toBe(true);
  await page.reload();
  return {headers,scenes};
}

test('changing the template source cannot save the previous scene while the new source is loading',async({page})=>{
  const {scenes}=await setup(page);
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/scenes/'+scenes[1].id,async route=>{await held;await route.continue();});
  await page.goto('/?lang=en#/templates');
  await page.getByLabel('Source scene').selectOption(scenes[0].id);
  await expect(page.locator('.templates-columns').getByLabel('Template name')).toHaveValue('Source A');
  await page.getByLabel('Source scene').selectOption(scenes[1].id);
  await expect(page.getByRole('button',{name:'Create from a scene',exact:true})).toHaveCount(0);
  release();
  await expect(page.locator('.templates-columns').getByLabel('Template name')).toBeVisible();
  await page.locator('.templates-columns').getByLabel('Template name').fill('Selected B');
  const created=page.waitForRequest(r=>r.url().endsWith('/api/templates')&&r.method()==='POST');
  await page.getByRole('button',{name:'Create from a scene',exact:true}).click();
  expect((await created).postDataJSON().scene.id).toBe(scenes[1].id);
});

test('changing a batch template clears old values and waits for the selected revision',async({page})=>{
  const {headers,scenes}=await setup(page);
  const templates=[];
  for(let index=0;index<2;index++){
    const scene=scenes[index];
    const response=await page.request.post('/api/templates',{headers,data:{name:`Template ${index}`,description:'',scene,variables:[{key:'person',label:`Person ${index}`,type:'text',target:{entity:'participant',id:scene.participants[1].id,field:'name'}}]}});
    expect(response.ok()).toBe(true);templates.push((await response.json()).item);
  }
  const response=await page.request.post('/api/projects',{headers,data:{name:'Selection batch',rules:'',platform:'wechat'}});
  expect(response.ok()).toBe(true);const project=(await response.json()).item;
  await page.goto('/?lang=en#/projects?project='+project.id);
  await page.getByRole('button',{name:'Structured variants',exact:true}).click();
  await page.getByLabel('Reusable template').selectOption(templates[0].id);
  await page.getByLabel('Person 0',{exact:true}).fill('Old name');
  let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/templates/'+templates[1].id,async route=>{await held;await route.continue();});
  await page.getByLabel('Reusable template').selectOption(templates[1].id);
  await expect(page.getByRole('button',{name:/Start batch 1/})).toBeDisabled();
  await expect(page.getByLabel('Person 0',{exact:true})).toHaveCount(0);
  release();
  await expect(page.getByLabel('Person 1',{exact:true})).toHaveValue('');
  await page.getByLabel('Variant name',{exact:true}).fill('New variant');
  await page.getByLabel('What to generate this time',{exact:true}).fill('Keep this fictional scene');
  await page.route('**/api/projects/*/batch-jobs',route=>route.request().method()==='POST'?route.fulfill({status:503,json:{error:{code:'unavailable',message:'Synthetic rejection'}}}):route.continue());
  const submitted=page.waitForRequest(r=>r.url().endsWith('/batch-jobs')&&r.method()==='POST');
  await page.getByRole('button',{name:/Start batch 1/}).click();
  const body=(await submitted).postDataJSON();
  expect(body.templateId).toBe(templates[1].id);expect(body.templateRevision).toBe(templates[1].revision);expect(body.variants[0].values).toEqual({});
});

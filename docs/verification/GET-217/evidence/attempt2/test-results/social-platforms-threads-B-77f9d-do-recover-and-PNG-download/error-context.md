# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: social-platforms.spec.ts >> threads B: real editor select edit undo recover and PNG download
- Location: tests/ui/social-platforms.spec.ts:30:35

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('.agent-phone')
Timeout: 5000ms
- Expected substring  - 3
+ Received string     + 1

- 中文换行与多语言边界。
- Hello world — 日本語、한국어、العربية。
- LongUnbrokenTokenLongUnbrokenTokenLongUnbrokenTokenLongUnbrokenTokenLongUnbrokenTokenLongUnbrokenTokenLongUnbrokenTokenLongUnbrokenTokenLongUnbrokenTokenLongUnbrokenTokenLongUnbrokenTokenLongUnbrokenToken
+ 09:41AI生成 / 虚构 · AI-generated / Fictional对方周六 09:38还没有消息

Call log:
  - Expect "toContainText" locator('.agent-phone') with timeout 5000ms
  - waiting for locator('.agent-phone')
    10 × locator resolved to <div data-surface="ios" data-mode="standard" class="agent-phone device-frame">…</div>
       - unexpected value "09:41AI生成 / 虚构 · AI-generated / Fictional对方周六 09:38还没有消息"

```

```yaml
- button "编辑设备状态": 09:41
- button "编辑水印": AI生成 / 虚构 · AI-generated / Fictional
- button "编辑会话标题": 对方
- region "聊天内容，可滚动调整截取范围":
  - button "编辑日期文字": 周六 09:38
  - text: 还没有消息
- button "编辑输入栏"
```

# Test source

```ts
  1  | import {test,expect} from '@playwright/test';
  2  | import fs from 'node:fs/promises';
  3  | import path from 'node:path';
  4  | import sharp from 'sharp';
  5  | import {createScene,type Scene,type Platform} from '../../apps/web/src/studio/model';
  6  | import {renderStudioHtml} from '../../services/mcp/studio-html.mjs';
  7  | import {renderSceneHtml} from '../../packages/renderer/renderSceneHtml.mjs';
  8  | import {assertDisclosureInPng} from './pngEvidence';
  9  | test.use({locale:'zh-CN'});
  10 | const out=process.env.IMSTAGE_ARTIFACT_DIR||'.local/get217';
  11 | const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  12 | function fixture(platform:Platform,kind:string):Scene{
  13 |  const s=createScene();return {...s,id:`synthetic-${platform}-${kind}`,platform,title:'合成评测 · 展览计划',headerText:'小满 · Synthetic',date:'2026年10月22日',surface:'ios',deviceProfileId:undefined,watermarkEnabled:true,participants:[{id:'me',name:'阿远'},{id:'friend',name:'小满'}],selfId:'me',messages:kind==='A'?[
  14 |  {id:'one',participantId:'friend',type:'text',text:'周六去看展吗？这是合成对话。',time:'10:06'},
  15 |  {id:'two',participantId:'me',type:'text',text:'好呀！See you at 14:00. ☀️',time:'10:07',quote:'周六去看展吗？'},
  16 |  {id:'three',participantId:'friend',type:'text',text:'门口见，记得带相机。',time:'10:08'}
  17 |  ]:kind==='B'?[
  18 |  {id:'one',participantId:'friend',type:'text',text:'中文换行与多语言边界。\nHello world — 日本語、한국어、العربية。\n'+ 'LongUnbrokenToken'.repeat(12),time:'10:06'},
  19 |  {id:'two',participantId:'me',type:'image',text:'合成媒体样本',asset:image,time:'10:07'},
  20 |  {id:'three',participantId:'friend',type:'album',text:'合成相册',items:[{id:'a',kind:'image',asset:image,caption:'样本 A'},{id:'b',kind:'image',asset:image,caption:'样本 B'}],time:'10:08'}
  21 |  ]:[
  22 |  {id:'one',participantId:'friend',type:'text',text:'这是一段长图合成验收。'+ '保留中文标点与段落，确保内容完整。'.repeat(16),time:'10:06'},
  23 |  {id:'state',participantId:'',type:'system',text:'合成状态：对话已开始',time:''},
  24 |  {id:'two',participantId:'me',type:'voice',text:'12秒',voiceTranscript:'合成文字稿：We will meet at the gallery.\n这不是实际音频转录。',time:'10:07'},
  25 |  {id:'three',participantId:'friend',type:'link',text:'展览指南 · Synthetic guide',subtitle:'合成链接卡片，无外部跳转',asset:image,time:'10:08'},
  26 |  {id:'end',participantId:'me',type:'text',text:'END · 全部内容已保留。',time:'10:09'}
  27 |  ]};
  28 | }
  29 | for(const platform of ['x','jike','threads','xiaohongshu'] as Platform[]){
  30 |  for(const kind of ['A','B','C']) test(`${platform} ${kind}: real editor select edit undo recover and PNG download`,async({page})=>{
  31 |   test.setTimeout(60000);await fs.mkdir(out,{recursive:true});const events:string[]=[];page.on('pageerror',e=>events.push(e.message));
  32 |   const scene=fixture('wechat',kind);await page.goto('/#/create');
  33 |   await page.evaluate(s=>sessionStorage.setItem('imstage.agent.guest.draft',JSON.stringify({scene:s})),scene);
> 34 |   await page.reload();await expect(page.locator('.agent-phone')).toContainText(scene.messages[0].text);
     |                                                                  ^ Error: expect(locator).toContainText(expected) failed
  35 |   const selector=page.getByLabel('目标聊天平台',{exact:true});await selector.selectOption(platform);
  36 |   const view=page.locator('.agent-phone .scene-view');await expect(view).toHaveAttribute('data-platform',platform);
  37 |   await page.locator('.agent-phone [data-message-id="one"] .scene-message-select').click();
  38 |   const text=page.getByLabel('消息文字',{exact:true});await text.fill('编辑已生效 · Edited synthetic message');await text.blur();
  39 |   await expect(view).toContainText('编辑已生效');await page.getByRole('button',{name:'撤销上次修改',exact:true}).click();
  40 |   await expect(view).toContainText(scene.messages[0].text);await page.getByRole('button',{name:'关闭 AI 编辑',exact:true}).click();
  41 |   await expect(selector).toHaveValue(platform);await page.reload();await expect(selector).toHaveValue(platform);
  42 |   const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出 PNG',exact:true}).click();
  43 |   const exported=path.join(out,`${platform}-${kind}-editor-export.png`);await(await download).saveAs(exported);await assertDisclosureInPng(exported);
  44 |   const meta=await sharp(exported).metadata();expect(meta.width).toBeGreaterThanOrEqual(640);expect(events).toEqual([]);
  45 |   await page.screenshot({path:path.join(out,`${platform}-${kind}-editor-desktop.png`)});
  46 |   await page.setViewportSize({width:390,height:900});await page.getByRole('button',{name:/渲染画面/}).click();
  47 |   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBeTruthy();await page.screenshot({path:path.join(out,`${platform}-${kind}-editor-mobile.png`)});
  48 |   await fs.writeFile(path.join(out,`${platform}-${kind}-editor-operations.json`),JSON.stringify({platform,seed:scene,actions:['seed synthetic local draft','select template','select message','edit text','assert edited output','undo','assert original','close edit','reload','assert platform restored','download PNG','verify PNG disclosure pixels','mobile viewport'],png:{width:meta.width,height:meta.height},errors:events},null,2));
  49 |  });
  50 |  for(const kind of ['A','B','C'])test(`${platform}: actual ${kind} shared and HTML renders`,async({page})=>{
  51 |   await fs.mkdir(out,{recursive:true});const scene=fixture(platform,kind),width=kind==='B'?320:390;
  52 |   await fs.writeFile(path.join(out,`${platform}-${kind}-input.json`),JSON.stringify(scene,null,2));
  53 |   for(const renderer of ['shared','html']){
  54 |    const html=renderer==='shared'?await renderStudioHtml(scene,{width,height:844,outputKind:'long-screenshot'}):renderSceneHtml(scene,{width,surface:'ios',outputKind:'long-screenshot'});
  55 |    await page.setViewportSize({width,height:900});await page.setContent(html);await page.evaluate(()=>document.fonts.ready);
  56 |    if(renderer==='shared' && ['x','threads'].includes(platform)){
  57 |     const header=await page.locator('.scene-header').evaluate(e=>{const title=e.querySelector('.scene-header-title')!.getBoundingClientRect(),menu=e.querySelector('.scene-header-more')!.getBoundingClientRect();return {width:title.width,sameRow:Math.abs(title.top-menu.top)<24};});expect(header.width).toBeGreaterThan(100);expect(header.sameRow).toBeTruthy();
  58 |    }
  59 |    if(kind==='A')await expect(rootOrDevice(page).locator(renderer==='shared'?'.scene-quote':'.quote')).toContainText(scene.messages[0].text);
  60 |    const root=page.locator('.device');await expect(root).toContainText(kind==='C'?'END · 全部内容已保留。':kind==='B'?'LongUnbrokenToken':'门口见');
  61 |    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);expect(overflow).toBeFalsy();
  62 |    if(renderer==='shared'){expect(await page.locator('.scene-messages').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBeTruthy();await expect(page.locator('.scene-view')).toHaveAttribute('data-platform',platform);}
  63 |    await root.screenshot({path:path.join(out,`${platform}-${kind}-${renderer}.png`)});
  64 |   }
  65 |  });
  66 | }
  67 | 
  68 | function rootOrDevice(page:import('@playwright/test').Page){return page.locator('.device');}
  69 | 
```
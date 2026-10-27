import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import * as model from '../apps/web/src/studio/model.ts';
import {previewScene} from '../apps/web/src/create/assets.ts';
import {streamDemo} from '../apps/web/src/create/stream.ts';
import {buildSystemPrompt} from '../services/agent/prompt.mjs';

const instants=[
  ['2026-10-25T15:59:00.000Z','23:59'],
  ['2026-10-25T16:00:00.000Z','00:00'],
  ['2026-03-08T09:12:00.000Z','17:12'],
  ['2026-11-01T09:12:00.000Z','17:12'],
];

for(const timezone of ['UTC','Asia/Shanghai','America/Los_Angeles']){
  test(`new device clock is Beijing time under host ${timezone}`,()=>{
    const moduleUrl=new URL('../apps/web/src/studio/model.ts',import.meta.url).href;
    const script=`import {currentDeviceTime} from ${JSON.stringify(moduleUrl)};const moments=${JSON.stringify(instants.map(([iso])=>iso))};process.stdout.write(JSON.stringify(moments.map(iso=>currentDeviceTime(new Date(iso)))));`;
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TZ:timezone},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),instants.map(([,expected])=>expected));
  });
}

test('new scenes capture the clock once; later creations and template copies stay independent',t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-25T15:59:00.000Z')});
  const first=model.createScene('weekend');
  assert.equal(first.deviceTime,'23:59');
  t.mock.timers.tick(120000);
  const second=model.createScene('weekend');
  assert.equal(second.deviceTime,'00:01');
  assert.equal(first.deviceTime,'23:59');
  first.participants[0].name='Synthetic local edit';
  assert.notEqual(second.participants[0].name,first.participants[0].name);
});

test('preview uses creation clock without rewriting its fictional story date',t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-25T15:59:00.000Z')});
  const preview=previewScene('wechat');
  assert.equal(preview.deviceTime,'23:59');
  assert.equal(preview.date,'明天 15:00');
  assert.equal(preview.id,'scene-mars-preview');
});

test('local demo uses its explicit creation instant and remains a cancellable local stream',async()=>{
  const abort=new AbortController();
  const events=[];
  for await(const event of streamDemo({prompt:'明天和 Elon Musk 去火星',platform:'wechat',now:new Date('2026-10-25T15:59:00.000Z'),delayMs:0},abort.signal)){
    events.push(event);
    if(event.type==='scene'){
      assert.equal(event.scene.deviceTime,'23:59');
      abort.abort();
      break;
    }
  }
  assert.ok(events.some(event=>event.type==='scene'));
});

test('existing user device time survives imports, drafts, ordinary edits and undo/redo',t=>{
  t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-25T15:59:00.000Z')});
  const existing=model.updateScene(model.createScene(),{deviceTime:'04:22'});
  assert.equal(model.parseSceneJson(model.serializeScene(existing)).scene.deviceTime,'04:22');
  assert.equal(model.parseDraft(model.serializeDraft(existing)).draft.scene.deviceTime,'04:22');
  let history=model.createHistory(existing);
  history=model.commit(history,model.updateScene(existing,{title:'Unrelated title edit'}));
  assert.equal(history.present.deviceTime,'04:22');
  history=model.undo(history);assert.equal(history.present.deviceTime,'04:22');
  history=model.redo(history);assert.equal(history.present.deviceTime,'04:22');
});

test('agent device time guidance preserves explicit user control and current safety rules',()=>{
  const prompt=buildSystemPrompt({referenceDate:'2026-10-25'});
  assert.match(prompt,/默认沿用当前场景的 deviceTime/);
  assert.match(prompt,/只有用户明确要求调整系统\/设备时间时才修改/);
  assert.match(prompt,/select_template/);
  assert.match(prompt,/watermarkEnabled/);
  assert.match(prompt,/真实截图参考编辑已停用/);
  assert.match(prompt,/voiceTranscript/);
});

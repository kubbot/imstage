/**
 * Unit tests for the IMStage bounded DeepSeek tool-calling agent.
 *
 * Everything here runs against an injected fake provider: no network, no paid
 * call, no credentials. The tests prove the real multi-round sequence,
 * invalid-tool feedback/recovery, selected-only invariants, truthful failure
 * semantics, bounds and cancellation.
 */

import test from 'node:test';
import sharp from 'sharp';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createScene, validateScene } from '../apps/web/src/studio/model.ts';
import {
  AGENT_TOOL_SCHEMAS,
  TOOL_NAMES,
  ProviderError,
  createAgentLimiter,
  createAgentRuntime,
  createChatProvider,
  createImageProvider,
  resolveAgentConfig,
  runAgent,
  serializeAgentEvent,
  validateAgentInput,
  writeNdjsonLine,
  finishNdjsonResponse,
  buildSceneContext,
  checkSceneLimits,
} from '../services/agent/index.mjs';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const ASSET = 'data:image/png;base64,' + (await sharp({ create: { width: 2, height: 2, channels: 3, background: '#567abc' } }).png().toBuffer()).toString('base64');
const AVATAR = 'data:image/jpeg;base64,BBBB';
const ATTACHMENT = 'data:image/webp;base64,CCCC';

function testConfig(overrides = {}) {
  return {
    deadlineMs: 2_000,
    maxRounds: 8,
    maxCalls: 24,
    maxAttachmentChars: 6 * 1024 * 1024,
    maxSceneContextChars: 48 * 1024,
    ...overrides,
  };
}

function toolResponse(name, args, { content = '', id = 'call' } = {}) {
  return {
    content,
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
    finishReason: 'tool_calls',
  };
}

function finalResponse(text) {
  return { content: text, toolCalls: [], finishReason: 'stop' };
}

function scriptedProvider(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async complete({ messages, tools, signal }) {
      calls.push({
        messages: JSON.parse(JSON.stringify(messages)),
        toolNames: tools.map((tool) => tool.function.name),
        aborted: Boolean(signal?.aborted),
      });
      if (signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step({ messages, tools, signal }) : step;
    },
  };
}

function pendingProvider() {
  return {
    calls: 0,
    async complete({ signal }) {
      this.calls += 1;
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

function eventCollector() {
  const events = [];
  return {
    events,
    onEvent(event) {
      events.push(event);
    },
    types() {
      return events.map((event) => event.type);
    },
    toolEvents() {
      return events.filter((event) => event.type === 'tool');
    },
  };
}

function baseScene() {
  return createScene('weekend');
}

/** Weekend scene plus a valid image message, for image-tool tests. */
function sceneWithImage() {
  const scene = baseScene();
  scene.messages = [
    ...scene.messages,
    { id: 'm-img', participantId: 'p-ayuan', type: 'image', text: '一张照片', time: '09:41' },
  ];
  assert.equal(validateScene(scene).ok, true);
  return scene;
}

function updateMessageArgs(scene, id, text) {
  const message = scene.messages.find((item) => item.id === id);
  return {
    id,
    participantId: message.participantId,
    type: message.type,
    text,
    time: message.time,
  };
}

/* ------------------------------------------------------------------ */
/* Multi-round tool calling                                            */
/* ------------------------------------------------------------------ */

test('runAgent performs a genuine multi-round tool sequence and feeds results back', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse('create_scene', { scene: { ...base, title: '新的标题' } }, { id: 'c1' }),
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', '改后的台词') }, { id: 'c2' }),
    finalResponse('已完成修改。'),
  ]);
  const collector = eventCollector();

  const result = await runAgent({
    prompt: '把标题改一下，并改最后一句',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, true);
  assert.equal(result.mutations, 2);
  assert.equal(provider.calls.length, 3);
  assert.deepEqual(provider.calls[0].toolNames, TOOL_NAMES);
  assert.deepEqual(collector.types(), [
    'scene',
    'tool',
    'tool',
    'scene',
    'tool',
    'tool',
    'scene',
    'assistant',
    'done',
  ]);
  assert.equal(collector.events.at(-1).type, 'done');
  assert.equal(result.scene.title, '新的标题');
  assert.equal(result.scene.messages.find((message) => message.id === 'm-4').text, '改后的台词');

  // Round 2 must carry the assistant tool_calls and the matching role:tool result.
  const secondCallMessages = provider.calls[1].messages;
  assert.ok(
    secondCallMessages.some(
      (message) => message.role === 'assistant' && Array.isArray(message.tool_calls),
    ),
    'assistant tool_calls must be appended before the next round',
  );
  const toolResult = secondCallMessages.find(
    (message) => message.role === 'tool' && message.tool_call_id === 'c1',
  );
  assert.ok(toolResult, 'role:tool result must be fed back');
  assert.equal(JSON.parse(toolResult.content).ok, true);

  // The initial turn carries the tool schemas and no base64 asset from the scene.
  assert.equal(provider.calls[0].toolNames.length, 5);
});

test('runAgent recovers from invalid tool arguments via truthful error feedback', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse(
      'upsert_message',
      { message: { id: 'm-4', participantId: 'p-ghost', type: 'text', text: 'x', time: '09:41' } },
      { id: 'bad' },
    ),
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', '恢复后的台词') }, { id: 'good' }),
    finalResponse('已修正。'),
  ]);
  const collector = eventCollector();

  const result = await runAgent({
    prompt: '改最后一句',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, true);
  const errors = collector.toolEvents().filter((event) => event.state === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].detail, /场景校验失败|发送者/);

  const feedback = provider.calls[1].messages.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(feedback.content).ok, false);
  assert.equal(result.scene.messages.find((message) => message.id === 'm-4').text, '恢复后的台词');
});

test('runAgent reports malformed tool argument JSON back to the model', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    { content: '', toolCalls: [{ id: 'x1', name: 'upsert_message', arguments: '{not json' }] },
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', 'ok') }, { id: 'x2' }),
    finalResponse('完成'),
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, true);
  const firstError = collector.toolEvents().find((event) => event.state === 'error');
  assert.match(firstError.detail, /JSON/);
});

test('runAgent accepts object-shaped tool arguments (already parsed)', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    {
      content: '',
      toolCalls: [
        {
          id: 'obj1',
          name: 'upsert_message',
          arguments: { message: updateMessageArgs(base, 'm-4', '对象参数') },
        },
      ],
    },
    finalResponse('完成'),
  ]);
  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.scene.messages.find((message) => message.id === 'm-4').text, '对象参数');
});

/* ------------------------------------------------------------------ */
/* No-op failure semantics                                             */
/* ------------------------------------------------------------------ */

test('a narrated-only run is an error, never a success', async () => {
  const base = baseScene();
  const provider = scriptedProvider([finalResponse('我建议你把标题改成“周末看海”。')]);
  const collector = eventCollector();

  const result = await runAgent({
    prompt: '改标题',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_mutation');
  assert.equal(collector.types().includes('done'), false);
  assert.equal(collector.types().includes('assistant'), false, 'unverified completion prose must not be emitted');
  assert.deepEqual(collector.types(), ['scene', 'error']);
});

test('a tool call that changes nothing is a failed tool result', async () => {
  const base = baseScene();
  const existing = base.messages.find((message) => message.id === 'm-4');
  const provider = scriptedProvider([
    toolResponse(
      'upsert_message',
      { message: { id: 'm-4', participantId: existing.participantId, type: existing.type, text: existing.text, time: existing.time } },
      { id: 'noop' },
    ),
    finalResponse('看起来不需要改。'),
  ]);
  const collector = eventCollector();

  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_mutation');
  const error = collector.toolEvents().find((event) => event.state === 'error');
  assert.match(error.detail, /没有实际修改/);
});

test('deleting a missing message is a failed tool result', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse('delete_message', { id: 'm-missing' }, { id: 'd1' }),
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', '改了') }, { id: 'd2' }),
    finalResponse('完成'),
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, true);
  const error = collector.toolEvents().find((event) => event.state === 'error');
  assert.match(error.detail, /找不到消息/);
});

test('upsert_message inserts a brand-new message as well as updating one', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse(
      'upsert_message',
      {
        message: {
          id: 'm-new',
          participantId: 'p-linxiaoman',
          type: 'text',
          text: '新加的一句',
          time: '09:42',
        },
      },
      { id: 'add' },
    ),
    finalResponse('已新增。'),
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '再加一句',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, true);
  assert.equal(result.scene.messages.length, base.messages.length + 1);
  assert.equal(result.scene.messages.at(-1).id, 'm-new');
  assert.equal(result.scene.messages.at(-1).text, '新加的一句');
  assert.equal(collector.toolEvents().find((event) => event.state === 'done').detail.includes('新增'), true);
});

test('a new message without a valid sender fails validation and is fed back', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse(
      'upsert_message',
      { message: { id: 'm-bad', participantId: 'p-ghost', type: 'text', text: 'x', time: '' } },
      { id: 'bad-new' },
    ),
    finalResponse('结束'),
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '加一句',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_mutation');
  assert.equal(collector.toolEvents().find((event) => event.state === 'error').detail.includes('发送者'), true);
});

/* ------------------------------------------------------------------ */
/* Targeted (selected-only) invariants                                 */
/* ------------------------------------------------------------------ */

test('targeted runs only allow the selected message to change', async () => {
  const base = baseScene();
  const targetId = 'm-2';
  const otherBefore = base.messages.find((message) => message.id === 'm-1');
  const targetBefore = base.messages.find((message) => message.id === targetId);

  const provider = scriptedProvider([
    toolResponse('create_scene', { scene: { ...base, title: '不允许' } }, { id: 't1' }),
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-1', '不允许改') }, { id: 't2' }),
    toolResponse('delete_message', { id: targetId }, { id: 't3' }),
    toolResponse('generate_image', { targetId: 'p-ayuan', kind: 'avatar', prompt: '头像' }, { id: 't4' }),
    toolResponse('upsert_message', { message: updateMessageArgs(base, targetId, '只改这一条') }, { id: 't5' }),
    finalResponse('已按要求修改。'),
  ]);
  const collector = eventCollector();
  const imageProvider = {
    async generate() {
      return { dataUrl: ASSET, mime: 'image/png', bytes: 4 };
    },
  };

  const result = await runAgent({
    prompt: '只改第二句',
    scene: base,
    targetId,
    provider,
    imageProvider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, true);
  assert.equal(result.scene.id, base.id);
  assert.equal(result.scene.title, base.title);
  assert.deepEqual(result.scene.participants, base.participants);
  assert.equal(result.scene.messages.find((message) => message.id === 'm-1').text, otherBefore.text);
  assert.equal(
    result.scene.messages.find((message) => message.id === targetId).text,
    '只改这一条',
  );
  assert.equal(result.scene.messages.length, base.messages.length);
  assert.equal(
    result.scene.messages.find((message) => message.id === targetId).participantId,
    targetBefore.participantId,
  );

  const errors = collector.toolEvents().filter((event) => event.state === 'error');
  assert.equal(errors.length, 4);
  assert.ok(errors.every((event) => /定向编辑/.test(event.detail)));
});

test('targeted run rejects a mismatched message id and never touches others', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-1', '偷改别的') }, { id: 'm1' }),
    finalResponse('结束'),
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '改 m-2',
    scene: base,
    targetId: 'm-2',
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, false);
  const error = collector.toolEvents().find((event) => event.state === 'error');
  assert.match(error.detail, /只能修改所选消息/);
  assert.deepEqual(result.scene, base);
});

/* ------------------------------------------------------------------ */
/* Scene id + asset preservation                                       */
/* ------------------------------------------------------------------ */

test('create_scene preserves scene.id and existing assets without echoing base64 to the model', async () => {
  const sceneWithAssets = baseScene();
  sceneWithAssets.messages[0] = { ...sceneWithAssets.messages[0], asset: ASSET };
  sceneWithAssets.participants[1] = { ...sceneWithAssets.participants[1], avatar: AVATAR };
  assert.equal(validateScene(sceneWithAssets).ok, true);

  const stripped = {
    id: 'other-id',
    title: '重建标题',
    platform: sceneWithAssets.platform,
    deviceTime: sceneWithAssets.deviceTime,
    date: sceneWithAssets.date,
    selfId: sceneWithAssets.selfId,
    participants: sceneWithAssets.participants.map((participant) => ({
      id: participant.id,
      name: participant.name,
    })),
    messages: sceneWithAssets.messages.map((message) => ({
      id: message.id,
      participantId: message.participantId,
      type: message.type,
      text: message.text,
      time: message.time,
    })),
    watermark: sceneWithAssets.watermark,
  };

  const provider = scriptedProvider([
    toolResponse('create_scene', { scene: stripped }, { id: 's1' }),
    finalResponse('已重建。'),
  ]);
  const result = await runAgent({
    prompt: '重写场景',
    scene: sceneWithAssets,
    provider,
    config: testConfig(),
    onEvent: () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.scene.id, sceneWithAssets.id);
  assert.equal(result.scene.messages[0].asset, ASSET);
  assert.equal(result.scene.participants[1].avatar, AVATAR);

  const payload = JSON.stringify(provider.calls[0].messages);
  assert.equal(payload.includes('base64,AAAA'), false, 'existing asset bytes must not be sent');
  assert.equal(payload.includes('base64,BBBB'), false, 'existing avatar bytes must not be sent');
  assert.match(payload, /已有图片/);
  assert.match(payload, /已有头像/);
});

test('model-supplied asset/avatar values are ignored in favour of server-side assets', async () => {
  const sceneWithAssets = baseScene();
  sceneWithAssets.messages[0] = { ...sceneWithAssets.messages[0], asset: ASSET };
  const provider = scriptedProvider([
    toolResponse(
      'create_scene',
      {
        scene: {
          ...sceneWithAssets,
          participants: sceneWithAssets.participants.map((participant) => ({
            ...participant,
            avatar: 'https://evil.example/avatar.png',
          })),
          messages: sceneWithAssets.messages.map((message) => ({
            ...message,
            asset: 'data:image/svg+xml;base64,PHN2Zz4=',
          })),
        },
      },
      { id: 'bad-assets' },
    ),
    toolResponse('upsert_message', { message: updateMessageArgs(sceneWithAssets, 'm-4', '改了') }, { id: 'ok' }),
    finalResponse('完成'),
  ]);
  const result = await runAgent({
    prompt: '重写',
    scene: sceneWithAssets,
    provider,
    config: testConfig(),
    onEvent: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.scene.messages[0].asset, ASSET);
  assert.equal(result.scene.participants.some((p) => p.avatar === 'https://evil.example/avatar.png'), false);
});

/* ------------------------------------------------------------------ */
/* Image tool behaviour                                                */
/* ------------------------------------------------------------------ */

test('generate_image sets a validated asset and never feeds base64 back to the model', async () => {
  const base = sceneWithImage();
  const imageProvider = {
    calls: [],
    async generate({ prompt, signal }) {
      this.calls.push({ prompt, aborted: Boolean(signal?.aborted) });
      return { dataUrl: ASSET, mime: 'image/png', bytes: 4 };
    },
  };
  const provider = scriptedProvider([
    toolResponse('generate_image', { targetId: 'm-img', kind: 'message', prompt: '海边日落' }, { id: 'img' }),
    finalResponse('已生成图片。'),
  ]);
  const collector = eventCollector();

  const result = await runAgent({
    prompt: '给图片消息配一张海边日落',
    scene: base,
    provider,
    imageProvider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, true);
  assert.equal(imageProvider.calls.length, 1);
  assert.equal(imageProvider.calls[0].prompt, '海边日落');
  assert.equal(result.scene.messages.find((message) => message.id === 'm-img').asset, ASSET);
  const toolDone = collector.toolEvents().find((event) => event.state === 'done');
  assert.match(toolDone.detail, /生成图片/);

  const feedback = provider.calls[1].messages.find((message) => message.role === 'tool');
  assert.equal(feedback.content.includes('base64'), false, 'tool feedback must not carry base64');
});

test('missing image configuration yields a truthful failed tool result and keeps text edits working', async () => {
  const base = sceneWithImage();
  const provider = scriptedProvider([
    toolResponse('generate_image', { targetId: 'm-img', kind: 'message', prompt: '海边日落' }, { id: 'img' }),
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', '没有图片也可以') }, { id: 'txt' }),
    finalResponse('图片服务不可用，已用文字完成。'),
  ]);
  const collector = eventCollector();

  const result = await runAgent({
    prompt: '配图并改一句',
    scene: base,
    provider,
    imageProvider: null,
    config: testConfig(),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, false);
  const error = collector.toolEvents().find((event) => event.state === 'error');
  assert.match(error.detail, /未配置/);
  assert.equal(result.scene.messages.find((message) => message.id === 'm-img').asset, undefined);
  assert.equal(result.scene.messages.find((message) => message.id === 'm-4').text, '没有图片也可以');
  assert.equal(collector.types().includes('done'), false);
});

test('an image provider failure is surfaced and does not fake success', async () => {
  const base = sceneWithImage();
  const imageProvider = {
    async generate() {
      const error = new Error('图片服务暂时不可用，请稍后重试。');
      error.name = 'ProviderError';
      throw error;
    },
  };
  const provider = scriptedProvider([
    toolResponse('generate_image', { targetId: 'm-img', kind: 'message', prompt: '图' }, { id: 'img' }),
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', '文字完成') }, { id: 'txt' }),
    finalResponse('完成'),
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '配图',
    scene: base,
    provider,
    imageProvider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, false);
  const error = collector.toolEvents().find((event) => event.state === 'error');
  assert.match(error.detail, /图片生成失败/);
  assert.equal(result.scene.messages.find((message) => message.id === 'm-img').asset, undefined);
});

test('generate_image rejects avatar changes during a targeted run', async () => {
  const base = baseScene();
  const imageProvider = { async generate() { return { dataUrl: ASSET, mime: 'image/png', bytes: 4 }; } };
  const provider = scriptedProvider([
    toolResponse('generate_image', { targetId: 'p-ayuan', kind: 'avatar', prompt: '头像' }, { id: 'a1' }),
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-2', '改') }, { id: 'a2' }),
    finalResponse('完成'),
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '换头像',
    scene: base,
    targetId: 'm-2',
    provider,
    imageProvider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, true);
  const error = collector.toolEvents().find((event) => event.state === 'error');
  assert.match(error.detail, /定向编辑不允许修改头像/);
});

test('generate_image requires an image-type message and never calls the provider otherwise', async () => {
  const base = baseScene();
  const imageProvider = {
    calls: 0,
    async generate() {
      this.calls += 1;
      return { dataUrl: ASSET, mime: 'image/png', bytes: 4 };
    },
  };
  const provider = scriptedProvider([
    toolResponse('generate_image', { targetId: 'm-2', kind: 'message', prompt: '图' }, { id: 'g1' }),
    toolResponse(
      'upsert_message',
      { message: { id: 'm-2', participantId: 'p-ayuan', type: 'image', text: '照片', time: '09:39' } },
      { id: 'u1' },
    ),
    toolResponse('generate_image', { targetId: 'm-2', kind: 'message', prompt: '图' }, { id: 'g2' }),
    finalResponse('完成'),
  ]);
  const collector = eventCollector();

  const result = await runAgent({
    prompt: '给第二条配图',
    scene: base,
    provider,
    imageProvider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, true);
  // Only the second (type=image) call reaches the paid image provider.
  assert.equal(imageProvider.calls, 1);
  const error = collector.toolEvents().find((event) => event.state === 'error');
  assert.match(error.detail, /type=image/);
  const target = result.scene.messages.find((message) => message.id === 'm-2');
  assert.equal(target.type, 'image');
  assert.equal(target.asset, ASSET);
});

test('an aborted image tool aborts the whole batch before later mutations', async () => {
  const base = sceneWithImage();
  const controller = new AbortController();
  const imageProvider = {
    calls: 0,
    async generate({ signal }) {
      this.calls += 1;
      return new Promise((_resolve, reject) => {
        const onAbort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
  const provider = scriptedProvider([
    {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'img',
          name: 'generate_image',
          arguments: JSON.stringify({ targetId: 'm-img', kind: 'message', prompt: '图' }),
        },
        {
          id: 'txt',
          name: 'upsert_message',
          arguments: JSON.stringify({ message: updateMessageArgs(base, 'm-4', '不应生效') }),
        },
      ],
    },
  ]);
  const collector = eventCollector();
  const promise = runAgent({
    prompt: '配图并改一句',
    scene: base,
    provider,
    imageProvider,
    signal: controller.signal,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  setTimeout(() => controller.abort(), 20);

  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(imageProvider.calls, 1);
  assert.equal(collector.events.filter((event) => event.type === 'scene').length, 1);
  assert.equal(collector.types().includes('done'), false);
  assert.equal(collector.toolEvents().some((event) => event.id === 'txt'), false);
  // The aborted image must be rethrown, not turned into a terminal tool event.
  assert.equal(collector.toolEvents().some((event) => event.state !== 'running'), false);
  assert.equal(
    result.scene.messages.find((message) => message.id === 'm-4').text,
    base.messages.find((message) => message.id === 'm-4').text,
  );
});

test('an image tool that resolves after abort cannot mutate or emit', async () => {
  const base = sceneWithImage();
  const controller = new AbortController();
  const imageProvider = {
    async generate() {
      controller.abort();
      return { dataUrl: ASSET, mime: 'image/png', bytes: 4 };
    },
  };
  const provider = scriptedProvider([
    {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'img',
          name: 'generate_image',
          arguments: JSON.stringify({ targetId: 'm-img', kind: 'message', prompt: '图' }),
        },
      ],
    },
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '配图',
    scene: base,
    provider,
    imageProvider,
    signal: controller.signal,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.aborted, true);
  assert.equal(collector.events.filter((event) => event.type === 'scene').length, 1);
  assert.equal(collector.types().includes('done'), false);
  assert.equal(result.scene.messages.find((message) => message.id === 'm-img').asset, undefined);
});

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

test('attachments are forwarded as bounded multimodal image parts', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', '根据截图改好了') }, { id: 'p1' }),
    finalResponse('完成'),
  ]);
  const result = await runAgent({
    prompt: '照着截图改',
    scene: base,
    attachments: [ATTACHMENT],
    provider,
    config: testConfig(),
    onEvent: () => {},
  });
  assert.equal(result.ok, true);
  const userMessage = provider.calls[0].messages.find((message) => message.role === 'user');
  assert.ok(Array.isArray(userMessage.content));
  const imagePart = userMessage.content.find((part) => part.type === 'image_url');
  assert.equal(imagePart.image_url.url, ATTACHMENT);
  assert.match(userMessage.content[0].text, /不可信素材/);
});

/* ------------------------------------------------------------------ */
/* Bounds, rounds and cancellation                                     */
/* ------------------------------------------------------------------ */

test('agent input validation enforces every documented bound', () => {
  const base = baseScene();
  const ok = validateAgentInput({ prompt: '改一下', scene: base });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.targetId, null);
  assert.deepEqual(ok.value.attachments, []);
  assert.deepEqual(ok.value.history, []);

  const longPrompt = validateAgentInput({ prompt: 'x'.repeat(4001), scene: base });
  assert.equal(longPrompt.code, 'invalid_prompt');

  assert.equal(validateAgentInput({ prompt: '   ', scene: base }).code, 'invalid_prompt');
  assert.equal(validateAgentInput({ prompt: 'x', scene: { id: 'broken' } }).code, 'invalid_scene');
  assert.equal(validateAgentInput({ prompt: 'x', scene: base, targetId: 'nope' }).code, 'invalid_target');
  assert.equal(
    validateAgentInput({ prompt: 'x', scene: base, attachments: [ATTACHMENT, ATTACHMENT, ATTACHMENT, ATTACHMENT] }).code,
    'invalid_attachments',
  );
  assert.equal(
    validateAgentInput({ prompt: 'x', scene: base, attachments: ['https://evil.example/a.png'] }).code,
    'invalid_attachments',
  );
  assert.equal(
    validateAgentInput({ prompt: 'x', scene: base, attachments: ['data:image/svg+xml;base64,PHN2Zz4='] }).code,
    'invalid_attachments',
  );
  assert.equal(
    validateAgentInput({ prompt: 'x', scene: base, history: Array.from({ length: 13 }, () => ({ role: 'user', content: 'hi' })) }).code,
    'invalid_history',
  );
  assert.equal(
    validateAgentInput({ prompt: 'x', scene: base, history: [{ role: 'system', content: 'hi' }] }).code,
    'invalid_history',
  );
  assert.equal(
    validateAgentInput({ prompt: 'x', scene: base, history: [{ role: 'user', content: 'x'.repeat(4001) }] }).code,
    'invalid_history',
  );

  const valid = validateAgentInput({
    prompt: 'x',
    scene: base,
    targetId: 'm-2',
    attachments: [ATTACHMENT],
    history: [{ role: 'user', content: '之前说过' }, { role: 'assistant', content: '好的' }],
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.targetId, 'm-2');
  assert.equal(valid.value.attachments.length, 1);
  assert.equal(valid.value.history.length, 2);
});

test('scene resource limits reject oversized input and oversized mutations', async () => {
  const base = baseScene();

  const tooManyMessages = {
    ...base,
    messages: Array.from({ length: 201 }, (_value, index) => ({
      id: `m-${index}`,
      participantId: 'p-linxiaoman',
      type: 'text',
      text: 'ok',
      time: '09:00',
    })),
  };
  assert.equal(validateAgentInput({ prompt: 'x', scene: tooManyMessages }).code, 'invalid_scene');

  const tooManyParticipants = {
    ...base,
    participants: Array.from({ length: 21 }, (_value, index) => ({ id: `p-${index}`, name: `n${index}` })),
    selfId: 'p-0',
  };
  assert.equal(validateAgentInput({ prompt: 'x', scene: tooManyParticipants }).code, 'invalid_scene');

  const longText = {
    ...base,
    messages: base.messages.map((message, index) =>
      index === 0 ? { ...message, text: 'x'.repeat(4001) } : message,
    ),
  };
  assert.equal(validateAgentInput({ prompt: 'x', scene: longText }).code, 'invalid_scene');

  const longId = {
    ...base,
    messages: base.messages.map((message, index) =>
      index === 0 ? { ...message, id: 'a'.repeat(129) } : message,
    ),
  };
  assert.equal(validateAgentInput({ prompt: 'x', scene: longId }).code, 'invalid_scene');

  // A proposed mutation that exceeds a limit fails with corrective feedback.
  const provider = scriptedProvider([
    toolResponse(
      'upsert_message',
      {
        message: {
          id: 'm-4',
          participantId: 'p-ayuan',
          type: 'text',
          text: 'x'.repeat(4001),
          time: '09:41',
        },
      },
      { id: 'big' },
    ),
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', 'ok') }, { id: 'ok' }),
    finalResponse('完成'),
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, true);
  const error = collector.toolEvents().find((event) => event.state === 'error');
  assert.match(error.detail, /超出限制|消息文本/);
  assert.equal(result.scene.messages.find((message) => message.id === 'm-4').text, 'ok');
});

test('checkSceneLimits reports ids, names, dates and texts', () => {
  const base = baseScene();
  assert.equal(checkSceneLimits(base), null);
  assert.match(
    checkSceneLimits({
      ...base,
      messages: base.messages.map((m, i) => (i === 0 ? { ...m, id: 'a'.repeat(129) } : m)),
    }),
    /消息 id 过长/,
  );
  assert.match(
    checkSceneLimits({
      ...base,
      participants: base.participants.map((p, i) => (i === 0 ? { ...p, name: 'n'.repeat(121) } : p)),
    }),
    /名称过长/,
  );
  assert.match(checkSceneLimits({ ...base, date: 'd'.repeat(81) }), /日期过长/);
  assert.match(
    checkSceneLimits({
      ...base,
      messages: base.messages.map((m, i) => (i === 0 ? { ...m, text: 'x'.repeat(4001) } : m)),
    }),
    /消息文本/,
  );
});

test('buildSceneContext is size-bounded and preserves an early target message', () => {
  const scene = baseScene();
  scene.messages = Array.from({ length: 200 }, (_value, index) => ({
    id: `m-${index}`,
    participantId: 'p-linxiaoman',
    type: 'text',
    text: `${index}-${'词'.repeat(400)}`,
    time: '09:00',
  }));
  assert.equal(checkSceneLimits(scene), null);

  // The target is the earliest message, which truncation would drop first.
  const targeted = buildSceneContext(scene, 3000, 'm-0');
  assert.equal(targeted.truncated, true);
  assert.ok(targeted.text.length <= 3000);
  const targetedJson = JSON.parse(targeted.text);
  assert.ok(targetedJson.messages.some((message) => message.id === 'm-0'));
  assert.ok(targetedJson.messages.length < scene.messages.length);

  // Without a target, the newest messages win and the JSON stays valid/bounded.
  const plain = buildSceneContext(scene, 3000);
  assert.ok(plain.text.length <= 3000);
  assert.ok(plain.truncated);
  const plainJson = JSON.parse(plain.text);
  assert.equal(plainJson.messages.at(-1).id, 'm-199');
  assert.equal(plainJson.messages.some((message) => message.id === 'm-0'), false);
});

test('runAgent stops at the round cap without claiming success', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', '新台词') }, { id: 'loop' }),
  ]);
  const collector = eventCollector();

  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig({ maxRounds: 4 }),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_rounds');
  assert.equal(provider.calls.length, 4);
  assert.equal(collector.events.at(-1).type, 'error');
  assert.equal(collector.types().includes('done'), false);
});

test('runAgent stops at the tool-call cap', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    {
      content: '',
      toolCalls: [
        { id: 'a', name: 'upsert_message', arguments: JSON.stringify({ message: updateMessageArgs(base, 'm-1', '一') }) },
        { id: 'b', name: 'upsert_message', arguments: JSON.stringify({ message: updateMessageArgs(base, 'm-2', '二') }) },
      ],
    },
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig({ maxCalls: 2, maxRounds: 8 }),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'max_calls');
  assert.equal(provider.calls.length, 2);
  assert.match(collector.events.at(-1).message, /工具调用超过上限/);
});

test('runAgent aborts on the wall deadline with a truthful error event', async () => {
  const base = baseScene();
  const provider = pendingProvider();
  const collector = eventCollector();
  const started = Date.now();

  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig({ deadlineMs: 40 }),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.ok(Date.now() - started < 1_500);
  assert.equal(collector.events.at(-1).type, 'error');
  assert.match(collector.events.at(-1).message, /秒上限/);
});

test('runAgent honours client cancellation without emitting done', async () => {
  const base = baseScene();
  const provider = pendingProvider();
  const collector = eventCollector();
  const controller = new AbortController();

  const promise = runAgent({
    prompt: '改',
    scene: base,
    provider,
    signal: controller.signal,
    config: testConfig({ deadlineMs: 5_000 }),
    onEvent: collector.onEvent,
  });
  setTimeout(() => controller.abort(), 15);

  const result = await promise;
  assert.equal(result.aborted, true);
  assert.equal(result.reason, 'aborted');
  assert.equal(collector.types().includes('done'), false);
});

test('runAgent surfaces provider failures through a bounded error event', async () => {
  const base = baseScene();
  const provider = scriptedProvider([new Error('AI 服务暂时不可用，请稍后重试。')]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'error');
  assert.equal(collector.events.at(-1).type, 'error');
  assert.match(collector.events.at(-1).message, /暂时不可用/);
});

test('runAgent never truncates a scene whose id differs from the payload', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse('create_scene', { scene: { ...base, id: 'rogue-id', title: '标题' } }, { id: 'r1' }),
    finalResponse('完成'),
  ]);
  const result = await runAgent({
    prompt: '改标题',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: () => {},
  });
  assert.equal(result.scene.id, 'scene-weekend');
});

/* ------------------------------------------------------------------ */
/* Provider finish reasons                                             */
/* ------------------------------------------------------------------ */

test('runAgent fails an incomplete final turn before emitting done', async () => {
  const base = baseScene();
  for (const [finishReason, pattern] of [
    ['length', /长度上限/],
    ['content_filter', /内容策略/],
    ['insufficient_system_resource', /资源不足/],
  ]) {
    const provider = scriptedProvider([
      { content: '被截断的内容', toolCalls: [], finishReason },
    ]);
    const collector = eventCollector();
    const result = await runAgent({
      prompt: '改',
      scene: base,
      provider,
      config: testConfig(),
      onEvent: collector.onEvent,
    });
    assert.equal(result.ok, false, finishReason);
    assert.equal(result.reason, 'incomplete', finishReason);
    assert.equal(result.finishReason, finishReason);
    assert.equal(collector.types().includes('done'), false, finishReason);
    assert.equal(collector.types().includes('assistant'), false, finishReason);
    assert.equal(collector.events.at(-1).type, 'error');
    assert.match(collector.events.at(-1).message, pattern);
  }
});

test('an incomplete turn is neither applied nor finalized even after real mutations', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    toolResponse('upsert_message', { message: updateMessageArgs(base, 'm-4', '已改') }, { id: 'ok' }),
    { content: '后续被截断', toolCalls: [], finishReason: 'length' },
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.reason, 'incomplete');
  assert.equal(result.mutations, 1);
  assert.equal(provider.calls.length, 2);
  assert.equal(collector.types().includes('done'), false);
  assert.equal(collector.events.at(-1).type, 'error');
  // The incomplete turn's tool calls (if any) must not be executed.
  assert.equal(collector.toolEvents().filter((event) => event.state === 'running').length, 1);
});

test('stub providers without a finishReason field still run normally', async () => {
  const base = baseScene();
  const provider = scriptedProvider([
    {
      content: '',
      toolCalls: [
        {
          id: 'stub-1',
          name: 'upsert_message',
          arguments: JSON.stringify({ message: updateMessageArgs(base, 'm-4', 'stub 改') }),
        },
      ],
    },
    { content: '完成', toolCalls: [] },
  ]);
  const collector = eventCollector();
  const result = await runAgent({
    prompt: '改',
    scene: base,
    provider,
    config: testConfig(),
    onEvent: collector.onEvent,
  });
  assert.equal(result.ok, true);
  assert.equal(collector.events.at(-1).type, 'done');
});

/* ------------------------------------------------------------------ */
/* Bounded NDJSON writes                                               */
/* ------------------------------------------------------------------ */

function fakeResponse({ writeResult = true, writableEnded = false, destroyed = false } = {}) {
  const res = new EventEmitter();
  res.writableEnded = writableEnded;
  res.destroyed = destroyed;
  res.writes = [];
  res.ended = false;
  res.write = (line) => {
    res.writes.push(line);
    return writeResult;
  };
  res.end = () => {
    res.ended = true;
    res.writableEnded = true;
  };
  res.destroy = () => {
    res.destroyed = true;
  };
  return res;
}

test('writeNdjsonLine resolves immediately when the socket accepts the line', async () => {
  const res = fakeResponse({ writeResult: true });
  await writeNdjsonLine(res, '{"type":"done"}\n', undefined);
  assert.deepEqual(res.writes, ['{"type":"done"}\n']);
  assert.equal(res.listenerCount('drain'), 0);
});

test('writeNdjsonLine waits for drain under backpressure and cleans up', async () => {
  const res = fakeResponse({ writeResult: false });
  const promise = writeNdjsonLine(res, 'x\n', undefined);
  await Promise.resolve();
  assert.equal(res.listenerCount('drain'), 1);
  res.emit('drain');
  await promise;
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('writeNdjsonLine backpressure wait is abortable by the whole-run deadline', async () => {
  const res = fakeResponse({ writeResult: false });
  const controller = new AbortController();
  const promise = writeNdjsonLine(res, 'x\n', controller.signal, {
    deadlineMessage: '已超过运行时限，已停止。',
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(
    () => promise,
    (error) => error.name === 'AbortError' && /已超过运行时限/.test(error.message),
  );
  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

test('writeNdjsonLine rejects immediately for an aborted signal or a gone socket', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => writeNdjsonLine(fakeResponse(), 'x\n', controller.signal),
    (error) => error.name === 'AbortError',
  );
  await assert.rejects(
    () => writeNdjsonLine(fakeResponse({ writableEnded: true }), 'x\n', undefined),
    /连接已关闭/,
  );
  await assert.rejects(
    () => writeNdjsonLine(fakeResponse({ destroyed: true }), 'x\n', undefined),
    /连接已关闭/,
  );
});

test('writeNdjsonLine rejects and removes listeners when the socket closes mid-wait', async () => {
  const res = fakeResponse({ writeResult: false });
  const promise = writeNdjsonLine(res, 'x\n', undefined);
  await Promise.resolve();
  res.emit('close');
  await assert.rejects(() => promise, /连接已关闭/);
  assert.equal(res.listenerCount('close'), 0);
  assert.equal(res.listenerCount('drain'), 0);
});

test('finishNdjsonResponse ends cleanly on a normal run', () => {
  const res = fakeResponse();
  const timer = finishNdjsonResponse(res, { deadlineHit: false });
  assert.equal(res.ended, true);
  assert.equal(res.destroyed, false);
  assert.equal(timer, null);
});

test('finishNdjsonResponse emits a timeout error and destroys a stuck socket boundedly', async () => {
  const res = fakeResponse({ writeResult: false });
  const timer = finishNdjsonResponse(res, {
    deadlineHit: true,
    timeoutLine: '{"type":"error","message":"超时"}\n',
    destroyDelayMs: 20,
  });
  assert.deepEqual(res.writes, ['{"type":"error","message":"超时"}\n']);
  assert.equal(res.ended, true);
  assert.equal(res.destroyed, false, 'destroy must be bounded, not immediate');
  assert.ok(timer);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(res.destroyed, true);
});

test('finishNdjsonResponse leaves an already-finished response alone', () => {
  const res = fakeResponse({ writableEnded: true });
  const timer = finishNdjsonResponse(res, {
    deadlineHit: true,
    timeoutLine: 'x\n',
    destroyDelayMs: 10,
  });
  assert.deepEqual(res.writes, []);
  assert.equal(res.ended, false);
  assert.equal(res.destroyed, false);
  assert.equal(timer, null);
});

/* ------------------------------------------------------------------ */
/* Event wire format                                                   */
/* ------------------------------------------------------------------ */

test('serializeAgentEvent emits exactly the documented union', () => {
  const scene = baseScene();
  const lines = [
    serializeAgentEvent({ type: 'scene', scene }),
    serializeAgentEvent({ type: 'tool', id: 'c1', name: 'create_scene', state: 'running', detail: '运行中' }),
    serializeAgentEvent({ type: 'assistant', text: '好了' }),
    serializeAgentEvent({ type: 'done' }),
    serializeAgentEvent({ type: 'error', message: '失败' }),
  ].join('');
  const events = lines
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));

  assert.deepEqual(Object.keys(events[0]).sort(), ['scene', 'type']);
  assert.deepEqual(Object.keys(events[1]).sort(), ['detail', 'id', 'name', 'state', 'type']);
  assert.deepEqual(Object.keys(events[2]).sort(), ['text', 'type']);
  assert.deepEqual(Object.keys(events[3]), ['type']);
  assert.deepEqual(Object.keys(events[4]).sort(), ['message', 'type']);

  assert.throws(() => serializeAgentEvent({ type: 'nope' }), /未知/);
  assert.throws(
    () => serializeAgentEvent({ type: 'tool', id: 'x', name: 'y', state: 'weird', detail: '' }),
    /状态/,
  );
});

test('AGENT_TOOL_SCHEMAS exposes the five scene tools with JSON schemas', () => {
  assert.deepEqual(
    AGENT_TOOL_SCHEMAS.map((tool) => tool.function.name),
    ['update_element', 'create_scene', 'upsert_message', 'delete_message', 'generate_image'],
  );
  for (const tool of AGENT_TOOL_SCHEMAS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    assert.equal(typeof tool.function.description, 'string');
  }
});

/* ------------------------------------------------------------------ */
/* Provider wire format                                                */
/* ------------------------------------------------------------------ */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
]);
const PNG_B64 = PNG_BYTES.toString('base64');

test('resolveAgentConfig reads the documented server-only env and degrades safely', () => {
  const deepseek = resolveAgentConfig({ DEEPSEEK_API_KEY: 'k-deepseek' });
  assert.equal(deepseek.configured, true);
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(deepseek.model, 'deepseek-flash');
  assert.equal(deepseek.imageConfigured, false);

  const imstage = resolveAgentConfig({
    IMSTAGE_AI_API_KEY: 'k-imstage',
    IMSTAGE_AI_BASE_URL: 'https://proxy.example/v1/',
    IMSTAGE_AI_MODEL: 'other-model',
    IMSTAGE_IMAGE_BASE_URL: 'https://images.example/v1',
    IMSTAGE_IMAGE_API_KEY: 'k-image',
    IMSTAGE_IMAGE_MODEL: 'image-model',
  });
  assert.equal(imstage.configured, true);
  assert.equal(imstage.baseUrl, 'https://proxy.example/v1');
  assert.equal(imstage.model, 'other-model');
  assert.equal(imstage.imageConfigured, true);

  // Missing or non-http(s) values must never be configured.
  assert.equal(resolveAgentConfig({}).configured, false);
  assert.equal(resolveAgentConfig({ DEEPSEEK_API_KEY: 'k', IMSTAGE_AI_BASE_URL: 'file:///etc/passwd' }).configured, false);
  assert.equal(
    resolveAgentConfig({
      IMSTAGE_IMAGE_API_KEY: 'k',
      IMSTAGE_IMAGE_MODEL: 'm',
      IMSTAGE_IMAGE_BASE_URL: 'not a url',
    }).imageConfigured,
    false,
  );

  const runtime = createAgentRuntime(resolveAgentConfig({ DEEPSEEK_API_KEY: 'k' }));
  assert.deepEqual(runtime.capabilities, {
    configured: true,
    model: 'deepseek-flash',
    imageConfigured: false,
  });
});

test('resolveAgentConfig selects the image provider and fails closed for unknown names', () => {
  // Default stays OpenAI-compatible and requires an explicit base URL.
  const openai = resolveAgentConfig({
    IMSTAGE_IMAGE_API_KEY: 'k',
    IMSTAGE_IMAGE_MODEL: 'm',
  });
  assert.equal(openai.imageProvider, 'openai');
  assert.equal(openai.imageProviderValid, true);
  assert.equal(openai.imageConfigured, false);
  assert.equal(
    resolveAgentConfig({
      IMSTAGE_IMAGE_API_KEY: 'k',
      IMSTAGE_IMAGE_MODEL: 'm',
      IMSTAGE_IMAGE_BASE_URL: 'https://images.example/v1',
      IMSTAGE_IMAGE_PROVIDER: 'openai',
    }).imageConfigured,
    true,
  );

  // Tencent WAND defaults to the domestic TokenHub base URL and the existing
  // image key/model env vars.
  const tencent = resolveAgentConfig({
    IMSTAGE_IMAGE_PROVIDER: 'tencent-wand',
    IMSTAGE_IMAGE_API_KEY: 'wand-key',
    IMSTAGE_IMAGE_MODEL: 'wand-vega-image-lite',
  });
  assert.equal(tencent.imageProvider, 'tencent-wand');
  assert.equal(tencent.imageBaseUrl, 'https://tokenhub.tencentmaas.com/v1');
  assert.equal(tencent.imageConfigured, true);
  assert.equal(tencent.imagePollIntervalMs, 3_000);
  assert.ok(tencent.imageDeadlineMs > 0);

  // An unknown provider must never silently fall back to another provider.
  const unknown = resolveAgentConfig({
    IMSTAGE_IMAGE_PROVIDER: 'anthropic-images',
    IMSTAGE_IMAGE_API_KEY: 'k',
    IMSTAGE_IMAGE_MODEL: 'm',
    IMSTAGE_IMAGE_BASE_URL: 'https://images.example/v1',
  });
  assert.equal(unknown.imageProvider, 'anthropic-images');
  assert.equal(unknown.imageProviderValid, false);
  assert.equal(unknown.imageConfigured, false);
});

test('the runtime routes Tencent WAND configs through the async provider', async () => {
  const config = resolveAgentConfig({
    DEEPSEEK_API_KEY: 'k',
    IMSTAGE_IMAGE_PROVIDER: 'tencent-wand',
    IMSTAGE_IMAGE_API_KEY: 'wand-secret',
    IMSTAGE_IMAGE_MODEL: 'wand-vega-image-lite',
  });
  assert.equal(config.imageConfigured, true);
  const pngBytes = Buffer.from(ASSET.slice(ASSET.indexOf(',') + 1), 'base64');
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
    if (href.includes('/wand/vega-images/tasks/')) {
      return jsonResponse({ status: 'completed', data: [{ url: 'https://demo.cos.myqcloud.com/out.png' }] });
    }
    if (href.startsWith('https://demo.cos.myqcloud.com/')) {
      return new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error(`unexpected request: ${href}`);
  };
  const runtime = createAgentRuntime(config, {
    chatProvider: scriptedProvider([
      toolResponse('generate_image', { targetId: 'm-img', kind: 'message', prompt: '海边日落' }, { id: 'img' }),
      finalResponse('已生成图片。'),
    ]),
    fetchImpl,
  });
  const collector = eventCollector();
  const result = await runtime.run({
    prompt: '给图片消息配一张海边日落',
    scene: sceneWithImage(),
    onEvent: collector.onEvent,
  });

  assert.equal(result.ok, true);
  assert.equal(result.scene.messages.find((message) => message.id === 'm-img').asset, ASSET);
  const submit = calls.find((call) => call.href.endsWith('/wand/vega-images/generations'));
  assert.equal(submit.init.headers.authorization, 'Bearer wand-secret');
  assert.equal(JSON.parse(submit.init.body).input, undefined);
  const download = calls.find((call) => call.href.startsWith('https://demo.cos.myqcloud.com/'));
  assert.equal(download.init.headers.authorization, undefined);
});

test('createChatProvider posts the documented DeepSeek tool-calling request', async () => {
  const requests = [];
  const provider = createChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'secret-key',
    model: 'deepseek-flash',
    fetchImpl: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'upsert_message', arguments: '{"message":{"id":"m-1"}}' },
                },
              ],
            },
          },
        ],
      });
    },
  });

  const tools = [{ type: 'function', function: { name: 'x', parameters: { type: 'object' } } }];
  const result = await provider.complete({
    messages: [{ role: 'user', content: 'hi' }],
    tools,
    signal: undefined,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.authorization, 'Bearer secret-key');
  assert.equal(requests[0].body.model, 'deepseek-flash');
  assert.equal(requests[0].body.stream, false);
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  assert.equal(requests[0].body.tool_choice, 'auto');
  assert.deepEqual(requests[0].body.tools, tools);

  assert.equal(result.content, '');
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(result.toolCalls, [
    { id: 'call_1', name: 'upsert_message', arguments: '{"message":{"id":"m-1"}}' },
  ]);
});

test('createChatProvider fails closed on incomplete, missing and unknown finish reasons', async () => {
  const make = (finishReason) =>
    createChatProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-flash',
      fetchImpl: async () =>
        jsonResponse({
          choices: [{ finish_reason: finishReason, message: { content: 'x', tool_calls: [] } }],
        }),
    });

  await assert.rejects(() => make('length').complete({ messages: [], tools: [] }), /长度上限/);
  await assert.rejects(() => make('content_filter').complete({ messages: [], tools: [] }), /内容策略/);
  await assert.rejects(() => make('aborted').complete({ messages: [], tools: [] }), /中止/);
  await assert.rejects(() => make(undefined).complete({ messages: [], tools: [] }), /结束原因/);
  await assert.rejects(
    () => make('weird-secret-token').complete({ messages: [], tools: [] }),
    (error) => {
      assert.equal(error.message.includes('weird-secret-token'), false);
      assert.match(error.message, /结束原因/);
      return true;
    },
  );

  // Only `stop` and `tool_calls` are accepted.
  assert.equal((await make('stop').complete({ messages: [], tools: [] })).finishReason, 'stop');
  assert.equal(
    (await make('tool_calls').complete({ messages: [], tools: [] })).finishReason,
    'tool_calls',
  );
});

test('createChatProvider surfaces bounded Chinese errors without leaking the key', async () => {
  const provider = createChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'secret-key',
    model: 'deepseek-flash',
    fetchImpl: async () =>
      jsonResponse({ error: { message: 'bad key secret-key' } }, 401),
  });
  await assert.rejects(
    () => provider.complete({ messages: [], tools: [] }),
    (error) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /鉴权失败/);
      assert.equal(error.message.includes('secret-key'), false);
      return true;
    },
  );

  const rateProvider = createChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'k',
    model: 'deepseek-flash',
    fetchImpl: async () => new Response('', { status: 429 }),
  });
  await assert.rejects(() => rateProvider.complete({ messages: [], tools: [] }), /频繁/);

  // Upstream error bodies are untrusted and must never be echoed to a client,
  // even when the secret crosses a truncation cutoff.
  const cutoffBody = `${'x'.repeat(195)}secret-key-tail`;
  const echoProvider = createChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'secret-key',
    model: 'deepseek-flash',
    fetchImpl: async () =>
      new Response(cutoffBody, {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      }),
  });
  await assert.rejects(
    () => echoProvider.complete({ messages: [], tools: [] }),
    (error) => {
      assert.equal(error.message.includes('secret-key'), false);
      assert.equal(error.message.includes('xxxx'), false, 'no upstream text may be echoed');
      assert.match(error.message, /拒绝了本次请求（HTTP 400）/);
      return true;
    },
  );
});

test('createChatProvider enforces a bounded response size', async () => {
  const provider = createChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'k',
    model: 'deepseek-flash',
    maxResponseBytes: 64,
    fetchImpl: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(500) } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  await assert.rejects(() => provider.complete({ messages: [], tools: [] }), /大小限制/);
});

test('createChatProvider propagates cancellation', async () => {
  const provider = createChatProvider({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'k',
    model: 'deepseek-flash',
    fetchImpl: async (_url, { signal }) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  });
  const controller = new AbortController();
  const promise = provider.complete({ messages: [], tools: [], signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(() => promise, (error) => error.name === 'AbortError');
});

test('createImageProvider uses b64_json only and validates the raster payload', async () => {
  const calls = [];
  const provider = createImageProvider({
    baseUrl: 'https://images.example/v1',
    apiKey: 'image-key',
    model: 'image-model',
    maxDataUrlChars: 6 * 1024 * 1024,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization });
      return jsonResponse({ data: [{ b64_json: PNG_B64 }] });
    },
  });
  const result = await provider.generate({ prompt: '海边日落', signal: undefined });
  assert.equal(calls[0].url, 'https://images.example/v1/images/generations');
  assert.equal(calls[0].body.response_format, 'b64_json');
  assert.equal(calls[0].auth, 'Bearer image-key');
  assert.equal(result.mime, 'image/png');
  assert.match(result.dataUrl, /^data:image\/png;base64,/);

  const noImage = createImageProvider({
    baseUrl: 'https://images.example/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async () => jsonResponse({ data: [{ url: 'https://evil.example/x.png' }] }),
  });
  await assert.rejects(() => noImage.generate({ prompt: 'x' }), /b64_json/);

  const notRaster = createImageProvider({
    baseUrl: 'https://images.example/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async () => jsonResponse({ data: [{ b64_json: Buffer.from('not an image at all').toString('base64') }] }),
  });
  await assert.rejects(() => notRaster.generate({ prompt: 'x' }), /格式/);
});

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

test('agent limiter enforces global, per-user active and rate limits', () => {
  const limiter = createAgentLimiter({
    activeGlobal: 1,
    activePerUser: 1,
    rate: { windowMs: 60_000, max: 100, maxKeys: 100 },
  });

  const first = limiter.tryStart('u1');
  assert.equal(first.ok, true);
  const second = limiter.tryStart('u2');
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'global_busy');
  assert.ok(second.retryAfterMs > 0);
  assert.equal(limiter.snapshot().globalActive, 1);

  first.release();
  assert.equal(limiter.snapshot().globalActive, 0);

  const perUser = createAgentLimiter({
    activeGlobal: 4,
    activePerUser: 1,
    rate: { windowMs: 60_000, max: 100, maxKeys: 100 },
  });
  const userOne = perUser.tryStart('u2');
  assert.equal(userOne.ok, true);
  const userTwo = perUser.tryStart('u2');
  assert.equal(userTwo.ok, false);
  assert.equal(userTwo.reason, 'user_busy');
  userOne.release();
  assert.equal(perUser.activeForUser('u2'), 0);

  const rateLimiter = createAgentLimiter({
    activeGlobal: 4,
    activePerUser: 4,
    rate: { windowMs: 60_000, max: 1, maxKeys: 100 },
  });
  const allowed = rateLimiter.tryStart('rate-user');
  assert.equal(allowed.ok, true);
  allowed.release();
  const denied = rateLimiter.tryStart('rate-user');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'rate_limited');
  assert.ok(denied.retryAfterMs > 0);
  // A denied rate attempt must not leak an active slot.
  assert.equal(rateLimiter.snapshot().globalActive, 0);
});

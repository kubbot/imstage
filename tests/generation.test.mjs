import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEMO_PHOTO_MESSAGE_ID,
  DEMO_SCENE_ID,
  MARS_PROMPT,
  applyGenerationEvent,
  isMarsPrompt,
  streamDemo,
  streamRemote,
} from '../apps/web/src/create/stream.ts';
import { createScene, validateScene } from '../apps/web/src/studio/model.ts';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const AVATAR = 'data:image/png;base64,AAAA';
const IMAGE = 'data:image/png;base64,BBBB';
const encoder = new TextEncoder();

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function applyAll(events, start = null) {
  let scene = start;
  for (const event of events) scene = applyGenerationEvent(scene, event);
  return scene;
}

function mockFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = original;
  });
}

/** Build an NDJSON Response whose UTF-8 bytes are split at `chunkSize`. */
function responseFromLines(
  lines,
  { chunkSize = 5, onCancel, status = 200, contentType = 'application/x-ndjson' } = {},
) {
  const bytes = encoder.encode(lines.join('\r\n'));
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': contentType } });
}

/* ------------------------------------------------------------------ */
/* applyGenerationEvent — schema validation                            */
/* ------------------------------------------------------------------ */

test('applyGenerationEvent validates a scene event and drops unknown fields', () => {
  const original = createScene('weekend');
  const snapshot = JSON.stringify(original);
  const result = applyGenerationEvent(null, {
    type: 'scene',
    scene: { ...original, id: 'scene-stream', unknownField: 'nope' },
  });
  assert.equal(result.id, 'scene-stream');
  assert.ok(!('unknownField' in result));
  assert.equal(validateScene(result).ok, true);
  assert.equal(JSON.stringify(original), snapshot);
});

test('applyGenerationEvent rejects malformed scene and event structures', () => {
  const base = createScene('weekend');
  assert.throws(() => applyGenerationEvent(null, { type: 'scene' }), /scene 对象/);
  assert.throws(
    () => applyGenerationEvent(null, { type: 'scene', scene: { id: 'broken' } }),
    /scene 事件无效/,
  );
  assert.throws(() => applyGenerationEvent(base, null), /对象/);
  assert.throws(() => applyGenerationEvent(base, {}), /type/);
  assert.throws(() => applyGenerationEvent(base, { type: 'nope' }), /未知/);
});

test('applyGenerationEvent appends messages immutably and enforces ids + senders', () => {
  const base = createScene('weekend');
  const snapshot = JSON.stringify(base);
  const appended = applyGenerationEvent(base, {
    type: 'message',
    message: { id: 'm-new', participantId: 'p-linxiaoman', type: 'text', text: '新的台词', time: '' },
  });
  assert.equal(appended.messages.length, base.messages.length + 1);
  assert.equal(appended.messages.at(-1).id, 'm-new');
  assert.equal(appended.messages.at(-1).time, '');
  assert.equal(JSON.stringify(base), snapshot);

  assert.throws(
    () =>
      applyGenerationEvent(base, {
        type: 'message',
        message: {
          id: base.messages[0].id,
          participantId: 'p-linxiaoman',
          type: 'text',
          text: 'x',
          time: '',
        },
      }),
    /重复/,
  );
  assert.throws(
    () =>
      applyGenerationEvent(base, {
        type: 'message',
        message: { id: 'm-ghost', participantId: 'p-ghost', type: 'text', text: 'x', time: '' },
      }),
    /发送者/,
  );
  assert.throws(
    () =>
      applyGenerationEvent(null, {
        type: 'message',
        message: { id: 'm-1', participantId: 'p-linxiaoman', type: 'text', text: 'x', time: '' },
      }),
    /需要已有场景/,
  );
  assert.throws(() => applyGenerationEvent(base, { type: 'message' }), /message 对象/);
});

test('message-delta appends text while preserving every other field', () => {
  const base = createScene('weekend');
  const snapshot = JSON.stringify(base);
  const target = base.messages[1];
  const result = applyGenerationEvent(base, {
    type: 'message-delta',
    id: target.id,
    text: '（增量）',
  });
  const updated = result.messages.find((message) => message.id === target.id);
  assert.equal(updated.text, target.text + '（增量）');
  assert.equal(updated.time, target.time);
  assert.equal(updated.participantId, target.participantId);
  assert.equal(updated.type, target.type);
  assert.deepEqual(result.messages[0], base.messages[0]);
  assert.deepEqual(result.messages[2], base.messages[2]);
  assert.equal(JSON.stringify(base), snapshot);

  assert.throws(
    () => applyGenerationEvent(base, { type: 'message-delta', id: 'm-404', text: 'x' }),
    /找不到目标消息/,
  );
  assert.throws(
    () => applyGenerationEvent(base, { type: 'message-delta', id: target.id, text: 42 }),
    /必须是字符串/,
  );
});

test('asset events set avatars and message images, rejecting unsafe data', () => {
  const base = createScene('weekend');
  const withAvatar = applyGenerationEvent(base, {
    type: 'asset',
    targetId: 'p-ayuan',
    kind: 'avatar',
    dataUrl: AVATAR,
  });
  assert.equal(withAvatar.participants.find((p) => p.id === 'p-ayuan').avatar, AVATAR);
  assert.equal(base.participants.find((p) => p.id === 'p-ayuan').avatar, undefined);

  const withImage = applyGenerationEvent(base, {
    type: 'asset',
    targetId: base.messages[0].id,
    kind: 'message',
    dataUrl: IMAGE,
  });
  assert.equal(withImage.messages.find((m) => m.id === base.messages[0].id).asset, IMAGE);
  assert.equal(base.messages[0].asset, undefined);

  for (const unsafe of [
    'https://example.com/tracker.png',
    'data:text/html;base64,YQ==',
    'data:image/svg+xml;base64,YQ==',
    'javascript:alert(1)',
  ]) {
    assert.throws(
      () => applyGenerationEvent(base, { type: 'asset', targetId: 'p-ayuan', kind: 'avatar', dataUrl: unsafe }),
      /Data URL/,
    );
  }
  assert.throws(
    () =>
      applyGenerationEvent(base, {
        type: 'asset',
        targetId: 'p-ayuan',
        kind: 'avatar',
        dataUrl: 'data:image/png;base64,' + 'A'.repeat(6 * 1024 * 1024),
      }),
    /Data URL/,
  );
  assert.throws(
    () => applyGenerationEvent(base, { type: 'asset', targetId: 'p-ghost', kind: 'avatar', dataUrl: AVATAR }),
    /找不到头像目标/,
  );
  assert.throws(
    () => applyGenerationEvent(base, { type: 'asset', targetId: 'm-404', kind: 'message', dataUrl: IMAGE }),
    /找不到消息目标/,
  );
  assert.throws(
    () => applyGenerationEvent(base, { type: 'asset', targetId: 'p-ayuan', kind: 'photo', dataUrl: AVATAR }),
    /kind/,
  );
});

test('status and done leave the scene untouched but reject corrupt scenes', () => {
  const base = createScene('weekend');
  assert.strictEqual(
    applyGenerationEvent(base, { type: 'status', stage: 'writing', message: '写' }),
    base,
  );
  assert.strictEqual(applyGenerationEvent(base, { type: 'done' }), base);
  assert.equal(applyGenerationEvent(null, { type: 'done' }), null);
  assert.equal(applyGenerationEvent(null, { type: 'status', stage: 'assets', message: 'x' }), null);
  assert.throws(
    () => applyGenerationEvent(base, { type: 'status', stage: 'nope', message: 'x' }),
    /stage/,
  );
  const corrupt = createScene('weekend');
  corrupt.messages[0].type = 'unknown';
  assert.throws(() => applyGenerationEvent(corrupt, { type: 'done' }), /无效场景/);
});

/* ------------------------------------------------------------------ */
/* isMarsPrompt                                                        */
/* ------------------------------------------------------------------ */

test('isMarsPrompt recognises only requests that name both Musk and Mars', () => {
  assert.equal(isMarsPrompt(MARS_PROMPT), true);
  assert.equal(isMarsPrompt('让马斯克带我去火星'), true);
  assert.equal(isMarsPrompt('elon musk flies to MARS'), true);
  assert.equal(isMarsPrompt('写一段周末看海的双人对话'), false);
  assert.equal(isMarsPrompt('只有马斯克出镜'), false);
  assert.equal(isMarsPrompt('只去火星'), false);
  assert.equal(isMarsPrompt(''), false);
  assert.equal(isMarsPrompt(null), false);
  assert.equal(isMarsPrompt(42), false);
});

/* ------------------------------------------------------------------ */
/* streamDemo — authored local fiction                                 */
/* ------------------------------------------------------------------ */

test('streamDemo writes the Mars fiction incrementally and ends with done', async () => {
  const events = await collect(
    streamDemo({
      prompt: MARS_PROMPT,
      platform: 'wechat',
      avatar: AVATAR,
      image: IMAGE,
      now: new Date(2026, 8, 20, 10, 30),
      delayMs: 0,
    }),
  );

  assert.equal(events.filter((event) => event.type === 'done').length, 1);
  assert.equal(events.at(-1).type, 'done');
  assert.deepEqual(
    events.filter((event) => event.type === 'status').map((event) => event.stage),
    ['understanding', 'writing', 'assets'],
  );
  assert.ok(events.some((event) => event.type === 'message-delta'));

  const sceneEvent = events.find((event) => event.type === 'scene');
  assert.equal(sceneEvent.scene.id, DEMO_SCENE_ID);
  assert.equal(sceneEvent.scene.title, '明天，火星见');
  assert.equal(sceneEvent.scene.selfId, 'me');
  assert.equal(sceneEvent.scene.watermark, '虚构场景 · AI 合成');
  assert.equal(sceneEvent.scene.date, '2026-09-21');
  assert.deepEqual(
    sceneEvent.scene.participants.map((p) => [p.id, p.name]),
    [
      ['me', '我'],
      ['elon', 'Elon Musk'],
    ],
  );

  const final = applyAll(events);
  assert.equal(validateScene(final).ok, true);
  assert.equal(final.messages.length, 6);
  assert.ok(final.messages.every((message) => message.time === ''));
  assert.equal(
    final.messages[0].text,
    '明天有空吗？我想和你一起去火星漫游。',
  );
  assert.equal(final.messages[2].type, 'location');
  assert.equal(final.messages[2].text, '火星 · 杰泽罗陨石坑');
  assert.equal(final.messages.at(-1).text, '明天见。');

  const photo = final.messages.find((message) => message.id === DEMO_PHOTO_MESSAGE_ID);
  assert.equal(photo.type, 'image');
  assert.equal(photo.text, '火星合影');
  assert.equal(photo.asset, IMAGE);

  assert.equal(final.participants.find((p) => p.id === 'elon').avatar, AVATAR);
  assert.equal(final.participants.find((p) => p.id === 'me').avatar, undefined);
});

test('streamDemo resolves tomorrow in local time across month/year/leap boundaries', async () => {
  const sceneDate = async (now) => {
    const events = await collect(
      streamDemo({ prompt: MARS_PROMPT, platform: 'wechat', now, delayMs: 0 }),
    );
    return events.find((event) => event.type === 'scene').scene.date;
  };

  assert.equal(await sceneDate(new Date(2026, 7, 31, 23, 30)), '2026-09-01');
  assert.equal(await sceneDate(new Date(2026, 11, 31, 23, 30)), '2027-01-01');
  assert.equal(await sceneDate(new Date(2028, 1, 28, 12, 0)), '2028-02-29');
  assert.equal(await sceneDate(new Date(2027, 1, 28, 12, 0)), '2027-03-01');
});

test('streamDemo rejects unrelated prompts instead of silently producing Mars', async () => {
  await assert.rejects(
    () => collect(streamDemo({ prompt: '写一段周末看海的双人对话', platform: 'wechat', delayMs: 0 })),
    /Elon Musk|火星/,
  );
  await assert.rejects(
    () => collect(streamDemo({ prompt: 42, platform: 'wechat', delayMs: 0 })),
    /prompt/,
  );
});

test('streamDemo abort is safe before the first yield and between yields', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    () => collect(streamDemo({ prompt: MARS_PROMPT, platform: 'wechat', delayMs: 0 }, before.signal)),
    (error) => error.name === 'AbortError',
  );

  const controller = new AbortController();
  let seen = 0;
  await assert.rejects(
    (async () => {
      for await (const _event of streamDemo(
        { prompt: MARS_PROMPT, platform: 'wechat', avatar: AVATAR, image: IMAGE, delayMs: 5 },
        controller.signal,
      )) {
        seen += 1;
        if (seen === 1) controller.abort();
      }
    })(),
    (error) => error.name === 'AbortError',
  );
  assert.equal(seen, 1);
});

/* ------------------------------------------------------------------ */
/* streamRemote — provider NDJSON contract                             */
/* ------------------------------------------------------------------ */

test('streamRemote parses CRLF NDJSON split across UTF-8 chunk boundaries', async (t) => {
  const base = createScene('weekend');
  const events = [
    { type: 'scene', scene: { ...base, id: 'scene-remote', messages: [] } },
    { type: 'status', stage: 'writing', message: '写作中' },
    {
      type: 'message',
      message: { id: 'm-remote-1', participantId: 'p-linxiaoman', type: 'text', text: '', time: '' },
    },
    { type: 'message-delta', id: 'm-remote-1', text: '你好，' },
    { type: 'message-delta', id: 'm-remote-1', text: '火星🌟' },
    { type: 'done' },
  ];
  let captured;
  mockFetch(t, async (url, init) => {
    captured = { url, init };
    return responseFromLines(events.map((event) => JSON.stringify(event)), { chunkSize: 5 });
  });

  const received = await collect(streamRemote({ prompt: '去火星', platform: 'wechat' }));
  assert.equal(received.at(-1).type, 'done');
  assert.equal(captured.url, '/api/scenes/stream');
  assert.equal(captured.init.method, 'POST');
  assert.match(captured.init.headers['Content-Type'], /application\/json/);
  assert.match(captured.init.headers.Accept, /application\/x-ndjson/);
  const sent = JSON.parse(captured.init.body);
  assert.equal(sent.prompt, '去火星');
  assert.equal(sent.platform, 'wechat');

  const final = applyAll(received);
  assert.equal(final.id, 'scene-remote');
  assert.equal(final.messages[0].text, '你好，火星🌟');
  assert.equal(validateScene(final).ok, true);
});

test('streamRemote rejects premature EOF without a done event', async (t) => {
  const base = createScene('weekend');
  const lines = [
    JSON.stringify({ type: 'scene', scene: { ...base, messages: [] } }),
    JSON.stringify({
      type: 'message',
      message: { id: 'm-remote-1', participantId: 'p-linxiaoman', type: 'text', text: 'hi', time: '' },
    }),
  ];
  mockFetch(t, async () => responseFromLines(lines));
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' })),
    /提前结束|done/,
  );
});

test('streamRemote rejects malformed, unknown and oversized events', async (t) => {
  const base = createScene('weekend');

  mockFetch(t, async () =>
    responseFromLines([JSON.stringify({ type: 'scene', scene: base }), '{not json']),
  );
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' })),
    /无法解析/,
  );

  mockFetch(t, async () =>
    responseFromLines([JSON.stringify({ type: 'scene', scene: base }), JSON.stringify({ type: 'nope' })]),
  );
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' })),
    /未知/,
  );

  const oversized = JSON.stringify({
    type: 'status',
    stage: 'writing',
    message: 'x',
    pad: 'a'.repeat(7 * 1024 * 1024 + 64),
  });
  mockFetch(t, async () => responseFromLines([oversized], { chunkSize: 65536 }));
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' })),
    /大小限制/,
  );
});

test('streamRemote surfaces provider error records and HTTP failures in Chinese', async (t) => {
  const base = createScene('weekend');
  mockFetch(t, async () =>
    responseFromLines([
      JSON.stringify({ type: 'scene', scene: base }),
      JSON.stringify({ type: 'error', message: '模型不可用' }),
    ]),
  );
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' })),
    /模型不可用/,
  );

  mockFetch(
    t,
    async () =>
      new Response('boom', {
        status: 500,
        headers: { 'Content-Type': 'application/x-ndjson' },
      }),
  );
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' })),
    /HTTP 500/,
  );

  mockFetch(
    t,
    async () =>
      new Response('missing', {
        status: 404,
        headers: { 'Content-Type': 'application/x-ndjson' },
      }),
  );
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' })),
    /真实生成服务尚未接入/,
  );
});

test('streamRemote validates content type and never falls back to the local demo', async (t) => {
  mockFetch(
    t,
    async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  );
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' })),
    /内容类型/,
  );

  mockFetch(t, async () => {
    throw new TypeError('fetch failed');
  });
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' })),
    /无法连接生成服务/,
  );
});

test('streamRemote rejects an invalid previousScene before calling the provider', async (t) => {
  let called = false;
  mockFetch(t, async () => {
    called = true;
    return responseFromLines(['']);
  });
  await assert.rejects(
    () =>
      collect(
        streamRemote({ prompt: 'x', platform: 'wechat', previousScene: { id: 'broken' } }),
      ),
    /previousScene/,
  );
  assert.equal(called, false);
});

test('streamRemote honours an already-aborted signal without fetching', async (t) => {
  let called = false;
  mockFetch(t, async () => {
    called = true;
    return responseFromLines(['']);
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => collect(streamRemote({ prompt: 'x', platform: 'wechat' }, controller.signal)),
    (error) => error.name === 'AbortError',
  );
  assert.equal(called, false);
});

test('streamRemote cancels and releases the reader when the consumer stops', async (t) => {
  const base = createScene('weekend');
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(JSON.stringify({ type: 'scene', scene: base }) + '\n'),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  mockFetch(
    t,
    async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
  );

  for await (const event of streamRemote({ prompt: 'x', platform: 'wechat' })) {
    assert.equal(event.type, 'scene');
    break;
  }
  assert.equal(cancelled, true);
});

test('streamRemote abort cancels the reader and surfaces AbortError', async (t) => {
  const base = createScene('weekend');
  let cancelled = false;
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(inner) {
      inner.enqueue(encoder.encode(JSON.stringify({ type: 'scene', scene: base }) + '\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  mockFetch(
    t,
    async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }),
  );

  const iterator = streamRemote({ prompt: 'x', platform: 'wechat' }, controller.signal);
  const first = await iterator.next();
  assert.equal(first.value.type, 'scene');
  controller.abort();
  await assert.rejects(() => iterator.next(), (error) => error.name === 'AbortError');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});


test('remote image events may exceed 1MB while staying within the raster limit', async (t) => {
  const scene = createScene('weekend');
  scene.messages = [{ id: 'image-large', participantId: scene.selfId, type: 'image', text: '合成示例', time: '' }];
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(1200000);
  mockFetch(t, async () => responseFromLines([
    JSON.stringify({type:'scene',scene}),
    JSON.stringify({type:'asset',targetId:'image-large',kind:'message',dataUrl}),
    JSON.stringify({type:'done'}),
  ], {chunkSize:65536}));
  const result = applyAll(await collect(streamRemote({prompt:'照片',platform:'wechat'})));
  assert.equal(result.messages[0].asset.length,dataUrl.length);
});

test('remote done must be terminal and cannot certify missing images', async (t) => {
  const scene = createScene('weekend');
  mockFetch(t,async()=>responseFromLines([
    JSON.stringify({type:'scene',scene}),JSON.stringify({type:'done'}),
    JSON.stringify({type:'message-delta',id:scene.messages[0].id,text:'late'}),
  ]));
  await assert.rejects(()=>collect(streamRemote({prompt:'x',platform:'wechat'})),/done 之后/);
  scene.messages = [{id:'incomplete',participantId:scene.selfId,type:'image',text:'等待图片',time:''}];
  globalThis.fetch=async()=>responseFromLines([JSON.stringify({type:'scene',scene}),JSON.stringify({type:'done'})]);
  await assert.rejects(()=>collect(streamRemote({prompt:'x',platform:'wechat'})),/未完成的图片/);
});

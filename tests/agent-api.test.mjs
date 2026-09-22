/**
 * HTTP integration tests for the IMStage agent endpoints.
 *
 * Prerequisites: `POST /api/agent/run` is protected by the existing
 * Origin + request-marker + session checks, responds with NDJSON only after
 * validation, and always releases its concurrency/rate lease. The provider is
 * injected, so no network call or credential is involved.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { start } from '../services/api/server.mjs';
import { AGENT_BODY_LIMIT } from '../services/agent/index.mjs';
import { createScene } from '../apps/web/src/studio/model.ts';

/* ------------------------------------------------------------------ */
/* Scoped runtime directory                                            */
/* ------------------------------------------------------------------ */

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-agent-api-'));

const APP_ORIGIN = 'http://127.0.0.1:4417';
const activeApps = new Set();

function caseDir(label) {
  return fs.mkdtempSync(path.join(RUNTIME_ROOT, `${label}-`));
}

async function makeAgentApp(agentOverrides = {}) {
  const dir = caseDir('case');
  const app = await start({
    dbPath: path.join(dir, 'imstage.db'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
    env: {},
    agent: agentOverrides,
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}`, dir };
}

after(async () => {
  for (const app of activeApps) {
    try {
      await app.close();
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Fake providers                                                      */
/* ------------------------------------------------------------------ */

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
      calls.push({ messages: JSON.parse(JSON.stringify(messages)), toolNames: tools.map((t) => t.function.name) });
      if (signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      return step;
    },
  };
}

/** Blocks the first completion until released/aborted; later calls finish. */
function gateProvider() {
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const state = { started: 0, release: () => releaseGate() };
  const provider = {
    async complete({ signal }) {
      state.started += 1;
      if (state.started > 1) return finalResponse('结束');
      return new Promise((resolve, reject) => {
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
        gate.then(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve(finalResponse('结束'));
        });
      });
    },
  };
  return { provider, state };
}

const fakeImageProvider = {
  calls: [],
  async generate({ prompt }) {
    this.calls.push(prompt);
    return { dataUrl: 'data:image/png;base64,AAAA', mime: 'image/png', bytes: 4 };
  },
};

const AGENT_EVENT_KEYS = {
  scene: ['type', 'scene'],
  tool: ['type', 'id', 'name', 'state', 'detail'],
  assistant: ['type', 'text'],
  done: ['type'],
  error: ['type', 'message'],
};

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `agent-${process.pid}-${emailSeq}@example.com`;
}

function mutationHeaders(cookie, extras = {}) {
  const headers = {
    'content-type': 'application/json',
    origin: APP_ORIGIN,
    'x-imstage-request': '1',
    ...extras,
  };
  if (cookie) headers.cookie = cookie;
  return headers;
}

function cookieFrom(res, name = 'imstage_session') {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${name}=([^;]*)`).exec(setCookie);
  return match && match[1] !== '' ? `${name}=${match[1]}` : null;
}

async function register(base) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify({ name: 'Agent 用户', email: uniqueEmail(), password: 'password-123456' }),
  });
  assert.equal(res.status, 200);
  return cookieFrom(res);
}

function runBody(overrides = {}) {
  return { prompt: '把最后一句改得更轻松一点', scene: createScene('weekend'), ...overrides };
}

async function postRun(base, body, { cookie, headers } = {}) {
  return fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(cookie, headers),
    body: JSON.stringify(body),
  });
}

async function readNdjson(res) {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs = 3_000) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function mutatedProvider(text = 'API 修改后的台词') {
  const base = createScene('weekend');
  const message = base.messages.find((item) => item.id === 'm-4');
  return scriptedProvider([
    toolResponse(
      'upsert_message',
      {
        message: {
          id: 'm-4',
          participantId: message.participantId,
          type: message.type,
          text,
          time: message.time,
        },
      },
      { id: 'api-1' },
    ),
    finalResponse('已完成修改。'),
  ]);
}

/* ------------------------------------------------------------------ */
/* Capabilities                                                        */
/* ------------------------------------------------------------------ */

test('GET /api/agent/capabilities is public and exposes only non-secret status', async () => {
  const secret = 'sk-super-secret-key';
  const { base } = await makeAgentApp({
    chatProvider: mutatedProvider(),
    imageProvider: fakeImageProvider,
    apiKey: secret,
    imageApiKey: 'img-super-secret',
  });

  const res = await fetch(`${base}/api/agent/capabilities`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['configured', 'imageConfigured', 'model']);
  assert.equal(body.configured, true);
  assert.equal(body.imageConfigured, true);
  assert.equal(body.model, 'deepseek-flash');

  const raw = JSON.stringify(body);
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes('img-super-secret'), false);
});

test('GET /api/agent/capabilities reports unconfigured without a provider', async () => {
  const { base } = await makeAgentApp({});
  const res = await fetch(`${base}/api/agent/capabilities`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.configured, false);
  assert.equal(body.imageConfigured, false);
  assert.equal(body.model, 'deepseek-flash');

  const notGet = await fetch(`${base}/api/agent/capabilities`, { method: 'POST' });
  assert.equal(notGet.status, 405);
});

/* ------------------------------------------------------------------ */
/* Auth + CSRF                                                         */
/* ------------------------------------------------------------------ */

test('POST /api/agent/run requires a session, matching Origin and the request marker', async () => {
  const { base } = await makeAgentApp({ chatProvider: mutatedProvider() });
  const cookie = await register(base);
  const body = JSON.stringify(runBody());

  const anonymous = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body,
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).error.code, 'unauthorized');

  const noOrigin = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-imstage-request': '1', cookie },
    body,
  });
  assert.equal(noOrigin.status, 403);
  assert.equal((await noOrigin.json()).error.code, 'origin_required');

  const badOrigin = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: { ...mutationHeaders(cookie), origin: 'http://evil.example' },
    body,
  });
  assert.equal(badOrigin.status, 403);
  assert.equal((await badOrigin.json()).error.code, 'origin_mismatch');

  const noMarker = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP_ORIGIN, cookie },
    body,
  });
  assert.equal(noMarker.status, 403);
  assert.equal((await noMarker.json()).error.code, 'request_marker_required');

  const wrongMethod = await fetch(`${base}/api/agent/run`, { headers: { cookie } });
  assert.equal(wrongMethod.status, 405);
});

test('POST /api/agent/run is denied with 503 when the AI service is not configured', async () => {
  const { base } = await makeAgentApp({});
  const cookie = await register(base);
  const res = await postRun(base, runBody(), { cookie });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, 'ai_not_configured');
});

/* ------------------------------------------------------------------ */
/* Admitted NDJSON stream                                              */
/* ------------------------------------------------------------------ */

test('POST /api/agent/run streams admitted NDJSON with the exact event union', async () => {
  const provider = mutatedProvider();
  const { base } = await makeAgentApp({ chatProvider: provider, imageProvider: fakeImageProvider });
  const cookie = await register(base);

  const res = await postRun(base, runBody(), { cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/x-ndjson/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const events = await readNdjson(res);
  for (const event of events) {
    assert.deepEqual(
      Object.keys(event).sort(),
      AGENT_EVENT_KEYS[event.type].slice().sort(),
      `unexpected shape: ${JSON.stringify(event)}`,
    );
  }
  assert.equal(events[0].type, 'scene');
  assert.equal(events.at(-1).type, 'done');
  assert.ok(events.some((event) => event.type === 'tool' && event.state === 'running'));
  assert.ok(events.some((event) => event.type === 'tool' && event.state === 'done'));
  assert.ok(events.some((event) => event.type === 'assistant'));

  const sceneEvents = events.filter((event) => event.type === 'scene');
  const finalScene = sceneEvents.at(-1).scene;
  assert.equal(finalScene.messages.find((message) => message.id === 'm-4').text, 'API 修改后的台词');

  // The provider actually received the scene context and tool schemas.
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(provider.calls[0].toolNames, [
    'update_element',
    'create_scene',
    'upsert_message',
    'delete_message',
    'generate_image',
  ]);
  assert.match(JSON.stringify(provider.calls[0].messages), /用户请求/);
});

test('POST /api/agent/run validates prompt, scene, target, attachments and history', async () => {
  const { base } = await makeAgentApp({ chatProvider: mutatedProvider() });
  const cookie = await register(base);

  const cases = [
    [{ ...runBody(), prompt: 'x'.repeat(4001) }, 'invalid_prompt'],
    [{ ...runBody(), prompt: '   ' }, 'invalid_prompt'],
    [{ prompt: '改', scene: { id: 'broken' } }, 'invalid_scene'],
    [
      {
        ...runBody(),
        scene: {
          ...createScene('weekend'),
          messages: Array.from({ length: 201 }, (_value, index) => ({
            id: `m-${index}`,
            participantId: 'p-linxiaoman',
            type: 'text',
            text: 'ok',
            time: '09:00',
          })),
        },
      },
      'invalid_scene',
    ],
    [{ ...runBody(), targetId: 'm-missing' }, 'invalid_target'],
    [
      { ...runBody(), attachments: Array.from({ length: 4 }, () => 'data:image/png;base64,AAAA') },
      'invalid_attachments',
    ],
    [{ ...runBody(), attachments: ['https://evil.example/x.png'] }, 'invalid_attachments'],
    [
      { ...runBody(), history: Array.from({ length: 13 }, () => ({ role: 'user', content: 'hi' })) },
      'invalid_history',
    ],
    [{ ...runBody(), history: [{ role: 'system', content: 'hi' }] }, 'invalid_history'],
  ];

  for (const [body, code] of cases) {
    const res = await postRun(base, body, { cookie });
    assert.equal(res.status, 400, `expected 400 for ${code}`);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal((await res.json()).error.code, code);
  }

  // A valid bounded request with all optional fields still succeeds.
  const ok = await postRun(
    base,
    runBody({
      targetId: 'm-4',
      attachments: ['data:image/png;base64,AAAA'],
      history: [{ role: 'user', content: '之前说过' }],
    }),
    { cookie },
  );
  assert.equal(ok.status, 200);
  const events = await readNdjson(ok);
  assert.equal(events.at(-1).type, 'done');
});

test('POST /api/agent/run surfaces an unconfigured image tool as a failed event, not success', async () => {
  const base = createScene('weekend');
  base.messages = [
    ...base.messages,
    { id: 'm-img', participantId: 'p-ayuan', type: 'image', text: '一张照片', time: '09:41' },
  ];
  const provider = scriptedProvider([
    toolResponse('generate_image', { targetId: 'm-img', kind: 'message', prompt: '一张图' }, { id: 'img' }),
    toolResponse(
      'upsert_message',
      { message: { id: 'm-4', participantId: 'p-ayuan', type: 'text', text: '没有图也可以', time: '09:41' } },
      { id: 'txt' },
    ),
    finalResponse('图片服务未配置，已用文字完成。'),
  ]);
  const { base: url } = await makeAgentApp({ chatProvider: provider, imageProvider: null });
  const cookie = await register(url);

  const res = await postRun(url, { prompt: '配图并改一句', scene: base }, { cookie });
  assert.equal(res.status, 200);
  const events = await readNdjson(res);
  const imageError = events.find((event) => event.type === 'tool' && event.name === 'generate_image' && event.state === 'error');
  assert.ok(imageError, 'image failure must be visible');
  assert.match(imageError.detail, /未配置/);
  assert.ok(events.some((event) => event.type === 'tool' && event.state === 'done'));
  assert.equal(events.at(-1).type, 'error');
});

/* ------------------------------------------------------------------ */
/* Concurrency, rate limits and cleanup                                */
/* ------------------------------------------------------------------ */

test('agent runs enforce per-user and global active limits and release on finish', async () => {
  const gate = gateProvider();
  const { base } = await makeAgentApp({
    chatProvider: gate.provider,
    limits: {
      activeGlobal: 1,
      activePerUser: 1,
      rate: { windowMs: 60_000, max: 100, maxKeys: 100 },
    },
  });
  const cookie = await register(base);

  const first = await postRun(base, runBody(), { cookie });
  assert.equal(first.status, 200);
  await waitFor(() => gate.state.started >= 1);

  const second = await postRun(base, runBody(), { cookie });
  assert.equal(second.status, 429);
  const limited = await second.json();
  assert.equal(limited.error.code, 'rate_limited');
  assert.ok(Number(second.headers.get('retry-after')) >= 1);

  gate.state.release();
  await first.text();

  // The lease must be released after the first run finished.
  const third = await postRun(base, runBody(), { cookie });
  assert.equal(third.status, 200);
  const events = await readNdjson(third);
  assert.equal(events.at(-1).type, 'error'); // gate returns a no-op final answer
});

test('agent rate limiting is bounded per user and returns Retry-After', async () => {
  const { base } = await makeAgentApp({
    chatProvider: mutatedProvider(),
    limits: {
      activeGlobal: 4,
      activePerUser: 2,
      rate: { windowMs: 60_000, max: 1, maxKeys: 100 },
    },
  });
  const cookie = await register(base);

  const first = await postRun(base, runBody(), { cookie });
  assert.equal(first.status, 200);
  await readNdjson(first);

  const second = await postRun(base, runBody(), { cookie });
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'rate_limited');
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
});

test('the run lease and stream are cleaned up when the client disconnects', async () => {
  const gate = gateProvider();
  const { base } = await makeAgentApp({
    chatProvider: gate.provider,
    limits: {
      activeGlobal: 1,
      activePerUser: 1,
      rate: { windowMs: 60_000, max: 100, maxKeys: 100 },
    },
  });
  const cookie = await register(base);

  const controller = new AbortController();
  const res = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify(runBody()),
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  await waitFor(() => gate.state.started >= 1);

  controller.abort();
  // Give the server a moment to run the abort/finally path.
  await waitFor(() => gate.state.started >= 1);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const after = await postRun(base, runBody(), { cookie });
  assert.equal(after.status, 200, 'lease must be released after a disconnect');
  await readNdjson(after);
});

test('a non-reading client cannot hold the run lease past the whole-run deadline', async () => {
  const HUGE = 'A'.repeat(4 * 1024 * 1024);
  const provider = scriptedProvider([
    toolResponse(
      'upsert_message',
      {
        message: {
          id: 'm-4',
          participantId: 'p-ayuan',
          type: 'text',
          text: HUGE,
          time: '09:41',
        },
      },
      { id: 'big' },
    ),
    finalResponse('完成'),
  ]);
  const { base } = await makeAgentApp({
    chatProvider: provider,
    limits: {
      activeGlobal: 1,
      activePerUser: 1,
      rate: { windowMs: 60_000, max: 100, maxKeys: 100 },
    },
    deadlineMs: 300,
  });
  const cookie = await register(base);

  // Raw client that never reads the body: the ~4 MiB scene write hits real
  // socket backpressure. The whole-run deadline must abort that wait, release
  // the lease and let a later run be admitted. (The abortable-wait itself is
  // covered deterministically by the isolated writeNdjsonLine tests.)
  const firstStatus = await new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/api/agent/run`,
      { method: 'POST', headers: mutationHeaders(cookie) },
      (res) => {
        resolve(res.statusCode);
        res.on('error', () => {});
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(runBody()));
  });
  assert.equal(firstStatus, 200);

  const started = Date.now();
  let after = null;
  for (;;) {
    after = await postRun(base, runBody(), { cookie });
    if (after.status === 200) break;
    if (Date.now() - started > 6_000) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(after.status, 200, 'the run lease must be released after the deadline');
  assert.ok(Date.now() - started < 6_000, 'recovery must be bounded');
  const events = await readNdjson(after);
  assert.ok(
    events.length > 0 && ['done', 'error'].includes(events.at(-1).type),
    'the later run must terminate',
  );
});

test('an oversized agent body is rejected with 413 before streaming', async () => {
  const { base } = await makeAgentApp({ chatProvider: mutatedProvider() });
  const cookie = await register(base);
  const huge = 'a'.repeat(AGENT_BODY_LIMIT + 1024 * 1024);
  const res = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ prompt: 'x', scene: { id: 'broken' }, pad: huge }),
  });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'payload_too_large');
});

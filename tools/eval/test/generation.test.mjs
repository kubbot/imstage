import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createEvalServer } from '../server.mjs';
import { encodePng } from '../src/png.mjs';
import { cleanupDir, tempDataDir } from './helpers.mjs';
import {
  AppError,
} from '../src/util.mjs';
import {
  buildProviderRequestBody,
  callDeepSeekScene,
  detectLanguage,
  normalizeGenerationInput,
  parseSceneResponse,
  publicGenerationStatus,
  resolveAiConfig,
} from '../src/generation.mjs';
import {
  ConversationSchemaError,
  validateConversationScene,
} from '../../../packages/schema/conversation.mjs';
import { renderSceneHtml } from '../../../packages/renderer/renderSceneHtml.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pngBuffer(width, height) {
  return encodePng({ width, height, data: Buffer.alloc(width * height * 4, 0xff) });
}

function validScene(overrides = {}) {
  const scene = {
    title: '测试群聊',
    platform: 'wechat',
    deviceTime: '09:41',
    date: '2026-01-01',
    selfId: 'me',
    participants: [
      { id: 'me', name: '我' },
      { id: 'p1', name: '小林' },
    ],
    messages: [
      { id: 'm1', participantId: 'p1', type: 'text', text: '在吗？', time: '09:40' },
      { id: 'm2', participantId: 'me', type: 'text', text: '在的。', time: '09:41' },
    ],
    watermark: '',
    ...overrides,
  };
  return { scene, warnings: ['截图中有一处文字不清晰'] };
}

function makeFakeGenerate(responder) {
  const calls = [];
  const fn = async (ctx) => {
    calls.push(ctx);
    const raw = typeof responder === 'function' ? await responder(ctx, calls.length) : responder;
    return { rawContent: typeof raw === 'string' ? raw : JSON.stringify(raw), model: 'fake-vision-1' };
  };
  fn.calls = calls;
  return fn;
}

function makeFakeRender({ longHeight = 1234 } = {}) {
  const calls = [];
  const fn = async (scene, opts) => {
    calls.push({ scene, opts });
    const height = opts.outputKind === 'long-screenshot' ? longHeight : opts.height;
    const buffer = pngBuffer(opts.width, height);
    return { buffer, width: opts.width, height };
  };
  fn.calls = calls;
  return fn;
}

async function launchGen({ generateScene, renderScene, aiConfig, dataDir } = {}) {
  const dir = dataDir ?? tempDataDir('gen');
  await fs.promises.mkdir(dir, { recursive: true });
  const server = createEvalServer({ dataDir: dir, port: 0, aiConfig, generateScene, renderScene });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function request(method, urlPath, body, { omitOrigin = false, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !omitOrigin && !h.Origin) h.Origin = base;
    const res = await fetch(base + urlPath, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json, headers: res.headers, text };
  }

  function rawGenerate(body, { destroyAfterMs } = {}) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/generate',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: base,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', (err) => {
        if (destroyAfterMs !== undefined) resolve({ status: 0, error: err.message });
        else reject(err);
      });
      req.write(payload);
      req.end();
      if (destroyAfterMs !== undefined) {
        setTimeout(() => req.destroy(), destroyAfterMs);
      }
    });
  }

  async function closeServer() {
    await new Promise((resolve) => server.close(resolve));
  }

  async function close() {
    await closeServer();
    await cleanupDir(dir);
  }

  return { server, store: server.store, base, port, dataDir: dir, request, rawGenerate, closeServer, close };
}

async function revisionOf(env) {
  const res = await env.request('GET', '/api/store');
  return res.json.revision;
}

const IMAGE_BASE64 = pngBuffer(8, 8).toString('base64');

// ---------------------------------------------------------------------------
// GET /api/generation
// ---------------------------------------------------------------------------

test('GET /api/generation reports configuration without secrets or host URLs', async (t) => {
  const secretKey = 'sk-SUPER-SECRET-KEY';
  const env = await launchGen({
    aiConfig: {
      configured: false,
      apiKey: secretKey,
      baseUrl: 'https://secret-host.example.com/v1',
      model: 'deepseek-flash',
      maxTokens: 4500,
      timeoutMs: 60000,
      disableThinking: true,
    },
  });
  t.after(() => env.close());
  const res = await env.request('GET', '/api/generation');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {
    configured: false,
    model: 'deepseek-flash',
    images: true,
    defaults: { targetIM: 'wechat', surface: 'ios', outputKind: 'screenshot' },
  });
  assert.equal(res.text.includes(secretKey), false);
  assert.equal(res.text.includes('secret-host'), false);
});

test('GET /api/generation reflects a configured provider', async (t) => {
  const env = await launchGen({
    aiConfig: { configured: true, apiKey: 'k', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
  });
  t.after(() => env.close());
  const res = await env.request('GET', '/api/generation');
  assert.equal(res.json.configured, true);
  assert.equal(res.json.model, 'deepseek-flash');
  assert.equal(res.json.images, true);
});

// ---------------------------------------------------------------------------
// Text generation
// ---------------------------------------------------------------------------

test('text generation creates a fresh unreviewed case with AI provenance', async (t) => {
  const generateScene = makeFakeGenerate(() => validScene());
  const renderScene = makeFakeRender();
  const env = await launchGen({ generateScene, renderScene });
  t.after(() => env.close());

  const res = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-text-0001',
    input: { text: '生成一条微信聊天：朋友问我周末爬山吗' },
  });
  assert.equal(res.status, 200, res.text);
  const c = res.json.case;
  assert.equal(res.json.revision, 1);
  assert.equal(c.question, '生成一条微信聊天：朋友问我周末爬山吗');
  assert.equal(c.inputLanguage, 'zh-CN');
  assert.equal(c.targetIM, 'wechat');
  assert.equal(c.surface, 'ios');
  assert.equal(c.outputKind, 'screenshot');
  assert.equal(c.width, 390);
  assert.equal(c.height, 844);
  assert.equal(c.synthetic, false);
  assert.equal(c.review, null);
  assert.equal(c.golden, null);
  assert.equal(c.computed.candidateCurrent, true);
  assert.equal(c.computed.goldenCurrent, false);
  assert.equal(c.computed.exportable, false);
  assert.equal(c.attachments.length, 0);
  assert.equal(c.candidate.provenance.kind, 'ai-generated');
  assert.equal(c.candidate.provenance.model, 'fake-vision-1');
  assert.equal(c.candidate.provenance.promptVersion, 'v1');
  assert.equal(c.candidate.provenance.rendererVersion, 'v1');
  assert.equal(typeof c.candidate.provenance.generatedAt, 'string');
  assert.equal(c.generation.requestId, 'req-text-0001');
  assert.equal(c.generation.scene.platform, 'wechat');
  assert.equal(c.generation.scene.messages.length, 2);
  assert.ok(Array.isArray(res.json.warnings));

  // The candidate PNG is served and is genuinely a PNG.
  const png = await env.request('GET', `/api/cases/${c.id}/candidate.png`);
  assert.equal(png.status, 200);
  assert.match(png.headers.get('content-type'), /image\/png/);

  // No auto-approval: synthetic export is empty.
  const exported = await env.request('POST', '/api/export', { scope: 'synthetic' });
  assert.equal(exported.status, 200);
  assert.equal(exported.json.cases.length, 0);
});

test('image-only generation sends real image bytes and infers an instruction', async (t) => {
  const generateScene = makeFakeGenerate(() =>
    validScene({
      messages: [
        { id: 'm1', participantId: 'p1', type: 'image', text: '这是截图', time: '09:40', assetIndex: 0 },
        { id: 'm2', participantId: 'me', type: 'text', text: '收到', time: '09:41' },
      ],
    }),
  );
  const renderScene = makeFakeRender();
  const env = await launchGen({ generateScene, renderScene });
  t.after(() => env.close());

  const res = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-image-0001',
    input: {
      images: [{ name: 'shot.png', mime: 'image/png', dataBase64: IMAGE_BASE64 }],
    },
  });
  assert.equal(res.status, 200, res.text);
  const c = res.json.case;
  assert.equal(c.question, '[图片输入] 复现截图中的对话');
  // Language is recorded automatically from the recognized scene text.
  assert.equal(c.inputLanguage, 'zh-CN');
  assert.equal(c.attachments.length, 1);
  assert.equal(c.attachments[0].name, 'shot.png');
  assert.equal(c.attachments[0].kind, 'image');
  assert.equal(c.generation.imageCount, 1);
  assert.equal(c.generation.scene.messages[0].assetIndex, 0);

  // The provider actually received the base64 image as a data: image_url block.
  const request = generateScene.calls[0].request;
  assert.equal(request.images.length, 1);
  assert.equal(request.images[0].dataBase64, IMAGE_BASE64);
  assert.ok(request.images[0].buffer.length > 0);
  const body = buildProviderRequestBody({ model: 'deepseek-flash', maxTokens: 10, disableThinking: true }, request);
  const userContent = body.messages[1].content;
  const textBlock = userContent.find((b) => b.type === 'text');
  assert.ok(textBlock.text.includes('复现'));
  const imageBlock = userContent.find((b) => b.type === 'image_url');
  assert.equal(imageBlock.image_url.url, `data:image/png;base64,${IMAGE_BASE64}`);

  // Original screenshot is preserved as an attachment, separately from output.
  const att = c.attachments[0];
  const raw = await env.request('GET', `/api/cases/${c.id}/attachments/${att.id}/raw`);
  assert.equal(raw.status, 200);
});

test('defaults and explicit overrides choose the right viewport and platform', async (t) => {
  const generateScene = makeFakeGenerate(() => validScene({ platform: 'wechat' }));
  const renderScene = makeFakeRender({ longHeight: 1234 });
  const env = await launchGen({ generateScene, renderScene });
  t.after(() => env.close());

  // Explicit targetIM/surface override both defaults and the raw AI platform.
  const desktop = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-override-0001',
    input: {
      text: 'Render a Telegram desktop chat',
      targetIM: 'telegram',
      surface: 'desktop',
    },
  });
  assert.equal(desktop.status, 200, desktop.text);
  assert.equal(desktop.json.case.targetIM, 'telegram');
  assert.equal(desktop.json.case.surface, 'desktop');
  assert.equal(desktop.json.case.width, 720);
  assert.equal(desktop.json.case.height, 900);
  assert.equal(desktop.json.case.generation.scene.platform, 'telegram');
  assert.ok(desktop.json.warnings.some((w) => w.includes('覆盖')));

  // Long screenshot stores the measured content height, not the default.
  const long = await env.request('POST', '/api/generate', {
    revision: desktop.json.revision,
    requestId: 'req-long-0001',
    input: { text: '生成一段很长的对话', targetIM: 'whatsapp', outputKind: 'long-screenshot' },
  });
  assert.equal(long.status, 200, long.text);
  assert.equal(long.json.case.outputKind, 'long-screenshot');
  assert.equal(long.json.case.targetIM, 'whatsapp');
  assert.equal(long.json.case.width, 390);
  assert.equal(long.json.case.height, 1234);
});

// ---------------------------------------------------------------------------
// Input validation before network
// ---------------------------------------------------------------------------

test('rejects empty input, too many images and non-image input before calling AI', async (t) => {
  const generateScene = makeFakeGenerate(() => validScene());
  const env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());

  const empty = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-empty-1',
    input: { text: '' },
  });
  assert.equal(empty.status, 422);
  assert.equal(empty.json.code, 'missing_input');

  const tooMany = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-many-1',
    input: {
      text: 'x',
      images: Array.from({ length: 4 }, (_, i) => ({
        name: `a${i}.png`,
        mime: 'image/png',
        dataBase64: IMAGE_BASE64,
      })),
    },
  });
  assert.equal(tooMany.status, 422);
  assert.equal(tooMany.json.code, 'too_many_images');

  const fakeImage = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-fakeimg-1',
    input: {
      text: 'x',
      images: [{ name: 'bad.png', mime: 'image/png', dataBase64: Buffer.from('not a png').toString('base64') }],
    },
  });
  assert.equal(fakeImage.status, 422);
  assert.equal(fakeImage.json.code, 'mime_sniff_mismatch');

  const video = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-video-1',
    input: {
      text: 'x',
      images: [{ name: 'v.mp4', mime: 'video/mp4', dataBase64: Buffer.from('zzzz').toString('base64') }],
    },
  });
  assert.equal(video.status, 422);

  const oversize = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-big-1',
    input: {
      text: 'x',
      images: [
        {
          name: 'big.png',
          mime: 'image/png',
          dataBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'),
        },
      ],
    },
  });
  assert.equal(oversize.status, 422);
  assert.equal(oversize.json.code, 'file_too_large');

  // None of the invalid requests reached the provider or changed the store.
  assert.equal(generateScene.calls.length, 0);
  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 0);
  assert.equal(store.json.revision, 0);
});

// ---------------------------------------------------------------------------
// Provider failures
// ---------------------------------------------------------------------------

test('missing credentials produce a stable actionable error and no fallback scene', async (t) => {
  const env = await launchGen({
    aiConfig: {
      configured: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      maxTokens: 4500,
      timeoutMs: 60000,
      disableThinking: true,
    },
  });
  t.after(() => env.close());
  const res = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-nocreds-1',
    input: { text: '你好' },
  });
  assert.equal(res.status, 503);
  assert.equal(res.json.code, 'ai_not_configured');
  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 0);
});

test('malformed model output fails safely with no persisted case', async (t) => {
  const env = await launchGen({ renderScene: makeFakeRender() });
  t.after(() => env.close());

  for (const [label, raw, code] of [
    ['not-json', 'I cannot do that', 'ai_invalid_json'],
    ['array', JSON.stringify([1, 2, 3]), 'ai_invalid_scene'],
    [
      'unknown-participant',
      JSON.stringify({
        scene: {
          ...validScene().scene,
          messages: [{ id: 'm1', participantId: 'ghost', type: 'text', text: 'hi', time: '09:41' }],
        },
      }),
      'ai_invalid_scene',
    ],
    [
      'bad-asset-ref',
      JSON.stringify({
        scene: {
          ...validScene().scene,
          messages: [{ id: 'm1', participantId: 'me', type: 'image', text: '', time: '09:41', assetIndex: 5 }],
        },
      }),
      'ai_invalid_scene',
    ],
  ]) {
    const generateScene = makeFakeGenerate(raw);
    const serverEnv = await launchGen({ generateScene, renderScene: makeFakeRender() });
    const res = await serverEnv.request('POST', '/api/generate', {
      revision: 0,
      requestId: `req-${label}`,
      input: { text: '你好' },
    });
    assert.equal(res.status, 502, `${label}: ${res.text}`);
    assert.equal(res.json.code, code, label);
    assert.equal(res.json.error.includes(raw), false, `${label} leaked raw output`);
    const store = await serverEnv.request('GET', '/api/store');
    assert.equal(store.json.cases.length, 0, label);
    assert.equal(serverEnv.store.revision, 0, label);
    await serverEnv.close();
  }
});

test('renderer failures are truthful and never stored', async (t) => {
  const cases = [
    ['wrong-dims', async (scene, opts) => ({ buffer: pngBuffer(opts.width, opts.height + 3), width: opts.width, height: opts.height + 3 }), 502, 'render_dimension_mismatch'],
    ['not-png', async () => ({ buffer: Buffer.from('definitely not png'), width: 390, height: 844 }), 502, 'render_invalid_png'],
    ['too-tall', async () => { throw new AppError('output_too_tall', '内容过高', 422); }, 422, 'output_too_tall'],
  ];
  for (const [label, renderScene, status, code] of cases) {
    const env = await launchGen({ generateScene: makeFakeGenerate(() => validScene()), renderScene });
    const res = await env.request('POST', '/api/generate', {
      revision: 0,
      requestId: `req-render-${label}`,
      input: { text: '你好' },
    });
    assert.equal(res.status, status, `${label}: ${res.text}`);
    assert.equal(res.json.code, code, label);
    assert.equal(env.store.revision, 0, label);
    await env.close();
  }
});

test('provider HTTP/timeout errors map to safe codes without leaking the key', async () => {
  const config = {
    configured: true,
    apiKey: 'sk-SECRET-KEY-123',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    maxTokens: 4500,
    timeoutMs: 60_000,
    disableThinking: true,
  };
  const request = normalizeGenerationInput({ text: '你好' });

  const statusCases = [
    [401, 'ai_auth_failed'],
    [403, 'ai_auth_failed'],
    [429, 'ai_quota_exceeded'],
    [500, 'ai_provider_error'],
    [503, 'ai_provider_error'],
    [400, 'ai_rejected_request'],
  ];
  for (const [status, code] of statusCases) {
    await assert.rejects(
      () => callDeepSeekScene({ config, request, fetchImpl: async () => ({ ok: false, status }) }),
      (err) => {
        assert.equal(err.code, code, `status ${status}`);
        assert.equal(err.message.includes('sk-SECRET-KEY-123'), false);
        return true;
      },
    );
  }

  // Invalid JSON body from the provider.
  await assert.rejects(
    () =>
      callDeepSeekScene({
        config,
        request,
        fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('bad json'); } }),
      }),
    (err) => err.code === 'ai_invalid_response',
  );

  // Empty content.
  await assert.rejects(
    () =>
      callDeepSeekScene({
        config,
        request,
        fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) }),
      }),
    (err) => err.code === 'ai_empty_response',
  );

  // Timeout: the fetch implementation never resolves before the abort fires.
  await assert.rejects(
    () =>
      callDeepSeekScene({
        config: { ...config, timeoutMs: 20 },
        request,
        fetchImpl: (_url, opts) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      }),
    (err) => err.code === 'ai_timeout',
  );

  // Network-level failure.
  await assert.rejects(
    () => callDeepSeekScene({ config, request, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    (err) => err.code === 'ai_unreachable',
  );
});

test('provider request body uses OpenAI-compatible vision blocks and disables thinking', () => {
  const request = normalizeGenerationInput({
    text: '复现这张截图',
    images: [{ name: 'a.png', mime: 'image/png', dataBase64: IMAGE_BASE64 }],
  });
  const body = buildProviderRequestBody(
    { model: 'deepseek-flash', maxTokens: 4500, disableThinking: true },
    request,
  );
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.max_tokens, 4500);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.messages[0].role, 'system');
  assert.equal(body.messages[1].role, 'user');
  assert.ok(Array.isArray(body.messages[1].content));
  assert.equal(body.messages[1].content[1].type, 'image_url');
  assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('resolveAiConfig uses the documented env variables and defaults', () => {
  const cfg = resolveAiConfig({});
  assert.equal(cfg.configured, false);
  assert.equal(cfg.baseUrl, 'https://api.deepseek.com');
  assert.equal(cfg.model, 'deepseek-flash');
  assert.equal(cfg.maxTokens, 4500);
  assert.equal(cfg.timeoutMs, 60000);
  assert.equal(cfg.disableThinking, true);

  const withKey = resolveAiConfig({ IMSTAGE_AI_API_KEY: 'k', IMSTAGE_AI_MODEL: 'x' });
  assert.equal(withKey.configured, true);
  assert.equal(withKey.model, 'x');
  const deepseekFallback = resolveAiConfig({ DEEPSEEK_API_KEY: 'k' });
  assert.equal(deepseekFallback.configured, true);
});

// ---------------------------------------------------------------------------
// Revision + idempotency + concurrency
// ---------------------------------------------------------------------------

test('stale revision is rejected before any provider call', async (t) => {
  const generateScene = makeFakeGenerate(() => validScene());
  const env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());
  const created = await env.request('POST', '/api/cases', {
    revision: 0,
    case: { question: 'x', inputLanguage: 'zh-CN', targetIM: 'wechat', surface: 'ios', outputKind: 'screenshot', width: 64, height: 64 },
  });
  assert.equal(created.status, 201);
  const res = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-stale-1',
    input: { text: 'hello' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'revision_conflict');
  assert.equal(generateScene.calls.length, 0);
});

test('a concurrent store edit during generation is never overwritten', async (t) => {
  let env;
  const generateScene = makeFakeGenerate(async () => {
    // Simulate the user editing the store while the paid model call runs.
    const edit = await env.request('POST', '/api/cases', {
      revision: 0,
      case: { question: 'concurrent', inputLanguage: 'zh-CN', targetIM: 'wechat', surface: 'ios', outputKind: 'screenshot', width: 64, height: 64 },
    });
    assert.equal(edit.status, 201);
    return validScene();
  });
  env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());

  const res = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-concurrent-1',
    input: { text: 'hello' },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'revision_conflict');
  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 1);
  assert.equal(store.json.cases[0].question, 'concurrent');
});

test('same requestId with identical input is idempotent; changed input conflicts', async (t) => {
  const generateScene = makeFakeGenerate(() => validScene());
  const env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());

  const input = { text: '生成微信聊天' };
  const first = await env.request('POST', '/api/generate', { revision: 0, requestId: 'req-idem-1', input });
  assert.equal(first.status, 200, first.text);
  const second = await env.request('POST', '/api/generate', {
    revision: first.json.revision,
    requestId: 'req-idem-1',
    input,
  });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.case.id, first.json.case.id);
  assert.deepEqual(second.json.warnings, first.json.warnings);
  assert.equal(generateScene.calls.length, 1);

  const changed = await env.request('POST', '/api/generate', {
    revision: second.json.revision,
    requestId: 'req-idem-1',
    input: { text: '完全不同的输入' },
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.code, 'request_id_conflict');
  assert.equal(generateScene.calls.length, 1);

  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 1);
});

test('one concurrent generation at a time; duplicate in-flight requestId conflicts', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const generateScene = makeFakeGenerate(async () => {
    await gate;
    return validScene();
  });
  const env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());

  const input = { text: '生成微信聊天' };
  const first = env.request('POST', '/api/generate', { revision: 0, requestId: 'req-inflight-1', input });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const duplicate = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-inflight-1',
    input,
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.code, 'request_in_progress');

  const other = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-inflight-2',
    input,
  });
  assert.equal(other.status, 409);
  assert.equal(other.json.code, 'generation_busy');

  release();
  const firstRes = await first;
  assert.equal(firstRes.status, 200, firstRes.text);
  assert.equal(generateScene.calls.length, 1);
});

test('client disconnect aborts the provider and stores nothing', async (t) => {
  let calls = 0;
  const generateScene = async ({ signal }) => {
    calls += 1;
    if (calls === 1) {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
      throw new AppError('request_aborted', '请求已取消', 499);
    }
    return { rawContent: JSON.stringify(validScene()), model: 'fake-vision-1' };
  };
  const env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());

  await env.rawGenerate(
    { revision: 0, requestId: 'req-cancel-1', input: { text: '生成微信聊天' } },
    { destroyAfterMs: 30 },
  );
  // Give the handler a moment to observe the abort and unwind.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 0);
  assert.equal(store.json.revision, 0);

  // The server is still usable and the concurrency gate was released.
  const retry = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-cancel-2',
    input: { text: '生成微信聊天' },
  });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// P1: durable recovery ledger (exact-once provider is impossible)
// ---------------------------------------------------------------------------

test('P1: renderer failure caches the provider result; retry does not pay again', async (t) => {
  let renderCalls = 0;
  const renderScene = async (scene, opts) => {
    renderCalls += 1;
    if (renderCalls === 1) throw new AppError('output_too_tall', '内容过高，请改选长截图', 422);
    const height = opts.outputKind === 'long-screenshot' ? 1234 : opts.height;
    return { buffer: pngBuffer(opts.width, height), width: opts.width, height };
  };
  const generateScene = makeFakeGenerate(() => validScene());
  const env = await launchGen({ generateScene, renderScene });
  t.after(() => env.close());

  const input = { text: '生成微信聊天' };
  const first = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-render-retry',
    input,
  });
  assert.equal(first.status, 422);
  assert.equal(first.json.code, 'output_too_tall');
  assert.equal(generateScene.calls.length, 1);

  const second = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-render-retry',
    input,
  });
  assert.equal(second.status, 200, second.text);
  assert.equal(generateScene.calls.length, 1, 'cached result must not hit the provider again');
  assert.equal(renderCalls, 2, 'retry re-renders locally');
  assert.equal(second.json.case.review, null);
});

test('P1: post-generation revision conflict retries from the cached model result', async (t) => {
  let env;
  const generateScene = makeFakeGenerate(async () => {
    const edit = await env.request('POST', '/api/cases', {
      revision: 0,
      case: {
        question: 'concurrent',
        inputLanguage: 'zh-CN',
        targetIM: 'wechat',
        surface: 'ios',
        outputKind: 'screenshot',
        width: 64,
        height: 64,
      },
    });
    assert.equal(edit.status, 201);
    return validScene();
  });
  env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());

  const input = { text: 'hello' };
  const first = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-rev-retry',
    input,
  });
  assert.equal(first.status, 409);
  assert.equal(first.json.code, 'revision_conflict');
  assert.equal(generateScene.calls.length, 1);

  const rev = (await env.request('GET', '/api/store')).json.revision;
  const second = await env.request('POST', '/api/generate', {
    revision: rev,
    requestId: 'req-rev-retry',
    input,
  });
  assert.equal(second.status, 200, second.text);
  assert.equal(generateScene.calls.length, 1, 'retry must reuse the cached model result');
  assert.equal(second.json.case.question, 'hello');
  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 2);
});

test('P1: a new app instance reuses the completed ledger entry', async (t) => {
  const firstGenerate = makeFakeGenerate(() => validScene());
  const env1 = await launchGen({ generateScene: firstGenerate, renderScene: makeFakeRender() });
  const input = { text: '生成微信聊天' };
  const first = await env1.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-instance',
    input,
  });
  assert.equal(first.status, 200, first.text);
  await env1.closeServer();

  const secondGenerate = makeFakeGenerate(() => {
    throw new Error('provider must not be called on a completed requestId');
  });
  const env2 = await launchGen({
    generateScene: secondGenerate,
    renderScene: makeFakeRender(),
    dataDir: env1.dataDir,
  });
  t.after(() => env2.close());

  const second = await env2.request('POST', '/api/generate', {
    revision: first.json.revision,
    requestId: 'req-instance',
    input,
  });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.case.id, first.json.case.id);
  assert.equal(secondGenerate.calls.length, 0);
});

test('P1: an uncertain provider attempt refuses a paid retry with generation_outcome_unknown', async (t) => {
  let calls = 0;
  const generateScene = async () => {
    calls += 1;
    throw new AppError('ai_timeout', 'AI 请求超时', 504);
  };
  const env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());
  const input = { text: '你好' };

  const first = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-unknown',
    input,
  });
  assert.equal(first.status, 504);
  assert.equal(first.json.code, 'ai_timeout');

  const second = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-unknown',
    input,
  });
  assert.equal(second.status, 409);
  assert.equal(second.json.code, 'generation_outcome_unknown');
  assert.equal(calls, 1, 'unknown outcome must not trigger a second paid call');
});

test('P1: changed input with a cached requestId conflicts instead of silently reusing', async (t) => {
  let renderCalls = 0;
  const renderScene = async (scene, opts) => {
    renderCalls += 1;
    if (renderCalls === 1) throw new AppError('output_too_tall', '内容过高', 422);
    return { buffer: pngBuffer(opts.width, opts.height), width: opts.width, height: opts.height };
  };
  const generateScene = makeFakeGenerate(() => validScene());
  const env = await launchGen({ generateScene, renderScene });
  t.after(() => env.close());

  const first = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-changed',
    input: { text: '原始输入' },
  });
  assert.equal(first.status, 422);

  const changed = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-changed',
    input: { text: '完全不同的输入' },
  });
  assert.equal(changed.status, 409);
  assert.equal(changed.json.code, 'request_id_conflict');
  assert.equal(generateScene.calls.length, 1);
});

test('P1: a deleted completed case is not resurrected by replaying the requestId', async (t) => {
  const env = await launchGen({ generateScene: makeFakeGenerate(() => validScene()), renderScene: makeFakeRender() });
  t.after(() => env.close());
  const input = { text: '生成微信聊天' };
  const first = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-deleted',
    input,
  });
  assert.equal(first.status, 200, first.text);
  const deleted = await env.request('DELETE', `/api/cases/${first.json.case.id}`, {
    revision: first.json.revision,
  });
  assert.equal(deleted.status, 200);

  const replay = await env.request('POST', '/api/generate', {
    revision: deleted.json.revision,
    requestId: 'req-deleted',
    input,
  });
  assert.equal(replay.status, 404);
  assert.equal(replay.json.code, 'generation_not_found');
  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 0);
});

test('P1: a corrupt recovery ledger fails closed and is never overwritten', async (t) => {
  const env = await launchGen({ generateScene: makeFakeGenerate(() => validScene()), renderScene: makeFakeRender() });
  t.after(() => env.close());
  const ledgerPath = path.join(env.dataDir, 'generation-ledger.json');
  const corrupt = 'this is not json';
  await fs.promises.writeFile(ledgerPath, corrupt);

  const res = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-corrupt-ledger',
    input: { text: '你好' },
  });
  assert.equal(res.status, 500);
  assert.equal(res.json.code, 'generation_ledger_corrupt');
  assert.equal(await fs.promises.readFile(ledgerPath, 'utf8'), corrupt);
  assert.equal(env.store.revision, 0);
});

test('P1: the recovery ledger is written with 0600 permissions', async (t) => {
  const env = await launchGen({ generateScene: makeFakeGenerate(() => validScene()), renderScene: makeFakeRender() });
  t.after(() => env.close());
  const res = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-mode-0600',
    input: { text: '生成微信聊天' },
  });
  assert.equal(res.status, 200, res.text);
  const stat = await fs.promises.stat(path.join(env.dataDir, 'generation-ledger.json'));
  assert.equal(stat.mode & 0o777, 0o600);
});

// ---------------------------------------------------------------------------
// P2: cancellation, full PNG decode, renderer class hardening
// ---------------------------------------------------------------------------

test('P2: client cancellation during a blob write does not commit a case', async (t) => {
  const generateScene = makeFakeGenerate(() => validScene());
  const env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const original = env.store.putBlob.bind(env.store);
  let blocked = false;
  env.store.putBlob = async (buffer) => {
    if (!blocked) {
      blocked = true;
      await gate;
    }
    return original(buffer);
  };

  await env.rawGenerate(
    { revision: 0, requestId: 'req-blob-cancel', input: { text: '生成微信聊天' } },
    { destroyAfterMs: 40 },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const store = await env.request('GET', '/api/store');
  assert.equal(store.json.cases.length, 0);
  assert.equal(store.json.revision, 0);
});

test('P2: a truncated 33-byte PNG header is rejected before the provider', async (t) => {
  const generateScene = makeFakeGenerate(() => validScene());
  const env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());
  const truncated = pngBuffer(4, 4).subarray(0, 33);
  assert.equal(truncated.length, 33);

  const res = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-truncated-input',
    input: {
      text: 'x',
      images: [{ name: 'trunc.png', mime: 'image/png', dataBase64: truncated.toString('base64') }],
    },
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.code, 'invalid_image');
  assert.equal(generateScene.calls.length, 0);
  assert.equal(env.store.revision, 0);
});

test('P2: a truncated 33-byte rendered PNG is rejected before commit', async (t) => {
  const truncated = pngBuffer(4, 4).subarray(0, 33);
  const env = await launchGen({
    generateScene: makeFakeGenerate(() => validScene()),
    renderScene: async () => ({ buffer: truncated, width: 390, height: 844 }),
  });
  t.after(() => env.close());
  const res = await env.request('POST', '/api/generate', {
    revision: 0,
    requestId: 'req-truncated-output',
    input: { text: '你好' },
  });
  assert.equal(res.status, 502);
  assert.equal(res.json.code, 'render_invalid_png');
  assert.equal(env.store.revision, 0);
});

test('P2: renderSceneHtml never emits a hostile platform value as a class', () => {
  const hostile = { ...validScene().scene, platform: 'x"><script>alert(1)</script>' };
  const html = renderSceneHtml(hostile, { surface: 'ios', width: 390, outputKind: 'screenshot', assets: [] });
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('x">'), false);
  assert.match(html, /platform-wechat/);
});

// ---------------------------------------------------------------------------
// Schema + renderer unit tests (shared packages)
// ---------------------------------------------------------------------------

test('conversation schema accepts valid scenes and enforces every bound', () => {
  const normalized = validateConversationScene(validScene().scene, { assetCount: 0 });
  assert.equal(normalized.platform, 'wechat');
  assert.equal(normalized.messages.length, 2);

  const assertSchemaRejects = (scene, code) => {
    assert.throws(
      () => validateConversationScene(scene, { assetCount: 1, expectedPlatform: 'wechat' }),
      (err) => {
        assert.ok(err instanceof ConversationSchemaError, `expected schema error for ${code}`);
        assert.equal(err.code, code);
        return true;
      },
    );
  };

  assertSchemaRejects({ ...validScene().scene, selfId: 'ghost' }, 'unknown_participant');
  assertSchemaRejects(
    {
      ...validScene().scene,
      messages: [{ id: 'm1', participantId: 'ghost', type: 'text', text: 'x', time: '09:41' }],
    },
    'unknown_participant',
  );
  assertSchemaRejects(
    {
      ...validScene().scene,
      messages: [{ id: 'm1', participantId: 'me', type: 'image', text: '', time: '09:41', assetIndex: 9 }],
    },
    'asset_out_of_range',
  );
  assertSchemaRejects(
    {
      ...validScene().scene,
      messages: [{ id: 'm1', participantId: 'me', type: 'text', text: '<script>alert(1)</script>', time: '09:41' }],
    },
    'unsafe_text',
  );
  assertSchemaRejects({ ...validScene().scene, title: 'x'.repeat(121) }, 'too_long');
  assertSchemaRejects(
    { ...validScene().scene, participants: [], selfId: 'me' },
    'invalid_participants',
  );

  // Image messages require a real upload.
  assert.throws(
    () =>
      validateConversationScene(
        { ...validScene().scene, messages: [{ id: 'm1', participantId: 'me', type: 'image', text: '', time: '09:41', assetIndex: 0 }] },
        { assetCount: 0 },
      ),
    (err) => err.code === 'invalid_asset_ref',
  );

  // System messages may omit participantId; explicit options override platform.
  const systemScene = {
    ...validScene().scene,
    platform: 'whatsapp',
    participants: [{ id: 'sys', name: '系统' }],
    selfId: 'sys',
    messages: [{ id: 'm1', participantId: '', type: 'system', text: '对方开启了好友验证', time: '09:41' }],
  };
  const overridden = validateConversationScene(systemScene, { expectedPlatform: 'wechat' });
  assert.equal(overridden.platform, 'wechat');
  assert.equal(overridden.messages[0].participantId, '');
});

test('parseSceneResponse overrides platform and surfaces warnings', () => {
  const raw = JSON.stringify({
    scene: { ...validScene().scene, platform: 'whatsapp' },
    warnings: ['文字模糊'],
  });
  const { scene, warnings } = parseSceneResponse(raw, { assetCount: 0, expectedPlatform: 'telegram' });
  assert.equal(scene.platform, 'telegram');
  assert.ok(warnings.some((w) => w.includes('覆盖')));
  assert.ok(warnings.includes('文字模糊'));
});

test('renderSceneHtml is deterministic, escaped and platform-specific with no remote loads', () => {
  const scene = validateConversationScene(
    {
      ...validScene().scene,
      messages: [
        { id: 'm1', participantId: 'p1', type: 'text', text: 'a bold c', time: '09:40' },
        { id: 'm2', participantId: 'me', type: 'image', text: '看这个', time: '09:41', assetIndex: 0 },
        { id: 'm3', participantId: '', type: 'system', text: '你已添加对方为好友', time: '09:42' },
      ],
    },
    { assetCount: 1, expectedPlatform: 'wechat' },
  );
  // Bypass the schema deliberately to prove the renderer escapes raw markup.
  scene.messages[0].text = 'a <b>bold</b> c';
  const assets = [{ mime: 'image/png', dataBase64: IMAGE_BASE64 }];

  const wechat = renderSceneHtml(scene, { surface: 'ios', width: 390, outputKind: 'screenshot', assets });
  const again = renderSceneHtml(scene, { surface: 'ios', width: 390, outputKind: 'screenshot', assets });
  assert.equal(wechat, again, 'renderer must be deterministic');
  assert.match(wechat, /platform-wechat/);
  assert.match(wechat, /surface-ios/);
  assert.match(wechat, /kind-screenshot/);
  assert.equal(wechat.includes('<b>bold</b>'), false, 'raw HTML from text must not survive');
  assert.match(wechat, /&lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(wechat, /data:image\/png;base64,/);
  assert.equal(wechat.includes('http://'), false);
  assert.equal(wechat.includes('https://'), false);
  assert.match(wechat, /95ec69/, 'wechat green bubble');

  const telegram = renderSceneHtml({ ...scene, platform: 'telegram' }, { surface: 'android', width: 390, outputKind: 'screenshot', assets });
  assert.match(telegram, /platform-telegram/);
  assert.match(telegram, /517da2/, 'telegram blue header');

  const whatsapp = renderSceneHtml({ ...scene, platform: 'whatsapp' }, { surface: 'desktop', width: 720, outputKind: 'long-screenshot', assets });
  assert.match(whatsapp, /platform-whatsapp/);
  assert.match(whatsapp, /075e54/, 'whatsapp green header');
  assert.match(whatsapp, /kind-long-screenshot/);
  assert.match(whatsapp, /windowbar/);

  // Missing asset degrades to an escaped placeholder instead of a broken URL.
  const noAsset = renderSceneHtml(scene, { surface: 'ios', width: 390, outputKind: 'screenshot', assets: [] });
  assert.match(noAsset, /\[图片\]/);
});

test('detectLanguage records zh-CN / en / other automatically', () => {
  assert.equal(detectLanguage('你好，世界'), 'zh-CN');
  assert.equal(detectLanguage('hello world'), 'en');
  assert.equal(detectLanguage('12345 !!!'), 'other');
  assert.equal(detectLanguage(''), 'other');
});

test('publicGenerationStatus never exposes secrets or host URLs', () => {
  const status = publicGenerationStatus({
    configured: true,
    apiKey: 'sk-secret',
    baseUrl: 'https://internal.example.com',
    model: 'deepseek-flash',
  });
  assert.deepEqual(status, {
    configured: true,
    model: 'deepseek-flash',
    images: true,
    defaults: { targetIM: 'wechat', surface: 'ios', outputKind: 'screenshot' },
  });
});

test('commit-window recovery completes the ledger and cannot resurrect a deleted case', async (t) => {
  const generateScene = makeFakeGenerate(() => validScene());
  const env = await launchGen({ generateScene, renderScene: makeFakeRender() });
  t.after(() => env.close());
  const body = { revision: 0, requestId: 'commit-window', input: { text: '周末露营' } };
  const result = await env.request('POST', '/api/generate', body);
  assert.equal(result.status, 200);
  // Simulate a crash after case commit but before the completion marker.
  const ledgerPath = path.join(env.store.dataDir, 'generation-ledger.json');
  const ledger = JSON.parse(await fs.promises.readFile(ledgerPath, 'utf8'));
  const entry = ledger.attempts[body.requestId];
  entry.status = 'model_ready'; entry.rawContent = JSON.stringify(validScene()); delete entry.caseId;
  await fs.promises.writeFile(ledgerPath, JSON.stringify(ledger));
  const restarted = await launchGen({ dataDir: env.store.dataDir, generateScene, renderScene: makeFakeRender() });
  // Avoid cleaning shared test data before the original server closes.
  t.after(() => new Promise((resolve) => restarted.server.close(resolve)));
  const recovered = await restarted.request('POST', '/api/generate', body);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.json.case.id, result.json.case.id);
  assert.equal(generateScene.calls.length, 1);
  assert.equal(JSON.parse(await fs.promises.readFile(ledgerPath, 'utf8')).attempts[body.requestId].status, 'completed');
  const deleted = await restarted.request('DELETE', `/api/cases/${result.json.case.id}`, { revision: recovered.json.revision });
  assert.equal(deleted.status, 200);
  const replay = await restarted.request('POST', '/api/generate', { ...body, revision: deleted.json.revision });
  assert.equal(replay.json.code, 'generation_not_found');
  assert.equal(generateScene.calls.length, 1);
});

test('concurrent ledger initialization uses one snapshot and retains begun attempts', async (t) => {
  const { GenerationLedger } = await import('../src/generation-ledger.mjs');
  const dir = tempDataDir('ledger-cold');
  await fs.promises.mkdir(dir, { recursive: true }); t.after(() => cleanupDir(dir));
  const ledger = new GenerationLedger({ dataDir: dir });
  let reads = 0;
  const original = ledger.loadFromDisk.bind(ledger);
  ledger.loadFromDisk = async () => { reads++; await new Promise((r) => setTimeout(r, 10)); return original(); };
  await Promise.all([ledger.load(), ledger.load()]);
  await ledger.begin('cold-first', 'a'.repeat(64));
  assert.equal(reads, 1);
  assert.equal((await ledger.read('cold-first')).status, 'started');
});

test('recovery writes cannot rename over a newer paid-attempt marker; failed writes do not advance memory', async (t) => {
  const { GenerationLedger } = await import('../src/generation-ledger.mjs');
  const dir = tempDataDir('ledger-serial'); await fs.promises.mkdir(dir, { recursive: true });
  t.after(() => cleanupDir(dir));
  const ledger = new GenerationLedger({ dataDir: dir });
  await ledger.begin('old-success', 'a'.repeat(64)); await ledger.complete('old-success', 'a'.repeat(64), 'c_old');
  const original = fs.promises.rename;
  let release, arrived, held = false, activeWrites = 0, maxWrites = 0;
  const gate = new Promise((r) => { release = r; });
  const ready = new Promise((r) => { arrived = r; });
  fs.promises.rename = async (from, to) => {
    if (to !== ledger.filePath) return original(from, to);
    activeWrites++; maxWrites = Math.max(maxWrites, activeWrites);
    try { if (!held) { held = true; arrived(); await gate; } return await original(from, to); }
    finally { activeWrites--; }
  };
  let oldWrite, newWrite;
  try {
    oldWrite = ledger.complete('old-success', 'a'.repeat(64), 'c_old'); await ready;
    let newSettled = false;
    newWrite = ledger.begin('new-paid', 'b'.repeat(64)).then(() => { newSettled = true; });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(newSettled, false, 'a new provider call cannot begin before its queued marker is durable');
    release(); await Promise.all([oldWrite, newWrite]);
    assert.equal(maxWrites, 1);
    const recovered = new GenerationLedger({ dataDir: dir });
    assert.equal((await recovered.read('new-paid')).status, 'started');
  } finally {
    release(); await Promise.allSettled([oldWrite, newWrite]); fs.promises.rename = original;
  }
  fs.promises.rename = async (from, to) => {
    if (to === ledger.filePath) throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
    return original(from, to);
  };
  try {
    await assert.rejects(ledger.begin('write-failed', 'c'.repeat(64)));
    assert.equal(await ledger.read('write-failed'), null);
  } finally { fs.promises.rename = original; }
  await ledger.begin('after-failure', 'd'.repeat(64));
  assert.equal((await ledger.read('after-failure')).status, 'started');
});

// IMStage MCP protocol tests.
//
// These exercise the real server through the official MCP SDK's Streamable HTTP
// client transport (not a hand-rolled JSON-RPC mock), covering:
//   - initialize / tools list / capabilities
//   - create -> get -> render (real PNG decode) -> resource reads
//   - targeted edits + optimistic revision conflicts
//   - idempotent create/update retries
//   - invalid patches that must not mutate stored state
//   - malformed input and explicit bounds
//   - bearer auth denial and private-tunnel mode
//   - restart persistence from the isolated data dir
//
// Every test uses a fresh temporary IMSTAGE_MCP_DATA_DIR and removes it in a
// finally block. Rendering tests skip only when no Chromium executable can be
// found at all; a real render failure is never skipped.

import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pngjs from 'pngjs';

import { resolveMcpConfig } from '../services/mcp/config.mjs';
import { resolveChromiumExecutable } from '../services/mcp/render.mjs';
import { EXAMPLE_CREATE_SCENE } from '../services/mcp/scene.mjs';
import { startMcpServer } from '../services/mcp/server.mjs';
import { WIDGET_RESOURCE_URI } from '../services/mcp/widget.mjs';

const { PNG } = pngjs;
const TOKEN = 'test-token-1234567890';

const QUIET_LOGGER = { log() {}, warn() {}, error() {}, debug() {} };

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'imstage-mcp-test-'));
}

function baseConfig(dataDir, overrides = {}) {
  return {
    ...resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir, IMSTAGE_MCP_TOKEN: TOKEN, IMSTAGE_MCP_PORT: '0' }),
    ...overrides,
  };
}

async function startServer(dataDir, overrides = {}) {
  return startMcpServer({ config: baseConfig(dataDir, overrides), logger: QUIET_LOGGER });
}

async function connectClient(url, token = TOKEN) {
  const client = new Client({ name: 'imstage-mcp-test', version: '0.0.1' });
  const headers = token === null ? {} : { Authorization: `Bearer ${token}` };
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  return client;
}

async function importChromiumExists() {
  try {
    const { chromium } = await import('playwright');
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

function chromiumUsable() {
  if (resolveChromiumExecutable(process.env)) return true;
  return null; // resolved lazily below
}

function createSceneArgument(overrides = {}) {
  return { ...structuredClone(EXAMPLE_CREATE_SCENE), ...overrides };
}

function decodePng(bufferOrBase64) {
  const buffer = Buffer.isBuffer(bufferOrBase64) ? bufferOrBase64 : Buffer.from(bufferOrBase64, 'base64');
  const png = PNG.sync.read(buffer);
  assert.equal(png.data.length, png.width * png.height * 4);
  return png;
}

function toolError(result) {
  assert.equal(result.isError, true);
  return result.structuredContent.error;
}

test('IMStage MCP protocol (real SDK client over HTTP)', async (t) => {
  const rendererReady = chromiumUsable() ?? (await importChromiumExists());
  const dataDir = tempDataDir();
  let handle;
  let client;
  try {
    handle = await startServer(dataDir);
    client = await connectClient(handle.url);

    await t.test('initialize exposes server info and instructions', () => {
      assert.equal(client.getServerVersion().name, 'imstage-mcp');
      assert.ok(client.getServerCapabilities().tools, 'tools capability');
      assert.ok(client.getServerCapabilities().resources, 'resources capability');
    });

    let sceneId;
    let latestRevision;

    await t.test('tools/list advertises exactly the owner flow and attaches the widget only to render', async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name),
        [
          'imstage_get_capabilities',
          'imstage_create_scene',
          'imstage_get_scene',
          'imstage_update_scene',
          'imstage_render_scene',
        ],
      );
      const renderTool = tools.find((tool) => tool.name === 'imstage_render_scene');
      assert.equal(renderTool._meta.ui.resourceUri, WIDGET_RESOURCE_URI);
      assert.equal(renderTool._meta['openai/outputTemplate'], WIDGET_RESOURCE_URI);
      assert.equal(renderTool.annotations.readOnlyHint, true);
      for (const tool of tools.filter((entry) => entry.name !== 'imstage_render_scene')) {
        assert.equal(tool._meta?.ui?.resourceUri, undefined, `${tool.name} must not attach a widget`);
      }
      const createTool = tools.find((tool) => tool.name === 'imstage_create_scene');
      assert.equal(createTool.annotations.readOnlyHint, false);
      assert.equal(createTool.inputSchema.additionalProperties, false);
    });

    await t.test('imstage_get_capabilities documents the real supported subset and examples', async () => {
      const result = await client.callTool({ name: 'imstage_get_capabilities', arguments: {} });
      assert.notEqual(result.isError, true);
      const capabilities = result.structuredContent;
      assert.deepEqual(capabilities.supportedSubset.platforms, ['wechat', 'xiaohongshu', 'imessage', 'whatsapp', 'slack', 'instagram']);
      assert.deepEqual(capabilities.supportedSubset.surfaces, ['ios', 'android', 'desktop']);
      assert.deepEqual(capabilities.supportedSubset.nativelyRenderedMessageTypes, ['text', 'image', 'location', 'system', 'contact', 'transfer', 'voice', 'video', 'link', 'album']);
      assert.equal(capabilities.canonicalValidator, 'apps/web/src/studio/model.ts#validateScene');
      assert.ok(capabilities.examples.createScene.scene.participants.length >= 1);
      assert.equal(capabilities.examples.updateScene.patch.updateMessages.length, 1);
      assert.ok(capabilities.errorCodes.some((entry) => entry.code === 'revision_conflict'));
      assert.equal(capabilities.widget.resourceUri, WIDGET_RESOURCE_URI);
    });

    await t.test('create returns an opaque server id + revision 1 and preserves the normalized scene', async () => {
      const result = await client.callTool({
        name: 'imstage_create_scene',
        arguments: { scene: createSceneArgument(), idempotencyKey: 'create-1' },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
      const content = result.structuredContent;
      assert.match(content.sceneId, /^scn_[0-9a-f]{32}$/);
      assert.equal(content.revision, 1);
      assert.equal(content.deduplicated, false);
      assert.equal(content.scene.title, EXAMPLE_CREATE_SCENE.title);
      assert.equal(content.scene.messages.length, EXAMPLE_CREATE_SCENE.messages.length);
      sceneId = content.sceneId;
      latestRevision = content.revision;
    });

    await t.test('create rejects a caller-supplied id and unknown fields', async () => {
      const withId = toolError(
        await client.callTool({
          name: 'imstage_create_scene',
          arguments: { scene: { ...createSceneArgument(), id: 'scn_attacker' } },
        }),
      );
      assert.equal(withId.code, 'invalid_request');
      const unknown = toolError(
        await client.callTool({
          name: 'imstage_create_scene',
          arguments: { scene: { ...createSceneArgument(), unexpected: true } },
        }),
      );
      assert.equal(unknown.code, 'invalid_request');
      const unknownArg = toolError(
        await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId, extra: 1 } }),
      );
      assert.equal(unknownArg.code, 'invalid_request');
    });

    await t.test('get_scene returns the stored revision and latestRevision', async () => {
      const result = await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId } });
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent.sceneId, sceneId);
      assert.equal(result.structuredContent.revision, 1);
      assert.equal(result.structuredContent.latestRevision, 1);
      const missing = toolError(
        await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId: 'scn_' + 'f'.repeat(32) } }),
      );
      assert.equal(missing.code, 'scene_not_found');
    });

    await t.test('update applies a targeted patch and bumps the revision', async () => {
      const result = await client.callTool({
        name: 'imstage_update_scene',
        arguments: {
          sceneId,
          expectedRevision: latestRevision,
          patch: {
            set: { title: '周末自驾看海', watermark: 'IMStage' },
            updateMessages: [{ id: 'm-2', text: '周六带上相机和无人机。' }],
            addMessages: [{ id: 'm-3', participantId: 'p-linxiaoman', type: 'text', text: '好，周六见！', time: '09:41' }],
          },
          idempotencyKey: 'update-1',
        },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
      assert.equal(result.structuredContent.revision, 2);
      assert.equal(result.structuredContent.changed, true);
      assert.equal(result.structuredContent.scene.title, '周末自驾看海');
      assert.equal(result.structuredContent.scene.messages.length, 3);
      assert.equal(result.structuredContent.scene.messages[2].id, 'm-3');
      latestRevision = result.structuredContent.revision;
    });

    await t.test('stale expectedRevision returns an actionable revision_conflict and does not mutate', async () => {
      const conflict = toolError(
        await client.callTool({
          name: 'imstage_update_scene',
          arguments: { sceneId, expectedRevision: 1, patch: { set: { title: 'stale write' } } },
        }),
      );
      assert.equal(conflict.code, 'revision_conflict');
      assert.equal(conflict.details.currentRevision, latestRevision);
      assert.match(conflict.recovery, /imstage_get_scene/);
      const current = await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId } });
      assert.equal(current.structuredContent.scene.title, '周末自驾看海');
      assert.equal(current.structuredContent.revision, latestRevision);
    });

    await t.test('concurrent updates with the same expectedRevision: exactly one wins', async () => {
      const [a, b] = await Promise.all([
        client.callTool({
          name: 'imstage_update_scene',
          arguments: { sceneId, expectedRevision: latestRevision, patch: { set: { watermark: 'A' } } },
        }),
        client.callTool({
          name: 'imstage_update_scene',
          arguments: { sceneId, expectedRevision: latestRevision, patch: { set: { watermark: 'B' } } },
        }),
      ]);
      const errors = [a, b].filter((result) => result.isError);
      const oks = [a, b].filter((result) => !result.isError);
      assert.equal(oks.length, 1, JSON.stringify([a.structuredContent, b.structuredContent]));
      assert.equal(errors.length, 1);
      assert.equal(errors[0].structuredContent.error.code, 'revision_conflict');
      latestRevision = oks[0].structuredContent.revision;
    });

    await t.test('invalid patch keeps the stored scene unchanged', async () => {
      const before = await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId } });
      const bad = toolError(
        await client.callTool({
          name: 'imstage_update_scene',
          arguments: {
            sceneId,
            expectedRevision: latestRevision,
            patch: {
              set: { title: 'should not persist' },
              removeMessages: ['m-does-not-exist'],
            },
          },
        }),
      );
      assert.equal(bad.code, 'invalid_patch');
      const after = await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId } });
      assert.equal(after.structuredContent.revision, before.structuredContent.revision);
      assert.equal(after.structuredContent.scene.title, before.structuredContent.scene.title);
    });

    await t.test('create/update idempotency keys deduplicate retries', async () => {
      const args = { scene: createSceneArgument({ title: '幂等场景' }), idempotencyKey: 'idem-create' };
      const first = await client.callTool({ name: 'imstage_create_scene', arguments: structuredClone(args) });
      const retry = await client.callTool({ name: 'imstage_create_scene', arguments: structuredClone(args) });
      assert.equal(retry.structuredContent.sceneId, first.structuredContent.sceneId);
      assert.equal(retry.structuredContent.deduplicated, true);
      assert.equal(retry.structuredContent.revision, 1);

      const updateArgs = {
        sceneId: first.structuredContent.sceneId,
        expectedRevision: 1,
        patch: { set: { watermark: 'once' } },
        idempotencyKey: 'idem-update',
      };
      const updateFirst = await client.callTool({ name: 'imstage_update_scene', arguments: structuredClone(updateArgs) });
      assert.equal(updateFirst.structuredContent.revision, 2);
      const updateRetry = await client.callTool({ name: 'imstage_update_scene', arguments: structuredClone(updateArgs) });
      assert.equal(updateRetry.structuredContent.revision, 2);
      assert.equal(updateRetry.structuredContent.deduplicated, true);

      const reused = toolError(
        await client.callTool({
          name: 'imstage_update_scene',
          arguments: { ...structuredClone(updateArgs), patch: { set: { watermark: 'different' } } },
        }),
      );
      assert.equal(reused.code, 'idempotency_conflict');
    });

    await t.test('malformed input and bounds fail loudly', async () => {
      const missingScene = toolError(await client.callTool({ name: 'imstage_create_scene', arguments: {} }));
      assert.equal(missingScene.code, 'invalid_request');

      const missingTitle = toolError(
        await client.callTool({
          name: 'imstage_create_scene',
          arguments: { scene: { ...createSceneArgument(), title: '' } },
        }),
      );
      assert.equal(missingTitle.code, 'invalid_request');

      const badPlatform = toolError(
        await client.callTool({
          name: 'imstage_create_scene',
          arguments: { scene: createSceneArgument({ platform: 'telegram' }) },
        }),
      );
      assert.equal(badPlatform.code, 'unsupported_platform');
      assert.deepEqual(badPlatform.details.supported, ['wechat', 'xiaohongshu', 'imessage', 'whatsapp', 'slack', 'instagram']);

      const remoteAsset = toolError(
        await client.callTool({
          name: 'imstage_create_scene',
          arguments: {
            scene: {
              ...createSceneArgument(),
              participants: [
                { id: 'p-linxiaoman', name: '林小满', avatar: 'https://example.com/a.png' },
                { id: 'p-ayuan', name: '阿远' },
              ],
            },
          },
        }),
      );
      assert.equal(remoteAsset.code, 'validation_error');

      const tooManyMessages = structuredClone(EXAMPLE_CREATE_SCENE);
      tooManyMessages.messages = Array.from({ length: 121 }, (_value, index) => ({
        id: `m-${index + 1}`,
        participantId: 'p-linxiaoman',
        type: 'text',
        text: `消息 ${index + 1}`,
        time: '09:41',
      }));
      const bounded = toolError(
        await client.callTool({ name: 'imstage_create_scene', arguments: { scene: tooManyMessages } }),
      );
      assert.equal(bounded.code, 'limit_exceeded');
    });

    await t.test('render returns PNG image content, scene state and render metadata', { skip: !rendererReady ? 'no Chromium executable available' : false }, async () => {
      const result = await client.callTool({
        name: 'imstage_render_scene',
        arguments: { sceneId, outputKind: 'long-screenshot' },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
      const image = result.content.find((block) => block.type === 'image');
      assert.ok(image, 'render must return an image content block');
      assert.equal(image.mimeType, 'image/png');
      const png = decodePng(image.data);
      assert.equal(png.width, result.structuredContent.width);
      assert.equal(png.height, result.structuredContent.height);
      assert.ok(png.width > 0 && png.height > 0);
      assert.equal(result.structuredContent.sceneId, sceneId);
      assert.equal(result.structuredContent.revision, latestRevision);
      assert.match(result.structuredContent.sha256, /^[0-9a-f]{64}$/);
      assert.equal(result.structuredContent.rendererVersion, 'studio-32523b0-v1');
      assert.equal(result.structuredContent.widgetUri, WIDGET_RESOURCE_URI);
      assert.match(result.structuredContent.downloadUri, /^imstage:\/\/renders\/rnd_[0-9a-f]{32}\.png$/);
      assert.match(result._meta.preview.dataUri, /^data:image\/png;base64,/);
      assert.equal(result._meta['openai/widgetSessionId'], undefined, 'session identity belongs to the host');
    });

    await t.test('render rejects screenshot output that would clip tall content', { skip: !rendererReady ? 'no Chromium executable available' : false }, async () => {
      const error = toolError(
        await client.callTool({
          name: 'imstage_render_scene',
          arguments: { sceneId, outputKind: 'screenshot', height: 200 },
        }),
      );
      assert.equal(error.code, 'output_too_tall');
      assert.match(error.recovery, /long-screenshot/);
    });

    await t.test('render bounds long screenshots by pixels', { skip: !rendererReady ? 'no Chromium executable available' : false }, async () => {
      const tall = structuredClone(EXAMPLE_CREATE_SCENE);
      tall.messages = Array.from({ length: 90 }, (_value, index) => ({
        id: `m-${index + 1}`,
        participantId: 'p-linxiaoman',
        type: 'text',
        text: '这是一条用于撑高页面的中等长度消息，重复多次以触发像素上限。',
        time: '09:41',
      }));
      const created = await client.callTool({ name: 'imstage_create_scene', arguments: { scene: tall } });
      const error = toolError(
        await client.callTool({
          name: 'imstage_render_scene',
          arguments: { sceneId: created.structuredContent.sceneId, outputKind: 'long-screenshot', width: 1200 },
        }),
      );
      assert.equal(error.code, 'output_too_large');
      assert.equal(error.details.maxPixels, 4_000_000);
    });

    await t.test('render supports inline scenes without persisting them', { skip: !rendererReady ? 'no Chromium executable available' : false }, async () => {
      const result = await client.callTool({
        name: 'imstage_render_scene',
        arguments: { scene: createSceneArgument({ title: '内联预览' }), surface: 'android' },
      });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
      assert.equal(result.structuredContent.sceneId, null);
      assert.equal(result.structuredContent.ephemeral, true);
      assert.equal(result.structuredContent.surface, 'android');
      const image = result.content.find((block) => block.type === 'image');
      decodePng(image.data);
    });

    await t.test('render accepts an inline embedded image and rejects sceneId+scene together', { skip: !rendererReady ? 'no Chromium executable available' : false }, async () => {
      const withImage = createSceneArgument({
        messages: [
          {
            id: 'm-1',
            participantId: 'p-linxiaoman',
            type: 'image',
            text: '图片消息',
            time: '09:41',
            asset: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          },
        ],
      });
      const rendered = await client.callTool({ name: 'imstage_render_scene', arguments: { scene: withImage } });
      assert.notEqual(rendered.isError, true, JSON.stringify(rendered.structuredContent));
      decodePng(rendered.content.find((block) => block.type === 'image').data);

      const both = toolError(
        await client.callTool({ name: 'imstage_render_scene', arguments: { sceneId, scene: withImage } }),
      );
      assert.equal(both.code, 'invalid_request');
      const neither = toolError(await client.callTool({ name: 'imstage_render_scene', arguments: {} }));
      assert.equal(neither.code, 'invalid_request');
    });

    await t.test('widget resource is self-contained and mutation tools have no widget', async () => {
      const resource = await client.readResource({ uri: WIDGET_RESOURCE_URI });
      assert.equal(resource.contents.length, 1);
      const content = resource.contents[0];
      assert.equal(content.mimeType, 'text/html;profile=mcp-app');
      assert.match(content.text, /ui\/message/);
      assert.match(content.text, /ui\/download-file/);
      assert.match(content.text, /ui\/initialize/);
      assert.match(content.text, /window\.openai/);
      assert.equal(/https?:\/\//.test(content.text), false, 'widget must not reference remote URLs');
      assert.equal(/<script[^>]+src=/i.test(content.text), false, 'widget must not load remote scripts');
      assert.equal(/<img[^>]+src="https?:/i.test(content.text), false);
      const listed = await client.listResources();
      assert.ok(listed.resources.some((entry) => entry.uri === WIDGET_RESOURCE_URI));
    });

    await t.test('rendered PNG is downloadable through a resource', { skip: !rendererReady ? 'no Chromium executable available' : false }, async () => {
      const rendered = await client.callTool({ name: 'imstage_render_scene', arguments: { sceneId } });
      const resource = await client.readResource({ uri: rendered.structuredContent.downloadUri });
      assert.equal(resource.contents[0].mimeType, 'image/png');
      const buffer = Buffer.from(resource.contents[0].blob, 'base64');
      assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(buffer.length, rendered.structuredContent.bytes);
    });

    await t.test('scene snapshot resources expose historical revisions', async () => {
      const listed = await client.listResourceTemplates();
      assert.ok(listed.resourceTemplates.some((entry) => entry.uriTemplate.includes('/revisions/')));
      const snapshot = await client.readResource({ uri: `imstage://scenes/${sceneId}/revisions/1` });
      const parsed = JSON.parse(snapshot.contents[0].text);
      assert.equal(parsed.revision, 1);
      assert.equal(parsed.scene.title, EXAMPLE_CREATE_SCENE.title);
      const latest = await client.readResource({ uri: `imstage://scenes/${sceneId}` });
      assert.equal(JSON.parse(latest.contents[0].text).revision, latestRevision);
    });

    await t.test('bearer auth denies missing and wrong tokens', async () => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'probe', version: '1' },
        },
      });
      const missing = await fetch(handle.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(missing.status, 401);
      assert.match(missing.headers.get('www-authenticate') ?? '', /Bearer/);
      const wrong = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-token-1234567890' },
        body,
      });
      assert.equal(wrong.status, 401);
      const malformed = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Basic abc' },
        body,
      });
      assert.equal(malformed.status, 401);
    });

    await t.test('malformed JSON body is rejected before the transport', async () => {
      const response = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: '{ not json',
      });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error.code, -32700);
    });

    await client.close();
    client = null;
    await handle.close();
    handle = null;

    await t.test('restart persistence reads the same scene and revision', async () => {
      const restarted = await startServer(dataDir);
      try {
        const restartedClient = await connectClient(restarted.url);
        try {
          const result = await restartedClient.callTool({ name: 'imstage_get_scene', arguments: { sceneId } });
          assert.equal(result.structuredContent.revision, latestRevision);
          assert.equal(result.structuredContent.sceneId, sceneId);
          const revisions = result.structuredContent.revisions.map((entry) => entry.revision);
          assert.deepEqual(revisions, Array.from({ length: latestRevision }, (_value, index) => index + 1));
        } finally {
          await restartedClient.close();
        }
      } finally {
        await restarted.close();
      }
    });
  } finally {
    if (client) await client.close().catch(() => {});
    if (handle) await handle.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('IMStage MCP private tunnel mode allows loopback without a token but keeps storage isolated', async () => {
  const dataDir = tempDataDir();
  let handle;
  try {
    const config = resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir, IMSTAGE_MCP_PRIVATE_TUNNEL: '1', IMSTAGE_MCP_PORT: '0' });
    assert.equal(config.token, null);
    assert.equal(config.privateTunnel, true);
    assert.equal(config.host, '127.0.0.1');
    handle = await startMcpServer({ config, logger: QUIET_LOGGER });
    const client = await connectClient(handle.url, null);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 5);
    } finally {
      await client.close();
    }
    const health = await fetch(`http://${handle.host}:${handle.port}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');
  } finally {
    if (handle) await handle.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('IMStage MCP refuses to start without a token or private tunnel flag', () => {
  const dataDir = tempDataDir();
  try {
    assert.throws(
      () => resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir }),
      /IMSTAGE_MCP_TOKEN/,
    );
    assert.throws(() => resolveMcpConfig({ IMSTAGE_MCP_TOKEN: TOKEN }), /IMSTAGE_MCP_DATA_DIR/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('stateless transport rejects hostile browser origins/hosts and safely replays no-op edits', async()=>{
 const dataDir=tempDataDir();let handle,client;
 try{
  handle=await startServer(dataDir);client=await connectClient(handle.url);
  for(const extra of [{Origin:'https://untrusted.example'}]){
   const response=await fetch(handle.url,{method:'POST',headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json',...extra},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(response.status,403);
  }
  const hostile=await new Promise((resolve,reject)=>{const req=http.request(handle.url,{method:'POST',headers:{Host:'untrusted.example',Authorization:`Bearer ${TOKEN}`}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end();});assert.equal(hostile,403);
  const raw=await fetch(handle.url,{method:'POST',headers:{Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});assert.equal(raw.status,200);assert.equal(raw.headers.get('mcp-session-id'),null);assert.equal((await raw.json()).result.tools.length,5);
  const made=(await client.callTool({name:'imstage_create_scene',arguments:{scene:createSceneArgument(),idempotencyKey:'noop-create'}})).structuredContent;
  const args={sceneId:made.sceneId,expectedRevision:1,patch:{set:{title:made.title}},idempotencyKey:'noop'};
  const noop=await client.callTool({name:'imstage_update_scene',arguments:args});assert.equal(noop.structuredContent.changed,false);
  await client.callTool({name:'imstage_update_scene',arguments:{sceneId:made.sceneId,expectedRevision:1,patch:{set:{title:'新的标题'}}}});
  const retry=await client.callTool({name:'imstage_update_scene',arguments:args});assert.equal(retry.isError,undefined);assert.equal(retry.structuredContent.changed,false);assert.equal(retry.structuredContent.revision,1);
  const current=await client.callTool({name:'imstage_get_scene',arguments:{sceneId:made.sceneId}});assert.equal(current.structuredContent.title,'新的标题');assert.equal(current.structuredContent.revision,2);
 }finally{await client?.close();await handle?.close();fs.rmSync(dataDir,{recursive:true,force:true})}
});

// Unit tests for the IMStage MCP building blocks that do not need HTTP or a
// browser: the shared-scene adapter/patcher, the isolated SQLite store, render
// option validation, configuration parsing and widget safety.
//
// All storage tests use a fresh temporary IMSTAGE_MCP_DATA_DIR that is removed
// in a finally block.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveMcpConfig } from '../services/mcp/config.mjs';
import { McpToolError } from '../services/mcp/errors.mjs';
import { computeRenderId, resolveRenderConfig } from '../services/mcp/render.mjs';
import {
  adaptSceneForRenderer,
  applyScenePatch,
  buildCapabilities,
  EXAMPLE_CREATE_SCENE,
  prepareCreateScene,
  prepareEphemeralScene,
} from '../services/mcp/scene.mjs';
import { openStore } from '../services/mcp/store.mjs';
import { buildRenderWidgetHtml, buildWidgetResourceContent, WIDGET_RESOURCE_URI } from '../services/mcp/widget.mjs';

const TINY_PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'imstage-mcp-unit-'));
}

function freshScene(overrides = {}) {
  return { ...structuredClone(EXAMPLE_CREATE_SCENE), ...overrides };
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof McpToolError, `expected McpToolError, got ${error}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected an error with code ${code}`);
}

test('scene adapter reuses the shared validator and rejects anything outside the renderer subset', () => {
  const scene = prepareCreateScene(freshScene());
  assert.match(scene.id, /^scn_[0-9a-f]{32}$/);
  assert.equal(scene.platform, 'wechat');
  assert.equal(scene.messages.length, EXAMPLE_CREATE_SCENE.messages.length);

  expectCode(() => prepareCreateScene({ ...freshScene(), platform: 'telegram' }), 'unsupported_platform');
  expectCode(() => prepareCreateScene({ ...freshScene(), title: '' }), 'invalid_request');
  expectCode(() => prepareCreateScene({ ...freshScene(), leaked: 1 }), 'invalid_request');
  expectCode(
    () => prepareCreateScene({ ...freshScene(), messages: [{ ...EXAMPLE_CREATE_SCENE.messages[0], extra: 1 }] }),
    'invalid_request',
  );
  expectCode(
    () => prepareCreateScene({ ...freshScene(), messages: [{ ...EXAMPLE_CREATE_SCENE.messages[0], id: 'bad id!' }] }),
    'invalid_request',
  );
  expectCode(() => prepareCreateScene({ ...freshScene(), selfId: 'missing' }), 'validation_error');

  const ephemeral = prepareEphemeralScene(freshScene(), { sceneId: 'eph_' + 'a'.repeat(32) });
  assert.equal(ephemeral.id, 'eph_' + 'a'.repeat(32));
});

test('scene patcher applies targeted changes atomically and keeps operations ordered', () => {
  const scene = prepareCreateScene(freshScene());
  const { scene: patched, changed } = applyScenePatch(scene, {
    set: { title: '新标题', watermark: '水印' },
    removeParticipants: ['p-ayuan'],
    addParticipants: [{ id: 'p-new', name: '新朋友' }],
    updateMessages: [{ id: 'm-1', text: '改过的文本' }],
    removeMessages: ['m-2'],
    addMessages: [{ id: 'm-9', participantId: 'p-new', type: 'text', text: '你好', time: '09:50' }],
    moveMessages: [{ id: 'm-9', toIndex: 0 }],
  });
  assert.equal(changed, true);
  assert.equal(patched.title, '新标题');
  assert.deepEqual(patched.participants.map((p) => p.id), ['p-linxiaoman', 'p-new']);
  assert.deepEqual(patched.messages.map((m) => m.id), ['m-9', 'm-1']);
  assert.equal(patched.messages[1].text, '改过的文本');
  // The original scene is untouched (pure / immutable update).
  assert.equal(scene.title, EXAMPLE_CREATE_SCENE.title);
  assert.equal(scene.messages.length, 2);
});

test('a failing patch never partially mutates the source scene', () => {
  const scene = prepareCreateScene(freshScene());
  const snapshot = JSON.stringify(scene);
  expectCode(
    () =>
      applyScenePatch(scene, {
        set: { title: '不应生效' },
        addParticipants: [{ id: 'p-x', name: 'X' }],
        removeMessages: ['does-not-exist'],
      }),
    'invalid_patch',
  );
  assert.equal(JSON.stringify(scene), snapshot);

  expectCode(
    () => applyScenePatch(scene, { addMessages: [{ id: 'm-1', participantId: 'p-ayuan', type: 'text', text: 'dup', time: '09:41' }] }),
    'invalid_patch',
  );
  expectCode(() => applyScenePatch(scene, {}), 'invalid_patch');
  expectCode(() => applyScenePatch(scene, { bogus: [] }), 'invalid_request');
});

test('renderer adapter maps embedded image data URIs to assets and assetIndex', () => {
  const scene = prepareCreateScene(
    freshScene({
      messages: [
        { id: 'm-1', participantId: 'p-linxiaoman', type: 'image', text: '图片一', time: '09:41', asset: TINY_PNG_DATA_URI },
        { id: 'm-2', participantId: 'p-ayuan', type: 'text', text: '收到', time: '09:42' },
        { id: 'm-3', participantId: 'p-ayuan', type: 'image', text: '同图', time: '09:43', asset: TINY_PNG_DATA_URI },
      ],
    }),
  );
  const adapted = adaptSceneForRenderer(scene);
  assert.equal(adapted.assets.length, 1, 'identical assets are deduplicated');
  assert.equal(adapted.scene.messages[0].assetIndex, 0);
  assert.equal(adapted.scene.messages[1].assetIndex, undefined);
  assert.equal(adapted.scene.messages[2].assetIndex, 0);
  assert.equal(adapted.scene.messages[0].asset, undefined, 'raw data URI is not part of the renderer contract');
});

test('idempotency keys deduplicate store writes and reject reuse with different bodies', () => {
  const dataDir = tempDataDir();
  const store = openStore({ dataDir });
  try {
    const scene = prepareCreateScene(freshScene());
    const first = store.createScene({ scene, requestHash: 'hash-1', idempotencyKey: 'key-1' });
    const second = store.createScene({ scene: prepareCreateScene(freshScene()), requestHash: 'hash-1', idempotencyKey: 'key-1' });
    assert.equal(second.deduplicated, true);
    assert.equal(second.sceneId, first.sceneId);
    assert.equal(second.revision, 1);

    const conflict = expectCode(
      () => store.createScene({ scene: prepareCreateScene(freshScene()), requestHash: 'hash-2', idempotencyKey: 'key-1' }),
      'idempotency_conflict',
    );
    assert.equal(conflict.status, 409);

    const updated = store.updateScene({
      sceneId: first.sceneId,
      expectedRevision: 1,
      scene: { ...scene, title: '第二版' },
      requestHash: 'hash-3',
      idempotencyKey: 'key-2',
    });
    assert.equal(updated.revision, 2);
    const retried = store.updateScene({
      sceneId: first.sceneId,
      expectedRevision: 1,
      scene: { ...scene, title: '第二版' },
      requestHash: 'hash-3',
      idempotencyKey: 'key-2',
    });
    assert.equal(retried.deduplicated, true);
    assert.equal(retried.revision, 2);
    assert.equal(store.currentRevision(first.sceneId), 2);
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('store keeps every revision snapshot and reports actionable conflicts', () => {
  const dataDir = tempDataDir();
  const store = openStore({ dataDir });
  try {
    const scene = prepareCreateScene(freshScene());
    store.createScene({ scene, requestHash: 'h1' });
    store.updateScene({ sceneId: scene.id, expectedRevision: 1, scene: { ...scene, title: 'r2' }, requestHash: 'h2' });
    store.updateScene({ sceneId: scene.id, expectedRevision: 2, scene: { ...scene, title: 'r3' }, requestHash: 'h3' });

    const conflict = expectCode(
      () => store.updateScene({ sceneId: scene.id, expectedRevision: 1, scene, requestHash: 'h4' }),
      'revision_conflict',
    );
    assert.deepEqual(conflict.details, { sceneId: scene.id, expectedRevision: 1, currentRevision: 3 });
    assert.equal(store.getScene(scene.id, 1).scene.title, EXAMPLE_CREATE_SCENE.title);
    assert.equal(store.getScene(scene.id, 3).scene.title, 'r3');
    assert.equal(store.getScene(scene.id).revision, 3);
    assert.deepEqual(store.listSceneRevisions(scene.id).map((entry) => entry.revision), [1, 2, 3]);
    assert.equal(store.getScene('scn_' + 'f'.repeat(32)), null);
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('store persists across reopen and prunes old render artifacts', () => {
  const dataDir = tempDataDir();
  let store = openStore({ dataDir, maxStoredRenders: 2 });
  const scene = prepareCreateScene(freshScene());
  try {
    store.createScene({ scene, requestHash: 'h1' });
    assert.equal(store.currentRevision(scene.id), 1);
  } finally {
    store.close();
  }

  store = openStore({ dataDir, maxStoredRenders: 2 });
  try {
    assert.equal(store.currentRevision(scene.id), 1, 'scene survives a reopen');
    for (let index = 0; index < 3; index += 1) {
      store.saveRender({
        renderId: `rnd_${String(index).padStart(32, '0')}`,
        sceneId: scene.id,
        revision: 1,
        pngBase64: Buffer.from(`png-${index}`).toString('base64'),
        sha256: 'a'.repeat(64),
        bytes: 10,
        width: 1,
        height: 1,
        title: 't',
        outputKind: 'screenshot',
        surface: 'ios',
      });
    }
    assert.equal(store.countRenders(), 2, 'render retention is bounded');
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('render option validation enforces surface, output kind and pixel-friendly ranges', () => {
  assert.deepEqual(resolveRenderConfig({ surface: 'ios', width: 390, height: 844, outputKind: 'long-screenshot' }), {
    surface: 'ios',
    width: 390,
    height: 844,
    outputKind: 'long-screenshot',
  });
  expectCode(() => resolveRenderConfig({ surface: 'web', width: 390, height: 844, outputKind: 'screenshot' }), 'invalid_request');
  expectCode(() => resolveRenderConfig({ surface: 'ios', width: 100, height: 844, outputKind: 'screenshot' }), 'invalid_request');
  expectCode(() => resolveRenderConfig({ surface: 'ios', width: 390, height: 999_999, outputKind: 'screenshot' }), 'invalid_request');
  expectCode(() => resolveRenderConfig({ surface: 'ios', width: 390, height: 844, outputKind: 'gif' }), 'invalid_request');
});

test('render ids are deterministic for identical inputs', () => {
  const scene = prepareCreateScene(freshScene());
  const adapted = adaptSceneForRenderer(scene);
  const base = { scene: adapted.scene, surface: 'ios', width: 390, height: 844, outputKind: 'long-screenshot', rendererVersion: 'v1' };
  assert.equal(computeRenderId(base), computeRenderId(base));
  assert.match(computeRenderId(base), /^rnd_[0-9a-f]{32}$/);
  assert.notEqual(computeRenderId(base), computeRenderId({ ...base, outputKind: 'screenshot' }));
});

test('config parsing enforces isolated data dir and token rules', () => {
  const dataDir = tempDataDir();
  try {
    const config = resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir, IMSTAGE_MCP_TOKEN: 'x'.repeat(32) });
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 4421);
    assert.equal(config.dataDir, path.resolve(dataDir));
    assert.equal(config.privateTunnel, false);
    assert.throws(() => resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir, IMSTAGE_MCP_TOKEN: 'short' }), /IMSTAGE_MCP_TOKEN/);
    assert.throws(() => resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir, IMSTAGE_MCP_PORT: 'abc', IMSTAGE_MCP_TOKEN: 'x'.repeat(32) }), /IMSTAGE_MCP_PORT/);
    const tunnel = resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir, IMSTAGE_MCP_PRIVATE_TUNNEL: 'true' });
    assert.equal(tunnel.privateTunnel, true);
    assert.equal(tunnel.token, null);
    const allowed = resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir, IMSTAGE_MCP_TOKEN: 'x'.repeat(32), IMSTAGE_MCP_ALLOWED_HOSTS: 'a.example, b.example' });
    assert.deepEqual(allowed.allowedHosts, ['a.example', 'b.example']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('widget markup is self-contained, uses the MCP Apps bridge and never trusts scene HTML', () => {
  const html = buildRenderWidgetHtml();
  assert.match(html, /ui\/initialize/);
  assert.match(html, /ui\/notifications\/initialized/);
  assert.match(html, /ui\/message/);
  assert.match(html, /ui\/download-file/);
  assert.match(html, /blob:snapshot.dataUri/);
  assert.match(html, /window\.openai/);
  assert.match(html, /sendFollowUpMessage/);
  assert.equal(/https?:\/\//.test(html), false);
  assert.equal(/<script[^>]*\ssrc=/i.test(html), false);
  assert.equal(/innerHTML\s*=/.test(html), false, 'widget must not assign innerHTML');

  const resource = buildWidgetResourceContent();
  assert.equal(resource.uri, WIDGET_RESOURCE_URI);
  assert.equal(resource.mimeType, 'text/html;profile=mcp-app');
  assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.equal(resource._meta.ui.prefersBorder, true);
});

test('capabilities describe the honest fidelity subset', () => {
  const capabilities = buildCapabilities();
  assert.deepEqual(capabilities.supportedSubset.platforms, ['wechat', 'xiaohongshu', 'imessage', 'whatsapp', 'slack', 'instagram']);
  assert.deepEqual(capabilities.supportedSubset.nativelyRenderedMessageTypes, ['text', 'image', 'location', 'system', 'contact', 'transfer', 'voice', 'video', 'link', 'album']);
  assert.deepEqual(capabilities.supportedSubset.degradedMessageTypes, []);
  assert.deepEqual(capabilities.supportedSubset.persistedNotRendered, []);
  assert.equal(capabilities.limits.scene.messagesMax, 120);
  assert.match(capabilities.auth.header, /Authorization: Bearer/);
});

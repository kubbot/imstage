/**
 * MCP instance-scoped projects, templates and deterministic batches.
 *
 * The calling AI supplies all content; MCP only validates and saves. These
 * tests use the real SDK client over the isolated instance database and assert
 * ownership boundaries, revision conflicts, atomic batch validation and
 * idempotent retries without touching the Web account database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { resolveMcpConfig } from '../services/mcp/config.mjs';
import { EXAMPLE_CREATE_SCENE } from '../services/mcp/scene.mjs';
import { startMcpServer } from '../services/mcp/server.mjs';

const TOKEN = 'test-token-1234567890';
const QUIET_LOGGER = { log() {}, warn() {}, error() {}, debug() {} };

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'imstage-mcp-projects-'));
}

async function startServer(dataDir) {
  const config = resolveMcpConfig({ IMSTAGE_MCP_DATA_DIR: dataDir, IMSTAGE_MCP_TOKEN: TOKEN, IMSTAGE_MCP_PORT: '0' });
  return startMcpServer({ config, logger: QUIET_LOGGER });
}

async function connectClient(url) {
  const client = new Client({ name: 'imstage-mcp-projects-test', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  return client;
}

function sceneArgument(overrides = {}) {
  return { ...structuredClone(EXAMPLE_CREATE_SCENE), ...overrides };
}

function templateArgument(overrides = {}) {
  return {
    name: 'MCP 模板',
    description: '可复用实例模板',
    scene: sceneArgument(),
    variables: [{ key: 'field_1', label: 'Person', type: 'text', target: { entity: 'participant', id: 'p-ayuan', field: 'name' } }],
    ...overrides,
  };
}

function error(result) {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error;
}

async function withServer(run) {
  const dataDir = tempDataDir();
  let handle;
  let client;
  try {
    handle = await startServer(dataDir);
    client = await connectClient(handle.url);
    await run(client, handle);
  } finally {
    if (client) await client.close().catch(() => {});
    if (handle) await handle.close().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

test('MCP templates use the shared contract, isolate revisions and reject unsafe targets', async () => {
  await withServer(async (client) => {
    const created = await client.callTool({ name: 'imstage_create_template', arguments: { template: templateArgument() } });
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
    const template = created.structuredContent.template;
    assert.equal(template.revision, 1);
    assert.equal(template.variableCount, 1);
    assert.equal(template.definition.scene.participants.length, 2);

    const listed = await client.callTool({ name: 'imstage_list_templates', arguments: {} });
    assert.equal(listed.structuredContent.items.length, 1);
    assert.equal('definition' in listed.structuredContent.items[0], false, 'list stays lightweight');

    const fetched = await client.callTool({ name: 'imstage_get_template', arguments: { templateId: template.id } });
    assert.equal(fetched.structuredContent.template.definition.variables[0].key, 'field_1');

    const updated = await client.callTool({
      name: 'imstage_update_template',
      arguments: { templateId: template.id, expectedRevision: 1, template: templateArgument({ name: '改名模板' }) },
    });
    assert.equal(updated.structuredContent.template.revision, 2);
    assert.equal(updated.structuredContent.template.name, '改名模板');

    const stale = await client.callTool({
      name: 'imstage_update_template',
      arguments: { templateId: template.id, expectedRevision: 1, template: templateArgument() },
    });
    assert.equal(error(stale).code, 'revision_conflict');

    const unsafe = await client.callTool({
      name: 'imstage_create_template',
      arguments: { template: templateArgument({ variables: [{ key: 'field_1', label: 'Person', type: 'text', target: { entity: 'participant', id: 'missing', field: 'name' } }] }) },
    });
    assert.equal(error(unsafe).code, 'invalid_template');

    const reference = await client.callTool({
      name: 'imstage_create_template',
      arguments: { template: templateArgument({ scene: { ...sceneArgument(), reference: { source: 'data:image/png;base64,AAAA' } } }) },
    });
    assert.equal(error(reference).code, 'invalid_request');

    const unknown = await client.callTool({ name: 'imstage_get_template', arguments: { templateId: '00000000-0000-4000-8000-000000000000' } });
    assert.equal(error(unknown).code, 'not_found');
  });
});

test('MCP projects bound rules/defaults and enforce optimistic revisions', async () => {
  await withServer(async (client) => {
    const created = await client.callTool({
      name: 'imstage_create_project',
      arguments: { project: { name: '实例项目', rules: '固定语气', defaults: { platform: 'wechat' } } },
    });
    const project = created.structuredContent.project;
    assert.equal(project.revision, 1);
    assert.deepEqual(project.defaults, { platform: 'wechat' });

    const fetched = await client.callTool({ name: 'imstage_get_project', arguments: { projectId: project.projectId } });
    assert.equal(fetched.structuredContent.project.name, '实例项目');
    assert.deepEqual(fetched.structuredContent.batches, []);

    const listed = await client.callTool({ name: 'imstage_list_projects', arguments: {} });
    assert.equal(listed.structuredContent.items.length, 1);

    const updated = await client.callTool({
      name: 'imstage_update_project',
      arguments: { projectId: project.projectId, expectedRevision: 1, project: { name: '实例项目 2', rules: '更短的语气' } },
    });
    assert.equal(updated.structuredContent.project.revision, 2);

    const stale = await client.callTool({
      name: 'imstage_update_project',
      arguments: { projectId: project.projectId, expectedRevision: 1, project: { name: 'x' } },
    });
    assert.equal(error(stale).code, 'revision_conflict');

    const badDefaults = await client.callTool({
      name: 'imstage_create_project',
      arguments: { project: { name: 'bad', defaults: { nested: { deep: true } } } },
    });
    assert.equal(error(badDefaults).code, 'invalid_request');

    const missing = await client.callTool({ name: 'imstage_get_project', arguments: { projectId: 'prj_missing' } });
    assert.equal(error(missing).code, 'project_not_found');
  });
});

test('MCP batch creates independent scenes atomically, idempotently and without any model call', async () => {
  await withServer(async (client) => {
    const project = (await client.callTool({ name: 'imstage_create_project', arguments: { project: { name: '批量项目', rules: '共同规则' } } })).structuredContent.project;
    const template = (await client.callTool({ name: 'imstage_create_template', arguments: { template: templateArgument() } })).structuredContent.template;

    const key = 'batch-key-1';
    const items = [
      { name: 'Ava', prompt: '描述 Ava', values: { field_1: 'Ava' } },
      { name: 'Noah', prompt: '描述 Noah', values: { field_1: 'Noah' }, patch: { set: { title: 'Noah 的对话' } } },
      { name: 'Full', prompt: '完整场景', scene: sceneArgument({ title: '完整场景' }) },
    ];
    const created = await client.callTool({
      name: 'imstage_create_batch',
      arguments: { projectId: project.projectId, templateId: template.id, templateRevision: template.revision, clientIdempotencyKey: key, items },
    });
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
    const batch = created.structuredContent;
    assert.equal(batch.itemCount, 3);
    assert.equal(batch.templateRevision, 1);
    assert.equal(batch.receipt.items.length, 3);
    const ids = batch.items.map((item) => item.sceneId);
    assert.equal(new Set(ids).size, 3, 'each item gets an independent scene id');

    // Produced scenes are ordinary MCP scenes: existing tools operate unchanged.
    const first = await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId: ids[0] } });
    assert.equal(first.structuredContent.scene.participants.find((p) => p.id === 'p-ayuan').name, 'Ava');
    const second = await client.callTool({ name: 'imstage_get_scene', arguments: { sceneId: ids[1] } });
    assert.equal(second.structuredContent.scene.title, 'Noah 的对话');
    assert.equal(second.structuredContent.scene.participants.find((p) => p.id === 'p-ayuan').name, 'Noah');

    const sourceTemplate = await client.callTool({ name: 'imstage_get_template', arguments: { templateId: template.id } });
    assert.equal(sourceTemplate.structuredContent.template.definition.scene.participants.find((p) => p.id === 'p-ayuan').name, '阿远', 'source template never mutates');

    // Idempotent replay with the identical payload returns the same receipt.
    const replay = await client.callTool({
      name: 'imstage_create_batch',
      arguments: { projectId: project.projectId, templateId: template.id, templateRevision: template.revision, clientIdempotencyKey: key, items },
    });
    assert.equal(replay.structuredContent.batchId, batch.batchId);
    assert.equal(replay.structuredContent.deduplicated, true);

    // Same key with a changed payload is a conflict, never a silent overwrite.
    const conflict = await client.callTool({
      name: 'imstage_create_batch',
      arguments: { projectId: project.projectId, templateId: template.id, clientIdempotencyKey: key, items: [items[0]] },
    });
    assert.equal(error(conflict).code, 'idempotency_conflict');

    const got = await client.callTool({ name: 'imstage_get_batch', arguments: { batchId: batch.batchId } });
    assert.equal(got.structuredContent.items.length, 3);
    assert.equal(got.structuredContent.rules, '共同规则');

    const batches = await client.callTool({ name: 'imstage_list_batches', arguments: { projectId: project.projectId } });
    assert.equal(batches.structuredContent.items.length, 1);
    assert.equal(batches.structuredContent.items[0].sceneIds.length, 3);
  });
});

test('MCP batch validates the full request before writing anything', async () => {
  await withServer(async (client) => {
    const project = (await client.callTool({ name: 'imstage_create_project', arguments: { project: { name: '原子项目' } } })).structuredContent.project;
    const template = (await client.callTool({ name: 'imstage_create_template', arguments: { template: templateArgument() } })).structuredContent.template;

    const cases = [
      { items: [{ name: 'A', prompt: 'p', values: { unknown: 'x' } }], templateId: template.id, code: 'validation_error' },
      { items: [{ name: 'A', prompt: 'p' }], templateId: template.id, templateRevision: 99, code: 'revision_conflict' },
      { items: [{ name: 'A', prompt: 'p', scene: sceneArgument(), values: { field_1: 'x' } }], templateId: template.id, code: 'invalid_request' },
      { items: Array.from({ length: 21 }, (_, i) => ({ name: `n${i}`, prompt: 'p' })), templateId: template.id, code: 'limit_exceeded' },
      { items: [{ name: 'A', prompt: 'p' }], code: 'invalid_request' },
      { items: [{ name: 'A', prompt: 'p', scene: { ...sceneArgument(), platform: 'unknown' } }], code: 'unsupported_platform' },
    ];
    for (const entry of cases) {
      const args = { projectId: project.projectId, items: entry.items };
      if (entry.templateId) args.templateId = entry.templateId;
      if (entry.templateRevision) args.templateRevision = entry.templateRevision;
      const result = await client.callTool({ name: 'imstage_create_batch', arguments: args });
      assert.equal(error(result).code, entry.code, JSON.stringify(result.structuredContent));
    }
    // Nothing was written by any rejected request.
    const batches = await client.callTool({ name: 'imstage_list_batches', arguments: {} });
    assert.deepEqual(batches.structuredContent.items, []);
    const projectAfter = await client.callTool({ name: 'imstage_get_project', arguments: { projectId: project.projectId } });
    assert.deepEqual(projectAfter.structuredContent.batches, []);
    assert.equal(projectAfter.structuredContent.project.batchCount, 0);

    // A missing project and unknown template are explicit, not silent.
    const missingProject = await client.callTool({ name: 'imstage_create_batch', arguments: { projectId: 'prj_missing', items: [{ name: 'A', prompt: 'p', scene: sceneArgument() }] } });
    assert.equal(error(missingProject).code, 'project_not_found');
    const missingTemplate = await client.callTool({ name: 'imstage_create_batch', arguments: { projectId: project.projectId, templateId: '00000000-0000-4000-8000-000000000000', items: [{ name: 'A', prompt: 'p' }] } });
    assert.equal(error(missingTemplate).code, 'not_found');
  });
});

test('MCP update_project preserves omitted rules and defaults for a rename', async () => {
  await withServer(async (client) => {
    const created = await client.callTool({
      name: 'imstage_create_project',
      arguments: { project: { name: '原项目', rules: '固定语气，保留 4 条消息', defaults: { platform: 'wechat' } } },
    });
    const project = created.structuredContent.project;

    const renamed = await client.callTool({
      name: 'imstage_update_project',
      arguments: { projectId: project.projectId, expectedRevision: 1, project: { name: '重命名项目' } },
    });
    assert.equal(renamed.structuredContent.project.name, '重命名项目');
    assert.equal(renamed.structuredContent.project.rules, '固定语气，保留 4 条消息', 'rename must not clear rules');
    assert.deepEqual(renamed.structuredContent.project.defaults, { platform: 'wechat' }, 'rename must not clear defaults');

    // The frozen batch receipt keeps the preserved rules snapshot.
    const template = (await client.callTool({ name: 'imstage_create_template', arguments: { template: templateArgument() } })).structuredContent.template;
    const batch = await client.callTool({
      name: 'imstage_create_batch',
      arguments: { projectId: project.projectId, templateId: template.id, items: [{ name: 'A', prompt: 'p', values: { field_1: 'Ava' } }] },
    });
    assert.equal(batch.isError, undefined, JSON.stringify(batch.structuredContent));
    assert.equal(batch.structuredContent.receipt.rules, '固定语气，保留 4 条消息');

    // Explicit clears still work when requested.
    const cleared = await client.callTool({
      name: 'imstage_update_project',
      arguments: { projectId: project.projectId, expectedRevision: 2, project: { rules: '' } },
    });
    assert.equal(cleared.structuredContent.project.rules, '');
    assert.equal(cleared.structuredContent.project.name, '重命名项目');
  });
});

test('MCP batch enforces adapter bounds on template instances and writes nothing on failure', async () => {
  await withServer(async (client) => {
    const project = (await client.callTool({ name: 'imstage_create_project', arguments: { project: { name: '边界项目' } } })).structuredContent.project;
    const scene = sceneArgument();
    scene.messages = [{ ...scene.messages[0], id: 'm-long', text: 'x'.repeat(1500) }];
    const template = (await client.callTool({
      name: 'imstage_create_template',
      arguments: {
        template: {
          name: '边界模板',
          description: '',
          scene,
          variables: [
            { key: 'field_1', label: 'Message', type: 'text', target: { entity: 'message', id: 'm-long', field: 'text' } },
            { key: 'field_2', label: 'Person', type: 'text', target: { entity: 'participant', id: 'p-ayuan', field: 'name' } },
          ],
        },
      },
    })).structuredContent.template;

    // Shared limits allow 4000-char text and 100-char names; MCP caps them at
    // 2000/60. Both must be rejected before the atomic write.
    for (const values of [{ field_1: 'y'.repeat(3000) }, { field_2: 'z'.repeat(80) }]) {
      const result = await client.callTool({
        name: 'imstage_create_batch',
        arguments: { projectId: project.projectId, templateId: template.id, items: [{ name: 'A', prompt: 'p', values }] },
      });
      assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
      assert.equal(result.structuredContent.error.code, 'limit_exceeded');
    }
    const batches = await client.callTool({ name: 'imstage_list_batches', arguments: {} });
    assert.deepEqual(batches.structuredContent.items, []);
    const projectAfter = await client.callTool({ name: 'imstage_get_project', arguments: { projectId: project.projectId } });
    assert.equal(projectAfter.structuredContent.project.batchCount, 0);
  });
});

test('canonical batch hashing preserves own prototype keys', async () => {
  const { stableStringify } = await import('../services/mcp/util.mjs');
  const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}');
  assert.ok(Object.prototype.hasOwnProperty.call(withProto, '__proto__'), 'JSON.parse keeps an own __proto__ key');
  assert.match(stableStringify(withProto), /"__proto__"/);
  assert.notEqual(stableStringify(withProto), stableStringify({ a: 1 }), 'a changed payload must not hash the same');

  const defined = {};
  Object.defineProperty(defined, '__proto__', { value: { evil: true }, enumerable: true, configurable: true, writable: true });
  defined.a = 1;
  assert.match(stableStringify(defined), /"__proto__"/);
});

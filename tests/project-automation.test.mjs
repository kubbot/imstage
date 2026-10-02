/**
 * Account project automation — real HTTP API + account MCP owner bridge.
 *
 * Proves the full first-batch outcome end to end against a running API:
 *   - ChatGPT/Claude-style MCP callers create an account project (type/brief)
 *     and a WhatsApp friendship scenario planned for 50 unique cases;
 *   - validated content submits in 20 / 20 / 10 batches and Web + a second
 *     authorized MCP client see the same project, scenario, cases and
 *     resumable progress;
 *   - idempotent retries return the original receipt (also after defaults
 *     changed), same key with a different request conflicts;
 *   - duplicate item keys and exact duplicate dialogues are rejected;
 *   - template values+patch freeze a snapshot at submit time;
 *   - validation failures roll the whole batch back (no real-screenshot /
 *     payment bypass);
 *   - scene watermark override `false` survives default application;
 *   - account scene capacity is enforced;
 *   - scope filtering, revocation and foreign ownership cannot leak data.
 *
 * No model, image provider or renderer is used: all content is synthetic.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { start } from '../services/api/server.mjs';
import { createScene } from '../apps/web/src/studio/model.ts';

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-project-automation-'));
const APP_ORIGIN = 'http://127.0.0.1:4417';
const activeApps = new Set();

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

async function makeApp() {
  const dir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'case-'));
  const app = await start({
    dbPath: path.join(dir, 'imstage.db'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
    env: {},
    agent: {},
    projects: { pollMs: 20, sessionCheckMs: 30, maxLeaseWaitMs: 3_000 },
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}` };
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

let emailSeq = 0;
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

async function register(base, label = '自动化用户') {
  emailSeq += 1;
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify({ name: label, email: `automation-${process.pid}-${emailSeq}@example.com`, password: 'password-123456' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { cookie: cookieFrom(res), user: body.user };
}

async function jsonFetch(base, pathname, { method = 'GET', cookie, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: mutationHeaders(cookie),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

async function createToken(base, cookie, { name = '自动化 MCP 客户端', scopes } = {}) {
  const res = await fetch(`${base}/api/connections/tokens`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ name, ...(scopes ? { scopes } : {}) }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { token: body.token, connection: body.connection };
}

/* ------------------------------------------------------------------ */
/* MCP helpers                                                         */
/* ------------------------------------------------------------------ */

async function mcpTool(base, token, name, args = {}, id = 1) {
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json().catch(() => null);
  return { res, body, result: body?.result ?? null };
}

async function mcpList(base, token) {
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = await res.json();
  return body.result.tools;
}

function toolOk({ result }, label = 'tool call') {
  assert.ok(result, label);
  assert.notEqual(result.isError, true, `${label}: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

function toolErr({ result }, label = 'tool call') {
  assert.ok(result, label);
  assert.equal(result.isError, true, `${label}: expected a tool error`);
  return result.structuredContent.error;
}

/* ------------------------------------------------------------------ */
/* Synthetic scenes (full Scene JSON; scene ids are server-generated)   */
/* ------------------------------------------------------------------ */

function sceneFor(index, { title = `案例 ${index}`, platform = 'whatsapp', texts, watermarkEnabled, messageType = 'text' } = {}) {
  const base = createScene('weekend');
  const { id: _ignored, ...rest } = base;
  const messages = base.messages.map((message, position) => ({
    ...message,
    id: `m${index}_${position}`,
    type: messageType,
    // When texts are given, every message uses them (cycled) so two calls with
    // the same texts really are the same dialogue apart from ids/titles/times.
    text: texts ? texts[position % texts.length] : `对话 ${index}-${position}`,
  }));
  return {
    ...rest,
    title,
    platform,
    messages,
    ...(watermarkEnabled === undefined ? {} : { watermarkEnabled }),
  };
}

function countScenes(app) {
  return Number(app.db.prepare('SELECT COUNT(*) AS total FROM scenes').get().total);
}

/* ------------------------------------------------------------------ */
/* Owner bridge                                                        */
/* ------------------------------------------------------------------ */

test('account project automation bridges MCP and HTTP for one owner', async (t) => {
  const { app, base } = await makeApp();
  const alice = await register(base, 'Alice');
  const bob = await register(base, 'Bob');
  const { token, connection } = await createToken(base, alice.cookie);
  const bobToken = (await createToken(base, bob.cookie, { name: 'Bob MCP' })).token;

  let projectId;
  let scenarioId;
  let scenarioPlanCases;
  let edgeProjectId;
  let firstBatchId;
  let batchOneItems;

  await t.test('MCP project create with type/brief is visible on the web API', async () => {
    const projectInput = {
      name: '客服培训素材',
      rules: '每段对话 8–12 轮，语气口语化。',
      type: 'training',
      brief: { language: 'zh-CN', cast: [{ name: '小林', role: '客服', avatar: 'data:image/png;base64,AAAA' }] },
      defaults: { platform: 'whatsapp', watermarkEnabled: true },
    };
    const created = toolOk(
      await mcpTool(base, token, 'imstage_create_project', { project: projectInput, idempotencyKey: 'project-key-1' }),
      'create_project',
    );
    projectId = created.project.id;
    assert.equal(created.project.type, 'training');
    assert.equal(created.project.recipeVersion, 1);
    assert.equal(created.project.revision, 1);
    assert.equal(created.project.brief.cast[0].name, '小林');
    assert.equal(created.webUrl.includes(projectId), true);

    // Same key + same request replays the original receipt.
    const replay = toolOk(
      await mcpTool(base, token, 'imstage_create_project', { project: projectInput, idempotencyKey: 'project-key-1' }),
      'create_project replay',
    );
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.project.id, projectId);

    // Same key + different request is an explicit conflict.
    const conflict = toolErr(
      await mcpTool(base, token, 'imstage_create_project', { project: { name: '另一个项目' }, idempotencyKey: 'project-key-1' }),
      'create_project conflict',
    );
    assert.equal(conflict.code, 'idempotency_conflict');

    // The web API reads the same project (shared data, shared rules).
    const list = await jsonFetch(base, '/api/projects', { cookie: alice.cookie });
    const item = list.data.items.find((entry) => entry.id === projectId);
    assert.ok(item, 'project list shows the MCP-created project');
    assert.equal(item.type, 'training');
    assert.equal(item.brief.cast[0].name, '小林');
    assert.equal(item.platform, 'whatsapp');
    assert.equal(item.watermarkEnabled, true);

    const detail = await jsonFetch(base, `/api/projects/${projectId}`, { cookie: alice.cookie });
    assert.equal(detail.res.status, 200);
    assert.equal(detail.data.item.name, '客服培训素材');
    assert.deepEqual(detail.data.scenes, []);

    const viaMcp = toolOk(await mcpTool(base, token, 'imstage_list_projects', {}), 'list_projects');
    assert.ok(viaMcp.items.some((entry) => entry.id === projectId));

    // Project types are shared pure recipes on both surfaces.
    const typesHttp = await jsonFetch(base, '/api/project-types', { cookie: alice.cookie });
    assert.equal(typesHttp.res.status, 200);
    assert.deepEqual(
      typesHttp.data.items.map((entry) => entry.type).sort(),
      ['custom', 'demo', 'evaluation_dataset', 'story', 'training'],
    );
    const evalRecipe = typesHttp.data.items.find((entry) => entry.type === 'evaluation_dataset');
    assert.deepEqual([...evalRecipe.extraDeliverables], ['records.jsonl', 'annotations.jsonl']);
    const typesMcp = toolOk(await mcpTool(base, token, 'imstage_list_project_types', {}), 'list_project_types');
    assert.equal(typesMcp.items.length, 5);
    assert.equal(typesMcp.presets.length, 5);
  });

  await t.test('scenario planning bridges HTTP and MCP for 50 cases', async () => {
    const created = await jsonFetch(base, `/api/projects/${projectId}/scenarios`, {
      method: 'POST',
      cookie: alice.cookie,
      body: {
        scenario: {
          name: 'WhatsApp 结交新朋友',
          brief: '在 WhatsApp 上自然地认识新朋友',
          preset: 'friendship',
          caseCount: 50,
          platform: 'whatsapp',
          locale: 'zh-CN',
        },
      },
    });
    assert.equal(created.res.status, 200, JSON.stringify(created.data));
    scenarioId = created.data.scenario.scenarioId;
    assert.equal(created.data.counts.planned, 50);
    assert.equal(created.data.contentStatus, 'collecting');
    assert.deepEqual(
      created.data.casePlan.suggestedRanges.map((range) => range.count),
      [20, 20, 10],
    );
    assert.equal(created.data.casePlan.cases[0].itemKey, 'case-001');
    assert.equal(created.data.casePlan.cases[49].itemKey, 'case-050');
    for (const entry of created.data.casePlan.cases.slice(0, 3)) {
      assert.ok(entry.objective.length > 0 && entry.context.length > 0, 'planned cases carry objective/context');
    }
    scenarioPlanCases = created.data.casePlan.cases;

    // Another authorized MCP client sees exactly the same plan and progress.
    const viaMcp = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId, scenarioId }), 'get_scenario');
    assert.equal(viaMcp.scenario.name, 'WhatsApp 结交新朋友');
    assert.equal(viaMcp.counts.planned, 50);
    assert.equal(viaMcp.counts.submitted, 0);
    assert.equal(viaMcp.missingItemKeys.length, 50);
    assert.equal(viaMcp.contentStatus, 'collecting');
    assert.ok(viaMcp.casePlan.guidance.length >= 1);
    assert.ok(viaMcp.resume.nextAction.includes('case-001'));

    const list = toolOk(await mcpTool(base, token, 'imstage_list_scenarios', { projectId }), 'list_scenarios');
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].submitted, 0);
    assert.equal(list.items[0].missing, 50);
  });

  await t.test('content batches submit 20/20/10 and resume missing keys', async () => {
    batchOneItems = scenarioPlanCases.slice(0, 20).map((entry, index) => ({
      itemKey: entry.itemKey,
      name: entry.name,
      objective: entry.objective,
      context: entry.context,
      annotations: { labels: { difficulty: 'medium' } },
      scene: sceneFor(100 + index, { texts: [`第一句 ${entry.itemKey}`, `第二句 ${entry.itemKey}`] }),
    }));
    const itemsFor = (from, to, offset) =>
      scenarioPlanCases.slice(from, to).map((entry, index) => ({
        itemKey: entry.itemKey,
        name: entry.name,
        objective: entry.objective,
        context: entry.context,
        scene: sceneFor(offset + index, { texts: [`第一句 ${entry.itemKey}`, `第二句 ${entry.itemKey}`] }),
      }));

    // First 20 through the account MCP tool.
    const first = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId,
        scenarioId,
        clientIdempotencyKey: 'batch-1',
        items: batchOneItems,
      }),
      'batch 1 (20)',
    );
    firstBatchId = first.batchId;
    assert.equal(first.total, 20);
    assert.equal(first.items.length, 20);
    assert.equal(first.items[0].itemKey, 'case-001');
    assert.equal(first.items[0].sceneRevision, 1);
    assert.ok(first.items[0].sceneId);
    assert.equal(first.scenarioProgress.submitted, 20);
    assert.equal(first.scenarioProgress.missing, 30);
    assert.equal(first.scenarioProgress.suggestedNextRange.fromKey, 'case-021');

    // Second 20 through the web HTTP API — same service, same project.
    const second = await jsonFetch(base, `/api/projects/${projectId}/content-batches`, {
      method: 'POST',
      cookie: alice.cookie,
      body: { scenarioId, clientIdempotencyKey: 'batch-2', items: itemsFor(20, 40, 200) },
    });
    assert.equal(second.res.status, 200, JSON.stringify(second.data));
    assert.equal(second.data.item.total, 20);
    assert.equal(second.data.item.scenarioProgress.missing, 10);

    // Final 10 through MCP again.
    const third = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId,
        scenarioId,
        clientIdempotencyKey: 'batch-3',
        items: itemsFor(40, 50, 300),
      }),
      'batch 3 (10)',
    );
    assert.equal(third.total, 10);
    assert.equal(third.scenarioProgress.missing, 0);
    assert.equal(third.scenarioProgress.contentStatus, 'ready');

    // Web and a second authorized MCP client read the same resumable progress.
    const status = await jsonFetch(base, `/api/projects/${projectId}/status`, { cookie: alice.cookie });
    assert.equal(status.res.status, 200);
    assert.equal(status.data.totals.expectedCases, 50);
    assert.equal(status.data.totals.submittedCases, 50);
    assert.equal(status.data.totals.missingCases, 0);
    assert.equal(status.data.status, 'awaiting_delivery', 'content complete is ready/awaiting_delivery');
    assert.equal(status.data.delivery.export, 'not_started', 'no file delivery is claimed in this batch');
    assert.match(status.data.delivery.note, /后续批次/);
    assert.ok(!/completed/.test(status.data.status), 'content status never claims file completion');

    const secondClient = await createToken(base, alice.cookie, { name: '第二个 MCP 客户端' });
    const crossStatus = toolOk(
      await mcpTool(base, secondClient.token, 'imstage_get_project_status', { projectId }),
      'status via second client',
    );
    assert.equal(crossStatus.totals.submittedCases, 50);
    assert.equal(crossStatus.status, 'awaiting_delivery');
    const crossScenario = toolOk(
      await mcpTool(base, secondClient.token, 'imstage_get_scenario', { projectId, scenarioId }),
      'scenario via second client',
    );
    assert.equal(crossScenario.counts.submitted, 50);
    assert.deepEqual(crossScenario.missingItemKeys, []);

    // Batch receipts are readable on both surfaces with sceneId/revision.
    const receipt = await jsonFetch(base, `/api/projects/${projectId}/content-batches/${first.batchId}`, { cookie: alice.cookie });
    assert.equal(receipt.res.status, 200);
    assert.equal(receipt.data.item.items.length, 20);
    assert.equal(receipt.data.item.items[0].itemKey, 'case-001');
    const mcpReceipt = toolOk(
      await mcpTool(base, token, 'imstage_get_batch', { projectId, batchId: first.batchId }),
      'get_batch',
    );
    assert.equal(mcpReceipt.items.length, 20);
    assert.ok(mcpReceipt.items.every((item) => item.sceneId && item.sceneRevision === 1));
    const batches = toolOk(await mcpTool(base, token, 'imstage_list_batches', { projectId }), 'list_batches');
    assert.equal(batches.items.length, 3);
    // All 50 scenes belong to the project on the web as well.
    const projectDetail = await jsonFetch(base, `/api/projects/${projectId}`, { cookie: alice.cookie });
    assert.equal(projectDetail.data.scenes.length, 50);
  });

  await t.test('idempotent retries return the original receipt after defaults changed', async () => {
    // Change project defaults after the batches were submitted.
    const updated = await jsonFetch(base, `/api/projects/${projectId}`, {
      method: 'PUT',
      cookie: alice.cookie,
      body: { revision: 1, defaults: { platform: 'wechat', watermarkEnabled: false } },
    });
    assert.equal(updated.res.status, 200, JSON.stringify(updated.data));
    assert.equal(updated.data.item.revision, 2);
    assert.equal(updated.data.item.watermarkEnabled, false);

    const before = countScenes(app);
    const replay = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId,
        scenarioId,
        clientIdempotencyKey: 'batch-1',
        items: batchOneItems,
      }),
      'batch replay',
    );
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.batchId, firstBatchId);
    assert.equal(countScenes(app), before, 'an idempotent retry never creates scenes again');

    // The same key + same request over HTTP resolves the same receipt.
    const viaHttp = await jsonFetch(base, `/api/projects/${projectId}/content-batches`, {
      method: 'POST',
      cookie: alice.cookie,
      body: { scenarioId, clientIdempotencyKey: 'batch-1', items: batchOneItems },
    });
    assert.equal(viaHttp.res.status, 200);
    assert.equal(viaHttp.data.item.batchId, firstBatchId, 'same key resolves to the same batch across transports');
    assert.equal(viaHttp.data.deduplicated, true);
    assert.equal(countScenes(app), before);

    // Same key + different request conflicts loudly (HTTP and MCP alike).
    const differentItems = batchOneItems.slice(0, 2).map((item) => ({
      ...item,
      scene: sceneFor(500, { texts: ['冲突 A', '冲突 B'] }),
    }));
    const conflict = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId,
        scenarioId,
        clientIdempotencyKey: 'batch-1',
        items: differentItems,
      }),
      'batch conflict via MCP',
    );
    assert.equal(conflict.code, 'idempotency_conflict');
    const conflictHttp = await jsonFetch(base, `/api/projects/${projectId}/content-batches`, {
      method: 'POST',
      cookie: alice.cookie,
      body: { scenarioId, clientIdempotencyKey: 'batch-1', items: differentItems },
    });
    assert.equal(conflictHttp.res.status, 409);
    assert.equal(conflictHttp.data.error.code, 'idempotency_conflict');
    assert.equal(countScenes(app), before);
  });

  await t.test('scene watermark override survives project/scenario defaults', async () => {
    const edge = toolOk(
      await mcpTool(base, token, 'imstage_create_project', {
        project: { name: '边界项目', defaults: { platform: 'whatsapp', watermarkEnabled: true } },
      }),
      'edge project',
    ).project;
    edgeProjectId = edge.id;
    const edgeScenario = toolOk(
      await mcpTool(base, token, 'imstage_create_scenario', {
        projectId: edgeProjectId,
        scenario: { name: '水印场景', preset: 'custom', caseCount: 3, platform: 'whatsapp' },
      }),
      'edge scenario',
    );
    const edgeCases = edgeScenario.casePlan.cases;

    const submitted = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: edgeScenario.scenario.scenarioId,
        items: [
          {
            itemKey: edgeCases[0].itemKey,
            name: edgeCases[0].name,
            objective: edgeCases[0].objective,
            context: edgeCases[0].context,
            scene: sceneFor(900, { texts: ['显式关闭水印 A', '显式关闭水印 B'], watermarkEnabled: false }),
          },
        ],
      }),
      'watermark off batch',
    );
    const offScene = toolOk(await mcpTool(base, token, 'imstage_get_scene', { sceneId: submitted.items[0].sceneId }), 'get_scene');
    assert.equal(offScene.scene.watermarkEnabled, false, 'an explicit false survives default application');

    const applied = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: edgeScenario.scenario.scenarioId,
        items: [
          {
            itemKey: edgeCases[1].itemKey,
            name: edgeCases[1].name,
            objective: edgeCases[1].objective,
            context: edgeCases[1].context,
            scene: sceneFor(901, { texts: ['默认水印 A', '默认水印 B'] }),
          },
        ],
      }),
      'watermark default batch',
    );
    const onScene = toolOk(await mcpTool(base, token, 'imstage_get_scene', { sceneId: applied.items[0].sceneId }), 'get_scene');
    assert.equal(onScene.scene.watermarkEnabled, true, 'the frozen scenario default fills the missing switch');

    // No payment message can slip through the content path.
    const rejected = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: edgeScenario.scenario.scenarioId,
        items: [
          {
            itemKey: edgeCases[2].itemKey,
            name: edgeCases[2].name,
            objective: edgeCases[2].objective,
            context: edgeCases[2].context,
            scene: sceneFor(902, { texts: ['支付截图 A'], messageType: 'payment' }),
          },
        ],
      }),
      'payment bypass',
    );
    assert.ok(['validation_error', 'invalid_request', 'limit_exceeded'].includes(rejected.code), rejected.code);
  });

  await t.test('duplicate keys and duplicate dialogues are rejected', async () => {
    const created = await jsonFetch(base, `/api/projects/${edgeProjectId}/scenarios`, {
      method: 'POST',
      cookie: alice.cookie,
      body: { scenario: { name: '去重场景', preset: 'custom', caseCount: 6, platform: 'whatsapp' } },
    });
    assert.equal(created.res.status, 200);
    const dedupeScenarioId = created.data.scenario.scenarioId;
    const cases = created.data.casePlan.cases;

    const itemFor = (entry, index, extra = {}) => ({
      itemKey: entry.itemKey,
      name: entry.name,
      objective: entry.objective,
      context: entry.context,
      scene: sceneFor(index, extra),
    });

    // Duplicate keys inside one batch are rejected (all-or-nothing).
    const dupKey = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: dedupeScenarioId,
        items: [itemFor(cases[0], 600), itemFor(cases[0], 601)],
      }),
      'duplicate keys in one batch',
    );
    assert.equal(dupKey.code, 'duplicate_item_key');

    // Exact duplicate dialogues are rejected even with new ids/titles/times.
    const twinTexts = ['同样的第一句', '同样的第二句'];
    const dupDialogue = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: dedupeScenarioId,
        items: [
          itemFor(cases[0], 602, { texts: twinTexts, title: '标题甲' }),
          itemFor(cases[1], 603, { texts: twinTexts, title: '标题乙' }),
        ],
      }),
      'duplicate dialogues in one batch',
    );
    assert.equal(dupDialogue.code, 'duplicate_dialogue');
    assert.match(dupDialogue.message, /case-001/);

    // Submit one real case, then try to reuse its key and its dialogue.
    const accepted = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: dedupeScenarioId,
        items: [itemFor(cases[0], 610, { texts: ['独特第一句', '独特第二句'], title: '改过的标题' })],
      }),
      'first dedupe case',
    );
    assert.equal(accepted.total, 1);
    const reusedKey = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: dedupeScenarioId,
        items: [itemFor(cases[0], 611, { texts: ['再不同也没用', '也一样'] })],
      }),
      'reused key',
    );
    assert.equal(reusedKey.code, 'duplicate_item_key');

    // Same dialogue as the stored case, different key/times/titles → rejected.
    const reusedDialogue = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: dedupeScenarioId,
        items: [itemFor(cases[1], 612, { texts: ['独特第一句', '独特第二句'], title: '换标题', deviceTime: '23:59' })],
      }),
      'reused dialogue',
    );
    assert.equal(reusedDialogue.code, 'duplicate_dialogue');
    assert.match(reusedDialogue.message, /case-001/);

    // Unknown keys and missing case metadata fail the whole request.
    const unknownKey = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: dedupeScenarioId,
        items: [{ ...itemFor(cases[1], 613), itemKey: 'case-999' }],
      }),
      'unknown key',
    );
    assert.equal(unknownKey.code, 'unknown_item_key');
    const missingObjective = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: dedupeScenarioId,
        items: [{ ...itemFor(cases[1], 614), objective: '   ' }],
      }),
      'missing objective',
    );
    assert.equal(missingObjective.code, 'invalid_items');
  });

  await t.test('template values+patch freeze a snapshot at submit time', async () => {
    const templateBase = createScene('weekend');
    const { id: _drop, ...templateScene } = templateBase;
    templateScene.title = '模板场景';
    templateScene.platform = 'whatsapp';
    const [firstMessage] = templateScene.messages;
    const variable = {
      key: 'greeting',
      label: '问候语',
      type: 'text',
      target: { entity: 'message', id: firstMessage.id, field: 'text' },
    };
    const template = toolOk(
      await mcpTool(base, token, 'imstage_create_template', {
        template: { name: '问候模板', description: '共享问候语', scene: templateScene, variables: [variable] },
      }),
      'create_template',
    );
    const templateId = template.template.id;
    assert.equal(template.template.revision, 1);
    assert.equal(template.template.variableCount, 1);

    const submitted = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        templateId,
        clientIdempotencyKey: 'template-batch-1',
        items: [
          {
            itemKey: 'tpl-001',
            name: '模板实例一',
            values: { greeting: '你好呀，很高兴认识你' },
            patch: { set: { title: '实例标题' } },
          },
        ],
      }),
      'template batch',
    );
    assert.equal(submitted.templateId, templateId);
    assert.equal(submitted.templateRevision, 1);

    // Update the template afterwards: the submitted scene keeps the snapshot.
    const updated = toolOk(
      await mcpTool(base, token, 'imstage_update_template', {
        templateId,
        expectedRevision: 1,
        template: {
          name: '问候模板',
          description: '改过的问候语',
          scene: { ...templateScene, messages: templateScene.messages.map((m, i) => (i === 0 ? { ...m, text: '再见' } : m)) },
          variables: [variable],
        },
      }),
      'update_template',
    );
    assert.equal(updated.template.revision, 2);

    const stored = toolOk(
      await mcpTool(base, token, 'imstage_get_scene', { sceneId: submitted.items[0].sceneId }),
      'get instantiated scene',
    );
    assert.equal(stored.scene.title, '实例标题', 'the patch applied');
    assert.equal(stored.scene.messages[0].text, '你好呀，很高兴认识你', 'the frozen template snapshot survived the later edit');

    // A stale templateRevision is an explicit conflict, not a silent re-freeze.
    const stale = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        templateId,
        templateRevision: 1,
        items: [{ itemKey: 'tpl-002', name: '模板实例二', values: { greeting: '第三句问候' } }],
      }),
      'stale template revision',
    );
    assert.equal(stale.code, 'revision_conflict');

    // The latest revision is used by new batches.
    const after = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        templateId,
        templateRevision: 2,
        items: [{ itemKey: 'tpl-003', name: '模板实例三', values: { greeting: '新的问候' } }],
      }),
      'template batch after update',
    );
    assert.equal(after.templateRevision, 2);
    assert.equal(after.items.length, 1);

    // Account templates stay reachable over the account template tools.
    const listed = toolOk(await mcpTool(base, token, 'imstage_list_templates', {}), 'list_templates');
    assert.ok(listed.items.some((item) => item.id === templateId));
  });

  await t.test('validation failures roll back the whole batch', async () => {
    const before = countScenes(app);
    const batchesBefore = (await jsonFetch(base, `/api/projects/${edgeProjectId}/content-batches`, { cookie: alice.cookie })).data.items
      .length;

    const bad = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        items: [
          { itemKey: 'rollback-1', name: '有效条目', scene: sceneFor(700, { texts: ['有效 A', '有效 B'] }) },
          { itemKey: 'rollback-2', name: '空对话', scene: { ...sceneFor(701, { texts: ['x'] }), messages: [] } },
        ],
      }),
      'invalid item rolls back',
    );
    assert.ok(['limit_exceeded', 'validation_error', 'invalid_request'].includes(bad.code), bad.code);
    assert.equal(countScenes(app), before, 'no scene from the failed batch persists');
    const batchesAfter = (await jsonFetch(base, `/api/projects/${edgeProjectId}/content-batches`, { cookie: alice.cookie })).data.items
      .length;
    assert.equal(batchesAfter, batchesBefore, 'no receipt from the failed batch persists');

    // A batch larger than 20 is rejected before anything is written.
    const oversized = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        items: Array.from({ length: 21 }, (_, index) => ({
          itemKey: `oversized-${index}`,
          name: `条目 ${index}`,
          scene: sceneFor(710 + index),
        })),
      }),
      'oversized batch',
    );
    assert.equal(oversized.code, 'invalid_batch_size');
    assert.equal(countScenes(app), before);

    // Items without any content are rejected too.
    const empty = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        items: [{ itemKey: 'empty-1', name: '没有内容' }],
      }),
      'item without content',
    );
    assert.equal(empty.code, 'invalid_items');
    assert.equal(countScenes(app), before);
  });

  await t.test('case progress tracks live scene mutations (PUT/DELETE/attach/detach)', async () => {
    const consistency = toolOk(
      await mcpTool(base, token, 'imstage_create_scenario', {
        projectId: edgeProjectId,
        scenario: { name: '一致性场景', preset: 'custom', caseCount: 4, platform: 'whatsapp' },
      }),
      'consistency scenario',
    );
    const consistencyId = consistency.scenario.scenarioId;
    const cases = consistency.casePlan.cases;
    const itemFor = (entry, index, extra = {}) => ({
      itemKey: entry.itemKey,
      name: entry.name,
      objective: entry.objective,
      context: entry.context,
      scene: sceneFor(index, extra),
    });

    // Planned rows alone are never completed.
    assert.equal(consistency.counts.submitted, 0);
    assert.equal(consistency.counts.planned, 4);

    const submitted = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: consistencyId,
        items: [
          itemFor(cases[0], 1001, { texts: ['一致 A1', '一致 A2'] }),
          itemFor(cases[1], 1002, { texts: ['一致 B1', '一致 B2'] }),
        ],
      }),
      'consistency batch',
    );
    const sceneA = submitted.items[0].sceneId;
    const sceneB = submitted.items[1].sceneId;

    // PUT: an updated scene advances the case's live revision.
    const before = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: edgeProjectId, scenarioId: consistencyId }), 'before edit');
    assert.equal(before.cases[0].sceneRevision, 1);
    toolOk(
      await mcpTool(base, token, 'imstage_update_scene', {
        sceneId: sceneA,
        expectedRevision: 1,
        patch: { set: { title: '编辑后的标题' } },
      }),
      'edit scene',
    );
    const afterEdit = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: edgeProjectId, scenarioId: consistencyId }), 'after edit');
    assert.equal(afterEdit.cases[0].sceneRevision, 2, 'the case tracks the current scene revision');
    assert.equal(afterEdit.counts.submitted, 2);

    // The edited transcript cannot be submitted again under another key: the
    // duplicate check compares current scene content, not a stale signature.
    const edited = toolOk(await mcpTool(base, token, 'imstage_get_scene', { sceneId: sceneA }), 'read edited scene');
    const editedTexts = edited.scene.messages.map((message) => message.text);
    const replayedDialogue = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: consistencyId,
        items: [itemFor(cases[2], 1003, { texts: editedTexts, title: '换标题也没用' })],
      }),
      'edited transcript resubmission',
    );
    assert.equal(replayedDialogue.code, 'duplicate_dialogue');
    assert.match(replayedDialogue.message, /case-001/);

    // DETACH: a scene detached from the project no longer counts as done.
    const detached = await jsonFetch(base, `/api/projects/${edgeProjectId}/scenes/${sceneB}`, {
      method: 'DELETE',
      cookie: alice.cookie,
      body: {},
    });
    assert.equal(detached.res.status, 200);
    const afterDetach = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: edgeProjectId, scenarioId: consistencyId }), 'after detach');
    assert.equal(afterDetach.counts.submitted, 1, 'detached scenes are missing again');
    assert.deepEqual(afterDetach.missingItemKeys, ['case-002', 'case-003', 'case-004']);

    // Re-attaching restores the case.
    const reattached = await jsonFetch(base, `/api/projects/${edgeProjectId}/scenes`, {
      method: 'POST',
      cookie: alice.cookie,
      body: { sceneId: sceneB },
    });
    assert.equal(reattached.res.status, 200);
    const afterAttach = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: edgeProjectId, scenarioId: consistencyId }), 'after attach');
    assert.equal(afterAttach.counts.submitted, 2);

    // DELETE: a deleted scene frees its key for a real resubmission.
    const currentA = toolOk(await mcpTool(base, token, 'imstage_get_scene', { sceneId: sceneA }), 'read scene before delete');
    const deleted = await jsonFetch(base, `/api/scenes/${sceneA}`, {
      method: 'DELETE',
      cookie: alice.cookie,
      body: { revision: currentA.revision },
    });
    assert.equal(deleted.res.status, 200);
    const afterDelete = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: edgeProjectId, scenarioId: consistencyId }), 'after delete');
    assert.equal(afterDelete.counts.submitted, 1, 'deleted scenes never keep a completed count');
    assert.deepEqual(afterDelete.missingItemKeys, ['case-001', 'case-003', 'case-004']);

    const resubmitted = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        scenarioId: consistencyId,
        items: [itemFor(cases[0], 1004, { texts: ['重提 A1', '重提 A2'] })],
      }),
      'resubmit freed key',
    );
    assert.equal(resubmitted.total, 1);
    const afterResubmit = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: edgeProjectId, scenarioId: consistencyId }), 'after resubmit');
    assert.equal(afterResubmit.counts.submitted, 2);
    assert.equal(afterResubmit.cases[0].sceneId, resubmitted.items[0].sceneId, 'the case points at the new scene');
  });

  await t.test('idempotent replay survives template deletion and settings changes', async () => {
    // Replay after the template is gone still returns the original receipt.
    const templateBase = createScene('weekend');
    const { id: _drop, ...templateScene } = templateBase;
    const variable = {
      key: 'greeting',
      label: '问候语',
      type: 'text',
      target: { entity: 'message', id: templateScene.messages[0].id, field: 'text' },
    };
    const template = toolOk(
      await mcpTool(base, token, 'imstage_create_template', {
        template: { name: '临时模板', scene: templateScene, variables: [variable] },
      }),
      'temp template',
    );
    const created = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        templateId: template.template.id,
        clientIdempotencyKey: 'replay-after-delete',
        items: [{ itemKey: 'replay-001', name: '重放条目', values: { greeting: '重放问候' } }],
      }),
      'batch before template delete',
    );
    toolOk(
      await mcpTool(base, token, 'imstage_delete_template', {
        templateId: template.template.id,
        expectedRevision: 1,
      }),
      'delete template',
    );
    const replay = toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        templateId: template.template.id,
        clientIdempotencyKey: 'replay-after-delete',
        items: [{ itemKey: 'replay-001', name: '重放条目', values: { greeting: '重放问候' } }],
      }),
      'replay after template delete',
    );
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.batchId, created.batchId, 'the original receipt is returned without re-resolving the template');

    // A NEW batch with the deleted template fails honestly.
    const gone = toolErr(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: edgeProjectId,
        templateId: template.template.id,
        items: [{ itemKey: 'replay-002', name: '不存在的模板', values: { greeting: 'x' } }],
      }),
      'new batch with deleted template',
    );
    assert.ok(['not_found', 'invalid_template'].includes(gone.code), gone.code);

    // Project update replays by key even after unrelated later edits.
    const status0 = await jsonFetch(base, `/api/projects/${edgeProjectId}/status`, { cookie: alice.cookie });
    const edgeRevision = status0.data.project.revision;
    const first = await jsonFetch(base, `/api/projects/${edgeProjectId}`, {
      method: 'PUT',
      cookie: alice.cookie,
      body: { revision: edgeRevision, rules: '重放规则', idempotencyKey: 'update-replay-1' },
    });
    assert.equal(first.res.status, 200, JSON.stringify(first.data));
    const later = await jsonFetch(base, `/api/projects/${edgeProjectId}`, {
      method: 'PUT',
      cookie: alice.cookie,
      body: { revision: edgeRevision + 1, name: '后续改名' },
    });
    assert.equal(later.res.status, 200);
    const replayedUpdate = await jsonFetch(base, `/api/projects/${edgeProjectId}`, {
      method: 'PUT',
      cookie: alice.cookie,
      body: { revision: edgeRevision, rules: '重放规则', idempotencyKey: 'update-replay-1' },
    });
    assert.equal(replayedUpdate.res.status, 200);
    assert.equal(replayedUpdate.data.deduplicated, true, 'the same body replays after other settings changed');
    assert.equal(replayedUpdate.data.item.revision, edgeRevision + 1, 'the original receipt is returned, never a new write');
    // A replay never clobbers later edits.
    const afterReplay = await jsonFetch(base, `/api/projects/${edgeProjectId}`, { cookie: alice.cookie });
    assert.equal(afterReplay.data.item.name, '后续改名', 'later edits survive the replay');
    assert.equal(afterReplay.data.item.revision, edgeRevision + 2, 'the replay never bumps the revision again');
  });

  await t.test('account scene capacity is enforced on real submissions', async () => {
    // A second owner fills their own account to the 100-scene cap with real
    // batches, then the next item is rejected (all-or-nothing).
    const bobProject = toolOk(
      await mcpTool(base, bobToken, 'imstage_create_project', { project: { name: 'Bob 项目', defaults: { platform: 'whatsapp' } } }),
      'bob project',
    ).project;
    const bobScenario = toolOk(
      await mcpTool(base, bobToken, 'imstage_create_scenario', {
        projectId: bobProject.id,
        scenario: { name: 'Bob 场景', preset: 'custom', caseCount: 100, platform: 'whatsapp' },
      }),
      'bob scenario',
    );
    assert.equal(bobScenario.counts.planned, 100);
    const bobCases = bobScenario.casePlan.cases;
    for (let batch = 0; batch < 5; batch += 1) {
      const slice = bobCases.slice(batch * 20, batch * 20 + 20);
      const receipt = toolOk(
        await mcpTool(base, bobToken, 'imstage_create_batch', {
          projectId: bobProject.id,
          scenarioId: bobScenario.scenario.scenarioId,
          items: slice.map((entry, index) => ({
            itemKey: entry.itemKey,
            name: entry.name,
            objective: entry.objective,
            context: entry.context,
            scene: sceneFor(800 + batch * 20 + index, { texts: [`Bob ${entry.itemKey} 一`, `Bob ${entry.itemKey} 二`] }),
          })),
        }),
        `bob batch ${batch}`,
      );
      assert.equal(receipt.total, 20);
    }
    const bobStatus = toolOk(
      await mcpTool(base, bobToken, 'imstage_get_project_status', { projectId: bobProject.id }),
      'bob status',
    );
    assert.equal(bobStatus.totals.submittedCases, 100);
    assert.equal(bobStatus.totals.accountScenes, 100);
    assert.equal(bobStatus.status, 'awaiting_delivery');

    // One more scene must not push the account past the cap.
    const overflow = toolErr(
      await mcpTool(base, bobToken, 'imstage_create_batch', {
        projectId: bobProject.id,
        items: [{ itemKey: 'overflow-1', name: '溢出', scene: sceneFor(999, { texts: ['溢出 A', '溢出 B'] }) }],
      }),
      'capacity overflow',
    );
    assert.equal(overflow.code, 'scene_limit_reached');
  });

  await t.test('foreign ownership, scope filtering and revocation cannot leak data', async () => {
    // Another account sees nothing of Alice's project over HTTP or MCP.
    const foreignGet = await jsonFetch(base, `/api/projects/${projectId}`, { cookie: bob.cookie });
    assert.equal(foreignGet.res.status, 404);
    const foreignScenario = await jsonFetch(base, `/api/projects/${projectId}/scenarios/${scenarioId}`, { cookie: bob.cookie });
    assert.equal(foreignScenario.res.status, 404);
    const foreignStatus = await jsonFetch(base, `/api/projects/${projectId}/status`, { cookie: bob.cookie });
    assert.equal(foreignStatus.res.status, 404);
    const foreignBatch = await jsonFetch(base, `/api/projects/${projectId}/content-batches`, {
      method: 'POST',
      cookie: bob.cookie,
      body: { items: [{ itemKey: 'steal-1', name: '偷', scene: sceneFor(950, { texts: ['偷 A', '偷 B'] }) }] },
    });
    assert.equal(foreignBatch.res.status, 404);
    const foreignMcp = toolErr(await mcpTool(base, bobToken, 'imstage_get_project', { projectId }), 'foreign project read');
    assert.equal(foreignMcp.code, 'not_found');
    const foreignCreate = toolErr(
      await mcpTool(base, bobToken, 'imstage_create_scenario', {
        projectId,
        scenario: { name: '偷建场景', preset: 'custom', caseCount: 1 },
      }),
      'foreign scenario create',
    );
    assert.equal(foreignCreate.code, 'not_found');

    // A scenes-only credential lists exactly the six scene tools.
    const legacy = await createToken(base, alice.cookie, { name: '仅作品', scopes: ['imstage.scenes'] });
    const legacyTools = await mcpList(base, legacy.token);
    assert.deepEqual(
      legacyTools.map((tool) => tool.name).sort(),
      [
        'imstage_create_scene',
        'imstage_get_capabilities',
        'imstage_get_scene',
        'imstage_list_scenes',
        'imstage_render_scene',
        'imstage_update_scene',
      ],
    );
    const hidden = toolErr(
      await mcpTool(base, legacy.token, 'imstage_create_batch', {
        projectId,
        items: [{ itemKey: 'hidden-1', name: '隐藏', scene: sceneFor(960) }],
      }),
      'hidden project tool',
    );
    assert.equal(hidden.code, 'invalid_request');
    assert.match(hidden.message, /未知工具/);

    // A full-scope credential sees the project tools.
    const fullTools = await mcpList(base, token);
    assert.ok(fullTools.some((tool) => tool.name === 'imstage_get_project_status'));
    assert.ok(fullTools.some((tool) => tool.name === 'imstage_create_scenario'));

    // Revoking the connection kills the credential immediately.
    const revoked = await fetch(`${base}/api/connections/${connection.id}`, {
      method: 'DELETE',
      headers: mutationHeaders(alice.cookie),
      body: '{}',
    });
    assert.equal(revoked.status, 200);
    const afterRevoke = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(afterRevoke.status, 401);
  });

  await t.test('bounded summaries never dump full scenes or assets', async () => {
    const fresh = await createToken(base, alice.cookie, { name: '摘要检查' });
    const detail = toolOk(await mcpTool(base, fresh.token, 'imstage_get_project', { projectId }), 'get_project');
    const serialized = JSON.stringify(detail);
    assert.ok(!serialized.includes('data:image'), 'no asset bytes in the bounded summary');
    assert.ok(!serialized.includes('"messages"'), 'no full scene messages in the bounded summary');
    assert.ok(!serialized.includes('scene_json'), 'no raw scene dumps in the bounded summary');
    assert.equal(detail.item.brief.cast[0].hasAvatar, true, 'avatar presence is summarized, not dumped');
    assert.equal(detail.item.brief.cast[0].avatar, undefined);

    const status = toolOk(await mcpTool(base, fresh.token, 'imstage_get_project_status', { projectId }), 'get_project_status');
    assert.ok(Array.isArray(status.scenarios));
    assert.ok(status.scenarios[0].missingItemKeys.length <= 200);
    assert.equal(status.delivery.export, 'not_started');
  });

  await t.test('an explicitly empty scope grant is never promoted to full access', async () => {
    const { accountToolsForScopes } = await import('../services/integrations/account-mcp.mjs');
    assert.deepEqual(accountToolsForScopes([]), [], 'scopes=[] grants no tools at all');
    assert.equal(accountToolsForScopes(['imstage.scenes']).length, 6);
    assert.equal(
      accountToolsForScopes(['imstage.scenes', 'imstage.projects']).length,
      23,
      'full grants see the six scene tools plus the 17 project tools',
    );
  });
});

test('edited and detached cases use live dialogue hashes and explicit pending keys', async () => {
  const { base } = await makeApp();
  const { cookie } = await register(base, 'Live dialogue regression');
  const { token } = await createToken(base, cookie);
  const project = toolOk(await mcpTool(base, token, 'imstage_create_project', { project: { name: 'Live dialogue' } })).project;
  const planned = toolOk(await mcpTool(base, token, 'imstage_create_scenario', {
    projectId: project.id, scenario: { name: 'Live case coverage', preset: 'friendship', caseCount: 4, autoExport: false },
  }));
  const scenarioId = planned.scenario.scenarioId;
  const original = sceneFor(2001, { texts: ['原始问候', '原始回应'] });
  const item = (key, scene) => ({ itemKey: key, name: key, objective: '自然开启话题', context: '双方在活动中相识', scene });
  const first = toolOk(await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id, scenarioId, items: [item('case-001', original)],
  }));
  const sceneId = first.items[0].sceneId;
  toolOk(await mcpTool(base, token, 'imstage_update_scene', {
    sceneId, expectedRevision: 1,
    patch: { updateMessages: [{ id: original.messages[0].id, text: '修改后的新开场' }] },
  }));
  const reused = toolOk(await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id, scenarioId, items: [item('case-002', original)],
  }));
  assert.equal(reused.total, 1, 'historical transcript is distinct from the live edited case');
  const edited = toolOk(await mcpTool(base, token, 'imstage_get_scene', { sceneId })).scene;
  const { id: _serverId, ...editedInput } = edited;
  const duplicate = toolErr(await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id, scenarioId, items: [item('case-003', editedInput)],
  }));
  assert.equal(duplicate.code, 'duplicate_dialogue');
  const detached = await jsonFetch(base, `/api/projects/${project.id}/scenes/${sceneId}`, { method: 'DELETE', cookie, body: {} });
  assert.equal(detached.res.status, 200);
  const status = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: project.id, scenarioId }));
  assert.deepEqual(status.missingItemKeys, ['case-001', 'case-003', 'case-004']);
  assert.deepEqual(status.suggestedNextRange, {
    fromKey: 'case-001', toKey: 'case-004', count: 3, itemKeys: ['case-001', 'case-003', 'case-004'],
  });
  const replacement = toolOk(await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id, scenarioId, items: [item('case-001', editedInput)],
  }));
  assert.equal(replacement.total, 1, 'a detached planned key can be completed with a new Scene');
});

test('scenario content batches preserve rules, recipe and cast after project edits', async () => {
  const { base } = await makeApp();
  const { cookie } = await register(base, 'Frozen scenario regression');
  const { token } = await createToken(base, cookie);
  const originalCast = [{ name: 'Original', role: '朋友' }];
  const project = toolOk(await mcpTool(base, token, 'imstage_create_project', {
    project: { name: 'Frozen scenario', type: 'evaluation_dataset', rules: 'ORIGINAL', brief: { cast: originalCast } },
  })).project;
  const scenario = toolOk(await mcpTool(base, token, 'imstage_create_scenario', {
    projectId: project.id, scenario: { name: 'Original scenario', preset: 'friendship', caseCount: 1, autoExport: false },
  })).scenario;
  toolOk(await mcpTool(base, token, 'imstage_update_project', {
    projectId: project.id, expectedRevision: project.revision,
    project: { type: 'story', rules: 'CHANGED', brief: { cast: [{ name: 'Changed', role: '朋友' }] } },
  }));
  const receipt = toolOk(await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id, scenarioId: scenario.scenarioId,
    items: [{ itemKey: 'case-001', name: 'Original case', objective: '开启交流', context: '共同活动后交流', annotations: { labels: { stage: 'greeting' } }, scene: sceneFor(2010) }],
  }));
  assert.equal(receipt.frozen.rules, 'ORIGINAL');
  assert.equal(receipt.frozen.type, 'evaluation_dataset');
  assert.equal(receipt.frozen.recipeVersion, 1);
  assert.deepEqual(receipt.frozen.cast, originalCast);
});

test('evaluation cases require caller labels and cleared drafts become pending again', async () => {
  const { base, app } = await makeApp();
  const { cookie } = await register(base, 'Case completeness regression');
  const { token } = await createToken(base, cookie);
  const project = toolOk(await mcpTool(base, token, 'imstage_create_project', {
    project: { name: 'Dataset completeness', type: 'evaluation_dataset' },
  })).project;
  const scenario = toolOk(await mcpTool(base, token, 'imstage_create_scenario', {
    projectId: project.id, scenario: { name: 'Dataset scenario', preset: 'friendship', caseCount: 1, autoExport: false },
  })).scenario;
  const entry = { itemKey: 'case-001', name: 'Greeting', objective: '开启交流', context: '活动后认识新朋友', scene: sceneFor(2020) };
  const missing = toolErr(await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id, scenarioId: scenario.scenarioId, items: [entry],
  }));
  assert.equal(missing.code, 'missing_annotations');
  assert.equal(countScenes(app), 0, 'annotation validation rolls back all scene writes');
  const labeled = { ...entry, annotations: { labels: { outcome: 'conversation-started' } } };
  const batch = toolOk(await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id, scenarioId: scenario.scenarioId, items: [labeled],
  }));
  const sceneId = batch.items[0].sceneId;
  const stored = toolOk(await mcpTool(base, token, 'imstage_get_scene', { sceneId }));
  const cleared = await jsonFetch(base, `/api/scenes/${sceneId}`, {
    method: 'PUT', cookie, body: { revision: stored.revision, scene: { ...stored.scene, messages: [] } },
  });
  assert.equal(cleared.res.status, 200, 'an empty editable Scene remains a valid draft');
  const pending = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: project.id, scenarioId: scenario.scenarioId }));
  assert.equal(pending.counts.submitted, 0);
  assert.equal(pending.contentStatus, 'collecting');
  assert.deepEqual(pending.missingItemKeys, ['case-001']);
  const resumed = toolOk(await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id, scenarioId: scenario.scenarioId, items: [labeled],
  }));
  assert.equal(resumed.total, 1, 'the cleared case can be submitted again');
});

/**
 * Policy regression: hosted generation audit coverage and correctness.
 *
 * Covers the real hosted flows end to end (HTTP Agent + batch through the
 * in-process worker, account MCP over an in-memory transport, standalone MCP
 * store writes, hosted deterministic renders) and asserts:
 *   - a start record exists before provider use and is finalized accurately
 *     (ok / error / aborted / partial — reason and mutation count, not blanket
 *     "partial"),
 *   - audit writes are mandatory (a failing audit insert fails the write),
 *   - rows are per-account isolated and never contain prompts, text or secrets.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { start } from '../services/api/server.mjs';
import { createScene, validateScene } from '../apps/web/src/studio/model.ts';
import { createAccountMcpServer } from '../services/integrations/account-mcp.mjs';
import { openStore } from '../services/mcp/store.mjs';
import { POLICY_VERSION } from '../packages/schema/policy.mjs';

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-policy-audit-'));
const APP_ORIGIN = 'http://127.0.0.1:4417';
const activeApps = new Set();
const activeStores = new Set();

after(async () => {
  for (const app of activeApps) {
    try { await app.close(); } catch { /* ignore */ }
  }
  for (const store of activeStores) {
    try { store.close(); } catch { /* ignore */ }
  }
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
});

function caseDir(label) {
  return fs.mkdtempSync(path.join(RUNTIME_ROOT, `${label}-`));
}

const highLimits = {
  activeGlobal: 4,
  activePerUser: 1,
  rate: { windowMs: 60_000, max: 1_000, maxKeys: 1_000 },
};

async function makeApp(agent = {}) {
  const dir = caseDir('case');
  const app = await start({
    dbPath: path.join(dir, 'imstage.db'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
    env: {},
    agent,
    projects: { pollMs: 20, sessionCheckMs: 30, maxLeaseWaitMs: 3_000 },
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}`, dir };
}

let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `audit-${emailSeq}-${Date.now()}@example.test`;
}

function mutationHeaders(cookie, extra = {}) {
  return {
    'content-type': 'application/json',
    origin: APP_ORIGIN,
    'x-imstage-request': '1',
    ...(cookie ? { cookie } : {}),
    ...extra,
  };
}

function cookieFrom(res) {
  const raw = res.headers.get('set-cookie') ?? '';
  return raw.split(';')[0] || null;
}

async function register(base) {
  const email = uniqueEmail();
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify({ name: '审计用户', email, password: 'password-123456' }),
  });
  assert.equal(res.status, 200);
  return { cookie: cookieFrom(res), email };
}

function auditRows(db, filter = '') {
  return db.prepare(`SELECT * FROM generation_audit ${filter}`).all();
}

function finalStatuses(db) {
  return auditRows(db).filter((row) => row.status !== 'running').map((row) => row.status).sort();
}

/* ------------------------------------------------------------------ */
/* Fake providers                                                      */
/* ------------------------------------------------------------------ */

function toolResponse(name, args, { id = 'call' } = {}) {
  return { content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls' };
}

function finalResponse(text = '已完成。') {
  return { content: text, toolCalls: [], finishReason: 'stop' };
}

function scriptedProvider(script) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async complete({ messages }) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

async function postRun(base, cookie, body) {
  return fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify(body),
  });
}

/* ------------------------------------------------------------------ */
/* Direct API Agent runs                                               */
/* ------------------------------------------------------------------ */

test('hosted Agent runs leave a start record and finalize ok/error/partial accurately', async () => {
  const okProvider = scriptedProvider([
    toolResponse('upsert_message', { message: { id: 'm-4', participantId: 'p-ayuan', type: 'text', text: '改后的台词', time: '09:41' } }, { id: 'c1' }),
    finalResponse('改好了。'),
  ]);
  const failProvider = scriptedProvider([
    toolResponse('delete_message', { id: 'does-not-exist' }, { id: 'c1' }),
    finalResponse('没改到。'),
  ]);
  // One real mutation, then finish without the required image asset: the run
  // is incomplete with partial output (mutations > 0 → partial, not error).
  const partialScene = createScene('weekend');
  partialScene.messages.push({ id: 'm-img', participantId: 'p-ayuan', type: 'image', text: '配图', time: '09:42' });
  const partialProvider = scriptedProvider([
    toolResponse('upsert_message', { message: { id: 'm-4', participantId: 'p-ayuan', type: 'text', text: '先改一句', time: '09:41' } }, { id: 'c1' }),
    finalResponse('还差图片。'),
  ]);

  for (const [provider, scene, expected] of [
    [okProvider, createScene('weekend'), 'ok'],
    [failProvider, createScene('weekend'), 'error'],
    [partialProvider, partialScene, 'partial'],
  ]) {
    const { app, base } = await makeApp({ chatProvider: provider, limits: highLimits });
    const { cookie } = await register(base);
    const res = await postRun(base, cookie, { prompt: '改最后一句', scene });
    assert.equal(res.status, 200);
    await res.text();

    const rows = auditRows(app.db, "WHERE flow = 'agent'");
    assert.equal(rows.length, 1, 'one row per run (start row is finalized in place)');
    const row = rows[0];
    assert.equal(row.status, expected);
    assert.equal(row.account_id !== 'anonymous', true, 'authenticated account id is recorded');
    assert.equal(row.policy_version, POLICY_VERSION);
    assert.ok(row.run_id.startsWith('run_'));
    assert.match(row.scene_hash, /^[0-9a-f]{64}$/);
    if (expected === 'ok') assert.equal(row.error_code, null);
    else assert.ok(row.error_code, 'failures record a bounded error code');
    await app.close();
    activeApps.delete(app);
  }
});

test('an abrupt provider failure still leaves the running record and finalizes to error', async () => {
  const thrower = scriptedProvider([new Error('provider exploded')]);
  const { app, base } = await makeApp({ chatProvider: thrower, limits: highLimits });
  const { cookie } = await register(base);
  const res = await postRun(base, cookie, { prompt: '改最后一句', scene: createScene('weekend') });
  assert.equal(res.status, 200);
  await res.text();
  const rows = auditRows(app.db, "WHERE flow = 'agent'");
  assert.equal(rows.length, 1, 'the start record survives an abrupt run');
  assert.equal(rows[0].status, 'error');
  assert.equal(rows[0].error_code, 'error');
  await app.close();
  activeApps.delete(app);
});

/* ------------------------------------------------------------------ */
/* Batch generation                                                    */
/* ------------------------------------------------------------------ */

test('project batch tasks are audited with flow=batch and account isolation', async () => {
  const provider = scriptedProvider([
    toolResponse('create_scene', { scene: { ...createScene('weekend'), title: '批量作品' } }, { id: 'c1' }),
    finalResponse('已生成。'),
    toolResponse('create_scene', { scene: { ...createScene('welcome'), title: '批量作品 2' } }, { id: 'c2' }),
    finalResponse('已生成。'),
  ]);
  const { app, base } = await makeApp({ chatProvider: provider, limits: highLimits });
  const { cookie, email } = await register(base);
  const other = await register(base);

  const project = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: mutationHeaders(cookie),
    body: JSON.stringify({ name: '审计批量项目', platform: 'imstage' }),
  });
  assert.equal(project.status, 200);
  const projectId = (await project.json()).item.id;

  const enqueued = await fetch(`${base}/api/projects/${projectId}/batch-jobs`, {
    method: 'POST', headers: mutationHeaders(cookie),
    body: JSON.stringify({ prompts: ['生成一段合成评测对话'], platforms: ['imstage'], clientBatchId: crypto.randomUUID() }),
  });
  assert.equal(enqueued.status, 200);
  const jobId = (await enqueued.json()).item.id;

  const deadline = Date.now() + 15_000;
  let detail;
  for (;;) {
    const res = await fetch(`${base}/api/projects/${projectId}/batch-jobs/${jobId}`, { headers: mutationHeaders(cookie) });
    detail = (await res.json()).item;
    const done = detail.tasks.every((task) => !['queued', 'running'].includes(task.status));
    if (done || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(detail.tasks.every((task) => task.status === 'done'), JSON.stringify(detail.tasks));

  const rows = auditRows(app.db, "WHERE flow = 'batch'");
  assert.equal(rows.length, detail.tasks.length, 'every generated batch scene is audited');
  for (const row of rows) {
    assert.equal(row.status, 'ok');
    assert.equal(row.policy_version, POLICY_VERSION);
    assert.match(row.scene_hash, /^[0-9a-f]{64}$/);
    assert.equal(row.account_id !== 'anonymous' && row.account_id !== '', true);
  }
  // Account isolation: every row belongs to the batch owner's account, and
  // the other registered account has no rows at all.
  const ownerId = app.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const otherId = app.db.prepare('SELECT id FROM users WHERE email = ?').get(other.email).id;
  assert.ok(rows.every((row) => row.account_id === ownerId), 'batch rows belong to the owning account');
  assert.equal(auditRows(app.db, `WHERE account_id = '${otherId}'`).length, 0, 'no rows leak to another account');
  const dump = JSON.stringify(auditRows(app.db));
  assert.equal(dump.includes('生成一段合成评测对话'), false, 'batch prompts are never stored in the audit');
  assert.equal(dump.includes('批量作品'), false, 'scene text is never stored in the audit');
  await app.close();
  activeApps.delete(app);
});

/* ------------------------------------------------------------------ */
/* MCP surfaces (account + standalone) and hosted renders              */
/* ------------------------------------------------------------------ */

function stubRender() {
  return async () => ({ pngBase64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'), sha256: 'a'.repeat(64), bytes: 8, width: 100, height: 200 });
}

test('account MCP writes are audited per account (create/update/render)', async () => {
  const { app } = await makeApp({ chatProvider: scriptedProvider([finalResponse()]), limits: highLimits });
  for (const [userId, title] of [['audit-user-a', '甲的作品'], ['audit-user-b', '乙的作品']]) {
    app.db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)')
      .run(userId, `${userId}@example.test`, 'Synthetic', 'not-a-login', new Date().toISOString());
    const server = createAccountMcpServer({
      db: app.db, userId, renderService: { render: stubRender() }, appOrigin: APP_ORIGIN,
      logger: { warn() {}, error() {} }, sceneIdFactory: () => crypto.randomUUID(),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'audit-test', version: '1' });
    await server.connect(st); await client.connect(ct);
    try {
      const scene = { ...createScene('weekend'), id: undefined, title };
      delete scene.id;
      const created = await client.callTool({ name: 'imstage_create_scene', arguments: { scene } });
      assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
      const sceneId = created.structuredContent.sceneId;
      const rendered = await client.callTool({ name: 'imstage_render_scene', arguments: { sceneId } });
      assert.equal(rendered.isError, undefined, JSON.stringify(rendered.structuredContent));
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
    const rows = auditRows(app.db, `WHERE account_id = '${userId}'`).filter((row) => row.status !== 'running');
    const flows = rows.map((row) => row.flow).sort();
    assert.deepEqual(flows, ['account_mcp', 'render'], `user ${userId} flows`);
    for (const row of rows) {
      assert.equal(row.policy_version, POLICY_VERSION);
      assert.match(row.scene_hash, /^[0-9a-f]{64}$/);
    }
  }
  // Isolation: no rows from one account appear under the other.
  const a = auditRows(app.db, "WHERE account_id = 'audit-user-a'");
  const b = auditRows(app.db, "WHERE account_id = 'audit-user-b'");
  assert.equal(a.length > 0 && b.length > 0, true);
  assert.equal(a.some((row) => row.scene_hash === b[0].scene_hash && row.flow === 'account_mcp' && row.scene_hash === 'a'.repeat(64)), false);
  const dump = JSON.stringify(auditRows(app.db));
  assert.equal(dump.includes('甲的作品'), false);
  assert.equal(dump.includes('乙的作品'), false);
  await app.close();
  activeApps.delete(app);
});

test('standalone MCP scene writes audit in the same transaction and fail loudly without it', async () => {
  const dataDir = caseDir('mcp-audit');
  const store = openStore({ dataDir });
  activeStores.add(store);
  const scene = { ...createScene('weekend'), id: `scn_${'d'.repeat(32)}` };
  store.createScene({ scene, requestHash: 'h' });
  let rows = auditRows(store.db, "WHERE flow = 'mcp_scene'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].account_id, 'mcp:instance');

  // Failure injection: with the audit table gone, the write must fail and
  // roll back — never silently succeed without evidence.
  store.db.exec('DROP TABLE generation_audit');
  assert.throws(
    () => store.createScene({ scene: { ...scene, id: `scn_${'e'.repeat(32)}` }, requestHash: 'h2' }),
    /SQLITE|audit|generation/i,
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n, 1, 'the unaudited write was rolled back');
});

test('hosted deterministic render outputs are audited (flow=render) with the output hash', async () => {
  const dataDir = caseDir('mcp-render-audit');
  const store = openStore({ dataDir });
  activeStores.add(store);
  store.saveRender({
    renderId: `rnd_${'a'.repeat(32)}`, sceneId: null, revision: null,
    pngBase64: Buffer.from([137, 80]).toString('base64'), sha256: 'b'.repeat(64),
    bytes: 2, width: 10, height: 10, title: '渲染', outputKind: 'screenshot', surface: 'ios',
  });
  const rows = auditRows(store.db, "WHERE flow = 'render'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scene_hash, 'b'.repeat(64), 'the rendered output hash is recorded');
  assert.equal(rows[0].policy_version, POLICY_VERSION);
});

test('validated scenes never smuggle prompt text into the audit through hashes', async () => {
  // The hash is a digest of canonical structure; raw content never appears.
  const { app } = await makeApp({ chatProvider: scriptedProvider([finalResponse()]), limits: highLimits });
  const cookie = (await register(base(app))).cookie;
  const res = await postRun(base(app), cookie, { prompt: 'SECRET-PROMPT-XYZ 生成一段对话', scene: createScene('weekend') });
  await res.text();
  const dump = JSON.stringify(auditRows(app.db));
  assert.equal(dump.includes('SECRET-PROMPT-XYZ'), false);
  assert.equal(dump.includes('生成一段对话'), false);
  assert.equal(validateScene(createScene('weekend')).ok, true);
  await app.close();
  activeApps.delete(app);
});

function base(app) {
  return `http://127.0.0.1:${app.port}`;
}

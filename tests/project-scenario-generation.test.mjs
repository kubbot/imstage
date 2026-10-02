/**
 * Scenario AI generation (batch C): Project → Scenario → 50/100 Cases.
 *
 * Controlled agent fixture only: a scripted provider returns real
 * `create_scene` tool mutations (distinct dialogues per frozen case key) and a
 * final stop — no paid provider, no credentials, no network. Coverage:
 *   - 50 distinct cases through persisted 20/20/10 chunks with exact
 *     generation/scenario/item/reservation/task/attempt bindings, progressing
 *     with the client closed (durable worker, not browser polling);
 *   - 100 cases through the durable driver (≤3 queued chunk jobs, serial
 *     20-sized chunks released as prior chunks settle);
 *   - idempotent replay/double-click never repeats model calls (before, during
 *     and after success); a different immutable request with the same key 409s;
 *   - reservation fencing: MCP/Web cannot write a reserved case key, a stale
 *     task cannot seize or release a re-bound reservation;
 *   - capacity: reservations count in every new-Scene path, pre-flight before
 *     the paid run, re-checked after the async lease with no provider call;
 *   - session revocation, cancellation and restart recovery are truthful and
 *     release reservations; explicit retry re-runs only missing/failed keys;
 *   - auto-export runs through the shared export service after commit.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { start } from '../services/api/server.mjs';
import { createScene } from '../apps/web/src/studio/model.ts';
import { createProjectAutomation } from '../services/projects/automation.mjs';
import { buildCaseTaskPrompt, createScenarioGenerationService, installScenarioGenerationSchema } from '../services/projects/scenario-generation.mjs';
import { buildCasePlan } from '../packages/schema/project-recipes.mjs';
import { createBatchQueue } from '../services/projects/batch.mjs';
import * as legacyStore from '../services/projects/store.mjs';
import * as autoStore from '../services/projects/automation-store.mjs';
import * as cap from '../services/projects/capacity.mjs';
import { installGenerationAuditSchema } from '../services/audit/generation-audit.mjs';

/* ------------------------------------------------------------------ */
/* Scoped runtime directory                                            */
/* ------------------------------------------------------------------ */

test('all 50 case prompts resolve bilingual variations and preset guidance in the frozen scenario language', () => {
  for (const locale of ['zh-CN', 'en']) {
    const scenario = { name: 'New friends', platform: 'whatsapp', locale, preset: 'friendship', caseCount: 50 };
    const plan = buildCasePlan(scenario);
    const variations = new Set();
    for (const entry of plan.cases) {
      const prompt = buildCaseTaskPrompt({ scenario, entry, presetGuidance: plan.guidance });
      const language = locale === 'en' ? 'en' : 'zh';
      const line = prompt.split('\n').find((text) => text.startsWith('【本例变化】'));
      assert.equal(line, `【本例变化】${entry.guide.variation.map((item) => `${item.label[language]}：${item.value[language]}`).join('；')}`);
      for (const guidance of plan.guidance) assert.ok(prompt.includes(guidance[language]));
      assert.ok(!prompt.includes('[object Object]'));
      variations.add(line);
    }
    assert.equal(variations.size, 50);
  }
});

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-scenario-gen-'));
const APP_ORIGIN = 'http://127.0.0.1:4419';
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

const highLimits = {
  activeGlobal: 8,
  activePerUser: 4,
  rate: { windowMs: 60_000, max: 5_000, maxKeys: 1_000 },
};

/* ------------------------------------------------------------------ */
/* Controlled agent fixture                                            */
/* ------------------------------------------------------------------ */

function finalResponse(text = '已完成。') {
  return { content: text, toolCalls: [], finishReason: 'stop' };
}

function toolResponse(name, args, { content = '', id = 'call' } = {}) {
  return { content, toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls' };
}

/**
 * A run is over ONLY when the controlled provider's own create_scene tool
 * result comes back. The Agent may include unrelated initial/context tool
 * messages in `messages`, so a bare `role === 'tool'` stop would end the run
 * before any mutation exists.
 */
const OWN_TOOL_PREFIX = 'sg-scene-';
function hasOwnToolResult(messages) {
  return messages.some(
    (message) => message?.role === 'tool' && String(message?.tool_call_id ?? '').startsWith(OWN_TOOL_PREFIX),
  );
}

function caseKeyOf(messages) {
  const text = messages
    .map((message) => (typeof message?.content === 'string' ? message.content : ''))
    .join('\n');
  return /【案例编号】(case-\d+)/.exec(text)?.[1] ?? null;
}

/**
 * Provider returning one distinct valid Scene per case key: the frozen plan's
 * key lands in the dialogue text so every published case has unique content.
 * `failKeys` error out, `emptyKeys` return no mutation (once — an explicit
 * retry then succeeds), `blockKeys` hold the run open until release()/abort.
 */
function controlledCaseProvider({ failKeys = new Set(), emptyKeys = new Set(), blockKeys = new Set() } = {}) {
  const calls = [];
  const blocked = [];
  const emptied = new Set();
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  return {
    calls,
    release: () => releaseGate(),
    async complete({ messages, signal }) {
      const key = caseKeyOf(messages) ?? `case-${String(calls.length).padStart(3, '0')}`;
      calls.push(key);
      if (hasOwnToolResult(messages)) return finalResponse();
      if (blockKeys.has(key)) {
        blocked.push(key);
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
          gate.then(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
        });
      }
      if (signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      if (emptyKeys.has(key) && !emptied.has(key)) {
        emptied.add(key);
        return finalResponse('没有修改');
      }
      if (failKeys.has(key)) throw new Error(`injected provider failure for ${key}`);
      const scene = createScene('weekend');
      scene.title = `案例 ${key}`;
      // Honor the frozen cast names in the prompt like a real model would
      // (roles guide the dialogue; avatar bytes never appear in the prompt).
      const promptText = messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n');
      const castLine = /【人物】([^\n]+)/.exec(promptText)?.[1] ?? '';
      const castNames = castLine
        .split('；')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .map((entry) => entry.replace(/（[^）]*）/g, ''));
      const others = scene.participants.filter((participant) => participant.id !== scene.selfId);
      const renamed = new Map();
      castNames.forEach((name, index) => {
        if (others[index]) renamed.set(others[index].id, name);
      });
      scene.participants = scene.participants.map((participant) =>
        (participant.id !== scene.selfId && renamed.has(participant.id)
          ? { ...participant, name: renamed.get(participant.id), avatar: undefined }
          : participant),
      );
      for (let index = others.length; index < castNames.length; index += 1) {
        const template = others[0] ?? scene.participants[0];
        scene.participants.push({ ...template, id: `p-cast-${index + 1}`, name: castNames[index], avatar: undefined });
      }
      scene.messages = scene.messages.map((message, index) => ({
        ...message,
        text: `独特对话 ${key} #${index}`,
      }));
      return toolResponse('create_scene', { scene }, { id: `${OWN_TOOL_PREFIX}${calls.length}` });
    },
  };
}

/** Blocks every completion until release()/abort (held-key fixtures). */
function holdProvider(keys) {
  return controlledCaseProvider({ blockKeys: new Set(keys) });
}

/* ------------------------------------------------------------------ */
/* App + HTTP helpers                                                  */
/* ------------------------------------------------------------------ */

async function makeApp({ agent = {}, projects = {}, renderService, dbPath, exportDir, now } = {}) {
  const dir = dbPath ? path.dirname(dbPath) : fs.mkdtempSync(path.join(RUNTIME_ROOT, 'case-'));
  const app = await start({
    dbPath: dbPath ?? path.join(dir, 'imstage.db'),
    exportDir: exportDir ?? path.join(dir, 'project-exports'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {}, warn() {} },
    env: {},
    agent,
    ...(now ? { now } : {}),
    ...(renderService ? { renderService } : {}),
    projects: { pollMs: 15, sessionCheckMs: 25, maxLeaseWaitMs: 3_000, ...projects },
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}`, dir };
}

let emailSeq = 0;
function mutationHeaders(cookie, extras = {}) {
  const headers = { 'content-type': 'application/json', origin: APP_ORIGIN, 'x-imstage-request': '1', ...extras };
  if (cookie) headers.cookie = cookie;
  return headers;
}

function cookieFrom(res, name = 'imstage_session') {
  const match = new RegExp(`${name}=([^;]*)`).exec(res.headers.get('set-cookie') ?? '');
  return match && match[1] !== '' ? `${name}=${match[1]}` : null;
}

async function register(base, label = '生成用户') {
  emailSeq += 1;
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify({ name: label, email: `scenariogen-${process.pid}-${emailSeq}@example.com`, password: 'password-123456' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { cookie: cookieFrom(res), user: body.user, sessionId: null };
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

async function createToken(base, cookie, { name = '场景生成 MCP', scopes } = {}) {
  const res = await fetch(`${base}/api/connections/tokens`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ name, ...(scopes ? { scopes } : {}) }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.token;
}

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

async function waitFor(predicate, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function createProject(base, cookie, body = {}) {
  const { res, data } = await jsonFetch(base, '/api/projects', { method: 'POST', cookie, body: { name: '生成项目', ...body } });
  assert.equal(res.status, 200, JSON.stringify(data));
  return data.item;
}

async function createScenario(base, cookie, projectId, body = {}) {
  const { res, data } = await jsonFetch(base, `/api/projects/${projectId}/scenarios`, {
    method: 'POST',
    cookie,
    body: { scenario: { name: 'WhatsApp 认识新朋友', brief: '结交新朋友的自然对话', preset: 'friendship', ...body } },
  });
  assert.equal(res.status, 200, JSON.stringify(data));
  return data;
}

async function startGeneration(base, cookie, projectId, scenarioId, body = {}) {
  return jsonFetch(base, `/api/projects/${projectId}/scenarios/${scenarioId}/generation`, {
    method: 'POST',
    cookie,
    body,
  });
}

async function generationStatus(base, cookie, projectId, scenarioId) {
  const { res, data } = await jsonFetch(base, `/api/projects/${projectId}/scenarios/${scenarioId}/generation`, { cookie });
  assert.equal(res.status, 200, JSON.stringify(data));
  return data;
}

/** Distinct synthetic scene for capacity fixtures (server generates ids). */
function uniqueScene(index) {
  const scene = createScene('weekend');
  scene.title = `作品 ${index}`;
  scene.messages = scene.messages.map((message, position) => ({ ...message, text: `容量作品 ${index}-${position}` }));
  delete scene.id;
  return scene;
}

async function httpCreateScene(base, cookie, scene) {
  const id = crypto.randomUUID();
  return jsonFetch(base, `/api/scenes/${id}`, {
    method: 'PUT',
    cookie,
    body: { scene: { ...scene, id }, revision: 0 },
  });
}

/* ------------------------------------------------------------------ */
/* 50 / 100 case generation through persisted chunks                   */
/* ------------------------------------------------------------------ */

test('50 distinct cases generate through 20/20/10 persisted chunks with the client closed', async () => {
  const provider = controlledCaseProvider();
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 50 });
  const scenarioId = plan.scenario.scenarioId;

  const { res, data } = await startGeneration(base, cookie, project.id, scenarioId, { idempotencyKey: 'gen-50' });
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.generation.caseTotal, 50);
  assert.deepEqual(
    data.plannedItemKeys,
    plan.casePlan.cases.map((entry) => entry.itemKey),
  );

  // Client closed: only direct DB observation from here — no HTTP polling.
  const db = app.db;
  await waitFor(() => {
    const row = db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'consumed'").get();
    return Number(row.n) === 50;
  });

  const jobs = db.prepare('SELECT * FROM batch_jobs ORDER BY rowid ASC').all();
  assert.equal(jobs.length, 3, '50 cases persist exactly 3 chunks');
  assert.deepEqual(jobs.map((job) => Number(job.total)), [20, 20, 10]);
  assert.ok(jobs.every((job) => job.generation_id === data.generation.generationId));

  const tasks = db.prepare('SELECT * FROM batch_tasks ORDER BY rowid ASC').all();
  assert.equal(tasks.length, 50);
  assert.equal(new Set(tasks.map((task) => task.item_key)).size, 50, 'every task binds a distinct case key');
  for (const task of tasks) {
    assert.equal(task.generation_id, data.generation.generationId);
    assert.ok(task.reservation_id, 'task persists its reservation binding');
    assert.ok(task.scenario_id === scenarioId);
    assert.ok(task.status === 'done' && task.scene_id, `task ${task.item_key} published`);
    // Objective/context from the frozen plan are in the model prompt.
    assert.match(task.prompt, /【目标】/);
    assert.match(task.prompt, /【背景】/);
    assert.match(task.prompt, /【案例编号】case-\d+/);
  }

  // Distinct delivered dialogues and frozen plan metadata on every case.
  const status = await generationStatus(base, cookie, project.id, scenarioId);
  const cases = status.cases;
  assert.equal(cases.length, 50);
  assert.equal(status.missingItemKeys.length, 0);
  const signatures = new Set();
  for (const entry of cases) {
    assert.equal(entry.submitted, true, `${entry.itemKey} submitted`);
    assert.ok(entry.objective && entry.context, 'frozen plan metadata stored');
    const row = db.prepare('SELECT scene_json FROM scenes WHERE id = ?').get(entry.sceneId);
    assert.ok(row, 'scene row exists');
    signatures.add(autoStore.dialogueSignature(JSON.parse(row.scene_json)));
  }
  assert.equal(signatures.size, 50, '50 distinct dialogues');

  const generation = status.generation;
  assert.equal(generation.status, 'done');
  assert.equal(generation.done, 50);
  assert.equal(generation.failed, 0);
  const active = db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get();
  assert.equal(Number(active.n), 0, 'no stranded reservations');
});

test('100 cases run through the durable driver with at most 3 queued chunks', async () => {
  const provider = controlledCaseProvider();
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 100 });
  const scenarioId = plan.scenario.scenarioId;

  const { res, data } = await startGeneration(base, cookie, project.id, scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.chunks.total, 5, '100 cases = 5 durable chunks');

  const db = app.db;
  let maxActiveChunks = 0;
  await waitFor(() => {
    const active = Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM batch_jobs WHERE generation_id IS NOT NULL AND status IN ('queued', 'running')")
        .get().n,
    );
    maxActiveChunks = Math.max(maxActiveChunks, active);
    const consumed = Number(db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'consumed'").get().n);
    return consumed === 100;
  });

  assert.ok(maxActiveChunks <= 3, `driver keeps ≤3 queued chunk jobs (saw ${maxActiveChunks})`);
  const jobs = db.prepare('SELECT * FROM batch_jobs WHERE generation_id IS NOT NULL ORDER BY rowid ASC').all();
  assert.equal(jobs.length, 5);
  assert.ok(jobs.every((job) => Number(job.total) === 20), 'serial 20-sized chunks');
  const keys = db.prepare('SELECT item_key FROM batch_tasks WHERE generation_id IS NOT NULL').all().map((row) => row.item_key);
  assert.equal(new Set(keys).size, 100);
  assert.equal(keys.length, 100);
});

/* ------------------------------------------------------------------ */
/* Idempotent replay / double click                                    */
/* ------------------------------------------------------------------ */

test('double click and idempotent replay never repeat model calls', async () => {
  const provider = controlledCaseProvider();
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 2 });
  const scenarioId = plan.scenario.scenarioId;

  // Concurrent double click with the same idempotency key: one parent only.
  const [first, second] = await Promise.all([
    startGeneration(base, cookie, project.id, scenarioId, { idempotencyKey: 'double-click' }),
    startGeneration(base, cookie, project.id, scenarioId, { idempotencyKey: 'double-click' }),
  ]);
  assert.equal(first.res.status, 200);
  assert.equal(second.res.status, 200);
  assert.equal(first.data.generation.generationId, second.data.generation.generationId);
  const parents = app.db.prepare('SELECT id FROM scenario_generations').all();
  assert.equal(parents.length, 1, 'one parent generation for a double click');

  await waitFor(() => Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'consumed'").get().n) === 2);
  const callsAfterFirstRun = provider.calls.length;
  assert.equal(callsAfterFirstRun, 4, 'two cases × (tool + final) — no duplicate runs');

  // Replay after full success returns the ORIGINAL generation, no new calls.
  const replay = await startGeneration(base, cookie, project.id, scenarioId, { idempotencyKey: 'double-click' });
  assert.equal(replay.res.status, 200, JSON.stringify(replay.data));
  assert.equal(replay.data.generation.generationId, first.data.generation.generationId);
  assert.equal(replay.data.deduplicated, true);
  assert.equal(provider.calls.length, callsAfterFirstRun, 'replay never calls the model again');

  // A different immutable request under the same key conflicts.
  const other = await createScenario(base, cookie, project.id, { name: '另一个场景', caseCount: 1 });
  const conflict = await startGeneration(base, cookie, project.id, other.scenario.scenarioId, { idempotencyKey: 'double-click' });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.data.error.code, 'idempotency_conflict');
});

/* ------------------------------------------------------------------ */
/* Reservation fencing and MCP write conflicts                         */
/* ------------------------------------------------------------------ */

test('reserved case keys reject MCP writes until released; stale attempts cannot seize a re-bound reservation', async () => {
  const provider = controlledCaseProvider({ blockKeys: new Set(['case-001']) });
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const token = await createToken(base, cookie);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 1, autoExport: false });
  const scenarioId = plan.scenario.scenarioId;
  const planned = plan.casePlan.cases[0];

  const { res, data } = await startGeneration(base, cookie, project.id, scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));

  // Public MCP submission for a reserved key is rejected while it is reserved.
  const blocked = await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id,
    scenarioId,
    items: [{
      itemKey: planned.itemKey,
      name: planned.name,
      objective: planned.objective,
      context: planned.context,
      scene: uniqueScene(1),
    }],
  });
  const blockedError = toolErr(blocked, 'reserved key write');
  assert.equal(blockedError.code, 'case_reserved');

  // Cancel: reservation released, no fake completion, MCP may now resume it.
  const cancel = await jsonFetch(base, `/api/projects/${project.id}/scenarios/${scenarioId}/generation/cancel`, {
    method: 'POST',
    cookie,
    body: { generationId: data.generation.generationId },
  });
  assert.equal(cancel.res.status, 200, JSON.stringify(cancel.data));
  provider.release();
  await waitFor(() => {
    const row = app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get();
    return Number(row.n) === 0;
  });
  const afterCancel = await generationStatus(base, cookie, project.id, scenarioId);
  assert.equal(afterCancel.cases.every((entry) => entry.submitted === false), true, 'cancellation never fakes completion');

  const resumed = await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id,
    scenarioId,
    clientIdempotencyKey: 'mcp-resume-1',
    items: [{
      itemKey: planned.itemKey,
      name: planned.name,
      objective: planned.objective,
      context: planned.context,
      scene: uniqueScene(2),
    }],
  });
  const receipt = toolOk(resumed, 'MCP resumes a released key');
  assert.equal(receipt.items[0].itemKey, planned.itemKey);
});

test('in-process fencing: a stale task cannot publish or release a re-bound reservation', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at_ms INTEGER);
    CREATE TABLE scenes(user_id TEXT,id TEXT,title TEXT,platform TEXT,message_count INTEGER,revision INTEGER,scene_json TEXT,updated_at TEXT,PRIMARY KEY(user_id,id));
    CREATE TABLE mcp_idempotency(user_id TEXT,key TEXT,operation TEXT,request_hash TEXT,response_json TEXT,created_at TEXT,PRIMARY KEY(user_id,key));`);
  legacyStore.installProjectSchema(db);
  autoStore.installAutomationSchema(db);
  installScenarioGenerationSchema(db);
  installGenerationAuditSchema(db);
  const now = Date.parse('2026-10-03T00:00:00Z');
  db.prepare('INSERT INTO users VALUES(?)').run('u1');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('s1', 'u1', now + 86_400_000);
  const automation = createProjectAutomation({ db, nowMs: () => now });
  const gen = createScenarioGenerationService({
    db,
    nowMs: () => now,
    queue: { wake() {} },
    logger: { warn() {} },
    onScenarioContentReady: () => ({ queued: true }),
  });
  const projectId = automation.createProject({ userId: 'u1', input: { name: 'P' } }).item.id;
  const plan = automation.createScenario({ userId: 'u1', projectId, input: { name: 'S', caseCount: 1, autoExport: false } });
  const scenarioId = plan.scenario.scenarioId;
  const receipt = gen.enqueue({ userId: 'u1', projectId, scenarioId, sessionId: 's1' });
  const reservation = cap.listGenerationReservations(db, 'u1', receipt.generation.generationId)[0];
  const staleTask = db.prepare('SELECT * FROM batch_tasks WHERE id = ?').get(reservation.task_id);

  // Simulate an explicit retry: the key is released and re-bound to a NEW task.
  cap.releaseReservation(db, { userId: 'u1', reservationId: reservation.reservation_id, reason: 'interrupted', errorCode: 'interrupted', nowMs: now });
  const freshReservationId = crypto.randomUUID();
  cap.reserveCase(db, {
    userId: 'u1',
    reservationId: freshReservationId,
    generationId: reservation.generation_id,
    scenarioId,
    projectId,
    itemKey: reservation.item_key,
    ordinal: 0,
    nowMs: now,
  });
  const freshTaskId = crypto.randomUUID();
  cap.bindReservationTask(db, {
    userId: 'u1',
    reservationId: freshReservationId,
    chunkIndex: 0,
    jobId: 'job-2',
    taskId: freshTaskId,
    attempt: 2,
    nowMs: now,
  });

  // The stale attempt's result arrives late: rejected, and it must not touch
  // the reservation now bound to the newer task.
  const scene = uniqueScene(1);
  const stale = gen.settleTask({
    userId: 'u1',
    jobId: staleTask.job_id,
    taskId: staleTask.id,
    generationId: reservation.generation_id,
    scenarioId,
    projectId,
    itemKey: reservation.item_key,
    reservationId: reservation.reservation_id,
    attempt: Number(staleTask.attempt ?? 1),
    scene,
    sessionId: 's1',
  });
  assert.equal(stale.ok, false);
  const reBound = cap.getReservation(db, 'u1', freshReservationId);
  assert.equal(reBound.status, 'active', 'stale attempt cannot release the re-bound reservation');
  assert.equal(reBound.task_id, freshTaskId);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n), 0, 'stale attempt cannot publish');

  // ReleaseTask by the stale task is equally fenced.
  gen.releaseTask({ userId: 'u1', reservationId: freshReservationId, taskId: staleTask.id, attempt: 1, code: 'x', message: 'x' });
  assert.equal(cap.getReservation(db, 'u1', freshReservationId).status, 'active');

  // The matching attempt publishes atomically.
  const ok = gen.settleTask({
    userId: 'u1',
    jobId: 'job-2',
    taskId: freshTaskId,
    generationId: reservation.generation_id,
    scenarioId,
    projectId,
    itemKey: reservation.item_key,
    reservationId: freshReservationId,
    attempt: 2,
    scene: { ...uniqueScene(2), id: crypto.randomUUID() },
    sessionId: 's1',
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(cap.getReservation(db, 'u1', freshReservationId).status, 'consumed');
  const caseRow = autoStore.caseItem(autoStore.getCaseRow(db, 'u1', scenarioId, reservation.item_key, projectId));
  assert.equal(caseRow.submitted, true);
  db.close();
});

/* ------------------------------------------------------------------ */
/* Capacity boundaries                                                 */
/* ------------------------------------------------------------------ */

test('active reservations count toward account capacity in every create path', async () => {
  const provider = controlledCaseProvider({ blockKeys: new Set(planAllKeys(50)) });
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const token = await createToken(base, cookie);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 50, autoExport: false });
  const scenarioId = plan.scenario.scenarioId;

  const { res, data } = await startGeneration(base, cookie, project.id, scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(Number(data.generation.pending), 50, '50 promised slots reserved');

  // Fill the remaining 50 real slots through the ordinary HTTP path.
  for (let index = 0; index < 50; index += 1) {
    const created = await httpCreateScene(base, cookie, uniqueScene(index));
    assert.equal(created.res.status, 200, JSON.stringify(created.data));
  }

  // Every new-Scene path now refuses: HTTP, account MCP and content batches.
  const overflow = await httpCreateScene(base, cookie, uniqueScene(999));
  assert.equal(overflow.res.status, 409);
  assert.equal(overflow.data.error.code, 'scene_limit_reached');

  const mcpScene = uniqueScene(1000);
  const mcpResult = await mcpTool(base, token, 'imstage_create_scene', { scene: mcpScene });
  const mcpError = toolErr(mcpResult, 'mcp create_scene respects reservations');
  assert.equal(mcpError.code, 'storage_limit');

  // A content batch in a scenario WITHOUT reservations still fails on the
  // shared capacity guard (not the case fence).
  const other = await createScenario(base, cookie, project.id, { name: '无预留场景', caseCount: 1, autoExport: false });
  const batch = await jsonFetch(base, `/api/projects/${project.id}/content-batches`, {
    method: 'POST',
    cookie,
    body: {
      scenarioId: other.scenario.scenarioId,
      items: [{
        itemKey: other.casePlan.cases[0].itemKey,
        name: other.casePlan.cases[0].name,
        objective: other.casePlan.cases[0].objective,
        context: other.casePlan.cases[0].context,
        scene: uniqueScene(1001),
      }],
    },
  });
  assert.equal(batch.res.status, 409);
  assert.equal(batch.data.error.code, 'scene_limit_reached');

  // Cancelling the generation releases its promised slots for real use.
  const cancel = await jsonFetch(base, `/api/projects/${project.id}/scenarios/${scenarioId}/generation/cancel`, {
    method: 'POST',
    cookie,
    body: { generationId: data.generation.generationId },
  });
  assert.equal(cancel.res.status, 200, JSON.stringify(cancel.data));
  provider.release();
  const after = await httpCreateScene(base, cookie, uniqueScene(2000));
  assert.equal(after.res.status, 200, JSON.stringify(after.data));
});

function planAllKeys(count) {
  return Array.from({ length: count }, (unused, index) => `case-${String(index + 1).padStart(3, '0')}`);
}

test('capacity pre-flight rejects an unpayable generation before any model call', async () => {
  const provider = controlledCaseProvider();
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie);
  for (let index = 0; index < 60; index += 1) {
    const created = await httpCreateScene(base, cookie, uniqueScene(index));
    assert.equal(created.res.status, 200);
  }
  const plan = await createScenario(base, cookie, project.id, { caseCount: 50, autoExport: false });
  const { res, data } = await startGeneration(base, cookie, project.id, plan.scenario.scenarioId);
  assert.equal(res.status, 409, JSON.stringify(data));
  assert.equal(data.error.code, 'scene_limit_reached');
  assert.equal(provider.calls.length, 0, 'no provider call for a rejected generation');
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get().n), 0);
});

test('post-lease capacity recheck fails honestly without a provider call', async () => {
  // In-process worker with a limiter that blocks the first lease attempts, so
  // unrelated scene inserts can fill the account while the task waits.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at_ms INTEGER);
    CREATE TABLE scenes(user_id TEXT,id TEXT,title TEXT,platform TEXT,message_count INTEGER,revision INTEGER,scene_json TEXT,updated_at TEXT,PRIMARY KEY(user_id,id));
    CREATE TABLE mcp_idempotency(user_id TEXT,key TEXT,operation TEXT,request_hash TEXT,response_json TEXT,created_at TEXT,PRIMARY KEY(user_id,key));`);
  legacyStore.installProjectSchema(db);
  autoStore.installAutomationSchema(db);
  installScenarioGenerationSchema(db);
  installGenerationAuditSchema(db);
  const now = Date.now();
  db.prepare('INSERT INTO users VALUES(?)').run('u1');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('s1', 'u1', now + 86_400_000);
  legacyStore.createProject(db, { userId: 'u1', projectId: 'p1', name: 'P', rules: '', platform: 'wechat', nowMs: now });
  const job = legacyStore.createBatchJob(db, {
    userId: 'u1',
    projectId: 'p1',
    sessionId: 's1',
    rules: '',
    tasks: [{ prompt: '生成对话', platform: 'wechat' }],
    clientBatchId: 'legacy-capacity',
    nowMs: now,
  });

  let attempts = 0;
  let providerCalls = 0;
  const queue = createBatchQueue({
    db,
    nowMs: () => Date.now(),
    pollMs: 10,
    sessionCheckMs: 200,
    maxLeaseWaitMs: 2_000,
    logger: { warn() {} },
    agent: {
      limiter: {
        tryStart() {
          attempts += 1;
          // First two attempts wait; during the wait the account fills up.
          if (attempts <= 2) return { ok: false, retryAfterMs: 30 };
          return { ok: true, release() {} };
        },
      },
      runtime: {
        async run() {
          providerCalls += 1;
          return { ok: true, scene: createScene('weekend') };
        },
      },
    },
  });
  queue.start();
  try {
    await waitFor(() => attempts >= 1);
    // Fill the account while the task waits for its lease.
    for (let index = 0; index < 100; index += 1) {
      const scene = { ...uniqueScene(index), id: crypto.randomUUID() };
      db.prepare(
        `INSERT INTO scenes (user_id, id, title, platform, message_count, revision, scene_json, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run('u1', scene.id, scene.title, scene.platform, scene.messages.length, JSON.stringify(scene), new Date().toISOString());
    }
    const task = await waitFor(() => {
      const row = legacyStore.listJobTasks(db, job.id)[0];
      return row.status !== 'queued' && row.status !== 'running' ? row : null;
    });
    assert.equal(task.status, 'failed');
    assert.equal(task.errorCode, 'scene_limit_reached');
    assert.equal(providerCalls, 0, 'no provider call once capacity is gone');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM scenes WHERE user_id = ?').get('u1').n), 100);
  } finally {
    await queue.stop();
    db.close();
  }
});

/* ------------------------------------------------------------------ */
/* Cancellation, session revocation and restart recovery               */
/* ------------------------------------------------------------------ */

test('session revocation mid-run cancels without publishing and releases reservations', async () => {
  const provider = controlledCaseProvider({ blockKeys: new Set(['case-001']) });
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie, user } = await register(base);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 1, autoExport: false });
  const { res, data } = await startGeneration(base, cookie, project.id, plan.scenario.scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));

  await waitFor(() => provider.calls.length > 0);
  // Revoke the session while the paid run is in flight.
  app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  provider.release();
  await waitFor(() => {
    const row = app.db.prepare('SELECT status FROM scenario_generations WHERE id = ?').get(data.generation.generationId);
    return row && row.status !== 'queued' && row.status !== 'running';
  });
  assert.equal(Number(app.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n), 0, 'nothing published after revocation');
  const reservations = app.db.prepare('SELECT status FROM scene_reservations').all();
  assert.ok(reservations.every((row) => row.status !== 'active'), 'reservations released');
});

test('restart marks generation interrupted; explicit retry re-runs only missing keys', async () => {
  const dir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'restart-'));
  const dbPath = path.join(dir, 'imstage.db');
  const exportDir = path.join(dir, 'project-exports');

  // Run 1: case-001 succeeds, case-002 blocks until the app is torn down.
  const provider1 = controlledCaseProvider({ blockKeys: new Set(['case-002']) });
  const first = await makeApp({ agent: { chatProvider: provider1, limits: highLimits }, dbPath, exportDir });
  const { cookie } = await register(first.base);
  const project = await createProject(first.base, cookie);
  const plan = await createScenario(first.base, cookie, project.id, { caseCount: 2, autoExport: false });
  const scenarioId = plan.scenario.scenarioId;
  const { res, data } = await startGeneration(first.base, cookie, project.id, scenarioId, { idempotencyKey: 'restart-run' });
  assert.equal(res.status, 200, JSON.stringify(data));
  await waitFor(() => Number(first.app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'consumed'").get().n) >= 1);
  // Crash/stop mid-generation: the blocked run never commits.
  await first.app.close();
  activeApps.delete(first.app);

  // Run 2: startup recovery is truthful and never silently resumes.
  const provider2 = controlledCaseProvider();
  const second = await makeApp({ agent: { chatProvider: provider2, limits: highLimits }, dbPath, exportDir });
  const recovered = second.app.db.prepare('SELECT status, reason FROM scenario_generations').get();
  assert.equal(recovered.status, 'interrupted', 'parent is interrupted after restart');
  const leftovers = second.app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get();
  assert.equal(Number(leftovers.n), 0, 'attempt reservations released at startup');
  assert.equal(provider2.calls.length, 0, 'restart never re-runs anything by itself');
  const statusAfterRestart = await generationStatus(second.base, cookie, project.id, scenarioId);
  assert.equal(statusAfterRestart.cases.filter((entry) => entry.submitted).length, 1, 'the committed case stays done');

  // Explicit retry: only the missing key is re-run.
  const retry = await jsonFetch(second.base, `/api/projects/${project.id}/scenarios/${scenarioId}/generation/retry`, {
    method: 'POST',
    cookie,
    body: { generationId: data.generation.generationId, idempotencyKey: 'restart-retry' },
  });
  assert.equal(retry.res.status, 200, JSON.stringify(retry.data));
  assert.deepEqual(retry.data.plannedItemKeys, ['case-002'], 'retry targets only missing keys');
  await waitFor(() => {
    const row = second.app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'consumed'").get();
    return Number(row.n) === 2;
  });
  await waitFor(() => Number(second.app.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n) === 2);
  assert.deepEqual([...new Set(provider2.calls)], ['case-002'], 'the successful case is never re-run');
});

test('failed items are retried only; no-mutation results fail honestly', async () => {
  const provider = controlledCaseProvider({ emptyKeys: new Set(['case-002']) });
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 3, autoExport: false });
  const scenarioId = plan.scenario.scenarioId;

  const { res, data } = await startGeneration(base, cookie, project.id, scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));
  await waitFor(() => {
    const row = app.db.prepare('SELECT status FROM scenario_generations WHERE id = ?').get(data.generation.generationId);
    return row && ['done', 'partial', 'failed'].includes(row.status);
  });

  const status = await generationStatus(base, cookie, project.id, scenarioId);
  assert.equal(status.generation.status, 'partial');
  const failed = status.cases.filter((entry) => !entry.submitted);
  assert.deepEqual(failed.map((entry) => entry.itemKey), ['case-002'], 'only the no-mutation item is missing');
  assert.equal(status.generation.failed, 1);

  const before = provider.calls.filter((key) => key === 'case-001').length;
  const retry = await jsonFetch(base, `/api/projects/${project.id}/scenarios/${scenarioId}/generation/retry`, {
    method: 'POST',
    cookie,
    body: { generationId: data.generation.generationId, idempotencyKey: 'retry-failed' },
  });
  assert.equal(retry.res.status, 200, JSON.stringify(retry.data));
  assert.deepEqual(retry.data.plannedItemKeys, ['case-002']);
  await waitFor(() => {
    const row = app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'consumed'").get();
    return Number(row.n) === 3;
  });
  assert.equal(provider.calls.filter((key) => key === 'case-001').length, before, 'completed cases are never re-run');
});

/* ------------------------------------------------------------------ */
/* Auto-export and configuration boundaries                            */
/* ------------------------------------------------------------------ */

test('auto-export queues the shared scenario export after the last committed case', async () => {
  const stub = {
    async render() {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      );
      return { buffer: png, width: 1, height: 1, bytes: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex'), pngBase64: png.toString('base64') };
    },
  };
  const provider = controlledCaseProvider();
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits }, renderService: stub });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie, { type: 'training' });
  const plan = await createScenario(base, cookie, project.id, { caseCount: 2, autoExport: true });
  const scenarioId = plan.scenario.scenarioId;

  const { res, data } = await startGeneration(base, cookie, project.id, scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));
  // Auto-export is queued only after the last case commits (shared service).
  await waitFor(async () => {
    const { res: exportRes, data: exportData } = await jsonFetch(base, `/api/projects/${project.id}/exports`, { cookie });
    return exportRes.status === 200 && exportData.items.length > 0 ? exportData : null;
  });
  // Download only on a real validated bundle (completed or explicit partial).
  const done = await waitFor(async () => {
    const { res: exportRes, data: exportData } = await jsonFetch(base, `/api/projects/${project.id}/exports`, { cookie });
    if (exportRes.status !== 200) return null;
    const item = exportData.items.find((entry) => ['completed', 'partial'].includes(entry.status));
    return item ?? null;
  });
  const download = await fetch(`${base}/api/projects/${project.id}/exports/${done.exportId}/download`, {
    headers: mutationHeaders(cookie),
  });
  assert.equal(download.status, 200);
  const bytes = await download.arrayBuffer();
  assert.ok(bytes.byteLength > 0, 'real ZIP bytes');
});

test('unconfigured AI fails clearly while caller content submission stays usable', async () => {
  const { base } = await makeApp({ agent: {} });
  const { cookie } = await register(base);
  const token = await createToken(base, cookie);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 1, autoExport: false });

  const { res, data } = await startGeneration(base, cookie, project.id, plan.scenario.scenarioId);
  assert.equal(res.status, 503);
  assert.equal(data.error.code, 'ai_not_configured');

  const planned = plan.casePlan.cases[0];
  const submitted = await mcpTool(base, token, 'imstage_create_batch', {
    projectId: project.id,
    scenarioId: plan.scenario.scenarioId,
    items: [{
      itemKey: planned.itemKey,
      name: planned.name,
      objective: planned.objective,
      context: planned.context,
      scene: uniqueScene(7),
    }],
  });
  toolOk(submitted, 'MCP caller content works without model configuration');
});

test('evaluation dataset scenarios refuse unlabeled AI generation', async () => {
  const provider = controlledCaseProvider();
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie, { type: 'evaluation_dataset' });
  const plan = await createScenario(base, cookie, project.id, { caseCount: 2, autoExport: false });

  const { res, data } = await startGeneration(base, cookie, project.id, plan.scenario.scenarioId);
  assert.equal(res.status, 422, JSON.stringify(data));
  assert.equal(data.error.code, 'missing_annotations');
  assert.equal(provider.calls.length, 0, 'no paid call for a disabled action');
});

/* ------------------------------------------------------------------ */
/* Deletion lifecycle                                                  */
/* ------------------------------------------------------------------ */

test('deleting a project releases every generation reservation immediately', async () => {
  const provider = controlledCaseProvider({ blockKeys: new Set(planAllKeys(50)) });
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 50, autoExport: false });
  const scenarioId = plan.scenario.scenarioId;
  const { res, data } = await startGeneration(base, cookie, project.id, scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));
  await waitFor(() => provider.calls.length > 0);

  // Delete while the paid run is in flight and future chunks are queued.
  const del = await jsonFetch(base, `/api/projects/${project.id}`, { method: 'DELETE', cookie, body: { revision: 1 } });
  assert.equal(del.res.status, 200, JSON.stringify(del.data));
  const active = Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get().n);
  assert.equal(active, 0, 'all reservations released in the delete transaction');
  const parent = app.db.prepare('SELECT status, reason FROM scenario_generations').get();
  assert.ok(!['queued', 'running'].includes(parent.status), `parent terminated (${parent.status})`);
  assert.equal(Number(app.db.prepare('SELECT COUNT(*) AS n FROM scenarios WHERE project_id = ?').get(project.id).n), 0, 'scenario rows cascade');

  // The late in-flight result can never publish.
  provider.release();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(Number(app.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n), 0, 'no late scene after delete');

  // Capacity is usable again without worker callbacks or a restart.
  const fresh = await httpCreateScene(base, cookie, uniqueScene(1));
  assert.equal(fresh.res.status, 200, JSON.stringify(fresh.data));
});

test('404/409 deletes never release another project\u2019s reservations', async () => {
  const provider = controlledCaseProvider({ blockKeys: new Set(planAllKeys(10)) });
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const first = await createProject(base, cookie, { name: '项目一' });
  const second = await createProject(base, cookie, { name: '项目二' });
  const del = await jsonFetch(base, `/api/projects/${first.id}`, { method: 'DELETE', cookie, body: { revision: 1 } });
  assert.equal(del.res.status, 200);

  const plan = await createScenario(base, cookie, second.id, { caseCount: 10, autoExport: false });
  const { res, data } = await startGeneration(base, cookie, second.id, plan.scenario.scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));
  const before = Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get().n);
  assert.equal(before, 10);

  // Re-deleting the gone project (404) and a wrong-revision delete (409) must
  // leave the other project's reservations untouched.
  const again = await jsonFetch(base, `/api/projects/${first.id}`, { method: 'DELETE', cookie, body: { revision: 1 } });
  assert.equal(again.res.status, 404);
  const wrong = await jsonFetch(base, `/api/projects/${second.id}`, { method: 'DELETE', cookie, body: { revision: 99 } });
  assert.equal(wrong.res.status, 409);
  const after = Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get().n);
  assert.equal(after, 10, 'failed deletes never release foreign reservations');
});

/* ------------------------------------------------------------------ */
/* Frozen project cast                                                 */
/* ------------------------------------------------------------------ */

test('model prompt carries the frozen cast names/roles; later cast edits never change it', async () => {
  const provider = controlledCaseProvider();
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const project = await createProject(base, cookie, {
    brief: { language: 'zh-CN', cast: [{ name: '小林', role: '新同事', avatar }, { name: '阿豪', role: '球友' }] },
  });
  const plan = await createScenario(base, cookie, project.id, { caseCount: 1, autoExport: false });

  // Later project cast edits must NOT change the scenario's frozen cast.
  const updated = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'PUT',
    cookie,
    body: { revision: 1, brief: { cast: [{ name: '别人', role: '无关人物' }] } },
  });
  assert.equal(updated.res.status, 200, JSON.stringify(updated.data));

  const { res, data } = await startGeneration(base, cookie, project.id, plan.scenario.scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));
  await waitFor(() => Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'consumed'").get().n) === 1);

  const task = app.db.prepare('SELECT prompt, scene_id FROM batch_tasks WHERE item_key = ?').get('case-001');
  assert.match(task.prompt, /【人物】小林（新同事）；阿豪（球友）/, 'frozen cast names/roles reach the model prompt');
  assert.doesNotMatch(task.prompt, /别人/, 'later project cast edits never leak into the prompt');
  assert.doesNotMatch(task.prompt, /base64/, 'no avatar bytes in the model prompt');

  // The published scene honors the frozen names and keeps the cast avatar.
  const scene = JSON.parse(app.db.prepare('SELECT scene_json FROM scenes WHERE id = ?').get(task.scene_id).scene_json);
  const byName = new Map(scene.participants.map((participant) => [participant.name, participant]));
  assert.ok(byName.get('小林'), 'participant keeps the frozen cast name');
  assert.equal(byName.get('小林')?.avatar, avatar, 'frozen cast avatar preserved on the published scene');
  assert.ok(byName.get('阿豪'), 'second cast member honored');
});

/* ------------------------------------------------------------------ */
/* Rate pacing: deferred tasks resume across limiter windows           */
/* ------------------------------------------------------------------ */

const rateLimits = { activeGlobal: 4, activePerUser: 1, rate: { windowMs: 200, max: 2, maxKeys: 100 } };
const pacingProjects = { pollMs: 5, sessionCheckMs: 10, maxLeaseWaitMs: 60 };

test('rate pacing: deferred scenario tasks resume across windows with exact starts and no user retry', async () => {
  const provider = controlledCaseProvider();
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: rateLimits }, projects: pacingProjects });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 5, autoExport: false });
  const { res, data } = await startGeneration(base, cookie, project.id, plan.scenario.scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));

  await waitFor(() => {
    const row = app.db.prepare('SELECT status FROM scenario_generations WHERE id = ?').get(data.generation.generationId);
    return row && ['done', 'partial', 'failed'].includes(row.status);
  });
  await waitFor(() => Number(app.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n) === 5);
  const status = await generationStatus(base, cookie, project.id, plan.scenario.scenarioId);
  assert.equal(status.generation.status, 'done');
  assert.equal(status.generation.done, 5);
  // Exactly one provider start per case: deferral happens BEFORE any run.
  assert.equal(new Set(provider.calls).size, 5, '5 distinct case starts');
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get().n), 0);
});

test('rate pacing yields the single worker to another account and sweeps revoked deferred work', async () => {
  const provider = controlledCaseProvider();
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: rateLimits }, projects: pacingProjects });
  const first = await register(base);
  const second = await register(base);
  const projectA = await createProject(base, first.cookie, { name: '账号 A' });
  const projectB = await createProject(base, second.cookie, { name: '账号 B' });
  const planA = await createScenario(base, first.cookie, projectA.id, { caseCount: 3, autoExport: false });
  const planB = await createScenario(base, second.cookie, projectB.id, { caseCount: 3, autoExport: false });
  const genA = await startGeneration(base, first.cookie, projectA.id, planA.scenario.scenarioId);
  const genB = await startGeneration(base, second.cookie, projectB.id, planB.scenario.scenarioId);
  assert.equal(genA.res.status, 200);
  assert.equal(genB.res.status, 200);

  // Both accounts complete despite the shared tight limiter: the deferring
  // account yields the global worker instead of blocking it.
  await waitFor(() => Number(app.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n) === 6);
  for (const [cookie, plan, gen] of [[first.cookie, planA, genA], [second.cookie, planB, genB]]) {
    const status = await generationStatus(base, cookie, projectA.id === gen.data.generation.projectId ? projectA.id : projectB.id, plan.scenario.scenarioId);
    assert.equal(status.generation.done, 3, 'each account finishes its own cases');
    void gen;
  }
});

test('cancel and session revocation while deferred release reservations without provider calls', async () => {
  const provider = controlledCaseProvider();
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: rateLimits }, projects: pacingProjects });
  const canceller = await register(base);
  const project = await createProject(base, canceller.cookie);
  const plan = await createScenario(base, canceller.cookie, project.id, { caseCount: 4, autoExport: false });
  const { res, data } = await startGeneration(base, canceller.cookie, project.id, plan.scenario.scenarioId);
  assert.equal(res.status, 200, JSON.stringify(data));
  const cancel = await jsonFetch(base, `/api/projects/${project.id}/scenarios/${plan.scenario.scenarioId}/generation/cancel`, {
    method: 'POST',
    cookie: canceller.cookie,
    body: { generationId: data.generation.generationId },
  });
  assert.equal(cancel.res.status, 200, JSON.stringify(cancel.data));
  await waitFor(() => Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get().n) === 0);

  // Revoked session: a deferred/queued generation is swept with no provider call.
  const revoked = await register(base);
  const project2 = await createProject(base, revoked.cookie, { name: '撤销项目' });
  const plan2 = await createScenario(base, revoked.cookie, project2.id, { caseCount: 4, autoExport: false });
  const second = await startGeneration(base, revoked.cookie, project2.id, plan2.scenario.scenarioId);
  assert.equal(second.res.status, 200);
  app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(revoked.user.id);
  await waitFor(() => {
    const row = app.db.prepare('SELECT status FROM scenario_generations WHERE id = ?').get(second.data.generation.generationId);
    return row && !['queued', 'running'].includes(row.status);
  }, 20_000);
  const stillActive = Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get().n);
  assert.equal(stillActive, 0, 'revoked deferred work releases every reservation');
});

/* ------------------------------------------------------------------ */
/* Legacy chunk controls and frozen scenario watermark                 */
/* ------------------------------------------------------------------ */

test('legacy batch entry cannot strand internal chunks: list hides them, cancel delegates to the parent, retry rejects', async () => {
  // Held runs keep the generation active while the public legacy entry is used.
  const provider = controlledCaseProvider({ blockKeys: new Set(['case-001', 'case-002']) });
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: rateLimits }, projects: pacingProjects });
  const { cookie } = await register(base);
  const project = await createProject(base, cookie);
  const plan = await createScenario(base, cookie, project.id, { caseCount: 2, autoExport: false });
  const { data } = await startGeneration(base, cookie, project.id, plan.scenario.scenarioId);
  const chunk = app.db.prepare('SELECT id FROM batch_jobs WHERE generation_id IS NOT NULL').get();
  assert.ok(chunk, 'internal chunk exists');

  // Public history never shows internal chunks in the legacy freeform list.
  const list = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs`, { cookie });
  assert.equal(list.res.status, 200);
  assert.equal(list.data.items.length, 0, 'internal chunks stay out of the legacy list');

  // Public legacy cancel of a chunk delegates to a consistent parent cancel.
  const cancel = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs/${chunk.id}/cancel`, {
    method: 'POST',
    cookie,
    body: {},
  });
  assert.equal(cancel.res.status, 200, JSON.stringify(cancel.data));
  assert.equal(Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE status = 'active'").get().n), 0, 'delegated cancel releases every reservation');
  const parent = app.db.prepare('SELECT status, cancel_requested FROM scenario_generations WHERE id = ?').get(data.generation.generationId);
  assert.equal(Number(parent.cancel_requested), 1);

  // Legacy retry of a scenario chunk is refused: it would drop the bindings.
  const retry = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs/${chunk.id}/retry`, {
    method: 'POST',
    cookie,
    body: {},
  });
  assert.equal(retry.res.status, 409);
  assert.equal(retry.data.error.code, 'generation_chunk');
  provider.release();
});

test('the frozen per-scenario watermark override reaches every persisted generated scene', async () => {
  const provider = controlledCaseProvider();
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const { cookie } = await register(base);

  // Project ON / scenario OFF.
  const on = await createProject(base, cookie, { name: '水印开项目', watermarkEnabled: true });
  const offPlan = await createScenario(base, cookie, on.id, { name: '水印关场景', caseCount: 1, autoExport: false, watermarkEnabled: false });
  assert.equal(offPlan.scenario.frozen.watermarkEnabled, false, 'explicit override frozen');
  await startGeneration(base, cookie, on.id, offPlan.scenario.scenarioId);
  await waitFor(() => Number(app.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n) === 1);
  const offScene = JSON.parse(app.db.prepare('SELECT scene_json FROM scenes ORDER BY rowid DESC LIMIT 1').get().scene_json);
  assert.equal(offScene.watermarkEnabled, false, 'persisted scene keeps the scenario choice');

  // Project OFF / scenario ON.
  const off = await createProject(base, cookie, { name: '水印关项目', watermarkEnabled: false });
  const onPlan = await createScenario(base, cookie, off.id, { name: '水印开场景', caseCount: 1, autoExport: false, watermarkEnabled: true });
  assert.equal(onPlan.scenario.frozen.watermarkEnabled, true);
  await startGeneration(base, cookie, off.id, onPlan.scenario.scenarioId);
  await waitFor(() => Number(app.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n) === 2);
  const onScene = JSON.parse(app.db.prepare('SELECT scene_json FROM scenes ORDER BY rowid DESC LIMIT 1').get().scene_json);
  assert.equal(onScene.watermarkEnabled, true, 'explicit ON overrides a project default OFF');

  // Omitted override still inherits the project flag.
  const inherited = await createScenario(base, cookie, off.id, { name: '继承场景', caseCount: 1, autoExport: false });
  assert.equal(inherited.scenario.frozen.watermarkEnabled, false, 'omitted keeps the project default');
});

test('a rate-limited account yields before the legacy wait budget elapses', async () => {
  const scripted = controlledCaseProvider();
  // Hold the real limiter clock until B enters the provider. Machine load and
  // HTTP setup latency cannot accidentally open A's next rate window.
  let clock = Date.now();
  let app;
  let projectA;
  let atBStart;
  const provider = { async complete(args) {
    if (!hasOwnToolResult(args.messages) && args.messages.some(message => message.role === 'user' && (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).includes('【场景】公平 B'))) {
      atBStart = {
        scenesA: Number(app.db.prepare('SELECT COUNT(*) AS n FROM scene_projects WHERE project_id = ?').get(projectA.id).n),
        pendingA: Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE project_id = ? AND status = 'active'").get(projectA.id).n),
      };
    }
    return scripted.complete(args);
  } };
  const started = await makeApp({ now: () => clock, agent: { chatProvider: provider, limits: { ...rateLimits, rate: { ...rateLimits.rate, windowMs: 600 } } }, projects: { ...pacingProjects, maxLeaseWaitMs: 3_000 } });
  app = started.app;
  const { base } = started;
  const a = await register(base, '公平 A');
  const b = await register(base, '公平 B');
  projectA = await createProject(base, a.cookie);
  const projectB = await createProject(base, b.cookie);
  const planA = await createScenario(base, a.cookie, projectA.id, { name: '公平 A', caseCount: 5, autoExport: false });
  const planB = await createScenario(base, b.cookie, projectB.id, { name: '公平 B', caseCount: 1, autoExport: false });
  const first = await startGeneration(base, a.cookie, projectA.id, planA.scenario.scenarioId);
  assert.equal(first.res.status, 200);
  await waitFor(() => Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE project_id = ? AND status = 'consumed'").get(projectA.id).n) === 2);
  assert.equal((await startGeneration(base, b.cookie, projectB.id, planB.scenario.scenarioId)).res.status, 200);
  await waitFor(() => atBStart);
  assert.deepEqual(atBStart, { scenesA: 2, pendingA: 3 }, 'B starts during A’s rate window, even when the legacy timeout exceeds that window');
  clock += 600;
  await waitFor(() => Number(app.db.prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE project_id = ? AND status = 'consumed'").get(projectA.id).n) === 4);
  clock += 600;
  await waitFor(() => Number(app.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n) === 6);
  assert.equal((await generationStatus(base, a.cookie, projectA.id, planA.scenario.scenarioId)).generation.status, 'done');
});

test('stopping during a denied lease reconciles parent and reservations, preserving legacy interruption', async () => {
  const { createAgentLimiter } = await import('../services/agent/limits.mjs');
  const time = Date.parse('2026-10-02T00:00:00Z');
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    for (const mode of ['scenario', 'legacy']) {
      const db = new DatabaseSync(':memory:');
      db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);
        CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at_ms INTEGER);
        CREATE TABLE scenes(user_id TEXT,id TEXT,title TEXT,platform TEXT,message_count INTEGER,revision INTEGER,scene_json TEXT,updated_at TEXT,PRIMARY KEY(user_id,id));
        CREATE TABLE mcp_idempotency(user_id TEXT,key TEXT,operation TEXT,request_hash TEXT,response_json TEXT,created_at TEXT,PRIMARY KEY(user_id,key));`);
      legacyStore.installProjectSchema(db);
      autoStore.installAutomationSchema(db);
      installGenerationAuditSchema(db);
      db.prepare('INSERT INTO users VALUES(?)').run('stop-user');
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('stop-session', 'stop-user', time + 86_400_000);
      const service = createProjectAutomation({ db, nowMs: () => time });
      const projectId = service.createProject({ userId: 'stop-user', input: { name: 'Stop fixture' } }).item.id;
      const plan = service.createScenario({ userId: 'stop-user', projectId, input: { name: 'Stop case', caseCount: 1, autoExport: false } });
      const gen = createScenarioGenerationService({ db, nowMs: () => time, queue: { wake() {} }, logger: { warn() {} } });
      const args = { userId: 'stop-user', sessionId: 'stop-session', projectId, scenarioId: plan.scenario.scenarioId };
      const generationId = mode === 'scenario' ? gen.enqueue(args).generation.generationId : null;
      if (mode === 'legacy') legacyStore.createBatchJob(db, { ...args, rules: '', tasks: [{ prompt: 'Legacy stop', platform: 'imstage' }], clientBatchId: 'legacy-stop', nowMs: time });
      const limiter = createAgentLimiter(rateLimits);
      for (let index = 0; index < 2; index++) limiter.tryStart(args.userId, time).release();
      let entered;
      const denial = new Promise(resolve => { entered = resolve; });
      let providerCalls = 0;
      const queue = createBatchQueue({ db, nowMs: () => time, scenarioGeneration: gen, onJobFinished: job => gen.onChunkJobSettled(job), pollMs: 5, maxLeaseWaitMs: 500, logger: { warn() {}, error() {} },
        agent: { runtime: { async run() { providerCalls++; return { ok: true, scene: createScene() }; } }, limiter: { tryStart(userId, at) { const result = limiter.tryStart(userId, at); if (!result.ok) entered(); return result; } } } });
      try {
        queue.start();
        await denial;
        await queue.stop();
        assert.equal(providerCalls, 0);
        assert.equal(db.prepare('SELECT status FROM batch_jobs').get().status, 'interrupted');
        assert.equal(db.prepare('SELECT status FROM batch_tasks').get().status, 'interrupted');
        assert.equal(cap.countActiveReservations(db, args.userId), 0);
        if (generationId) assert.equal(gen.get({ userId: args.userId, generationId }).status, 'interrupted');
      } finally { await queue.stop(); db.close(); }
    }
  } finally { clearInterval(keepAlive); }
});

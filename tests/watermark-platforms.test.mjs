/**
 * Project creation platform templates + optional watermark (2026-10-02 user
 * decision), verified end to end offline:
 *
 *   - Scene.watermarkEnabled boolean roundtrip / default (absent = on) /
 *     invalid rejection / obsolete-alias stripping;
 *   - Project.watermarkEnabled persistence (create/update/get/list/context),
 *     omitted update preserves the old value, conflict + account isolation;
 *   - additive SQLite migration: legacy rows keep their watermark (default on);
 *   - durable batch blank scenes freeze the project switch at enqueue and keep
 *     it on retry even after the project changes;
 *   - the Agent runtime preserves the starting watermark flag (create_scene)
 *     and the model can never change it (update_element);
 *   - deterministic HTML renders genuinely different platform templates and
 *     renders watermark on/off differently;
 *   - cache render ids and audit scene hashes distinguish on/off scenes.
 *
 * No network call and no provider credential: providers are injected fakes.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { start } from '../services/api/server.mjs';
import { createScene, parseSceneJson, validateScene } from '../apps/web/src/studio/model.ts';
import { validateConversationScene } from '../packages/schema/conversation.mjs';
import { renderSceneHtml } from '../packages/renderer/renderSceneHtml.mjs';
import {
  canonicalSceneJson,
  sceneWatermarkEnabled,
  stripDisclosureOverrides,
} from '../packages/schema/policy.mjs';
import { hashScene } from '../services/audit/generation-audit.mjs';
import { computeRenderId, resolveRenderConfig } from '../services/mcp/render.mjs';
import { executeTool } from '../services/agent/tools.mjs';
import * as projectStore from '../services/projects/index.mjs';
import { blankScene, validateProjectWatermarkEnabled, DEFAULT_PROJECT_WATERMARK } from '../services/projects/model.mjs';

/* ------------------------------------------------------------------ */
/* Scoped runtime directory                                            */
/* ------------------------------------------------------------------ */

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-watermark-'));

const APP_ORIGIN = 'http://127.0.0.1:4417';
const activeApps = new Set();

function caseDir(label) {
  return fs.mkdtempSync(path.join(RUNTIME_ROOT, `${label}-`));
}

async function makeApp({ agent = {}, projects = {}, dbPath } = {}) {
  const dir = caseDir('case');
  const app = await start({
    dbPath: dbPath ?? path.join(dir, 'imstage.db'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
    env: {},
    agent,
    projects: { pollMs: 20, sessionCheckMs: 30, maxLeaseWaitMs: 3_000, ...projects },
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}`, dir, dbPath: app.config.dbPath };
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
/* Fake providers + HTTP helpers                                       */
/* ------------------------------------------------------------------ */

function toolResponse(name, args, { content = '', id = 'call' } = {}) {
  return { content, toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls' };
}

function finalResponse(text) {
  return { content: text, toolCalls: [], finishReason: 'stop' };
}

function scriptedProvider(script) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async complete({ messages, signal }) {
      calls.push(JSON.parse(JSON.stringify(messages)));
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

const highLimits = {
  activeGlobal: 4,
  activePerUser: 1,
  rate: { windowMs: 60_000, max: 1_000, maxKeys: 1_000 },
};

let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `watermark-${process.pid}-${emailSeq}@example.com`;
}

function mutationHeaders(cookie, extras = {}) {
  const headers = { 'content-type': 'application/json', origin: APP_ORIGIN, 'x-imstage-request': '1', ...extras };
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
    body: JSON.stringify({ name: '水印用户', email: uniqueEmail(), password: 'password-123456' }),
  });
  assert.equal(res.status, 200);
  return cookieFrom(res);
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

async function createProject(base, cookie, body = {}) {
  const { res, data } = await jsonFetch(base, '/api/projects', {
    method: 'POST',
    cookie,
    body: { name: '水印项目', ...body },
  });
  assert.equal(res.status, 200, JSON.stringify(data));
  return data.item;
}

async function readNdjson(res) {
  const text = await res.text();
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/* ------------------------------------------------------------------ */
/* Scene model: boolean roundtrip / default / invalid / aliases        */
/* ------------------------------------------------------------------ */

function sceneWith(extra = {}) {
  return {
    id: 'scene-watermark',
    title: '水印场景',
    platform: 'wechat',
    deviceTime: '09:41',
    date: '',
    selfId: 'p1',
    participants: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }],
    messages: [{ id: 'm1', participantId: 'p2', type: 'text', text: '你好', time: '09:41' }],
    watermark: '自定义水印',
    ...extra,
  };
}

test('scene watermarkEnabled round-trips booleans, defaults to on and rejects non-boolean', () => {
  // Roundtrip: explicit booleans survive validation (and a second pass).
  for (const enabled of [true, false]) {
    const first = validateScene(sceneWith({ watermarkEnabled: enabled }));
    assert.equal(first.ok, true);
    assert.equal(first.scene.watermarkEnabled, enabled);
    const again = validateScene(first.scene);
    assert.equal(again.ok, true);
    assert.equal(again.scene.watermarkEnabled, enabled);
  }
  // Default: absent means on. The normalized scene keeps the field absent and
  // every surface derives "on" from the same shared rule.
  const legacy = validateScene(sceneWith());
  assert.equal(legacy.ok, true);
  assert.equal(legacy.scene.watermarkEnabled, undefined);
  assert.equal(sceneWatermarkEnabled(legacy.scene), true);
  assert.equal(sceneWatermarkEnabled(undefined), true);
  // Invalid types are rejected loudly, never coerced.
  for (const bad of ['false', 1, 0, null, {}]) {
    const result = validateScene(sceneWith({ watermarkEnabled: bad }));
    assert.equal(result.ok, false, `watermarkEnabled=${JSON.stringify(bad)} must be rejected`);
    assert.match(JSON.stringify(result.errors), /watermarkEnabled/);
  }
  // JSON import path enforces the same contract.
  const parsed = parseSceneJson(JSON.stringify(sceneWith({ watermarkEnabled: false })));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.scene.watermarkEnabled, false);
  // Obsolete toggle aliases are still stripped; the supported field is kept.
  const stripped = stripDisclosureOverrides({ watermarkEnabled: false, hideDisclosure: true, markEnabled: false });
  assert.equal(stripped.watermarkEnabled, false);
  assert.equal('hideDisclosure' in stripped, false);
  assert.equal('markEnabled' in stripped, false);
});

test('conversation schema keeps the optional watermark boolean and rejects non-booleans', () => {
  const raw = {
    title: '评测对话',
    platform: 'wechat',
    deviceTime: '09:41',
    date: '',
    selfId: 'me',
    participants: [{ id: 'me', name: '我' }],
    messages: [{ id: 'm1', participantId: 'me', type: 'text', text: '你好', time: '09:41' }],
    watermark: '',
  };
  const on = validateConversationScene({ ...raw, watermarkEnabled: true });
  assert.equal(on.watermarkEnabled, true);
  const off = validateConversationScene({ ...raw, watermarkEnabled: false });
  assert.equal(off.watermarkEnabled, false);
  const missing = validateConversationScene(raw);
  assert.equal('watermarkEnabled' in missing, false);
  assert.throws(() => validateConversationScene({ ...raw, watermarkEnabled: 'no' }), /watermarkEnabled/);
});

test('project watermark validation: default on, explicit off, rejection of coercion', () => {
  assert.equal(DEFAULT_PROJECT_WATERMARK, true);
  assert.equal(validateProjectWatermarkEnabled(undefined), true);
  assert.equal(validateProjectWatermarkEnabled(undefined, false), false, 'omitted keeps the passed fallback');
  assert.equal(validateProjectWatermarkEnabled(false), false);
  assert.equal(validateProjectWatermarkEnabled(true), true);
  // `null` is not "omitted": it is a non-boolean and must be rejected.
  for (const bad of ['true', 1, 0, '', {}, null]) {
    assert.throws(() => validateProjectWatermarkEnabled(bad), /watermarkEnabled/, `${JSON.stringify(bad)} must be rejected`);
  }
});

/* ------------------------------------------------------------------ */
/* Project persistence: API roundtrip, omitted updates, isolation      */
/* ------------------------------------------------------------------ */

test('project watermarkEnabled persists through create/get/list/update and is account-isolated', async () => {
  const { base } = await makeApp({ agent: { chatProvider: scriptedProvider([]), limits: highLimits } });
  const alice = await register(base);
  const bob = await register(base);

  // New projects default to on.
  const on = await createProject(base, alice, { name: '默认项目' });
  assert.equal(on.watermarkEnabled, true);
  // Explicit off is stored; invalid values are rejected (no coercion).
  const off = await createProject(base, alice, { name: '无水印项目', watermarkEnabled: false });
  assert.equal(off.watermarkEnabled, false);
  const bad = await jsonFetch(base, '/api/projects', { method: 'POST', cookie: alice, body: { name: '坏值', watermarkEnabled: 'false' } });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.data.error.code, 'invalid_watermark');

  // List and detail both expose the flag.
  const list = await jsonFetch(base, '/api/projects', { cookie: alice });
  const listed = list.data.items.find((item) => item.id === off.id);
  assert.equal(listed.watermarkEnabled, false);
  const detail = await jsonFetch(base, `/api/projects/${off.id}`, { cookie: alice });
  assert.equal(detail.data.item.watermarkEnabled, false);

  // Omitted update fields preserve the stored value (false stays false).
  const kept = await jsonFetch(base, `/api/projects/${off.id}`, {
    method: 'PUT', cookie: alice, body: { rules: '新规则', revision: off.revision },
  });
  assert.equal(kept.res.status, 200);
  assert.equal(kept.data.item.watermarkEnabled, false);
  assert.equal(kept.data.item.rules, '新规则');

  // An explicit change is persisted; a stale revision conflicts.
  const changed = await jsonFetch(base, `/api/projects/${off.id}`, {
    method: 'PUT', cookie: alice, body: { watermarkEnabled: true, revision: kept.data.item.revision },
  });
  assert.equal(changed.res.status, 200);
  assert.equal(changed.data.item.watermarkEnabled, true);
  const conflict = await jsonFetch(base, `/api/projects/${off.id}`, {
    method: 'PUT', cookie: alice, body: { watermarkEnabled: false, revision: kept.data.item.revision },
  });
  assert.equal(conflict.res.status, 409);
  const afterConflict = await jsonFetch(base, `/api/projects/${off.id}`, { cookie: alice });
  assert.equal(afterConflict.data.item.watermarkEnabled, true, 'a rejected write never changes the stored switch');

  // Invalid update values are rejected and change nothing — including null,
  // which is a non-boolean, not "omitted".
  for (const bad of ['yes', null]) {
    const invalid = await jsonFetch(base, `/api/projects/${off.id}`, {
      method: 'PUT', cookie: alice, body: { watermarkEnabled: bad, revision: changed.data.item.revision },
    });
    assert.equal(invalid.res.status, 400, `watermarkEnabled=${JSON.stringify(bad)} must be rejected`);
    assert.equal(invalid.data.error.code, 'invalid_watermark');
  }

  // Account isolation: another account can neither read nor write the switch.
  const bobGet = await jsonFetch(base, `/api/projects/${off.id}`, { cookie: bob });
  assert.equal(bobGet.res.status, 404);
  const bobPut = await jsonFetch(base, `/api/projects/${off.id}`, {
    method: 'PUT', cookie: bob, body: { watermarkEnabled: false, revision: changed.data.item.revision },
  });
  assert.equal(bobPut.res.status, 404);
});

test('additive migration keeps legacy project rows on and never rewrites stored data', () => {
  const db = new DatabaseSync(':memory:');
  // A pre-watermark database: no watermark_enabled columns anywhere.
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE scenes(user_id TEXT,id TEXT,title TEXT,platform TEXT,message_count INTEGER,
      revision INTEGER,scene_json TEXT,updated_at TEXT,PRIMARY KEY(user_id,id));
    CREATE TABLE projects (
      user_id    TEXT NOT NULL,
      id         TEXT NOT NULL,
      name       TEXT NOT NULL,
      rules      TEXT NOT NULL DEFAULT '',
      platform   TEXT NOT NULL DEFAULT 'wechat',
      revision   INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE TABLE batch_jobs (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      project_id       TEXT NOT NULL,
      session_id       TEXT,
      client_batch_id  TEXT,
      status           TEXT NOT NULL,
      rules            TEXT NOT NULL DEFAULT '',
      reason           TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      total            INTEGER NOT NULL,
      succeeded        INTEGER NOT NULL DEFAULT 0,
      failed           INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL
    );
    CREATE TABLE batch_tasks (
      id         TEXT PRIMARY KEY,
      job_id     TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      ordinal    INTEGER NOT NULL,
      prompt     TEXT NOT NULL,
      platform   TEXT NOT NULL,
      status     TEXT NOT NULL,
      scene_id   TEXT,
      error      TEXT,
      error_code TEXT,
      detail     TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );
    INSERT INTO users VALUES('legacy-user');
    INSERT INTO projects VALUES('legacy-user','legacy-project','旧项目','旧规则','wechat',7,'2026-09-01','2026-09-01');
    INSERT INTO batch_jobs VALUES('legacy-job','legacy-user','legacy-project',NULL,NULL,'done','',NULL,0,1,1,0,'2026-09-01','2026-09-01');
    INSERT INTO batch_tasks VALUES('legacy-task','legacy-job','legacy-user',0,'提示','wechat','done',NULL,NULL,NULL,'','2026-09-01');
  `);
  projectStore.installProjectSchema(db);

  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  assert.equal(columns('projects').has('watermark_enabled'), true);
  assert.equal(columns('batch_jobs').has('watermark_enabled'), true);

  // The legacy row survives and reads as watermark-on; nothing else changed.
  const item = projectStore.getProjectItem(db, 'legacy-user', 'legacy-project');
  assert.equal(item.name, '旧项目');
  assert.equal(item.rules, '旧规则');
  assert.equal(item.revision, 7);
  assert.equal(item.watermarkEnabled, true);
  const context = projectStore.getProjectContext(db, 'legacy-user', 'legacy-project');
  assert.equal(context.watermarkEnabled, true);
  const job = projectStore.getJobDetail(db, 'legacy-user', 'legacy-project', 'legacy-job');
  assert.equal(job.watermarkEnabled, true);
  assert.equal(job.status, 'done');

  // The migrated row is writable through the same store contract.
  projectStore.updateProject(db, {
    userId: 'legacy-user', projectId: 'legacy-project', name: '旧项目', rules: '旧规则',
    platform: 'wechat', watermarkEnabled: false, revision: 7, nowMs: Date.now(),
  });
  assert.equal(projectStore.getProjectItem(db, 'legacy-user', 'legacy-project').watermarkEnabled, false);
  // A store-level update with an omitted watermarkEnabled preserves the stored
  // switch in both directions — it never resets to the default.
  projectStore.updateProject(db, {
    userId: 'legacy-user', projectId: 'legacy-project', name: '旧项目', rules: '改了规则',
    platform: 'wechat', revision: 8, nowMs: Date.now(),
  });
  assert.equal(projectStore.getProjectItem(db, 'legacy-user', 'legacy-project').watermarkEnabled, false, 'off stays off when omitted');
  projectStore.updateProject(db, {
    userId: 'legacy-user', projectId: 'legacy-project', name: '旧项目', rules: '再改规则',
    platform: 'wechat', watermarkEnabled: true, revision: 9, nowMs: Date.now(),
  });
  assert.equal(projectStore.getProjectItem(db, 'legacy-user', 'legacy-project').watermarkEnabled, true);
  projectStore.updateProject(db, {
    userId: 'legacy-user', projectId: 'legacy-project', name: '旧项目', rules: '又一次',
    platform: 'wechat', revision: 10, nowMs: Date.now(),
  });
  assert.equal(projectStore.getProjectItem(db, 'legacy-user', 'legacy-project').watermarkEnabled, true, 'on stays on when omitted');
  db.close();
});

/* ------------------------------------------------------------------ */
/* Batch: frozen switch at enqueue, preserved on retry                 */
/* ------------------------------------------------------------------ */

test('batch blank scenes freeze the project watermark switch and keep it on retry', async () => {
  // First run fails (no mutation); the retry run rebuilds the scene through the
  // real create_scene tool, so the published scene proves the whole chain.
  const modelScene = { ...createScene('weekend'), title: '批量作品', watermarkEnabled: true };
  const provider = scriptedProvider([
    finalResponse('没有生成任何内容'),
    toolResponse('create_scene', { scene: modelScene }),
    finalResponse('完成'),
  ]);
  const { base, app } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie, { name: '批量项目', watermarkEnabled: false });

  const { res, data } = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs`, {
    method: 'POST', cookie, body: { prompts: ['生成一段对话'], platforms: ['wechat'] },
  });
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(data.item.watermarkEnabled, false, 'the job snapshot carries the enqueue-time switch');

  // The project turns the watermark back on *before* the work runs.
  const changed = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'PUT', cookie, body: { watermarkEnabled: true, revision: project.revision },
  });
  assert.equal(changed.data.item.watermarkEnabled, true);

  const failed = await waitFor(async () => {
    const { data: job } = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs/${data.item.id}`, { cookie });
    return job.item.status === 'failed' ? job.item : null;
  });
  assert.equal(failed.tasks.length, 1);
  assert.equal(failed.tasks[0].status, 'failed');

  // Explicit retry: the retried job keeps the frozen switch, not the project's.
  const retry = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs/${data.item.id}/retry`, {
    method: 'POST', cookie, body: {},
  });
  assert.equal(retry.res.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.item.watermarkEnabled, false, 'retry preserves the original frozen switch');
  assert.notEqual(retry.data.item.id, data.item.id);

  const done = await waitFor(async () => {
    const { data: job } = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs/${retry.data.item.id}`, { cookie });
    return job.item.status === 'done' ? job.item : null;
  });
  const sceneId = done.tasks[0].sceneId;
  const saved = await jsonFetch(base, `/api/scenes/${sceneId}`, { cookie });
  assert.equal(saved.res.status, 200);
  assert.equal(saved.data.item.scene.watermarkEnabled, false, 'the published scene keeps the frozen (off) switch');

  // The blank scene contract itself carries the switch through validation.
  const blank = blankScene('wechat', 'blank-1', false);
  assert.equal(blank.watermarkEnabled, false);
  assert.equal(blankScene('wechat', 'blank-2').watermarkEnabled, true);
  // Direct store path: createBatchJob snapshots and createRetryJob copies.
  const row = app.db.prepare('SELECT watermark_enabled FROM batch_jobs WHERE id = ?').get(retry.data.item.id);
  assert.equal(Number(row.watermark_enabled), 0);
});

/* ------------------------------------------------------------------ */
/* Agent runtime: preserve the starting flag, model can never change it */
/* ------------------------------------------------------------------ */

test('create_scene preserves the starting watermark flag and update_element can never change it', async () => {
  // Starting scene: watermark off (a user choice).
  const start = { ...createScene('weekend'), watermark: '我的水印', watermarkEnabled: false };
  // The model tries to turn it on and to drop the field entirely.
  for (const candidate of [
    { ...createScene('weekend'), title: '重建场景', watermarkEnabled: true },
    { ...createScene('weekend'), title: '重建场景' },
  ]) {
    const result = await executeTool('create_scene', { scene: candidate }, { scene: start });
    assert.equal(result.ok, true);
    assert.equal(result.scene.watermarkEnabled, false, 'create_scene keeps the starting user preference');
    assert.equal(result.scene.watermark, '我的水印', 'the custom watermark text is kept too');
  }
  // A starting scene with the flag on keeps it on; absent stays absent (on).
  const on = await executeTool('create_scene', { scene: { ...createScene('weekend'), title: 'X' } },
    { scene: { ...start, watermarkEnabled: true } });
  assert.equal(on.scene.watermarkEnabled, true);
  const legacy = await executeTool('create_scene', { scene: { ...createScene('weekend'), title: 'X' } },
    { scene: (() => { const s = { ...start }; delete s.watermarkEnabled; return s; })() });
  assert.equal(legacy.scene.watermarkEnabled, undefined);

  // update_element rejects the field outright (both directions).
  for (const patch of [{ watermarkEnabled: true }, { watermarkEnabled: false }, { watermark: '新水印' }]) {
    const rejected = await executeTool('update_element', { targetId: '@scene', patch }, { scene: start });
    assert.equal(rejected.ok, false, `patch ${JSON.stringify(patch)} must be rejected`);
  }
  assert.equal(start.watermarkEnabled, false, 'the scene is never mutated');
});

test('server Agent runs preserve scene settings even when project defaults differ', async () => {
  const provider = scriptedProvider([finalResponse('好的')]);
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const offProject = await createProject(base, cookie, { name: 'Agent 项目', watermarkEnabled: false });
  const onProject = await createProject(base, cookie, { name: '水印项目', watermarkEnabled: true });

  // Legacy blank scene without a flag keeps the shared default: watermark on.
  const blank = { ...createScene('weekend'), id: crypto.randomUUID(), messages: [] };
  delete blank.watermarkEnabled;
  const first = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ prompt: '生成一段对话', scene: blank, projectId: offProject.id }),
  });
  assert.equal(first.status, 200);
  await readNdjson(first);
  // The provider really sees the scene context; unescape it before asserting.
  const modelView = (index) => JSON.stringify(provider.calls[index]).replace(/\\"/g, '"');
  assert.doesNotMatch(modelView(0), /"watermarkEnabled":false/, 'legacy blank scenes are never rewritten by project defaults');

  // An explicit boolean on a blank scene always wins over the project default:
  // project off + scene on stays on…
  const explicitOn = { ...createScene('weekend'), id: crypto.randomUUID(), messages: [], watermarkEnabled: true };
  const second = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ prompt: '生成一段对话', scene: explicitOn, projectId: offProject.id }),
  });
  assert.equal(second.status, 200);
  await readNdjson(second);
  assert.match(modelView(1), /"watermarkEnabled":true/, 'explicit on survives an off project');

  // …and project on + scene off stays off.
  const explicitOff = { ...createScene('weekend'), id: crypto.randomUUID(), messages: [], watermarkEnabled: false };
  const third = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ prompt: '生成一段对话', scene: explicitOff, projectId: onProject.id }),
  });
  assert.equal(third.status, 200);
  await readNdjson(third);
  assert.match(modelView(2), /"watermarkEnabled":false/, 'explicit off survives an on project');

  // An established scene keeps its own switch even with the same project.
  const established = { ...createScene('weekend'), id: crypto.randomUUID(), watermarkEnabled: true };
  const fourth = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ prompt: '调整语气', scene: established, projectId: offProject.id }),
  });
  assert.equal(fourth.status, 200);
  await readNdjson(fourth);
  assert.match(modelView(3), /"watermarkEnabled":true/, 'established scenes are never overwritten');
});

/* ------------------------------------------------------------------ */
/* Deterministic rendering + cache/audit identity                      */
/* ------------------------------------------------------------------ */

test('deterministic HTML renders every platform template differently and honours on/off', () => {
  const base = {
    id: 'r1', title: '渲染', deviceTime: '09:41', date: '', selfId: 'p1',
    participants: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }],
    messages: [{ id: 'm1', participantId: 'p2', type: 'text', text: '你好', time: '09:41' }],
    watermark: '自定义水印',
  };
  const signatures = new Map();
  for (const platform of ['imstage', 'wechat', 'whatsapp', 'imessage', 'instagram', 'xiaohongshu', 'slack']) {
    const html = renderSceneHtml({ ...base, platform }, { surface: 'ios' });
    assert.ok(html.includes(`platform-${platform}`), `${platform} body class`);
    for (const [other, signature] of signatures) {
      assert.notEqual(html, signature, `${platform} must render differently from ${other}`);
    }
    signatures.set(platform, html);
  }
  // WeChat green self bubbles, WhatsApp green header, iMessage blue self
  // bubbles and Slack purple header prove real chrome differences in output.
  assert.ok(renderSceneHtml({ ...base, platform: 'wechat' }, {}).includes('#95ec69'));
  assert.ok(renderSceneHtml({ ...base, platform: 'whatsapp' }, {}).includes('#075e54'));
  assert.ok(renderSceneHtml({ ...base, platform: 'imessage' }, {}).includes('#0b84ff'));
  assert.ok(renderSceneHtml({ ...base, platform: 'slack' }, {}).includes('#4a154b'));

  // Watermark on/off really changes the rendered frame.
  const on = renderSceneHtml({ ...base, platform: 'wechat', watermarkEnabled: true }, {});
  const off = renderSceneHtml({ ...base, platform: 'wechat', watermarkEnabled: false }, {});
  assert.ok(on.includes('data-imstage-disclosure="true"'));
  assert.ok(on.includes('自定义水印'));
  assert.equal(off.includes('data-imstage-disclosure'), false);
  assert.equal(off.includes('自定义水印'), false);
});

test('render cache ids and audit scene hashes distinguish watermark on/off scenes', () => {
  const base = createScene('weekend');
  const options = resolveRenderConfig({ surface: 'ios', width: 390, height: 844, outputKind: 'long-screenshot' });
  const on = computeRenderId({ scene: { ...base, watermarkEnabled: true }, ...options, rendererVersion: 'v' });
  const off = computeRenderId({ scene: { ...base, watermarkEnabled: false }, ...options, rendererVersion: 'v' });
  assert.notEqual(on, off, 'a cached render is never reused across on/off');
  assert.equal(computeRenderId({ scene: { ...base, watermarkEnabled: true }, ...options, rendererVersion: 'v' }), on);
  assert.notEqual(
    hashScene({ ...base, watermarkEnabled: true }),
    hashScene({ ...base, watermarkEnabled: false }),
    'the audit scene hash records the difference',
  );
  assert.notEqual(
    canonicalSceneJson({ ...base, watermarkEnabled: true }),
    canonicalSceneJson({ ...base, watermarkEnabled: false }),
  );
});

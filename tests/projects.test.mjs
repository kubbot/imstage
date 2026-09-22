/**
 * HTTP integration tests for IMStage Projects and durable batch generation.
 *
 * Prerequisites covered here:
 *   - account isolation for projects, scene association and Agent rules;
 *   - conflict-safe revisions;
 *   - rule/platform snapshots at enqueue;
 *   - durable serial batch jobs with status, cancel, retry and idempotency;
 *   - failed tools and restarts never publish a scene or report false success.
 *
 * Providers are injected, so no network call or credential is involved.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { start } from '../services/api/server.mjs';
import { createScene } from '../apps/web/src/studio/model.ts';
import { markInterruptedJobs } from '../services/projects/index.mjs';
import * as projectStore from '../services/projects/index.mjs';

/* ------------------------------------------------------------------ */
/* Scoped runtime directory                                            */
/* ------------------------------------------------------------------ */

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-projects-'));

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

function generatedProvider(title = '生成的作品') {
  const scene = createScene('weekend');
  scene.title = title;
  return scriptedProvider([
    toolResponse('create_scene', { scene }),
    finalResponse('已生成。'),
  ]);
}

/** Blocks the first completion until released/aborted; later calls finish. */
function gatedProvider(script) {
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const calls = [];
  let index = 0;
  return {
    calls,
    release: () => releaseGate(),
    async complete({ messages, signal }) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      if (calls.length === 1) {
        await new Promise((resolve, reject) => {
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
            resolve();
          });
        });
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

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

let emailSeq = 0;
function uniqueEmail() {
  emailSeq += 1;
  return `projects-${process.pid}-${emailSeq}@example.com`;
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
    body: JSON.stringify({ name: '项目用户', email: uniqueEmail(), password: 'password-123456' }),
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
    body: { name: '项目 A', ...body },
  });
  assert.equal(res.status, 200, JSON.stringify(data));
  return data.item;
}

async function enqueue(base, cookie, projectId, body) {
  const { res, data } = await jsonFetch(base, `/api/projects/${projectId}/batch-jobs`, {
    method: 'POST',
    cookie,
    body,
  });
  return { res, data };
}

async function getJob(base, cookie, projectId, jobId) {
  const { res, data } = await jsonFetch(base, `/api/projects/${projectId}/batch-jobs/${jobId}`, { cookie });
  return { res, data };
}

async function waitFor(predicate, timeoutMs = 4_000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function waitForJobStatus(base, cookie, projectId, jobId, statuses) {
  return waitFor(async () => {
    const { res, data } = await getJob(base, cookie, projectId, jobId);
    assert.equal(res.status, 200);
    return statuses.includes(data.item.status) ? data.item : null;
  });
}

/* ------------------------------------------------------------------ */
/* Projects CRUD, isolation and revisions                              */
/* ------------------------------------------------------------------ */

test('projects CRUD enforces ownership, bounds and conflict-safe revisions', async () => {
  const { base } = await makeApp({ agent: { chatProvider: generatedProvider(), limits: highLimits } });
  const alice = await register(base);
  const bob = await register(base);

  // Creation validates fields.
  const bad = await jsonFetch(base, '/api/projects', { method: 'POST', cookie: alice, body: { name: '   ' } });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.data.error.code, 'invalid_name');

  const tooLongRules = await jsonFetch(base, '/api/projects', {
    method: 'POST',
    cookie: alice,
    body: { name: '规则', rules: 'x'.repeat(4001) },
  });
  assert.equal(tooLongRules.res.status, 400);
  assert.equal(tooLongRules.data.error.code, 'invalid_rules');

  const project = await createProject(base, alice, {
    name: '产品发布',
    rules: '保持轻松语气',
    platform: 'xiaohongshu',
  });
  assert.equal(project.name, '产品发布');
  assert.equal(project.rules, '保持轻松语气');
  assert.equal(project.platform, 'xiaohongshu');
  assert.equal(project.revision, 1);

  // Alice sees it; Bob cannot read, update or delete it.
  const list = await jsonFetch(base, '/api/projects', { cookie: alice });
  assert.equal(list.res.status, 200);
  assert.equal(list.data.items.length, 1);

  const bobGet = await jsonFetch(base, `/api/projects/${project.id}`, { cookie: bob });
  assert.equal(bobGet.res.status, 404);
  const bobUpdate = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'PUT',
    cookie: bob,
    body: { name: '偷来的', revision: 1 },
  });
  assert.equal(bobUpdate.res.status, 404);
  const bobDelete = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'DELETE',
    cookie: bob,
    body: { revision: 1 },
  });
  assert.equal(bobDelete.res.status, 404);

  // Stale revision is rejected; the current revision succeeds and advances.
  const stale = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'PUT',
    cookie: alice,
    body: { rules: '更新后的规则', revision: 0 },
  });
  assert.equal(stale.res.status, 409);
  assert.equal(stale.data.error.code, 'revision_conflict');

  const updated = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'PUT',
    cookie: alice,
    body: { rules: '更新后的规则', revision: 1 },
  });
  assert.equal(updated.res.status, 200);
  assert.equal(updated.data.item.revision, 2);
  assert.equal(updated.data.item.rules, '更新后的规则');

  const replay = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'PUT',
    cookie: alice,
    body: { rules: '过期写入', revision: 1 },
  });
  assert.equal(replay.res.status, 409);

  const staleDelete = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'DELETE',
    cookie: alice,
    body: { revision: 1 },
  });
  assert.equal(staleDelete.res.status, 409);

  const removed = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'DELETE',
    cookie: alice,
    body: { revision: 2 },
  });
  assert.equal(removed.res.status, 200);
  assert.equal(removed.data.ok, true);
});

test('project deletion preserves scenes and only removes the association', async () => {
  const { app, base } = await makeApp({ agent: { chatProvider: generatedProvider(), limits: highLimits } });
  const alice = await register(base);
  const project = await createProject(base, alice);

  const sceneId = crypto.randomUUID();
  const scene = { ...createScene('weekend'), id: sceneId, title: '保留的作品' };
  const saved = await jsonFetch(base, `/api/scenes/${sceneId}`, {
    method: 'PUT',
    cookie: alice,
    body: { scene, revision: 0 },
  });
  assert.equal(saved.res.status, 200);

  const attach = await jsonFetch(base, `/api/projects/${project.id}/scenes`, {
    method: 'POST',
    cookie: alice,
    body: { sceneId },
  });
  assert.equal(attach.res.status, 200);
  assert.equal(attach.data.alreadyAttached, false);

  const attachAgain = await jsonFetch(base, `/api/projects/${project.id}/scenes`, {
    method: 'POST',
    cookie: alice,
    body: { sceneId },
  });
  assert.equal(attachAgain.data.alreadyAttached, true);

  const detail = await jsonFetch(base, `/api/projects/${project.id}`, { cookie: alice });
  assert.equal(detail.data.scenes.length, 1);
  assert.equal(detail.data.scenes[0].id, sceneId);

  const removed = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'DELETE',
    cookie: alice,
    body: { revision: 1 },
  });
  assert.equal(removed.res.status, 200);
  assert.equal(removed.data.detachedScenes, 1);

  // The scene still exists for the account.
  const sceneAfter = await jsonFetch(base, `/api/scenes/${sceneId}`, { cookie: alice });
  assert.equal(sceneAfter.res.status, 200);
  const associations = app.db
    .prepare('SELECT COUNT(*) AS total FROM scene_projects WHERE user_id = ? AND scene_id = ?')
    .get((await jsonFetch(base, '/api/auth/session', { cookie: alice })).data.user.id, sceneId);
  assert.equal(Number(associations.total), 0);
});

test('attaching an existing scene requires ownership', async () => {
  const { base } = await makeApp({ agent: { chatProvider: generatedProvider(), limits: highLimits } });
  const alice = await register(base);
  const bob = await register(base);
  const project = await createProject(base, alice);

  const sceneId = crypto.randomUUID();
  await jsonFetch(base, `/api/scenes/${sceneId}`, {
    method: 'PUT',
    cookie: bob,
    body: { scene: { ...createScene('weekend'), id: sceneId }, revision: 0 },
  });

  const cross = await jsonFetch(base, `/api/projects/${project.id}/scenes`, {
    method: 'POST',
    cookie: alice,
    body: { sceneId },
  });
  assert.equal(cross.res.status, 404);
  assert.equal(cross.data.error.code, 'not_found');
});

/* ------------------------------------------------------------------ */
/* Batch enqueue validation, snapshots and idempotency                 */
/* ------------------------------------------------------------------ */

test('batch enqueue validates prompt/platform bounds and is idempotent per key', async () => {
  const { base } = await makeApp({ agent: { chatProvider: generatedProvider(), limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);

  const empty = await enqueue(base, cookie, project.id, { prompts: ['  ', ''] });
  assert.equal(empty.res.status, 400);
  assert.equal(empty.data.error.code, 'invalid_prompts');

  const tooMany = await enqueue(base, cookie, project.id, {
    prompts: Array.from({ length: 11 }, (_v, i) => `提示 ${i}`),
  });
  assert.equal(tooMany.res.status, 400);
  assert.equal(tooMany.data.error.code, 'invalid_prompts');

  const tooBig = await enqueue(base, cookie, project.id, {
    prompts: Array.from({ length: 6 }, (_v, i) => `提示 ${i}`),
    platforms: ['wechat', 'xiaohongshu', 'imessage', 'whatsapp'],
  });
  assert.equal(tooBig.res.status, 400);
  assert.equal(tooBig.data.error.code, 'invalid_batch_size');

  const badPlatform = await enqueue(base, cookie, project.id, {
    prompts: ['一句话'],
    platforms: ['myspace'],
  });
  assert.equal(badPlatform.res.status, 400);
  assert.equal(badPlatform.data.error.code, 'invalid_platforms');

  const first = await enqueue(base, cookie, project.id, {
    prompts: ['第一段对话', '第二段对话'],
    platforms: ['wechat', 'xiaohongshu'],
    clientBatchId: 'batch-key-1',
  });
  assert.equal(first.res.status, 200);
  assert.equal(first.data.item.total, 4);
  assert.equal(first.data.deduplicated, false);

  const replay = await enqueue(base, cookie, project.id, {
    prompts: ['不同内容', '也不一样'],
    platforms: ['slack'],
    clientBatchId: 'batch-key-1',
  });
  assert.equal(replay.res.status, 200);
  assert.equal(replay.data.deduplicated, true);
  assert.equal(replay.data.item.id, first.data.item.id);
  assert.equal(replay.data.item.total, 4);

  const count = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs`, { cookie });
  assert.equal(count.data.items.length, 1);

  // The full task list is persisted for status reads.
  const detail = await getJob(base, cookie, project.id, first.data.item.id);
  assert.equal(detail.data.item.tasks.length, 4);
  assert.deepEqual(
    [...new Set(detail.data.item.tasks.map((task) => task.platform))].sort(),
    ['wechat', 'xiaohongshu'],
  );
});

test('batch generation snapshots project rules at enqueue', async () => {
  const provider = gatedProvider([
    toolResponse('create_scene', { scene: { ...createScene('weekend'), title: '快照作品' } }),
    finalResponse('完成'),
  ]);
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie, { rules: '规则版本一' });

  const { res, data } = await enqueue(base, cookie, project.id, {
    prompts: ['生成一段对话'],
    platforms: ['wechat'],
  });
  assert.equal(res.status, 200);

  // Wait until the worker started the first provider call, then change rules.
  await waitFor(() => provider.calls.length >= 1);
  const changed = await jsonFetch(base, `/api/projects/${project.id}`, {
    method: 'PUT',
    cookie,
    body: { rules: '规则版本二', revision: 1 },
  });
  assert.equal(changed.res.status, 200);

  const detail = await getJob(base, cookie, project.id, data.item.id);
  assert.equal(detail.data.item.rules, '规则版本一');

  provider.release();
  const finished = await waitForJobStatus(base, cookie, project.id, data.item.id, ['done', 'failed', 'partial']);
  assert.equal(finished.status, 'done');

  const context = JSON.stringify(provider.calls[0]);
  assert.match(context, /规则版本一/);
  assert.doesNotMatch(context, /规则版本二/);
  assert.match(context, /项目规则/);
});

/* ------------------------------------------------------------------ */
/* Batch success, failure and cancellation                             */
/* ------------------------------------------------------------------ */

test('successful batch tasks publish brand-new scenes attached to the project', async () => {
  const provider = generatedProvider('批量生成的作品');
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);

  const { data } = await enqueue(base, cookie, project.id, {
    prompts: ['生成一段海边的对话'],
    platforms: ['wechat'],
  });
  const finished = await waitForJobStatus(base, cookie, project.id, data.item.id, ['done']);
  assert.equal(finished.succeeded, 1);
  assert.equal(finished.failed, 0);

  const task = finished.tasks[0];
  assert.equal(task.status, 'done');
  assert.ok(task.sceneId, 'task must expose the generated scene id');

  const scene = await jsonFetch(base, `/api/scenes/${task.sceneId}`, { cookie });
  assert.equal(scene.res.status, 200);
  assert.equal(scene.data.item.scene.title, '批量生成的作品');

  const scenes = await jsonFetch(base, `/api/projects/${project.id}`, { cookie });
  assert.equal(scenes.data.scenes.length, 1);
  assert.equal(scenes.data.scenes[0].id, task.sceneId);
});

test('a failed tool never publishes a scene and is reported as failed', async () => {
  const provider = scriptedProvider([
    toolResponse('delete_message', { id: 'does-not-exist' }, { id: 'bad-tool' }),
    finalResponse('没能完成'),
  ]);
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);

  const { data } = await enqueue(base, cookie, project.id, {
    prompts: ['删除一条不存在的消息'],
    platforms: ['wechat'],
  });
  const finished = await waitForJobStatus(base, cookie, project.id, data.item.id, ['failed', 'partial']);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.succeeded, 0);
  assert.equal(finished.failed, 1);

  const task = finished.tasks[0];
  assert.equal(task.status, 'failed');
  assert.equal(task.sceneId !== null, true);
  const scene = await jsonFetch(base, `/api/scenes/${task.sceneId}`, { cookie });
  assert.equal(scene.res.status, 404, 'a failed task must not have published a scene');

  const scenes = await jsonFetch(base, `/api/projects/${project.id}`, { cookie });
  assert.equal(scenes.data.scenes.length, 0);
});

test('cancelling a running batch aborts it and publishes nothing', async () => {
  const provider = gatedProvider([
    toolResponse('create_scene', { scene: createScene('weekend') }),
    finalResponse('完成'),
  ]);
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);

  const { data } = await enqueue(base, cookie, project.id, {
    prompts: ['生成对话一', '生成对话二'],
    platforms: ['wechat'],
  });
  await waitFor(async () => {
    const job = await getJob(base, cookie, project.id, data.item.id);
    return job.data.item.status === 'running';
  });

  const cancelled = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs/${data.item.id}/cancel`, {
    method: 'POST',
    cookie,
    body: {},
  });
  assert.equal(cancelled.res.status, 200);

  const finished = await waitForJobStatus(base, cookie, project.id, data.item.id, ['cancelled']);
  assert.equal(finished.status, 'cancelled');
  assert.ok(finished.tasks.every((task) => task.status !== 'done'));

  const scenes = await jsonFetch(base, `/api/projects/${project.id}`, { cookie });
  assert.equal(scenes.data.scenes.length, 0);
});

test('a revoked session cancels the active batch job', async () => {
  const provider = gatedProvider([
    toolResponse('create_scene', { scene: createScene('weekend') }),
    finalResponse('完成'),
  ]);
  const { app, base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);
  const session = await jsonFetch(base, '/api/auth/session', { cookie });
  const userId = session.data.user.id;

  const { data } = await enqueue(base, cookie, project.id, {
    prompts: ['生成对话'],
    platforms: ['wechat'],
  });
  await waitFor(() => app.db.prepare("SELECT status FROM batch_jobs WHERE id = ?").get(data.item.id)?.status === 'running');

  // Revoke the session directly (equivalent to logout deleting the row).
  app.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

  await waitFor(() => {
    const row = app.db.prepare('SELECT status FROM batch_jobs WHERE id = ?').get(data.item.id);
    return row?.status === 'cancelled';
  });
  const scenes = app.db.prepare('SELECT COUNT(*) AS total FROM scenes WHERE user_id = ?').get(userId);
  assert.equal(Number(scenes.total), 0);
});

/* ------------------------------------------------------------------ */
/* Retry and restart                                                   */
/* ------------------------------------------------------------------ */

test('explicit retry re-runs only failed tasks with a fresh idempotent job', async () => {
  const provider = scriptedProvider([
    toolResponse('delete_message', { id: 'nope' }, { id: 'bad' }),
    finalResponse('失败一次'),
  ]);
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);

  const { data } = await enqueue(base, cookie, project.id, {
    prompts: ['第一次失败'],
    platforms: ['wechat'],
  });
  await waitForJobStatus(base, cookie, project.id, data.item.id, ['failed']);

  const retry = await jsonFetch(base, `/api/projects/${project.id}/batch-jobs/${data.item.id}/retry`, {
    method: 'POST',
    cookie,
    body: {},
  });
  assert.equal(retry.res.status, 200);
  assert.notEqual(retry.data.item.id, data.item.id);
  assert.equal(retry.data.item.total, 1);

  const retried = await waitForJobStatus(base, cookie, project.id, retry.data.item.id, ['failed']);
  assert.equal(retried.failed, 1);
});

test('restart recovery marks pending jobs interrupted without false success', async () => {
  const provider = gatedProvider([
    toolResponse('create_scene', { scene: createScene('weekend') }),
    finalResponse('完成'),
  ]);
  const { app, base, dbPath } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);

  const { data } = await enqueue(base, cookie, project.id, {
    prompts: ['生成对话'],
    platforms: ['wechat'],
  });
  await waitFor(async () => {
    const job = await getJob(base, cookie, project.id, data.item.id);
    return job.data.item.status === 'running';
  });

  await app.close();
  activeApps.delete(app);

  // Simulate crash residue: the job never reached a terminal state.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`UPDATE batch_jobs SET status = 'running' WHERE id = '${data.item.id}'`);
  raw.exec(`UPDATE batch_tasks SET status = 'running' WHERE job_id = '${data.item.id}'`);
  raw.close();

  const reopened = await makeApp({ agent: { chatProvider: generatedProvider(), limits: highLimits }, dbPath });
  const cookie2 = await register(reopened.base);
  const crossJob = await jsonFetch(
    reopened.base,
    `/api/projects/${project.id}/batch-jobs/${data.item.id}`,
    { cookie: cookie2 },
  );
  assert.equal(crossJob.res.status, 404, 'another account must not read the old job');

  const row = reopened.app.db
    .prepare('SELECT status, succeeded FROM batch_jobs WHERE id = ?')
    .get(data.item.id);
  assert.equal(row.status, 'interrupted');
  assert.equal(Number(row.succeeded), 0);

  const task = reopened.app.db
    .prepare('SELECT status FROM batch_tasks WHERE job_id = ?')
    .get(data.item.id);
  assert.equal(task.status, 'interrupted');

  const scenes = reopened.app.db
    .prepare('SELECT COUNT(*) AS total FROM scenes WHERE user_id = (SELECT user_id FROM batch_jobs WHERE id = ?)')
    .get(data.item.id);
  assert.equal(Number(scenes.total), 0);
});

test('markInterruptedJobs is idempotent and leaves terminal jobs untouched', async () => {
  const { app } = await makeApp({ agent: { chatProvider: generatedProvider(), limits: highLimits } });
  const userId = crypto.randomUUID();
  app.db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
    userId,
    uniqueEmail(),
    '恢复用户',
    'scrypt$1$1$1$AAAA$BBBB',
    new Date().toISOString(),
  );
  app.db.prepare(
    `INSERT INTO batch_jobs (id, user_id, project_id, status, rules, total, created_at, updated_at)
     VALUES ('11111111-1111-4111-8111-111111111111', ?, 'p', 'queued', '', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
  ).run(userId);
  app.db.prepare(
    `INSERT INTO batch_jobs (id, user_id, project_id, status, rules, total, created_at, updated_at)
     VALUES ('22222222-2222-4222-8222-222222222222', ?, 'p', 'done', '', 1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
  ).run(userId);

  const first = markInterruptedJobs(app.db, Date.now());
  assert.equal(first.jobs, 1);
  const second = markInterruptedJobs(app.db, Date.now());
  assert.equal(second.jobs, 0);

  const queued = app.db.prepare("SELECT status FROM batch_jobs WHERE id = '11111111-1111-4111-8111-111111111111'").get();
  assert.equal(queued.status, 'interrupted');
  const done = app.db.prepare("SELECT status FROM batch_jobs WHERE id = '22222222-2222-4222-8222-222222222222'").get();
  assert.equal(done.status, 'done');
});

/* ------------------------------------------------------------------ */
/* Normal Agent project-rule integration                               */
/* ------------------------------------------------------------------ */

test('agent runs honor an owned projectId rule snapshot and reject cross-account projects', async () => {
  const provider = scriptedProvider([
    toolResponse('upsert_message', {
      message: { id: 'm-4', participantId: 'p-ayuan', type: 'text', text: '带规则的修改', time: '09:41' },
    }),
    finalResponse('完成'),
  ]);
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const alice = await register(base);
  const bob = await register(base);
  const project = await createProject(base, alice, { rules: '只用中文，语气克制' });

  const scene = createScene('weekend');
  const runBody = { prompt: '把最后一句改得更轻松一点', scene, projectId: project.id };
  const runRes = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(alice),
    body: JSON.stringify(runBody),
  });
  assert.equal(runRes.status, 200);
  await runRes.text();
  assert.match(JSON.stringify(provider.calls[0]), /只用中文，语气克制/);
  assert.match(JSON.stringify(provider.calls[0]), /项目规则/);

  // Another account's project id must not load any rules.
  const cross = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(bob),
    body: JSON.stringify({ ...runBody, projectId: project.id }),
  });
  assert.equal(cross.status, 404);
  assert.equal((await cross.json()).error.code, 'not_found');

  // Prompt length validation still applies before rules are appended.
  const tooLong = await fetch(`${base}/api/agent/run`, {
    method: 'POST',
    headers: mutationHeaders(alice),
    body: JSON.stringify({ ...runBody, prompt: 'x'.repeat(4001) }),
  });
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).error.code, 'invalid_prompt');
});

test('batch enqueue is rejected when the AI service is not configured', async () => {
  const { base } = await makeApp({});
  const cookie = await register(base);
  const project = await createProject(base, cookie);

  const { res, data } = await enqueue(base, cookie, project.id, {
    prompts: ['生成对话'],
    platforms: ['wechat'],
  });
  assert.equal(res.status, 503);
  assert.equal(data.error.code, 'ai_not_configured');
});

/* Review regressions: cancellation between awaits and durable publication. */
function reviewDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,expires_at_ms INTEGER);
    CREATE TABLE scenes(user_id TEXT,id TEXT,title TEXT,platform TEXT,message_count INTEGER,
      revision INTEGER,scene_json TEXT,updated_at TEXT,PRIMARY KEY(user_id,id));
    INSERT INTO users VALUES('review-user');
    INSERT INTO sessions VALUES('review-session','review-user',9999999999999);`);
  db.exec(projectStore.PROJECT_SCHEMA_SQL);
  projectStore.createProject(db, { userId: 'review-user', projectId: 'review-project',
    name: 'Review', rules: '', platform: 'wechat', nowMs: Date.now() });
  return db;
}

function reviewJob(db) {
  return projectStore.createBatchJob(db, { userId: 'review-user', projectId: 'review-project',
    sessionId: 'review-session', rules: '', tasks: [{ prompt: '生成对话', platform: 'wechat' }],
    clientBatchId: crypto.randomUUID(), nowMs: Date.now() });
}

test('cancel while waiting for a lease never starts a paid run', async () => {
  const db = reviewDatabase();
  const job = reviewJob(db);
  let attempts = 0;
  let calls = 0;
  const queue = projectStore.createBatchQueue({ db, nowMs: Date.now, pollMs: 10,
    sessionCheckMs: 2000, maxLeaseWaitMs: 500,
    agent: {
      limiter: { tryStart() {
        attempts += 1;
        return attempts === 1 ? { ok: false, retryAfterMs: 100 } : { ok: true, release() {} };
      } },
      runtime: { async run() { calls += 1; return { ok: true, scene: createScene('weekend') }; } },
    } });
  queue.start();
  try {
    await waitFor(() => attempts > 0);
    projectStore.markJobCancelRequested(db, { userId: 'review-user', projectId: 'review-project',
      jobId: job.id, reason: 'User cancelled', nowMs: Date.now() });
    queue.cancel(job.id);
    await waitFor(() => projectStore.getJobDetailById(db, 'review-user', job.id)?.status === 'cancelled');
    assert.equal(calls, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scenes').get().n, 0);
  } finally { await queue.stop(); db.close(); }
});

test('session revoked before the watcher ticks prevents publishing a finished run', async () => {
  const db = reviewDatabase();
  const job = reviewJob(db);
  const queue = projectStore.createBatchQueue({ db, nowMs: Date.now, pollMs: 10,
    sessionCheckMs: 2000,
    agent: {
      limiter: { tryStart() { return { ok: true, release() {} }; } },
      runtime: { async run() {
        db.prepare('DELETE FROM sessions WHERE id=?').run('review-session');
        return { ok: true, scene: createScene('weekend') };
      } },
    } });
  queue.start();
  try {
    await waitFor(() => projectStore.getJobDetailById(db, 'review-user', job.id)?.status === 'cancelled');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scenes').get().n, 0);
  } finally { await queue.stop(); db.close(); }
});

test('a successful scene mutation followed by failed image generation is not batch success', async () => {
  const scene = createScene('weekend');
  scene.messages = [{ id: 'missing-image', participantId: scene.selfId, type: 'image', text: '美食', time: '09:41' }];
  const provider = scriptedProvider([
    toolResponse('create_scene', { scene }),
    toolResponse('generate_image', { targetId: 'missing-image', kind: 'message', prompt: '美食照片' }),
    finalResponse('图片服务不可用，保留部分内容'),
  ]);
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);
  const { data } = await enqueue(base, cookie, project.id, { prompts: ['生成带美食图片的对话'] });
  const finished = await waitForJobStatus(base, cookie, project.id, data.item.id, ['failed', 'done']);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.tasks[0].errorCode, 'image_tools_failed');
  const saved = await jsonFetch(base, `/api/projects/${project.id}`, { cookie });
  assert.equal(saved.data.scenes.length, 0);
});

test('concurrent retries of one failed batch return one job', async () => {
  const provider = scriptedProvider([finalResponse('没有修改')]);
  const { base, app } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);
  const { data } = await enqueue(base, cookie, project.id, { prompts: ['生成对话'] });
  await waitForJobStatus(base, cookie, project.id, data.item.id, ['failed']);
  const retry = () => jsonFetch(base, `/api/projects/${project.id}/batch-jobs/${data.item.id}/retry`,
    { method: 'POST', cookie, body: {} });
  const [first, second] = await Promise.all([retry(), retry()]);
  assert.equal(first.res.status, 200);
  assert.equal(second.res.status, 200);
  assert.equal(first.data.item.id, second.data.item.id);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM batch_jobs WHERE project_id=?').get(project.id).n, 2);
});

test('scene publication and task completion roll back together on a task write failure', () => {
  const db = reviewDatabase();
  try {
    const job = reviewJob(db);
    const task = job.tasks[0];
    const scene = { ...createScene('weekend'), id: task.sceneId };
    db.exec(`CREATE TRIGGER fail_task_completion BEFORE UPDATE OF status ON batch_tasks
      WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'injected task completion failure'); END;`);
    assert.throws(() => projectStore.publishGeneratedScene(db, { userId: 'review-user',
      projectId: 'review-project', scene, taskId: task.id, nowMs: Date.now() }), /injected/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scenes').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scene_projects').get().n, 0);
    assert.equal(projectStore.listJobTasks(db, job.id)[0].status, 'queued');
    db.exec('DROP TRIGGER fail_task_completion');
    projectStore.publishGeneratedScene(db, { userId: 'review-user', projectId: 'review-project',
      scene, taskId: task.id, nowMs: Date.now() });
    markInterruptedJobs(db, Date.now());
    assert.equal(projectStore.listJobTasks(db, job.id)[0].status, 'done');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scenes').get().n, 1);
    assert.throws(() => projectStore.createRetryJob(db, { userId: 'review-user', projectId: 'review-project',
      jobId: job.id, sessionId: 'review-session', nowMs: Date.now() }), /没有需要重试/);
  } finally { db.close(); }
});

test('ordinary scene save associates the owned project and rejects another account project atomically', async () => {
  const { base } = await makeApp({});
  const alice = await register(base);
  const bob = await register(base);
  const own = await createProject(base, alice);
  const foreign = await createProject(base, bob);
  const scene = { ...createScene('weekend'), id: crypto.randomUUID() };
  const saved = await jsonFetch(base, `/api/scenes/${scene.id}`, { method: 'PUT', cookie: alice,
    body: { scene, revision: 0, projectId: own.id } });
  assert.equal(saved.res.status, 200);
  const loaded = await jsonFetch(base, `/api/scenes/${scene.id}`, { cookie: alice });
  assert.deepEqual(loaded.data.item.projectIds, [own.id]);
  const cross = await jsonFetch(base, `/api/scenes/${scene.id}`, { method: 'PUT', cookie: alice,
    body: { scene: { ...scene, title: 'Must not persist' }, revision: 1, projectId: foreign.id } });
  assert.equal(cross.res.status, 404);
  const unchanged = await jsonFetch(base, `/api/scenes/${scene.id}`, { cookie: alice });
  assert.equal(unchanged.data.item.scene.title, scene.title);
  assert.equal(unchanged.data.item.revision, 1);
  assert.deepEqual(unchanged.data.item.projectIds, [own.id]);
});

test('ordinary save can move a scene to another project and explicitly detach it', async () => {
  const { base } = await makeApp({});
  const cookie = await register(base);
  const first = await createProject(base, cookie, { name: 'First' });
  const second = await createProject(base, cookie, { name: 'Second' });
  const scene = { ...createScene('weekend'), id: crypto.randomUUID() };
  const put = (revision, projectId) => jsonFetch(base, `/api/scenes/${scene.id}`, {
    method: 'PUT', cookie, body: { scene, revision, projectId },
  });
  assert.equal((await put(0, first.id)).res.status, 200);
  assert.equal((await put(1, second.id)).res.status, 200);
  assert.deepEqual((await jsonFetch(base, `/api/scenes/${scene.id}`, { cookie })).data.item.projectIds, [second.id]);
  assert.equal((await jsonFetch(base, `/api/projects/${first.id}`, { cookie })).data.scenes.length, 0);
  assert.equal((await put(2, '')).res.status, 200);
  assert.deepEqual((await jsonFetch(base, `/api/scenes/${scene.id}`, { cookie })).data.item.projectIds, []);
});

test('attaching a scene already in another project never reports a false success', async () => {
  const { base } = await makeApp({});
  const cookie = await register(base);
  const first = await createProject(base, cookie, { name: 'First' });
  const second = await createProject(base, cookie, { name: 'Second' });
  const scene = { ...createScene('weekend'), id: crypto.randomUUID() };
  const saved = await jsonFetch(base, `/api/scenes/${scene.id}`, { method: 'PUT', cookie,
    body: { scene, revision: 0, projectId: first.id } });
  assert.equal(saved.res.status, 200);
  const attached = await jsonFetch(base, `/api/projects/${second.id}/scenes`, {
    method: 'POST', cookie, body: { sceneId: scene.id },
  });
  assert.ok([200, 409].includes(attached.res.status));
  const loaded = await jsonFetch(base, `/api/projects/${second.id}`, { cookie });
  if (attached.res.status === 200) {
    assert.ok(loaded.data.scenes.some(item => item.id === scene.id), 'successful attach must actually associate the destination project');
  } else {
    assert.deepEqual((await jsonFetch(base, `/api/scenes/${scene.id}`, { cookie })).data.item.projectIds, [first.id]);
  }
});

test('project detach HTTP endpoint removes the association and preserves the scene', async () => {
  const { base } = await makeApp({});
  const cookie = await register(base);
  const project = await createProject(base, cookie);
  const scene = { ...createScene('weekend'), id: crypto.randomUUID() };
  const saved = await jsonFetch(base, `/api/scenes/${scene.id}`, { method: 'PUT', cookie,
    body: { scene, revision: 0, projectId: project.id } });
  assert.equal(saved.res.status, 200);
  const endpoint = `/api/projects/${project.id}/scenes/${scene.id}`;
  const detached = await jsonFetch(base, endpoint, { method: 'DELETE', cookie, body: {} });
  assert.equal(detached.res.status, 200);
  assert.equal(detached.data.detached, true);
  const projectAfter = await jsonFetch(base, `/api/projects/${project.id}`, { cookie });
  assert.equal(projectAfter.data.scenes.length, 0);
  assert.equal(projectAfter.data.item.sceneCount, 0);
  const sceneAfter = await jsonFetch(base, `/api/scenes/${scene.id}`, { cookie });
  assert.equal(sceneAfter.res.status, 200);
  assert.equal(sceneAfter.data.item.scene.title, scene.title);
  assert.equal(sceneAfter.data.item.revision, 1);
  assert.deepEqual(sceneAfter.data.item.projectIds, []);
  const repeated = await jsonFetch(base, endpoint, { method: 'DELETE', cookie, body: {} });
  assert.equal(repeated.res.status, 200);
  assert.equal(repeated.data.detached, false);
});

/* ------------------------------------------------------------------ */
/* Structured variants and frozen templates                            */
/* ------------------------------------------------------------------ */

test('batch input rejects ambiguous legacy/new mixing and validates variants', () => {
  const legacy = { prompts: ['one'] };
  const variants = { variants: [{ name: 'A', prompt: 'one' }] };
  assert.throws(() => projectStore.buildBatchTasks({ ...legacy, ...variants }, 'wechat'), (error) => error.code === 'ambiguous_batch_input');
  assert.equal(projectStore.buildBatchTasks(variants, 'wechat').length, 1);
  assert.throws(() => projectStore.buildBatchTasks({ variants: [] }, 'wechat'), (error) => error.code === 'invalid_variants');
  assert.throws(() => projectStore.buildBatchTasks({ variants: Array.from({ length: 11 }, (_, i) => ({ name: `v${i}`, prompt: 'p' })) }, 'wechat'), (error) => error.code === 'invalid_variants');
  assert.throws(() => projectStore.buildBatchTasks({ variants: [{ name: '', prompt: 'p' }] }, 'wechat'), (error) => error.code === 'invalid_variants');
  assert.throws(() => projectStore.buildBatchTasks({ variants: [{ name: 'a', prompt: '' }] }, 'wechat'), (error) => error.code === 'invalid_variants');
  assert.throws(() => projectStore.buildBatchTasks({ variants: [{ name: 'a', prompt: 'p', values: { Bad_Key: 'x' } }] }, 'wechat'), (error) => error.code === 'invalid_variant_values');
  assert.throws(() => projectStore.buildBatchTasks({ variants: [{ name: 'a', prompt: 'p', values: { key: 5 } }] }, 'wechat'), (error) => error.code === 'invalid_variant_values');
  const expanded = projectStore.buildBatchTasks({ variants: [{ name: 'a', prompt: 'p', values: { key: 'v' } }], platforms: ['wechat', 'slack'] }, 'wechat');
  assert.equal(expanded.length, 2);
  assert.deepEqual(expanded[0].values, { key: 'v' });
  // Legacy task shape stays backward compatible.
  const plain = projectStore.buildBatchTasks({ promptsText: 'one\ntwo' }, 'wechat');
  assert.equal(plain[0].name, '');
  assert.deepEqual(plain[0].values, {});
});

test('frozen variant values and template snapshot survive template deletion', async () => {
  const provider = (() => {
    const calls = [];
    let index = 0;
    return {
      calls,
      async complete({ messages, signal }) {
        calls.push(JSON.parse(JSON.stringify(messages)));
        if (signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
        const step = index % 2 === 0
          ? toolResponse('create_scene', { scene: { ...createScene('weekend'), title: `变体作品 ${Math.floor(index / 2) + 1}` } }, { id: `call-${index}` })
          : finalResponse('已生成。');
        index += 1;
        return step;
      },
    };
  })();
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie, { name: '变体项目', platform: 'wechat' });

  const scene = { ...createScene('weekend'), id: 'variant-template-source' };
  const template = await jsonFetch(base, '/api/templates', {
    method: 'POST',
    cookie,
    body: {
      name: '变体模板',
      description: '',
      scene,
      variables: [{ key: 'name', label: 'Person', type: 'text', target: { entity: 'participant', id: scene.participants[1].id, field: 'name' } }],
    },
  });
  assert.equal(template.res.status, 200, JSON.stringify(template.data));

  const enqueued = await enqueue(base, cookie, project.id, {
    variants: [
      { name: 'Ava', prompt: '生成 Ava 的对话', values: { name: 'Ava' } },
      { name: 'Noah', prompt: '生成 Noah 的对话', values: { name: 'Noah' } },
    ],
    templateId: template.data.item.id,
    templateRevision: template.data.item.revision,
    clientBatchId: crypto.randomUUID(),
  });
  assert.equal(enqueued.res.status, 200, JSON.stringify(enqueued.data));
  assert.equal(enqueued.data.item.total, 2);
  assert.equal(enqueued.data.item.templateId, template.data.item.id);
  assert.equal(enqueued.data.item.templateRevision, 1);
  assert.equal(enqueued.data.item.tasks[0].name, 'Ava');
  assert.deepEqual(enqueued.data.item.tasks[0].values, { name: 'Ava' });

  // Deleting the template after enqueue must not change the queued work.
  assert.equal((await jsonFetch(base, `/api/templates/${template.data.item.id}`, { method: 'DELETE', cookie, body: { revision: 1 } })).res.status, 200);

  const done = await waitForJobStatus(base, cookie, project.id, enqueued.data.item.id, ['done', 'partial', 'failed']);
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(done.tasks.filter((task) => task.sceneId).length, 2);
  assert.notEqual(done.tasks[0].sceneId, done.tasks[1].sceneId);
  const context = JSON.stringify(provider.calls);
  assert.ok(context.includes('Ava'), 'frozen template values reach the agent context');
  assert.ok(context.includes('Noah'), 'each independent item uses its own values');
});

test('batch rejects values without a template, a stale template revision and ambiguous input', async () => {
  const { base } = await makeApp({ agent: { chatProvider: generatedProvider(), limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);
  const scene = { ...createScene('weekend'), id: 'revision-template-source' };
  const template = await jsonFetch(base, '/api/templates', {
    method: 'POST', cookie,
    body: { name: '修订模板', description: '', scene, variables: [{ key: 'name', label: 'Person', type: 'text', target: { entity: 'participant', id: scene.participants[1].id, field: 'name' } }] },
  });
  assert.equal(template.res.status, 200);

  const ambiguous = await enqueue(base, cookie, project.id, { prompts: ['p'], variants: [{ name: 'a', prompt: 'p' }] });
  assert.equal(ambiguous.res.status, 400);
  assert.equal(ambiguous.data.error.code, 'ambiguous_batch_input');

  const orphanValues = await enqueue(base, cookie, project.id, { variants: [{ name: 'a', prompt: 'p', values: { name: 'x' } }] });
  assert.equal(orphanValues.res.status, 400);
  assert.equal(orphanValues.data.error.code, 'invalid_variants');

  const stale = await enqueue(base, cookie, project.id, { variants: [{ name: 'a', prompt: 'p' }], templateId: template.data.item.id, templateRevision: 99 });
  assert.equal(stale.res.status, 409);
  assert.equal(stale.data.error.code, 'revision_conflict');

  const badValues = await enqueue(base, cookie, project.id, { variants: [{ name: 'a', prompt: 'p', values: { unlisted: 'x' } }], templateId: template.data.item.id, templateRevision: 1 });
  assert.equal(badValues.res.status, 400);
  assert.equal(badValues.data.error.code, 'invalid_values');
});

/* ------------------------------------------------------------------ */
/* Frozen-job retries and reference-template platforms                 */
/* ------------------------------------------------------------------ */

function countingProvider() {
  const calls = [];
  let index = 0;
  return {
    calls,
    get callCount() { return calls.length; },
    async complete({ messages, signal }) {
      calls.push(JSON.parse(JSON.stringify(messages)));
      if (signal?.aborted) { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }
      const step = index % 2 === 0
        ? toolResponse('create_scene', { scene: { ...createScene('weekend'), title: `作品 ${Math.floor(index / 2) + 1}` } }, { id: `call-${index}` })
        : finalResponse('已生成。');
      index += 1;
      return step;
    },
  };
}

test('same-key retry recovers the frozen job after the template is updated and deleted', async () => {
  const provider = countingProvider();
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);
  const scene = { ...createScene('weekend'), id: 'frozen-retry-source' };
  const template = await jsonFetch(base, '/api/templates', {
    method: 'POST', cookie,
    body: { name: '冻结模板', description: '', scene, variables: [] },
  });
  assert.equal(template.res.status, 200);
  const templateId = template.data.item.id;
  const body = { prompts: ['生成一段对话'], templateId, templateRevision: 1, clientBatchId: 'frozen-retry-key' };

  const enqueued = await enqueue(base, cookie, project.id, body);
  assert.equal(enqueued.res.status, 200, JSON.stringify(enqueued.data));
  const jobId = enqueued.data.item.id;
  await waitForJobStatus(base, cookie, project.id, jobId, ['done', 'partial', 'failed']);
  const callsAfterFirst = provider.callCount;
  assert.ok(callsAfterFirst > 0);

  const updated = await jsonFetch(base, `/api/templates/${templateId}`, {
    method: 'PUT', cookie, body: { revision: 1, ...template.data.item.definition, name: '改名后的模板' },
  });
  assert.equal(updated.res.status, 200);
  assert.equal((await jsonFetch(base, `/api/templates/${templateId}`, { method: 'DELETE', cookie, body: { revision: 2 } })).res.status, 200);

  // The retry must recover the original frozen job, not re-validate the now
  // missing/updated template and not start another provider run.
  const replay = await enqueue(base, cookie, project.id, body);
  assert.equal(replay.res.status, 200, JSON.stringify(replay.data));
  assert.equal(replay.data.deduplicated, true);
  assert.equal(replay.data.item.id, jobId);
  assert.equal(provider.callCount, callsAfterFirst, 'no new provider run for an idempotent retry');

  // A genuinely new key still validates the current template and fails 404.
  const fresh = await enqueue(base, cookie, project.id, { ...body, clientBatchId: 'frozen-retry-new-key' });
  assert.equal(fresh.res.status, 404);
});

test('screenshot-reference templates reject other platforms before enqueue', async () => {
  const provider = countingProvider();
  const { base } = await makeApp({ agent: { chatProvider: provider, limits: highLimits } });
  const cookie = await register(base);
  const project = await createProject(base, cookie);
  const { default: sharp } = await import('sharp');
  const sourcePng = await sharp({ create: { width: 600, height: 900, channels: 3, background: '#ededed' } }).png().toBuffer();
  const image = `data:image/png;base64,${sourcePng.toString('base64')}`;
  const scene = {
    ...createScene('weekend'),
    id: 'reference-platform-source',
    platform: 'wechat',
    reference: {
      source: image,
      assets: [],
      plan: {
        schemaVersion: 1, im: 'wechat', surface: 'ios', width: 600, height: 900, warnings: [],
        edits: [{ id: 'words', kind: 'text', text: '原图文字', box: [100, 400, 600, 100], fontSize: 16, background: '#ffffff', color: '#000000' }],
      },
    },
  };
  const template = await jsonFetch(base, '/api/templates', {
    method: 'POST', cookie,
    body: { name: '截图模板', description: '', scene, variables: [] },
  });
  assert.equal(template.res.status, 200, JSON.stringify(template.data));
  assert.equal(template.data.item.mode, 'reference');

  const rejected = await enqueue(base, cookie, project.id, {
    prompts: ['生成'], platforms: ['slack'], templateId: template.data.item.id, templateRevision: 1, clientBatchId: crypto.randomUUID(),
  });
  assert.equal(rejected.res.status, 400);
  assert.equal(rejected.data.error.code, 'reference_platform_mismatch');

  const accepted = await enqueue(base, cookie, project.id, {
    prompts: ['生成'], platforms: ['wechat'], templateId: template.data.item.id, templateRevision: 1, clientBatchId: crypto.randomUUID(),
  });
  assert.equal(accepted.res.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.item.templateId, template.data.item.id);
  assert.equal(accepted.data.item.tasks[0].platform, 'wechat');
});

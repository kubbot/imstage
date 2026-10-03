/**
 * IMStage Projects — SQLite persistence.
 *
 * Owns the `projects`, `scene_projects`, `batch_jobs` and `batch_tasks` tables.
 * Scene ownership and revisions stay in the existing `scenes` table; deleting a
 * project only removes the association rows, never the scenes themselves.
 *
 * Every function takes the open `DatabaseSync` handle explicitly so the HTTP
 * layer and the background worker share one connection and one transaction
 * discipline.
 */

import crypto from 'node:crypto';

import { assertSceneCapacity, installSceneReservations, releaseGenerationReservations, releaseProjectReservations } from './capacity.mjs';
import { projectsError, isTerminalJobStatus } from './errors.mjs';
import { MAX_PROJECTS_PER_USER, MAX_SCENES_PER_USER } from './model.mjs';
import { withTransaction } from './txn.mjs';

export const PROJECT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS projects (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    rules      TEXT NOT NULL DEFAULT '',
    platform   TEXT NOT NULL DEFAULT 'wechat',
    watermark_enabled INTEGER NOT NULL DEFAULT 1,
    type       TEXT NOT NULL DEFAULT 'custom',
    recipe_version INTEGER NOT NULL DEFAULT 1,
    brief_json TEXT NOT NULL DEFAULT '{}',
    revision   INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_projects_user_updated ON projects(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS scene_projects (
    user_id    TEXT NOT NULL,
    scene_id   TEXT NOT NULL,
    project_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, scene_id),
    FOREIGN KEY (user_id, scene_id) REFERENCES scenes(user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_scene_projects_project ON scene_projects(user_id, project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS batch_jobs (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id       TEXT NOT NULL,
    generation_id    TEXT,
    session_id       TEXT,
    client_batch_id  TEXT,
    status           TEXT NOT NULL,
    not_before       TEXT,
    rules            TEXT NOT NULL DEFAULT '',
    watermark_enabled INTEGER NOT NULL DEFAULT 1,
    template_id      TEXT,
    template_revision INTEGER,
    template_json    TEXT,
    reason           TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    total            INTEGER NOT NULL,
    succeeded        INTEGER NOT NULL DEFAULT 0,
    failed           INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batch_jobs_project ON batch_jobs(user_id, project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_jobs_client
    ON batch_jobs(user_id, project_id, client_batch_id)
    WHERE client_batch_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS batch_tasks (
    id         TEXT PRIMARY KEY,
    job_id     TEXT NOT NULL REFERENCES batch_jobs(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ordinal    INTEGER NOT NULL,
    prompt     TEXT NOT NULL,
    platform   TEXT NOT NULL,
    variant_name TEXT,
    values_json TEXT,
    scenario_id TEXT,
    item_key    TEXT,
    generation_id TEXT,
    attempt     INTEGER,
    reservation_id TEXT,
    status     TEXT NOT NULL,
    scene_id   TEXT,
    error      TEXT,
    error_code TEXT,
    detail     TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_batch_tasks_job ON batch_tasks(job_id, ordinal);
`;

/**
 * Install the project/batch tables and apply additive column migrations.
 * Existing rows and scenes are never rewritten or deleted; a legacy database
 * simply gains NULL template/variant columns and a watermark column defaulting
 * to on (1), so every legacy project keeps its watermark. Legacy projects also
 * gain `type='custom'`, `recipe_version=1` and an empty brief — the custom
 * recipe v1 migration — without touching name/rules/revision.
 */
export function installProjectSchema(db) {
  db.exec(PROJECT_SCHEMA_SQL);
  // Reservation ledger shared by every new-Scene path (idempotent).
  installSceneReservations(db);
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  const projectColumns = columns('projects');
  for (const [name, ddl] of [
    ['watermark_enabled', 'INTEGER NOT NULL DEFAULT 1'],
    ['type', "TEXT NOT NULL DEFAULT 'custom'"],
    ['recipe_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['brief_json', "TEXT NOT NULL DEFAULT '{}'"],
  ]) {
    if (!projectColumns.has(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${ddl}`);
  }
  const jobColumns = columns('batch_jobs');
  for (const [name, ddl] of [['template_id', 'TEXT'], ['template_revision', 'INTEGER'], ['template_json', 'TEXT'], ['watermark_enabled', 'INTEGER NOT NULL DEFAULT 1'], ['generation_id', 'TEXT'], ['not_before', 'TEXT']]) {
    if (!jobColumns.has(name)) db.exec(`ALTER TABLE batch_jobs ADD COLUMN ${name} ${ddl}`);
  }
  const taskColumns = columns('batch_tasks');
  for (const [name, ddl] of [
    ['variant_name', 'TEXT'],
    ['values_json', 'TEXT'],
    ['scenario_id', 'TEXT'],
    ['item_key', 'TEXT'],
    ['generation_id', 'TEXT'],
    ['attempt', 'INTEGER'],
    ['reservation_id', 'TEXT'],
  ]) {
    if (!taskColumns.has(name)) db.exec(`ALTER TABLE batch_tasks ADD COLUMN ${name} ${ddl}`);
  }
}

export function nowIso(ms) {
  return new Date(ms).toISOString();
}

function parseBrief(value) {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function projectItem(row, sceneCount = 0) {
  return {
    id: row.id,
    name: row.name,
    rules: row.rules,
    platform: row.platform,
    // Legacy rows migrate to 1 (on); only an explicit 0 turns the watermark off.
    watermarkEnabled: Number(row.watermark_enabled ?? 1) === 1,
    // Legacy rows migrate to the custom recipe v1 with an empty brief.
    type: row.type ?? 'custom',
    recipeVersion: Number(row.recipe_version ?? 1),
    brief: parseBrief(row.brief_json),
    revision: Number(row.revision),
    updatedAt: row.updated_at,
    sceneCount: Number(sceneCount),
  };
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

export function listProjects(db, userId) {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.rules, p.platform, p.watermark_enabled, p.type, p.recipe_version, p.brief_json, p.revision, p.updated_at,
              (SELECT COUNT(*) FROM scene_projects sp
                WHERE sp.user_id = p.user_id AND sp.project_id = p.id) AS scene_count
       FROM projects p
       WHERE p.user_id = ?
       ORDER BY p.updated_at DESC, p.id ASC`,
    )
    .all(userId);
  return rows.map((row) => projectItem(row, row.scene_count));
}

export function getProjectRow(db, userId, projectId) {
  return (
    db
      .prepare('SELECT id, name, rules, platform, watermark_enabled, type, recipe_version, brief_json, revision, updated_at FROM projects WHERE user_id = ? AND id = ?')
      .get(userId, projectId) ?? null
  );
}

export function getProjectItem(db, userId, projectId) {
  const row = getProjectRow(db, userId, projectId);
  if (!row) return null;
  const count = db
    .prepare('SELECT COUNT(*) AS total FROM scene_projects WHERE user_id = ? AND project_id = ?')
    .get(userId, projectId);
  return projectItem(row, count?.total ?? 0);
}

/**
 * Server-side project context for normal Agent runs. Returns `null` when the
 * project does not exist or belongs to another account, so callers can never
 * pull rules across an ownership boundary.
 */
export function getProjectContext(db, userId, projectId) {
  const row = getProjectRow(db, userId, projectId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    rules: row.rules,
    platform: row.platform,
    watermarkEnabled: Number(row.watermark_enabled ?? 1) === 1,
    type: row.type ?? 'custom',
    recipeVersion: Number(row.recipe_version ?? 1),
    brief: parseBrief(row.brief_json),
  };
}

export function countProjects(db, userId) {
  const row = db.prepare('SELECT COUNT(*) AS total FROM projects WHERE user_id = ?').get(userId);
  return Number(row?.total ?? 0);
}

export function createProject(db, { userId, projectId, name, rules, platform, watermarkEnabled = true, type = 'custom', recipeVersion = 1, brief = {}, nowMs }) {
  return withTransaction(db, () => createProjectRow(db, { userId, projectId, name, rules, platform, watermarkEnabled, type, recipeVersion, brief, nowMs }));
}

/**
 * Non-transactional insert so the account automation service can run several
 * writes inside one enclosing transaction (see `services/projects/automation.mjs`).
 */
export function createProjectRow(db, { userId, projectId, name, rules, platform, watermarkEnabled = true, type = 'custom', recipeVersion = 1, brief = {}, nowMs }) {
  const stamp = nowIso(nowMs);
  if (countProjects(db, userId) >= MAX_PROJECTS_PER_USER) {
    throw projectsError(409, 'project_limit_reached', `每个账号最多保存 ${MAX_PROJECTS_PER_USER} 个项目`);
  }
  db.prepare(
    `INSERT INTO projects (user_id, id, name, rules, platform, watermark_enabled, type, recipe_version, brief_json, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(userId, projectId, name, rules, platform, watermarkEnabled ? 1 : 0, type, recipeVersion, JSON.stringify(brief ?? {}), stamp, stamp);
  return projectItem(
    { id: projectId, name, rules, platform, watermark_enabled: watermarkEnabled ? 1 : 0, type, recipe_version: recipeVersion, brief_json: JSON.stringify(brief ?? {}), revision: 1, updated_at: stamp },
    0,
  );
}

/**
 * Update a project. An omitted `watermarkEnabled` preserves the stored switch
 * (only an explicit boolean changes it), so a partial update can never quietly
 * turn a legacy project's watermark back on. Omitted `type`/`brief` keep the
 * stored recipe and brief the same way.
 */
export function updateProject(db, args) {
  return withTransaction(db, () => updateProjectRow(db, args));
}

/** Non-transactional update for the enclosing automation transaction. */
export function updateProjectRow(db, { userId, projectId, name, rules, platform, watermarkEnabled, type, brief, revision, nowMs }) {
  const stamp = nowIso(nowMs);
  const row = getProjectRow(db, userId, projectId);
  if (!row) throw projectsError(404, 'not_found', '项目不存在');
  if (Number(row.revision) !== revision) {
    throw projectsError(409, 'revision_conflict', '项目已更新，请刷新后重试');
  }
  const storedWatermark = watermarkEnabled === undefined ? Number(row.watermark_enabled ?? 1) === 1 : watermarkEnabled === true;
  const storedType = type === undefined ? (row.type ?? 'custom') : type;
  const storedBrief = brief === undefined ? parseBrief(row.brief_json) : brief;
  const storedRecipeVersion = type === undefined ? Number(row.recipe_version ?? 1) : 1;
  const result = db
    .prepare(
      `UPDATE projects
       SET name = ?, rules = ?, platform = ?, watermark_enabled = ?, type = ?, recipe_version = ?, brief_json = ?, revision = revision + 1, updated_at = ?
       WHERE user_id = ? AND id = ? AND revision = ?`,
    )
    .run(name, rules, platform, storedWatermark ? 1 : 0, storedType, storedRecipeVersion, JSON.stringify(storedBrief ?? {}), stamp, userId, projectId, revision);
  if (result.changes !== 1) {
    throw projectsError(409, 'revision_conflict', '项目已更新，请刷新后重试');
  }
  return projectItem(
    { id: projectId, name, rules, platform, watermark_enabled: storedWatermark ? 1 : 0, type: storedType, recipe_version: storedRecipeVersion, brief_json: JSON.stringify(storedBrief ?? {}), revision: revision + 1, updated_at: stamp },
    countProjectScenes(db, userId, projectId),
  );
}

export function countProjectScenes(db, userId, projectId) {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM scene_projects WHERE user_id = ? AND project_id = ?')
    .get(userId, projectId);
  return Number(row?.total ?? 0);
}

/**
 * Delete a project. Association rows cascade, scenes are preserved, and any
 * queued/running batch for the project is marked for cancellation before the
 * project row disappears. The scenario-generation lifecycle is terminated in
 * the SAME transaction: non-terminal parents are cancelled truthfully (cases
 * already published stay, the parent may end `partial`) and EVERY active
 * reservation — including future/unassigned chunk keys — is released, so the
 * account's Scene capacity is freed immediately without waiting for any worker
 * callback or restart. A slow in-flight result cannot publish afterwards: the
 * publisher re-checks project existence.
 */
export function deleteProject(db, { userId, projectId, revision, nowMs }) {
  const stamp = nowIso(nowMs);
  return withTransaction(db, () => {
    const row = getProjectRow(db, userId, projectId);
    if (!row) throw projectsError(404, 'not_found', '项目不存在');
    if (Number(row.revision) !== revision) {
      throw projectsError(409, 'revision_conflict', '项目已更新，请刷新后重试');
    }
    const detached = countProjectScenes(db, userId, projectId);
    db.prepare(
      `UPDATE batch_jobs
       SET cancel_requested = 1,
           status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
           reason = COALESCE(reason, '项目已删除'),
           updated_at = ?
       WHERE user_id = ? AND project_id = ? AND status IN ('queued', 'running')`,
    ).run(stamp, userId, projectId);
    db.prepare(
      `UPDATE batch_tasks SET status = 'cancelled', error = COALESCE(error, '项目已删除'), error_code = 'cancelled', updated_at = ?
       WHERE job_id IN (SELECT id FROM batch_jobs WHERE user_id = ? AND project_id = ? AND status = 'cancelled' AND cancel_requested = 1)
         AND status = 'queued'`,
    ).run(stamp, userId, projectId);
    terminateScenarioGenerations(db, { userId, projectId, nowMs });
    const result = db.prepare('DELETE FROM projects WHERE user_id = ? AND id = ?').run(userId, projectId);
    if (result.changes !== 1) throw projectsError(404, 'not_found', '项目不存在');
    return { detachedScenes: detached };
  });
}

/**
 * Central delete guard for the scenario-generation lifecycle (see
 * `deleteProject`). Table-existence guarded so legacy embedders that only
 * install the old project schema keep working unchanged.
 */
function terminateScenarioGenerations(db, { userId, projectId, nowMs }) {
  const hasGenerations = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scenario_generations'")
    .get();
  if (!hasGenerations) return { parents: 0, reservations: 0 };
  const stamp = nowIso(nowMs);
  const parents = db
    .prepare("SELECT id FROM scenario_generations WHERE user_id = ? AND project_id = ? AND status IN ('queued', 'running')")
    .all(userId, projectId);
  let released = 0;
  for (const parent of parents) {
    const consumed = Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE user_id = ? AND generation_id = ? AND status = 'consumed'")
        .get(userId, parent.id)?.n ?? 0,
    );
    // Truthful cancellation: published cases are never erased; the parent may
    // legitimately end `partial` instead of pretending full success/failure.
    db.prepare(
      `UPDATE scenario_generations SET status = ?, cancel_requested = 1, reason = COALESCE(reason, '项目已删除'), updated_at = ? WHERE id = ?`,
    ).run(consumed > 0 ? 'partial' : 'cancelled', stamp, parent.id);
  }
  released += releaseProjectReservations(db, { userId, projectId, reason: '项目已删除', errorCode: 'cancelled', nowMs });
  return { parents: parents.length, reservations: released };
}

/* ------------------------------------------------------------------ */
/* Scene association                                                   */
/* ------------------------------------------------------------------ */

export function listProjectScenes(db, userId, projectId) {
  return db
    .prepare(
      `SELECT s.id, s.title, s.platform, s.message_count, s.revision, s.updated_at
       FROM scene_projects sp
       JOIN scenes s ON s.user_id = sp.user_id AND s.id = sp.scene_id
       WHERE sp.user_id = ? AND sp.project_id = ?
       ORDER BY sp.created_at DESC, s.id ASC`,
    )
    .all(userId, projectId)
    .map((row) => ({
      id: row.id,
      title: row.title,
      platform: row.platform,
      messageCount: Number(row.message_count),
      revision: Number(row.revision),
      updatedAt: row.updated_at,
    }));
}

export function attachScene(db, { userId, projectId, sceneId, nowMs }) {
  return withTransaction(db, () => {
    if (!getProjectRow(db, userId, projectId)) {
      throw projectsError(404, 'not_found', '项目不存在');
    }
    const scene = db.prepare('SELECT id FROM scenes WHERE user_id = ? AND id = ?').get(userId, sceneId);
    if (!scene) throw projectsError(404, 'not_found', '作品不存在');
    const result = db
      .prepare(
        'INSERT INTO scene_projects (user_id, scene_id, project_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id,scene_id) DO UPDATE SET project_id=excluded.project_id WHERE scene_projects.project_id<>excluded.project_id',
      )
      .run(userId, sceneId, projectId, nowIso(nowMs));
    return { alreadyAttached: result.changes === 0 };
  });
}

export function detachScene(db, { userId, projectId, sceneId }) {
  return withTransaction(db, () => {
    if (!getProjectRow(db, userId, projectId)) {
      throw projectsError(404, 'not_found', '项目不存在');
    }
    const result = db
      .prepare('DELETE FROM scene_projects WHERE user_id = ? AND project_id = ? AND scene_id = ?')
      .run(userId, projectId, sceneId);
    return { detached: result.changes > 0 };
  });
}

/* ------------------------------------------------------------------ */
/* Batch jobs                                                          */
/* ------------------------------------------------------------------ */

function jobSummary(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    generationId: row.generation_id ?? null,
    status: row.status,
    rules: row.rules,
    // Frozen at enqueue: later project edits never change a queued/finished job.
    watermarkEnabled: Number(row.watermark_enabled ?? 1) === 1,
    templateId: row.template_id ?? null,
    templateRevision: row.template_revision === null || row.template_revision === undefined ? null : Number(row.template_revision),
    reason: row.reason ?? null,
    cancelRequested: Number(row.cancel_requested) === 1,
    total: Number(row.total),
    succeeded: Number(row.succeeded),
    failed: Number(row.failed),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskItem(row) {
  let values = {};
  if (typeof row.values_json === 'string' && row.values_json !== '') {
    try { values = JSON.parse(row.values_json); } catch { values = {}; }
  }
  return {
    id: row.id,
    ordinal: Number(row.ordinal),
    prompt: row.prompt,
    platform: row.platform,
    name: row.variant_name ?? '',
    values,
    status: row.status,
    sceneId: row.scene_id ?? null,
    // Scenario-generation bindings (absent for legacy project batches).
    scenarioId: row.scenario_id ?? null,
    itemKey: row.item_key ?? null,
    generationId: row.generation_id ?? null,
    attempt: row.attempt === null || row.attempt === undefined ? null : Number(row.attempt),
    reservationId: row.reservation_id ?? null,
    error: row.error ?? null,
    errorCode: row.error_code ?? null,
    detail: row.detail ?? '',
    updatedAt: row.updated_at,
  };
}

export function findJobByClientId(db, userId, projectId, clientBatchId) {
  if (!clientBatchId) return null;
  return (
    db
      .prepare('SELECT * FROM batch_jobs WHERE user_id = ? AND project_id = ? AND client_batch_id = ?')
      .get(userId, projectId, clientBatchId) ?? null
  );
}

export function getJobRowById(db, userId, jobId) {
  return db.prepare('SELECT * FROM batch_jobs WHERE user_id = ? AND id = ?').get(userId, jobId) ?? null;
}

export function getJobRow(db, userId, projectId, jobId) {
  return (
    db
      .prepare('SELECT * FROM batch_jobs WHERE user_id = ? AND project_id = ? AND id = ?')
      .get(userId, projectId, jobId) ?? null
  );
}

export function listJobTasks(db, jobId) {
  return db
    .prepare('SELECT * FROM batch_tasks WHERE job_id = ? ORDER BY ordinal ASC, id ASC')
    .all(jobId)
    .map(taskItem);
}

export function jobDetail(db, row) {
  return { ...jobSummary(row), tasks: listJobTasks(db, row.id) };
}

export function getJobDetail(db, userId, projectId, jobId) {
  const row = getJobRow(db, userId, projectId, jobId);
  if (!row) return null;
  return jobDetail(db, row);
}

export function getJobDetailById(db, userId, jobId) {
  const row = getJobRowById(db, userId, jobId);
  if (!row) return null;
  return jobDetail(db, row);
}

/** Public batch history never mixes internal scenario-generation chunks. */
export function listBatchJobs(db, userId, projectId, limit = 10) {
  return db
    .prepare(
      `SELECT * FROM batch_jobs WHERE user_id = ? AND project_id = ? AND generation_id IS NULL
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(userId, projectId, limit)
    .map(jobSummary);
}

export function countActiveJobs(db, userId) {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM batch_jobs WHERE user_id = ? AND status IN ('queued', 'running')")
    .get(userId);
  return Number(row?.total ?? 0);
}

/**
 * Persist a new job and its tasks atomically. Task scene ids are generated
 * up front so a retry/replace never reuses another account's scene id. A
 * frozen template snapshot, the project's watermark switch and every item's
 * values are written in the same transaction, so later template/project edits
 * cannot change queued output. Scenario-generation tasks additionally carry
 * their frozen `scenarioId`/`itemKey`/`generationId`/`attempt`/`reservationId`
 * bindings so publication can fence writes per attempt.
 */
export function createBatchJob(db, { userId, projectId, sessionId, rules, tasks, clientBatchId, nowMs, template = null, watermarkEnabled = true, generationId = null }) {
  const jobId = crypto.randomUUID();
  const stamp = nowIso(nowMs);
  const templateJson = template ? JSON.stringify(template.definition) : null;
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO batch_jobs
         (id, user_id, project_id, generation_id, session_id, client_batch_id, status, rules, watermark_enabled, template_id, template_revision, template_json, total, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      userId,
      projectId,
      generationId,
      sessionId ?? null,
      clientBatchId,
      rules,
      watermarkEnabled ? 1 : 0,
      template ? template.id : null,
      template ? template.revision : null,
      templateJson,
      tasks.length,
      stamp,
      stamp,
    );
    const insertTask = db.prepare(
      `INSERT INTO batch_tasks
         (id, job_id, user_id, ordinal, prompt, platform, variant_name, values_json, scenario_id, item_key, generation_id, attempt, reservation_id, status, scene_id, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, '', ?)`,
    );
    tasks.forEach((task, index) => {
      insertTask.run(
        crypto.randomUUID(),
        jobId,
        userId,
        index,
        task.prompt,
        task.platform,
        task.name || null,
        JSON.stringify(task.values ?? {}),
        task.scenarioId ?? null,
        task.itemKey ?? null,
        task.generationId ?? generationId,
        task.attempt ?? (task.itemKey ? 1 : null),
        task.reservationId ?? null,
        crypto.randomUUID(),
        stamp,
      );
    });
  });
  return jobDetail(db, getJobRowById(db, userId, jobId));
}

/**
 * Claim the oldest eligible queued job for the single serial worker. Deferred
 * jobs (rate pacing) are skipped until their `not_before` instant, so the
 * global worker yields to other accounts instead of blocking on one limiter.
 */
export function claimNextJob(db, nowMs) {
  return withTransaction(db, () => {
    const row = db
      .prepare(
        `SELECT * FROM batch_jobs
         WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?)
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(nowIso(nowMs));
    if (!row) return null;
    db.prepare("UPDATE batch_jobs SET status = 'running', updated_at = ? WHERE id = ?").run(
      nowIso(nowMs),
      row.id,
    );
    return { ...row, status: 'running' };
  });
}

/**
 * Durable rate-pacing defer: put a not-yet-started task's job back to `queued`
 * until `notBeforeMs`. Only used BEFORE any provider execution (the lease
 * could not be acquired), so the same task/attempt/reservation simply resumes
 * later — nothing is re-run or lost.
 */
export function deferJob(db, jobId, notBeforeMs, nowMs) {
  db.prepare(
    `UPDATE batch_jobs SET status = 'queued', not_before = ?, updated_at = ?
     WHERE id = ? AND status = 'running'`,
  ).run(nowIso(notBeforeMs), nowIso(nowMs), jobId);
}

export function sessionStillValid(db, userId, sessionId, nowMs) {
  if (!sessionId) return true;
  const row = db
    .prepare('SELECT 1 AS ok FROM sessions WHERE id = ? AND user_id = ? AND expires_at_ms > ?')
    .get(sessionId, userId, nowMs);
  return Boolean(row);
}

export function jobCancelRequested(db, jobId) {
  const row = db.prepare('SELECT cancel_requested FROM batch_jobs WHERE id = ?').get(jobId);
  return Number(row?.cancel_requested ?? 0) === 1;
}

export function markTaskRunning(db, taskId, nowMs) {
  db.prepare("UPDATE batch_tasks SET status = 'running', detail = '', updated_at = ? WHERE id = ?").run(
    nowIso(nowMs),
    taskId,
  );
}

export function updateTaskDetail(db, taskId, detail, nowMs) {
  db.prepare('UPDATE batch_tasks SET detail = ?, updated_at = ? WHERE id = ?').run(
    String(detail ?? '').slice(0, 500),
    nowIso(nowMs),
    taskId,
  );
}

export function markTaskDone(db, taskId, nowMs) {
  db.prepare(
    "UPDATE batch_tasks SET status = 'done', error = NULL, error_code = NULL, detail = '已生成并保存', updated_at = ? WHERE id = ?",
  ).run(nowIso(nowMs), taskId);
}

export function markTaskFailed(db, taskId, { code, message }, nowMs) {
  db.prepare(
    "UPDATE batch_tasks SET status = 'failed', error = ?, error_code = ?, updated_at = ? WHERE id = ?",
  ).run(String(message ?? '生成失败').slice(0, 500), String(code ?? 'error'), nowIso(nowMs), taskId);
}

export function markTaskInterrupted(db, taskId, message, nowMs) {
  db.prepare(
    "UPDATE batch_tasks SET status = 'interrupted', error = ?, error_code = 'interrupted', updated_at = ? WHERE id = ?",
  ).run(String(message ?? '任务已中断').slice(0, 500), nowIso(nowMs), taskId);
}

export function markTaskCancelled(db, taskId, message, nowMs) {
  db.prepare(
    "UPDATE batch_tasks SET status = 'cancelled', error = ?, error_code = 'cancelled', updated_at = ? WHERE id = ?",
  ).run(String(message ?? '已取消').slice(0, 500), nowIso(nowMs), taskId);
}

export function markRemainingTasksInterrupted(db, jobId, message, nowMs) {
  db.prepare(
    `UPDATE batch_tasks SET status = 'interrupted', error = ?, error_code = 'interrupted', updated_at = ?
     WHERE job_id = ? AND status IN ('queued', 'running')`,
  ).run(String(message ?? '任务已中断').slice(0, 500), nowIso(nowMs), jobId);
}

export function markRemainingTasksCancelled(db, jobId, message, nowMs) {
  db.prepare(
    `UPDATE batch_tasks SET status = 'cancelled', error = ?, error_code = 'cancelled', updated_at = ?
     WHERE job_id = ? AND status IN ('queued', 'running')`,
  ).run(String(message ?? '已取消').slice(0, 500), nowIso(nowMs), jobId);
}

export function finalizeJob(db, jobId, { status, reason }, nowMs) {
  const counts = db
    .prepare('SELECT status, COUNT(*) AS total FROM batch_tasks WHERE job_id = ? GROUP BY status')
    .all(jobId);
  const byStatus = new Map(counts.map((row) => [row.status, Number(row.total)]));
  const succeeded = byStatus.get('done') ?? 0;
  const failed = byStatus.get('failed') ?? 0;
  db.prepare(
    `UPDATE batch_jobs SET status = ?, reason = ?, succeeded = ?, failed = ?, updated_at = ? WHERE id = ?`,
  ).run(status, reason ?? null, succeeded, failed, nowIso(nowMs), jobId);
}

/**
 * Mark the job cancelled and cancel every still-pending task. Running tasks are
 * handled by the worker, which finalizes the job only after the active run
 * actually stops.
 *
 * Internal scenario-generation chunks (`generation_id` set) are NEVER
 * cancellable through the legacy public batch entry: cancelling a queued chunk
 * there would strand its parent and reservations. The scenario-generation
 * service cancels whole parents with `allowGenerationChunk: true`.
 */
export function markJobCancelRequested(db, { userId, projectId, jobId, reason, nowMs, allowGenerationChunk = false }) {
  const stamp = nowIso(nowMs);
  return withTransaction(db, () => {
    const row = getJobRow(db, userId, projectId, jobId);
    if (!row) throw projectsError(404, 'not_found', '生成任务不存在');
    if (row.generation_id && !allowGenerationChunk) {
      // Public legacy entry on an internal chunk: DELEGATE to a consistent
      // whole-parent cancellation (the parent's trusted internal call is the
      // only other path). All sibling chunks stop and every reservation of the
      // parent is released in this same transaction.
      const hasGenerations = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scenario_generations'")
        .get();
      if (hasGenerations) {
        const consumed = Number(
          db
            .prepare("SELECT COUNT(*) AS n FROM scene_reservations WHERE user_id = ? AND generation_id = ? AND status = 'consumed'")
            .get(userId, row.generation_id)?.n ?? 0,
        );
        db.prepare(
          `UPDATE scenario_generations SET cancel_requested = 1, status = ?, reason = COALESCE(reason, ?), updated_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`,
        ).run(consumed > 0 ? 'partial' : 'cancelled', reason, stamp, row.generation_id);
        const chunks = db
          .prepare("SELECT id FROM batch_jobs WHERE user_id = ? AND generation_id = ? AND status IN ('queued', 'running')")
          .all(userId, row.generation_id);
        for (const chunk of chunks) {
          db.prepare(
            `UPDATE batch_jobs SET cancel_requested = 1,
               status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
               reason = COALESCE(reason, ?), updated_at = ?
             WHERE id = ?`,
          ).run(reason, stamp, chunk.id);
          db.prepare(
            `UPDATE batch_tasks SET status = 'cancelled', error = COALESCE(error, ?), error_code = 'cancelled', updated_at = ?
             WHERE job_id = ? AND status = 'queued'`,
          ).run(reason, stamp, chunk.id);
        }
        releaseGenerationReservations(db, {
          userId,
          generationId: row.generation_id,
          reason,
          errorCode: 'cancelled',
          nowMs,
        });
      }
      return jobDetail(db, getJobRow(db, userId, projectId, jobId));
    }
    if (isTerminalJobStatus(row.status)) return jobDetail(db, row);
    db.prepare(
      'UPDATE batch_jobs SET cancel_requested = 1, reason = COALESCE(reason, ?), updated_at = ? WHERE id = ?',
    ).run(reason, stamp, jobId);
    if (row.status === 'queued') {
      markRemainingTasksCancelled(db, jobId, reason, nowMs);
      db.prepare("UPDATE batch_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?").run(stamp, jobId);
    }
    return jobDetail(db, getJobRow(db, userId, projectId, jobId));
  });
}

/**
 * Build a fresh job containing only the retryable tasks of a terminal job,
 * reusing the original rule and watermark snapshots — a retry keeps the
 * enqueue-time user settings even if the project changed since. Explicit
 * retries therefore never resume automatically after a restart and never
 * create duplicate scenes.
 */
export function createRetryJob(db, { userId, projectId, jobId, sessionId, nowMs }) {
  const prior = findJobByClientId(db,userId,projectId,'retry-'+jobId);
  if(prior) return jobDetail(db,prior);
  const source = getJobRow(db, userId, projectId, jobId);
  if (!source) throw projectsError(404, 'not_found', '生成任务不存在');
  if (source.generation_id) {
    // Scenario chunks carry frozen case bindings; a legacy retry would drop
    // them and pay for a loose scene that is not a case. Retry the parent.
    throw projectsError(
      409,
      'generation_chunk',
      '这是 AI 生成案例的内部任务，不能用旧批量重试；请使用场景的“重试缺项/失败项”。',
    );
  }
  if (!isTerminalJobStatus(source.status)) {
    throw projectsError(409, 'job_not_finished', '生成任务尚未结束，无法重试');
  }
  const retryable = db
    .prepare(
      `SELECT prompt, platform, variant_name, values_json FROM batch_tasks
       WHERE job_id = ? AND status IN ('failed', 'interrupted', 'cancelled')
       ORDER BY ordinal ASC, id ASC`,
    )
    .all(jobId)
    .filter((task) => typeof task.prompt === 'string' && task.prompt.trim() !== '');
  if (retryable.length === 0) {
    throw projectsError(400, 'nothing_to_retry', '没有需要重试的任务');
  }
  let template = null;
  if (source.template_id && typeof source.template_json === 'string' && source.template_json !== '') {
    try { template = { id: source.template_id, revision: Number(source.template_revision ?? 1), definition: JSON.parse(source.template_json) }; }
    catch { template = null; }
  }
  return createBatchJob(db, {
    userId,
    projectId,
    sessionId,
    rules: source.rules,
    watermarkEnabled: Number(source.watermark_enabled ?? 1) === 1,
    tasks: retryable.map((task) => {
      let values = {};
      if (typeof task.values_json === 'string' && task.values_json !== '') { try { values = JSON.parse(task.values_json); } catch { values = {}; } }
      return { prompt: task.prompt, platform: task.platform, name: task.variant_name ?? '', values };
    }),
    clientBatchId: 'retry-'+jobId,
    template,
    nowMs,
  });
}

/**
 * Publish one successfully finished generated scene as a brand new account
 * scene and attach it to the project. Only called for `ok: true` runs.
 */
export function publishGeneratedScene(db, { userId, projectId, scene, nowMs, taskId }) {
  const stamp = nowIso(nowMs);
  const sceneId = String(scene.id).toLowerCase();
  const sceneJson = JSON.stringify(scene);
  return withTransaction(db, () => {
    const existing = db.prepare('SELECT revision FROM scenes WHERE user_id = ? AND id = ?').get(userId, sceneId);
    if (existing) throw projectsError(409, 'conflict', '生成的作品已存在');
    // Shared capacity guard: real scenes + active generation reservations.
    assertSceneCapacity(db, userId, 1);
    db.prepare(
      `INSERT INTO scenes (user_id, id, title, platform, message_count, revision, scene_json, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(userId, sceneId, scene.title, scene.platform, scene.messages.length, sceneJson, stamp);
    // If the project was deleted while this task ran, still keep the generated
    // scene in the account; only the association is skipped.
    const attached = Boolean(getProjectRow(db, userId, projectId));
    if (attached) {
      db.prepare(
        'INSERT OR IGNORE INTO scene_projects (user_id, scene_id, project_id, created_at) VALUES (?, ?, ?, ?)',
      ).run(userId, sceneId, projectId, stamp);
    }
    if(taskId) markTaskDone(db,taskId,nowMs);
    return { sceneId, attached };
  });
}

/* ------------------------------------------------------------------ */
/* Startup recovery                                                    */
/* ------------------------------------------------------------------ */

/**
 * Truthful restart recovery: any job that was queued or running when the
 * process died is marked interrupted, and no generated scene is invented for
 * it. Users must explicitly retry.
 */
export function markInterruptedJobs(db, nowMs) {
  const stamp = nowIso(nowMs);
  const message = '服务重启，任务已中断，请手动重试';
  return withTransaction(db, () => {
    const tasks = db
      .prepare(
        `UPDATE batch_tasks
         SET status = 'interrupted', error = COALESCE(error, ?), error_code = 'interrupted', updated_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(message, stamp);
    const jobs = db
      .prepare(
        `UPDATE batch_jobs
         SET status = 'interrupted', reason = COALESCE(reason, ?), updated_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(message, stamp);
    return { jobs: Number(jobs.changes ?? 0), tasks: Number(tasks.changes ?? 0) };
  });
}

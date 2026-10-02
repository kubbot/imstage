/**
 * IMStage Project Automation — SQLite persistence for scenarios, planned
 * cases and caller content batches.
 *
 * Additive-only: the legacy `projects` / `scenes` / `scene_projects` tables
 * are untouched (the type/brief columns live in `services/projects/store.mjs`
 * migration), and every row here carries `user_id` so ownership is enforced at
 * the storage layer as well as in the application service.
 *
 * The idempotency records reuse the account `mcp_idempotency` table so an MCP
 * caller and the Web HTTP API resolve the same key to the same receipt — one
 * client can resume a batch another client created.
 */

import crypto from 'node:crypto';

import { projectsError } from './errors.mjs';
import { sha256Hex } from '../mcp/util.mjs';

export const AUTOMATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS scenarios (
    user_id          TEXT NOT NULL,
    id               TEXT NOT NULL,
    project_id       TEXT NOT NULL,
    name             TEXT NOT NULL,
    brief            TEXT NOT NULL DEFAULT '',
    preset           TEXT NOT NULL,
    case_count       INTEGER NOT NULL,
    platform         TEXT NOT NULL,
    locale           TEXT NOT NULL DEFAULT 'zh-CN',
    auto_export      INTEGER NOT NULL DEFAULT 1,
    rules_frozen     TEXT NOT NULL DEFAULT '',
    watermark_frozen INTEGER NOT NULL DEFAULT 1,
    cast_json        TEXT NOT NULL DEFAULT '[]',
    defaults_json    TEXT NOT NULL DEFAULT '{}',
    plan_json        TEXT NOT NULL,
    recipe_type      TEXT NOT NULL DEFAULT 'custom',
    recipe_version   INTEGER NOT NULL DEFAULT 1,
    revision         INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (user_id, id),
    FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_scenarios_project ON scenarios(user_id, project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS scenario_cases (
    user_id          TEXT NOT NULL,
    scenario_id      TEXT NOT NULL,
    item_key         TEXT NOT NULL,
    ordinal          INTEGER NOT NULL,
    name             TEXT NOT NULL DEFAULT '',
    objective        TEXT NOT NULL DEFAULT '',
    context          TEXT NOT NULL DEFAULT '',
    annotations_json TEXT NOT NULL DEFAULT '',
    scene_id         TEXT,
    scene_revision   INTEGER,
    dialogue_hash    TEXT,
    source           TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (user_id, scenario_id, item_key),
    FOREIGN KEY (user_id, scenario_id) REFERENCES scenarios(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_scenario_cases_scene ON scenario_cases(user_id, scene_id);

  CREATE TABLE IF NOT EXISTS content_batches (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    project_id       TEXT NOT NULL,
    scenario_id      TEXT,
    client_key       TEXT,
    request_hash     TEXT NOT NULL,
    template_id      TEXT,
    template_revision INTEGER,
    template_json    TEXT,
    frozen_json      TEXT NOT NULL DEFAULT '{}',
    origin           TEXT NOT NULL DEFAULT '',
    grant_ref        TEXT,
    total            INTEGER NOT NULL,
    created_at       TEXT NOT NULL,
    FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_content_batches_client
    ON content_batches(user_id, project_id, client_key) WHERE client_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_content_batches_project ON content_batches(user_id, project_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS content_batch_items (
    user_id          TEXT NOT NULL,
    batch_id         TEXT NOT NULL,
    ordinal          INTEGER NOT NULL,
    item_key         TEXT NOT NULL,
    name             TEXT NOT NULL DEFAULT '',
    objective        TEXT NOT NULL DEFAULT '',
    context          TEXT NOT NULL DEFAULT '',
    annotations_json TEXT NOT NULL DEFAULT '',
    prompt           TEXT NOT NULL DEFAULT '',
    scene_id         TEXT NOT NULL,
    scene_revision   INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (user_id, batch_id, item_key),
    FOREIGN KEY (batch_id) REFERENCES content_batches(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_content_batch_items_scene ON content_batch_items(user_id, scene_id);

  CREATE TABLE IF NOT EXISTS mcp_idempotency (
    user_id       TEXT NOT NULL,
    key           TEXT NOT NULL,
    operation     TEXT NOT NULL,
    request_hash  TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
`;

export function installAutomationSchema(db) {
  db.exec(AUTOMATION_SCHEMA_SQL);
  // Submit-time hashes become historical when a Scene is edited or detached.
  // Duplicate checks compare live dialogue content in the batch service;
  // a cached unique index would wrongly reject reuse of an old transcript.
  db.exec('DROP INDEX IF EXISTS idx_scenario_cases_dialogue');
}

export function nowIso(ms) {
  return new Date(ms).toISOString();
}

/**
 * Exact normalized dialogue signature: ignores scene/participant/message ids,
 * titles, times and platform, so re-titled or re-timed copies of the same
 * conversation collide. Roles are positional so renaming a participant does
 * not create a "new" dialogue.
 */
export function dialogueSignature(scene) {
  const indexById = new Map(scene.participants.map((person, index) => [person.id, index]));
  const lines = scene.messages.map((message) => [
    indexById.get(message.participantId) ?? -1,
    message.type,
    String(message.text ?? '').replace(/\s+/g, ' ').trim(),
    message.asset ? 1 : 0,
  ]);
  return sha256Hex(JSON.stringify(lines));
}

export function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error wins */
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Idempotency (shared with the account MCP store adapter)             */
/* ------------------------------------------------------------------ */

export function readIdempotent(db, userId, key, operation, requestHash) {
  if (!key) return null;
  const row = db
    .prepare('SELECT operation, request_hash, response_json FROM mcp_idempotency WHERE user_id = ? AND key = ?')
    .get(userId, key);
  if (!row) return null;
  if (row.operation !== operation || row.request_hash !== requestHash) {
    throw projectsError(409, 'idempotency_conflict', '该 idempotencyKey 已用于不同的请求内容');
  }
  return JSON.parse(row.response_json);
}

export function writeIdempotent(db, userId, key, operation, requestHash, response, nowMs) {
  if (!key) return;
  db.prepare(
    `INSERT INTO mcp_idempotency (user_id, key, operation, request_hash, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO NOTHING`,
  ).run(userId, key, operation, requestHash, JSON.stringify(response), nowIso(nowMs));
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function scenarioItem(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    brief: row.brief,
    preset: row.preset,
    caseCount: Number(row.case_count),
    platform: row.platform,
    locale: row.locale,
    autoExport: Number(row.auto_export) === 1,
    recipeType: row.recipe_type,
    recipeVersion: Number(row.recipe_version),
    // Frozen at creation: later project edits never change a scenario.
    frozen: {
      rules: row.rules_frozen,
      watermarkEnabled: Number(row.watermark_frozen ?? 1) === 1,
      cast: parseJson(row.cast_json, []),
      defaults: parseJson(row.defaults_json, {}),
    },
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertScenario(db, { userId, scenario, plan, nowMs }) {
  const stamp = nowIso(nowMs);
  db.prepare(
    `INSERT INTO scenarios
       (user_id, id, project_id, name, brief, preset, case_count, platform, locale, auto_export,
        rules_frozen, watermark_frozen, cast_json, defaults_json, plan_json, recipe_type, recipe_version,
        revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    userId,
    scenario.id,
    scenario.projectId,
    scenario.name,
    scenario.brief,
    scenario.preset,
    scenario.caseCount,
    scenario.platform,
    scenario.locale,
    scenario.autoExport ? 1 : 0,
    scenario.frozen.rules,
    scenario.frozen.watermarkEnabled ? 1 : 0,
    JSON.stringify(scenario.frozen.cast ?? []),
    JSON.stringify(scenario.frozen.defaults ?? {}),
    JSON.stringify(plan),
    scenario.recipeType,
    scenario.recipeVersion,
    stamp,
    stamp,
  );
  const insertCase = db.prepare(
    `INSERT INTO scenario_cases (user_id, scenario_id, item_key, ordinal, name, objective, context, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const entry of plan.cases) {
    insertCase.run(userId, scenario.id, entry.itemKey, entry.ordinal, entry.name, entry.objective, entry.context, stamp, stamp);
  }
  return scenarioItem(
    db.prepare('SELECT * FROM scenarios WHERE user_id = ? AND id = ?').get(userId, scenario.id),
  );
}

export function getScenarioRow(db, userId, scenarioId) {
  return db.prepare('SELECT * FROM scenarios WHERE user_id = ? AND id = ?').get(userId, scenarioId) ?? null;
}

export function getScenarioItem(db, userId, scenarioId) {
  const row = getScenarioRow(db, userId, scenarioId);
  return row ? scenarioItem(row) : null;
}

export function listScenarioRows(db, userId, projectId) {
  return db
    .prepare('SELECT * FROM scenarios WHERE user_id = ? AND project_id = ? ORDER BY created_at ASC, id ASC')
    .all(userId, projectId);
}

export function countScenarios(db, userId, projectId) {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM scenarios WHERE user_id = ? AND project_id = ?')
    .get(userId, projectId);
  return Number(row?.total ?? 0);
}

export function scenarioPlan(row) {
  return parseJson(row.plan_json, { cases: [] });
}

/* ------------------------------------------------------------------ */
/* Planned / submitted cases                                           */
/* ------------------------------------------------------------------ */

export function caseItem(row) {
  const liveSceneId = row.live_scene_id ?? null;
  const liveScene = (() => {
    if (typeof row.live_scene_json !== 'string' || row.live_scene_json === '') return null;
    try {
      return JSON.parse(row.live_scene_json);
    } catch {
      return null;
    }
  })();
  const attachedProjectId = row.attached_project_id ?? null;
  const expectedProjectId = row.expected_project_id ?? null;
  // Completion is derived from the LIVE scene and its project association: a
  // deleted or reassigned scene is never counted as a finished case.
  const annotations = parseJson(row.annotations_json, {});
  const hasDialogue = Array.isArray(liveScene?.messages) && liveScene.messages.length > 0;
  const hasRequiredAnnotations = row.recipe_type !== 'evaluation_dataset' ||
    Object.keys(annotations.labels ?? {}).length > 0;
  const submitted = hasDialogue && hasRequiredAnnotations && (expectedProjectId === null || attachedProjectId === expectedProjectId);
  return {
    itemKey: row.item_key,
    ordinal: Number(row.ordinal),
    name: row.name,
    objective: row.objective,
    context: row.context,
    annotations,
    sceneId: liveSceneId,
    // The current scene revision (not the revision stored at submit time).
    sceneRevision: liveScene ? Number(row.live_revision ?? row.scene_revision ?? 1) : null,
    submitted,
    source: row.source ?? '',
    updatedAt: row.updated_at,
  };
}

const CASE_SELECT = `
  SELECT c.*, s.id AS live_scene_id, s.revision AS live_revision, s.scene_json AS live_scene_json,
         sp.project_id AS attached_project_id, sc.recipe_type
  FROM scenario_cases c
  LEFT JOIN scenes s ON s.user_id = c.user_id AND s.id = c.scene_id
  LEFT JOIN scene_projects sp ON sp.user_id = c.user_id AND sp.scene_id = c.scene_id
  LEFT JOIN scenarios sc ON sc.user_id = c.user_id AND sc.id = c.scenario_id
`;

export function listCaseRows(db, userId, scenarioId, projectId = null) {
  return db
    .prepare(`${CASE_SELECT} WHERE c.user_id = ? AND c.scenario_id = ? ORDER BY c.ordinal ASC, c.item_key ASC`)
    .all(userId, scenarioId)
    .map((row) => ({ ...row, expected_project_id: projectId }));
}

export function getCaseRow(db, userId, scenarioId, itemKey, projectId = null) {
  const row = db
    .prepare(`${CASE_SELECT} WHERE c.user_id = ? AND c.scenario_id = ? AND c.item_key = ?`)
    .get(userId, scenarioId, itemKey);
  return row ? { ...row, expected_project_id: projectId } : null;
}

/**
 * Current dialogue signatures of completed cases, recomputed from the live
 * scene JSON. An edited transcript therefore cannot be submitted again as a
 * "different" case even though the cached submit-time hash is stale.
 */
export function submittedDialogueHashes(db, userId, scenarioId, projectId = null) {
  return listCaseRows(db, userId, scenarioId, projectId)
    .map(caseItem)
    .filter((item) => item.submitted && item.sceneId)
    .map((item) => ({ itemKey: item.itemKey, dialogueHash: liveDialogueHash(db, userId, item.sceneId) }))
    .filter((entry) => typeof entry.dialogueHash === 'string');
}

function liveDialogueHash(db, userId, sceneId) {
  const row = db.prepare('SELECT scene_json FROM scenes WHERE user_id = ? AND id = ?').get(userId, sceneId);
  if (!row) return null;
  try {
    return dialogueSignature(JSON.parse(row.scene_json));
  } catch {
    return null;
  }
}

/**
 * Housekeeping inside the batch transaction: drop cached dialogue signatures
 * whose scene no longer exists, so the unique index cannot block a legitimate
 * resubmission after a Web/MCP deletion.
 */
export function clearStaleDialogueHashes(db, userId, scenarioId) {
  db.prepare(
    `UPDATE scenario_cases SET dialogue_hash = NULL
     WHERE user_id = ? AND scenario_id = ? AND scene_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM scenes s WHERE s.user_id = scenario_cases.user_id AND s.id = scenario_cases.scene_id
       )`,
  ).run(userId, scenarioId);
}

/**
 * Mark one planned case as submitted with its final metadata and scene link.
 * Runs inside the caller's batch transaction so a partial batch can never
 * exist.
 */
export function submitCaseContent(db, { userId, scenarioId, itemKey, name, objective, context, annotations, sceneId, sceneRevision, dialogueHash, source, nowMs }) {
  db.prepare(
    `UPDATE scenario_cases
     SET name = ?, objective = ?, context = ?, annotations_json = ?, scene_id = ?, scene_revision = ?, dialogue_hash = ?, source = ?, updated_at = ?
     WHERE user_id = ? AND scenario_id = ? AND item_key = ?`,
  ).run(
    name,
    objective,
    context,
    JSON.stringify(annotations ?? {}),
    sceneId,
    sceneRevision,
    dialogueHash,
    source ?? 'caller',
    nowIso(nowMs),
    userId,
    scenarioId,
    itemKey,
  );
}

/** Free-standing case link for batches without a scenario (dedupe bookkeeping). */
export function insertLooseCase(db, { userId, scenarioId = null, itemKey, ordinal, name, objective, context, annotations, sceneId, sceneRevision, dialogueHash, source, nowMs }) {
  db.prepare(
    `INSERT INTO scenario_cases (user_id, scenario_id, item_key, ordinal, name, objective, context, annotations_json, scene_id, scene_revision, dialogue_hash, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    userId,
    scenarioId,
    itemKey,
    ordinal,
    name,
    objective,
    context,
    JSON.stringify(annotations ?? {}),
    sceneId,
    sceneRevision,
    dialogueHash,
    source ?? 'caller',
    nowIso(nowMs),
    nowIso(nowMs),
  );
}

/* ------------------------------------------------------------------ */
/* Content batches                                                     */
/* ------------------------------------------------------------------ */

function batchSummary(row) {
  return {
    batchId: row.id,
    projectId: row.project_id,
    scenarioId: row.scenario_id ?? null,
    clientIdempotencyKey: row.client_key ?? null,
    requestHash: row.request_hash,
    templateId: row.template_id ?? null,
    templateRevision: row.template_revision === null || row.template_revision === undefined ? null : Number(row.template_revision),
    total: Number(row.total),
    origin: row.origin ?? '',
    createdAt: row.created_at,
  };
}

function batchItem(row) {
  return {
    itemKey: row.item_key,
    ordinal: Number(row.ordinal),
    name: row.name,
    objective: row.objective,
    context: row.context,
    annotations: parseJson(row.annotations_json, {}),
    prompt: row.prompt ?? '',
    sceneId: row.scene_id,
    sceneRevision: Number(row.scene_revision ?? 1),
  };
}

export function insertContentBatch(db, { batch, items, nowMs }) {
  const stamp = nowIso(nowMs);
  db.prepare(
    `INSERT INTO content_batches
       (id, user_id, project_id, scenario_id, client_key, request_hash, template_id, template_revision, template_json, frozen_json, origin, grant_ref, total, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    batch.id,
    batch.userId,
    batch.projectId,
    batch.scenarioId ?? null,
    batch.clientKey ?? null,
    batch.requestHash,
    batch.template?.id ?? null,
    batch.template?.revision ?? null,
    batch.template ? JSON.stringify(batch.template.definition) : null,
    JSON.stringify(batch.frozen ?? {}),
    batch.origin ?? '',
    batch.grantRef ?? null,
    items.length,
    stamp,
  );
  const insertItem = db.prepare(
    `INSERT INTO content_batch_items (user_id, batch_id, ordinal, item_key, name, objective, context, annotations_json, prompt, scene_id, scene_revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  items.forEach((item, index) => {
    insertItem.run(
      batch.userId,
      batch.id,
      index,
      item.itemKey,
      item.name,
      item.objective,
      item.context,
      JSON.stringify(item.annotations ?? {}),
      item.prompt ?? '',
      item.sceneId,
      item.sceneRevision,
      stamp,
    );
  });
}

export function findContentBatchByClientKey(db, userId, projectId, clientKey) {
  if (!clientKey) return null;
  return (
    db
      .prepare('SELECT * FROM content_batches WHERE user_id = ? AND project_id = ? AND client_key = ?')
      .get(userId, projectId, clientKey) ?? null
  );
}

/** Any earlier batch item in the same project that already used this key. */
export function findProjectItemKey(db, userId, projectId, itemKey) {
  return (
    db
      .prepare(
        `SELECT i.item_key FROM content_batch_items i
         JOIN content_batches b ON b.id = i.batch_id
         WHERE i.user_id = ? AND b.project_id = ? AND i.item_key = ?`,
      )
      .get(userId, projectId, itemKey) ?? null
  );
}

export function getContentBatchRow(db, userId, batchId) {
  return db.prepare('SELECT * FROM content_batches WHERE user_id = ? AND id = ?').get(userId, batchId) ?? null;
}

export function listContentBatchRows(db, userId, projectId, limit = 20) {
  return db
    .prepare('SELECT * FROM content_batches WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(userId, projectId, limit);
}

export function contentBatchItems(db, userId, batchId) {
  return db
    .prepare('SELECT * FROM content_batch_items WHERE user_id = ? AND batch_id = ? ORDER BY ordinal ASC, item_key ASC')
    .all(userId, batchId)
    .map(batchItem);
}

export function contentBatchDetail(db, row) {
  return { ...batchSummary(row), items: contentBatchItems(db, row.user_id, row.id) };
}

export function countContentBatches(db, userId, projectId) {
  const row = db
    .prepare('SELECT COUNT(*) AS total FROM content_batches WHERE user_id = ? AND project_id = ?')
    .get(userId, projectId);
  return Number(row?.total ?? 0);
}

/* ------------------------------------------------------------------ */
/* Scene writes (inside the batch transaction)                         */
/* ------------------------------------------------------------------ */

export function countAccountScenes(db, userId) {
  const row = db.prepare('SELECT COUNT(*) AS total FROM scenes WHERE user_id = ?').get(userId);
  return Number(row?.total ?? 0);
}

export function insertSceneRow(db, { userId, scene, nowMs }) {
  db.prepare(
    `INSERT INTO scenes (user_id, id, title, platform, message_count, revision, scene_json, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(userId, scene.id, scene.title, scene.platform, scene.messages.length, JSON.stringify(scene), nowIso(nowMs));
}

export function attachSceneRow(db, { userId, projectId, sceneId, nowMs }) {
  db.prepare(
    'INSERT OR IGNORE INTO scene_projects (user_id, scene_id, project_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(userId, sceneId, projectId, nowIso(nowMs));
}

/** Fresh project-scoped UUID for a scene id (never accepts a caller id). */
export function newSceneId() {
  return crypto.randomUUID();
}

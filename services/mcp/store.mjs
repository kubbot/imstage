// Isolated persistent store for the IMStage MCP server.
//
// Scope guarantees:
//   - uses Node's built-in `node:sqlite` only, configured by IMSTAGE_MCP_DATA_DIR
//   - never opens or migrates the product/API database
//   - one file (`mcp.sqlite`) plus WAL sidecars in the configured directory
//
// Optimistic concurrency:
//   - every scene row carries a monotonically increasing `revision`
//   - every revision is also copied into `scene_snapshots`, so a caller can
//     read any historical revision by id
//   - create/update accept an optional idempotency key. A retry with the same
//     key and the same canonical request returns the first result instead of
//     creating a duplicate scene or bumping the revision twice.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fail } from './errors.mjs';
import { MAX_STORED_RENDERS } from './limits.mjs';
import { nowIso } from './util.mjs';
import { installTemplateSchema } from '../templates/store.mjs';

export const STORE_SCHEMA_VERSION = 1;
export const STORE_FILE_NAME = 'mcp.sqlite';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mcp_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenes (
  id          TEXT PRIMARY KEY,
  revision    INTEGER NOT NULL,
  scene_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scene_snapshots (
  scene_id   TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  scene_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scene_id, revision)
);
CREATE TABLE IF NOT EXISTS idempotency (
  key           TEXT PRIMARY KEY,
  operation     TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS renders (
  render_id    TEXT PRIMARY KEY,
  scene_id     TEXT,
  revision     INTEGER,
  png_base64   TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  bytes        INTEGER NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  title        TEXT NOT NULL,
  output_kind  TEXT NOT NULL,
  surface      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_renders_created ON renders(created_at DESC);

-- Instance-scoped projects, batches and their produced scene references.
-- Deliberately separate from any Web account database.
CREATE TABLE IF NOT EXISTS mcp_projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  rules         TEXT NOT NULL DEFAULT '',
  defaults_json TEXT NOT NULL DEFAULT '{}',
  revision      INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_batches (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  template_id       TEXT,
  template_revision INTEGER,
  template_json     TEXT,
  rules             TEXT NOT NULL DEFAULT '',
  client_key        TEXT,
  request_hash      TEXT NOT NULL,
  item_count        INTEGER NOT NULL,
  receipt_json      TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_batches_client ON mcp_batches(client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mcp_batches_project ON mcp_batches(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS mcp_batch_items (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL,
  ordinal     INTEGER NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  prompt      TEXT NOT NULL DEFAULT '',
  scene_id    TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  values_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_mcp_batch_items_batch ON mcp_batch_items(batch_id, ordinal);
`;

export const MCP_PROJECT_LIMIT = 50;
export const MCP_BATCH_LIMIT = 20;
export const MCP_STORED_BATCH_LIMIT = 500;

function isSqliteError(error) {
  return Boolean(error && error.code === 'ERR_SQLITE_ERROR');
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort on exotic filesystems */
    }
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA_SQL);
  // Reuse the shared owner-scoped template store inside this isolated database.
  // The instance scope is an explicit constant, never a Web user id.
  installTemplateSchema(db);
  db.prepare('INSERT OR REPLACE INTO mcp_meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(STORE_SCHEMA_VERSION),
  );
  if (dbPath !== ':memory:') {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.chmodSync(`${dbPath}${suffix}`, 0o600);
      } catch {
        /* file may not exist yet */
      }
    }
  }
  return db;
}

function withTransaction(db, fn) {
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

function parseSceneRow(row) {
  return { id: row.id, revision: Number(row.revision), scene: JSON.parse(row.scene_json), updatedAt: row.updated_at };
}

function parseSnapshotRow(row) {
  return {
    id: row.scene_id,
    revision: Number(row.revision),
    scene: JSON.parse(row.scene_json),
    updatedAt: row.created_at,
  };
}

/**
 * @param {{ dataDir: string, maxStoredRenders?: number }} options
 */
export function openStore({ dataDir, maxStoredRenders = MAX_STORED_RENDERS } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new Error('openStore 需要 IMSTAGE_MCP_DATA_DIR 解析出的绝对路径');
  }
  const dbPath = path.join(path.resolve(dataDir), STORE_FILE_NAME);
  const db = openDatabase(dbPath);
  return new Store(db, { dbPath, maxStoredRenders });
}

class Store {
  constructor(db, { dbPath, maxStoredRenders }) {
    this.db = db;
    this.dbPath = dbPath;
    this.maxStoredRenders = maxStoredRenders;
  }

  #checkCapacity(scene, creating) {
    const totals = this.db.prepare('SELECT count(*) AS count, coalesce(sum(length(cast(scene_json AS blob))),0) AS bytes FROM scene_snapshots').get();
    const scenes = this.db.prepare('SELECT count(*) AS count FROM scenes').get().count;
    if (totals.count >= 5000 || totals.bytes + Buffer.byteLength(JSON.stringify(scene)) > 512 * 1024 * 1024 || (creating && scenes >= 1000)) {
      fail('storage_limit', '作品存储达到容量上限；已保存作品保持不变，请先导出并由所有者管理存储。', {status:429});
    }
  }

  rememberIdempotent(key, operation, requestHash, response) {
    if(!key) return;
    return withTransaction(this.db, () => {
      const prior=this.#readIdempotent(key,operation,requestHash);
      if(prior) return prior;
      this.#writeIdempotent(key,operation,requestHash,response);
      return response;
    });
  }

  #readIdempotent(key, operation, requestHash) {
    if (!key) return null;
    const row = this.db
      .prepare('SELECT operation, request_hash, response_json FROM idempotency WHERE key = ?')
      .get(key);
    if (!row) return null;
    if (row.operation !== operation || row.request_hash !== requestHash) {
      fail('idempotency_conflict', '该 idempotencyKey 已用于不同的请求内容', {
        details: { idempotencyKey: key, operation: row.operation },
        recovery: '换一个新的 idempotencyKey 重试；重试同一操作时必须复用完全相同的请求体。',
        status: 409,
      });
    }
    return JSON.parse(row.response_json);
  }

  #writeIdempotent(key, operation, requestHash, response) {
    if (!key) return;
    this.db
      .prepare(
        'INSERT INTO idempotency (key, operation, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(key, operation, requestHash, JSON.stringify(response), nowIso());
  }

  /**
   * Public read of a recorded idempotent response. Returns null when the key
   * is unknown; throws `idempotency_conflict` when the key was used for a
   * different operation or request body.
   */
  findIdempotentResponse(key, operation, requestHash) {
    return this.#readIdempotent(key, operation, requestHash);
  }

  createScene({ scene, requestHash, idempotencyKey = null }) {
    return withTransaction(this.db, () => {
      const existing = this.#readIdempotent(idempotencyKey, 'create_scene', requestHash);
      if (existing) return { ...existing, deduplicated: true };

      this.#checkCapacity(scene, true);
      const timestamp = nowIso();
      try {
        this.db
          .prepare('INSERT INTO scenes (id, revision, scene_json, created_at, updated_at) VALUES (?, 1, ?, ?, ?)')
          .run(scene.id, JSON.stringify(scene), timestamp, timestamp);
      } catch (error) {
        if (isSqliteError(error) && /UNIQUE/i.test(String(error.message))) {
          fail('scene_exists', `场景 id 已存在：${scene.id}`, {
            details: { sceneId: scene.id },
            recovery: '重新调用 imstage_create_scene 获取新的服务端 id。',
            status: 409,
          });
        }
        throw error;
      }
      this.db
        .prepare('INSERT INTO scene_snapshots (scene_id, revision, scene_json, created_at) VALUES (?, 1, ?, ?)')
        .run(scene.id, JSON.stringify(scene), timestamp);

      const response = { sceneId: scene.id, revision: 1, updatedAt: timestamp };
      this.#writeIdempotent(idempotencyKey, 'create_scene', requestHash, response);
      return { ...response, deduplicated: false };
    });
  }

  updateScene({ sceneId, expectedRevision, scene, requestHash, idempotencyKey = null }) {
    return withTransaction(this.db, () => {
      const existing = this.#readIdempotent(idempotencyKey, 'update_scene', requestHash);
      if (existing) return { ...existing, deduplicated: true };

      const row = this.db.prepare('SELECT revision FROM scenes WHERE id = ?').get(sceneId);
      if (!row) {
        fail('scene_not_found', `场景不存在：${sceneId}`, {
          details: { sceneId },
          recovery: '调用 imstage_create_scene 创建新场景，或核对 sceneId。',
          status: 404,
        });
      }
      this.#checkCapacity(scene, false);
      const currentRevision = Number(row.revision);
      if (currentRevision !== expectedRevision) {
        fail('revision_conflict', `场景已被更新：期望 revision ${expectedRevision}，当前 ${currentRevision}`, {
          details: { sceneId, expectedRevision, currentRevision },
          recovery: `调用 imstage_get_scene 读取 revision ${currentRevision} 的最新场景，将 patch 重新应用到该版本后，用 expectedRevision=${currentRevision} 重试。`,
          status: 409,
        });
      }
      const nextRevision = currentRevision + 1;
      const timestamp = nowIso();
      const sceneJson = JSON.stringify(scene);
      const result = this.db
        .prepare('UPDATE scenes SET revision = ?, scene_json = ?, updated_at = ? WHERE id = ? AND revision = ?')
        .run(nextRevision, sceneJson, timestamp, sceneId, expectedRevision);
      if (result.changes !== 1) {
        // Another writer won between the read and the update (multi-process).
        const latest = this.db.prepare('SELECT revision FROM scenes WHERE id = ?').get(sceneId);
        fail('revision_conflict', '场景已被并发更新', {
          details: { sceneId, expectedRevision, currentRevision: latest ? Number(latest.revision) : null },
          recovery: '调用 imstage_get_scene 读取最新 revision，重新应用 patch 后重试。',
          status: 409,
        });
      }
      this.db
        .prepare('INSERT INTO scene_snapshots (scene_id, revision, scene_json, created_at) VALUES (?, ?, ?, ?)')
        .run(sceneId, nextRevision, sceneJson, timestamp);

      const response = { sceneId, revision: nextRevision, updatedAt: timestamp };
      this.#writeIdempotent(idempotencyKey, 'update_scene', requestHash, response);
      return { ...response, deduplicated: false };
    });
  }

  /** Latest scene, or a specific historical snapshot. */
  getScene(sceneId, revision = null) {
    if (Number.isInteger(revision)) {
      const row = this.db
        .prepare('SELECT scene_id, revision, scene_json, created_at FROM scene_snapshots WHERE scene_id = ? AND revision = ?')
        .get(sceneId, revision);
      if (!row) return null;
      return parseSnapshotRow(row);
    }
    const row = this.db
      .prepare('SELECT id, revision, scene_json, updated_at FROM scenes WHERE id = ?')
      .get(sceneId);
    return row ? parseSceneRow(row) : null;
  }

  currentRevision(sceneId) {
    const row = this.db.prepare('SELECT revision FROM scenes WHERE id = ?').get(sceneId);
    return row ? Number(row.revision) : null;
  }

  listSceneRevisions(sceneId) {
    return this.db
      .prepare('SELECT revision, created_at FROM scene_snapshots WHERE scene_id = ? ORDER BY revision ASC')
      .all(sceneId)
      .map((row) => ({ revision: Number(row.revision), createdAt: row.created_at }));
  }

  saveRender(record) {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO renders (render_id, scene_id, revision, png_base64, sha256, bytes, width, height, title, output_kind, surface, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(render_id) DO UPDATE SET
           png_base64 = excluded.png_base64,
           sha256 = excluded.sha256,
           bytes = excluded.bytes,
           width = excluded.width,
           height = excluded.height,
           title = excluded.title,
           output_kind = excluded.output_kind,
           surface = excluded.surface,
           created_at = excluded.created_at`,
      )
      .run(
        record.renderId,
        record.sceneId ?? null,
        Number.isInteger(record.revision) ? record.revision : null,
        record.pngBase64,
        record.sha256,
        record.bytes,
        record.width,
        record.height,
        record.title,
        record.outputKind,
        record.surface,
        timestamp,
      );
    this.db
      .prepare(
        `DELETE FROM renders WHERE render_id NOT IN (
           SELECT render_id FROM renders ORDER BY created_at DESC, render_id DESC LIMIT ?
         )`,
      )
      .run(this.maxStoredRenders);
    return { ...record, createdAt: timestamp };
  }

  getRender(renderId) {
    const row = this.db.prepare('SELECT * FROM renders WHERE render_id = ?').get(renderId);
    if (!row) return null;
    return {
      renderId: row.render_id,
      sceneId: row.scene_id,
      revision: row.revision === null ? null : Number(row.revision),
      pngBase64: row.png_base64,
      sha256: row.sha256,
      bytes: Number(row.bytes),
      width: Number(row.width),
      height: Number(row.height),
      title: row.title,
      outputKind: row.output_kind,
      surface: row.surface,
      createdAt: row.created_at,
    };
  }

  countRenders() {
    return Number(this.db.prepare('SELECT COUNT(*) AS total FROM renders').get().total);
  }

  /* ---------------------------------------------------------------- */
  /* Instance projects                                                 */
  /* ---------------------------------------------------------------- */

  #projectItem(row, batchCount = 0) {
    return {
      projectId: row.id,
      name: row.name,
      rules: row.rules,
      defaults: JSON.parse(row.defaults_json || '{}'),
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      batchCount: Number(batchCount),
    };
  }

  createProject({ projectId, name, rules, defaults, nowMs = Date.now() }) {
    const stamp = nowIso(nowMs);
    withTransaction(this.db, () => {
      const count = Number(this.db.prepare('SELECT COUNT(*) AS total FROM mcp_projects').get().total);
      if (count >= MCP_PROJECT_LIMIT) {
        fail('storage_limit', `项目数量达到上限（${MCP_PROJECT_LIMIT}）`, { status: 429 });
      }
      this.db
        .prepare('INSERT INTO mcp_projects (id, name, rules, defaults_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(projectId, name, rules, JSON.stringify(defaults), stamp, stamp);
    });
    return this.getProject(projectId);
  }

  updateProject({ projectId, expectedRevision, name, rules, defaults, nowMs = Date.now() }) {
    const stamp = nowIso(nowMs);
    withTransaction(this.db, () => {
      const row = this.db.prepare('SELECT revision FROM mcp_projects WHERE id = ?').get(projectId);
      if (!row) fail('project_not_found', `项目不存在：${projectId}`, { details: { projectId }, status: 404 });
      if (Number(row.revision) !== expectedRevision) {
        fail('revision_conflict', `项目已被更新：期望 revision ${expectedRevision}，当前 ${Number(row.revision)}`, {
          details: { projectId, expectedRevision, currentRevision: Number(row.revision) },
          recovery: '调用 imstage_get_project 读取最新 revision，重新提交。',
          status: 409,
        });
      }
      this.db
        .prepare('UPDATE mcp_projects SET name = ?, rules = ?, defaults_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
        .run(name, rules, JSON.stringify(defaults), stamp, projectId, expectedRevision);
    });
    return this.getProject(projectId);
  }

  getProject(projectId) {
    const row = this.db.prepare('SELECT * FROM mcp_projects WHERE id = ?').get(projectId);
    if (!row) return null;
    return this.#projectItem(row, this.db.prepare('SELECT COUNT(*) AS total FROM mcp_batches WHERE project_id = ?').get(projectId).total);
  }

  listProjects() {
    return this.db
      .prepare('SELECT * FROM mcp_projects ORDER BY updated_at DESC, id ASC')
      .all()
      .map((row) => this.#projectItem(row, this.db.prepare('SELECT COUNT(*) AS total FROM mcp_batches WHERE project_id = ?').get(row.id).total));
  }

  /* ---------------------------------------------------------------- */
  /* Deterministic batches                                             */
  /* ---------------------------------------------------------------- */

  /** A previously stored batch for an idempotency key, or null. */
  findBatchByClientKey(clientKey, requestHash) {
    if (!clientKey) return null;
    const row = this.db.prepare('SELECT id, request_hash FROM mcp_batches WHERE client_key = ?').get(clientKey);
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      fail('idempotency_conflict', '该 clientIdempotencyKey 已用于不同的批次内容', {
        details: { clientIdempotencyKey: clientKey },
        recovery: '换一个新的 clientIdempotencyKey 重试；重试同一批次时必须复用完全相同的请求体。',
        status: 409,
      });
    }
    return this.getBatch(row.id);
  }

  /**
   * Write every produced scene, its snapshot, the batch receipt and the item
   * references in one transaction. Any validation/capacity failure rolls the
   * whole batch back so a retry never leaves partial scenes behind.
   */
  createBatch({ projectId, templateId = null, templateRevision = null, templateDefinition = null, rules = '', items, clientKey = null, requestHash, nowMs = Date.now() }) {
    if (!Array.isArray(items) || items.length === 0) fail('invalid_request', '批次至少需要 1 个条目');
    if (items.length > MCP_BATCH_LIMIT) fail('limit_exceeded', `每批最多 ${MCP_BATCH_LIMIT} 个条目`);
    const batchId = `bat_${crypto.randomBytes(12).toString('hex')}`;
    const stamp = nowIso(nowMs);
    return withTransaction(this.db, () => {
      if (clientKey) {
        const existing = this.db.prepare('SELECT id, request_hash FROM mcp_batches WHERE client_key = ?').get(clientKey);
        if (existing) {
          if (existing.request_hash !== requestHash) {
            fail('idempotency_conflict', '该 clientIdempotencyKey 已用于不同的批次内容', { details: { clientIdempotencyKey: clientKey }, status: 409 });
          }
          return { ...this.getBatch(existing.id), deduplicated: true };
        }
      }
      const stored = Number(this.db.prepare('SELECT COUNT(*) AS total FROM mcp_batches').get().total);
      if (stored >= MCP_STORED_BATCH_LIMIT) fail('storage_limit', `批次存储达到上限（${MCP_STORED_BATCH_LIMIT}）`, { status: 429 });
      const scenes = this.db.prepare('SELECT COUNT(*) AS total FROM scenes').get().total;
      if (Number(scenes) + items.length > 1000) fail('storage_limit', '作品存储达到容量上限；请先由所有者管理存储。', { status: 429 });

      const insertScene = this.db.prepare('INSERT INTO scenes (id, revision, scene_json, created_at, updated_at) VALUES (?, 1, ?, ?, ?)');
      const insertSnapshot = this.db.prepare('INSERT INTO scene_snapshots (scene_id, revision, scene_json, created_at) VALUES (?, 1, ?, ?)');
      const insertItem = this.db.prepare('INSERT INTO mcp_batch_items (id, batch_id, ordinal, name, prompt, scene_id, revision, values_json) VALUES (?, ?, ?, ?, ?, ?, 1, ?)');
      const descriptors = [];
      items.forEach((item, index) => {
        const sceneJson = JSON.stringify(item.scene);
        this.#checkCapacity(item.scene, true);
        try {
          insertScene.run(item.scene.id, sceneJson, stamp, stamp);
        } catch (error) {
          if (isSqliteError(error) && /UNIQUE/i.test(String(error.message))) {
            fail('scene_exists', `场景 id 已存在：${item.scene.id}`, { details: { sceneId: item.scene.id }, status: 409 });
          }
          throw error;
        }
        insertSnapshot.run(item.scene.id, sceneJson, stamp);
        insertItem.run(crypto.randomUUID(), batchId, index, item.name ?? '', item.prompt ?? '', item.scene.id, JSON.stringify(item.values ?? {}));
        descriptors.push({ ordinal: index, name: item.name ?? '', prompt: item.prompt ?? '', sceneId: item.scene.id, revision: 1, values: item.values ?? {} });
      });
      const receipt = {
        batchId,
        projectId,
        templateId,
        templateRevision,
        rules,
        createdAt: stamp,
        items: descriptors.map(({ ordinal, name: itemName, prompt, sceneId, revision }) => ({ ordinal, name: itemName, prompt, sceneId, revision })),
      };
      this.db
        .prepare('INSERT INTO mcp_batches (id, project_id, template_id, template_revision, template_json, rules, client_key, request_hash, item_count, receipt_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(batchId, projectId, templateId, templateRevision, templateDefinition ? JSON.stringify(templateDefinition) : null, rules, clientKey, requestHash, items.length, JSON.stringify(receipt), stamp);
      return { ...this.getBatch(batchId), deduplicated: false };
    });
  }

  getBatch(batchId) {
    const row = this.db.prepare('SELECT * FROM mcp_batches WHERE id = ?').get(batchId);
    if (!row) return null;
    const items = this.db
      .prepare('SELECT * FROM mcp_batch_items WHERE batch_id = ? ORDER BY ordinal ASC, id ASC')
      .all(batchId)
      .map((item) => ({
        itemId: item.id,
        ordinal: Number(item.ordinal),
        name: item.name,
        prompt: item.prompt,
        sceneId: item.scene_id,
        revision: Number(item.revision),
        values: JSON.parse(item.values_json || '{}'),
      }));
    return {
      batchId: row.id,
      projectId: row.project_id,
      templateId: row.template_id ?? null,
      templateRevision: row.template_revision === null || row.template_revision === undefined ? null : Number(row.template_revision),
      template: row.template_json ? JSON.parse(row.template_json) : null,
      rules: row.rules,
      itemCount: Number(row.item_count),
      createdAt: row.created_at,
      receipt: JSON.parse(row.receipt_json),
      items,
    };
  }

  listBatches({ projectId = null, limit = 20 } = {}) {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM mcp_batches WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(projectId, Math.min(Math.max(1, limit), 100))
      : this.db.prepare('SELECT * FROM mcp_batches ORDER BY created_at DESC, id DESC LIMIT ?').all(Math.min(Math.max(1, limit), 100));
    return rows.map((row) => ({
      batchId: row.id,
      projectId: row.project_id,
      templateId: row.template_id ?? null,
      templateRevision: row.template_revision === null || row.template_revision === undefined ? null : Number(row.template_revision),
      itemCount: Number(row.item_count),
      createdAt: row.created_at,
      sceneIds: JSON.parse(row.receipt_json).items.map((item) => item.sceneId),
    }));
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * IMStage Project Exports — SQLite persistence (additive schema).
 *
 * Three tables, all owner-scoped:
 *   - `project_exports`: one frozen deterministic delivery job (snapshot refs,
 *     run status/phase, principal reference, output receipt);
 *   - `project_export_items`: one row per exported case (frozen Scene JSON and
 *     hash, per-item render result or bounded error);
 *   - `project_export_tickets`: short-lived download capabilities — only the
 *     SHA-256 of the opaque ticket is stored, never the ticket itself and never
 *     a raw access token.
 *
 * Status vocabulary (run): queued / running / completed / partial / failed /
 * cancelled / interrupted. Phase (running): validating / rendering / packaging.
 * Delivery lifecycle is separate: active → expired (files purged, metadata kept
 * so the UI can honestly show "expired" instead of a dead link).
 */

export const EXPORT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS project_exports (
    user_id          TEXT NOT NULL,
    id               TEXT NOT NULL,
    project_id       TEXT NOT NULL,
    scenario_id      TEXT,
    scope_json       TEXT NOT NULL DEFAULT '{}',
    status           TEXT NOT NULL,
    phase            TEXT NOT NULL DEFAULT '',
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    client_key       TEXT,
    request_hash     TEXT NOT NULL,
    fingerprint      TEXT NOT NULL DEFAULT '',
    frozen_json      TEXT NOT NULL DEFAULT '{}',
    principal_kind   TEXT NOT NULL,
    principal_id     TEXT NOT NULL,
    allow_partial    INTEGER NOT NULL DEFAULT 0,
    render_options_json TEXT NOT NULL DEFAULT '{}',
    error_code       TEXT,
    error_message    TEXT,
    item_count       INTEGER NOT NULL DEFAULT 0,
    zip_path         TEXT,
    zip_bytes        INTEGER,
    zip_sha256       TEXT,
    delivery_state   TEXT NOT NULL DEFAULT 'active',
    origin           TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    started_at       TEXT,
    finished_at      TEXT,
    expires_at       TEXT,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_project_exports_project ON project_exports(user_id, project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_project_exports_active ON project_exports(status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_exports_client
    ON project_exports(user_id, project_id, client_key) WHERE client_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS project_export_items (
    user_id          TEXT NOT NULL,
    export_id        TEXT NOT NULL,
    item_id          TEXT NOT NULL,
    item_key         TEXT NOT NULL,
    ordinal          INTEGER NOT NULL,
    scenario_id      TEXT,
    name             TEXT NOT NULL DEFAULT '',
    objective        TEXT NOT NULL DEFAULT '',
    context          TEXT NOT NULL DEFAULT '',
    annotations_json TEXT NOT NULL DEFAULT '{}',
    scene_id         TEXT,
    scene_revision   INTEGER,
    scene_json       TEXT NOT NULL DEFAULT '{}',
    scene_hash       TEXT NOT NULL DEFAULT '',
    dialogue_hash    TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'pending',
    reused           INTEGER NOT NULL DEFAULT 0,
    png_bytes        INTEGER,
    png_sha256       TEXT,
    png_width        INTEGER,
    png_height       INTEGER,
    error_code       TEXT,
    error_message    TEXT,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (user_id, export_id, item_id),
    FOREIGN KEY (user_id, export_id) REFERENCES project_exports(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_project_export_items_scene ON project_export_items(user_id, scene_hash);

  CREATE TABLE IF NOT EXISTS project_export_tickets (
    ticket_hash      TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    export_id        TEXT NOT NULL,
    principal_kind   TEXT NOT NULL,
    principal_id     TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    revoked_at       TEXT,
    FOREIGN KEY (user_id, export_id) REFERENCES project_exports(user_id, id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_project_export_tickets_export ON project_export_tickets(user_id, export_id);
`;

export function installExportSchema(db) {
  db.exec(EXPORT_SCHEMA_SQL);
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function isoAt(ms) {
  return new Date(ms).toISOString();
}

/** Short synchronous transaction (node:sqlite is synchronous). */
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
/* Exports                                                             */
/* ------------------------------------------------------------------ */

export function insertExport(db, { exportRow, items, nowMs }) {
  const stamp = isoAt(nowMs);
  db.prepare(
    `INSERT INTO project_exports
       (user_id, id, project_id, scenario_id, scope_json, status, phase, cancel_requested, client_key, request_hash,
        fingerprint, frozen_json, principal_kind, principal_id, allow_partial, render_options_json,
        error_code, error_message, item_count, zip_path, zip_bytes, zip_sha256, delivery_state, origin,
        created_at, updated_at, started_at, finished_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'queued', '', 0, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, 'active', ?, ?, ?, NULL, NULL, ?)`,
  ).run(
    exportRow.userId,
    exportRow.id,
    exportRow.projectId,
    exportRow.scenarioId ?? null,
    JSON.stringify(exportRow.scope ?? {}),
    exportRow.clientKey ?? null,
    exportRow.requestHash,
    exportRow.fingerprint,
    JSON.stringify(exportRow.frozen ?? {}),
    exportRow.principal.kind,
    exportRow.principal.id,
    exportRow.allowPartial ? 1 : 0,
    JSON.stringify(exportRow.renderOptions ?? {}),
    items.length,
    exportRow.origin ?? '',
    stamp,
    stamp,
    // Bounded retention from creation: even a failed/interrupted snapshot
    // never lives forever in the DB.
    exportRow.expiresAt ?? isoAt(nowMs + 7 * 24 * 60 * 60 * 1000),
  );
  const insertItem = db.prepare(
    `INSERT INTO project_export_items
       (user_id, export_id, item_id, item_key, ordinal, scenario_id, name, objective, context, annotations_json,
        scene_id, scene_revision, scene_json, scene_hash, dialogue_hash, status, reused, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
  );
  for (const item of items) {
    insertItem.run(
      exportRow.userId,
      exportRow.id,
      item.itemId,
      item.itemKey,
      item.ordinal,
      item.scenarioId ?? null,
      item.name ?? '',
      item.objective ?? '',
      item.context ?? '',
      JSON.stringify(item.annotations ?? {}),
      item.sceneId ?? null,
      item.sceneRevision ?? null,
      JSON.stringify(item.scene ?? {}),
      item.sceneHash ?? '',
      item.dialogueHash ?? '',
      stamp,
    );
  }
}

export function getExportRow(db, userId, exportId) {
  return db.prepare('SELECT * FROM project_exports WHERE user_id = ? AND id = ?').get(userId, exportId) ?? null;
}

export function findExportByClientKey(db, userId, projectId, clientKey) {
  if (!clientKey) return null;
  return (
    db
      .prepare('SELECT * FROM project_exports WHERE user_id = ? AND project_id = ? AND client_key = ?')
      .get(userId, projectId, clientKey) ?? null
  );
}

export function findExportByFingerprint(db, userId, projectId, scenarioId, fingerprint) {
  return (
    db
      .prepare(
        `SELECT * FROM project_exports
         WHERE user_id = ? AND project_id = ? AND fingerprint = ?
           AND delivery_state = 'active'
           AND (? IS NULL AND scenario_id IS NULL OR scenario_id = ?)
         ORDER BY created_at DESC, id ASC`,
      )
      .get(userId, projectId, fingerprint, scenarioId ?? null, scenarioId ?? null) ?? null
  );
}

export function listExportRows(db, userId, projectId, limit = 20) {
  return db
    .prepare('SELECT * FROM project_exports WHERE user_id = ? AND project_id = ? ORDER BY created_at DESC, id ASC LIMIT ?')
    .all(userId, projectId, limit);
}

/** All viable deliveries, streamed without frozen payloads or a UI history limit. */
export function iterateCurrentDeliveryRows(db, userId, projectId, nowMs) {
  return db.prepare(`SELECT user_id, id, project_id, scenario_id, scope_json, status, phase,
    cancel_requested, fingerprint, allow_partial, render_options_json, error_code, error_message,
    item_count, zip_path, zip_bytes, zip_sha256, delivery_state, origin, created_at, updated_at,
    started_at, finished_at, expires_at, principal_kind
    FROM project_exports WHERE user_id = ? AND project_id = ? AND status = 'completed'
      AND delivery_state = 'active' AND zip_path IS NOT NULL
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC, id ASC`).iterate(userId, projectId, isoAt(nowMs));
}

export function countActiveExports(db, userId) {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM project_exports WHERE user_id = ? AND status IN ('queued', 'running')")
    .get(userId);
  return Number(row?.total ?? 0);
}

/** Active exports of ONE project (unrelated account exports never count). */
export function countActiveExportsForProject(db, userId, projectId) {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM project_exports WHERE user_id = ? AND project_id = ? AND status IN ('queued', 'running')")
    .get(userId, projectId);
  return Number(row?.total ?? 0);
}

export function updateExportStatus(db, userId, exportId, patch, nowMs) {
  const fields = [];
  const values = [];
  for (const [key, column] of [
    ['status', 'status'],
    ['phase', 'phase'],
    ['errorCode', 'error_code'],
    ['errorMessage', 'error_message'],
    ['startedAt', 'started_at'],
    ['finishedAt', 'finished_at'],
    ['expiresAt', 'expires_at'],
    ['deliveryState', 'delivery_state'],
    ['zipPath', 'zip_path'],
    ['zipBytes', 'zip_bytes'],
    ['zipSha256', 'zip_sha256'],
  ]) {
    if (patch[key] !== undefined) {
      fields.push(`${column} = ?`);
      values.push(patch[key]);
    }
  }
  if (patch.cancelRequested !== undefined) {
    fields.push('cancel_requested = ?');
    values.push(patch.cancelRequested ? 1 : 0);
  }
  if (fields.length === 0) return;
  fields.push('updated_at = ?');
  values.push(isoAt(nowMs), userId, exportId);
  db.prepare(`UPDATE project_exports SET ${fields.join(', ')} WHERE user_id = ? AND id = ?`).run(...values);
}

export function requestCancel(db, userId, exportId, nowMs) {
  db.prepare('UPDATE project_exports SET cancel_requested = 1, updated_at = ? WHERE user_id = ? AND id = ?').run(
    isoAt(nowMs),
    userId,
    exportId,
  );
}

/** Claim the oldest queued export for the shared single worker. */
export function claimNextExport(db, nowMs) {
  const row = db
    .prepare("SELECT * FROM project_exports WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1")
    .get();
  if (!row) return null;
  const result = db
    .prepare("UPDATE project_exports SET status = 'running', phase = 'validating', started_at = ?, updated_at = ? WHERE user_id = ? AND id = ? AND status = 'queued'")
    .run(isoAt(nowMs), isoAt(nowMs), row.user_id, row.id);
  if (Number(result.changes) !== 1) return null;
  return getExportRow(db, row.user_id, row.id);
}

/* ------------------------------------------------------------------ */
/* Items                                                               */
/* ------------------------------------------------------------------ */

const ITEM_SUMMARY_COLUMNS =
  'user_id, export_id, item_id, item_key, ordinal, scenario_id, name, objective, context, annotations_json, ' +
  'scene_id, scene_revision, scene_hash, dialogue_hash, status, reused, png_bytes, png_sha256, png_width, png_height, error_code, error_message, updated_at';

/** Item metadata WITHOUT the frozen scene blob — safe for status payloads. */
export function itemSummary(row) {
  return {
    itemId: row.item_id,
    itemKey: row.item_key,
    ordinal: Number(row.ordinal),
    scenarioId: row.scenario_id ?? null,
    name: row.name,
    objective: row.objective,
    context: row.context,
    annotations: parseJson(row.annotations_json, {}),
    sceneId: row.scene_id ?? null,
    sceneRevision: row.scene_revision === null || row.scene_revision === undefined ? null : Number(row.scene_revision),
    sceneHash: row.scene_hash ?? '',
    dialogueHash: row.dialogue_hash ?? '',
    status: row.status,
    reused: Number(row.reused) === 1,
    png: row.png_sha256
      ? {
          bytes: Number(row.png_bytes ?? 0),
          sha256: row.png_sha256,
          width: row.png_width === null || row.png_width === undefined ? null : Number(row.png_width),
          height: row.png_height === null || row.png_height === undefined ? null : Number(row.png_height),
        }
      : null,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
    updatedAt: row.updated_at,
  };
}

/** Bounded summaries only — never loads scene_json blobs. */
export function listExportItemSummaries(db, userId, exportId) {
  return db
    .prepare(`SELECT ${ITEM_SUMMARY_COLUMNS} FROM project_export_items WHERE user_id = ? AND export_id = ? ORDER BY ordinal ASC, item_id ASC`)
    .all(userId, exportId)
    .map(itemSummary);
}

/** One item WITH its frozen scene JSON (worker reads one at a time). */
export function getExportItemWithScene(db, userId, exportId, itemId) {
  const row = db
    .prepare('SELECT * FROM project_export_items WHERE user_id = ? AND export_id = ? AND item_id = ?')
    .get(userId, exportId, itemId);
  return row ? { ...itemSummary(row), scene: parseJson(row.scene_json, {}) } : null;
}

export function updateExportItem(db, userId, exportId, itemId, patch, nowMs) {
  const fields = [];
  const values = [];
  for (const [key, column] of [
    ['status', 'status'],
    ['errorCode', 'error_code'],
    ['errorMessage', 'error_message'],
    ['pngBytes', 'png_bytes'],
    ['pngSha256', 'png_sha256'],
    ['pngWidth', 'png_width'],
    ['pngHeight', 'png_height'],
  ]) {
    if (patch[key] !== undefined) {
      fields.push(`${column} = ?`);
      values.push(patch[key]);
    }
  }
  if (patch.reused !== undefined) {
    fields.push('reused = ?');
    values.push(patch.reused ? 1 : 0);
  }
  fields.push('updated_at = ?');
  values.push(isoAt(nowMs), userId, exportId, itemId);
  db.prepare(`UPDATE project_export_items SET ${fields.join(', ')} WHERE user_id = ? AND export_id = ? AND item_id = ?`).run(...values);
}

export function resetRetryableItems(db, userId, exportId, nowMs) {
  db.prepare(
    `UPDATE project_export_items SET status = 'pending', error_code = NULL, error_message = NULL, updated_at = ?
     WHERE user_id = ? AND export_id = ? AND status IN ('failed', 'pending', 'cancelled', 'interrupted')`,
  ).run(isoAt(nowMs), userId, exportId);
}

export function markUnfinishedItems(db, userId, exportId, status, message, code, nowMs) {
  db.prepare(
    `UPDATE project_export_items SET status = ?, error_code = COALESCE(error_code, ?), error_message = COALESCE(error_message, ?), updated_at = ?
     WHERE user_id = ? AND export_id = ? AND status IN ('pending', 'rendering')`,
  ).run(status, code, message, isoAt(nowMs), userId, exportId);
}

/* ------------------------------------------------------------------ */
/* Tickets                                                             */
/* ------------------------------------------------------------------ */

export function insertTicket(db, { ticketHash, userId, exportId, principal, nowMs, ttlMs }) {
  const stamp = isoAt(nowMs);
  db.prepare(
    `INSERT INTO project_export_tickets (ticket_hash, user_id, export_id, principal_kind, principal_id, created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(ticketHash, userId, exportId, principal.kind, principal.id, stamp, isoAt(nowMs + ttlMs));
}

export function getTicketRow(db, ticketHash, nowMs) {
  return (
    db
      .prepare('SELECT * FROM project_export_tickets WHERE ticket_hash = ? AND revoked_at IS NULL AND expires_at > ?')
      .get(ticketHash, isoAt(nowMs)) ?? null
  );
}

export function revokeTicketsForExport(db, userId, exportId, nowMs) {
  db.prepare('UPDATE project_export_tickets SET revoked_at = ? WHERE user_id = ? AND export_id = ? AND revoked_at IS NULL').run(
    isoAt(nowMs),
    userId,
    exportId,
  );
}

export function deleteTicketsForExport(db, userId, exportId) {
  db.prepare('DELETE FROM project_export_tickets WHERE user_id = ? AND export_id = ?').run(userId, exportId);
}

export function deleteExpiredTickets(db, nowMs) {
  return Number(db.prepare('DELETE FROM project_export_tickets WHERE expires_at <= ?').run(isoAt(nowMs)).changes);
}

/* ------------------------------------------------------------------ */
/* Retention / lifecycle                                               */
/* ------------------------------------------------------------------ */

export function listExpiredExports(db, nowMs, limit = 100) {
  return db
    .prepare(
      `SELECT * FROM project_exports
       WHERE delivery_state = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
       ORDER BY expires_at ASC LIMIT ?`,
    )
    .all(isoAt(nowMs), limit);
}

/** Orphans: exports whose owning user or project no longer exists. */
export function listOrphanExports(db, limit = 100) {
  return db
    .prepare(
      `SELECT e.* FROM project_exports e
       WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = e.user_id)
          OR NOT EXISTS (SELECT 1 FROM projects p WHERE p.user_id = e.user_id AND p.id = e.project_id)
       LIMIT ?`,
    )
    .all(limit);
}

export function listExportsForProject(db, userId, projectId) {
  return db
    .prepare('SELECT * FROM project_exports WHERE user_id = ? AND project_id = ? ORDER BY created_at ASC')
    .all(userId, projectId);
}

export function deleteExportRow(db, userId, exportId) {
  db.prepare('DELETE FROM project_export_tickets WHERE user_id = ? AND export_id = ?').run(userId, exportId);
  db.prepare('DELETE FROM project_export_items WHERE user_id = ? AND export_id = ?').run(userId, exportId);
  return Number(db.prepare('DELETE FROM project_exports WHERE user_id = ? AND id = ?').run(userId, exportId).changes);
}

export function retainedBytesForUser(db, userId) {
  const exports = db.prepare(`SELECT COALESCE(SUM(COALESCE(zip_bytes, 0)
    + length(CAST(frozen_json AS BLOB))), 0) AS total FROM project_exports
    WHERE user_id = ? AND delivery_state = 'active'`).get(userId);
  const items = db.prepare(`SELECT COALESCE(SUM(COALESCE(png_bytes, 0)
    + length(CAST(i.scene_json AS BLOB)) + length(CAST(i.annotations_json AS BLOB))
    + length(CAST(i.name AS BLOB)) + length(CAST(i.objective AS BLOB))
    + length(CAST(i.context AS BLOB))), 0) AS total FROM project_export_items i
    JOIN project_exports e ON e.user_id = i.user_id AND e.id = i.export_id
    WHERE e.user_id = ? AND e.delivery_state = 'active'`).get(userId);
  return Number(exports?.total ?? 0) + Number(items?.total ?? 0);
}

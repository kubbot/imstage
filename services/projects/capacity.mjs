/**
 * IMStage Projects — shared account Scene capacity guard.
 *
 * Every path that can create a NEW account Scene must consult this one helper:
 *   - HTTP `POST /api/scenes` (server.mjs)
 *   - account MCP `imstage_create_scene`
 *   - automation content batches (MCP/HTTP caller content)
 *   - the legacy batch publisher (`publishGeneratedScene`) and its pre-flight
 *     before any provider call
 *   - the scenario generation publisher (which consumes its own reservation)
 *
 * Usage is "real scenes + active reservations": a reservation is a promised
 * Scene slot held by an in-flight scenario generation case (frozen at enqueue,
 * consumed on successful publish, released on failure/cancel/interruption).
 * Existing creations never consume another generation's promised slot, and a
 * scenario publish excludes its own reservation because the atomic insert
 * consumes it.
 *
 * The reservation ledger also carries the generation/task/attempt binding used
 * for write fencing (`case_reserved`): only the matching server-internal
 * attempt may publish a reserved case key.
 */

import { projectsError } from './errors.mjs';
import { MAX_SCENES_PER_USER } from './model.mjs';
import { inTransaction, withTransaction } from './txn.mjs';

function nowIso(ms) {
  return new Date(ms).toISOString();
}

export const RESERVATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS scene_reservations (
    reservation_id TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    purpose        TEXT NOT NULL DEFAULT 'scenario_generation',
    generation_id  TEXT NOT NULL,
    scenario_id    TEXT NOT NULL,
    project_id     TEXT NOT NULL,
    item_key       TEXT NOT NULL,
    ordinal        INTEGER NOT NULL DEFAULT 0,
    chunk_index    INTEGER,
    job_id         TEXT,
    task_id        TEXT,
    attempt        INTEGER NOT NULL DEFAULT 1,
    status         TEXT NOT NULL DEFAULT 'active',
    scene_id       TEXT,
    error          TEXT,
    error_code     TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scene_reservations_user ON scene_reservations(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_scene_reservations_key ON scene_reservations(user_id, scenario_id, item_key, status);
  CREATE INDEX IF NOT EXISTS idx_scene_reservations_generation ON scene_reservations(generation_id, item_key);
  CREATE INDEX IF NOT EXISTS idx_scene_reservations_task ON scene_reservations(task_id);
`;

/** Idempotent install; safe to call from any store bootstrap or test helper. */
export function installSceneReservations(db) {
  db.exec(RESERVATION_SCHEMA_SQL);
}

// The guard must work on every account DB, including stores built from the raw
// legacy schema (tests and embedders). The idempotent install is memoized per
// handle so the capacity check can never fail on a missing ledger table.
const ensured = new WeakSet();
function ensure(db) {
  if (ensured.has(db)) return;
  installSceneReservations(db);
  // A CREATE TABLE inside a caller transaction can be rolled back (e.g. an
  // injected failure test): only memoize the install when it is durable.
  if (!inTransaction(db)) ensured.add(db);
}

export function countSceneRows(db, userId) {
  const row = db.prepare('SELECT COUNT(*) AS total FROM scenes WHERE user_id = ?').get(userId);
  return Number(row?.total ?? 0);
}

/**
 * Active reservations (promised Scene slots) for an account. Optionally
 * excludes one reservation id — used by the scenario publisher whose atomic
 * insert consumes exactly that reservation.
 */
export function countActiveReservations(db, userId, { excludeReservationId = null } = {}) {
  ensure(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM scene_reservations
       WHERE user_id = ? AND status = 'active' AND (? IS NULL OR reservation_id <> ?)`,
    )
    .get(userId, excludeReservationId, excludeReservationId);
  return Number(row?.total ?? 0);
}

/** Real scenes + promised slots. The number that must fit `MAX_SCENES_PER_USER`. */
export function sceneCapacityUsage(db, userId, options = {}) {
  return {
    scenes: countSceneRows(db, userId),
    reserved: countActiveReservations(db, userId, options),
    limit: MAX_SCENES_PER_USER,
  };
}

/**
 * Assert `needed` new scenes fit the account limit including reservations.
 * Throws `scene_limit_reached` (409) with a truthful message.
 */
export function assertSceneCapacity(db, userId, needed = 1, options = {}) {
  const usage = sceneCapacityUsage(db, userId, options);
  if (usage.scenes + usage.reserved + needed > usage.limit) {
    throw projectsError(
      409,
      'scene_limit_reached',
      `每个账号最多保存 ${usage.limit} 个作品（已保存 ${usage.scenes} 个，生成/提交占用 ${usage.reserved} 个），请先清理或等待生成完成后再试`,
    );
  }
  return usage;
}

/* ------------------------------------------------------------------ */
/* Reservation ledger                                                  */
/* ------------------------------------------------------------------ */

export function getReservation(db, userId, reservationId) {
  ensure(db);
  return (
    db
      .prepare('SELECT * FROM scene_reservations WHERE user_id = ? AND reservation_id = ?')
      .get(userId, reservationId) ?? null
  );
}

/** Any active reservation for a case key (the `case_reserved` fence). */
export function findActiveCaseReservation(db, userId, scenarioId, itemKey) {
  ensure(db);
  return (
    db
      .prepare(
        `SELECT * FROM scene_reservations
         WHERE user_id = ? AND scenario_id = ? AND item_key = ? AND status = 'active'`,
      )
      .get(userId, scenarioId, itemKey) ?? null
  );
}

export function listGenerationReservations(db, userId, generationId) {
  ensure(db);
  return db
    .prepare('SELECT * FROM scene_reservations WHERE user_id = ? AND generation_id = ? ORDER BY ordinal ASC, item_key ASC')
    .all(userId, generationId);
}

/**
 * Reserve one case key (a promised Scene slot). Rows are created at enqueue so
 * the capacity guard sees pending generation work everywhere.
 */
export function reserveCase(db, { userId, reservationId, generationId, scenarioId, projectId, itemKey, ordinal = 0, nowMs }) {
  ensure(db);
  const stamp = nowIso(nowMs);
  db.prepare(
    `INSERT INTO scene_reservations
       (reservation_id, user_id, purpose, generation_id, scenario_id, project_id, item_key, ordinal, chunk_index, job_id, task_id, attempt, status, created_at, updated_at)
     VALUES (?, ?, 'scenario_generation', ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, 'active', ?, ?)`,
  ).run(reservationId, userId, generationId, scenarioId, projectId, itemKey, ordinal, stamp, stamp);
  return getReservation(db, userId, reservationId);
}

/** Bind an active reservation to the chunk task/attempt that will publish it. */
export function bindReservationTask(db, { userId, reservationId, chunkIndex, jobId, taskId, attempt, nowMs }) {
  db.prepare(
    `UPDATE scene_reservations
     SET chunk_index = ?, job_id = ?, task_id = ?, attempt = ?, updated_at = ?
     WHERE user_id = ? AND reservation_id = ? AND status = 'active'`,
  ).run(chunkIndex, jobId, taskId, attempt, nowIso(nowMs), userId, reservationId);
}

/** Release (never publish) a reservation: failure, cancel or interruption. */
export function releaseReservation(db, { userId, reservationId, reason = null, errorCode = null, nowMs }) {
  db.prepare(
    `UPDATE scene_reservations SET status = 'released', error = ?, error_code = ?, updated_at = ?
     WHERE user_id = ? AND reservation_id = ? AND status = 'active'`,
  ).run(reason, errorCode, nowIso(nowMs), userId, reservationId);
}

/**
 * Release ONLY the matching attempt. A stale task (bound to a reservation that
 * has since been re-bound to a newer task/attempt) can never release or consume
 * the newer attempt's promised slot.
 */
export function releaseMatchingReservation(db, { userId, reservationId, taskId = null, attempt = null, reason = null, errorCode = null, nowMs }) {
  const row = reservationId ? getReservation(db, userId, reservationId) : null;
  if (!row || row.status !== 'active') return false;
  if (taskId !== null && taskId !== undefined && row.task_id !== taskId) return false;
  if (attempt !== null && attempt !== undefined && row.task_id !== null && Number(row.attempt) !== Number(attempt)) return false;
  releaseReservation(db, { userId, reservationId, reason, errorCode, nowMs });
  return true;
}

/** Consume a reservation during the atomic scene insert (matching attempt only). */
export function consumeReservation(db, { userId, reservationId, sceneId, nowMs }) {
  const result = db
    .prepare(
      `UPDATE scene_reservations SET status = 'consumed', scene_id = ?, updated_at = ?
       WHERE user_id = ? AND reservation_id = ? AND status = 'active'`,
    )
    .run(sceneId, nowIso(nowMs), userId, reservationId);
  return result.changes === 1;
}

/** Release every active reservation of a generation (cancel/restart/finish). */
export function releaseGenerationReservations(db, { userId, generationId, reason = null, errorCode = null, nowMs, keepStatuses = ['active'] }) {
  const placeholders = keepStatuses.map(() => '?').join(', ');
  const result = db
    .prepare(
      `UPDATE scene_reservations SET status = 'released', error = ?, error_code = ?, updated_at = ?
       WHERE user_id = ? AND generation_id = ? AND status IN (${placeholders})`,
    )
    .run(reason, errorCode, nowIso(nowMs), userId, generationId, ...keepStatuses);
  return Number(result.changes ?? 0);
}

/**
 * Publish-time fence: the reservation must still be active and bound to this
 * exact generation/task/attempt. Anything else is a stale or foreign write and
 * is rejected without touching the account.
 */
export function assertReservationMatches(db, { userId, reservationId, generationId, taskId, attempt, scenarioId, itemKey }) {
  const row = getReservation(db, userId, reservationId);
  if (!row || row.status !== 'active') {
    throw projectsError(409, 'case_reserved', '该案例的生成预留已失效（已释放或已消费），结果不会被保存');
  }
  const matches =
    row.generation_id === generationId &&
    (taskId === null || row.task_id === taskId) &&
    Number(row.attempt) === Number(attempt) &&
    row.scenario_id === scenarioId &&
    row.item_key === itemKey;
  if (!matches) {
    throw projectsError(409, 'case_reserved', '该案例已由另一次生成占用，本次结果不会被保存');
  }
  return row;
}

/** Release every active reservation of a project (delete lifecycle). */
export function releaseProjectReservations(db, { userId, projectId, reason = null, errorCode = null, nowMs }) {
  ensure(db);
  const result = db
    .prepare(
      `UPDATE scene_reservations SET status = 'released', error = ?, error_code = ?, updated_at = ?
       WHERE user_id = ? AND project_id = ? AND status = 'active'`,
    )
    .run(reason, errorCode, nowIso(nowMs), userId, projectId);
  return Number(result.changes ?? 0);
}

/** Re-entrant transaction entry point (single owner of COMMIT/ROLLBACK). */
export { withTransaction };

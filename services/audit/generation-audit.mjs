/**
 * IMStage — minimal persistent generation audit (hosted flows only).
 *
 * Every *authenticated hosted generation* — the hosted Agent, project batch
 * generation, portrait generation and AI-supplied content saved through either
 * MCP surface — records one durable row:
 *
 *   run id · time · account id · policy version · status · scene hash · flow
 *
 * Deliberately minimal and privacy-preserving:
 *   - no raw prompts, no screenshot or image bytes, no tokens, no scene text;
 *   - the scene hash is a SHA-256 digest of canonical scene JSON, or an output
 *     PNG digest for render flows; no raw content is stored in this table;
 *   - rows are retained for 90 days and then deleted by the real cleanup in
 *     `cleanupGenerationAudit` (run at server start and on an interval).
 *
 * Limitation (documented in docs/safety-policy.md): anonymous local editing
 * and PNG export in the browser never reaches a server, so no server audit
 * record exists for it. The mandatory "AI生成 / 虚构" disclosure is rendered
 * client-side and is present in those exports instead. This module makes no
 * claim about local actions.
 */

import crypto from 'node:crypto';
import { canonicalSceneJson, POLICY_VERSION } from '../../packages/schema/policy.mjs';

export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const AUDIT_TABLE = 'generation_audit';
export { POLICY_VERSION };

const FLOWS = new Set(['agent', 'batch', 'portrait', 'mcp_scene', 'mcp_batch', 'account_mcp', 'render']);
const STATUSES = new Set(['running', 'ok', 'error', 'aborted', 'partial']);

export function newRunId() {
  return `run_${crypto.randomUUID()}`;
}

/** SHA-256 of the canonical scene JSON. Stores no raw scene bytes; known inputs can still be compared. */
export function hashScene(scene) {
  if (scene === undefined || scene === null) return null;
  try {
    return crypto.createHash('sha256').update(canonicalSceneJson(scene)).digest('hex');
  } catch {
    return null;
  }
}

export function installGenerationAuditSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
      run_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      account_id TEXT NOT NULL,
      flow TEXT NOT NULL,
      status TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      scene_hash TEXT,
      error_code TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS ${AUDIT_TABLE}_created_ms_idx ON ${AUDIT_TABLE}(created_ms)`);
}

/**
 * Record one hosted generation run. Only metadata is persisted — callers must
 * not pass prompts, screenshots or tokens, and this function has nowhere to
 * put them anyway.
 *
 * @returns the recorded row (without internal ids beyond run_id)
 */
export function recordGenerationAudit(
  db,
  { runId, accountId, flow, status, scene = null, sceneHash = null, errorCode = null, nowMs = Date.now(), policyVersion = POLICY_VERSION },
) {
  const id = typeof runId === 'string' && runId.length > 0 && runId.length <= 128 ? runId : newRunId();
  const account = typeof accountId === 'string' && accountId.length > 0 ? accountId.slice(0, 128) : 'anonymous';
  const safeFlow = FLOWS.has(flow) ? flow : 'agent';
  const safeStatus = STATUSES.has(status) ? status : 'error';
  const hash = typeof sceneHash === 'string' && /^[0-9a-f]{64}$/.test(sceneHash) ? sceneHash : hashScene(scene);
  const createdMs = Number.isFinite(nowMs) ? Math.trunc(nowMs) : Date.now();
  const createdAt = new Date(createdMs).toISOString();
  const code = typeof errorCode === 'string' ? errorCode.slice(0, 80) : null;
  db.prepare(
    `INSERT OR REPLACE INTO ${AUDIT_TABLE}
      (run_id, created_at, created_ms, account_id, flow, status, policy_version, scene_hash, error_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, createdAt, createdMs, account, safeFlow, safeStatus, policyVersion, hash, code);
  return {
    runId: id,
    createdAt,
    accountId: account,
    flow: safeFlow,
    status: safeStatus,
    policyVersion,
    sceneHash: hash,
    errorCode: code,
  };
}

export function listGenerationAudit(db, { limit = 100 } = {}) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
  const rows = db.prepare(`SELECT run_id, created_at, account_id, flow, status, policy_version, scene_hash, error_code FROM ${AUDIT_TABLE} ORDER BY created_ms DESC LIMIT ?`).all(safeLimit);
  return rows.map((row) => ({
    runId: row.run_id,
    createdAt: row.created_at,
    accountId: row.account_id,
    flow: row.flow,
    status: row.status,
    policyVersion: row.policy_version,
    sceneHash: row.scene_hash,
    errorCode: row.error_code,
  }));
}

/**
 * Real 90-day retention cleanup. Deletes every audit row older than the
 * retention window and returns how many rows were removed.
 */
export function cleanupGenerationAudit(db, { nowMs = Date.now(), retentionMs = AUDIT_RETENTION_MS } = {}) {
  const cutoff = Math.trunc(nowMs) - Math.trunc(retentionMs);
  const result = db.prepare(`DELETE FROM ${AUDIT_TABLE} WHERE created_ms < ?`).run(cutoff);
  return Number(result.changes ?? 0);
}

/** Schedule periodic cleanup (callers should keep the timer and clear it). */
export function scheduleAuditCleanup(db, { intervalMs = 6 * 60 * 60 * 1000, onError = () => {} } = {}) {
  const timer = setInterval(() => {
    try {
      cleanupGenerationAudit(db);
    } catch (error) {
      onError(error);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * Non-destructive schema migration for render caches: adds a nullable
 * `policy_version` column so blobs rendered before the current safety policy
 * can be identified and blocked without deleting any stored data.
 */
export function ensurePolicyVersionColumn(db, table) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === 'policy_version')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN policy_version TEXT`);
  }
}

/** True only for renders produced under the *current* policy version. */
export function isCurrentPolicyVersion(value) {
  return value === POLICY_VERSION;
}

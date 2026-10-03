/**
 * IMStage Scenario Generation — durable parent generation queue for
 * Project → Scenario → Case AI generation on the existing paid Web generator.
 *
 * Design (batch C):
 *   - `enqueueScenarioGeneration` freezes ALL requested stable case keys as
 *     capacity reservations up front and persists parent + chunk jobs in one
 *     transaction. Chunks are the existing persisted `batch_jobs`/`batch_tasks`
 *     (≤20 tasks per job, 20/20/10 for 50 cases) run by the existing serial
 *     `services/projects/batch.mjs` worker through the already-configured
 *     `agent.runtime` + limiter. No provider client is added here and the
 *     browser tab may close immediately.
 *   - A durable parent driver releases the next chunk when a prior chunk
 *     settles (needed above 3 chunks / 60 cases, e.g. 100 cases = 5 chunks with
 *     at most 3 queued/running jobs per account). The browser never schedules
 *     chunks.
 *   - Every case key is fenced by `scene_reservations` (generationId + taskId +
 *     attemptId + scenarioId + itemKey). Public MCP/Web content submission for
 *     a reserved key is rejected (`case_reserved`); only the matching internal
 *     attempt may publish. Successful cases are never re-run; an explicit
 *     retry targets only missing/failed keys; a duplicate enqueue (double
 *     click / replayed idempotency key) returns the original parent and never
 *     calls the model twice.
 *   - Publication is ONE short synchronous transaction (`txn.withTransaction`,
 *     re-entrant across the legacy and automation stores): it re-checks
 *     session/owner, cancelled parent+child, project/scenario existence,
 *     matching reservation/attempt, non-empty valid Scene, live duplicate
 *     dialogue in the same scenario and account capacity (excluding its own
 *     consumed reservation), then writes Scene + project association + case
 *     metadata + reservation consumption + task success + audit together.
 *     Auto-export runs through the shared export service AFTER commit and an
 *     export failure never downgrades a committed task.
 *   - Startup recovery marks parent + children interrupted and releases the
 *     attempt reservations BEFORE any worker starts. A crash after the provider
 *     returned but before commit is result-unknown: it is never silently
 *     re-run, and an explicit retry may incur another provider call for such
 *     cases (documented in docs/project-automation.md — no exactly-once claim
 *     across process crashes).
 */

import crypto from 'node:crypto';

import { newRunId as newAuditRunId, recordGenerationAudit } from '../audit/generation-audit.mjs';
import { sha256Hex, stableStringify } from '../mcp/util.mjs';
import { applySceneDefaults } from '../preferences/defaults.mjs';
import { validateScene } from '../../apps/web/src/studio/model.ts';
import { SCENARIO_LIMITS, localizeRecipeText } from '../../packages/schema/project-recipes.mjs';
import {
  assertReservationMatches,
  assertSceneCapacity,
  bindReservationTask,
  consumeReservation,
  findActiveCaseReservation,
  getReservation,
  installSceneReservations,
  listGenerationReservations,
  releaseGenerationReservations,
  releaseMatchingReservation,
  releaseReservation,
  reserveCase,
} from './capacity.mjs';
import { projectsError } from './errors.mjs';
import { blankScene, buildTaskPrompt, MAX_ACTIVE_BATCH_JOBS } from './model.mjs';
import * as autoStore from './automation-store.mjs';
import * as legacyStore from './store.mjs';
import { withTransaction } from './txn.mjs';

export const GENERATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS scenario_generations (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    scenario_id     TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    idempotency_key TEXT,
    request_hash    TEXT NOT NULL,
    mode            TEXT NOT NULL DEFAULT 'generate',
    source_generation_id TEXT,
    status          TEXT NOT NULL DEFAULT 'queued',
    case_total      INTEGER NOT NULL,
    chunk_size      INTEGER NOT NULL DEFAULT ${SCENARIO_LIMITS.batchItemsMax},
    chunks_total    INTEGER NOT NULL,
    chunks_started  INTEGER NOT NULL DEFAULT 0,
    reason          TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scenario_generations_scenario ON scenario_generations(user_id, scenario_id, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_scenario_generations_idem
    ON scenario_generations(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

export function installScenarioGenerationSchema(db) {
  db.exec(GENERATION_SCHEMA_SQL);
  installSceneReservations(db);
}

const CHUNK_SIZE = SCENARIO_LIMITS.batchItemsMax;
const MAX_CHUNKS_QUEUED_PER_USER = MAX_ACTIVE_BATCH_JOBS;

function nowIso(ms) {
  return new Date(ms).toISOString();
}

function generationItem(row, extra = {}) {
  return {
    generationId: row.id,
    projectId: row.project_id,
    scenarioId: row.scenario_id,
    mode: row.mode,
    sourceGenerationId: row.source_generation_id ?? null,
    status: row.status,
    idempotencyKey: row.idempotency_key ?? null,
    caseTotal: Number(row.case_total),
    chunkSize: Number(row.chunk_size),
    chunksTotal: Number(row.chunks_total),
    chunksStarted: Number(row.chunks_started),
    reason: row.reason ?? null,
    cancelRequested: Number(row.cancel_requested) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extra,
  };
}

/**
 * Per-case task prompt: the frozen case plan's name/objective/context and the
 * preset variation are part of the model prompt AND are stored back as the
 * case metadata on publish, so the delivered case matches what was planned.
 */
export function buildCaseTaskPrompt({ scenario, entry, presetGuidance, cast = [] }) {
  const lines = [];
  lines.push(`【场景】${scenario.name}（平台 ${scenario.platform} · 语言 ${scenario.locale}）`);
  if (scenario.brief) lines.push(`【场景说明】${scenario.brief}`);
  // Frozen cast names/roles only: avatar bytes never enter the model prompt.
  const castEntries = (Array.isArray(cast) ? cast : []).filter((member) => member && member.name);
  if (castEntries.length > 0) {
    lines.push(`【人物】${castEntries.map((member) => `${member.name}${member.role ? `（${member.role}）` : ''}`).join('；')}`);
  }
  lines.push(`【案例编号】${entry.itemKey}`);
  lines.push(`【案例名称】${entry.name}`);
  lines.push(`【目标】${entry.objective}`);
  lines.push(`【背景】${entry.context}`);
  const variation = (entry.guide?.variation ?? []).map((item) => `${localizeRecipeText(item.label, scenario.locale)}：${localizeRecipeText(item.value, scenario.locale)}`).join('；');
  if (variation) lines.push(`【本例变化】${variation}`);
  if (presetGuidance) {
    const guidance = (Array.isArray(presetGuidance) ? presetGuidance : [presetGuidance])
      .map((item) => localizeRecipeText(item, scenario.locale)).join('\n- ');
    lines.push(`【生成指引】\n- ${guidance}`);
  }
  lines.push('请生成这一个案例的完整对话：一段真实、可直接渲染的聊天记录，消息自然交替，围绕上方目标与背景展开，只输出这一个案例。');
  return lines.join('\n');
}

function failureMessage(code, message) {
  return String(message ?? code ?? '生成失败').slice(0, 500);
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {() => number} options.nowMs
 * @param {{ wake?: Function }} [options.queue] existing batch worker to wake
 * @param {(args: object) => any} [options.onScenarioContentReady] shared export service hook (AFTER commit)
 * @param {object} [options.logger]
 * @param {(userId: string) => object|null} [options.readPreferences] shared account defaults (avatars)
 */
export function createScenarioGenerationService({ db, nowMs = Date.now, queue = null, onScenarioContentReady = null, readPreferences = null, logger = console }) {
  installScenarioGenerationSchema(db);

  /* ---------------- reads ---------------- */

  function getGenerationRow(userId, generationId) {
    return (
      db.prepare('SELECT * FROM scenario_generations WHERE user_id = ? AND id = ?').get(userId, generationId) ?? null
    );
  }

  function activeGenerationRow(userId, scenarioId) {
    return (
      db
        .prepare(
          `SELECT * FROM scenario_generations
           WHERE user_id = ? AND scenario_id = ? AND status IN ('queued', 'running')
           ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        )
        .get(userId, scenarioId) ?? null
    );
  }

  function reservationCounts(userId, generationId) {
    const rows = db
      .prepare(
        `SELECT status, COUNT(*) AS total FROM scene_reservations
         WHERE user_id = ? AND generation_id = ? GROUP BY status`,
      )
      .all(userId, generationId);
    const counts = { active: 0, consumed: 0, released: 0 };
    for (const row of rows) counts[row.status] = Number(row.total);
    return counts;
  }

  function generationView(userId, row) {
    const counts = reservationCounts(userId, row.id);
    const failures = db
      .prepare(
        `SELECT item_key, error, error_code FROM scene_reservations
         WHERE user_id = ? AND generation_id = ? AND status = 'released'
         ORDER BY ordinal ASC, item_key ASC LIMIT 50`,
      )
      .all(userId, row.id)
      .map((entry) => ({ itemKey: entry.item_key, error: entry.error, errorCode: entry.error_code }));
    return generationItem(row, {
      done: counts.consumed,
      failed: counts.released,
      pending: counts.active,
      failures,
    });
  }

  /** Case-level progress for one scenario, merged across generations. */
  function scenarioGenerationStatus({ userId, projectId, scenarioId }) {
    const latest = db
      .prepare(
        `SELECT * FROM scenario_generations WHERE user_id = ? AND scenario_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(userId, scenarioId);
    const active = activeGenerationRow(userId, scenarioId);
    const cases = autoStore.listCaseRows(db, userId, scenarioId, projectId).map(autoStore.caseItem);
    const submittedKeys = new Set(cases.filter((item) => item.submitted).map((item) => item.itemKey));
    const reservations = latest
      ? listGenerationReservations(db, userId, latest.id).map((row) => ({
          itemKey: row.item_key,
          status: row.status,
          sceneId: row.scene_id ?? null,
          error: row.error ?? null,
          errorCode: row.error_code ?? null,
          jobId: row.job_id ?? null,
          taskId: row.task_id ?? null,
          attempt: Number(row.attempt ?? 1),
        }))
      : [];
    return {
      generation: latest ? generationView(userId, latest) : null,
      active: active ? generationView(userId, active) : null,
      submittedItemKeys: [...submittedKeys],
      missingItemKeys: cases.filter((item) => !item.submitted).map((item) => item.itemKey),
      cases,
      reservations,
    };
  }

  /* ---------------- chunk driver ---------------- */

  function activeJobsFor(userId) {
    return legacyStore.countActiveJobs(db, userId);
  }

  /** Pending (unbound, active) reservations of one generation, stable order. */
  function pendingReservations(userId, generationId) {
    return listGenerationReservations(db, userId, generationId).filter(
      (row) => row.status === 'active' && (row.job_id === null || row.job_id === undefined),
    );
  }

  /**
   * Persist one chunk job binding its reserved cases. Runs inside the caller's
   * transaction (re-entrant helper). Task ids and scene ids are generated up
   * front; every task row persists its exact generation/scenario/item/
   * reservation/task/attempt bindings BEFORE the worker may claim the job.
   */
  function createChunkJobLocked({ row, scenario, plan, reservations, chunkIndex }) {
    // Frozen cast (names/roles only) travels in the task values so the worker
    // can seed the starting scene participants without touching the provider.
    const frozenCast = (scenario.frozen?.cast ?? []).map((member) => ({ name: member.name, role: member.role }));
    const tasks = reservations.map((reservation) => {
      const entry = plan.cases.find((candidate) => candidate.itemKey === reservation.item_key) ?? {
        itemKey: reservation.item_key,
        name: reservation.item_key,
        objective: '',
        context: '',
        guide: { variation: [] },
      };
      return {
        prompt: buildCaseTaskPrompt({
          scenario: {
            name: scenario.name,
            brief: scenario.brief,
            platform: scenario.platform,
            locale: scenario.locale,
          },
          entry,
          presetGuidance: plan.guidance,
          cast: frozenCast,
        }),
        platform: scenario.platform,
        name: `${entry.itemKey} ${entry.name}`,
        values: frozenCast.length > 0 ? { cast: frozenCast } : {},
        scenarioId: row.scenario_id,
        itemKey: reservation.item_key,
        generationId: row.id,
        reservationId: reservation.reservation_id,
        attempt: Number(reservation.attempt ?? 1),
      };
    });
    const job = legacyStore.createBatchJob(db, {
      userId: row.user_id,
      projectId: row.project_id,
      generationId: row.id,
      sessionId: row.session_id,
      rules: scenario.frozen.rules,
      watermarkEnabled: scenario.frozen.watermarkEnabled,
      tasks,
      clientBatchId: `scenario-gen:${row.id}:${chunkIndex}`,
      template: null,
      nowMs: nowMs(),
    });
    // Bind each reservation to the exact task/attempt that will publish it.
    for (const [index, reservation] of reservations.entries()) {
      const task = job.tasks[index];
      bindReservationTask(db, {
        userId: row.user_id,
        reservationId: reservation.reservation_id,
        chunkIndex,
        jobId: job.id,
        taskId: task.id,
        attempt: Number(reservation.attempt ?? 1),
        nowMs: nowMs(),
      });
    }
    return job;
  }

  /**
   * Durable driver: queue the next un-started chunks while the account has a
   * free job slot. Each iteration re-reads the pending reservations from the
   * DB (never a stale snapshot) and advances `chunks_started` exactly once per
   * created job. Called after enqueue and whenever ANY job of the account
   * settles — never by the browser.
   */
  function pumpChunksLocked(userId, generationId) {
    const row = getGenerationRow(userId, generationId);
    if (!row || Number(row.cancel_requested) === 1) return null;
    if (!['queued', 'running'].includes(row.status)) return null;
    const plan = autoStore.scenarioPlan(autoStore.getScenarioRow(db, userId, row.scenario_id));
    const scenario = autoStore.getScenarioItem(db, userId, row.scenario_id);
    if (!scenario) return null;
    let created = null;
    for (;;) {
      if (Number(row.chunks_started) >= Number(row.chunks_total)) break;
      if (activeJobsFor(userId) >= MAX_CHUNKS_QUEUED_PER_USER) break;
      const pending = pendingReservations(userId, generationId).slice(0, CHUNK_SIZE);
      if (pending.length === 0) break;
      const chunkIndex = Number(row.chunks_started);
      created = createChunkJobLocked({ row, scenario, plan, reservations: pending, chunkIndex });
      // Single, exact increment per created chunk job.
      db.prepare('UPDATE scenario_generations SET chunks_started = ?, updated_at = ? WHERE id = ?').run(
        chunkIndex + 1,
        nowIso(nowMs()),
        generationId,
      );
      row.chunks_started = chunkIndex + 1;
    }
    return created;
  }

  /** Refresh parent status from real reservation/task facts. */
  function refreshGenerationStatus(userId, generationId, { terminalReason = null } = {}) {
    const row = getGenerationRow(userId, generationId);
    if (!row) return null;
    // A deletion/user cancellation is terminal: a late worker callback must
    // not resurrect the parent or requeue anything.
    if (row.status === 'cancelled') return row;
    const counts = reservationCounts(userId, generationId);
    const interrupted = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM scene_reservations
           WHERE user_id = ? AND generation_id = ? AND status = 'released' AND error_code = 'interrupted'`,
        )
        .get(userId, generationId)?.n ?? 0,
    );
    const jobs = db
      .prepare(
        `SELECT status FROM batch_jobs WHERE user_id = ? AND id IN
          (SELECT DISTINCT job_id FROM scene_reservations WHERE user_id = ? AND generation_id = ? AND job_id IS NOT NULL)`,
      )
      .all(userId, userId, generationId);
    const jobActive = jobs.some((job) => ['queued', 'running'].includes(job.status));
    let status = row.status;
    let reason = row.reason;
    if (interrupted > 0 && counts.active === 0) {
      // A restart/interruption is never reported as completed or as a plain
      // partial: the user must explicitly retry the missing keys.
      status = 'interrupted';
      reason = reason ?? '任务已中断，请手动重试（只补缺项）';
    } else if (Number(row.cancel_requested) === 1 && counts.active === 0) {
      status = counts.consumed > 0 ? 'partial' : 'cancelled';
      reason = reason ?? '用户已取消';
    } else if (counts.active > 0 && jobActive) {
      status = 'running';
    } else if (counts.active > 0 && !jobActive) {
      // Driver or worker must pick it up; keep it queued.
      status = 'queued';
    } else {
      status = counts.consumed === 0 ? (counts.released > 0 ? 'failed' : 'done') : counts.released > 0 ? 'partial' : 'done';
      if (terminalReason && !reason) reason = terminalReason;
    }
    db.prepare('UPDATE scenario_generations SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(
      status,
      reason ?? null,
      nowIso(nowMs()),
      generationId,
    );
    return getGenerationRow(userId, generationId);
  }

  /**
   * Durable fair pending-parent pump: triggered by EVERY account job
   * settlement (legacy or scenario). A parent queued while all job slots were
   * busy must still progress once those jobs finish — no browser polling is
   * involved. Oldest parent first, so concurrent parents cannot strand each
   * other's reservations.
   */
  function pumpUserLocked(userId) {
    const rows = db
      .prepare(
        `SELECT id FROM scenario_generations
         WHERE user_id = ? AND status IN ('queued', 'running')
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(userId);
    for (const row of rows) {
      if (activeJobsFor(userId) >= MAX_CHUNKS_QUEUED_PER_USER) break;
      pumpChunksLocked(userId, row.id);
      refreshGenerationStatus(userId, row.id);
    }
  }

  /**
   * Called by the batch worker after ANY job settles: drive the owning parent
   * (if any), then fairly pump every pending parent of the account.
   */
  function onChunkJobSettled(job) {
    const generationId = job?.generation_id ?? job?.generationId ?? null;
    const userId = job?.user_id ?? job?.userId ?? null;
    if (!userId) return;
    try {
      withTransaction(db, () => {
        if (generationId) {
          refreshGenerationStatus(userId, generationId, { terminalReason: job.reason ?? null });
        }
        pumpUserLocked(userId);
        if (generationId) refreshGenerationStatus(userId, generationId, { terminalReason: job.reason ?? null });
      });
    } catch (error) {
      logger.warn?.('[imstage-scenario-gen] chunk driver failed:', error?.message ?? error);
    }
    queue?.wake?.();
  }

  /* ---------------- enqueue / retry ---------------- */

  function requireSessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw projectsError(401, 'session_required', 'AI 生成需要有效登录会话，请重新登录后再试');
    }
    return sessionId;
  }

  function scenarioContextOrThrow(userId, projectId, scenarioId) {
    const id = legacyStore.getProjectRow(db, userId, projectId);
    if (!id) throw projectsError(404, 'not_found', '项目不存在');
    const scenario = autoStore.getScenarioItem(db, userId, scenarioId);
    if (!scenario || scenario.projectId !== projectId) throw projectsError(404, 'not_found', '场景不存在');
    const row = autoStore.getScenarioRow(db, userId, scenarioId);
    return { scenario, row, plan: autoStore.scenarioPlan(row) };
  }

  /**
   * Freeze every requested stable key as a reservation + parent row and queue
   * the first ≤3 chunks atomically (20/20/10 for 50 cases). `mode: 'retry'`
   * targets only missing/failed keys of a prior generation and never re-runs a
   * successfully completed case.
   */
  function enqueue({ userId, projectId, scenarioId, sessionId, idempotencyKey = null, mode = 'generate', sourceGenerationId = null }) {
    // Canonical IMMUTABLE caller request. Target keys are derived from mutable
    // state and are never part of the hash: a replayed request (before, during
    // or after success) must resolve to the original parent instead of
    // conflicting or reporting nothing to generate.
    const requestHash = sha256Hex(
      stableStringify({
        operation: 'scenario.generate',
        projectId,
        scenarioId,
        mode,
        sourceGenerationId: sourceGenerationId ?? null,
      }),
    );

    // 1) Replay lookup FIRST — no mutable target/runtime checks before it.
    if (idempotencyKey) {
      const prior = autoStore.readIdempotent(db, userId, idempotencyKey, 'scenario.generate', requestHash);
      if (prior) {
        const row = getGenerationRow(userId, prior.generation?.generationId);
        return {
          generation: row ? generationView(userId, row) : prior.generation,
          deduplicated: true,
        };
      }
    }

    requireSessionId(sessionId);
    if (!legacyStore.sessionStillValid(db, userId, sessionId, nowMs())) {
      throw projectsError(401, 'session_required', '登录已失效，无法开始 AI 生成，请重新登录');
    }
    const { scenario } = scenarioContextOrThrow(userId, projectId, scenarioId);
    if (scenario.recipeType === 'evaluation_dataset') {
      // Caller labels are mandatory for evaluation data; the Web generator
      // never invents ground truth. The action is refused with a clear reason.
      throw projectsError(
        422,
        'missing_annotations',
        '评测数据集案例必须由调用方提供标注（labels），不能由 AI 生成；请通过内容批次提交带标注的案例。',
      );
    }

    // 2) Double-click / concurrent submit: one active parent per scenario.
    //    The receipt is written under the key so later replays never re-run.
    const active = activeGenerationRow(userId, scenarioId);
    if (active) {
      const response = { generation: generationView(userId, active), deduplicated: true };
      if (idempotencyKey) autoStore.writeIdempotent(db, userId, idempotencyKey, 'scenario.generate', requestHash, response, nowMs());
      return response;
    }

    // 3) Mutable target computation happens only after replay resolution.
    const cases = autoStore.listCaseRows(db, userId, scenarioId, projectId).map(autoStore.caseItem);
    const targets = cases.filter((item) => !item.submitted);
    if (targets.length === 0) {
      throw projectsError(400, 'nothing_to_generate', '没有缺少内容的案例，无需生成');
    }

    return withTransaction(db, () => {
      if (idempotencyKey) {
        const prior = autoStore.readIdempotent(db, userId, idempotencyKey, 'scenario.generate', requestHash);
        if (prior) {
          const row = getGenerationRow(userId, prior.generation?.generationId);
          return { generation: row ? generationView(userId, row) : prior.generation, deduplicated: true };
        }
      }

      // Capacity pre-flight: every pending case needs a promised slot, counted
      // against real scenes AND other generations' active reservations.
      assertSceneCapacity(db, userId, targets.length);

      const generationId = crypto.randomUUID();
      const stamp = nowIso(nowMs());
      const chunksTotal = Math.ceil(targets.length / CHUNK_SIZE);
      db.prepare(
        `INSERT INTO scenario_generations
           (id, user_id, project_id, scenario_id, session_id, idempotency_key, request_hash, mode, source_generation_id,
            status, case_total, chunk_size, chunks_total, chunks_started, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?)`,
      ).run(
        generationId,
        userId,
        projectId,
        scenarioId,
        sessionId,
        idempotencyKey,
        requestHash,
        mode,
        sourceGenerationId,
        targets.length,
        CHUNK_SIZE,
        chunksTotal,
        stamp,
        stamp,
      );
      for (const [index, item] of targets.entries()) {
        reserveCase(db, {
          userId,
          reservationId: crypto.randomUUID(),
          generationId,
          scenarioId,
          projectId,
          itemKey: item.itemKey,
          ordinal: index,
          nowMs: nowMs(),
        });
      }
      // Queue at most 3 chunks immediately (fits the 3 active jobs/account);
      // the durable driver releases the rest as prior chunks settle.
      pumpChunksLocked(userId, generationId);
      refreshGenerationStatus(userId, generationId);
      const row = getGenerationRow(userId, generationId);
      const response = {
        generation: generationView(userId, row),
        plannedItemKeys: targets.map((item) => item.itemKey),
        chunks: { total: chunksTotal, queued: Number(row.chunks_started) },
        deduplicated: false,
      };
      if (idempotencyKey) autoStore.writeIdempotent(db, userId, idempotencyKey, 'scenario.generate', requestHash, response, nowMs());
      return response;
    });
  }

  function retry({ userId, projectId, scenarioId, sessionId, generationId = null, idempotencyKey = null }) {
    return enqueue({
      userId,
      projectId,
      scenarioId,
      sessionId,
      idempotencyKey,
      mode: 'retry',
      sourceGenerationId: generationId,
    });
  }

  function cancel({ userId, projectId, scenarioId = null, generationId, reason = '用户已取消' }) {
    return withTransaction(db, () => {
      const row = getGenerationRow(userId, generationId);
      if (!row || (scenarioId && row.scenario_id !== scenarioId) || (projectId && row.project_id !== projectId)) {
        throw projectsError(404, 'not_found', '生成任务不存在');
      }
      if (['done', 'partial', 'failed', 'cancelled', 'interrupted'].includes(row.status)) {
        return { generation: generationView(userId, row) };
      }
      db.prepare('UPDATE scenario_generations SET cancel_requested = 1, reason = ?, updated_at = ? WHERE id = ?').run(
        reason,
        nowIso(nowMs()),
        generationId,
      );
      // Cancel queued chunk jobs (running ones abort via the job cancel flag).
      for (const job of db
        .prepare(
          `SELECT id FROM batch_jobs WHERE user_id = ? AND id IN
            (SELECT DISTINCT job_id FROM scene_reservations WHERE user_id = ? AND generation_id = ? AND job_id IS NOT NULL)`,
        )
        .all(userId, userId, generationId)) {
        try {
          legacyStore.markJobCancelRequested(db, {
            userId,
            projectId: row.project_id,
            jobId: job.id,
            reason,
            nowMs: nowMs(),
            // Trusted internal call: chunk cancellation is exactly what the
            // parent-level cancel must do (the public legacy entry is refused).
            allowGenerationChunk: true,
          });
        } catch {
          /* job may already be terminal */
        }
      }
      releaseGenerationReservations(db, {
        userId,
        generationId,
        reason,
        errorCode: 'cancelled',
        nowMs: nowMs(),
        keepStatuses: ['active'],
      });
      refreshGenerationStatus(userId, generationId, { terminalReason: reason });
      return { generation: generationView(userId, getGenerationRow(userId, generationId)) };
    });
  }

  /* ---------------- startup / shutdown recovery ---------------- */

  /**
   * Truthful restart recovery: any parent still queued/running after the
   * batch jobs were marked interrupted becomes `interrupted` and ALL of its
   * reservations are released so an explicit retry or MCP submission can
   * resume. Nothing is silently re-run and nothing is faked as completed.
   */
  function recoverInterrupted() {
    return withTransaction(db, () => {
      const rows = db
        .prepare("SELECT * FROM scenario_generations WHERE status IN ('queued', 'running')")
        .all();
      let parents = 0;
      let reservations = 0;
      for (const row of rows) {
        reservations += releaseGenerationReservations(db, {
          userId: row.user_id,
          generationId: row.id,
          reason: '服务重启，任务已中断，请手动重试（只补缺项）',
          errorCode: 'interrupted',
          nowMs: nowMs(),
          keepStatuses: ['active'],
        });
        db.prepare(
          `UPDATE scenario_generations SET status = 'interrupted', reason = COALESCE(reason, ?), updated_at = ? WHERE id = ?`,
        ).run('服务重启，任务已中断，请手动重试（只补缺项）', nowIso(nowMs()), row.id);
        parents += 1;
      }
      return { parents, reservations };
    });
  }

  /* ---------------- publication (called by the batch worker) ---------------- */

  /**
   * ONE synchronous transaction publishing one generated case. Never calls the
   * model and never awaits; the auto-export check runs after COMMIT.
   *
   * Returns { ok: true, sceneId } or { ok: false, code, message } — failures
   * are written truthfully (task failed + reservation released) in the same
   * transaction instead of throwing, so the worker keeps its semantics.
   */
  function settleTask({ userId, jobId, taskId, generationId, scenarioId, projectId, itemKey, reservationId, attempt, scene, sessionId, accountDefaults = null }) {
    return withTransaction(db, () => {
      /**
       * Fail one task truthfully. The reservation is released ONLY when it is
       * still bound to this exact task/attempt (never a newer one), and a
       * fencing rejection (`release: false`) mutates neither the reservation
       * nor any other attempt's state — only this stale task row.
       */
      const fail = (code, message, { cancelled = false, release = true } = {}) => {
        const text = failureMessage(code, message);
        if (release && reservationId) {
          releaseMatchingReservation(db, {
            userId,
            reservationId,
            taskId,
            attempt,
            reason: text,
            errorCode: code,
            nowMs: nowMs(),
          });
        }
        if (cancelled) legacyStore.markTaskCancelled(db, taskId, text, nowMs());
        else legacyStore.markTaskFailed(db, taskId, { code, message: text }, nowMs());
        return { ok: false, code, message: text };
      };

      // Cancelled/stopped parent or child first.
      const generation = getGenerationRow(userId, generationId);
      if (!generation || Number(generation.cancel_requested) === 1 || generation.status === 'cancelled') {
        return fail('cancelled', '生成任务已取消，结果未保存', { cancelled: true });
      }
      if (legacyStore.jobCancelRequested(db, jobId)) {
        return fail('cancelled', '生成任务已取消，结果未保存', { cancelled: true });
      }
      // Session must still be valid — and must have been non-empty at enqueue.
      if (!sessionId || !legacyStore.sessionStillValid(db, userId, sessionId, nowMs())) {
        return fail('session_expired', '登录已失效，结果未保存', { cancelled: true });
      }
      // Ownership + existence: a deleted project/scenario rejects the result
      // (the legacy loose-scene behaviour is intentionally NOT reused here).
      const project = legacyStore.getProjectRow(db, userId, projectId);
      const scenario = autoStore.getScenarioItem(db, userId, scenarioId);
      if (!project) return fail('project_deleted', '项目已删除，结果未保存');
      if (!scenario || scenario.projectId !== projectId) return fail('scenario_deleted', '场景已删除，结果未保存');

      // Reservation fencing: only the matching attempt may publish. A stale
      // task must not release, consume or seize the reservation now bound to a
      // newer task/attempt.
      try {
        assertReservationMatches(db, { userId, reservationId, generationId, taskId, attempt, scenarioId, itemKey });
      } catch (error) {
        return fail(error?.code ?? 'case_reserved', error?.message ?? '该案例已由另一次生成占用', { release: false });
      }

      // Frozen plan metadata (labels) must exist and stay authoritative.
      const caseRow = autoStore.getCaseRow(db, userId, scenarioId, itemKey, projectId);
      if (!caseRow) return fail('unknown_item_key', `案例 ${itemKey} 不属于该场景计划`);
      const caseMeta = autoStore.caseItem(caseRow);
      if (scenario.recipeType === 'evaluation_dataset' && Object.keys((caseMeta.annotations ?? {}).labels ?? {}).length === 0) {
        return fail('missing_annotations', `评测案例 ${itemKey} 缺少调用方标注，结果未保存`);
      }

      // Scene validity + honest failure when the model returned nothing. The
      // reserved task scene id is authoritative for the insert.
      const reservedSceneId = taskSceneId(db, taskId);
      let normalized = null;
      try {
        const candidate = scene ? { ...scene, id: (reservedSceneId ?? scene.id ?? '').toLowerCase() } : null;
        const validated = candidate && candidate.id ? validateScene(candidate) : { ok: false, scene: null };
        if (validated.ok && validated.scene) normalized = validated.scene;
      } catch {
        normalized = null;
      }
      if (!normalized) return fail('invalid_scene', '生成的作品未通过校验，未保存');
      if (!Array.isArray(normalized.messages) || normalized.messages.length === 0) {
        return fail('no_mutation', '模型没有生成有效内容，未保存');
      }
      const sceneId = String(reservedSceneId ?? normalized.id).toLowerCase();
      // Frozen cast avatars attach AFTER the model run (never in the model
      // prompt); remaining missing avatars use the shared account defaults —
      // the same path as caller content batches.
      const cast = Array.isArray(scenario.frozen?.cast) ? scenario.frozen.cast : [];
      if (cast.length > 0 && Array.isArray(normalized.participants)) {
        normalized = {
          ...normalized,
          participants: normalized.participants.map((participant) => {
            if (participant && participant.avatar !== undefined) return participant;
            const member = cast.find((entry) => entry && entry.name && entry.name === participant?.name);
            return member?.avatar ? { ...participant, avatar: member.avatar } : participant;
          }),
        };
      }
      try {
        normalized = applySceneDefaults(normalized, {
          myAvatar: accountDefaults?.myAvatar ?? null,
          otherAvatar: accountDefaults?.otherAvatar ?? null,
        });
      } catch {
        /* defaults are best-effort; the validated scene still publishes */
      }
      normalized = { ...normalized, id: sceneId, watermarkEnabled: scenario.frozen.watermarkEnabled !== false };

      // Duplicate dialogue in the same scenario (live content, id/title/time
      // independent) is rejected — same rule as caller content batches.
      const signature = autoStore.dialogueSignature(normalized);
      for (const entry of autoStore.submittedDialogueHashes(db, userId, scenarioId, projectId)) {
        if (entry.dialogueHash === signature && entry.itemKey !== itemKey) {
          return fail('duplicate_dialogue', `与 ${entry.itemKey} 的对话内容完全相同（忽略 ID/标题/时间/平台）`);
        }
      }

      // Capacity: exclude our own reservation, which this insert consumes.
      try {
        assertSceneCapacity(db, userId, 1, { excludeReservationId: reservationId });
      } catch (error) {
        return fail(error?.code ?? 'scene_limit_reached', error?.message ?? '作品数量已达上限');
      }

      const stamp = nowIso(nowMs());
      autoStore.insertSceneRow(db, { userId, scene: normalized, nowMs: nowMs() });
      autoStore.attachSceneRow(db, { userId, projectId, sceneId, nowMs: nowMs() });
      autoStore.submitCaseContent(db, {
        userId,
        scenarioId,
        itemKey,
        name: caseMeta.name,
        objective: caseMeta.objective,
        context: caseMeta.context,
        annotations: caseMeta.annotations,
        sceneId,
        sceneRevision: 1,
        dialogueHash: signature,
        source: 'generated',
        nowMs: nowMs(),
      });
      autoStore.clearStaleDialogueHashes(db, userId, scenarioId);
      consumeReservation(db, { userId, reservationId, sceneId, nowMs: nowMs() });
      legacyStore.markTaskDone(db, taskId, nowMs());
      recordGenerationAudit(db, {
        runId: newAuditRunId(),
        accountId: userId,
        flow: 'batch',
        status: 'ok',
        scene: normalized,
        nowMs: nowMs(),
      });
      return { ok: true, sceneId, stamp };
    });
  }

  function taskSceneId(db2, taskId) {
    const row = db2.prepare('SELECT scene_id FROM batch_tasks WHERE id = ?').get(taskId);
    return row?.scene_id ?? null;
  }

  /**
   * Shared account defaults (avatars) resolved in the async worker BEFORE the
   * synchronous publish transaction — the transaction never awaits.
   */
  async function fetchAccountDefaults(userId) {
    if (typeof readPreferences !== 'function') return null;
    try {
      return (await readPreferences(userId)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Post-commit hook: shared auto-export service. Export failure never
   * downgrades the committed task — errors are logged and reported as export
   * state only.
   */
  async function afterPublish({ userId, projectId, scenarioId, sessionId }) {
    if (typeof onScenarioContentReady !== 'function') return { queued: false, reason: 'export_not_configured' };
    try {
      const cases = autoStore.listCaseRows(db, userId, scenarioId, projectId).map(autoStore.caseItem);
      const missing = cases.filter((item) => !item.submitted).length;
      const scenario = autoStore.getScenarioItem(db, userId, scenarioId);
      if (!scenario || !scenario.autoExport) return { queued: false, reason: 'auto_export_disabled' };
      if (missing > 0) return { queued: false, reason: 'missing_items', missing };
      return await onScenarioContentReady({
        userId,
        projectId,
        scenarioId,
        principal: { kind: 'session', id: sessionId },
      });
    } catch (error) {
      logger.warn?.('[imstage-scenario-gen] auto export failed after commit:', error?.message ?? error);
      return { queued: false, reason: 'export_failed', error: String(error?.message ?? error).slice(0, 200) };
    }
  }

  /**
   * Pre-run guard: inspect session/ownership/cancel/fencing BEFORE the paid
   * runtime starts so an already-unpublishable scenario task never spends a
   * model call. Failures mark this task truthfully; the reservation is released
   * only when it still matches this task/attempt (fencing rejections mutate
   * neither the reservation nor another attempt).
   */
  function guardBeforeRun({ userId, jobId, taskId, generationId, scenarioId, projectId, itemKey, reservationId, attempt, sessionId }) {
    try {
      return withTransaction(db, () => {
        const fail = (code, message, { cancelled = false, release = true } = {}) => {
          const text = failureMessage(code, message);
          if (release && reservationId) {
            releaseMatchingReservation(db, { userId, reservationId, taskId, attempt, reason: text, errorCode: code, nowMs: nowMs() });
          }
          if (cancelled) legacyStore.markTaskCancelled(db, taskId, text, nowMs());
          else legacyStore.markTaskFailed(db, taskId, { code, message: text }, nowMs());
          return { ok: false, code, message: text };
        };
        const generation = getGenerationRow(userId, generationId);
        if (!generation) return fail('generation_gone', '生成任务不存在');
        if (Number(generation.cancel_requested) === 1 || generation.status === 'cancelled') {
          return fail('cancelled', '生成任务已取消', { cancelled: true });
        }
        if (!sessionId || !legacyStore.sessionStillValid(db, userId, sessionId, nowMs())) {
          return fail('session_expired', '登录已失效', { cancelled: true });
        }
        if (legacyStore.jobCancelRequested(db, jobId)) {
          return fail('cancelled', '生成任务已取消', { cancelled: true });
        }
        const project = legacyStore.getProjectRow(db, userId, projectId);
        if (!project) return fail('project_deleted', '项目已删除');
        const scenario = autoStore.getScenarioItem(db, userId, scenarioId);
        if (!scenario || scenario.projectId !== projectId) return fail('scenario_deleted', '场景已删除');
        const row = reservationId ? getReservation(db, userId, reservationId) : null;
        if (!row || row.status !== 'active' || row.task_id !== taskId || Number(row.attempt) !== Number(attempt)) {
          return fail('case_reserved', '该案例的生成预留已转移或失效，本次运行不执行', { release: false });
        }
        return { ok: true };
      });
    } catch (error) {
      return { ok: false, code: error?.code ?? 'internal_error', message: String(error?.message ?? error).slice(0, 300) };
    }
  }

  /**
   * Release the reservation of a failed/interrupted task — matching attempt
   * only. A stale task (its reservation re-bound to a newer attempt) never
   * releases the newer attempt's slot.
   */
  function releaseTask({ userId, reservationId, taskId, attempt = null, code, message }) {
    if (!reservationId) return;
    try {
      withTransaction(db, () => {
        releaseMatchingReservation(db, {
          userId,
          reservationId,
          taskId,
          attempt,
          reason: failureMessage(code, message),
          errorCode: code,
          nowMs: nowMs(),
        });
      });
    } catch (error) {
      logger.warn?.('[imstage-scenario-gen] release failed:', error?.message ?? error);
    }
  }

  /** Release every active reservation bound to a job's unfinished tasks. */
  function releaseJobReservations({ userId, jobId, reason, code = 'interrupted' }) {
    try {
      withTransaction(db, () => {
        const rows = db
          .prepare(
            `SELECT reservation_id FROM scene_reservations
             WHERE user_id = ? AND status = 'active' AND task_id IN
               (SELECT id FROM batch_tasks WHERE job_id = ? AND status <> 'done')`,
          )
          .all(userId, jobId);
        for (const row of rows) {
          releaseReservation(db, { userId, reservationId: row.reservation_id, reason, errorCode: code, nowMs: nowMs() });
        }
      });
    } catch (error) {
      logger.warn?.('[imstage-scenario-gen] job release failed:', error?.message ?? error);
    }
  }

  return {
    enqueue,
    retry,
    cancel,
    status: scenarioGenerationStatus,
    get: (args) => generationView(args.userId, getGenerationRow(args.userId, args.generationId)),
    settleTask,
    guardBeforeRun,
    fetchAccountDefaults,
    afterPublish,
    releaseTask,
    releaseJobReservations,
    onChunkJobSettled,
    recoverInterrupted,
    wake: () => queue?.wake?.(),
  };
}

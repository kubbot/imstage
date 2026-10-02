/**
 * IMStage Projects — durable serial batch worker.
 *
 * One in-process worker claims queued jobs from SQLite in FIFO order and runs
 * each task through the *existing* `ctx.agent.runtime.run`, sharing the same
 * concurrency and rate limiter as interactive Agent runs. Nothing here talks to
 * a provider directly, so there is no second model client and no fallback.
 *
 * Safety properties:
 *   - only `ok: true` runs publish a scene, always as a brand-new UUID;
 *   - failures, cancellations and restarts are recorded truthfully;
 *   - a revoked session or a cancel request aborts the active run and stops the
 *     remaining tasks;
 *   - restart recovery marks any queued/running job interrupted.
 */

import { validateScene } from '../../apps/web/src/studio/model.ts';
import { instantiateTemplate } from '../../packages/schema/templates.ts';
import { assertSceneCapacity } from './capacity.mjs';
import { projectsError } from './errors.mjs';
import { blankScene, buildTaskPrompt } from './model.mjs';
import {
  claimNextJob,
  finalizeJob,
  getJobRowById,
  jobCancelRequested,
  listJobTasks,
  markRemainingTasksCancelled,
  markRemainingTasksInterrupted,
  markTaskCancelled,
  markTaskDone,
  markTaskFailed,
  markTaskInterrupted,
  markTaskRunning,
  markInterruptedJobs,
  deferJob,
  publishGeneratedScene,
  sessionStillValid,
  updateTaskDetail,
} from './store.mjs';

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Build the starting scene for one task. A queued job that froze a template
 * instantiates that exact snapshot with the item values (an explicit template
 * scene keeps its own watermark setting); otherwise the legacy blank scene is
 * used and carries the watermark switch the job froze at enqueue. Platform
 * comes from the task so project defaults keep working for template-free
 * batches.
 */
function initialScene(job, task) {
  const watermarkEnabled = Number(job.watermark_enabled ?? 1) === 1;
  if (typeof job.template_json === 'string' && job.template_json !== '') {
    let definition = null;
    try { definition = JSON.parse(job.template_json); } catch { definition = null; }
    if (definition) {
      const result = instantiateTemplate(definition, task.values ?? {}, task.sceneId);
      if (!result.ok) throw projectsError(422, 'invalid_template_instance', `模板变量不合法：${result.errors.slice(0, 3).join('；')}`);
      // A screenshot-reference template keeps its source platform; switching the
      // label would not convert the source image or its edit layer.
      const candidate = result.value.reference ? result.value : { ...result.value, platform: task.platform };
      const validated = validateScene(candidate);
      if (!validated.ok || !validated.scene) throw projectsError(422, 'invalid_template_instance', '模板实例未通过校验');
      return validated.scene;
    }
  }
  const blank = blankScene(task.platform, task.sceneId, watermarkEnabled);
  // Scenario generation seeds the frozen cast names onto the starting scene so
  // the model builds the conversation around the project's 人物表 (roles travel
  // in the prompt; avatar bytes never do). Cast members beyond the template's
  // participant slots are appended as extra participants.
  const cast = Array.isArray(task.values?.cast) ? task.values.cast.filter((member) => member && member.name) : [];
  if (cast.length === 0) return blank;
  const others = blank.participants.filter((participant) => participant.id !== blank.selfId);
  const renamed = new Map();
  cast.forEach((member, index) => {
    if (others[index]) renamed.set(others[index].id, member.name);
  });
  const participants = blank.participants.map((participant) =>
    (participant.id !== blank.selfId && renamed.has(participant.id)
      ? { ...participant, name: renamed.get(participant.id), avatar: undefined }
      : participant),
  );
  for (let index = others.length; index < cast.length; index += 1) {
    const template = others[0] ?? blank.participants[0];
    participants.push({ ...template, id: `p-cast-${index + 1}`, name: cast[index].name, avatar: undefined });
  }
  return { ...blank, participants };
}

function eventDetail(event) {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'tool') {
    if (event.state === 'error') return `工具失败：${event.detail ?? event.name ?? ''}`;
    if (typeof event.detail === 'string' && event.detail.trim() !== '') return event.detail;
    return '';
  }
  if (event.type === 'assistant' && typeof event.text === 'string' && event.text.trim() !== '') {
    return event.text.slice(0, 300);
  }
  if (event.type === 'error' && typeof event.message === 'string') {
    return `错误：${event.message}`;
  }
  return '';
}

function failureMessage(result) {
  switch (result?.reason) {
    case 'no_mutation':
      return '模型没有生成有效内容';
    case 'incomplete':
      return '模型回复不完整，未生成作品';
    case 'max_rounds':
      return '模型轮次超限，未生成作品';
    case 'max_calls':
      return '工具调用超限，未生成作品';
    case 'timeout':
      return '生成超时，未生成作品';
    case 'aborted':
      return '生成被中断';
    default:
      return result?.error ? String(result.error).slice(0, 300) : '生成失败';
  }
}

/**
 * @param {object} options
 * @param {import('node:sqlite').DatabaseSync} options.db
 * @param {{ runtime: { run: Function }, limiter: { tryStart: Function } }} options.agent
 * @param {() => number} options.nowMs
 * @param {object} [options.logger]
 * @param {object} [options.scenarioGeneration] scenario generation publisher
 *   (`settleTask` / `afterPublish` / `releaseJobReservations` / `onChunkJobSettled`);
 *   scenario-bound tasks are never published through the legacy loose path.
 * @param {(job: object) => void} [options.onJobFinished] durable driver hook
 * @param {number} [options.pollMs]
 * @param {number} [options.sessionCheckMs]
 * @param {number} [options.maxLeaseWaitMs]
 */
export function createBatchQueue({
  db,
  agent,
  nowMs,
  logger = console,
  scenarioGeneration = null,
  onJobFinished = null,
  pollMs = 1_000,
  sessionCheckMs = 2_000,
  maxLeaseWaitMs = 5 * 60 * 1_000,
}) {
  let stopped = false;
  let loopPromise = null;
  let wakeResolver = null;
  const activeRuns = new Map(); // jobId -> AbortController

  function wake() {
    if (wakeResolver) {
      const resolve = wakeResolver;
      wakeResolver = null;
      resolve();
    }
  }

  function waitForWork(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (wakeResolver === finish) wakeResolver = null;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      wakeResolver = finish;
    });
  }

  async function acquireLease(userId, deferDenied = false) {
    const deadline = nowMs() + maxLeaseWaitMs;
    for (;;) {
      if (stopped) return null;
      const lease = agent.limiter.tryStart(userId, nowMs());
      if (lease.ok) return lease;
      // Scenario work yields immediately on a known pre-run denial. Waiting
      // here would monopolize the serial worker until the legacy timeout.
      if (deferDenied) return { deferred: true, retryAfterMs: Math.max(1, Number(lease.retryAfterMs) || 1_000) };
      const remaining = deadline - nowMs();
      if (remaining <= 0) return null;
      await sleep(Math.min(Math.max(100, lease.retryAfterMs ?? 1_000), 5_000, remaining));
    }
  }

  function startWatcher(job, controller) {
    const timer = setInterval(() => {
      if (stopped) {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        if (jobCancelRequested(db, job.id)) {
          controller.abort();
          return;
        }
        if (!sessionStillValid(db, job.user_id, job.session_id, nowMs())) {
          controller.abort();
        }
      } catch {
        /* a transient DB error must not crash the worker */
      }
    }, Math.max(50, sessionCheckMs));
    timer.unref?.();
    return timer;
  }

  function finalize(jobId, { cancelledReason, interruptedReason }) {
    const list = listJobTasks(db, jobId);
    const pending = list.some((task) => task.status === 'queued' || task.status === 'running');
    if (cancelledReason) {
      if (pending) markRemainingTasksCancelled(db, jobId, cancelledReason, nowMs());
      finalizeJob(db, jobId, { status: 'cancelled', reason: cancelledReason }, nowMs());
      return;
    }
    if (interruptedReason) {
      if (pending) markRemainingTasksInterrupted(db, jobId, interruptedReason, nowMs());
      finalizeJob(db, jobId, { status: 'interrupted', reason: interruptedReason }, nowMs());
      return;
    }
    if (pending) {
      markRemainingTasksInterrupted(db, jobId, '任务未完成', nowMs());
      finalizeJob(db, jobId, { status: 'interrupted', reason: '任务未完成' }, nowMs());
      return;
    }
    const next = listJobTasks(db, jobId);
    const done = next.filter((task) => task.status === 'done').length;
    const failed = next.filter((task) => task.status === 'failed').length;
    const cancelled = next.filter((task) => task.status === 'cancelled').length;
    let status = 'done';
    if (failed > 0 && done > 0) status = 'partial';
    else if (failed > 0) status = 'failed';
    else if (cancelled > 0 && done === 0) status = 'cancelled';
    else if (cancelled > 0) status = 'partial';
    finalizeJob(db, jobId, { status, reason: null }, nowMs());
  }

  async function runJob(job) {
    const jobId = job.id;
    const tasks = listJobTasks(db, jobId);
    let cancelledReason = null;
    let interruptedReason = null;

    for (const task of tasks) {
      if (task.status !== 'queued') continue;

      if (stopped) {
        interruptedReason = '服务已重启或停止';
        break;
      }
      const fresh = getJobRowById(db, job.user_id, jobId);
      if (!fresh) {
        interruptedReason = '生成任务不存在';
        break;
      }
      if (Number(fresh.cancel_requested) === 1) {
        cancelledReason = fresh.reason || '已取消';
        break;
      }
      if (!sessionStillValid(db, job.user_id, job.session_id, nowMs())) {
        cancelledReason = '登录已失效，任务已取消';
        break;
      }

      // Capacity pre-flight BEFORE any provider call: real scenes plus active
      // generation reservations must leave a free slot (a scenario task's own
      // reservation is excluded — publishing consumes it). Failing here never
      // spends a model call the account cannot store.
      try {
        assertSceneCapacity(db, job.user_id, 1, { excludeReservationId: task.reservationId ?? null });
      } catch (error) {
        markTaskFailed(db, task.id, { code: error?.code ?? 'scene_limit_reached', message: error?.message ?? '作品数量已达上限' }, nowMs());
        continue;
      }

      const lease = await acquireLease(job.user_id, Boolean(task.generationId));
      if (!lease) {
        interruptedReason = stopped ? '服务已重启或停止' : '等待生成资源超时，任务已中断';
        break;
      }
      if (lease.deferred) {
        if (stopped) { interruptedReason = '服务已重启或停止'; break; }
        if (jobCancelRequested(db, jobId) || !sessionStillValid(db, job.user_id, job.session_id, nowMs())) {
          cancelledReason = '任务已取消或登录已失效';
          break;
        }
        deferJob(db, jobId, nowMs() + lease.retryAfterMs, nowMs());
        return 'deferred';
      }

      if (stopped || jobCancelRequested(db,jobId) || !sessionStillValid(db,job.user_id,job.session_id,nowMs())) { lease.release(); cancelledReason='任务已取消或登录已失效'; break; }
      // Capacity recheck AFTER the async lease wait: another create may have
      // filled the account while waiting. Never spend a provider call the
      // account cannot store; release the lease and fail this task honestly
      // (scenario tasks release only their own matching reservation).
      try {
        assertSceneCapacity(db, job.user_id, 1, { excludeReservationId: task.reservationId ?? null });
      } catch (error) {
        lease.release();
        const message = error?.message ?? '作品数量已达上限';
        markTaskFailed(db, task.id, { code: error?.code ?? 'scene_limit_reached', message }, nowMs());
        if (scenarioGeneration && task.reservationId) {
          scenarioGeneration.releaseTask({
            userId: job.user_id,
            reservationId: task.reservationId,
            taskId: task.id,
            attempt: task.attempt ?? 1,
            code: error?.code ?? 'scene_limit_reached',
            message,
          });
        }
        continue;
      }
      // Scenario tasks: pre-run session/ownership/cancel/fencing inspection so
      // an already-unpublishable task never pays for a model run.
      if (task.itemKey && task.generationId && scenarioGeneration) {
        const guard = scenarioGeneration.guardBeforeRun({
          userId: job.user_id,
          jobId,
          taskId: task.id,
          generationId: task.generationId,
          scenarioId: task.scenarioId,
          projectId: job.project_id,
          itemKey: task.itemKey,
          reservationId: task.reservationId,
          attempt: task.attempt ?? 1,
          sessionId: job.session_id,
        });
        if (!guard.ok) {
          lease.release();
          continue;
        }
      }
      const controller = new AbortController();
      activeRuns.set(jobId, controller);
      markTaskRunning(db, task.id, nowMs());
      const watcher = startWatcher(job, controller);
      let scene;
      try {
        scene = initialScene(job, task);
      } catch (error) {
        clearInterval(watcher);
        activeRuns.delete(jobId);
        lease.release();
        markTaskFailed(db, task.id, { code: error?.code ?? 'invalid_template_instance', message: error?.message ?? '无法从模板创建场景' }, nowMs());
        continue;
      }
      let result;
      try {
        result = await agent.runtime.run({
          prompt: buildTaskPrompt(job.rules, task.prompt),
          scene,
          onEvent: (event) => {
            const detail = eventDetail(event);
            if (detail) updateTaskDetail(db, task.id, detail, nowMs());
          },
          signal: controller.signal,
          userId: job.user_id,
        });
      } catch (error) {
        result = { ok: false, reason: 'error', error: error?.message ?? String(error) };
      } finally {
        clearInterval(watcher);
        activeRuns.delete(jobId);
        lease.release();
      }

      if (stopped) {
        markTaskInterrupted(db, task.id, '服务已停止', nowMs());
        interruptedReason = '服务已重启或停止';
        break;
      }

      if (jobCancelRequested(db,jobId) || !sessionStillValid(db,job.user_id,job.session_id,nowMs())) controller.abort();
      if (controller.signal.aborted) {
        if (!sessionStillValid(db, job.user_id, job.session_id, nowMs())) {
          markTaskCancelled(db, task.id, '登录已失效', nowMs());
          cancelledReason = '登录已失效，任务已取消';
          break;
        }
        if (jobCancelRequested(db, jobId)) {
          markTaskCancelled(db, task.id, '已取消', nowMs());
          cancelledReason = '已取消';
          break;
        }
        markTaskInterrupted(db, task.id, '任务已中断', nowMs());
        continue;
      }

      if (result?.ok === true && result.scene) {
        if (task.itemKey && task.generationId) {
          // Scenario generation: ONE transaction re-checks session/ownership,
          // parent+child cancellation, project/scenario existence, the exact
          // reservation/attempt, scene validity, duplicate dialogue and
          // capacity, then binds content + case + task success atomically.
          if (!scenarioGeneration) {
            markTaskFailed(db, task.id, { code: 'internal_error', message: '场景生成服务未接入，结果未保存' }, nowMs());
            continue;
          }
          let settled;
          try {
            const accountDefaults = scenarioGeneration.fetchAccountDefaults
              ? await scenarioGeneration.fetchAccountDefaults(job.user_id)
              : null;
            if (stopped) {
              // Shutdown after the async defaults read: never publish across a
              // stop — finish honestly as interrupted; already committed tasks
              // stay committed.
              markTaskInterrupted(db, task.id, '服务已停止', nowMs());
              interruptedReason = '服务已重启或停止';
              break;
            }
            settled = scenarioGeneration.settleTask({
              userId: job.user_id,
              jobId,
              taskId: task.id,
              generationId: task.generationId,
              scenarioId: task.scenarioId,
              projectId: job.project_id,
              itemKey: task.itemKey,
              reservationId: task.reservationId,
              attempt: task.attempt ?? 1,
              scene: result.scene,
              sessionId: job.session_id,
              accountDefaults,
            });
          } catch (error) {
            settled = { ok: false, code: error?.code ?? 'publish_failed', message: error?.message ?? '保存生成的作品失败' };
            markTaskFailed(db, task.id, { code: settled.code, message: settled.message }, nowMs());
          }
          if (settled?.ok === true) {
            // Shared auto-export check AFTER commit; an export failure never
            // downgrades the committed task.
            try {
              await scenarioGeneration.afterPublish({
                userId: job.user_id,
                projectId: job.project_id,
                scenarioId: task.scenarioId,
                sessionId: job.session_id,
              });
            } catch (error) {
              logger.warn?.('[imstage-projects] auto export after publish failed:', error?.message ?? error);
            }
          }
        } else {
          try {
            const normalized = validateScene(result.scene);
            if (!normalized.ok || !normalized.scene) {
              throw projectsError(500, 'invalid_scene', '生成的作品未通过校验');
            }
            const scene = { ...normalized.scene, id: task.sceneId };
            publishGeneratedScene(db, {
              userId: job.user_id,
              projectId: job.project_id,
              scene,
              taskId: task.id,
              nowMs: nowMs(),
            });
          } catch (error) {
            markTaskFailed(
              db,
              task.id,
              { code: error?.code ?? 'publish_failed', message: error?.message ?? '保存生成的作品失败' },
              nowMs(),
            );
          }
        }
      } else {
        markTaskFailed(
          db,
          task.id,
          { code: result?.reason ?? 'error', message: failureMessage(result) },
          nowMs(),
        );
      }
    }

    finalize(jobId, { cancelledReason, interruptedReason });
    // Unfinished scenario tasks never keep their promised slots: reservations
    // bound to non-done tasks of this job are released (matching attempt only)
    // so an explicit retry or an MCP submission can resume those case keys.
    if (scenarioGeneration) {
      try {
        scenarioGeneration.releaseJobReservations({
          userId: job.user_id,
          jobId,
          reason: cancelledReason ?? interruptedReason ?? '任务未完成',
          code: cancelledReason ? 'cancelled' : interruptedReason ? 'interrupted' : 'failed',
        });
      } catch (error) {
        logger.warn?.('[imstage-projects] reservation release failed:', error?.message ?? error);
      }
    }
    // Durable chunk driver: release the next chunk of the parent generation
    // (never browser-scheduled) and refresh its status.
    try {
      onJobFinished?.(getJobRowById(db, job.user_id, jobId) ?? job);
    } catch (error) {
      logger.warn?.('[imstage-projects] job hook failed:', error?.message ?? error);
    }
    return 'finalized';
  }

  /**
   * Abandoned queued/deferred jobs (session revoked or expired while waiting)
   * are cancelled here so their reservations are released without waiting for
   * a claim that would only fail later. No provider call is ever made.
   */
  function sweepAbandonedJobs() {
    try {
      const rows = db
        .prepare("SELECT id, user_id, session_id FROM batch_jobs WHERE status = 'queued'")
        .all();
      for (const row of rows) {
        if (!row.session_id || sessionStillValid(db, row.user_id, row.session_id, nowMs())) continue;
        markRemainingTasksCancelled(db, row.id, '登录已失效，任务已取消', nowMs());
        finalizeJob(db, row.id, { status: 'cancelled', reason: '登录已失效，任务已取消' }, nowMs());
        if (scenarioGeneration) {
          scenarioGeneration.releaseJobReservations({
            userId: row.user_id,
            jobId: row.id,
            reason: '登录已失效，任务已取消',
            code: 'cancelled',
          });
        }
        try {
          onJobFinished?.(getJobRowById(db, row.user_id, row.id) ?? row);
        } catch {
          /* best effort */
        }
      }
    } catch {
      /* a transient DB error must not crash the worker */
    }
  }

  async function loop() {
    while (!stopped) {
      let job = null;
      try {
        job = claimNextJob(db, nowMs());
      } catch (error) {
        logger.error?.('[imstage-projects] claim failed:', error?.message ?? error);
      }
      if (!job) {
        sweepAbandonedJobs();
        await waitForWork(pollMs);
        continue;
      }
      try {
        const outcome = await runJob(job);
        if (outcome === 'deferred') continue; // pacing defer: claim other work
      } catch (error) {
        logger.error?.('[imstage-projects] batch job failed:', error?.stack ?? error);
        try {
          markRemainingTasksInterrupted(db, job.id, '服务器内部错误', nowMs());
          finalizeJob(db, job.id, { status: 'interrupted', reason: '服务器内部错误' }, nowMs());
        } catch {
          /* best effort */
        }
      }
      wake();
    }
  }

  return {
    wake,
    start() {
      if (!loopPromise) loopPromise = loop();
      return loopPromise;
    },
    async stop() {
      if (stopped) {
        await loopPromise?.catch(() => {});
        return;
      }
      stopped = true;
      wake();
      for (const controller of activeRuns.values()) {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }
      await loopPromise?.catch(() => {});
      try {
        markInterruptedJobs(db, nowMs());
        // Includes deferred jobs and future chunks; committed cases remain
        // consumed while every unfinished reservation and parent converges.
        scenarioGeneration?.recoverInterrupted();
      } catch {
        /* best effort on shutdown */
      }
    },
    /** Abort a job that may be running right now. */
    cancel(jobId) {
      const controller = activeRuns.get(jobId);
      if (controller) {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }
    },
    snapshot() {
      return { stopped, activeJobs: activeRuns.size, tracked: activeRuns.size };
    },
  };
}

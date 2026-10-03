/**
 * IMStage deterministic project export service (batch B) — transport-free core.
 *
 * One cohesive service owns the full delivery lifecycle for account projects:
 *
 *   enqueue / list / get / status / retry / cancel / download / ticket / cleanup
 *
 * Construction: `createProjectExportService({ db, renderService, exportDir,
 * nowMs, logger })`, initialized once inside the API process and injected into
 * both the account MCP factory and the shared automation service, so HTTP and
 * MCP can never diverge.
 *
 * Guarantees:
 *   - no model is ever called: content comes from the frozen caller-submitted
 *     Scenes, PNGs come from the real deterministic renderer (never faked);
 *   - every export freezes project/scenario/defaults/case metadata and the
 *     current Scene JSON + revision + content hash at enqueue; retries keep the
 *     same snapshot and never re-run successful items;
 *   - authorization is a persisted principal reference ({kind:'grant'|'session',
 *     id}); raw tokens are never stored. Revocation/expiry is re-checked before
 *     each item and again AFTER the slow render resolves, BEFORE any output is
 *     committed or returned, and again before the ZIP is published;
 *   - client disconnects never cancel a bounded export; a process restart marks
 *     active exports `interrupted` while keeping committed outputs;
 *   - current/historical is decided by a full live fingerprint (project/
 *     scenario/case metadata + Scene content + scope membership), not only the
 *     project revision; annotation edits alone already mark a package historical;
 *   - PNG reuse requires the same owner + Scene content + render config +
 *     current renderer/policy versions + still-valid source AND caller
 *     authorization, and copied bytes are re-hashed against the registered hash;
 *   - the worker streams one Scene/PNG at a time into the ZIP (never aggregates
 *     all buffers) and status reads never load scene blobs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { POLICY_VERSION } from '../../audit/generation-audit.mjs';
import { STUDIO_RENDERER_VERSION } from '../../mcp/studio-html.mjs';
import { parsePngHeader, resolveRenderConfig } from '../../mcp/render.mjs';
import { sha256Hex, stableStringify } from '../../mcp/util.mjs';
import { McpToolError } from '../../mcp/errors.mjs';
import { projectsError } from '../errors.mjs';
import * as legacyStore from '../store.mjs';
import * as autoStore from '../automation-store.mjs';
import { sceneContentHash, verifySceneAssets, writeArchive } from './archive.mjs';
import { ZipLimitError, createZipWriter } from './zip.mjs';
import * as exportStore from './store.mjs';

export const EXPORT_LIMITS = Object.freeze({
  itemsMax: 100,
  sceneJsonBytesMax: 64 * 1024 * 1024,
  zipBytesMax: 100 * 1024 * 1024,
  retainedPerUserBytesMax: 500 * 1024 * 1024,
  activePerUser: 3,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  ticketTtlMs: 10 * 60 * 1000,
  itemSummariesMax: 100,
  listMax: 50,
  tmpStaleMs: 60 * 60 * 1000,
});

export const DEFAULT_RENDER_OPTIONS = Object.freeze({
  surface: 'ios',
  width: 390,
  height: 844,
  outputKind: 'long-screenshot',
});

/** Run statuses. Retryable per settled contract: failed/interrupted only —
 * plus `partial` when it still carries explicitly failed/interrupted items
 * (successful items are NEVER re-run). `cancelled` is final. */
export const EXPORT_STATUSES = Object.freeze(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const ACTIVE_STATUSES = new Set(['queued', 'running']);
const RETRYABLE_ITEM_STATES = new Set(['failed', 'interrupted']);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function asProjectsError(error) {
  if (error instanceof McpToolError) {
    return projectsError(error.status ?? 400, error.code, error.message);
  }
  return error;
}

/**
 * Public error messages are bounded AND sanitized: raw fs/Chromium errors can
 * embed private filesystem paths (export dir, Chrome executable). Technical
 * details stay in server logs only; API/status/artifacts never leak paths.
 */
function boundedMessage(value, fallback = '导出失败') {
  const text = typeof value === 'string' && value !== '' ? value : fallback;
  const sanitized = text
    .replace(/(?:[A-Za-z]:)?[\\/](?:Users|private|tmp|var|home|opt|srv|root|Applications|node_modules)[^\s'"`,;)]*/gi, '<path>')
    .replace(/(?:[A-Za-z]:\\)[^\s'"`,;)]*/g, '<path>')
    .replace(/\/(?:[\w.@-]+\/)+[\w.@-]+/g, '<path>');
  return sanitized.length > 300 ? `${sanitized.slice(0, 300)}…` : sanitized;
}

/**
 * @param {object} options
 * @param {object} options.db            SQLite handle (node:sqlite DatabaseSync)
 * @param {object} options.renderService deterministic render service ({render})
 * @param {string} options.exportDir     dedicated export root (IMSTAGE_PROJECT_EXPORT_DIR)
 * @param {() => number} [options.nowMs]
 * @param {object} [options.logger]
 * @param {string} [options.appOrigin]   public origin for download URLs
 */
export function createProjectExportService({
  db,
  renderService,
  exportDir,
  nowMs = Date.now,
  logger = console,
  appOrigin = 'http://127.0.0.1:4417',
  rendererVersion = STUDIO_RENDERER_VERSION,
  policyVersion = POLICY_VERSION,
  // Test seam: override the slow FS boundary to exercise publish races.
  fileOps: fileOpsOverride = {},
} = {}) {
  if (!db) throw new Error('createProjectExportService 需要数据库句柄');
  if (!renderService || typeof renderService.render !== 'function') {
    throw new Error('createProjectExportService 需要 renderService');
  }
  if (typeof exportDir !== 'string' || exportDir === '') {
    throw new Error('createProjectExportService 需要专用 exportDir');
  }
  exportStore.installExportSchema(db);

  const root = path.resolve(exportDir);
  const exportsDir = path.join(root, 'exports');
  const tmpDir = path.join(root, 'tmp');
  // Injectable FS boundary for the slow file operations around commit points —
  // tests block these to exercise publish races honestly (not just renderer
  // gates). Defaults to the real fs.promises operations.
  const fsp = {
    mkdir: fs.promises.mkdir,
    writeFile: fs.promises.writeFile,
    readFile: fs.promises.readFile,
    copyFile: fs.promises.copyFile,
    rename: fs.promises.rename,
    rm: fs.promises.rm,
    stat: fs.promises.stat,
    ...fileOpsOverride,
  };

  function safeId(value, label) {
    if (typeof value !== 'string' || !SAFE_ID_RE.test(value)) {
      throw projectsError(400, 'invalid_id', `${label} 不合法`);
    }
    return value;
  }

  function exportPaths(userId, exportId) {
    const safeUser = safeId(userId, 'userId');
    const safeExport = safeId(exportId, 'exportId');
    return {
      dir: path.join(exportsDir, safeUser, safeExport),
      zip: path.join(exportsDir, safeUser, `${safeExport}.zip`),
      renders: path.join(exportsDir, safeUser, safeExport, 'renders'),
    };
  }

  function itemPngPath(userId, exportId, ordinal) {
    return path.join(exportPaths(userId, exportId).renders, `${String(ordinal).padStart(4, '0')}.png`);
  }

  function tmpPath(prefix) {
    return path.join(tmpDir, `${prefix}-${crypto.randomBytes(8).toString('hex')}.tmp`);
  }

  async function atomicWrite(target, buffer) {
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const staging = tmpPath('file');
    try {
      await fsp.writeFile(staging, buffer);
      await fsp.rename(staging, target);
    } finally {
      await fsp.rm(staging, { force: true }).catch(() => {});
    }
  }

  /* ------------------------------------------------------------------ */
  /* Principal authorization                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Validate one persisted principal reference FOR AN OWNER. Grants require
   * both scopes and, for personal-token grants, a live (non-rotated, non
   * expired) token — the retained personal expiry is authoritative. Sessions
   * are checked by owner id + expiry. Users must exist. Normal OAuth
   * access-token expiry/refresh never invalidates a still-active grant.
   */
  function principalValid({ kind, id, userId }) {
    if (typeof userId !== 'string' || userId === '') return false;
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) return false;
    if (kind === 'session') {
      const row = db.prepare('SELECT user_id, expires_at_ms FROM sessions WHERE id = ?').get(id);
      return Boolean(row) && row.user_id === userId && Number(row.expires_at_ms) > nowMs();
    }
    if (kind === 'grant') {
      const row = db.prepare('SELECT * FROM oauth_grants WHERE id = ?').get(id);
      if (!row || row.user_id !== userId || row.revoked_at) return false;
      let scopes = [];
      try {
        scopes = JSON.parse(row.scopes_json ?? '[]');
      } catch {
        scopes = [];
      }
      if (!scopes.includes('imstage.scenes') || !scopes.includes('imstage.projects')) return false;
      if (!['oauth', 'token', 'web'].includes(row.source)) return false;
      if (row.source === 'token') {
        const token = db
          .prepare(
            `SELECT 1 AS ok FROM oauth_tokens
             WHERE grant_id = ? AND user_id = ? AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at_ms > ?
             LIMIT 1`,
          )
          .get(id, userId, nowMs());
        return Boolean(token);
      }
      return true;
    }
    return false;
  }

  function requirePrincipal(principal) {
    if (!principal || (principal.kind !== 'grant' && principal.kind !== 'session') || typeof principal.id !== 'string' || principal.id === '') {
      throw projectsError(401, 'unauthorized', '缺少有效的授权引用');
    }
    return principal;
  }

  /* ------------------------------------------------------------------ */
  /* Freeze: scope → items (one snapshot per case, transiently bounded)  */
  /* ------------------------------------------------------------------ */

  function normalizeRenderOptions(raw) {
    const merged = { ...DEFAULT_RENDER_OPTIONS, ...(raw ?? {}) };
    try {
      return resolveRenderConfig(merged);
    } catch (error) {
      throw asProjectsError(error);
    }
  }

  function requestHashFor(input) {
    return sha256Hex(
      stableStringify({
        operation: 'export_project',
        projectId: input.projectId,
        expectedRevision: input.expectedRevision ?? null,
        scenarioId: input.scenarioId ?? null,
        sceneIds: input.sceneIds ?? null,
        renderOptions: input.renderOptions ?? null,
        allowPartial: input.allowPartial === true,
        auto: input.auto === true,
      }),
    );
  }

  function caseRowsForScenario(userId, projectId, scenarioId) {
    return autoStore.listCaseRows(db, userId, scenarioId, projectId).map(autoStore.caseItem);
  }

  function liveSceneFor(userId, sceneId) {
    if (!sceneId) return null;
    const row = db.prepare('SELECT id, revision, scene_json FROM scenes WHERE user_id = ? AND id = ?').get(userId, sceneId);
    if (!row) return null;
    let scene;
    try {
      scene = JSON.parse(row.scene_json);
    } catch {
      return null;
    }
    return { id: row.id, revision: Number(row.revision), scene };
  }

  function scenarioSnapshot(scenario, plan) {
    return {
      id: scenario.id,
      name: scenario.name,
      brief: scenario.brief,
      preset: scenario.preset,
      caseCount: scenario.caseCount,
      platform: scenario.platform,
      locale: scenario.locale,
      recipeType: scenario.recipeType,
      recipeVersion: scenario.recipeVersion,
      revision: scenario.revision,
      frozen: scenario.frozen,
      plan,
    };
  }

  /** Internal identity: unique per export even when two scenarios share case-001. */
  function itemIdFor(scenarioId, itemKey) {
    return scenarioId ? `${scenarioId}:${itemKey}` : itemKey;
  }

  function freezeItem({ userId, itemKey, ordinal, scenarioId, meta, recipeType }) {
    const live = liveSceneFor(userId, meta.sceneId);
    if (!live) {
      throw projectsError(422, 'missing_items', `案例 ${itemKey} 的场景不存在或不可解析`);
    }
    return {
      itemId: itemIdFor(scenarioId, itemKey),
      itemKey,
      ordinal,
      scenarioId: scenarioId ?? null,
      name: meta.name ?? '',
      objective: meta.objective ?? '',
      context: meta.context ?? '',
      annotations: meta.annotations ?? { labels: {} },
      recipeType: recipeType ?? 'custom',
      sceneId: live.id,
      sceneRevision: live.revision,
      scene: live.scene,
      sceneHash: sceneContentHash(live.scene),
      dialogueHash: autoStore.dialogueSignature(live.scene),
    };
  }

  function scenarioContextFor(userId, projectId, scenarioId) {
    const scenario = autoStore.getScenarioItem(db, userId, scenarioId);
    if (!scenario || scenario.projectId !== projectId) {
      throw projectsError(404, 'not_found', '场景不存在');
    }
    const row = autoStore.getScenarioRow(db, userId, scenarioId);
    return { scenario, plan: autoStore.scenarioPlan(row) };
  }

  /** Light scene lookup (no blob) for membership/metadata resolution. */
  function sceneMetaFor(userId, sceneId) {
    return (
      db.prepare('SELECT id, revision, title FROM scenes WHERE user_id = ? AND id = ?').get(userId, sceneId) ?? null
    );
  }

  /**
   * ONE scope resolver used by BOTH the freeze path and the live fingerprint
   * recompute (metadata + scene ids only, never scene blobs):
   *   - linked case metadata is only used when the linked scenario belongs to
   *     THIS project — a case scene re-attached from another project is loose;
   *   - sceneIds selections collect deduped frozen scenario snapshots for every
   *     linked scenario, so scenario.json files and frozen recipe requirements
   *     (e.g. evaluation_dataset) are complete and honored after project type
   *     changes;
   *   - membership is submitted planned cases + loose project scenes.
   */
  function resolveScopeMeta({ userId, projectId, scenarioId, sceneIds }) {
    const entries = [];
    const missing = [];
    const scenarioMap = new Map();
    const caseLinkedScenes = new Set();

    const scenarioOf = (candidateId) => {
      if (!candidateId) return null;
      const scenario = autoStore.getScenarioItem(db, userId, candidateId);
      return scenario && scenario.projectId === projectId ? scenario : null;
    };
    const snapshotFor = (scenario) => {
      if (!scenarioMap.has(scenario.id)) {
        scenarioMap.set(scenario.id, scenarioSnapshot(scenario, autoStore.scenarioPlan(autoStore.getScenarioRow(db, userId, scenario.id))));
      }
      return scenarioMap.get(scenario.id);
    };

    const pushCase = (caseItemRow, scenario) => {
      if (caseItemRow.sceneId) caseLinkedScenes.add(caseItemRow.sceneId);
      if (!caseItemRow.submitted || !caseItemRow.sceneId) {
        missing.push({ itemKey: caseItemRow.itemKey, scenarioId: scenario?.id ?? null, reason: 'not_submitted' });
        return;
      }
      entries.push({
        itemId: itemIdFor(scenario?.id ?? null, caseItemRow.itemKey),
        itemKey: caseItemRow.itemKey,
        scenarioId: scenario?.id ?? null,
        sceneId: caseItemRow.sceneId,
        meta: caseItemRow,
        recipeType: scenario?.recipeType ?? null,
      });
    };

    const pushScene = (sceneId) => {
      const metaRow = sceneMetaFor(userId, sceneId);
      const attached = db
        .prepare('SELECT 1 AS ok FROM scene_projects WHERE user_id = ? AND scene_id = ? AND project_id = ?')
        .get(userId, sceneId, projectId);
      if (!metaRow || !attached) throw projectsError(404, 'not_found', '作品不存在或不属于该项目');
      const linkedRow = db
        .prepare('SELECT c.scenario_id, c.item_key FROM scenario_cases c WHERE c.user_id = ? AND c.scene_id = ? LIMIT 1')
        .get(userId, sceneId);
      const scenario = linkedRow?.scenario_id ? scenarioOf(linkedRow.scenario_id) : null;
      const linkedMeta = scenario
        ? caseRowsForScenario(userId, projectId, scenario.id).find((entry) => entry.itemKey === linkedRow.item_key)
        : null;
      if (scenario) snapshotFor(scenario);
      const looseKey = `scene-${sceneId}`;
      const meta = linkedMeta ?? {
        sceneId,
        name: typeof metaRow.title === 'string' && metaRow.title !== '' ? metaRow.title : `Scene ${sceneId.slice(0, 8)}`,
        objective: '',
        context: '',
        annotations: { labels: {} },
      };
      entries.push({
        itemId: itemIdFor(linkedMeta ? scenario?.id ?? null : null, linkedMeta ? linkedRow.item_key : looseKey),
        itemKey: linkedMeta ? linkedRow.item_key : looseKey,
        scenarioId: linkedMeta ? scenario?.id ?? null : null,
        sceneId,
        meta,
        recipeType: linkedMeta ? scenario?.recipeType ?? null : null,
      });
    };

    if (scenarioId) {
      const scenario = scenarioOf(scenarioId);
      if (!scenario) throw projectsError(404, 'not_found', '场景不存在');
      snapshotFor(scenario);
      for (const entry of caseRowsForScenario(userId, projectId, scenarioId)) pushCase(entry, scenario);
    } else if (Array.isArray(sceneIds) && sceneIds.length > 0) {
      for (const sceneId of sceneIds) pushScene(sceneId);
    } else {
      for (const row of autoStore.listScenarioRows(db, userId, projectId)) {
        const scenario = autoStore.scenarioItem(row);
        snapshotFor(scenario);
        for (const entry of caseRowsForScenario(userId, projectId, scenario.id)) pushCase(entry, scenario);
      }
      const loose = db
        .prepare(
          `SELECT sp.scene_id AS id FROM scene_projects sp
           WHERE sp.user_id = ? AND sp.project_id = ?
           ORDER BY sp.created_at ASC, sp.scene_id ASC`,
        )
        .all(userId, projectId);
      for (const row of loose) {
        if (caseLinkedScenes.has(row.id)) continue;
        pushScene(row.id);
      }
    }
    return { entries, missing, scenarios: [...scenarioMap.values()] };
  }

  /** Freeze path: resolves the scope then snapshots scenes one at a time
   * (transient ≤ 64 MiB, enforced by validateFreeze). */
  function resolveScope({ userId, projectId, project, scenarioId, sceneIds }) {
    const meta = resolveScopeMeta({ userId, projectId, scenarioId, sceneIds });
    const items = [];
    let sceneJsonBytes = 0;
    for (const entry of meta.entries) {
      const frozen = freezeItem({
        userId,
        itemKey: entry.itemKey,
        ordinal: items.length + 1,
        scenarioId: entry.scenarioId,
        meta: entry.meta,
        recipeType: entry.recipeType ?? project.type,
      });
      sceneJsonBytes += Buffer.byteLength(JSON.stringify(frozen.scene), 'utf8');
      items.push(frozen);
    }
    return { items, missing: meta.missing, scenarios: meta.scenarios, sceneJsonBytes };
  }

  /**
   * Full fingerprint over everything the package delivers: scope membership,
   * frozen scenario snapshots (recipe/rules/cast — never re-judged against
   * mutable project settings for scenario exports), per-case metadata
   * (name/objective/context/annotations) and Scene CONTENT hashes, plus the
   * render config and renderer/policy versions. Whole-project exports also
   * cover the live project settings. Annotation edits therefore mark an older
   * package historical while PNGs stay reusable.
   */
  function fingerprintParts({ scope, project, projectPart, scenarios, items, missing }) {
    return {
      // Normalized so frozen and live recompute always hash the same shape.
      scope: {
        scenarioId: scope?.scenarioId ?? null,
        sceneIds: Array.isArray(scope?.sceneIds) ? [...scope.sceneIds].sort() : null,
        wholeProject: scope?.wholeProject === true,
      },
      project: projectPart ?? { id: project.id },
      scenarios: scenarios.map((scenario) => ({
        id: scenario.id,
        name: scenario.name,
        brief: scenario.brief,
        preset: scenario.preset,
        caseCount: scenario.caseCount,
        platform: scenario.platform,
        locale: scenario.locale,
        recipeType: scenario.recipeType,
        recipeVersion: scenario.recipeVersion,
        revision: scenario.revision,
        frozen: scenario.frozen,
      })),
      items: items.map((item) => ({
        itemId: item.itemId,
        itemKey: item.itemKey,
        scenarioId: item.scenarioId ?? null,
        name: item.name,
        objective: item.objective,
        context: item.context,
        annotations: item.annotations ?? {},
        sceneHash: item.sceneHash,
      })),
      missing: (missing ?? []).map((entry) => entry.itemKey).sort(),
    };
  }

  function fingerprintOf(parts, renderOptions) {
    return sha256Hex(stableStringify({ ...parts, renderOptions, rendererVersion, policyVersion }));
  }

  /** The exact project envelope delivered into project.json/manifest — part of
   * the fingerprint for EVERY scope, so project metadata edits flip history. */
  function projectPartFor(projectRow, project) {
    return {
      id: projectRow.id,
      name: projectRow.name,
      type: project.type,
      recipeVersion: project.recipeVersion,
      rules: projectRow.rules,
      platform: projectRow.platform,
      watermarkEnabled: Number(projectRow.watermark_enabled ?? 1) === 1,
      brief: project.brief ?? {},
      revision: Number(projectRow.revision),
    };
  }

  /** Recompute the same fingerprint parts from LIVE data (one scene at a time). */
  function liveFingerprintFor(row, renderOptions) {
    const scope = JSON.parse(row.scope_json ?? '{}');
    const project = legacyStore.getProjectContext(db, row.user_id, row.project_id);
    const projectRow = legacyStore.getProjectRow(db, row.user_id, row.project_id);
    if (!project || !projectRow) return null;
    let meta;
    try {
      meta = resolveScopeMeta({
        userId: row.user_id,
        projectId: row.project_id,
        scenarioId: scope.scenarioId ?? null,
        sceneIds: Array.isArray(scope.sceneIds) ? scope.sceneIds : null,
      });
    } catch {
      return null;
    }
    const items = [];
    const missing = [...meta.missing];
    for (const entry of meta.entries) {
      // One scene at a time: only the hash/metadata is accumulated.
      const live = liveSceneFor(row.user_id, entry.sceneId);
      if (!live) {
        missing.push({ itemKey: entry.itemKey, scenarioId: entry.scenarioId });
        continue;
      }
      items.push({
        itemId: entry.itemId,
        itemKey: entry.itemKey,
        scenarioId: entry.scenarioId,
        name: entry.meta.name ?? '',
        objective: entry.meta.objective ?? '',
        context: entry.meta.context ?? '',
        annotations: entry.meta.annotations ?? {},
        sceneHash: sceneContentHash(live.scene),
      });
    }
    const parts = fingerprintParts({
      scope: { scenarioId: scope.scenarioId ?? null, sceneIds: scope.sceneIds ?? null, wholeProject: scope.wholeProject === true },
      project,
      projectPart: projectPartFor(projectRow, project),
      scenarios: meta.scenarios,
      items,
      missing,
    });
    return fingerprintOf(parts, renderOptions);
  }

  /**
   * Shared freeze-time validation (explicit AND auto export paths):
 *   - planned dialogues within EACH scenario must not be exact duplicates
   *     (loose legacy scenes are never cross-compared);
   *   - frozen evaluation_dataset recipe requires caller annotations;
   *   - empty / missing / size limits.
   */
  function validateFreeze({ items, missing, allowPartial, sceneJsonBytes }) {
    const byScenario = new Map();
    for (const item of items) {
      if (!item.scenarioId) continue; // loose legacy entries: never cross-compared
      const group = byScenario.get(item.scenarioId) ?? new Map();
      const prior = group.get(item.dialogueHash);
      if (prior) {
        throw projectsError(409, 'duplicate_dialogue', `场景内案例对话内容重复（忽略 ID/标题/时间/平台）：${[prior, item.itemKey].sort().join(', ')}`);
      }
      group.set(item.dialogueHash, item.itemKey);
      byScenario.set(item.scenarioId, group);
    }
    for (const item of items) {
      if (item.recipeType === 'evaluation_dataset' && Object.keys(item.annotations?.labels ?? {}).length === 0) {
        throw projectsError(422, 'missing_annotations', `评测案例 ${item.itemKey} 缺少调用方标注`);
      }
    }
    if (items.length === 0) {
      throw projectsError(422, 'empty_export', '没有可导出的内容：请先提交案例内容');
    }
    if (items.length > EXPORT_LIMITS.itemsMax) {
      throw projectsError(413, 'item_limit', `单次导出最多 ${EXPORT_LIMITS.itemsMax} 个作品`);
    }
    if (sceneJsonBytes > EXPORT_LIMITS.sceneJsonBytesMax) {
      throw projectsError(413, 'scene_payload_too_large', '冻结的 Scene JSON 总量超过 64 MiB 上限');
    }
    if (missing.length > 0 && !allowPartial) {
      throw projectsError(
        422,
        'missing_items',
        `缺少 ${missing.length} 个计划案例（${missing.slice(0, 5).map((entry) => entry.itemKey).join(', ')}…）；可传 allowPartial 导出已有内容`,
      );
    }
  }

  /* ------------------------------------------------------------------ */
  /* Enqueue                                                             */
  /* ------------------------------------------------------------------ */

  function exportView(row, { includeItems = true, fingerprintCache = null } = {}) {
    // Counts/metadata come from blob-free summaries even when the per-item
    // array is omitted (status payloads must never load scene JSON).
    const summaries = exportStore.listExportItemSummaries(db, row.user_id, row.id);
    const counts = {
      items: Number(row.item_count),
      done: summaries.filter((item) => item.status === 'done').length,
      failed: summaries.filter((item) => item.status === 'failed').length,
      cancelled: summaries.filter((item) => item.status === 'cancelled').length,
      interrupted: summaries.filter((item) => item.status === 'interrupted').length,
      reused: summaries.filter((item) => item.reused).length,
    };
    const missing = summaries.filter((item) => item.status !== 'done').map((item) => item.itemKey);
    let renderOptions = {};
    try {
      renderOptions = JSON.parse(row.render_options_json ?? '{}');
    } catch {
      renderOptions = {};
    }
    return {
      exportId: row.id,
      projectId: row.project_id,
      scenarioId: row.scenario_id ?? null,
      scope: (() => {
        try {
          return JSON.parse(row.scope_json ?? '{}');
        } catch {
          return {};
        }
      })(),
      status: row.status,
      phase: row.phase || null,
      cancelRequested: Number(row.cancel_requested) === 1,
      allowPartial: Number(row.allow_partial) === 1,
      renderOptions,
      origin: row.origin ?? '',
      counts,
      missingItemKeys: missing.slice(0, EXPORT_LIMITS.itemSummariesMax),
      missingTruncated: missing.length > EXPORT_LIMITS.itemSummariesMax,
      items: includeItems ? summaries.slice(0, EXPORT_LIMITS.itemSummariesMax) : undefined,
      itemsTruncated: includeItems ? summaries.length > EXPORT_LIMITS.itemSummariesMax : undefined,
      contentState: contentStateFor(row, renderOptions, fingerprintCache),
      delivery: {
        state: deliveryExpired(row) ? 'expired' : row.delivery_state,
        available: !deliveryExpired(row) && row.delivery_state === 'active' && Boolean(row.zip_path) && ['completed', 'partial'].includes(row.status),
        zipBytes: row.zip_bytes === null || row.zip_bytes === undefined ? null : Number(row.zip_bytes),
        zipSha256: row.zip_sha256 ?? null,
        expiresAt: row.expires_at ?? null,
        downloadUrl: !deliveryExpired(row) && row.zip_path ? `${appOrigin}/api/projects/${row.project_id}/exports/${row.id}/download` : null,
      },
      principal: { kind: row.principal_kind },
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? '' } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
    };
  }

  /** current/historical from the FULL live fingerprint, not just revision. */
  function deliveryExpired(row) {
    return row.delivery_state === 'expired' || (row.expires_at !== null && row.expires_at !== undefined && Date.parse(row.expires_at) <= nowMs());
  }

  function contentStateFor(row, renderOptions, fingerprintCache = null) {
    if (deliveryExpired(row)) return 'expired';
    if (!['completed', 'partial'].includes(row.status)) return 'current';
    try {
      const cacheKey = stableStringify({ scope: JSON.parse(row.scope_json ?? '{}'), renderOptions });
      const live = fingerprintCache?.has(cacheKey)
        ? fingerprintCache.get(cacheKey)
        : liveFingerprintFor(row, renderOptions);
      fingerprintCache?.set(cacheKey, live);
      if (live === null) return 'historical';
      return live === row.fingerprint ? 'current' : 'historical';
    } catch {
      return 'historical';
    }
  }

  function createExportRow({ userId, projectId, project, projectRow, scenarios, items, missing, renderOptions, allowPartial, scenarioId, sceneIds, clientKey, requestHash, principal, origin, scope }) {
    const exportId = crypto.randomUUID();
    const parts = fingerprintParts({
      scope,
      project,
      // Full project envelope for EVERY scope: project.json delivers it, so
      // project metadata edits must flip history and break auto dedupe.
      projectPart: projectPartFor(projectRow, project),
      scenarios,
      items,
      missing,
    });
    const fingerprint = fingerprintOf(parts, renderOptions);
    const frozen = {
      project: {
        id: project.id,
        name: project.name,
        type: project.type,
        recipeVersion: project.recipeVersion,
        rules: project.rules,
        platform: project.platform,
        watermarkEnabled: project.watermarkEnabled,
        brief: project.brief ?? {},
        revision: projectRow.revision,
      },
      scenarios,
      missingItems: missing,
      renderer: { version: rendererVersion },
      policy: { version: policyVersion },
    };
    exportStore.withTransaction(db, () => {
      // Charge the incoming frozen payload before insertion, including failed
      // jobs that may never produce a PNG. UTF-8 bytes match SQLite storage.
      const incomingBytes = Buffer.byteLength(JSON.stringify(frozen)) + items.reduce((total, item) => total
        + Buffer.byteLength(JSON.stringify(item.scene ?? {}))
        + Buffer.byteLength(JSON.stringify(item.annotations ?? {}))
        + Buffer.byteLength(item.name ?? '') + Buffer.byteLength(item.objective ?? '')
        + Buffer.byteLength(item.context ?? ''), 0);
      assertRetainedBudget(userId, incomingBytes);
      exportStore.insertExport(db, {
        exportRow: {
          userId,
          id: exportId,
          projectId,
          scenarioId,
          scope,
          clientKey,
          requestHash,
          fingerprint,
          frozen,
          principal,
          allowPartial,
          renderOptions,
          origin,
          // Bounded snapshot retention from creation (see exports/store.mjs).
          expiresAt: exportStore.isoAt(nowMs() + EXPORT_LIMITS.retentionMs),
        },
        items,
        nowMs: nowMs(),
      });
    });
    wake();
    return { export: exportView(exportStore.getExportRow(db, userId, exportId)), deduplicated: false };
  }
  function enqueue({ userId, projectId, input = {}, principal, origin = '' }) {
    requirePrincipal(principal);
    const id = projectId;
    const project = legacyStore.getProjectContext(db, userId, id);
    if (!project) throw projectsError(404, 'not_found', '项目不存在');
    const projectRow = legacyStore.getProjectRow(db, userId, id);
    const clientKey = typeof input.idempotencyKey === 'string' && input.idempotencyKey !== '' ? input.idempotencyKey.slice(0, 128) : null;
    const requestHash = requestHashFor({ projectId: id, ...input });
    // Idempotent replay resolves BEFORE any mutable state/revision check.
    const priorRow = exportStore.findExportByClientKey(db, userId, id, clientKey);
    if (priorRow) {
      if (priorRow.request_hash !== requestHash) {
        throw projectsError(409, 'idempotency_conflict', '该 idempotencyKey 已用于不同的请求内容');
      }
      return { export: exportView(priorRow), deduplicated: true };
    }

    if (input.expectedRevision !== undefined && input.expectedRevision !== null) {
      const expected = Number(input.expectedRevision);
      if (!Number.isInteger(expected) || expected < 1) {
        throw projectsError(400, 'invalid_revision', 'expectedRevision 必须是正整数');
      }
      if (Number(projectRow.revision) !== expected) {
        throw projectsError(409, 'revision_conflict', `项目已更新：期望 revision ${expected}，当前 ${projectRow.revision}`);
      }
    }
    const renderOptions = normalizeRenderOptions(input.renderOptions);
    const allowPartial = input.allowPartial === true;
    const scenarioId = typeof input.scenarioId === 'string' && input.scenarioId !== '' ? input.scenarioId : null;
    const sceneIds = Array.isArray(input.sceneIds) ? input.sceneIds : null;
    if (scenarioId && sceneIds) {
      throw projectsError(400, 'invalid_scope', 'scenarioId 与 sceneIds 只能二选一');
    }
    if (sceneIds) {
      if (sceneIds.length < 1 || sceneIds.length > EXPORT_LIMITS.itemsMax) {
        throw projectsError(400, 'invalid_scope', `sceneIds 需为 1-${EXPORT_LIMITS.itemsMax} 个`);
      }
      for (const sceneId of sceneIds) safeId(sceneId, 'sceneId');
    }
    const scope = scenarioId ? { scenarioId } : sceneIds ? { sceneIds } : { wholeProject: true };

    const { items, missing, scenarios, sceneJsonBytes } = resolveScope({ userId, projectId: id, project, scenarioId, sceneIds });
    validateFreeze({ items, missing, allowPartial, sceneJsonBytes });

    if (exportStore.countActiveExports(db, userId) >= EXPORT_LIMITS.activePerUser) {
      throw projectsError(429, 'export_limit_reached', `同时进行的导出最多 ${EXPORT_LIMITS.activePerUser} 个`);
    }
    if (exportStore.retainedBytesForUser(db, userId) >= EXPORT_LIMITS.retainedPerUserBytesMax) {
      throw projectsError(429, 'storage_quota', '账号导出保留总量已达 500 MiB 上限，请等待旧导出过期或删除项目');
    }

    return createExportRow({
      userId,
      projectId: id,
      project,
      projectRow,
      scenarios,
      items,
      missing,
      renderOptions,
      allowPartial,
      scenarioId,
      sceneIds,
      clientKey,
      requestHash,
      principal,
      origin,
      scope,
    });
  }

  /**
   * AutoExport: queue ONE deduped scenario export when the final content batch
   * completed the plan (cases AND required annotations). Shares the exact
   * validation + fingerprint path with explicit enqueue; capacity problems are
   * soft signals (content already saved — never rolled back, never faked).
   */
  async function enqueueAutoScenario({ userId, projectId, scenarioId, principal, renderOptions: rawRenderOptions = null }) {
    try {
      requirePrincipal(principal);
      const project = legacyStore.getProjectContext(db, userId, projectId);
      const projectRow = legacyStore.getProjectRow(db, userId, projectId);
      if (!project || !projectRow) return { queued: false, reason: 'not_found' };
      const renderOptions = normalizeRenderOptions(rawRenderOptions);
      const scope = { scenarioId };
      const { items, missing, scenarios, sceneJsonBytes } = resolveScope({ userId, projectId, project, scenarioId, sceneIds: null });
      // Honest signals before any queueing attempt.
      if (missing.length > 0) return { queued: false, reason: 'missing_items', missing: missing.length };
      for (const item of items) {
        if (item.recipeType === 'evaluation_dataset' && Object.keys(item.annotations?.labels ?? {}).length === 0) {
          return { queued: false, reason: 'missing_annotations', missing: 1 };
        }
      }
      try {
        validateFreeze({ items, missing: [], allowPartial: false, sceneJsonBytes });
      } catch (error) {
        return { queued: false, reason: error?.code ?? 'invalid' };
      }
      const parts = fingerprintParts({ scope, project, projectPart: projectPartFor(projectRow, project), scenarios, items, missing: [] });
      const fingerprint = fingerprintOf(parts, renderOptions);
      const existing = exportStore.findExportByFingerprint(db, userId, projectId, scenarioId, fingerprint);
      if (existing) return { queued: false, reason: 'already_exported', exportId: existing.id };
      if (exportStore.countActiveExports(db, userId) >= EXPORT_LIMITS.activePerUser) {
        return { queued: false, reason: 'export_limit_reached' };
      }
      if (exportStore.retainedBytesForUser(db, userId) >= EXPORT_LIMITS.retainedPerUserBytesMax) {
        return { queued: false, reason: 'storage_quota' };
      }
      const result = createExportRow({
        userId,
        projectId,
        project,
        projectRow,
        scenarios,
        items,
        missing: [],
        renderOptions,
        allowPartial: false,
        scenarioId,
        sceneIds: null,
        clientKey: null,
        requestHash: requestHashFor({ projectId, scenarioId, renderOptions, allowPartial: false, auto: true }),
        principal,
        origin: 'auto-export',
        scope,
      });
      return { queued: true, exportId: result.export.exportId };
    } catch (error) {
      logger.warn?.('[imstage-exports] auto export skipped:', error?.message ?? error);
      return { queued: false, reason: error?.code ?? 'error' };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reads                                                               */
  /* ------------------------------------------------------------------ */

  function requireExport(userId, projectId, exportId) {
    const row = exportStore.getExportRow(db, userId, exportId);
    if (!row || row.project_id !== projectId) throw projectsError(404, 'not_found', '导出不存在');
    return row;
  }

  function get({ userId, projectId, exportId }) {
    return { export: exportView(requireExport(userId, projectId, exportId)) };
  }

  function list({ userId, projectId, limit = 20 }) {
    if (!legacyStore.getProjectContext(db, userId, projectId)) throw projectsError(404, 'not_found', '项目不存在');
    const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, EXPORT_LIMITS.listMax) : 20;
    const items = exportStore.listExportRows(db, userId, projectId, bounded).map((row) => exportView(row, { includeItems: false }));
    return { items };
  }

  /** Delivery summary for project status payloads (bounded, blob-free). */
  function projectDeliverySummary({ userId, projectId }) {
    if (!legacyStore.getProjectContext(db, userId, projectId)) return null;
    const rows = exportStore.listExportRows(db, userId, projectId, 5);
    const liveScope = resolveScopeMeta({ userId, projectId, scenarioId: null, sceneIds: null });
    const expected = new Set([
      ...liveScope.entries.map((item) => item.itemId),
      ...liveScope.missing.map((item) => itemIdFor(item.scenarioId, item.itemKey)),
    ]);
    const liveTotal = expected.size;
    const empty = {
      export: 'not_started',
      active: exportStore.countActiveExportsForProject(db, userId, projectId),
      latest: null,
      current: null,
      currentExports: [],
      historical: [],
      coverage: { delivered: 0, expected: liveTotal, complete: false },
      downloadsExpireAt: null,
      note: '内容齐备后调用导出（或启用 autoExport）生成文件包；导出完成后此摘要显示下载与过期信息。',
    };
    if (rows.length === 0) return empty;
    const fingerprintCache = new Map();
    const views = rows.map((row) => exportView(row, { includeItems: false, fingerprintCache }));
    const delivered = new Set();
    const currentExports = [];
    let current = null;
    // History pagination cannot decide completion. Inspect all viable packages
    // without loading frozen blobs, stopping once their union covers the plan.
    for (const row of exportStore.iterateCurrentDeliveryRows(db, userId, projectId, nowMs())) {
      const view = exportView(row, { includeItems: false, fingerprintCache });
      if (view.contentState !== 'current' || !view.delivery.available || view.counts.failed > 0 || view.missingItemKeys.length > 0) continue;
      const keys = new Set(exportStore.listExportItemSummaries(db, userId, row.id)
        .filter((item) => item.status === 'done' && expected.has(item.itemId)).map((item) => item.itemId));
      let contributes = false;
      for (const key of keys) {
        if (!delivered.has(key)) contributes = true;
        delivered.add(key);
      }
      if (contributes) currentExports.push(view);
      // The single whole package is recorded even when older packs already
      // cover the plan union (rows with equal created_at have no stable order):
      // never miss it, never replace it with an older one, and only stop the
      // scan once both the union is covered AND the whole package was seen.
      if (liveTotal > 0 && keys.size === liveTotal && current === null) current = view;
      if (liveTotal > 0 && delivered.size === liveTotal && current !== null) break;
    }
    const complete = liveTotal > 0 && delivered.size === liveTotal;
    return {
      export: views[0].status,
      // Active exports are counted PER PROJECT: unrelated account exports must
      // never make this project show "exporting".
      active: exportStore.countActiveExportsForProject(db, userId, projectId),
      latest: views[0],
      current,
      // Multiple scenario packages are distinct downloads; no synthetic ZIP.
      currentExports,
      historical: views
        .filter((view) => view.contentState === 'historical')
        .map((view) => ({
          exportId: view.exportId,
          status: view.status,
          finishedAt: view.finishedAt,
          expiresAt: view.delivery.expiresAt,
          downloadAvailable: view.delivery.available,
        })),
      coverage: { delivered: delivered.size, expected: liveTotal, complete },
      downloadsExpireAt: currentExports.map((view) => view.delivery.expiresAt).filter(Boolean).sort()[0] ?? null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Retry / cancel                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Explicit retry of FAILED/INTERRUPTED items of the same frozen snapshot
   * (plus `partial` exports that still carry failed/interrupted items).
   * Successful items are never re-run. The caller's CURRENT principal
   * re-authorizes the snapshot — a stale original grant never bypasses this.
   */
  function retry({ userId, projectId, exportId, principal, idempotencyKey = null }) {
    requirePrincipal(principal);
    const requestHash = sha256Hex(stableStringify({
      operation: 'export.retry',
      projectId,
      exportId,
      principal: { kind: principal.kind, id: principal.id },
    }));
    const key = idempotencyKey ? `export.retry:${idempotencyKey}` : null;
    // Same-key replay resolves BEFORE mutable state checks; a different body
    // (other export / other caller) with the same key is an explicit conflict.
    const prior = autoStore.readIdempotent(db, userId, key, 'export.retry', requestHash);
    if (prior) return { ...prior, deduplicated: true };

    const row = requireExport(userId, projectId, exportId);
    if (ACTIVE_STATUSES.has(row.status)) throw projectsError(409, 'export_active', '导出仍在进行，无需重试');
    const summaries = exportStore.listExportItemSummaries(db, userId, exportId);
    const retryable = summaries.filter((item) => RETRYABLE_ITEM_STATES.has(item.status));
    const canRetry = row.status === 'failed' || row.status === 'interrupted' || (row.status === 'partial' && retryable.length > 0);
    if (!canRetry) {
      throw projectsError(409, 'nothing_to_retry', '只有失败/中断的导出（或仍含失败/中断条目的部分导出）可重试；成功条目不会重新执行');
    }
    if (row.delivery_state !== 'active') throw projectsError(410, 'download_expired', '导出文件已过期，请发起新的导出');

    exportStore.withTransaction(db, () => {
      // Only failed/interrupted items return to pending; successful outputs stay.
      for (const item of retryable) {
        exportStore.updateExportItem(db, userId, exportId, item.itemId, {
          status: 'pending',
          errorCode: null,
          errorMessage: null,
        }, nowMs());
      }
      // A stale ZIP must never be served while the retry runs (or after a
      // failed retry): it is rebuilt from the same snapshot below.
      exportStore.updateExportStatus(db, userId, exportId, {
        status: 'queued',
        phase: '',
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        // Bounded retention from the retry point; never left null/expired.
        expiresAt: exportStore.isoAt(nowMs() + EXPORT_LIMITS.retentionMs),
        cancelRequested: false,
        zipPath: null,
        zipBytes: null,
        zipSha256: null,
      }, nowMs());
      db.prepare('UPDATE project_exports SET principal_kind = ?, principal_id = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(
        principal.kind,
        principal.id,
        exportStore.isoAt(nowMs()),
        userId,
        exportId,
      );
    });
    fs.promises.rm(exportPaths(userId, exportId).zip, { force: true }).catch(() => {});
    const response = { export: exportView(exportStore.getExportRow(db, userId, exportId)) };
    autoStore.writeIdempotent(db, userId, key, 'export.retry', requestHash, response, nowMs());
    wake();
    return { ...response, deduplicated: false };
  }

  function cancel({ userId, projectId, exportId, idempotencyKey = null }) {
    const requestHash = sha256Hex(stableStringify({ operation: 'export.cancel', projectId, exportId }));
    const key = idempotencyKey ? `export.cancel:${idempotencyKey}` : null;
    const prior = autoStore.readIdempotent(db, userId, key, 'export.cancel', requestHash);
    if (prior) return { ...prior, deduplicated: true };

    const row = requireExport(userId, projectId, exportId);
    let cancelled = true;
    if (TERMINAL_STATUSES.has(row.status)) {
      cancelled = false;
    } else {
      exportStore.withTransaction(db, () => {
        exportStore.requestCancel(db, userId, exportId, nowMs());
        if (row.status === 'queued') {
          exportStore.markUnfinishedItems(db, userId, exportId, 'cancelled', '用户已取消', 'cancelled', nowMs());
          exportStore.updateExportStatus(db, userId, exportId, {
            status: 'cancelled',
            phase: '',
            finishedAt: exportStore.isoAt(nowMs()),
            cancelRequested: true,
            errorCode: 'cancelled',
            errorMessage: '用户已取消',
          }, nowMs());
        }
      });
      wake();
    }
    const response = { export: exportView(exportStore.getExportRow(db, userId, exportId)), cancelled };
    autoStore.writeIdempotent(db, userId, key, 'export.cancel', requestHash, response, nowMs());
    return { ...response, deduplicated: false };
  }

  /* ------------------------------------------------------------------ */
  /* Download + tickets                                                  */
  /* ------------------------------------------------------------------ */

  function downloadTarget({ userId, projectId, exportId }) {
    const row = requireExport(userId, projectId, exportId);
    // Expiry is enforced at READ time (the hourly timer is a sweeper, not the
    // only gate): an expired download is never served or re-ticketed.
    if (row.expires_at && Date.parse(row.expires_at) <= nowMs()) {
      throw projectsError(410, 'download_expired', '导出文件已过期或不存在，请重新导出');
    }
    if (!row.zip_path || row.delivery_state !== 'active') {
      throw projectsError(410, 'download_expired', '导出文件已过期或不存在，请重新导出');
    }
    if (ACTIVE_STATUSES.has(row.status)) {
      throw projectsError(409, 'export_active', '导出尚未完成');
    }
    const target = exportPaths(userId, exportId).zip;
    if (!fs.existsSync(target)) {
      throw projectsError(410, 'download_expired', '导出文件已过期或不存在，请重新导出');
    }
    return { row, filePath: target, fileName: `project-export-${row.id}.zip` };
  }

  function openDownload({ userId, projectId, exportId }) {
    return downloadTarget({ userId, projectId, exportId });
  }

  /** 10-minute opaque ticket bound to one ZIP + the caller's principal. */
  function issueDownloadTicket({ userId, projectId, exportId, principal }) {
    requirePrincipal(principal);
    // downloadTarget rejects expired deliveries before any ticket is minted.
    const { row } = downloadTarget({ userId, projectId, exportId });
    const ticket = crypto.randomBytes(32).toString('base64url');
    exportStore.insertTicket(db, {
      ticketHash: sha256Hex(ticket),
      userId,
      exportId,
      principal,
      nowMs: nowMs(),
      ttlMs: EXPORT_LIMITS.ticketTtlMs,
    });
    return {
      ticket,
      ticketUrl: `${appOrigin}/api/projects/${projectId}/exports/${exportId}/download?ticket=${encodeURIComponent(ticket)}`,
      exportId: row.id,
      expiresAt: exportStore.isoAt(nowMs() + EXPORT_LIMITS.ticketTtlMs),
    };
  }

  /**
   * Resolve an anonymous ticket download: a specific bounded capability for one
   * ZIP. Only the hash is stored; the route's project/export must match the
   * ticket's binding; expired/revoked tickets are denied; the ticket's OWN
   * bound principal is re-checked (denied, never mass-revoking other tickets
   * minted under different valid principals).
   */
  function resolveDownloadTicket({ ticket, projectId, exportId }) {
    if (typeof ticket !== 'string' || ticket.length < 16 || ticket.length > 128) {
      throw projectsError(404, 'not_found', '下载链接无效');
    }
    const row = exportStore.getTicketRow(db, sha256Hex(ticket), nowMs());
    if (!row) throw projectsError(410, 'ticket_expired', '下载票据已过期或已撤销，请重新请求下载链接');
    if (row.export_id !== exportId) throw projectsError(404, 'not_found', '下载链接无效');
    const exportRow = exportStore.getExportRow(db, row.user_id, exportId);
    if (!exportRow || exportRow.project_id !== projectId || exportRow.delivery_state !== 'active') {
      throw projectsError(410, 'ticket_expired', '下载票据已过期或已撤销，请重新请求下载链接');
    }
    if (exportRow.expires_at && Date.parse(exportRow.expires_at) <= nowMs()) {
      throw projectsError(410, 'ticket_expired', '下载票据已过期或已撤销，请重新请求下载链接');
    }
    if (!principalValid({ kind: row.principal_kind, id: row.principal_id, userId: row.user_id })) {
      // Only THIS ticket is denied; other tickets bound to valid principals
      // keep working until their own expiry.
      throw projectsError(403, 'unauthorized', '来源授权已失效，本下载票据不可用');
    }
    return downloadTarget({ userId: row.user_id, projectId: exportRow.project_id, exportId });
  }

  /* ------------------------------------------------------------------ */
  /* Worker (shared, concurrency 1)                                      */
  /* ------------------------------------------------------------------ */

  let wakePromise = null;
  let stopped = true;

  function wake() {
    if (stopped) return;
    if (!wakePromise) {
      wakePromise = Promise.resolve().then(() => loop());
    }
  }

  async function loop() {
    try {
      while (!stopped) {
        const row = exportStore.claimNextExport(db, nowMs());
        if (!row) break;
        await processExport(row).catch((error) => {
          logger.error?.('[imstage-exports] export run failed:', error?.message ?? error);
        });
      }
    } finally {
      wakePromise = null;
      // A failure during claim handling may have queued more work.
      if (!stopped && db.prepare("SELECT 1 AS ok FROM project_exports WHERE status = 'queued' LIMIT 1").get()) wake();
    }
  }

  function exportStillLive(row) {
    const current = exportStore.getExportRow(db, row.user_id, row.id);
    if (!current) return false;
    const project = db.prepare('SELECT 1 AS ok FROM projects WHERE user_id = ? AND id = ?').get(row.user_id, row.project_id);
    return Boolean(project);
  }

  function checkCancelled(row) {
    const current = exportStore.getExportRow(db, row.user_id, row.id);
    return Boolean(current && Number(current.cancel_requested) === 1);
  }

  /** Graceful stop: never claim/publish completions while stopping. */
  function stopRequested(row) {
    if (!stopped) return false;
    markInterrupted(row, 'interrupted', '服务关闭，导出中断；已保留成功的输出，可显式重试');
    return true;
  }

  /** Storage quota is enforced BEFORE every PNG commit (also failed items). */
  function assertRetainedBudget(userId, extraBytes) {
    if (exportStore.retainedBytesForUser(db, userId) + extraBytes > EXPORT_LIMITS.retainedPerUserBytesMax) {
      throw projectsError(429, 'storage_quota', '账号导出保留总量已达 500 MiB 上限');
    }
  }

  async function processExport(row) {
    const userId = row.user_id;
    const exportId = row.id;
    try {
      // ALL initialization runs inside the try: a claimed export can never stay
      // 'running' because setup failed before the guarded section.
      const paths = exportPaths(userId, exportId);
      await fsp.mkdir(paths.renders, { recursive: true });
      const renderOptions = JSON.parse(row.render_options_json ?? '{}');
      const principal = { kind: row.principal_kind, id: row.principal_id, userId };
      let frozen = {};
      try {
        frozen = JSON.parse(row.frozen_json ?? '{}');
      } catch {
        frozen = {};
      }
      await runItems(row, principal, renderOptions, frozen);
    } catch (error) {
      // A failure outside the per-item guards must never leave status=running.
      const code = typeof error?.code === 'string' ? error.code.slice(0, 60) : 'export_failed';
      if (exportStillLive(row)) {
        exportStore.updateExportStatus(db, userId, exportId, {
          status: 'failed',
          phase: '',
          errorCode: code,
          errorMessage: boundedMessage(error?.message),
          finishedAt: exportStore.isoAt(nowMs()),
        }, nowMs());
      }
      logger.warn?.('[imstage-exports] export failed:', error?.message ?? error);
    }
  }

  async function runItems(row, principal, renderOptions, frozen) {
    const userId = row.user_id;
    const exportId = row.id;
    const paths = exportPaths(userId, exportId);
    const summaries = exportStore.listExportItemSummaries(db, userId, exportId);

    // -------- validating (per item, one scene at a time) --------
    exportStore.updateExportStatus(db, userId, exportId, { status: 'running', phase: 'validating' }, nowMs());
    for (const summary of summaries) {
      if (!exportStillLive(row)) return; // project/export deleted in-flight
      if (stopRequested(row)) return;
      if (!principalValid(principal)) return markInterrupted(row, 'authorization_revoked', '来源授权已失效，导出中断');
      if (checkCancelled(row)) return finalizeCancelled(row);
      const item = exportStore.getExportItemWithScene(db, userId, exportId, summary.itemId);
      if (!item || item.status !== 'pending') continue;
      const { invalid } = await verifySceneAssets(item.scene);
      if (invalid.length > 0) {
        exportStore.updateExportItem(db, userId, exportId, item.itemId, {
          status: 'failed',
          errorCode: 'invalid_image',
          errorMessage: boundedMessage(`内嵌图片无法解码：${invalid.map((entry) => entry.source).slice(0, 3).join(', ')}`),
        }, nowMs());
      }
    }

    // -------- rendering (per item) --------
    exportStore.updateExportStatus(db, userId, exportId, { status: 'running', phase: 'rendering' }, nowMs());
    for (const summary of exportStore.listExportItemSummaries(db, userId, exportId)) {
      if (summary.status !== 'pending') continue;
      if (!exportStillLive(row)) return;
      if (stopRequested(row)) return;
      if (!principalValid(principal)) return markInterrupted(row, 'authorization_revoked', '来源授权已失效，导出中断');
      if (checkCancelled(row)) return finalizeCancelled(row);
      try {
        const pngPath = itemPngPath(userId, exportId, summary.ordinal);
        const reusable = findReusablePng({
          userId,
          sceneHash: summary.sceneHash,
          renderOptions,
          principal,
          exceptExportId: exportId,
        });
        if (reusable) {
          await fsp.mkdir(paths.renders, { recursive: true });
          await fsp.copyFile(reusable.path, pngPath);
          const buffer = await fsp.readFile(pngPath);
          const png = verifyPngBuffer(buffer);
          // The copied bytes must match the SHA the source export registered.
          if (!reuseHashOk(reusable.sourceSha256, png.sha256)) {
            await fsp.rm(pngPath, { force: true });
            throw new Error('复用的 PNG 哈希与登记值不一致');
          }
          if (!exportStillLive(row) || stopped || checkCancelled(row) || !principalValid(principal)) {
            await fsp.rm(pngPath, { force: true }).catch(() => {});
            if (stopped) return stopRequested(row);
            if (checkCancelled(row)) return finalizeCancelled(row);
            return markInterrupted(row, 'authorization_revoked', '来源授权已失效，导出中断');
          }
          assertRetainedBudget(userId, png.bytes);
          exportStore.updateExportItem(db, userId, exportId, summary.itemId, {
            status: 'done',
            reused: true,
            pngBytes: png.bytes,
            pngSha256: png.sha256,
            pngWidth: png.width,
            pngHeight: png.height,
            errorCode: null,
            errorMessage: null,
          }, nowMs());
          continue;
        }
        const item = exportStore.getExportItemWithScene(db, userId, exportId, summary.itemId);
        const rendered = await renderService.render({ scene: item.scene, ...renderOptions });
        // Slow renderer resolved: re-check ownership + authorization + cancel
        // BEFORE any output is committed or returned.
        if (!exportStillLive(row)) return;
        if (stopped) return stopRequested(row);
        if (!principalValid(principal)) return markInterrupted(row, 'authorization_revoked', '来源授权已失效，导出中断');
        if (checkCancelled(row)) return finalizeCancelled(row);
        const buffer = Buffer.isBuffer(rendered?.buffer) ? rendered.buffer : Buffer.from(rendered?.pngBase64 ?? '', 'base64');
        const png = verifyPngBuffer(buffer);
        assertRetainedBudget(userId, png.bytes);
        await atomicWrite(pngPath, buffer);
        // Fresh guard AFTER the slow write, immediately BEFORE the DB commit.
        if (!exportStillLive(row)) {
          await fsp.rm(pngPath, { force: true }).catch(() => {});
          return;
        }
        if (stopped) {
          await fsp.rm(pngPath, { force: true }).catch(() => {});
          return stopRequested(row);
        }
        if (checkCancelled(row)) {
          await fsp.rm(pngPath, { force: true }).catch(() => {});
          return finalizeCancelled(row);
        }
        if (!principalValid(principal)) {
          await fsp.rm(pngPath, { force: true }).catch(() => {});
          return markInterrupted(row, 'authorization_revoked', '来源授权已失效，导出中断');
        }
        // Another enqueue may have consumed quota while the file was written.
        assertRetainedBudget(userId, png.bytes);
        exportStore.updateExportItem(db, userId, exportId, summary.itemId, {
          status: 'done',
          reused: false,
          pngBytes: png.bytes,
          pngSha256: png.sha256,
          pngWidth: png.width,
          pngHeight: png.height,
          errorCode: null,
          errorMessage: null,
        }, nowMs());
      } catch (error) {
        // A copied/written PNG that never reached the DB must not bypass quota.
        await fsp.rm(itemPngPath(userId, exportId, summary.ordinal), { force: true }).catch(() => {});
        const code = typeof error?.code === 'string' ? error.code : 'render_failed';
        exportStore.updateExportItem(db, userId, exportId, summary.itemId, {
          status: 'failed',
          errorCode: code.slice(0, 60),
          errorMessage: boundedMessage(error?.message),
        }, nowMs());
      }
    }

    if (!exportStillLive(row)) return;
    if (stopped) return stopRequested(row);
    if (checkCancelled(row)) return finalizeCancelled(row);

    // -------- packaging (streaming: one scene + one PNG at a time) --------
    exportStore.updateExportStatus(db, userId, exportId, { status: 'running', phase: 'packaging' }, nowMs());
    const doneItems = exportStore.listExportItemSummaries(db, userId, exportId).filter((entry) => entry.status === 'done');
    const allSummaries = exportStore.listExportItemSummaries(db, userId, exportId);
    const failedItems = allSummaries.filter((entry) => entry.status === 'failed');
    const missing = [
      ...(frozen.missingItems ?? []),
      ...allSummaries
        .filter((entry) => entry.status !== 'done' && entry.status !== 'failed')
        .map((entry) => ({ itemKey: entry.itemKey, scenarioId: entry.scenarioId ?? null, reason: 'not_exported' })),
      ...failedItems.map((entry) => ({ itemKey: entry.itemKey, scenarioId: entry.scenarioId ?? null, reason: entry.error_code ?? 'failed' })),
    ];

    if (doneItems.length === 0) {
      exportStore.updateExportStatus(db, userId, exportId, {
        status: 'failed',
        phase: '',
        errorCode: 'export_failed',
        errorMessage: boundedMessage('没有任何案例导出成功'),
        finishedAt: exportStore.isoAt(nowMs()),
      }, nowMs());
      return;
    }

    const staging = tmpPath(`exp-${exportId}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    const writer = createZipWriter(staging, { maxBytes: EXPORT_LIMITS.zipBytesMax });
    await writer.open();
    try {
      const recipeByScenario = new Map((frozen.scenarios ?? []).map((scenario) => [scenario.id, scenario.recipeType]));
      const prepared = doneItems.map((item) => ({
        ...item,
        recipeType: recipeByScenario.get(item.scenarioId) ?? frozen.project?.type ?? 'custom',
      }));
      await writeArchive({
        writer,
        exportRow: row,
        frozen,
        items: prepared,
        // ONE scene / ONE PNG alive at a time; hashes verified against the
        // registered item hashes before entering the archive.
        loadScene: async (itemId) => exportStore.getExportItemWithScene(db, userId, exportId, itemId).scene,
        loadPng: async (itemId) => {
          const item = prepared.find((entry) => entry.itemId === itemId);
          const buffer = await fsp.readFile(itemPngPath(userId, exportId, item.ordinal));
          const png = verifyPngBuffer(buffer);
          if (png.sha256 !== item.png?.sha256) throw projectsError(500, 'render_failed', '渲染文件哈希与登记值不一致');
          return buffer;
        },
        missingItems: missing,
        rendererVersion,
        policyVersion,
        nowMs: nowMs(),
      });
      await writer.finish();
    } catch (error) {
      await writer.abort();
      throw error;
    }

    // Publish guards re-run AFTER every slow operation, immediately BEFORE the
    // DB commit: nothing may appear after cancel/revoke/stop/project deletion.
    const publishGuard = () => {
      if (!exportStillLive(row)) return 'gone';
      if (stopped) return 'stopped';
      if (!principalValid(principal)) return 'revoked';
      if (checkCancelled(row)) return 'cancelled';
      return null;
    };
    const abortPublish = async (reason) => {
      // Never leave a half-published archive behind (staging or final zip).
      await fsp.rm(staging, { force: true }).catch(() => {});
      await fsp.rm(paths.zip, { force: true }).catch(() => {});
      if (reason === 'stopped') return stopRequested(row);
      if (reason === 'revoked') return markInterrupted(row, 'authorization_revoked', '来源授权已失效，导出中断');
      if (reason === 'cancelled') return finalizeCancelled(row);
      return undefined; // 'gone': rows purged with the project, nothing to persist
    };

    let guard = publishGuard();
    if (guard) return abortPublish(guard);

    const stat = await fsp.stat(staging);
    if (stat.size > EXPORT_LIMITS.zipBytesMax) {
      await fsp.rm(staging, { force: true });
      throw projectsError(413, 'output_too_large', '导出文件包超过 100 MiB 上限');
    }
    guard = publishGuard();
    if (guard) return abortPublish(guard);

    const zipSha = await hashFile(staging);
    guard = publishGuard();
    if (guard) return abortPublish(guard);
    if (exportStore.retainedBytesForUser(db, userId) + stat.size > EXPORT_LIMITS.retainedPerUserBytesMax) {
      await fsp.rm(staging, { force: true });
      throw projectsError(429, 'storage_quota', '账号导出保留总量已达 500 MiB 上限');
    }
    await fsp.mkdir(path.dirname(paths.zip), { recursive: true });
    await fsp.rm(paths.zip, { force: true });
    await fsp.rename(staging, paths.zip);
    // Fresh guard after the atomic rename: a failure here removes the published
    // file again and persists a truthful terminal state.
    guard = publishGuard();
    if (guard) return abortPublish(guard);

    try {
      assertRetainedBudget(userId, stat.size);
    } catch (error) {
      await fsp.rm(paths.zip, { force: true }).catch(() => {});
      throw error;
    }
    const hasFailures = failedItems.length > 0 || missing.length > 0;
    exportStore.updateExportStatus(db, userId, exportId, {
      status: hasFailures ? 'partial' : 'completed',
      phase: '',
      zipPath: path.relative(root, paths.zip),
      zipBytes: stat.size,
      zipSha256: zipSha,
      finishedAt: exportStore.isoAt(nowMs()),
      expiresAt: exportStore.isoAt(nowMs() + EXPORT_LIMITS.retentionMs),
      errorCode: hasFailures ? 'missing_items' : null,
      errorMessage: hasFailures ? `有 ${missing.length} 个案例未包含在本次文件包中，详见 validation.json` : null,
    }, nowMs());
  }

  function verifyPngBuffer(buffer) {
    const header = parsePngHeader(buffer);
    return { bytes: buffer.length, sha256: sha256Hex(buffer), width: header.width, height: header.height };
  }

  function reuseHashOk(sourceSha256, actualSha256) {
    return typeof sourceSha256 === 'string' && sourceSha256 === actualSha256;
  }

  function markInterrupted(row, code, message) {
    exportStore.withTransaction(db, () => {
      exportStore.markUnfinishedItems(db, row.user_id, row.id, 'interrupted', message, code, nowMs());
      exportStore.updateExportStatus(db, row.user_id, row.id, {
        status: 'interrupted',
        phase: '',
        errorCode: code,
        errorMessage: message,
        finishedAt: exportStore.isoAt(nowMs()),
      }, nowMs());
    });
  }

  function finalizeCancelled(row) {
    exportStore.withTransaction(db, () => {
      exportStore.markUnfinishedItems(db, row.user_id, row.id, 'cancelled', '用户已取消', 'cancelled', nowMs());
      const items = exportStore.listExportItemSummaries(db, row.user_id, row.id);
      const done = items.filter((item) => item.status === 'done').length;
      exportStore.updateExportStatus(db, row.user_id, row.id, {
        status: 'cancelled',
        phase: '',
        cancelRequested: true,
        errorCode: 'cancelled',
        errorMessage: `用户已取消（已保留 ${done} 个已完成输出）`,
        finishedAt: exportStore.isoAt(nowMs()),
      }, nowMs());
    });
  }

  /**
   * PNG reuse: same owner + same Scene content hash + same render config +
   * current renderer/policy versions + the SOURCE export's authorization AND
   * the current caller's authorization both still valid. Returns the source
   * path plus its registered hash for post-copy verification.
   */
  function findReusablePng({ userId, sceneHash, renderOptions, principal, exceptExportId }) {
    if (!principalValid({ ...principal, userId })) return null;
    const renderOptionsJson = stableStringify(renderOptions);
    const rows = db
      .prepare(
        `SELECT i.ordinal, i.png_sha256, e.id AS export_id, e.render_options_json, e.frozen_json,
                e.principal_kind, e.principal_id
         FROM project_export_items i
         JOIN project_exports e ON e.user_id = i.user_id AND e.id = i.export_id
         WHERE i.user_id = ? AND i.scene_hash = ? AND i.status = 'done' AND i.png_sha256 IS NOT NULL
           AND e.delivery_state = 'active' AND e.id != ?
         ORDER BY e.created_at DESC LIMIT 8`,
      )
      .all(userId, sceneHash, exceptExportId);
    for (const source of rows) {
      let frozen = {};
      try {
        frozen = JSON.parse(source.frozen_json ?? '{}');
      } catch {
        continue;
      }
      if (frozen?.renderer?.version !== rendererVersion || frozen?.policy?.version !== policyVersion) continue;
      if (stableStringify(JSON.parse(source.render_options_json ?? '{}')) !== renderOptionsJson) continue;
      // Source authorization must still be valid, not only the caller's.
      if (!principalValid({ kind: source.principal_kind, id: source.principal_id, userId })) continue;
      const file = itemPngPath(userId, source.export_id, source.ordinal);
      if (!fs.existsSync(file)) continue;
      return { path: file, sourceSha256: source.png_sha256 };
    }
    return null;
  }

  async function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest('hex');
  }

  /* ------------------------------------------------------------------ */
  /* Cleanup / retention                                                 */
  /* ------------------------------------------------------------------ */

  async function purgeExportFiles(row) {
    const paths = exportPaths(row.user_id, row.id);
    await fs.promises.rm(paths.dir, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(paths.zip, { force: true }).catch(() => {});
  }

  /** Expired snapshots must not retain huge frozen Scene blobs in the DB. */
  function clearSnapshotBlobs(userId, exportId) {
    db.prepare("UPDATE project_export_items SET scene_json = '' WHERE user_id = ? AND export_id = ?").run(userId, exportId);
    db.prepare("UPDATE project_exports SET frozen_json = '{}' WHERE user_id = ? AND id = ?").run(userId, exportId);
  }

  /** Remove own temp files: all at startup, only stale ones on the timer so an
   * in-flight packaging temp file is never touched. */
  async function cleanTmpFiles({ onlyStale }) {
    const entries = await fs.promises.readdir(tmpDir).catch(() => []);
    const now = nowMs();
    for (const entry of entries) {
      if (!/^(exp-|file-)[A-Za-z0-9_-]+\.tmp$/.test(entry)) continue;
      const target = path.join(tmpDir, entry);
      if (onlyStale) {
        const stat = await fs.promises.stat(target).catch(() => null);
        if (!stat || now - stat.mtimeMs < EXPORT_LIMITS.tmpStaleMs) continue;
      }
      await fs.promises.rm(target, { force: true }).catch(() => {});
    }
  }

  /** Real 7-day retention: purge expired files/tickets, mark delivery expired. */
  async function cleanup() {
    if (cleaning) return { purged: 0, skipped: true };
    cleaning = true;
    try {
      let purged = 0;
      exportStore.deleteExpiredTickets(db, nowMs());
      for (const row of exportStore.listExpiredExports(db, nowMs())) {
        await purgeExportFiles(row);
        exportStore.withTransaction(db, () => {
          exportStore.revokeTicketsForExport(db, row.user_id, row.id, nowMs());
          clearSnapshotBlobs(row.user_id, row.id);
          exportStore.updateExportStatus(db, row.user_id, row.id, {
            deliveryState: 'expired',
            zipPath: null,
            zipBytes: null,
            zipSha256: null,
          }, nowMs());
        });
        purged += 1;
      }
      // Orphan owned exports (user or project gone) never leave files behind.
      for (const row of exportStore.listOrphanExports(db)) {
        await purgeExportFiles(row);
        exportStore.deleteExportRow(db, row.user_id, row.id);
        purged += 1;
      }
      await cleanTmpFiles({ onlyStale: true });
      return { purged };
    } finally {
      cleaning = false;
    }
  }

  /** Project deletion: cancel + purge every own export, ticket and file. */
  async function purgeProject({ userId, projectId }) {
    const rows = exportStore.listExportsForProject(db, userId, projectId);
    for (const row of rows) {
      await purgeExportFiles(row);
      exportStore.deleteExportRow(db, userId, row.id);
    }
    return { purged: rows.length };
  }

  /** Account deletion cascade / orphan cleanup for one account. */
  async function purgeUser({ userId }) {
    const rows = db.prepare('SELECT * FROM project_exports WHERE user_id = ?').all(userId);
    for (const row of rows) {
      await purgeExportFiles(row);
      exportStore.deleteExportRow(db, userId, row.id);
    }
    return { purged: rows.length };
  }

  /** Startup truth: active exports from a previous process become interrupted. */
  function recoverInterrupted() {
    const rows = db.prepare("SELECT * FROM project_exports WHERE status IN ('queued', 'running')").all();
    for (const row of rows) {
      exportStore.withTransaction(db, () => {
        exportStore.markUnfinishedItems(db, row.user_id, row.id, 'interrupted', '服务重启，导出中断；可显式重试同一快照', 'interrupted', nowMs());
        exportStore.updateExportStatus(db, row.user_id, row.id, {
          status: 'interrupted',
          phase: '',
          errorCode: 'interrupted',
          errorMessage: '服务重启，导出中断；已保留成功的输出，可显式重试失败/中断条目',
          finishedAt: exportStore.isoAt(nowMs()),
        }, nowMs());
      });
    }
    return { interrupted: rows.length };
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  let cleanupTimer = null;
  let cleaning = false;
  let cleanupPromise = null;

  function start() {
    stopped = false;
    fs.mkdirSync(exportsDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    recoverInterrupted();
    // Startup cleans ALL own unregistered temp files (none can be in-flight)
    // and really runs the retention sweep — the hourly timer is only a sweeper.
    cleanTmpFiles({ onlyStale: false }).catch(() => {});
    cleanupPromise = cleanup().catch((error) => logger.warn?.('[imstage-exports] startup cleanup failed:', error?.message ?? error));
    wake();
    cleanupTimer = setInterval(() => {
      cleanupPromise = cleanup().catch((error) => logger.warn?.('[imstage-exports] cleanup failed:', error?.message ?? error));
    }, 60 * 60 * 1000);
    cleanupTimer.unref?.();
    return api;
  }

  async function stop() {
    stopped = true;
    if (cleanupTimer) clearInterval(cleanupTimer);
    cleanupTimer = null;
    // Graceful stop: the in-flight item finishes its DB bookkeeping BEFORE the
    // caller closes SQLite. Publication guards refuse to claim completion while
    // stopping; the real renderer is bounded by its own timeout. A running
    // cleanup sweep also finishes first — no DB access after close().
    if (wakePromise) await wakePromise.catch(() => {});
    if (cleanupPromise) await cleanupPromise.catch(() => {});
  }

  const api = {
    limits: EXPORT_LIMITS,
    defaultRenderOptions: DEFAULT_RENDER_OPTIONS,
    exportDir: root,
    principalValid,
    enqueue,
    enqueueAutoScenario,
    list,
    get,
    status: get,
    retry,
    cancel,
    openDownload,
    issueDownloadTicket,
    resolveDownloadTicket,
    projectDeliverySummary,
    purgeProject,
    purgeUser,
    cleanup,
    recoverInterrupted,
    start,
    stop,
    wake,
  };
  return api;
}

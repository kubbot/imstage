/**
 * IMStage Account Project Automation — application service.
 *
 * One cohesive service owns the Project → Scenario → Case business rules for
 * both transports: the HTTP routes in `services/api/server.mjs` and the
 * account MCP tools call exactly these functions, so neither surface can drift
 * from the other or bypass ownership, capacity, idempotency or validation.
 *
 * Scope of this batch (content foundation):
 *   - versioned project recipes / scenario presets (pure `project-recipes.mjs`)
 *   - project create/update with `type` + bounded `brief`, revisions and
 *     idempotency
 *   - scenario creation freezes the parent rules/defaults/cast and plans
 *     deterministic `case-001 …` cases with generation guidance
 *   - validated content batches (≤20 items, all-or-nothing transaction of
 *     scene + association + case + receipt + minimal audit), ownership and
 *     capacity checks, request hashes, idempotent receipts, duplicate key and
 *     duplicate dialogue rejection
 *   - bounded summaries / resume context and truthful content status
 *     (`collecting` / `ready`; delivery state comes from the injected export
 *     service — completed is only reported when a current file package really
 *     matches the live content)
 *
 * File delivery (deterministic export queue, PNG/ZIP downloads) lives in
 * `services/projects/exports/`; the shared export service is injected here so
 * auto-export, status and delivery summaries stay consistent across HTTP/MCP.
 */

import crypto from 'node:crypto';

import { instantiateTemplate } from '../../packages/schema/templates.ts';
import {
  PROJECT_RECIPE_LIMITS,
  SCENARIO_LIMITS,
  SCENARIO_LOCALES,
  buildCasePlan,
  isProjectType,
  parseCaseItemKey,
  projectRecipe,
  projectTypeSummaries,
  scenarioPreset,
  scenarioPresetSummaries,
  suggestedBatchRanges,
} from '../../packages/schema/project-recipes.mjs';
import { newRunId as newAuditRunId, recordGenerationAudit } from '../audit/generation-audit.mjs';
import { TemplateError, getTemplate } from '../templates/store.mjs';
import { applyScenePatch, enforceSceneBounds, prepareCreateScene } from '../mcp/scene.mjs';
import { applySceneDefaults } from '../preferences/defaults.mjs';
import { McpToolError } from '../mcp/errors.mjs';
import { sha256Hex, stableStringify } from '../mcp/util.mjs';
import { projectsError } from './errors.mjs';
import {
  DEFAULT_PROJECT_PLATFORM,
  DEFAULT_PROJECT_WATERMARK,
  MAX_SCENES_PER_USER,
  isPlatform,
  parseRevision,
  validateProjectId,
  validateProjectName,
  validateProjectPlatform,
  validateProjectRules,
  validateProjectWatermarkEnabled,
} from './model.mjs';
import * as legacyStore from './store.mjs';
import * as autoStore from './automation-store.mjs';
import { dialogueSignature } from './automation-store.mjs';

export const MAX_PROJECT_BRIEF_CHARS = PROJECT_RECIPE_LIMITS.brief;
export const MAX_BRIEF_CAST_MEMBERS = PROJECT_RECIPE_LIMITS.castMembers;
export const MAX_ANNOTATION_LABELS = 20;
export const MAX_ANNOTATION_KEY_CHARS = 80;
export const MAX_ANNOTATION_VALUE_CHARS = 1000;
export const MAX_ITEM_KEY_CHARS = 64;
export const MAX_CASE_NAME_CHARS = SCENARIO_LIMITS.caseName;
export const MAX_CASE_OBJECTIVE_CHARS = SCENARIO_LIMITS.objective;
export const MAX_CASE_CONTEXT_CHARS = SCENARIO_LIMITS.context;
export const MAX_PROMPT_CHARS = 4000;
export const MAX_IDEMPOTENCY_KEY_CHARS = 128;
export const MAX_CONTENT_BATCH_ITEMS = SCENARIO_LIMITS.batchItemsMax;
export const MAX_MISSING_KEYS_REPORTED = 200;
export const MAX_BATCH_LIST_LIMIT = 50;

const ITEM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ANNOTATION_KEY_RE = /^[^\s\u0000-\u001f\u007f]{1,80}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Map shared validator failures onto transport-agnostic project errors. */
function asProjectsError(error) {
  if (error instanceof McpToolError) {
    return projectsError(error.status ?? 400, error.code, error.message);
  }
  return error;
}

function guarded(fn) {
  try {
    return fn();
  } catch (error) {
    throw asProjectsError(error);
  }
}

/* ------------------------------------------------------------------ */
/* Shared validators                                                   */
/* ------------------------------------------------------------------ */

export function validateProjectType(raw, fallback = 'custom') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' || !isProjectType(raw)) {
    throw projectsError(400, 'invalid_type', 'project type 不受支持');
  }
  return raw;
}

/** Project brief: bounded language/platform/cast; never stores chat transcripts. */
export function validateProjectBrief(raw) {
  if (raw === undefined || raw === null) return {};
  if (!isPlainObject(raw)) throw projectsError(400, 'invalid_brief', 'brief 必须是对象');
  for (const key of Object.keys(raw)) {
    if (!['language', 'platform', 'cast'].includes(key)) {
      throw projectsError(400, 'invalid_brief', `brief 含未知字段：${key}`);
    }
  }
  const brief = {};
  if (raw.language !== undefined) {
    if (typeof raw.language !== 'string' || raw.language.length > 40) {
      throw projectsError(400, 'invalid_brief', 'brief.language 必须是不超过 40 字符的字符串');
    }
    brief.language = raw.language;
  }
  if (raw.platform !== undefined) {
    if (!isPlatform(raw.platform)) throw projectsError(400, 'invalid_brief', 'brief.platform 不受支持');
    brief.platform = raw.platform;
  }
  if (raw.cast !== undefined) {
    if (!Array.isArray(raw.cast)) throw projectsError(400, 'invalid_brief', 'brief.cast 必须是数组');
    if (raw.cast.length > MAX_BRIEF_CAST_MEMBERS) {
      throw projectsError(400, 'invalid_brief', `brief.cast 最多 ${MAX_BRIEF_CAST_MEMBERS} 人`);
    }
    brief.cast = raw.cast.map((member, index) => {
      if (!isPlainObject(member)) throw projectsError(400, 'invalid_brief', `brief.cast[${index}] 必须是对象`);
      for (const key of Object.keys(member)) {
        if (!['name', 'role', 'avatar'].includes(key)) {
          throw projectsError(400, 'invalid_brief', `brief.cast[${index}] 含未知字段：${key}`);
        }
      }
      const name = typeof member.name === 'string' ? member.name.trim() : '';
      const role = typeof member.role === 'string' ? member.role.trim() : '';
      if (name.length < 1 || name.length > PROJECT_RECIPE_LIMITS.castName) {
        throw projectsError(400, 'invalid_brief', `brief.cast[${index}].name 需为 1-${PROJECT_RECIPE_LIMITS.castName} 字符`);
      }
      if (role.length < 1 || role.length > PROJECT_RECIPE_LIMITS.castRole) {
        throw projectsError(400, 'invalid_brief', `brief.cast[${index}].role 需为 1-${PROJECT_RECIPE_LIMITS.castRole} 字符`);
      }
      const entry = { name, role };
      if (member.avatar !== undefined) {
        const avatar = member.avatar;
        if (
          typeof avatar !== 'string' ||
          avatar.length > 2 * 1024 * 1024 ||
          !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(avatar)
        ) {
          throw projectsError(400, 'invalid_brief', `brief.cast[${index}].avatar 必须是内嵌 data:image/...;base64`);
        }
        entry.avatar = avatar;
      }
      return entry;
    });
  }
  if (JSON.stringify(brief).length > MAX_PROJECT_BRIEF_CHARS) {
    throw projectsError(413, 'invalid_brief', `brief 不能超过 ${MAX_PROJECT_BRIEF_CHARS} 字符`);
  }
  return brief;
}

/** Annotations: caller-provided `{labels:{<key>:<string>}}`, strictly bounded. */
export function validateAnnotations(raw) {
  if (raw === undefined || raw === null) return { labels: {} };
  if (!isPlainObject(raw)) throw projectsError(400, 'invalid_annotations', 'annotations 必须是对象');
  for (const key of Object.keys(raw)) {
    if (key !== 'labels') throw projectsError(400, 'invalid_annotations', `annotations 含未知字段：${key}`);
  }
  const labels = raw.labels === undefined ? {} : raw.labels;
  if (!isPlainObject(labels)) throw projectsError(400, 'invalid_annotations', 'annotations.labels 必须是对象');
  const keys = Object.keys(labels);
  if (keys.length > MAX_ANNOTATION_LABELS) {
    throw projectsError(400, 'invalid_annotations', `annotations.labels 最多 ${MAX_ANNOTATION_LABELS} 个`);
  }
  const out = {};
  for (const key of keys) {
    const value = labels[key];
    if (!ANNOTATION_KEY_RE.test(key)) throw projectsError(400, 'invalid_annotations', `annotations 标签名不合法：${key}`);
    if (typeof value !== 'string' || value.length > MAX_ANNOTATION_VALUE_CHARS) {
      throw projectsError(400, 'invalid_annotations', `annotations.labels.${key} 必须是不超过 ${MAX_ANNOTATION_VALUE_CHARS} 字的字符串`);
    }
    out[key] = value;
  }
  return { labels: out };
}

/**
 * Exact normalized dialogue signature (shared with the store layer): ignores
 * scene/participant/message ids, titles, times and platform, so re-titled or
 * re-timed copies of the same conversation collide. Roles are positional so
 * renaming a participant does not create a "new" dialogue.
 */
export { dialogueSignature };

/* ------------------------------------------------------------------ */
/* Service factory                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the account automation service.
 *
 * @param {{db: object, nowMs?: () => number, sceneIdFactory?: () => string,
 *          readPreferences?: (userId: string) => Promise<object|null>|object|null,
 *          exportService?: object, onScenarioContentReady?: (args) => Promise<object>}} options
 */
export function createProjectAutomation({
  db,
  nowMs = Date.now,
  sceneIdFactory = () => crypto.randomUUID(),
  readPreferences = null,
  exportService = null,
  onScenarioContentReady = null,
}) {
  if (!db) throw new Error('createProjectAutomation 需要数据库句柄');

  /* ---------------- project types ---------------- */

  function listProjectTypes() {
    return { items: projectTypeSummaries(), presets: scenarioPresetSummaries() };
  }

  /* ---------------- projects ---------------- */

function pickWatermark(input, defaults) {
  if (input.watermarkEnabled !== undefined) return input.watermarkEnabled;
  if (defaults && defaults.watermarkEnabled !== undefined) return defaults.watermarkEnabled;
  return undefined;
}

function pickPlatform(input, defaults) {
  if (input.platform !== undefined) return input.platform;
  if (defaults && defaults.platform !== undefined) return defaults.platform;
  return undefined;
}

  function projectCreateInput(input = {}) {
    const defaults = input.defaults === undefined ? {} : input.defaults;
    if (!isPlainObject(defaults)) throw projectsError(400, 'invalid_defaults', 'defaults 必须是对象');
    return {
      name: validateProjectName(input.name),
      rules: validateProjectRules(input.rules, ''),
      platform: validateProjectPlatform(pickPlatform(input, defaults), DEFAULT_PROJECT_PLATFORM),
      watermarkEnabled: validateProjectWatermarkEnabled(pickWatermark(input, defaults), DEFAULT_PROJECT_WATERMARK),
      type: validateProjectType(input.type, 'custom'),
      brief: validateProjectBrief(input.brief),
    };
  }

  /**
   * Partial update semantics. The returned `provided` holds ONLY the fields
   * the caller actually sent (validated), which is what idempotency hashes —
   * never the merged current settings, so a replay stays replayable after
   * unrelated settings changed.
   */
  function projectUpdateInput(input = {}, current) {
    const defaults = input.defaults === undefined ? undefined : input.defaults;
    if (defaults !== undefined && !isPlainObject(defaults)) {
      throw projectsError(400, 'invalid_defaults', 'defaults 必须是对象');
    }
    const watermark = pickWatermark(input, defaults);
    const platform = pickPlatform(input, defaults);
    const provided = {};
    if (input.name !== undefined) provided.name = validateProjectName(input.name);
    if (input.rules !== undefined) provided.rules = validateProjectRules(input.rules, current.rules);
    if (platform !== undefined) provided.platform = validateProjectPlatform(platform, current.platform);
    if (watermark !== undefined) provided.watermarkEnabled = validateProjectWatermarkEnabled(watermark);
    if (input.type !== undefined) provided.type = validateProjectType(input.type);
    if (input.brief !== undefined) provided.brief = validateProjectBrief(input.brief);
    return {
      provided,
      value: {
        name: provided.name ?? current.name,
        rules: provided.rules ?? current.rules,
        platform: provided.platform ?? current.platform,
        watermarkEnabled: provided.watermarkEnabled,
        type: provided.type,
        brief: provided.brief,
      },
    };
  }

  function createProject({ userId, input = {}, idempotencyKey = null }) {
    const value = projectCreateInput(input);
    const requestHash = sha256Hex(stableStringify({ operation: 'automation.create_project', ...value }));
    return autoStore.withTransaction(db, () => {
      const prior = autoStore.readIdempotent(db, userId, idempotencyKey, 'automation.create_project', requestHash);
      if (prior) return { ...prior, deduplicated: true };
      const item = legacyStore.createProjectRow(db, {
        userId,
        projectId: crypto.randomUUID(),
        ...value,
        nowMs: nowMs(),
      });
      const response = { item };
      autoStore.writeIdempotent(db, userId, idempotencyKey, 'automation.create_project', requestHash, response, nowMs());
      return response;
    });
  }

  function updateProject({ userId, projectId, expectedRevision, input = {}, idempotencyKey = null }) {
    const id = validateProjectId(projectId);
    const revision = parseRevision(expectedRevision);
    const current = legacyStore.getProjectContext(db, userId, id);
    if (!current) throw projectsError(404, 'not_found', '项目不存在');
    const { value, provided } = projectUpdateInput(input, current);
    // The hash covers the normalized caller request only (not merged current
    // settings): the same body replays even after other settings changed.
    const requestHash = sha256Hex(stableStringify({ operation: 'automation.update_project', projectId: id, expectedRevision: revision, provided }));
    return autoStore.withTransaction(db, () => {
      const prior = autoStore.readIdempotent(db, userId, idempotencyKey, 'automation.update_project', requestHash);
      if (prior) return { ...prior, deduplicated: true };
      const item = legacyStore.updateProjectRow(db, {
        userId,
        projectId: id,
        name: value.name,
        rules: value.rules,
        platform: value.platform,
        watermarkEnabled: value.watermarkEnabled,
        type: value.type,
        brief: value.brief,
        revision,
        nowMs: nowMs(),
      });
      const response = { item };
      autoStore.writeIdempotent(db, userId, idempotencyKey, 'automation.update_project', requestHash, response, nowMs());
      return response;
    });
  }

  function listProjects({ userId }) {
    return { items: legacyStore.listProjects(db, userId) };
  }

  /* ---------------- scenarios ---------------- */

  function scenarioInput(input = {}, project) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name.length < 1 || name.length > SCENARIO_LIMITS.name) {
      throw projectsError(400, 'invalid_name', `场景名称需为 1-${SCENARIO_LIMITS.name} 个字符`);
    }
    const brief = input.brief === undefined || input.brief === null ? '' : input.brief;
    if (typeof brief !== 'string' || brief.length > SCENARIO_LIMITS.brief) {
      throw projectsError(400, 'invalid_brief', `场景 brief 不能超过 ${SCENARIO_LIMITS.brief} 字符`);
    }
    const preset = input.preset === undefined || input.preset === null || input.preset === '' ? 'custom' : input.preset;
    if (typeof preset !== 'string' || !scenarioPreset(preset)) {
      throw projectsError(400, 'invalid_preset', '场景预设不受支持');
    }
    const caseCount = input.caseCount === undefined || input.caseCount === null
      ? SCENARIO_LIMITS.defaultCaseCount
      : input.caseCount;
    if (!Number.isInteger(caseCount) || caseCount < SCENARIO_LIMITS.caseCountMin || caseCount > SCENARIO_LIMITS.caseCountMax) {
      throw projectsError(
        400,
        'invalid_case_count',
        `caseCount 需为 ${SCENARIO_LIMITS.caseCountMin}-${SCENARIO_LIMITS.caseCountMax} 的整数（默认 ${SCENARIO_LIMITS.defaultCaseCount}）`,
      );
    }
    const platform = input.platform === undefined || input.platform === null || input.platform === ''
      ? project.platform
      : input.platform;
    if (!isPlatform(platform)) throw projectsError(400, 'invalid_platform', '场景平台不受支持');
    const locale = input.locale === undefined || input.locale === null || input.locale === ''
      ? 'zh-CN'
      : input.locale;
    if (!SCENARIO_LOCALES.includes(locale)) {
      throw projectsError(400, 'invalid_locale', `locale 只能是：${SCENARIO_LOCALES.join(', ')}`);
    }
    const autoExport = input.autoExport === undefined ? true : input.autoExport;
    if (typeof autoExport !== 'boolean') {
      throw projectsError(400, 'invalid_auto_export', 'autoExport 必须是布尔值');
    }
    // Normalized request for idempotency: constant defaults are resolved, but
    // `platform` is recorded only when explicitly provided — its default comes
    // from mutable project settings and must not break replay hashing.
    const provided = { name, brief, preset, caseCount, locale, autoExport };
    if (input.platform !== undefined && input.platform !== null && input.platform !== '') provided.platform = platform;
    return {
      provided,
      value: { name, brief, preset, caseCount, platform, locale, autoExport },
    };
  }

  function createScenario({ userId, projectId, input = {}, idempotencyKey = null }) {
    const id = validateProjectId(projectId);
    const project = legacyStore.getProjectContext(db, userId, id);
    if (!project) throw projectsError(404, 'not_found', '项目不存在');
    const { value, provided } = scenarioInput(input, project);
    const requestHash = sha256Hex(stableStringify({ operation: 'automation.create_scenario', projectId: id, provided }));
    return autoStore.withTransaction(db, () => {
      const prior = autoStore.readIdempotent(db, userId, idempotencyKey, 'automation.create_scenario', requestHash);
      if (prior) return { ...prior, deduplicated: true };
      if (autoStore.countScenarios(db, userId, id) >= SCENARIO_LIMITS.scenariosPerProject) {
        throw projectsError(409, 'scenario_limit_reached', `每个项目最多 ${SCENARIO_LIMITS.scenariosPerProject} 个场景`);
      }
      const plan = buildCasePlan({
        preset: value.preset,
        caseCount: value.caseCount,
        locale: value.locale,
        name: value.name,
        brief: value.brief,
        platform: value.platform,
      });
      const scenario = autoStore.insertScenario(db, {
        userId,
        scenario: {
          id: crypto.randomUUID(),
          projectId: id,
          ...value,
          // Frozen at creation: later project edits never change this scenario.
          frozen: {
            rules: project.rules,
            watermarkEnabled: project.watermarkEnabled,
            cast: project.brief?.cast ?? [],
            defaults: {
              platform: project.platform,
              watermarkEnabled: project.watermarkEnabled,
              type: project.type,
              recipeVersion: project.recipeVersion,
            },
          },
          recipeType: project.type,
          recipeVersion: project.recipeVersion,
        },
        plan,
        nowMs: nowMs(),
      });
      const response = {
        scenario: scenarioView(scenario),
        casePlan: planView(plan),
        counts: { planned: value.caseCount, submitted: 0, missing: value.caseCount },
        suggestedNextRange: plan.suggestedRanges[0] ?? null,
        contentStatus: 'collecting',
      };
      autoStore.writeIdempotent(db, userId, idempotencyKey, 'automation.create_scenario', requestHash, response, nowMs());
      return response;
    });
  }

  function scenarioView(scenario) {
    return {
      scenarioId: scenario.id,
      projectId: scenario.projectId,
      name: scenario.name,
      brief: scenario.brief,
      preset: scenario.preset,
      caseCount: scenario.caseCount,
      platform: scenario.platform,
      locale: scenario.locale,
      autoExport: scenario.autoExport,
      recipeType: scenario.recipeType,
      recipeVersion: scenario.recipeVersion,
      frozen: scenario.frozen,
      revision: scenario.revision,
      createdAt: scenario.createdAt,
      updatedAt: scenario.updatedAt,
    };
  }

  /** Bounded plan view: guidance once at preset level, variation per case. */
  function planView(plan) {
    return {
      preset: plan.preset,
      caseCount: plan.caseCount,
      locale: plan.locale,
      guidance: plan.guidance,
      suggestedRanges: plan.suggestedRanges,
      cases: plan.cases.map((entry) => ({
        itemKey: entry.itemKey,
        ordinal: entry.ordinal,
        name: entry.name,
        objective: entry.objective,
        context: entry.context,
        variation: entry.guide.variation,
      })),
    };
  }

  /**
   * Progress is derived from live scenes and their project association, so a
   * Web/MCP deletion or reassignment never counts as a finished case and the
   * plan stays resumable. Planned `case-001…` rows alone are never "done".
   */
  function scenarioProgress(userId, scenarioRow) {
    const plan = autoStore.scenarioPlan(scenarioRow);
    const cases = autoStore.listCaseRows(db, userId, scenarioRow.id, scenarioRow.project_id).map(autoStore.caseItem);
    const submitted = cases.filter((item) => item.submitted);
    const missing = cases.filter((item) => !item.submitted).map((item) => item.itemKey);
    return {
      planned: plan.cases.length,
      submitted: submitted.length,
      missing: missing.length,
      missingItemKeys: missing.slice(0, MAX_MISSING_KEYS_REPORTED),
      missingTruncated: missing.length > MAX_MISSING_KEYS_REPORTED,
      suggestedNextRange: nextRangeFor(plan, missing),
      contentStatus: missing.length === 0 ? 'ready' : 'collecting',
    };
  }

  function nextRangeFor(plan, missingKeys) {
    if (missingKeys.length === 0) return null;
    const itemKeys = missingKeys.slice(0, SCENARIO_LIMITS.batchItemsMax);
    return { fromKey: itemKeys[0], toKey: itemKeys.at(-1), count: itemKeys.length, itemKeys };
  }

  function listScenarios({ userId, projectId }) {
    const id = validateProjectId(projectId);
    if (!legacyStore.getProjectContext(db, userId, id)) throw projectsError(404, 'not_found', '项目不存在');
    const items = autoStore.listScenarioRows(db, userId, id).map((row) => {
      const progress = scenarioProgress(userId, row);
      return {
        scenarioId: row.id,
        name: row.name,
        preset: row.preset,
        caseCount: Number(row.case_count),
        platform: row.platform,
        locale: row.locale,
        autoExport: Number(row.auto_export) === 1,
        submitted: progress.submitted,
        missing: progress.missing,
        contentStatus: progress.contentStatus,
        updatedAt: row.updated_at,
      };
    });
    return { items };
  }

  function getScenario({ userId, projectId, scenarioId }) {
    const id = validateProjectId(projectId);
    const scenario = autoStore.getScenarioItem(db, userId, scenarioId);
    if (!scenario || scenario.projectId !== id) throw projectsError(404, 'not_found', '场景不存在');
    const row = autoStore.getScenarioRow(db, userId, scenarioId);
    const plan = autoStore.scenarioPlan(row);
    const cases = autoStore.listCaseRows(db, userId, scenarioId, id).map(autoStore.caseItem);
    const progress = scenarioProgress(userId, row);
    return {
      scenario: scenarioView(scenario),
      casePlan: planView(plan),
      cases,
      counts: { planned: progress.planned, submitted: progress.submitted, missing: progress.missing },
      missingItemKeys: progress.missingItemKeys,
      missingTruncated: progress.missingTruncated,
      suggestedNextRange: progress.suggestedNextRange,
      contentStatus: progress.contentStatus,
      resume: {
        nextAction:
          progress.missing === 0
            ? '全部案例内容已提交。接下来：imstage_export_project 导出（或等待 autoExport）→ 轮询 imstage_get_project_status 至 completed/partial → 用 imstage_get_project_export 获取可用 ZIP 下载链接。'
            : `继续提交缺少的 ${progress.missing} 个案例（建议下一批：${progress.suggestedNextRange?.fromKey ?? '-'} 起，最多 ${SCENARIO_LIMITS.batchItemsMax} 条/批），全部提交后导出。`,
      },
    };
  }

  /* ---------------- content batches ---------------- */

  function requireProject(userId, projectId) {
    const id = validateProjectId(projectId);
    const project = legacyStore.getProjectContext(db, userId, id);
    if (!project) throw projectsError(404, 'not_found', '项目不存在');
    return { id, project };
  }

  function requireScenario(userId, projectId, scenarioId) {
    const scenario = autoStore.getScenarioItem(db, userId, scenarioId);
    if (!scenario || scenario.projectId !== projectId) throw projectsError(404, 'not_found', '场景不存在');
    const row = autoStore.getScenarioRow(db, userId, scenarioId);
    return { scenario, row, plan: autoStore.scenarioPlan(row) };
  }

  function resolveTemplate(userId, templateId, templateRevision) {
    if (templateId === undefined || templateId === null || templateId === '') return null;
    let detail;
    try {
      detail = getTemplate(db, userId, templateId);
    } catch (error) {
      if (error instanceof TemplateError) throw projectsError(error.status, error.code, error.message);
      throw error;
    }
    if (templateRevision !== undefined && templateRevision !== null && templateRevision !== detail.revision) {
      throw projectsError(409, 'revision_conflict', `模板已更新：期望 revision ${templateRevision}，当前 ${detail.revision}`);
    }
    return { id: detail.id, revision: detail.revision, definition: detail.definition };
  }

  function validateItemKey(raw, label) {
    if (typeof raw !== 'string' || !ITEM_RE.test(raw)) {
      throw projectsError(400, 'invalid_item_key', `${label} 的 itemKey 不合法`);
    }
    return raw;
  }

  function normalizeBatchItem(raw, index, { planByKey, template, frozenWatermark, defaultPlatform, accountDefaults }) {
    const label = `第 ${index + 1} 条`;
    if (!isPlainObject(raw)) throw projectsError(400, 'invalid_items', `${label} 必须是对象`);
    for (const key of Object.keys(raw)) {
      if (!['itemKey', 'name', 'objective', 'context', 'annotations', 'prompt', 'scene', 'values', 'patch'].includes(key)) {
        throw projectsError(400, 'invalid_items', `${label} 含未知字段：${key}`);
      }
    }
    const itemKey = validateItemKey(raw.itemKey, label);
    const planned = planByKey.get(itemKey) ?? null;
    const hasScene = raw.scene !== undefined;
    const hasValues = raw.values !== undefined;
    const hasPatch = raw.patch !== undefined;
    if (hasScene && (hasValues || hasPatch)) {
      throw projectsError(400, 'invalid_items', `${label} 不能同时提供 scene 与 values/patch`);
    }
    if (!hasScene && !hasValues && !hasPatch) {
      throw projectsError(400, 'invalid_items', `${label} 需要完整 scene，或 templateId + values/patch`);
    }

    const name = raw.name === undefined || raw.name === null ? (planned?.name ?? '') : raw.name;
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > MAX_CASE_NAME_CHARS) {
      throw projectsError(400, 'invalid_items', `${label} 的 name 需为 1-${MAX_CASE_NAME_CHARS} 个字符`);
    }
    const objective = raw.objective === undefined || raw.objective === null ? '' : raw.objective;
    const context = raw.context === undefined || raw.context === null ? '' : raw.context;
    if (typeof objective !== 'string' || objective.length > MAX_CASE_OBJECTIVE_CHARS) {
      throw projectsError(400, 'invalid_items', `${label} 的 objective 不能超过 ${MAX_CASE_OBJECTIVE_CHARS} 字`);
    }
    if (typeof context !== 'string' || context.length > MAX_CASE_CONTEXT_CHARS) {
      throw projectsError(400, 'invalid_items', `${label} 的 context 不能超过 ${MAX_CASE_CONTEXT_CHARS} 字`);
    }
    if (planByKey.size > 0 && (objective.trim() === '' || context.trim() === '')) {
      throw projectsError(422, 'invalid_items', `${label} 的 objective/context 必填且不能为空`);
    }
    const prompt = raw.prompt === undefined || raw.prompt === null ? '' : raw.prompt;
    if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) {
      throw projectsError(400, 'invalid_items', `${label} 的 prompt 不能超过 ${MAX_PROMPT_CHARS} 字`);
    }
    const annotations = validateAnnotations(raw.annotations);

    let scene;
    if (hasScene) {
      const rawScene = raw.scene;
      if (!isPlainObject(rawScene)) throw projectsError(400, 'invalid_items', `${label} 的 scene 必须是对象`);
      // Defaults fill only missing fields: an explicit `watermarkEnabled: false`
      // survives project/scenario default application untouched.
      // Server-owned default fill: missing participant avatars come from the
      // account preferences (same semantics as ordinary create_scene — an
      // explicit blank/null avatar always wins). Resolved avatars are persisted
      // in the Scene snapshot; status/summaries never return default bytes.
      const candidate = applySceneDefaults({ ...rawScene }, {
        myAvatar: accountDefaults?.myAvatar ?? null,
        otherAvatar: accountDefaults?.otherAvatar ?? null,
      });
      if (candidate.watermarkEnabled === undefined && typeof frozenWatermark === 'boolean') {
        candidate.watermarkEnabled = frozenWatermark;
      }
      if (candidate.platform === undefined || candidate.platform === null || candidate.platform === '') {
        candidate.platform = defaultPlatform;
      }
      scene = guarded(() => prepareCreateScene(candidate, { sceneId: sceneIdFactory() }));
    } else {
      if (!template) {
        throw projectsError(400, 'invalid_items', `${label} 提供 values/patch 时必须同时指定 templateId`);
      }
      const values = raw.values === undefined ? {} : raw.values;
      if (!isPlainObject(values)) throw projectsError(400, 'invalid_items', `${label} 的 values 必须是对象`);
      const sceneId = sceneIdFactory();
      const instantiated = guarded(() => instantiateTemplate(template.definition, values, sceneId));
      if (!instantiated.ok) {
        throw projectsError(422, 'invalid_values', `${label} 变量不合法：${instantiated.errors.slice(0, 3).join('；')}`);
      }
      let built = instantiated.value;
      if (hasPatch) {
        const patched = guarded(() => applyScenePatch(built, raw.patch));
        built = patched.scene;
      }
      if (built.watermarkEnabled === undefined && typeof frozenWatermark === 'boolean') {
        built = { ...built, watermarkEnabled: frozenWatermark };
      }
      built = applySceneDefaults(built, {
        myAvatar: accountDefaults?.myAvatar ?? null,
        otherAvatar: accountDefaults?.otherAvatar ?? null,
      });
      guarded(() => enforceSceneBounds(built, { label: `${label}.scene` }));
      scene = built;
    }

    return {
      itemKey,
      name: name.trim(),
      objective,
      context,
      annotations,
      prompt,
      scene,
      dialogueHash: dialogueSignature(scene),
    };
  }

  function batchRequestHash(projectId, scenarioId, templateId, templateRevision, rawItems) {
    return sha256Hex(
      stableStringify({
        operation: 'content_batch',
        projectId,
        scenarioId: scenarioId ?? null,
        templateId: templateId ?? null,
        templateRevision: templateRevision ?? null,
        items: rawItems,
      }),
    );
  }

  function batchReceipt(row, { deduplicated = false } = {}) {
    const frozen = (() => {
      try {
        return JSON.parse(row.frozen_json ?? '{}');
      } catch {
        return {};
      }
    })();
    return {
      batchId: row.id,
      projectId: row.project_id,
      scenarioId: row.scenario_id ?? null,
      clientIdempotencyKey: row.client_key ?? null,
      requestHash: row.request_hash,
      templateId: row.template_id ?? null,
      templateRevision: row.template_revision === null || row.template_revision === undefined ? null : Number(row.template_revision),
      frozen,
      total: Number(row.total),
      origin: row.origin ?? '',
      createdAt: row.created_at,
      items: autoStore.contentBatchItems(db, row.user_id, row.id),
      deduplicated,
    };
  }

  async function createContentBatch({ userId, projectId, input = {}, idempotencyKey = null, origin = '', grantRef = null, principal = null, authorizeCheck = null }) {
    // Ownership check first: a foreign project is never readable or writable.
    const { id, project } = requireProject(userId, projectId);
    const scenarioId = input.scenarioId === undefined || input.scenarioId === null || input.scenarioId === '' ? null : input.scenarioId;
    const rawTemplateId = input.templateId === undefined || input.templateId === null || input.templateId === '' ? null : input.templateId;
    const rawTemplateRevision = input.templateRevision === undefined || input.templateRevision === null ? null : input.templateRevision;
    const clientKeyRaw = idempotencyKey ?? input.clientIdempotencyKey ?? null;
    const clientKey = validateIdempotencyKey(clientKeyRaw);
    const rawItems = input.items;
    if (!Array.isArray(rawItems) || rawItems.length < 1) {
      throw projectsError(400, 'invalid_items', 'items 至少需要 1 个条目');
    }
    if (rawItems.length > MAX_CONTENT_BATCH_ITEMS) {
      throw projectsError(413, 'invalid_batch_size', `每批最多 ${MAX_CONTENT_BATCH_ITEMS} 个条目，当前 ${rawItems.length} 个`);
    }

    // The request hash covers the normalized *caller request* only — never
    // resolved template revisions or project defaults — so a safe retry after
    // unrelated template/settings changes still matches the original request.
    const requestHash = batchRequestHash(id, scenarioId, rawTemplateId, rawTemplateRevision, rawItems);

    // Idempotent replay is resolved before any mutable-state validation (the
    // current template/defaults are not re-read): the same key + same
    // normalized request returns the original receipt even after defaults or
    // templates changed; a different request with the same key is an explicit
    // conflict.
    const priorRow = autoStore.findContentBatchByClientKey(db, userId, id, clientKey);
    if (priorRow) {
      if (priorRow.request_hash !== requestHash) {
        throw projectsError(409, 'idempotency_conflict', '该 clientIdempotencyKey 已用于不同的请求内容');
      }
      return batchReceipt(priorRow, { deduplicated: true });
    }
    // Server-owned account defaults (avatars) are read AFTER idempotent replay
    // and never enter the request hash: mutable preferences must not break a
    // replay of the exact normalized caller input.
    const accountDefaults = typeof readPreferences === 'function' ? await readPreferences(userId) : null;
    // Authorization recheck AFTER the async gates (defaults read) and BEFORE
    // the transactional write: a session expiry/revocation that lands while the
    // await is in flight must never commit a batch. No async IO happens inside
    // the transaction below.
    if (typeof authorizeCheck === 'function') await authorizeCheck();
    // Concurrent same-key submits serialize on the async gates above: re-read
    // the SAME key here (before any mutable/case validation) so the loser gets
    // the frozen receipt instead of a spurious duplicate_item_key error.
    const racedRow = autoStore.findContentBatchByClientKey(db, userId, id, clientKey);
    if (racedRow) {
      if (racedRow.request_hash !== requestHash) {
        throw projectsError(409, 'idempotency_conflict', '该 clientIdempotencyKey 已用于不同的请求内容');
      }
      return batchReceipt(racedRow, { deduplicated: true });
    }

    const scenarioContext = scenarioId ? requireScenario(userId, id, scenarioId) : null;
    const template = resolveTemplate(userId, rawTemplateId, rawTemplateRevision);

    const planByKey = new Map();
    if (scenarioContext) {
      for (const entry of scenarioContext.plan.cases) planByKey.set(entry.itemKey, entry);
    }
    const frozenWatermark = scenarioContext
      ? scenarioContext.scenario.frozen.watermarkEnabled
      : project.watermarkEnabled;
    const defaultPlatform = scenarioContext ? scenarioContext.scenario.platform : project.platform;

    const seenKeys = new Set();
    const seenDialogues = new Map();
    const existingDialogues = new Map();
    if (scenarioContext) {
      // Live signatures of completed cases: an edited transcript cannot be
      // resubmitted as a "different" case through a stale cached hash.
      for (const entry of autoStore.submittedDialogueHashes(db, userId, scenarioId, id)) {
        existingDialogues.set(entry.dialogueHash, entry.itemKey);
      }
    }

    const items = [];
    try {
      for (const [index, raw] of rawItems.entries()) {
        const item = normalizeBatchItem(raw, index, { planByKey, template, frozenWatermark, defaultPlatform, accountDefaults });
      const recipeType = scenarioContext ? scenarioContext.scenario.recipeType : project.type;
      if (recipeType === 'evaluation_dataset' && Object.keys(item.annotations.labels ?? {}).length === 0) {
        throw projectsError(422, 'missing_annotations', `评测案例 ${item.itemKey} 需要调用方提供至少一个标注`);
      }
      if (seenKeys.has(item.itemKey)) {
        throw projectsError(409, 'duplicate_item_key', `itemKey 重复：${item.itemKey}`);
      }
      seenKeys.add(item.itemKey);
      if (planByKey.size > 0) {
        const planned = planByKey.get(item.itemKey);
        if (!planned) {
          throw projectsError(400, 'unknown_item_key', `itemKey 不属于该场景计划：${item.itemKey}`);
        }
        const row = autoStore.getCaseRow(db, userId, scenarioId, item.itemKey, id);
        if (row && autoStore.caseItem(row).submitted) {
          throw projectsError(409, 'duplicate_item_key', `案例已提交，不能重复创建：${item.itemKey}`);
        }
        const priorDialogue = existingDialogues.get(item.dialogueHash) ?? seenDialogues.get(item.dialogueHash);
        if (priorDialogue) {
          throw projectsError(409, 'duplicate_dialogue', `与 ${priorDialogue} 的对话内容完全相同（忽略 ID/标题/时间/平台）`);
        }
        seenDialogues.set(item.dialogueHash, item.itemKey);
      } else {
        const prior = autoStore.findProjectItemKey(db, userId, id, item.itemKey);
        if (prior) {
          throw projectsError(409, 'duplicate_item_key', `itemKey 已存在于该项目：${item.itemKey}`);
        }
        const priorDialogue = seenDialogues.get(item.dialogueHash);
        if (priorDialogue) {
          throw projectsError(409, 'duplicate_dialogue', `与 ${priorDialogue} 的对话内容完全相同（忽略 ID/标题/时间/平台）`);
        }
        seenDialogues.set(item.dialogueHash, item.itemKey);
      }
      items.push(item);
    }
    } catch (error) {
      // A concurrent identical submit may have won the race while we validated:
      // the same key now resolves to its frozen receipt instead of surfacing a
      // spurious duplicate error.
      const raced = autoStore.findContentBatchByClientKey(db, userId, id, clientKey);
      if (raced) {
        if (raced.request_hash !== requestHash) {
          throw projectsError(409, 'idempotency_conflict', '该 clientIdempotencyKey 已用于不同的请求内容');
        }
        return batchReceipt(raced, { deduplicated: true });
      }
      throw error;
    }

    // True capacity validation: the account scene limit is checked before the
    // transaction and re-checked inside it, so a concurrent batch can never
    // push an account past the cap.
    if (autoStore.countAccountScenes(db, userId) + items.length > MAX_SCENES_PER_USER) {
      throw projectsError(409, 'scene_limit_reached', `每个账号最多保存 ${MAX_SCENES_PER_USER} 个作品`);
    }

    const receipt = autoStore.withTransaction(db, () => {
      // The transaction is the serialization point: resolve the exact key once
      // more before any write so two concurrent identical submits can never
      // both create scenes.
      const racedInside = autoStore.findContentBatchByClientKey(db, userId, id, clientKey);
      if (racedInside) {
        if (racedInside.request_hash !== requestHash) {
          throw projectsError(409, 'idempotency_conflict', '该 clientIdempotencyKey 已用于不同的请求内容');
        }
        return batchReceipt(racedInside, { deduplicated: true });
      }
      if (autoStore.countAccountScenes(db, userId) + items.length > MAX_SCENES_PER_USER) {
        throw projectsError(409, 'scene_limit_reached', `每个账号最多保存 ${MAX_SCENES_PER_USER} 个作品`);
      }
      const batchId = crypto.randomUUID();
      if (scenarioContext) {
        // Housekeeping: cached signatures of deleted scenes are cleared inside
        // the same transaction so a legitimate resubmission is never blocked.
        autoStore.clearStaleDialogueHashes(db, userId, scenarioId);
      }
      const frozen = {
        rules: scenarioContext ? scenarioContext.scenario.frozen.rules : project.rules,
        watermarkEnabled: frozenWatermark,
        platform: defaultPlatform,
        type: scenarioContext ? scenarioContext.scenario.recipeType : project.type,
        recipeVersion: scenarioContext ? scenarioContext.scenario.recipeVersion : project.recipeVersion,
        cast: scenarioContext ? scenarioContext.scenario.frozen.cast : (project.brief?.cast ?? []),
        scenarioName: scenarioContext?.scenario.name ?? null,
        preset: scenarioContext?.scenario.preset ?? null,
      };
      items.forEach((item) => {
        autoStore.insertSceneRow(db, { userId, scene: item.scene, nowMs: nowMs() });
        autoStore.attachSceneRow(db, { userId, projectId: id, sceneId: item.scene.id, nowMs: nowMs() });
        if (scenarioContext) {
          autoStore.submitCaseContent(db, {
            userId,
            scenarioId,
            itemKey: item.itemKey,
            name: item.name,
            objective: item.objective,
            context: item.context,
            annotations: item.annotations,
            sceneId: item.scene.id,
            sceneRevision: 1,
            dialogueHash: item.dialogueHash,
            source: 'caller',
            nowMs: nowMs(),
          });
        }
        // Per-Scene metadata audit inside the same transaction (matching the
        // account create/update behavior): a failed audit fails the batch
        // write and every generated scene hash is represented.
        recordGenerationAudit(db, {
          runId: newAuditRunId(),
          accountId: userId,
          flow: 'account_mcp',
          status: 'ok',
          scene: item.scene,
          nowMs: nowMs(),
        });
      });
      autoStore.insertContentBatch(db, {
        batch: {
          id: batchId,
          userId,
          projectId: id,
          scenarioId,
          clientKey,
          requestHash,
          template: template ? { id: template.id, revision: template.revision, definition: template.definition } : null,
          frozen,
          origin,
          grantRef,
        },
        items: items.map((item) => ({
          itemKey: item.itemKey,
          name: item.name,
          objective: item.objective,
          context: item.context,
          annotations: item.annotations,
          prompt: item.prompt,
          sceneId: item.scene.id,
          sceneRevision: 1,
        })),
        nowMs: nowMs(),
      });
      const row = autoStore.getContentBatchRow(db, userId, batchId);
      return batchReceipt(row, { deduplicated: false });
    });
    if (scenarioContext) {
      receipt.scenarioProgress = scenarioProgress(userId, autoStore.getScenarioRow(db, userId, scenarioId));
      if (!receipt.deduplicated) {
        receipt.autoExport = await maybeAutoExport({
          userId,
          projectId: id,
          scenarioId,
          principal,
          progress: receipt.scenarioProgress,
          autoExportEnabled: scenarioContext.scenario.autoExport,
        });
      }
    }
    return receipt;
  }

  /**
   * AutoExport: the final content batch of a ready scenario queues exactly one
   * deduped scenario export (fingerprint-deduped by the export service). Never
   * runs for incomplete/unannotated content and never blocks the saved batch.
   */
  async function maybeAutoExport({ userId, projectId, scenarioId, principal, progress, autoExportEnabled }) {
    if (!autoExportEnabled) return { queued: false, reason: 'auto_export_disabled' };
    if (progress.missing > 0) return { queued: false, reason: 'missing_items', missing: progress.missing };
    if (typeof onScenarioContentReady !== 'function') return { queued: false, reason: 'export_not_configured' };
    return await onScenarioContentReady({ userId, projectId, scenarioId, principal });
  }

  function validateIdempotencyKey(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    if (typeof raw !== 'string') throw projectsError(400, 'invalid_idempotency_key', 'idempotencyKey 必须是字符串');
    const trimmed = raw.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      throw projectsError(400, 'invalid_idempotency_key', `idempotencyKey 需为 1-${MAX_IDEMPOTENCY_KEY_CHARS} 个字符`);
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw projectsError(400, 'invalid_idempotency_key', 'idempotencyKey 不能包含控制字符');
    }
    return trimmed;
  }

  function getContentBatch({ userId, projectId, batchId }) {
    const { id } = requireProject(userId, projectId);
    const row = autoStore.getContentBatchRow(db, userId, batchId);
    if (!row || row.project_id !== id) throw projectsError(404, 'not_found', '批次不存在');
    return batchReceipt(row);
  }

  function listContentBatches({ userId, projectId, limit = 20 }) {
    const { id } = requireProject(userId, projectId);
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_BATCH_LIST_LIMIT) : 20;
    const items = autoStore.listContentBatchRows(db, userId, id, safeLimit).map((row) => ({
      batchId: row.id,
      scenarioId: row.scenario_id ?? null,
      clientIdempotencyKey: row.client_key ?? null,
      templateId: row.template_id ?? null,
      templateRevision: row.template_revision === null || row.template_revision === undefined ? null : Number(row.template_revision),
      total: Number(row.total),
      origin: row.origin ?? '',
      createdAt: row.created_at,
    }));
    return { items };
  }

  /* ---------------- project detail & status ---------------- */

  function sceneSummaries(userId, projectId) {
    return legacyStore.listProjectScenes(db, userId, projectId);
  }

  /** Bounded brief view: avatar bytes are summarized, never dumped. */
  function summarizeBrief(brief) {
    if (!brief || typeof brief !== 'object') return {};
    const cast = Array.isArray(brief.cast)
      ? brief.cast.map((member) => {
          const { avatar, ...rest } = member;
          return { ...rest, hasAvatar: Boolean(avatar) };
        })
      : undefined;
    return { ...brief, ...(cast ? { cast } : {}) };
  }

  /** Bounded detail read: summaries and resume guidance, never full dumps. */
  function getProject({ userId, projectId }) {
    const { id, project } = requireProject(userId, projectId);
    const scenarioRows = autoStore.listScenarioRows(db, userId, id);
    const scenarios = scenarioRows.map((row) => {
      const progress = scenarioProgress(userId, row);
      return {
        scenarioId: row.id,
        name: row.name,
        preset: row.preset,
        caseCount: Number(row.case_count),
        submitted: progress.submitted,
        missing: progress.missing,
        contentStatus: progress.contentStatus,
        suggestedNextRange: progress.suggestedNextRange,
      };
    });
    const expectedCases = scenarios.reduce((sum, item) => sum + item.caseCount, 0);
    const submittedCases = scenarios.reduce((sum, item) => sum + item.submitted, 0);
    const item = legacyStore.getProjectItem(db, userId, id);
    return {
      item: { ...item, brief: summarizeBrief(item.brief) },
      recipe: projectRecipe(project.type),
      scenarios,
      scenes: sceneSummaries(userId, id),
      contentBatches: {
        count: autoStore.countContentBatches(db, userId, id),
        latest: listContentBatches({ userId, projectId: id, limit: 5 }).items,
      },
      totals: { expectedCases, submittedCases, missingCases: expectedCases - submittedCases },
      status: projectStatusFor(userId, id, scenarios),
      delivery: deliverySummary(userId, id),
      resume: {
        nextAction: scenarios.some((item) => item.contentStatus !== 'ready')
          ? `继续提交缺少的案例：${scenarios.find((item) => item.contentStatus !== 'ready')?.suggestedNextRange?.fromKey ?? '-'} 起（每批 ≤ ${SCENARIO_LIMITS.batchItemsMax} 条），全部提交后导出。`
          : scenarios.length === 0
            ? '尚未创建场景计划。'
            : '内容已齐备（ready）：调用 imstage_export_project 导出（或等待 autoExport），轮询 imstage_get_project_status 至 completed 后用 imstage_get_project_export 获取 ZIP。',
      },
    };
  }

  /** Delivery summary from the injected export service (bounded, blob-free). */
  function deliverySummary(userId, projectId) {
    if (exportService && typeof exportService.projectDeliverySummary === 'function') {
      return exportService.projectDeliverySummary({ userId, projectId });
    }
    return {
      export: 'not_started',
      active: 0,
      latest: null,
      current: null,
      historical: [],
      downloadsExpireAt: null,
      note: '导出服务未接入。',
    };
  }

  /**
   * Truthful aggregate status: `completed` only when current file packages'
   * mandatory files cover the LIVE content; partial/failed/interrupted and
   * historical packages are reported as such, never as success.
   */
  function projectStatusFor(userId, projectId, scenarios) {
    if (scenarios.length === 0) return 'collecting';
    if (scenarios.some((item) => item.contentStatus !== 'ready')) return 'collecting';
    const delivery = deliverySummary(userId, projectId);
    if (delivery.active > 0) return 'exporting';
    if (delivery.coverage?.complete === true) return 'completed';
    const current = delivery.current ?? null;
    if (
      current &&
      current.status === 'completed' &&
      (current.counts?.failed ?? 0) === 0 &&
      (current.missingItemKeys?.length ?? 0) === 0
    ) {
      return 'completed';
    }
    const latest = delivery.latest ?? null;
    if (latest && latest.contentState !== 'historical' && ['partial', 'failed', 'interrupted', 'cancelled'].includes(latest.status)) {
      return latest.status;
    }
    return 'ready';
  }

  /** Truthful aggregate status for one project (content only in this batch). */
  function getProjectStatus({ userId, projectId, exportId = null }) {
    const { id, project } = requireProject(userId, projectId);
    const scenarioRows = autoStore.listScenarioRows(db, userId, id);
    const scenarios = scenarioRows.map((row) => {
      const progress = scenarioProgress(userId, row);
      return {
        scenarioId: row.id,
        name: row.name,
        preset: row.preset,
        caseCount: Number(row.case_count),
        submitted: progress.submitted,
        missing: progress.missing,
        missingItemKeys: progress.missingItemKeys,
        missingTruncated: progress.missingTruncated,
        suggestedNextRange: progress.suggestedNextRange,
        contentStatus: progress.contentStatus,
        autoExport: Number(row.auto_export) === 1,
      };
    });
    const expectedCases = scenarios.reduce((sum, item) => sum + item.caseCount, 0);
    const submittedCases = scenarios.reduce((sum, item) => sum + item.submitted, 0);
    const status = projectStatusFor(userId, id, scenarios);
    return {
      project: {
        id,
        name: project.name,
        type: project.type,
        recipeVersion: project.recipeVersion,
        platform: project.platform,
        watermarkEnabled: project.watermarkEnabled,
        revision: legacyStore.getProjectRow(db, userId, id).revision,
      },
      recipe: projectRecipe(project.type),
      scenarios,
      totals: {
        scenarios: scenarios.length,
        expectedCases,
        submittedCases,
        missingCases: expectedCases - submittedCases,
        accountScenes: autoStore.countAccountScenes(db, userId),
      },
      contentBatches: {
        count: autoStore.countContentBatches(db, userId, id),
        latest: listContentBatches({ userId, projectId: id, limit: 5 }).items,
      },
      status,
      delivery: deliverySummary(userId, id),
      // Optional single-export detail (bounded item summaries, never scene blobs).
      ...(exportId && exportService && typeof exportService.get === 'function'
        ? { export: exportService.get({ userId, projectId: id, exportId }).export }
        : {}),
      resume: {
        nextAction:
          status === 'completed'
            ? '当前文件包已覆盖全部内容：按 delivery.currentExports 用 imstage_get_project_export 获取各包下载链接（注意 expiresAt）；也可导出整个项目为一个总包。'
            : status === 'exporting'
              ? '导出进行中：继续轮询 imstage_get_project_status 至 completed/partial。'
              : scenarios.some((item) => item.contentStatus !== 'ready')
                ? scenarios
                    .filter((item) => item.contentStatus !== 'ready')
                    .map((item) => `${item.name}：缺少 ${item.missing} 个案例，从 ${item.suggestedNextRange?.fromKey ?? '-'} 继续提交`)
                    .join('；')
                : '内容已齐备（ready）：调用 imstage_export_project 导出（或等待 autoExport），完成后用 imstage_get_project_export 获取 ZIP。',
      },
    };
  }

  return {
    listProjectTypes,
    createProject,
    updateProject,
    listProjects,
    getProject,
    createScenario,
    listScenarios,
    getScenario,
    createContentBatch,
    getContentBatch,
    listContentBatches,
    getProjectStatus,
  };
}

export { suggestedBatchRanges };

/**
 * IMStage Projects — validation and prompt construction.
 *
 * Pure helpers shared by the HTTP handlers, the store and the serial batch
 * worker. No database or network access happens here so every bound can be
 * unit-tested directly.
 *
 * Scope note: a Project is account-owned metadata (name, rules, default
 * platform). It never stores credentials and its `rules` field is ordinary
 * user-authored text, not a secret.
 */

import { createScene, validateScene, PLATFORMS } from '../../apps/web/src/studio/model.ts';
import { projectsError } from './errors.mjs';

export const MAX_PROJECT_NAME_CHARS = 80;
export const MAX_PROJECT_RULES_CHARS = 4000;
export const MAX_PROJECTS_PER_USER = 50;
export const DEFAULT_PROJECT_PLATFORM = 'wechat';

export const MAX_BATCH_PROMPTS = 10;
export const MAX_BATCH_ITEMS = 20;
export const MAX_BATCH_PROMPT_CHARS = 4000;
export const MAX_CLIENT_BATCH_ID_CHARS = 200;
export const MAX_ACTIVE_BATCH_JOBS = 3;

/**
 * Kept in sync with `MAX_SCENES_PER_USER` in `services/api/server.mjs`. The
 * batch publisher enforces the same per-account scene cap as the direct scene
 * PUT route so generated scenes cannot bypass the account quota.
 */
export const MAX_SCENES_PER_USER = 100;

const PLATFORM_SET = new Set(PLATFORMS);

export function isPlatform(value) {
  return typeof value === 'string' && PLATFORM_SET.has(value);
}

export function validateProjectName(raw) {
  if (typeof raw !== 'string') {
    throw projectsError(400, 'invalid_name', '项目名称必须是字符串');
  }
  const name = raw.trim();
  if (name.length < 1 || name.length > MAX_PROJECT_NAME_CHARS) {
    throw projectsError(
      400,
      'invalid_name',
      `项目名称长度需为 1-${MAX_PROJECT_NAME_CHARS} 个字符`,
    );
  }
  return name;
}

export function validateProjectRules(raw, fallback = '') {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') {
    throw projectsError(400, 'invalid_rules', '项目规则必须是字符串');
  }
  if (raw.length > MAX_PROJECT_RULES_CHARS) {
    throw projectsError(
      400,
      'invalid_rules',
      `项目规则不能超过 ${MAX_PROJECT_RULES_CHARS} 个字符`,
    );
  }
  return raw;
}

export function validateProjectPlatform(raw, fallback = DEFAULT_PROJECT_PLATFORM) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (!isPlatform(raw)) {
    throw projectsError(400, 'invalid_platform', '默认平台不受支持');
  }
  return raw;
}

export function parseRevision(raw) {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    throw projectsError(400, 'invalid_revision', 'revision 必须是不小于 0 的整数');
  }
  return raw;
}

export function validateProjectId(raw) {
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw projectsError(404, 'not_found', '项目不存在');
  }
  return raw.toLowerCase();
}

export function validateJobId(raw) {
  if (typeof raw !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw projectsError(404, 'not_found', '生成任务不存在');
  }
  return raw.toLowerCase();
}

/**
 * Split the batch input into non-empty prompt lines. Accepts either an array
 * of strings or a newline-separated `promptsText` value.
 */
export function normalizePrompts(input) {
  let raw;
  if (Array.isArray(input?.prompts)) {
    raw = input.prompts;
  } else if (typeof input?.promptsText === 'string') {
    raw = input.promptsText.split(/\r?\n/);
  } else {
    throw projectsError(400, 'invalid_prompts', '请至少输入 1 条提示词');
  }
  const prompts = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw projectsError(400, 'invalid_prompts', '每条提示词都必须是字符串');
    }
    const text = item.trim();
    if (text === '') continue;
    if (text.length > MAX_BATCH_PROMPT_CHARS) {
      throw projectsError(
        400,
        'invalid_prompts',
        `单条提示词不能超过 ${MAX_BATCH_PROMPT_CHARS} 个字符`,
      );
    }
    prompts.push(text);
  }
  if (prompts.length === 0) {
    throw projectsError(400, 'invalid_prompts', '请至少输入 1 条提示词');
  }
  if (prompts.length > MAX_BATCH_PROMPTS) {
    throw projectsError(
      400,
      'invalid_prompts',
      `最多只能输入 ${MAX_BATCH_PROMPTS} 条提示词（每行一条）`,
    );
  }
  return prompts;
}

/** Distinct, validated platform selection. Empty selection uses the default. */
export function normalizePlatforms(raw, fallback = DEFAULT_PROJECT_PLATFORM) {
  if (raw === undefined || raw === null) return [fallback];
  if (!Array.isArray(raw)) {
    throw projectsError(400, 'invalid_platforms', 'platforms 必须是数组');
  }
  const platforms = [];
  for (const item of raw) {
    if (!isPlatform(item)) {
      throw projectsError(400, 'invalid_platforms', '选择的平台不受支持');
    }
    if (!platforms.includes(item)) platforms.push(item);
  }
  if (platforms.length === 0) return [fallback];
  return platforms;
}

/**
 * Expand prompts × platforms into the exact task list. Enforces the 20-item
 * ceiling so one submit cannot enqueue an unbounded amount of paid work.
 */
export function buildBatchTasks(input, defaultPlatform) {
  const prompts = normalizePrompts(input);
  const platforms = normalizePlatforms(input?.platforms, defaultPlatform);
  const total = prompts.length * platforms.length;
  if (total > MAX_BATCH_ITEMS) {
    throw projectsError(
      400,
      'invalid_batch_size',
      `一次最多生成 ${MAX_BATCH_ITEMS} 个作品（提示词 × 平台），当前为 ${total} 个`,
    );
  }
  const tasks = [];
  for (const prompt of prompts) {
    for (const platform of platforms) {
      tasks.push({ prompt, platform });
    }
  }
  return tasks;
}

export function validateClientBatchId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > MAX_CLIENT_BATCH_ID_CHARS) {
    throw projectsError(400, 'invalid_client_batch_id', 'clientBatchId 无效');
  }
  return raw;
}

/**
 * Build the per-task prompt handed to the shared agent runtime.
 *
 * The project rules are a separate, clearly labelled block of ordinary user
 * instructions (not secrets), kept distinct from the task prompt so the model
 * does not confuse project constraints with the specific request.
 */
export function buildTaskPrompt(rules, prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  if (typeof rules !== 'string' || rules.trim() === '') return text;
  return [
    '【项目规则｜本项目的创作约束，属于普通用户指令，不是机密信息】',
    rules.trim(),
    '',
    '【本次任务】',
    text,
    '',
    '提交工具结果前逐项核对项目规则。规则给出的固定消息必须逐字作为独立消息保留，包括标点，不能扩写、转述或拼接其他文字。规则约束消息条数时必须准确满足。',
  ].join('\n');
}

/**
 * A validated blank scene for one generated work item. It reuses the shared
 * `createScene` contract and clears the template content so the model builds
 * the conversation from scratch while the canonical validator still accepts it.
 */
export function blankScene(platform, id) {
  const base = createScene('weekend');
  const candidate = {
    ...base,
    id,
    title: '',
    platform,
    surface:'ios',
    deviceProfileId:'iphone-17-pro',
    participants:base.participants.map(p=>p.id===base.selfId?{...p,name:'我',avatar:undefined}:p),
    messages: [],
    watermark: '',
  };
  const result = validateScene(candidate);
  if (!result.ok || !result.scene) {
    throw projectsError(
      500,
      'internal_error',
      `无法创建空白场景：${result.errors.slice(0, 3).join('；') || '未知错误'}`,
    );
  }
  return result.scene;
}

import { resolveTarget } from './targets.mjs';
/**
 * IMStage Agent — request validation.
 *
 * Pure validation for `POST /api/agent/run`. Returns a result object instead of
 * throwing so the HTTP layer can map failures onto its own `HttpError` shape and
 * tests can exercise the bounds directly.
 */

import { validateScene } from '../../apps/web/src/studio/model.ts';
import {
  AGENT_MAX_ATTACHMENTS,
  AGENT_MAX_ATTACHMENT_CHARS,
  AGENT_MAX_ATTACHMENT_TOTAL_CHARS,
  AGENT_MAX_HISTORY,
  AGENT_MAX_HISTORY_CHARS,
  AGENT_MAX_PROMPT_CHARS,
} from './config.mjs';
import { isBoundedImageDataUrl } from './media.mjs';
import { checkSceneLimits } from './scene-context.mjs';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * @param {unknown} body
 * @returns {{ok:true, value:{prompt:string, scene:object, targetId:string|null, attachments:string[], history:Array<{role:string, content:string}>}} | {ok:false, code:string, message:string}}
 */
export function validateAgentInput(body) {
  if (!isPlainObject(body)) return fail('invalid_request', '请求体必须是 JSON 对象');

  const prompt = body.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return fail('invalid_prompt', '请输入修改要求');
  }
  if (prompt.length > AGENT_MAX_PROMPT_CHARS) {
    return fail('invalid_prompt', `修改要求不能超过 ${AGENT_MAX_PROMPT_CHARS} 个字符`);
  }

  const sceneResult = validateScene(body.scene);
  if (!sceneResult.ok || !sceneResult.scene) {
    const detail = sceneResult.errors.slice(0, 3).join('；');
    return fail('invalid_scene', detail ? `场景数据无效：${detail}` : '场景数据无效');
  }
  const scene = sceneResult.scene;
  // Reject a scene that is too large before any model context is built.
  const limitError = checkSceneLimits(scene);
  if (limitError) {
    return fail('invalid_scene', `场景过大：${limitError}`);
  }

  let targetId = null;
  if (body.targetId !== undefined && body.targetId !== null) {
    if (typeof body.targetId !== 'string' || body.targetId.trim() === '') {
      return fail('invalid_target', 'targetId 必须是非空字符串');
    }
    if (!resolveTarget(scene, body.targetId)) {
      return fail('invalid_target', 'targetId 对应的消息不存在');
    }
    targetId = body.targetId;
  }

  let attachments = [];
  if (body.attachments !== undefined && body.attachments !== null) {
    if (!Array.isArray(body.attachments)) {
      return fail('invalid_attachments', 'attachments 必须是数组');
    }
    if (body.attachments.length > AGENT_MAX_ATTACHMENTS) {
      return fail('invalid_attachments', `最多只能提供 ${AGENT_MAX_ATTACHMENTS} 张附件图片`);
    }
    let total = 0;
    for (const item of body.attachments) {
      if (!isBoundedImageDataUrl(item, AGENT_MAX_ATTACHMENT_CHARS)) {
        return fail('invalid_attachments', '附件必须是不超过 6MB 的 PNG/JPEG/WebP 内联图片');
      }
      total += item.length;
    }
    if (total > AGENT_MAX_ATTACHMENT_TOTAL_CHARS) {
      return fail('invalid_attachments', '附件总大小超出限制');
    }
    attachments = body.attachments.slice();
  }

  let history = [];
  if (body.history !== undefined && body.history !== null) {
    if (!Array.isArray(body.history)) {
      return fail('invalid_history', 'history 必须是数组');
    }
    if (body.history.length > AGENT_MAX_HISTORY) {
      return fail('invalid_history', `history 最多只能有 ${AGENT_MAX_HISTORY} 条`);
    }
    for (const item of body.history) {
      if (!isPlainObject(item)) return fail('invalid_history', 'history 的每一项必须是对象');
      if (item.role !== 'user' && item.role !== 'assistant') {
        return fail('invalid_history', 'history 的 role 只能是 user 或 assistant');
      }
      if (typeof item.content !== 'string' || item.content.length > AGENT_MAX_HISTORY_CHARS) {
        return fail('invalid_history', `history 的 content 必须是不超过 ${AGENT_MAX_HISTORY_CHARS} 字符的字符串`);
      }
      history.push({ role: item.role, content: item.content });
    }
  }

  return { ok: true, value: { prompt: prompt.trim(), scene, targetId, attachments, history } };
}

import { resolveTarget } from './targets.mjs';
/**
 * IMStage Agent — scene context + invariant helpers.
 *
 * Existing assets are never echoed to the model as base64. They are replaced by
 * explicit presence markers in the context sent to the provider, while the real
 * bytes stay server-side and are preserved across mutations keyed by id.
 */

import {
  AGENT_MAX_SCENE_DATE_CHARS,
  AGENT_MAX_SCENE_ID_CHARS,
  AGENT_MAX_SCENE_MESSAGES,
  AGENT_MAX_SCENE_NAME_CHARS,
  AGENT_MAX_SCENE_PARTICIPANTS,
  AGENT_MAX_SCENE_TEXT_CHARS,
  AGENT_MAX_SCENE_TIME_CHARS,
  AGENT_MAX_SCENE_TITLE_CHARS,
  AGENT_MAX_SCENE_WATERMARK_CHARS,
} from './config.mjs';

export const ASSET_MARKER = '<已有图片：服务端保留，勿修改>';
export const AVATAR_MARKER = '<已有头像：服务端保留，勿修改>';

/** Per-message text cap inside the model context (not the scene limit). */
const MESSAGE_CONTEXT_TEXT_CHARS = 2000;
const PARTICIPANT_CONTEXT_NAME_CHARS = 120;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value, max) {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function markMessage(message) {
  const marked = {
    id: message.id,
    participantId: message.participantId,
    type: message.type,
    text: truncate(message.text, MESSAGE_CONTEXT_TEXT_CHARS),
    time: message.time, date: message.date,
    subtitle: truncate(message.subtitle,400), quote: truncate(message.quote,800), width: message.width, height: message.height, appearance: message.appearance,
    items: message.items?.map(item => ({...item, caption:truncate(item.caption,200), asset: item.asset ? ASSET_MARKER : undefined})),
  };
  if (message.asset) marked.asset = ASSET_MARKER;
  return marked;
}

function markParticipant(participant) {
  const marked = { id: participant.id, name: truncate(participant.name, PARTICIPANT_CONTEXT_NAME_CHARS) };
  if (participant.avatar) marked.avatar = AVATAR_MARKER;
  return marked;
}

/**
 * Compact, size-bounded JSON view of a scene for the model.
 *
 * O(n) in the number of messages: every message is serialized once, then the
 * trailing messages that fit the budget are joined; there is no repeated
 * slice + stringify. `targetId` (targeted editing) is always preserved, even
 * when the scene must be truncated and the target is early in the list.
 *
 * @param {object} scene
 * @param {number} maxChars
 * @param {string|null} [targetId]
 * @returns {{text:string, truncated:boolean}}
 */
export function buildSceneContext(scene, maxChars, targetId = null) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 48 * 1024;
  const head = {
    id: scene.id,
    title: truncate(scene.title, AGENT_MAX_SCENE_TITLE_CHARS),
    platform: scene.platform,
    surface: scene.surface, background: scene.background, backgroundImage: scene.backgroundImage ? ASSET_MARKER : undefined, appearance: scene.appearance, headerText: truncate(scene.headerText,400), composerText: truncate(scene.composerText,200), battery: scene.battery,
    deviceTime: truncate(scene.deviceTime, AGENT_MAX_SCENE_TIME_CHARS),
    date: truncate(scene.date, AGENT_MAX_SCENE_DATE_CHARS), referenceDate: scene.referenceDate,
    selfId: scene.selfId,
    watermark: truncate(scene.watermark, AGENT_MAX_SCENE_WATERMARK_CHARS),
    participants: scene.participants.map(markParticipant),
  };

  const marked = scene.messages.map(markMessage);
  const parts = marked.map((message) => JSON.stringify(message));
  const prefix = `${JSON.stringify(head).slice(0, -1)},"messages":[`;
  const suffix = ']}';
  const budget = Math.max(0, limit - prefix.length - suffix.length);
  const build = (indices) => `${prefix}${indices.map((index) => parts[index]).join(',')}${suffix}`;

  // Accumulate from the end; each added element costs its JSON plus one comma.
  const selectFromEnd = (indices, maxCost) => {
    const picked = [];
    let used = 0;
    for (let cursor = indices.length - 1; cursor >= 0; cursor -= 1) {
      const index = indices[cursor];
      const cost = parts[index].length + (picked.length > 0 ? 1 : 0);
      if (used + cost > maxCost) break;
      picked.push(index);
      used += cost;
    }
    picked.reverse();
    return picked;
  };

  const allIndices = marked.map((_message, index) => index);
  const targetIndex = targetId ? marked.findIndex((message) => message.id === targetId) : -1;

  let selected;
  if (targetIndex !== -1) {
    const rest = allIndices.filter((index) => index !== targetIndex);
    // Reserve the target plus the comma that joins it to the selected rest.
    const restBudget = Math.max(0, budget - parts[targetIndex].length - 1);
    selected = [...selectFromEnd(rest, restBudget), targetIndex].sort((a, b) => a - b);
  } else {
    selected = selectFromEnd(allIndices, budget);
  }

  let truncated = selected.length < marked.length;
  let text = build(selected);
  if (text.length > limit) {
    // Only reachable when the required target alone exceeds the budget.
    const m = targetIndex !== -1 ? marked[targetIndex] : null;
    const minimal = {id:scene.id,messages:m?[{id:m.id,type:m.type,participantId:m.participantId,text:''}]:[],truncated:true};
    if(m) minimal.messages[0].text = m.text.slice(0, Math.max(0,limit-JSON.stringify(minimal).length-16));
    text = JSON.stringify(minimal);
    if(text.length>limit) text = JSON.stringify({targetId,truncated:true});
    if(text.length>limit) text = '{}';
    truncated = true;
  }
  return { text, truncated };
}

function shortId(value) {
  const text = typeof value === 'string' ? value : '';
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * Explicit scene resource limits, applied to the incoming scene and to every
 * proposed mutation. Returns a Chinese reason, or `null` when within bounds.
 */
export function checkSceneLimits(scene) {
  if (!isPlainObject(scene)) return '场景数据无效';
  const messages = Array.isArray(scene.messages) ? scene.messages : [];
  const participants = Array.isArray(scene.participants) ? scene.participants : [];
  const albumChars = messages.reduce((n,m) => n + (m.items || []).reduce((s,i) => s + (i.asset?.length || 0),0),0);
  const referenceChars = (scene.reference?.source?.length || 0) + (scene.reference?.assets || []).reduce((n,a)=>n+a.dataUrl.length,0);
  const assetChars = referenceChars + (scene.backgroundImage?.length || 0) + albumChars + messages.reduce((n,m) => n + (typeof m?.asset === 'string' ? m.asset.length : 0), 0) + participants.reduce((n,p) => n + (typeof p?.avatar === 'string' ? p.avatar.length : 0), 0);
  if (assetChars > 12 * 1024 * 1024) return '图片素材总大小超过 12 MB，请减少图片';

  if (messages.length > AGENT_MAX_SCENE_MESSAGES) {
    return `消息数量超过上限（${AGENT_MAX_SCENE_MESSAGES} 条）`;
  }
  if (participants.length > AGENT_MAX_SCENE_PARTICIPANTS) {
    return `参与者数量超过上限（${AGENT_MAX_SCENE_PARTICIPANTS} 个）`;
  }
  if (typeof scene.id === 'string' && scene.id.length > AGENT_MAX_SCENE_ID_CHARS) return '场景 id 过长';
  if (typeof scene.title === 'string' && scene.title.length > AGENT_MAX_SCENE_TITLE_CHARS) return '标题过长';
  if (typeof scene.date === 'string' && scene.date.length > AGENT_MAX_SCENE_DATE_CHARS) return '日期过长';
  if (typeof scene.deviceTime === 'string' && scene.deviceTime.length > AGENT_MAX_SCENE_TIME_CHARS) return '设备时间过长';
  if (typeof scene.watermark === 'string' && scene.watermark.length > AGENT_MAX_SCENE_WATERMARK_CHARS) return '水印过长';

  for (const participant of participants) {
    if (!isPlainObject(participant)) continue;
    if (typeof participant.id === 'string' && participant.id.length > AGENT_MAX_SCENE_ID_CHARS) {
      return `参与者 id 过长：${shortId(participant.id)}`;
    }
    if (typeof participant.name === 'string' && participant.name.length > AGENT_MAX_SCENE_NAME_CHARS) {
      return `参与者名称过长：${shortId(participant.name)}`;
    }
  }
  for (const message of messages) {
    if (!isPlainObject(message)) continue;
    if (typeof message.id === 'string' && message.id.length > AGENT_MAX_SCENE_ID_CHARS) {
      return `消息 id 过长：${shortId(message.id)}`;
    }
    if (typeof message.text === 'string' && message.text.length > AGENT_MAX_SCENE_TEXT_CHARS) {
      return `消息文本超过 ${AGENT_MAX_SCENE_TEXT_CHARS} 字：${shortId(message.id)}`;
    }
  }
  return null;
}

/**
 * Remove any model-supplied `asset`/`avatar` before validation. Models must not
 * smuggle base64 (or markers) into the scene; real bytes are re-attached from
 * the current scene by id.
 */
export function stripSceneAssets(sceneLike) {
  if (!isPlainObject(sceneLike)) return sceneLike;
  const copied = { ...sceneLike };
  delete copied.backgroundImage;
  delete copied.reference;
  if (Array.isArray(copied.messages)) {
    copied.messages = copied.messages.map((message) => {
      if (!isPlainObject(message)) return message;
      const next = { ...message };
      delete next.asset;
      if (Array.isArray(next.items)) next.items = next.items.map(item => {if (!isPlainObject(item)) return item; const {asset,...rest}=item; return rest;});
      return next;
    });
  }
  if (Array.isArray(copied.participants)) {
    copied.participants = copied.participants.map((participant) => {
      if (!isPlainObject(participant)) return participant;
      const next = { ...participant };
      delete next.avatar;
      return next;
    });
  }
  return copied;
}

/** Re-attach existing assets by id so a model rewrite cannot drop user data. */
export function preserveAssetsById(nextScene, currentScene) {
  const currentMessages = new Map(currentScene.messages.map((message) => [message.id, message]));
  const currentParticipants = new Map(
    currentScene.participants.map((participant) => [participant.id, participant]),
  );
  return {
    ...nextScene,
    ...(currentScene.reference ? {reference:currentScene.reference} : {}),
    ...(currentScene.backgroundImage ? {backgroundImage:currentScene.backgroundImage} : {}),
    messages: nextScene.messages.map((message) => {
      const existing = currentMessages.get(message.id);
      if (message.items) message = {...message, items:message.items.map(item => { const old = existing?.items?.find(i => i.id === item.id); return old?.asset ? {...item,asset:old.asset} : item; })};
      if (existing?.asset && !message.asset) return { ...message, asset: existing.asset };
      return message;
    }),
    participants: nextScene.participants.map((participant) => {
      const existing = currentParticipants.get(participant.id);
      if (existing?.avatar && !participant.avatar) {
        return { ...participant, avatar: existing.avatar };
      }
      return participant;
    }),
  };
}

const METADATA_KEYS = ['title', 'platform', 'deviceTime', 'date', 'selfId', 'watermark'];

/**
 * Enforce the targeted-edit contract: only message `targetId` may differ.
 * Returns a human-readable reason, or `null` when the invariant holds.
 */
export function targetedChangeViolation(before, after, targetId) {
  const target = resolveTarget(before, targetId);
  if (!target) return '定向编辑目标不存在';
  const a = structuredClone(before), b = structuredClone(after);
  if (target.kind === 'scene') {
    for (const key of ['title','platform','deviceTime','date','watermark','surface','background','backgroundImage','appearance','headerText','composerText','battery']) { delete a[key]; delete b[key]; }
  } else if (target.kind === 'participant') {
    const next = b.participants.find(p => p.id === target.id);
    if (!next) return '定向编辑不能删除参与者';
    b.participants = b.participants.map(p => p.id === target.id ? a.participants.find(p => p.id === target.id) : p);
  } else {
    if (a.messages.length !== b.messages.length) return '定向编辑不能新增或删除消息';
    const index = a.messages.findIndex(m => m.id === target.id);
    if (b.messages[index]?.id !== target.id) return '定向编辑不能改变消息顺序或 id';
    b.messages[index] = a.messages[index];
  }
  return JSON.stringify(a) === JSON.stringify(b) ? null : '定向编辑不能修改其他元素、消息或参与者';
}

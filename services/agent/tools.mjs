import { resolveTarget } from './targets.mjs';
/**
 * IMStage Agent — scene tools.
 *
 * The model may only mutate the scene through these four bounded tools. There
 * is no shell, no arbitrary URL fetch and no network tool. Every mutation is
 * validated with the shared canonical `validateScene`; the scene id is always
 * preserved and a no-op is reported as a failure, never as success.
 */

import { assertDecodableImage } from './image-decode.mjs';
import { validateScene } from '../../apps/web/src/studio/model.ts';
import { AGENT_MAX_IMAGE_PROMPT_CHARS } from './config.mjs';
import { isBoundedImageDataUrl } from './media.mjs';
import { isAbortError } from './providers.mjs';
import {
  checkSceneLimits,
  preserveAssetsById,
  stripSceneAssets,
  targetedChangeViolation,
} from './scene-context.mjs';

export const TOOL_NAMES = Object.freeze([
  'update_element',
  'create_scene',
  'upsert_message',
  'delete_message',
  'generate_image',
]);

export const RUNNING_DETAILS = Object.freeze({
  update_element: '正在调整元素…',
  create_scene: '正在重建场景…',
  upsert_message: '正在更新消息…',
  delete_message: '正在删除消息…',
  generate_image: '正在生成图片…',
});

export const AGENT_TOOL_SCHEMAS = Object.freeze([
  {type:'function', function:{name:'update_element',description:'调整场景设置或参与者。targetId 为 @scene 或 @participant:参与者id。patch 是要修改的字段，禁止提供图片数据。场景支持 surface,background,appearance,headerText,composerText,battery,title,date,deviceTime,platform；参与者支持name,subtitle。',parameters:{type:'object',properties:{targetId:{type:'string'},patch:{type:'object'}},required:['targetId','patch'],additionalProperties:false}}},
  {
    type: 'function',
    function: {
      name: 'create_scene',
      description:
        '用一段完整的 Scene JSON 重建整个场景。适合从零创建场景或大范围重写。必须保留当前场景的 id；不要提供图片 base64，已有图片由服务端按消息/参与者 id 自动保留。',
      parameters: {
        type: 'object',
        properties: {
          scene: {
            type: 'object',
            description:
              '完整 Scene 对象，字段：id,title,platform,deviceTime,date,selfId,participants[],messages[],watermark。platform 只能是 wechat/xiaohongshu/imessage/whatsapp/slack/instagram；message.type 只能是 text/image/location/system/contact/transfer/voice/video/link/album。可选surface(ios/android/desktop),background(#RRGGBB),appearance(fontSize,color,background,radius,spacing),headerText,composerText,battery；消息可选subtitle,quote,width,height,appearance,items[{id,kind:image|video,caption}]。',
          },
        },
        required: ['scene'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_message',
      description:
        '新增或修改一条消息。message.id 已存在时原地更新，否则追加到末尾。不要提供 asset 图片数据，已有图片由服务端保留。',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'object',
            description:
              'Message 对象：id,participantId,type,text,time；type 为 system 时 participantId 用空字符串。',
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_message',
      description: '按 id 删除一条消息。定向编辑时不允许删除。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '要删除的消息 id' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        '为一个图片消息或某个参与者头像生成真实图片。kind 为 message 时 targetId 是消息 id；kind 为 avatar 时 targetId 是参与者 id。仅当用户要求图片或场景明显需要图片时调用。',
      parameters: {
        type: 'object',
        properties: {
          targetId: { type: 'string', description: '消息 id 或参与者 id' },
          kind: { type: 'string', enum: ['message', 'avatar', 'background'], description: '生成目标类型' },
          prompt: { type: 'string', description: '用于图片生成的中文描述' },
          edit: {type:'boolean',description:'true 表示将现有图片作为参考调用图片编辑 API，而非重新生成'},
          itemId:{type:'string',description:'相册子图片 id；目标为 album 时必填'},
        },
        required: ['targetId', 'kind', 'prompt'],
        additionalProperties: false,
      },
    },
  },
]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(context, detail) {
  return {
    ok: false,
    scene: context.scene,
    detail,
    result: { ok: false, error: detail },
  };
}

function sameScene(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Validate a candidate scene and enforce id preservation, no-op detection and
 * (for targeted runs) the selected-only invariant.
 */
function buildCandidate(context, candidate, detail) {
  const validation = validateScene(candidate);
  if (!validation.ok || !validation.scene) {
    const errors = validation.errors.slice(0, 3).join('；');
    return fail(context, `场景校验失败：${errors || '数据无效'}`);
  }
  const next = validation.scene;
  next.id = context.scene.id;
  const limitError = checkSceneLimits(next);
  if (limitError) return fail(context, `场景超出限制：${limitError}`);
  if (sameScene(next, context.scene)) {
    return fail(context, '没有实际修改，请提供新的内容');
  }
  if (context.targetId) {
    const violation = targetedChangeViolation(context.scene, next, context.targetId);
    if (violation) return fail(context, violation);
  }
  return {
    ok: true,
    scene: next,
    detail,
    result: {
      ok: true,
      message: detail,
      sceneId: next.id,
      messageCount: next.messages.length,
    },
  };
}

function applyCreateScene(args, context) {
  if (context.targetId) return fail(context, '定向编辑不允许替换整个场景');
  if (!isPlainObject(args?.scene)) return fail(context, '参数 scene 必须是对象');
  const stripped = stripSceneAssets(args.scene);
  const validation = validateScene(stripped);
  if (!validation.ok || !validation.scene) {
    const errors = validation.errors.slice(0, 3).join('；');
    return fail(context, `场景数据无效：${errors || '数据无效'}`);
  }
  const preserved = preserveAssetsById(validation.scene, context.scene);
  return buildCandidate(context, preserved, '场景已重建');
}

function applyUpsertMessage(args, context) {
  const input = args?.message;
  if (!isPlainObject(input)) return fail(context, '参数 message 必须是对象');
  const id = input.id;
  if (typeof id !== 'string' || id.trim() === '') {
    return fail(context, 'message.id 必须是非空字符串');
  }
  if (context.targetId && id !== context.targetId) {
    return fail(context, `定向编辑只能修改所选消息：${context.targetId}`);
  }
  const existing = context.scene.messages.find((message) => message.id === id);
  if (context.targetId && !existing) return fail(context, `找不到消息：${id}`);
  const sanitized = { ...input };
  delete sanitized.asset;
  if (Array.isArray(sanitized.items)) sanitized.items = sanitized.items.map(raw => { if (!isPlainObject(raw)) return raw; const {asset,...item}=raw; const old = existing?.items?.find(i => i.id === item.id); return old?.asset ? {...item,asset:old.asset} : item; });
  if (existing?.asset) sanitized.asset = existing.asset;
  const messages = existing
    ? context.scene.messages.map((message) => (message.id === id ? sanitized : message))
    : [...context.scene.messages, sanitized];
  return buildCandidate(
    context,
    { ...context.scene, messages },
    existing ? `消息 ${id} 已更新` : `已新增消息 ${id}`,
  );
}

function applyDeleteMessage(args, context) {
  if (context.targetId) return fail(context, '定向编辑不允许删除消息');
  const id = args?.id;
  if (typeof id !== 'string' || id.trim() === '') {
    return fail(context, 'id 必须是非空字符串');
  }
  if (!context.scene.messages.some((message) => message.id === id)) {
    return fail(context, `找不到消息：${id}`);
  }
  const messages = context.scene.messages.filter((message) => message.id !== id);
  return buildCandidate(context, { ...context.scene, messages }, `消息 ${id} 已删除`);
}

async function applyGenerateImage(args, context) {
  const kind = args?.kind;
  if (!['message','avatar','background'].includes(kind)) {
    return fail(context, 'kind 必须是 message 或 avatar');
  }
  const targetId = args?.targetId;
  if (typeof targetId !== 'string' || targetId.trim() === '') {
    return fail(context, 'targetId 必须是非空字符串');
  }
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  if (prompt === '') return fail(context, 'prompt 必须是非空字符串');
  if (prompt.length > AGENT_MAX_IMAGE_PROMPT_CHARS) {
    return fail(context, `prompt 不能超过 ${AGENT_MAX_IMAGE_PROMPT_CHARS} 个字符`);
  }

  if (kind === 'message') {
    const target = context.scene.messages.find((message) => message.id === targetId);
    if (!target) return fail(context, `找不到消息：${targetId}`);
    if (context.targetId && targetId !== context.targetId) {
      return fail(context, `定向编辑只能为所选消息生成图片：${context.targetId}`);
    }
    if (!['image','video','album','contact','location','link'].includes(target.type)) {
      return fail(
        context,
        `消息 ${targetId} 的类型是 ${target.type}，图片只能放在 type=image 的消息上；请先用 upsert_message 把该消息改为 type=image，再调用 generate_image。`,
      );
    }
  } else if (kind === 'avatar') {
    if (context.targetId && context.targetId !== `@participant:${targetId}`) return fail(context, '定向编辑不允许修改头像：只能修改选中人物');
    if (!context.scene.participants.some((participant) => participant.id === targetId)) {
      return fail(context, `找不到参与者：${targetId}`);
    }
  }

  if (kind === 'background' && context.targetId && context.targetId !== '@scene') return fail(context,'定向编辑不允许修改背景');
  const target = context.scene.messages.find(m => m.id === targetId);
  if (kind === 'message' && target?.type === 'album' && !target.items?.some(i => i.id === args.itemId)) return fail(context,'请指定相册中的 itemId');
  const referenceImage = kind === 'background' ? context.scene.backgroundImage : kind === 'avatar' ? context.scene.participants.find(p => p.id === targetId)?.avatar : target?.type === 'album' ? target.items.find(i => i.id === args.itemId)?.asset : target?.asset;
  if (args.edit && !referenceImage) return fail(context,'所选元素还没有图片，无法基于原图修改，请先生成或上传');
  if (!context.imageProvider) return {...fail(context,'图片生成服务未配置，无法生成图片。已保留部分结果。'),dependencyFailure:true};

  let generated;
  try {
    generated = await context.imageProvider.generate({ prompt, signal: context.signal, ...(args.edit ? {referenceImage} : {}) });
    await assertDecodableImage(generated?.dataUrl, context.signal);
  } catch (error) {
    // Cancellation must abort the whole run, not become a tool result that
    // lets a later call in the same batch mutate the scene.
    if (isAbortError(error) || context.signal?.aborted) {
      if (isAbortError(error)) throw error;
      const abort = new Error('请求已取消');
      abort.name = 'AbortError';
      throw abort;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {...fail(context, `图片生成失败：${message}`),dependencyFailure:true};
  }
  if (!isBoundedImageDataUrl(generated?.dataUrl, context.maxAttachmentChars)) {
    return {...fail(context, '图片生成返回的数据无效或超出大小限制'),dependencyFailure:true};
  }
  const dataUrl = generated.dataUrl;
  if (kind === 'background') return buildCandidate(context,{...context.scene,backgroundImage:dataUrl},'背景图片已更新');
  if (kind === 'message') {
    const messages = context.scene.messages.map((message) =>
      message.id === targetId ? (message.type === 'album' ? {...message,items:message.items.map(i => i.id === args.itemId ? {...i,asset:dataUrl} : i)} : { ...message, asset: dataUrl }) : message,
    );
    return buildCandidate(context, { ...context.scene, messages }, `已为消息 ${targetId} 生成图片`);
  }
  const participants = context.scene.participants.map((participant) =>
    participant.id === targetId ? { ...participant, avatar: dataUrl } : participant,
  );
  return buildCandidate(context, { ...context.scene, participants }, `已为参与者 ${targetId} 生成头像`);
}

/** Parse the model-provided tool arguments. */
export function parseToolArguments(raw) {
  if (isPlainObject(raw)) return { ok: true, value: raw };
  if (typeof raw !== 'string') return { ok: false, error: '工具参数必须是 JSON 字符串' };
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return { ok: false, error: '工具参数必须是 JSON 对象' };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: '工具参数不是合法 JSON' };
  }
}

/**
 * Execute one tool call against the current scene.
 *
 * @returns {Promise<{ok:boolean, scene:object, detail:string, result:object}>}
 */
export async function executeTool(name, args, context) {
  const ctx = {
    scene: context.scene,
    targetId: context.targetId ?? null,
    imageProvider: context.imageProvider ?? null,
    signal: context.signal,
    maxAttachmentChars: context.maxAttachmentChars,
  };
  switch (name) {
    case 'update_element': {
      const target = resolveTarget(ctx.scene,args.targetId);
      if (!target || target.kind === 'message' || !isPlainObject(args.patch)) return fail(ctx,'元素或 patch 无效');
      if (ctx.targetId && ctx.targetId !== args.targetId) return fail(ctx,'只能调整所选元素');
      const allowed = target.kind === 'scene' ? ['title','platform','deviceTime','date','watermark','surface','background','appearance','headerText','composerText','battery'] : ['name','subtitle'];
      if (Object.keys(args.patch).some(k => !allowed.includes(k))) return fail(ctx,'patch 包含不允许的字段');
      return buildCandidate(ctx,target.kind === 'scene' ? {...ctx.scene,...args.patch} : {...ctx.scene,participants:ctx.scene.participants.map(p => p.id === target.id ? {...p,...args.patch} : p)},'元素已更新');
    }
    case 'create_scene':
      return applyCreateScene(args, ctx);
    case 'upsert_message':
      return applyUpsertMessage(args, ctx);
    case 'delete_message':
      return applyDeleteMessage(args, ctx);
    case 'generate_image':
      return applyGenerateImage(args, ctx);
    default:
      return fail(ctx, `未知的工具：${typeof name === 'string' ? name : ''}`);
  }
}

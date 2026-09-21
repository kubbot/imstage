/**
 * IMStage Agent — bounded tool-calling loop.
 *
 * The loop is deliberately provider-agnostic: `provider` and `imageProvider`
 * are injected, which lets tests prove the real multi-round sequence, invalid
 * tool feedback/recovery, selected-only invariants and failure semantics without
 * any paid call.
 *
 * Contract highlights:
 *   - one model round per assistant turn, at most `maxRounds` rounds,
 *   - at most `maxCalls` tool calls, every real tool result fed back,
 *   - a wall deadline plus client cancellation,
 *   - `done` is only emitted after at least one real, validated mutation.
 */

import {
  AGENT_DEADLINE_MS,
  AGENT_MAX_ATTACHMENT_CHARS,
  AGENT_MAX_ROUNDS,
  AGENT_MAX_TOOL_CALLS,
  AGENT_MAX_TOOL_DETAIL_CHARS,
} from './config.mjs';
import { AGENT_TOOL_SCHEMAS, RUNNING_DETAILS, executeTool, parseToolArguments } from './tools.mjs';
import { buildInitialMessages } from './prompt.mjs';
import { buildObservationParts } from './observation.mjs';
import { isAbortError } from './providers.mjs';
import { finishReasonMessage, isAcceptedFinishReason } from './finish.mjs';

function clampDetail(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > AGENT_MAX_TOOL_DETAIL_CHARS
    ? `${text.slice(0, AGENT_MAX_TOOL_DETAIL_CHARS - 1)}…`
    : text;
}

function safeMessage(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim() !== '') {
    return clampDetail(error.message);
  }
  return '生成过程中出现未知错误';
}

function abortError() {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function normalizeToolCalls(rawCalls, sequence) {
  const list = Array.isArray(rawCalls) ? rawCalls : [];
  return list.map((call, index) => ({
    id:
      typeof call?.id === 'string' && call.id !== ''
        ? call.id
        : `call_${sequence + index + 1}`,
    name: typeof call?.name === 'string' ? call.name : '',
    arguments: call?.arguments,
  }));
}

async function safeEmit(emit, event) {
  try {
    await emit(event);
    return true;
  } catch {
    return false;
  }
}

/**
 * Emit a verified terminal success.
 *
 * Assistant completion prose is buffered during the loop and only released
 * here, immediately before `done`, so a failed/incomplete run can never emit a
 * completion claim that was not actually verified.
 */
async function finishSuccess({ emit, pendingAssistantText, scene, mutations }) {
  if (typeof pendingAssistantText === 'string' && pendingAssistantText !== '') {
    await emit({ type: 'assistant', text: pendingAssistantText });
  }
  await emit({ type: 'done' });
  return { ok: true, scene, mutations };
}

/**
 * @param {object} options
 * @param {string} options.prompt
 * @param {object} options.scene
 * @param {string|null} [options.targetId]
 * @param {string[]} [options.attachments]
 * @param {Array<{role:string,content:string}>} [options.history]
 * @param {object} options.provider
 * @param {object|null} [options.imageProvider]
 * @param {object} [options.config]
 * @param {AbortSignal} [options.signal]
 * @param {(event:object) => void|Promise<void>} options.onEvent
 */
export async function runAgent({
  prompt,
  scene: initialScene,
  targetId = null,
  attachments = [],
  history = [],
  provider,
  imageProvider = null,
  config = {},
  signal,
  onEvent,
  toolset = null,
}) {
  if (!provider) throw new Error('runAgent 需要 provider');
  if (typeof onEvent !== 'function') throw new Error('runAgent 需要 onEvent');

  const deadlineMs = config.deadlineMs ?? AGENT_DEADLINE_MS;
  const maxRounds = config.maxRounds ?? AGENT_MAX_ROUNDS;
  const maxCalls = config.maxCalls ?? AGENT_MAX_TOOL_CALLS;
  const maxAttachmentChars = config.maxAttachmentChars ?? AGENT_MAX_ATTACHMENT_CHARS;

  let scene = initialScene;
  let successfulMutations = 0;
  const failedImages = new Set();
  const generatedAssets = new Set();
  const imageFrameBindings = new Map();
  const textFrameBindings = new Map();
  const hasUnusedAssets = () => [...generatedAssets].some(id => scene.reference?.assets?.some(a=>a.id===id) && !scene.reference?.plan?.edits?.some(e => e.kind === 'image' && e.assetId === id));
  let toolCallsUsed = 0;
  let previewedScene = null;
  let sceneRevision = 0;
  let timedOut = false;
  // Completion prose is held back until the run is verified terminal.
  let pendingAssistantText = null;

  const timeoutController = new AbortController();
  const onTimeout = () => {
    timedOut = true;
    timeoutController.abort();
  };
  const timer = setTimeout(onTimeout, deadlineMs);

  const upstreamSignals = [timeoutController.signal];
  if (signal) upstreamSignals.push(signal);
  const combined = AbortSignal.any(upstreamSignals);

  const emit = (event) => Promise.resolve(onEvent(event));

  try {
    await emit({ type: 'scene', scene });

    const messages = (toolset?.buildMessages || buildInitialMessages)({
      prompt,
      scene,
      targetId,
      attachments,
      history,
      maxSceneContextChars: config.maxSceneContextChars,
    });

    for (let round = 1; round <= maxRounds; round += 1) {
      throwIfAborted(combined);
      const response = await provider.complete({
        messages: messages.map((m,index)=>index===0&&typeof m.content==='string'?{...m,content:m.content+`\n执行预算：剩余 ${maxRounds-round+1} 轮、${Math.max(0,maxCalls-toolCallsUsed)} 次工具。根据明确失败项定向修复，避免重复观察同一区域。预留最后一轮验证最新结果并finish，不满足要求不能宣称完成。`}:m),
        tools: toolset?.schemas || AGENT_TOOL_SCHEMAS,
        signal: combined,
      });
      throwIfAborted(combined);

      // An incomplete/refused/unknown turn must fail before we apply it or
      // emit `done`. Injected providers may omit `finishReason` (undefined).
      const finishReason =
        typeof response?.finishReason === 'string' ? response.finishReason : null;
      if (finishReason !== null && !isAcceptedFinishReason(finishReason)) {
        await emit({ type: 'error', message: finishReasonMessage(finishReason) });
        return {
          ok: false,
          scene,
          reason: 'incomplete',
          finishReason,
          mutations: successfulMutations,
        };
      }

      const content = typeof response?.content === 'string' ? response.content.trim() : '';
      const toolCalls = normalizeToolCalls(response?.toolCalls, toolCallsUsed);

      // Buffer completion prose; never emit it before the run is verified.
      pendingAssistantText = content === '' ? null : content;

      if (toolCalls.length === 0) {
        if (successfulMutations === 0) {
          await emit({
            type: 'error',
            message: '模型没有对场景做出实际修改。请用更明确的要求再试一次。',
          });
          return { ok: false, scene, reason: 'no_mutation', mutations: 0 };
        }
        if(toolset && previewedScene!==scene) {await emit({type:'error',message:'最新修改尚未通过渲染预览，任务未完成。'});return {ok:false,scene,reason:'preview_required',mutations:successfulMutations};}
        const missingMedia = !toolset && scene.messages.some(m => ['image','video'].includes(m.type) ? !m.asset : m.type === 'album' ? !m.items?.length || m.items.some(i=>!i.asset) : false);
        if (failedImages.size || missingMedia || hasUnusedAssets()) { await emit({type:'error', message:'图片工具未完成，已保留部分结果。请配置或修复图片服务后重试。'}); return {ok:false,scene,reason:'image_tools_failed',mutations:successfulMutations}; }
        return finishSuccess({ emit, pendingAssistantText, scene, mutations: successfulMutations });
      }

      // A final-round turn is still executed: the model may end with a valid
      // terminal `finish` tool. `maxCalls` and the deadline still bound it.

      messages.push({
        role: 'assistant',
        ...(typeof response.reasoningContent === 'string' ? {reasoning_content:response.reasoningContent} : {}),
        content: typeof response?.content === 'string' ? response.content : '',
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments:
              typeof call.arguments === 'string'
                ? call.arguments
                : JSON.stringify(call.arguments ?? {}),
          },
        })),
      });

      const roundObservationBatches = [];
      for (let callIndex = 0; callIndex < toolCalls.length; callIndex += 1) {
        const call = toolCalls[callIndex];
        toolCallsUsed += 1;
        if (toolCallsUsed > maxCalls) {
          await emit({
            type: 'error',
            message: `工具调用超过上限（${maxCalls} 次），已停止。`,
          });
          return { ok: false, scene, reason: 'max_calls', mutations: successfulMutations };
        }

        // Never start (or continue) a tool after a client/deadline abort.
        throwIfAborted(combined);
        await emit({
          type: 'tool',
          id: call.id,
          name: typeof call.name === 'string' && call.name !== '' ? call.name : 'unknown',
          state: 'running',
          detail: RUNNING_DETAILS[call.name] ?? '正在执行工具…',
        });
        throwIfAborted(combined);

        const parsed = parseToolArguments(call.arguments);
        let outcome = parsed.ok
          ? await (toolset?.execute || executeTool)(call.name, parsed.value, {
              scene,
              targetId,
              imageProvider,
              signal: combined,
              maxAttachmentChars,
              generatedAssetIds: [...generatedAssets],
              imageFrameBindings,
              textFrameBindings,
            })
          : {
              ok: false,
              scene,
              detail: parsed.error,
              result: { ok: false, error: parsed.error },
            };

        // A tool that resolved while the run was aborted must not mutate the
        // scene or emit a terminal/scene event.
        throwIfAborted(combined);

        if (call.name === 'generate_image') { const key = JSON.stringify([parsed.value?.kind, parsed.value?.targetId, parsed.value?.itemId,parsed.value?.assetId]); if (outcome.ok) {failedImages.delete(key);if(scene.reference&&parsed.value?.replacesFailedAssetId&&outcome.result?.assetId)failedImages.delete(JSON.stringify([undefined,undefined,undefined,parsed.value.replacesFailedAssetId]));} else if (outcome.dependencyFailure) failedImages.add(key); }
        if (call.name === 'generate_image' && outcome.ok && scene.reference && outcome.result?.assetId) generatedAssets.add(outcome.result.assetId);
        const sceneChanged = outcome.ok && outcome.scene !== scene;
        if (outcome.ok) {
          scene = outcome.scene;
          if (outcome.mutated !== false) successfulMutations += 1;
          if (outcome.mutated !== false || sceneChanged) sceneRevision += 1;
          if (outcome.images?.length) {
            roundObservationBatches.push({
              images: outcome.images,
              result: outcome.result && typeof outcome.result === 'object' ? outcome.result : {},
              toolName: call.name,
              sceneRevision,
            });
          }
        }

        if(outcome.terminal && (successfulMutations===0 || failedImages.size || hasUnusedAssets() || previewedScene!==scene)){
          const imageRecovery=scene.reference?'图片请求失败，必须重试成功；新ID替代时传replacesFailedAssetId':'图片请求失败，必须对相同kind、targetId和itemId重试成功';
          const missing=[...(successfulMutations===0?['尚无实际修改']:[]),...(failedImages.size?[imageRecovery]:[]),...(hasUnusedAssets()?['生成素材尚未放入画面，可放入或delete_assets删除弃用素材']:[]),...(previewedScene!==scene?['需要render_preview确认最新有效画面']:[])];
          outcome={...outcome,ok:false,detail:missing.join('；'),result:{ok:false,missing,failedImageRequests:[...failedImages].map(k=>JSON.parse(k))}};
        }
        await emit({
          type: 'tool',
          id: call.id,
          name: typeof call.name === 'string' && call.name !== '' ? call.name : 'unknown',
          state: outcome.ok ? 'done' : 'error',
          detail: outcome.detail,
        });

        if (call.name === 'render_preview') previewedScene = outcome.ok && outcome.previewValid !== false ? scene : null;
        if (outcome.ok && (outcome.mutated !== false || sceneChanged)) await emit({ type: 'scene', scene });

        let resultText;
        try {
          resultText = JSON.stringify(outcome.result);
        } catch {
          resultText = JSON.stringify({ ok: false, error: '工具结果序列化失败' });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });

        // Only a terminal finish that is the LAST call in the batch, after a
        // real mutation and a preview of the latest scene, may complete the run.
        const isLastCall = callIndex === toolCalls.length - 1;
        if (isLastCall && outcome.ok && outcome.terminal && successfulMutations > 0 && !failedImages.size && !hasUnusedAssets() && previewedScene === scene) {
          return finishSuccess({ emit, pendingAssistantText, scene, mutations: successfulMutations });
        }
      }
      if (roundObservationBatches.length) {
        messages.push({ role: 'user', content: buildObservationParts(roundObservationBatches) });
      }
    }

    // The loop exhausted maxRounds without a verified terminal finish.
    await emit({
      type: 'error',
      message: `模型在 ${maxRounds} 轮内没有给出最终答复，已停止。`,
    });
    return { ok: false, scene, reason: 'max_rounds', mutations: successfulMutations };
  } catch (error) {
    if (isAbortError(error) || combined.aborted) {
      if (timedOut) {
        await safeEmit(emit, {
          type: 'error',
          message: `生成超过 ${Math.max(1, Math.ceil(deadlineMs / 1000))} 秒上限，已停止。`,
        });
        return { ok: false, scene, reason: 'timeout', mutations: successfulMutations };
      }
      return { ok: false, scene, reason: 'aborted', aborted: true, mutations: successfulMutations };
    }
    const message = safeMessage(error);
    await safeEmit(emit, { type: 'error', message });
    return { ok: false, scene, reason: 'error', error: message, mutations: successfulMutations };
  } finally {
    clearTimeout(timer);
  }

  // Unreachable: every loop exit returns. Defensive fallback.
  return { ok: false, scene, reason: 'error', mutations: successfulMutations };
}

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
}) {
  if (!provider) throw new Error('runAgent 需要 provider');
  if (typeof onEvent !== 'function') throw new Error('runAgent 需要 onEvent');

  const deadlineMs = config.deadlineMs ?? AGENT_DEADLINE_MS;
  const maxRounds = config.maxRounds ?? AGENT_MAX_ROUNDS;
  const maxCalls = config.maxCalls ?? AGENT_MAX_TOOL_CALLS;
  const maxAttachmentChars = config.maxAttachmentChars ?? AGENT_MAX_ATTACHMENT_CHARS;

  let scene = initialScene;
  let successfulMutations = 0;
  let toolCallsUsed = 0;
  let timedOut = false;

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

    const messages = buildInitialMessages({
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
        messages,
        tools: AGENT_TOOL_SCHEMAS,
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

      if (content !== '') await emit({ type: 'assistant', text: content });

      if (toolCalls.length === 0) {
        if (successfulMutations === 0) {
          await emit({
            type: 'error',
            message: '模型没有对场景做出实际修改。请用更明确的要求再试一次。',
          });
          return { ok: false, scene, reason: 'no_mutation', mutations: 0 };
        }
        await emit({ type: 'done' });
        return { ok: true, scene, mutations: successfulMutations };
      }

      if (round === maxRounds) {
        await emit({
          type: 'error',
          message: `模型在 ${maxRounds} 轮内没有给出最终答复，已停止。`,
        });
        return { ok: false, scene, reason: 'max_rounds', mutations: successfulMutations };
      }

      messages.push({
        role: 'assistant',
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

      for (const call of toolCalls) {
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
        const outcome = parsed.ok
          ? await executeTool(call.name, parsed.value, {
              scene,
              targetId,
              imageProvider,
              signal: combined,
              maxAttachmentChars,
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

        if (outcome.ok) {
          scene = outcome.scene;
          successfulMutations += 1;
        }

        await emit({
          type: 'tool',
          id: call.id,
          name: typeof call.name === 'string' && call.name !== '' ? call.name : 'unknown',
          state: outcome.ok ? 'done' : 'error',
          detail: outcome.detail,
        });

        if (outcome.ok) await emit({ type: 'scene', scene });

        let resultText;
        try {
          resultText = JSON.stringify(outcome.result);
        } catch {
          resultText = JSON.stringify({ ok: false, error: '工具结果序列化失败' });
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
      }
    }
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

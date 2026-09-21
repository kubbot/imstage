/**
 * IMStage Agent — provider clients.
 *
 * Both clients use the native global `fetch`, accept an injectable
 * `fetchImpl` for tests, enforce a bounded response size, and never download
 * remote images. Provider errors carry human-readable Chinese messages and
 * never include credentials.
 */

import {
  AGENT_CHAT_PATH,
  AGENT_IMAGE_PATH,
  AGENT_MAX_IMAGE_RESPONSE_BYTES,
  AGENT_MAX_RESPONSE_BYTES,
} from './config.mjs';
import { detectImageMime } from './media.mjs';
import { finishReasonMessage, isAcceptedFinishReason } from './finish.mjs';

export class ProviderError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export function isAbortError(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function abortError() {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return `${base}${path}`;
}

/**
 * Drop an upstream error body without ever surfacing its text. Upstream bodies
 * are untrusted and may contain echoed credentials, so client-visible errors are
 * built from the HTTP status only.
 */
function drainErrorBody(response) {
  try {
    const result = response.body?.cancel?.();
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    /* ignore */
  }
}

async function readBoundedBody(response, maxBytes, signal) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
        throw new ProviderError('AI 服务响应超过大小限制。');
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  return Buffer.concat(chunks, total);
}

function chatHttpMessage(status) {
  if (status === 401 || status === 403) return 'AI 服务鉴权失败，请检查服务端密钥配置。';
  if (status === 404) return 'AI 服务接口不存在（HTTP 404），请检查服务端配置。';
  if (status === 429) return 'AI 服务请求过于频繁，请稍后重试。';
  if (status >= 500) return 'AI 服务暂时不可用，请稍后重试。';
  return `AI 服务拒绝了本次请求（HTTP ${status}）。`;
}

function imageHttpMessage(status) {
  if (status === 401 || status === 403) return '图片服务鉴权失败，请检查服务端密钥配置。';
  if (status === 404) return '图片服务接口不存在（HTTP 404），请检查服务端配置。';
  if (status === 429) return '图片服务请求过于频繁，请稍后重试。';
  if (status >= 500) return '图片服务暂时不可用，请稍后重试。';
  return `图片服务拒绝了本次请求（HTTP ${status}）。`;
}

/**
 * DeepSeek / OpenAI-compatible chat completion client with function tools.
 *
 * `complete()` returns a normalized assistant turn. It never streams and never
 * exposes provider internals to callers.
 */
export function createChatProvider({
  baseUrl,
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  maxResponseBytes = AGENT_MAX_RESPONSE_BYTES,
  endpointPath = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createChatProvider 需要 fetch');
  const path = endpointPath ?? AGENT_CHAT_PATH;
  return {
    model,
    async complete({ messages, tools, signal }) {
      const body = {
        model,
        messages,
        tools,
        tool_choice: 'auto',
        stream: false,
        // The product contract is deterministic, non-thinking tool calling.
        thinking: { type: 'disabled' },
      };
      let response;
      try {
        response = await fetchImpl(joinUrl(baseUrl, path), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ProviderError('无法连接 AI 服务，请检查网络或服务配置。');
      }
      if (!response.ok) {
        drainErrorBody(response);
        throw new ProviderError(chatHttpMessage(response.status), { status: response.status });
      }
      const buffer = await readBoundedBody(response, maxResponseBytes, signal);
      let payload;
      try {
        payload = JSON.parse(buffer.toString('utf8'));
      } catch {
        throw new ProviderError('AI 服务返回了无法解析的数据。');
      }
      const message = payload?.choices?.[0]?.message;
      if (typeof message !== 'object' || message === null) {
        throw new ProviderError('AI 服务没有返回有效的回复。');
      }
      const finishReason = payload?.choices?.[0]?.finish_reason;
      // Fail closed: only a completed turn (`stop`) or a tool-call turn
      // (`tool_calls`) is usable. Incomplete, missing or unknown reasons must
      // never be treated as a trustworthy final answer.
      if (!isAcceptedFinishReason(finishReason)) {
        throw new ProviderError(finishReasonMessage(finishReason));
      }
      const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const toolCalls = rawCalls
        .filter((call) => call && typeof call.function?.name === 'string' && call.function.name !== '')
        .map((call) => ({
          id: typeof call.id === 'string' && call.id !== '' ? call.id : undefined,
          name: call.function.name,
          arguments: call.function.arguments,
        }));
      return {
        content: typeof message.content === 'string' ? message.content : '',
        toolCalls,
        finishReason,
      };
    },
  };
}

/**
 * Explicitly configured OpenAI-compatible image client (`b64_json` only).
 * No remote image is ever downloaded and there is no fake fallback.
 */
export function createImageProvider({
  baseUrl,
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  maxResponseBytes = AGENT_MAX_IMAGE_RESPONSE_BYTES,
  maxDataUrlChars,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createImageProvider 需要 fetch');
  return {
    model,
    async generate({ prompt, signal, referenceImage }) {
      const body = {
        model,
        prompt,
        n: 1,
        response_format: 'b64_json',
      };
      if (/^gpt-image/.test(model || '')) delete body.response_format;
      let requestBody = JSON.stringify(body);
      let endpoint = AGENT_IMAGE_PATH;
      let headers = {'content-type':'application/json', authorization:`Bearer ${apiKey}`};
      if (referenceImage) {
        const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(referenceImage);
        if (!match || referenceImage.length > (maxDataUrlChars || 6*1024*1024)) throw new ProviderError('参考图片格式或大小无效。');
        const form = new FormData();
        form.set('model', model); form.set('prompt',prompt); form.set('n','1');
        if (!/^gpt-image/.test(model || '')) form.set('response_format','b64_json');
        form.set('image',new Blob([Buffer.from(match[2],'base64')],{type:match[1]}),'reference.' + match[1].split('/')[1]);
        // multipart image edits: the runtime, not the model, supplies reference bytes.
        requestBody = form; endpoint = '/images/edits'; headers = {authorization:`Bearer ${apiKey}`};
      }
      let response;
      try {
        response = await fetchImpl(joinUrl(baseUrl, endpoint), {
          method: 'POST',
          headers,
          body: requestBody,
          signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ProviderError('无法连接图片服务，请检查网络或服务配置。');
      }
      if (!response.ok) {
        drainErrorBody(response);
        throw new ProviderError(imageHttpMessage(response.status), { status: response.status });
      }
      const buffer = await readBoundedBody(response, maxResponseBytes, signal);
      let payload;
      try {
        payload = JSON.parse(buffer.toString('utf8'));
      } catch {
        throw new ProviderError('图片服务返回了无法解析的数据。');
      }
      const b64 = payload?.data?.[0]?.b64_json;
      if (typeof b64 !== 'string' || b64 === '') {
        throw new ProviderError('图片服务没有返回 b64_json 图片数据。');
      }
      if (maxDataUrlChars && b64.length > maxDataUrlChars) {
        throw new ProviderError('生成的图片超过大小限制。');
      }
      const bytes = Buffer.from(b64, 'base64');
      const mime = detectImageMime(bytes);
      if (!mime) throw new ProviderError('图片服务返回了不支持的图片格式。');
      const dataUrl = `data:${mime};base64,${b64}`;
      if (maxDataUrlChars && dataUrl.length > maxDataUrlChars) {
        throw new ProviderError('生成的图片超过大小限制。');
      }
      return { dataUrl, mime, bytes: bytes.length };
    },
  };
}

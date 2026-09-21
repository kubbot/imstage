/**
 * IMStage Agent — Tencent TokenHub WAND-Vega async image provider.
 *
 * The API is a two-step async task flow (official docs
 * https://intl.cloud.tencent.com/zh/document/product/1300/83859):
 *
 *   1. POST {base}/wand/vega-images/generations  -> { task_id }
 *   2. GET  {base}/wand/vega-images/tasks/{id}   -> status + data[].url
 *
 * Design rules enforced here:
 * - The submit request is made exactly once; a failed/slow task is never
 *   resubmitted.
 * - Polling is bounded by a wall deadline and is abortable; the caller's
 *   `AbortSignal` always wins and is re-thrown as an `AbortError`.
 * - Reference edits always send the actual inline data URL in
 *   `input[].content[].image_url`. A reference is never silently dropped: an
 *   absent reference means text-to-image, an unsupported/invalid reference is
 *   a hard error before any network call.
 * - Completed images are downloaded only from allowlisted Tencent COS hosts
 *   over HTTPS. Tencent's live API returns the temporary signed URL over
 *   plain HTTP; the URL is validated (host/credentials/port), then upgraded to
 *   HTTPS and fetched there. Other protocols are rejected, credentials/ports
 *   are rejected, redirects are not followed and no authorization header is
 *   sent. The body is size-limited and the decoded bytes must be a real
 *   PNG/JPEG/WebP raster.
 * - Errors are built from status/state only: upstream response text, task
 *   IDs, signed COS URLs and keys are never echoed to callers.
 */

import { ProviderError, isAbortError } from './providers.mjs';
import { detectImageMime } from './media.mjs';
import { assertDecodableImage } from './image-decode.mjs';

export const TENCENT_WAND_CREATE_PATH = '/wand/vega-images/generations';
export const TENCENT_WAND_TASK_PREFIX = '/wand/vega-images/tasks/';
export const TENCENT_WAND_DEFAULT_SIZE = '1024x1024';
export const TENCENT_WAND_MAX_PROMPT_CHARS = 2000;
/** Reference images per task: Lite accepts 0–3 (Flash/Pro accept up to 6). */
export const TENCENT_WAND_MAX_REFERENCE_IMAGES = 3;
/** Per-image input cap from the docs. */
export const TENCENT_WAND_MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const TENCENT_WAND_POLL_INTERVAL_MS = 3_000;
export const TENCENT_WAND_TASK_DEADLINE_MS = 120_000;
export const TENCENT_WAND_MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

/**
 * Allowlisted COS host shapes:
 *   <bucket>.cos.myqcloud.com
 *   <bucket>.cos.<region>.myqcloud.com
 * Buckets are DNS labels (no dots), regions look like `ap-guangzhou`.
 */
const COS_HOST_RE = /^[a-z0-9][a-z0-9-]{0,62}\.cos\.(?:[a-z]{2}-[a-z0-9-]+\.)?myqcloud\.com$/;
const REFERENCE_DATA_URL_RE = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+=*)$/;

function isAbort(error) {
  return isAbortError(error);
}

function makeAbortError() {
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

/**
 * Internal deadline + caller-signal controller. The caller's abort always maps
 * to an `AbortError`; our own deadline maps to a bounded timeout error.
 */
function createDeadline({ signal, deadlineMs }) {
  const controller = new AbortController();
  const externalAborted = () => Boolean(signal?.aborted);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = deadlineMs > 0 ? setTimeout(() => controller.abort(), deadlineMs) : null;
  return {
    signal: controller.signal,
    externalAborted,
    cleanup() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function joinPath(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

/** Drop an untrusted upstream error body without ever surfacing its text. */
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
      if (signal?.aborted) throw makeAbortError();
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
        throw new ProviderError('图片服务响应超过大小限制。');
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

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(makeAbortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function wandHttpMessage(status) {
  if (status === 401 || status === 403) return '图片服务鉴权失败，请检查服务端密钥配置。';
  if (status === 404) return '图片服务接口不存在（HTTP 404），请检查服务端配置。';
  if (status === 429) return '图片服务请求过于频繁，请稍后重试。';
  if (status >= 500) return '图片服务暂时不可用，请稍后重试。';
  return `图片服务拒绝了本次请求（HTTP ${status}）。`;
}

function terminalTaskMessage(status) {
  if (status === 'failed') return '图片生成任务执行失败，请稍后重试。';
  if (status === 'cancelled') return '图片生成任务已取消。';
  return '图片生成任务未完成，请稍后重试。';
}

/**
 * Normalize an inline reference image. Returns `null` for text-to-image, a
 * validated data URL for reference editing, and throws (never drops) for an
 * unsupported, oversized or malformed reference.
 */
export function normalizeReferenceImage(referenceImage) {
  if (referenceImage === undefined || referenceImage === null || referenceImage === '') return null;
  if (typeof referenceImage !== 'string') throw new ProviderError('参考图片格式无效。');
  const match = REFERENCE_DATA_URL_RE.exec(referenceImage);
  if (!match) {
    // A data URL of a known-but-unsupported raster mime is a distinct, honest
    // failure; anything else is simply malformed. Neither is ever dropped.
    if (/^data:image\//.test(referenceImage)) {
      throw new ProviderError('参考图片格式不受支持，仅支持 PNG/JPEG。');
    }
    throw new ProviderError('参考图片格式无效。');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > TENCENT_WAND_MAX_REFERENCE_BYTES) {
    throw new ProviderError('参考图片超过大小限制或内容为空。');
  }
  return referenceImage;
}

/**
 * Validate a completed-image download URL against the COS allowlist.
 * Returns the parsed URL or throws a sanitized error.
 */
export function assertAllowedCosUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '' || rawUrl.length > 4096) {
    throw new ProviderError('图片下载地址无效。');
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProviderError('图片下载地址无效。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('图片下载地址协议无效。');
  }
  if (url.username !== '' || url.password !== '') throw new ProviderError('图片下载地址无效。');
  if (url.port !== '') throw new ProviderError('图片下载地址无效。');
  if (!COS_HOST_RE.test(url.hostname)) {
    throw new ProviderError('图片下载地址不在允许的腾讯云 COS 域名内。');
  }
  // Tencent's live API may return the temporary signed COS URL over plain
  // HTTP. The host/credentials/port are validated above as an allowlisted COS
  // endpoint, then the URL is upgraded in place. The download is always issued
  // over HTTPS; a plain-HTTP request is never made.
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url;
}

/**
 * Create the Tencent WAND-Vega image provider. The returned `generate` matches
 * the OpenAI-compatible provider contract: `{dataUrl,mime,bytes}`.
 */
export function createTencentImageProvider({
  baseUrl,
  apiKey,
  model,
  fetchImpl = globalThis.fetch,
  maxResponseBytes = 8 * 1024 * 1024,
  maxDownloadBytes = TENCENT_WAND_MAX_DOWNLOAD_BYTES,
  maxDataUrlChars,
  pollIntervalMs = TENCENT_WAND_POLL_INTERVAL_MS,
  deadlineMs = TENCENT_WAND_TASK_DEADLINE_MS,
  maxPromptChars = TENCENT_WAND_MAX_PROMPT_CHARS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createTencentImageProvider 需要 fetch');

  async function postTask({ prompt, referenceImage, signal }) {
    const body = {
      model,
      prompt,
      size: TENCENT_WAND_DEFAULT_SIZE,
    };
    if (referenceImage) {
      body.input = [
        {
          content: [{ type: 'input_image', image_url: referenceImage }],
        },
      ];
    }
    let response;
    try {
      response = await fetchImpl(joinPath(baseUrl, TENCENT_WAND_CREATE_PATH), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        // Never forward the Authorization header across a redirect, and never
        // let a redirect turn a submit into a same-origin resubmit surprise.
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ProviderError('无法连接图片服务，请检查网络或服务配置。');
    }
    if (!response.ok) {
      drainErrorBody(response);
      throw new ProviderError(wandHttpMessage(response.status), { status: response.status });
    }
    const buffer = await readBoundedBody(response, maxResponseBytes, signal);
    let payload;
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new ProviderError('图片服务返回了无法解析的数据。');
    }
    const taskId = payload?.task_id;
    if (typeof taskId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(taskId)) {
      throw new ProviderError('图片服务没有返回有效的任务 ID。');
    }
    return taskId;
  }

  async function pollTask(taskId, signal) {
    const taskUrl = joinPath(baseUrl, `${TENCENT_WAND_TASK_PREFIX}${encodeURIComponent(taskId)}`);
    let response;
    try {
      response = await fetchImpl(taskUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        // Same rule as submit: an auth-bearing poll is never redirected.
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ProviderError('无法连接图片服务，请检查网络或服务配置。');
    }
    if (!response.ok) {
      drainErrorBody(response);
      throw new ProviderError(wandHttpMessage(response.status), { status: response.status });
    }
    const buffer = await readBoundedBody(response, maxResponseBytes, signal);
    let payload;
    try {
      payload = JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new ProviderError('图片服务返回了无法解析的数据。');
    }
    return payload;
  }

  async function downloadCompletedImage(rawUrl, signal) {
    const url = assertAllowedCosUrl(rawUrl);
    let response;
    try {
      response = await fetchImpl(url.href, {
        method: 'GET',
        // No credentials and no redirect following are permitted for downloads.
        headers: { accept: 'image/*' },
        redirect: 'error',
        signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ProviderError('无法下载生成的图片。');
    }
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      drainErrorBody(response);
      throw new ProviderError('无法下载生成的图片。');
    }
    const buffer = await readBoundedBody(response, maxDownloadBytes, signal);
    const mime = detectImageMime(buffer);
    if (!mime) throw new ProviderError('生成的图片格式不受支持。');
    return { buffer, mime, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
  }

  return {
    model,
    async generate({ prompt, signal, referenceImage } = {}) {
      if (typeof prompt !== 'string' || prompt.trim() === '') {
        throw new ProviderError('图片提示词无效。');
      }
      if (prompt.length > maxPromptChars) {
        throw new ProviderError('图片提示词超过长度限制。');
      }
      // Validate the reference before any network call so it can never be
      // silently dropped on the way to the provider.
      const reference = normalizeReferenceImage(referenceImage);

      const deadline = createDeadline({ signal, deadlineMs });
      try {
        const taskId = await postTask({ prompt, referenceImage: reference, signal: deadline.signal });

        // Poll the single submitted task; a failure or deadline never resubmits.
        for (;;) {
          const payload = await pollTask(taskId, deadline.signal);
          const status = payload?.status;

          if (status === 'completed') {
            const rawUrl = payload?.data?.[0]?.url;
            if (typeof rawUrl !== 'string' || rawUrl === '') {
              throw new ProviderError('图片生成完成但未返回图片地址。');
            }
            const downloaded = await downloadCompletedImage(rawUrl, deadline.signal);
            try {
              await assertDecodableImage(downloaded.dataUrl, deadline.signal);
            } catch (error) {
              if (isAbort(error)) throw error;
              throw new ProviderError('生成的图片无法解码或尺寸过大。');
            }
            if (maxDataUrlChars && downloaded.dataUrl.length > maxDataUrlChars) {
              throw new ProviderError('生成的图片超过大小限制。');
            }
            return {
              dataUrl: downloaded.dataUrl,
              mime: downloaded.mime,
              bytes: downloaded.buffer.length,
            };
          }
          if (status === 'failed' || status === 'cancelled' || status === 'incomplete') {
            throw new ProviderError(terminalTaskMessage(status));
          }
          if (status === 'queued' || status === 'in_progress') {
            await wait(pollIntervalMs, deadline.signal);
            continue;
          }
          throw new ProviderError('图片服务返回了未知的任务状态。');
        }
      } catch (error) {
        if (deadline.externalAborted()) throw makeAbortError();
        if (isAbort(error)) throw new ProviderError('图片生成超时，请稍后重试。');
        throw error;
      } finally {
        deadline.cleanup();
      }
    },
  };
}

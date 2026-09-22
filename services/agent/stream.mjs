/**
 * IMStage Agent — bounded NDJSON response writer.
 *
 * `writeNdjsonLine` awaits socket backpressure but stays abortable: the wait
 * resolves on `drain`, rejects on `close`, and also rejects as soon as the
 * caller's whole-run deadline signal aborts. This is what stops a non-reading
 * client from pinning an agent run (and its concurrency lease) forever.
 */

export function abortedError(message = '连接已关闭') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isResponseGone(res) {
  return Boolean(res && (res.writableEnded || res.destroyed));
}

/**
 * Finish a streamed agent response.
 *
 * On a deadline hit the response may still hold a large unflushed buffer that a
 * non-reading client never drains, so the socket is destroyed after a short,
 * bounded delay. Returns the destroy timer (or null) for observability/tests.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{deadlineHit?:boolean, timeoutLine?:string, destroyDelayMs?:number}} [options]
 */
export function finishNdjsonResponse(res, options = {}) {
  const deadlineHit = options.deadlineHit === true;
  const destroyDelayMs = options.destroyDelayMs ?? 500;
  const wasEnded = Boolean(res.writableEnded);

  if (deadlineHit && !wasEnded && !res.destroyed && typeof options.timeoutLine === 'string') {
    // Best-effort truthful terminal event; the client may no longer read.
    try {
      res.write(options.timeoutLine);
    } catch {
      /* socket already gone */
    }
  }
  if (!res.writableEnded) {
    try {
      res.end();
    } catch {
      /* socket already gone */
    }
  }
  if (deadlineHit && !wasEnded && !res.destroyed) {
    return setTimeout(() => {
      try {
        res.destroy();
      } catch {
        /* already destroyed */
      }
    }, destroyDelayMs);
  }
  return null;
}

/**
 * Write one pre-serialized NDJSON line, respecting (and bounding) backpressure.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} line
 * @param {AbortSignal|undefined} signal whole-run deadline / client-abort signal
 * @param {{deadlineMessage?:string}} [options]
 */
export async function writeNdjsonLine(res, line, signal, options = {}) {
  const deadlineMessage = options.deadlineMessage ?? '已超过运行时限，已停止。';
  if (isResponseGone(res)) throw abortedError('连接已关闭');
  if (signal?.aborted) throw abortedError(deadlineMessage);
  if (res.write(line)) return;

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClosed);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClosed = () => {
      cleanup();
      reject(abortedError('连接已关闭'));
    };
    const onAbort = () => {
      cleanup();
      reject(abortedError(deadlineMessage));
    };
    res.once('drain', onDrain);
    res.once('close', onClosed);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

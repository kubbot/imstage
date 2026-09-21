/**
 * IMStage Agent — provider finish reasons.
 *
 * The chat provider only certifies a completed turn (`stop`) or a tool-call
 * turn (`tool_calls`). Anything else — a known incomplete/refused reason
 * (`length`, `content_filter`, `insufficient_system_resource`, `aborted`) or a
 * missing/unknown value — must fail the run rather than be treated as final.
 *
 * The message never echoes the raw provider value, so a hostile proxy cannot
 * smuggle arbitrary (possibly secret) text through `finish_reason`.
 */

export const ACCEPTED_FINISH_REASONS = Object.freeze(['stop', 'tool_calls']);

export const INCOMPLETE_FINISH_REASONS = Object.freeze([
  'length',
  'content_filter',
  'insufficient_system_resource',
  'aborted',
]);

const INCOMPLETE_MESSAGES = Object.freeze({
  length: '模型输出达到长度上限，结果不完整，已停止。',
  content_filter: '模型输出被内容策略拦截，已停止。',
  insufficient_system_resource: 'AI 服务资源不足，结果不完整，已停止。',
  aborted: 'AI 服务中止了本次生成，已停止。',
});

export function isAcceptedFinishReason(reason) {
  return typeof reason === 'string' && ACCEPTED_FINISH_REASONS.includes(reason);
}

export function isIncompleteFinishReason(reason) {
  return typeof reason === 'string' && INCOMPLETE_FINISH_REASONS.includes(reason);
}

/** Human-readable Chinese explanation; never includes the raw provider value. */
export function finishReasonMessage(reason) {
  if (typeof reason === 'string' && INCOMPLETE_MESSAGES[reason]) {
    return INCOMPLETE_MESSAGES[reason];
  }
  return 'AI 服务返回了未知或不完整的结束原因，已停止。';
}

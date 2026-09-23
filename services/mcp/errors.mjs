// Typed operational errors for the IMStage MCP adapter.
//
// Every failure that can reach a ChatGPT tool call carries:
//   code     - stable machine-readable string
//   message  - short human-readable description (Chinese, matches the repo UX)
//   details  - optional structured context (e.g. the current revision)
//   recovery - concrete next action for the model or operator
//   status   - suggested HTTP status when surfaced outside a tool result
//
// Tool handlers convert these into `isError: true` CallToolResults with a
// structured `{ error: { code, message, details, recovery } }` payload, so the
// model can self-correct instead of retrying blindly.

export class McpToolError extends Error {
  constructor(code, message, { details, recovery, status = 400, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'McpToolError';
    this.code = code;
    this.details = details ?? null;
    this.recovery = recovery ?? null;
    this.status = status;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details,
      recovery: this.recovery,
    };
  }
}

export function fail(code, message, options) {
  throw new McpToolError(code, message, options);
}

export function invalidRequest(message, details, recovery) {
  fail('invalid_request', message, { details, recovery, status: 400 });
}

export function validationError(errors) {
  const list = Array.isArray(errors) ? errors.filter((e) => typeof e === 'string') : [];
  const detail = list.slice(0, 5).join('；');
  fail('validation_error', detail ? `场景数据无效：${detail}` : '场景数据无效', {
    details: { errors: list.slice(0, 20) },
    recovery:
      '修正 details.errors 中指出的字段后重试；调用 imstage_get_capabilities 查看允许的字段与取值。',
    status: 422,
  });
}

export function limitExceeded(message, details, recovery) {
  fail('limit_exceeded', message, { details, recovery, status: 422 });
}

export function isMcpToolError(value) {
  return value instanceof McpToolError;
}

/**
 * Convert any thrown value into a stable error payload. Unknown errors are
 * logged by the caller and reported as `internal_error` without leaking stack
 * details to the model.
 */
export function toErrorPayload(error) {
  if (isMcpToolError(error)) return error.toJSON();
  return {
    code: 'internal_error',
    message: '服务器内部错误',
    details: null,
    recovery: '请稍后重试；若持续失败，请检查服务端日志。',
  };
}

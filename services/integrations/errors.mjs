// Typed errors raised by the account-owned ChatGPT/MCP integration layer.
//
// The account API's `sendError` recognises these in addition to `HttpError`,
// so connection-management and consent endpoints return a stable
// `{ error: { code, message } }` payload with an explicit HTTP status instead
// of a generic 500. OAuth protocol endpoints instead raise the SDK's
// `OAuthError` subclasses from `@modelcontextprotocol/sdk/server/auth/errors.js`
// so the SDK handlers can emit standard `error`/`error_description` responses.

export class IntegrationError extends Error {
  /**
   * @param {number} status HTTP status code
   * @param {string} code   stable machine-readable code
   * @param {string} message short human-readable message
   * @param {Record<string,string>} [headers] extra response headers
   */
  constructor(status, code, message, headers = undefined) {
    super(message);
    this.name = 'IntegrationError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function integrationError(status, code, message, headers) {
  return new IntegrationError(status, code, message, headers);
}

/**
 * IMStage Projects — typed, transport-agnostic errors.
 *
 * The HTTP layer in `services/api/server.mjs` maps these onto its own JSON
 * error envelope. Keeping them out of the server module avoids a circular
 * import and lets the project/batch logic stay independently testable.
 */

export class ProjectsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ProjectsError';
    this.status = status;
    this.code = code;
  }
}

export function projectsError(status, code, message) {
  return new ProjectsError(status, code, message);
}

/** Terminal batch states that never change again without an explicit retry. */
export const TERMINAL_JOB_STATUSES = Object.freeze([
  'done',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);

export function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** Task states that an explicit retry may pick up again. */
export const RETRYABLE_TASK_STATUSES = Object.freeze(['failed', 'interrupted', 'cancelled']);

export function isRetryableTaskStatus(status) {
  return RETRYABLE_TASK_STATUSES.includes(status);
}

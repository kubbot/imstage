export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function fail(code, message, status = 400, details) {
  throw new AppError(code, message, status, details);
}


export function isSafeId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }

import type { Platform, Scene } from '../studio/model';
export type User = { id: string; email: string; name: string };
export type SceneSummary = { id: string; title: string; platform: Scene['platform']; messageCount: number; updatedAt: string; revision: number };
export type SavedScene = { projectIds?:string[]; id: string; scene: Scene; updatedAt: string; revision: number };
export type Project = { id: string; name: string; rules: string; platform: Platform; revision: number; updatedAt: string; sceneCount: number };
export type BatchTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type BatchJobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export type BatchTask = { id: string; ordinal: number; prompt: string; platform: Platform; status: BatchTaskStatus; sceneId: string | null; error: string | null; errorCode: string | null; detail: string; updatedAt: string; name?: string; values?: Record<string, string> };
export type BatchJob = { id: string; projectId: string; status: BatchJobStatus; rules: string; reason: string | null; cancelRequested: boolean; total: number; succeeded: number; failed: number; createdAt: string; updatedAt: string; tasks?: BatchTask[]; templateId?: string | null; templateRevision?: number | null };
export type TemplateVariable = { key: string; label: string; type: 'text' | 'image'; target: { entity: string; id?: string; field: string } };
export type TemplateSummary = { id: string; name: string; description: string; mode: 'reference' | 'custom' | 'structured'; variableCount: number; revision: number; createdAt: string; updatedAt: string };
export type TemplateDefinition = { schemaVersion?: number; name: string; description: string; scene: Scene; variables: TemplateVariable[] };
export type TemplateDetail = TemplateSummary & { definition: TemplateDefinition };
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = 'unavailable') { super(message); this.status = status; this.code = code; }
}

/* ------------------------------------------------------------------ */
/* Localized operational errors                                        */
/* ------------------------------------------------------------------ */

/** Locale is read from the document/localStorage so non-hook callers match the UI. */
export type ApiLocale = 'zh' | 'en';
export function apiLocale(): ApiLocale {
  try {
    const value = typeof document !== 'undefined' ? document.documentElement?.dataset?.locale : undefined;
    if (value === 'en' || value === 'zh') return value;
  } catch { /* fall through */ }
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('imstage-locale') : null;
    if (stored === 'en' || stored === 'zh') return stored;
  } catch { /* fall through */ }
  return 'zh';
}

const GENERIC: Record<ApiLocale, string> = { zh: '请求未完成，请稍后重试。', en: 'The request could not be completed. Please try again.' };
const NETWORK: Record<ApiLocale, string> = { zh: '连接不到账号服务，请检查连接后重试。', en: 'Cannot reach the account service. Check your connection and retry.' };
const TIMEOUT: Record<ApiLocale, string> = { zh: '请求超时，暂未确认操作结果。请重试或重新登录。', en: 'The request timed out, so the result is unknown. Retry or sign in again.' };
const UNAVAILABLE: Record<ApiLocale, string> = { zh: '账号服务暂时不可用，请稍后重试。', en: 'The account service is temporarily unavailable. Try again shortly.' };
const REJECTED_EN = 'The request was rejected. Check the highlighted fields.';

/** Stable English text for server codes whose messages are Chinese-only. */
const CODE_EN: Record<string, string> = {
  unauthorized: 'Please sign in again.',
  account_changed: 'The signed-in account changed. Reopen the scene.',
  invalid_credentials: 'The email or password is incorrect.',
  origin_required: 'This request was blocked for security reasons.',
  origin_mismatch: 'This request was blocked for security reasons.',
  request_marker_required: 'This request was blocked for security reasons.',
  rate_limited: 'Too many requests. Please wait and retry.',
  busy: 'The account service is busy. Please retry shortly.',
  revision_conflict: 'This item changed elsewhere. Reload and try again.',
  conflict: 'This item changed or already exists. Reload and try again.',
  not_found: 'The requested item no longer exists.',
  email_taken: 'That email is already registered.',
  payload_too_large: 'The request is too large.',
  unsupported_media_type: 'Unsupported request format.',
  invalid_json: 'The request could not be read.',
  request_timeout: 'The request timed out.',
  ai_not_configured: 'The AI service is not configured yet.',
  batch_limit_reached: 'Too many batch jobs are running. Wait or cancel one first.',
  scene_limit_reached: 'The scene limit for this account has been reached.',
  template_limit_reached: 'The template limit for this account has been reached.',
  project_limit_reached: 'The project limit for this account has been reached.',
  invalid_template: 'The template data is invalid.',
  invalid_values: 'Some values are not valid for this template.',
  reference_platform_mismatch: 'A screenshot template can only be generated on its source platform.',
  ambiguous_batch_input: 'Provide either prompts or structured variants, not both.',
  invalid_variants: 'The structured variants are not valid.',
  invalid_variant_values: 'Some variant values are not valid.',
  invalid_prompts: 'Add at least one valid prompt.',
  invalid_batch_size: 'Too many items for one batch.',
  nothing_to_retry: 'There is nothing to retry.',
  job_not_finished: 'The job has not finished yet.',
};

/**
 * Localize an API error. Chinese keeps the server detail (useful validation
 * text); English uses a stable per-code message and a safe generic fallback for
 * untranslated Chinese server messages.
 */
export function apiErrorMessage(code: string | undefined, serverMessage: string | undefined, locale: ApiLocale): string {
  const message = typeof serverMessage === 'string' ? serverMessage.trim() : '';
  if (locale === 'zh') return message !== '' ? message : GENERIC.zh;
  if (message === '') return (code && CODE_EN[code]) || GENERIC.en;
  if (/[\u3400-\u9fff]/.test(message)) return (code && CODE_EN[code]) || REJECTED_EN;
  return message;
}
let requestIdentity: string | null = null;
let identityVersion = 0;
export function bindIdentity(user: User | null) { requestIdentity = user?.id || null; identityVersion++; }
export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal; optional?: boolean } = {}): Promise<T> {
  const startedIdentityVersion = identityVersion;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 15000);
  try {
    const response = await fetch(`/api${path}`, {
      method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-IMStage-Request': '1', ...(requestIdentity ? { 'X-IMStage-User': requestIdentity } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const code = data?.error?.code;
      if (startedIdentityVersion === identityVersion && response.status === 401 && !options.optional && code !== 'invalid_credentials' && !['/auth/login', '/auth/register'].includes(path)) window.dispatchEvent(new Event('imstage-session-expired'));
      throw new ApiError(apiErrorMessage(code, data?.error?.message, apiLocale()), response.status, code);
    }
    if (!data || typeof data !== 'object') throw new ApiError(UNAVAILABLE[apiLocale()]);
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const locale = apiLocale();
    throw new ApiError(controller.signal.aborted ? TIMEOUT[locale] : NETWORK[locale]);
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : GENERIC[apiLocale()]; }
export function safeNext(value: string | null) {
  return value && /^\/(workspace|account|studio|create|projects|templates|welcome|connect(?:\/authorize)?)(\?[^#]*)?$/.test(value) ? value : '/workspace';
}
export function loginLink(next = '/workspace') { return `#/login?next=${encodeURIComponent(safeNext(next))}`; }
export function clearAccountDrafts(userId: string) {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(`imstage.account.${userId}.`) || key.startsWith(`imstage.agent.${userId}.`) || key === `imstage.prefs.draft.${userId}`) sessionStorage.removeItem(key); } catch { /* memory state is cleared by route unmount */ }
}

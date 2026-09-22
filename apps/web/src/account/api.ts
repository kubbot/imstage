import type { Platform, Scene } from '../studio/model';
export type User = { id: string; email: string; name: string };
export type SceneSummary = { id: string; title: string; platform: Scene['platform']; messageCount: number; updatedAt: string; revision: number };
export type SavedScene = { projectIds?:string[]; id: string; scene: Scene; updatedAt: string; revision: number };
export type Project = { id: string; name: string; rules: string; platform: Platform; revision: number; updatedAt: string; sceneCount: number };
export type BatchTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
export type BatchJobStatus = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export type BatchTask = { id: string; ordinal: number; prompt: string; platform: Platform; status: BatchTaskStatus; sceneId: string | null; error: string | null; errorCode: string | null; detail: string; updatedAt: string };
export type BatchJob = { id: string; projectId: string; status: BatchJobStatus; rules: string; reason: string | null; cancelRequested: boolean; total: number; succeeded: number; failed: number; createdAt: string; updatedAt: string; tasks?: BatchTask[] };
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 0, code = 'unavailable') { super(message); this.status = status; this.code = code; }
}
let requestIdentity: string | null = null;
let identityVersion = 0;
export function bindIdentity(user: User | null) { requestIdentity = user?.id || null; identityVersion++; }
export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
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
      if (startedIdentityVersion === identityVersion && response.status === 401 && data?.error?.code !== 'invalid_credentials' && !['/auth/login', '/auth/register'].includes(path)) window.dispatchEvent(new Event('imstage-session-expired'));
      throw new ApiError(data?.error?.message || '请求未完成，请稍后重试。', response.status, data?.error?.code);
    }
    if (!data || typeof data !== 'object') throw new ApiError('账号服务暂时不可用，请稍后重试。');
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? '请求超时，暂未确认操作结果。请重试或重新登录。' : '连接不到账号服务，请检查连接后重试。');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
export function safeNext(value: string | null) {
  return value && /^\/(workspace|account|studio|create|projects)(\?[^#]*)?$/.test(value) ? value : '/workspace';
}
export function loginLink(next = '/workspace') { return `#/login?next=${encodeURIComponent(safeNext(next))}`; }
export function clearAccountDrafts(userId: string) {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(`imstage.account.${userId}.`) || key.startsWith(`imstage.agent.${userId}.`)) sessionStorage.removeItem(key); } catch { /* memory state is cleared by route unmount */ }
}

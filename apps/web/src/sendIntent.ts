/**
 * One-shot send intent.
 *
 * The public site's explicit Send/Create action authorizes exactly one real
 * Agent request. The intent is a small, bounded record that travels with the
 * scene handoff and lives inside the creation session draft, so it survives
 * authentication, reloads and navigation.
 *
 * Lifecycle:
 *   staged      -> the visitor explicitly submitted; nothing has been sent yet
 *   running     -> persisted *before* the provider request starts
 *   done        -> a usable scene came back
 *   failed      -> the request ended without a result (retry stays explicit)
 *   interrupted -> the page reloaded while running; never auto-repeated
 *
 * Only `staged` may auto-start. `running` is converted to `interrupted` when a
 * session is recovered, because repeating a request that may already have been
 * billed or executed is never allowed without the visitor asking again.
 */

export const INTENT_PROMPT_LIMIT = 400;

export type SendIntentStatus = 'staged' | 'running' | 'done' | 'failed' | 'interrupted';

export interface SendIntent {
  id: string;
  prompt: string;
  status: SendIntentStatus;
  createdAt: number;
  attempts: number;
  error?: string;
}

const STATUSES: readonly SendIntentStatus[] = ['staged', 'running', 'done', 'failed', 'interrupted'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createSendIntent(prompt: string, now: number = Date.now()): SendIntent | null {
  const text = typeof prompt === 'string' ? prompt.trim().slice(0, INTENT_PROMPT_LIMIT) : '';
  if (!text) return null;
  return { id: crypto.randomUUID(), prompt: text, status: 'staged', createdAt: now, attempts: 0 };
}

/** Validate a persisted/transmitted intent. Invalid values are dropped, not guessed. */
export function normalizeIntent(raw: unknown): SendIntent | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.length < 8 || raw.id.length > 80) return null;
  if (typeof raw.prompt !== 'string') return null;
  const prompt = raw.prompt.trim().slice(0, INTENT_PROMPT_LIMIT);
  if (!prompt) return null;
  if (typeof raw.status !== 'string' || !STATUSES.includes(raw.status as SendIntentStatus)) return null;
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  const attempts = Number.isSafeInteger(raw.attempts) && (raw.attempts as number) >= 0 ? (raw.attempts as number) : 0;
  const error = typeof raw.error === 'string' ? raw.error.slice(0, 300) : undefined;
  return { id: raw.id, prompt, status: raw.status as SendIntentStatus, createdAt, attempts, ...(error ? { error } : {}) };
}

/**
 * Prepare an intent read back from disk. A request that was in flight when the
 * page went away becomes `interrupted`: it is shown with an explicit retry and
 * never sent again on its own.
 */
export function recoverIntent(raw: unknown): SendIntent | null {
  const intent = normalizeIntent(raw);
  if (!intent) return null;
  if (intent.status === 'running') return { ...intent, status: 'interrupted' };
  return intent;
}

export function isAutoStartable(intent: SendIntent | null | undefined): boolean {
  return Boolean(intent && intent.status === 'staged' && intent.prompt.trim());
}

export function intentNeedsAttention(intent: SendIntent | null | undefined): boolean {
  return Boolean(intent && (intent.status === 'failed' || intent.status === 'interrupted'));
}

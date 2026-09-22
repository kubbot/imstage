/**
 * Landing → workspace scene handoff.
 *
 * The scenario selector can hand the visitor's actual edited scene (avatars
 * already converted to data URIs) to the Agent workspace. The scene is written
 * synchronously to `sessionStorage` under a random token, and the token travels
 * in the query string, so even an immediate navigation cannot race the write.
 * The workspace reads and deletes the token only for a genuinely new session.
 */
import type { Scene } from '../studio/model';

export const HANDOFF_PREFIX = 'imstage.marketing.handoff.';
/** Bound for one handed-off scene; data-URI avatars and the story photo add up. */
export const MAX_HANDOFF_BYTES = 4 * 1024 * 1024;
/** Bound for the optional instruction carried with a new session. */
export const MAX_HANDOFF_PROMPT = 400;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function handoffKey(token: string): string {
  return `${HANDOFF_PREFIX}${token}`;
}

export function isHandoffToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN.test(token);
}

export interface HandoffPayload {
  /** Raw scene value; validated by the workspace before it is used. */
  scene: unknown;
  /** Bounded instruction; only honoured for an explicitly fresh session. */
  prompt?: string;
}

function boundPrompt(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, MAX_HANDOFF_PROMPT);
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Store a scene (and optionally the visitor's instruction) and return its
 * token, or `null` when storage is unusable. The prompt travels inside
 * sessionStorage — never as a query value that could leak or truncate.
 */
export function writeHandoffScene(scene: Scene, prompt?: string): string | null {
  try {
    const payload: HandoffPayload = { scene };
    const bounded = boundPrompt(prompt);
    if (bounded) payload.prompt = bounded;
    const json = JSON.stringify(payload);
    if (json.length > MAX_HANDOFF_BYTES) return null;
    const token = crypto.randomUUID();
    sessionStorage.setItem(handoffKey(token), json);
    return token;
  } catch {
    return null;
  }
}

/** Read the scene and optional bounded prompt, tolerating legacy scene-only tokens. */
export function readHandoffPayload(token: unknown): HandoffPayload | null {
  if (!isHandoffToken(token)) return null;
  try {
    const raw = sessionStorage.getItem(handoffKey(token));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const scene = 'scene' in record ? record.scene : record;
    const prompt = boundPrompt(record.prompt);
    return prompt ? { scene, prompt } : { scene };
  } catch {
    return null;
  }
}

export function readHandoffScene(token: unknown): unknown | null {
  return readHandoffPayload(token)?.scene ?? null;
}

export function clearHandoffScene(token: unknown): void {
  if (!isHandoffToken(token)) return;
  try {
    sessionStorage.removeItem(handoffKey(token));
  } catch {
    /* The scene was already copied into the session; cleanup is best effort. */
  }
}

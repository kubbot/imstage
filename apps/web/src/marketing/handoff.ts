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
/** Bound for one handed-off scene; data-URI avatars are ~150 KB together. */
export const MAX_HANDOFF_BYTES = 3 * 1024 * 1024;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function handoffKey(token: string): string {
  return `${HANDOFF_PREFIX}${token}`;
}

export function isHandoffToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN.test(token);
}

/** Store a scene and return its token, or `null` when storage is unusable. */
export function writeHandoffScene(scene: Scene): string | null {
  try {
    const payload = JSON.stringify(scene);
    if (payload.length > MAX_HANDOFF_BYTES) return null;
    const token = crypto.randomUUID();
    sessionStorage.setItem(handoffKey(token), payload);
    return token;
  } catch {
    return null;
  }
}

export function readHandoffScene(token: unknown): unknown | null {
  if (!isHandoffToken(token)) return null;
  try {
    const raw = sessionStorage.getItem(handoffKey(token));
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function clearHandoffScene(token: unknown): void {
  if (!isHandoffToken(token)) return;
  try {
    sessionStorage.removeItem(handoffKey(token));
  } catch {
    /* The scene was already copied into the session; cleanup is best effort. */
  }
}

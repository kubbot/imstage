/**
 * Web client for account creator preferences.
 *
 * A small per-account cache lets brand-new scenes pick up the saved avatars and
 * fictional-mark default synchronously, without threading an async fetch through
 * every scene-creation call site. The cache is keyed by the real session user id
 * and cleared on logout / account switch.
 */

import { api } from '../account/api';
import { applyFictionalMark } from '../../../../packages/schema/fictional-mark.mjs';
import type { Scene } from '../studio/model';

export type OnboardingStatus = 'pending' | 'completed' | 'legacy';

export type CreatorPreferences = {
  revision: number;
  myAvatar: string | null;
  otherAvatar: string | null;
  showFictionalMark: boolean;
  markLabel: string;
  onboardingStatus: OnboardingStatus;
  onboardingVersion: number;
  onboardingShown: boolean;
  updatedAt: string | null;
};

export type AvatarCrop = { left: number; top: number; width: number; height: number };

export type PreferenceEvent = 'onboarding_shown' | 'onboarding_saved' | 'onboarding_skipped' | 'first_artwork_completed';

const cache = new Map<string, CreatorPreferences>();
let version = 0;

export function preferencesVersion(): number {
  return version;
}

export function cachedPreferences(userId: string | null | undefined): CreatorPreferences | null {
  if (!userId) return null;
  return cache.get(userId) ?? null;
}

function setCached(userId: string, item: CreatorPreferences): CreatorPreferences {
  cache.set(userId, item);
  version += 1;
  return item;
}

export function clearPreferencesCache(userId?: string | null): void {
  if (userId) cache.delete(userId);
  else cache.clear();
  version += 1;
}

/** Fetch and cache the current account preferences; never throws. */
export async function ensurePreferences(userId: string, signal?: AbortSignal): Promise<CreatorPreferences | null> {
  if (!userId) return null;
  try {
    // This read is optional for routing: a failure (including 401 for a stale
    // identity) must never dispatch the global session-expired logout, because
    // OAuth consent and other pages must render without waiting on preferences.
    const data = await api<{ item: CreatorPreferences }>('/preferences', { signal, optional: true });
    return setCached(userId, data.item);
  } catch {
    return null;
  }
}

export async function fetchPreferences(signal?: AbortSignal): Promise<CreatorPreferences> {
  const data = await api<{ item: CreatorPreferences }>('/preferences', { signal });
  return data.item;
}

export type PreferencesUpdate = {
  revision: number;
  myAvatar?: string | null;
  otherAvatar?: string | null;
  showFictionalMark?: boolean;
  onboardingStatus?: 'completed';
  onboardingVersion?: number;
  crop?: AvatarCrop | null;
};

export async function savePreferences(userId: string, input: PreferencesUpdate): Promise<CreatorPreferences> {
  const data = await api<{ item: CreatorPreferences }>('/preferences', { method: 'PUT', body: input });
  return setCached(userId, data.item);
}

export async function recordPreferenceEvent(name: PreferenceEvent, dedupeKey?: string): Promise<void> {
  await api('/preferences/events', { method: 'POST', body: dedupeKey === undefined ? { name } : { name, dedupeKey } });
}

/** Best-effort telemetry: a failure must never break the creative flow. */
export function trackPreferenceEvent(name: PreferenceEvent, dedupeKey?: string): void {
  void recordPreferenceEvent(name, dedupeKey).catch(() => {});
}

export async function generatePortrait(seed: string): Promise<string> {
  const data = await api<{ avatar: string }>('/preferences/portrait', { method: 'POST', body: { seed } });
  return data.avatar;
}

/**
 * Apply the account defaults to a *brand new* scene. Existing scenes must never
 * be passed here: the returned scene is a new object and stored scenes are
 * never rewritten by a preferences change.
 */
export function applyNewSceneDefaults(scene: Scene, userId?: string | null): Scene {
  const prefs = cachedPreferences(userId);
  if (!prefs) return scene;
  let changed = false;
  const participants = scene.participants.map((participant) => {
    // Any explicitly present avatar (including an empty string) is preserved;
    // only a truly missing key is filled from account defaults.
    if (Object.prototype.hasOwnProperty.call(participant, 'avatar')) return participant;
    const fallback = participant.id === scene.selfId ? prefs.myAvatar : prefs.otherAvatar;
    if (!fallback) return participant;
    changed = true;
    return { ...participant, avatar: fallback };
  });
  const watermark = applyFictionalMark(scene.watermark, prefs.showFictionalMark, prefs.markLabel);
  if (watermark !== scene.watermark) changed = true;
  return changed ? { ...scene, participants, watermark } : scene;
}

/* ------------------------------------------------------------------ */
/* Recoverable per-user onboarding draft                               */
/* ------------------------------------------------------------------ */

export type OnboardingDraft = {
  myAvatar: string | null;
  otherAvatar: string | null;
  showFictionalMark: boolean;
  updatedAt: number;
};

function draftKey(userId: string): string {
  return `imstage.prefs.draft.${userId}`;
}

export function readOnboardingDraft(userId: string): OnboardingDraft | null {
  if (!userId) return null;
  try {
    const raw = sessionStorage.getItem(draftKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnboardingDraft>;
    const avatarOk = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(value));
    if (typeof parsed.showFictionalMark !== 'boolean') return null;
    if (!avatarOk(parsed.myAvatar) || !avatarOk(parsed.otherAvatar)) return null;
    return {
      myAvatar: typeof parsed.myAvatar === 'string' ? parsed.myAvatar : null,
      otherAvatar: typeof parsed.otherAvatar === 'string' ? parsed.otherAvatar : null,
      showFictionalMark: parsed.showFictionalMark,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeOnboardingDraft(userId: string, draft: OnboardingDraft): boolean {
  if (!userId) return false;
  try {
    sessionStorage.setItem(draftKey(userId), JSON.stringify(draft));
    return true;
  } catch {
    // Quota or disabled storage: keep the in-memory draft, report gracefully.
    return false;
  }
}

export function clearOnboardingDraft(userId: string): void {
  if (!userId) return;
  try {
    sessionStorage.removeItem(draftKey(userId));
  } catch {
    /* nothing to clear */
  }
}

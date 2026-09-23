/**
 * IMStage creator preferences — trusted read layer with a stable built-in
 * default "other" avatar.
 *
 * Requirement GET-45: the other participant must always have a usable, stable
 * fictional avatar, including for a skipped/unconfigured account MCP user. The
 * portrait generator is deterministic and local (no model, no key, no network),
 * so when no avatar is stored we derive one from the account id. The same seed
 * produces byte-identical output in the Web defaults and the account MCP
 * defaults, which keeps reload/export stable and Web/MCP in parity.
 *
 * The derived value is never written on a read. It becomes stored only when the
 * user actually saves it (or uploads a replacement). Explicit scene-level
 * `avatar: ''`/`null` still wins because default fill only fills a missing key.
 */

import { getPreferences } from './store.mjs';
import { generateFictionalPortrait } from './image.mjs';

const DEFAULT_AVATAR_CACHE_MAX = 500;

export function derivedOtherAvatarSeed(userId) {
  return `${userId}:default-other-avatar`;
}

export function createPreferencesReader(db, { maxCache = DEFAULT_AVATAR_CACHE_MAX } = {}) {
  const cache = new Map();

  async function derivedOtherAvatar(userId) {
    if (cache.has(userId)) {
      const cached = cache.get(userId);
      // refresh LRU position
      cache.delete(userId);
      cache.set(userId, cached);
      return cached;
    }
    const avatar = await generateFictionalPortrait(derivedOtherAvatarSeed(userId));
    if (cache.size >= maxCache) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(userId, avatar);
    return avatar;
  }

  return {
    derivedOtherAvatar,
    /** Stored preferences, with a deterministic derived other avatar when none is stored. */
    async get(userId) {
      const stored = getPreferences(db, userId);
      if (typeof stored.otherAvatar === 'string' && stored.otherAvatar !== '') return stored;
      return { ...stored, otherAvatar: await derivedOtherAvatar(userId) };
    },
  };
}

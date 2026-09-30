/**
 * IMStage creator preferences — trusted post-tool default fill.
 *
 * Defaults are applied *after* the tool/model produced a scene and *before* it
 * is validated and stored, from account state that the model never sees. This
 * keeps large avatar data out of the model context while still giving new
 * scenes the account's avatars and fictional mark.
 *
 * Explicit intent always wins: a key that is present (including `''`, `false`
 * or `null`) is never overwritten. Only a missing/`undefined` key is filled.
 */

import { FICTIONAL_MARK_LABEL } from '../../packages/schema/fictional-mark.mjs';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Fill missing avatar defaults on a scene-like object.
 *
 * The mandatory AI生成 / 虚构 disclosure is rendered unconditionally by every
 * renderer and export, so it is no longer stored in `scene.watermark` and no
 * preference can switch it off.
 *
 * @param {unknown} rawScene model/tool supplied scene
 * @param {{myAvatar?: string|null, otherAvatar?: string|null}} defaults
 * @returns {unknown} a new object when something changed, otherwise the input
 */
export function applySceneDefaults(rawScene, defaults = {}) {
  if (!isPlainObject(rawScene)) return rawScene;
  const {
    myAvatar = null,
    otherAvatar = null,
  } = defaults;

  let changed = false;
  const next = { ...rawScene };

  if (Array.isArray(rawScene.participants)) {
    const selfId = typeof rawScene.selfId === 'string' ? rawScene.selfId : '';
    const participants = rawScene.participants.map((participant) => {
      if (!isPlainObject(participant)) return participant;
      if (hasOwn(participant, 'avatar') && participant.avatar !== undefined) return participant;
      const fallback = participant.id === selfId ? myAvatar : otherAvatar;
      if (typeof fallback !== 'string' || fallback === '') return participant;
      changed = true;
      return { ...participant, avatar: fallback };
    });
    if (changed) next.participants = participants;
  }

  return changed ? next : rawScene;
}

/**
 * Model-safe summary of the account defaults. Never contains avatar bytes or
 * the raw stored image, only what the agent needs to know.
 */
export function sceneDefaultsSummary(preferences) {
  return {
    myAvatarConfigured: typeof preferences?.myAvatar === 'string' && preferences.myAvatar !== '',
    otherAvatarConfigured: typeof preferences?.otherAvatar === 'string' && preferences.otherAvatar !== '',
    showFictionalMark: true,
    markLabel: FICTIONAL_MARK_LABEL,
    onboardingStatus: preferences?.onboardingStatus ?? 'legacy',
    note: '新场景会自动套用账号默认头像；AI生成/虚构标识由系统强制显示，不可关闭；显式传入 avatar（含空值）时以显式值为准。',
  };
}

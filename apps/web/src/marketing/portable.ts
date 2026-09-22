/**
 * Avatar portability for the landing demo.
 *
 * The visible preview may reference the bounded same-origin static avatar, but
 * anything that is validated or exported must carry the image as a `data:`
 * URI: `validateScene` rejects remote paths and canvas export must not depend
 * on a network fetch. These helpers are pure so the conversion rule is
 * unit-testable without a browser.
 *
 * Which photo belongs to which participant depends on the language, because the
 * authored people differ: 中文 场景里「阿远」是另一位，「我」用另一张；English 场景里
 * 「Ava」是另一位。 Each photo appears at most once per scene.
 */
import { validateScene, type Scene } from '../studio/model.ts';
import type { Locale } from './locale';

export const DEMO_AVATARS = {
  yuan: '/assets/people/yuan.webp',
  ava: '/assets/people/ava.webp',
} as const;

export type AvatarRole = keyof typeof DEMO_AVATARS;
export interface DemoAvatars {
  yuan: string;
  ava: string;
}

/** Hard bound for any avatar read from the static bundle. */
export const MAX_AVATAR_BYTES = 1024 * 1024;

const DATA_IMAGE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

/**
 * Participant → photo assignment per language.
 * zh: the other person (阿远/p-ay) is Yuan, the visitor is Ava.
 * en: the other person (Ava/p-su) is Ava, the visitor is Yuan.
 * The third member of the group scene keeps initials so no photo repeats.
 */
export const DEMO_AVATAR_ROLES: Record<Locale, Readonly<Record<string, AvatarRole>>> = {
  zh: { self: 'ava', other: 'yuan', 'p-ay': 'yuan' },
  en: { self: 'yuan', other: 'ava', 'p-su': 'ava' },
};

export function avatarRoleForParticipant(id: string, locale: Locale): AvatarRole | null {
  return DEMO_AVATAR_ROLES[locale][id] ?? null;
}

export function demoAvatarRole(value: string | undefined): AvatarRole | null {
  if (value === DEMO_AVATARS.yuan) return 'yuan';
  if (value === DEMO_AVATARS.ava) return 'ava';
  return null;
}

/** Apply loaded data URIs to the demo participants, preserving everything else. */
export function injectAvatars(scene: Scene, avatars: DemoAvatars, locale: Locale): Scene {
  return {
    ...scene,
    participants: scene.participants.map((participant) => {
      const role = avatarRoleForParticipant(participant.id, locale);
      return role ? { ...participant, avatar: avatars[role] } : participant;
    }),
  };
}

/** Replace any demo static path with its loaded data URI. */
export function makePortable(scene: Scene, avatars: DemoAvatars): Scene {
  const swap = (value: string | undefined) => {
    const role = demoAvatarRole(value);
    return role ? avatars[role] : value;
  };
  return {
    ...scene,
    participants: scene.participants.map((participant) => {
      const next = swap(participant.avatar);
      return next === participant.avatar ? participant : { ...participant, avatar: next };
    }),
    messages: scene.messages.map((message) => {
      const next = swap(message.asset);
      return next === message.asset ? message : { ...message, asset: next };
    }),
  };
}

export interface PortableResult {
  ok: boolean;
  errors: string[];
  scene?: Scene;
}

/**
 * Convert demo assets to data URIs and validate the result. Callers must show
 * the returned errors instead of claiming a successful export/save.
 */
export function portableScene(scene: Scene, avatars: DemoAvatars): PortableResult {
  const result = validateScene(makePortable(scene, avatars));
  return { ok: result.ok, errors: result.errors, scene: result.scene };
}

/** True when every participant avatar already carries local image data. */
export function hasLocalAvatar(value: unknown): boolean {
  return typeof value === 'string' && DATA_IMAGE.test(value);
}

import type {Platform} from './model';
/**
 * Generic IMStage chat chrome. Platform identifiers survive in stored scenes
 * for migration only; every value renders the same independent IMStage UI, so
 * public output never shows a messaging-platform logo, name or clone.
 */
export const GENERIC_TEMPLATE = {
  version: 'imstage-generic-2026-v1',
  headerAvatar: false,
  messageAvatars: 'all',
  inlineTime: true,
  composer: 'default',
  background: '#e9edf2',
} as const;
/** @deprecated legacy structural keys kept only so old code keeps compiling. */
export const PLATFORM_TEMPLATES = new Proxy({} as Record<Platform, typeof GENERIC_TEMPLATE>, {
  get: () => GENERIC_TEMPLATE,
});
export function platformTemplate(_platform: Platform) {
  return GENERIC_TEMPLATE;
}

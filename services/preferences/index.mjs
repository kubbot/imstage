/**
 * IMStage creator preferences — public surface for the API server and MCP.
 */

export {
  ALLOWED_EVENTS,
  AVATAR_SIZE,
  DEDUPED_EVENTS,
  FICTIONAL_MARK_LABEL,
  MAX_AVATAR_PIXELS,
  MAX_AVATAR_UPLOAD_CHARS,
  ONBOARDING_VERSION,
  PreferencesError,
  isAllowedEvent,
  isDedupedEvent,
  normalizeCrop,
  normalizePreferencesUpdate,
  parseRevision,
  preferencesError,
} from './model.mjs';

export {
  PREFERENCES_SCHEMA_SQL,
  createDefaultPreferences,
  defaultPreferencesPayload,
  getPreferences,
  hasEvent,
  installPreferencesSchema,
  listEventSummary,
  markOnboardingShown,
  preferencesPayload,
  putPreferences,
  readPreferencesRow,
  recordEvent,
} from './store.mjs';

export { generateFictionalPortrait, processAvatar } from './image.mjs';

export { createPreferencesReader, derivedOtherAvatarSeed } from './reader.mjs';

export { applySceneDefaults, sceneDefaultsSummary } from './defaults.mjs';

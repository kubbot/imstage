/**
 * IMStage Contacts — public entry point.
 *
 * Re-exports the account-scoped contact-library validation, avatar
 * verification and SQLite persistence so `services/api/server.mjs` can wire
 * everything with a single import.
 */

export { ContactsError, contactsError } from './errors.mjs';
export {
  MAX_CONTACTS,
  MAX_CONTACT_NAME_CHARS,
  MAX_CONTACT_SUBTITLE_CHARS,
  MAX_AVATAR_ENCODED_CHARS,
  MAX_AVATAR_PIXELS,
  MAX_TOTAL_AVATAR_BYTES,
  isContactUuid,
  parseRevision,
  normalizeContactLibraryInput,
} from './model.mjs';
export { assertDecodableAvatar, validateContactAvatars, assertAvatarByteBudget } from './image.mjs';
export { CONTACT_SCHEMA_SQL, getContactLibrary, putContactLibrary } from './store.mjs';

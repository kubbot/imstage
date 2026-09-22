/**
 * IMStage Contacts — typed, transport-agnostic errors.
 *
 * The HTTP layer in `services/api/server.mjs` maps these onto its own JSON
 * error envelope. Keeping them out of the server module avoids a circular
 * import and lets the contact-library logic stay independently testable.
 */

export class ContactsError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ContactsError';
    this.status = status;
    this.code = code;
  }
}

export function contactsError(status, code, message) {
  return new ContactsError(status, code, message);
}

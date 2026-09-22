/**
 * IMStage Contacts — SQLite persistence.
 *
 * Owns the `contact_libraries` headline row and its `contacts` children. Every
 * function takes the open `DatabaseSync` handle explicitly so the HTTP layer
 * shares the single server connection and transaction discipline.
 *
 * The whole library is account-scoped: `user_id` is part of every primary key
 * and every query, so one account can never read or overwrite another's data.
 */

import { contactsError } from './errors.mjs';

export const CONTACT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contact_libraries (
    user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision        INTEGER NOT NULL,
    self_contact_id TEXT,
    auto_save       INTEGER NOT NULL DEFAULT 1,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    subtitle   TEXT NOT NULL DEFAULT '',
    avatar     TEXT,
    sort_order INTEGER NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_contacts_user_order ON contacts(user_id, sort_order);
`;

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* original error wins */
    }
    throw err;
  }
}

function nowIso(ms) {
  return new Date(ms).toISOString();
}

function contactItem(row) {
  return {
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    avatar: row.avatar ?? null,
  };
}

const EMPTY_LIBRARY = Object.freeze({
  revision: 0,
  contacts: Object.freeze([]),
  selfContactId: null,
  autoSave: true,
});

/** Read the full library for one user. Unknown accounts get the empty default. */
export function getContactLibrary(db, userId) {
  const library = db
    .prepare(
      'SELECT revision, self_contact_id, auto_save FROM contact_libraries WHERE user_id = ?',
    )
    .get(userId);
  if (!library) {
    return {
      revision: EMPTY_LIBRARY.revision,
      contacts: [],
      selfContactId: EMPTY_LIBRARY.selfContactId,
      autoSave: EMPTY_LIBRARY.autoSave,
    };
  }
  const rows = db
    .prepare(
      `SELECT id, name, subtitle, avatar FROM contacts
       WHERE user_id = ? ORDER BY sort_order ASC, id ASC`,
    )
    .all(userId);
  return {
    revision: Number(library.revision),
    contacts: rows.map(contactItem),
    selfContactId: library.self_contact_id ?? null,
    autoSave: Number(library.auto_save) === 1,
  };
}

/**
 * Atomically replace the library if `revision` matches the stored revision.
 *
 * `revision: 0` creates a library (and stores revision `1`). Every later write
 * increments the revision. A mismatch throws `409 revision_conflict` and leaves
 * the persisted state untouched. The caller must have already validated the
 * shape and decoded every avatar.
 */
export function putContactLibrary(db, { userId, revision, contacts, selfContactId, autoSave, nowMs }) {
  return withTransaction(db, () => {
    const current = db
      .prepare('SELECT revision FROM contact_libraries WHERE user_id = ?')
      .get(userId);
    const currentRevision = current ? Number(current.revision) : 0;
    if (revision !== currentRevision) {
      throw contactsError(409, 'revision_conflict', '联系人库已更新，请刷新后重试');
    }

    const nextRevision = currentRevision + 1;
    db.prepare(
      `INSERT INTO contact_libraries (user_id, revision, self_contact_id, auto_save, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         revision = excluded.revision,
         self_contact_id = excluded.self_contact_id,
         auto_save = excluded.auto_save,
         updated_at = excluded.updated_at`,
    ).run(userId, nextRevision, selfContactId, autoSave ? 1 : 0, nowIso(nowMs));

    db.prepare('DELETE FROM contacts WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      `INSERT INTO contacts (user_id, id, name, subtitle, avatar, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    contacts.forEach((contact, index) => {
      insert.run(userId, contact.id, contact.name, contact.subtitle, contact.avatar, index);
    });

    return {
      revision: nextRevision,
      contacts: contacts.map((contact) => ({ ...contact })),
      selfContactId,
      autoSave,
    };
  });
}

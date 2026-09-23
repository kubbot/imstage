/**
 * IMStage creator preferences — account-scoped SQLite storage.
 *
 * Additive migration only: creating these tables never rewrites scenes or
 * forces existing accounts through onboarding. A user without a row is treated
 * as a legacy account (`onboardingStatus: 'legacy'`), while registration writes
 * an explicit `pending` row so only genuinely new accounts are prompted.
 *
 * Every read/write is scoped by `user_id` and uses optimistic revisions, so a
 * concurrent tab cannot silently overwrite a newer value.
 */

import crypto from 'node:crypto';

import {
  ONBOARDING_VERSION,
  FICTIONAL_MARK_LABEL,
  isAllowedEvent,
  isDedupedEvent,
  preferencesError,
} from './model.mjs';

export const PREFERENCES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS account_preferences (
    user_id              TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    revision             INTEGER NOT NULL,
    my_avatar            TEXT,
    other_avatar         TEXT,
    show_fictional_mark  INTEGER NOT NULL,
    mark_label           TEXT NOT NULL,
    onboarding_status    TEXT NOT NULL,
    onboarding_version   INTEGER NOT NULL,
    onboarding_shown_at  TEXT,
    updated_at           TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS preference_events (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    dedupe_key TEXT,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_preference_events_dedupe
    ON preference_events(user_id, name, dedupe_key);
  CREATE INDEX IF NOT EXISTS idx_preference_events_user
    ON preference_events(user_id, created_at DESC);
`;

export function installPreferencesSchema(db) {
  db.exec(PREFERENCES_SCHEMA_SQL);
}

/* ------------------------------------------------------------------ */
/* Pure row mapping                                                    */
/* ------------------------------------------------------------------ */

export function defaultPreferencesPayload() {
  return {
    revision: 0,
    myAvatar: null,
    otherAvatar: null,
    showFictionalMark: true,
    markLabel: FICTIONAL_MARK_LABEL,
    onboardingStatus: 'legacy',
    onboardingVersion: ONBOARDING_VERSION,
    onboardingShown: false,
    updatedAt: null,
  };
}

export function preferencesPayload(row) {
  if (!row) return defaultPreferencesPayload();
  return {
    revision: Number(row.revision),
    myAvatar: typeof row.my_avatar === 'string' && row.my_avatar !== '' ? row.my_avatar : null,
    otherAvatar: typeof row.other_avatar === 'string' && row.other_avatar !== '' ? row.other_avatar : null,
    showFictionalMark: Number(row.show_fictional_mark) === 1,
    markLabel: typeof row.mark_label === 'string' && row.mark_label !== '' ? row.mark_label : FICTIONAL_MARK_LABEL,
    onboardingStatus: row.onboarding_status,
    onboardingVersion: Number(row.onboarding_version),
    onboardingShown: typeof row.onboarding_shown_at === 'string' && row.onboarding_shown_at !== '',
    updatedAt: row.updated_at ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

export function readPreferencesRow(db, userId) {
  return db
    .prepare(
      `SELECT revision, my_avatar, other_avatar, show_fictional_mark, mark_label,
              onboarding_status, onboarding_version, onboarding_shown_at, updated_at
       FROM account_preferences WHERE user_id = ?`,
    )
    .get(userId) ?? null;
}

export function getPreferences(db, userId) {
  return preferencesPayload(readPreferencesRow(db, userId));
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Create the pending preferences row for a freshly registered account.
 * Existing accounts never call this, so they keep the legacy (non-prompting)
 * default without a data migration.
 */
export function createDefaultPreferences(db, userId, nowMs, { status = 'pending' } = {}) {
  db.prepare(
    `INSERT INTO account_preferences
       (user_id, revision, my_avatar, other_avatar, show_fictional_mark, mark_label,
        onboarding_status, onboarding_version, onboarding_shown_at, updated_at)
     VALUES (?, 1, NULL, NULL, 1, ?, ?, ?, NULL, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  ).run(userId, FICTIONAL_MARK_LABEL, status, ONBOARDING_VERSION, new Date(nowMs).toISOString());
}

/**
 * Apply a partial update with optimistic concurrency.
 *
 * `patch` may contain `myAvatar`, `otherAvatar`, `showFictionalMark`,
 * `onboardingStatus` and `onboardingVersion`; omitted keys keep their value.
 * Avatar values are expected to be already processed (bounded square images).
 */
export function putPreferences(db, { userId, revision, patch, nowMs }) {
  return withTransaction(db, () => {
    const row = readPreferencesRow(db, userId);
    const updatedAt = new Date(nowMs).toISOString();
    if (!row) {
      if (revision !== 0) {
        throw preferencesError(409, 'revision_conflict', '偏好已被更新，请刷新后重试');
      }
      db.prepare(
        `INSERT INTO account_preferences
           (user_id, revision, my_avatar, other_avatar, show_fictional_mark, mark_label,
            onboarding_status, onboarding_version, onboarding_shown_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        userId,
        patch.myAvatar ?? null,
        patch.otherAvatar ?? null,
        patch.showFictionalMark === undefined ? 1 : patch.showFictionalMark ? 1 : 0,
        FICTIONAL_MARK_LABEL,
        patch.onboardingStatus ?? 'pending',
        patch.onboardingVersion ?? ONBOARDING_VERSION,
        updatedAt,
      );
      return preferencesPayload(readPreferencesRow(db, userId));
    }

    if (Number(row.revision) !== revision) {
      throw preferencesError(409, 'revision_conflict', '偏好已被更新，请刷新后重试');
    }

    const next = {
      my_avatar: patch.myAvatar === undefined ? row.my_avatar : patch.myAvatar,
      other_avatar: patch.otherAvatar === undefined ? row.other_avatar : patch.otherAvatar,
      show_fictional_mark:
        patch.showFictionalMark === undefined
          ? row.show_fictional_mark
          : patch.showFictionalMark
            ? 1
            : 0,
      mark_label: row.mark_label,
      onboarding_status: patch.onboardingStatus ?? row.onboarding_status,
      onboarding_version: patch.onboardingVersion ?? row.onboarding_version,
    };
    db.prepare(
      `UPDATE account_preferences
       SET revision = revision + 1, my_avatar = ?, other_avatar = ?, show_fictional_mark = ?,
           mark_label = ?, onboarding_status = ?, onboarding_version = ?, updated_at = ?
       WHERE user_id = ? AND revision = ?`,
    ).run(
      next.my_avatar ?? null,
      next.other_avatar ?? null,
      next.show_fictional_mark,
      next.mark_label,
      next.onboarding_status,
      next.onboarding_version,
      updatedAt,
      userId,
      revision,
    );
    return preferencesPayload(readPreferencesRow(db, userId));
  });
}

/**
 * Mark onboarding as shown once. Only the first call changes `onboarding_shown_at`,
 * so a refresh or interruption cannot re-trigger the automatic entry.
 */
export function markOnboardingShown(db, userId, nowMs) {
  db.prepare(
    'UPDATE account_preferences SET onboarding_shown_at = ? WHERE user_id = ? AND onboarding_shown_at IS NULL',
  ).run(new Date(nowMs).toISOString(), userId);
}

/* ------------------------------------------------------------------ */
/* Lightweight allowlisted events                                      */
/* ------------------------------------------------------------------ */

export function recordEvent(db, { userId, name, nowMs }) {
  if (!isAllowedEvent(name)) {
    throw preferencesError(400, 'invalid_event', '事件名称不在允许列表中');
  }
  // Account-once events use a server-owned stable key, so no client-supplied
  // value can bypass deduplication. Other events store no key at all; arbitrary
  // client text is never persisted (no prompt/avatar/conversation/UA).
  const key = isDedupedEvent(name) ? 'account-once' : null;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO preference_events (id, user_id, name, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), userId, name, key, new Date(nowMs).toISOString());
  return { name, recorded: Number(result.changes) === 1, deduplicated: Number(result.changes) === 0 };
}

/** Owner-scoped, content-free event summary for local verification. */
export function listEventSummary(db, userId) {
  const rows = db
    .prepare(
      `SELECT name, COUNT(*) AS total, MIN(created_at) AS first_at, MAX(created_at) AS last_at
       FROM preference_events WHERE user_id = ? GROUP BY name ORDER BY name ASC`,
    )
    .all(userId);
  return rows.map((row) => ({
    name: row.name,
    count: Number(row.total),
    firstAt: row.first_at,
    lastAt: row.last_at,
  }));
}

export function hasEvent(db, userId, name) {
  const row = db
    .prepare('SELECT 1 AS present FROM preference_events WHERE user_id = ? AND name = ? LIMIT 1')
    .get(userId, name);
  return Boolean(row);
}

/* ------------------------------------------------------------------ */
/* Transactions                                                        */
/* ------------------------------------------------------------------ */

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error wins */
    }
    throw error;
  }
}

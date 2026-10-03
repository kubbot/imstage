/**
 * IMStage Projects — one re-entrant transaction helper.
 *
 * `services/projects/store.mjs` and `services/projects/automation-store.mjs`
 * both open `BEGIN IMMEDIATE` transactions and neither may nest inside the
 * other (SQLite rejects nested BEGIN). The scenario publisher and the capacity
 * guard need exactly ONE short synchronous transaction that spans legacy and
 * automation writes, so every project store shares this helper: a nested call
 * joins the enclosing transaction instead of opening a second one, and the
 * outermost caller owns COMMIT/ROLLBACK.
 *
 * The helper is synchronous on purpose: no awaited work may span a transaction.
 */

const open = new WeakSet();

/** True while `db` has an open transaction owned by this helper. */
export function inTransaction(db) {
  return open.has(db);
}

/**
 * Run `fn` inside an immediate transaction. Nested calls execute `fn` in the
 * caller's transaction (all-or-nothing still holds at the outermost level).
 */
export function withTransaction(db, fn) {
  if (open.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  open.add(db);
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
  } finally {
    open.delete(db);
  }
}

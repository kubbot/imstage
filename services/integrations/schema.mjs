// Additive SQLite schema for the account-owned ChatGPT/MCP connection backend.
//
// This schema is installed into the *existing account API database* (the same
// file that holds `users`, `sessions` and `scenes`). It never creates a second
// product database and never touches the standalone MCP instance database
// (`services/mcp/store.mjs`). Existing accounts keep working: every statement
// is `CREATE TABLE/INDEX IF NOT EXISTS` and no existing row is rewritten.
//
// Tables
//   oauth_clients        dynamically registered public OAuth clients (DCR)
//   oauth_requests       short-lived pending authorization/consent requests
//   oauth_codes          hashed, single-use authorization codes
//   oauth_grants         the connection ("grant family") a token belongs to
//                        (`tools_discovered_at` records a real `tools/list`
//                        success so "connected" is never inferred from login)
//   oauth_tokens         hashed access/refresh tokens, revocable per row
//   mcp_idempotency      per-user idempotency records for account MCP writes
//   mcp_renders          per-user deterministic PNG render cache
//
// Owner scoping: every grant/token/idempotency/render row carries `user_id`
// and every query in `connections.mjs` / `oauth.mjs` / `account-mcp.mjs`
// filters on it, so two accounts can never observe each other's data.

export const INTEGRATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id                 TEXT PRIMARY KEY,
  client_name               TEXT,
  redirect_uris_json        TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  grant_types_json          TEXT NOT NULL,
  response_types_json       TEXT NOT NULL,
  scope                     TEXT,
  client_id_issued_at       INTEGER NOT NULL,
  created_at                TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_requests (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state          TEXT,
  resource       TEXT NOT NULL,
  scopes_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at_ms  INTEGER NOT NULL,
  consumed_at    TEXT,
  user_id        TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_requests_expires ON oauth_requests(expires_at_ms);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT NOT NULL,
  scopes_json    TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  grant_id       TEXT,
  created_at     TEXT NOT NULL,
  expires_at_ms  INTEGER NOT NULL,
  used_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_codes(expires_at_ms);

CREATE TABLE IF NOT EXISTS oauth_grants (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  client_id     TEXT,
  client_name   TEXT NOT NULL,
  resource      TEXT,
  scopes_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  tools_discovered_at TEXT,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash   TEXT PRIMARY KEY,
  grant_id     TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  client_id    TEXT,
  expires_at_ms INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT,
  rotated_at   TEXT,
  replaced_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens(grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);

CREATE TABLE IF NOT EXISTS mcp_idempotency (
  user_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  operation     TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS mcp_renders (
  user_id     TEXT NOT NULL,
  render_id   TEXT NOT NULL,
  scene_id    TEXT,
  revision    INTEGER,
  png_base64  TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  width       INTEGER NOT NULL,
  height      INTEGER NOT NULL,
  title       TEXT NOT NULL,
  output_kind TEXT NOT NULL,
  surface     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, render_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_renders_user_created ON mcp_renders(user_id, created_at DESC);
`;

/**
 * Install the additive integration schema. Safe to call on every startup; it
 * only creates missing objects and performs no data migration.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function installIntegrationSchema(db) {
  db.exec(INTEGRATION_SCHEMA_SQL);
  // Additive migration for databases created before tool-discovery evidence was
  // recorded. `last_used_at` only proves the token was validated; the MCP
  // `tools/list` success is what the UI reports as a fully connected client.
  const grantColumns = db.prepare('PRAGMA table_info(oauth_grants)').all();
  if (!grantColumns.some((column) => column.name === 'tools_discovered_at')) {
    db.exec('ALTER TABLE oauth_grants ADD COLUMN tools_discovered_at TEXT');
  }
}

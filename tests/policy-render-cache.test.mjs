/**
 * Policy regression: pre-policy cached PNG renders are never served again.
 *
 * Both render caches (standalone MCP `renders`, account `mcp_renders`) record
 * the policy version on write and block older blobs on read — non-destructive:
 * rows and scene data remain stored. The actual `imstage://renders/{id}.png`
 * resource read path is covered for both servers.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { openStore, MCP_INSTANCE_ACCOUNT } from '../services/mcp/store.mjs';
import { createImstageMcpServer } from '../services/mcp/server.mjs';
import { createAccountStore } from '../services/integrations/account-mcp.mjs';
import { installIntegrationSchema } from '../services/integrations/schema.mjs';
import { installGenerationAuditSchema, POLICY_VERSION } from '../services/audit/generation-audit.mjs';

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-render-cache-'));
const activeStores = new Set();

after(() => {
  for (const store of activeStores) {
    try { store.close(); } catch { /* ignore */ }
  }
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
});

const PNG_B64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

function renderRecord(renderId) {
  return {
    renderId, sceneId: null, revision: null,
    pngBase64: PNG_B64, sha256: 'c'.repeat(64), bytes: 8,
    width: 100, height: 200, title: '渲染', outputKind: 'screenshot', surface: 'ios',
  };
}

function accountDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  installIntegrationSchema(db);
  installGenerationAuditSchema(db);
  return db;
}

test('standalone MCP render cache: pre-policy blobs are blocked without deletion', () => {
  const dataDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'store-'));
  const store = openStore({ dataDir });
  activeStores.add(store);
  const id = `rnd_${'a'.repeat(32)}`;
  store.saveRender(renderRecord(id));
  assert.ok(store.getRender(id), 'current-policy renders are served');
  assert.equal(store.db.prepare('SELECT policy_version FROM renders WHERE render_id = ?').get(id).policy_version, POLICY_VERSION);

  // Simulate a blob cached before the policy change.
  store.db.prepare('UPDATE renders SET policy_version = NULL WHERE render_id = ?').run(id);
  assert.equal(store.getRender(id), null, 'pre-policy renders are never served');
  const row = store.db.prepare('SELECT COUNT(*) AS n FROM renders WHERE render_id = ?').get(id);
  assert.equal(Number(row.n), 1, 'the row is kept (non-destructive policy)');
  // Scene data is untouched by the render-cache policy.
  store.createScene({ scene: { id: `scn_${'b'.repeat(32)}`, title: '保留作品', messages: [] }, requestHash: 'h' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM scenes').get().n, 1);
});

test('account render cache: pre-policy blobs are blocked without deletion', () => {
  const db = accountDb();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)')
    .run('user-1', 'u1@example.test', 'U1', 'x', new Date().toISOString());
  const store = createAccountStore(db, 'user-1');
  const id = `rnd_${'d'.repeat(32)}`;
  store.saveRender(renderRecord(id));
  assert.ok(store.getRender(id), 'current-policy renders are served');
  assert.equal(db.prepare('SELECT policy_version FROM mcp_renders WHERE render_id = ?').get(id).policy_version, POLICY_VERSION);

  db.prepare('UPDATE mcp_renders SET policy_version = ? WHERE render_id = ?').run('studio-old', id);
  assert.equal(store.getRender(id), null, 'pre-policy renders are never served');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM mcp_renders WHERE render_id = ?').get(id).n), 1, 'row kept');
  // The account scope is enforced by the store; the same account can still
  // list the row while the blob stays unserved.
  assert.equal(createAccountStore(db, 'user-1').getRender(id), null);
  db.close();
});

async function withClient(store, run) {
  const server = createImstageMcpServer({
    store,
    renderService: {},
    logger: { log() {}, warn() {}, error() {} },
    sceneIdFactory: () => crypto.randomUUID(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'render-cache-test', version: '1' });
  await server.connect(st);
  await client.connect(ct);
  try {
    await run(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

test('imstage://renders/{id}.png resource read path blocks pre-policy blobs on both servers', async () => {
  // Standalone MCP server.
  const dataDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'res-'));
  const store = openStore({ dataDir });
  activeStores.add(store);
  const current = `rnd_${'e'.repeat(32)}`;
  const stale = `rnd_${'f'.repeat(32)}`;
  store.saveRender(renderRecord(current));
  store.saveRender(renderRecord(stale));
  store.db.prepare('UPDATE renders SET policy_version = NULL WHERE render_id = ?').run(stale);
  await withClient(store, async (client) => {
    const ok = await client.readResource({ uri: `imstage://renders/${current}.png` });
    assert.ok(ok.contents[0].blob || ok.contents[0].text, 'current render is served');
    await assert.rejects(
      () => client.readResource({ uri: `imstage://renders/${stale}.png` }),
      (error) => /渲染不存在|not found|InvalidParams/i.test(String(error.message)),
      'pre-policy render is blocked on the resource read path',
    );
  });

  // Account MCP server (same resource surface over its own store).
  const db = accountDb();
  db.prepare('INSERT INTO users (id,email,name,password_hash,created_at) VALUES (?,?,?,?,?)')
    .run('user-2', 'u2@example.test', 'U2', 'x', new Date().toISOString());
  const accountStore = createAccountStore(db, 'user-2');
  const aCurrent = `rnd_${'a'.repeat(32)}`;
  const aStale = `rnd_${'b'.repeat(32)}`;
  accountStore.saveRender(renderRecord(aCurrent));
  accountStore.saveRender(renderRecord(aStale));
  db.prepare('UPDATE mcp_renders SET policy_version = NULL WHERE render_id = ?').run(aStale);
  const server = createImstageMcpServer({
    store: accountStore, renderService: {},
    logger: { log() {}, warn() {}, error() {} },
    sceneIdFactory: () => crypto.randomUUID(),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'render-cache-account', version: '1' });
  await server.connect(st);
  await client.connect(ct);
  try {
    const ok = await client.readResource({ uri: `imstage://renders/${aCurrent}.png` });
    assert.ok(ok.contents[0].blob || ok.contents[0].text);
    await assert.rejects(
      () => client.readResource({ uri: `imstage://renders/${aStale}.png` }),
      (error) => /渲染不存在|not found|InvalidParams/i.test(String(error.message)),
    );
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    db.close();
  }
  assert.equal(MCP_INSTANCE_ACCOUNT, 'mcp:instance');
});

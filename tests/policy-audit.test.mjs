/**
 * Policy regression: the hosted generation audit is durable, minimal and
 * actually expires after 90 days.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AUDIT_RETENTION_MS,
  cleanupGenerationAudit,
  hashScene,
  installGenerationAuditSchema,
  listGenerationAudit,
  newRunId,
  recordGenerationAudit,
} from '../services/audit/generation-audit.mjs';
import { openStore } from '../services/mcp/store.mjs';
import { POLICY_VERSION, DISCLOSURE_TEXT } from '../packages/schema/policy.mjs';

const DAY = 24 * 60 * 60 * 1000;

function memoryDb() {
  const db = new DatabaseSync(':memory:');
  installGenerationAuditSchema(db);
  return db;
}

const SCENE = {
  id: 'scn_00000000000000000000000000000001', title: '合成场景', platform: 'imstage', deviceTime: '09:41', date: '', selfId: 'p1',
  participants: [{ id: 'p1', name: '甲' }], messages: [{ id: 'm1', participantId: 'p1', type: 'text', text: '敏感台词 SECRET-LINE', time: '09:41' }], watermark: '',
};

test('audit rows contain exactly the documented metadata, never prompts or content', () => {
  const db = memoryDb();
  const row = recordGenerationAudit(db, { runId: newRunId(), accountId: 'user-1', flow: 'agent', status: 'ok', scene: SCENE });
  assert.match(row.runId, /^run_[0-9a-f-]{36}$/);
  assert.equal(row.accountId, 'user-1');
  assert.equal(row.flow, 'agent');
  assert.equal(row.status, 'ok');
  assert.equal(row.policyVersion, POLICY_VERSION);
  assert.match(row.sceneHash, /^[0-9a-f]{64}$/);
  const dump = JSON.stringify(db.prepare('SELECT * FROM generation_audit').all());
  assert.equal(dump.includes('SECRET-LINE'), false, 'no scene text in the audit');
  assert.equal(dump.includes('SECRET'), false);
  assert.equal(/token|password|api[-_]?key/i.test(dump), false);
});

test('scene hash is deterministic and independent of content order', () => {
  const a = hashScene({ title: 't', messages: [{ text: 'x' }], b: 1 });
  const b = hashScene({ b: 1, messages: [{ text: 'x' }], title: 't' });
  assert.equal(a, b);
  assert.notEqual(a, hashScene({ title: 't', messages: [{ text: 'y' }], b: 1 }));
  assert.equal(hashScene(undefined), null);
});

test('durable 90-day retention: cleanup deletes expired rows and only those', () => {
  const db = memoryDb();
  const now = Date.now();
  recordGenerationAudit(db, { accountId: 'a', flow: 'agent', status: 'ok', scene: SCENE, nowMs: now - (AUDIT_RETENTION_MS + DAY) });
  recordGenerationAudit(db, { accountId: 'a', flow: 'batch', status: 'ok', scene: SCENE, nowMs: now - (AUDIT_RETENTION_MS - DAY) });
  recordGenerationAudit(db, { accountId: 'a', flow: 'mcp_scene', status: 'ok', scene: SCENE, nowMs: now - DAY });
  assert.equal(listGenerationAudit(db).length, 3);

  const removed = cleanupGenerationAudit(db, { nowMs: now });
  assert.equal(removed, 1, 'only the row past 90 days is deleted');
  const left = listGenerationAudit(db);
  assert.equal(left.length, 2);
  assert.equal(left.some((row) => row.flow === 'agent'), false, 'the expired row is really gone');
  // Running cleanup again removes nothing more.
  assert.equal(cleanupGenerationAudit(db, { nowMs: now }), 0);

  // Everything expires once the window passes (real cleanup, not a display filter).
  assert.equal(cleanupGenerationAudit(db, { nowMs: now + AUDIT_RETENTION_MS }), 2);
  assert.equal(listGenerationAudit(db).length, 0);
});

test('the MCP store records durable audit rows for hosted AI-supplied scenes and batches', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imstage-audit-'));
  try {
    const store = openStore({ dataDir });
    const created = store.createScene({ scene: { ...SCENE, id: `scn_${'a'.repeat(32)}` }, requestHash: 'h1', idempotencyKey: 'k1' });
    assert.equal(created.deduplicated, false);
    // A deduplicated retry must not add a second audit row.
    const retry = store.createScene({ scene: { ...SCENE, id: `scn_${'a'.repeat(32)}` }, requestHash: 'h1', idempotencyKey: 'k1' });
    assert.equal(retry.deduplicated, true);
    store.createBatch({
      projectId: 'prj_1', requestHash: 'h2',
      items: [
        { name: 'a', prompt: '生成一段合成对话 SECRET-PROMPT', scene: { ...SCENE, id: `scn_${'b'.repeat(32)}` }, values: {} },
        { name: 'b', prompt: '再来一段', scene: { ...SCENE, id: `scn_${'c'.repeat(32)}` }, values: {} },
      ],
    });

    const rows = store.db.prepare('SELECT * FROM generation_audit').all();
    const flows = rows.map((row) => row.flow).sort();
    assert.deepEqual(flows, ['mcp_batch', 'mcp_batch', 'mcp_scene']);
    for (const row of rows) {
      assert.match(row.scene_hash, /^[0-9a-f]{64}$/);
      assert.equal(row.policy_version, POLICY_VERSION);
      assert.equal(row.account_id, 'mcp:instance');
      assert.ok(row.run_id.startsWith('run_'));
      assert.ok(row.created_ms > Date.now() - DAY);
    }
    // The raw prompt text is never persisted in the audit.
    const dump = JSON.stringify(rows);
    assert.equal(dump.includes('SECRET-PROMPT'), false);
    assert.equal(dump.includes('生成一段合成对话'), false);
    // …and the audit table really exists on disk (durable, not in-memory only).
    store.close();
    const onDisk = new DatabaseSync(path.join(dataDir, 'mcp.sqlite'));
    const diskRows = onDisk.prepare('SELECT COUNT(*) AS n FROM generation_audit').get();
    assert.equal(Number(diskRows.n), 3);
    onDisk.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('policy constants match what the renderers enforce', () => {
  assert.match(DISCLOSURE_TEXT, /AI生成/);
  assert.match(DISCLOSURE_TEXT, /虚构/);
  assert.match(DISCLOSURE_TEXT, /AI-generated/);
});

/**
 * HTTP integration tests for account-scoped reusable templates.
 *
 * Covers ownership isolation, optimistic revisions, list/detail separation,
 * instantiation independence, layout-bearing snapshots and the guarantee that
 * deleting a template never deletes scenes created from it.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { start } from '../services/api/server.mjs';
import { createScene } from '../apps/web/src/studio/model.ts';

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-templates-api-'));
const APP_ORIGIN = 'http://127.0.0.1:4417';
const activeApps = new Set();

after(async () => {
  for (const app of activeApps) {
    try { await app.close(); } catch { /* ignore */ }
  }
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
});

let seq = 0;
const email = (prefix) => `${prefix}-${process.pid}-${++seq}@example.test`;

function headers(cookie, extra = {}) {
  return { 'content-type': 'application/json', origin: APP_ORIGIN, 'x-imstage-request': '1', ...(cookie ? { cookie } : {}), ...extra };
}
function cookieFrom(res) {
  const match = /imstage_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
  return match && match[1] !== '' ? `imstage_session=${match[1]}` : null;
}

async function makeApp() {
  const dir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'case-'));
  const app = await start({
    dbPath: path.join(dir, 'imstage.db'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(dir, 'dist-does-not-exist'),
    logger: { log() {}, error() {} },
    env: {},
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}` };
}

async function register(base, prefix) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: headers(null),
    body: JSON.stringify({ name: '模板验收', email: email(prefix), password: 'synthetic-template-password-2026' }),
  });
  assert.equal(res.status, 200);
  return cookieFrom(res);
}

async function api(base, cookie, route, { method = 'GET', body } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: headers(cookie, method === 'GET' ? {} : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

const definition = (scene = createScene('weekend')) => ({
  name: 'Meetup template',
  description: 'Repeatable meetup',
  scene,
  variables: [
    { key: 'name', label: 'Person', type: 'text', target: { entity: 'participant', id: scene.participants[1].id, field: 'name' } },
    { key: 'reply', label: 'Reply', type: 'text', target: { entity: 'message', id: scene.messages[0].id, field: 'text' } },
  ],
});

test('template CRUD is account-scoped, revision-safe and lists only summaries', async () => {
  const { base } = await makeApp();
  const a = await register(base, 'owner-a');
  const b = await register(base, 'owner-b');
  const scene = createScene('weekend');
  scene.id = 'template-source';

  const created = await api(base, a, '/api/templates', { method: 'POST', body: definition(scene) });
  assert.equal(created.status, 200);
  const id = created.data.item.id;
  assert.equal(created.data.item.revision, 1);
  assert.equal(created.data.item.variableCount, 2);
  assert.equal(created.data.item.definition.scene.id, 'template-source');

  const listed = await api(base, a, '/api/templates');
  assert.equal(listed.status, 200);
  assert.equal(listed.data.items.length, 1);
  assert.equal('definition' in listed.data.items[0], false, 'list responses must not embed heavy snapshots');

  assert.equal((await api(base, b, '/api/templates')).data.items.length, 0, 'another account sees none');
  assert.equal((await api(base, b, `/api/templates/${id}`)).status, 404, 'foreign template id never leaks');
  assert.equal((await api(base, b, `/api/templates/${id}`, { method: 'PUT', body: { revision: 1, ...definition(scene) } })).status, 404);
  assert.equal((await api(base, b, `/api/templates/${id}`, { method: 'DELETE', body: { revision: 1 } })).status, 404);

  const updated = await api(base, a, `/api/templates/${id}`, {
    method: 'PUT',
    body: { revision: 1, ...definition(scene), name: 'Renamed template' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.item.name, 'Renamed template');
  assert.equal(updated.data.item.revision, 2);

  const stale = await api(base, a, `/api/templates/${id}`, { method: 'PUT', body: { revision: 1, ...definition(scene) } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'revision_conflict');

  const removed = await api(base, a, `/api/templates/${id}`, { method: 'DELETE', body: { revision: 2 } });
  assert.equal(removed.status, 200);
  assert.equal((await api(base, a, `/api/templates/${id}`)).status, 404);
});

test('instantiation is independent, never mutates the source, and rejects hostile or invalid values', async () => {
  const { base } = await makeApp();
  const cookie = await register(base, 'instantiate');
  const scene = createScene('weekend');
  scene.id = 'source-scene';
  const person = scene.participants[1].id;
  const message = scene.messages[0].id;
  const created = await api(base, cookie, '/api/templates', { method: 'POST', body: definition(scene) });
  const id = created.data.item.id;
  const frozen = JSON.stringify(created.data.item.definition);

  const first = await api(base, cookie, `/api/templates/${id}/instantiate`, { method: 'POST', body: { values: { name: 'Ava', reply: 'By the window.' } } });
  const second = await api(base, cookie, `/api/templates/${id}/instantiate`, { method: 'POST', body: { values: { name: 'Noah', reply: 'At the entrance.' } } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.data.scene.id, second.data.scene.id);
  assert.notEqual(first.data.scene.id, scene.id);
  assert.equal(first.data.scene.participants.find((p) => p.id === person).name, 'Ava');
  assert.equal(second.data.scene.participants.find((p) => p.id === person).name, 'Noah');
  assert.equal(first.data.scene.messages.find((m) => m.id === message).text, 'By the window.');
  first.data.scene.messages.find((m) => m.id === message).text = 'mutated';
  assert.equal(second.data.scene.messages.find((m) => m.id === message).text, 'At the entrance.');

  assert.equal((await api(base, cookie, `/api/templates/${id}/instantiate`, { method: 'POST', body: { values: { unlisted: 'x' } } })).status, 400);
  assert.equal((await api(base, cookie, `/api/templates/${id}/instantiate`, { method: 'POST', body: { values: { name: 42 } } })).status, 400);
  assert.equal((await api(base, cookie, `/api/templates/${id}/instantiate`, { method: 'POST', body: { values: { reply: 'x'.repeat(4001) } } })).status, 400);
  assert.equal((await api(base, cookie, '/api/templates/not-a-uuid/instantiate', { method: 'POST', body: { values: {} } })).status, 404);

  const reRead = await api(base, cookie, `/api/templates/${id}`);
  assert.equal(JSON.stringify(reRead.data.item.definition), frozen, 'source snapshot never mutates');
  assert.equal(scene.participants.find((p) => p.id === person).name, scene.participants[1].name);
});

test('custom layout survives template creation, listing mode and instantiation', async () => {
  const { base } = await makeApp();
  const cookie = await register(base, 'layout');
  const scene = createScene('weekend');
  scene.id = crypto.randomUUID();
  scene.layout = { kind: 'custom', name: 'Neutral sheet', avatarShape: 'rounded', showAvatars: false, headerBackground: '#101418', background: '#ffffff', textColor: '#111214', bubbleRadius: 14, messageSpacing: 12, headerHeight: 64, maxBubbleWidth: 320, fontFamily: 'serif' };

  const saved = await api(base, cookie, `/api/scenes/${scene.id}`, { method: 'PUT', body: { scene, revision: 0 } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.item.scene.layout.name, 'Neutral sheet');

  const created = await api(base, cookie, '/api/templates', { method: 'POST', body: { ...definition(scene), variables: [] } });
  assert.equal(created.status, 200);
  assert.equal(created.data.item.mode, 'custom');
  assert.equal((await api(base, cookie, '/api/templates')).data.items[0].mode, 'custom');

  const instance = await api(base, cookie, `/api/templates/${created.data.item.id}/instantiate`, { method: 'POST', body: { values: {} } });
  assert.equal(instance.status, 200);
  assert.deepEqual(instance.data.scene.layout, scene.layout);
  assert.notEqual(instance.data.scene.id, scene.id);
});

test('deleting a template keeps scenes created from it', async () => {
  const { base } = await makeApp();
  const cookie = await register(base, 'keep-scenes');
  const scene = createScene('weekend');
  scene.id = 'keep-source';
  const created = await api(base, cookie, '/api/templates', { method: 'POST', body: definition(scene) });
  const id = created.data.item.id;
  const instance = await api(base, cookie, `/api/templates/${id}/instantiate`, { method: 'POST', body: { values: {} } });
  const produced = instance.data.scene;
  assert.equal((await api(base, cookie, `/api/scenes/${produced.id}`, { method: 'PUT', body: { scene: produced, revision: 0 } })).status, 200);
  assert.equal((await api(base, cookie, `/api/templates/${id}`, { method: 'DELETE', body: { revision: 1 } })).status, 200);
  assert.equal((await api(base, cookie, `/api/scenes/${produced.id}`)).status, 200);
});

test('invalid template payloads are rejected atomically without storing rows', async () => {
  const { base } = await makeApp();
  const cookie = await register(base, 'invalid');
  const scene = createScene('weekend');
  const baseDefinition = definition(scene);
  const bad = [
    { ...baseDefinition, name: '' },
    { ...baseDefinition, schemaVersion: 2 },
    { ...baseDefinition, variables: [{ ...baseDefinition.variables[0], key: 'constructor' }] },
    { ...baseDefinition, variables: [{ ...baseDefinition.variables[0], target: { entity: 'participant', id: 'missing', field: 'name' } }] },
    { ...baseDefinition, variables: [{ ...baseDefinition.variables[0] }, { ...baseDefinition.variables[0], key: 'alias' }] },
    { ...baseDefinition, html: '<script/>' },
  ];
  for (const payload of bad) {
    const res = await api(base, cookie, '/api/templates', { method: 'POST', body: payload });
    assert.ok(res.status >= 400, `expected rejection for ${JSON.stringify(payload).slice(0, 60)}`);
  }
  assert.equal((await api(base, cookie, '/api/templates')).data.items.length, 0);
});

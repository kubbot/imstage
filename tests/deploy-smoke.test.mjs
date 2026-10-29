import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { start } from '../services/api/server.mjs';
import { smoke } from '../deploy/smoke.mjs';

test('deployment smoke checks real login, repeated session reads and revocation without changing scenes', async () => {
  const artifacts = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
  await fs.mkdir(artifacts, { recursive: true });
  const dir = await fs.mkdtemp(path.join(artifacts, 'deploy-smoke-'));
  const origin = 'http://127.0.0.1:4417';
  const revision = 'a'.repeat(40);
  const app = await start({ dbPath: path.join(dir, 'imstage.db'), appOrigin: origin, port: 0, env: { IMSTAGE_RELEASE_REVISION: revision }, logger: { log() {}, error() {} } });
  const baseURL = `http://127.0.0.1:${app.port}`;
  const account = { email: 'deployment-smoke@example.com', password: 'fixture-password-12345' };
  try {
    const registered = await fetch(`${baseURL}/api/auth/register`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-imstage-request': '1' }, body: JSON.stringify({ ...account, name: 'Deployment fixture', termsAccepted: true }) });
    assert.equal(registered.status, 200);
    assert.equal((await fetch(`${baseURL}/api/health`)).headers.get('x-imstage-revision'), revision);
    assert.deepEqual(await smoke({ baseURL, origin, expectedRevision: revision, ...account }), { health: 'ready', login: true, session: true, logout: true });
    await assert.rejects(smoke({ baseURL, origin, expectedRevision: 'b'.repeat(40), ...account }), /revision/);
    await assert.rejects(smoke({ baseURL, origin, ...account, password: 'wrong-password' }), /login.*401/);
  } finally {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deployment smoke refuses to send credentials over remote HTTP', async () => {
  await assert.rejects(smoke({ baseURL: 'http://example.com', email: 'fixture@example.com', password: 'fixture-password' }), /HTTPS/);
});

test('deployment smoke CLI never prints private stdin on a JSON parse error', () => {
  const result = spawnSync(process.execPath, ['deploy/smoke.mjs'], { input: 'private-fixture', encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /private-fixture/);
});

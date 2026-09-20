import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CorruptStoreError, Store } from '../src/store.mjs';
import { cleanupDir, tempDataDir } from './helpers.mjs';

function validCase(id, overrides = {}) {
  return {
    id,
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    question: 'hello',
    inputLanguage: 'zh-CN',
    targetIM: 'wechat',
    surface: 'ios',
    outputKind: 'screenshot',
    width: 64,
    height: 64,
    notes: '',
    maxDiffRatio: 0.005,
    synthetic: false,
    attachments: [],
    candidate: null,
    review: null,
    golden: null,
    ...overrides,
  };
}

test('persists mutations and survives a restart', async () => {
  const dir = tempDataDir('store-restart');
  try {
    const first = new Store({ dataDir: dir });
    await first.load();
    await first.mutate((draft) => {
      draft.cases.push(validCase('c1'));
    });
    assert.equal(first.revision, 1);
    assert.equal(first.listCases().length, 1);

    const second = new Store({ dataDir: dir });
    const state = await second.load();
    assert.equal(state.revision, 1);
    assert.equal(second.listCases().length, 1);
    assert.equal(second.getCase('c1').question, 'hello');
  } finally {
    await cleanupDir(dir);
  }
});

test('serializes concurrent mutations without losing writes', async () => {
  const dir = tempDataDir('store-concurrent');
  try {
    const store = new Store({ dataDir: dir });
    await store.load();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.mutate((draft) => {
          draft.cases.push(validCase(`c${i}`));
        }),
      ),
    );
    assert.equal(store.revision, 25);
    assert.equal(store.listCases().length, 25);

    const reloaded = new Store({ dataDir: dir });
    await reloaded.load();
    assert.equal(reloaded.listCases().length, 25);
  } finally {
    await cleanupDir(dir);
  }
});

test('never silently overwrites a corrupt store file', async () => {
  const dir = tempDataDir('store-corrupt');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const storePath = path.join(dir, 'store.json');
    const corruptContent = '{ this is not valid json';
    await fs.promises.writeFile(storePath, corruptContent);
    const store = new Store({ dataDir: dir });
    await assert.rejects(() => store.load(), CorruptStoreError);
    await assert.rejects(
      () => store.mutate((draft) => draft.cases.push({ id: 'x' })),
      CorruptStoreError,
    );
    const after = await fs.promises.readFile(storePath, 'utf8');
    assert.equal(after, corruptContent, '损坏文件必须保持原样');
  } finally {
    await cleanupDir(dir);
  }
});

test('treats an unsupported schema version as corrupt', async () => {
  const dir = tempDataDir('store-schema');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const storePath = path.join(dir, 'store.json');
    const content = JSON.stringify({ schemaVersion: 99, revision: 0, cases: [] });
    await fs.promises.writeFile(storePath, content);
    const store = new Store({ dataDir: dir });
    await assert.rejects(() => store.load(), CorruptStoreError);
    assert.equal(await fs.promises.readFile(storePath, 'utf8'), content);
  } finally {
    await cleanupDir(dir);
  }
});

test('blob storage is content addressed and detects corruption', async () => {
  const dir = tempDataDir('store-blob');
  try {
    const store = new Store({ dataDir: dir });
    await store.load();
    const payload = Buffer.from('synthetic-bytes');
    const { sha256, size } = await store.putBlob(payload);
    assert.equal(size, payload.length);
    assert.equal(await store.hasBlob(sha256), true);
    const fetched = await store.getBlob(sha256);
    assert.ok(fetched.equals(payload));
    assert.equal(await store.getBlob(sha256Hex('missing')), null);

    // Tamper with the stored blob; reads must reject rather than return bad data.
    const blobPath = store.blobPath(sha256);
    await fs.promises.writeFile(blobPath, Buffer.from('tampered'));
    await assert.rejects(() => store.getBlob(sha256), /hash 不匹配/);
  } finally {
    await cleanupDir(dir);
  }
});

test('atomic writes leave no temp files behind', async () => {
  const dir = tempDataDir('store-atomic');
  try {
    const store = new Store({ dataDir: dir });
    await store.load();
    await store.mutate((draft) => draft.cases.push({ id: 'c1' }));
    const entries = await fs.promises.readdir(dir);
    const temps = entries.filter((name) => name.includes('.tmp'));
    assert.deepEqual(temps, []);
    const parsed = JSON.parse(await fs.promises.readFile(path.join(dir, 'store.json'), 'utf8'));
    assert.equal(parsed.cases.length, 1);
  } finally {
    await cleanupDir(dir);
  }
});

test('detects malformed case metadata instead of silently rewriting it', async () => {
  const dir = tempDataDir('store-shape');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const content = JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      updatedAt: 'x',
      cases: [{ id: 'c1', revision: 1, question: 'q', width: 'bad', height: 64, attachments: [], candidate: null }],
    });
    await fs.promises.writeFile(path.join(dir, 'store.json'), content);
    const store = new Store({ dataDir: dir });
    await assert.rejects(() => store.load(), CorruptStoreError);
    await assert.rejects(() => store.mutate((d) => d.cases.push({})), CorruptStoreError);
    assert.equal(await fs.promises.readFile(path.join(dir, 'store.json'), 'utf8'), content);
  } finally {
    await cleanupDir(dir);
  }
});

test('detects duplicate case ids as corruption', async () => {
  const dir = tempDataDir('store-dup');
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const caseShape = {
      id: 'c1',
      revision: 1,
      question: 'q',
      width: 64,
      height: 64,
      attachments: [],
      candidate: null,
    };
    const content = JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      updatedAt: 'x',
      cases: [caseShape, { ...caseShape }],
    });
    await fs.promises.writeFile(path.join(dir, 'store.json'), content);
    const store = new Store({ dataDir: dir });
    await assert.rejects(() => store.load(), /重复/);
  } finally {
    await cleanupDir(dir);
  }
});

test('creates private 0700 directories and 0600 files', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDataDir('store-perm');
  try {
    const store = new Store({ dataDir: dir });
    await store.load();
    await store.mutate((draft) => draft.cases.push({ id: 'c1' }));
    const modeOf = async (p) => ((await fs.promises.stat(p)).mode & 0o777).toString(8);
    assert.equal(await modeOf(dir), '700');
    assert.equal(await modeOf(store.blobsDir), '700');
    assert.equal(await modeOf(path.join(dir, 'store.json')), '600');
    const { sha256 } = await store.putBlob(Buffer.from('private-bytes'));
    assert.equal(await modeOf(store.blobPath(sha256)), '600');
  } finally {
    await cleanupDir(dir);
  }
});

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

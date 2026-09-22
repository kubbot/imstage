import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createEvalServer } from '../server.mjs';
import { REPO_ROOT } from '../src/util.mjs';

const TEST_ROOT = process.env.IMSTAGE_EVAL_TEST_DIR
  ? path.resolve(process.env.IMSTAGE_EVAL_TEST_DIR)
  : path.join(REPO_ROOT, '.local', 'eval-test');

export function tempDataDir(label) {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(TEST_ROOT, `${label}-${unique}`);
}

export async function cleanupDir(dir) {
  if (dir && dir.startsWith(TEST_ROOT)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

export async function launch({ dataDir } = {}) {
  const dir = dataDir ?? tempDataDir('srv');
  await fs.promises.mkdir(dir, { recursive: true });
  const server = createEvalServer({ dataDir: dir, port: 0 });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function request(method, urlPath, body, { headers = {}, omitOrigin = false } = {}) {
    const h = { ...headers };
    if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !omitOrigin && !h.Origin) {
      h.Origin = base;
    }
    const res = await fetch(base + urlPath, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json, headers: res.headers, text };
  }

  // Raw HTTP request so tests can forge Host headers that fetch forbids.
  function rawRequest({ method = 'GET', urlPath = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path: urlPath, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, headers: res.headers, text });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    await cleanupDir(dir);
  }

  return { server, store: server.store, base, port, dataDir: dir, request, rawRequest, close };
}

export const ORIGIN = 'http://127.0.0.1';

// Build a valid case payload for tests.
export function casePayload(overrides = {}) {
  return {
    question: '测试用例：生成一条微信单聊截图',
    inputLanguage: 'zh-CN',
    targetIM: 'wechat',
    surface: 'ios',
    outputKind: 'screenshot',
    width: 64,
    height: 64,
    notes: 'harness',
    maxDiffRatio: 0.005,
    synthetic: false,
    ...overrides,
  };
}

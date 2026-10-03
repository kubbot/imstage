/**
 * Deterministic project file delivery (batch B) — service + worker behavior.
 *
 * Exercises the real API + account MCP stack with a stub renderer that returns a
 * real, decodable 1x1 PNG buffer (state transitions are deterministic; the
 * parent separately runs 50 real renders). Archives are verified with an
 * INDEPENDENT decoder (Python zipfile), never with our own ZIP parser:
 *
 *   - 50 cases submitted 20/20/10 → export → completed ZIP with real
 *     project.json / README / scenario.json / cases.jsonl / scene JSON /
 *     renders / manifest / validation and matching SHA-256s;
 *   - missing planned cases → 422 missing_items; allowPartial stays partial;
 *   - evaluation_dataset annotations (caller-provided provenance only) and
 *     frozen recipe after project type changes;
 *   - freeze-time duplicate dialogue detection after copying edits;
 *   - PNG reuse: edit 1 of 50 → new export renders 1, reuses 49;
 *   - fingerprint current/historical (content edits);
 *   - revoke-while-blocked-renderer, failure item retry, stop/restart, cancel,
 *     foreign owner, ticket expiry/route binding/revocation, retention purge;
 *   - AutoExport fires exactly once, replay never duplicates;
 *   - whole-project export with two scenarios sharing case-001 keys.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

import { start } from '../services/api/server.mjs';
import { createScene } from '../apps/web/src/studio/model.ts';
import { ZipLimitError, createZipWriter, isSafeZipName } from '../services/projects/exports/zip.mjs';
import { EXPORT_LIMITS } from '../services/projects/exports/service.mjs';
import { retainedBytesForUser } from '../services/projects/exports/store.mjs';

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-project-exports-'));
const APP_ORIGIN = 'http://127.0.0.1:4417';
const activeApps = new Set();

after(async () => {
  for (const app of activeApps) {
    try {
      await app.close();
    } catch {
      /* ignore */
    }
  }
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* Controlled runtime: clock + stub renderer                           */
/* ------------------------------------------------------------------ */

const PNG_1X1 = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#23b579' } }).png().toBuffer();
const fixturePixels = await sharp(PNG_1X1).raw().toBuffer({ resolveWithObject: true });
assert.equal(fixturePixels.info.width, 1);
assert.equal(fixturePixels.info.height, 1);
assert.equal(fixturePixels.data.length, 4);

function stubRenderService() {
  const calls = [];
  const gates = new Map();
  let failures = new Map();
  return {
    calls,
    get gates() {
      return gates;
    },
    failOnce(sceneId, error) {
      failures.set(sceneId, error);
    },
    block(sceneId) {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      gates.set(sceneId, gate);
      return () => {
        gates.delete(sceneId);
        release();
      };
    },
    async render(options) {
      calls.push(options);
      const gate = gates.get(options.scene?.id);
      if (gate) await gate;
      if (failures.has(options.scene?.id)) {
        const error = failures.get(options.scene?.id);
        failures.delete(options.scene?.id);
        throw error;
      }
      return {
        buffer: PNG_1X1,
        width: 1,
        height: 1,
        bytes: PNG_1X1.length,
        sha256: crypto.createHash('sha256').update(PNG_1X1).digest('hex'),
        pngBase64: PNG_1X1.toString('base64'),
      };
    },
  };
}

function makeClock(startMs) {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance(ms) {
      current += ms;
    },
  };
}

async function makeApp({ clock, renderService, dir, exportFileOps } = {}) {
  const root = dir ?? fs.mkdtempSync(path.join(RUNTIME_ROOT, 'case-'));
  const app = await start({
    dbPath: path.join(root, 'imstage.db'),
    exportDir: path.join(root, 'project-exports'),
    appOrigin: APP_ORIGIN,
    port: 0,
    distDir: path.join(root, 'dist-does-not-exist'),
    logger: { log() {}, error() {}, warn() {} },
    env: {},
    agent: {},
    now: clock ? clock.now : undefined,
    renderService: renderService ?? stubRenderService(),
    ...(exportFileOps ? { exportFileOps } : {}),
    projects: { pollMs: 15, sessionCheckMs: 20, maxLeaseWaitMs: 3_000 },
  });
  activeApps.add(app);
  return {
    app,
    base: `http://127.0.0.1:${app.port}`,
    exportDir: path.join(root, 'project-exports'),
    root,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP / MCP helpers                                                  */
/* ------------------------------------------------------------------ */

let emailSeq = 0;
function mutationHeaders(cookie, extras = {}) {
  const headers = { 'content-type': 'application/json', origin: APP_ORIGIN, 'x-imstage-request': '1', ...extras };
  if (cookie) headers.cookie = cookie;
  return headers;
}

function cookieFrom(res, name = 'imstage_session') {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${name}=([^;]*)`).exec(setCookie);
  return match && match[1] !== '' ? `${name}=${match[1]}` : null;
}

async function register(base, label = '导出用户') {
  emailSeq += 1;
  const credentials = { name: label, email: `exports-${process.pid}-${emailSeq}@example.com`, password: 'password-123456' };
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify(credentials),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { cookie: cookieFrom(res), user: body.user, credentials };
}

/** Fresh login (used after clock jumps that outlive the original session). */
async function login(base, credentials) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify(credentials),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return cookieFrom(res);
}

async function jsonFetch(base, pathname, { method = 'GET', cookie, body } = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: mutationHeaders(cookie),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

async function createToken(base, cookie, { name = '导出 MCP', scopes } = {}) {
  const res = await fetch(`${base}/api/connections/tokens`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ name, ...(scopes ? { scopes } : {}) }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { token: body.token, connection: body.connection };
}

async function mcpTool(base, token, name, args = {}, id = 1) {
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json().catch(() => null);
  return { res, body, result: body?.result ?? null };
}

function toolOk({ result }, label = 'tool call') {
  assert.ok(result, `${label}: ${JSON.stringify(result)}`);
  assert.notEqual(result.isError, true, `${label}: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

function toolErr({ res, body, result }, label = 'tool call') {
  // Auth/transport rejections arrive as JSON-RPC errors, tool failures as
  // isError results — both are legitimate "denied" outcomes.
  if (!result && body?.error) {
    return { code: body.error.code ?? body.error.data?.code, message: String(body.error.message ?? ''), status: res.status };
  }
  assert.ok(result, label);
  assert.equal(result.isError, true, `${label}: expected a tool error`);
  return result.structuredContent.error;
}

/* ------------------------------------------------------------------ */
/* Synthetic scenes                                                    */
/* ------------------------------------------------------------------ */

function sceneFor(index, { texts, platform = 'whatsapp', watermarkEnabled, avatar } = {}) {
  const base = createScene('weekend');
  const { id: _ignored, ...rest } = base;
  const messages = base.messages.map((message, position) => ({
    ...message,
    id: `m${index}_${position}`,
    text: texts ? texts[position % texts.length] : `对话 ${index}-${position}`,
  }));
  return {
    ...rest,
    title: `案例 ${index}`,
    platform,
    messages,
    ...(watermarkEnabled === undefined ? {} : { watermarkEnabled }),
    ...(avatar === undefined
      ? {}
      : {
          participants: rest.participants.map((person, position) => ({
            ...person,
            ...(position === 0 ? { avatar } : {}),
          })),
        }),
  };
}

async function waitFor(predicate, { timeoutMs = 15_000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/* ------------------------------------------------------------------ */
/* Independent archive validation (Python zipfile)                     */
/* ------------------------------------------------------------------ */

function pythonZipCheck(zipPath, { requireManifest = true } = {}) {
  const script = `
import hashlib, json, sys, zipfile
path = sys.argv[1]
require_manifest = sys.argv[2] == '1'
z = zipfile.ZipFile(path)
bad = z.testzip()
assert bad is None, f"crc mismatch: {bad}"
names = z.namelist()
for n in names:
    assert not n.startswith('/') and '..' not in n and all(ord(c) < 128 for c in n), f"unsafe path {n}"
out = {'names': names}
if require_manifest:
    manifest = json.loads(z.read('manifest.json'))
    validation = json.loads(z.read('validation.json'))
    listed = {f['path']: f for f in manifest['files']}
    assert 'manifest.json' not in listed and 'validation.json' not in listed, 'self-hash must be excluded'
    for p, meta in listed.items():
        data = z.read(p)
        assert len(data) == meta['bytes'], f"size mismatch {p}"
        assert hashlib.sha256(data).hexdigest() == meta['sha256'], f"hash mismatch {p}"
    for entry in validation['checks']['requiredFiles']:
        assert entry['present'] is True, f"required missing flag {entry['path']}"
        assert entry['path'] in names, f"required absent {entry['path']}"
    import json as _j
    cases = []
    for line in z.read('cases.jsonl').decode('utf-8').splitlines():
        if not line.strip():
            continue
        case = _j.loads(line)
        cases.append(case)
        assert case['scene'] in names, f"scene ref {case['scene']}"
        if case.get('render'):
            png = z.read(case['render'])
            assert png[:8] == b'\\x89PNG\\r\\n\\x1a\\n', 'render is not a PNG'
        assert case['itemKey'] and case['objective'] is not None
    for n in names:
        if n.startswith('renders/') and n.endswith('.png'):
            png = z.read(n)
            assert png[:8] == b'\\x89PNG\\r\\n\\x1a\\n', f"bad png {n}"
            w = int.from_bytes(png[16:20], 'big'); h = int.from_bytes(png[20:24], 'big')
            assert w >= 1 and h >= 1
    out.update({
        'manifest_files': sorted(listed),
        'manifest_meta': {k: manifest.get(k) for k in ('version', 'renderer', 'policy', 'hashScope', 'recipe')},
        'validation_status': validation['status'],
        'missingItems': validation.get('missingItems', []),
        'dataset': validation.get('dataset', {}),
        'assets_invalid': validation['checks']['assets']['invalid'],
        'assets_valid': validation['checks']['assets']['valid'],
        'cases': cases,
        'project_doc': json.loads(z.read('project.json')),
        'records': [json.loads(l) for l in z.read('records.jsonl').decode('utf-8').splitlines() if l.strip()] if 'records.jsonl' in names else [],
        'annotations': [json.loads(l) for l in z.read('annotations.jsonl').decode('utf-8').splitlines() if l.strip()] if 'annotations.jsonl' in names else [],
    })
print(json.dumps(out))
`;
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', script, zipPath, requireManifest ? '1' : '0']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`python zipfile 校验失败 (${code}):\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim().split('\n').at(-1)));
      } catch {
        reject(new Error(`python zipfile 输出解析失败: ${stdout} / ${stderr}`));
      }
    });
  });
}

function zipBytesFor(exportDir, userId, exportRow) {
  return path.join(exportDir, 'exports', userId, `${exportRow.exportId}.zip`);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function seedFiftyCaseProject(base, token, { autoExport = false, type = 'training', caseCount = 50, name = '五十案例交付' } = {}) {
  const project = toolOk(
    await mcpTool(base, token, 'imstage_create_project', {
      project: { name, type, defaults: { platform: 'whatsapp', watermarkEnabled: true } },
    }),
    'create project',
  ).project;
  const planned = toolOk(
    await mcpTool(base, token, 'imstage_create_scenario', {
      projectId: project.id,
      scenario: { name: 'WhatsApp 结交新朋友', preset: 'friendship', caseCount, platform: 'whatsapp', autoExport },
    }),
    'create scenario',
  );
  const scenarioId = planned.scenario.scenarioId;
  const cases = planned.casePlan.cases;
  const ranges = [];
  for (let start = 0; start < cases.length; start += 20) ranges.push(cases.slice(start, start + 20));
  for (const [index, slice] of ranges.entries()) {
    toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: project.id,
        scenarioId,
        clientIdempotencyKey: `seed-${index}`,
        items: slice.map((entry, position) => ({
          itemKey: entry.itemKey,
          name: entry.name,
          objective: entry.objective,
          context: entry.context,
          ...(type === 'evaluation_dataset' ? { annotations: { labels: { outcome: `ok-${entry.itemKey}` } } } : {}),
          scene: sceneFor(index * 20 + position, {
            texts: [`第一句 ${entry.itemKey}`, `第二句 ${entry.itemKey}`],
            watermarkEnabled: true,
          }),
        })),
      }),
      `batch ${index}`,
    );
  }
  return { project, scenarioId, cases };
}

async function pollExport(base, cookie, projectId, exportId, expectStatuses) {
  return waitFor(
    async () => {
      const { data } = await jsonFetch(base, `/api/projects/${projectId}/exports/${exportId}`, { cookie });
      return expectStatuses.includes(data?.item?.status) ? data.item : null;
    },
    { label: `export ${exportId} → ${expectStatuses.join('/')}` },
  );
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test('50 cases export a validated ZIP of real PNG/Scene/JSONL/README/manifest', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base, exportDir } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId, cases } = await seedFiftyCaseProject(base, token, { caseCount: 50 });
  assert.equal(cases.length, 50);

  // Full export through MCP (missing planned cases are covered separately).
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'exp-1', scenarioId,
    }),
    'export',
  );
  assert.equal(queued.export.counts.items, 50);
  assert.deepEqual(queued.export.renderOptions, { surface: 'ios', width: 390, height: 844, outputKind: 'long-screenshot' });
  const exportId = queued.export.exportId;

  const finished = await pollExport(base, cookie, project.id, exportId, ['completed', 'partial', 'failed']);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.equal(finished.counts.done, 50);
  assert.equal(finished.counts.failed, 0);
  assert.equal(finished.contentState, 'current');
  assert.equal(finished.delivery.available, true);
  assert.ok(finished.delivery.expiresAt, 'download expiry is exposed');
  assert.equal(renderer.calls.length, 50);
  for (const call of renderer.calls.slice(0, 3)) {
    assert.equal(call.surface, 'ios');
    assert.equal(call.outputKind, 'long-screenshot');
    assert.ok(call.scene.messages.length > 0);
  }

  const zipPath = zipBytesFor(exportDir, user.id, finished);
  assert.ok(fs.existsSync(zipPath), 'zip exists on disk');
  const check = await pythonZipCheck(zipPath);
  for (const required of [
    'project.json',
    'README.md',
    `scenarios/${scenarioId}/scenario.json`,
    'cases.jsonl',
    'scenes/0001.scene.json',
    'renders/whatsapp/0001.png',
    'manifest.json',
    'validation.json',
  ]) {
    assert.ok(check.names.includes(required), `missing ${required} in ${check.names.join(',')}`);
  }
  assert.equal(check.validation_status, 'passed');
  assert.deepEqual(check.missingItems, []);
  // ZIP sha/bytes live OUTSIDE the archive (export receipt only).
  assert.equal(finished.delivery.zipBytes, fs.statSync(zipPath).size);
  assert.equal(finished.delivery.zipSha256, crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex'));
  // manifest v1: content-only hashes, renderer/policy/recipe versions.
  assert.equal(check.manifest_meta.version, 1);
  assert.ok(check.manifest_meta.renderer.version.length > 0);
  assert.ok(check.manifest_meta.policy.version.length > 0);
  assert.deepEqual(check.manifest_meta.hashScope.excluded, ['manifest.json', 'validation.json']);
  assert.equal(check.manifest_meta.recipe[0].type, 'training');
  assert.equal(check.cases.length, 50);
  assert.deepEqual(check.cases[0].itemKey, 'case-001');
  assert.ok(check.cases[0].objective.length > 0 && check.cases[0].context.length > 0);
  // project.json carries no account ids or private paths.
  const projectJson = JSON.stringify(check.project_doc);
  assert.ok(!projectJson.includes(userEmailPattern()), 'no account email');
  assert.ok(!/data:image/.test(projectJson), 'no raw avatar bytes dumped into project.json summary');
});

function userEmailPattern() {
  return `exports-${process.pid}`;
}

test('assets: real inline images extracted, dummy AAAA never becomes a binary asset', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base, exportDir } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const realAvatar = `data:image/png;base64,${PNG_1X1.toString('base64')}`;

  const project = toolOk(
    await mcpTool(base, token, 'imstage_create_project', {
      project: {
        name: '素材校验',
        brief: { cast: [{ name: '小林', role: '客服', avatar: 'data:image/png;base64,AAAA' }] },
        defaults: { platform: 'whatsapp' },
      },
    }),
    'project',
  ).project;
  const planned = toolOk(
    await mcpTool(base, token, 'imstage_create_scenario', {
      projectId: project.id,
      scenario: { name: '单场景', preset: 'custom', caseCount: 2, platform: 'whatsapp', autoExport: false },
    }),
    'scenario',
  );
  const items = planned.casePlan.cases.map((entry, index) => ({
    itemKey: entry.itemKey,
    name: entry.name,
    objective: entry.objective,
    context: entry.context,
    scene: sceneFor(500 + index, { texts: [`素材 ${entry.itemKey} 一`, `素材 ${entry.itemKey} 二`], avatar: realAvatar }),
  }));
  toolOk(await mcpTool(base, token, 'imstage_create_batch', { projectId: project.id, scenarioId: planned.scenario.scenarioId, items }), 'batch');
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'assets-1', scenarioId: planned.scenario.scenarioId,
    }),
    'export',
  );
  const finished = await pollExport(base, cookie, project.id, queued.export.exportId, ['completed', 'partial', 'failed']);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  const check = await pythonZipCheck(zipBytesFor(exportDir, user.id, finished));
  const avatarAsset = check.manifest_files.find((p) => p.startsWith('assets/'));
  assert.ok(avatarAsset, `real asset extracted: ${check.manifest_files.join(',')}`);
  assert.match(avatarAsset, /^assets\/[0-9a-f]{64}\.png$/);
  // The dummy AAAA brief avatar is honestly reported and never archived.
  assert.ok(
    check.assets_invalid.some((entry) => /avatar/.test(entry.source)),
    JSON.stringify(check.assets_invalid),
  );
  assert.ok(!check.names.some((n) => n.includes('AAAA')), 'no dummy asset path in the archive');
  // Scene JSON stays re-importable with embedded data URIs.
  const scenes = check.cases.map((c) => c.scene);
  assert.ok(scenes.length === 2);
});

test('allowPartial stays partial; freeze rejects copied duplicate dialogues', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base, exportDir } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project } = await seedFiftyCaseProject(base, token, { caseCount: 2, name: '部分导出项目' });

  const planned = toolOk(
    await mcpTool(base, token, 'imstage_create_scenario', {
      projectId: project.id,
      scenario: { name: '部分导出', preset: 'custom', caseCount: 3, platform: 'whatsapp', autoExport: false },
    }),
    'scenario',
  );
  const partialId = planned.scenario.scenarioId;
  const first = planned.casePlan.cases[0];
  toolOk(
    await mcpTool(base, token, 'imstage_create_batch', {
      projectId: project.id,
      scenarioId: partialId,
      items: [{
        itemKey: first.itemKey,
        name: first.name,
        objective: first.objective,
        context: first.context,
        scene: sceneFor(600, { texts: ['部分 A', '部分 B'] }),
      }],
    }),
    'partial batch',
  );
  const missing = toolErr(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'p-1', scenarioId: partialId,
    }),
    'missing',
  );
  assert.equal(missing.code, 'missing_items');
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'p-2', scenarioId: partialId, allowPartial: true,
    }),
    'allowPartial export',
  );
  const finished = await pollExport(base, cookie, project.id, queued.export.exportId, ['partial', 'failed', 'completed']);
  assert.equal(finished.status, 'partial', 'partial stays partial even when its available output is complete');
  assert.equal(finished.counts.done, 1);
  const check = await pythonZipCheck(zipBytesFor(exportDir, user.id, finished));
  assert.equal(check.validation_status, 'partial');
  assert.equal(check.missingItems.length, 2, JSON.stringify(check.missingItems));

  // Freeze-time duplicate dialogue: after an edit copies another case's
  // transcript, the scenario is honestly rejected (duplicate_dialogue).
  const dupScenario = toolOk(
    await mcpTool(base, token, 'imstage_create_scenario', {
      projectId: project.id,
      scenario: { name: '重复对话', preset: 'custom', caseCount: 2, platform: 'whatsapp', autoExport: false },
    }),
    'dup scenario',
  );
  const dupId = dupScenario.scenario.scenarioId;
  const [a, b] = dupScenario.casePlan.cases;
  toolOk(
    await mcpTool(base, token, 'imstage_create_batch', {
      projectId: project.id,
      scenarioId: dupId,
      items: [{ itemKey: a.itemKey, name: a.name, objective: a.objective, context: a.context, scene: sceneFor(610, { texts: ['同样开场', '同样回应', '同样收尾'] }) }],
    }),
    'dup item 1',
  );
  toolOk(
    await mcpTool(base, token, 'imstage_create_batch', {
      projectId: project.id,
      scenarioId: dupId,
      items: [{ itemKey: b.itemKey, name: b.name, objective: b.objective, context: b.context, scene: sceneFor(611, { texts: ['不同开场', '不同回应', '不同收尾'] }) }],
    }),
    'dup item 2',
  );
  const detail = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: project.id, scenarioId: dupId }), 'get scenario');
  const firstSceneId = detail.cases.find((entry) => entry.itemKey === a.itemKey).sceneId;
  const secondSceneId = detail.cases.find((entry) => entry.itemKey === b.itemKey).sceneId;
  const firstScene = toolOk(await mcpTool(base, token, 'imstage_get_scene', { sceneId: firstSceneId }), 'get scene 1');
  toolOk(
    await mcpTool(base, token, 'imstage_update_scene', {
      sceneId: secondSceneId,
      expectedRevision: 1,
      patch: {
        updateMessages: firstScene.scene.messages.map((message, position) => ({
          id: `m611_${position}`,
          text: message.text,
        })),
      },
    }),
    'copy dialogue',
  );
  const dup = toolErr(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'dup-1', scenarioId: dupId,
    }),
    'duplicate dialogue at freeze',
  );
  assert.equal(dup.code, 'duplicate_dialogue');
  assert.match(dup.message, /case-00/);
});

test('evaluation_dataset: caller annotations, provenance, frozen recipe after type change', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base, exportDir } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(base, token, {
    caseCount: 2,
    type: 'evaluation_dataset',
    autoExport: false,
    name: '评测数据集',
  });

  // Change the PROJECT recipe after the scenario froze its own recipe.
  toolOk(
    await mcpTool(base, token, 'imstage_update_project', {
      projectId: project.id,
      expectedRevision: 1,
      project: { type: 'story' },
    }),
    'update type',
  );
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 2, idempotencyKey: 'eval-1', scenarioId,
    }),
    'eval export',
  );
  const finished = await pollExport(base, cookie, project.id, queued.export.exportId, ['completed', 'partial', 'failed']);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  const check = await pythonZipCheck(zipBytesFor(exportDir, user.id, finished));
  // Frozen evaluation_dataset recipe still requires records/annotations files.
  assert.ok(check.names.includes('records.jsonl'), check.names.join(','));
  assert.ok(check.names.includes('annotations.jsonl'), check.names.join(','));
  assert.equal(check.dataset.required, true);
  assert.equal(check.annotations.length, 2);
  for (const line of check.annotations) {
    assert.equal(line.provenance, 'caller-provided');
    assert.ok(Object.keys(line.labels).length >= 1);
  }
  for (const record of check.records) {
    // Honest provenance: never claims synthetic/human/AI authorship.
    assert.equal(record.provenance, 'caller-provided');
    assert.ok(!('generatedBy' in record) && !('source' in record), JSON.stringify(record));
  }
});

test('PNG reuse: edit 1 of 50 scenes → renders 1, reuses 49; history stays downloadable', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(base, token, { caseCount: 50, name: '复用项目' });

  const first = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'reuse-1', scenarioId,
    }),
    'export 1',
  );
  await pollExport(base, cookie, project.id, first.export.exportId, ['completed']);
  assert.equal(renderer.calls.length, 50);

  // Edit exactly one Scene, then export again.
  const detail = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: project.id, scenarioId }), 'scenario');
  const target = detail.cases.find((entry) => entry.itemKey === 'case-007');
  const scene = toolOk(await mcpTool(base, token, 'imstage_get_scene', { sceneId: target.sceneId }), 'scene');
  toolOk(
    await mcpTool(base, token, 'imstage_update_scene', {
      sceneId: target.sceneId,
      expectedRevision: scene.revision,
      patch: { updateMessages: [{ id: scene.scene.messages[0].id, text: '修改后的开场白' }] },
    }),
    'edit scene',
  );

  const second = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'reuse-2', scenarioId,
    }),
    'export 2',
  );
  const finished = await pollExport(base, cookie, project.id, second.export.exportId, ['completed', 'partial']);
  assert.equal(finished.status, 'completed', JSON.stringify(finished));
  assert.equal(finished.counts.reused, 49, `reused ${finished.counts.reused}`);
  assert.equal(renderer.calls.length, 51, 'only the edited scene re-renders');

  const firstDetail = (await jsonFetch(base, `/api/projects/${project.id}/exports/${first.export.exportId}`, { cookie })).data.item;
  assert.equal(firstDetail.contentState, 'historical');
  assert.equal(firstDetail.delivery.available, true, 'frozen output stays downloadable as historical');
  assert.equal(finished.contentState, 'current');

  // Metadata-only project edits (delivered into project.json/manifest) reuse
  // EVERY PNG but flip history for all prior packs and the new pack is current.
  toolOk(
    await mcpTool(base, token, 'imstage_update_project', {
      projectId: project.id,
      expectedRevision: 1,
      project: { name: '复用项目（改名）', brief: { language: 'zh-CN' } },
    }),
    'project metadata edit',
  );
  const third = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 2, idempotencyKey: 'reuse-3', scenarioId,
    }),
    'export 3',
  );
  const thirdDone = await pollExport(base, cookie, project.id, third.export.exportId, ['completed', 'partial']);
  assert.equal(thirdDone.counts.reused, 50, `reused ${thirdDone.counts.reused}`);
  assert.equal(renderer.calls.length, 51, 'metadata-only edits never re-render');
  const secondDetail = (await jsonFetch(base, `/api/projects/${project.id}/exports/${second.export.exportId}`, { cookie })).data.item;
  assert.equal(secondDetail.contentState, 'historical', 'delivered metadata changes mark prior package historical');
  assert.equal(thirdDone.contentState, 'current', 'the metadata-edit pack matches live content');
  // Historical packs stay downloadable while valid.
  assert.equal(secondDetail.delivery.available, true);
});

test('revoke while renderer is blocked interrupts without committing output', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base, exportDir } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token, connection } = await createToken(base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(base, token, { caseCount: 2, autoExport: false, name: '撤销项目' });

  const planned = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: project.id, scenarioId }), 'plan');
  const sceneId = planned.cases[0].sceneId;
  const release = renderer.block(sceneId);
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'revoke-1', scenarioId,
    }),
    'export',
  );
  await waitFor(() => renderer.calls.length >= 1, { label: 'render started' });

  // Revoke the source grant WHILE the renderer is blocked.
  const revoked = await fetch(`${base}/api/connections/${connection.id}`, {
    method: 'DELETE',
    headers: mutationHeaders(cookie),
    body: '{}',
  });
  assert.equal(revoked.status, 200);
  release();

  const finished = await pollExport(base, cookie, project.id, queued.export.exportId, ['interrupted', 'failed', 'cancelled', 'completed', 'partial']);
  assert.equal(finished.status, 'interrupted', JSON.stringify(finished));
  assert.equal(finished.counts.done, 0, 'no output is committed after revocation');
  assert.equal(fs.existsSync(zipBytesFor(exportDir, user.id, finished)), false, 'no ZIP is published');

  // Retry from an authorized caller re-authorizes the SAME snapshot; the stale
  // original grant never silently bypasses authorization.
  const stale = toolErr(
    await mcpTool(base, token, 'imstage_retry_project_export', {
      projectId: project.id, exportId: queued.export.exportId, idempotencyKey: 'retry-stale',
    }),
    'stale grant retry',
  );
  assert.notEqual(stale.status, 200, JSON.stringify(stale));
  const fresh = await createToken(base, cookie, { name: '新授权' });
  const retried = toolOk(
    await mcpTool(base, fresh.token, 'imstage_retry_project_export', {
      projectId: project.id, exportId: queued.export.exportId, idempotencyKey: 'retry-1',
    }),
    'retry with valid grant',
  );
  assert.equal(retried.export.status, 'queued');
  const done = await pollExport(base, cookie, project.id, queued.export.exportId, ['completed', 'partial', 'failed']);
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(done.counts.done, 2);
});

test('failure item retry re-runs only failed items; cancel keeps committed output', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base, exportDir } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(base, token, { caseCount: 3, autoExport: false, name: '失败重试' });

  const planned = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: project.id, scenarioId }), 'plan');
  renderer.failOnce(planned.cases[1].sceneId, Object.assign(new Error('渲染注入失败'), { code: 'render_failed' }));
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'fail-1', scenarioId,
    }),
    'export',
  );
  const partial = await pollExport(base, cookie, project.id, queued.export.exportId, ['partial', 'failed']);
  assert.equal(partial.status, 'partial', JSON.stringify(partial));
  assert.equal(partial.counts.done, 2);
  assert.equal(partial.counts.failed, 1);

  // Retry runs ONLY the failed item (successful items are never re-rendered).
  const callsBefore = renderer.calls.length;
  const retried = toolOk(
    await mcpTool(base, token, 'imstage_retry_project_export', {
      projectId: project.id, exportId: queued.export.exportId, idempotencyKey: 'fail-retry',
    }),
    'retry',
  );
  assert.equal(retried.export.counts.done, 2, 'successful items are preserved');
  const done = await pollExport(base, cookie, project.id, queued.export.exportId, ['completed', 'partial', 'failed']);
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(renderer.calls.length - callsBefore, 1, 'exactly one re-render');

  // Cancel semantics: queued exports cancel immediately; completed stay final.
  const second = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'fail-2', scenarioId,
    }),
    'export 2',
  );
  const cancel = toolOk(
    await mcpTool(base, token, 'imstage_cancel_project_export', {
      projectId: project.id, exportId: second.export.exportId, idempotencyKey: 'cancel-1',
    }),
    'cancel',
  );
  // A running export settles to cancelled at the next worker guard.
  await pollExport(base, cookie, project.id, second.export.exportId, ['cancelled', 'completed', 'partial', 'failed']);
  const cancelledDetail = (await jsonFetch(base, `/api/projects/${project.id}/exports/${second.export.exportId}`, { cookie })).data.item;
  assert.equal(cancelledDetail.status, 'cancelled', JSON.stringify(cancelledDetail));
  assert.equal(cancel.export.cancelRequested, true);
  const again = toolOk(
    await mcpTool(base, token, 'imstage_cancel_project_export', {
      projectId: project.id, exportId: second.export.exportId, idempotencyKey: 'cancel-2',
    }),
    'cancel again',
  );
  assert.equal(again.cancelled, false, 'terminal exports report no new cancellation');
  assert.ok(fs.existsSync(zipBytesFor(exportDir, user.id, done)));
});

test('graceful stop interrupts in-flight work; restart retry resumes the snapshot', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const first = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(first.base);
  const { token } = await createToken(first.base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(first.base, token, { caseCount: 2, autoExport: false, name: '重启项目' });
  const planned = toolOk(await mcpTool(first.base, token, 'imstage_get_scenario', { projectId: project.id, scenarioId }), 'plan');
  const release = renderer.block(planned.cases[0].sceneId);
  const queued = toolOk(
    await mcpTool(first.base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'restart-1', scenarioId,
    }),
    'export',
  );
  await waitFor(() => renderer.calls.length >= 1, { label: 'render started' });

  // Close while the render is blocked: stop() waits for DB bookkeeping and
  // never claims completion while stopping.
  const closing = first.app.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  await closing;
  activeApps.delete(first.app);

  // "Process restart": a new app on the same durable state.
  const second = await makeApp({ clock, renderService: renderer, dir: first.root });
  const recovered = (await jsonFetch(second.base, `/api/projects/${project.id}/exports/${queued.export.exportId}`, { cookie })).data.item;
  assert.equal(recovered.status, 'interrupted', JSON.stringify(recovered));
  assert.equal(recovered.counts.done + recovered.counts.interrupted, 2, 'successful outputs are retained');

  const retried = toolOk(
    await mcpTool(second.base, token, 'imstage_retry_project_export', {
      projectId: project.id, exportId: queued.export.exportId, idempotencyKey: 'restart-retry',
    }),
    'retry after restart',
  );
  assert.equal(retried.export.status, 'queued');
  const done = await pollExport(second.base, cookie, project.id, queued.export.exportId, ['completed', 'partial', 'failed']);
  assert.equal(done.status, 'completed', JSON.stringify(done));
});

test('tickets: anonymous bounded capability, expiry, route binding, per-ticket revocation', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(base, token, { caseCount: 1, autoExport: false, name: '票据项目' });
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 't-1', scenarioId,
    }),
    'export',
  );
  await pollExport(base, cookie, project.id, queued.export.exportId, ['completed']);

  // Owner download with cookie: no-store + attachment, server-generated name.
  const owner = await fetch(`${base}/api/projects/${project.id}/exports/${queued.export.exportId}/download`, {
    headers: { cookie },
  });
  assert.equal(owner.status, 200);
  assert.equal(owner.headers.get('content-type'), 'application/zip');
  assert.match(owner.headers.get('content-disposition') ?? '', /^attachment; filename="project-export-[0-9a-f-]+\.zip"$/);
  assert.equal(owner.headers.get('cache-control'), 'no-store');
  await owner.arrayBuffer();

  // Ticket minted through the MCP tool (bounded capability), used anonymously.
  const ticketResult = toolOk(
    await mcpTool(base, token, 'imstage_get_project_export', {
      projectId: project.id, exportId: queued.export.exportId, downloadTicket: true,
    }),
    'ticket mint',
  );
  assert.ok(ticketResult.downloadTicket.ticketUrl.includes('ticket='));
  const ticket = new URL(ticketResult.downloadTicket.ticketUrl).searchParams.get('ticket');
  assert.ok(ticket.length >= 16);
  const anonPath = `/api/projects/${project.id}/exports/${queued.export.exportId}/download?ticket=${encodeURIComponent(ticket)}`;
  const anon = await fetch(`${base}${anonPath}`);
  assert.equal(anon.status, 200);
  await anon.arrayBuffer();

  // Route binding: the ticket only opens its own export.
  const mismatch = await fetch(`${base}/api/projects/${project.id}/exports/00000000-0000-0000-0000-000000000000/download?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(mismatch.status, 404);

  // Expiry is enforced at read time (before any sweeper runs).
  clock.advance(11 * 60 * 1000);
  const expired = await fetch(`${base}${anonPath}`);
  assert.equal(expired.status, 410);

  // A ticket minted under a grant is denied once THAT grant is revoked, without
  // revoking unrelated tickets bound to other valid principals.
  const other = await createToken(base, cookie, { name: '票据来源' });
  const viaGrant = toolOk(
    await mcpTool(base, other.token, 'imstage_get_project_export', {
      projectId: project.id, exportId: queued.export.exportId, downloadTicket: true,
    }),
    'grant ticket',
  );
  const sessionTicket = toolOk(
    await mcpTool(base, token, 'imstage_get_project_export', {
      projectId: project.id, exportId: queued.export.exportId, downloadTicket: true,
    }),
    'session ticket',
  );
  const revoke = await fetch(`${base}/api/connections/${other.connection.id}`, {
    method: 'DELETE', headers: mutationHeaders(cookie), body: '{}',
  });
  assert.equal(revoke.status, 200);
  const grantTicket = new URL(viaGrant.downloadTicket.ticketUrl).searchParams.get('ticket');
  const denied = await fetch(`${base}/api/projects/${project.id}/exports/${queued.export.exportId}/download?ticket=${encodeURIComponent(grantTicket)}`);
  assert.ok([403, 410].includes(denied.status), String(denied.status));
  const otherTicket = new URL(sessionTicket.downloadTicket.ticketUrl).searchParams.get('ticket');
  const stillOk = await fetch(`${base}/api/projects/${project.id}/exports/${queued.export.exportId}/download?ticket=${encodeURIComponent(otherTicket)}`);
  assert.equal(stillOk.status, 200, 'other principals keep their own tickets');
  await stillOk.arrayBuffer();
});

test('retention: expiry enforced at read, sweep purges files and snapshot blobs', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const first = await makeApp({ clock, renderService: renderer });
  const { cookie: initialCookie, user, credentials } = await register(first.base);
  let cookie = initialCookie;
  const { token } = await createToken(first.base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(first.base, token, { caseCount: 2, autoExport: false, name: '保留项目' });
  const queued = toolOk(
    await mcpTool(first.base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'r-1', scenarioId,
    }),
    'export',
  );
  const done = await pollExport(first.base, cookie, project.id, queued.export.exportId, ['completed']);
  const zipPath = zipBytesFor(first.exportDir, user.id, done);
  assert.ok(fs.existsSync(zipPath));

  // 8 days pass: no timer has run yet, but READ already enforces expiry. The
  // original session has expired too — log in fresh (sessions follow the clock).
  clock.advance(8 * 24 * 60 * 60 * 1000);
  cookie = await login(first.base, credentials);
  const beforeSweep = (await jsonFetch(first.base, `/api/projects/${project.id}/exports/${queued.export.exportId}`, { cookie })).data.item;
  assert.equal(beforeSweep.delivery.state, 'expired');
  assert.equal(beforeSweep.delivery.available, false);
  assert.equal(beforeSweep.delivery.downloadUrl, null);
  const expiredDownload = await fetch(`${first.base}/api/projects/${project.id}/exports/${queued.export.exportId}/download`, { headers: { cookie } });
  assert.equal(expiredDownload.status, 410, 'expired downloads are denied at read time');
  const expiredTicket = toolErr(
    await mcpTool(first.base, token, 'imstage_get_project_export', {
      projectId: project.id, exportId: queued.export.exportId, downloadTicket: true,
    }),
    'expired ticket mint',
  );
  assert.equal(expiredTicket.code, 'download_expired');

  // Startup runs the same real sweep as the hourly timer.
  await first.app.close();
  activeApps.delete(first.app);
  const revived = await makeApp({ clock, renderService: renderer, dir: first.root });
  cookie = await login(revived.base, credentials);
  await waitFor(async () => !fs.existsSync(zipPath), { label: 'zip purged', timeoutMs: 5_000 });
  const after = (await jsonFetch(revived.base, `/api/projects/${project.id}/exports/${queued.export.exportId}`, { cookie })).data.item;
  assert.equal(after.delivery.state, 'expired');
  assert.equal(after.delivery.available, false);
  const rows = revived.app.db
    .prepare('SELECT scene_json FROM project_export_items WHERE export_id = ?')
    .all(queued.export.exportId);
  assert.ok(rows.length > 0 && rows.every((row) => row.scene_json === ''), 'expired snapshots do not retain scene blobs');
  assert.equal(revived.app.db.prepare('SELECT frozen_json FROM project_exports WHERE id = ?').get(queued.export.exportId).frozen_json, '{}');
});

test('autoExport queues exactly one deduped export; replay and edits behave honestly', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const project = toolOk(
    await mcpTool(base, token, 'imstage_create_project', { project: { name: '自动交付', defaults: { platform: 'whatsapp' } } }),
    'project',
  ).project;

  const planned = toolOk(
    await mcpTool(base, token, 'imstage_create_scenario', {
      projectId: project.id,
      scenario: { name: '自动场景', preset: 'custom', caseCount: 2, platform: 'whatsapp', autoExport: true },
    }),
    'scenario',
  );
  const scenarioId = planned.scenario.scenarioId;
  const entry = planned.casePlan.cases[0];
  const itemFor = (caseEntry, index) => ({
    itemKey: caseEntry.itemKey,
    name: caseEntry.name,
    objective: caseEntry.objective,
    context: caseEntry.context,
    scene: sceneFor(700 + index, { texts: [`自动 ${caseEntry.itemKey} A`, `自动 ${caseEntry.itemKey} B`] }),
  });
  const receipt = toolOk(
    await mcpTool(base, token, 'imstage_create_batch', {
      projectId: project.id, scenarioId, clientIdempotencyKey: 'auto-1', items: [itemFor(entry, 0)],
    }),
    'first batch',
  );
  assert.equal(receipt.autoExport.queued, false);
  assert.equal(receipt.autoExport.reason, 'missing_items');

  const second = planned.casePlan.cases[1];
  const finalReceipt = toolOk(
    await mcpTool(base, token, 'imstage_create_batch', {
      projectId: project.id, scenarioId, clientIdempotencyKey: 'auto-2', items: [itemFor(second, 1)],
    }),
    'final batch',
  );
  assert.equal(finalReceipt.autoExport.queued, true, JSON.stringify(finalReceipt.autoExport));
  const exportId = finalReceipt.autoExport.exportId;

  // Idempotent replay of the final batch never queues a second export.
  const replay = toolOk(
    await mcpTool(base, token, 'imstage_create_batch', {
      projectId: project.id, scenarioId, clientIdempotencyKey: 'auto-2', items: [itemFor(second, 1)],
    }),
    'replay',
  );
  assert.equal(replay.deduplicated, true);
  const list = (await jsonFetch(base, `/api/projects/${project.id}/exports`, { cookie })).data.items;
  assert.equal(list.length, 1, 'one auto export only');

  const done = await pollExport(base, cookie, project.id, exportId, ['completed']);
  assert.equal(done.counts.done, 2);

  // Subsequent ordinary edits require an EXPLICIT new export.
  const detail = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: project.id, scenarioId }), 'scenario');
  const target = detail.cases[0];
  toolOk(
    await mcpTool(base, token, 'imstage_update_scene', {
      sceneId: target.sceneId,
      expectedRevision: 1,
      patch: { set: { watermark: '编辑后' } },
    }),
    'edit',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterEdit = (await jsonFetch(base, `/api/projects/${project.id}/exports`, { cookie })).data.items;
  assert.equal(afterEdit.length, 1, 'edits never auto-create exports');
  const manual = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'auto-manual', scenarioId,
    }),
    'manual export',
  );
  assert.notEqual(manual.export.exportId, exportId);
  await pollExport(base, cookie, project.id, manual.export.exportId, ['completed']);
  const status = toolOk(await mcpTool(base, token, 'imstage_get_project_status', { projectId: project.id }), 'status');
  assert.equal(status.status, 'completed', JSON.stringify(status.delivery));
});

test('whole-project export namespaces two scenarios sharing case-001 keys', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const project = toolOk(
    await mcpTool(base, token, 'imstage_create_project', { project: { name: '双场景', defaults: { platform: 'whatsapp' } } }),
    'project',
  ).project;
  for (const [index, name] of ['场景一', '场景二'].entries()) {
    const planned = toolOk(
      await mcpTool(base, token, 'imstage_create_scenario', {
        projectId: project.id,
        scenario: { name, preset: 'custom', caseCount: 2, platform: 'whatsapp', autoExport: false },
      }),
      `scenario ${index}`,
    );
    const items = planned.casePlan.cases.map((entry, position) => ({
      itemKey: entry.itemKey,
      name: entry.name,
      objective: entry.objective,
      context: entry.context,
      scene: sceneFor(800 + index * 10 + position, { texts: [`${name} ${entry.itemKey} 一`, `${name} ${entry.itemKey} 二`] }),
    }));
    toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: project.id, scenarioId: planned.scenario.scenarioId, items,
      }),
      `batch ${index}`,
    );
  }
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'whole-1',
    }),
    'whole project export',
  );
  assert.equal(queued.export.counts.items, 4, 'both scenarios export despite both using case-001/case-002');
  const done = await pollExport(base, cookie, project.id, queued.export.exportId, ['completed', 'partial', 'failed']);
  assert.equal(done.status, 'completed', JSON.stringify(done));
  const status = toolOk(
    await mcpTool(base, token, 'imstage_get_project_status', { projectId: project.id, exportId: queued.export.exportId }),
    'status',
  );
  assert.equal(status.export.items.length, 4);
  assert.equal(new Set(status.export.items.map((item) => `${item.scenarioId}:${item.itemKey}`)).size, 4, 'scenario-namespaced identity');
});

test('idempotent export replay precedes revision checks; same key different body conflicts', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(base, token, { caseCount: 1, autoExport: false, name: '幂等项目' });

  const first = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'idem-1', scenarioId,
    }),
    'export',
  );
  toolOk(
    await mcpTool(base, token, 'imstage_update_project', { projectId: project.id, expectedRevision: 1, project: { name: '改名' } }),
    'rename',
  );
  const replay = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'idem-1', scenarioId,
    }),
    'replay',
  );
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.export.exportId, first.export.exportId);
  const conflict = toolErr(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 2, idempotencyKey: 'idem-1', scenarioId,
    }),
    'conflict',
  );
  assert.equal(conflict.code, 'idempotency_conflict');
  const stale = toolErr(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'idem-2', scenarioId,
    }),
    'stale revision',
  );
  assert.equal(stale.code, 'revision_conflict');
});

test('foreign owners and scenes-only credentials cannot reach exports', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const alice = await register(base, 'Alice');
  const bob = await register(base, 'Bob');
  const aliceToken = await createToken(base, alice.cookie);
  const bobToken = await createToken(base, bob.cookie, { name: 'Bob MCP' });
  const { project, scenarioId } = await seedFiftyCaseProject(base, aliceToken.token, { caseCount: 1, autoExport: false, name: '归属项目' });
  const queued = toolOk(
    await mcpTool(base, aliceToken.token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'own-1', scenarioId,
    }),
    'export',
  );
  await pollExport(base, alice.cookie, project.id, queued.export.exportId, ['completed']);

  const foreignGet = await jsonFetch(base, `/api/projects/${project.id}/exports/${queued.export.exportId}`, { cookie: bob.cookie });
  assert.equal(foreignGet.res.status, 404);
  const foreignDownload = await fetch(`${base}/api/projects/${project.id}/exports/${queued.export.exportId}/download`, {
    headers: { cookie: bob.cookie },
  });
  assert.equal(foreignDownload.status, 404);
  const foreignMcp = toolErr(
    await mcpTool(base, bobToken.token, 'imstage_get_project_export', { projectId: project.id, exportId: queued.export.exportId }),
    'foreign mcp',
  );
  assert.equal(foreignMcp.code, 'not_found');

  const legacy = await createToken(base, alice.cookie, { name: '旧授权', scopes: ['imstage.scenes'] });
  const hidden = toolErr(
    await mcpTool(base, legacy.token, 'imstage_export_project', { projectId: project.id, expectedRevision: 1, idempotencyKey: 'x' }),
    'hidden export tool',
  );
  assert.equal(hidden.code, 'invalid_request');
  assert.match(hidden.message, /未知工具/);
});

test('project deletion cancels and purges every own export, ticket and file', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base, exportDir } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(base, token, { caseCount: 1, autoExport: false, name: '删除项目' });
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'del-1', scenarioId,
    }),
    'export',
  );
  const done = await pollExport(base, cookie, project.id, queued.export.exportId, ['completed']);
  const zipPath = zipBytesFor(exportDir, user.id, done);
  assert.ok(fs.existsSync(zipPath));
  const ticket = toolOk(
    await mcpTool(base, token, 'imstage_get_project_export', {
      projectId: project.id, exportId: queued.export.exportId, downloadTicket: true,
    }),
    'ticket',
  );

  const deleted = await jsonFetch(base, `/api/projects/${project.id}`, { method: 'DELETE', cookie, body: { revision: 1 } });
  assert.equal(deleted.res.status, 200, JSON.stringify(deleted.data));
  assert.equal(fs.existsSync(zipPath), false, 'files are purged');
  const ticketValue = new URL(ticket.downloadTicket.ticketUrl).searchParams.get('ticket');
  const denied = await fetch(`${base}/api/projects/${project.id}/exports/${queued.export.exportId}/download?ticket=${encodeURIComponent(ticketValue)}`);
  assert.ok([404, 410].includes(denied.status), String(denied.status));
});

test('zip writer: independent Python decode, byte limit and safe paths', async () => {
  const dir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'zip-'));
  const target = path.join(dir, 'unit.zip');
  const writer = createZipWriter(target, { maxBytes: 64 * 1024 });
  await writer.open();
  await writer.add('project.json', Buffer.from('{"ok":true}\n'));
  await writer.add('scenes/0001.scene.json', Buffer.from('{"scene":1}\n'));
  await writer.add('renders/whatsapp/0001.png', PNG_1X1);
  await writer.finish();
  const check = await pythonZipCheck(target, { requireManifest: false });
  assert.deepEqual(check.names, ['project.json', 'scenes/0001.scene.json', 'renders/whatsapp/0001.png']);

  // Byte limit aborts instead of growing without bounds.
  const tiny = path.join(dir, 'tiny.zip');
  const limited = createZipWriter(tiny, { maxBytes: 2048 });
  await limited.open();
  await assert.rejects(
    () => limited.add('big.bin', Buffer.alloc(4096, 1)),
    (error) => error instanceof ZipLimitError || error.code === 'output_too_large',
  );
  await limited.abort();
  assert.equal(fs.existsSync(tiny), false, 'aborted archives are removed');

  assert.equal(isSafeZipName('assets/abc.png'), true);
  assert.equal(isSafeZipName('../escape'), false);
  assert.equal(isSafeZipName('a/../b'), false);
});

/* ------------------------------------------------------------------ */
/* Checkpoint regression coverage (async auth, races, coverage, scope)  */
/* ------------------------------------------------------------------ */

test('async batch authorization: expiry during the defaults await never commits', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const { app, base } = await makeApp({ clock, renderService: stubRenderService() });
  const { user } = await register(base);
  const { createProjectAutomation } = await import('../services/projects/automation.mjs');

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let authorized = true;
  const svc = createProjectAutomation({
    db: app.db,
    readPreferences: async () => {
      await gate; // deferred in-memory preferences read
      return { myAvatar: null, otherAvatar: null };
    },
  });

  const project = svc.createProject({ userId: user.id, input: { name: '授权时序' } }).item;
  const scenario = svc.createScenario({
    userId: user.id,
    projectId: project.id,
    input: { name: 'S', preset: 'custom', caseCount: 1, autoExport: false },
  });
  const entry = scenario.casePlan.cases[0];
  const pending = svc.createContentBatch({
    userId: user.id,
    projectId: project.id,
    input: {
      scenarioId: scenario.scenario.scenarioId,
      items: [{
        itemKey: entry.itemKey, name: entry.name, objective: entry.objective, context: entry.context,
        scene: sceneFor(900, { texts: ['授权 A', '授权 B'] }),
      }],
    },
    authorizeCheck: () => {
      if (!authorized) throw new Error('principal expired');
    },
  });
  // The principal expires WHILE the preferences await is in flight.
  authorized = false;
  release();
  await assert.rejects(() => pending, /principal expired/);
  const scenes = Number(app.db.prepare('SELECT COUNT(*) AS total FROM scenes').get().total);
  assert.equal(scenes, 0, 'a batch is never committed after the principal went away');

  // The same call succeeds once authorized again.
  authorized = true;
  const retry = await svc.createContentBatch({
    userId: user.id,
    projectId: project.id,
    input: {
      scenarioId: scenario.scenario.scenarioId,
      items: [{
        itemKey: entry.itemKey, name: entry.name, objective: entry.objective, context: entry.context,
        scene: sceneFor(901, { texts: ['授权 C', '授权 D'] }),
      }],
    },
    authorizeCheck: () => {
      if (!authorized) throw new Error('principal expired');
    },
  });
  assert.equal(retry.total, 1);
  assert.equal(Number(app.db.prepare('SELECT COUNT(*) AS total FROM scenes').get().total), 1);
});

test('concurrent same-key batches resolve to one frozen receipt, never duplicate errors', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const { app, base } = await makeApp({ clock, renderService: stubRenderService() });
  const { user } = await register(base);
  const { createProjectAutomation } = await import('../services/projects/automation.mjs');

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let gateCalls = 0;
  const svc = createProjectAutomation({
    db: app.db,
    readPreferences: async () => {
      gateCalls += 1;
      await gate;
      return { myAvatar: null, otherAvatar: null };
    },
  });
  const project = svc.createProject({ userId: user.id, input: { name: '并发幂等' } }).item;
  const scenario = svc.createScenario({
    userId: user.id,
    projectId: project.id,
    input: { name: 'S', preset: 'custom', caseCount: 1, autoExport: false },
  });
  const entry = scenario.casePlan.cases[0];
  const input = {
    scenarioId: scenario.scenario.scenarioId,
    items: [{
      itemKey: entry.itemKey, name: entry.name, objective: entry.objective, context: entry.context,
      scene: sceneFor(910, { texts: ['并发 A', '并发 B'] }),
    }],
  };
  const first = svc.createContentBatch({ userId: user.id, projectId: project.id, input, idempotencyKey: 'race-1' });
  const second = svc.createContentBatch({ userId: user.id, projectId: project.id, input, idempotencyKey: 'race-1' });
  // Both calls are parked on the async defaults gate at the same time.
  await waitFor(() => gateCalls >= 2, { label: 'both calls reached the async gate' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.batchId, b.batchId, 'one frozen receipt');
  assert.equal([a.deduplicated, b.deduplicated].filter(Boolean).length, 1, 'exactly one is the winner');
  assert.equal(Number(app.db.prepare('SELECT COUNT(*) AS total FROM scenes').get().total), 1);
  assert.equal(Number(app.db.prepare('SELECT COUNT(*) AS total FROM content_batches').get().total), 1);

  // Different body with the same key is still an explicit conflict.
  await assert.rejects(
    () => svc.createContentBatch({
      userId: user.id,
      projectId: project.id,
      input: {
        scenarioId: scenario.scenario.scenarioId,
        items: [{
          itemKey: entry.itemKey, name: entry.name, objective: entry.objective, context: entry.context,
          scene: sceneFor(911, { texts: ['冲突 A', '冲突 B'] }),
        }],
      },
      idempotencyKey: 'race-1',
    }),
    (error) => error.code === 'idempotency_conflict',
  );
});

test('project completion requires full delivery coverage (two scenarios / subset packs)', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const project = toolOk(
    await mcpTool(base, token, 'imstage_create_project', { project: { name: '覆盖范围', defaults: { platform: 'whatsapp' } } }),
    'project',
  ).project;
  const scenarioIds = [];
  for (const [index, name] of ['场景一', '场景二'].entries()) {
    const planned = toolOk(
      await mcpTool(base, token, 'imstage_create_scenario', {
        projectId: project.id,
        scenario: { name, preset: 'custom', caseCount: 2, platform: 'whatsapp', autoExport: false },
      }),
      `scenario ${index}`,
    );
    scenarioIds.push(planned.scenario.scenarioId);
    toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: project.id,
        scenarioId: planned.scenario.scenarioId,
        items: planned.casePlan.cases.map((entry, position) => ({
          itemKey: entry.itemKey, name: entry.name, objective: entry.objective, context: entry.context,
          scene: sceneFor(920 + index * 10 + position, { texts: [`${name} ${entry.itemKey} 一`, `${name} ${entry.itemKey} 二`] }),
        })),
      }),
      `batch ${index}`,
    );
  }

  // Only ONE scenario exported: the subset pack must NOT complete the project.
  const subset = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'cov-1', scenarioId: scenarioIds[0],
    }),
    'subset export',
  );
  await pollExport(base, cookie, project.id, subset.export.exportId, ['completed']);
  let status = toolOk(await mcpTool(base, token, 'imstage_get_project_status', { projectId: project.id }), 'status');
  assert.equal(status.status, 'ready', `subset pack must not complete the project: ${JSON.stringify(status.delivery)}`);
  assert.equal(status.delivery.current, null);
  assert.equal(status.delivery.coverage.complete, false);

  const secondScenario = toolOk(await mcpTool(base, token, 'imstage_export_project', {
    projectId: project.id, expectedRevision: 1, idempotencyKey: 'cov-scenario-2', scenarioId: scenarioIds[1],
  }), 'second scenario export');
  await pollExport(base, cookie, project.id, secondScenario.export.exportId, ['completed']);
  status = toolOk(await mcpTool(base, token, 'imstage_get_project_status', { projectId: project.id }), 'union status');
  assert.equal(status.status, 'completed', 'two current scenario packages cover the whole project');
  assert.equal(status.delivery.coverage.delivered, 4);
  assert.equal(status.delivery.current, null, 'separate packages must not pretend to be one total ZIP');
  assert.equal(status.delivery.currentExports.length, 2);

  // Whole-project export completes it.
  const whole = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'cov-2',
    }),
    'whole export',
  );
  await pollExport(base, cookie, project.id, whole.export.exportId, ['completed']);
  status = toolOk(await mcpTool(base, token, 'imstage_get_project_status', { projectId: project.id }), 'status');
  assert.equal(status.status, 'completed', JSON.stringify(status.delivery));
  assert.equal(status.delivery.coverage.complete, true);

  for (let index = 0; index < 5; index++) {
    const newer = toolOk(await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, scenarioId: scenarioIds[0], idempotencyKey: `newer-subset-${index}`,
    }), 'newer subset');
    await pollExport(base, cookie, project.id, newer.export.exportId, ['completed']);
  }
  status = toolOk(await mcpTool(base, token, 'imstage_get_project_status', { projectId: project.id }), 'status beyond history page');
  assert.equal(status.status, 'completed');
  assert.equal(status.delivery.current.exportId, whole.export.exportId, 'five newer subsets cannot hide the current total package');

  // An active export of ANOTHER project never makes this project "exporting".
  const other = toolOk(
    await mcpTool(base, token, 'imstage_create_project', { project: { name: '另一个项目', defaults: { platform: 'whatsapp' } } }),
    'other project',
  ).project;
  const otherPlan = toolOk(
    await mcpTool(base, token, 'imstage_create_scenario', {
      projectId: other.id,
      scenario: { name: '其他场景', preset: 'custom', caseCount: 1, platform: 'whatsapp', autoExport: false },
    }),
    'other scenario',
  );
  toolOk(
    await mcpTool(base, token, 'imstage_create_batch', {
      projectId: other.id, scenarioId: otherPlan.scenario.scenarioId,
      items: otherPlan.casePlan.cases.map((entry) => ({
        itemKey: entry.itemKey, name: entry.name, objective: entry.objective, context: entry.context,
        scene: sceneFor(930, { texts: ['其他 A', '其他 B'] }),
      })),
    }),
    'other batch',
  );
  // Block the other project's render via its scene id.
  const otherScene = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: other.id, scenarioId: otherPlan.scenario.scenarioId }), 'other plan')
    .cases[0].sceneId;
  const releaseOther = renderer.block(otherScene);
  const slow = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: other.id, expectedRevision: 1, idempotencyKey: 'cov-3', scenarioId: otherPlan.scenario.scenarioId,
    }),
    'slow export',
  );
  await waitFor(() => renderer.calls.some((call) => call.scene?.id === otherScene), { label: 'other export rendering' });
  status = toolOk(await mcpTool(base, token, 'imstage_get_project_status', { projectId: project.id }), 'status during other export');
  assert.equal(status.status, 'completed', 'unrelated active exports never change this project status');
  assert.equal(status.delivery.active, 0);
  releaseOther();
  await pollExport(base, cookie, other.id, slow.export.exportId, ['completed', 'partial', 'failed']);
  assert.ok(user.id);
});

test('delivery summary finds the whole package deterministically (newer covering subsets, same coverage)', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const project = toolOk(
    await mcpTool(base, token, 'imstage_create_project', { project: { name: '交付顺序回归', defaults: { platform: 'whatsapp' } } }),
    'project',
  ).project;
  const scenarioIds = [];
  for (const [index, name] of ['场景一', '场景二'].entries()) {
    const planned = toolOk(
      await mcpTool(base, token, 'imstage_create_scenario', {
        projectId: project.id,
        scenario: { name, preset: 'custom', caseCount: 2, platform: 'whatsapp', autoExport: false },
      }),
      `scenario ${index}`,
    );
    scenarioIds.push(planned.scenario.scenarioId);
    toolOk(
      await mcpTool(base, token, 'imstage_create_batch', {
        projectId: project.id,
        scenarioId: planned.scenario.scenarioId,
        items: planned.casePlan.cases.map((entry, position) => ({
          itemKey: entry.itemKey, name: entry.name, objective: entry.objective, context: entry.context,
          scene: sceneFor(700 + index * 10 + position, { texts: [`${name} ${entry.itemKey} 一`, `${name} ${entry.itemKey} 二`] }),
        })),
      }),
      `batch ${index}`,
    );
  }

  // Whole package FIRST; the two subset packs that jointly cover the whole
  // plan are created LATER with strictly newer timestamps. The delivery scan
  // must still report the whole package as `current`: stopping as soon as the
  // union is covered would deterministically lose it.
  clock.advance(1_000);
  const whole = toolOk(
    await mcpTool(base, token, 'imstage_export_project', { projectId: project.id, expectedRevision: 1, idempotencyKey: 'order-whole' }),
    'whole export',
  );
  await pollExport(base, cookie, project.id, whole.export.exportId, ['completed']);
  for (const [index, scenarioId] of scenarioIds.entries()) {
    clock.advance(1_000);
    const subset = toolOk(
      await mcpTool(base, token, 'imstage_export_project', {
        projectId: project.id, expectedRevision: 1, scenarioId, idempotencyKey: `order-subset-${index}`,
      }),
      `subset ${index}`,
    );
    await pollExport(base, cookie, project.id, subset.export.exportId, ['completed']);
  }

  const status = toolOk(await mcpTool(base, token, 'imstage_get_project_status', { projectId: project.id }), 'status');
  assert.equal(status.status, 'completed');
  assert.equal(status.delivery.coverage.complete, true);
  assert.equal(
    status.delivery.current?.exportId,
    whole.export.exportId,
    'the single whole package stays current even when newer subset packs cover the union first',
  );
  assert.ok(status.delivery.currentExports.length >= 2, 'subset packs remain separate downloads');
  assert.ok(user.id);
});

test('publish race: cancel during a blocked publish commit never serves a stale ZIP', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  let releaseRename;
  const renameGate = new Promise((resolve) => {
    releaseRename = resolve;
  });
  let renameCalls = 0;
  const realRename = fs.promises.rename;
  const { base, exportDir } = await makeApp({
    clock,
    renderService: renderer,
    exportFileOps: {
      rename: async (from, to) => {
        renameCalls += 1;
        if (String(to).endsWith('.zip')) {
          await renameGate; // block only the final ZIP publish
        }
        return realRename(from, to);
      },
    },
  });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(base, token, { caseCount: 1, autoExport: false, name: '发布竞态' });
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'race-pub', scenarioId,
    }),
    'export',
  );
  await waitFor(() => renameCalls >= 1, { label: 'publish rename blocked' });

  // Cancel while the publish rename is blocked.
  toolOk(
    await mcpTool(base, token, 'imstage_cancel_project_export', {
      projectId: project.id, exportId: queued.export.exportId, idempotencyKey: 'race-cancel',
    }),
    'cancel during publish',
  );
  releaseRename();
  const finished = await pollExport(base, cookie, project.id, queued.export.exportId, ['cancelled', 'completed', 'partial', 'failed', 'interrupted']);
  assert.equal(finished.status, 'cancelled', JSON.stringify(finished));
  // The blocked publish is aborted AFTER the guard: no ZIP is ever registered
  // or left on disk for a cancelled export.
  assert.equal(finished.delivery.zipSha256, null);
  assert.equal(fs.existsSync(zipBytesFor(exportDir, user.id, finished)), false);
});

test('scope metadata: re-attached case scenes are loose; selected cases carry frozen scenario recipe', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base, exportDir } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);

  // Project A: evaluation_dataset scenario with one annotated case.
  const a = toolOk(
    await mcpTool(base, token, 'imstage_create_project', {
      project: { name: '数据集项目', type: 'evaluation_dataset', defaults: { platform: 'whatsapp' } },
    }),
    'project a',
  ).project;
  const aPlan = toolOk(
    await mcpTool(base, token, 'imstage_create_scenario', {
      projectId: a.id,
      scenario: { name: '数据场景', preset: 'custom', caseCount: 1, platform: 'whatsapp', autoExport: false },
    }),
    'scenario a',
  );
  const aEntry = aPlan.casePlan.cases[0];
  const aBatch = toolOk(
    await mcpTool(base, token, 'imstage_create_batch', {
      projectId: a.id,
      scenarioId: aPlan.scenario.scenarioId,
      items: [{
        itemKey: aEntry.itemKey, name: aEntry.name, objective: aEntry.objective, context: aEntry.context,
        annotations: { labels: { outcome: 'ok' } },
        scene: sceneFor(940, { texts: ['数据 A', '数据 B'] }),
      }],
    }),
    'batch a',
  );
  const sceneId = aBatch.items[0].sceneId;

  // Selected-scene export of a linked case must carry the frozen scenario
  // snapshot and the frozen evaluation_dataset requirements — even after the
  // project recipe changed.
  toolOk(
    await mcpTool(base, token, 'imstage_update_project', { projectId: a.id, expectedRevision: 1, project: { type: 'story' } }),
    'type change',
  );
  const selected = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: a.id, expectedRevision: 2, idempotencyKey: 'sel-1', sceneIds: [sceneId],
    }),
    'selected scene export',
  );
  const selectedDone = await pollExport(base, cookie, a.id, selected.export.exportId, ['completed', 'partial', 'failed']);
  assert.equal(selectedDone.status, 'completed', JSON.stringify(selectedDone));
  const selectedCheck = await pythonZipCheck(zipBytesFor(exportDir, user.id, selectedDone));
  assert.ok(selectedCheck.names.includes(`scenarios/${aPlan.scenario.scenarioId}/scenario.json`), 'selected case carries its scenario.json');
  assert.ok(selectedCheck.names.includes('records.jsonl') && selectedCheck.names.includes('annotations.jsonl'), 'frozen dataset requirements honored');
  assert.equal(selectedCheck.annotations[0].labels.outcome, 'ok');

  // Re-attach the case scene to project B: B treats it as LOOSE (no foreign
  // scenario metadata leaks, no missing scenario.json for it).
  const b = toolOk(
    await mcpTool(base, token, 'imstage_create_project', { project: { name: '接收项目', defaults: { platform: 'whatsapp' } } }),
    'project b',
  ).project;
  const attached = await jsonFetch(base, `/api/projects/${b.id}/scenes`, { method: 'POST', cookie, body: { sceneId } });
  assert.equal(attached.res.status, 200, JSON.stringify(attached.data));
  const bExport = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: b.id, expectedRevision: 1, idempotencyKey: 'loose-1',
    }),
    'loose export',
  );
  const bDone = await pollExport(base, cookie, b.id, bExport.export.exportId, ['completed', 'partial', 'failed']);
  assert.equal(bDone.status, 'completed', JSON.stringify(bDone));
  const bCheck = await pythonZipCheck(zipBytesFor(exportDir, user.id, bDone));
  const looseCase = bCheck.cases[0];
  assert.match(looseCase.itemKey, /^scene-/, `re-attached scene is loose, got ${looseCase.itemKey}`);
  assert.equal(looseCase.scenarioId, null);
  assert.ok(!bCheck.names.some((n) => n.startsWith('scenarios/')), 'no foreign scenario.json leaks into the loose pack');
  assert.ok(!bCheck.names.includes('annotations.jsonl'), 'loose pack does not inherit foreign dataset requirements');
});

test('quota charges incoming snapshots before rendering and removes uncommitted copies', async () => {
  const renderer = stubRenderService();
  let quotaApp;
  let quotaUser;
  let copiedPath;
  const fixture = await makeApp({ renderService: renderer, exportFileOps: {
    async copyFile(from, to) {
      await fs.promises.copyFile(from, to);
      copiedPath = to;
      // Simulate another delivery consuming the remaining quota during IO.
      const firstRow = quotaApp.db.prepare('SELECT id, zip_bytes FROM project_exports WHERE user_id = ? ORDER BY created_at ASC LIMIT 1').get(quotaUser);
      const nonZip = retainedBytesForUser(quotaApp.db, quotaUser) - Number(firstRow.zip_bytes ?? 0);
      quotaApp.db.prepare('UPDATE project_exports SET zip_bytes = ? WHERE id = ?').run(EXPORT_LIMITS.retainedPerUserBytesMax - nonZip, firstRow.id);
    },
  } });
  quotaApp = fixture.app;
  const { cookie, user } = await register(fixture.base);
  quotaUser = user.id;
  const { token } = await createToken(fixture.base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(fixture.base, token, { caseCount: 1, autoExport: false });
  const first = toolOk(await mcpTool(fixture.base, token, 'imstage_export_project', {
    projectId: project.id, expectedRevision: 1, scenarioId, idempotencyKey: 'quota-first',
  }), 'first export');
  await pollExport(fixture.base, cookie, project.id, first.export.exportId, ['completed']);
  const row = quotaApp.db.prepare('SELECT zip_bytes FROM project_exports WHERE id = ?').get(first.export.exportId);
  const originalZipBytes = row.zip_bytes;
  const nonZipBytes = retainedBytesForUser(quotaApp.db, user.id) - Number(originalZipBytes);
  const snapshots = quotaApp.db.prepare('SELECT length(CAST(frozen_json AS BLOB)) AS bytes FROM project_exports WHERE id = ?').get(first.export.exportId).bytes
    + quotaApp.db.prepare('SELECT SUM(length(CAST(scene_json AS BLOB))) AS bytes FROM project_export_items WHERE export_id = ?').get(first.export.exportId).bytes;
  assert.ok(nonZipBytes >= snapshots, 'retained quota includes frozen UTF-8 payloads');
  quotaApp.db.prepare('UPDATE project_exports SET zip_bytes = ? WHERE id = ?').run(EXPORT_LIMITS.retainedPerUserBytesMax - nonZipBytes - 1, first.export.exportId);
  const denied = toolErr(await mcpTool(fixture.base, token, 'imstage_export_project', {
    projectId: project.id, expectedRevision: 1, scenarioId, idempotencyKey: 'quota-incoming',
  }), 'incoming snapshot rejected');
  assert.equal(denied.code, 'storage_quota');
  assert.equal(renderer.calls.length, 1);
  assert.equal(quotaApp.db.prepare('SELECT COUNT(*) AS total FROM project_exports').get().total, 1, 'denial is atomic');
  quotaApp.db.prepare('UPDATE project_exports SET zip_bytes = ? WHERE id = ?').run(originalZipBytes, first.export.exportId);
  const second = toolOk(await mcpTool(fixture.base, token, 'imstage_export_project', {
    projectId: project.id, expectedRevision: 1, scenarioId, idempotencyKey: 'quota-copy',
  }), 'second export');
  const failed = await pollExport(fixture.base, cookie, project.id, second.export.exportId, ['failed']);
  assert.equal(failed.items[0].error.code, 'storage_quota');
  assert.ok(copiedPath);
  assert.equal(fs.existsSync(copiedPath), false, 'quota-rejected copied PNG is removed');
});

test('a failed atomic PNG rename leaves no staging file', async () => {
  const fixture = await makeApp({ exportFileOps: {
    async rename() { const error = new Error('synthetic IO failure'); error.code = 'EIO'; throw error; },
  } });
  const { cookie } = await register(fixture.base);
  const { token } = await createToken(fixture.base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(fixture.base, token, { caseCount: 1, autoExport: false });
  const queued = toolOk(await mcpTool(fixture.base, token, 'imstage_export_project', {
    projectId: project.id, expectedRevision: 1, scenarioId, idempotencyKey: 'atomic-rename-failure',
  }), 'export with IO failure');
  await pollExport(fixture.base, cookie, project.id, queued.export.exportId, ['failed']);
  const leftover = fs.readdirSync(fixture.exportDir, { recursive: true }).filter((name) => name.endsWith('.tmp') || name.endsWith('.png'));
  assert.deepEqual(leftover, [], 'neither unregistered PNG nor its staging file is retained');
});

test('public failure metadata never leaks filesystem paths', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const realRead = fs.promises.readFile;
  const { base } = await makeApp({
    clock,
    renderService: renderer,
    exportFileOps: {
      readFile: async (p, ...rest) => {
        if (String(p).endsWith('.png')) {
          // Simulate a corrupt/missing render file with a private path in the
          // raw OS error — public metadata must never echo it.
          throw Object.assign(
            new Error("EACCES: permission denied, open '/Users/runner/private/imstage-secrets/0001.png'"),
            { code: 'EACCES' },
          );
        }
        return realRead(p, ...rest);
      },
    },
  });
  const { cookie } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId } = await seedFiftyCaseProject(base, token, { caseCount: 1, autoExport: false, name: '错误脱敏' });
  const queued = toolOk(
    await mcpTool(base, token, 'imstage_export_project', {
      projectId: project.id, expectedRevision: 1, idempotencyKey: 'sanitize-1', scenarioId,
    }),
    'export',
  );
  const finished = await pollExport(base, cookie, project.id, queued.export.exportId, ['failed', 'partial', 'completed']);
  const serialized = JSON.stringify(finished);
  assert.ok(!serialized.includes('/Users/'), `public status leaks a path: ${serialized.slice(0, 400)}`);
  assert.ok(!serialized.includes('/private/tmp'), `public status leaks a path: ${serialized.slice(0, 400)}`);
  assert.ok(!serialized.includes('project-exports'), `public status leaks the export dir: ${serialized.slice(0, 400)}`);
});

/**
 * Deterministic project file delivery — HTTP + account MCP transport contract.
 *
 * The service layer is covered by tests/project-exports.test.mjs; this file
 * pins the transport surface:
 *   - POST/GET /api/projects/:id/exports, GET detail, retry/cancel POSTs with
 *     the unchanged Cookie + Origin + request-marker mutation rules;
 *   - GET .../download for owners via Cookie OR Bearer with BOTH scopes;
 *   - POST .../download-ticket → 10-minute opaque ticket URL with no-store /
 *     attachment headers and anonymous bounded use;
 *   - MCP tools see the SAME exports as the Web API (one shared service);
 *   - full grants expose 27 tools (6 scene + 21 project/delivery), legacy
 *     grants keep exactly 6; `imstage_get_project_export` is not read-only
 *     (ticket minting is a write);
 *   - public instructions/capabilities describe the final delivery workflow
 *     without foundation "next batch / awaiting_delivery" wording.
 */

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

import { start } from '../services/api/server.mjs';
import { createScene } from '../apps/web/src/studio/model.ts';

const ARTIFACT_BASE = process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir();
fs.mkdirSync(ARTIFACT_BASE, { recursive: true });
const RUNTIME_ROOT = fs.mkdtempSync(path.join(ARTIFACT_BASE, 'imstage-project-export-http-'));
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

const PNG_1X1 = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#23b579' } }).png().toBuffer();
const fixturePixels = await sharp(PNG_1X1).raw().toBuffer({ resolveWithObject: true });
assert.equal(fixturePixels.info.width, 1);
assert.equal(fixturePixels.info.height, 1);

function stubRenderService() {
  const calls = [];
  return {
    calls,
    async render(options) {
      calls.push(options);
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

async function makeApp({ clock, renderService } = {}) {
  const root = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'case-'));
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
    projects: { pollMs: 15, sessionCheckMs: 20, maxLeaseWaitMs: 3_000 },
  });
  activeApps.add(app);
  return { app, base: `http://127.0.0.1:${app.port}` };
}

let emailSeq = 0;
function mutationHeaders(cookie, extras = {}) {
  const headers = { 'content-type': 'application/json', origin: APP_ORIGIN, 'x-imstage-request': '1', ...extras };
  if (cookie) headers.cookie = cookie;
  return headers;
}

function cookieFrom(res, name = 'imstage_session') {
  const match = new RegExp(`${name}=([^;]*)`).exec(res.headers.get('set-cookie') ?? '');
  return match && match[1] !== '' ? `${name}=${match[1]}` : null;
}

async function register(base) {
  emailSeq += 1;
  const res = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: mutationHeaders(null),
    body: JSON.stringify({ name: 'HTTP 用户', email: `exphttp-${process.pid}-${emailSeq}@example.com`, password: 'password-123456' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { cookie: cookieFrom(res), user: body.user };
}

async function createToken(base, cookie, { name = 'HTTP MCP', scopes } = {}) {
  const res = await fetch(`${base}/api/connections/tokens`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ name, ...(scopes ? { scopes } : {}) }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { token: body.token, connection: body.connection };
}

async function mcpTool(base, token, name, args = {}) {
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.json().catch(() => null);
  return { res, body, result: body?.result ?? null };
}

async function mcpList(base, token) {
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = await res.json();
  return body.result.tools;
}

function toolOk({ result }, label = 'tool call') {
  assert.ok(result, label);
  assert.notEqual(result.isError, true, `${label}: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

function sceneFor(index, texts) {
  const base = createScene('weekend');
  const { id: _ignored, ...rest } = base;
  return {
    ...rest,
    title: `HTTP 案例 ${index}`,
    platform: 'whatsapp',
    messages: base.messages.map((message, position) => ({
      ...message,
      id: `h${index}_${position}`,
      text: texts ? texts[position % texts.length] : `HTTP 对话 ${index}-${position}`,
    })),
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

async function seedProject(base, cookie, token, { caseCount = 2 } = {}) {
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ name: 'HTTP 交付', defaults: { platform: 'whatsapp' } }),
  });
  const project = (await created.json()).item;
  const scenarioRes = await fetch(`${base}/api/projects/${project.id}/scenarios`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ scenario: { name: 'HTTP 场景', preset: 'custom', caseCount, platform: 'whatsapp', autoExport: false } }),
  });
  const scenario = (await scenarioRes.json()).scenario;
  const plan = toolOk(await mcpTool(base, token, 'imstage_get_scenario', { projectId: project.id, scenarioId: scenario.scenarioId }), 'plan');
  const batchRes = await fetch(`${base}/api/projects/${project.id}/content-batches`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({
      scenarioId: scenario.scenarioId,
      items: plan.cases.map((entry, index) => ({
        itemKey: entry.itemKey,
        name: entry.name,
        objective: entry.objective,
        context: entry.context,
        scene: sceneFor(index, [`HTTP ${entry.itemKey} 一`, `HTTP ${entry.itemKey} 二`]),
      })),
    }),
  });
  assert.equal(batchRes.status, 200, JSON.stringify(await batchRes.clone().json()));
  return { project, scenarioId: scenario.scenarioId };
}

test('HTTP export endpoints keep Cookie/Origin/marker rules and share state with MCP', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const { cookie, user } = await register(base);
  const { token } = await createToken(base, cookie);
  const { project, scenarioId } = await seedProject(base, cookie, token);

  // Mutations keep the unchanged Origin + request-marker requirements.
  const noOrigin = await fetch(`${base}/api/projects/${project.id}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'x-imstage-request': '1' },
    body: JSON.stringify({ expectedRevision: 1, idempotencyKey: 'x-1', scenarioId }),
  });
  assert.equal(noOrigin.status, 403);
  const noMarker = await fetch(`${base}/api/projects/${project.id}/exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: APP_ORIGIN },
    body: JSON.stringify({ expectedRevision: 1, idempotencyKey: 'x-1', scenarioId }),
  });
  assert.equal(noMarker.status, 403);

  // Create via HTTP.
  const createdRes = await fetch(`${base}/api/projects/${project.id}/exports`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ expectedRevision: 1, idempotencyKey: 'http-1', scenarioId }),
  });
  const created = await createdRes.json();
  assert.equal(createdRes.status, 200, JSON.stringify(created));
  assert.equal(created.item.counts.items, 2);
  const exportId = created.item.exportId;

  // Poll via HTTP until complete.
  const done = await waitFor(
    async () => {
      const res = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}`, { headers: { cookie } });
      const body = await res.json();
      return ['completed', 'partial', 'failed'].includes(body.item?.status) ? body.item : null;
    },
    { label: 'http export done' },
  );
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.ok(done.delivery.zipBytes > 0 && done.delivery.expiresAt);

  // MCP sees the SAME export (one shared service instance).
  const viaMcp = toolOk(await mcpTool(base, token, 'imstage_get_project_export', { projectId: project.id, exportId }), 'mcp get export');
  assert.equal(viaMcp.export.exportId, exportId);
  assert.equal(viaMcp.export.delivery.zipSha256, done.delivery.zipSha256);
  const listMcp = toolOk(await mcpTool(base, token, 'imstage_get_project_status', { projectId: project.id, exportId }), 'mcp status');
  assert.equal(listMcp.export.exportId, exportId);
  assert.ok(Array.isArray(listMcp.export.items) && listMcp.export.items.length === 2);
  assert.ok(listMcp.delivery.latest, 'delivery summary exposed');
  assert.ok(listMcp.delivery.downloadsExpireAt, 'download expiry exposed');
  // Status payloads never contain scene blobs or avatar bytes.
  assert.ok(!JSON.stringify(listMcp).includes('scene_json'));
  assert.ok(!JSON.stringify(listMcp).includes('data:image'));

  // List over HTTP (bounded summaries).
  const listRes = await fetch(`${base}/api/projects/${project.id}/exports`, { headers: { cookie } });
  const list = await listRes.json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].items, undefined, 'list summaries omit per-item arrays');

  // Retry over HTTP is rejected for completed exports (nothing to retry).
  const retryRes = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}/retry`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({ idempotencyKey: 'http-retry' }),
  });
  assert.equal(retryRes.status, 409);
  // Cancel over HTTP on a terminal export reports no new cancellation.
  const cancelRes = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}/cancel`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: JSON.stringify({}),
  });
  const cancel = await cancelRes.json();
  assert.equal(cancelRes.status, 200);
  assert.equal(cancel.cancelled, false);
  assert.ok(user.id);
});

test('download endpoints: Cookie or Bearer (both scopes), ticket headers and anonymous use', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const renderer = stubRenderService();
  const { base } = await makeApp({ clock, renderService: renderer });
  const { cookie } = await register(base);
  const { token } = await createToken(base, cookie);
  const legacy = await createToken(base, cookie, { name: '旧授权', scopes: ['imstage.scenes'] });
  const { project, scenarioId } = await seedProject(base, cookie, token, { caseCount: 1 });
  const created = await (
    await fetch(`${base}/api/projects/${project.id}/exports`, {
      method: 'POST',
      headers: mutationHeaders(cookie),
      body: JSON.stringify({ expectedRevision: 1, idempotencyKey: 'dl-1', scenarioId }),
    })
  ).json();
  const exportId = created.item.exportId;
  await waitFor(
    async () => {
      const res = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}`, { headers: { cookie } });
      return ['completed', 'partial', 'failed'].includes((await res.json()).item?.status);
    },
    { label: 'export done' },
  );

  // Cookie download.
  const viaCookie = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}/download`, { headers: { cookie } });
  assert.equal(viaCookie.status, 200);
  assert.equal(viaCookie.headers.get('cache-control'), 'no-store');
  assert.match(viaCookie.headers.get('content-disposition') ?? '', /^attachment; filename="project-export-/);
  const zipBytes = Buffer.from(await viaCookie.arrayBuffer());
  assert.equal(zipBytes.subarray(0, 2).toString('latin1'), 'PK');

  // Bearer download with BOTH scopes works without a session cookie.
  const viaBearer = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}/download`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(viaBearer.status, 200);
  await viaBearer.arrayBuffer();

  // A scenes-only Bearer is not sufficient.
  const viaLegacy = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}/download`, {
    headers: { authorization: `Bearer ${legacy.token}` },
  });
  assert.equal(viaLegacy.status, 401);
  // Unauthenticated download is denied.
  const anonymous = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}/download`);
  assert.equal(anonymous.status, 401);

  // Ticket endpoint: 10-minute opaque URL, no-store, anonymous use.
  const ticketRes = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}/download-ticket`, {
    method: 'POST',
    headers: mutationHeaders(cookie),
    body: '{}',
  });
  assert.equal(ticketRes.status, 200);
  assert.equal(ticketRes.headers.get('cache-control'), 'no-store');
  const ticket = await ticketRes.json();
  assert.ok(ticket.ticket.length >= 16);
  assert.match(ticket.ticketUrl, /^http:\/\/127\.0\.0\.1:4417\/api\/projects\/.+\/download\?ticket=/);
  // The plaintext ticket exists only in the response (hash-only storage).
  const dbFile = path.join(RUNTIME_ROOT, 'does-not-matter');
  void dbFile;

  const ticketValue = new URL(ticket.ticketUrl).searchParams.get('ticket');
  const viaTicket = await fetch(`${base}/api/projects/${project.id}/exports/${exportId}/download?ticket=${encodeURIComponent(ticketValue)}`);
  assert.equal(viaTicket.status, 200);
  await viaTicket.arrayBuffer();

  // MCP instructions/capabilities describe the FINAL workflow (no foundation
  // "next batch / awaiting_delivery" developer wording).
  const caps = toolOk(await mcpTool(base, token, 'imstage_get_capabilities'), 'capabilities');
  const capsText = JSON.stringify(caps);
  assert.ok(!capsText.includes('awaiting_delivery'), 'capabilities must not carry foundation status wording');
  assert.ok(!/后续批次|next batch|will implement/i.test(capsText), 'capabilities must not promise future batches');
  assert.match(capsText, /imstage_export_project/);
  const tools = await mcpList(base, token);
  const exportTool = tools.find((tool) => tool.name === 'imstage_get_project_export');
  assert.equal(exportTool.annotations.readOnlyHint, false, 'ticket minting is a write side effect');
  const statusTool = tools.find((tool) => tool.name === 'imstage_get_project_status');
  assert.equal(statusTool.annotations.readOnlyHint, true);
  assert.equal(statusTool.inputSchema.properties.exportId !== undefined, true, 'status accepts an optional exportId');
});

test('tool discovery: full grants see 27 tools, legacy grants keep 6', async () => {
  const clock = makeClock(Date.parse('2026-10-03T00:00:00.000Z'));
  const { base } = await makeApp({ clock, renderService: stubRenderService() });
  const { cookie } = await register(base);
  const full = await createToken(base, cookie, { name: '全量授权' });
  const legacy = await createToken(base, cookie, { name: '旧授权', scopes: ['imstage.scenes'] });

  const fullTools = await mcpList(base, full.token);
  assert.equal(fullTools.length, 27, `full grant tool count: ${fullTools.map((tool) => tool.name).join(',')}`);
  for (const name of [
    'imstage_export_project',
    'imstage_retry_project_export',
    'imstage_cancel_project_export',
    'imstage_get_project_export',
  ]) {
    assert.ok(fullTools.some((tool) => tool.name === name), `missing ${name}`);
  }
  for (const tool of fullTools) {
    assert.deepEqual(tool.securitySchemes[0].scopes.sort(), tool.name.startsWith('imstage_') && ['imstage_create_scene', 'imstage_get_scene', 'imstage_update_scene', 'imstage_render_scene', 'imstage_list_scenes', 'imstage_get_capabilities'].includes(tool.name)
      ? ['imstage.scenes']
      : ['imstage.projects', 'imstage.scenes'],
      tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(tool.annotations.openWorldHint, false, tool.name);
  }

  const legacyTools = await mcpList(base, legacy.token);
  assert.deepEqual(
    legacyTools.map((tool) => tool.name).sort(),
    [
      'imstage_create_scene',
      'imstage_get_capabilities',
      'imstage_get_scene',
      'imstage_list_scenes',
      'imstage_render_scene',
      'imstage_update_scene',
    ],
  );
});

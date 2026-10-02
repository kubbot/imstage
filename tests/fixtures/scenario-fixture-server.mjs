/**
 * Isolated fixture entry for the Web Project → Scenario → Cases UI suite.
 *
 * Starts the REAL API server with a controlled Agent runtime (scripted
 * provider returning structured `create_scene` mutations per frozen case key —
 * no paid provider, no credentials, no network) plus a deterministic stub
 * renderer, on its own port and its own temporary database/export directory
 * under the registered artifact root. This is test-only: production startup
 * never exposes a fake-model switch.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { start } from '../../services/api/server.mjs';
import { createScene } from '../../apps/web/src/studio/model.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Runs end only when OUR create_scene tool result arrives (never bare role=tool). */
const OWN_TOOL_PREFIX = 'fx-scene-';

function finalResponse() {
  return { content: '已生成。', toolCalls: [], finishReason: 'stop' };
}

function toolResponse(name, args, id) {
  return { content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], finishReason: 'tool_calls' };
}

export function controlledCaseProvider() {
  const calls = [];
  return {
    calls,
    async complete({ messages }) {
      const text = messages.map((message) => (typeof message?.content === 'string' ? message.content : '')).join('\n');
      const key = /【案例编号】(case-\d+)/.exec(text)?.[1] ?? `case-${String(calls.length).padStart(3, '0')}`;
      calls.push(key);
      if (messages.some((message) => message?.role === 'tool' && String(message?.tool_call_id ?? '').startsWith(OWN_TOOL_PREFIX))) {
        return finalResponse();
      }
      const castLine = /【人物】([^\n]+)/.exec(text)?.[1] ?? '';
      const castNames = castLine
        .split('；')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .map((entry) => entry.replace(/（[^）]*）/g, ''));
      const scene = createScene('weekend');
      scene.title = `案例 ${key}`;
      const others = scene.participants.filter((participant) => participant.id !== scene.selfId);
      const renamed = new Map();
      castNames.forEach((name, index) => {
        if (others[index]) renamed.set(others[index].id, name);
      });
      scene.participants = scene.participants.map((participant) =>
        (participant.id !== scene.selfId && renamed.has(participant.id)
          ? { ...participant, name: renamed.get(participant.id), avatar: undefined }
          : participant),
      );
      for (let index = others.length; index < castNames.length; index += 1) {
        const template = others[0] ?? scene.participants[0];
        scene.participants.push({ ...template, id: `p-cast-${index + 1}`, name: castNames[index], avatar: undefined });
      }
      scene.messages = scene.messages.map((message, index) => ({ ...message, text: `独特对话 ${key} #${index}` }));
      return toolResponse('create_scene', { scene }, `${OWN_TOOL_PREFIX}${calls.length}`);
    },
  };
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export function stubRenderService() {
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function startScenarioFixture({ distDir = path.join(REPO_ROOT, 'dist') } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const root = fs.mkdtempSync(path.join(process.env.IMSTAGE_ARTIFACT_DIR || os.tmpdir(), 'imstage-scenario-fixture-'));
  const provider = controlledCaseProvider();
  const app = await start({
    dbPath: path.join(root, 'imstage.db'),
    exportDir: path.join(root, 'project-exports'),
    appOrigin: base,
    port,
    host: '127.0.0.1',
    distDir,
    env: {},
    logger: { log() {}, error() {}, warn() {} },
    agent: {
      chatProvider: provider,
      limits: { activeGlobal: 8, activePerUser: 4, rate: { windowMs: 60_000, max: 5_000, maxKeys: 1_000 } },
    },
    renderService: stubRenderService(),
    projects: { pollMs: 50, sessionCheckMs: 100, maxLeaseWaitMs: 5_000 },
  });
  return {
    app,
    provider,
    base,
    root,
    async close() {
      await app.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// Account-owned MCP surface served at /api/mcp inside the existing API process.
//
// The tools are the *same* definitions and handlers as the standalone
// instance-only MCP server (`services/mcp/server.mjs`), filtered to the account
// flow and backed by an owner-scoped store adapter over the Web `scenes` table.
// Instance projects/templates/batches are never advertised here.
//
// Guarantees:
//   - every row touched carries the authenticated `users.id`
//   - scene ids are Web-compatible UUIDs, so `/#/workspace?scene=<id>` opens the
//     same saved scene and the Web list/get endpoints see MCP writes
//   - results include `webUrl` for create/get/update/render
//   - list responses are bounded and omit full scene JSON / render blobs
//   - deterministic rendering only; no model or image provider is called
//   - inline asset data URIs, revisions, idempotency keys and the PNG cache are
//     all owner-scoped (a render id collision across accounts cannot leak)

import crypto from 'node:crypto';

import { MAX_SCENES_PER_USER } from '../projects/model.mjs';
import { assertSceneCapacity } from '../projects/capacity.mjs';
import { createImstageMcpServer, TOOL_DEFINITIONS } from '../mcp/server.mjs';
import { buildCapabilities } from '../mcp/scene.mjs';
import { applySceneDefaults, sceneDefaultsSummary, recordEvent } from '../preferences/index.mjs';
import { fail } from '../mcp/errors.mjs';
import { integerField, rejectUnknownKeys } from '../mcp/args.mjs';
import { MAX_STORED_RENDERS } from '../mcp/limits.mjs';
import { newRunId as newAuditRunId, recordGenerationAudit, isCurrentPolicyVersion, POLICY_VERSION } from '../audit/generation-audit.mjs';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { SCENE_SCOPE, SUPPORTED_SCOPES, hasScopes } from './scopes.mjs';
import { ACCOUNT_PROJECT_TOOLS, PROJECT_TOOL_SCOPES, createAccountProjectHandlers } from './account-projects.mjs';
import { isUniqueConstraintError, withTransaction } from './util.mjs';

export const ACCOUNT_MCP_SERVER_NAME = 'imstage-account-mcp';
export const ACCOUNT_MCP_SERVER_VERSION = '0.1.0';

const SCENE_QUERY_LIMIT_MAX = 50;

/* ------------------------------------------------------------------ */
/* Owner-scoped store adapter                                          */
/* ------------------------------------------------------------------ */

/**
 * Implement the MCP store interface over the account `scenes` table (and a
 * private owner-scoped idempotency/render cache). This is intentionally a
 * narrow adapter, not a second scene model: it stores exactly the JSON produced
 * by the shared `validateScene` contract, the same JSON the Web app reads.
 */
export function createAccountStore(db, userId, { maxStoredRenders = MAX_STORED_RENDERS } = {}) {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('createAccountStore 需要账号 id');
  }

  function readIdempotent(key, operation, requestHash) {
    if (!key) return null;
    const row = db
      .prepare('SELECT operation, request_hash, response_json FROM mcp_idempotency WHERE user_id = ? AND key = ?')
      .get(userId, key);
    if (!row) return null;
    if (row.operation !== operation || row.request_hash !== requestHash) {
      fail('idempotency_conflict', '该 idempotencyKey 已用于不同的请求内容', {
        details: { idempotencyKey: key, operation: row.operation },
        recovery: '换一个新的 idempotencyKey 重试；重试同一操作时必须复用完全相同的请求体。',
        status: 409,
      });
    }
    return JSON.parse(row.response_json);
  }

  function writeIdempotent(key, operation, requestHash, response, nowMs) {
    if (!key) return;
    db.prepare(
      `INSERT INTO mcp_idempotency (user_id, key, operation, request_hash, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO NOTHING`,
    ).run(userId, key, operation, requestHash, JSON.stringify(response), new Date(nowMs).toISOString());
  }

  /** Durable generation audit (metadata only) for AI-supplied scene content.
   *  Runs inside the caller's transaction: a failed audit fails the write. */
  function auditGeneration(scene, sceneHash = null) {
    recordGenerationAudit(db, {
      runId: newAuditRunId(),
      accountId: userId,
      flow: 'account_mcp',
      status: 'ok',
      scene,
      sceneHash,
    });
  }

  return {
    get userId() {
      return userId;
    },

    findIdempotentResponse(key, operation, requestHash) {
      return readIdempotent(key, operation, requestHash);
    },

    rememberIdempotent(key, operation, requestHash, response) {
      if (!key) return response;
      return withTransaction(db, () => {
        const prior = readIdempotent(key, operation, requestHash);
        if (prior) return prior;
        writeIdempotent(key, operation, requestHash, response, Date.now());
        return response;
      });
    },

    createScene({ scene, requestHash, idempotencyKey = null, nowMs = Date.now() }) {
      const result = withTransaction(db, () => {
        const existing = readIdempotent(idempotencyKey, 'create_scene', requestHash);
        if (existing) return { ...existing, deduplicated: true };
        // Shared capacity guard: real scenes + active scenario generation
        // reservations count toward the account limit in every create path.
        try {
          assertSceneCapacity(db, userId, 1);
        } catch {
          fail('storage_limit', `每个账号最多保存 ${MAX_SCENES_PER_USER} 个作品（含生成中占用）`, { status: 429 });
        }
        const updatedAt = new Date(nowMs).toISOString();
        try {
          db.prepare(
            `INSERT INTO scenes (user_id, id, title, platform, message_count, revision, scene_json, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
          ).run(userId, scene.id, scene.title, scene.platform, scene.messages.length, JSON.stringify(scene), updatedAt);
        } catch (error) {
          if (isUniqueConstraintError(error)) {
            fail('scene_exists', `场景 id 已存在：${scene.id}`, { details: { sceneId: scene.id }, status: 409 });
          }
          throw error;
        }
        const response = { sceneId: scene.id, revision: 1, updatedAt };
        writeIdempotent(idempotencyKey, 'create_scene', requestHash, response, nowMs);
        // Mandatory audit row, atomically with the scene write.
        auditGeneration(scene);
        return { ...response, deduplicated: false };
      });
      return result;
    },

    updateScene({ sceneId, expectedRevision, scene, requestHash, idempotencyKey = null, nowMs = Date.now() }) {
      const result = withTransaction(db, () => {
        const existing = readIdempotent(idempotencyKey, 'update_scene', requestHash);
        if (existing) return { ...existing, deduplicated: true };
        const row = db
          .prepare('SELECT revision FROM scenes WHERE user_id = ? AND id = ?')
          .get(userId, sceneId);
        if (!row) {
          fail('scene_not_found', `场景不存在：${sceneId}`, { details: { sceneId }, status: 404 });
        }
        const currentRevision = Number(row.revision);
        if (currentRevision !== expectedRevision) {
          fail('revision_conflict', `场景已被更新：期望 revision ${expectedRevision}，当前 ${currentRevision}`, {
            details: { sceneId, expectedRevision, currentRevision },
            recovery: `调用 imstage_get_scene 读取 revision ${currentRevision}，重新应用 patch 后用 expectedRevision=${currentRevision} 重试。`,
            status: 409,
          });
        }
        const updatedAt = new Date(nowMs).toISOString();
        const result = db
          .prepare(
            `UPDATE scenes
             SET title = ?, platform = ?, message_count = ?, revision = revision + 1, scene_json = ?, updated_at = ?
             WHERE user_id = ? AND id = ? AND revision = ?`,
          )
          .run(
            scene.title,
            scene.platform,
            scene.messages.length,
            JSON.stringify(scene),
            updatedAt,
            userId,
            sceneId,
            expectedRevision,
          );
        if (Number(result.changes) !== 1) {
          const latest = db.prepare('SELECT revision FROM scenes WHERE user_id = ? AND id = ?').get(userId, sceneId);
          fail('revision_conflict', '场景已被并发更新', {
            details: { sceneId, expectedRevision, currentRevision: latest ? Number(latest.revision) : null },
            status: 409,
          });
        }
        const response = { sceneId, revision: expectedRevision + 1, updatedAt };
        writeIdempotent(idempotencyKey, 'update_scene', requestHash, response, nowMs);
        auditGeneration(scene);
        return { ...response, deduplicated: false };
      });
      return result;
    },

    /**
     * Latest scene, or the requested revision when it is still current. The
     * account store keeps no per-revision history table (the Web app does not
     * either), so a stale revision is reported as not found rather than
     * returning a different version under the requested revision number.
     */
    getScene(sceneId, revision = null) {
      const row = db
        .prepare('SELECT id, revision, scene_json, updated_at FROM scenes WHERE user_id = ? AND id = ?')
        .get(userId, sceneId);
      if (!row) return null;
      const current = Number(row.revision);
      if (Number.isInteger(revision) && revision !== current) return null;
      return { id: row.id, revision: current, scene: JSON.parse(row.scene_json), updatedAt: row.updated_at };
    },

    currentRevision(sceneId) {
      const row = db.prepare('SELECT revision FROM scenes WHERE user_id = ? AND id = ?').get(userId, sceneId);
      return row ? Number(row.revision) : null;
    },

    listSceneRevisions(sceneId) {
      const row = db
        .prepare('SELECT revision, updated_at FROM scenes WHERE user_id = ? AND id = ?')
        .get(userId, sceneId);
      return row ? [{ revision: Number(row.revision), createdAt: row.updated_at }] : [];
    },

    /** Bounded summaries only: never the full scene JSON or render blobs. */
    listScenes({ limit = 20 } = {}) {
      const bounded = Math.min(Math.max(1, Number(limit) || 1), SCENE_QUERY_LIMIT_MAX);
      return db
        .prepare(
          `SELECT id, title, platform, message_count, revision, updated_at
           FROM scenes WHERE user_id = ?
           ORDER BY updated_at DESC, id ASC LIMIT ?`,
        )
        .all(userId, bounded)
        .map((row) => ({
          sceneId: row.id,
          title: row.title,
          platform: row.platform,
          messageCount: Number(row.message_count),
          revision: Number(row.revision),
          updatedAt: row.updated_at,
        }));
    },

    saveRender(record) {
      const createdAt = new Date().toISOString();
      return withTransaction(db, () => {
        db.prepare(
          `INSERT INTO mcp_renders
             (user_id, render_id, scene_id, revision, png_base64, sha256, bytes, width, height, title, output_kind, surface, created_at, policy_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, render_id) DO UPDATE SET
             scene_id = excluded.scene_id,
             revision = excluded.revision,
             png_base64 = excluded.png_base64,
             sha256 = excluded.sha256,
             bytes = excluded.bytes,
             width = excluded.width,
             height = excluded.height,
             title = excluded.title,
             output_kind = excluded.output_kind,
             surface = excluded.surface,
             created_at = excluded.created_at,
             policy_version = excluded.policy_version`,
        ).run(
          userId,
          record.renderId,
          record.sceneId ?? null,
          Number.isInteger(record.revision) ? record.revision : null,
          record.pngBase64,
          record.sha256,
          record.bytes,
          record.width,
          record.height,
          record.title,
          record.outputKind,
          record.surface,
          createdAt,
          POLICY_VERSION,
        );
        db.prepare(
          `DELETE FROM mcp_renders
           WHERE user_id = ? AND render_id NOT IN (
             SELECT render_id FROM mcp_renders WHERE user_id = ?
             ORDER BY created_at DESC, render_id DESC LIMIT ?
           )`,
        ).run(userId, userId, maxStoredRenders);
        // Hosted deterministic render output — audited like other hosted
        // generation (metadata only, same transaction).
        recordGenerationAudit(db, {
          runId: newAuditRunId(),
          accountId: userId,
          flow: 'render',
          status: 'ok',
          scene: null,
          sceneHash: record.sha256,
        });
        return { ...record, createdAt };
      });
    },

    getRender(renderId) {
      const row = db
        .prepare('SELECT * FROM mcp_renders WHERE user_id = ? AND render_id = ?')
        .get(userId, renderId);
      if (!row) return null;
      // Pre-policy blobs are blocked (non-destructively): rows and scene data
      // stay stored, they are simply never served again.
      if (!isCurrentPolicyVersion(row.policy_version)) return null;
      return {
        renderId: row.render_id,
        sceneId: row.scene_id,
        revision: row.revision === null || row.revision === undefined ? null : Number(row.revision),
        pngBase64: row.png_base64,
        sha256: row.sha256,
        bytes: Number(row.bytes),
        width: Number(row.width),
        height: Number(row.height),
        title: row.title,
        outputKind: row.output_kind,
        surface: row.surface,
        createdAt: row.created_at,
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Account-only tool surface                                           */
/* ------------------------------------------------------------------ */

const ACCOUNT_BASE_TOOLS = new Set([
  'imstage_get_capabilities',
  'imstage_create_scene',
  'imstage_get_scene',
  'imstage_update_scene',
  'imstage_render_scene',
]);

const LIST_SCENES_TOOL = {
  name: 'imstage_list_scenes',
  title: '列出我的 IMStage 作品',
  description:
    '列出当前账号最近保存的作品摘要（sceneId、标题、平台、消息数、revision、更新时间、webUrl）。不返回完整场景或渲染数据。修改前可用它找到 sceneId。',
  inputSchema: {
    type: 'object',
    properties: { limit: { type: 'integer', minimum: 1, maximum: SCENE_QUERY_LIMIT_MAX } },
    additionalProperties: false,
  },
  outputSchema: { type: 'object', additionalProperties: true },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

/** The six scene tools keep their original schemas and semantics and require
 * only the scenes scope. */
export const ACCOUNT_TOOLS = Object.freeze(
  [...TOOL_DEFINITIONS.filter((tool) => ACCOUNT_BASE_TOOLS.has(tool.name)), LIST_SCENES_TOOL].map((tool) => ({
    ...tool,
    securitySchemes: [{ type: 'oauth2', scopes: [SCENE_SCOPE] }],
  })),
);

/**
 * Account tool list filtered by the scopes the credential actually carries.
 * A scenes-only credential keeps exactly the six scene tools; the project /
 * scenario / template / content-batch tools appear only with `imstage.projects`.
 */
export function accountToolsForScopes(grantedScopes) {
  return [...ACCOUNT_TOOLS, ...ACCOUNT_PROJECT_TOOLS].filter((tool) =>
    hasScopes(grantedScopes, tool.securitySchemes[0].scopes),
  );
}

export const ACCOUNT_INSTRUCTIONS =
  'IMStage 账号 MCP：只操作当前已授权账号自己的数据，不调用模型，内容由你生成。作品流程：imstage_list_scenes 找到 sceneId → imstage_get_scene 读取 → imstage_create_scene / imstage_update_scene(expectedRevision) 确定性保存 → imstage_render_scene 渲染 PNG。项目交付流程：imstage_list_project_types 读配方 → imstage_create_project → imstage_create_scenario 生成 case-001… 计划 → 按计划用 imstage_create_batch 分批提交完整内容（每批 ≤20 条，可带 clientIdempotencyKey 幂等重试）→ 用 imstage_get_project_status 查看剩余稳定 itemKey 并继续提交 → 内容齐备后用 imstage_export_project 导出（autoExport 开启时最后一个批次会自动排队）→ 轮询 imstage_get_project_status 至 completed/partial → 用 imstage_get_project_export 获取下载链接并向用户报告可用 ZIP。未轮询到导出完成前不得声称文件已交付；部分导出（partial）必须如实报告缺项。计划不是已完成内容。场景 id 为服务端生成的 UUID，与网页 #/workspace?scene=ID 相同；返回值中的 webUrl 可直接打开。不要传远程图片 URL，只接受内嵌 data:image/...;base64。';

function textOk(text, structuredContent) {
  return { content: [{ type: 'text', text }], structuredContent };
}

function accountCapabilities(defaults = null, includeProjects = false) {
  const base = buildCapabilities();
  const tools = base.tools.filter((tool) => ACCOUNT_BASE_TOOLS.has(tool.name));
  tools.push({ name: 'imstage_list_scenes', readOnly: true, purpose: '列出当前账号最近保存的作品摘要。' });
  if (includeProjects) {
    for (const tool of ACCOUNT_PROJECT_TOOLS) {
      tools.push({ name: tool.name, readOnly: tool.annotations.readOnlyHint === true, purpose: tool.description.slice(0, 80) });
    }
  }
  return {
    ...base,
    server: ACCOUNT_MCP_SERVER_NAME,
    tools,
    limits: { scene: base.limits.scene, render: base.limits.render },
    accountDefaults: defaults ? sceneDefaultsSummary(defaults) : null,
    identifierRules: {
      ...base.identifierRules,
      sceneId: '服务端生成的标准 UUID（与网页作品 id 相同，例如 #/workspace?scene=<uuid>）。',
    },
    examples: {
      ...base.examples,
      updateScene: { ...base.examples.updateScene, sceneId: '<uuid>' },
      renderScene: { ...base.examples.renderScene, sceneId: '<uuid>' },
    },
    workflow: {
      deterministicSave: base.workflow.deterministicSave,
      webDifference: base.workflow.webDifference,
      accountScope:
        '只读写当前账号的数据；已保存作品与网页“我的作品”共用同一张表，网页修改会被 MCP 读到，MCP 修改也会出现在网页。',
      projectAutomation: includeProjects
        ? '项目/场景/案例与内容批次经共享应用服务保存，与网页 /api/projects 数据一致；每批 ≤20 条。内容齐备后用 imstage_export_project 导出（或 autoExport 自动排队），轮询 completed 后用 imstage_get_project_export 获取 ZIP。'
        : null,
    },
    auth: {
      scheme: 'OAuth 2.1 authorization code + PKCE，或用户创建的私人令牌',
      tokenType: 'Bearer',
      note: '每个 /api/mcp 请求都必须带 Bearer access token；token 绑定本 MCP 资源与账号，撤销后立即失效。',
    },
  };
}

/**
 * Build a fresh MCP server bound to one authenticated account. A new instance
 * per HTTP request keeps the store adapter (and therefore every read/write)
 * scoped to a single `users.id`.
 */export function createAccountMcpServer({
  db,
  userId,
  renderService,
  logger = console,
  appOrigin,
  maxStoredRenders = MAX_STORED_RENDERS,
  authorizeCheck = null,
  readPreferences = null,
  // One shared automation service + one shared export service (created once in
  // the API server): HTTP and MCP therefore share the export queue, auto-export
  // hooks and preferences default fill.
  automation = null,
  exportService = null,
  // Granted scopes + grant reference from the verified credential. tools/list
  // and every handler guard against scopes the credential does not carry; the
  // grant reference is recorded as batch provenance, never a raw token.
  scopes = SUPPORTED_SCOPES,
  grantId = null,
}) {
  const grantedScopes = Array.isArray(scopes) ? [...scopes] : [...SUPPORTED_SCOPES];
  const store = createAccountStore(db, userId, { maxStoredRenders });
  const webUrlBase = `${new URL(appOrigin).origin}/#/workspace?scene=`;
  const webUrlFor = (sceneId) => `${webUrlBase}${encodeURIComponent(sceneId)}`;
  // Read the account defaults lazily so a long-lived server always reflects the
  // latest saved avatars/mark. Avatar bytes stay server-side; the agent only
  // receives `sceneDefaultsSummary` (booleans + label).
  const readDefaults = async () => {
    if (typeof readPreferences !== 'function') return null;
    try {
      return (await readPreferences()) ?? null;
    } catch (error) {
      logger.warn?.('[imstage-mcp] failed to read account preferences:', error?.message ?? error);
      return null;
    }
  };
  // Default fill reads avatar bytes on the server, so the model never has to
  // send or receive them to get account defaults. Wire note: scene-bearing tool
  // results still return the stored scene verbatim (including any avatar data
  // URI) for fidelity with the shared Web scene contract; the documented
  // exposure boundary is in docs/creator-preferences.md.
  const defaultSceneFill = async (rawScene) => {
    const defaults = await readDefaults();
    if (!defaults) return rawScene;
    return applySceneDefaults(rawScene, {
      myAvatar: defaults.myAvatar,
      otherAvatar: defaults.otherAvatar,
      showFictionalMark: defaults.showFictionalMark,
      markLabel: defaults.markLabel,
    });
  };
  // `first_artwork_completed` is recorded only after a render really succeeded
  // and the post-render authorization recheck passed; it is account-once.
  const onRenderSuccess = () => {
    try {
      recordEvent(db, { userId, name: 'first_artwork_completed', nowMs: Date.now() });
    } catch (error) {
      logger.warn?.('[imstage-mcp] failed to record first artwork event:', error?.message ?? error);
    }
  };
  // Convert a revoked/expired credential into a stable tool error instead of an
  // opaque internal error, so a mid-render revoke is still legible.
  const guardedAuthorizeCheck = authorizeCheck
    ? async () => {
        try {
          await authorizeCheck();
        } catch (error) {
          if (error instanceof InvalidTokenError) {
            fail('unauthorized', '访问令牌已失效，请重新连接 IMStage。', {
              status: 401,
              recovery: '在 ChatGPT 的已连接应用中重新连接 IMStage，然后重试。',
            });
          }
          throw error;
        }
      }
    : null;
  const extraHandlers = {
    imstage_get_capabilities: async () => {
      const capabilities = accountCapabilities(await readDefaults(), hasScopes(grantedScopes, PROJECT_TOOL_SCOPES));
      if (guardedAuthorizeCheck) await guardedAuthorizeCheck();
      return textOk('账号 MCP 能力与边界见 structuredContent。', capabilities);
    },
    imstage_list_scenes: (args) => {
      rejectUnknownKeys(args, new Set(['limit']), 'arguments');
      const limit = integerField(args, 'limit', { min: 1, max: SCENE_QUERY_LIMIT_MAX }) ?? 20;
      const items = store.listScenes({ limit }).map((item) => ({ ...item, webUrl: webUrlFor(item.sceneId) }));
      return textOk(`找到 ${items.length} 个作品。`, { items });
    },
    // Account project/scenario/template/content-batch/export tools share the
    // application services with the HTTP routes and guard the project scope on
    // every call (also when invoked directly).
    ...createAccountProjectHandlers({
      db,
      userId,
      appOrigin,
      grantedScopes,
      grantRef: grantId,
      automation,
      exportService,
      principal: grantId ? { kind: 'grant', id: grantId } : null,
      // Re-checked after async gates (preferences read) and before the batch
      // transaction commits: a mid-await revocation never commits content.
      authorizeCheck: guardedAuthorizeCheck,
    }),
  };
  return createImstageMcpServer({
    store,
    renderService,
    logger,
    tools: accountToolsForScopes(grantedScopes),
    extraHandlers,
    webUrlFor,
    sceneIdFactory: () => crypto.randomUUID(),
    defaultSceneFill: defaultSceneFill,
    onRenderSuccess,
    authorizeCheck: guardedAuthorizeCheck,
    serverInfo: { name: ACCOUNT_MCP_SERVER_NAME, version: ACCOUNT_MCP_SERVER_VERSION },
    instructions: ACCOUNT_INSTRUCTIONS,
  });
}

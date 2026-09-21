// Durable generation recovery ledger.
//
// Exact-once provider semantics are impossible across process interruptions:
// if the process dies after the provider starts but before we persist the
// model result, we cannot know whether the provider produced (and billed) a
// response. This ledger makes that uncertainty explicit instead of silently
// paying again:
//
//   started     -> an attempt began; if we never saw a model result the outcome
//                  is UNKNOWN and a retry with the same requestId is refused
//                  with `generation_outcome_unknown` (the UI offers a new id).
//   model_ready -> the provider result is cached here; retries reuse it without
//                  another paid model call.
//   completed   -> a case was committed; retries return that case (or
//                  `generation_not_found` if it was deleted) without replay.
//
// The file lives under the store data directory, is written atomically with
// 0600 permissions (reusing `atomicWriteJson`) and is bounded. Corruption and
// an over-full ledger fail closed; incomplete jobs are never auto-evicted.

import fs from 'node:fs';
import path from 'node:path';
import { AppError, atomicWriteJson, fail, isSafeId, nowIso } from './util.mjs';

export const GENERATION_LEDGER_SCHEMA_VERSION = 1;
export const GENERATION_LEDGER_FILE = 'generation-ledger.json';
export const MAX_LEDGER_ENTRIES = 2000;
// Provider responses are bounded by max_tokens 4500; this is a defensive upper
// bound so a hostile/broken provider cannot blow up the ledger file.
export const MAX_RECOVERED_CONTENT_CHARS = 400_000;
const STATUSES = new Set(['started', 'model_ready', 'completed']);
const HASH_RE = /^[a-f0-9]{64}$/;

function ledgerFail(code, message, status = 500) {
  throw new AppError(code, message, status);
}

function emptyState() {
  return { schemaVersion: GENERATION_LEDGER_SCHEMA_VERSION, attempts: {} };
}

function validateEntry(requestId, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    ledgerFail('generation_ledger_corrupt', '生成恢复账本损坏，已拒绝继续（不会覆盖原文件）');
  }
  if (entry.requestId !== requestId || !isSafeId(requestId)) {
    ledgerFail('generation_ledger_corrupt', '生成恢复账本包含非法 requestId，已拒绝继续');
  }
  if (typeof entry.inputHash !== 'string' || !HASH_RE.test(entry.inputHash)) {
    ledgerFail('generation_ledger_corrupt', '生成恢复账本包含非法 inputHash，已拒绝继续');
  }
  if (!STATUSES.has(entry.status)) {
    ledgerFail('generation_ledger_corrupt', '生成恢复账本包含非法状态，已拒绝继续');
  }
  if (entry.rawContent !== undefined) {
    if (typeof entry.rawContent !== 'string' || entry.rawContent.length > MAX_RECOVERED_CONTENT_CHARS) {
      ledgerFail('generation_ledger_corrupt', '生成恢复账本缓存内容越界，已拒绝继续');
    }
  }
  if (entry.model !== undefined && (typeof entry.model !== 'string' || entry.model.length > 200)) {
    ledgerFail('generation_ledger_corrupt', '生成恢复账本 model 非法，已拒绝继续');
  }
  if (entry.status === 'model_ready' && typeof entry.rawContent !== 'string') {
    ledgerFail('generation_ledger_corrupt', '生成恢复账本缺少缓存结果，已拒绝继续');
  }
  if (entry.status === 'completed' && !isSafeId(entry.caseId)) {
    ledgerFail('generation_ledger_corrupt', '生成恢复账本缺少已提交 caseId，已拒绝继续');
  }
}

export class GenerationLedger {
  constructor({ dataDir, maxEntries = MAX_LEDGER_ENTRIES }) {
    if (!dataDir || typeof dataDir !== 'string') {
      throw new Error('GenerationLedger 需要 dataDir');
    }
    this.filePath = path.join(dataDir, GENERATION_LEDGER_FILE);
    this.maxEntries = maxEntries;
    this.state = null;
  }

  async load() {
    if (this.state) return this.state;
    if (!this.loading) this.loading = this.loadFromDisk();
    try { return await this.loading; }
    finally { this.loading = null; }
  }

  async loadFromDisk() {
    if (this.state) return this.state;
    let raw;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.state = emptyState();
        return this.state;
      }
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ledgerFail('generation_ledger_corrupt', '生成恢复账本 JSON 解析失败，已拒绝继续（不会覆盖原文件）');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      parsed.schemaVersion !== GENERATION_LEDGER_SCHEMA_VERSION ||
      !parsed.attempts ||
      typeof parsed.attempts !== 'object' ||
      Array.isArray(parsed.attempts)
    ) {
      ledgerFail('generation_ledger_corrupt', '生成恢复账本结构非法，已拒绝继续（不会覆盖原文件）');
    }
    const entries = Object.entries(parsed.attempts);
    if (entries.length > this.maxEntries) {
      ledgerFail(
        'generation_ledger_full',
        `生成恢复账本条目超过 ${this.maxEntries} 上限，已拒绝新生成（不会静默清除未完成记录）`,
        507,
      );
    }
    for (const [requestId, entry] of entries) validateEntry(requestId, entry);
    this.state = parsed;
    return this.state;
  }

  async mutate(fn) {
    await this.load();
    // Serialize the whole transaction. A recovery write cannot overwrite a
    // new paid-attempt marker, and a failed write never advances memory.
    const run = async () => {
      const draft = structuredClone(this.state);
      const result = fn(draft);
      await atomicWriteJson(this.filePath, draft);
      this.state = draft;
      return result;
    };
    const pending = (this.writeQueue || Promise.resolve()).then(run, run);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }

  async read(requestId) {
    const state = await this.load();
    return Object.hasOwn(state.attempts, requestId) ? state.attempts[requestId] : null;
  }

  /**
   * Register the start of a new attempt. Callers must reject a changed input
   * before calling this.
   */
  async begin(requestId, inputHash) {
    return this.mutate((state) => {
      const existing = Object.hasOwn(state.attempts, requestId) ? state.attempts[requestId] : null;
      if (existing) {
        if (existing.inputHash !== inputHash) {
          fail('request_id_conflict', 'requestId 已用于不同的输入，请使用新的 requestId', 409);
        }
        return existing;
      }
      if (Object.keys(state.attempts).length >= this.maxEntries) {
        fail(
          'generation_ledger_full',
          `生成恢复账本条目超过 ${this.maxEntries} 上限，已拒绝新生成（不会静默清除未完成记录）`,
          507,
        );
      }
      const entry = { requestId, inputHash, status: 'started', startedAt: nowIso() };
      state.attempts = { ...state.attempts, [requestId]: entry };
      return entry;
    });
  }

  /**
   * Cache the provider result before any rendering/commit. Safe to call twice.
   */
  async recordModel(requestId, inputHash, { rawContent, model }) {
    return this.mutate((state) => {
      const entry = state.attempts[requestId];
      if (!entry) ledgerFail('generation_ledger_corrupt', '生成恢复账本缺少进行中的记录，已拒绝继续');
      if (entry.inputHash !== inputHash) {
        fail('request_id_conflict', 'requestId 已用于不同的输入，请使用新的 requestId', 409);
      }
      if (typeof rawContent !== 'string' || rawContent.length === 0) {
        fail('ai_empty_response', 'AI 未返回可用内容', 502);
      }
      if (rawContent.length > MAX_RECOVERED_CONTENT_CHARS) {
        fail('ai_invalid_response', 'AI 返回内容过大，已拒绝缓存', 502);
      }
      if (entry.status === 'completed') return entry;
      if (entry.status === 'model_ready') return entry;
      entry.status = 'model_ready';
      entry.rawContent = rawContent;
      entry.model = typeof model === 'string' && model ? model.slice(0, 200) : 'unknown';
      entry.modelAt = nowIso();
      return entry;
    });
  }

  async complete(requestId, inputHash, caseId) {
    return this.mutate((state) => {
      const entry = state.attempts[requestId];
      if (!entry) ledgerFail('generation_ledger_corrupt', '生成恢复账本缺少进行中的记录，已拒绝继续');
      if (entry.inputHash !== inputHash) {
        fail('request_id_conflict', 'requestId 已用于不同的输入，请使用新的 requestId', 409);
      }
      if (!isSafeId(caseId)) ledgerFail('generation_ledger_corrupt', '生成恢复账本 caseId 非法');
      entry.status = 'completed';
      entry.caseId = caseId;
      entry.completedAt = nowIso();
      delete entry.rawContent; // the persisted case is now the source of truth
      return entry;
    });
  }
}

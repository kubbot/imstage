/**
 * IMStage prompt-first streaming engine.
 *
 * Protocol proposal (not yet implemented server-side): a single user sentence is
 * turned into a sequence of `GenerationEvent`s that incrementally build one
 * structured `Scene`. The proposal follows the product direction
 * "结构化 conversation contract → 确定性渲染" in `docs/product-brief.md` and the
 * split "AI 负责理解，确定性排版负责稳定画面" in `design/REVIEW.md`.
 *
 * Two sources of events live here and must never be confused:
 * - `streamDemo`: a clearly authored, local, deterministic fiction (no model,
 *   no network) used so the prompt-first UI has something honest to show.
 *   The UI is expected to label it as a local demo.
 * - `streamRemote`: the contract a real provider endpoint must satisfy. It talks
 *   to the same-origin `POST /api/scenes/stream` NDJSON endpoint and never falls
 *   back to the local demo when the endpoint is missing or fails.
 *
 * `applyGenerationEvent` is the pure reducer both sources share. It treats every
 * event as untrusted input, validates it against `validateScene`, and never
 * mutates the scene it is given.
 */

import { validateScene } from '../studio/model.ts';
import type { Message, Participant, Platform, Scene } from '../studio/model.ts';

/* ------------------------------------------------------------------ */
/* Protocol types                                                      */
/* ------------------------------------------------------------------ */

export type GenerationStage = 'understanding' | 'writing' | 'assets';

export type GenerationEvent =
  | { type: 'scene'; scene: Scene }
  | { type: 'message'; message: Message }
  | { type: 'message-delta'; id: string; text: string }
  | { type: 'asset'; targetId: string; kind: 'avatar' | 'message'; dataUrl: string }
  | { type: 'status'; stage: GenerationStage; message: string }
  | { type: 'done' };

const GENERATION_STAGES: readonly GenerationStage[] = ['understanding', 'writing', 'assets'];

/** Same-origin provider endpoint. The real service is not part of this change. */
export const STREAM_ENDPOINT = '/api/scenes/stream';

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(`${field} 必须是非空字符串`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') return fail(`${field} 必须是字符串`);
  return value;
}

/**
 * Bounded raster data URL check, kept in sync with `isLocalImage` in
 * `studio/model.ts`: only inline PNG/JPEG/WebP base64 up to 6 MB, never remote
 * URLs, SVG, HTML or other smuggling vectors.
 */
const RASTER_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const MAX_ASSET_CHARS = 6 * 1024 * 1024;

function isBoundedRasterDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_ASSET_CHARS &&
    RASTER_DATA_URL.test(value)
  );
}

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('生成已取消', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Validate the accumulated scene, returning a normalised copy or throwing. */
function validatedScene(scene: Scene, context: string): Scene {
  const result = validateScene(scene);
  if (!result.ok || !result.scene) {
    return fail(`${context}：${result.errors.join('；')}`);
  }
  return result.scene;
}

/**
 * Pure reducer for a single generation event.
 *
 * - `scene` replaces the current scene with a validated copy.
 * - `message` / `message-delta` / `asset` accumulate onto the current scene.
 * - `status` / `done` leave the scene untouched but still reject a corrupt one.
 *
 * The input scene is never mutated. Invalid structures, duplicate ids, missing
 * targets and unknown senders throw a descriptive Error in Chinese.
 */
export function applyGenerationEvent(
  scene: Scene | null,
  event: GenerationEvent,
): Scene | null {
  const raw: unknown = event;
  if (!isRecord(raw)) fail('生成事件必须是一个对象');
  const type = raw.type;
  if (typeof type !== 'string') fail('生成事件缺少有效的 type');

  switch (type) {
    case 'scene': {
      if (!isRecord(raw.scene)) fail('scene 事件缺少有效的 scene 对象');
      return validatedScene(raw.scene as unknown as Scene, 'scene 事件无效');
    }

    case 'message': {
      const base = requireScene(scene, 'message');
      if (!isRecord(raw.message)) fail('message 事件缺少有效的 message 对象');
      const candidate: Scene = {
        ...base,
        messages: [...base.messages, raw.message as unknown as Message],
      };
      return validatedScene(candidate, 'message 事件无效');
    }

    case 'message-delta': {
      const base = requireScene(scene, 'message-delta');
      const id = requireNonEmptyString(raw.id, 'message-delta 事件的 id');
      const text = requireString(raw.text, 'message-delta 事件的 text');
      const index = base.messages.findIndex((message) => message.id === id);
      if (index === -1) fail(`message-delta 找不到目标消息：${id}`);
      const messages = base.messages.map((message, current) =>
        current === index ? { ...message, text: message.text + text } : message,
      );
      return validatedScene({ ...base, messages }, 'message-delta 事件产生无效场景');
    }

    case 'asset': {
      const base = requireScene(scene, 'asset');
      const targetId = requireNonEmptyString(raw.targetId, 'asset 事件的 targetId');
      if (raw.kind !== 'avatar' && raw.kind !== 'message') {
        fail(`asset 事件的 kind 无效：${String(raw.kind)}`);
      }
      if (!isBoundedRasterDataUrl(raw.dataUrl)) {
        fail('asset 事件只接受不超过 6MB 的本地 PNG/JPEG/WebP Data URL');
      }
      const dataUrl: string = raw.dataUrl;
      if (raw.kind === 'avatar') {
        if (!base.participants.some((participant) => participant.id === targetId)) {
          fail(`asset 事件找不到头像目标：${targetId}`);
        }
        const participants = base.participants.map((participant) =>
          participant.id === targetId ? { ...participant, avatar: dataUrl } : participant,
        );
        return validatedScene({ ...base, participants }, 'asset 事件产生无效场景');
      }
      if (!base.messages.some((message) => message.id === targetId)) {
        fail(`asset 事件找不到消息目标：${targetId}`);
      }
      const messages = base.messages.map((message) =>
        message.id === targetId ? { ...message, asset: dataUrl } : message,
      );
      return validatedScene({ ...base, messages }, 'asset 事件产生无效场景');
    }

    case 'status': {
      if (!GENERATION_STAGES.includes(raw.stage as GenerationStage)) {
        fail(`status 事件的 stage 无效：${String(raw.stage)}`);
      }
      requireString(raw.message, 'status 事件的 message');
      return checkExistingScene(scene, 'status');
    }

    case 'done':
      return checkExistingScene(scene, 'done');

    default:
      return fail(`未知的生成事件类型：${type}`);
  }
}

function requireScene(scene: Scene | null, context: string): Scene {
  if (scene === null) {
    return fail(`${context} 事件需要已有场景，但当前场景为空`);
  }
  const result = validateScene(scene);
  if (!result.ok || !result.scene) {
    return fail(`当前场景无效：${result.errors.join('；')}`);
  }
  return result.scene;
}

function checkExistingScene(scene: Scene | null, context: string): Scene | null {
  if (scene === null) return null;
  const result = validateScene(scene);
  if (!result.ok || !result.scene) {
    return fail(`${context} 事件收到无效场景：${result.errors.join('；')}`);
  }
  // No structural change: keep the caller's reference for cheap identity checks.
  return scene;
}

/* ------------------------------------------------------------------ */
/* Local demo                                                          */
/* ------------------------------------------------------------------ */

/** The canonical prompt the authored local demo is written for. */
export const MARS_PROMPT = '我和 Elon Musk 在明天一起去火星漫游';

/**
 * Recognise a prompt that explicitly asks for both Elon (Musk/马斯克) and Mars
 * (Mars/火星). Anything else must not silently become the Mars demo.
 */
export function isMarsPrompt(prompt: unknown): boolean {
  if (typeof prompt !== 'string') return false;
  const wantsMusk = /(?:^|[^a-z])musk(?:[^a-z]|$)|马斯克/i.test(prompt);
  const wantsMars = /(?:^|[^a-z])mars(?:[^a-z]|$)|火星/i.test(prompt);
  return wantsMusk && wantsMars;
}

export interface StreamDemoOptions {
  prompt: string;
  platform: Platform;
  /** Parent-owned Elon avatar data URL. */
  avatar?: string;
  /** Parent-owned generated photo data URL. */
  image?: string;
  now?: Date;
  /** Test hook: fixed delay per step (0 disables waits). */
  delayMs?: number;
}

export const DEMO_SCENE_ID = 'scene-mars';
export const DEMO_PHOTO_MESSAGE_ID = 'm-mars-elon-3';

interface DemoMessage {
  id: string;
  participantId: string;
  type: Message['type'];
  text: string;
}

const DEMO_MESSAGES: readonly DemoMessage[] = [
  { id: 'm-mars-me-1', participantId: 'me', type: 'text', text: '明天有空吗？我想和你一起去火星漫游。' },
  { id: 'm-mars-elon-1', participantId: 'elon', type: 'text', text: '好，明天见。我来安排飞船。' },
  { id: 'm-mars-elon-2', participantId: 'elon', type: 'location', text: '火星 · 杰泽罗陨石坑' },
  { id: 'm-mars-me-2', participantId: 'me', type: 'text', text: '能拍张照片给我看看吗？' },
  { id: DEMO_PHOTO_MESSAGE_ID, participantId: 'elon', type: 'image', text: '火星合影' },
  { id: 'm-mars-elon-4', participantId: 'elon', type: 'text', text: '明天见。' },
];

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local (not UTC) YYYY-MM-DD so the fiction follows the viewer's calendar. */
function localDateString(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function localTimeString(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function chunkText(text: string, size = 3): string[] {
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += size) {
    chunks.push(codePoints.slice(index, index + size).join(''));
  }
  return chunks;
}

function randomStepDelay(): number {
  return 200 + Math.floor(Math.random() * 251);
}

/** Check abort immediately before and after every yield. */
function* emit(event: GenerationEvent, signal?: AbortSignal): Generator<GenerationEvent> {
  throwIfAborted(signal);
  yield event;
  throwIfAborted(signal);
}

/**
 * Authored local demo generation. This is fiction written in the repository, not
 * a model call. It rejects prompts that are not the Mars request rather than
 * silently reusing the Mars demo for unrelated scenes.
 */
export async function* streamDemo(
  options: StreamDemoOptions,
  signal?: AbortSignal,
): AsyncGenerator<GenerationEvent, void, void> {
  throwIfAborted(signal);
  if (!options || typeof options.prompt !== 'string') {
    fail('本地演示需要 prompt 文本');
  }
  if (!isMarsPrompt(options.prompt)) {
    fail('本地演示只处理同时提到 Elon Musk 与火星的提示词，其他请求不会静默生成火星场景');
  }
  if (options.now !== undefined && (!(options.now instanceof Date) || Number.isNaN(options.now.getTime()))) {
    fail('now 必须是有效的 Date');
  }

  const now = options.now instanceof Date ? options.now : new Date();
  const stepDelay =
    options.delayMs === undefined ? randomStepDelay() : Math.max(0, options.delayMs);
  const chunkDelay =
    options.delayMs === undefined ? Math.min(60, stepDelay) : Math.max(0, options.delayMs);

  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);

  const participants: Participant[] = [
    { id: 'me', name: '我' },
    { id: 'elon', name: 'Elon Musk' },
  ];

  const scene: Scene = {
    id: DEMO_SCENE_ID,
    title: '明天，火星见',
    platform: options.platform,
    deviceTime: localTimeString(now),
    date: localDateString(tomorrow),
    selfId: 'me',
    participants,
    messages: [],
    watermark: '虚构场景 · AI 合成',
  };
  const demoScene = validatedScene(scene, '本地演示场景无效');

  yield* emit(
    { type: 'status', stage: 'understanding', message: '正在载入火星故事示例…' },
    signal,
  );
  await delay(stepDelay, signal);

  yield* emit({ type: 'scene', scene: demoScene }, signal);
  yield* emit(
    { type: 'status', stage: 'writing', message: '正在展开示例中的虚构对话…' },
    signal,
  );

  for (const message of DEMO_MESSAGES) {
    await delay(stepDelay, signal);
    yield* emit(
      {
        type: 'message',
        message: {
          id: message.id,
          participantId: message.participantId,
          type: message.type,
          text: '',
          time: '',
        },
      },
      signal,
    );
    for (const chunk of chunkText(message.text)) {
      yield* emit({ type: 'message-delta', id: message.id, text: chunk }, signal);
      await delay(chunkDelay, signal);
    }
  }

  yield* emit(
    { type: 'status', stage: 'assets', message: '正在填入头像参考与已生成的合影…' },
    signal,
  );
  await delay(stepDelay, signal);

  if (typeof options.avatar === 'string' && options.avatar !== '') {
    yield* emit(
      { type: 'asset', targetId: 'elon', kind: 'avatar', dataUrl: options.avatar },
      signal,
    );
  }
  if (typeof options.image === 'string' && options.image !== '') {
    yield* emit(
      {
        type: 'asset',
        targetId: DEMO_PHOTO_MESSAGE_ID,
        kind: 'message',
        dataUrl: options.image,
      },
      signal,
    );
  }

  yield* emit({ type: 'done' }, signal);
}

/* ------------------------------------------------------------------ */
/* Remote provider stream                                              */
/* ------------------------------------------------------------------ */

export interface StreamRemoteOptions {
  prompt: string;
  platform: Platform;
  previousScene?: Scene | null;
}

const MAX_EVENT_CHARS = 7 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function isProviderUnavailable(status: number): boolean {
  return status === 404 || status === 405 || status === 501 || status === 502 || status === 503;
}

/**
 * Consume the proposed NDJSON provider stream from `POST /api/scenes/stream`.
 *
 * Every line is one `GenerationEvent` (or `{ "type": "error", "message": ... }`).
 * The stream must end with `done` and a complete, valid scene. Failures surface
 * as concise Chinese errors and never fall back to the local demo.
 */
export async function* streamRemote(
  options: StreamRemoteOptions,
  signal?: AbortSignal,
): AsyncGenerator<GenerationEvent, void, void> {
  throwIfAborted(signal);
  if (!options || typeof options.prompt !== 'string' || options.prompt.trim() === '') {
    fail('生成请求缺少 prompt 文本');
  }

  const payload: Record<string, unknown> = {
    prompt: options.prompt,
    platform: options.platform,
  };
  if (options.previousScene) {
    const previous = validateScene(options.previousScene);
    if (!previous.ok || !previous.scene) {
      fail(`previousScene 无效：${previous.errors.join('；')}`);
    }
    payload.previousScene = previous.scene;
  }

  let response: Response;
  try {
    response = await fetch(STREAM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson',
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    throwIfAborted(signal);
    const detail = error instanceof Error ? error.message : String(error);
    return fail(`无法连接生成服务，真实生成服务尚未接入：${detail}`);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) fail('生成服务凭据无效，请检查服务端配置。');
    if (isProviderUnavailable(response.status)) {
      fail('真实生成服务尚未接入。可以先体验示例，或连接服务后重试。');
    }
    fail(`生成服务返回错误：HTTP ${response.status}`);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/x-ndjson')) {
    fail(
      `生成服务返回了不支持的内容类型：${contentType || '（未提供）'}，期望 application/x-ndjson`,
    );
  }
  if (!response.body) fail('生成服务没有返回可读取的响应体');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let scene: Scene | null = null;
  let sawDone = false;
  let totalBytes = 0;
  let buffer = '';

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  // Parse one complete NDJSON line, validate/accumulate it, then yield it.
  const processLine = function* (rawLine: string): Generator<GenerationEvent> {
    let line = rawLine;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.trim() === '') return;
    if (sawDone) fail('生成流在 done 之后继续发送事件');
    if (line.length > MAX_EVENT_CHARS) fail('生成流单个事件超过大小限制');

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return fail('生成流返回了无法解析的事件');
    }

    if (isRecord(parsed) && parsed.type === 'error') {
      const message = typeof parsed.message === 'string' ? parsed.message : '未知错误';
      fail(`生成服务返回错误：${message}`);
    }

    scene = applyGenerationEvent(scene, parsed as GenerationEvent);
    if (isRecord(parsed) && parsed.type === 'done') {
      if (scene === null || scene.messages.length === 0) fail('生成流在产出有效场景前就结束了');
      if (scene.messages.some(message => message.type === 'image' && !message.asset)) fail('生成流结束时仍有未完成的图片');
      sawDone = true;
    }
    yield parsed as GenerationEvent;
  };

  try {
    for (;;) {
      throwIfAborted(signal);
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throwIfAborted(signal);
        const detail = error instanceof Error ? error.message : String(error);
        fail(`读取生成流失败：${detail}`);
      }
      if (chunk.done) break;

      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) fail('生成流响应超过大小限制');
      buffer += decoder.decode(chunk.value, { stream: true });

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        yield* processLine(line);
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_EVENT_CHARS) fail('生成流单个事件超过大小限制');
    }

    buffer += decoder.decode();
    if (buffer !== '') yield* processLine(buffer);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      await reader.cancel();
    } catch {
      /* stream already closed or errored */
    }
    try {
      reader.releaseLock();
    } catch {
      /* reader already released */
    }
  }

  if (!sawDone) fail('生成流提前结束：没有收到 done 事件');
}

import { validateReference, type ReferenceDocument } from '../../../../packages/schema/reference.ts';
import { deviceProfileError } from './device-profiles.ts';
/**
 * IMStage studio scene model.
 *
 * Pure, framework-free logic shared by the editor, the renderer and the tests.
 * All update helpers are immutable: they never mutate the scene passed in and
 * always return a fresh object (or the exact same reference when nothing
 * changed). This keeps undo/redo predictable.
 */

export type Platform = 'wechat' | 'xiaohongshu' | 'imessage' | 'whatsapp' | 'slack' | 'instagram';
export type TemplateId = 'weekend' | 'launch' | 'welcome';
export type MessageType = 'text' | 'image' | 'location' | 'system' | 'contact' | 'transfer' | 'voice' | 'video' | 'link' | 'album';

export interface Appearance {
  background?: string;
  color?: string;
  fontSize?: number;
  radius?: number;
  spacing?: number;
}
export interface MediaItem { id: string; asset?: string; caption: string; kind: 'image' | 'video'; }
export interface Participant {
  id: string;
  name: string;
  avatar?: string;
  subtitle?: string;
}

export interface Message {
  id: string;
  participantId: string;
  type: MessageType;
  text: string;
  time: string;
  asset?: string;
  subtitle?: string;
  quote?: string;
  width?: number;
  height?: number;
  appearance?: Appearance;
  items?: MediaItem[];
}

export interface Scene {
  id: string;
  title: string;
  platform: Platform;
  deviceTime: string;
  date: string;
  selfId: string;
  participants: Participant[];
  messages: Message[];
  watermark: string;
  reference?: ReferenceDocument;
  surface?: 'ios' | 'android' | 'desktop';
  /** Optional coded device profile id; must match `surface` when present. */
  deviceProfileId?: string;
  background?: string;
  backgroundImage?: string;
  appearance?: Appearance;
  composerText?: string;
  headerText?: string;
  battery?: number;
}

export const PLATFORMS: readonly Platform[] = [
  'wechat',
  'xiaohongshu',
  'imessage',
  'whatsapp',
  'slack',
  'instagram',
];

export const TEMPLATE_IDS: readonly TemplateId[] = ['weekend', 'launch', 'welcome'];

export const MESSAGE_TYPES: readonly MessageType[] = ['text', 'image', 'location', 'system', 'contact', 'transfer', 'voice', 'video', 'link', 'album'];

export const PLATFORM_LABELS: Record<Platform, string> = {
  wechat: '微信',
  xiaohongshu: '小红书',
  imessage: 'iMessage',
  whatsapp: 'WhatsApp',
  slack: 'Slack',
  instagram: 'Instagram',
};

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  text: '文字',
  image: '图片',
  location: '定位',
  system: '系统提示',
  contact: '联系人', transfer: '转账', voice: '语音', video: '视频', link: '链接', album: '相册',
};

export const TEMPLATE_LABELS: Record<TemplateId, string> = {
  weekend: '周末看海',
  launch: '发布会预告',
  welcome: '新朋友',
};

export const DRAFT_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function isLocalImage(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 6 * 1024 * 1024 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(value);
}

function extraFields(raw: Record<string, unknown>, target: Record<string, unknown>, errors: string[]) {
  for (const key of ['subtitle','quote','composerText','headerText']) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || raw[key].length > 4000) errors.push(`${key} 必须是不超过 4000 字的文本`);
    else target[key] = raw[key];
  }
  for (const [key, min, max] of [['width',40,1200],['height',24,1800],['battery',0,100]] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max) errors.push(`${key} 超出允许范围`);
    else target[key] = raw[key];
  }
  if (raw.appearance !== undefined) {
    if (!isRecord(raw.appearance)) errors.push('appearance 必须是对象');
    else {
      const style: Record<string, unknown> = {};
      for (const key of ['background','color']) if (raw.appearance[key] !== undefined) {
        if (typeof raw.appearance[key] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(raw.appearance[key])) errors.push(`${key} 必须是六位颜色`);
        else style[key] = raw.appearance[key];
      }
      for (const [key,min,max] of [['fontSize',10,40],['radius',0,40],['spacing',0,48]] as const) if (raw.appearance[key] !== undefined) {
        const n = raw.appearance[key];
        if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) errors.push(`${key} 超出允许范围`);
        else style[key] = n;
      }
      target.appearance = style;
    }
  }
}

export function cloneScene(scene: Scene): Scene {
  if (typeof structuredClone === 'function') {
    return structuredClone(scene);
  }
  return JSON.parse(JSON.stringify(scene)) as Scene;
}

export function serializeScene(scene: Scene): string {
  return JSON.stringify(scene, null, 2);
}

/* ------------------------------------------------------------------ */
/* Synthetic templates                                                 */
/* ------------------------------------------------------------------ */

function templateWeekend(): Scene {
  return {
    id: 'scene-weekend',
    title: '周末去看海',
    platform: 'wechat',
    deviceTime: '09:41',
    date: '周六 09:38',
    selfId: 'p-linxiaoman',
    participants: [
      { id: 'p-linxiaoman', name: '林小满' },
      { id: 'p-ayuan', name: '阿远' },
    ],
    messages: [
      {
        id: 'm-1',
        participantId: 'p-linxiaoman',
        type: 'text',
        text: '周末有空吗？听说东极岛的海，比上次去的那片还要蓝。',
        time: '09:38',
      },
      {
        id: 'm-2',
        participantId: 'p-ayuan',
        type: 'text',
        text: '周六可以！不过得早点出发，下午风大。',
        time: '09:39',
      },
      {
        id: 'm-3',
        participantId: 'p-linxiaoman',
        type: 'location',
        text: '示意地点 · 东极岛码头',
        time: '09:40',
      },
      {
        id: 'm-4',
        participantId: 'p-ayuan',
        type: 'text',
        text: '好，那就周六见，我带上相机。',
        time: '09:41',
      },
    ],
    watermark: '',
  };
}

function templateLaunch(): Scene {
  return {
    id: 'scene-launch',
    title: '新品发布讨论组',
    platform: 'wechat',
    deviceTime: '14:20',
    date: '今天 14:18',
    selfId: 'p-linxiaoman',
    participants: [
      { id: 'p-linxiaoman', name: '林小满' },
      { id: 'p-ayuan', name: '阿远（设计）' },
      { id: 'p-suwan', name: '苏晚（运营）' },
    ],
    messages: [
      {
        id: 'm-1',
        participantId: '',
        type: 'system',
        text: '你邀请「苏晚（运营）」加入了群聊',
        time: '14:18',
      },
      {
        id: 'm-2',
        participantId: 'p-suwan',
        type: 'text',
        text: '发布物料我这边先出三版文案，主视觉等设计稿。',
        time: '14:19',
      },
      {
        id: 'm-3',
        participantId: 'p-ayuan',
        type: 'text',
        text: '主视觉今晚能定稿，明天上午给到封面和长图。',
        time: '14:20',
      },
      {
        id: 'm-4',
        participantId: 'p-linxiaoman',
        type: 'text',
        text: '好，那我们明早十点在这里对齐一次。',
        time: '14:20',
      },
    ],
    watermark: '',
  };
}

function templateWelcome(): Scene {
  return {
    id: 'scene-welcome',
    title: '新朋友',
    platform: 'wechat',
    deviceTime: '21:05',
    date: '21:03',
    selfId: 'p-linxiaoman',
    participants: [
      { id: 'p-linxiaoman', name: '林小满' },
      { id: 'p-ayuan', name: '阿远' },
    ],
    messages: [
      {
        id: 'm-1',
        participantId: '',
        type: 'system',
        text: '你已添加了 阿远，现在可以开始聊天了',
        time: '21:03',
      },
      {
        id: 'm-2',
        participantId: 'p-ayuan',
        type: 'text',
        text: '你好，我是阿远，从活动上加的。之后多交流。',
        time: '21:04',
      },
      {
        id: 'm-3',
        participantId: 'p-linxiaoman',
        type: 'text',
        text: '你好你好，欢迎随时聊。',
        time: '21:05',
      },
    ],
    watermark: '',
  };
}

const TEMPLATES: Record<TemplateId, Scene> = {
  weekend: templateWeekend(),
  launch: templateLaunch(),
  welcome: templateWelcome(),
};

/**
 * Build a brand new scene from a template. Every call returns an independent
 * deep copy so edits never leak into the template or another call.
 */
export function createScene(template: TemplateId = 'weekend'): Scene {
  const source = TEMPLATES[template] ?? TEMPLATES.weekend;
  return cloneScene(source);
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  scene?: Scene;
}

/**
 * Validate an untrusted value (parsed JSON, localStorage draft, form input) and
 * return a normalised scene. Unknown fields are dropped so malformed stored
 * data can never smuggle extra state into the editor.
 */
export function validateScene(value: unknown): ValidationResult {
  if (!isRecord(value)) {
    return { ok: false, errors: ['场景数据必须是一个对象'] };
  }

  const errors: string[] = [];

  const id = nonEmptyString(value.id);
  if (!id) errors.push('缺少有效的场景 id');

  const title = typeof value.title === 'string' ? value.title : '';
  if (typeof value.title !== 'string') errors.push('场景标题必须是字符串');

  const platform = PLATFORMS.includes(value.platform as Platform)
    ? (value.platform as Platform)
    : undefined;
  if (!platform) errors.push(`未知平台：${String(value.platform)}`);

  const deviceTime = typeof value.deviceTime === 'string' ? value.deviceTime : '';
  if (typeof value.deviceTime !== 'string') errors.push('设备时间必须是字符串');

  const date = typeof value.date === 'string' ? value.date : '';
  if (typeof value.date !== 'string') errors.push('日期必须是字符串');

  const participants: Participant[] = [];
  const participantIds = new Set<string>();
  if (!Array.isArray(value.participants) || value.participants.length === 0) {
    errors.push('至少需要一个参与者');
  } else {
    value.participants.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors.push(`参与者 ${index + 1} 不是对象`);
        return;
      }
      const pid = nonEmptyString(raw.id);
      const name = typeof raw.name === 'string' ? raw.name : '';
      if (!pid) errors.push(`参与者 ${index + 1} 缺少有效 id`);
      if (typeof raw.name !== 'string' || name.trim() === '') {
        errors.push(`参与者 ${index + 1} 缺少名称`);
      }
      if (raw.avatar !== undefined && typeof raw.avatar !== 'string') {
        errors.push(`参与者 ${index + 1} 的头像必须是字符串`);
      }
      if (raw.avatar && !isLocalImage(raw.avatar)) errors.push(`参与者 ${index + 1} 的头像必须是本地图片`);
      if (!pid) return;
      if (participantIds.has(pid)) errors.push(`参与者 id 重复：${pid}`);
      participantIds.add(pid);
      const participant: Participant = { id: pid, name };
      if (typeof raw.avatar === 'string' && raw.avatar !== '') participant.avatar = raw.avatar;
      if (typeof raw.subtitle === "string" && raw.subtitle.length <= 4000) participant.subtitle = raw.subtitle;
      participants.push(participant);
    });
  }

  const selfId = typeof value.selfId === 'string' ? value.selfId : '';
  if (!selfId) {
    errors.push('缺少 selfId');
  } else if (!participantIds.has(selfId)) {
    errors.push(`selfId 不在参与者列表中：${selfId}`);
  }

  const messages: Message[] = [];
  const messageIds = new Set<string>();
  if (!Array.isArray(value.messages)) {
    errors.push('messages 必须是数组');
  } else {
    value.messages.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors.push(`消息 ${index + 1} 不是对象`);
        return;
      }
      const mid = nonEmptyString(raw.id);
      if (!mid) errors.push(`消息 ${index + 1} 缺少有效 id`);
      if (mid && messageIds.has(mid)) errors.push(`消息 id 重复：${mid}`);
      if (mid) messageIds.add(mid);

      const type = MESSAGE_TYPES.includes(raw.type as MessageType)
        ? (raw.type as MessageType)
        : undefined;
      if (!type) errors.push(`消息 ${index + 1} 的类型无效：${String(raw.type)}`);

      const participantId = typeof raw.participantId === 'string' ? raw.participantId : '';
      if (type !== 'system') {
        if (!participantId) {
          errors.push(`消息 ${index + 1} 缺少发送者`);
        } else if (!participantIds.has(participantId)) {
          errors.push(`消息 ${index + 1} 的发送者不存在：${participantId}`);
        }
      }

      if (typeof raw.text !== 'string') errors.push(`消息 ${index + 1} 的文本必须是字符串`);
      if (typeof raw.time !== 'string') errors.push(`消息 ${index + 1} 的时间必须是字符串`);
      if (raw.asset !== undefined && typeof raw.asset !== 'string') {
        errors.push(`消息 ${index + 1} 的素材必须是字符串`);
      }
      if (raw.asset && !isLocalImage(raw.asset)) errors.push(`消息 ${index + 1} 的素材必须是本地图片`);

      if (!mid || !type) return;
      const message: Message = {
        id: mid,
        participantId: type === 'system' ? '' : participantId,
        type,
        text: typeof raw.text === 'string' ? raw.text : '',
        time: typeof raw.time === 'string' ? raw.time : '',
      };
      if (typeof raw.asset === 'string' && raw.asset !== '') message.asset = raw.asset;
      extraFields(raw, message as unknown as Record<string, unknown>, errors);
      if (raw.items !== undefined) {
        if (!Array.isArray(raw.items) || raw.items.length > 9) errors.push('相册最多 9 项');
        else {
          const seenItems = new Set(); message.items = [];
          for (const item of raw.items) {
            if (!isRecord(item) || typeof item.id !== 'string' || !item.id || item.id.length > 128 || seenItems.has(item.id) || !['image','video'].includes(String(item.kind)) || typeof item.caption !== 'string' || item.caption.length > 4000 || (item.asset && !isLocalImage(item.asset))) { errors.push('相册内容无效'); continue; }
            seenItems.add(item.id); message.items.push({id:item.id,caption:item.caption,kind:item.kind as 'image'|'video',...(item.asset ? {asset:item.asset as string} : {})});
          }
        }
      }
      messages.push(message);
    });
  }

  const watermark = typeof value.watermark === 'string' ? value.watermark : '';
  if (typeof value.watermark !== 'string') errors.push('水印必须是字符串');

  const extras: Record<string, unknown> = {};
  if (value.reference !== undefined) { try {extras.reference = validateReference(value.reference);} catch(e) {errors.push(e instanceof Error ? e.message : '截图文档无效');} }
  extraFields(value, extras, errors);
  if (value.surface !== undefined) {
    if (!['ios','android','desktop'].includes(String(value.surface))) errors.push('设备平台无效');
    else extras.surface = value.surface;
  }
  if (value.deviceProfileId !== undefined) {
    if (typeof value.deviceProfileId !== 'string' || value.deviceProfileId.trim() === '') {
      errors.push('设备配置 id 必须是非空字符串');
    } else {
      const surface = ['ios','android','desktop'].includes(String(value.surface)) ? String(value.surface) : undefined;
      const profileError = deviceProfileError(value.deviceProfileId, surface);
      if (profileError) errors.push(profileError);
      else extras.deviceProfileId = value.deviceProfileId;
    }
  }
  if (value.background !== undefined) {
    if (typeof value.background !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value.background)) errors.push('背景必须是六位颜色');
    else extras.background = value.background;
  }
  if (value.backgroundImage !== undefined && value.backgroundImage !== '') {
    if (!isLocalImage(value.backgroundImage)) errors.push('背景必须是本地图片');
    else extras.backgroundImage = value.backgroundImage;
  }
  if (errors.length > 0 || !id || !platform) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    errors: [],
    scene: { id, title, platform, deviceTime, date, selfId, participants, messages, watermark, ...extras },
  };
}

export function isScene(value: unknown): value is Scene {
  return validateScene(value).ok;
}

export function parseSceneJson(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['JSON 解析失败'] };
  }
  return validateScene(parsed);
}

/* ------------------------------------------------------------------ */
/* Immutable updates                                                   */
/* ------------------------------------------------------------------ */

export function nextMessageId(scene: Scene): string {
  let max = 0;
  for (const message of scene.messages) {
    const match = /(\d+)$/.exec(message.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const existing = new Set(scene.messages.map((message) => message.id));
  let candidate = max + 1;
  while (existing.has(`m-${candidate}`)) candidate += 1;
  return `m-${candidate}`;
}

export function nextParticipantId(scene: Scene): string {
  let max = 0;
  for (const participant of scene.participants) {
    const match = /(\d+)$/.exec(participant.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const existing = new Set(scene.participants.map((participant) => participant.id));
  let candidate = max + 1;
  while (existing.has(`p-${candidate}`)) candidate += 1;
  return `p-${candidate}`;
}

export type ScenePatch = Partial<Omit<Scene, 'id' | 'participants' | 'messages'>>;
export type MessagePatch = Partial<Omit<Message, 'id'>>;
export type ParticipantPatch = Partial<Omit<Participant, 'id'>>;

export function updateScene(scene: Scene, patch: ScenePatch): Scene {
  return {
    ...scene,
    ...patch,
    id: scene.id,
    participants: scene.participants,
    messages: scene.messages,
  };
}

export function updateMessage(scene: Scene, id: string, patch: MessagePatch): Scene {
  let changed = false;
  const messages = scene.messages.map((message) => {
    if (message.id !== id) return message;
    changed = true;
    const next: Message = { ...message, ...patch, id: message.id };
    if (!next.asset) delete next.asset;
    return next;
  });
  if (!changed) return scene;
  return { ...scene, messages };
}

export interface NewMessageInput {
  participantId?: string;
  type?: MessageType;
  text?: string;
  time?: string;
  asset?: string;
  subtitle?: string;
  quote?: string;
  width?: number;
  height?: number;
  appearance?: Appearance;
  items?: MediaItem[];
}

export function addMessage(scene: Scene, input: NewMessageInput = {}): Scene {
  const type = input.type ?? 'text';
  const participantId =
    type === 'system' ? '' : (input.participantId ?? scene.selfId);
  const message: Message = {
    id: nextMessageId(scene),
    participantId,
    type,
    text: input.text ?? '',
    time: input.time ?? scene.deviceTime,
  };
  if (input.asset) message.asset = input.asset;
  return { ...scene, messages: [...scene.messages, message] };
}

export function deleteMessage(scene: Scene, id: string): Scene {
  const messages = scene.messages.filter((message) => message.id !== id);
  if (messages.length === scene.messages.length) return scene;
  return { ...scene, messages };
}

export function moveMessage(scene: Scene, id: string, delta: number): Scene {
  const index = scene.messages.findIndex((message) => message.id === id);
  if (index === -1) return scene;
  const target = index + delta;
  if (target < 0 || target >= scene.messages.length) return scene;
  const messages = [...scene.messages];
  const [moved] = messages.splice(index, 1);
  messages.splice(target, 0, moved);
  return { ...scene, messages };
}

export function updateParticipant(scene: Scene, id: string, patch: ParticipantPatch): Scene {
  let changed = false;
  const participants = scene.participants.map((participant) => {
    if (participant.id !== id) return participant;
    changed = true;
    const next: Participant = { ...participant, ...patch, id: participant.id };
    if (!next.avatar) delete next.avatar;
    return next;
  });
  if (!changed) return scene;
  return { ...scene, participants };
}

export function addParticipant(scene: Scene, name: string): Scene {
  const participant: Participant = { id: nextParticipantId(scene), name };
  return { ...scene, participants: [...scene.participants, participant] };
}

/* ------------------------------------------------------------------ */
/* Versioned drafts                                                    */
/* ------------------------------------------------------------------ */

export interface Draft {
  version: number;
  scene: Scene;
  savedAt: string;
}

export interface DraftResult {
  ok: boolean;
  errors: string[];
  draft?: Draft;
}

export function serializeDraft(scene: Scene, savedAt: string = new Date().toISOString()): string {
  const draft: Draft = { version: DRAFT_VERSION, scene, savedAt };
  return JSON.stringify(draft);
}

export function parseDraft(raw: unknown): DraftResult {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ['草稿 JSON 解析失败'] };
    }
  }
  if (!isRecord(parsed)) {
    return { ok: false, errors: ['草稿必须是对象'] };
  }
  if (parsed.version !== DRAFT_VERSION) {
    return { ok: false, errors: [`不支持的草稿版本：${String(parsed.version)}`] };
  }
  const result = validateScene(parsed.scene);
  if (!result.ok || !result.scene) {
    return { ok: false, errors: result.errors };
  }
  const savedAt = typeof parsed.savedAt === 'string' ? parsed.savedAt : '';
  return { ok: true, errors: [], draft: { version: DRAFT_VERSION, scene: result.scene, savedAt } };
}

/* ------------------------------------------------------------------ */
/* Undo / redo history                                                 */
/* ------------------------------------------------------------------ */

export interface History {
  past: Scene[];
  present: Scene;
  future: Scene[];
}

export function createHistory(scene: Scene): History {
  return { past: [], present: scene, future: [] };
}

export function commit(history: History, scene: Scene): History {
  if (scene === history.present) return history;
  return { past: [...history.past, history.present], present: scene, future: [] };
}

export function undo(history: History): History {
  if (history.past.length === 0) return history;
  const past = history.past.slice(0, -1);
  const present = history.past[history.past.length - 1];
  return { past, present, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  if (history.future.length === 0) return history;
  const [present, ...future] = history.future;
  return { past: [...history.past, history.present], present, future };
}

export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

export function resetHistory(scene: Scene): History {
  return createHistory(scene);
}

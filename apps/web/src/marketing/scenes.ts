/**
 * Synthetic scenes for the public website.
 *
 * Authored content only: no real people, no private conversations, no metrics.
 * Chinese renders on the WeChat template, English on WhatsApp, so switching the
 * language also switches the platform chrome. Avatars are injected later as
 * data URIs (see `portable.ts`) because validation and export require local
 * image data, never a remote or raw static path.
 */
import type { Message, Platform, Scene } from '../studio/model';
import type { Locale } from './locale';

export type SceneKind = 'coffee' | 'weekend' | 'product';

export const SELF_ID = 'self';
export const OTHER_ID = 'other';

/** The line the hero invites the visitor to rewrite. */
export const EDITABLE_REPLY_ID = 'm2';
/** A line owned by the export section, so both areas edit different things. */
export const COMMENTARY_LINE_ID = 'm4';

/** Locale decides the platform: 中文 → WeChat, English → WhatsApp. */
export function platformFor(locale: Locale): Platform {
  return locale === 'zh' ? 'wechat' : 'whatsapp';
}

export interface ScenarioMeta {
  kind: SceneKind;
  label: Record<Locale, string>;
  caption: Record<Locale, string>;
}

export const SCENARIOS: readonly ScenarioMeta[] = [
  {
    kind: 'coffee',
    label: { zh: '街角咖啡', en: 'Corner coffee' },
    caption: { zh: '下午三点，老地方。一句邀约就够了。', en: 'Three in the afternoon, the usual place. One invitation is enough.' },
  },
  {
    kind: 'weekend',
    label: { zh: '周末看海', en: 'Weekend by the sea' },
    caption: { zh: '风很大，还是想去看海。', en: 'Windy forecast, and still worth the trip.' },
  },
  {
    kind: 'product',
    label: { zh: '产品讨论', en: 'Product notes' },
    caption: { zh: '把一次小改动，说明白就好。', en: 'One small change, explained clearly.' },
  },
];

export function isSceneKind(value: unknown): value is SceneKind {
  return value === 'coffee' || value === 'weekend' || value === 'product';
}

interface SceneData {
  title: string;
  deviceTime: string;
  date: string;
  battery: number;
  participants: Scene['participants'];
  messages: Message[];
}

function build(kind: SceneKind, locale: Locale, data: SceneData): Scene {
  return {
    id: `demo-${kind}-${locale}`,
    platform: platformFor(locale),
    selfId: SELF_ID,
    surface: 'ios',
    // The project default for new scenes; 402 × 874 logical at 3×.
    deviceProfileId: 'iphone-17-pro',
    watermark: '',
    ...data,
  };
}

function coffee(locale: Locale): Scene {
  return locale === 'zh'
    ? build('coffee', locale, {
        title: '街角咖啡',
        deviceTime: '15:02',
        date: '今天',
        battery: 68,
        participants: [
          { id: SELF_ID, name: '我' },
          { id: OTHER_ID, name: '阿远' },
        ],
        messages: [
          { id: 'm1', participantId: SELF_ID, type: 'text', text: '下午三点，老地方？', time: '14:52' },
          { id: EDITABLE_REPLY_ID, participantId: OTHER_ID, type: 'text', text: '好，给你留了靠窗的位置。', time: '14:53' },
          { id: 'm3', participantId: OTHER_ID, type: 'location', text: '示意地点 · 街角咖啡', subtitle: '示意位置', time: '14:53' },
          { id: COMMENTARY_LINE_ID, participantId: SELF_ID, type: 'text', text: '那杯桂花拿铁，我来点。', time: '14:54' },
        ],
      })
    : build('coffee', locale, {
        title: 'Corner coffee',
        deviceTime: '15:02',
        date: 'Today',
        battery: 68,
        participants: [
          { id: SELF_ID, name: 'You' },
          { id: OTHER_ID, name: 'Ava' },
        ],
        messages: [
          { id: 'm1', participantId: SELF_ID, type: 'text', text: '3pm, the usual place?', time: '14:52' },
          { id: EDITABLE_REPLY_ID, participantId: OTHER_ID, type: 'text', text: 'Saved you the window seat.', time: '14:53' },
          { id: 'm3', participantId: OTHER_ID, type: 'location', text: 'Demo location · Corner Coffee', subtitle: 'Illustrative location', time: '14:53' },
          { id: COMMENTARY_LINE_ID, participantId: SELF_ID, type: 'text', text: "I'll get the oat latte this time.", time: '14:54' },
        ],
      });
}

function weekend(locale: Locale): Scene {
  return locale === 'zh'
    ? build('weekend', locale, {
        title: '周末看海',
        deviceTime: '09:12',
        date: '周六',
        battery: 81,
        participants: [
          { id: SELF_ID, name: '我' },
          { id: OTHER_ID, name: '阿远' },
        ],
        messages: [
          { id: 'm1', participantId: SELF_ID, type: 'text', text: '周六出发？风大，记得带外套。', time: '09:05' },
          { id: EDITABLE_REPLY_ID, participantId: OTHER_ID, type: 'text', text: '好，我订了早班船。', time: '09:06' },
          { id: 'm3', participantId: OTHER_ID, type: 'location', text: '示意地点 · 东极岛码头', subtitle: '示意位置', time: '09:06' },
          { id: COMMENTARY_LINE_ID, participantId: SELF_ID, type: 'text', text: '那就周六见，我带上相机。', time: '09:07' },
        ],
      })
    : build('weekend', locale, {
        title: 'Weekend by the sea',
        deviceTime: '09:12',
        date: 'Saturday',
        battery: 81,
        participants: [
          { id: SELF_ID, name: 'You' },
          { id: OTHER_ID, name: 'Noah' },
        ],
        messages: [
          { id: 'm1', participantId: SELF_ID, type: 'text', text: 'Still on for Saturday? It gets windy out there.', time: '09:05' },
          { id: EDITABLE_REPLY_ID, participantId: OTHER_ID, type: 'text', text: 'Booked the early ferry.', time: '09:06' },
          { id: 'm3', participantId: OTHER_ID, type: 'location', text: 'Demo location · Island pier', subtitle: 'Illustrative location', time: '09:06' },
          { id: COMMENTARY_LINE_ID, participantId: SELF_ID, type: 'text', text: 'See you Saturday — bringing my camera.', time: '09:07' },
        ],
      });
}

function product(locale: Locale): Scene {
  return locale === 'zh'
    ? build('product', locale, {
        title: '产品讨论组',
        deviceTime: '11:05',
        date: '今天',
        battery: 57,
        participants: [
          { id: SELF_ID, name: '我' },
          { id: 'p-su', name: '苏晚' },
          { id: 'p-ay', name: '阿远' },
        ],
        messages: [
          { id: 'm0', participantId: '', type: 'system', text: '你邀请「苏晚」加入了群聊', time: '10:58' },
          { id: 'm1', participantId: 'p-su', type: 'text', text: '首页那句标题，我想压到两行。', time: '11:00' },
          { id: EDITABLE_REPLY_ID, participantId: 'p-ay', type: 'text', text: '可以，今晚出个版本，明早一起过。', time: '11:01' },
          { id: COMMENTARY_LINE_ID, participantId: SELF_ID, type: 'text', text: '好，明早十点这里见。', time: '11:02' },
        ],
      })
    : build('product', locale, {
        title: 'Product notes',
        deviceTime: '11:05',
        date: 'Today',
        battery: 57,
        participants: [
          { id: SELF_ID, name: 'You' },
          { id: 'p-su', name: 'Priya' },
          { id: 'p-ay', name: 'Leo' },
        ],
        messages: [
          { id: 'm0', participantId: '', type: 'system', text: 'You added Priya to the group', time: '10:58' },
          { id: 'm1', participantId: 'p-su', type: 'text', text: 'The home headline should wrap to two lines.', time: '11:00' },
          { id: EDITABLE_REPLY_ID, participantId: 'p-ay', type: 'text', text: "I can have a version tonight; let's review in the morning.", time: '11:01' },
          { id: COMMENTARY_LINE_ID, participantId: SELF_ID, type: 'text', text: 'Morning, 10. See you here.', time: '11:02' },
        ],
      });
}

/** Build a fresh, independent scene. Edits never leak between calls. */
export function createScenario(kind: SceneKind, locale: Locale): Scene {
  if (kind === 'weekend') return weekend(locale);
  if (kind === 'product') return product(locale);
  return coffee(locale);
}

/* --------------------------------------------------------- edit helpers */
export function setMessageText(scene: Scene, id: string, text: string): Scene {
  return { ...scene, messages: scene.messages.map((message) => (message.id === id ? { ...message, text } : message)) };
}

export function setParticipantName(scene: Scene, id: string, name: string): Scene {
  return { ...scene, participants: scene.participants.map((participant) => (participant.id === id ? { ...participant, name } : participant)) };
}

export function messageText(scene: Scene, id: string): string {
  return scene.messages.find((message) => message.id === id)?.text ?? '';
}

export function participantName(scene: Scene, id: string): string {
  return scene.participants.find((participant) => participant.id === id)?.name ?? '';
}

/** The first participant who is not the visitor; the "other person" field target. */
export function otherParticipantId(scene: Scene): string {
  return scene.participants.find((participant) => participant.id !== scene.selfId)?.id ?? OTHER_ID;
}

export function isTextMessage(scene: Scene, id: string): boolean {
  return scene.messages.some((message) => message.id === id && message.type === 'text');
}

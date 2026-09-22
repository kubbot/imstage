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

export type SceneKind = 'coffee' | 'weekend' | 'product' | 'wukang';

export const SELF_ID = 'self';
export const OTHER_ID = 'other';

/**
 * The default scenario is an authored AI story. Its ids are stable because the
 * playback, the portable asset swap and the Agent seed all reference them.
 *
 * `WUKANG_OTHER_ID` deliberately does not match a legacy avatar role: Su Wan
 * keeps text initials until the parent imports her matching fictional portrait,
 * which the bounded loader can then attach without touching legacy scenes.
 */
export const WUKANG_OTHER_ID = 'su';
export const WUKANG_PHOTO_ID = 'photo';

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
    kind: 'wukang',
    label: { zh: '武康路的傍晚', en: 'Wukang Road, evening' },
    caption: { zh: '一句邀约，等她把照片发过来。', en: 'One invitation, and the photo she sends back.' },
  },
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
  return value === 'coffee' || value === 'weekend' || value === 'product' || value === 'wukang';
}

/**
 * Read an explicit `?scenario=` (search or hash query) so old links such as
 * `/?scenario=coffee` keep selecting their scene. Unknown values fall back to
 * the caller's default instead of failing the page.
 */
export function readScenarioParam(search: string, hash: string): SceneKind | null {
  const queries: string[] = [];
  if (search) queries.push(search.startsWith('?') ? search : `?${search}`);
  const hashQuery = hash.indexOf('?');
  if (hashQuery >= 0) queries.push(hash.slice(hashQuery));
  for (const query of queries) {
    const value = new URLSearchParams(query).get('scenario');
    if (isSceneKind(value)) return value;
  }
  return null;
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

/** The authored instruction the visitor can edit and carry into the Agent. */
export const WUKANG_PROMPT: Record<Locale, string> = {
  zh: '我约了苏晚在武康路见面。我问她在哪里，她请路人拍了一张照片发给我。',
  en: 'I asked Su Wan to meet me on Wukang Road. I asked where she was, and she had a passerby take a photo and sent it to me.',
};

/**
 * The default scenario: a short, fully authored AI story. The conversation is
 * ordinary on purpose — the proof is that an instruction became dialogue, a
 * pause and a photograph. `WUKANG_PHOTO_ID` is the image message the bounded
 * asset loader fills in; until then it renders the renderer's preparing state.
 */
function wukang(locale: Locale): Scene {
  return locale === 'zh'
    ? build('wukang', locale, {
        title: '武康路的傍晚',
        deviceTime: '18:55',
        date: '今天',
        battery: 62,
        participants: [
          { id: SELF_ID, name: '我' },
          { id: WUKANG_OTHER_ID, name: '苏晚' },
        ],
        messages: [
          { id: 'm1', participantId: SELF_ID, type: 'text', text: '你到哪里了？', time: '18:52' },
          { id: 'm2', participantId: WUKANG_OTHER_ID, type: 'text', text: '武康路。等我，给你发张照片。', time: '18:53' },
          { id: WUKANG_PHOTO_ID, participantId: WUKANG_OTHER_ID, type: 'image', text: '', time: '18:54' },
          { id: 'm3', participantId: WUKANG_OTHER_ID, type: 'text', text: '刚请路人帮我拍的。认得出我吗？', time: '18:54' },
          { id: COMMENTARY_LINE_ID, participantId: SELF_ID, type: 'text', text: '看见你了。别动，我过来。', time: '18:55' },
        ],
      })
    : build('wukang', locale, {
        title: 'Wukang Road, evening',
        deviceTime: '18:55',
        date: 'Today',
        battery: 62,
        participants: [
          { id: SELF_ID, name: 'You' },
          { id: WUKANG_OTHER_ID, name: 'Su Wan' },
        ],
        messages: [
          { id: 'm1', participantId: SELF_ID, type: 'text', text: 'Where are you?', time: '18:52' },
          { id: 'm2', participantId: WUKANG_OTHER_ID, type: 'text', text: 'On Wukang Road. Give me a second — sending a photo.', time: '18:53' },
          { id: WUKANG_PHOTO_ID, participantId: WUKANG_OTHER_ID, type: 'image', text: '', time: '18:54' },
          { id: 'm3', participantId: WUKANG_OTHER_ID, type: 'text', text: "Just asked a passerby to take it. Can you tell it's me?", time: '18:54' },
          { id: COMMENTARY_LINE_ID, participantId: SELF_ID, type: 'text', text: "I see you. Stay there, I'm coming over.", time: '18:55' },
        ],
      });
}

/** Build a fresh, independent scene. Edits never leak between calls. */
export function createScenario(kind: SceneKind, locale: Locale): Scene {
  if (kind === 'wukang') return wukang(locale);
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

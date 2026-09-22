/**
 * The authored Wukang story, as a bounded playback program.
 *
 * This module is pure and browser-free: it defines the beats, derives the frame
 * for any beat index, and turns a frame into a real `Scene` for the shared
 * renderer. The React timer/visibility hook lives in `useStoryPlayback.ts`, so
 * the story rules can be unit-tested in Node without a DOM.
 *
 * The playback replays one AI-authored example. It never claims that a paid
 * model is running: only the explicit "Create with AI" CTA opens the real Agent.
 */
import type { Scene } from '../studio/model';
import { WUKANG_PHOTO_ID } from './scenes.ts';
import type { Locale } from './locale';

export type StoryBeatKind = 'read' | 'message' | 'typing' | 'preparing' | 'photo';

export interface StoryBeat {
  id: string;
  kind: StoryBeatKind;
  /** Message revealed on this beat (photo beats reference the image message). */
  messageId?: string;
  /** Index into PROCESS_STEPS that is highlighted during this beat. */
  step: number;
  duration: number;
}

/** The authored process the visitor watches, one step per stage of the story. */
export const PROCESS_STEPS: Record<Locale, readonly string[]> = {
  zh: ['读懂指令', '写出对白', '生成照片', '交给你改'],
  en: ['Reads the prompt', 'Writes the dialogue', 'Creates the photo', 'Hands it back to edit'],
};

export const STORY_LEAD_IN_MS = 800;

export const BEATS: readonly StoryBeat[] = [
  { id: 'read', kind: 'read', step: 0, duration: 700 },
  { id: 'ask', kind: 'message', messageId: 'm1', step: 1, duration: 1100 },
  { id: 'reply-typing', kind: 'typing', step: 1, duration: 900 },
  { id: 'reply', kind: 'message', messageId: 'm2', step: 1, duration: 1000 },
  { id: 'photo-preparing', kind: 'preparing', messageId: WUKANG_PHOTO_ID, step: 2, duration: 1200 },
  { id: 'photo-ready', kind: 'photo', messageId: WUKANG_PHOTO_ID, step: 2, duration: 1100 },
  { id: 'caption-typing', kind: 'typing', step: 2, duration: 800 },
  { id: 'caption', kind: 'message', messageId: 'm3', step: 3, duration: 1000 },
  { id: 'answer', kind: 'message', messageId: 'm4', step: 3, duration: 700 },
];

export const STORY_STEP_COUNT = PROCESS_STEPS.zh.length;

/** Every message id the playback can reveal, in first-appearance order. */
export const STORY_MESSAGE_IDS: readonly string[] = BEATS.reduce<string[]>((ids, beat) => {
  if (beat.messageId && !ids.includes(beat.messageId)) ids.push(beat.messageId);
  return ids;
}, []);

/** Whole playback length including the lead-in, used by tests and copy. */
export function storyDurationMs(): number {
  return STORY_LEAD_IN_MS + BEATS.reduce((total, beat) => total + beat.duration, 0);
}

export type PhotoState = 'hidden' | 'preparing' | 'ready';

export interface StoryFrame {
  /** -1 before the first beat; `BEATS.length - 1` once complete. */
  beatIndex: number;
  step: number;
  revealed: readonly string[];
  typing: boolean;
  photo: PhotoState;
  complete: boolean;
}

const LAST_BEAT = BEATS.length - 1;
const COMPLETE_FRAME: StoryFrame = {
  beatIndex: LAST_BEAT,
  step: STORY_STEP_COUNT - 1,
  revealed: STORY_MESSAGE_IDS,
  typing: false,
  photo: 'ready',
  complete: true,
};

/**
 * Fold the beats up to `beatIndex` into one frame. Passing of time is the only
 * input, so the same beat index always renders the same conversation.
 */
export function storyFrame(beatIndex: number, complete = false): StoryFrame {
  if (complete) return COMPLETE_FRAME;
  const index = Math.max(-1, Math.min(beatIndex, LAST_BEAT));
  const revealed: string[] = [];
  let photo: PhotoState = 'hidden';
  let step = 0;
  for (let i = 0; i <= index; i += 1) {
    const beat = BEATS[i];
    step = beat.step;
    if (beat.messageId && !revealed.includes(beat.messageId)) revealed.push(beat.messageId);
    if (beat.kind === 'preparing') photo = 'preparing';
    if (beat.kind === 'photo') photo = 'ready';
  }
  return {
    beatIndex: index,
    step,
    revealed,
    typing: index >= 0 && BEATS[index].kind === 'typing',
    photo,
    complete: false,
  };
}

export function storyCompleteFrame(): StoryFrame {
  return COMPLETE_FRAME;
}

/* ---------------------------------------------------------- eligibility */

/** Minimum visible fraction of the stage that counts as "on screen". */
export const HOST_VISIBLE_RATIO = 0.25;

export type PlaybackAction = 'none' | 'play' | 'resume' | 'pause';

export interface PlaybackEligibility {
  status: 'idle' | 'playing' | 'paused' | 'done';
  pauseReason: 'manual' | 'offscreen' | 'hidden' | null;
  hostVisible: boolean;
  documentVisible: boolean;
  reducedMotion: boolean;
}

/**
 * The single rule for every automatic start, resume and pause.
 *
 * Automatic playback requires the stage on screen AND the document visible.
 * A manual pause is never overridden by the environment; an environmental pause
 * (off-screen or hidden tab) resumes only when both conditions hold again.
 */
export function nextPlaybackAction(input: PlaybackEligibility): PlaybackAction {
  const eligible = input.hostVisible && input.documentVisible;
  // Explicit replay still obeys background/offscreen pausing in reduced motion.
  if (input.status === 'playing' && !eligible) return 'pause';
  if (input.reducedMotion) return 'none';
  if (input.status === 'idle') return eligible ? 'play' : 'none';
  if (input.status === 'playing') return eligible ? 'none' : 'pause';
  if (input.status === 'paused' && input.pauseReason !== 'manual') return eligible ? 'resume' : 'none';
  return 'none';
}

/** Why the environment forced a pause: a hidden tab outranks an off-screen stage. */
export function pauseReasonFor(hostVisible: boolean, documentVisible: boolean): 'hidden' | 'offscreen' {
  return documentVisible && !hostVisible ? 'offscreen' : 'hidden';
}

/* --------------------------------------------------------------- scene */

/** True once every authored message is on screen and the photo has resolved. */
export function storyIsComplete(scene: Scene, frame: StoryFrame): boolean {
  return frame.complete && frame.photo === 'ready' && frame.revealed.length === STORY_MESSAGE_IDS.length;
}

/** True while the photo beat is showing its honest preparing state. */
export function framePhotoPending(frame: StoryFrame, photoReady: boolean): boolean {
  return frame.photo === 'preparing' || (frame.photo === 'ready' && !photoReady);
}

/**
 * Render one frame from the complete authored scene. Messages keep their
 * authored order. The image message is only revealed once the photo is both
 * narratively ready and actually loaded, so the shared renderer never shows its
 * generic missing-image placeholder in the middle of the story.
 */
export function sceneForFrame(base: Scene, frame: StoryFrame, photoReady = false): Scene {
  const messages = base.messages.filter((message) => {
    if (message.id === WUKANG_PHOTO_ID) return frame.photo === 'ready' && photoReady;
    return frame.revealed.includes(message.id);
  });
  return { ...base, messages };
}

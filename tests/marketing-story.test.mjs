/**
 * Story playback and handoff contracts for the landing page.
 *
 * Pure rules only, so they run without a browser: how a beat index folds into a
 * frame, how a frame becomes a real scene, that the playback is bounded, and
 * that an instruction travels with the scene through sessionStorage under a
 * bound and never through a query value.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { WUKANG_PHOTO_ID, createScenario } from '../apps/web/src/marketing/scenes.ts';
import {
  BEATS,
  HOST_VISIBLE_RATIO,
  STORY_LEAD_IN_MS,
  STORY_MESSAGE_IDS,
  STORY_STEP_COUNT,
  PROCESS_STEPS,
  framePhotoPending,
  nextPlaybackAction,
  pauseReasonFor,
  sceneForFrame,
  storyCompleteFrame,
  storyDurationMs,
  storyFrame,
  storyIsComplete,
} from '../apps/web/src/marketing/story.ts';
import { MAX_HANDOFF_PROMPT, handoffKey, readHandoffPayload, readHandoffScene, writeHandoffScene } from '../apps/web/src/marketing/handoff.ts';

const LAST = BEATS.length - 1;

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    size: () => map.size,
  };
}

test('the playback is bounded to one short, terminating sequence', () => {
  const total = storyDurationMs();
  assert.equal(total, STORY_LEAD_IN_MS + BEATS.reduce((sum, beat) => sum + beat.duration, 0));
  assert.ok(total > 8000 && total < 10500, `playback length ${total}ms`);
  assert.ok(BEATS.length >= 8);
  for (const beat of BEATS) {
    assert.ok(beat.duration > 0, beat.id);
    assert.ok(beat.step >= 0 && beat.step < STORY_STEP_COUNT, beat.id);
  }
  // Every authored message is revealed exactly once (photo beats repeat the id).
  assert.deepEqual([...STORY_MESSAGE_IDS], ['m1', 'm2', WUKANG_PHOTO_ID, 'm3', 'm4']);
});

test('a beat index folds deterministically into a frame', () => {
  const before = storyFrame(-1);
  assert.deepEqual(before.revealed, []);
  assert.equal(before.typing, false);
  assert.equal(before.photo, 'hidden');
  assert.equal(before.step, 0);
  assert.equal(before.complete, false);

  const first = storyFrame(1);
  assert.deepEqual(first.revealed, ['m1']);
  assert.equal(first.step, 1);
  assert.equal(first.typing, false);

  const typing = BEATS.findIndex((beat) => beat.kind === 'typing');
  assert.equal(storyFrame(typing).typing, true);
  assert.equal(storyFrame(typing + 1).typing, false);

  const preparing = BEATS.findIndex((beat) => beat.kind === 'preparing');
  assert.equal(storyFrame(preparing).photo, 'preparing');
  assert.ok(storyFrame(preparing).revealed.includes(WUKANG_PHOTO_ID));
  const ready = BEATS.findIndex((beat) => beat.kind === 'photo');
  assert.equal(storyFrame(ready).photo, 'ready');

  const clamped = storyFrame(999);
  assert.equal(clamped.beatIndex, LAST);
  assert.equal(clamped.complete, false);

  const complete = storyFrame(LAST, true);
  assert.equal(complete.complete, true);
  assert.equal(complete.photo, 'ready');
  assert.equal(complete.step, STORY_STEP_COUNT - 1);
  assert.deepEqual([...complete.revealed], [...STORY_MESSAGE_IDS]);
  assert.deepEqual(storyCompleteFrame(), complete);
});

test('a frame renders the authored scene without the shared missing-image placeholder', () => {
  const base = createScenario('wukang', 'zh');
  const empty = sceneForFrame(base, storyFrame(-1));
  assert.equal(empty.messages.length, 0);
  assert.equal(empty.title, base.title);
  assert.equal(empty.participants.length, 2);

  // During the photo beat's preparation the image message is withheld entirely,
  // so the shared renderer never shows its generic missing-image placeholder.
  const preparing = storyFrame(BEATS.findIndex((beat) => beat.kind === 'preparing'));
  assert.equal(framePhotoPending(preparing, true), true);
  assert.deepEqual(sceneForFrame(base, preparing, true).messages.map((message) => message.id), ['m1', 'm2']);
  assert.deepEqual(sceneForFrame(base, preparing, false).messages.map((message) => message.id), ['m1', 'm2']);

  // The photo arrives only when the narrative is ready and the asset is local.
  const ready = storyFrame(BEATS.findIndex((beat) => beat.kind === 'photo'));
  assert.equal(framePhotoPending(ready, true), false);
  assert.equal(framePhotoPending(ready, false), true);
  assert.deepEqual(sceneForFrame(base, ready, true).messages.map((message) => message.id), ['m1', 'm2', WUKANG_PHOTO_ID]);
  assert.deepEqual(sceneForFrame(base, ready, false).messages.map((message) => message.id), ['m1', 'm2']);

  const complete = sceneForFrame(base, storyCompleteFrame(), true);
  assert.deepEqual(complete.messages.map((message) => message.id), base.messages.map((message) => message.id));
  assert.equal(complete.messages.length, 5);
  // Without the loaded asset a "complete" frame is still honest: no image row.
  assert.equal(sceneForFrame(base, storyCompleteFrame(), false).messages.length, 4);
  assert.equal(storyIsComplete(base, storyCompleteFrame()), true);
  assert.equal(storyIsComplete(base, storyFrame(LAST)), false);

  // Same input, same output: the export snapshot is reproducible.
  assert.deepEqual(sceneForFrame(base, storyFrame(4), true), sceneForFrame(base, storyFrame(4), true));
  // And the base scene is never mutated.
  assert.equal(base.messages.length, 5);
});

test('automatic playback requires an on-screen stage in a visible document', () => {
  assert.equal(HOST_VISIBLE_RATIO, 0.25);
  const base = { status: 'idle', pauseReason: null, hostVisible: false, documentVisible: true, reducedMotion: false };
  // An idle observer must not start a hidden or off-screen story.
  assert.equal(nextPlaybackAction(base), 'none');
  assert.equal(nextPlaybackAction({ ...base, hostVisible: true, documentVisible: false }), 'none');
  assert.equal(nextPlaybackAction({ ...base, hostVisible: true }), 'play');
  assert.equal(nextPlaybackAction({ ...base, hostVisible: true, documentVisible: false, reducedMotion: true }), 'none');

  // Playing is paused by either environmental condition.
  const playing = { status: 'playing', pauseReason: null, hostVisible: true, documentVisible: true, reducedMotion: false };
  assert.equal(nextPlaybackAction({ ...playing, hostVisible: false }), 'pause');
  assert.equal(nextPlaybackAction({ ...playing, documentVisible: false }), 'pause');
  assert.equal(nextPlaybackAction({ ...playing, hostVisible: false, documentVisible: false }), 'pause');
  assert.equal(nextPlaybackAction(playing), 'none');
  assert.equal(nextPlaybackAction({ ...playing, reducedMotion: true }), 'none');
  assert.equal(nextPlaybackAction({ ...playing, reducedMotion: true, hostVisible: false }), 'pause');
  assert.equal(nextPlaybackAction({ ...playing, reducedMotion: true, documentVisible: false }), 'pause');
  assert.equal(nextPlaybackAction({ ...playing, reducedMotion: true, status: 'paused', pauseReason: 'offscreen' }), 'none');

  // An environmental pause resumes only when BOTH conditions hold again.
  const pausedOffscreen = { status: 'paused', pauseReason: 'offscreen', hostVisible: false, documentVisible: true, reducedMotion: false };
  assert.equal(nextPlaybackAction(pausedOffscreen), 'none');
  assert.equal(nextPlaybackAction({ ...pausedOffscreen, hostVisible: true, documentVisible: false }), 'none');
  assert.equal(nextPlaybackAction({ ...pausedOffscreen, hostVisible: true }), 'resume');
  const pausedHidden = { ...pausedOffscreen, pauseReason: 'hidden', hostVisible: true, documentVisible: false };
  assert.equal(nextPlaybackAction(pausedHidden), 'none');
  assert.equal(nextPlaybackAction({ ...pausedHidden, documentVisible: true }), 'resume');

  // A manual pause is never overridden by the environment.
  const manual = { status: 'paused', pauseReason: 'manual', hostVisible: true, documentVisible: true, reducedMotion: false };
  assert.equal(nextPlaybackAction(manual), 'none');
  assert.equal(nextPlaybackAction({ ...manual, hostVisible: false, documentVisible: false }), 'none');

  // A finished story never restarts on its own.
  assert.equal(nextPlaybackAction({ ...playing, status: 'done' }), 'none');

  assert.equal(pauseReasonFor(false, true), 'offscreen');
  assert.equal(pauseReasonFor(true, false), 'hidden');
  assert.equal(pauseReasonFor(false, false), 'hidden');
});

test('the four process steps are authored in both languages', () => {
  assert.equal(PROCESS_STEPS.zh.length, STORY_STEP_COUNT);
  assert.equal(PROCESS_STEPS.en.length, STORY_STEP_COUNT);
  for (const locale of ['zh', 'en']) {
    for (const step of PROCESS_STEPS[locale]) assert.ok(step.trim().length > 0);
  }
  // Every step is reachable during the playback.
  const reached = new Set(BEATS.map((beat) => beat.step));
  for (let step = 0; step < STORY_STEP_COUNT; step += 1) assert.ok(reached.has(step), `step ${step}`);
});

test('an instruction travels with the scene inside a bounded session payload', () => {
  const storage = memoryStorage();
  globalThis.sessionStorage = storage;
  const scene = createScenario('wukang', 'zh');
  const prompt = '我约了苏晚在武康路见面。';
  const token = writeHandoffScene(scene, prompt);
  assert.ok(token);
  assert.equal(readHandoffScene(token).title, scene.title);
  const payload = readHandoffPayload(token);
  assert.equal(payload.scene.title, scene.title);
  assert.equal(payload.prompt, prompt);
  // No query value carries the instruction; only the random token does.
  assert.ok(!token.includes(prompt));

  // The prompt is bounded, not merely re-validated on read.
  const long = writeHandoffScene(scene, 'x'.repeat(MAX_HANDOFF_PROMPT * 3));
  assert.equal(readHandoffPayload(long).prompt.length, MAX_HANDOFF_PROMPT);
  // Blank instructions are dropped rather than stored as an empty string.
  const blank = writeHandoffScene(scene, '   ');
  assert.equal(readHandoffPayload(blank).prompt, undefined);

  // A legacy scene-only payload still reads as a scene.
  globalThis.sessionStorage.setItem(handoffKey(token), JSON.stringify(scene));
  assert.equal(readHandoffScene(token).title, scene.title);
  assert.equal(readHandoffPayload(token).prompt, undefined);

  delete globalThis.sessionStorage;
});

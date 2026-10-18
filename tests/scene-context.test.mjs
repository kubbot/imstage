/**
 * GET-35 — voice transcripts inside the bounded Agent scene context.
 *
 * The explicit transcript is ordinary visible scene content for the model:
 * it joins the bounded scene context within the existing per-message text cap,
 * never leaks hidden/oracle payloads, and never appears when the scene does not
 * carry one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSceneContext,
  checkSceneLimits,
  preserveAssetsById,
  stripSceneAssets,
  targetedChangeViolation,
} from '../services/agent/scene-context.mjs';
import { createScene, validateScene } from '../apps/web/src/studio/model.ts';

const TRANSCRIPT = '这段文字稿是创作者显式录入的合成台词。';

function sceneWithVoice(extra = {}) {
  const base = createScene('weekend');
  return {
    ...base,
    messages: [
      { id: 'm-1', participantId: 'p-ayuan', type: 'voice', text: '', time: '09:41', voiceTranscript: TRANSCRIPT, ...extra },
    ],
  };
}

test('buildSceneContext includes the explicit transcript within the existing text cap', () => {
  const { text } = buildSceneContext(sceneWithVoice(), 48 * 1024);
  assert.ok(text.includes(TRANSCRIPT), 'transcript is visible scene content for the model');
  const parsed = JSON.parse(text);
  assert.equal(parsed.messages[0].voiceTranscript, TRANSCRIPT);
  assert.equal(parsed.messages[0].type, 'voice');
});

test('buildSceneContext never materialises a transcript the scene does not carry', () => {
  const { text } = buildSceneContext(createScene('weekend'), 48 * 1024);
  assert.ok(!text.includes('voiceTranscript'), 'no invented field for messages without one');
});

test('buildSceneContext bounds the transcript like message text (2000 chars)', () => {
  const long = '长'.repeat(2500);
  const { text } = buildSceneContext(sceneWithVoice({ voiceTranscript: long }), 48 * 1024);
  const parsed = JSON.parse(text);
  assert.equal(parsed.messages[0].voiceTranscript.length, 2000, 'context copy is truncated to the existing per-message cap');
  assert.ok(parsed.messages[0].voiceTranscript.endsWith('…'));
});

test('checkSceneLimits rejects an over-long transcript defensively', () => {
  assert.equal(checkSceneLimits(sceneWithVoice()), null);
  const reason = checkSceneLimits(sceneWithVoice({ voiceTranscript: '长'.repeat(2001) }));
  assert.match(reason, /语音文字稿超过 2000 字/);
});

test('asset stripping/preservation keeps text transcripts untouched', () => {
  const scene = validateScene(sceneWithVoice()).scene;
  const stripped = stripSceneAssets(scene);
  assert.equal(stripped.messages[0].voiceTranscript, TRANSCRIPT);
  const preserved = preserveAssetsById(stripped, scene);
  assert.equal(preserved.messages[0].voiceTranscript, TRANSCRIPT);
});

test('targeted edits may change the selected transcript only', () => {
  const before = validateScene(sceneWithVoice()).scene;
  const ownEdit = validateScene(sceneWithVoice({ voiceTranscript: '只改这一条。' })).scene;
  assert.equal(targetedChangeViolation(before, ownEdit, 'm-1'), null, 'editing the target transcript is allowed');

  const other = validateScene({
    ...sceneWithVoice(),
    messages: [
      ...sceneWithVoice().messages,
      { id: 'm-2', participantId: 'p-linxiaoman', type: 'voice', text: '', time: '09:42', voiceTranscript: '不该被改动' },
    ],
  }).scene;
  const changedOther = JSON.parse(JSON.stringify(other));
  changedOther.messages[1].voiceTranscript = '越权改动';
  assert.match(targetedChangeViolation(other, changedOther, 'm-1'), /不能修改其他/);
});

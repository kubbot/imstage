/**
 * GET-35 — explicit voice transcripts at the shared model layer.
 *
 * RED/GREEN coverage for the optional `Message.voiceTranscript` contract:
 * omission keeps legacy voice scenes byte/semantic compatible, validation is
 * strict (type/length/voice-only), no hidden legacy data is ever inferred as a
 * transcript, and the explicit TEXT→VOICE conversion is one reversible edit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogueSignature } from '../services/projects/automation-store.mjs';

import {
  addMessage,
  commit,
  createHistory,
  createScene,
  parseDraft,
  parseSceneJson,
  serializeDraft,
  serializeScene,
  undo,
  updateMessage,
  validateScene,
} from '../apps/web/src/studio/model.ts';
import { VoiceTranscriptError, assertVoiceTranscript, messageTypeChangePatch, newVoiceMessageInput } from '../apps/web/src/studio/voice-transcript.ts';
import {
  VOICE_TRANSCRIPT_MAX,
  hasVoiceTranscript,
  voiceTranscriptError,
} from '../packages/schema/voice.mjs';

function legacyVoiceScene(extra = {}) {
  return {
    ...createScene('weekend'),
    messages: [
      {
        id: 'm-1',
        participantId: 'p-ayuan',
        type: 'voice',
        text: '12 秒',
        subtitle: '语音标签',
        time: '09:41',
        ...extra,
      },
    ],
  };
}

function voiceScene(extra = {}) {
  return legacyVoiceScene({ text: '', subtitle: undefined, ...extra });
}

test('dialogue identity distinguishes explicit voice wording while preserving legacy hashes', () => {
  assert.equal(dialogueSignature(createScene('weekend')), '78e7eb8413d093d95cf45786f7ae661a52f87793449bc8a52dfb61b1df9fc3e9');
  const legacy = voiceScene();
  assert.equal(dialogueSignature(legacy), '428eb6ac332915a262d81e060ff567e8fb67da3bd8c0a1624257edd5f5568405');
  for (const voiceTranscript of ['', '  \n  ']) {
    assert.equal(dialogueSignature(voiceScene({ voiceTranscript })), dialogueSignature(legacy));
  }
  const first = voiceScene({ voiceTranscript: '明天上午九点在码头见。' });
  const second = voiceScene({ voiceTranscript: '这周取消行程，下周再约。' });
  assert.equal(validateScene(first).ok, true);
  assert.equal(validateScene(second).ok, true);
  assert.notEqual(dialogueSignature(first), dialogueSignature(second), 'different authored voice messages are not duplicate cases');
  assert.equal(dialogueSignature(voiceScene({ voiceTranscript: '  Bring\n the camera. ' })), dialogueSignature(voiceScene({ voiceTranscript: 'Bring the camera.' })), 'existing whitespace-insensitive dialogue semantics apply');
});

/* ------------------------------------------------------------------ */
/* optional field + legacy compatibility                               */
/* ------------------------------------------------------------------ */

test('voiceTranscript is optional: legacy voice scenes validate without gaining one', () => {
  const result = validateScene(legacyVoiceScene());
  assert.equal(result.ok, true, result.errors.join('；'));
  const [message] = result.scene.messages;
  assert.equal('voiceTranscript' in message, false);
  assert.equal(message.text, '12 秒', 'legacy text stays the bubble label');
  assert.equal(message.subtitle, '语音标签', 'legacy subtitle stays the label/duration');
  assert.ok(!serializeScene(result.scene).includes('voiceTranscript'), 'exported scene stays byte-compatible');

  // Re-importing the exported scene is a semantic no-op.
  const again = parseSceneJson(serializeScene(result.scene));
  assert.equal(again.ok, true);
  assert.deepEqual(again.scene.messages, result.scene.messages);

  // Draft round trip keeps the absence.
  const draft = parseDraft(serializeDraft(result.scene));
  assert.equal(draft.ok, true);
  assert.equal('voiceTranscript' in draft.draft.scene.messages[0], false);
});

test('loading an old voice scene never treats text/subtitle as a hidden transcript', () => {
  const raw = JSON.parse(serializeScene(validateScene(legacyVoiceScene()).scene));
  // Simulate a really old payload with juicy "hidden" wording in both legacy fields.
  raw.messages[0].text = '记得带相机，周六码头见';
  raw.messages[0].subtitle = '3′42″';
  const result = parseSceneJson(JSON.stringify(raw));
  assert.equal(result.ok, true);
  const [message] = result.scene.messages;
  assert.equal('voiceTranscript' in message, false);
  assert.equal(hasVoiceTranscript(message), false);
  assert.equal(message.text, '记得带相机，周六码头见', 'wording stays in its legacy field');
});

/* ------------------------------------------------------------------ */
/* strict validation                                                   */
/* ------------------------------------------------------------------ */

test('an explicit transcript is kept and survives draft/export round trips', () => {
  const wording = '周六可以！不过得早点出发，下午风大。\nBring the camera — see you at the dock.';
  const result = validateScene(voiceScene({ voiceTranscript: wording }));
  assert.equal(result.ok, true, result.errors.join('；'));
  assert.equal(result.scene.messages[0].voiceTranscript, wording, 'exact wording preserved');
  assert.ok(serializeScene(result.scene).includes('voiceTranscript'), 'exported scene carries the transcript');

  const draft = parseDraft(serializeDraft(result.scene));
  assert.equal(draft.ok, true);
  assert.equal(draft.draft.scene.messages[0].voiceTranscript, wording);
  assert.deepEqual(draft.draft.scene.messages[0], result.scene.messages[0]);
});

test('validateScene rejects invalid transcript types instead of dropping them', () => {
  for (const bad of [123, null, true, { text: 'hidden payload' }, ['nested']]) {
    const result = validateScene(voiceScene({ voiceTranscript: bad }));
    assert.equal(result.ok, false, `type ${JSON.stringify(bad)} must be rejected`);
    assert.ok(result.errors.some((error) => error.includes('voiceTranscript 必须是字符串')));
  }
});

test('validateScene rejects over-long transcripts (max 2000) instead of truncating them', () => {
  assert.equal(VOICE_TRANSCRIPT_MAX, 2000);
  const atLimit = validateScene(voiceScene({ voiceTranscript: '好'.repeat(VOICE_TRANSCRIPT_MAX) }));
  assert.equal(atLimit.ok, true, atLimit.errors.join('；'));
  const overLimit = validateScene(voiceScene({ voiceTranscript: '好'.repeat(VOICE_TRANSCRIPT_MAX + 1) }));
  assert.equal(overLimit.ok, false);
  assert.ok(overLimit.errors.some((error) => error.includes('voiceTranscript 不能超过 2000 字')));
});

test('validateScene rejects a transcript on non-voice messages (no hidden payloads)', () => {
  for (const type of ['text', 'image', 'system', 'contact', 'location', 'video', 'link', 'album']) {
    const scene = {
      ...createScene('weekend'),
      messages: [{ id: 'm-1', participantId: type === 'system' ? '' : 'p-ayuan', type, text: '你好', time: '09:41', voiceTranscript: '不该出现在这里' }],
    };
    const result = validateScene(scene);
    assert.equal(result.ok, false, `${type} must reject voiceTranscript`);
    assert.ok(result.errors.some((error) => error.includes('只能用于语音')));
  }
});

test('voiceTranscriptError is total and reports exactly one reason', () => {
  assert.equal(voiceTranscriptError(undefined, 'voice'), undefined);
  assert.equal(voiceTranscriptError(undefined, 'text'), undefined);
  assert.equal(voiceTranscriptError('ok', 'voice'), undefined);
  assert.match(voiceTranscriptError('ok', 'text'), /只能用于语音/);
  assert.match(voiceTranscriptError(7, 'voice'), /必须是字符串/);
  assert.match(voiceTranscriptError('a'.repeat(VOICE_TRANSCRIPT_MAX + 1), 'voice'), /不能超过/);
});

/* ------------------------------------------------------------------ */
/* explicit conversion + undo/redo                                     */
/* ------------------------------------------------------------------ */

test('an explicit TEXT→VOICE switch copies the wording once and undo restores the text message', () => {
  const scene = createScene('weekend');
  const original = scene.messages.find((message) => message.id === 'm-1');
  assert.equal(original.type, 'text');

  let history = createHistory(scene);
  history = commit(history, updateMessage(scene, original.id, messageTypeChangePatch(original, 'voice', scene.selfId)));

  const converted = history.present.messages.find((message) => message.id === original.id);
  assert.equal(converted.type, 'voice');
  assert.equal(converted.voiceTranscript, original.text, 'authored wording becomes the visible transcript');
  assert.equal(converted.text, '', 'voice bubble falls back to its neutral label');
  assert.equal(converted.subtitle, undefined, 'no invented duration');

  const restored = undo(history).present;
  assert.deepEqual(restored.messages.find((message) => message.id === original.id), original, 'one reversible edit');
  assert.equal(restored.messages.find((message) => message.id === original.id).voiceTranscript, undefined);
});

test('loading an old voice message never auto-copies labels when switching types', () => {
  const scene = validateScene(legacyVoiceScene()).scene;
  const voice = scene.messages[0];
  // VOICE → TEXT keeps the legacy label wording and never creates a transcript.
  const patch = messageTypeChangePatch(voice, 'text', scene.selfId);
  assert.equal(patch.voiceTranscript, undefined);
  const next = updateMessage(scene, voice.id, patch);
  assert.equal(next.messages[0].type, 'text');
  assert.equal('voiceTranscript' in next.messages[0], false);
  assert.equal(next.messages[0].text, '12 秒');
});

test('VOICE→TEXT moves an explicit transcript back into the visible text', () => {
  const scene = validateScene(voiceScene({ voiceTranscript: '周六码头见。' })).scene;
  const voice = scene.messages[0];
  const next = updateMessage(scene, voice.id, messageTypeChangePatch(voice, 'text', scene.selfId));
  assert.equal(next.messages[0].type, 'text');
  assert.equal(next.messages[0].text, '周六码头见。');
  assert.equal('voiceTranscript' in next.messages[0], false, 'non-voice messages cannot keep a transcript');
});

test('every other type conversion simply drops the invalid transcript', () => {
  const scene = validateScene(voiceScene({ voiceTranscript: '周六码头见。' })).scene;
  const voice = scene.messages[0];
  for (const type of ['image', 'location', 'contact', 'video', 'link', 'album']) {
    const patch = messageTypeChangePatch(voice, type, scene.selfId);
    assert.equal(patch.voiceTranscript, undefined, `${type} conversion keeps no transcript`);
    const next = updateMessage(scene, voice.id, patch);
    assert.equal(validateScene(next).ok, true);
  }
});

test('Inspector direct merges can leave a voice message with an explicit empty transcript', () => {
  for (const transcript of ['', '周六码头见。']) {
    const scene = validateScene(voiceScene({ voiceTranscript: transcript })).scene;
    const voice = scene.messages[0];
    for (const type of ['text', 'image', 'system']) {
      // ElementInspector merges the patch directly before validateScene; it
      // does not call updateMessage, which normalizes an empty transcript.
      const patch = messageTypeChangePatch(voice, type, scene.selfId);
      const result = validateScene({ ...scene, messages: [{ ...voice, ...patch }] });
      assert.equal(result.ok, true, `${type}: ${result.errors.join('；')}`);
      assert.equal(Object.hasOwn(result.scene.messages[0], 'voiceTranscript'), false);
      if (type === 'text') assert.equal(result.scene.messages[0].text, transcript);
    }
  }
});

/* ------------------------------------------------------------------ */
/* new voice composer                                                  */
/* ------------------------------------------------------------------ */

test('new voice composer input makes the words an explicit synthetic transcript', () => {
  const scene = addMessage(createScene('weekend'), newVoiceMessageInput('周六可以，早点出发。', 'p-ayuan', '09:42'));
  const created = scene.messages[scene.messages.length - 1];
  assert.equal(created.type, 'voice');
  assert.equal(created.voiceTranscript, '周六可以，早点出发。');
  assert.equal(created.text, '', 'neutral voice label at render time, not invented wording');
  assert.equal(created.subtitle, undefined, 'no invented real duration');
  assert.equal(validateScene(scene).ok, true, validateScene(scene).errors.join('；'));
});

test('addMessage enforces the same transcript contract', () => {
  const base = createScene('weekend');
  assert.throws(() => addMessage(base, newVoiceMessageInput('x'.repeat(VOICE_TRANSCRIPT_MAX + 1), 'p-ayuan', '09:42')), /不能超过/);
  assert.throws(() => addMessage(base, { type: 'text', text: 'hi', voiceTranscript: 'sneaky' }), /只能用于语音/);
});

test('updateMessage treats an empty transcript as omission', () => {
  const scene = validateScene(voiceScene({ voiceTranscript: '周六码头见。' })).scene;
  const cleared = updateMessage(scene, scene.messages[0].id, { voiceTranscript: '' });
  assert.equal('voiceTranscript' in cleared.messages[0], false);
  assert.ok(!serializeScene(cleared).includes('voiceTranscript'));
});

test('rendered presence helper never invents a transcript', () => {
  assert.equal(hasVoiceTranscript({}), false);
  assert.equal(hasVoiceTranscript({ voiceTranscript: '' }), false);
  assert.equal(hasVoiceTranscript({ voiceTranscript: '   ' }), false);
  assert.equal(hasVoiceTranscript({ text: '12 秒', subtitle: '旧标签' }), false);
  assert.equal(hasVoiceTranscript({ voiceTranscript: '文字' }), true);
});

/* ------------------------------------------------------------------ */
/* GET-35 repair: reject over-long submissions BEFORE state change     */
/* ------------------------------------------------------------------ */

test('a 2001-char text→voice conversion is rejected with a typed error and keeps the old scene valid', () => {
  const longWording = '长'.repeat(2001);
  const scene = validateScene({
    ...createScene('weekend'),
    messages: [{ id: 'm-1', participantId: 'p-ayuan', type: 'text', text: longWording, time: '09:41' }],
  }).scene;
  const before = structuredClone(scene);

  assert.throws(
    () => messageTypeChangePatch(scene.messages[0], 'voice', scene.selfId),
    (error) => {
      assert.ok(error instanceof VoiceTranscriptError, 'typed error');
      assert.equal(error.code, 'voice_transcript_invalid');
      assert.match(error.message, /2000/);
      return true;
    },
  );
  // Nothing was truncated or mutated: the old scene stays byte-identical and valid.
  assert.deepEqual(scene, before, 'scene untouched by the rejected conversion');
  assert.equal(validateScene(scene).ok, true, 'old scene remains valid');
  assert.equal(parseDraft(serializeDraft(scene)).ok, true, 'draft round trip still succeeds');
});

test('exact 2000 chars convert and round-trip multiline Unicode unchanged', () => {
  const wording = '周六码头见 📷\n' + '字'.repeat(1990) + '完';
  assert.equal(wording.length, 2000);
  assert.ok(wording.includes('\n') && wording.includes('📷'), 'multiline + non-BMP wording');
  const scene = validateScene({
    ...createScene('weekend'),
    messages: [{ id: 'm-1', participantId: 'p-ayuan', type: 'text', text: wording, time: '09:41' }],
  }).scene;

  const patch = messageTypeChangePatch(scene.messages[0], 'voice', scene.selfId);
  assert.equal(patch.voiceTranscript, wording, 'exact wording copied at the 2000 cap');
  const converted = updateMessage(scene, 'm-1', patch);
  assert.equal(validateScene(converted).ok, true);
  const draft = parseDraft(serializeDraft(converted));
  assert.equal(draft.ok, true);
  assert.equal(draft.draft.scene.messages[0].voiceTranscript, wording, 'multiline Unicode round trip exact');
});

test('voice composer oversize input throws the typed error instead of silently truncating', () => {
  assert.throws(
    () => newVoiceMessageInput('长'.repeat(VOICE_TRANSCRIPT_MAX + 1), 'p-ayuan', '09:42'),
    (error) => error instanceof VoiceTranscriptError && error.code === 'voice_transcript_invalid' && /2000/.test(error.message),
  );
  // At the exact cap the input is accepted; one more char is rejected, never cut.
  assert.equal(newVoiceMessageInput('长'.repeat(VOICE_TRANSCRIPT_MAX), 'p-ayuan', '09:42').voiceTranscript.length, VOICE_TRANSCRIPT_MAX);
  assert.throws(() => assertVoiceTranscript('长'.repeat(VOICE_TRANSCRIPT_MAX + 1)), VoiceTranscriptError);
  assert.doesNotThrow(() => assertVoiceTranscript('正常文字稿。\nSecond line.'));
});

test('existing ordinary text input is never length-restricted by the transcript cap', () => {
  const longWording = '字'.repeat(5000);
  const result = validateScene({
    ...createScene('weekend'),
    messages: [{ id: 'm-1', participantId: 'p-ayuan', type: 'text', text: longWording, time: '09:41' }],
  });
  assert.equal(result.ok, true, '5000-char ordinary text stays legal');
  assert.equal(result.scene.messages[0].text, longWording);
});

/* ------------------------------------------------------------------ */
/* ElementInspector shared conversion semantics                        */
/* ------------------------------------------------------------------ */

test('inspector conversions: voice→image drops the transcript in one undoable gesture', () => {
  const scene = validateScene(voiceScene({ voiceTranscript: '周六码头见。' })).scene;
  const before = structuredClone(scene);
  const patch = messageTypeChangePatch(scene.messages[0], 'image', scene.selfId);
  assert.equal(patch.voiceTranscript, undefined);
  const next = updateMessage(scene, scene.messages[0].id, patch);
  assert.equal(validateScene(next).ok, true, 'inspector apply() would accept the single change');
  assert.equal('voiceTranscript' in next.messages[0], false);
  // One gesture = one history step: undo restores the exact voice message.
  const history = commit(createHistory(scene), next);
  assert.deepEqual(undo(history).present, scene);
  assert.deepEqual(scene, before);
});

test('inspector conversions never promote legacy voice labels into transcripts', () => {
  const scene = validateScene(legacyVoiceScene()).scene;
  const voice = scene.messages[0];
  for (const type of ['text', 'image', 'location', 'contact', 'video', 'link', 'album']) {
    const patch = messageTypeChangePatch(voice, type, scene.selfId);
    assert.equal(patch.voiceTranscript, undefined, `${type}: no label promotion`);
    const next = updateMessage(scene, voice.id, patch);
    assert.equal(validateScene(next).ok, true, `${type}: converted scene valid`);
    assert.equal('voiceTranscript' in next.messages[0], false);
  }
});

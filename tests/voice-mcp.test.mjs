/**
 * GET-35 — `voiceTranscript` on the shared MCP/Agent operation surface.
 *
 * Existing create_scene / upsert_message / update operations can supply and
 * modify the explicit transcript with strict server validation and the normal
 * same-account bounds; nothing else changes and no hidden payload can ride
 * along on another message type.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createScene, validateScene } from '../apps/web/src/studio/model.ts';
import {
  adaptSceneForRenderer,
  applyScenePatch,
  enforceSceneBounds,
  prepareCreateScene,
} from '../services/mcp/scene.mjs';
import { executeTool } from '../services/agent/tools.mjs';
import { VOICE_TRANSCRIPT_MAX } from '../packages/schema/voice.mjs';

function voiceMessage(extra = {}) {
  return { id: 'm-1', participantId: 'p-ayuan', type: 'voice', text: '', time: '09:41', voiceTranscript: '周六码头见。', ...extra };
}

function sceneWith(message) {
  const base = createScene('weekend');
  return { ...base, messages: [message] };
}

/** MCP scene ids are server-owned; callers must omit them. */
function serverOwned(scene) {
  const { id: _serverOwned, ...rest } = scene;
  return rest;
}

/* ------------------------------------------------------------------ */
/* MCP adapter                                                         */
/* ------------------------------------------------------------------ */

test('MCP create_scene accepts a bounded explicit transcript on voice messages', () => {
  const prepared = prepareCreateScene(serverOwned(sceneWith(voiceMessage())), { sceneId: 'scn_' + 'a'.repeat(32) });
  assert.equal(prepared.messages[0].voiceTranscript, '周六码头见。');
  const { scene: adapted } = adaptSceneForRenderer(prepared);
  assert.equal(adapted.messages[0].voiceTranscript, '周六码头见。');
});

test('MCP strict validation rejects wrong types, over-long values and non-voice use', () => {
  assert.throws(
    () => enforceSceneBounds(sceneWith(voiceMessage({ voiceTranscript: 42 }))),
    (error) => error.code === 'invalid_request' && /voiceTranscript/.test(error.message),
  );
  assert.throws(
    () => enforceSceneBounds(sceneWith(voiceMessage({ voiceTranscript: 'x'.repeat(VOICE_TRANSCRIPT_MAX + 1) }))),
    (error) => error.code === 'limit_exceeded' && /voiceTranscript/.test(error.message),
  );
  assert.throws(
    () => enforceSceneBounds(sceneWith({ id: 'm-1', participantId: 'p-ayuan', type: 'text', text: '你好', time: '09:41', voiceTranscript: 'sneaky' })),
    (error) => error.code === 'invalid_request' && /只能用于 type=voice/.test(error.message),
  );
  // A typo of the field name is still an unknown field, never a silent drop.
  assert.throws(
    () => enforceSceneBounds(sceneWith(voiceMessage({ voiceTranscripts: 'typo' }))),
    (error) => error.code === 'invalid_request' && /未知字段/.test(error.message),
  );
});

test('MCP update patch can modify the transcript and keeps strict bounds', () => {
  const prepared = prepareCreateScene(serverOwned(sceneWith(voiceMessage())), { sceneId: 'scn_' + 'b'.repeat(32) });
  const patched = applyScenePatch(prepared, {
    updateMessages: [{ id: 'm-1', voiceTranscript: '改后的文字稿，仍然逐字保留。' }],
  });
  assert.equal(patched.scene.messages[0].voiceTranscript, '改后的文字稿，仍然逐字保留。');
  assert.equal(patched.changed, true);

  assert.throws(
    () => applyScenePatch(prepared, { updateMessages: [{ id: 'm-1', voiceTranscript: 'x'.repeat(VOICE_TRANSCRIPT_MAX + 1) }] }),
    (error) => error.code === 'limit_exceeded',
  );
});

/* ------------------------------------------------------------------ */
/* Agent tools                                                         */
/* ------------------------------------------------------------------ */

test('agent upsert_message can create and modify an explicit transcript', async () => {
  const scene = validateScene(sceneWith({ id: 'm-1', participantId: 'p-ayuan', type: 'voice', text: '', time: '09:41' })).scene;

  const created = await executeTool('upsert_message', {
    message: { id: 'm-2', participantId: 'p-ayuan', type: 'voice', text: '', time: '09:42', voiceTranscript: '这段是按虚构脚本写的台词。' },
  }, { scene });
  assert.equal(created.ok, true, created.detail);
  assert.equal(created.scene.messages[1].voiceTranscript, '这段是按虚构脚本写的台词。');

  const updated = await executeTool('upsert_message', {
    message: { id: 'm-2', participantId: 'p-ayuan', type: 'voice', text: '', time: '09:42', voiceTranscript: '改好了。' },
  }, { scene: created.scene });
  assert.equal(updated.ok, true, updated.detail);
  assert.equal(updated.scene.messages[1].voiceTranscript, '改好了。');
});

test('agent create_scene carries explicit transcripts and never invents missing ones', async () => {
  const scene = validateScene(sceneWith({ id: 'm-1', participantId: 'p-ayuan', type: 'voice', text: '12 秒', subtitle: '旧标签', time: '09:41' })).scene;
  const rebuilt = await executeTool('create_scene', {
    scene: {
      id: scene.id,
      title: scene.title,
      platform: scene.platform,
      deviceTime: scene.deviceTime,
      date: scene.date,
      selfId: scene.selfId,
      participants: scene.participants,
      watermark: scene.watermark,
      messages: [
        { id: 'm-1', participantId: 'p-ayuan', type: 'voice', text: '12 秒', subtitle: '旧标签', time: '09:41' },
        { id: 'm-2', participantId: 'p-linxiaoman', type: 'voice', text: '', time: '09:42', voiceTranscript: '新建语音的文字稿。' },
      ],
    },
  }, { scene });
  assert.equal(rebuilt.ok, true, rebuilt.detail);
  assert.equal('voiceTranscript' in rebuilt.scene.messages[0], false, 'old voice wording is never migrated');
  assert.equal(rebuilt.scene.messages[1].voiceTranscript, '新建语音的文字稿。');
});

test('agent tools reject a transcript on non-voice messages and over-long values', async () => {
  const scene = validateScene(sceneWith({ id: 'm-1', participantId: 'p-ayuan', type: 'text', text: '你好', time: '09:41' })).scene;
  const wrongType = await executeTool('upsert_message', {
    message: { id: 'm-1', participantId: 'p-ayuan', type: 'text', text: '你好呀', time: '09:41', voiceTranscript: '不该出现' },
  }, { scene });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.detail, /voiceTranscript|校验失败/);

  const tooLong = await executeTool('upsert_message', {
    message: { id: 'm-2', participantId: 'p-ayuan', type: 'voice', text: '', time: '09:42', voiceTranscript: 'x'.repeat(VOICE_TRANSCRIPT_MAX + 1) },
  }, { scene });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.detail, /2000|校验失败/);
});

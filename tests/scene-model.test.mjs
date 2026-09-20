import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAFT_VERSION,
  MESSAGE_TYPES,
  PLATFORMS,
  addMessage,
  addParticipant,
  canRedo,
  canUndo,
  commit,
  createHistory,
  createScene,
  deleteMessage,
  isScene,
  moveMessage,
  nextMessageId,
  nextParticipantId,
  parseDraft,
  parseSceneJson,
  redo,
  resetHistory,
  serializeDraft,
  serializeScene,
  undo,
  updateMessage,
  updateParticipant,
  updateScene,
  validateScene,
} from '../apps/web/src/studio/model.ts';

/* ------------------------------------------------------------------ */
/* templates                                                           */
/* ------------------------------------------------------------------ */

test('createScene("weekend") matches the sample brief', () => {
  const scene = createScene('weekend');
  assert.deepEqual(PLATFORMS, ['wechat', 'xiaohongshu', 'imessage', 'whatsapp', 'slack']);
  assert.equal(scene.platform, 'wechat');
  assert.equal(scene.messages.length, 4);
  assert.equal(scene.watermark, '');
  assert.deepEqual(
    scene.participants.map((p) => p.name),
    ['林小满', '阿远'],
  );
  const location = scene.messages.find((m) => m.type === 'location');
  assert.ok(location, 'weekend template includes a location message');
  assert.match(location.text, /示意地点/);
  assert.ok(scene.messages.every((m) => typeof m.id === 'string' && m.id !== ''));
});

test('createScene("launch") has a three-person design launch group', () => {
  const scene = createScene('launch');
  assert.equal(scene.participants.length, 3);
  assert.ok(scene.messages.some((m) => m.type === 'text'));
});

test('createScene("welcome") starts with a new-friend system message', () => {
  const scene = createScene('welcome');
  assert.equal(scene.messages[0].type, 'system');
  assert.equal(scene.messages[0].participantId, '');
});

test('createScene returns independent fresh copies with stable message ids', () => {
  const first = createScene('weekend');
  const second = createScene('weekend');
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.messages, second.messages);
  assert.notStrictEqual(first.participants, second.participants);
  assert.deepEqual(
    first.messages.map((m) => m.id),
    second.messages.map((m) => m.id),
  );

  first.messages[0].text = '被修改';
  first.participants[0].name = '被改名';
  assert.notEqual(second.messages[0].text, '被修改');
  assert.notEqual(second.participants[0].name, '被改名');
  assert.equal(
    createScene('weekend').messages[0].text,
    '周末有空吗？听说东极岛的海，比上次去的那片还要蓝。',
  );
});

/* ------------------------------------------------------------------ */
/* immutable updates                                                   */
/* ------------------------------------------------------------------ */

test('updateScene returns a new scene and leaves the original untouched', () => {
  const before = createScene('weekend');
  const snapshot = serializeScene(before);
  const after = updateScene(before, { title: '新的标题', watermark: 'IMStage' });
  assert.notStrictEqual(after, before);
  assert.equal(after.title, '新的标题');
  assert.equal(after.watermark, 'IMStage');
  assert.equal(serializeScene(before), snapshot);
  assert.strictEqual(after.messages, before.messages);
  assert.strictEqual(after.id, before.id);
});

test('updateMessage replaces only the target message', () => {
  const before = createScene('weekend');
  const targetId = before.messages[1].id;
  const after = updateMessage(before, targetId, { text: '改过的内容', time: '10:00' });
  assert.notStrictEqual(after, before);
  assert.notStrictEqual(after.messages, before.messages);
  assert.strictEqual(after.messages[1].text, '改过的内容');
  assert.strictEqual(after.messages[1].time, '10:00');
  assert.strictEqual(after.messages[1].id, targetId);
  assert.strictEqual(before.messages[1].text, '周六可以！不过得早点出发，下午风大。');
  assert.strictEqual(after.messages[0], before.messages[0]);
});

test('updateMessage on a missing id returns the same reference', () => {
  const before = createScene('weekend');
  assert.strictEqual(updateMessage(before, 'm-404', { text: 'x' }), before);
});

test('addMessage appends with a unique stable id without mutating the source', () => {
  const before = createScene('weekend');
  const expectedId = nextMessageId(before);
  const after = addMessage(before, { type: 'text', text: '新消息' });
  assert.notStrictEqual(after, before);
  assert.equal(before.messages.length, 4);
  assert.equal(after.messages.length, 5);
  assert.equal(after.messages[4].id, expectedId);
  assert.equal(after.messages[4].text, '新消息');
  assert.equal(after.messages[4].participantId, before.selfId);
  assert.equal(after.messages[4].time, before.deviceTime);
});

test('addMessage defaults system messages to an empty sender', () => {
  const after = addMessage(createScene('welcome'), { type: 'system', text: '系统提示' });
  assert.equal(after.messages.at(-1).participantId, '');
});

test('deleteMessage removes the target immutably and no-ops on unknown ids', () => {
  const before = createScene('weekend');
  const after = deleteMessage(before, 'm-2');
  assert.equal(after.messages.length, 3);
  assert.equal(before.messages.length, 4);
  assert.ok(!after.messages.some((m) => m.id === 'm-2'));
  assert.strictEqual(deleteMessage(before, 'm-404'), before);
});

test('moveMessage reorders immutably and clamps out-of-range moves', () => {
  const before = createScene('weekend');
  const after = moveMessage(before, 'm-1', 1);
  assert.deepEqual(
    after.messages.map((m) => m.id),
    ['m-2', 'm-1', 'm-3', 'm-4'],
  );
  assert.deepEqual(
    before.messages.map((m) => m.id),
    ['m-1', 'm-2', 'm-3', 'm-4'],
  );
  assert.strictEqual(moveMessage(before, 'm-1', -1), before);
  assert.strictEqual(moveMessage(before, 'm-4', 1), before);
});

test('updateParticipant renames and clears avatars immutably', () => {
  const before = createScene('weekend');
  const withAvatar = updateParticipant(before, 'p-ayuan', { avatar: 'data:image/png;base64,AAA' });
  assert.equal(withAvatar.participants[1].avatar, 'data:image/png;base64,AAA');
  assert.equal(before.participants[1].avatar, undefined);
  assert.equal(withAvatar.participants[1].name, '阿远');

  const cleared = updateParticipant(withAvatar, 'p-ayuan', { avatar: undefined });
  assert.equal(cleared.participants[1].avatar, undefined);
});

test('addParticipant allocates a stable unique id', () => {
  const before = createScene('weekend');
  const expected = nextParticipantId(before);
  const after = addParticipant(before, '苏晚');
  assert.equal(after.participants.at(-1).id, expected);
  assert.equal(after.participants.length, 3);
  assert.equal(before.participants.length, 2);
  const again = addParticipant(after, '第四人');
  assert.notEqual(again.participants.at(-1).id, expected);
});

test('message ids stay unique even for non-numeric ids', () => {
  const scene = createScene('weekend');
  scene.messages[0].id = 'draft-note';
  const id = nextMessageId(scene);
  assert.ok(!scene.messages.some((m) => m.id === id));
  assert.deepEqual(MESSAGE_TYPES, ['text', 'image', 'location', 'system']);
});

/* ------------------------------------------------------------------ */
/* validation                                                          */
/* ------------------------------------------------------------------ */

test('validateScene accepts a well-formed scene and normalises it', () => {
  const scene = createScene('weekend');
  const result = validateScene({ ...scene, unknownField: 'nope' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.scene);
  assert.equal(result.scene.title, scene.title);
  assert.ok(!('unknownField' in result.scene));
  assert.equal(isScene(result.scene), true);
});

test('validateScene rejects non-objects and missing core fields', () => {
  assert.equal(validateScene(null).ok, false);
  assert.equal(validateScene([]).ok, false);
  assert.equal(validateScene('scene').ok, false);
  const missing = validateScene({ id: 'x' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.length > 0);
});

test('validateScene rejects unknown platforms and message types', () => {
  const scene = createScene('weekend');
  const badPlatform = validateScene({ ...scene, platform: 'telegram' });
  assert.equal(badPlatform.ok, false);
  assert.ok(badPlatform.errors.some((e) => e.includes('平台')));

  const badType = createScene('weekend');
  badType.messages[0].type = 'sticker';
  const result = validateScene(badType);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('类型')));
});

test('validateScene rejects broken participants and dangling senders', () => {
  const noParticipants = { ...createScene('weekend'), participants: [] };
  assert.equal(validateScene(noParticipants).ok, false);

  const duplicate = createScene('weekend');
  duplicate.participants[1].id = duplicate.participants[0].id;
  assert.equal(validateScene(duplicate).ok, false);

  const dangling = createScene('weekend');
  dangling.messages[0].participantId = 'p-ghost';
  const result = validateScene(dangling);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('发送者')));
});

test('validateScene rejects a selfId that is not a participant', () => {
  const scene = createScene('weekend');
  scene.selfId = 'p-nobody';
  assert.equal(validateScene(scene).ok, false);
});

test('validateScene rejects non-array messages and bad field types', () => {
  const scene = createScene('weekend');
  const notArray = validateScene({ ...scene, messages: 'nope' });
  assert.equal(notArray.ok, false);
  assert.ok(notArray.errors.some((e) => e.includes('数组')));

  const badWatermark = validateScene({ ...scene, watermark: 42 });
  assert.equal(badWatermark.ok, false);

  const badText = createScene('weekend');
  badText.messages[0].text = null;
  assert.equal(validateScene(badText).ok, false);
});

test('parseSceneJson handles corrupt JSON and valid JSON', () => {
  assert.equal(parseSceneJson('{not json').ok, false);
  assert.equal(parseSceneJson('null').ok, false);
  const good = parseSceneJson(JSON.stringify(createScene('launch')));
  assert.equal(good.ok, true);
  assert.equal(good.scene.participants.length, 3);
});

/* ------------------------------------------------------------------ */
/* drafts                                                              */
/* ------------------------------------------------------------------ */

test('draft round-trips through serializeDraft and parseDraft', () => {
  const scene = createScene('launch');
  const raw = serializeDraft(scene, '2026-09-20T00:00:00.000Z');
  const parsed = parseDraft(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.draft.version, DRAFT_VERSION);
  assert.equal(parsed.draft.savedAt, '2026-09-20T00:00:00.000Z');
  assert.deepEqual(parsed.draft.scene, scene);
});

test('parseDraft rejects corrupt, mis-versioned and malformed drafts', () => {
  assert.equal(parseDraft('{broken').ok, false);
  assert.equal(parseDraft(JSON.stringify({ version: 99, scene: createScene() })).ok, false);
  assert.equal(parseDraft(JSON.stringify({ version: DRAFT_VERSION, scene: { id: 'x' } })).ok, false);
  assert.equal(parseDraft(JSON.stringify({ version: DRAFT_VERSION })).ok, false);
  assert.equal(parseDraft(DRAFT_VERSION).ok, false);

  const corrupt = createScene('weekend');
  corrupt.messages[0].type = 'unknown';
  const result = parseDraft({ version: DRAFT_VERSION, scene: corrupt, savedAt: '' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

/* ------------------------------------------------------------------ */
/* undo / redo                                                         */
/* ------------------------------------------------------------------ */

test('history supports commit, undo and redo', () => {
  const first = createScene('weekend');
  const second = updateScene(first, { title: '第二版' });
  const third = updateScene(second, { title: '第三版' });

  let history = createHistory(first);
  assert.equal(canUndo(history), false);
  assert.equal(canRedo(history), false);

  history = commit(history, second);
  history = commit(history, third);
  assert.equal(history.present.title, '第三版');
  assert.equal(canUndo(history), true);

  history = undo(history);
  assert.equal(history.present.title, '第二版');
  history = undo(history);
  assert.equal(history.present.title, '周末去看海');
  assert.equal(canUndo(history), false);

  history = redo(history);
  assert.equal(history.present.title, '第二版');
  history = redo(history);
  assert.equal(history.present.title, '第三版');
  assert.equal(canRedo(history), false);
});

test('a new commit clears the redo branch', () => {
  const first = createScene('weekend');
  let history = createHistory(first);
  history = commit(history, updateScene(first, { title: 'A' }));
  history = undo(history);
  assert.equal(canRedo(history), true);
  history = commit(history, updateScene(first, { title: 'B' }));
  assert.equal(canRedo(history), false);
  history = redo(history);
  assert.equal(history.present.title, 'B');
});

test('committing the same reference is a no-op', () => {
  const scene = createScene('weekend');
  const history = createHistory(scene);
  assert.strictEqual(commit(history, scene), history);
  assert.strictEqual(undo(history), history);
  assert.strictEqual(redo(history), history);
});

test('undo isolation: histories and scenes never leak into each other', () => {
  const sceneA = createScene('weekend');
  const sceneB = createScene('launch');
  let historyA = createHistory(sceneA);
  let historyB = createHistory(sceneB);

  historyA = commit(historyA, updateMessage(sceneA, 'm-1', { text: 'A 的第一条' }));
  assert.equal(historyB.present, sceneB);
  assert.equal(sceneB.messages[0].text, '你邀请「苏晚（运营）」加入了群聊');

  historyB = commit(historyB, addMessage(sceneB, { type: 'text', text: 'B 追加' }));
  assert.equal(historyA.present.messages.length, 4);
  assert.equal(historyB.present.messages.length, 5);

  historyA = undo(historyA);
  assert.equal(historyA.present.messages[0].text, '周末有空吗？听说东极岛的海，比上次去的那片还要蓝。');
  assert.equal(historyB.present.messages.length, 5);
  assert.equal(historyA.present.messages.length, 4);

  const histA = historyA;
  historyB = commit(historyB, updateScene(historyB.present, { title: 'B 改标题' }));
  assert.equal(histA.present.title, '周末去看海');
  assert.equal(historyA.present.title, '周末去看海');
});

test('resetHistory drops the past and future', () => {
  const first = createScene('weekend');
  let history = createHistory(first);
  history = commit(history, updateScene(first, { title: '改动' }));
  history = undo(history);
  const reset = resetHistory(createScene('welcome'));
  assert.deepEqual(reset, { past: [], present: createScene('welcome'), future: [] });
  assert.notEqual(reset.present.platform, 'imessage');
});

test('validation failure never mutates the input object', () => {
  const scene = createScene('weekend');
  scene.messages[0].type = 'broken';
  const snapshot = JSON.stringify(scene);
  validateScene(scene);
  parseSceneJson(snapshot);
  assert.equal(JSON.stringify(scene), snapshot);
});

test('untrusted drafts cannot request external images or unsupported data content', () => {
  for (const value of ['https://example.com/tracker.png', 'data:text/html;base64,YQ==', 'javascript:alert(1)']) {
    const scene = createScene(); scene.participants[0].avatar = value;
    assert.equal(validateScene(scene).ok, false);
    delete scene.participants[0].avatar; scene.messages[0].asset = value;
    assert.equal(validateScene(scene).ok, false);
  }
});

test('scene date and device time survive draft round trip independently', () => {
  const scene = updateScene(createScene(), { date: '2026-08-12', deviceTime: '21:10' });
  const restored = parseDraft(serializeDraft(scene)).draft.scene;
  assert.equal(restored.date, '2026-08-12'); assert.equal(restored.deviceTime, '21:10');
});

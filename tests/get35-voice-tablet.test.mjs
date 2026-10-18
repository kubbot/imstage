/**
 * GET-35 — tablet `ipad-window` preset + shared voice-transcript rendering.
 *
 * Covers the registry-only tablet preset (round trips, mismatch rejection,
 * unchanged legacy sizes), the React/MCP SSR path (`renderStudioMarkup`, the
 * exact markup the real MCP PNG renderer loads), the deterministic HTML
 * renderer, and the render profile matrix (logical × DPR export pixels) with
 * one shared content payload and stable ids.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_PROFILES,
  deviceProfile,
  deviceProfileError,
  findDeviceProfile,
} from '../apps/web/src/studio/device-profiles.ts';
import {
  createScene,
  parseDraft,
  serializeDraft,
  serializeScene,
  validateScene,
} from '../apps/web/src/studio/model.ts';
import { renderSceneHtml } from '../packages/renderer/renderSceneHtml.mjs';
import { adaptSceneForRenderer } from '../services/mcp/scene.mjs';

/** The actual MCP render path loads this SSR bundle (built by `npm run build:mcp`). */
async function loadStudioMarkup() {
  try {
    const runtime = await import('../.local/mcp-renderer/studio.mjs');
    return runtime.renderStudioMarkup;
  } catch (error) {
    throw new Error('MCP renderer bundle missing — run `npm run build:mcp` first', { cause: error });
  }
}

const TRANSCRIPT = '周六可以！不过得早点出发，下午风大。\nSecond line — bring the camera 📷 <b>not markup</b>;\n第三行要能安全换行不溢出。';

function sharedContent({ deviceProfileId, surface, title = '周末去看海', participants } = {}) {
  const base = createScene('weekend');
  return {
    ...base,
    ...(title === base.title ? {} : { title }),
    surface,
    deviceProfileId,
    participants: participants ?? base.participants,
    messages: [
      { id: 'm-1', participantId: 'p-linxiaoman', type: 'text', text: '听这段语音', time: '09:38' },
      {
        id: 'm-2',
        participantId: 'p-ayuan',
        type: 'voice',
        text: '',
        time: '09:39',
        voiceTranscript: TRANSCRIPT,
      },
      { id: 'm-3', participantId: 'p-ayuan', type: 'voice', text: '12 秒', subtitle: '旧标签', time: '09:40' },
    ],
  };
}

function validated(scene) {
  const result = validateScene(scene);
  assert.equal(result.ok, true, result.errors.join('；'));
  return result.scene;
}

/* ------------------------------------------------------------------ */
/* registry                                                            */
/* ------------------------------------------------------------------ */

test('ipad-window is a registry-only tablet preset on the unchanged ios surface', () => {
  const profile = findDeviceProfile('ipad-window');
  assert.ok(profile, 'ipad-window exists in DEVICE_PROFILES');
  assert.equal(profile.label, 'iPad 横屏窗口');
  assert.equal(profile.surface, 'ios', 'persisted surface enum is unchanged');
  assert.equal(profile.width, 1024);
  assert.equal(profile.height, 768);
  assert.equal(profile.pixelRatio, 2);
  assert.equal(profile.width * profile.pixelRatio, 2048, 'export width = logical × DPR');
  assert.equal(profile.height * profile.pixelRatio, 1536, 'export height = logical × DPR');
  assert.equal(profile.formFactor, 'tablet', 'registry-only discriminator');
  assert.ok(DEVICE_PROFILES.some((entry) => entry.id === 'ipad-window'), 'directly discoverable in device dropdowns');
});

test('no new top-level tablet surface exists and formFactor never persists', () => {
  const scene = validated(sharedContent({ deviceProfileId: 'ipad-window', surface: 'ios' }));
  assert.equal(scene.surface, 'ios');
  assert.equal(scene.deviceProfileId, 'ipad-window');
  assert.ok(!serializeScene(scene).includes('formFactor'), 'registry discriminator is never serialized');
  const withSurface = validateScene({ ...createScene('weekend'), surface: 'tablet' });
  assert.equal(withSurface.ok, false, 'a tablet surface is not part of the scene contract');
  for (const profile of DEVICE_PROFILES) {
    assert.ok(['phone', 'tablet', 'desktop'].includes(profile.formFactor));
  }
});

test('ipad-window survives validateDraft/serializeDraft and mismatches are rejected', () => {
  const scene = validated(sharedContent({ deviceProfileId: 'ipad-window', surface: 'ios' }));
  const draft = parseDraft(serializeDraft(scene));
  assert.equal(draft.ok, true);
  assert.equal(draft.draft.scene.deviceProfileId, 'ipad-window');
  assert.equal(draft.draft.scene.surface, 'ios');
  assert.equal(deviceProfile(draft.draft.scene).id, 'ipad-window');
  assert.equal(deviceProfile({ surface: 'ios', deviceProfileId: 'ipad-window' }).formFactor, 'tablet');

  assert.match(deviceProfileError('ipad-window', 'android'), /不匹配/);
  assert.match(deviceProfileError('ipad-window', 'desktop'), /不匹配/);
  assert.equal(deviceProfileError('ipad-window', 'ios'), undefined);
  assert.equal(deviceProfileError('ipad-window', undefined), undefined);
  for (const surface of ['android', 'desktop']) {
    const result = validateScene({ ...createScene('weekend'), surface, deviceProfileId: 'ipad-window' });
    assert.equal(result.ok, false, `ipad-window on ${surface} must be rejected`);
    assert.ok(result.errors.some((error) => error.includes('不匹配')));
  }
});

test('existing profile sizes and legacy fallbacks are unchanged', () => {
  const expected = {
    'legacy360': ['ios', 360, 640, 2],
    'iphone-17-pro': ['ios', 402, 874, 3],
    'iphone-15-pro': ['ios', 393, 852, 3],
    'pixel-8': ['android', 360, 800, 3],
    'ipad-window': ['ios', 1024, 768, 2],
    'macos-window': ['desktop', 1000, 720, 2],
  };
  for (const [id, [surface, width, height, pixelRatio]] of Object.entries(expected)) {
    const profile = findDeviceProfile(id);
    assert.deepEqual([profile.surface, profile.width, profile.height, profile.pixelRatio], [surface, width, height, pixelRatio], id);
  }
  assert.deepEqual(
    [deviceProfile({ surface: 'android' }).width, deviceProfile({ surface: 'android' }).height, deviceProfile({ surface: 'android' }).pixelRatio],
    [360, 640, 2],
  );
  assert.deepEqual(
    [deviceProfile({ surface: 'desktop' }).width, deviceProfile({ surface: 'desktop' }).height, deviceProfile({ surface: 'desktop' }).pixelRatio],
    [900, 640, 2],
  );
  assert.deepEqual(
    [deviceProfile({}).width, deviceProfile({}).height, deviceProfile({}).pixelRatio],
    [360, 640, 2],
  );
});

test('render profile matrix: same content, stable ids, export pixels = logical × DPR', () => {
  const matrix = [
    { id: 'iphone-17-pro', surface: 'ios', width: 402, height: 874, pixelRatio: 3, exportWidth: 1206, exportHeight: 2622 },
    { id: 'ipad-window', surface: 'ios', width: 1024, height: 768, pixelRatio: 2, exportWidth: 2048, exportHeight: 1536 },
    { id: 'macos-window', surface: 'desktop', width: 1000, height: 720, pixelRatio: 2, exportWidth: 2000, exportHeight: 1440 },
  ];
  for (const entry of matrix) {
    const scene = validated(sharedContent({ deviceProfileId: entry.id, surface: entry.surface }));
    const profile = deviceProfile(scene);
    assert.equal(profile.id, entry.id);
    assert.equal(profile.width * profile.pixelRatio, entry.exportWidth);
    assert.equal(profile.height * profile.pixelRatio, entry.exportHeight);
    assert.deepEqual(scene.messages.map((message) => message.id), ['m-1', 'm-2', 'm-3'], 'message ids stay stable across devices');
    assert.deepEqual(scene.participants.map((person) => person.id), ['p-linxiaoman', 'p-ayuan'], 'participant ids stay stable');
  }
});

/* ------------------------------------------------------------------ */
/* React / MCP SSR rendering                                           */
/* ------------------------------------------------------------------ */

test('MCP SceneView SSR renders the transcript below the voice bubble, safely escaped', async () => {
  const renderStudioMarkup = await loadStudioMarkup();
  const markup = renderStudioMarkup(validated(sharedContent({ deviceProfileId: 'iphone-17-pro', surface: 'ios' })));

  assert.match(markup, /data-device="iphone-17-pro"/);
  assert.ok(markup.includes('scene-voice-transcript'), 'transcript node exists');
  assert.ok(markup.includes('周六可以！不过得早点出发，下午风大。'), 'exact wording renders');
  assert.ok(markup.includes('第三行要能安全换行不溢出。'), 'multiline wording renders');
  assert.ok(markup.includes('&lt;b&gt;not markup&lt;/b&gt;'), 'transcript text is escaped');
  assert.ok(!markup.includes('<b>not markup</b>'), 'no raw markup injection');

  // Ordering: the transcript renders below its voice bubble inside message m-2.
  const m2 = markup.slice(markup.indexOf('data-message-id="m-2"'), markup.indexOf('data-message-id="m-3"'));
  assert.ok(m2.includes('scene-voice-transcript'), 'transcript sits inside the voice message');
  assert.ok(m2.indexOf('scene-voice-transcript') > m2.indexOf('scene-bubble'), 'transcript sits below the voice bubble');

  // Legacy voice without a transcript keeps the honest placeholder, no transcript node.
  const voiceRows = markup.split('data-message-id="m-3"');
  assert.equal(voiceRows.length, 2);
  assert.ok(!voiceRows[1].includes('scene-voice-transcript'), 'no transcript invented for old voice messages');
  assert.ok(voiceRows[1].includes('12 秒'), 'legacy label still renders inline');
});

test('MCP SceneView SSR renders phone/desktop compact and tablet two-pane from real scene data only', async () => {
  const renderStudioMarkup = await loadStudioMarkup();

  const phone = renderStudioMarkup(validated(sharedContent({ deviceProfileId: 'iphone-17-pro', surface: 'ios' })));
  assert.ok(!phone.includes('scene-split'), 'phone keeps the compact layout');
  assert.ok(!phone.includes('scene-chat-list'), 'phone has no chat list pane');

  const desktop = renderStudioMarkup(validated(sharedContent({ deviceProfileId: 'macos-window', surface: 'desktop' })));
  assert.ok(!desktop.includes('scene-split'), 'desktop keeps its existing window semantics');
  assert.ok(desktop.includes('data-device="macos-window"'));

  const tablet = renderStudioMarkup(validated(sharedContent({ deviceProfileId: 'ipad-window', surface: 'ios' })));
  assert.ok(tablet.includes('scene-split'), 'tablet renders the two-pane layout');
  assert.ok(tablet.includes('data-device="ipad-window"'));
  assert.equal((tablet.match(/class="scene-chat-list-item/g) ?? []).length, 1, 'derived list contains ONLY this thread');
  assert.ok(tablet.includes('scene-chat-list-name">阿远<'), 'direct-chat title comes from the actual scene participants');
  assert.ok(tablet.includes('scene-chat-list-preview">12 秒<'), 'preview is the real latest message');
  assert.ok(tablet.includes('scene-chat-list-time">09:40<'), 'time is the real latest message time');
  assert.ok(!tablet.includes('unread'), 'no fabricated unread counts');
});

test('tablet group titles and member counts come from the actual scene', async () => {
  const renderStudioMarkup = await loadStudioMarkup();
  const group = validated(sharedContent({
    deviceProfileId: 'ipad-window',
    surface: 'ios',
    title: '新品发布讨论组',
    participants: [
      { id: 'p-linxiaoman', name: '林小满' },
      { id: 'p-ayuan', name: '阿远' },
      { id: 'p-suwan', name: '苏晚' },
    ],
  }));
  const markup = renderStudioMarkup(group);
  assert.ok(markup.includes('scene-chat-list-name">新品发布讨论组<'), 'group list title is scene.title');
  assert.ok(markup.includes('scene-chat-list-count">3 人<'), 'group count is the real participant count');
  const aside = markup.slice(markup.indexOf('<aside'), markup.indexOf('</aside>'));
  assert.ok(!aside.includes('苏晚'), 'no fabricated personal rows beyond the single thread');
});

/* ------------------------------------------------------------------ */
/* deterministic HTML renderer                                         */
/* ------------------------------------------------------------------ */

test('deterministic HTML renderer shares voiceTranscript semantics', () => {
  const withTranscript = renderSceneHtml(validated(sharedContent({ deviceProfileId: 'iphone-17-pro', surface: 'ios' })), { surface: 'ios', width: 390, outputKind: 'long-screenshot' });
  assert.ok(withTranscript.includes('data-voice-transcript="true"'));
  assert.ok(withTranscript.includes('周六可以！不过得早点出发，下午风大。'));
  assert.ok(withTranscript.includes('&lt;b&gt;not markup&lt;/b&gt;') && !withTranscript.includes('<b>not markup</b>'), 'escaped');
  assert.ok(withTranscript.includes('white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word'), 'transcript wraps safely');

  const legacyOnly = renderSceneHtml(validated({
    ...createScene('weekend'),
    messages: [{ id: 'm-1', participantId: 'p-ayuan', type: 'voice', text: '12 秒', subtitle: '旧标签', time: '09:40' }],
  }), { surface: 'ios', width: 390 });
  assert.ok(legacyOnly.includes('12 秒'), 'legacy label renders');
  assert.ok(legacyOnly.includes('旧标签'), 'legacy duration/label renders');
  assert.ok(!legacyOnly.includes('data-voice-transcript'), 'no transcript invented for old voice messages');
});

test('deterministic HTML renderer draws the tablet two-pane only for ipad-window', () => {
  const tablet = renderSceneHtml(validated(sharedContent({ deviceProfileId: 'ipad-window', surface: 'ios' })), { surface: 'ios', width: 1024 });
  assert.ok(tablet.includes('class="split"'));
  assert.ok(tablet.includes('class="chat-list"'));
  assert.equal((tablet.match(/class="chat-list-item/g) ?? []).length, 1);
  assert.ok(tablet.includes('chat-list-name">阿远<'));
  const aside = tablet.slice(tablet.indexOf('<aside'), tablet.indexOf('</aside>'));
  assert.ok(!aside.includes('unread'), 'no fabricated unread counts');

  const phone = renderSceneHtml(validated(sharedContent({ deviceProfileId: 'iphone-17-pro', surface: 'ios' })), { surface: 'ios', width: 390 });
  assert.ok(!phone.includes('class="split"'));
  const desktop = renderSceneHtml(validated(sharedContent({ deviceProfileId: 'macos-window', surface: 'desktop' })), { surface: 'desktop', width: 1000 });
  assert.ok(!desktop.includes('class="split"'), 'desktop keeps existing window semantics');
});

test('adaptSceneForRenderer keeps the explicit transcript in the shared message contract', () => {
  const scene = validated(sharedContent({ deviceProfileId: 'ipad-window', surface: 'ios' }));
  const { scene: adapted } = adaptSceneForRenderer(scene);
  const voice = adapted.messages.find((message) => message.id === 'm-2');
  assert.equal(voice.voiceTranscript, TRANSCRIPT);
  const legacy = adapted.messages.find((message) => message.id === 'm-3');
  assert.equal('voiceTranscript' in legacy, false);
});

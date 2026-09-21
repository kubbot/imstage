import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEVICE_PROFILES,
  DEVICE_PROFILE_IDS,
  deviceProfile,
  deviceProfileError,
  findDeviceProfile,
  normaliseSurface,
} from '../apps/web/src/studio/device-profiles.ts';
import {
  DRAFT_VERSION,
  createScene,
  parseDraft,
  serializeDraft,
  updateScene,
  validateScene,
} from '../apps/web/src/studio/model.ts';

const fixture = JSON.parse(
  readFileSync(new URL('../tools/eval/fixtures/device-fidelity.json', import.meta.url), 'utf8'),
);

function shape(profile) {
  return {
    id: profile.id,
    surface: profile.surface,
    width: profile.width,
    height: profile.height,
    pixelRatio: profile.pixelRatio,
  };
}

/* ------------------------------------------------------------------ */
/* registry                                                            */
/* ------------------------------------------------------------------ */

test('DEVICE_PROFILES matches the coded device spec', () => {
  assert.deepEqual(DEVICE_PROFILE_IDS, ['legacy360', 'iphone-15-pro', 'pixel-8', 'macos-window']);
  assert.equal(new Set(DEVICE_PROFILE_IDS).size, DEVICE_PROFILES.length);

  const byId = new Map(DEVICE_PROFILES.map((profile) => [profile.id, profile]));
  assert.deepEqual(shape(byId.get('legacy360')), {
    id: 'legacy360',
    surface: 'ios',
    width: 360,
    height: 640,
    pixelRatio: 2,
  });
  assert.deepEqual(shape(byId.get('iphone-15-pro')), {
    id: 'iphone-15-pro',
    surface: 'ios',
    width: 393,
    height: 852,
    pixelRatio: 3,
  });
  assert.deepEqual(shape(byId.get('pixel-8')), {
    id: 'pixel-8',
    surface: 'android',
    width: 360,
    height: 800,
    pixelRatio: 3,
  });
  assert.deepEqual(shape(byId.get('macos-window')), {
    id: 'macos-window',
    surface: 'desktop',
    width: 1000,
    height: 720,
    pixelRatio: 2,
  });

  // Native panel pixel math for the two phones (hardware specs, not app-version claims).
  const iphone = byId.get('iphone-15-pro');
  assert.equal(iphone.width * iphone.pixelRatio, 1179);
  assert.equal(iphone.height * iphone.pixelRatio, 2556);
  const pixel = byId.get('pixel-8');
  assert.equal(pixel.width * pixel.pixelRatio, 1080);
  assert.equal(pixel.height * pixel.pixelRatio, 2400);

  for (const profile of DEVICE_PROFILES) {
    assert.equal(typeof profile.label, 'string');
    assert.ok(profile.label.length > 0);
    assert.ok(Number.isInteger(profile.width) && profile.width > 0);
    assert.ok(Number.isInteger(profile.height) && profile.height > 0);
    assert.ok(Number.isInteger(profile.pixelRatio) && profile.pixelRatio > 0);
  }
});

test('findDeviceProfile and normaliseSurface are total and defensive', () => {
  assert.equal(findDeviceProfile('macos-window').surface, 'desktop');
  assert.equal(findDeviceProfile('missing'), undefined);
  assert.equal(findDeviceProfile(undefined), undefined);
  assert.equal(normaliseSurface('android'), 'android');
  assert.equal(normaliseSurface('desktop'), 'desktop');
  assert.equal(normaliseSurface('ios'), 'ios');
  assert.equal(normaliseSurface('web'), 'ios');
  assert.equal(normaliseSurface(undefined), 'ios');
});

/* ------------------------------------------------------------------ */
/* resolution and legacy fallback                                      */
/* ------------------------------------------------------------------ */

test('deviceProfile chooses an explicit matching id, else the legacy surface preset', () => {
  assert.deepEqual(shape(deviceProfile({})), {
    id: 'legacy360',
    surface: 'ios',
    width: 360,
    height: 640,
    pixelRatio: 2,
  });
  assert.equal(deviceProfile({ surface: 'ios' }).id, 'legacy360');
  assert.deepEqual(shape(deviceProfile({ surface: 'android' })), {
    id: 'legacy-android',
    surface: 'android',
    width: 360,
    height: 640,
    pixelRatio: 2,
  });
  assert.deepEqual(shape(deviceProfile({ surface: 'desktop' })), {
    id: 'legacy-desktop',
    surface: 'desktop',
    width: 900,
    height: 640,
    pixelRatio: 2,
  });

  assert.equal(deviceProfile({ surface: 'ios', deviceProfileId: 'iphone-15-pro' }).id, 'iphone-15-pro');
  assert.equal(deviceProfile({ surface: 'android', deviceProfileId: 'pixel-8' }).id, 'pixel-8');
  assert.equal(deviceProfile({ surface: 'desktop', deviceProfileId: 'macos-window' }).id, 'macos-window');

  // Defensive at render time: unknown or mismatched ids fall back, they never throw.
  assert.equal(deviceProfile({ surface: 'ios', deviceProfileId: 'iphone-99' }).id, 'legacy360');
  assert.equal(deviceProfile({ surface: 'ios', deviceProfileId: 'pixel-8' }).id, 'legacy360');
  assert.equal(deviceProfile({ surface: 'android', deviceProfileId: 'iphone-15-pro' }).id, 'legacy-android');
});

test('deviceProfileError reports unknown ids and surface mismatches only', () => {
  assert.equal(deviceProfileError('iphone-15-pro', 'ios'), undefined);
  assert.equal(deviceProfileError('iphone-15-pro', undefined), undefined);
  assert.equal(deviceProfileError('macos-window', 'desktop'), undefined);
  assert.match(deviceProfileError('nope', 'ios'), /未知设备配置/);
  assert.match(deviceProfileError('pixel-8', 'ios'), /不匹配/);
  assert.match(deviceProfileError('legacy360', 'desktop'), /不匹配/);
});

/* ------------------------------------------------------------------ */
/* model validation and persistence                                    */
/* ------------------------------------------------------------------ */

test('validateScene persists a surface-matching deviceProfileId', () => {
  const result = validateScene({ ...createScene('weekend'), surface: 'ios', deviceProfileId: 'iphone-15-pro' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.scene.surface, 'ios');
  assert.equal(result.scene.deviceProfileId, 'iphone-15-pro');
  assert.equal(deviceProfile(result.scene).id, 'iphone-15-pro');
});

test('validateScene rejects unknown device profile ids instead of silently dropping them', () => {
  const result = validateScene({ ...createScene('weekend'), surface: 'ios', deviceProfileId: 'iphone-99' });
  assert.equal(result.ok, false);
  assert.equal(result.scene, undefined);
  assert.ok(result.errors.some((error) => error.includes('未知设备配置')));
});

test('validateScene rejects device profile / surface mismatches', () => {
  const cases = [
    ['ios', 'pixel-8'],
    ['android', 'iphone-15-pro'],
    ['desktop', 'legacy360'],
    ['ios', 'macos-window'],
  ];
  for (const [surface, deviceProfileId] of cases) {
    const result = validateScene({ ...createScene('weekend'), surface, deviceProfileId });
    assert.equal(result.ok, false, `${deviceProfileId} on ${surface} must be rejected`);
    assert.ok(result.errors.some((error) => error.includes('不匹配')));
  }
});

test('a mismatched explicit id is rejected even when surface is omitted', () => {
  const result = validateScene({ ...createScene('weekend'), deviceProfileId: 'pixel-8' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('不匹配')));
});

test('legacy scenes without an explicit id stay valid and never gain a deviceProfileId', () => {
  for (const surface of ['ios', 'android', 'desktop']) {
    const result = validateScene({ ...createScene('weekend'), surface });
    assert.equal(result.ok, true);
    assert.equal(result.scene.surface, surface);
    assert.equal(result.scene.deviceProfileId, undefined);
    assert.equal(deviceProfile(result.scene).surface, surface);
    assert.notEqual(deviceProfile(result.scene).id, '');
  }
});

test('device profile id survives an immutable update and a draft round trip', () => {
  const scene = updateScene(createScene('weekend'), { surface: 'desktop', deviceProfileId: 'macos-window' });
  assert.equal(scene.deviceProfileId, 'macos-window');

  const restored = parseDraft(serializeDraft(scene));
  assert.equal(restored.ok, true);
  assert.equal(restored.draft.scene.surface, 'desktop');
  assert.equal(restored.draft.scene.deviceProfileId, 'macos-window');
  assert.equal(deviceProfile(restored.draft.scene).id, 'macos-window');
});

test('parseDraft rejects a persisted device profile mismatch', () => {
  const scene = { ...createScene('weekend'), surface: 'android', deviceProfileId: 'iphone-15-pro' };
  const result = parseDraft({ version: DRAFT_VERSION, scene, savedAt: '' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes('不匹配')));
});

/* ------------------------------------------------------------------ */
/* evaluation fixture consistency                                      */
/* ------------------------------------------------------------------ */

test('device fidelity fixture references real profiles with consistent export pixels', () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.kind, 'imstage-device-fidelity-fixtures');
  assert.match(fixture.notice, /NOT approved product goldens/);
  assert.equal(fixture.devices.length, 3);

  const surfaces = new Set();
  for (const device of fixture.devices) {
    const profile = findDeviceProfile(device.deviceProfileId);
    assert.ok(profile, `fixture device ${device.deviceProfileId} exists in the registry`);
    assert.equal(profile.surface, device.expectedSurface);
    assert.equal(profile.width, device.expectedWidth);
    assert.equal(profile.height, device.expectedHeight);
    assert.equal(profile.pixelRatio, device.expectedPixelRatio);
    assert.equal(device.expectedExport.width, device.expectedWidth * device.expectedPixelRatio);
    assert.equal(device.expectedExport.height, device.expectedHeight * device.expectedPixelRatio);
    surfaces.add(device.expectedSurface);
  }
  assert.deepEqual([...surfaces].sort(), ['android', 'desktop', 'ios']);
});

test('each fixture device can validate and render the shared semantic content', () => {
  const content = fixture.semanticContent;
  assert.equal(fixture.platform, 'wechat');
  assert.ok(content.participants.length >= 2);
  assert.ok(content.messages.length >= 3);

  const participantIds = new Set(content.participants.map((participant) => participant.id));
  for (const message of content.messages) {
    assert.equal(typeof message.id, 'string');
    assert.equal(typeof message.text, 'string');
    assert.equal(typeof message.time, 'string');
    assert.ok(participantIds.has(message.participantId), `sender ${message.participantId} exists`);
  }

  for (const device of fixture.devices) {
    const scene = {
      ...createScene('weekend'),
      platform: fixture.platform,
      surface: device.expectedSurface,
      deviceProfileId: device.deviceProfileId,
      participants: content.participants,
      selfId: content.selfId,
      messages: content.messages,
      deviceTime: content.deviceTime,
      date: content.date,
    };
    const result = validateScene(scene);
    assert.equal(result.ok, true, `scene validates for ${device.deviceProfileId}: ${result.errors.join('; ')}`);
    assert.equal(result.scene.deviceProfileId, device.deviceProfileId);
    assert.equal(result.scene.surface, device.expectedSurface);
    assert.equal(deviceProfile(result.scene).id, device.deviceProfileId);
  }
});

test('fixture declares required avatar, realism and semantic checks', () => {
  const manual = fixture.checks?.manual ?? [];
  assert.ok(manual.length >= 3);
  assert.ok(manual.every((check) => check.required === true));
  assert.ok(manual.some((check) => check.kind === 'avatar'));
  assert.ok(manual.some((check) => check.kind === 'realism'));
  assert.ok(fixture.checks.required.some((line) => /semanticContent/.test(line)));
  assert.ok(fixture.checks.required.some((line) => /no device bezel/i.test(line)));
});

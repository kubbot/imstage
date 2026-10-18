/**
 * Real deterministic renderer — long-screenshot capture regression (v8 fix).
 *
 * The parent preflight found intermittent stale compositor pixels when a
 * long-shot viewport was RESIZED before capture (first PNG duplicated the
 * status bar/header at the bottom despite a single DOM node). The fix captures
 * the validated `.device` rectangle via `fullPage` + `clip` WITHOUT resizing
 * the viewport (services/mcp/render.mjs, renderer version v8).
 *
 * These tests run the ACTUAL renderer (Playwright + system Chromium) and check:
 *   - short bounded screenshots still match the viewport exactly;
 *   - >1200px long screenshots keep their FULL content height (no cutoff at
 *     the viewport), twice, with consistent geometry;
 *   - the bottom rows are not a stale copy of the top rows (composer bottom);
 *   - very long scenes hit the pixel cap honestly (pre-capture bounds);
 *   - watermark on/off really renders differently;
 *   - too-tall bounded requests fail instead of silently cropping.
 *
 * page.route network deny / no-JS / deadline controls are unchanged by the fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import sharp from 'sharp';

import { createScene } from '../apps/web/src/studio/model.ts';
import { resolveRenderConfig, renderScenePng, parsePngHeader } from '../services/mcp/render.mjs';

function sceneWithMessages(messageCount, { watermarkEnabled, title = '长截图回归' } = {}) {
  const base = createScene('weekend');
  const { id: _ignored, ...rest } = base;
  const participants = rest.participants.slice(0, 2);
  const messages = [];
  for (let index = 0; index < messageCount; index += 1) {
    messages.push({
      id: `m-${index}`,
      participantId: participants[index % 2].id,
      type: 'text',
      text: `第 ${index + 1} 条回归消息：验证长截图不会在视口高度处截断，也不会把状态栏重复到底部。`,
      time: `10:${String(index % 60).padStart(2, '0')}`,
    });
  }
  return {
    ...rest,
    title,
    platform: 'whatsapp',
    selfId: participants[0].id,
    participants,
    messages,
    ...(watermarkEnabled === undefined ? {} : { watermarkEnabled }),
  };
}

async function rowDigest(png, top) {
  const { info, data } = await sharp(png)
    .extract({ left: 0, top, width: pngWidth(png), height: 60 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return crypto.createHash('sha256').update(data).digest('hex') + `:${info.height}`;
}

function pngWidth(png) {
  return png.readUInt32BE(16);
}

function pngHeight(png) {
  return png.readUInt32BE(20);
}

test('short bounded screenshot matches the viewport exactly', async () => {
  const scene = sceneWithMessages(2, { watermarkEnabled: false });
  const rendered = await renderScenePng({ scene, surface: 'ios', width: 390, height: 640, outputKind: 'screenshot' });
  const header = parsePngHeader(rendered.buffer);
  assert.equal(header.width, 390);
  assert.equal(header.height, 640, 'bounded screenshot is exactly the viewport');
  assert.equal(rendered.sha256, crypto.createHash('sha256').update(rendered.buffer).digest('hex'));
});

test('long screenshot keeps full content height > 1200 with no stale bottom pixels', async () => {
  const scene = sceneWithMessages(24, { watermarkEnabled: true });
  const first = await renderScenePng({ scene, surface: 'ios', width: 390, height: 844, outputKind: 'long-screenshot' });
  assert.ok(first.height > 1200, `long screenshot must exceed the 1200px viewport, got ${first.height}`);
  assert.ok(first.height < 20_000, 'bounded height');

  // Two captures keep the same full geometry, and EACH independently passes
  // the stale-compositor checks (the preflight glitch duplicated the header at
  // the bottom of a capture, which the bottom-vs-top comparison detects).
  const second = await renderScenePng({ scene, surface: 'ios', width: 390, height: 844, outputKind: 'long-screenshot' });
  assert.equal(second.width, first.width);
  assert.equal(second.height, first.height, 'two captures of one scene have identical geometry');
  for (const [index, capture] of [first, second].entries()) {
    const top = await rowDigest(capture.buffer, 0);
    const bottom = await rowDigest(capture.buffer, capture.height - 60);
    assert.notEqual(top, bottom, `capture ${index}: composer bottom must not be a stale copy of the header`);
    assert.ok(capture.height > 1200, `capture ${index}: full content height (no viewport cutoff)`);
  }
  // Every message really lands in the capture (no cutoff after the viewport):
  // 24 messages need far more than 1200px, and the clip check inside the
  // renderer already proved height ∈ [content-1, content].
  assert.ok(first.height > 24 * 60, `24 messages need real height, got ${first.height}`);
  assert.ok(first.height < 3000, `24 messages stay bounded, got ${first.height}`);
});

test('very long scenes hit the pixel cap honestly (before capture)', async () => {
  // Configuration-level cap: no browser involved.
  assert.throws(
    () => resolveRenderConfig({ surface: 'ios', width: 1200, height: 20_000, outputKind: 'screenshot' }),
    (error) => error.code === 'output_too_large',
  );
  // Content-level long-shot cap: the validated content rectangle exceeds
  // RENDER_LIMITS.maxPixels and is rejected before any capture.
  const scene = sceneWithMessages(120);
  await assert.rejects(
    () => renderScenePng({ scene, surface: 'ios', width: 390, height: 844, outputKind: 'long-screenshot' }),
    (error) => error.code === 'output_too_large',
    'a >10k px long shot must exceed the 4M pixel cap',
  );
});

test('watermark on/off renders differently with the real renderer', async () => {
  const on = await renderScenePng({ scene: sceneWithMessages(3, { watermarkEnabled: true }), surface: 'ios', width: 390, height: 640, outputKind: 'screenshot' });
  const off = await renderScenePng({ scene: sceneWithMessages(3, { watermarkEnabled: false }), surface: 'ios', width: 390, height: 640, outputKind: 'screenshot' });
  assert.notEqual(on.sha256, off.sha256, 'watermark must really change the pixels');
});

test('too-tall bounded requests fail instead of silently cropping', async () => {
  const scene = sceneWithMessages(24);
  await assert.rejects(
    () => renderScenePng({ scene, surface: 'ios', width: 390, height: 640, outputKind: 'screenshot' }),
    (error) => error.code === 'output_too_tall',
  );
});

/* ------------------------------------------------------------------ */
/* GET-35: actual render profile matrix + voice transcript             */
/*                                                                     */
/* phone 402x874@3, tablet 1024x768@2 (ipad-window), desktop           */
/* 1000x720@2 (macos-window) render the same content with stable ids.  */
/* Standard captures match the logical viewport; long captures grow     */
/* with the transcript instead of clipping it.                          */
/* ------------------------------------------------------------------ */

function get35Scene({ deviceProfileId, surface, transcriptLines }) {
  const { id: _ignored, ...rest } = createScene('weekend');
  const participants = rest.participants.slice(0, 2);
  const transcript = Array.from({ length: transcriptLines }, (_, index) => `文字稿第 ${index + 1} 行：周六码头见，English line ${index + 1} wraps safely.`).join('\n');
  return {
    ...rest,
    title: 'GET-35 矩阵',
    platform: 'wechat',
    surface,
    deviceProfileId,
    selfId: participants[0].id,
    participants,
    watermarkEnabled: false,
    messages: [
      { id: 'm-1', participantId: participants[1].id, type: 'text', text: '听这段语音。', time: '09:38' },
      { id: 'm-2', participantId: participants[1].id, type: 'voice', text: '', time: '09:39', ...(transcriptLines > 0 ? { voiceTranscript: transcript } : {}) },
      { id: 'm-3', participantId: participants[0].id, type: 'text', text: '收到，周六见。', time: '09:40' },
    ],
  };
}

test('GET-35 profile matrix renders the same content and never clips the voice transcript', async () => {
  const matrix = [
    { id: 'iphone-17-pro', surface: 'ios', width: 402, height: 874 },
    { id: 'ipad-window', surface: 'ios', width: 1024, height: 768 },
    { id: 'macos-window', surface: 'desktop', width: 1000, height: 720 },
  ];
  for (const profile of matrix) {
    // Same content, stable ids on every profile.
    const short = get35Scene({ deviceProfileId: profile.id, surface: profile.surface, transcriptLines: 2 });
    const tall = get35Scene({ deviceProfileId: profile.id, surface: profile.surface, transcriptLines: 14 });
    for (const scene of [short, tall]) {
      assert.deepEqual(scene.messages.map((message) => message.id), ['m-1', 'm-2', 'm-3']);
      assert.deepEqual(scene.participants.map((person) => person.id), ['p-linxiaoman', 'p-ayuan']);
    }

    // Standard: exact logical viewport (clipping rules unchanged).
    const standard = await renderScenePng({ scene: short, surface: profile.surface, width: profile.width, height: profile.height, outputKind: 'screenshot' });
    assert.equal(standard.width, profile.width, `${profile.id} standard width`);
    assert.equal(standard.height, profile.height, `${profile.id} standard height`);

    // Long: the full transcript content grows the capture instead of being cut.
    const long = await renderScenePng({ scene: tall, surface: profile.surface, width: profile.width, height: profile.height, outputKind: 'long-screenshot' });
    assert.equal(long.width, profile.width, `${profile.id} long width`);
    assert.ok(long.height > profile.height, `${profile.id} long capture exceeds the viewport (${long.height} > ${profile.height})`);

    if (profile.id === 'ipad-window') {
      // Pixel-level proof the transcript is really rendered and not clipped:
      // the same scene without it captures strictly shorter.
      const without = get35Scene({ deviceProfileId: profile.id, surface: profile.surface, transcriptLines: 0 });
      const bare = await renderScenePng({ scene: without, surface: profile.surface, width: profile.width, height: profile.height, outputKind: 'long-screenshot' });
      assert.ok(long.height > bare.height, `transcript adds ${long.height - bare.height}px of real content in long mode`);
    }
  }
});

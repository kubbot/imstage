/**
 * Policy regression: default-on watermark disclosure + payment/screenshot bans
 * across the shared model, the deterministic renderer and the browser
 * renderer. The 2026-10-02 user decision makes the watermark a project/scene
 * preference (default on, Agent model can never change it); obsolete toggle
 * aliases stay stripped and the payment/reference/security cases are kept.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { addMessage, createScene, parseSceneJson, validateScene } from '../apps/web/src/studio/model.ts';
import { renderStudioHtml } from '../services/mcp/studio-html.mjs';
import { renderSceneHtml } from '../packages/renderer/renderSceneHtml.mjs';
import { canonicalSceneJson, DISCLOSURE_TEXT, PAYMENT_NEUTRALIZED_TEXT, sceneWatermarkEnabled } from '../packages/schema/policy.mjs';

function validScene() {
  return {
    id: 'scene-policy', title: '合成场景', platform: 'imstage', deviceTime: '09:41', date: '', selfId: 'p1',
    participants: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }],
    messages: [{ id: 'm1', participantId: 'p2', type: 'text', text: '你好', time: '09:41' }],
    watermark: '',
  };
}

test('the deterministic renderer draws the disclosure by default, whatever obsolete aliases say', () => {
  for (const watermark of ['', '我的水印', DISCLOSURE_TEXT]) {
    const html = renderSceneHtml({ ...validScene(), watermark, showFictionalMark: false, hideDisclosure: true }, { surface: 'ios' });
    assert.ok(html.includes('AI生成 / 虚构'), 'disclosure present');
    assert.ok(html.includes('AI-generated / Fictional'), 'bilingual disclosure present');
    assert.ok(html.includes('data-imstage-disclosure="true"'));
    assert.ok(html.includes('我的水印') === (watermark === '我的水印'), 'custom watermark is independent of the mark');
  }
  // Desktop/long outputs carry it too (crop / MCP render paths share this HTML).
  const desktop = renderSceneHtml(validScene(), { surface: 'desktop', outputKind: 'long-screenshot', width: 800 });
  assert.ok(desktop.includes('data-imstage-disclosure="true"'));
});

test('a user-chosen watermark-free scene suppresses the disclosure and custom watermark everywhere', () => {
  const off = renderSceneHtml({ ...validScene(), watermark: '我的水印', watermarkEnabled: false }, { surface: 'ios' });
  assert.equal(off.includes('data-imstage-disclosure'), false, 'no disclosure band');
  assert.equal(off.includes('AI生成 / 虚构'), false, 'no mark text');
  assert.equal(off.includes('我的水印'), false, 'custom watermark is suppressed too');
  const on = renderSceneHtml({ ...validScene(), watermark: '我的水印', watermarkEnabled: true }, { surface: 'ios' });
  assert.ok(on.includes('data-imstage-disclosure="true"'));
  assert.ok(on.includes('我的水印'));
  // Absent means on: legacy/new scenes without the field keep the watermark.
  assert.equal(sceneWatermarkEnabled(validScene()), true);
  assert.equal(sceneWatermarkEnabled({ watermarkEnabled: false }), false);
});

test('each platform template renders its own chrome; payment cards never render', () => {
  const seen = new Map();
  for (const platform of ['imstage', 'wechat', 'whatsapp', 'telegram', 'imessage', 'slack', 'instagram', 'xiaohongshu']) {
    const html = renderSceneHtml({ ...validScene(), platform }, {});
    assert.ok(html.includes(`platform-${platform}`), `body class selects the ${platform} template`);
    assert.equal(html.includes('data-imstage-disclosure="true"'), true);
    // Platform differences must exist in the deterministic renderer: the
    // rendered HTML (theme colors/chrome) is genuinely different per template.
    const signature = html.split('<body')[1] ?? html;
    for (const [other, otherSignature] of seen) {
      assert.notEqual(signature, otherSignature, `${platform} must render differently from ${other}`);
    }
    seen.set(platform, signature);
  }
  // The generic IMStage template stays its own option, not a hidden fallback.
  assert.ok(renderSceneHtml({ ...validScene(), platform: 'imstage' }, {}).includes('platform-imstage'));
  const payment = renderSceneHtml({ ...validScene(), messages: [{ id: 'm1', participantId: 'p2', type: 'transfer', text: '¥10,000', time: '09:41' }] }, {});
  assert.equal(payment.includes('¥10,000'), false, 'payment payload never renders');
  assert.ok(payment.includes(PAYMENT_NEUTRALIZED_TEXT));
});

test('the browser SceneView (preview + html-to-image export DOM) carries the disclosure by default', async () => {
  const scene = validateScene({ ...validScene(), showFictionalMark: false }).scene;
  const html = await renderStudioHtml(scene, { width: 390, height: 844, outputKind: 'screenshot' });
  assert.ok(html.includes('AI生成 / 虚构'));
  assert.ok(html.includes('data-imstage-disclosure'));
  assert.ok(html.includes('data-platform="imstage"'));
  assert.equal(/scene-transfer/.test(html), false);
  // A user-chosen watermark-free scene hides the band in the same shared DOM.
  const offScene = validateScene({ ...validScene(), watermarkEnabled: false }).scene;
  const off = await renderStudioHtml(offScene, { width: 390, height: 844, outputKind: 'screenshot' });
  assert.equal(off.includes('data-imstage-disclosure'), false);
  assert.equal(off.includes('AI生成 / 虚构'), false);
});

test('imports cannot smuggle payment messages or obsolete toggle aliases through', () => {
  // Obsolete disclosure aliases are stripped, the import succeeds, the mark
  // stays on. The supported `watermarkEnabled` boolean is validated instead.
  const stripped = validateScene({ ...validScene(), showFictionalMark: false, hideDisclosure: true, disclosure: false, markEnabled: false });
  assert.equal(stripped.ok, true);
  for (const key of ['showFictionalMark', 'hideDisclosure', 'disclosure', 'markEnabled']) {
    assert.equal(Object.prototype.hasOwnProperty.call(stripped.scene, key), false);
  }
  // Payment messages are neutralised on import: id, order and time survive.
  const legacy = validateScene({
    ...validScene(),
    messages: [
      { id: 'm1', participantId: 'p2', type: 'transfer', text: '¥10,000', time: '08:00' },
      { id: 'm2', participantId: 'p1', type: 'text', text: '收到', time: '08:01' },
    ],
  });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.scene.messages.map((m) => m.id), ['m1', 'm2']);
  assert.equal(legacy.scene.messages[0].type, 'system');
  assert.equal(legacy.scene.messages[0].text, PAYMENT_NEUTRALIZED_TEXT);
  assert.equal(legacy.scene.messages[0].time, '08:00');
  assert.equal(legacy.scene.messages[1].type, 'text');
  // JSON imports go through the same gate.
  const parsed = parseSceneJson(JSON.stringify({ ...validScene(), reference: { source: 'data:image/png;base64,AAAA' } }));
  assert.equal(parsed.ok, false);
  assert.match(JSON.stringify(parsed.errors), /已停用|disabled/);
});

test('creation APIs reject payment message types outright', () => {
  const scene = createScene();
  for (const type of ['transfer', 'redpacket', 'balance', 'wallet']) {
    assert.throws(() => addMessage(scene, { type, text: '¥1' }), /不支持/, `${type} must be rejected`);
  }
});

test('scene hashes for the audit are canonical, content-private and watermark-sensitive', () => {
  const a = canonicalSceneJson({ title: 't', messages: [{ text: 'x' }], extra: 1 });
  const b = canonicalSceneJson({ extra: 1, messages: [{ text: 'x' }], title: 't' });
  assert.equal(a, b, 'key order must not change the hash input');
  assert.deepEqual(JSON.parse(a), { extra: 1, messages: [{ text: 'x' }], title: 't' });
  // The audit scene hash distinguishes watermark on/off scenes.
  assert.notEqual(
    canonicalSceneJson({ ...validScene(), watermarkEnabled: true }),
    canonicalSceneJson({ ...validScene(), watermarkEnabled: false }),
  );
});

test('legacy payment notices preserve calendar dates and explain retirement bilingually', () => {
  const scene = validScene();
  scene.messages[0] = { ...scene.messages[0], type: 'transfer', date: '2026-09-29' };
  const result = validateScene(scene);
  assert.equal(result.ok, true);
  assert.equal(result.scene.messages[0].date, '2026-09-29');
  assert.match(result.scene.messages[0].text, /This message type is disabled/);
  scene.messages[0].date = '2026-02-30';
  assert.equal(validateScene(scene).ok, false);
});

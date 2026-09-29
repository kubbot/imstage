/**
 * Policy regression: mandatory disclosure + payment/screenshot bans across
 * the shared model, the deterministic renderer and the browser renderer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { addMessage, createScene, parseSceneJson, validateScene } from '../apps/web/src/studio/model.ts';
import { renderStudioHtml } from '../services/mcp/studio-html.mjs';
import { renderSceneHtml } from '../packages/renderer/renderSceneHtml.mjs';
import { canonicalSceneJson, DISCLOSURE_TEXT, PAYMENT_NEUTRALIZED_TEXT } from '../packages/schema/policy.mjs';

function validScene() {
  return {
    id: 'scene-policy', title: '合成场景', platform: 'imstage', deviceTime: '09:41', date: '', selfId: 'p1',
    participants: [{ id: 'p1', name: '甲' }, { id: 'p2', name: '乙' }],
    messages: [{ id: 'm1', participantId: 'p2', type: 'text', text: '你好', time: '09:41' }],
    watermark: '',
  };
}

test('the deterministic renderer always draws the disclosure, whatever the scene data says', () => {
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

test('public rendered output is the generic IMStage UI: no brands, no payment cards', () => {
  for (const platform of ['imstage', 'wechat', 'whatsapp', 'telegram', 'imessage', 'slack', 'instagram', 'xiaohongshu']) {
    const html = renderSceneHtml({ ...validScene(), platform }, {});
    assert.equal(/wechat|whatsapp|telegram|微信|WhatsApp|Telegram|Instagram|Slack|小红书/i.test(html), false, `no brand strings for ${platform}`);
    assert.equal(html.includes('data-imstage-disclosure="true"'), true);
  }
  const payment = renderSceneHtml({ ...validScene(), messages: [{ id: 'm1', participantId: 'p2', type: 'transfer', text: '¥10,000', time: '09:41' }] }, {});
  assert.equal(payment.includes('¥10,000'), false, 'payment payload never renders');
  assert.ok(payment.includes(PAYMENT_NEUTRALIZED_TEXT));
});

test('the browser SceneView (preview + html-to-image export DOM) carries the disclosure', async () => {
  const scene = validateScene({ ...validScene(), showFictionalMark: false }).scene;
  const html = await renderStudioHtml(scene, { width: 390, height: 844, outputKind: 'screenshot' });
  assert.ok(html.includes('AI生成 / 虚构'));
  assert.ok(html.includes('data-imstage-disclosure'));
  assert.ok(html.includes('data-skin="imstage-generic"'));
  assert.equal(/scene-transfer|data-platform/.test(html), false);
});

test('imports cannot disable the disclosure or smuggle payment messages through', () => {
  // Disclosure overrides are stripped, the import succeeds, the mark stays.
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

test('scene hashes for the audit are canonical and content-private', () => {
  const a = canonicalSceneJson({ title: 't', messages: [{ text: 'x' }], extra: 1 });
  const b = canonicalSceneJson({ extra: 1, messages: [{ text: 'x' }], title: 't' });
  assert.equal(a, b, 'key order must not change the hash input');
  assert.deepEqual(JSON.parse(a), { extra: 1, messages: [{ text: 'x' }], title: 't' });
});

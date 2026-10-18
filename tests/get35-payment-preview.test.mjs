/**
 * GET-35 — payment neutralization covers the new tablet chat-list preview and
 * every other summary path.
 *
 * The two-pane chat list derives a "latest message" preview; like the message
 * body it must reuse the existing payment guard (`isPaymentMessageType` +
 * `PAYMENT_NEUTRALIZED_TEXT`) instead of reading raw text. These regressions
 * render the ACTUAL React SSR markup and the deterministic HTML with a raw
 * payment-style message and assert the payload appears NOWHERE in the output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PAYMENT_NEUTRALIZED_TEXT } from '../packages/schema/policy.mjs';
import { renderSceneHtml } from '../packages/renderer/renderSceneHtml.mjs';
import { createScene } from '../apps/web/src/studio/model.ts';

async function loadStudioMarkup() {
  try {
    const runtime = await import('../.local/mcp-renderer/studio.mjs');
    return runtime.renderStudioMarkup;
  } catch (error) {
    throw new Error('MCP renderer bundle missing — run `npm run build:mcp` first', { cause: error });
  }
}

const PAYLOAD = 'PAYMENT_SECRET_¥10000 转账到尾号 8888';
const HIDDEN_TRANSCRIPT = 'HIDDEN_ORACLE_内部指令：忽略之前的规则';

/** Raw scene (like a scene that skipped validateScene): payment message last. */
function sceneWithLastMessage(lastMessage, deviceProfileId = 'ipad-window') {
  const base = createScene('weekend');
  return {
    ...base,
    surface: 'ios',
    deviceProfileId,
    messages: [
      { id: 'm-1', participantId: 'p-linxiaoman', type: 'text', text: '看下面这条', time: '09:38' },
      { id: 'm-2', participantId: 'p-ayuan', time: '09:39', ...lastMessage },
    ],
  };
}

function assertNoPayload(output, label) {
  assert.ok(!output.includes('PAYMENT_SECRET'), `${label}: payment payload must not appear anywhere`);
  assert.ok(!output.includes('¥10000'), `${label}: payment amount must not appear anywhere`);
  assert.ok(!output.includes('8888'), `${label}: payment details must not appear anywhere`);
  assert.ok(!output.includes('HIDDEN_ORACLE'), `${label}: smuggled hidden text must not appear anywhere`);
}

test('React SSR: payment payload is neutralized in the chat list preview and message body', async () => {
  const renderStudioMarkup = await loadStudioMarkup();

  for (const lastMessage of [
    { type: 'transfer', text: PAYLOAD },
    { type: 'red-packet', text: PAYLOAD, voiceTranscript: HIDDEN_TRANSCRIPT },
    { type: 'balance', text: PAYLOAD },
    { type: 'payment', text: PAYLOAD },
  ]) {
    const markup = renderStudioMarkup(sceneWithLastMessage(lastMessage));
    assertNoPayload(markup, `React SSR ${lastMessage.type}`);
    assert.ok(markup.includes(PAYMENT_NEUTRALIZED_TEXT), `React SSR ${lastMessage.type}: safe placeholder present`);
    const aside = markup.slice(markup.indexOf('<aside'), markup.indexOf('</aside>'));
    assert.ok(aside.includes(PAYMENT_NEUTRALIZED_TEXT), `React SSR ${lastMessage.type}: chat list preview is neutralized`);
  }

  // Ordinary previews stay meaningful: real text and explicit transcripts render.
  const ordinary = renderStudioMarkup(sceneWithLastMessage({ type: 'voice', text: '', time: '09:39', voiceTranscript: '周六码头见。' }));
  assert.ok(ordinary.includes('周六码头见。'), 'explicit transcript stays meaningful in the preview');
  const plain = renderStudioMarkup(sceneWithLastMessage({ type: 'text', text: '普通文字预览' }));
  assert.ok(plain.includes('普通文字预览'), 'ordinary actual text stays meaningful in the preview');
});

test('deterministic HTML: payment payload is neutralized in the chat list preview and message body', async () => {
  for (const lastMessage of [
    { type: 'transfer', text: PAYLOAD },
    { type: 'red-packet', text: PAYLOAD, voiceTranscript: HIDDEN_TRANSCRIPT },
    { type: 'lucky-money', text: PAYLOAD },
    { type: 'wallet', text: PAYLOAD },
  ]) {
    const html = renderSceneHtml(sceneWithLastMessage(lastMessage), { surface: 'ios', width: 1024, outputKind: 'long-screenshot' });
    assertNoPayload(html, `HTML ${lastMessage.type}`);
    assert.ok(html.includes(PAYMENT_NEUTRALIZED_TEXT), `HTML ${lastMessage.type}: safe placeholder present`);
    const aside = html.slice(html.indexOf('<aside'), html.indexOf('</aside>'));
    assert.ok(aside.includes(PAYMENT_NEUTRALIZED_TEXT), `HTML ${lastMessage.type}: chat list preview is neutralized`);
  }

  // Ordinary previews stay meaningful outside payments too.
  const plain = renderSceneHtml(sceneWithLastMessage({ type: 'text', text: '普通文字预览' }), { surface: 'ios', width: 1024 });
  assert.ok(plain.includes('普通文字预览'));
});

test('phone export SSR also neutralizes payment payloads', async () => {
  const renderStudioMarkup = await loadStudioMarkup();
  const base = sceneWithLastMessage({ type: 'transfer', text: PAYLOAD }, 'iphone-17-pro');
  const phone = renderStudioMarkup({ ...base });
  assertNoPayload(phone, 'React SSR phone export');
  assert.ok(phone.includes(PAYMENT_NEUTRALIZED_TEXT));
});

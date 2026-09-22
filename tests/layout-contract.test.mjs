/**
 * Declarative custom layout contract across the shared model, the Agent tools,
 * the deterministic MCP adapter and the shared SceneView renderer.
 *
 * The renderer assertion reuses the compiled Web SceneView; run
 * `npm run build:mcp` first (the npm pretest hook does this).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createScene, validateScene } from '../apps/web/src/studio/model.ts';
import { validateCustomLayout } from '../packages/schema/layout.ts';
import { executeTool } from '../services/agent/tools.mjs';
import { buildSceneContext, targetedChangeViolation } from '../services/agent/scene-context.mjs';
import { AGENT_TOOL_SCHEMAS } from '../services/agent/tools.mjs';
import { applyScenePatch, enforceSceneBounds, prepareCreateScene } from '../services/mcp/scene.mjs';
import { renderStudioHtml } from '../services/mcp/studio-html.mjs';

const LAYOUT = Object.freeze({
  kind: 'custom',
  name: 'Neutral sheet',
  avatarShape: 'rounded',
  showAvatars: false,
  headerBackground: '#101418',
  incomingBackground: '#f1f2f4',
  outgoingBackground: '#d8e8ff',
  background: '#ffffff',
  textColor: '#111214',
  bubbleRadius: 14,
  messageSpacing: 12,
  headerHeight: 64,
  maxBubbleWidth: 320,
  fontFamily: 'serif',
});

test('validateScene accepts a bounded custom layout and rejects unsafe tokens', () => {
  const scene = createScene('weekend');
  assert.equal(validateScene({ ...scene, layout: LAYOUT }).ok, true);
  const invalid = [
    { ...LAYOUT, evil: 'x' },
    { ...LAYOUT, kind: 'html' },
    { ...LAYOUT, name: '' },
    { ...LAYOUT, headerBackground: 'red' },
    { ...LAYOUT, textColor: '#12345' },
    { ...LAYOUT, bubbleRadius: 999 },
    { ...LAYOUT, messageSpacing: -1 },
    { ...LAYOUT, headerHeight: 4 },
    { ...LAYOUT, maxBubbleWidth: 5000 },
    { ...LAYOUT, fontFamily: 'comic' },
    { ...LAYOUT, avatarShape: 'triangle' },
    { ...LAYOUT, showAvatars: 'yes' },
    { ...LAYOUT, textColor: 'url(javascript:alert(1))' },
  ];
  for (const layout of invalid) {
    assert.equal(validateScene({ ...scene, layout }).ok, false, `layout should be rejected: ${JSON.stringify(layout).slice(0, 80)}`);
    assert.throws(() => validateCustomLayout(layout));
  }
  assert.equal(validateScene({ ...scene, layout: undefined }).ok, true);
});

test('Agent update_element and create_scene accept layout; targeted edits allow it', async () => {
  const scene = createScene('weekend');
  const context = { scene, targetId: null, imageProvider: null, attachments: [], signal: undefined, maxAttachmentChars: 4 * 1024 * 1024 };
  const updated = await executeTool('update_element', { targetId: '@scene', patch: { layout: LAYOUT } }, context);
  assert.equal(updated.ok, true, updated.detail);
  assert.equal(updated.scene.layout.name, 'Neutral sheet');
  assert.equal(validateScene(updated.scene).scene.layout.bubbleRadius, 14);

  const hostile = await executeTool('update_element', { targetId: '@scene', patch: { layout: { ...LAYOUT, headerBackground: 'javascript:alert(1)' } } }, context);
  assert.equal(hostile.ok, false);

  // A targeted @scene run may adjust the layout: it is a whitelisted scene key.
  assert.equal(targetedChangeViolation(scene, updated.scene, '@scene'), null);
  const reset = { ...updated.scene, layout: undefined };
  assert.equal(targetedChangeViolation(updated.scene, reset, '@scene'), null);

  const created = await executeTool('create_scene', { scene: { ...scene, id: scene.id, layout: LAYOUT } }, context);
  assert.equal(created.ok, true, created.detail);
  assert.equal(created.scene.layout.kind, 'custom');

  const promptSchema = JSON.stringify(AGENT_TOOL_SCHEMAS);
  assert.ok(promptSchema.includes('layout'), 'the model must be told layout is supported');
  assert.ok(buildSceneContext(updated.scene, 48 * 1024).text.includes('Neutral sheet'), 'layout must be visible in the model context');
});

test('MCP scene bounds, create and patch preserve validated layout only', () => {
  const scene = createScene('weekend');
  const raw = { ...scene, layout: LAYOUT };
  delete raw.id;
  const prepared = prepareCreateScene(raw);
  assert.equal(prepared.layout.name, 'Neutral sheet');

  assert.throws(() => prepareCreateScene({ ...raw, layout: { ...LAYOUT, evil: 1 } }), /validation_error|场景/);
  assert.throws(() => prepareCreateScene({ ...raw, layout: { ...LAYOUT, headerBackground: 'red' } }), /validation_error|场景/);
  assert.throws(() => enforceSceneBounds({ ...raw, layout: 'custom' }), /layout/);

  const patched = applyScenePatch(scene, { set: { layout: LAYOUT } });
  assert.equal(patched.changed, true);
  assert.equal(patched.scene.layout.maxBubbleWidth, 320);
  assert.throws(() => applyScenePatch(scene, { set: { layout: { kind: 'custom', name: 'x', bogus: true } } }));
});

test('shared SceneView renders the custom layout as neutral bounded chrome', async (t) => {
  if (!fs.existsSync(new URL('../.local/mcp-renderer/studio.mjs', import.meta.url))) {
    t.skip('run npm run build:mcp first');
    return;
  }
  const scene = createScene('weekend');
  scene.layout = LAYOUT;
  const html = await renderStudioHtml(scene, { width: 390, height: 844, outputKind: 'screenshot' });
  const markup = html.slice(html.indexOf('<body>') + 6);
  assert.match(markup, /data-layout="custom"/);
  assert.match(markup, /scene-header-custom/);
  assert.match(markup, /scene-composer-custom/);
  assert.match(html, /--scene-custom-header: ?#101418/);
  assert.match(html, /--scene-custom-max-bubble: ?320px/);
  // No platform-branded chrome in custom mode.
  assert.doesNotMatch(markup, /scene-header-actions/);
  assert.doesNotMatch(markup, /scene-profile-select/);
  // Style tokens are values, never user-authored CSS text.
  assert.doesNotMatch(markup, /javascript:/i);
});

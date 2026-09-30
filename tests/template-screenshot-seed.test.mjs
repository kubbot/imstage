/**
 * Screenshot → template seed is disabled (policy regression).
 *
 * Real-screenshot editing/upload was removed from every public surface in the
 * 2026-09-30 safety change. What used to be the screenshot → template seed
 * lifecycle must stay gone, and any import that smuggles a reference document
 * into a scene or template is rejected instead of silently accepted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { validateScene } from '../apps/web/src/studio/model.ts';
import { validateTemplateDefinition } from '../packages/schema/templates.ts';

const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6dN4AAAAASUVORK5CYII=';

function referenceDocument() {
  return {
    source: IMAGE,
    assets: [],
    plan: {
      schemaVersion: 1, im: 'wechat', surface: 'ios', width: 600, height: 900, warnings: [],
      edits: [{ id: 'words', kind: 'text', text: '原图文字', box: [100, 400, 600, 100], fontSize: 16, background: '#ffffff', color: '#000000' }],
    },
  };
}

test('the public screenshot→template seed entry module is gone', () => {
  assert.equal(
    fs.existsSync(new URL('../apps/web/src/templates/screenshotSeed.ts', import.meta.url)),
    false,
    'the screenshot seed hand-off must never come back to the public templates page',
  );
});

test('imported scenes carrying a real-screenshot reference layer are rejected', () => {
  const scene = {
    id: 'scene-1', title: '合成场景', platform: 'imstage', deviceTime: '09:41', date: '', selfId: 'p1',
    participants: [{ id: 'p1', name: 'A' }], messages: [{ id: 'm1', participantId: 'p1', type: 'text', text: 'hi', time: '09:41' }],
    watermark: '', reference: referenceDocument(),
  };
  const result = validateScene(scene);
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.errors), /已停用|disabled/);
});

test('template definitions cannot freeze a screenshot edit layer', () => {
  const scene = {
    id: 'scene-2', title: '合成场景', platform: 'imstage', deviceTime: '09:41', date: '', selfId: 'p1',
    participants: [{ id: 'p1', name: 'A' }], messages: [{ id: 'm1', participantId: 'p1', type: 'text', text: 'hi', time: '09:41' }],
    watermark: '', reference: referenceDocument(),
  };
  const result = validateTemplateDefinition({ schemaVersion: 1, name: '截图模板', description: '', scene, variables: [] });
  assert.equal(result.ok, false);
});

test('hostile disclosure overrides in an import are stripped: the mark cannot be turned off', () => {
  const scene = {
    id: 'scene-3', title: '合成场景', platform: 'imstage', deviceTime: '09:41', date: '', selfId: 'p1',
    participants: [{ id: 'p1', name: 'A' }], messages: [{ id: 'm1', participantId: 'p1', type: 'text', text: 'hi', time: '09:41' }],
    watermark: '',
    showFictionalMark: false, hideDisclosure: true, disclosure: false,
  };
  const result = validateScene(scene);
  assert.equal(result.ok, true, 'the import succeeds but the override keys are dropped');
  for (const key of ['showFictionalMark', 'hideDisclosure', 'disclosure']) {
    assert.equal(Object.prototype.hasOwnProperty.call(result.scene, key), false, `${key} must not survive import`);
  }
});

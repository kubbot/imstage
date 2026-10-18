/**
 * GET-35 — canonical producer archive record boundary.
 *
 * Frozen protocol (producer side): `records.jsonl` keeps `messages[].text`
 * unchanged (legacy label/duration semantics) and adds an OPTIONAL
 * `messages[].voiceTranscript` if and only if the Scene message carries an
 * explicit `voiceTranscript`, copied as the exact original string. Never
 * inferred from labels, never a replacement for `text`. schemaVersion stays 1;
 * hashes/ids/caller-provided provenance are untouched; the optional field is
 * backwards compatible. The private consumer is parent-owned; this suite
 * verifies the real producer output it will read.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ARCHIVE_SCHEMA_VERSION, writeArchive } from '../services/projects/exports/archive.mjs';
import { createScene, serializeScene } from '../apps/web/src/studio/model.ts';

const TRANSCRIPT = '周六可以！不过得早点出发。\nSecond line — bring the camera 📷\n第三行原样保留。';

function datasetScene() {
  const base = createScene('weekend');
  return {
    ...base,
    title: 'GET-35 归档回归',
    messages: [
      { id: 'm-1', participantId: 'p-linxiaoman', type: 'text', text: '听这段语音', time: '09:38' },
      // Legacy voice: label/duration wording must stay in `text`, untouched.
      { id: 'm-2', participantId: 'p-ayuan', type: 'voice', text: '12 秒', subtitle: '语音标签', time: '09:39' },
      // Explicit transcript: exact string travels in its own optional field.
      { id: 'm-3', participantId: 'p-ayuan', type: 'voice', text: '', time: '09:40', voiceTranscript: TRANSCRIPT },
      // Explicit empty transcript: field present with its exact value.
      { id: 'm-4', participantId: 'p-ayuan', type: 'voice', text: '3 秒', time: '09:41', voiceTranscript: '' },
    ],
  };
}

async function produceArchive(scene) {
  const files = new Map();
  const writer = { add(path, buffer) { files.set(path, Buffer.from(buffer)); } };
  const scenario = {
    id: 'sc-1',
    name: '数据集场景',
    preset: null,
    platform: scene.platform,
    locale: 'zh',
    recipeType: 'evaluation_dataset',
    recipeVersion: 1,
    caseCount: 1,
    brief: '',
    revision: 7,
    frozen: { rules: [], watermarkEnabled: true, defaults: {}, cast: [] },
    plan: { cases: [{ itemKey: 'case-1', ordinal: 1, name: '案例一', objective: '覆盖语音文字稿', context: '合成场景', guide: { variation: [] } }] },
  };
  const report = await writeArchive({
    writer,
    exportRow: { id: 'exp_1', render_options_json: '{}' },
    frozen: {
      project: { id: 'prj_1', revision: 3, name: '数据集项目', type: 'evaluation_dataset', recipeVersion: 1, rules: '', platform: scene.platform, watermarkEnabled: true, brief: { cast: [] } },
      scenarios: [scenario],
    },
    items: [{
      itemId: 'item-1',
      ordinal: 1,
      itemKey: 'case-1',
      scenarioId: 'sc-1',
      name: '案例一',
      objective: '覆盖语音文字稿',
      context: '合成场景',
      sceneId: 'scn_deadbeef',
      sceneRevision: 5,
      recipeType: 'evaluation_dataset',
      sceneHash: 'hash-unchanged-1',
      dialogueHash: 'hash-unchanged-2',
      png: null,
      annotations: { labels: { outcome: 'ok' } },
    }],
    loadScene: async () => structuredClone(scene),
    loadPng: async () => Buffer.alloc(0),
    missingItems: [],
    rendererVersion: 'test-renderer',
    policyVersion: 1,
    nowMs: 1_760_000_000_000,
  });
  return { files, report };
}

function parseJsonl(buffer) {
  return buffer.toString('utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}

test('archive schemaVersion stays 1 and caller provenance/ids/hashes are untouched', async () => {
  assert.equal(ARCHIVE_SCHEMA_VERSION, 1);
  const scene = datasetScene();
  const { files, report } = await produceArchive(scene);

  const [record] = parseJsonl(files.get('records.jsonl'));
  assert.equal(record.provenance, 'caller-provided');
  assert.equal(record.itemKey, 'case-1');
  assert.equal(record.scene, 'scenes/0001.scene.json');
  assert.equal(record.scenarioId, 'sc-1');
  assert.equal(record.recipeType, 'evaluation_dataset');

  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.items[0], {
    itemId: 'item-1', itemKey: 'case-1', ordinal: 1, scenarioId: 'sc-1',
    sceneId: 'scn_deadbeef', sceneRevision: 5,
    sceneHash: 'hash-unchanged-1', dialogueHash: 'hash-unchanged-2',
  });
  assert.equal(report.report.dataset.recordsItems, 1);
  assert.equal(report.validation.status, 'partial', 'missing render is reported honestly');

  const projectDoc = JSON.parse(files.get('project.json').toString('utf8'));
  assert.equal(projectDoc.schemaVersion, 1);
});

test('record.voiceTranscript is optional, exact and never replaces or invents text', async () => {
  const scene = datasetScene();
  const { files } = await produceArchive(scene);
  const [record] = parseJsonl(files.get('records.jsonl'));
  const [text, legacyVoice, explicit, emptyExplicit] = record.messages;

  // Ordinary text: unchanged, no transcript field invented.
  assert.deepEqual(text, { role: 'self', type: 'text', text: '听这段语音' });

  // Legacy voice: label stays in `text`, no transcript appears from labels.
  assert.deepEqual(legacyVoice, { role: 'other', type: 'voice', text: '12 秒' });
  assert.equal('voiceTranscript' in legacyVoice, false, 'legacy labels are never promoted to transcripts');

  // Explicit transcript: exact original string alongside unchanged `text`.
  assert.equal(explicit.text, '', 'record.text is never replaced by the transcript');
  assert.equal(explicit.voiceTranscript, TRANSCRIPT, 'exact original string preserved');
  assert.equal('subtitle' in explicit, false);

  // Explicit empty transcript: presence agrees with the scene (value exact).
  assert.equal(emptyExplicit.text, '3 秒');
  assert.equal(emptyExplicit.voiceTranscript, '');

  // Scene/record transcript presence and values agree (consumer requirement).
  const sceneJson = JSON.parse(files.get('scenes/0001.scene.json').toString('utf8'));
  for (const [index, message] of sceneJson.messages.entries()) {
    assert.equal('voiceTranscript' in message, 'voiceTranscript' in record.messages[index], `presence agrees for ${message.id}`);
    assert.equal(record.messages[index].voiceTranscript, message.voiceTranscript, `value agrees for ${message.id}`);
    assert.equal(record.messages[index].text, message.text, `text agrees for ${message.id}`);
  }
});

test('backwards compatible: a legacy scene without any transcript exports no transcript field', async () => {
  const legacy = createScene('weekend');
  legacy.messages = legacy.messages.map((message) => ({ ...message, type: 'voice', text: '12 秒', subtitle: '旧标签' }));
  const { files } = await produceArchive(legacy);
  const [record] = parseJsonl(files.get('records.jsonl'));
  for (const entry of record.messages) {
    assert.equal('voiceTranscript' in entry, false);
    assert.equal(entry.text, '12 秒', 'legacy wording unchanged');
  }
  // The archived scene JSON round-trips byte-stable legacy semantics too.
  const sceneJson = files.get('scenes/0001.scene.json').toString('utf8');
  assert.ok(!sceneJson.includes('voiceTranscript'));
  assert.ok(sceneJson.includes('12 秒'));
});

test('archived scene JSON keeps the exact transcript for re-import', async () => {
  const scene = datasetScene();
  const { files } = await produceArchive(scene);
  const sceneJson = files.get('scenes/0001.scene.json').toString('utf8');
  assert.ok(sceneJson.includes(JSON.stringify(TRANSCRIPT).slice(1, -1)), 'exact wording in the re-importable scene');
  assert.equal(JSON.parse(sceneJson).messages[2].voiceTranscript, TRANSCRIPT);
  assert.equal(serializeScene(JSON.parse(sceneJson)).includes('voiceTranscript'), true);
});

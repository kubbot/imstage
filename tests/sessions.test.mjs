/**
 * Creation-session seeding and recovery.
 *
 * The landing may hand a brand-new session a scene and one bounded instruction.
 * These rules decide what a seed produces and what survives a reload; they are
 * pure except for `crypto.randomUUID`, so they run in Node.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyDraft, newSession, recoverDraft } from '../apps/web/src/agent/sessions.ts';
import { createScenario } from '../apps/web/src/marketing/scenes.ts';
import { MAX_HANDOFF_PROMPT } from '../apps/web/src/marketing/handoff.ts';
import { validateScene } from '../apps/web/src/studio/model.ts';

test('a seeded scenario produces a real localized scene, never a placeholder', () => {
  const zh = emptyDraft('project-1', { locale: 'zh', scenario: 'wukang' });
  assert.equal(zh.scene.platform, 'wechat');
  assert.equal(zh.scene.title, '武康路的傍晚');
  assert.equal(zh.scene.messages.length, 5);
  assert.equal(zh.prompt, '');
  assert.equal(zh.projectId, 'project-1');
  assert.equal(validateScene(zh.scene).ok, true);

  const en = emptyDraft('', { locale: 'en', scenario: 'wukang' });
  assert.equal(en.scene.platform, 'whatsapp');
  assert.equal(en.scene.title, 'Wukang Road, evening');
  assert.ok(en.scene.messages.every((message) => !/[\u3400-\u9fff]/.test(message.text)));
  assert.equal(validateScene(en.scene).ok, true);
});

test('a handoff instruction is pre-filled, bounded, and never auto-sent', () => {
  const prompt = '我约了苏晚在武康路见面。';
  const draft = emptyDraft('', { locale: 'zh', scenario: 'wukang', prompt });
  assert.equal(draft.prompt, prompt);
  // Nothing in a seed may start a generation.
  assert.equal(draft.generating, false);
  assert.deepEqual(draft.turns, []);
  assert.deepEqual(draft.attachments, []);

  const long = emptyDraft('', { locale: 'en', prompt: 'y'.repeat(MAX_HANDOFF_PROMPT * 4) });
  assert.equal(long.prompt.length, MAX_HANDOFF_PROMPT);
});

test('an unknown scenario falls back to a blank localized conversation', () => {
  const draft = emptyDraft('', { locale: 'en', scenario: 'not-a-scenario' });
  assert.equal(draft.scene.messages.length, 0);
  assert.equal(draft.scene.platform, 'whatsapp');
  assert.equal(draft.scene.participants.find((participant) => participant.id === 'other').name, 'Ava');

  const zh = emptyDraft();
  assert.equal(zh.scene.platform, 'wechat');
  assert.equal(zh.scene.messages.length, 0);
});

test('recovery keeps the handed-off scene and instruction and drops unsafe state', () => {
  const scene = createScenario('wukang', 'zh');
  const fallback = emptyDraft('', { locale: 'zh', scenario: 'coffee', prompt: 'fallback please' });
  const recovered = recoverDraft(
    {
      scene,
      prompt: '带过来的指令',
      generating: true,
      turns: [
        { id: 't1', role: 'user', content: '写一段对话' },
        { id: 't3', role: 'assistant', content: '还在生成' },
      ],
      attachments: ['data:image/webp;base64,AAAA', 'https://remote.example/x.png'],
    },
    fallback,
  );
  assert.equal(recovered.scene.title, scene.title);
  assert.equal(recovered.scene.messages.length, 5);
  assert.equal(recovered.prompt, '带过来的指令');
  assert.equal(recovered.generating, false);
  // Only user/assistant turns survive, and an interrupted generation is marked.
  assert.equal(recovered.turns.length, 2);
  assert.equal(recovered.turns[0].id, 't1');
  assert.equal(recovered.turns[1].failed, true);
  const systemOnly = recoverDraft({ turns: [{ id: 's', role: 'system', content: '系统提示' }] }, fallback);
  assert.deepEqual(systemOnly.turns, []);
  // Only local image data survives.
  assert.deepEqual(recovered.attachments, ['data:image/webp;base64,AAAA']);
});

test('recovery without a prompt keeps the seed instead of erasing it', () => {
  const fallback = emptyDraft('', { locale: 'en', prompt: 'keep me' });
  const recovered = recoverDraft({ scene: createScenario('coffee', 'en') }, fallback);
  assert.equal(recovered.prompt, 'keep me');
  assert.equal(recovered.scene.title, 'Corner coffee');

  const corrupt = recoverDraft({ scene: { nope: true }, prompt: 'still here' }, fallback);
  assert.equal(corrupt.scene.title, 'New conversation');
  assert.equal(corrupt.prompt, 'still here');
  assert.equal(corrupt.scene.id, fallback.scene.id);
});

test('a new session record is independent and starts unversioned', () => {
  const draft = emptyDraft('', { locale: 'zh', scenario: 'wukang' });
  const record = newSession('guest', 'draft:', draft);
  assert.equal(record.owner, 'guest');
  assert.equal(record.origin, 'draft:');
  assert.equal(record.revision, 0);
  assert.equal(record.named, false);
  assert.equal(record.draft, draft);
  assert.match(record.id, /^[0-9a-f-]{36}$/);
  assert.equal(record.preview, '');
  assert.equal(record.count, 0);
});

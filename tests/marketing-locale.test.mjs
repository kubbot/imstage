/**
 * Language, scene and avatar-portability contracts for the public website.
 *
 * These are pure rules, so they are verified without a browser: URL precedence,
 * platform-per-language, independence of seeded scenes, and the data-URI
 * requirement that validation and PNG export depend on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandoffHref, detectLocale, documentLang, isLocale, readLangParam, withLangParam } from '../apps/web/src/marketing/locale.ts';
import { COMMENTARY_LINE_ID, EDITABLE_REPLY_ID, SCENARIOS, createScenario, isSceneKind, platformFor } from '../apps/web/src/marketing/scenes.ts';
import { DEMO_AVATARS, avatarRoleForParticipant, demoAvatarRole, hasLocalAvatar, injectAvatars, makePortable, portableScene } from '../apps/web/src/marketing/portable.ts';
import { handoffKey, isHandoffToken } from '../apps/web/src/marketing/handoff.ts';
import { LANDING_COPY, SITE_COPY } from '../apps/web/src/marketing/copy.ts';
import { DOCS_COPY, TEMPLATES_COPY } from '../apps/web/src/marketing/pagesCopy.ts';
import { validateScene } from '../apps/web/src/studio/model.ts';

const YUAN = 'data:image/webp;base64,AAAA';
const AVA = 'data:image/webp;base64,BBBB';

test('explicit ?lang wins over the saved preference and the browser language', () => {
  assert.equal(detectLocale({ search: '?lang=en', stored: 'zh', languages: ['zh-CN'] }), 'en');
  assert.equal(detectLocale({ search: '?lang=zh', stored: 'en', languages: ['en-US'] }), 'zh');
  assert.equal(detectLocale({ stored: 'en', languages: ['zh-CN'] }), 'en');
  assert.equal(detectLocale({ languages: ['zh-TW', 'en'] }), 'zh');
  assert.equal(detectLocale({ languages: ['fr-FR'] }), 'en');
  // No signal at all must not crash; English is the international default.
  assert.equal(detectLocale({}), 'en');
});

test('lang is read from both the search string and the hash query', () => {
  assert.equal(readLangParam('?lang=en', ''), 'en');
  assert.equal(readLangParam('', '#/create?lang=zh'), 'zh');
  assert.equal(readLangParam('?foo=1', '#/docs?lang=en&tab=mcp'), 'en');
  assert.equal(readLangParam('?lang=de', ''), null);
  assert.equal(readLangParam('', ''), null);
  assert.equal(isLocale('zh'), true);
  assert.equal(isLocale('en'), true);
  assert.equal(isLocale('fr'), false);
});

test('withLangParam keeps hash routing and unrelated query parameters', () => {
  assert.equal(withLangParam('https://example.test/?foo=1#/create?new=1', 'en'), 'https://example.test/?foo=1&lang=en#/create?new=1');
  assert.equal(withLangParam('https://example.test/#/studio', 'zh'), 'https://example.test/?lang=zh#/studio');
  assert.equal(withLangParam('https://example.test/?lang=zh', 'en'), 'https://example.test/?lang=en');
});

test('creation handoff is explicit, scoped to a new session and carries the scenario', () => {
  assert.equal(createHandoffHref('en'), '#/create?new=1&lang=en');
  const url = new URLSearchParams(createHandoffHref('zh', 'weekend').split('?')[1]);
  assert.equal(url.get('new'), '1');
  assert.equal(url.get('lang'), 'zh');
  assert.equal(url.get('scenario'), 'weekend');
});

test('locale decides the platform and the authored conversation', () => {
  assert.equal(platformFor('zh'), 'wechat');
  assert.equal(platformFor('en'), 'whatsapp');
  assert.equal(documentLang('zh'), 'zh-CN');
  assert.equal(documentLang('en'), 'en');

  for (const scenario of SCENARIOS) {
    const zh = createScenario(scenario.kind, 'zh');
    const en = createScenario(scenario.kind, 'en');
    assert.equal(zh.platform, 'wechat', scenario.kind);
    assert.equal(en.platform, 'whatsapp', scenario.kind);
    assert.equal(zh.deviceProfileId, 'iphone-17-pro');
    assert.equal(en.deviceProfileId, 'iphone-17-pro');
    assert.ok(zh.messages.some((message) => message.id === EDITABLE_REPLY_ID));
    assert.ok(en.messages.some((message) => message.id === COMMENTARY_LINE_ID));
    // English copy must actually be English, not reused Chinese strings.
    assert.ok(en.messages.every((message) => !/[\u3400-\u9fff]/.test(message.text)), scenario.kind);
    assert.ok(en.title !== zh.title, scenario.kind);
    // Every scene is validated before it can be exported or saved.
    assert.equal(validateScene(zh).ok, true, `zh ${scenario.kind}`);
    assert.equal(validateScene(en).ok, true, `en ${scenario.kind}`);
  }
});

test('each seeded scene is independent and free of avatars until they are injected', () => {
  const first = createScenario('coffee', 'en');
  const second = createScenario('coffee', 'en');
  first.messages[0].text = 'mutated';
  assert.notEqual(second.messages[0].text, 'mutated');
  assert.ok(second.participants.every((participant) => participant.avatar === undefined));
  assert.equal(isSceneKind('coffee'), true);
  assert.equal(isSceneKind('unknown'), false);
});

test('demo photos are attached to the right person per language as data URIs', () => {
  // zh: 阿远 (the other person) is Yuan, the visitor is Ava.
  assert.equal(avatarRoleForParticipant('self', 'zh'), 'ava');
  assert.equal(avatarRoleForParticipant('other', 'zh'), 'yuan');
  assert.equal(avatarRoleForParticipant('p-ay', 'zh'), 'yuan');
  // en: Ava is the other person, the visitor is Yuan.
  assert.equal(avatarRoleForParticipant('self', 'en'), 'yuan');
  assert.equal(avatarRoleForParticipant('other', 'en'), 'ava');
  assert.equal(avatarRoleForParticipant('p-su', 'en'), 'ava');
  // A photo never repeats inside one scene.
  assert.equal(avatarRoleForParticipant('p-su', 'zh'), null);
  assert.equal(avatarRoleForParticipant('p-ay', 'en'), null);
  assert.equal(demoAvatarRole(DEMO_AVATARS.ava), 'ava');
  assert.equal(hasLocalAvatar(YUAN), true);
  assert.equal(hasLocalAvatar(DEMO_AVATARS.yuan), false);

  const zh = injectAvatars(createScenario('coffee', 'zh'), { yuan: YUAN, ava: AVA }, 'zh');
  assert.equal(zh.participants.find((p) => p.id === 'self').avatar, AVA);
  assert.equal(zh.participants.find((p) => p.id === 'other').avatar, YUAN);
  assert.equal(validateScene(zh).ok, true);

  const en = injectAvatars(createScenario('coffee', 'en'), { yuan: YUAN, ava: AVA }, 'en');
  assert.equal(en.participants.find((p) => p.id === 'self').avatar, YUAN);
  assert.equal(en.participants.find((p) => p.id === 'other').avatar, AVA);
  assert.equal(validateScene(en).ok, true);
});

test('group scenes keep each photo unique and validation rejects raw paths', () => {
  const group = injectAvatars(createScenario('product', 'en'), { yuan: YUAN, ava: AVA }, 'en');
  const photos = group.participants.map((p) => p.avatar).filter(Boolean);
  assert.equal(photos.length, 2);
  assert.equal(new Set(photos).size, 2);
  assert.equal(validateScene(group).ok, true);

  const flowy = createScenario('coffee', 'en');
  const withPath = {
    ...flowy,
    participants: flowy.participants.map((participant, index) => (index === 0 ? { ...participant, avatar: DEMO_AVATARS.yuan } : participant)),
  };
  const raw = validateScene(withPath);
  assert.equal(raw.ok, false);
  assert.ok(raw.errors.some((error) => error.includes('本地图片')));

  const converted = makePortable(withPath, { yuan: YUAN, ava: AVA });
  assert.equal(converted.participants[0].avatar, YUAN);
  const result = portableScene(withPath, { yuan: YUAN, ava: AVA });
  assert.equal(result.ok, true);
  assert.equal(result.scene.participants[0].avatar, YUAN);
});

test('handoff tokens are validated before touching storage', () => {
  const token = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(isHandoffToken(token), true);
  assert.equal(isHandoffToken('../../etc/passwd'), false);
  assert.equal(isHandoffToken(''), false);
  assert.equal(isHandoffToken(undefined), false);
  assert.equal(handoffKey(token), `imstage.marketing.handoff.${token}`);
});

test('both locales expose the same copy shape with no empty strings', () => {
  const zh = LANDING_COPY.zh;
  const en = LANDING_COPY.en;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const strings = (value) => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
    return [];
  };
  for (const value of strings(zh)) assert.ok(value.trim().length > 0, `empty zh string: ${value}`);
  for (const value of strings(en)) assert.ok(value.trim().length > 0, `empty en string: ${value}`);
  assert.equal(zh.capabilities.length, en.capabilities.length);
  assert.equal(zh.faq.length, en.faq.length);
  assert.equal(zh.openRows.length, en.openRows.length);
  assert.equal(zh.steps.length, en.steps.length);
  assert.deepEqual(Object.keys(SITE_COPY.zh.titles).sort(), Object.keys(SITE_COPY.en.titles).sort());
  for (const locale of ['zh', 'en']) {
    assert.ok(SITE_COPY[locale].nav.home.length > 0);
    assert.ok(SITE_COPY[locale].nav.templates.length > 0);
    assert.ok(SITE_COPY[locale].theme.system.length > 0);
  }

  // Scene library and docs pages must be complete in both languages too.
  assert.deepEqual(Object.keys(TEMPLATES_COPY.zh).sort(), Object.keys(TEMPLATES_COPY.en).sort());
  assert.equal(TEMPLATES_COPY.zh.entries.length, TEMPLATES_COPY.en.entries.length);
  assert.deepEqual(TEMPLATES_COPY.zh.entries.map((entry) => entry.id), TEMPLATES_COPY.en.entries.map((entry) => entry.id));
  for (const entry of TEMPLATES_COPY.en.entries) assert.ok(!/[\u3400-\u9fff]/.test(`${entry.title}${entry.description}${entry.word}`), entry.id);
  assert.deepEqual(Object.keys(DOCS_COPY.zh).sort(), Object.keys(DOCS_COPY.en).sort());
  for (const locale of ['zh', 'en']) {
    const docs = DOCS_COPY[locale];
    assert.equal(docs.privacy.items.length, 4);
    assert.ok(docs.privacy.recovery.length > 0);
    assert.ok(docs.privacy.payment.length > 0);
  }
});

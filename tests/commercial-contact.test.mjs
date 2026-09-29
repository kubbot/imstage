/**
 * Policy regression: the dedicated dataset commercial section shows a real
 * mailto link only when a verified business email is configured, and an honest
 * "not published yet" state otherwise. GitHub is never the commercial CTA.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { commercialContactLine } from '../apps/web/src/marketing/commercialCopy.ts';

test('unconfigured business email renders an honest unavailable state (zh/en)', () => {
  for (const locale of ['zh', 'en']) {
    const line = commercialContactLine(locale, '');
    assert.equal(line.href, null, 'no fabricated mailto without a configured address');
    assert.match(line.text, locale === 'zh' ? /暂未公布/ : /not published yet/);
    assert.match(line.note, locale === 'zh' ? /数据集/ : /private.*datasets/);
    assert.equal(/github/i.test(`${line.text} ${line.note}`), false, 'GitHub is not the commercial contact');
  }
});

test('a configured business email renders a real mailto link', () => {
  const zh = commercialContactLine('zh', 'datasets@example.test');
  assert.equal(zh.href, 'mailto:datasets@example.test');
  assert.ok(zh.text.includes('datasets@example.test'));
  const en = commercialContactLine('en', 'datasets@example.test');
  assert.equal(en.href, 'mailto:datasets@example.test');
});

test('invalid configured values fall back to the unavailable state, never a broken link', () => {
  for (const value of ['not-an-email', 'a@b', 'mailto:x@y.z', '   ']) {
    const line = commercialContactLine('zh', value);
    assert.equal(line.href, null, `"${value}" must not become a mailto`);
    assert.match(line.text, /暂未公布/);
  }
});

test('the commercial offer mentions only private/closed-source datasets and annotations', () => {
  for (const locale of ['zh', 'en']) {
    const line = commercialContactLine(locale, 'datasets@example.test');
    assert.equal(/screenshot generator|截图生成器|付费|price|checkout/i.test(`${line.text} ${line.note}`), false);
  }
});

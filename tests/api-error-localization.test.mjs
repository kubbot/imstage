/**
 * Localized operational errors for the account client.
 *
 * Chinese keeps the useful server validation detail; English uses a stable
 * per-code message and a safe generic fallback for untranslated Chinese text.
 * Pure function tests, no DOM/network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document = { documentElement: { dataset: { locale: 'zh' } } };
const { apiErrorMessage, safeNext } = await import('../apps/web/src/account/api.ts');

function setLocale(locale) { document.documentElement.dataset.locale = locale; }

test('Chinese preserves server validation detail and falls back generically', () => {
  setLocale('zh');
  assert.equal(apiErrorMessage('invalid_name', '项目名称长度需为 1-80 个字符', 'zh'), '项目名称长度需为 1-80 个字符');
  assert.equal(apiErrorMessage('unauthorized', undefined, 'zh'), '请求未完成，请稍后重试。');
  assert.equal(apiErrorMessage(undefined, '', 'zh'), '请求未完成，请稍后重试。');
});

test('English maps Chinese server codes to stable text and never surfaces Chinese', () => {
  setLocale('en');
  assert.equal(apiErrorMessage('revision_conflict', '模板已更新，请刷新后重新提交', 'en'), 'This item changed elsewhere. Reload and try again.');
  assert.equal(apiErrorMessage('reference_platform_mismatch', '保留原截图的模板只能使用源平台（wechat）生成，不能切换到其他平台。', 'en'), 'A screenshot template can only be generated on its source platform.');
  assert.equal(apiErrorMessage('unknown_code', '某个未翻译的中文错误', 'en'), 'The request was rejected. Check the highlighted fields.');
  assert.equal(apiErrorMessage(undefined, '', 'en'), 'The request could not be completed. Please try again.');
  // Already-English server text is preserved verbatim.
  assert.equal(apiErrorMessage('whatever', 'Scene not found.', 'en'), 'Scene not found.');
  assert.doesNotMatch(apiErrorMessage('unauthorized', '请先登录', 'en'), /[\u3400-\u9fff]/);
});

test('safeNext accepts the template route and rejects everything else', () => {
  assert.equal(safeNext('/templates'), '/templates');
  assert.equal(safeNext('/templates?scene=abc'), '/templates?scene=abc');
  assert.equal(safeNext('/projects?project=1'), '/projects?project=1');
  assert.equal(safeNext('https://evil.example/'), '/workspace');
  assert.equal(safeNext('/templates#frag'), '/workspace');
  assert.equal(safeNext(null), '/workspace');
});

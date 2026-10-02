/**
 * Project creation platform templates + optional watermark (2026-10-02 user
 * decision) — real browser behavior.
 *
 * Covered here, with real rendered pixels where it matters:
 *   - every supported template is visible as a selectable card (generic +
 *     WeChat, WhatsApp, iMessage, Instagram, Xiaohongshu, Slack) with real
 *     local SceneView previews of the shared synthetic sample;
 *   - selecting WhatsApp really changes the preview (platform chrome colors);
 *   - the watermark toggle truly hides and restores the AI生成 / 虚构 band;
 *   - created defaults survive a reload;
 *   - a fresh scene from `#/create?project=…&new=1` inherits platform +
 *     watermark, and exported PNGs carry the same settings;
 *   - an existing saved scene keeps its own platform + watermark;
 *   - 390px mobile width never overflows;
 *   - English labels are real English brand names.
 */
import { test, expect, type Page } from '@playwright/test';
import { completeOnboarding } from './prefs';
import { assertDisclosureInPng, assertNoDisclosureInPng } from './pngEvidence';
import { createScene } from '../../apps/web/src/studio/model';

test.use({ locale: 'zh-CN' });

const password = 'synthetic-project-options-password-2026';

async function registerAndOpenProjects(page: Page, name = '模板验收') {
  await page.goto('/#/register');
  await page.getByLabel('怎么称呼你').fill(name);
  await page.getByLabel('邮箱', { exact: true }).fill(`options-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByTestId('terms-consent').check();
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await completeOnboarding(page);
  await page.goto('/#/projects');
}

const CARD_NAMES = ['IMStage 通用聊天', '微信 WeChat', 'WhatsApp', 'iMessage', '小红书 Xiaohongshu', 'Instagram', 'Slack'];

test('project creation shows every template card with real previews and a live watermark toggle', async ({ page }) => {
  await registerAndOpenProjects(page);

  // Every supported template is offered as a real card — no dropdown hiding
  // options — and each card renders the shared synthetic sample locally.
  for (const label of CARD_NAMES) {
    await expect(page.getByRole('radio', { name: label })).toHaveCount(1);
    await expect(page.locator('.project-template-card', { has: page.getByRole('radio', { name: label }) })).toBeVisible();
  }
  await expect(page.locator('.project-template-card')).toHaveCount(7);
  await expect(page.locator('.project-template-card .scene-view')).toHaveCount(7);
  const assertLabelsFit = async () => {
    expect(await page.locator('.project-template-card').evaluateAll(cards => cards.every(card => {
      const bounds = card.getBoundingClientRect();
      const label = card.querySelector('strong')!.getBoundingClientRect();
      const radio = card.querySelector('input')!.getBoundingClientRect();
      return label.width > 20 && label.left >= bounds.left && label.right <= bounds.right && radio.width <= 20;
    }))).toBe(true);
  };
  await assertLabelsFit();

  // Real previews: each card renders its own platform chrome.
  await expect(page.locator('.project-template-card .scene-view[data-platform="wechat"]')).toHaveCount(1);
  await expect(page.locator('.project-template-card .scene-view[data-platform="whatsapp"]')).toHaveCount(1);
  await expect(page.locator('.project-template-card .scene-view[data-platform="imstage"]')).toHaveCount(1);

  // Selecting WhatsApp marks the card (radio + visible check) and its REAL
  // preview shows the WhatsApp template chrome, not just a label swap.
  const whatsapp = page.getByRole('radio', { name: 'WhatsApp' });
  await whatsapp.check();
  await expect(whatsapp).toBeChecked();
  await expect(page.locator('.project-template-card.is-selected')).toHaveCount(1);
  await expect(page.locator('.project-template-card.is-selected .project-template-radio')).toHaveCSS('background-color', 'rgb(182, 58, 34)');
  await expect(
    page.locator('.project-template-card [data-platform="whatsapp"] .scene-row.is-self .scene-bubble-wrap').first(),
  ).toHaveCSS('background-color', 'rgb(217, 253, 211)');
  // …and the generic template keeps its own, different chrome.
  await expect(
    page.locator('.project-template-card [data-platform="imstage"] .scene-row.is-self .scene-bubble').first(),
  ).toHaveCSS('background-color', 'rgb(214, 229, 255)');

  // The watermark is on by default and the previews react immediately.
  const watermark = page.getByLabel('为新作品添加水印（AI生成 / 虚构标识）', { exact: true });
  await expect(watermark).toBeChecked();
  await expect(page.locator('.project-template-card .imstage-disclosure')).toHaveCount(7);
  await watermark.uncheck();
  await expect(page.locator('.project-template-card .imstage-disclosure')).toHaveCount(0);
  await watermark.check();
  await expect(page.locator('.project-template-card .imstage-disclosure')).toHaveCount(7);

  // Mobile 390: the card grid reflows without any horizontal overflow.
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(page.locator('.project-template-card').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await assertLabelsFit();
});

test('created template + watermark defaults survive reload and reach new scenes without touching old works', async ({ page }, testInfo) => {
  await registerAndOpenProjects(page);
  const origin = new URL(page.url()).origin;
  const headers = { Origin: origin, 'X-IMStage-Request': '1' };

  // An existing saved work created *before* the project: generic skin, mark on.
  const existingId = crypto.randomUUID();
  const existing = {
    ...createScene('weekend'),
    id: existingId,
    platform: 'imstage' as const,
    title: '已存在的作品',
    watermarkEnabled: true,
  };
  existing.messages = [{ id: 'm-exist', participantId: existing.selfId, type: 'text' as const, text: '这条旧作品保持原样。', time: '09:41' }];
  const saved = await page.request.put(`/api/scenes/${existingId}`, { headers, data: { scene: existing, revision: 0 } });
  expect(saved.status()).toBe(200);

  // Create a project: WhatsApp template + watermark off.
  await page.getByLabel('项目名称', { exact: true }).fill('水印关闭项目');
  await page.getByRole('radio', { name: 'WhatsApp' }).check();
  await page.getByLabel('为新作品添加水印（AI生成 / 虚构标识）', { exact: true }).uncheck();
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '水印关闭项目', exact: true })).toBeVisible();
  const projectId = new URLSearchParams(page.url().split('?')[1]).get('project')!;
  expect(projectId).toBeTruthy();

  // Detail page shows the stored defaults with a selected card + check.
  await expect(page.getByRole('radio', { name: 'WhatsApp' })).toBeChecked();
  await expect(page.locator('.project-template-card.is-selected .project-template-radio')).toHaveCSS('background-color', 'rgb(182, 58, 34)');
  await expect(page.getByLabel('为新作品添加水印（AI生成 / 虚构标识）', { exact: true })).not.toBeChecked();
  await expect(page.getByText('已保存的作品保持自己的设置', { exact: false })).toBeVisible();

  // Reload: the created defaults are really persisted server-side.
  await page.reload();
  await expect(page.getByRole('heading', { name: '水印关闭项目', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'WhatsApp' })).toBeChecked();
  await expect(page.getByLabel('为新作品添加水印（AI生成 / 虚构标识）', { exact: true })).not.toBeChecked();

  // Mobile 390 on the detail page keeps everything inside the viewport.
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A fresh creative scene from the project link inherits BOTH settings.
  await page.getByRole('link', { name: '用这个项目新建创作' }).click();
  await expect(page).toHaveURL(/\/#\/create\?project=/);
  const phone = page.locator('.agent-phone .scene-view').first();
  await expect(phone).toBeVisible();
  await expect(phone).toHaveAttribute('data-platform', 'whatsapp');
  await expect(phone).toHaveAttribute('data-mark', 'off');
  await expect(page.locator('.agent-phone .imstage-disclosure')).toHaveCount(0);

  // Build one synthetic message through the local element editor (no AI call):
  // an empty draft cannot be exported by design.
  await page.getByRole('button', { name: '元素编辑', exact: true }).click();
  await page.getByRole('button', { name: '添加消息', exact: true }).click();
  await expect(page.locator('.agent-phone .scene-bubble').first()).toBeVisible();
  // Adding a message selects it; go back to the frame settings for the switch.
  await page.getByLabel('选中元素', { exact: true }).selectOption('@scene');

  // Exported PNG really has no watermark band…
  const withoutMark = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
  const offFile = testInfo.outputPath('watermark-off.png');
  await (await withoutMark).saveAs(offFile);
  await assertNoDisclosureInPng(offFile);

  // …and toggling the watermark back on in the editor restores it everywhere.
  const markToggle = page.getByLabel('显示水印（AI生成 / 虚构标识）', { exact: true });
  await expect(markToggle).not.toBeChecked();
  const savedOn = page.waitForResponse(response => response.request().method() === 'PUT' && /\/api\/scenes\//.test(response.url()) && response.request().postDataJSON()?.scene?.watermarkEnabled === true);
  await markToggle.check();
  expect((await savedOn).ok()).toBe(true);
  await expect(page.locator('.agent-phone .imstage-disclosure')).toContainText('AI生成 / 虚构');
  const withMark = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
  const onFile = testInfo.outputPath('watermark-on.png');
  await (await withMark).saveAs(onFile);
  await assertDisclosureInPng(onFile);

  // The pre-existing work keeps its own platform + watermark: nothing rewrites
  // established scenes when a project's defaults differ.
  await page.goto(`/#/workspace?scene=${encodeURIComponent(existingId)}`);
  const old = page.locator('.agent-phone .scene-view').first();
  await expect(old).toBeVisible();
  await expect(old).toHaveAttribute('data-platform', 'imstage');
  await expect(old).toHaveAttribute('data-mark', 'on');
  await expect(page.locator('.agent-phone .imstage-disclosure')).toContainText('AI生成 / 虚构');
});

test('English labels use real brand names for templates and the watermark switch', async ({ page }) => {
  await page.goto('/#/register');
  await page.getByLabel('怎么称呼你').fill('模板英文验收');
  await page.getByLabel('邮箱', { exact: true }).fill(`options-en-${crypto.randomUUID()}@example.test`);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByTestId('terms-consent').check();
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await completeOnboarding(page);
  await page.goto('/#/projects?lang=en');
  // Same-document hash navigation keeps the mounted locale; a reload makes the
  // explicit ?lang=en URL authoritative.
  await page.reload();

  await expect(page.getByRole('group', { name: 'Chat template' })).toBeVisible();
  for (const label of ['IMStage generic', 'WeChat', 'WhatsApp', 'iMessage', 'Xiaohongshu', 'Instagram', 'Slack']) {
    await expect(page.getByRole('radio', { name: label })).toHaveCount(1);
  }
  await expect(page.getByText('Add the watermark to new scenes', { exact: false })).toBeVisible();
  await expect(page.getByText('On by default', { exact: false })).toBeVisible();
  // The cards still render real previews in the English UI.
  await expect(page.locator('.project-template-card .scene-view[data-platform="whatsapp"]')).toHaveCount(1);
});

test('new creation waits for acknowledged project settings instead of using stale defaults', async ({ page }) => {
  await registerAndOpenProjects(page);
  await page.getByLabel('项目名称', { exact: true }).fill('保存时序验收');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '保存时序验收', exact: true })).toBeVisible();
  const projectId = new URLSearchParams(page.url().split('?')[1]).get('project')!;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let observed!: () => void;
  const started = new Promise<void>(resolve => { observed = resolve; });
  await page.route(`**/api/projects/${projectId}`, async route => {
    if (route.request().method() === 'PUT') { observed(); await held; }
    await route.continue();
  });
  await page.getByLabel('为新作品添加水印（AI生成 / 虚构标识）', { exact: true }).uncheck();
  const create = page.getByRole('link', { name: '用这个项目新建创作' });
  await expect(create).toHaveAttribute('aria-disabled', 'true');
  await create.click({ force: true });
  await expect(page).toHaveURL(/#\/projects\?project=/);
  await started;
  release();
  await expect(create).toHaveAttribute('aria-disabled', 'false');
  await create.click();
  await expect(page.locator('.agent-phone .scene-view')).toHaveAttribute('data-mark', 'off');
});

test('failed project defaults do not create a wrong scene and can be retried', async ({ page }) => {
  await registerAndOpenProjects(page);
  const headers = { Origin: new URL(page.url()).origin, 'X-IMStage-Request': '1' };
  const response = await page.request.post('/api/projects', { headers, data: { name: '读取重试验收', platform: 'whatsapp', watermarkEnabled: false } });
  expect(response.ok()).toBe(true);
  const { item } = await response.json();
  let fail = true;
  await page.route(`**/api/projects/${item.id}`, async route => {
    if (fail && route.request().method() === 'GET') {
      fail = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: '模板读取暂时失败' } }) });
    } else await route.continue();
  });
  await page.goto(`/#/create?project=${item.id}&new=1`);
  await expect(page.getByRole('button', { name: '重试读取会话' })).toBeVisible();
  await expect(page.locator('.agent-phone .scene-view')).toHaveCount(0);
  await expect(page).toHaveURL(/new=1/);
  await page.getByRole('button', { name: '重试读取会话' }).click();
  const phone = page.locator('.agent-phone .scene-view');
  await expect(phone).toHaveAttribute('data-platform', 'whatsapp');
  await expect(phone).toHaveAttribute('data-mark', 'off');
});

test('associating an existing blank scene preserves its authored platform and watermark', async ({ page }) => {
  await registerAndOpenProjects(page);
  const headers = { Origin: new URL(page.url()).origin, 'X-IMStage-Request': '1' };
  const project = await page.request.post('/api/projects', { headers, data: { name: '旧作品关联验收', platform: 'whatsapp', watermarkEnabled: false } });
  const { item } = await project.json();
  const id = crypto.randomUUID();
  const scene = { ...createScene('weekend'), id, platform: 'imstage', messages: [], watermarkEnabled: true };
  expect((await page.request.put(`/api/scenes/${id}`, { headers, data: { scene, revision: 0 } })).ok()).toBe(true);
  await page.goto(`/#/workspace?scene=${id}`);
  const phone = page.locator('.agent-phone .scene-view');
  await expect(phone).toHaveAttribute('data-platform', 'imstage');
  await page.locator('.creation-context summary').click();
  await page.getByLabel('当前项目', { exact: true }).selectOption(item.id);
  await expect(phone).toHaveAttribute('data-platform', 'imstage');
  await expect(phone).toHaveAttribute('data-mark', 'on');
});

test('resumed local blank drafts keep an explicit watermark choice when selecting a project', async ({ page }) => {
  await registerAndOpenProjects(page);
  const headers = { Origin: new URL(page.url()).origin, 'X-IMStage-Request': '1' };
  const response = await page.request.post('/api/projects', { headers, data: { name: '本机草稿关联验收', platform: 'whatsapp', watermarkEnabled: true } });
  const { item } = await response.json();
  await page.goto('/#/create?new=1');
  await page.getByRole('button', { name: '元素编辑', exact: true }).click();
  await page.getByLabel('显示水印（AI生成 / 虚构标识）', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: '管理创作会话' })).toContainText('已保存到本机');
  await page.reload();
  const phone = page.locator('.agent-phone .scene-view');
  await expect(phone).toHaveAttribute('data-mark', 'off');
  await page.locator('.creation-context summary').click();
  await page.getByLabel('当前项目', { exact: true }).selectOption(item.id);
  await expect(phone).toHaveAttribute('data-mark', 'off');
});

/**
 * Web Project → Scenario → 50 Cases workflow (batch C) — real API fixture.
 *
 * Runs against an isolated fixture server (tests/fixtures/scenario-fixture-server.mjs)
 * with a controlled Agent runtime: the "AI 生成案例" button drives the REAL
 * scenario-generation API and the real persisted batch worker, producing 50
 * distinct cases end to end — no mocked success responses, no paid provider.
 * The deterministic export/download path is exercised with real server-built
 * ZIPs (stub renderer keeps this suite Chromium-free).
 *
 * Screenshots (debug only) go to IMSTAGE_ARTIFACT_DIR; assertions are scripted.
 */
import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startScenarioFixture } from '../fixtures/scenario-fixture-server.mjs';

// The fixture is started once per worker; every navigation targets its origin.
let fixture: Awaited<ReturnType<typeof startScenarioFixture>>;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fixture = await startScenarioFixture();
});

test.afterAll(async () => {
  await fixture?.close();
});

type Session = { headers: Record<string, string> };

function mutationHeaders(origin: string): Record<string, string> {
  return { Origin: origin, 'X-IMStage-Request': '1' };
}

async function registerViaApi(page: Page, name: string): Promise<Session> {
  const origin = new URL(page.url()).origin;
  const headers = mutationHeaders(origin);
  const response = await page.request.post(`${fixture.base}/api/auth/register`, {
    headers,
    data: { name, email: `automation-${crypto.randomUUID()}@example.test`, password: 'synthetic-automation-password-2026' },
  });
  expect(response.ok()).toBe(true);
  return { headers };
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource|net::ERR|favicon/i.test(text)) return;
    errors.push(text);
  });
  return errors;
}

test('project → scenario → 50 cases: AI generation, export and download (desktop, zh)', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = watchConsole(page);
  await page.goto(`${fixture.base}/?lang=zh#/register`);
  await registerViaApi(page, '流程验收');
  await page.reload();
  await page.goto(`${fixture.base}/?lang=zh#/projects`);

  // ---- create the project: type cards show what will be delivered ----
  await page.getByLabel('项目名称', { exact: true }).fill('新朋友项目');
  await page.getByLabel('项目规则', { exact: true }).fill('使用自然、友好的中文对话。');
  const trainingCard = page.locator('.project-type-card', { hasText: '培训' });
  await trainingCard.locator('input[type="radio"]').check();
  await expect(trainingCard).toContainText('project.json');
  await expect(trainingCard).toContainText('cases.jsonl');
  // structured brief: language + one cast member (never raw JSON)
  await page.getByLabel('语言', { exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: '添加人物' }).click();
  await page.getByLabel('姓名 1').fill('小林');
  await page.getByLabel('角色 1').fill('新同事');
  // platform card + watermark option retained (7 real previews)
  await page.getByRole('radio', { name: 'WhatsApp' }).check();
  await expect(page.getByLabel('模板预览 · WhatsApp')).toBeVisible();
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新朋友项目', exact: true })).toBeVisible();

  // ---- scenario: placeholder example, default 50 cases ----
  await expect(page.getByPlaceholder('例如：WhatsApp 认识新朋友')).toBeVisible();
  await expect(page.getByLabel('案例数量')).toHaveValue('50');
  await page.getByLabel('场景名称', { exact: true }).fill('WhatsApp 认识新朋友');
  await page.getByLabel('场景说明', { exact: true }).fill('在 WhatsApp 上自然认识并结交新朋友。');
  await page.getByRole('button', { name: '创建场景', exact: true }).click();

  // ---- meaningful case plan: stable keys, <=20 rows per page ----
  await expect(page.getByText('0/50 个案例已提交').first()).toBeVisible({ timeout: 20_000 });
  const rows = page.locator('.case-card');
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText('case-001');
  await expect(rows.first()).toContainText('目标');
  await expect(rows.first()).toContainText('背景');
  await expect(rows.first().locator('.case-variation')).toContainText('认识渠道=校园社团');
  await expect(page.locator('.case-variation').filter({ hasText: '[object Object]' })).toHaveCount(0);
  await expect(page.getByText('第 1/3 页')).toBeVisible();
  await page.getByRole('button', { name: '下一页' }).click();
  await expect(rows.first()).toContainText('case-021');
  await page.getByRole('button', { name: '全部', exact: true }).click();

  // ---- keyboard: native radio-group semantics on the platform picker ----
  const scenarioForm = page.locator('.scenario-create');
  const whatsappRadio = scenarioForm.getByRole('radio', { name: 'WhatsApp' });
  const wechatRadio = scenarioForm.getByRole('radio', { name: '微信' });
  await expect(scenarioForm.locator('input[type="radio"]:checked')).toHaveCount(1);
  await wechatRadio.focus();
  await expect(wechatRadio).toBeFocused();
  await page.keyboard.press('Space');
  await expect(wechatRadio).toBeChecked();
  await expect(whatsappRadio).not.toBeChecked();
  await whatsappRadio.focus();
  await page.keyboard.press('Space');
  await expect(whatsappRadio).toBeChecked();
  await expect(scenarioForm.locator('input[type="radio"]:checked')).toHaveCount(1);

  // ---- explicit AI generation: the real generation API + persisted jobs ----
  await page.getByRole('button', { name: 'AI 生成案例' }).click();
  await expect(page.getByText('内容已齐备').first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('50/50 个案例已提交').first()).toBeVisible({ timeout: 30_000 });
  // submitted cases link to the protected workspace scene view
  await page.getByRole('button', { name: '仅已提交' }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText('已提交');
  await expect(rows.first().getByRole('link', { name: '打开作品' })).toBeVisible();
  await page.getByRole('button', { name: '全部', exact: true }).click();

  // ---- deterministic export + real ZIP download ----
  await page.getByRole('button', { name: '导出文件' }).click();
  const downloadLink = page.getByRole('link', { name: /下载 ZIP/ }).first();
  await expect(downloadLink).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText('每个文件包是单独的下载；多个文件包共同覆盖项目内容。')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  const accessibility = await new AxeBuilder({ page }).include('.project-scenarios')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) }))).toEqual([]);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('scenario workflow is usable at 390px in English with the dark theme', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('imstage-theme', 'dark');
      localStorage.setItem('imstage-locale', 'en');
    } catch { /* ignore */ }
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${fixture.base}/?lang=en#/register`);
  await registerViaApi(page, 'Mobile EN');
  await page.reload();
  await page.goto(`${fixture.base}/?lang=en#/projects`);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  await page.getByLabel('Project name', { exact: true }).fill('Mobile project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mobile project', exact: true })).toBeVisible();

  await expect(page.getByLabel('Cases')).toHaveValue('50');
  await page.getByLabel('Scenario name', { exact: true }).fill('Meeting new friends');
  await page.locator('.scenario-create').getByLabel('Language', { exact: true }).selectOption('en');
  await page.getByLabel('Cases').fill('2');
  await page.getByRole('button', { name: 'Create scenario', exact: true }).click();
  await expect(page.getByText('0/2 cases submitted').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.case-variation').first()).toContainText('How they met=campus club');
  await expect(page.locator('.case-variation').filter({ hasText: '[object Object]' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Generate cases with AI' }).click();
  await expect(page.getByText('Content complete').first()).toBeVisible({ timeout: 90_000 });

  await page.getByRole('button', { name: 'Export files' }).click();
  const downloadLink = page.getByRole('link', { name: /Download ZIP/ }).first();
  await expect(downloadLink).toBeVisible({ timeout: 90_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  // No horizontal overflow at 390px; keyboard reaches the case filter.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const groupHeights = await page.locator('.scenario-action-group').evaluateAll((groups) => groups.map((group) => group.getBoundingClientRect().height));
  expect(groupHeights.every((height) => height < 280)).toBe(true);
  await page.getByRole('button', { name: 'Missing only' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('No cases match this filter.')).toBeVisible();

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('unconfigured AI is explained while caller content stays usable', async ({ page }) => {
  // The fixture configures a runtime, so the unconfigured path is asserted at
  // the API level in tests/project-scenario-generation.test.mjs; here we only
  // ensure the UI never runs generation without a click (no paid call on open).
  const errors = watchConsole(page);
  await page.goto(`${fixture.base}/?lang=zh#/register`);
  await registerViaApi(page, '无自动调用');
  await page.reload();
  await page.goto(`${fixture.base}/?lang=zh#/projects`);
  await page.getByLabel('项目名称', { exact: true }).fill('安静项目');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '安静项目', exact: true })).toBeVisible();
  await page.getByLabel('场景名称', { exact: true }).fill('静默场景');
  await page.getByLabel('案例数量').fill('4');
  await page.getByRole('button', { name: '创建场景', exact: true }).click();
  await expect(page.getByText('0/4 个案例已提交').first()).toBeVisible({ timeout: 20_000 });
  // No generation started by itself: nothing is queued and no cases submitted.
  await page.waitForTimeout(2_500);
  await expect(page.getByText('0/4 个案例已提交').first()).toBeVisible();
  await expect(page.getByText('生成中', { exact: true })).toHaveCount(0);
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('scenario selection stays scoped while stale loads arrive, and the watermark override persists', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  await page.goto(`${fixture.base}/?lang=zh#/register`);
  await registerViaApi(page, '范围验收');
  await page.reload();
  await page.goto(`${fixture.base}/?lang=zh#/projects`);
  await page.getByLabel('项目名称', { exact: true }).fill('范围项目');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await expect(page.getByRole('heading', { name: '范围项目', exact: true })).toBeVisible();

  // Scenario A (watermark OFF overrides the project default ON), scenario B.
  await page.getByLabel('场景名称', { exact: true }).fill('场景 A');
  await page.getByLabel('案例数量').fill('1');
  await page.locator('.scenario-create').getByLabel('为新作品添加水印（AI生成 / 虚构标识）', { exact: true }).uncheck();
  await page.getByRole('button', { name: '创建场景', exact: true }).click();
  await expect(page.getByRole('button', { name: /场景 A/ })).toBeVisible();
  await page.getByLabel('场景名称', { exact: true }).fill('场景 B');
  await page.getByLabel('案例数量').fill('2');
  await page.locator('.scenario-create').getByLabel('为新作品添加水印（AI生成 / 虚构标识）', { exact: true }).check();
  await page.getByRole('button', { name: '创建场景', exact: true }).click();
  await expect(page.getByRole('button', { name: /场景 B/ })).toBeVisible();

  const projectList = await (await page.request.get(`${fixture.base}/api/projects`)).json();
  const project = projectList.items.find((item: { name: string }) => item.name === '范围项目');
  const scenarioList = await (await page.request.get(`${fixture.base}/api/projects/${project.id}/scenarios`)).json();
  const scenarioA = scenarioList.items.find((item: { name: string }) => item.name === '场景 A');
  const scenarioPattern = new RegExp(`/api/projects/${project.id}/scenarios/${scenarioA.scenarioId}(?:/generation)?$`);
  // Capture the actual old response before holding it; delaying a fetch itself
  // would merely return current data and miss the stale-response regression.
  let release!: () => void;
  let heldReads = 0;
  let fulfilled = 0;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(scenarioPattern, async (route) => {
    const response = await route.fetch();
    heldReads += 1;
    await held;
    await route.fulfill({ response });
    fulfilled += 1;
  });
  await page.getByRole('button', { name: /场景 A/ }).click();
  await expect.poll(() => heldReads).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: /场景 B/ }).click();
  await expect(page.getByText('0/2 个案例已提交').first()).toBeVisible({ timeout: 20_000 });
  release();
  await expect.poll(() => fulfilled).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('0/2 个案例已提交').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /场景 B/ })).toHaveAttribute('aria-pressed', 'true');
  await page.unroute(scenarioPattern);

  // Generate scenario A's single case and verify the frozen watermark override
  // reached the REAL persisted scene (not just a checked DOM box).
  await page.getByRole('button', { name: /场景 A/ }).click();
  await page.getByRole('button', { name: 'AI 生成案例' }).click();
  await expect(page.getByText('内容已齐备').first()).toBeVisible({ timeout: 90_000 });
  const scenes = await (await page.request.get(`${fixture.base}/api/scenes`)).json();
  expect(scenes.items.length).toBe(1);
  const saved = await (await page.request.get(`${fixture.base}/api/scenes/${scenes.items[0].id}`)).json();
  expect(saved.item.scene.watermarkEnabled).toBe(false);

  // A → B → A: the first A epoch has the SAME scenario ID as the last one.
  // Clear the real stored content between reads to distinguish old and new A.
  const generationCalls = fixture.provider.calls.length;
  const oldEpoch = new Promise<void>((resolve) => { release = resolve; });
  const readsByUrl = new Map<string, number>();
  heldReads = 0;
  fulfilled = 0;
  await page.route(scenarioPattern, async (route) => {
    const url = route.request().url();
    const count = readsByUrl.get(url) ?? 0;
    readsByUrl.set(url, count + 1);
    if (count > 0) { await route.continue(); return; }
    const response = await route.fetch();
    heldReads += 1;
    await oldEpoch;
    await route.fulfill({ response });
    fulfilled += 1;
  });
  await page.getByRole('button', { name: /场景 B/ }).click();
  await expect(page.locator('.case-card')).toHaveCount(2);
  await page.getByRole('button', { name: /场景 A/ }).click();
  await expect.poll(() => heldReads).toBeGreaterThanOrEqual(2);
  const update = await page.request.put(`${fixture.base}/api/scenes/${scenes.items[0].id}`, {
    headers: mutationHeaders(fixture.base),
    data: { scene: { ...saved.item.scene, messages: [] }, revision: saved.item.revision },
  });
  expect(update.ok()).toBe(true);
  await page.getByRole('button', { name: /场景 B/ }).click();
  await expect(page.locator('.case-card')).toHaveCount(2);
  await page.getByRole('button', { name: /场景 A/ }).click();
  await expect(page.locator('.case-card')).toHaveCount(1);
  await expect(page.locator('.case-card.is-submitted')).toHaveCount(0);
  release();
  await expect.poll(() => fulfilled).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.case-card.is-submitted')).toHaveCount(0);
  expect(fixture.provider.calls.length).toBe(generationCalls);
  await page.unroute(scenarioPattern);
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

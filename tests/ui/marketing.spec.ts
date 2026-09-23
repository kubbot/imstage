import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

const draftKey = 'imstage.studio.draft.v1';
// The published site follows navigator.language on a first visit. The default
// suite runs as a Chinese browser; English cases opt in with ?lang=en or their
// own test.use({ locale }).
test.use({ locale: 'zh-CN' });
const hero = (page: Page) => page.locator('.journey-device');
const heroScene = (page: Page) => page.locator('.journey-device .scene-view');
const heroCta = (page: Page) => page.getByTestId('hero-start');
const storyExport = (page: Page) => page.getByTestId('hero-export');

/** The story export is ready only once the bounded assets are local. */
async function readyToExport(page: Page) {
  await expect(hero(page).locator('.scene-image img')).toBeVisible({ timeout: 15000 });
  await expect(storyExport(page)).toBeEnabled();
}

/** Reveal every scroll-reveal section before checking colours so axe never
 * measures text mid-transition. Content is otherwise visible by default. */
async function revealAll(page: Page) {
  const sections = page.locator('.mark-section');
  const count = await sections.count();
  for (let index = 0; index < count; index += 1) {
    await sections.nth(index).scrollIntoViewIfNeeded();
    await page.waitForTimeout(120);
  }
  await page.locator('.mark-cta').scrollIntoViewIfNeeded();
  await expect
    .poll(() => sections.evaluateAll((nodes) => nodes.filter((node) => Number(getComputedStyle(node).opacity) < 1).length))
    .toBe(0);
}

test.describe('landing default (zh-CN browser)', () => {
  test('the hero promises one prompt, replays one authored story and exports the real frame', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#mark-hero-title')).toHaveCount(1);
    await expect(page.locator('#mark-hero-title')).toContainText('让对话，');
    await expect(page.locator('#mark-hero-title em')).toHaveText('有画面。');
    await expect(page.locator('.journey-promise')).toHaveText('写下情节。AI 生成对话、人物与照片。');
    await expect(heroScene(page)).toHaveAttribute('data-platform', 'wechat');
    // The instruction composer is the authored example, and it is editable.
    await expect(page.getByLabel('你的指令', { exact: true })).toHaveValue(/武康路/);
    await expect(page.locator('.journey-caption').getByText('虚构人物 · AI 合成示例', { exact: false })).toBeVisible();
    await expect(heroCta(page)).toBeVisible();
    await readyToExport(page);
    await expect(hero(page).locator('.scene-row')).toHaveCount(5);
    await expect(hero(page).locator('.scene-image img')).toHaveAttribute('src', /^data:image\/webp;base64,/);
  });

  test('the hero export writes a real PNG at the iPhone 17 Pro resolution', async ({ page }, testInfo) => {
    await page.goto('/');
    await readyToExport(page);
    const download = page.waitForEvent('download');
    await storyExport(page).click();
    const file = testInfo.outputPath('landing-story.png');
    await (await download).saveAs(file);
    const png = await readFile(file);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1206);
    expect(png.readUInt32BE(20)).toBe(2622);
    expect(png.length).toBeGreaterThan(20000);
    // The exported preview in the contrast section is the same real renderer.
    await page.locator('#mark-export').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-export-preview="ready"]')).toBeVisible();
    const preview = page.locator('.mark-export-card-body img');
    await expect(preview).toHaveAttribute('src', /^data:image\/png;base64,/);
  });

  test('editing one line in the contrast section also reaches the exported frame', async ({ page }) => {
    await page.goto('/');
    await page.locator('#mark-export').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-export-preview="ready"]')).toBeVisible();
    const field = page.getByLabel('我说的话', { exact: true });
    await field.fill('这句话会进入导出。');
    await expect(page.locator('.mark-export-card-body img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    const download = page.waitForEvent('download');
    await page.locator('#mark-export').getByRole('button', { name: '导出 PNG', exact: true }).click();
    await (await download).createReadStream();
  });

  test('scenario selector swaps the editable scene and hands it to the studio, leaving the story intact', async ({ page }) => {
    await page.goto('/#/studio');
    await page.getByRole('textbox', { name: '文本内容', exact: true }).fill('不能丢失的草稿');
    const original = await page.evaluate((key) => localStorage.getItem(key), draftKey);
    await page.goto('/?lang=zh');
    await page.locator('.mark-scenarios').scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: /周末看海/ }).click();
    await expect(page.getByLabel('我说的话', { exact: true })).toHaveValue('那就周六见，我带上相机。');
    await expect(page.locator('.mark-scenario.is-active')).toContainText('周末看海');
    // The hero keeps playing the authored Wukang story.
    await expect(hero(page)).toContainText('苏晚');
    await expect(page.locator('.journey-caption')).toContainText('虚构人物 · AI 合成示例');
    // The landing demo never writes the studio draft.
    expect(await page.evaluate((key) => localStorage.getItem(key), draftKey)).toBe(original);
    const useLink = page.locator('.mark-scenario.is-active .mark-scenario-use');
    await expect(useLink).toHaveAttribute('href', /new=1.*scenario=weekend|scenario=weekend.*new=1/);
    await useLink.click();
    await expect(page).toHaveURL(/#\/create/);
    await expect(page.locator('.agent-phone .scene-view')).toHaveAttribute('data-platform', 'wechat');
    await expect(page.locator('.agent-phone')).toContainText('好，我订了早班船。');
  });
});

test.describe('language', () => {
  test('an explicit ?lang=en switches platform, names, times and the whole marketing chrome', async ({ page }) => {
    await page.goto('/?lang=en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#mark-hero-title')).toContainText('Conversations,');
    await expect(page.locator('#mark-hero-title em')).toHaveText('with a scene.');
    await expect(page.getByRole('banner').getByRole('link', { name: /GitHub/ })).toBeVisible();
    await expect(heroScene(page)).toHaveAttribute('data-platform', 'whatsapp');
    await expect(hero(page)).toContainText('Where are you?');
    await expect(hero(page)).toContainText('Su Wan');
    await expect(page.getByRole('banner').getByRole('link', { name: /^Templates$/ })).toBeVisible();
    await expect(page.getByRole('contentinfo')).toContainText('A stage for every conversation.');
    await expect(page.getByLabel('Your instruction', { exact: true })).toHaveValue(/Wukang Road/);
    await expect(page).toHaveTitle(/One prompt. A story unfolds./);
    await readyToExport(page);
    // The English example must not leak any Chinese renderer fallback copy.
    expect(await hero(page).innerText()).not.toMatch(/[\u3400-\u9fff]/);
  });

  test('the saved preference is applied on the next visit and the toggle updates the URL', async ({ page }) => {
    await page.goto('/');
    await page.locator('.mark-toggle').getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page).toHaveURL(/lang=en/);
    await expect(heroScene(page)).toHaveAttribute('data-platform', 'whatsapp');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(heroScene(page)).toHaveAttribute('data-platform', 'whatsapp');
    await page.locator('.mark-toggle').getByRole('button', { name: '中文', exact: true }).click();
    await expect(heroScene(page)).toHaveAttribute('data-platform', 'wechat');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  });

  test('an explicit URL wins over a saved preference', async ({ page }) => {
    await page.goto('/?lang=zh');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.goto('/?lang=en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});

test.describe('english-first browser', () => {
  test.use({ locale: 'en-US' });

  test('navigator language selects English and WhatsApp on a first visit', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(heroScene(page)).toHaveAttribute('data-platform', 'whatsapp');
    await expect(page.getByLabel('Your instruction', { exact: true })).toBeVisible();
  });
});

test('the English landing starts a new WhatsApp session without overwriting an existing draft', async ({ page }) => {
  await page.goto('/#/create');
  await expect(page.getByRole('button', { name: '管理创作会话' })).toBeVisible();
  await page.getByLabel('描述想生成的聊天', { exact: true }).fill('不能被覆盖的会话');
  await expect(page.getByRole('button', { name: '管理创作会话' })).toContainText('已保存到本机');

  await page.goto('/?lang=en');
  await page.getByTestId('hero-start').click();
  await expect(page).toHaveURL(/#\/create/);
  await expect(page.locator('.agent-phone .scene-view')).toHaveAttribute('data-platform', 'whatsapp');

  await page.getByRole('button', { name: 'Manage sessions' }).click();
  await expect(page.getByRole('button', { name: 'Open session: 不能被覆盖的会话', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open session: 不能被覆盖的会话', exact: true }).click();
  await expect(page.getByLabel('Describe the chat to generate', { exact: true })).toHaveValue('不能被覆盖的会话');
});

test('avatar loading failure is visible, blocks export and recovers on retry', async ({ page }) => {
  await page.route('**/assets/people/**', (route) => route.fulfill({ status: 500, body: 'nope' }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '重新加载头像', exact: true })).toBeVisible();
  await expect(storyExport(page)).toBeDisabled();
  await page.unroute('**/assets/people/**');
  await page.getByRole('button', { name: '重新加载头像', exact: true }).click();
  await expect(page.getByRole('button', { name: '重新加载头像', exact: true })).toHaveCount(0);
  await readyToExport(page);
});

test('mobile keeps a useful story, the CTA and touch-sized controls without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  // The compact CTA row is in the first viewport, before the phone.
  await expect(heroCta(page)).toBeInViewport();
  await expect(hero(page)).toBeVisible();
  // The authored scene photo starts in the first viewport, not just its frame:
  // the primary prompt and action still sit above it.
  await readyToExport(page);
  const photo = await page.locator('.journey-device .scene-image').boundingBox();
  expect(photo).not.toBeNull();
  expect(photo!.y).toBeLessThan(844);
  expect(844 - photo!.y).toBeGreaterThanOrEqual(80);
  await hero(page).scrollIntoViewIfNeeded();
  await expect(hero(page).locator('.scene-row').first()).toBeInViewport();
  for (const selector of ['.mark-btn', '.mark-toggle button', '.mark-story-controls button']) {
    const boxes = await page.locator(selector).evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).offsetParent !== null).map((node) => node.getBoundingClientRect().height));
    for (const height of boxes) expect(height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('keyboard navigation reaches the skip link, the instruction composer and the scenario selector', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.locator('.skip-link');
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  const composer = page.getByLabel('你的指令', { exact: true });
  await composer.focus();
  await composer.fill('我约了苏晚在武康路见面。');
  await expect(composer).toHaveValue('我约了苏晚在武康路见面。');

  const card = page.getByRole('button', { name: /产品讨论/ });
  await card.focus();
  await expect(card).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.mark-scenario.is-active')).toContainText('产品讨论');
  await expect(page.getByLabel('我说的话', { exact: true })).toHaveValue('好，明早十点这里见。');
});

test('reduced motion keeps every section visible, starts on the result and the FAQ still works', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const pending = await page.locator('.mark-section[data-reveal="pending"]').count();
  expect(pending).toBe(0);
  await expect(page.locator('.journey-device .scene-row')).toHaveCount(5);
  const details = page.locator('.mark-faq-list details').first();
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  await expect(details).toContainText('都是合成的虚构内容');
});

for (const theme of ['light', 'dark'] as const) {
  test(`automated WCAG A/AA checks pass on the landing in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/');
    await expect(page.locator('.journey-device .scene-view')).toBeVisible();
    await revealAll(page);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(result.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }))).toEqual([]);
  });

  test(`the English landing has no console errors in ${theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/?lang=en');
    await page.locator('.mark-scenarios').scrollIntoViewIfNeeded();
    await page.locator('#mark-export').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-export-preview="ready"]')).toBeVisible();
    await expect(page.locator('.mark-cta')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test.describe('refinements', () => {
  test('the header CTA opens a locale-correct new session and preserves the existing draft', async ({ page }) => {
    await page.goto('/#/create');
    await expect(page.getByRole('button', { name: '管理创作会话' })).toBeVisible();
    await page.getByLabel('描述想生成的聊天', { exact: true }).fill('EXISTING DRAFT');
    await expect(page.getByRole('button', { name: '管理创作会话' })).toContainText('已保存到本机');

    await page.goto('/?lang=en');
    await expect(page.locator('.journey-device .scene-view')).toHaveAttribute('data-platform', 'whatsapp');
    await page.getByRole('banner').getByRole('link', { name: 'Start creating' }).click();
    await expect(page).toHaveURL(/#\/create/);
    await expect(page.locator('.agent-phone .scene-view')).toHaveAttribute('data-platform', 'whatsapp');

    // The in-app "New session" button also follows the current language.
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.locator('.agent-phone .scene-view')).toHaveAttribute('data-platform', 'whatsapp');
    await expect(page.locator('.agent-phone .scene-row')).toHaveCount(0);

    // The pre-existing Chinese draft is still there and opens unchanged.
    await page.getByRole('button', { name: 'Manage sessions' }).click();
    await expect(page.getByRole('button', { name: 'Open session: EXISTING DRAFT', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open session: EXISTING DRAFT', exact: true }).click();
    await expect(page.getByLabel('Describe the chat to generate', { exact: true })).toHaveValue('EXISTING DRAFT');

    // Ordinary navigation resumes the active session instead of creating one.
    const pointer = await page.evaluate(() => sessionStorage.getItem('imstage.sessions.active.guest.draft:'));
    await page.goto('/#/create');
    await expect(page.getByLabel('Describe the chat to generate', { exact: true })).toHaveValue('EXISTING DRAFT');
    expect(await page.evaluate(() => sessionStorage.getItem('imstage.sessions.active.guest.draft:'))).toBe(pointer);
  });

  test('a render that is already running cannot publish a stale preview after an edit or a language switch', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      const original = document.fonts.ready;
      let gate!: Promise<unknown> | null;
      Object.defineProperty(document.fonts, 'ready', {
        configurable: true,
        get() { return gate ?? original; },
      });
      (window as unknown as { __gateFonts: () => void }).__gateFonts = () => {
        gate = new Promise((resolve) => {
          (window as unknown as { __releaseFonts: () => void }).__releaseFonts = () => { gate = null; resolve(null); };
        });
      };
    });
    await page.goto('/');
    await page.locator('#mark-export').scrollIntoViewIfNeeded();
    await page.evaluate(() => (window as unknown as { __gateFonts: () => void }).__gateFonts());
    await expect(page.locator('[data-export-preview="loading"]')).toBeVisible();

    // Edit while the render is held, then release: the stale frame must be dropped.
    await page.getByLabel('我说的话', { exact: true }).fill('延迟编辑后的这句话。');
    await page.waitForTimeout(600);
    await page.evaluate(() => (window as unknown as { __releaseFonts: () => void }).__releaseFonts());
    await expect(page.locator('[data-export-preview="ready"]')).toBeVisible({ timeout: 15000 });
    const editedPreview = await page.locator('.mark-export-card-body img').getAttribute('src');
    const editedDownload = page.waitForEvent('download');
    await page.locator('#mark-export').getByRole('button', { name: '导出 PNG', exact: true }).click();
    const editedFile = testInfo.outputPath('delayed-edit.png');
    await (await editedDownload).saveAs(editedFile);
    const editedBytes = await readFile(editedFile);
    expect(editedPreview).toBe(`data:image/png;base64,${editedBytes.toString('base64')}`);

    // Hold a new render, switch language, release: only the English frame commits.
    await page.evaluate(() => (window as unknown as { __gateFonts: () => void }).__gateFonts());
    await page.locator('.mark-toggle').getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.locator('.journey-device .scene-view')).toHaveAttribute('data-platform', 'whatsapp');
    await page.waitForTimeout(600);
    await page.evaluate(() => (window as unknown as { __releaseFonts: () => void }).__releaseFonts());
    await expect(page.locator('[data-export-preview="ready"]')).toBeVisible({ timeout: 15000 });
    const englishPreview = await page.locator('.mark-export-card-body img').getAttribute('src');
    const englishDownload = page.waitForEvent('download');
    await page.locator('#mark-export').getByRole('button', { name: 'Export PNG', exact: true }).click();
    const englishFile = testInfo.outputPath('delayed-switch.png');
    await (await englishDownload).saveAs(englishFile);
    const englishBytes = await readFile(englishFile);
    expect(englishPreview).toBe(`data:image/png;base64,${englishBytes.toString('base64')}`);
    expect(englishPreview).not.toBe(editedPreview);
  });

  test('the export card names the resolution and device exactly once', async ({ page }) => {
    await page.goto('/');
    await page.locator('#mark-export').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-export-preview="ready"]')).toBeVisible();
    const meta = page.locator('.mark-export-meta-line');
    await expect(meta).toHaveText('PNG · 1206 × 2622 · iPhone 17 Pro');
    expect(await meta.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap');
    expect(await meta.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.locator('.mark-export-meta').count()).toBe(0);
    const text = await meta.innerText();
    expect(text.match(/1206 × 2622/g)).toHaveLength(1);
    expect(text.match(/iPhone 17 Pro/g)).toHaveLength(1);
  });

  test('the story stage and its controls fit a 1440 × 900 first viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await readyToExport(page);
    const frame = await page.locator('.journey-device .mark-phone-frame').boundingBox();
    expect(frame).not.toBeNull();
    expect(frame!.width).toBeGreaterThanOrEqual(280);
    expect(frame!.width).toBeLessThanOrEqual(340);
    expect(Math.round(frame!.y + frame!.height)).toBeLessThanOrEqual(900);
    await expect(page.getByTestId('hero-export')).toBeInViewport();
    await expect(page.locator('.journey-device .scene-row').nth(4)).toBeInViewport();
    await expect(heroCta(page)).toBeInViewport();
  });

  test('the scenario previews and the handoff carry locale-correct local assets', async ({ page }) => {
    await page.goto('/');
    // Scenario thumbnails use the same loaded data avatars, never static paths.
    const thumbs = page.locator('.mark-crop img.scene-avatar');
    await expect(thumbs.first()).toBeVisible();
    expect(await thumbs.evaluateAll((nodes) => nodes.every((node) => (node as HTMLImageElement).src.startsWith('data:image/webp;base64,')))).toBe(true);
    expect(await page.locator('.mark-crop img').evaluateAll((nodes) => nodes.some((node) => (node as HTMLImageElement).src.includes('/assets/')))).toBe(false);

    // Handoff carries validated data URIs; no raw static path may appear.
    await page.goto('/');
    await page.locator('.mark-scenarios').scrollIntoViewIfNeeded();
    await page.locator('.mark-scenario.is-active .mark-scenario-use').click();
    await expect(page).toHaveURL(/#\/create/);
    await expect(page.locator('.agent-phone .scene-avatar').first()).toHaveAttribute('src', /^data:image\/webp;base64,/);
    await expect(page.locator('.agent-phone .scene-image img')).toHaveAttribute('src', /^data:image\/webp;base64,/);
    expect(await page.locator('.agent-phone img').evaluateAll((nodes) => nodes.some((node) => (node as HTMLImageElement).src.includes('/assets/')))).toBe(false);
  });

  test('the scenes and docs pages follow the language instead of falling back to Chinese', async ({ page }) => {
    await page.goto('/?lang=en#/templates');
    await expect(page.locator('.templates-page h1')).toHaveText('One opening. Endless versions of yours.');
    await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
    expect(await page.locator('.templates-page').innerText()).not.toMatch(/[\u3400-\u9fff]/);
    await expect(page.locator('.template-card .scene-view').first()).toHaveAttribute('data-platform', 'whatsapp');

    await page.goto('/?lang=zh#/templates');
    await expect(page.getByRole('button', { name: '全部', exact: true })).toBeVisible();
    await expect(page.locator('.template-card .scene-view').first()).toHaveAttribute('data-platform', 'wechat');

    await page.goto('/?lang=en#/docs');
    await expect(page.getByRole('button', { name: 'Data & privacy', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Data & privacy', exact: true }).click();
    const privacy = page.locator('.docs-content');
    await expect(privacy).toContainText('hosted service');
    await expect(privacy).toContainText('instance token');
    await expect(privacy).toContainText('not implemented');
    // The old, now-false claim that there is no account/upload must be gone.
    expect(await privacy.innerText()).not.toContain('没有账号');
    expect(await privacy.innerText()).not.toMatch(/[\u3400-\u9fff]/);
  });
});

test('download keeps its clicked scene when the header language changes during capture', async ({page}, testInfo) => {
  await page.goto('/?lang=zh');
  await readyToExport(page);
  const first = page.waitForEvent('download');
  await storyExport(page).click();
  const baseline = testInfo.outputPath('snapshot-baseline.png');
  await (await first).saveAs(baseline);
  await expect(storyExport(page)).toBeEnabled();
  await page.evaluate(() => {
    const ready = document.fonts.ready;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release=resolve;});
    Object.defineProperty(document.fonts, 'ready', {configurable:true,get:()=>gate});
    (window as any).__releaseCapture=()=>{Object.defineProperty(document.fonts,'ready',{configurable:true,get:()=>ready});release();};
  });
  const pending = page.waitForEvent('download');
  await storyExport(page).click();
  await expect(page.getByRole('button', { name: '正在导出 PNG…', exact: true }).first()).toBeDisabled();
  await page.locator('.mark-toggle').getByRole('button',{name:'EN',exact:true}).click();
  await expect(heroScene(page)).toHaveAttribute('data-platform','whatsapp');
  await page.evaluate(()=>(window as any).__releaseCapture());
  const download=await pending;
  expect(download.suggestedFilename()).toContain('wechat');
  const result=testInfo.outputPath('snapshot-after-language-switch.png');await download.saveAs(result);
  expect(await readFile(result)).toEqual(await readFile(baseline));
  await page.locator('#mark-export').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-export-preview="ready"]')).toBeVisible({ timeout: 15000 });
  const current=page.waitForEvent('download');await page.locator('#mark-export').getByRole('button',{name:'Export PNG',exact:true}).click();
  const currentFile=testInfo.outputPath('current-language.png');await(await current).saveAs(currentFile);
  expect(await readFile(currentFile)).not.toEqual(await readFile(result));
  await expect(page.locator('.mark-export-card-body img')).toHaveAttribute('src',`data:image/png;base64,${(await readFile(currentFile)).toString('base64')}`);
});

import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// The published site follows navigator.language on a first visit.
test.use({ locale: 'zh-CN' });

const hero = (page: Page) => page.locator('.mark-hero-stage');
const phone = (page: Page) => page.locator('.mark-story-phone');
const rows = (page: Page) => page.locator('.mark-hero-stage .scene-row');
const photo = (page: Page) => page.locator('.mark-hero-stage .scene-image img');
const cta = (page: Page) => page.locator('.mark-hero-actions').getByRole('link', { name: '用 AI 创作' });
const storyExport = (page: Page) => page.getByRole('button', { name: '导出这张画面', exact: true });
const heroStatus = (page: Page) => page.locator('.mark-hero-actions .mark-status');

async function storyStatus(page: Page) {
  return phone(page).getAttribute('data-story-status');
}

async function storyDone(page: Page) {
  await expect(phone(page)).toHaveAttribute('data-story-status', 'done', { timeout: 20000 });
}

async function storyPlaying(page: Page) {
  await expect(phone(page)).toHaveAttribute('data-story-status', 'playing', { timeout: 10000 });
}

/** Wait until the locally loaded photo is on screen, without measuring timers. */
async function photoVisible(page: Page) {
  await storyDone(page);
  await expect(photo(page)).toBeVisible();
  return (await photo(page).getAttribute('src')) ?? '';
}

test.describe('story playback', () => {
  test('one autoplay ends on a complete, labelled AI-made result', async ({ page }) => {
    await page.goto('/?lang=zh');
    await expect(hero(page)).toBeVisible();
    // The replay is explicitly an authored example, never a live model call.
    await expect(hero(page).getByText('AI 合成示例 · 可重播', { exact: false })).toBeVisible();
    await expect(hero(page).locator('.mark-platform')).toHaveText('微信 · 中文');
    const stageText = await hero(page).innerText();
    expect(stageText).not.toMatch(/\d+\s?%/);
    expect(stageText).not.toContain('正在调用');

    await storyDone(page);
    // The complete result is visible: five messages and the actual photo.
    await expect(rows(page)).toHaveCount(5);
    await expect(photo(page)).toBeVisible();
    expect(await photo(page).getAttribute('src')).toMatch(/^data:image\/webp;base64,/);
    await expect(rows(page).nth(4)).toContainText('看见你了。别动，我过来。');
    // No hidden final message: the conversation fits the phone viewport.
    const overflow = await hero(page).locator('.scene-messages').evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(overflow).toBeLessThanOrEqual(2);
    // Every authored process step finished.
    await expect(page.locator('.mark-process li')).toHaveCount(4);
    await expect(page.locator('.mark-process li').nth(3)).toHaveClass(/is-active/);
    await expect(storyExport(page)).toBeEnabled();
  });

  test('pause, resume, replay and show-result are explicit controls', async ({ page }) => {
    await page.goto('/?lang=zh');
    await storyPlaying(page);
    await expect(page.getByRole('button', { name: '查看完整结果', exact: true })).toBeEnabled();

    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(phone(page)).toHaveAttribute('data-story-status', 'paused');
    const pausedCount = await rows(page).count();
    await page.waitForTimeout(1200);
    expect(await rows(page).count()).toBe(pausedCount);

    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(phone(page)).toHaveAttribute('data-story-status', 'playing');

    await page.getByRole('button', { name: '查看完整结果', exact: true }).click();
    await expect(phone(page)).toHaveAttribute('data-story-status', 'done');
    await expect(rows(page)).toHaveCount(5);
    await expect(photo(page)).toBeVisible();
    // Show-result is a one-way skip; the pause control is inert at the end.
    await expect(page.getByRole('button', { name: '查看完整结果', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: '重播', exact: true }).click();
    await expect(phone(page)).toHaveAttribute('data-story-status', 'playing');
    await storyDone(page);
    await expect(rows(page)).toHaveCount(5);
  });

  test('a manually paused story never auto-resumes when the stage leaves and returns', async ({ page }) => {
    await page.goto('/?lang=zh');
    await storyPlaying(page);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await expect(phone(page)).toHaveAttribute('data-story-status', 'paused');

    await page.locator('.mark-cta').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    expect(await storyStatus(page)).toBe('paused');
    await page.locator('.mark-hero-stage').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    expect(await storyStatus(page)).toBe('paused');

    // An explicit resume is the only way back to playback.
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect(phone(page)).toHaveAttribute('data-story-status', 'playing');
  });

  test('an off-screen playing story pauses and resumes when it returns', async ({ page }) => {
    await page.goto('/?lang=zh');
    await storyPlaying(page);
    await page.locator('.mark-cta').scrollIntoViewIfNeeded();
    await expect(phone(page)).toHaveAttribute('data-story-status', 'paused', { timeout: 5000 });
    await page.locator('.mark-hero-stage').scrollIntoViewIfNeeded();
    await expect(phone(page)).toHaveAttribute('data-story-status', 'playing', { timeout: 5000 });
    await storyDone(page);
  });

  test('a hidden document pauses and never resumes while still off-screen', async ({ page }) => {
    await page.goto('/?lang=zh');
    await storyPlaying(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(phone(page)).toHaveAttribute('data-story-status', 'paused');
    // Off-screen and back while the document is still hidden: still no resume.
    await page.locator('.mark-cta').scrollIntoViewIfNeeded();
    await page.locator('.mark-hero-stage').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    expect(await storyStatus(page)).toBe('paused');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(phone(page)).toHaveAttribute('data-story-status', 'playing', { timeout: 5000 });
    await storyDone(page);
  });

  test('a language switch during playback restarts in the other language with the same photo', async ({ page }) => {
    await page.goto('/?lang=zh');
    await storyPlaying(page);

    // Switch mid-playback; the story restarts on the WhatsApp template.
    await page.locator('.mark-toggle').getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.locator('.mark-hero-stage .scene-view')).toHaveAttribute('data-platform', 'whatsapp');
    await storyDone(page);
    await expect(rows(page)).toHaveCount(5);
    await expect(rows(page).nth(0)).toContainText('Where are you?');
    await expect(rows(page).nth(4)).toContainText("I see you. Stay there, I'm coming over.");
    expect(await hero(page).innerText()).not.toMatch(/[\u3400-\u9fff]/);
    const enPhoto = await photo(page).getAttribute('src');
    expect(enPhoto).toMatch(/^data:image\/webp;base64,/);

    // The same fictional woman is represented by the same photo in Chinese.
    await page.locator('.mark-toggle').getByRole('button', { name: '中文', exact: true }).click();
    await storyDone(page);
    expect(await photo(page).getAttribute('src')).toBe(enPhoto);
  });

  test('reduced motion starts on the complete static result', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?lang=zh');
    await expect(phone(page)).toHaveAttribute('data-story-status', 'done', { timeout: 1500 });
    await expect(rows(page)).toHaveCount(5);
    await expect(photo(page)).toBeVisible();
    const overflow = await hero(page).locator('.scene-messages').evaluate((node) => node.scrollHeight - node.clientHeight);
    expect(overflow).toBeLessThanOrEqual(2);
  });
});

test.describe('story assets and export', () => {
  test('the photo preparation state is localized and never the shared placeholder', async ({ page }) => {
    // Hold the bounded photo read open so the preparing beat is observable.
    await page.route('**/assets/stories/wukang-evening.webp', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await route.continue();
    });
    await page.goto('/?lang=en');
    await expect(page.locator('.mark-preparing')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.mark-preparing')).toContainText('Creating the photo');
    // The shared renderer's generic missing-image placeholder never appears.
    await expect(page.locator('.mark-hero-stage .scene-image')).toHaveCount(0);
    await expect(page.locator('.mark-hero-stage .scene-image-missing')).toHaveCount(0);
    await expect(rows(page).nth(0)).toContainText('Where are you?');
    await expect(photo(page)).toBeVisible({ timeout: 15000 });
  });

  test('a failed story photo is visible, blocks export and recovers on retry', async ({ page }) => {
    await page.route('**/assets/stories/wukang-evening.webp', (route) => route.fulfill({ status: 500, body: 'nope' }));
    await page.goto('/?lang=zh');
    await expect(page.getByRole('alert').filter({ hasText: '示例照片加载失败' })).toBeVisible({ timeout: 10000 });
    await expect(storyExport(page)).toBeDisabled();
    await storyDone(page);
    await expect(photo(page)).toHaveCount(0);

    await page.unroute('**/assets/stories/wukang-evening.webp');
    await page.getByRole('button', { name: '重新加载照片', exact: true }).click();
    await expect(photo(page)).toBeVisible({ timeout: 10000 });
    await expect(storyExport(page)).toBeEnabled();
  });

  test('the exported frame is a real PNG that carries the photo and every message', async ({ page }, testInfo) => {
    await page.goto('/?lang=zh');
    await photoVisible(page);
    await expect(storyExport(page)).toBeEnabled();

    // The off-screen export node — the exact DOM that is rasterised — carries
    // the same photo data URI as the visible message, plus the complete story.
    const exportFrame = page.locator('.mark-export-host').last();
    await expect(exportFrame.locator('.scene-row')).toHaveCount(5);
    const exportPhoto = await exportFrame.locator('.scene-image img').getAttribute('src');
    expect(exportPhoto).toMatch(/^data:image\/webp;base64,/);
    expect(exportPhoto).toBe(await photo(page).getAttribute('src'));
    // No decorative UI leaks into the downloaded frame.
    expect(await exportFrame.locator('.mark-typing').count()).toBe(0);

    const download = page.waitForEvent('download');
    await storyExport(page).click();
    const file = testInfo.outputPath('wukang-story.png');
    await (await download).saveAs(file);
    const png = await readFile(file);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1206);
    expect(png.readUInt32BE(20)).toBe(2622);
    expect(png.length).toBeGreaterThan(20000);
    await expect(page.getByRole('status').filter({ hasText: 'PNG 已导出' })).toBeVisible();
  });

  test('the larger photo view closes with Escape and restores focus', async ({ page }) => {
    await page.goto('/?lang=zh');
    await photoVisible(page);
    const trigger = page.getByRole('button', { name: '放大照片', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('img')).toHaveAttribute('src', /^data:image\/webp;base64,/);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
});

test.describe('handoff to the real Agent', () => {
  test('Create with AI preloads the scene and typed instruction without generating', async ({ page }) => {
    // An existing draft must survive the new-session handoff.
    await page.goto('/#/create');
    await expect(page.getByRole('button', { name: '管理创作会话' })).toBeVisible();
    const instruction = page.getByLabel('描述想生成的聊天', { exact: true });
    await instruction.fill('上一个会话不能丢');
    await expect(page.getByRole('button', { name: '管理创作会话' })).toContainText('已保存到本机');

    const runs: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/agent/run')) runs.push(request.url());
    });

    await page.goto('/?lang=zh');
    await photoVisible(page);
    const composer = page.getByLabel('你的指令', { exact: true });
    await expect(composer).toHaveValue(/武康路/);
    await composer.fill('我约了苏晚在武康路见面，她请路人拍了一张照片。');
    await cta(page).click();

    await expect(page).toHaveURL(/#\/create/);
    await expect(page).not.toHaveURL(/new=1/);
    await expect(page.locator('.agent-phone .scene-view')).toHaveAttribute('data-platform', 'wechat');
    await expect(page.locator('.agent-phone .scene-row')).toHaveCount(5);
    await expect(page.locator('.agent-phone .scene-image img')).toHaveAttribute('src', /^data:image\/webp;base64,/);
    await expect(instruction).toHaveValue('我约了苏晚在武康路见面，她请路人拍了一张照片。');
    // Prefilled, not sent: no provider call, no assistant turn.
    expect(runs).toEqual([]);
    await expect(page.getByRole('button', { name: '停止生成' })).toHaveCount(0);

    // The previous draft is still there and unchanged.
    await page.getByRole('button', { name: '管理创作会话' }).click();
    await page.getByRole('button', { name: '打开会话：上一个会话不能丢', exact: true }).click();
    await expect(instruction).toHaveValue('上一个会话不能丢');
  });

  test('an edit in the export section reaches that section handoff scene', async ({ page }) => {
    await page.goto('/?lang=zh');
    await photoVisible(page);
    await page.locator('#mark-export').scrollIntoViewIfNeeded();
    await page.getByLabel('我说的话', { exact: true }).fill('这段编辑要带到创作页。');
    await page.locator('.mark-scenarios').scrollIntoViewIfNeeded();
    await page.locator('.mark-scenario.is-active .mark-scenario-use').click();
    await expect(page).toHaveURL(/#\/create/);
    await expect(page.locator('.agent-phone')).toContainText('这段编辑要带到创作页。');
  });

  test('a failed photo blocks the handoff instead of dropping the scene', async ({ page }) => {
    await page.route('**/assets/stories/wukang-evening.webp', (route) => route.fulfill({ status: 500, body: 'nope' }));
    await page.goto('/?lang=en');
    await expect(page.getByRole('button', { name: 'Reload photo', exact: true })).toBeVisible({ timeout: 10000 });
    await page.getByLabel('Your instruction', { exact: true }).fill('keep my instruction');
    await page.locator('.mark-hero-actions').getByRole('link', { name: 'Create with AI' }).click();
    await expect(heroStatus(page)).toContainText('still preparing');
    await expect(page).not.toHaveURL(/#\/create/);
    await expect(page.getByLabel('Your instruction', { exact: true })).toHaveValue('keep my instruction');
  });

  test('no navigation happens while the payload is still loading, and the prompt is kept', async ({ page }) => {
    await page.route('**/assets/stories/wukang-evening.webp', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 8000));
      await route.continue();
    });
    await page.goto('/?lang=zh');
    const composer = page.getByLabel('你的指令', { exact: true });
    await composer.fill('自定义指令不能丢');
    await cta(page).click();
    await expect(heroStatus(page)).toContainText('场景还在准备');
    await expect(page).not.toHaveURL(/#\/create/);
    await expect(composer).toHaveValue('自定义指令不能丢');

    // The Wukang scenario card applies the same no-silent-loss rule.
    await page.locator('.mark-scenario.is-active .mark-scenario-use').click();
    await expect(heroStatus(page)).toContainText('场景还在准备');
    await expect(page).not.toHaveURL(/#\/create/);
  });

  test('unusable session storage is reported and the prompt is kept', async ({ page }) => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (String(key).startsWith('imstage.marketing.handoff.')) throw new DOMException('QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await page.goto('/?lang=zh');
    await photoVisible(page);
    const composer = page.getByLabel('你的指令', { exact: true });
    await composer.fill('存储失败也要保留');
    await cta(page).click();
    await expect(heroStatus(page)).toContainText('浏览器无法暂存');
    await expect(page).not.toHaveURL(/#\/create/);
    await expect(composer).toHaveValue('存储失败也要保留');
  });
});

test.describe('layout', () => {
  test('desktop 1440 × 900 shows the final photo and message without scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/?lang=zh');
    await photoVisible(page);
    const frame = await page.locator('.mark-hero-stage .mark-phone-frame').boundingBox();
    expect(frame).not.toBeNull();
    expect(frame!.width).toBeGreaterThanOrEqual(280);
    expect(frame!.width).toBeLessThanOrEqual(340);
    await expect(photo(page)).toBeInViewport();
    await expect(rows(page).nth(4)).toBeInViewport();
    await expect(page.locator('.mark-story-controls')).toBeInViewport();
    await expect(cta(page)).toBeInViewport();
  });

  test('mobile 390 × 844 keeps the CTA and the story without overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?lang=zh');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    // The compact CTA row sits directly under the headline, before the phone.
    await expect(cta(page)).toBeInViewport();
    await expect(page.getByRole('button', { name: '导出这张画面', exact: true })).toBeInViewport();
    await expect(rows(page).first()).toBeInViewport({ timeout: 5000 });
    await storyDone(page);
    await expect(photo(page)).toBeVisible();
    // The instruction composer and playback controls stay reachable one scroll down.
    await page.locator('.mark-hero-composer').scrollIntoViewIfNeeded();
    await expect(page.getByLabel('你的指令', { exact: true })).toBeInViewport();
    await page.locator('.mark-story-controls').scrollIntoViewIfNeeded();
    await expect(page.locator('.mark-story-controls')).toBeInViewport();
    for (const selector of ['.mark-btn', '.mark-story-controls button', '.mark-hero-composer textarea']) {
      const heights = await page.locator(selector).evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).offsetParent !== null).map((node) => node.getBoundingClientRect().height));
      for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
});

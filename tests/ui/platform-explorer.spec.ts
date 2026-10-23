import { test, expect } from '@playwright/test';

/**
 * Public platform explorer (platform comparison) on the Templates page.
 *
 * The fixture pins one language; the shared scene is synthetic and its people,
 * message text and times must stay fixed while only the platform skin changes.
 */
test.use({ locale: 'zh-CN' });

const SCENE_LINES = ['下午三点，老地方？', '好，给你留了靠窗的位置。', '示意地点 · 街角咖啡', '那杯桂花拿铁，我来点。'];

test('all platforms are discoverable and switching changes only the skin of one shared scene', async ({ page }) => {
  await page.goto('/?lang=zh#/templates');
  const explorer = page.locator('.platform-explorer');
  await expect(page.getByRole('heading', { name: '同一段合成对话，对照各平台聊天风格。' })).toBeVisible();
  // The explorer sits before the existing story gallery and mounts one preview
  // behind exactly one selector control.
  const explorerBox = (await explorer.boundingBox())!;
  expect(explorerBox.y).toBeLessThan((await page.locator('.gallery-controls').boundingBox())!.y);
  const picker = page.getByRole('radiogroup', { name: '选择平台风格' });
  await expect(page.getByRole('radiogroup')).toHaveCount(1);
  await expect(picker.getByRole('radio')).toHaveCount(10);
  await expect(explorer.locator('.scene-view')).toHaveCount(1);

  const skin = explorer.locator('.scene-view');
  await expect(skin).toHaveAttribute('data-skin', 'imstage-generic');
  await expect(picker.getByRole('radio', { name: /IMStage 通用聊天/ })).toHaveAttribute('aria-checked', 'true');
  const header = await explorer.locator('.scene-header-name').innerText();

  await picker.getByRole('radio', { name: /WhatsApp/ }).click();
  await expect(skin).toHaveAttribute('data-skin', 'imstage-whatsapp');
  expect(await skin.getAttribute('data-layout'), 'the shared scene carries no custom layout override').toBeNull();

  // People, message text and time are identical across every switch.
  for (const [label, platform] of [[/IMStage 通用聊天/, 'imstage-generic'], [/WhatsApp/, 'imstage-whatsapp'], [/小红书/, 'imstage-xiaohongshu']] as const) {
    await picker.getByRole('radio', { name: label }).click();
    await expect(skin).toHaveAttribute('data-skin', platform);
    for (const line of SCENE_LINES) await expect(skin).toContainText(line);
    await expect(explorer.locator('.scene-status-time')).toHaveText('15:02');
    await expect(explorer.locator('.scene-header-name')).toHaveText(header);
  }

  // Content-kind labels come from explicit presentation capabilities: the
  // social-network DM styles (Instagram included) are labelled as synthetic
  // conversation/DM styles, never as posts or publishing.
  await expect(picker.getByRole('radio', { name: /Instagram/ })).toContainText('私信 / 对话风格');
  await expect(picker.getByRole('radio', { name: /WhatsApp/ })).toContainText('聊天风格');
  await picker.getByRole('radio', { name: /Instagram/ }).click();
  await expect(skin).toHaveAttribute('data-skin', 'imstage-instagram');
  await expect(page.locator('.platform-explorer-note')).toContainText('合成私信');
  await expect(page.locator('.platform-explorer-note')).toContainText('不是帖子');

  // Keyboard-native selection: arrows move the checked radio and the skin.
  await picker.getByRole('radio', { name: /小红书/ }).click();
  await picker.getByRole('radio', { name: /小红书/ }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(picker.getByRole('radio', { name: /iMessage/ })).toHaveAttribute('aria-checked', 'true');
  await expect(skin).toHaveAttribute('data-skin', 'imstage-imessage');
});

test('Continue with this style hands the exact scene and selected platform to the creator', async ({ page }) => {
  await page.goto('/?lang=zh#/templates');
  const picker = page.getByRole('radiogroup', { name: '选择平台风格' });
  await picker.getByRole('radio', { name: /即刻/ }).click();
  await expect(page.locator('.platform-explorer .scene-view')).toHaveAttribute('data-skin', 'imstage-jike');

  await page.getByRole('button', { name: '用这个风格继续创作' }).click();
  await expect(page).toHaveURL(/#\/create\?new=1/);
  await expect(page).toHaveURL(/handoff=/);
  const phone = page.locator('.agent-phone');
  await expect(phone.locator('.scene-view')).toHaveAttribute('data-skin', 'imstage-jike');
  for (const line of SCENE_LINES) await expect(phone).toContainText(line);
  await expect(phone.locator('.scene-status-time')).toHaveText('15:02');
  expect(await phone.locator('.scene-view').getAttribute('data-layout')).toBeNull();
});

test('mobile keeps a compact scrolling selector with the preview adjacent and usable switching', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?lang=zh#/templates');
  const explorer = page.locator('.platform-explorer');
  await expect(explorer).toBeVisible();
  const picker = page.locator('.platform-picker');
  const first = (await page.locator('.platform-option').first().boundingBox())!;
  const last = (await page.locator('.platform-option').last().boundingBox())!;
  // One compact row of options that scrolls inside itself...
  expect(Math.abs(last.y - first.y)).toBeLessThan(5);
  expect(await picker.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  for (const option of await page.locator('.platform-option').all()) {
    const box = (await option.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
  }
  // ...with the preview adjacent, so switching shows its result in view.
  const pickerBox = (await picker.boundingBox())!;
  const previewBox = (await page.locator('.platform-preview').boundingBox())!;
  expect(previewBox.y - (pickerBox.y + pickerBox.height)).toBeLessThan(60);
  expect(previewBox.y).toBeLessThan(600);
  await page.getByRole('radio', { name: /小红书/ }).click();
  await expect(explorer.locator('.scene-view')).toHaveAttribute('data-skin', 'imstage-xiaohongshu');
  await expect(page.locator('.platform-explorer-note')).toContainText('合成私信');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('a failed handoff draft keeps the page, the search input and the selection with actionable feedback', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window.sessionStorage, 'setItem', {
      configurable: true,
      value: () => { throw new Error('session storage blocked'); },
    });
  });
  await page.goto('/?lang=zh#/templates');
  await page.getByRole('textbox', { name: '搜索场景' }).fill('看海');
  await expect(page.locator('.template-card')).toHaveCount(1);
  const picker = page.getByRole('radiogroup', { name: '选择平台风格' });
  await picker.getByRole('radio', { name: /WhatsApp/ }).click();

  await page.getByRole('button', { name: '用这个风格继续创作' }).click();
  // Neutral, actionable feedback: no unsupported diagnosis about the cause.
  await expect(page.getByRole('alert')).toContainText('未能准备创作草稿');
  await expect(page.getByRole('alert')).toContainText('请重试');
  await expect(page).toHaveURL(/#\/templates/);
  await expect(page).not.toHaveURL(/#\/create/);
  await expect(page.getByRole('textbox', { name: '搜索场景' })).toHaveValue('看海');
  await expect(picker.getByRole('radio', { name: /WhatsApp/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.platform-explorer .scene-view')).toHaveAttribute('data-skin', 'imstage-whatsapp');
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not prepare the creation draft');
  await expect(page.getByRole('alert')).not.toContainText('未能准备');
});

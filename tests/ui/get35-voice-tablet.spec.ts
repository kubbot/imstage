import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';

/**
 * GET-35 — explicit voice transcripts + tablet `ipad-window` preset.
 *
 * Narrow UI coverage for the remaining PRIMARY IMStage producer gaps:
 * - the studio voice composer/edit UI exposes an ordinary labeled transcript
 *   field and renders it below the voice bubble (never invented content);
 * - an explicit TEXT→VOICE switch copies the authored wording once and undo
 *   restores the text message;
 * - the tablet preset is directly discoverable in the device dropdown and
 *   exports 2048×1536 (logical 1024×768 @2x) with the same messages/stable ids,
 *   a derived one-thread chat list and a long-mode export that never clips the
 *   transcript.
 *
 * Deterministic/render-matrix assertions live in tests/get35-voice-tablet.test.mjs
 * and tests/mcp-render.test.mjs (already covered by focused CI runs).
 *
 * Repair coverage (parent P2 review): over-long submissions are rejected
 * visibly before any state change (no truncation, no state loss), and the
 * primary Agent element inspector shares the explicit conversion semantics
 * (TEXT→VOICE copy, VOICE→TEXT restore, voice→other drop in one gesture).
 */

test.use({ locale: 'zh-CN' });

const OWNER_PASSWORD = 'synthetic-get35-tests-2026';
const TRANSCRIPT = '周六可以！不过得早点出发，下午风大。\nSecond line — bring the camera;\n第三行要能安全换行不溢出。';

async function registerOwner(page: Page) {
  await page.goto('/#/create');
  const origin = new URL(page.url()).origin;
  const email = `get35-${crypto.randomUUID()}@example.test`;
  const register = await page.request.post('/api/auth/register', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { email, name: '创作者', password: OWNER_PASSWORD },
  });
  expect(register.ok()).toBeTruthy();
  const prefs = await page.request.put('/api/preferences', {
    headers: { Origin: origin, 'X-IMStage-Request': '1' },
    data: { revision: 1, onboardingStatus: 'completed' },
  });
  expect(prefs.ok()).toBeTruthy();
  await page.reload();
  return origin;
}

/** Deterministic generation mock: one voice message with an explicit transcript. */
async function generationWithVoice(page: Page, { title = '周末去看海', group = false, transcript = TRANSCRIPT } = {}) {
  await page.route('**/api/agent/run', async (route) => {
    const { scene } = route.request().postDataJSON() as { scene: { selfId: string; participants: { id: string }[] } };
    const participants = scene.participants.map((person) => ({ ...person, name: person.id === scene.selfId ? '林小满' : '阿远' }));
    if (group) participants.push({ id: 'p-get35-third', name: '小周' });
    const next = {
      ...scene,
      title,
      headerText: undefined,
      participants,
      messages: [
        { id: 'm-1', participantId: scene.selfId, type: 'text', text: '听这段语音', time: '09:38' },
        { id: 'm-2', participantId: scene.participants[1].id, type: 'voice', text: '', time: '09:39', voiceTranscript: transcript },
        { id: 'm-3', participantId: scene.selfId, type: 'text', text: '收到，周六见。', time: '09:40' },
      ],
    };
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body: [{ type: 'scene', scene: next }, { type: 'assistant', text: '已生成' }, { type: 'done' }].map((event) => JSON.stringify(event)).join('\n') + '\n',
    });
  });
  await page.getByLabel('描述想生成的聊天', { exact: true }).fill('生成一段带语音文字稿的对话');
  await page.getByRole('button', { name: '开始生成', exact: true }).click();
  await expect(page.locator('.agent-render-footer')).toContainText('画面已更新，可以继续说想改哪里。');
}

/* ------------------------------------------------------------------ */
/* Studio voice creation / edit UI                                      */
/* ------------------------------------------------------------------ */

test('voice composer words become an explicit synthetic transcript below the voice bubble', async ({ page }) => {
  await page.goto('/#/studio');
  const composer = page.locator('section').filter({ has: page.getByRole('heading', { name: '添加一条台词', exact: true }) });
  await composer.getByRole('combobox', { name: '类型', exact: true }).selectOption('voice');
  await expect(composer.getByText('显式合成文字稿')).toBeVisible();
  await page.getByRole('textbox', { name: '添加一条台词', exact: true }).fill('周六码头见，记得带相机。');
  await composer.getByRole('button', { name: '添加这条台词' }).click();

  const transcript = page.locator('.studio-phone .scene-voice-transcript');
  await expect(transcript).toHaveCount(1);
  await expect(transcript).toHaveText('周六码头见，记得带相机。');
  await expect(page.locator('.studio-phone .scene-voice-wrap .scene-bubble')).toContainText('语音', { ignoreCase: false });

  // The ordinary labeled edit field is exposed below the voice bubble fields.
  const panel = page.locator('section').filter({ has: page.locator('h2').filter({ hasText: '选中消息' }) });
  await expect(panel.getByRole('textbox', { name: '语音文字稿', exact: true })).toHaveValue('周六码头见，记得带相机。');
  await panel.getByRole('textbox', { name: '语音文字稿', exact: true }).fill('改好的文字稿');
  await expect(transcript).toHaveText('改好的文字稿');
});

test('explicit TEXT→VOICE switching copies the wording once and undo restores the text message', async ({ page }) => {
  await page.goto('/#/studio');
  await page.getByRole('textbox', { name: '文本内容', exact: true }).fill('周六码头见。');
  const panel = page.locator('section').filter({ has: page.locator('h2').filter({ hasText: '选中消息' }) });
  await panel.getByRole('combobox', { name: '类型', exact: true }).selectOption('voice');

  await expect(panel.getByRole('textbox', { name: '语音文字稿', exact: true })).toHaveValue('周六码头见。');
  await expect(page.locator('.studio-phone .scene-voice-transcript')).toHaveText('周六码头见。');

  await page.getByRole('button', { name: '撤销' }).click();
  await expect(panel.getByRole('textbox', { name: '文本内容', exact: true })).toHaveValue('周六码头见。');
  await expect(page.locator('.studio-phone .scene-voice-transcript')).toHaveCount(0);
});

/* ------------------------------------------------------------------ */
/* Tablet preset in the producer                                        */
/* ------------------------------------------------------------------ */

test('ipad-window is discoverable and exports 2048×1536 with the transcript and a one-thread chat list', async ({ page }) => {
  await registerOwner(page);
  await generationWithVoice(page);

  const device = page.getByLabel('截图设备', { exact: true });
  await expect(device.locator('option', { hasText: 'iPad 横屏窗口' })).toHaveCount(1);
  await device.selectOption('ipad-window');

  const scene = page.locator('.agent-phone .scene-view');
  await expect(scene).toHaveAttribute('data-device', 'ipad-window');
  await expect(scene.locator('.scene-chat-list-item')).toHaveCount(1);
  await expect(scene.locator('.scene-chat-list-name')).toHaveText('阿远');
  await expect(scene.locator('.scene-voice-transcript')).toHaveText(TRANSCRIPT);

  const before = await scene.locator('[data-message-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-message-id')));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
  const file = test.info().outputPath('ipad-standard.png');
  await (await download).saveAs(file);
  const meta = await sharp(await readFile(file!)).metadata();
  expect([meta.width, meta.height]).toEqual([2048, 1536]);

  // Tablet hides the phone back button. Its title must retain the available
  // thread width, including skins with an avatar and separate action icons.
  for (const platform of ['imstage', 'wechat', 'whatsapp']) {
    await page.getByLabel('目标聊天平台', { exact: true }).selectOption(platform);
    const header = scene.locator('.scene-header-title');
    await expect(header.locator('.scene-header-name')).toHaveText('阿远');
    const dimensions = await header.evaluate((element) => {
      const name = element.querySelector('.scene-header-name') as HTMLElement;
      return { titleWidth: element.getBoundingClientRect().width, textWidth: name.scrollWidth, visibleTextWidth: name.clientWidth };
    });
    expect(dimensions.titleWidth, `${platform} leaves space for the tablet chat title`).toBeGreaterThan(200);
    expect(dimensions.textWidth, `${platform} title is not clipped`).toBeLessThanOrEqual(dimensions.visibleTextWidth);
  }

  // Switching devices never rewrites content or ids.
  await device.selectOption('macos-window');
  await expect(scene).toHaveAttribute('data-device', 'macos-window');
  const after = await scene.locator('[data-message-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-message-id')));
  expect(after).toEqual(before);
});

test('tablet long export keeps the full transcript and the phone/desktop presets stay compatible', async ({ page }) => {
  await registerOwner(page);
  const longTranscript = Array.from({ length: 16 }, (_, i) => `第${i + 1}行：周六码头见，bring the camera and keep this entire authored line visible.`).join('\n');
  await generationWithVoice(page, { title: '新品发布讨论组', group: true, transcript: longTranscript });

  const device = page.getByLabel('截图设备', { exact: true });
  await device.selectOption('ipad-window');
  await page.getByLabel('导出图片范围').selectOption('full');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 PNG', exact: true }).click();
  const file = test.info().outputPath('tablet-long.png');
  await (await download).saveAs(file);
  const meta = await sharp(await readFile(file!)).metadata();
  expect(meta.width).toBe(2048);
  expect(meta.height!).toBeGreaterThan(1536);

  // Group title comes from the actual scene; no fabricated chats or unread badges.
  const scene = page.locator('.agent-phone .scene-view');
  await expect(scene.locator('.scene-chat-list-name')).toHaveText('新品发布讨论组');
  await expect(scene.locator('.scene-chat-list-item')).toHaveCount(1);
  const transcript = scene.locator('.scene-voice-transcript');
  await expect(transcript).toHaveText(longTranscript);
  const bounds = await transcript.evaluate((element) => {
    const node = element.firstChild!;
    const range = document.createRange();
    range.setStart(node, node.textContent!.lastIndexOf('第16行'));
    range.setEnd(node, node.textContent!.length);
    return { lastLineBottom: range.getBoundingClientRect().bottom, blockBottom: element.getBoundingClientRect().bottom, contentHeight: element.scrollHeight, visibleHeight: element.clientHeight };
  });
  expect(bounds.contentHeight).toBeLessThanOrEqual(bounds.visibleHeight);
  expect(bounds.lastLineBottom).toBeLessThanOrEqual(bounds.blockBottom + 1);

  // Phone keeps the compact layout; desktop keeps its window semantics.
  await page.getByLabel('导出图片范围').selectOption('standard');
  await device.selectOption('iphone-17-pro');
  await expect(scene).toHaveAttribute('data-device', 'iphone-17-pro');
  await expect(scene.locator('.scene-chat-list-item')).toHaveCount(0);
  await device.selectOption('macos-window');
  await expect(scene).toHaveAttribute('data-device', 'macos-window');
  await expect(scene.locator('.scene-chat-list-item')).toHaveCount(0);
});

/* ------------------------------------------------------------------ */
/* Repairs: visible rejection before state change                      */
/* ------------------------------------------------------------------ */

test('a 2001-char text→voice conversion is rejected visibly and the old scene stays valid', async ({ page }) => {
  await page.goto('/#/studio');
  const longWording = '长'.repeat(2001);
  await page.getByRole('textbox', { name: '添加一条台词', exact: true }).fill(longWording);
  const composer = page.locator('section').filter({ has: page.getByRole('heading', { name: '添加一条台词', exact: true }) });
  await composer.getByRole('button', { name: '添加这条台词' }).click();
  await expect(page.locator('.studio-phone .scene-row')).toHaveCount(5);

  const panel = page.locator('section').filter({ has: page.locator('h2').filter({ hasText: '选中消息' }) });
  await panel.getByRole('combobox', { name: '类型', exact: true }).selectOption('voice');

  // Rejected BEFORE state change: error surfaced, wording intact, no truncation.
  await expect(page.getByRole('alert').last()).toContainText('2000');
  await expect(panel.getByRole('combobox', { name: '类型', exact: true })).toHaveValue('text');
  await expect(panel.getByRole('textbox', { name: '文本内容', exact: true })).toHaveValue(longWording);
  await expect(page.locator('.studio-phone .scene-voice-transcript')).toHaveCount(0);
  await expect(page.locator('.studio-phone .scene-row')).toHaveCount(5, { message: 'draft keeps the valid old scene' });
});

test('voice composer oversize submission is rejected visibly with the input kept', async ({ page }) => {
  await page.goto('/#/studio');
  const composer = page.locator('section').filter({ has: page.getByRole('heading', { name: '添加一条台词', exact: true }) });
  await composer.getByRole('combobox', { name: '类型', exact: true }).selectOption('voice');
  const over = '长'.repeat(2001);
  await page.getByRole('textbox', { name: '添加一条台词', exact: true }).fill(over);
  await composer.getByRole('button', { name: '添加这条台词' }).click();

  await expect(page.getByRole('alert').last()).toContainText('2000');
  await expect(page.getByRole('textbox', { name: '添加一条台词', exact: true })).toHaveValue(over, { message: 'typed input is kept, never truncated' });
  await expect(page.locator('.studio-phone .scene-row')).toHaveCount(4, { message: 'no state change on rejection' });

  // Exactly 2000 chars is valid and round-trips.
  await page.getByRole('textbox', { name: '添加一条台词', exact: true }).fill('长'.repeat(2000));
  await composer.getByRole('button', { name: '添加这条台词' }).click();
  await expect(page.locator('.studio-phone .scene-voice-transcript')).toHaveText('长'.repeat(2000));
});

test('element inspector shares conversion semantics and edits the transcript field', async ({ page }) => {
  await registerOwner(page);
  await generationWithVoice(page);

  await page.getByRole('button', { name: '元素编辑', exact: true }).click();
  await page.getByLabel('选中元素', { exact: true }).selectOption('m-2');

  // Ordinary labeled transcript field with the explicit wording.
  const transcript = page.getByRole('textbox', { name: '语音文字稿', exact: true });
  await expect(transcript).toHaveValue(TRANSCRIPT);
  await transcript.fill('改后的文字稿');
  await expect(page.locator('.agent-phone .scene-voice-transcript')).toHaveText('改后的文字稿');

  // voice→text with a neutral bubble restores the authored words; no stale
  // transcript can survive on a non-voice message (controls stay usable).
  await page.getByRole('combobox', { name: '消息类型', exact: true }).selectOption('text');
  await expect(page.locator('.agent-inspector').getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '消息文字', exact: true })).toHaveValue('改后的文字稿');
  await expect(transcript).toHaveCount(0);

  // voice→image drops the field in one undoable gesture without breaking the panel.
  await page.getByLabel('选中元素', { exact: true }).selectOption('m-2');
  await page.getByRole('combobox', { name: '消息类型', exact: true }).selectOption('voice');
  await expect(transcript).toHaveCount(1);
  await page.getByRole('combobox', { name: '消息类型', exact: true }).selectOption('image');
  await expect(page.locator('.agent-inspector').getByRole('alert')).toHaveCount(0);
  await expect(transcript).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: '消息类型', exact: true })).toHaveValue('image');
});

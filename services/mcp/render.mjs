// Deterministic PNG renderer for the IMStage MCP server.
//
// Uses the compiled Web SceneView and studio.css, with network/JS disabled
// in the screenshot page. Rendering has bounded pixels, time and concurrency.

import fs from 'node:fs';
import { fail, isMcpToolError } from './errors.mjs';
import { RENDER_LIMITS } from './limits.mjs';
import { sha256Hex, stableStringify } from './util.mjs';
import { renderStudioHtml } from './studio-html.mjs';
import sharp from 'sharp';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAC_CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';

const ALLOWED_PLACEHOLDERS = ['data:', 'about:', 'blob:'];

class Semaphore {
  constructor({ limit, maxQueued }) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.maxQueued = Math.max(0, Number(maxQueued) || 0);
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new Error('render_queue_full'));
    }
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  async run(fn) {
    try {
      await this.acquire();
    } catch {
      fail('renderer_busy', '渲染队列已满，请稍后重试', {
        details: { maxConcurrent: this.limit, maxQueued: this.maxQueued },
        recovery: '等待数百毫秒后重试渲染；不要并发提交大量渲染。',
        status: 429,
      });
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Validate the PNG signature and IHDR before allocating any pixel buffer. */
export function parsePngHeader(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length < 33) {
    fail('render_failed', '渲染结果不是合法 PNG：文件过小', { status: 500 });
  }
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    fail('render_failed', '渲染结果不是合法 PNG：签名不匹配', { status: 500 });
  }
  const chunkLength = buffer.readUInt32BE(8);
  const chunkType = buffer.subarray(12, 16).toString('latin1');
  if (chunkLength !== 13 || chunkType !== 'IHDR') {
    fail('render_failed', '渲染结果不是合法 PNG：缺少 IHDR', { status: 500 });
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) {
    fail('render_failed', '渲染结果宽高不合法', { status: 500 });
  }
  return { width, height };
}

export function resolveChromiumExecutable(env = process.env) {
  const configured = String(env.IMSTAGE_MCP_CHROMIUM_EXECUTABLE ?? env.IMSTAGE_CHROMIUM_EXECUTABLE ?? '').trim();
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    fail('renderer_unavailable', 'IMSTAGE_MCP_CHROMIUM_EXECUTABLE 指向的文件不存在', {
      details: { path: configured },
      recovery: '修正环境变量，或删除它让服务回退到系统 Chrome / Playwright 自带 Chromium。',
      status: 503,
    });
  }
  if (process.platform === 'darwin') {
    for (const candidate of [MAC_CHROME, MAC_CHROMIUM]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null; // fall back to the bundled Playwright Chromium path
}

export function resolveRenderConfig(overrides = {}) {
  const { surface, width, height, outputKind } = overrides;
  if (!['ios', 'android', 'desktop'].includes(surface)) {
    fail('invalid_request', `surface 只能是 ios/android/desktop`, { details: { surface } });
  }
  if (!['screenshot', 'long-screenshot'].includes(outputKind)) {
    fail('invalid_request', `outputKind 只能是 screenshot/long-screenshot`, { details: { outputKind } });
  }
  if (!Number.isInteger(width) || width < RENDER_LIMITS.widthMin || width > RENDER_LIMITS.widthMax) {
    fail('invalid_request', `width 必须是 ${RENDER_LIMITS.widthMin}-${RENDER_LIMITS.widthMax} 的整数`, {
      details: { width, min: RENDER_LIMITS.widthMin, max: RENDER_LIMITS.widthMax },
    });
  }
  if (!Number.isInteger(height) || height < RENDER_LIMITS.heightMin || height > RENDER_LIMITS.heightMax) {
    fail('invalid_request', `height 必须是 ${RENDER_LIMITS.heightMin}-${RENDER_LIMITS.heightMax} 的整数`, {
      details: { height, min: RENDER_LIMITS.heightMin, max: RENDER_LIMITS.heightMax },
    });
  }
  if (width * Math.max(height, outputKind === 'long-screenshot' ? 1200 : height) > RENDER_LIMITS.maxPixels) fail('output_too_large', '请求画布超过像素上限，请减小宽高。', { status: 422 });
  return { surface, width, height, outputKind };
}

function abortIfDeadline(deadline) {
  if (Date.now() > deadline) {
    fail('render_timeout', `渲染超过 ${RENDER_LIMITS.timeoutMs}ms 上限`, {
      recovery: '缩小场景（更少消息/更小 width），或重试。',
      status: 503,
    });
  }
}

/**
 * @param {object} options
 * @param {object} options.scene scene already adapted to the renderer contract
 * @param {object[]} options.assets data URI assets referenced by assetIndex
 * @param {string} options.surface
 * @param {number} options.width
 * @param {number} options.height
 * @param {string} options.outputKind
 */
export async function renderScenePng({ scene, assets = [], surface, width, height, outputKind, executablePath, timeoutMs = RENDER_LIMITS.timeoutMs }) {
  resolveRenderConfig({surface, width, height, outputKind});
  const inlineAssets = new Set([scene.backgroundImage, ...scene.participants.map(p => p.avatar), ...scene.messages.flatMap(m => [m.asset, ...(m.items || []).map(i => i.asset)])].filter(Boolean));
  for (const asset of inlineAssets) {
    try { await sharp(Buffer.from(asset.split(',')[1], 'base64'), {limitInputPixels:4_000_000}).metadata(); }
    catch { fail('invalid_image', '内嵌图片无法解码或超过 400 万像素，请提供有效的小尺寸 PNG/JPEG/WebP。'); }
  }
  const html = await renderStudioHtml({...scene, surface}, {width, height, outputKind});
  const deadline = Date.now() + timeoutMs;
  const resolvedExecutable = executablePath ?? resolveChromiumExecutable();

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    fail('renderer_unavailable', '未安装 playwright，无法执行渲染', {
      details: { cause: error instanceof Error ? error.message : String(error) },
      recovery: '运行 npm ci 安装依赖；Linux 上还需要 npx playwright install --with-deps chromium。',
      status: 503,
    });
  }

  const launchOptions = { args: ['--disable-dev-shm-usage'], timeout: timeoutMs };
  if (resolvedExecutable) launchOptions.executablePath = resolvedExecutable;

  let browser;
  try {
    browser = await chromium.launch(launchOptions);
  } catch (error) {
    fail('renderer_unavailable', '无法启动 Chromium', {
      details: { cause: error instanceof Error ? error.message : String(error) },
      recovery: '设置 IMSTAGE_MCP_CHROMIUM_EXECUTABLE 指向可用的 Chrome/Chromium，或安装 Playwright Chromium。',
      status: 503,
    });
  }

  let watchdog;
  try {
    watchdog = setTimeout(() => {
      browser.close().catch(() => {});
    }, timeoutMs);
    watchdog.unref?.();

    const context = await browser.newContext({
      viewport: { width, height: outputKind === 'long-screenshot' ? Math.max(height, 1200) : height },
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
    });
    try {
      const page = await context.newPage();
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (ALLOWED_PLACEHOLDERS.some((prefix) => url.startsWith(prefix))) return route.continue();
        return route.abort();
      });
      abortIfDeadline(deadline);
      await page.setContent(html, { waitUntil: 'load', timeout: Math.max(1000, deadline - Date.now()) });
      abortIfDeadline(deadline);

      const box = await page.locator('.device').boundingBox();
      if (!box || !Number.isFinite(box.height)) {
        fail('render_failed', '无法测量渲染内容尺寸', { status: 500 });
      }
      const contentHeight = Math.max(1, Math.ceil(box.height));

      if (outputKind === 'long-screenshot') {
        if (contentHeight > RENDER_LIMITS.heightMax || width * contentHeight > RENDER_LIMITS.maxPixels) {
          fail('output_too_large', `长截图高度 ${contentHeight}px 使总像素超过 ${RENDER_LIMITS.maxPixels} 上限`, {
            details: { width, height: contentHeight, maxPixels: RENDER_LIMITS.maxPixels },
            recovery: '减少消息数量、减小 width，或拆分为多张截图。',
            status: 422,
          });
        }
        await page.setViewportSize({ width, height: contentHeight });
      } else if (contentHeight > height + 1 || await page.locator('.scene-messages').evaluate(el => el.scrollHeight > el.clientHeight + 1)) {
        fail('output_too_tall', `内容高度 ${contentHeight}px 超过视口 ${height}px`, {
          details: { contentHeight, viewportHeight: height },
          recovery: '改用 outputKind=long-screenshot，或减少消息数量。',
          status: 422,
        });
      }

      abortIfDeadline(deadline);
      const buffer = await page.screenshot({ type: 'png', animations: 'disabled', timeout: Math.max(1000, deadline - Date.now()) });
      if (buffer.length > RENDER_LIMITS.maxPngBytes) {
        fail('output_too_large', `PNG 超过 ${RENDER_LIMITS.maxPngBytes} 字节上限`, {
          details: { bytes: buffer.length, maxBytes: RENDER_LIMITS.maxPngBytes },
          recovery: '减少消息数量或减小 width。',
          status: 422,
        });
      }
      const header = parsePngHeader(buffer);
      if (width * header.height > RENDER_LIMITS.maxPixels) {
        fail('output_too_large', '渲染像素超过上限', {
          details: { width: header.width, height: header.height, maxPixels: RENDER_LIMITS.maxPixels },
          status: 422,
        });
      }
      return {
        buffer,
        width: header.width,
        height: header.height,
        bytes: buffer.length,
        sha256: sha256Hex(buffer),
        pngBase64: buffer.toString('base64'),
      };
    } finally {
      await context.close().catch(() => {});
    }
  } catch (error) {
    if (isMcpToolError(error)) throw error;
    fail('render_failed', '渲染失败', {
      details: { cause: error instanceof Error ? error.message : String(error) },
      recovery: '重试渲染；若持续失败，请检查 Chromium 可用性与场景内容。',
      status: 500,
      cause: error,
    });
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await browser.close().catch(() => {});
  }
}

/** Deterministic render id: same scene + options + renderer => same id. */
export function computeRenderId({ scene, surface, width, height, outputKind, rendererVersion }) {
  return `rnd_${sha256Hex(stableStringify({ scene, surface, width, height, outputKind, rendererVersion })).slice(0, 32)}`;
}

/** Bounded-concurrency render service shared by all MCP sessions. */
export function createRenderService({ maxConcurrent = RENDER_LIMITS.maxConcurrent, maxQueued = RENDER_LIMITS.maxQueued, executablePath, timeoutMs = RENDER_LIMITS.timeoutMs } = {}) {
  const semaphore = new Semaphore({ limit: maxConcurrent, maxQueued });
  return {
    maxConcurrent,
    maxQueued,
    render(options) {
      return semaphore.run(() => renderScenePng({ ...options, executablePath, timeoutMs }));
    },
  };
}

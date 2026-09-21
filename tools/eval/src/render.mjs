// Deterministic browser screenshotter for the shared renderer.
//
// renderScenePng(scene, opts) -> { buffer, width, height }
//
// - Uses pinned playwright@1.63.0.
// - Loads renderSceneHtml output and aborts every non-data: network request.
// - Launches the executable from IMSTAGE_CHROMIUM_EXECUTABLE when configured,
//   otherwise a local macOS Chrome/Chromium if present, otherwise the bundled
//   Playwright Chromium.
// - Always closes the context and browser in `finally`.
// - Never silently clips content: an ordinary screenshot whose content is
//   taller than the viewport fails with `output_too_tall` and tells the caller
//   to choose long-screenshot. Long screenshots measure the real content height
//   and refuse to exceed the 8M pixel budget.
// - Validates the returned PNG header before handing the buffer back.

import fs from 'node:fs';
import { MAX_PIXELS } from './constants.mjs';
import { AppError, fail } from './util.mjs';
import { parsePngHeader } from './png.mjs';
import { assetToDataUri, renderSceneHtml } from '../../../packages/renderer/renderSceneHtml.mjs';

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAC_CHROMIUM = '/Applications/Chromium.app/Contents/MacOS/Chromium';

export function resolveChromiumExecutable(env = process.env) {
  const configured = String(env.IMSTAGE_CHROMIUM_EXECUTABLE ?? '').trim();
  if (configured) {
    if (fs.existsSync(configured)) return configured;
    fail('renderer_unavailable', 'IMSTAGE_CHROMIUM_EXECUTABLE 指向的文件不存在', 500);
  }
  if (process.platform === 'darwin') {
    for (const candidate of [MAC_CHROME, MAC_CHROMIUM]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null; // fall back to the bundled Playwright Chromium
}

function abortIfCancelled(signal) {
  if (signal?.aborted) throw new AppError('request_aborted', '请求已取消', 499);
}

/**
 * @param {object} scene validated conversation scene
 * @param {object} options
 * @returns {Promise<{ buffer: Buffer, width: number, height: number }>}
 */
export async function renderScenePng(scene, options = {}) {
  const surface = options.surface ?? 'ios';
  const width = Number.isInteger(options.width) && options.width > 0 ? options.width : 390;
  const viewportHeight = Number.isInteger(options.height) && options.height > 0 ? options.height : 844;
  const outputKind = options.outputKind === 'long-screenshot' ? 'long-screenshot' : 'screenshot';
  const assets = Array.isArray(options.assets) ? options.assets : [];
  const signal = options.signal;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 30_000;

  abortIfCancelled(signal);
  const html = renderSceneHtml(scene, { surface, width, outputKind, assets });

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    fail('renderer_unavailable', '未安装 playwright，无法执行截图', 500);
  }

  const executablePath = options.executablePath ?? resolveChromiumExecutable();
  const launchOptions = {
    args: ['--disable-dev-shm-usage'],
  };
  if (executablePath) launchOptions.executablePath = executablePath;

  const browser = await chromium.launch({ ...launchOptions, timeout: timeoutMs }).catch((err) => {
    fail('renderer_unavailable', `无法启动浏览器: ${err && err.message ? err.message : String(err)}`, 500);
  });
  try {
    const context = await browser.newContext({
      viewport: { width, height: outputKind === 'long-screenshot' ? Math.max(viewportHeight, 1200) : viewportHeight },
      deviceScaleFactor: 1,
    });
    try {
      const page = await context.newPage();
      // Only inline data/blob resources are allowed; everything else is aborted.
      await page.route('**/*', (route) => {
        const url = route.request().url();
        if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) {
          return route.continue();
        }
        return route.abort();
      });
      await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
      await page
        .evaluate(() => (document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : true))
        .catch(() => {});
      abortIfCancelled(signal);

      // Bounded decode of every referenced uploaded image: a header-valid but
      // truncated JPEG/WebP must fail here instead of rendering a broken image.
      const assetUris = assets.map(assetToDataUri).filter((uri) => typeof uri === 'string');
      if (assetUris.length > 0) {
        const decoded = await page
          .evaluate(async (uris) => {
            const decodeOne = (uri) => {
              const image = new Image();
              image.src = uri;
              return Promise.race([
                image.decode(),
                new Promise((_resolve, reject) => setTimeout(() => reject(new Error('decode timeout')), 3000)),
              ]);
            };
            for (const uri of uris) {
              await decodeOne(uri);
            }
            return true;
          }, assetUris)
          .catch(() => false);
        if (!decoded) {
          fail('asset_decode_failed', '上传的图片无法被浏览器解码，请检查图片是否损坏', 422);
        }
      }

      const contentHeight = await page.evaluate(() =>
        Math.ceil(document.querySelector('.device').getBoundingClientRect().height),
      );

      if (outputKind === 'long-screenshot') {
        const measured = Math.max(1, Math.ceil(contentHeight));
        if (width * measured > MAX_PIXELS) {
          const err = new AppError(
            'output_too_large',
            `长截图高度 ${measured}px 使总像素 ${width * measured} 超过 ${MAX_PIXELS} 上限`,
            422,
          );
          err.details = { width, height: measured, maxPixels: MAX_PIXELS };
          throw err;
        }
        await page.setViewportSize({ width, height: measured });
      } else if (contentHeight > viewportHeight + 1) {
        const err = new AppError(
          'output_too_tall',
          `内容高度 ${Math.ceil(contentHeight)}px 超过视口 ${viewportHeight}px，请改选长截图 (long-screenshot)`,
          422,
        );
        err.details = { contentHeight: Math.ceil(contentHeight), viewportHeight };
        throw err;
      }

      abortIfCancelled(signal);
      const buffer = await page.screenshot({ type: 'png', animations: 'disabled' });
      const header = parsePngHeader(buffer);
      return { buffer, width: header.width, height: header.height };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

export default renderScenePng;

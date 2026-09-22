// Screenshot-edit benchmark: deterministic product-native edit-layer renderer.
//
// The ORIGINAL screenshot stays as the background at its exact source
// dimensions. Validated local patches (escaped text backgrounds, fixed image
// frames) are overlaid as absolutely positioned layers. No scene template is
// re-drawn and no remote resource is ever fetched.
//
// Guarantees:
// - pure HTML builder (buildEditPlanHtml) so escaping/geometry can be unit
//   tested without a browser;
// - all network/animation disabled; system font stack with Noto CJK/Cyrillic;
// - the screenshot is captured at the exact source dimensions and fully
//   decoded (decodePng) before being returned;
// - text is shrunk to >= 12px when needed, wrap preserved, remaining overflow
//   reported as {id, fits, fontSize, overflowPx};
// - browser/context always closed in `finally`;
// - empty or invalid input is rejected instead of producing a blank fallback.

import { AppError, fail } from '../util.mjs';
import { readImageDimensions } from '../generation.mjs';
import { decodePng } from '../png.mjs';
import { boxToPixels, validatePlan } from './plan.mjs';

export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans SC', 'Noto Sans Cyrillic', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;

function abortIfCancelled(signal) {
  if (signal?.aborted) throw new AppError('request_aborted', '请求已取消', 499);
}

function normalizeMime(mime) {
  const value = String(mime ?? '').toLowerCase();
  return value === 'image/jpg' ? 'image/jpeg' : value;
}

function dataUriFor(buffer, mime) {
  const normalized = normalizeMime(mime);
  if (!['image/png', 'image/jpeg'].includes(normalized)) {
    fail('unsupported_image', `编辑层只接受 PNG/JPEG，收到: ${mime}`, 422, { reasonCode: 'unsupported_mime' });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('empty_file', '图片数据为空', 422, { reasonCode: 'empty_file' });
  }
  if (buffer.length > MAX_ASSET_BYTES) {
    fail('file_too_large', `图片超过 ${MAX_ASSET_BYTES} 字节上限`, 422, { reasonCode: 'file_too_large' });
  }
  return `data:${normalized};base64,${buffer.toString('base64')}`;
}

export { buildEditPlanHtml, escapeHtml } from '../../../../packages/renderer/editPlanHtml.mjs';
import { buildEditPlanHtml } from '../../../../packages/renderer/editPlanHtml.mjs';

import { fitDocumentText } from '../../../../packages/renderer/fitText.mjs';
async function fitTextPatches(page) { return page.evaluate(fitDocumentText); }

/**
 * Render a validated edit plan over the original screenshot.
 *
 * @param {object} options
 * @param {Buffer} options.sourceBuffer original PNG/JPEG bytes
 * @param {string} options.sourceMime 'image/png' | 'image/jpeg'
 * @param {number} options.width exact source width in pixels
 * @param {number} options.height exact source height in pixels
 * @param {object} options.plan validated edit plan
 * @param {Array<{id:string,mime:string,buffer:Buffer}>} options.assets authorized assets
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.executablePath]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{buffer:Buffer,width:number,height:number,textFits:Array,patches:Array,warnings:string[]}>}
 */
export async function renderEditPlan({
  sourceBuffer,
  sourceMime,
  width,
  height,
  plan,
  assets = [],
  signal,
  executablePath,
  timeoutMs = DEFAULT_RENDER_TIMEOUT_MS,
} = {}) {
  if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0) {
    fail('empty_source', '缺少源图数据', 422, { reasonCode: 'empty_source' });
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    fail('invalid_dimensions', '宽高必须是正整数', 422, { reasonCode: 'invalid_dimensions' });
  }
  let sourceDims;
  try {
    sourceDims = readImageDimensions(sourceBuffer, normalizeMime(sourceMime));
  } catch (err) {
    fail('invalid_image', `源图无法解析: ${err.message}`, 422, { reasonCode: 'invalid_image' });
  }
  if (sourceDims.width !== width || sourceDims.height !== height) {
    fail(
      'dimension_mismatch',
      `源图实际尺寸 ${sourceDims.width}x${sourceDims.height} 与请求 ${width}x${height} 不一致`,
      422,
      { reasonCode: 'dimension_mismatch' },
    );
  }

  const assetDataUris = new Map();
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset || typeof asset.id !== 'string' || asset.id.length === 0) {
      fail('invalid_asset', '素材缺少合法 id', 422, { reasonCode: 'invalid_asset' });
    }
    assetDataUris.set(asset.id, dataUriFor(asset.buffer, asset.mime));
  }

  const authorizedIds = new Set(assetDataUris.keys());
  const { plan: validatedPlan, warnings } = validatePlan(plan, {
    mode: 'render',
    authorizedAssetIds: authorizedIds,
  });

  abortIfCancelled(signal);
  const sourceDataUri = dataUriFor(sourceBuffer, sourceMime);
  const html = buildEditPlanHtml(validatedPlan, { width, height, sourceDataUri, assetDataUris });

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    fail('renderer_unavailable', '未安装 playwright，无法执行截图', 500, { reasonCode: 'renderer_unavailable' });
  }

  const { resolveChromiumExecutable } = await import('../render.mjs');
  const resolvedExecutable = executablePath ?? resolveChromiumExecutable();
  const launchOptions = { args: ['--disable-dev-shm-usage'] };
  if (resolvedExecutable) launchOptions.executablePath = resolvedExecutable;

  const browser = await chromium.launch({ ...launchOptions, timeout: timeoutMs }).catch((err) => {
    fail('renderer_unavailable', `无法启动浏览器: ${err && err.message ? err.message : String(err)}`, 500, {
      reasonCode: 'renderer_unavailable',
    });
  });

  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    try {
      const page = await context.newPage();
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
      await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
      abortIfCancelled(signal);

      const textFits = await fitTextPatches(page);
      abortIfCancelled(signal);

      const buffer = await page.screenshot({
        type: 'png',
        animations: 'disabled',
        caret: 'hide',
        clip: { x: 0, y: 0, width, height },
      });
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        fail('render_failed', '渲染器未返回 PNG 数据', 502, { reasonCode: 'render_failed' });
      }
      let header;
      try {
        header = decodePng(buffer);
      } catch (err) {
        fail('render_invalid_png', `渲染输出不是完整合法 PNG: ${err.message}`, 502, {
          reasonCode: 'render_invalid_png',
        });
      }
      if (header.width !== width || header.height !== height) {
        fail(
          'render_dimension_mismatch',
          `渲染输出尺寸 ${header.width}x${header.height} 与源图 ${width}x${height} 不一致`,
          502,
          { reasonCode: 'render_dimension_mismatch' },
        );
      }
      return {
        buffer,
        width,
        height,
        textFits,
        warnings,
        patches: validatedPlan.edits.map((edit) => ({
          id: edit.id,
          kind: edit.kind,
          ...boxToPixels(edit.box, width, height),
        })),
      };
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

export default renderEditPlan;

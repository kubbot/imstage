import { fail } from '../schema/errors.mjs';
import { boxToPixels } from '../schema/edit-plan.mjs';
export const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans SC', 'Noto Sans Cyrillic', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(value) {
  return Number(value.toFixed(4));
}

function renderPatch(edit, width, height, assetDataUris) {
  const rect = boxToPixels(edit.box, width, height);
  const base = [
    `left:${fmt(rect.x)}px`,
    `top:${fmt(rect.y)}px`,
    `width:${fmt(rect.width)}px`,
    `height:${fmt(rect.height)}px`,
    `background:${edit.background}`,
  ];
  const radiusMax = Math.max(0, Math.min(rect.width, rect.height) / 2);
  const radius = edit.radius ? Math.min(edit.radius, radiusMax) : 0;
  if (radius > 0) base.push(`border-radius:${fmt(radius)}px`);
  const style = `${base.join(';')};`;
  if (edit.kind === 'text') {
    return (
      `<div class="patch patch-text-wrap" data-text-patch="1" data-edit-id="${escapeHtml(edit.id)}" ` +
      `data-font-size="${edit.fontSize}" style="${style}">` +
      `<div class="patch-text" style="font-family:${FONT_STACK};font-size:${edit.fontSize}px;` +
      `font-weight:${edit.fontWeight};text-align:${edit.align};color:${edit.color};">${escapeHtml(edit.text)}</div>` +
      `</div>`
    );
  }
  const uri = assetDataUris.get(edit.assetId);
  if (!uri) {
    fail('unauthorized_asset', `缺少编辑所需的素材: ${edit.assetId}`, 422, {
      field: edit.assetId,
      reasonCode: 'invalid_asset',
    });
  }
  return (
    `<div class="patch patch-image-wrap" data-image-patch="1" data-edit-id="${escapeHtml(edit.id)}" style="${style}">` +
    `<img class="patch-image" src="${uri}" style="object-fit:${edit.fit};" alt="" />` +
    `</div>`
  );
}

/**
 * Pure HTML builder for an edit plan. Deterministic: no Date/random and every
 * patch is an absolute layer over the original source image.
 */
export function buildEditPlanHtml(plan, { width, height, sourceDataUri, assetDataUris = new Map() }) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    fail('invalid_dimensions', 'HTML 构建需要正整数宽高', 422, { reasonCode: 'invalid_dimensions' });
  }
  if (typeof sourceDataUri !== 'string' || !sourceDataUri.startsWith('data:image/')) {
    fail('invalid_source', '缺少源图 data URI', 422, { reasonCode: 'invalid_source' });
  }
  const patches = plan.edits.map((edit) => renderPatch(edit, width, height, assetDataUris)).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=${width}, initial-scale=1" />
<title>edit-plan</title>
<style>
  *, *::before, *::after { box-sizing: border-box; animation: none !important; transition: none !important; }
  html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: #ffffff; }
  .source-frame { position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px; display: block; }
  .patch { position: absolute; overflow: hidden; display: flex; align-items: center; }
  .patch-text-wrap { justify-content: flex-start; }
  .patch-text { width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; line-height: 1.25; }
  .patch-image-wrap { display: block; }
  .patch-image { width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<img class="source-frame" src="${sourceDataUri}" width="${width}" height="${height}" alt="" />
${patches}
</body>
</html>
`;
}

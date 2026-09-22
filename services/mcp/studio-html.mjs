import fs from 'node:fs';
const compiled = new URL('../../.local/mcp-renderer/studio.mjs', import.meta.url);
const styleFile = new URL('../../apps/web/src/studio/studio.css', import.meta.url);
let runtime;
export const STUDIO_RENDERER_VERSION = 'studio-20260923-title-v3';

/** Shared Web component; generated markup contains no user executable code. */
export async function renderStudioHtml(scene, { width, height, outputKind }) {
  if (!fs.existsSync(compiled)) throw new Error('Run npm run build:mcp before starting the MCP server.');
  runtime ??= import(compiled.href);
  const { renderStudioMarkup } = await runtime;
  const css = fs.readFileSync(styleFile, 'utf8');
  const full = outputKind === 'long-screenshot';
  // Numbers are validated by resolveRenderConfig before this function is called.
  if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 20000)) throw new Error('Invalid render dimensions');
  const markup = renderStudioMarkup(scene);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;padding:0;background:#fff}*{box-sizing:border-box}
${css}
.device{width:${width}px;${full?'':`height:${height}px;`}overflow:hidden}
.device>.scene-view{width:100%;max-width:none;min-height:${full?'640px':'0'};height:${full?'auto':'100%'}}
button{font:inherit}.scene-view button{color:inherit}
</style></head><body><div class="device">${markup}</div></body></html>`;
}

import { renderStudioMarkup, STUDIO_CSS } from './generated/studio.mjs';
import { PLATFORM_IDS, socialChatAdapter } from '../schema/platforms.mjs';

/** Pure shell for the editor's SceneView. Callers supply a validated scene. */
export function renderStudioDocument(scene, { width, height = 844, outputKind }) {
  if (![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=20000)) throw new Error('Invalid render dimensions');
  const full=outputKind==='long-screenshot';
  const platform=PLATFORM_IDS.includes(scene.platform)?scene.platform:'imstage';
  const mode=socialChatAdapter(scene.platform) ? ` data-mode="${full?'full':'standard'}"` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body{margin:0;padding:0;background:#fff}*{box-sizing:border-box}
${STUDIO_CSS}
.device{width:${width}px;${full?'':`height:${height}px;`}overflow:hidden}
.device>.scene-view{width:100%;max-width:none;min-height:${full?'640px':'0'};height:${full?'auto':'100%'}}
button{font:inherit}.scene-view button{color:inherit}
</style></head><body><div class="device platform-${platform}"${mode}>${renderStudioMarkup(scene)}</div></body></html>`;
}

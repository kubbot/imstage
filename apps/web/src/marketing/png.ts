/**
 * Real PNG export for the landing demo.
 *
 * Renders the hidden natural-size SceneView (never the scaled preview) through
 * the same `html-to-image` path the studio uses, so the downloaded file is the
 * deterministic renderer output rather than a decorative image.
 */
import { slugify, waitForImages } from '../studio/storage';

export interface PngResult {
  dataUrl: string;
  width: number;
  height: number;
}

export async function renderScenePng(node: HTMLElement, pixelRatio = 3): Promise<PngResult> {
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  if (!width || !height) throw new Error('导出画布尺寸无效');
  // Freeze the DOM synchronously, before fonts/images yield. Header language
  // changes must not mutate a download that the visitor already requested.
  const snapshot = node.cloneNode(true) as HTMLElement;
  snapshot.style.width = `${width}px`;
  snapshot.style.height = `${height}px`;
  node.parentElement!.appendChild(snapshot);
  try {
    await waitForImages(snapshot);
    if (document.fonts?.ready) await document.fonts.ready;
    const { toPng } = await import('html-to-image');
    const dataUrl = await toPng(snapshot, {
      pixelRatio,
      skipFonts: true,
      backgroundColor: getComputedStyle(snapshot).backgroundColor,
    });
    return { dataUrl, width: width * pixelRatio, height: height * pixelRatio };
  } finally {
    snapshot.remove();
  }
}

export function downloadDataUrl(dataUrl: string, filename: string): void {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

export function sceneFileName(scene: { platform: string; title: string }, suffix = 'frame'): string {
  return `imstage-${slugify(scene.title, suffix)}-${scene.platform}.png`;
}

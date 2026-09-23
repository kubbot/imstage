/**
 * Client-side avatar reading and proportional square crop.
 *
 * The crop always maps a square region of the *source* pixels onto a square
 * canvas via `CanvasRenderingContext2D.drawImage(source, sx, sy, sw, sh, ...)`,
 * so rectangular uploads are never stretched. The canvas only prepares a
 * preview/upload payload; the server re-validates and re-encodes every byte.
 *
 * https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage
 */

import type { AvatarCrop } from './api';

export const MAX_AVATAR_UPLOAD_BYTES = 2 * 1024 * 1024;
export const AVATAR_OUTPUT_SIZE = 256;
const VALID_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type LoadedAvatar = {
  dataUrl: string;
  width: number;
  height: number;
  image: HTMLImageElement;
};

export type LoadAvatarResult = { ok: true; loaded: LoadedAvatar } | { ok: false; error: string };

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsDataURL(file);
  });
}

export function loadImageElement(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('decode_failed'));
    image.src = dataUrl;
  });
}

/** Read + decode an uploaded avatar with the same bounds the server enforces. */
export async function loadAvatarFile(file: File | null | undefined): Promise<LoadAvatarResult> {
  if (!file) return { ok: false, error: 'no_file' };
  if (!(VALID_TYPES as readonly string[]).includes(file.type)) return { ok: false, error: 'type' };
  if (file.size > MAX_AVATAR_UPLOAD_BYTES) return { ok: false, error: 'size' };
  let dataUrl: string;
  try {
    dataUrl = await readFileAsDataUrl(file);
  } catch {
    return { ok: false, error: 'read' };
  }
  try {
    const image = await loadImageElement(dataUrl);
    return { ok: true, loaded: { dataUrl, width: image.naturalWidth, height: image.naturalHeight, image } };
  } catch {
    return { ok: false, error: 'decode' };
  }
}

export type CropAdjust = { zoom: number; x: number; y: number };

export const DEFAULT_CROP_ADJUST: CropAdjust = { zoom: 1, x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute a square source rect for the given pan/zoom. `zoom` is >= 1 (1 shows
 * the largest centred square); `x`/`y` are -100..100 pan fractions.
 */
export function computeSquareCrop(width: number, height: number, adjust: CropAdjust): AvatarCrop {
  const zoom = Number.isFinite(adjust.zoom) ? clamp(adjust.zoom, 1, 3) : 1;
  const x = Number.isFinite(adjust.x) ? clamp(adjust.x, -100, 100) : 0;
  const y = Number.isFinite(adjust.y) ? clamp(adjust.y, -100, 100) : 0;
  const base = Math.min(width, height);
  const side = Math.max(1, Math.round(base / zoom));
  const cx = width / 2 + (x / 100) * ((width - side) / 2);
  const cy = height / 2 + (y / 100) * ((height - side) / 2);
  return {
    left: Math.round(clamp(cx - side / 2, 0, width - side)),
    top: Math.round(clamp(cy - side / 2, 0, height - side)),
    width: side,
    height: side,
  };
}

/** Draw a proportional square crop at output size and return a PNG data URI. */
export function cropSquare(loaded: LoadedAvatar, crop: AvatarCrop, size = AVATAR_OUTPUT_SIZE): string {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas_unavailable');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(loaded.image, crop.left, crop.top, crop.width, crop.height, 0, 0, size, size);
  return canvas.toDataURL('image/png');
}

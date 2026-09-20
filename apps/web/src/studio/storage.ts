/**
 * Browser-only helpers for the studio: local drafts, image ingestion and
 * download/copy utilities. Nothing here talks to a server. Drafts are stored
 * in localStorage only and the UI must never claim cloud persistence.
 */

import { parseDraft, serializeDraft, type Scene } from './model';

export const DRAFT_KEY = 'imstage.studio.draft.v1';
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const VALID_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type StorageCode = 'ok' | 'unavailable' | 'quota' | 'error';

export interface StorageResult {
  ok: boolean;
  code: StorageCode;
  message: string;
}

export interface LoadDraftResult {
  status: 'ok' | 'empty' | 'corrupt' | 'unavailable';
  scene?: Scene;
  raw?: string;
  message?: string;
}

function getStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return (
      error.name === 'QuotaExceededError' ||
      error.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      error.code === 22 ||
      error.code === 1014
    );
  }
  if (error instanceof Error) {
    return /quota|exceeded|storage full/i.test(error.name + ' ' + error.message);
  }
  return false;
}

export function storageAvailable(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    const probe = '__imstage_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(): LoadDraftResult {
  const storage = getStorage();
  if (!storage) {
    return { status: 'unavailable', message: '当前浏览器不可用本地存储，草稿不会自动保存。' };
  }
  let raw: string | null = null;
  try {
    raw = storage.getItem(DRAFT_KEY);
  } catch {
    return { status: 'unavailable', message: '读取本地草稿失败，浏览器可能禁用了存储。' };
  }
  if (raw === null || raw === '') return { status: 'empty' };
  const parsed = parseDraft(raw);
  if (!parsed.ok || !parsed.draft) {
    return {
      status: 'corrupt',
      raw,
      message: `本地草稿无法读取：${parsed.errors.join('；')}`,
    };
  }
  return { status: 'ok', scene: parsed.draft.scene, raw };
}

export function saveDraft(scene: Scene, raw = serializeDraft(scene)): StorageResult {
  const storage = getStorage();
  if (!storage) {
    return { ok: false, code: 'unavailable', message: '本地存储不可用，草稿不会自动保存。' };
  }
  try {
    storage.setItem(DRAFT_KEY, raw);
    return { ok: true, code: 'ok', message: '已保存到本机浏览器' };
  } catch (error) {
    if (isQuotaError(error)) {
      return {
        ok: false,
        code: 'quota',
        message: '本地存储空间不足（图片过大时常见）。可先下载场景 JSON 备份，再删除部分图片。',
      };
    }
    return {
      ok: false,
      code: 'error',
      message: `写入本地草稿失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function clearDraft(): StorageResult {
  const storage = getStorage();
  if (!storage) {
    return { ok: false, code: 'unavailable', message: '本地存储不可用。' };
  }
  try {
    storage.removeItem(DRAFT_KEY);
    return { ok: true, code: 'ok', message: '已清除本机草稿' };
  } catch (error) {
    return {
      ok: false,
      code: 'error',
      message: `清除草稿失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type ImageReadResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };

/**
 * Validate and decode a user image. Returns a data URL only when the type,
 * size and decode all succeed, so a failed upload can never destroy the
 * currently rendered preview.
 */
export async function readImageFile(file: File | null | undefined): Promise<ImageReadResult> {
  if (!file) return { ok: false, error: '没有选择文件' };
  if (!(VALID_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: '仅支持 PNG / JPEG / WebP 图片' };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: '图片需小于 4MB' };
  }
  let dataUrl: string;
  try {
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
      reader.readAsDataURL(file);
    });
  } catch (error) {
    return { ok: false, error: `读取图片失败：${error instanceof Error ? error.message : String(error)}` };
  }
  const decoded = await new Promise<boolean>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = dataUrl;
  });
  if (!decoded) return { ok: false, error: '图片无法解码，请更换文件' };
  return { ok: true, dataUrl };
}

export function slugify(value: string, fallback = 'scene'): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Wait for every <img> inside a node to finish decoding (or fail). */
export async function waitForImages(root: HTMLElement): Promise<void> {
  await Promise.all(Array.from(root.querySelectorAll('img')).map(image => new Promise<void>((resolve, reject) => {
    const finish = () => { cleanup(); image.naturalWidth > 0 ? resolve() : reject(new Error('图片无法加载，请更换素材后重试')); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('图片加载超时，请重试')); }, 10000);
    const cleanup = () => { clearTimeout(timer); image.removeEventListener('load', finish); image.removeEventListener('error', finish); };
    if (image.complete) { finish(); return; }
    image.addEventListener('load', finish); image.addEventListener('error', finish);
  })));
}

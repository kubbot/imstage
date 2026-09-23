/**
 * Bounded same-origin asset loading for the landing demo.
 *
 * Only the committed demo portraits and the Wukang story photograph are read,
 * only from a relative same-origin path, only under a hard byte limit. The
 * result is a `data:` URI so the same scene can be validated and exported
 * without a network fetch. Loading, error and retry are explicit states; a
 * failure downgrades to text avatars (or blocks the story export) instead of
 * silently breaking the frame.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  DEMO_AVATARS,
  DEMO_STORIES,
  hasLocalAvatar,
  MAX_AVATAR_BYTES,
  MAX_STORY_BYTES,
  type DemoAvatars,
} from './portable';

export type AvatarLoad = { ok: true; avatars: DemoAvatars } | { ok: false; error: string };
export type StoryLoad = { ok: true; photo: string } | { ok: false; error: string };

export function assertSameOriginAsset(url: string): void {
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('..')) {
    throw new Error('示例素材路径无效');
  }
}

/** Read one bounded same-origin image as a validated `data:` URI. */
export async function readSameOriginImage(url: string, limit: number, signal: AbortSignal, label = '示例素材'): Promise<string> {
  assertSameOriginAsset(url);
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`${label}加载失败（${response.status}）`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new Error(`${label}格式无效`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error(`${label}为空`);
  if (blob.size > limit) throw new Error(`${label}超出大小限制`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`${label}读取失败`));
    reader.readAsDataURL(blob);
  });
  if (!hasLocalAvatar(dataUrl)) throw new Error(`${label}数据无效`);
  return dataUrl;
}

function abortable<T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined, onAbort: T): Promise<T> {
  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener('abort', relay, { once: true });
  return task(controller.signal)
    .catch((error) => {
      if (controller.signal.aborted) return onAbort;
      throw error;
    })
    .finally(() => signal?.removeEventListener('abort', relay));
}

/** Load both synthetic avatars; any failure rejects as a whole. */
export async function loadDemoAvatars(signal?: AbortSignal): Promise<AvatarLoad> {
  return abortable(
    async (inner) => {
      try {
        const [yuan, ava, suWan] = await Promise.all([
          readSameOriginImage(DEMO_AVATARS.yuan, MAX_AVATAR_BYTES, inner, '示例头像'),
          readSameOriginImage(DEMO_AVATARS.ava, MAX_AVATAR_BYTES, inner, '示例头像'),
          readSameOriginImage(DEMO_AVATARS.suWan, MAX_AVATAR_BYTES, inner, '示例头像'),
        ]);
        return { ok: true, avatars: { yuan, ava, suWan } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '示例头像加载失败' };
      }
    },
    signal,
    { ok: false, error: '示例头像加载已取消' },
  );
}

/** Load the authored story photograph; a failure is reported, never faked. */
export async function loadStoryPhoto(signal?: AbortSignal): Promise<StoryLoad> {
  return abortable(
    async (inner) => {
      try {
        const photo = await readSameOriginImage(DEMO_STORIES.wukang, MAX_STORY_BYTES, inner, '示例照片');
        return { ok: true, photo };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : '示例照片加载失败' };
      }
    },
    signal,
    { ok: false, error: '示例照片加载已取消' },
  );
}

export type AvatarState =
  | { status: 'loading' }
  | { status: 'ready'; avatars: DemoAvatars }
  | { status: 'error'; message: string };

export type StoryState =
  | { status: 'loading' }
  | { status: 'ready'; photo: string }
  | { status: 'error'; message: string };

/** React state machine for the loader, with an explicit retry. */
export function useDemoAvatars(): { state: AvatarState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AvatarState>({ status: 'loading' });

  useEffect(() => {
    // https://react.dev/reference/react/useEffect#fetching-data-with-effects
    const controller = new AbortController();
    setState({ status: 'loading' });
    void loadDemoAvatars(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { status: 'ready', avatars: result.avatars } : { status: 'error', message: result.error });
    });
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, retry };
}

/** Same state machine for the story photograph, with its own retry. */
export function useStoryPhoto(): { state: StoryState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StoryState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void loadStoryPhoto(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setState(result.ok ? { status: 'ready', photo: result.photo } : { status: 'error', message: result.error });
    });
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, retry };
}

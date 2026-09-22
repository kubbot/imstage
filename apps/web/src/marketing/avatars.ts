/**
 * Bounded same-origin avatar loading for the landing demo.
 *
 * Only the two static demo photos are read, only from a relative same-origin
 * path, only under a hard byte limit. The result is a `data:` URI so the same
 * scene can be validated and exported without a network fetch. Loading, error
 * and retry are explicit states; a failure downgrades to text avatars instead
 * of silently breaking the frame.
 */
import { useCallback, useEffect, useState } from 'react';
import { DEMO_AVATARS, hasLocalAvatar, MAX_AVATAR_BYTES, type DemoAvatars } from './portable';

export type AvatarLoad = { ok: true; avatars: DemoAvatars } | { ok: false; error: string };

function assertSameOriginAsset(url: string): void {
  if (!url.startsWith('/') || url.startsWith('//') || url.includes('..')) {
    throw new Error('示例头像路径无效');
  }
}

async function readAvatar(url: string, signal: AbortSignal): Promise<string> {
  assertSameOriginAsset(url);
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`示例头像加载失败（${response.status}）`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) throw new Error('示例头像格式无效');
  const blob = await response.blob();
  if (blob.size === 0) throw new Error('示例头像为空');
  if (blob.size > MAX_AVATAR_BYTES) throw new Error('示例头像超出大小限制');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('示例头像读取失败'));
    reader.readAsDataURL(blob);
  });
  if (!hasLocalAvatar(dataUrl)) throw new Error('示例头像数据无效');
  return dataUrl;
}

/** Load both synthetic avatars; any failure rejects as a whole. */
export async function loadDemoAvatars(signal?: AbortSignal): Promise<AvatarLoad> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const [yuan, ava] = await Promise.all([
      readAvatar(DEMO_AVATARS.yuan, controller.signal),
      readAvatar(DEMO_AVATARS.ava, controller.signal),
    ]);
    if (controller.signal.aborted) throw new Error('示例头像加载已取消');
    return { ok: true, avatars: { yuan, ava } };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: '示例头像加载已取消' };
    return { ok: false, error: error instanceof Error ? error.message : '示例头像加载失败' };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export type AvatarState =
  | { status: 'loading' }
  | { status: 'ready'; avatars: DemoAvatars }
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

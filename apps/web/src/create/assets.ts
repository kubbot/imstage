import type { Scene, Platform } from '../studio/model';

export const MARS_PROMPT_TEXT = '我和 Elon Musk 在明天一起去火星漫游';
export const avatarSource = {
  profile: 'https://x.com/elonmusk',
  image: 'https://pbs.twimg.com/profile_images/2053244804520427520/m8mdWZCG_400x400.jpg',
  observed: '2026-09-20',
};
export const demoAssets = { avatar: '/assets/elon-x-avatar.jpg', image: '/assets/mars-companions.png' };

export function previewScene(platform: Platform = 'wechat'): Scene {
  return {
    id: 'scene-mars-preview', title: '明天，火星见', platform, deviceTime: '09:41', date: '明天 15:00',
    selfId: 'me', participants: [{ id: 'me', name: '我' }, { id: 'elon', name: 'Elon Musk', avatar: demoAssets.avatar }],
    messages: [
      { id: 'm1', participantId: 'me', type: 'text', text: '明天，去火星漫游？', time: '' },
      { id: 'm2', participantId: 'elon', type: 'text', text: '当然。给你留了靠窗的位置。', time: '' },
      { id: 'm3', participantId: 'elon', type: 'location', text: '火星 · 杰泽罗陨石坑', time: '' },
      { id: 'm4', participantId: 'elon', type: 'image', text: '我们在火星的合影 · AI 合成', time: '', asset: demoAssets.image },
      { id: 'm5', participantId: 'me', type: 'text', text: '这张照片，我要留很久。', time: '' },
    ], watermark: '虚构场景 · AI 合成',
  };
}

export async function loadDemoAssets(signal?: AbortSignal) {
  async function dataUrl(url: string) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('示例素材未能加载，请重试。');
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size > 6 * 1024 * 1024) throw new Error('示例素材格式无效。');
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('示例素材读取失败。'));
      reader.readAsDataURL(blob);
    });
  }
  const [avatar, image] = await Promise.all([dataUrl(demoAssets.avatar), dataUrl(demoAssets.image)]);
  signal?.throwIfAborted();
  return { avatar, image };
}

export async function makePortable(scene: Scene, signal?: AbortSignal): Promise<Scene> {
  const localAssets = [demoAssets.avatar, demoAssets.image];
  const needsLocalAssets = scene.participants.some(p => p.avatar && localAssets.includes(p.avatar)) || scene.messages.some(m => m.asset && localAssets.includes(m.asset));
  if (!needsLocalAssets) return structuredClone(scene);
  const loaded = await loadDemoAssets(signal);
  const substitute = (value?: string) => value === demoAssets.avatar ? loaded.avatar : value === demoAssets.image ? loaded.image : value;
  return { ...scene, participants: scene.participants.map(p => ({ ...p, avatar: substitute(p.avatar) })), messages: scene.messages.map(m => ({ ...m, asset: substitute(m.asset) })) };
}

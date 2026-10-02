import type {Platform} from './model';
/**
 * Platform chat templates belong to code. Agent content cannot redefine
 * platform structure. Each entry is an approximate style preview for synthetic
 * content — never a pixel clone and never a brand logo. `imstage` is the
 * generic IMStage template and stays a first-class option alongside WeChat,
 * WhatsApp, iMessage, Instagram, Xiaohongshu and Slack. The deterministic
 * renderer (packages/renderer/renderSceneHtml.mjs) mirrors these differences.
 */
export interface PlatformTemplate {
  version: string;
  headerAvatar: boolean;
  messageAvatars: 'all' | 'incoming' | 'group' | 'none';
  inlineTime: boolean;
  composer: 'default' | 'wechat' | 'whatsapp' | 'imessage' | 'instagram' | 'slack';
  background: string;
}

export const GENERIC_TEMPLATE: PlatformTemplate = {
  version: 'imstage-generic-2026-v1',
  headerAvatar: false,
  messageAvatars: 'all',
  inlineTime: true,
  composer: 'default',
  background: '#e9edf2',
};

export const PLATFORM_TEMPLATES: Record<Platform, PlatformTemplate> = {
  imstage: GENERIC_TEMPLATE,
  wechat: { version: 'wechat-ios-2026-v1', headerAvatar: false, messageAvatars: 'all', inlineTime: false, composer: 'wechat', background: '#f5f5f5' },
  whatsapp: { version: 'whatsapp-ios-2026-v1', headerAvatar: true, messageAvatars: 'group', inlineTime: true, composer: 'whatsapp', background: '#ece5dd' },
  instagram: { version: 'instagram-ios-2026-v1', headerAvatar: true, messageAvatars: 'incoming', inlineTime: false, composer: 'instagram', background: '#ffffff' },
  imessage: { version: 'imessage-v1', headerAvatar: false, messageAvatars: 'none', inlineTime: false, composer: 'imessage', background: '#ffffff' },
  xiaohongshu: { version: 'xiaohongshu-v1', headerAvatar: false, messageAvatars: 'all', inlineTime: false, composer: 'default', background: '#ffffff' },
  slack: { version: 'slack-v1', headerAvatar: false, messageAvatars: 'all', inlineTime: true, composer: 'slack', background: '#ffffff' },
};

export function platformTemplate(platform: Platform): PlatformTemplate {
  return PLATFORM_TEMPLATES[platform] ?? GENERIC_TEMPLATE;
}

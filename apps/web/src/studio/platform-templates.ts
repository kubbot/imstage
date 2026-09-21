import type {Platform} from './model';
/** Platform chrome belongs to code. Agent content cannot redefine platform structure. */
export const PLATFORM_TEMPLATES = {
  wechat: {version:'wechat-ios-2026-v1', headerAvatar:false, messageAvatars:'all', inlineTime:false, composer:'wechat', background:'#ededed'},
  whatsapp: {version:'whatsapp-ios-2026-v1', headerAvatar:true, messageAvatars:'group', inlineTime:true, composer:'whatsapp', background:'#f4f0e7'},
  instagram: {version:'instagram-ios-2026-v1', headerAvatar:true, messageAvatars:'incoming', inlineTime:false, composer:'instagram', background:'#ffffff'},
  imessage: {version:'imessage-v1', headerAvatar:false, messageAvatars:'none', inlineTime:false, composer:'default', background:'#ffffff'},
  xiaohongshu: {version:'xiaohongshu-v1', headerAvatar:false, messageAvatars:'all', inlineTime:false, composer:'default', background:'#f6f6f6'},
  slack: {version:'slack-v1', headerAvatar:false, messageAvatars:'all', inlineTime:false, composer:'default', background:'#ffffff'},
} as const;
export function platformTemplate(platform:Platform){return PLATFORM_TEMPLATES[platform];}

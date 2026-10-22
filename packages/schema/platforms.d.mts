export type PlatformId = 'imstage'|'wechat'|'xiaohongshu'|'imessage'|'whatsapp'|'slack'|'instagram'|'x'|'jike'|'threads';
export interface SocialChatAdapter {
 readonly label:string; readonly version:string; readonly headerAvatar:boolean;
 readonly messageAvatars:'all'|'incoming'|'group'|'none'; readonly inlineTime:boolean; readonly composer:'default';
 readonly background:string; readonly incoming:string; readonly outgoing:string; readonly outgoingText:string;
 readonly accent:string; readonly radius:number; readonly headerBackground:string; readonly border:string;
 readonly placeholder:Readonly<Record<'zh'|'en',string>>; readonly subtitle:Readonly<Record<'zh'|'en',string>>;
}
export const PLATFORM_IDS:readonly PlatformId[];
export const SOCIAL_CHAT_ADAPTERS:Readonly<Record<'x'|'jike'|'threads'|'xiaohongshu',SocialChatAdapter>>;
export function socialChatAdapter(platform:string):SocialChatAdapter|undefined;

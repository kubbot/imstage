// Code-owned catalog shared by Web, API, Agent and MCP. New templates must
// add an adapter, rendering tests and real export evidence before admission.
// These are synthetic conversation styles, not social-network publishing APIs.
export const PLATFORM_IDS = Object.freeze(['imstage','wechat','xiaohongshu','imessage','whatsapp','slack','instagram','x','jike','threads']);
export const SOCIAL_CHAT_ADAPTERS = Object.freeze({
  x: Object.freeze({label:'X',version:'x-chat-v1',headerAvatar:true,messageAvatars:'incoming',inlineTime:true,composer:'default',background:'#ffffff',incoming:'#eff3f4',outgoing:'#1d6fa5',outgoingText:'#ffffff',accent:'#1d6fa5',radius:20,headerBackground:'#ffffff',border:'#e5e9ec',placeholder:{zh:'发送私信…',en:'Start a message…'},subtitle:{zh:'X · 合成私信',en:'X · Synthetic DM'}}),
  jike: Object.freeze({label:'即刻 / Jike',version:'jike-chat-v1',headerAvatar:false,messageAvatars:'all',inlineTime:false,composer:'default',background:'#f7f8fa',incoming:'#ffffff',outgoing:'#ffe450',outgoingText:'#202124',accent:'#695700',radius:12,headerBackground:'#ffffff',border:'#e5e7eb',placeholder:{zh:'聊点有趣的…',en:'Say something interesting…'},subtitle:{zh:'即刻 · 合成对话',en:'Jike · Synthetic chat'}}),
  threads: Object.freeze({label:'Threads',version:'threads-chat-v1',headerAvatar:true,messageAvatars:'incoming',inlineTime:true,composer:'default',background:'#ffffff',incoming:'#f0f0f0',outgoing:'#181818',outgoingText:'#ffffff',accent:'#181818',radius:22,headerBackground:'#ffffff',border:'#e5e5e5',placeholder:{zh:'发送消息…',en:'Message…'},subtitle:{zh:'Threads · 合成私信',en:'Threads · Synthetic DM'}}),
  xiaohongshu: Object.freeze({label:'小红书 / Xiaohongshu',version:'xiaohongshu-chat-v2',headerAvatar:false,messageAvatars:'all',inlineTime:false,composer:'default',background:'#ffffff',incoming:'#f4f4f6',outgoing:'#c71f3a',outgoingText:'#ffffff',accent:'#c71f3a',radius:14,headerBackground:'#ffffff',border:'#f0f0f2',placeholder:{zh:'发送消息…',en:'Message…'},subtitle:{zh:'小红书 · 合成私信',en:'Xiaohongshu · Synthetic DM'}}),
});
export function socialChatAdapter(platform) {
  return Object.hasOwn(SOCIAL_CHAT_ADAPTERS, platform) ? SOCIAL_CHAT_ADAPTERS[platform] : undefined;
}

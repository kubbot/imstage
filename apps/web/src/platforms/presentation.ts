/**
 * Explicit presentation capabilities for the public platform explorer.
 *
 * Content kind is presentation metadata owned by this experience; it is never
 * inferred from rendering-adapter internals. `dm` platforms are social-network
 * direct-message/conversation styles — synthetic DMs and chats, not posts,
 * feeds, comments or publishing APIs. `chat` platforms are classic IM chat
 * styles. Keep this map in sync with the shared `PLATFORMS` source.
 */
import type { Platform } from '../studio/model';

export type PresentationKind = 'chat' | 'dm';

export const PRESENTATION_KIND: Record<Platform, PresentationKind> = {
  imstage: 'chat',
  wechat: 'chat',
  xiaohongshu: 'dm',
  imessage: 'chat',
  whatsapp: 'chat',
  slack: 'chat',
  instagram: 'dm',
  x: 'dm',
  jike: 'dm',
  threads: 'dm',
};

export function presentationKind(platform: Platform): PresentationKind {
  return PRESENTATION_KIND[platform] ?? 'chat';
}

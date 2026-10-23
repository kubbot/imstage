/**
 * Copy for the public platform explorer (platform comparison section).
 *
 * Bilingual like the rest of the public site. English strings stay ASCII so the
 * localized templates page never mixes scripts. Platform names come from the
 * shared `PLATFORM_LABELS` (see `studio/model.ts`), never from this file, and
 * the prose never hardcodes how many platforms exist — that list is dynamic.
 */
import type { Locale } from '../marketing/locale';

export interface PlatformExplorerCopy {
  label: string;
  title: string;
  lede: string;
  selectLabel: string;
  previewLabel: string;
  /** Content-kind label for classic IM chat skins. */
  chatTag: string;
  /** Content-kind label for social-network DM/conversation skins. */
  dmTag: string;
  /** Short note under the preview for chat skins. */
  styleNote: string;
  /** Short note under the preview for DM/conversation skins. */
  dmNote: string;
  continueLabel: string;
  /** Neutral, actionable feedback when the handoff draft cannot be prepared. */
  prepareError: string;
}

export const PLATFORM_EXPLORER_COPY: Record<Locale, PlatformExplorerCopy> = {
  zh: {
    label: '平台风格对照',
    title: '同一段合成对话，对照各平台聊天风格。',
    lede: '选一个平台风格，画面只换皮肤：人物、台词与时间保持不变。预览内容全部为合成虚构文本。',
    selectLabel: '选择平台风格',
    previewLabel: '所选平台的合成对话预览',
    chatTag: '聊天风格',
    dmTag: '私信 / 对话风格',
    styleNote: '合成虚构对话的聊天风格预览。',
    dmNote: '合成私信 / 对话风格预览，不是帖子或发布接口。',
    continueLabel: '用这个风格继续创作',
    prepareError: '未能准备创作草稿，选择和预览已保留，请重试。',
  },
  en: {
    label: 'Platform styles',
    title: 'One synthetic conversation, compared across platform chat styles.',
    lede: 'Pick a platform style: only the skin changes while people, lines and times stay fixed. Every preview line is synthetic, fictional content.',
    selectLabel: 'Choose a platform style',
    previewLabel: 'Synthetic conversation preview for the selected platform',
    chatTag: 'Chat style',
    dmTag: 'DM / chat style',
    styleNote: 'Synthetic fictional conversation in a chat style.',
    dmNote: 'Synthetic DM / conversation style preview - not posts, not publishing.',
    continueLabel: 'Continue with this style',
    prepareError: 'Could not prepare the creation draft. Your selection and preview are kept - please retry.',
  },
};

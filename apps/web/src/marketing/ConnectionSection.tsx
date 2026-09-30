import { useState, type ReactNode } from 'react';
import { IconArrowUpRight, IconBrandOpenai, IconCheck, IconCopy } from '@tabler/icons-react';
import { useLocale } from './LocaleContext';
import './connection.css';

export const STARTER_PROMPTS = {
  zh: '用 IMStage 制作一段合成的新品发布群聊样本：三位同事讨论发布文案和上线时间。生成可编辑的合成聊天场景，并给我带「AI生成 / 虚构」标识的 PNG 和网站编辑链接。',
  en: 'Use IMStage to author a synthetic product-launch group chat sample. Three teammates discuss the announcement and launch time. Make an editable synthetic scene and give me a PNG with the fixed AI-generated / fictional label plus a link to edit it on the website.',
};

/** The visible artwork is an authored example using the shared scene renderer. */
export default function ConnectionSection({ preview }: { preview: ReactNode }) {
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) throw new Error('clipboard unavailable');
      await clipboard.writeText(STARTER_PROMPTS[locale]);
      setCopied(true); setMessage(zh ? '示例指令已复制。连接后粘贴到 ChatGPT。' : 'Prompt copied. Paste it into ChatGPT after connecting.');
    } catch {
      setCopied(false); setMessage(zh ? '无法自动复制，请选中上面的指令复制。' : 'Select the prompt above and copy it manually.');
    }
  }
  return <section className="mark-section connect-feature" id="chatgpt" aria-labelledby="connect-feature-title">
    <div className="mark-shell connect-feature-layout">
      <div className="connect-feature-copy">
        <IconBrandOpenai size={36} stroke={1.5} aria-hidden="true" />
        <h2 id="connect-feature-title">{zh ? '连接 ChatGPT，用一句话创作和修改合成聊天场景。' : 'Connect ChatGPT. Author and edit synthetic chat scenes with one sentence.'}</h2>
        <p className="mark-lede">{zh ? '连接一次，描述需要的测试样本。继续聊、继续改，把合成样本带回 IMStage。' : 'Connect once. Describe the test sample you need, refine it in conversation, and bring the synthetic scene back to IMStage.'}</p>
        <blockquote className="connect-prompt">{STARTER_PROMPTS[locale]}</blockquote>
        <div className="connect-feature-actions">
          <a href="#/connect" className="mark-btn">{zh ? '连接 ChatGPT' : 'Connect ChatGPT'}<IconArrowUpRight size={18} aria-hidden="true" /></a>
          <button type="button" className="connect-copy" onClick={() => void copy()}>{copied ? <IconCheck size={17} aria-hidden="true" /> : <IconCopy size={17} aria-hidden="true" />}{zh ? '复制示例指令' : 'Copy starter prompt'}</button>
        </div>
        <p className="connect-caption">{zh ? '首次使用需在 ChatGPT 手动添加 IMStage 并授权。' : 'First use: add IMStage in ChatGPT manually and authorize.'}</p>
        <p className="connect-feedback" role="status">{message}</p>
      </div>
      <figure className="connect-feature-art">{preview}<figcaption>{zh ? '产品发布 · 合成测试样本示例' : 'Product launch · synthetic test-sample example'}</figcaption></figure>
      <div className="connect-feature-flow" aria-label={zh ? '创作流程' : 'Creation flow'}>
        <span>{zh ? '说出想法' : 'Describe your idea'}</span><span aria-hidden="true">→</span><span>{zh ? '在对话里修改' : 'Refine in conversation'}</span><span aria-hidden="true">→</span><span>{zh ? '下载，或继续创作' : 'Download or keep creating'}</span>
      </div>
    </div>
  </section>;
}

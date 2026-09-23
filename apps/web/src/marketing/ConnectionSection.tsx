import { useState, type ReactNode } from 'react';
import { IconArrowUpRight, IconBrandOpenai, IconCheck, IconCopy } from '@tabler/icons-react';
import { useLocale } from './LocaleContext';
import './connection.css';

export const STARTER_PROMPTS = {
  zh: '用 IMStage 制作一段新品发布的群聊：三位同事讨论发布文案和上线时间。生成可编辑的聊天画面，并给我 PNG 和网站编辑链接。',
  en: 'Use IMStage to create a product launch group chat. Three teammates discuss the announcement and launch time. Make an editable scene and give me a PNG and a link to edit it on the website.',
};

/** The visible artwork is an authored example using the shared scene renderer. */
export default function ConnectionSection({ preview }: { preview: ReactNode }) {
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(STARTER_PROMPTS[locale]);
      setCopied(true); setMessage(zh ? '示例指令已复制。连接后粘贴到 ChatGPT。' : 'Prompt copied. Paste it into ChatGPT after connecting.');
    } catch {
      setCopied(false); setMessage(zh ? '无法自动复制，请选中上面的指令复制。' : 'Select the prompt above and copy it manually.');
    }
  }
  return <section className="mark-section connect-feature" id="chatgpt" aria-labelledby="connect-feature-title">
    <div className="mark-shell connect-feature-layout">
      <div className="connect-feature-copy">
        <IconBrandOpenai size={36} stroke={1.5} aria-hidden="true" />
        <h2 id="connect-feature-title">{zh ? <>你的下一张作品，<br />从 ChatGPT 开始。</> : <>Your next scene.<br />Starting in ChatGPT.</>}</h2>
        <p className="mark-lede">{zh ? '连接一次，说出你的想法。继续聊、继续改，把作品带回 IMStage。' : 'Connect once. Describe your idea, refine it in conversation, and bring the scene back to IMStage.'}</p>
        <blockquote className="connect-prompt">{STARTER_PROMPTS[locale]}</blockquote>
        <div className="connect-feature-actions">
          <a href="#/connect" className="mark-btn">{zh ? '在 ChatGPT 中使用' : 'Use in ChatGPT'}<IconArrowUpRight size={18} aria-hidden="true" /></a>
          <button type="button" className="connect-copy" onClick={() => void copy()}>{copied ? <IconCheck size={17} aria-hidden="true" /> : <IconCopy size={17} aria-hidden="true" />}{zh ? '复制示例指令' : 'Copy starter prompt'}</button>
        </div>
        <p className="connect-caption">{zh ? '首次使用需在 ChatGPT 添加连接并授权。' : 'First time? Add the connection in ChatGPT and authorize your account.'}</p>
        <p className="connect-feedback" role="status">{message}</p>
      </div>
      <figure className="connect-feature-art">{preview}<figcaption>{zh ? '产品发布 · 合成场景示例' : 'Product launch · Authored scene example'}</figcaption></figure>
      <div className="connect-feature-flow" aria-label={zh ? '创作流程' : 'Creation flow'}>
        <span>{zh ? '说出想法' : 'Describe your idea'}</span><span aria-hidden="true">→</span><span>{zh ? '在对话里修改' : 'Refine in conversation'}</span><span aria-hidden="true">→</span><span>{zh ? '下载，或继续创作' : 'Download or keep creating'}</span>
      </div>
    </div>
  </section>;
}

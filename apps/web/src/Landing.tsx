import { useEffect, useRef, useState } from 'react';
import { IconArrowUpRight, IconArrowRight, IconCheck, IconCopy, IconMessageCircle, IconPlus, IconArrowDown, IconAdjustmentsHorizontal, IconDownload, IconBraces, IconPhoto, IconArrowBackUp, IconWorld, IconPlugConnected, IconBrandGithub } from '@tabler/icons-react';
import { Mark, LinkButton, TemplateCard, templates, github } from './components';
import PromptStudio from './create/PromptStudio';

function PrecisionSection() {
  const [value, setValue] = useState('好啊，这次不赶路，只看海。');
  return <section className="precision-section section-shell" id="details"><div className="precision-copy"><span className="section-label">创作自由，也有精确控制</span><h2>大的故事。<br />小到一句话的掌控。</h2><p>不用为了改几个字，重新做一张图。<br />人物、台词、时间，都可以单独编辑。</p><a className="text-link" href="#/studio">把细节交给你 <IconArrowUpRight size={17} /></a></div><div className="precision-demo"><div className="precision-demo-bar"><span><IconAdjustmentsHorizontal size={16} /> 消息细节</span><span>试着改一改</span></div><label htmlFor="precision-text">阿远的回复</label><textarea id="precision-text" maxLength={100} value={value} onChange={e => setValue(e.target.value)} /><div className="precision-flow"><span /><IconArrowDown size={19} /><span /></div><div className="precision-bubble" aria-live="polite">{value || '等待你写下这句台词…'}</div><div className="precision-meta"><span><IconCheck size={14} /> 仅修改这条消息</span><button onClick={() => setValue('好啊，这次不赶路，只看海。')}><IconArrowBackUp size={14} />重置</button></div></div></section>;
}
function OpenSection() {
  const [tab, setTab] = useState('scene');
  const data = tab === 'scene' ? '{\n  "title": "周末出逃计划",\n  "platform": "wechat",\n  "messages": [\n    {\n      "id": "message-02",\n      "text": "这次不赶路，只看海。"\n    }\n  ]\n}' : '// 规划中的共同路径\n\n你的 Web 场景\n       ↓\n   结构化对话\n       ↓\n 确定性渲染器\n       ↓\n  PNG · API · MCP';
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  async function copy() { try { await navigator.clipboard.writeText(data); setCopied(true); setCopyError(''); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1800); } catch { setCopyError('复制不可用，请选中代码后手动复制。'); } }
  return <section className="open-section section-shell" id="open-source"><div className="open-copy"><IconBraces size={34} stroke={1.3} /><h2>你的作品，<br />不止属于一个页面。</h2><p>场景是可编辑的数据，也是可以带走的作品。<br />开源，让创作有更多可能。</p><div className="integration-list"><a href="#/studio"><IconWorld size={20} /><div><strong>浏览器工作台</strong><span>本地编辑、保存与导出</span></div><span className="available-tag">可体验</span><IconArrowUpRight size={17} /></a><a href="#/docs?tab=mcp"><IconPlugConnected size={20} /><div><strong>MCP / API</strong><span>同一个场景，融入你的工具链</span></div><span className="planned-tag">规划中</span><IconArrowUpRight size={17} /></a></div><a className="text-link" href={github} target="_blank" rel="noreferrer"><IconBrandGithub size={17} />在 GitHub 一起构建 <IconArrowUpRight size={15} /></a></div><div className="code-window"><div className="code-tabs"><div role="group" aria-label="数据展示"><button aria-pressed={tab === 'scene'} onClick={() => setTab('scene')}>scene.json</button><button aria-pressed={tab === 'flow'} onClick={() => setTab('flow')}>共同渲染路径</button></div><button className="icon-btn" onClick={copy} aria-label={copied ? '已复制' : '复制示例'}>{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}</button></div><pre><code>{data}</code></pre><div className="code-footer"><span role="status">{copyError || (copied ? '已复制到剪贴板' : '格式示意 · 当前字段以工作台导出为准')}</span><IconBraces size={16} /></div></div></section>;
}
const faqs = [
  ['现在可以用 IMStage 做什么？', '可以从合成示例创建场景，修改人物、消息和时间，上传本地图片，切换平台风格，保存浏览器草稿并导出 PNG。进入创作台后可用 Agent 从描述或截图生成、继续编辑聊天；自托管实例需配置模型。首页火星故事是固定交互示例。'],
  ['聊天画面和真实 App 一样吗？', '目前提供微信、小红书等风格预览，尚未完成针对具体 App 版本的像素校准。我们会用经过授权的真实截图逐个校准字体、间距和消息状态；当前请用于设计、教学和虚构叙事。'],
  ['我的素材会传到哪里？', '示例和手动编辑在浏览器本地处理。在 Agent 创作台提交时，描述、当前对话与参考截图会发送到配置的模型；配图需求发送到独立图片服务。草稿保存在当前浏览器，清理网站数据会删除草稿，重要内容请导出 JSON 或图片备份。'],
  ['开源、免费和托管有什么区别？', '代码采用 MIT 许可。Web 免费是产品方向，当前本地编辑功能不收费；托管 MCP/API、AI 额度与价格尚未上线，也不会在这个页面收取费用。'],
  ['可以导出长截图吗？', '可以。普通截图是默认选项；在工作台切换为完整长图后，导出会包含完整对话。水印默认关闭，也可以自定义。'],
];
function FAQ() { return <section className="faq-section section-shell"><div><h2>开始之前，<br />你可能想知道。</h2><p>把边界讲清楚，创作更放心。</p></div><div className="faq-list">{faqs.map(([q, a]) => <details key={q}><summary>{q}<IconPlus size={19} /></summary><p>{a}</p></details>)}</div></section>; }
export function Home() {
  return <><section className="hero prompt-hero section-shell"><div className="hero-heading"><div className="eyebrow"><span className="eyebrow-rule" />开源的聊天场景创作工具<span className="eyebrow-rule" /></div><h1><span>一句话，</span><span className="accent-text">聊到想象之外。</span></h1><p>写下场景，让人物、对话、定位和照片一起出现。<br className="desktop-break" />从一句脑洞，开始你的下一张作品。</p></div><PromptStudio embedded /><div className="hero-foot"><span>设计演示</span><span>故事创作</span><span>沟通教学</span><span>合成评测</span></div></section>
    <section className="gallery-section section-shell"><div className="section-heading"><span className="section-label">给灵感一个开场</span><h2>日常的对话，<br className="mobile-break" />也可以很有戏。</h2><p>从一个场景出发，写出属于你的版本。</p></div><div className="template-grid">{templates.slice(0, 2).map((template, index) => <TemplateCard key={template.id} template={template} index={index} />)}</div><a className="gallery-all text-link" href="#/templates">看看所有场景 <IconArrowRight size={17} /></a></section>
    <PrecisionSection /><section className="feature-strip section-shell"><article><IconMessageCircle size={25} stroke={1.5} /><h3>每个角色，都有自己的声音</h3><p>单聊或群聊，独立设置人物与台词。</p></article><article><IconPhoto size={25} stroke={1.5} /><h3>放进你的素材</h3><p>图片和地点，让情节多一点真实感。</p></article><article><IconDownload size={25} stroke={1.5} /><h3>把完整故事带走</h3><p>一屏截图或长图，自由选择输出方式。</p></article></section>
    <OpenSection /><FAQ /><section className="closing section-shell"><Mark /><h2>下一段故事，<br />等你开场。</h2><LinkButton href="#/create">打开你的创作台 <IconArrowUpRight size={18} /></LinkButton></section></>;
}

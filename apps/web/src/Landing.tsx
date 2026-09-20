import { useEffect, useRef, useState } from 'react';
import { IconArrowUpRight, IconArrowRight, IconCheck, IconCopy, IconMessageCircle, IconPlus, IconArrowDown, IconAdjustmentsHorizontal, IconDownload, IconBraces, IconPhoto, IconArrowBackUp, IconChevronRight, IconWorld, IconPlayerPlay, IconPlugConnected, IconBrandGithub } from '@tabler/icons-react';
import { Mark, LinkButton, TemplateCard, templates, github } from './components';
import { SceneView } from './studio/SceneView';
import { createScene } from './studio/model';

function LiveStage() {
  const [scene, setScene] = useState(() => { const scene = createScene('weekend'); scene.date = '周五 17:30'; scene.messages = scene.messages.slice(0, 3).map((m, i) => ({ ...m, time: '', text: ['明天，去有海的地方？', '好啊。把周末还给自己。', '东极岛 · 示意地点'][i] })); return scene; });
  const [edited, setEdited] = useState(false);
  function rewrite() {
    setScene(current => ({ ...current, messages: current.messages.map((m, i) => i === 1 ? { ...m, text: edited ? '好啊。把周末还给自己。' : '好啊，这次不赶路，只看海。' } : m) })); setEdited(!edited);
  }
  return <div className="live-stage" id="live-stage">
    <div className="stage-toolbar"><div className="stage-file"><Mark /><span>周末出逃计划</span><IconChevronRight size={13} /><span className="subtle">场景预览</span></div><span className="stage-status"><span />可以直接试改</span></div>
    <div className="stage-content"><div className="story-panel">
      <div className="story-heading"><IconMessageCircle size={19} /><span>好故事，从一句话开始</span></div>
      <div className="story-prompt"><span className="quote-mark">“</span><p>约一个朋友，<br />去有海的地方过周末。</p><span className="prompt-person"><span className="mini-avatar">我</span>你的故事</span></div>
      <div className="story-response"><Mark /><div><strong>故事已经有了开场。</strong><p>两个人，一次邀约，还有一个目的地。<br />现在，给它加一点你的语气。</p></div></div>
      <button className="rewrite-button" onClick={rewrite}><IconAdjustmentsHorizontal size={16} />{edited ? '恢复原来的说法' : '让回复更有松弛感'}<IconArrowRight size={16} /></button>
      <p className="stage-feedback" aria-live="polite">{edited ? '已替换第 2 条消息，其他内容保持原样。' : '点击试试，右侧这句回复会跟着变化。'}</p>
      <div className="stage-steps" aria-label="创作流程"><span className={!edited ? 'active' : ''}>写下故事</span><IconChevronRight size={12} /><span className={edited ? 'active' : ''}>打磨细节</span><IconChevronRight size={12} /><a href="#/studio?template=weekend">导出画面 <IconArrowUpRight size={12} /></a></div>
    </div><div className="output-panel"><div className="output-top"><div className="platform-switch" role="group" aria-label="预览平台">{([['wechat', '微信'], ['xiaohongshu', '小红书']] as const).map(([platform, name]) => <button key={platform} aria-pressed={scene.platform === platform} onClick={() => setScene({ ...scene, platform })}>{name}</button>)}</div><span>风格预览</span></div>
      <div className="hero-device"><SceneView scene={scene} /></div>
      <div className="output-bottom"><span><IconCheck size={14} /> 同一份内容，换一种表达</span><a href="#/studio?template=weekend" aria-label="在工作台继续编辑周末出逃计划"><IconArrowUpRight size={18} /></a></div>
    </div></div>
  </div>;
}
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
  ['现在可以用 IMStage 做什么？', '可以从合成示例创建场景，修改人物、消息和时间，上传本地图片，切换平台风格，保存浏览器草稿并导出 PNG。自然语言生成和截图识别还未接入。'],
  ['聊天画面和真实 App 一样吗？', '目前提供微信、小红书等风格预览，尚未完成针对具体 App 版本的像素校准。我们会用经过授权的真实截图逐个校准字体、间距和消息状态；当前请用于设计、教学和虚构叙事。'],
  ['我的素材会传到哪里？', '本轮工作台在浏览器本地处理内容，没有把图片或对话上传到服务器。草稿保存在当前浏览器，清理网站数据会删除草稿，重要内容请导出 JSON 或图片备份。'],
  ['开源、免费和托管有什么区别？', '代码采用 MIT 许可。Web 免费是产品方向，当前本地编辑功能不收费；托管 MCP/API、AI 额度与价格尚未上线，也不会在这个页面收取费用。'],
  ['可以导出长截图吗？', '可以。普通截图是默认选项；在工作台切换为完整长图后，导出会包含完整对话。水印默认关闭，也可以自定义。'],
];
function FAQ() { return <section className="faq-section section-shell"><div><h2>开始之前，<br />你可能想知道。</h2><p>把边界讲清楚，创作更放心。</p></div><div className="faq-list">{faqs.map(([q, a]) => <details key={q}><summary>{q}<IconPlus size={19} /></summary><p>{a}</p></details>)}</div></section>; }
export function Home() {
  return <><section className="hero section-shell"><div className="hero-heading"><div className="eyebrow"><span className="eyebrow-rule" />开源的聊天场景创作工具<span className="eyebrow-rule" /></div><h1><span>让对话，</span><span className="accent-text">成为作品。</span></h1><p>从脑海中的一个故事，到一张恰到好处的聊天画面。<br className="desktop-break" />编排人物与台词，让每个细节都听你的。</p><div className="hero-actions"><LinkButton href="#/studio">开始创作 <IconArrowUpRight size={18} /></LinkButton><LinkButton href="#/templates" secondary><IconPlayerPlay size={16} />寻找场景灵感</LinkButton></div></div><LiveStage /><div className="hero-foot"><span>设计演示</span><span>故事创作</span><span>沟通教学</span><span>合成评测</span></div></section>
    <section className="gallery-section section-shell"><div className="section-heading"><span className="section-label">给灵感一个开场</span><h2>日常的对话，<br className="mobile-break" />也可以很有戏。</h2><p>从一个场景出发，写出属于你的版本。</p></div><div className="template-grid">{templates.slice(0, 2).map((template, index) => <TemplateCard key={template.id} template={template} index={index} />)}</div><a className="gallery-all text-link" href="#/templates">看看所有场景 <IconArrowRight size={17} /></a></section>
    <PrecisionSection /><section className="feature-strip section-shell"><article><IconMessageCircle size={25} stroke={1.5} /><h3>每个角色，都有自己的声音</h3><p>单聊或群聊，独立设置人物与台词。</p></article><article><IconPhoto size={25} stroke={1.5} /><h3>放进你的素材</h3><p>图片和地点，让情节多一点真实感。</p></article><article><IconDownload size={25} stroke={1.5} /><h3>把完整故事带走</h3><p>一屏截图或长图，自由选择输出方式。</p></article></section>
    <OpenSection /><FAQ /><section className="closing section-shell"><Mark /><h2>下一段故事，<br />等你开场。</h2><LinkButton href="#/studio">打开你的创作台 <IconArrowUpRight size={18} /></LinkButton></section></>;
}

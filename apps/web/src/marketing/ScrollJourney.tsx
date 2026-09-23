import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { IconArrowDown, IconArrowUpRight, IconDownload, IconMaximize, IconPencil } from '@tabler/icons-react';
import { SceneView } from '../studio/SceneView';
import type { Scene } from '../studio/model';
import { ScaledSceneFrame } from './DeviceFrame';
import type { Locale } from './locale';
import type { DemoAvatars } from './portable';
import './journey.css';

const COPY = {
  zh: {
    labels: ['从一句话开始', '每一处都能改', '从一张到一组'],
    title: ['让对话，', '有画面。'], promise: '写下情节。AI 生成对话、人物与照片。',
    scroll: '向下探索', steps: '对话 → 编辑 → 系列',
    editTitle: ['刚好的停顿。', '你想要的语气。'], editBody: '点选消息，直接修改。人物、照片与样式也可以继续交给 AI。',
    editLabel: '改一句，画面随之改变', edited: '已在画面中更新',
    variantsTitle: ['同一个设定。', '不同的故事。'], variantsBody: '共同设定留在项目里。每一条，只改人物、照片或情节。',
    rows: [['苏晚', '武康路 · 路人抓拍'], ['阿禾', '见面前 · 发张自拍'], ['林森', '初次见面 · 认个人']],
    reply: ['看见你了。别动，我过来。', '我点好咖啡了，靠窗的位置。', '票拿到了，我们门口见。'],
    project: '打开 Project', editAction: '在工作台继续',
    demo: '虚构人物 · AI 合成示例', photo: '查看示例照片', export: '导出 PNG',
    select: '点选消息', selected: '正在编辑', example: '变体示例',
  },
  en: {
    labels: ['Start with a line', 'Make it yours', 'Turn one into many'],
    title: ['Conversations,', 'with a scene.'], promise: 'Describe the moment. AI writes the dialogue and creates the imagery.',
    scroll: 'Scroll to explore', steps: 'Create → Refine → Vary',
    editTitle: ['The right pause.', 'Your kind of voice.'], editBody: 'Select a message and change it. Ask AI to refine people, photos and the details around them.',
    editLabel: 'Change a line. See it in the scene.', edited: 'Updated in the scene',
    variantsTitle: ['One premise.', 'Different stories.'], variantsBody: 'Keep the premise in a project. Change the people, photos or plot of each story.',
    rows: [['Su Wan', 'Wukang Road · A candid photo'], ['Ava', 'Before we meet · A selfie'], ['Noah', 'First meeting · A familiar face']],
    reply: ['I see you. Stay right there, I am on my way.', 'Coffee is ready. I found a window seat.', 'Got the tickets. Meet you at the entrance.'],
    project: 'Open a Project', editAction: 'Continue in the workspace',
    demo: 'Fictional people · AI-made example', photo: 'View the example photo', export: 'Export PNG',
    select: 'Select a message', selected: 'Editing', example: 'Example variation',
  },
} as const;

interface Props {
  locale: Locale;
  scene: Scene;
  avatars: DemoAvatars | null;
  composer: ReactNode;
  assetStatus: ReactNode;
  onChange: (scene: Scene) => void;
  onContinue: (event: MouseEvent<HTMLAnchorElement>, scene: Scene) => void;
  continueHref: string;
  onPhoto: () => void;
  onExport: () => void;
  exportDisabled: boolean;
  photoReady: boolean;
}

/** An authored, scroll-directed scene. It never calls a provider. */
export function ScrollJourney({ locale, scene, avatars, composer, assetStatus, onChange, onContinue, continueHref, onPhoto, onExport, exportDisabled, photoReady }: Props) {
  const copy = COPY[locale];
  const root = useRef<HTMLDivElement>(null);
  const [chapter, setChapter] = useState(0);
  const [variant, setVariant] = useState(0);
  const [selected, setSelected] = useState('');
  const [edited, setEdited] = useState(false);
  const editInput = useRef<HTMLTextAreaElement>(null);
  const otherId = scene.participants.find(person => person.id !== scene.selfId)?.id;
  const lastText = scene.messages.filter(message => message.type === 'text').at(-1);
  const selectedMessage = scene.messages.find(message => message.id === selected && message.type === 'text') ?? lastText;

  useEffect(() => {
    setSelected(''); setEdited(false); setVariant(0);
  }, [locale]);

  useEffect(() => {
    const host = root.current;
    if (!host || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<number, boolean>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) visible.set(Number((entry.target as HTMLElement).dataset.chapter), entry.isIntersecting);
      const active = [...visible].filter(([, shown]) => shown).map(([index]) => index);
      if (active.length) setChapter(Math.max(...active));
    }, { rootMargin: '-18% 0px -42% 0px', threshold: 0 });
    host.querySelectorAll('[data-chapter]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  const variants = useMemo(() => copy.rows.map((row, index): Scene => ({
    ...scene, id: `${scene.id}-demo-${index}`, title: row[0],
    participants: scene.participants.map(person => person.id === otherId ? {
      ...person, name: row[0], avatar: index === 1 ? avatars?.ava : index === 2 ? avatars?.yuan : person.avatar,
    } : person),
    messages: scene.messages.map(message => index > 0 && message.id === 'm2' ? { ...message, text: locale === 'zh' ? '我到了。发张照片，你就能认出我了。' : 'I’m here. Sending a photo so you can spot me.' } : index > 0 && message.id === 'm3' ? { ...message, text: locale === 'zh' ? '就是我。你到了吗？' : 'That’s me. Are you here yet?' } : message.id === lastText?.id ? { ...message, text: copy.reply[index] } :
      message.type === 'image' && index > 0 ? { ...message, asset: index === 1 ? avatars?.ava : avatars?.yuan } : message),
  })), [scene, avatars, otherId, lastText?.id, copy, locale]);
  const selectedScene = chapter === 2 ? variants[variant] : scene;
  const visibleScene = { ...selectedScene, messages: selectedScene.messages.filter(message => message.type !== 'image' || Boolean(message.asset)) };

  function selectMessage(id: string) {
    const message = scene.messages.find(item => item.id === id);
    if (message?.type === 'image') { if (photoReady) onPhoto(); return; }
    if (message?.type !== 'text') return;
    setSelected(id);
    document.getElementById('journey-edit')?.scrollIntoView({ behavior: 'auto', block: 'center' });
    editInput.current?.focus({ preventScroll: true });
  }

  return <div className="journey" ref={root} data-journey-step={chapter}>
    <div className="journey-copy">
      <section className="journey-chapter journey-intro" data-chapter="0" aria-labelledby="mark-hero-title">
        <p className="journey-index">01 <span>/</span> {copy.labels[0]}</p>
        <h1 id="mark-hero-title">{copy.title[0]}<br /><em>{copy.title[1]}</em></h1>
        <p className="journey-promise">{copy.promise}</p>
        {composer}
        <a href="#journey-edit" className="journey-scroll" onClick={event => { event.preventDefault(); document.getElementById('journey-edit')?.scrollIntoView({ behavior: 'auto' }); }}><IconArrowDown size={14} aria-hidden="true" />{copy.scroll}<span>{copy.steps}</span></a>
      </section>
      <section className="journey-chapter" id="journey-edit" data-chapter="1" aria-labelledby="journey-edit-title">
        <p className="journey-index">02 <span>/</span> {copy.labels[1]}</p>
        <h2 id="journey-edit-title">{copy.editTitle[0]}<br />{copy.editTitle[1]}</h2>
        <p className="journey-description">{copy.editBody}</p>
        <div className="journey-edit-field">
          <label htmlFor="journey-line"><IconPencil size={14} aria-hidden="true" />{copy.editLabel}</label>
          <textarea id="journey-line" ref={editInput} value={selectedMessage?.text ?? ''} maxLength={240} rows={3} onChange={event => {
            if (!selectedMessage) return;
            onChange({ ...scene, messages: scene.messages.map(message => message.id === selectedMessage.id ? { ...message, text: event.target.value } : message) });
            setEdited(true);
          }} />
          <span role="status">{edited ? copy.edited : '\u00a0'}</span>
        </div>
        <div className="journey-mobile-preview"><ScaledSceneFrame label={copy.selected}><SceneView scene={scene} locale={locale} exportMode /></ScaledSceneFrame></div>
        <a href={continueHref} className="journey-text-action" onClick={event => onContinue(event, scene)}>{copy.editAction}<IconArrowUpRight size={16} aria-hidden="true" /></a>
      </section>
      <section className="journey-chapter" id="journey-projects" data-chapter="2" aria-labelledby="journey-project-title">
        <p className="journey-index">03 <span>/</span> {copy.labels[2]}</p>
        <h2 id="journey-project-title">{copy.variantsTitle[0]}<br />{copy.variantsTitle[1]}</h2>
        <p className="journey-description">{copy.variantsBody}</p>
        <div className="journey-variants" role="group" aria-label={copy.example}>
          {copy.rows.map((row, index) => <button key={row[0]} type="button" aria-pressed={variant === index} onClick={() => { setVariant(index); setChapter(2); }}>
            <span className="journey-row-number">0{index + 1}</span><strong>{row[0]}</strong><span>{row[1]}</span><IconArrowUpRight size={14} aria-hidden="true" />
          </button>)}
        </div>
        <div className="journey-mobile-preview"><ScaledSceneFrame label={copy.example}><SceneView scene={variants[variant]} locale={locale} exportMode /></ScaledSceneFrame></div>
        <a href={continueHref} className="journey-text-action journey-mobile-action" onClick={event => onContinue(event, variants[variant])}>{copy.editAction}<IconArrowUpRight size={16} aria-hidden="true" /></a>
        <a href={`#/projects?lang=${locale}`} className="journey-text-action">{copy.project}<IconArrowUpRight size={16} aria-hidden="true" /></a>
      </section>
    </div>
    <aside className="journey-scene" aria-label={copy.demo}>
      <div className="journey-sticky">
        <div className="journey-stage">
          <div className="journey-paper journey-paper-back" aria-hidden="true"><ScaledSceneFrame><SceneView scene={variants[1]} locale={locale} exportMode /></ScaledSceneFrame></div>
          <div className="journey-paper journey-paper-far" aria-hidden="true"><ScaledSceneFrame><SceneView scene={variants[2]} locale={locale} exportMode /></ScaledSceneFrame></div>
          <div className="journey-device">
            <ScaledSceneFrame label={copy.demo}><SceneView scene={visibleScene} locale={locale} selectedId={chapter === 1 ? selectedMessage?.id : undefined} onSelect={chapter === 2 ? undefined : selectMessage} /></ScaledSceneFrame>
          </div>
          <span className="journey-annotation"><IconPencil size={13} aria-hidden="true" />{chapter === 2 ? `${copy.example} ${variant + 1}/3` : chapter === 1 ? copy.selected : copy.select}</span>
        </div>
        <p className="journey-chapter-note" aria-hidden="true"><span>{`0${chapter + 1} / 03`}</span>{copy.labels[chapter]}</p>
        <div className="journey-caption"><span>{copy.demo}</span><div>
          {chapter === 2 ? <a href={continueHref} className="journey-text-action" onClick={event => onContinue(event, visibleScene)}>{copy.editAction}<IconArrowUpRight size={14} /></a> : <><button type="button" aria-label={copy.photo} title={copy.photo} onClick={onPhoto} disabled={!photoReady}><IconMaximize size={15} /></button>
          <button type="button" aria-label={copy.export} title={copy.export} onClick={onExport} disabled={exportDisabled} data-testid="hero-export"><IconDownload size={15} /></button></>}
        </div></div>
        <div className="journey-assets">{assetStatus}</div>
      </div>
    </aside>
  </div>;
}

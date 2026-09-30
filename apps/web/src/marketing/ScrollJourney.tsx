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
    labels: ['给出固定上下文', '按需修改措辞', '生成可控变体'],
    title: ['合成对话，', '用于测试与评测。'], promise: '描述固定上下文，生成可对照的合成样本。',
    scroll: '向下探索', steps: '构建 → 修改 → 变体',
    editTitle: ['固定上下文。', '受控的措辞修改。'], editBody: '点选消息，直接修改。人物、措辞与样式也可以继续交给 AI。',
    editLabel: '改一句，画面随之改变', edited: '已在画面中更新',
    variantsTitle: ['同一个设定。', '不同回答的样本。'], variantsBody: '共同设定留在项目里。每一条只改回答或人物，用来生成可对照的合成评测样本。',
    rows: [['样本 A', '同一上下文 · 回答 A'], ['样本 B', '同一上下文 · 回答 B'], ['样本 C', '同一上下文 · 回答 C']],
    reply: ['好呀，谢谢。周五中午前我确认。', '可以，我周五中午前给答复。', '好的，我周五确认后同步结果。'],
    project: '打开 Project', editAction: '在工作台继续',
    demo: '虚构人物 · AI 合成示例', photo: '查看示例照片', export: '导出 PNG',
    select: '点选消息', selected: '正在编辑', example: '变体示例',
  },
  en: {
    labels: ['Fix the context', 'Adjust the wording', 'Generate controlled variants'],
    title: ['Synthetic conversations,', 'for tests & evaluation.'], promise: 'Describe the fixed context. Generate comparable synthetic samples.',
    scroll: 'Scroll to explore', steps: 'Build → Refine → Vary',
    editTitle: ['Fixed context.', 'Controlled wording edits.'], editBody: 'Select a message and change it. Ask AI to refine the people, the wording and the details around them.',
    editLabel: 'Change a line. See it in the scene.', edited: 'Updated in the scene',
    variantsTitle: ['One premise.', 'Samples with different replies.'], variantsBody: 'Keep the premise in a project. Change the reply or the people to produce comparable synthetic evaluation samples.',
    rows: [['Sample A', 'Same context · reply A'], ['Sample B', 'Same context · reply B'], ['Sample C', 'Same context · reply C']],
    reply: ['Yes, thanks. I’ll confirm by Friday noon.', 'Sure — I’ll reply before Friday noon.', 'OK, I’ll confirm on Friday and share the result.'],
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
    messages: scene.messages.map(message => index > 0 && message.id === 'm2' ? { ...message, text: locale === 'zh' ? '我周五之前给你一个确定的答复。' : 'I’ll give you a definite reply before Friday.' } : index > 0 && message.id === 'm3' ? { ...message, text: locale === 'zh' ? '好，那就先这样约定。' : 'Alright, that works for now.' } : message.id === lastText?.id ? { ...message, text: copy.reply[index] } :
      message.type === 'image' && index > 0 ? { ...message, asset: index === 1 ? avatars?.ava : avatars?.yuan } : message),
  })), [scene, avatars, otherId, lastText?.id, copy, locale]);
  const selectedScene = chapter === 2 ? variants[variant] : scene;
  const visibleScene = { ...selectedScene, messages: selectedScene.messages.filter(message => message.type !== 'image' || Boolean(message.asset)) };
  const sceneHasImage = visibleScene.messages.some(message => message.type === 'image');

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
          {chapter === 2 ? <a href={continueHref} className="journey-text-action" onClick={event => onContinue(event, visibleScene)}>{copy.editAction}<IconArrowUpRight size={14} /></a> : <>{sceneHasImage && <button type="button" aria-label={copy.photo} title={copy.photo} onClick={onPhoto} disabled={!photoReady}><IconMaximize size={15} /></button>}
          <button type="button" aria-label={copy.export} title={copy.export} onClick={onExport} disabled={exportDisabled} data-testid="hero-export"><IconDownload size={15} /></button></>}
        </div></div>
        <div className="journey-assets">{assetStatus}</div>
      </div>
    </aside>
  </div>;
}

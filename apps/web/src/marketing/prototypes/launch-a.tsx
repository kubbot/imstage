/**
 * Prototype A — Conversation Stage.
 *
 * Journey: one large, asymmetric typographic opening that puts an editable
 * line immediately under the headline. Editing it rewrites the matching
 * message in the real shared SceneView render, so create → edit → export is
 * legible within five seconds. The later section goes deeper on the same
 * scene: name, line and clock, all rendered by the same component.
 *
 * Local visual language: a lit stage. Warm pool of light, tall device,
 * generous vertical rhythm, one scene held up close.
 */
import { useRef, useState } from 'react';
import { IconArrowUpRight, IconDownload, IconPencil, IconRefresh } from '@tabler/icons-react';
import { SceneView } from '../../studio/SceneView';
import { Mark } from '../../components';
import type { Scene } from '../../studio/model';
import { BrandLockup, Cta, LocaleToggle, ThemeToggle, usePrototypeChrome } from './shared';
import {
  COMMENTARY_LINE_ID,
  createScenario,
  EDITABLE_REPLY_ID,
  OTHER_PARTICIPANT_ID,
  setMessageText,
  setParticipantName,
} from './scenes';
import './launch-a.css';

interface Copy {
  brand: string;
  locale: { group: string; zh: string; en: string };
  theme: { group: string; light: string; dark: string; system: string };
  skip: string;
  cta: string;
  ctaSecondary: string;
  eyebrow: string;
  h1a: string;
  h1b: string;
  lede: string;
  editLabel: string;
  editHint: string;
  steps: readonly string[];
  previewLabel: string;
  previewNote: string;
  synthetic: string;
  consoleLabel: string;
  consoleTitleA: string;
  consoleTitleB: string;
  consoleLede: string;
  fields: { person: string; line: string; clock: string };
  personPlaceholder: string;
  linePlaceholder: string;
  clockPlaceholder: string;
  reset: string;
  exportAction: string;
  exporting: string;
  exportDone: string;
  exportFail: string;
  consoleNote: string;
  footerNote: string;
  footerMeta: string;
}

const COPY: Record<'zh' | 'en', Copy> = {
  zh: {
    brand: 'IMStage 首页',
    locale: { group: '界面语言', zh: '中文', en: 'EN' },
    theme: { group: '外观主题', light: '浅色', dark: '深色', system: '跟随系统' },
    skip: '跳到主要内容',
    cta: '打开创作台',
    ctaSecondary: '看看怎么改',
    eyebrow: '开源的聊天场景创作工具',
    h1a: '让对话，',
    h1b: '成为作品。',
    lede: '写下场景，改一句台词，导出属于你的画面。人物、时间、地点，都留在同一条对话里。',
    editLabel: '试着改这句',
    editHint: '改动会立即出现在右侧画面',
    steps: ['写下', '改一句', '导出'],
    previewLabel: '实时预览',
    previewNote: '微信 · 中文',
    synthetic: '合成示例 · 非真实聊天',
    consoleLabel: '细节控制',
    consoleTitleA: '一句话的改动，',
    consoleTitleB: '画面立刻跟上。',
    consoleLede: '名字、台词、时间，可以单独修改，不会打乱其他内容。',
    fields: { person: '对话的人', line: '我说的话', clock: '画面时间' },
    personPlaceholder: '写下名字',
    linePlaceholder: '写下你要说的话',
    clockPlaceholder: '例如 09:41',
    reset: '回到初始',
    exportAction: '导出这张画面',
    exporting: '正在准备图片…',
    exportDone: 'PNG 已导出。',
    exportFail: '导出失败，请重试。',
    consoleNote: '两处画面读取同一份场景：改一处，另一处同步跟上。',
    footerNote: '给每段对话，一个舞台。',
    footerMeta: '原型 A · 对话导演台',
  },
  en: {
    brand: 'IMStage home',
    locale: { group: 'Interface language', zh: '中文', en: 'EN' },
    theme: { group: 'Appearance', light: 'Light', dark: 'Dark', system: 'System' },
    skip: 'Skip to content',
    cta: 'Open the studio',
    ctaSecondary: 'See how editing works',
    eyebrow: 'Open-source conversation staging',
    h1a: 'Turn a conversation',
    h1b: 'into a keepsake.',
    lede: 'Write a scene, rewrite one line, export the frame. People, time and place stay inside the same conversation.',
    editLabel: 'Try rewriting this line',
    editHint: 'Your edit shows up in the preview right away',
    steps: ['Write', 'Edit a line', 'Export'],
    previewLabel: 'Live preview',
    previewNote: 'WhatsApp · English',
    synthetic: 'Synthetic demo · not a real chat',
    consoleLabel: 'Fine control',
    consoleTitleA: 'Change one line,',
    consoleTitleB: 'the frame follows.',
    consoleLede: 'Names, lines and the phone clock can be edited one at a time, without disturbing the rest.',
    fields: { person: 'The other person', line: 'Your line', clock: 'Phone clock' },
    personPlaceholder: 'Write a name',
    linePlaceholder: 'Write your line',
    clockPlaceholder: 'For example 09:41',
    reset: 'Reset',
    exportAction: 'Export this frame',
    exporting: 'Preparing the image…',
    exportDone: 'PNG exported.',
    exportFail: 'Export failed. Please try again.',
    consoleNote: 'Both previews read the same scene — edit one, the other keeps up.',
    footerNote: 'A stage for every conversation.',
    footerMeta: 'Prototype A · Conversation stage',
  },
};

export default function LaunchA() {
  const { locale, setLocale, theme, setTheme } = usePrototypeChrome();
  const copy = COPY[locale];
  const [scene, setScene] = useState<Scene>(() => createScenario('coffee', locale));
  const [sceneLocale, setSceneLocale] = useState(locale);
  const [status, setStatus] = useState('');
  const [exporting, setExporting] = useState(false);
  const consoleDevice = useRef<HTMLDivElement>(null);

  // Switching locale reseeds the scene in the same render, so the platform
  // chrome and the copy never disagree for a frame.
  if (sceneLocale !== locale) {
    setSceneLocale(locale);
    setScene(createScenario('coffee', locale));
    setStatus('');
  }

  const reply = scene.messages.find((message) => message.id === EDITABLE_REPLY_ID)?.text ?? '';
  const selfLine = scene.messages.find((message) => message.id === COMMENTARY_LINE_ID)?.text ?? '';
  const otherName = scene.participants.find((participant) => participant.id === OTHER_PARTICIPANT_ID)?.name ?? '';

  function reset() {
    setScene(createScenario('coffee', locale));
    setStatus('');
  }

  async function exportFrame() {
    if (exporting) return;
    const node = consoleDevice.current?.querySelector<HTMLElement>('.scene-view');
    if (!node) {
      setStatus(copy.exportFail);
      return;
    }
    setExporting(true);
    setStatus(copy.exporting);
    try {
      await document.fonts.ready;
      const { toPng } = await import('html-to-image');
      const dataUrl = await toPng(node, {
        pixelRatio: 3,
        skipFonts: true,
        backgroundColor: getComputedStyle(node).backgroundColor,
      });
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `imstage-prototype-${scene.platform}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      setStatus(copy.exportDone);
    } catch {
      setStatus(copy.exportFail);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="pa">
      <a className="pf-skip" href="#pa-main">
        {copy.skip}
      </a>
      <header className="pf-header">
        <div className="pf-shell pf-header-in">
          <BrandLockup label={copy.brand} />
          <div className="pf-controls">
            <LocaleToggle locale={locale} onChange={setLocale} labels={copy.locale} />
            <ThemeToggle theme={theme} onChange={setTheme} labels={copy.theme} />
            <Cta href="/#/create" small>
              {copy.cta}
              <IconArrowUpRight size={15} />
            </Cta>
          </div>
        </div>
      </header>

      <main id="pa-main" className="pa-main">
        <section className="pf-shell pa-hero">
          <div className="pa-copy">
            <p className="pf-eyebrow">{copy.eyebrow}</p>
            <h1 className="pa-h1">
              <span>{copy.h1a}</span>
              <span className="pa-h1-em">{copy.h1b}</span>
            </h1>
            <p className="pa-lede">{copy.lede}</p>

            <div className="pa-edit">
              <label htmlFor="pa-line">{copy.editLabel}</label>
              <input
                id="pa-line"
                value={reply}
                maxLength={120}
                spellCheck={false}
                onChange={(event) => setScene((current) => setMessageText(current, EDITABLE_REPLY_ID, event.target.value))}
              />
              <p className="pa-edit-hint">
                <IconPencil size={14} stroke={1.7} aria-hidden="true" />
                {copy.editHint}
              </p>
            </div>

            <div className="pa-actions">
              <Cta href="/#/create">
                {copy.cta}
                <IconArrowUpRight size={17} />
              </Cta>
              <Cta href="#pa-details" variant="ghost">
                {copy.ctaSecondary}
              </Cta>
            </div>

            <ol className="pa-steps">
              {copy.steps.map((step, index) => (
                <li key={step} className={index === 1 ? 'is-active' : undefined}>
                  <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          <div className="pa-stage">
            <div className="pa-stage-pool" aria-hidden="true" />
            <div className="pa-stage-inner">
              <div className="pa-stage-top">
                <span className="pf-preview-note">{copy.previewLabel}</span>
                <span className="pa-platform">{copy.previewNote}</span>
              </div>
              <div className="pf-device pa-device">
                <SceneView scene={scene} />
              </div>
              <p className="pf-device-caption">{copy.synthetic}</p>
            </div>
          </div>
        </section>

        <section className="pf-shell pa-console" id="pa-details">
          <div className="pa-console-copy">
            <p className="pf-section-label">{copy.consoleLabel}</p>
            <h2 className="pa-h2">
              {copy.consoleTitleA}
              <br />
              {copy.consoleTitleB}
            </h2>
            <p className="pa-lede pa-lede-sm">{copy.consoleLede}</p>

            <div className="pa-fields">
              <label className="pa-field">
                <span>{copy.fields.person}</span>
                <input
                  value={otherName}
                  maxLength={24}
                  placeholder={copy.personPlaceholder}
                  onChange={(event) => setScene((current) => setParticipantName(current, OTHER_PARTICIPANT_ID, event.target.value))}
                />
              </label>
              <label className="pa-field">
                <span>{copy.fields.line}</span>
                <input
                  value={selfLine}
                  maxLength={120}
                  placeholder={copy.linePlaceholder}
                  onChange={(event) => setScene((current) => setMessageText(current, COMMENTARY_LINE_ID, event.target.value))}
                />
              </label>
              <label className="pa-field">
                <span>{copy.fields.clock}</span>
                <input
                  value={scene.deviceTime}
                  maxLength={8}
                  placeholder={copy.clockPlaceholder}
                  onChange={(event) => setScene((current) => ({ ...current, deviceTime: event.target.value }))}
                />
              </label>
            </div>

            <div className="pa-console-actions">
              <button type="button" className="pf-btn pf-btn-sm" onClick={exportFrame} disabled={exporting}>
                <IconDownload size={16} stroke={1.7} aria-hidden="true" />
                {exporting ? copy.exporting : copy.exportAction}
              </button>
              <button type="button" className="pf-btn pf-btn-ghost pf-btn-sm" onClick={reset}>
                <IconRefresh size={16} stroke={1.7} aria-hidden="true" />
                {copy.reset}
              </button>
              <span className="pa-status" role="status" aria-live="polite">
                {status}
              </span>
            </div>
            <p className="pf-note pa-console-note">{copy.consoleNote}</p>
          </div>

          <div className="pa-console-stage">
            <div className="pf-device pa-device" ref={consoleDevice}>
              <SceneView scene={scene} />
            </div>
            <p className="pf-device-caption">{copy.synthetic}</p>
          </div>
        </section>
      </main>

      <footer className="pf-footer">
        <div className="pf-shell pf-footer-in">
          <span className="pf-footer-brand">
            <Mark />
            IMStage
          </span>
          <span>{copy.footerNote}</span>
          <span>{copy.footerMeta}</span>
        </div>
      </footer>
    </div>
  );
}

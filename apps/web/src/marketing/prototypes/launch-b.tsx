/**
 * Prototype B — Scene Gallery.
 *
 * Journey: a compact promise first, then an immersive horizontal exhibition of
 * three real shared-renderer outputs. Clicking a panel selects that scenario,
 * lifts it and rewrites the caption/CTA below. The later section turns the
 * selected conversation into a three-beat editorial narrative beside one more
 * render of the same scene.
 *
 * Local visual language: a gallery wall. Tinted panels, oversized numerals,
 * thin rules, wide horizontal rhythm, no form chrome.
 */
import { useMemo, useState } from 'react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { SceneView } from '../../studio/SceneView';
import { Mark } from '../../components';
import { BrandLockup, Cta, LocaleToggle, ThemeToggle, usePrototypeChrome } from './shared';
import { SCENARIOS, beatMessages, createScenario } from './scenes';
import './launch-b.css';

interface Copy {
  brand: string;
  locale: { group: string; zh: string; en: string };
  theme: { group: string; light: string; dark: string; system: string };
  skip: string;
  eyebrow: string;
  h1a: string;
  h1b: string;
  lede: string;
  cta: string;
  ctaSecondary: string;
  railLabel: string;
  renderNote: string;
  panelHint: string;
  focusCta: string;
  beatsLabel: string;
  beatsTitle: string;
  beatsNote: string;
  beats: readonly string[];
  previewLabel: string;
  synthetic: string;
  footerNote: string;
  footerMeta: string;
}

const COPY: Record<'zh' | 'en', Copy> = {
  zh: {
    brand: 'IMStage 首页',
    locale: { group: '界面语言', zh: '中文', en: 'EN' },
    theme: { group: '外观主题', light: '浅色', dark: '深色', system: '跟随系统' },
    skip: '跳到主要内容',
    eyebrow: '场景作品集',
    h1a: '先看作品，',
    h1b: '再开始写。',
    lede: '三段日常对话，用同一个真实渲染器生成。挑一个开场，再写你自己的版本。',
    cta: '打开创作台',
    ctaSecondary: '看看怎么用',
    railLabel: '点击挑选场景',
    renderNote: '微信 · 中文渲染',
    panelHint: '选择这个场景',
    focusCta: '用这个场景开始',
    beatsLabel: '叙事三拍',
    beatsTitle: '从一句开场，到一段日常。',
    beatsNote: '每一拍都来自同一个场景。改成什么样，由你决定。',
    beats: ['开场', '回应', '收束'],
    previewLabel: '实时预览',
    synthetic: '合成示例 · 非真实聊天',
    footerNote: '给每段对话，一个舞台。',
    footerMeta: '原型 B · 场景作品集',
  },
  en: {
    brand: 'IMStage home',
    locale: { group: 'Interface language', zh: '中文', en: 'EN' },
    theme: { group: 'Appearance', light: 'Light', dark: 'Dark', system: 'System' },
    skip: 'Skip to content',
    eyebrow: 'Scene gallery',
    h1a: 'See the scene first.',
    h1b: 'Then make it yours.',
    lede: 'Three everyday conversations, rendered by the real thing. Pick an opening, then write your own version.',
    cta: 'Open the studio',
    ctaSecondary: 'How it works',
    railLabel: 'Pick a scene',
    renderNote: 'WhatsApp · English render',
    panelHint: 'Select this scene',
    focusCta: 'Start from this scene',
    beatsLabel: 'Three beats',
    beatsTitle: 'From one opening line to an everyday scene.',
    beatsNote: 'Every beat comes from the same scene. You decide what it becomes.',
    beats: ['Opening', 'Reply', 'Close'],
    previewLabel: 'Live preview',
    synthetic: 'Synthetic demo · not a real chat',
    footerNote: 'A stage for every conversation.',
    footerMeta: 'Prototype B · Scene gallery',
  },
};

export default function LaunchB() {
  const { locale, setLocale, theme, setTheme } = usePrototypeChrome();
  const copy = COPY[locale];
  const [selected, setSelected] = useState(0);
  const [selectedLocale, setSelectedLocale] = useState(locale);

  if (selectedLocale !== locale) {
    setSelectedLocale(locale);
    setSelected(0);
  }

  const scenarios = useMemo(
    () => SCENARIOS.map((meta) => ({ meta, scene: createScenario(meta.kind, locale) })),
    [locale],
  );

  const active = scenarios[Math.min(selected, scenarios.length - 1)];
  const beats = beatMessages(active.scene).map((message, index) => ({
    label: copy.beats[index] ?? String(index + 1),
    text: message.text,
  }));

  return (
    <div className="pb">
      <a className="pf-skip" href="#pb-main">
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

      <main id="pb-main" className="pb-main">
        <section className="pf-shell pb-hero">
          <div className="pb-promise">
            <p className="pf-eyebrow">{copy.eyebrow}</p>
            <h1 className="pb-h1">
              <span>{copy.h1a}</span>
              <span className="pb-h1-em">{copy.h1b}</span>
            </h1>
            <p className="pb-lede">{copy.lede}</p>
            <div className="pb-actions">
              <Cta href="/#/create">
                {copy.cta}
                <IconArrowUpRight size={17} />
              </Cta>
              <Cta href="#pb-beats" variant="ghost">
                {copy.ctaSecondary}
              </Cta>
            </div>
          </div>

          <div className="pb-wall">
            <div className="pb-rail-head">
              <span className="pf-preview-note">{copy.railLabel}</span>
              <span className="pb-render-note">{copy.renderNote}</span>
            </div>

            <div className="pb-rail">
              {scenarios.map((item, index) => (
                <div
                  key={item.meta.kind}
                  className="pb-panel"
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected === index}
                  aria-label={`${item.meta.label[locale]} — ${copy.panelHint}`}
                  onClick={() => setSelected(index)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setSelected(index);
                    }
                  }}
                >
                  <span className="pb-panel-top">
                    <span className="pb-panel-index" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="pb-panel-label">{item.meta.label[locale]}</span>
                  </span>
                  <div className="pb-frame pf-device">
                    <SceneView scene={item.scene} />
                  </div>
                </div>
              ))}
            </div>

            <div className="pb-focus" role="group" aria-label={copy.railLabel}>
              <span className="pb-focus-index" aria-hidden="true">
                {String(selected + 1).padStart(2, '0')}
              </span>
              <span className="pb-focus-text">
                <strong>{active.meta.label[locale]}</strong>
                <span>{active.meta.caption[locale]}</span>
              </span>
              <Cta href="/#/create" small>
                {copy.focusCta}
                <IconArrowUpRight size={15} />
              </Cta>
            </div>
          </div>
        </section>

        <section className="pf-shell pb-beats" id="pb-beats">
          <div className="pb-beats-head">
            <p className="pf-section-label">{copy.beatsLabel}</p>
            <h2 className="pb-h2">{copy.beatsTitle}</h2>
            <p className="pb-lede pb-lede-sm">{copy.beatsNote}</p>
          </div>

          <div className="pb-beats-body">
            <ol className="pb-beat-rail">
              {beats.map((beat, index) => (
                <li key={beat.label} className="pb-beat">
                  <span className="pb-beat-index" aria-hidden="true">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <strong>{beat.label}</strong>
                  <p>{beat.text}</p>
                </li>
              ))}
            </ol>

            <div className="pb-beats-stage">
              <div className="pb-stage-head">
                <span className="pf-preview-note">{copy.previewLabel}</span>
                <span className="pb-stage-scene">{active.meta.label[locale]}</span>
              </div>
              <div className="pf-device pb-beats-device">
                <SceneView scene={active.scene} />
              </div>
              <p className="pf-device-caption">{copy.synthetic}</p>
            </div>
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

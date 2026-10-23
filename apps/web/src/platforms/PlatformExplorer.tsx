/**
 * Public platform explorer for the Templates page.
 *
 * A bilingual comparison of every shared platform chat skin on one shared
 * synthetic scene. Exactly one `SceneView` is mounted at a time: switching the
 * platform only changes the skin, while people, message text and times stay
 * fixed. Content kind comes from the explicit presentation mapping (DM-style
 * social platforms are synthetic conversation/DM previews — never posts or
 * publishing APIs, and the UI offers no posts/comments controls at all).
 * "Continue with this style" stages the exact previewed scene through the
 * existing marketing handoff and opens the creator with `createHandoffHref`;
 * when the draft cannot be prepared the page keeps the selection and says so.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { IconArrowUpRight } from '@tabler/icons-react';
import { PLATFORMS, PLATFORM_LABELS, type Platform, type Scene } from '../studio/model';
import { presentationKind } from './presentation';
import { SceneView } from '../studio/SceneView';
import { createScenario } from '../marketing/scenes';
import { createHandoffHref } from '../marketing/locale';
import { writeHandoffScene } from '../marketing/handoff';
import { useLocale } from '../marketing/LocaleContext';
import { DEMO_DEVICE, ScaledSceneFrame } from '../marketing/DeviceFrame';
import { PLATFORM_EXPLORER_COPY } from './copy';
import './platforms.css';

/** Shared bilingual labels are authored as `中文 / English`; pick the active half. */
export function platformName(platform: Platform, locale: 'zh' | 'en'): string {
  const label = PLATFORM_LABELS[platform];
  const parts = label.split(' / ');
  return (locale === 'zh' ? parts[0] : parts[parts.length - 1]) ?? label;
}

export function PlatformExplorer() {
  const { locale } = useLocale();
  const copy = PLATFORM_EXPLORER_COPY[locale];
  const [selected, setSelected] = useState<Platform>('imstage');
  const [failed, setFailed] = useState(false);
  const options = useRef<Array<HTMLButtonElement | null>>([]);

  // One shared synthetic scene; only the platform skin ever changes.
  const baseScene = useMemo(() => createScenario('coffee', locale), [locale]);
  const previewScene = useMemo<Scene>(() => ({ ...baseScene, platform: selected }), [baseScene, selected]);
  const kind = presentationKind(selected);

  function moveSelection(index: number, key: string): boolean {
    const last = PLATFORMS.length - 1;
    const target = key === 'ArrowDown' || key === 'ArrowRight' ? (index + 1) % PLATFORMS.length
      : key === 'ArrowUp' || key === 'ArrowLeft' ? (index - 1 + PLATFORMS.length) % PLATFORMS.length
      : key === 'Home' ? 0
      : key === 'End' ? last
      : -1;
    if (target < 0) return false;
    setSelected(PLATFORMS[target]);
    options.current[target]?.focus();
    return true;
  }

  function continueWithStyle() {
    const token = writeHandoffScene(previewScene);
    if (!token) {
      setFailed(true);
      return;
    }
    setFailed(false);
    window.location.hash = createHandoffHref(locale, undefined, token);
  }

  return (
    <section className="platform-explorer" aria-labelledby="platform-explorer-title">
      <div className="platform-explorer-copy">
        <span className="section-label">{copy.label}</span>
        <h2 id="platform-explorer-title">{copy.title}</h2>
        <p>{copy.lede}</p>
      </div>
      <div className="platform-explorer-grid">
        <div className="platform-picker" role="radiogroup" aria-label={copy.selectLabel}>
          {PLATFORMS.map((platform, index) => (
            <button
              key={platform}
              type="button"
              role="radio"
              aria-checked={selected === platform}
              tabIndex={selected === platform ? 0 : -1}
              className="platform-option"
              ref={(node) => { options.current[index] = node; }}
              onClick={() => { setSelected(platform); setFailed(false); }}
              onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                if (moveSelection(index, event.key)) event.preventDefault();
              }}
            >
              <span className="platform-option-name">{platformName(platform, locale)}</span>
              <span className="platform-option-tag">{presentationKind(platform) === 'dm' ? copy.dmTag : copy.chatTag}</span>
            </button>
          ))}
        </div>
        <div className="platform-preview">
          <ScaledSceneFrame size={DEMO_DEVICE} label={copy.previewLabel}>
            <SceneView scene={previewScene} exportMode locale={locale} />
          </ScaledSceneFrame>
          <p className="platform-explorer-note">{kind === 'dm' ? copy.dmNote : copy.styleNote}</p>
          <div className="platform-explorer-actions">
            <button type="button" className="btn btn-primary" onClick={continueWithStyle}>
              {copy.continueLabel} <IconArrowUpRight size={17} />
            </button>
            <p className="platform-explorer-status" role={failed ? 'alert' : 'status'}>{failed ? copy.prepareError : ''}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Production landing page — the Conversation Stage.
 *
 * Journey: read a two-line promise, rewrite the highlighted line, watch the
 * real shared SceneView answer, then export the actual PNG. Everything below
 * the fold stays short: a capability strip, real scenario previews, one
 * edit→export section, honest self-host/MCP notes, native FAQ and a single
 * final call to action.
 *
 * The page is usable without an account: all editing is local, the only
 * network reads are the two bounded same-origin avatar files, and creation
 * links hand off to the real Agent workspace through an explicit query param.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { IconAlertTriangle, IconArrowUpRight, IconBrandGithub, IconCheck, IconDownload, IconPencil, IconRefresh } from '@tabler/icons-react';
import { SceneView } from '../studio/SceneView';
import type { Scene } from '../studio/model';
import { useLocale } from './LocaleContext';
import { LANDING_COPY } from './copy';
import { createHandoffHref, type Locale } from './locale';
import { useDemoAvatars } from './avatars';
import { injectAvatars, portableScene, type DemoAvatars } from './portable';
import { writeHandoffScene } from './handoff';
import { createRevisionQueue, type RevisionQueue } from './renderQueue';
import { deviceProfile } from '../studio/device-profiles';
import {
  COMMENTARY_LINE_ID,
  createScenario,
  EDITABLE_REPLY_ID,
  isTextMessage,
  messageText,
  otherParticipantId,
  participantName,
  SCENARIOS,
  setMessageText,
  setParticipantName,
  type SceneKind,
} from './scenes';
import { ExportStage, ScaledSceneFrame, DEMO_DEVICE } from './DeviceFrame';
import { downloadDataUrl, renderScenePng, sceneFileName } from './png';
import { useReveal } from './reveal';
import './marketing.css';

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; src: string; width: number; height: number }
  | { status: 'error' };

function Reveal({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  const { ref, state } = useReveal<HTMLElement>(true);
  return (
    <section id={id} ref={ref} className={`mark-section${className ? ` ${className}` : ''}`} data-reveal={state}>
      {children}
    </section>
  );
}

/** Scenario thumbnails use the real renderer and the same loaded avatars. */
function ScenarioPreview({ kind, locale, avatars }: { kind: SceneKind; locale: Locale; avatars: DemoAvatars | null }) {
  const scene = useMemo(() => {
    const base = createScenario(kind, locale);
    return avatars ? injectAvatars(base, avatars, locale) : base;
  }, [kind, locale, avatars]);
  return (
    <div className="mark-crop" aria-hidden="true">
      <ScaledSceneFrame size={DEMO_DEVICE}>
        <SceneView scene={scene} exportMode locale={locale} />
      </ScaledSceneFrame>
    </div>
  );
}

export default function MarketingSite() {
  const { locale } = useLocale();
  const copy = LANDING_COPY[locale];
  const { state: avatarState, retry: retryAvatars } = useDemoAvatars();
  const avatars = avatarState.status === 'ready' ? avatarState.avatars : null;
  const assetsReady = Boolean(avatars);

  const [kind, setKind] = useState<SceneKind>('coffee');
  const [scene, setScene] = useState<Scene>(() => createScenario('coffee', locale));
  const [editableId, setEditableId] = useState(EDITABLE_REPLY_ID);
  const [heroStatus, setHeroStatus] = useState('');
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });

  const latestScene = useRef(scene);
  latestScene.current = scene;
  const exportRef = useRef<HTMLDivElement>(null);
  const contrastRef = useRef<HTMLElement>(null);
  const previewStarted = useRef(false);
  const exportingRef = useRef(false);
  const avatarsRef = useRef<DemoAvatars | null>(null);
  avatarsRef.current = avatars;

  // Export and save read the validated, data-URI scene; the visible preview can
  // render slightly earlier while the two bounded avatar files are loading.
  const portable = useMemo(() => (avatars ? portableScene(scene, avatars) : null), [scene, avatars]);
  const exportScene = portable?.scene ?? scene;
  const exportReady = Boolean(portable?.ok);

  // Single-flight preview queue: only the newest revision may publish.
  const queueRef = useRef<RevisionQueue<PreviewState> | null>(null);
  if (!queueRef.current) {
    queueRef.current = createRevisionQueue<PreviewState>({
      render: async () => {
        const node = exportRef.current;
        if (!node) throw new Error('export node missing');
        const result = await renderScenePng(node);
        return { status: 'ready', src: result.dataUrl, width: result.width, height: result.height };
      },
      commit: (value) => setPreview(value),
      fail: () => setPreview({ status: 'error' }),
    });
  }

  const requestPreview = useCallback(() => {
    if (exportingRef.current || !avatarsRef.current) return;
    // Keep the current image visible while regenerating to avoid flicker.
    setPreview((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    queueRef.current?.request();
  }, []);

  // Reseed the whole stage when the language or selected scenario changes.
  useEffect(() => {
    queueRef.current?.cancel();
    setScene(() => {
      const next = createScenario(kind, locale);
      return avatarsRef.current ? injectAvatars(next, avatarsRef.current, locale) : next;
    });
    setEditableId(EDITABLE_REPLY_ID);
    setHeroStatus('');
    setPreview({ status: 'idle' });
  }, [kind, locale]);

  // Avatars arrive as data URIs; keep any edit the visitor already made.
  useEffect(() => {
    if (!avatars) return;
    setScene((current) => injectAvatars(current, avatars, locale));
  }, [avatars, locale]);

  const resetScene = useCallback(() => {
    queueRef.current?.cancel();
    setScene(() => {
      const next = createScenario(kind, locale);
      return avatarsRef.current ? injectAvatars(next, avatarsRef.current, locale) : next;
    });
    setEditableId(EDITABLE_REPLY_ID);
    setHeroStatus('');
  }, [kind, locale]);

  // First export preview only once the section approaches the viewport.
  useEffect(() => {
    if (!assetsReady || previewStarted.current) return;
    const element = contrastRef.current;
    if (!element) return;
    if (typeof IntersectionObserver !== 'function') {
      previewStarted.current = true;
      requestPreview();
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          previewStarted.current = true;
          observer.disconnect();
          requestPreview();
        }
      },
      { rootMargin: '160px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [assetsReady, requestPreview]);

  // Keep the exported preview honest while the visitor edits, with a debounce.
  // The queue also marks itself dirty when a render is already running.
  useEffect(() => {
    if (!assetsReady || !previewStarted.current) return;
    const timer = window.setTimeout(requestPreview, 450);
    return () => window.clearTimeout(timer);
  }, [scene, assetsReady, requestPreview]);

  const exportFrame = useCallback(async () => {
    if (!avatars || !portable?.ok || !portable.scene) {
      // Never download a frame whose avatars were not converted and validated.
      setHeroStatus(copy.exportFail);
      return;
    }
    const node = exportRef.current;
    if (!node) {
      setHeroStatus(copy.exportFail);
      return;
    }
    const snapshot = portable.scene;
    exportingRef.current = true;
    setExporting(true);
    setHeroStatus(copy.exporting);
    // Freeze preview publishing so the downloaded frame and preview cannot race.
    queueRef.current?.cancel();
    previewStarted.current = true;
    try {
      const result = await renderScenePng(node);
      downloadDataUrl(result.dataUrl, sceneFileName(snapshot));
      if (latestScene.current === scene) {
        setPreview({ status: 'ready', src: result.dataUrl, width: result.width, height: result.height });
        setHeroStatus(copy.exportDone);
      }
    } catch {
      setHeroStatus(copy.exportFail);
    } finally {
      exportingRef.current = false;
      setExporting(false);
      if (latestScene.current !== scene) requestPreview();
    }
  }, [avatars, portable, scene, requestPreview, copy.exportDone, copy.exportFail, copy.exporting]);

  /** Write the current scene (avatars already data URIs) and hand it over. */
  function handoff(event: MouseEvent<HTMLAnchorElement>, source: Scene, scenario?: SceneKind) {
    if (!avatars) return; // Fall back to the query-param scenario seed.
    const result = portableScene(source, avatars);
    if (!result.ok || !result.scene) return;
    const token = writeHandoffScene(result.scene);
    if (!token) return;
    event.preventDefault();
    window.location.hash = createHandoffHref(locale, scenario, token);
  }

  function scenarioScene(target: SceneKind): Scene {
    const base = createScenario(target, locale);
    return avatars ? injectAvatars(base, avatars, locale) : base;
  }

  const editableText = messageText(scene, editableId);
  const otherId = otherParticipantId(scene);
  const clock = scene.deviceTime;
  const profile = deviceProfile(scene);
  const exportDisabled = exporting || !exportReady;
  const resolution =
    preview.status === 'ready'
      ? `${preview.width} × ${preview.height}`
      : `${DEMO_DEVICE.width * profile.pixelRatio} × ${DEMO_DEVICE.height * profile.pixelRatio}`;

  return (
    <div className="mark" data-locale={locale}>
      <section className="mark-hero" aria-labelledby="mark-hero-title">
        <div className="mark-shell mark-hero-in">
          <div className="mark-hero-copy">
            <p className="mark-eyebrow">{copy.eyebrow}</p>
            <h1 className="mark-h1" id="mark-hero-title">
              <span>{copy.h1a}</span>
              <span className="mark-h1-em">{copy.h1b}</span>
            </h1>
            <p className="mark-promise">{copy.promise}</p>

            <div className="mark-edit">
              <label htmlFor="mark-line">{copy.editLabel}</label>
              <input
                id="mark-line"
                value={editableText}
                maxLength={120}
                spellCheck={false}
                disabled={exporting}
                placeholder={copy.editPlaceholder}
                onChange={(event) => setScene((current) => setMessageText(current, editableId, event.target.value))}
              />
              <p className="mark-edit-hint">
                <IconPencil size={14} stroke={1.7} aria-hidden="true" />
                {copy.editHint}
              </p>
            </div>

            <div className="mark-actions">
              <a className="mark-btn" href={createHandoffHref(locale, kind)} data-testid="hero-start" onClick={(event) => handoff(event, scene, kind)}>
                {copy.primary}
                <IconArrowUpRight size={17} aria-hidden="true" />
              </a>
              <button type="button" className="mark-btn mark-btn-ghost" onClick={() => void exportFrame()} disabled={exportDisabled}>
                <IconDownload size={16} stroke={1.7} aria-hidden="true" />
                {exporting ? copy.exporting : copy.secondary}
              </button>
            </div>

            <p className="mark-status" role="status" aria-live="polite">
              {heroStatus}
            </p>

            <ol className="mark-steps">
              {copy.steps.map((step, index) => (
                <li key={step} className={index === 1 ? 'is-active' : undefined}>
                  <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          <div className="mark-hero-stage">
            <div className="mark-stage-top">
              <span className="mark-preview-note">{copy.previewLabel}</span>
              <span className="mark-platform">{copy.previewNote}</span>
            </div>
            <ScaledSceneFrame label={`${copy.previewLabel} · ${scene.title}`}>
              <SceneView
                scene={scene}
                selectedId={editableId}
                locale={locale}
                onSelect={(id) => {
                  if (isTextMessage(scene, id)) setEditableId(id);
                }}
              />
            </ScaledSceneFrame>
            <div className="mark-stage-foot">
              <p className="mark-device-caption">{copy.synthetic}</p>
              {avatarState.status === 'loading' && <p className="mark-asset-status">{copy.avatarLoading}</p>}
              {avatarState.status === 'error' && (
                <p className="mark-asset-status is-error" role="alert">
                  <IconAlertTriangle size={14} aria-hidden="true" />
                  {copy.avatarError}
                  <button type="button" className="mark-inline-btn" onClick={retryAvatars}>
                    {copy.avatarRetry}
                  </button>
                </p>
              )}
            </div>
          </div>
        </div>
      </section>

      <Reveal className="mark-strip" id="mark-capabilities">
        <div className="mark-shell">
          <div className="mark-strip-head">
            <p className="mark-label">{copy.capabilitiesLabel}</p>
            <h2 className="mark-h2">{copy.capabilitiesTitle}</h2>
          </div>
          <ul className="mark-capabilities">
            {copy.capabilities.map((item, index) => (
              <li key={item.title}>
                <span className="mark-cap-index" aria-hidden="true">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
              </li>
            ))}
          </ul>
          <ul className="mark-usecases" aria-label={copy.capabilitiesLabel}>
            {copy.useCases.map((useCase) => (
              <li key={useCase}>{useCase}</li>
            ))}
          </ul>
        </div>
      </Reveal>

      <Reveal id="mark-scenarios">
        <div className="mark-shell">
          <div className="mark-section-head">
            <p className="mark-label">{copy.scenariosLabel}</p>
            <h2 className="mark-h2">{copy.scenariosTitle}</h2>
            <p className="mark-lede">{copy.scenariosLede}</p>
          </div>
          <div className="mark-scenarios">
            {SCENARIOS.map((scenario) => {
              const active = scenario.kind === kind;
              return (
                <article key={scenario.kind} className={`mark-scenario${active ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className="mark-scenario-select"
                    aria-pressed={active}
                    disabled={exporting}
                    onClick={() => setKind(scenario.kind)}
                  >
                    <ScenarioPreview kind={scenario.kind} locale={locale} avatars={avatars} />
                    <span className="mark-scenario-name">{scenario.label[locale]}</span>
                    <span className="mark-scenario-caption">{scenario.caption[locale]}</span>
                    <span className="mark-scenario-state">{active ? copy.scenarioActive : copy.scenarioUse}</span>
                  </button>
                  <a
                    className="mark-scenario-use"
                    href={createHandoffHref(locale, scenario.kind)}
                    onClick={(event) => handoff(event, active ? scene : scenarioScene(scenario.kind), scenario.kind)}
                  >
                    {copy.scenarioUse}
                    <IconArrowUpRight size={15} aria-hidden="true" />
                  </a>
                </article>
              );
            })}
          </div>
        </div>
      </Reveal>

      <section ref={contrastRef} className="mark-section mark-contrast" id="mark-export" aria-labelledby="mark-contrast-title">
        <div className="mark-shell mark-contrast-in">
          <div className="mark-contrast-copy">
            <p className="mark-label mark-label-band">{copy.contrastLabel}</p>
            <h2 className="mark-h2" id="mark-contrast-title">
              {copy.contrastTitleA}
              <br />
              {copy.contrastTitleB}
            </h2>
            <p className="mark-lede mark-lede-band">{copy.contrastLede}</p>

            <div className="mark-fields">
              <label className="mark-field">
                <span>{copy.fields.person}</span>
                <input
                  value={participantName(scene, otherId)}
                  maxLength={24}
                  disabled={exporting}
                  placeholder={copy.personPlaceholder}
                  onChange={(event) => setScene((current) => setParticipantName(current, otherId, event.target.value))}
                />
              </label>
              <label className="mark-field">
                <span>{copy.fields.line}</span>
                <input
                  value={messageText(scene, COMMENTARY_LINE_ID)}
                  maxLength={120}
                  disabled={exporting}
                  placeholder={copy.linePlaceholder}
                  onChange={(event) => setScene((current) => setMessageText(current, COMMENTARY_LINE_ID, event.target.value))}
                />
              </label>
              <label className="mark-field">
                <span>{copy.fields.clock}</span>
                <input
                  value={clock}
                  maxLength={8}
                  disabled={exporting}
                  placeholder={copy.clockPlaceholder}
                  onChange={(event) => setScene((current) => ({ ...current, deviceTime: event.target.value }))}
                />
              </label>
            </div>

            <div className="mark-contrast-actions">
              <button type="button" className="mark-btn mark-btn-band" onClick={() => void exportFrame()} disabled={exportDisabled}>
                <IconDownload size={16} stroke={1.7} aria-hidden="true" />
                {exporting ? copy.exporting : copy.exportAction}
              </button>
              <button type="button" className="mark-btn mark-btn-band-ghost" onClick={resetScene} disabled={exporting}>
                <IconRefresh size={15} stroke={1.7} aria-hidden="true" />
                {copy.reset}
              </button>
            </div>
            <p className="mark-note mark-note-band">{copy.contrastNote}</p>
          </div>

          <div className="mark-export-card">
            <div className="mark-export-card-head">
              <span>{copy.exportPreviewLabel}</span>
              <span className="mark-file-chip">PNG</span>
            </div>
            <div className="mark-export-card-body">
              {preview.status === 'ready' ? (
                <img src={preview.src} alt={`${copy.exportPreviewLabel} · ${scene.title}`} data-export-preview="ready" />
              ) : preview.status === 'error' ? (
                <div className="mark-export-empty" data-export-preview="error">
                  <IconAlertTriangle size={22} aria-hidden="true" />
                  <p>{copy.exportError}</p>
                  <button type="button" className="mark-inline-btn" onClick={requestPreview}>
                    {copy.retry}
                  </button>
                </div>
              ) : (
                <div className="mark-export-empty" data-export-preview={preview.status}>
                  <span className="mark-export-spinner" aria-hidden="true" />
                  <p>{copy.exportPreparing}</p>
                </div>
              )}
            </div>
            <p className="mark-export-meta-line" data-resolution={resolution.replace(/\s/g, '')}>
              {`PNG · ${resolution} · iPhone 17 Pro`}
            </p>
            <p className="mark-export-caption">
              <IconCheck size={14} aria-hidden="true" />
              {copy.exportCaption}
            </p>
          </div>
        </div>
      </section>

      <Reveal id="mark-open">
        <div className="mark-shell">
          <div className="mark-section-head mark-section-head-row">
            <div>
              <p className="mark-label">{copy.openLabel}</p>
              <h2 className="mark-h2">{copy.openTitle}</h2>
              <p className="mark-lede">{copy.openLede}</p>
            </div>
            <a className="mark-btn mark-btn-ghost" href="https://github.com/kubbot/imstage" target="_blank" rel="noreferrer">
              <IconBrandGithub size={17} aria-hidden="true" />
              {copy.openGithub}
              <IconArrowUpRight size={15} aria-hidden="true" />
            </a>
          </div>
          <ul className="mark-open-rows">
            {copy.openRows.map((row) => (
              <li key={row.title}>
                <div>
                  <h3>{row.title}</h3>
                  <p>{row.detail}</p>
                </div>
                <span className="mark-tag">{row.tag}</span>
              </li>
            ))}
          </ul>
        </div>
      </Reveal>

      <Reveal id="mark-faq">
        <div className="mark-shell mark-faq">
          <div>
            <p className="mark-label">{copy.faqLabel}</p>
            <h2 className="mark-h2">{copy.faqTitle}</h2>
          </div>
          <div className="mark-faq-list">
            {copy.faq.map((item) => (
              <details key={item.q}>
                <summary>
                  {item.q}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </Reveal>

      <section className="mark-section mark-cta" aria-labelledby="mark-cta-title">
        <div className="mark-shell">
          <h2 className="mark-h2 mark-cta-title" id="mark-cta-title">
            {copy.ctaTitle}
          </h2>
          <p className="mark-lede">{copy.ctaBody}</p>
          <a className="mark-btn mark-btn-lg" href={createHandoffHref(locale, kind)} onClick={(event) => handoff(event, scene, kind)}>
            {copy.ctaAction}
            <IconArrowUpRight size={18} aria-hidden="true" />
          </a>
          <p className="mark-note">{copy.footerNote}</p>
        </div>
      </section>

      <ExportStage nodeRef={exportRef} size={DEMO_DEVICE}>
        <SceneView scene={exportScene} exportMode locale={locale} />
      </ExportStage>
    </div>
  );
}

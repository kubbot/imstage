/**
 * Production landing page — the AI story stage.
 *
 * Journey: one instruction becomes believable dialogue, a pause, a photo and a
 * reply, replayed by a bounded state machine; then the same editable scene goes
 * to the real Agent. The replay is explicitly an authored AI-made example and
 * never claims a paid model is running. Below the fold stay the capability
 * strip, real scenario previews, one edit→export section, honest self-host/MCP
 * notes, native FAQ and a single final call to action.
 *
 * The page is usable without an account: all editing is local, the only network
 * reads are bounded same-origin assets (two portraits and one story photo), and
 * creation links hand off to the Agent through an explicit query token.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconBrandGithub,
  IconCheck,
  IconDownload,
  IconMaximize,
  IconPhoto,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconSparkles,
  IconX,
} from '@tabler/icons-react';
import { SceneView } from '../studio/SceneView';
import type { Scene } from '../studio/model';
import { useLocale } from './LocaleContext';
import { LANDING_COPY } from './copy';
import { createHandoffHref, type Locale } from './locale';
import { useDemoAvatars, useStoryPhoto } from './avatars';
import { injectAvatars, injectStoryPhoto, portableScene, type DemoAvatars, type DemoStories } from './portable';
import { MAX_HANDOFF_PROMPT, writeHandoffScene } from './handoff';
import { createRevisionQueue, type RevisionQueue } from './renderQueue';
import { deviceProfile } from '../studio/device-profiles';
import {
  COMMENTARY_LINE_ID,
  createScenario,
  messageText,
  otherParticipantId,
  participantName,
  readScenarioParam,
  SCENARIOS,
  setMessageText,
  setParticipantName,
  WUKANG_PHOTO_ID,
  WUKANG_PROMPT,
  type SceneKind,
} from './scenes';
import { BEATS, PROCESS_STEPS, STORY_STEP_COUNT, framePhotoPending, sceneForFrame } from './story';
import { useStoryPlayback } from './useStoryPlayback';
import { ExportStage, ScaledSceneFrame, DEMO_DEVICE } from './DeviceFrame';
import { downloadDataUrl, renderScenePng, sceneFileName } from './png';
import { useReveal } from './reveal';
import './marketing.css';

type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; src: string; width: number; height: number }
  | { status: 'error' };

/** Build a scenario's complete scene, with whatever assets are already local. */
function buildScene(kind: SceneKind, locale: Locale, avatars: DemoAvatars | null, photo: string | undefined): Scene {
  let scene = createScenario(kind, locale);
  if (avatars) scene = injectAvatars(scene, avatars, locale);
  if (kind === 'wukang' && photo) scene = injectStoryPhoto(scene, photo, WUKANG_PHOTO_ID);
  return scene;
}

/** Read the OS motion preference once, then follow changes. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

function Reveal({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  const { ref, state } = useReveal<HTMLElement>(true);
  return (
    <section id={id} ref={ref} className={`mark-section${className ? ` ${className}` : ''}`} data-reveal={state}>
      {children}
    </section>
  );
}

/** Scenario thumbnails use the real renderer and the same loaded assets. */
function ScenarioPreview({ kind, locale, avatars, photo }: { kind: SceneKind; locale: Locale; avatars: DemoAvatars | null; photo: string | undefined }) {
  const scene = useMemo(() => buildScene(kind, locale, avatars, photo), [kind, locale, avatars, photo]);
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
  const { state: photoState, retry: retryPhoto } = useStoryPhoto();
  const storyPhoto = photoState.status === 'ready' ? photoState.photo : undefined;
  const photoReady = photoState.status === 'ready';
  const stories = useMemo<DemoStories>(() => (storyPhoto ? { wukang: storyPhoto } : {}), [storyPhoto]);

  const [kind, setKind] = useState<SceneKind>(() => readScenarioParam(window.location.search, window.location.hash) ?? 'wukang');
  const [prompt, setPrompt] = useState(() => WUKANG_PROMPT[locale]);
  const [promptEdited, setPromptEdited] = useState(false);
  const [scene, setScene] = useState<Scene>(() => buildScene(kind, locale, null, undefined));
  const [storyScene, setStoryScene] = useState<Scene>(() => buildScene('wukang', locale, null, undefined));
  const [heroStatus, setHeroStatus] = useState('');
  const [exporting, setExporting] = useState(false);
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [photoOpen, setPhotoOpen] = useState(false);

  const latestScene = useRef(scene);
  latestScene.current = scene;
  const exportRef = useRef<HTMLDivElement>(null);
  const storyExportRef = useRef<HTMLDivElement>(null);
  const contrastRef = useRef<HTMLElement>(null);
  const lightboxRef = useRef<HTMLDialogElement>(null);
  const storyHostRef = useRef<HTMLDivElement>(null);
  const previewStarted = useRef(false);
  const exportingRef = useRef(false);
  const avatarsRef = useRef<DemoAvatars | null>(null);
  avatarsRef.current = avatars;
  const photoRef = useRef<string | undefined>(undefined);
  photoRef.current = storyPhoto;

  const reducedMotion = usePrefersReducedMotion();
  const playback = useStoryPlayback({ storyKey: `wukang:${locale}`, reducedMotion, hostRef: storyHostRef });
  const frame = playback.frame;
  const photoPending = framePhotoPending(frame, photoReady);
  // The shared renderer never sees an image message without its asset.
  const visibleStory = useMemo(() => sceneForFrame(storyScene, frame, photoReady), [storyScene, frame, photoReady]);

  // Export and save read the validated, data-URI scene; the visible preview can
  // render slightly earlier while the bounded assets are loading.
  const portable = useMemo(() => portableScene(scene, avatars, stories), [scene, avatars, stories]);
  const exportScene = portable.scene ?? scene;
  const storyPortable = useMemo(() => portableScene(storyScene, avatars, stories), [storyScene, avatars, stories]);
  const storyExportScene = storyPortable.scene ?? storyScene;
  const sceneNeedsPhoto = kind === 'wukang';
  const exportReady = portable.ok && assetsReady && (!sceneNeedsPhoto || photoReady);
  const storyExportReady = storyPortable.ok && assetsReady && photoReady;

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
    // Never render the Wukang preview before its photo is local, so the shared
    // renderer cannot publish an "image not set" frame.
    if (sceneNeedsPhoto && !photoReady) return;
    // Keep the current image visible while regenerating to avoid flicker.
    setPreview((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    queueRef.current?.request();
  }, [sceneNeedsPhoto, photoReady]);

  // Reseed the editable scene when the language or selected scenario changes.
  useEffect(() => {
    queueRef.current?.cancel();
    setScene(buildScene(kind, locale, avatarsRef.current, photoRef.current));
    setHeroStatus('');
    setPreview({ status: 'idle' });
  }, [kind, locale]);

  // The story is always the authored Wukang example; a language switch reseeds it.
  useEffect(() => {
    setStoryScene(buildScene('wukang', locale, avatarsRef.current, photoRef.current));
  }, [locale]);

  // Keep a localized authored instruction unless the visitor wrote their own.
  useEffect(() => {
    if (!promptEdited) setPrompt(WUKANG_PROMPT[locale]);
  }, [locale, promptEdited]);

  // Assets arrive as data URIs; keep any edit the visitor already made.
  useEffect(() => {
    if (!avatars) return;
    setScene((current) => injectAvatars(current, avatars, locale));
    setStoryScene((current) => injectAvatars(current, avatars, locale));
  }, [avatars, locale]);

  useEffect(() => {
    if (!storyPhoto) return;
    setScene((current) => (kind === 'wukang' ? injectStoryPhoto(current, storyPhoto, WUKANG_PHOTO_ID) : current));
    setStoryScene((current) => injectStoryPhoto(current, storyPhoto, WUKANG_PHOTO_ID));
  }, [storyPhoto, kind]);

  // A "still preparing" handoff warning is cleared as soon as the assets land.
  useEffect(() => {
    setHeroStatus((current) => (current === copy.handoffLoading ? '' : current));
  }, [assetsReady, photoReady, copy.handoffLoading]);

  const resetScene = useCallback(() => {
    queueRef.current?.cancel();
    setScene(buildScene(kind, locale, avatarsRef.current, photoRef.current));
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
  useEffect(() => {
    if (!assetsReady || !previewStarted.current) return;
    const timer = window.setTimeout(requestPreview, 450);
    return () => window.clearTimeout(timer);
  }, [scene, assetsReady, requestPreview]);

  // Native dialog: Escape closes it and focus returns to the trigger.
  useEffect(() => {
    const dialog = lightboxRef.current;
    if (!dialog) return;
    if (photoOpen && !dialog.open) dialog.showModal();
    else if (!photoOpen && dialog.open) dialog.close();
  }, [photoOpen]);

  const exportStory = useCallback(async () => {
    if (!storyPortable.ok || !storyPortable.scene || !assetsReady || !photoReady) {
      setHeroStatus(copy.exportFail);
      return;
    }
    const node = storyExportRef.current;
    if (!node) {
      setHeroStatus(copy.exportFail);
      return;
    }
    // The snapshot is the complete authored story, never a half-played frame.
    const snapshot = storyPortable.scene;
    exportingRef.current = true;
    setExporting(true);
    setHeroStatus(copy.exporting);
    try {
      const result = await renderScenePng(node);
      downloadDataUrl(result.dataUrl, sceneFileName(snapshot));
      setHeroStatus(copy.exportDone);
    } catch {
      setHeroStatus(copy.exportFail);
    } finally {
      exportingRef.current = false;
      setExporting(false);
    }
  }, [assetsReady, copy.exportDone, copy.exportFail, copy.exporting, photoReady, storyPortable]);

  const exportFrame = useCallback(async () => {
    if (!portable.ok || !portable.scene || !assetsReady || (sceneNeedsPhoto && !photoReady)) {
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
  }, [assetsReady, copy.exportDone, copy.exportFail, copy.exporting, photoReady, portable, requestPreview, scene, sceneNeedsPhoto]);

  /**
   * Hand a scene to the Agent. Navigation is never allowed to race the payload:
   * the link is always cancelled, and a missing asset or unusable storage is
   * reported instead of silently dropping the visitor's scene or instruction.
   */
  const stageHandoff = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, source: Scene, scenario: SceneKind, instruction?: string) => {
      event.preventDefault();
      const result = portableScene(source, avatars, stories);
      const needsPhoto = scenario === 'wukang';
      if (!assetsReady || !result.ok || !result.scene || (needsPhoto && !photoReady)) {
        setHeroStatus(copy.handoffLoading);
        return;
      }
      const token = writeHandoffScene(result.scene, instruction);
      if (!token) {
        setHeroStatus(copy.handoffStorage);
        return;
      }
      window.location.hash = createHandoffHref(locale, scenario, token);
    },
    [assetsReady, avatars, copy.handoffLoading, copy.handoffStorage, locale, photoReady, stories],
  );

  /** The story CTA adds the visitor's bounded instruction to the same handoff. */
  const handoffStory = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => stageHandoff(event, storyScene, 'wukang', prompt.trim() || undefined),
    [prompt, stageHandoff, storyScene],
  );

  function scenarioScene(target: SceneKind): Scene {
    return buildScene(target, locale, avatars, storyPhoto);
  }

  const otherId = otherParticipantId(scene);
  const clock = scene.deviceTime;
  const profile = deviceProfile(scene);
  const exportDisabled = exporting || !exportReady;
  const resolution =
    preview.status === 'ready'
      ? `${preview.width} × ${preview.height}`
      : `${DEMO_DEVICE.width * profile.pixelRatio} × ${DEMO_DEVICE.height * profile.pixelRatio}`;

  const storyStatus =
    playback.status === 'playing'
      ? `${copy.storyPlaying} · ${Math.min(frame.step + 1, STORY_STEP_COUNT)}/${STORY_STEP_COUNT}`
      : playback.status === 'paused'
        ? copy.storyPaused
        : playback.status === 'done'
          ? copy.storyDone
          : copy.storyIdle;
  const playLabel = playback.status === 'playing' ? copy.storyPause : playback.status === 'paused' ? copy.storyResume : copy.storyPlay;
  const progress = playback.status === 'done' ? 1 : Math.max(0, (frame.beatIndex + 1) / BEATS.length);

  return (
    <div className="mark" data-locale={locale}>
      <section className="mark-hero" aria-labelledby="mark-hero-title">
        <div className="mark-shell mark-hero-in">
          <div className="mark-hero-left">
            <div className="mark-hero-copy">
              <p className="mark-eyebrow">{copy.eyebrow}</p>
              <h1 className="mark-h1" id="mark-hero-title">
                <span>{copy.h1a}</span>
                <span className="mark-h1-em">{copy.h1b}</span>
              </h1>
              <p className="mark-promise">{copy.promise}</p>
            </div>

            <div className="mark-hero-composer">
              <label htmlFor="mark-instruction">{copy.promptLabel}</label>
              <textarea
                id="mark-instruction"
                value={prompt}
                rows={3}
                maxLength={MAX_HANDOFF_PROMPT}
                spellCheck={false}
                placeholder={copy.promptPlaceholder}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  setPromptEdited(true);
                }}
              />
              <p className="mark-composer-hint">
                <IconSparkles size={14} stroke={1.7} aria-hidden="true" />
                {copy.promptHint}
              </p>
            </div>

            <div className="mark-hero-actions">
              <div className="mark-actions">
                <a className="mark-btn" href={createHandoffHref(locale, 'wukang')} data-testid="hero-start" onClick={handoffStory}>
                  {copy.primary}
                  <IconArrowUpRight size={17} aria-hidden="true" />
                </a>
                <button type="button" className="mark-btn mark-btn-ghost" data-testid="hero-export" onClick={() => void exportStory()} disabled={exporting || !storyExportReady}>
                  <IconDownload size={16} stroke={1.7} aria-hidden="true" />
                  {exporting ? copy.exporting : copy.secondary}
                </button>
              </div>
              <p className="mark-status" role="status" aria-live="polite">
                {heroStatus}
              </p>
              <p className="mark-note mark-boundary">{copy.storyBoundary}</p>
            </div>

            <ol className="mark-process" aria-label={copy.storyProcess}>
              {PROCESS_STEPS[locale].map((step, index) => (
                <li key={step} className={index === frame.step ? 'is-active' : index < frame.step ? 'is-done' : undefined}>
                  <span aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                  {step}
                </li>
              ))}
            </ol>
          </div>

          <div className="mark-hero-stage" ref={storyHostRef}>
            <div className="mark-stage-top">
              <span className="mark-preview-note">{copy.storyLabel}</span>
              <span className="mark-stage-top-actions">
                {photoReady && (
                  <button type="button" className="mark-inline-btn mark-icon-btn" aria-label={copy.photoZoom} title={copy.photoZoom} onClick={() => setPhotoOpen(true)}>
                    <IconMaximize size={15} stroke={1.7} aria-hidden="true" />
                  </button>
                )}
                <span className="mark-platform">{copy.previewNote}</span>
              </span>
            </div>
            <ScaledSceneFrame label={`${copy.storyLabel} · ${copy.synthetic}`}>
              <div className="mark-story-phone" data-story-status={playback.status} data-story-beat={frame.beatIndex}>
                <SceneView scene={visibleStory} locale={locale} />
                {photoPending ? (
                  <div className="mark-preparing" aria-hidden="true">
                    <IconPhoto size={15} stroke={1.7} />
                    <span>{copy.storyPreparing}</span>
                  </div>
                ) : frame.typing ? (
                  <div className="mark-typing" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                ) : null}
              </div>
            </ScaledSceneFrame>

            <div className="mark-story-progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${progress})` }} />
            </div>

            <div className="mark-story-controls" role="group" aria-label={copy.storyControls}>
              <button type="button" className="mark-btn mark-btn-ghost mark-btn-sm" onClick={playback.toggle} disabled={exporting || playback.status === 'done'}>
                {playback.status === 'playing' ? <IconPlayerPause size={15} aria-hidden="true" /> : <IconPlayerPlay size={15} aria-hidden="true" />}
                {playLabel}
              </button>
              <button type="button" className="mark-btn mark-btn-ghost mark-btn-sm" onClick={playback.replay} disabled={exporting}>
                <IconRefresh size={15} aria-hidden="true" />
                {copy.storyReplay}
              </button>
              <button type="button" className="mark-btn mark-btn-ghost mark-btn-sm" onClick={playback.showResult} disabled={exporting || playback.status === 'done'}>
                <IconCheck size={15} aria-hidden="true" />
                {copy.storyShowResult}
              </button>
              <span className="mark-story-state" data-story-state={playback.status}>
                {storyStatus}
              </span>
            </div>

            <div className="mark-story-assets">
              {photoState.status === 'loading' && <p className="mark-asset-status">{copy.photoLoading}</p>}
              {photoState.status === 'error' && (
                <p className="mark-asset-status is-error" role="alert">
                  <IconAlertTriangle size={14} aria-hidden="true" />
                  {copy.photoError}
                  <button type="button" className="mark-inline-btn" onClick={retryPhoto}>
                    {copy.photoRetry}
                  </button>
                </p>
              )}
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
                    <ScenarioPreview kind={scenario.kind} locale={locale} avatars={avatars} photo={storyPhoto} />
                    <span className="mark-scenario-name">{scenario.label[locale]}</span>
                    <span className="mark-scenario-caption">{scenario.caption[locale]}</span>
                    <span className="mark-scenario-state">{active ? copy.scenarioActive : copy.scenarioUse}</span>
                  </button>
                  <a
                    className="mark-scenario-use"
                    href={createHandoffHref(locale, scenario.kind)}
                    onClick={(event) => stageHandoff(event, active ? scene : scenarioScene(scenario.kind), scenario.kind)}
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
          <a className="mark-btn mark-btn-lg" href={createHandoffHref(locale, 'wukang')} onClick={handoffStory}>
            {copy.ctaAction}
            <IconArrowUpRight size={18} aria-hidden="true" />
          </a>
          <p className="mark-note">{copy.footerNote}</p>
        </div>
      </section>

      <dialog className="mark-lightbox" ref={lightboxRef} aria-label={copy.photoCaption} onClose={() => setPhotoOpen(false)} onCancel={() => setPhotoOpen(false)}>
        {storyPhoto && <img src={storyPhoto} alt={copy.photoCaption} />}
        <button type="button" className="mark-btn mark-btn-ghost mark-lightbox-close" onClick={() => setPhotoOpen(false)}>
          <IconX size={16} aria-hidden="true" />
          {copy.photoClose}
        </button>
      </dialog>

      <ExportStage nodeRef={exportRef} size={DEMO_DEVICE}>
        <SceneView scene={exportScene} exportMode locale={locale} />
      </ExportStage>
      <ExportStage nodeRef={storyExportRef} size={DEMO_DEVICE}>
        <SceneView scene={storyExportScene} exportMode locale={locale} />
      </ExportStage>
    </div>
  );
}

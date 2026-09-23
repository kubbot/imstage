/**
 * Creator preferences onboarding / settings page.
 *
 * One skippable page with three groups on the left (my avatar, other default
 * avatar, fictional mark) and a real `SceneView` preview on the right. The same
 * page is reopened from account settings; no personalization is required and
 * `先用默认设置` always finishes the flow.
 *
 * Draft handling: edits are mirrored into a per-user sessionStorage draft, then
 * cleared on successful completion or logout. The draft is never shared across
 * accounts because the key contains the real session user id.
 */

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { IconArrowLeft, IconCheck, IconRefresh, IconTrash, IconUpload, IconWand } from '@tabler/icons-react';
import { useAuth } from '../account/Auth';
import { errorText, safeNext } from '../account/api';
import { useLocale } from '../marketing/LocaleContext';
import { SceneView } from '../studio/SceneView';
import DevicePreview from '../studio/DevicePreview';
import type { Scene } from '../studio/model';
import {
  cachedPreferences,
  clearOnboardingDraft,
  ensurePreferences,
  generatePortrait,
  readOnboardingDraft,
  savePreferences,
  trackPreferenceEvent,
  writeOnboardingDraft,
  type AvatarCrop,
  type CreatorPreferences,
} from './api';
import {
  DEFAULT_CROP_ADJUST,
  computeSquareCrop,
  cropSquare,
  loadAvatarFile,
  type CropAdjust,
  type LoadedAvatar,
} from './crop';
import { preferencesCopy, avatarErrorText } from './copy';
import './preferences.css';

type AvatarTarget = 'my' | 'other';

export default function Onboarding({ next = '/workspace', settings = false }: { next?: string; settings?: boolean }) {
  const { user } = useAuth();
  const { locale } = useLocale();
  const c = preferencesCopy(locale);
  const userId = user?.id ?? '';
  const label = cachedPreferences(userId)?.markLabel || '虚构对话';

  const [server, setServer] = useState<CreatorPreferences | null>(() => cachedPreferences(userId));
  const [loading, setLoading] = useState(() => !cachedPreferences(userId));
  const [loadError, setLoadError] = useState(false);
  const [retry, setRetry] = useState(0);

  const [myAvatar, setMyAvatar] = useState<string | null>(null);
  const [otherAvatar, setOtherAvatar] = useState<string | null>(null);
  const [showFictionalMark, setShowFictionalMark] = useState(true);
  const [restored, setRestored] = useState(false);
  const [storageError, setStorageError] = useState(false);

  const [editing, setEditing] = useState<{ target: AvatarTarget; loaded: LoadedAvatar } | null>(null);
  const [adjust, setAdjust] = useState<CropAdjust>(DEFAULT_CROP_ADJUST);
  const [avatarError, setAvatarError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(false);
  const [dragging, setDragging] = useState<AvatarTarget | null>(null);

  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');

  const initialized = useRef('');
  const avatarToken = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingTarget = useRef<AvatarTarget>('my');

  /* -------------------------------------------------------------- */
  /* Load server preferences                                        */
  /* -------------------------------------------------------------- */
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(!cachedPreferences(userId));
    (async () => {
      const cached = cachedPreferences(userId);
      const item = cached ?? (await ensurePreferences(userId, controller.signal));
      if (cancelled) return;
      if (item) {
        setServer(item);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [userId, retry]);

  /* -------------------------------------------------------------- */
  /* Seed local state from draft or server, once per account         */
  /* -------------------------------------------------------------- */
  useEffect(() => {
    if (!userId || !server || initialized.current === userId) return;
    initialized.current = userId;
    // Recovered draft state is seeded before any generation can run, so a slow
    // portrait response can never clobber a saved or draft avatar.
    const draft = readOnboardingDraft(userId);
    const initialMy = draft ? draft.myAvatar : server.myAvatar;
    const initialOther = draft ? draft.otherAvatar : server.otherAvatar;
    const initialMark = draft ? draft.showFictionalMark : server.showFictionalMark;
    setMyAvatar(initialMy);
    setOtherAvatar(initialOther);
    setShowFictionalMark(initialMark);
    if (draft) setRestored(true);
    // `onboarding_shown` is deduped server-side, and it is what stops an
    // interrupted account from being auto-prompted again on the next visit.
    trackPreferenceEvent('onboarding_shown');
    // Generate only when there is genuinely no saved/draft avatar.
    if (initialOther === null) void regenerate(`${userId}:default`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, server]);

  /* -------------------------------------------------------------- */
  /* Recoverable per-user draft (only when it differs)               */
  /* -------------------------------------------------------------- */
  const dirty = server
    ? myAvatar !== server.myAvatar || otherAvatar !== server.otherAvatar || showFictionalMark !== server.showFictionalMark
    : myAvatar !== null || otherAvatar !== null || !showFictionalMark;
  useEffect(() => {
    if (!userId || loading || !initialized.current) return;
    if (!dirty) {
      clearOnboardingDraft(userId);
      setStorageError(false);
      return;
    }
    const ok = writeOnboardingDraft(userId, { myAvatar, otherAvatar, showFictionalMark, updatedAt: Date.now() });
    setStorageError(!ok);
  }, [userId, loading, dirty, myAvatar, otherAvatar, showFictionalMark]);

  /* -------------------------------------------------------------- */
  /* Auto-generate the fictional other avatar (guarded)              */
  /* -------------------------------------------------------------- */
  async function regenerate(seed?: string) {
    if (!userId || generating) return;
    const token = ++avatarToken.current;
    setGenerating(true);
    setGenError(false);
    try {
      const value = await generatePortrait(seed || `${userId}:${crypto.randomUUID()}`);
      if (token === avatarToken.current) setOtherAvatar(value);
    } catch {
      // Never block onboarding: fall back to the built-in initials avatar.
      if (token === avatarToken.current) setGenError(true);
    } finally {
      if (token === avatarToken.current) setGenerating(false);
    }
  }

  /** Replacing the other avatar supersedes its in-flight generation. */
  function setUserAvatar(target: AvatarTarget, value: string | null) {
    if (target === 'my') setMyAvatar(value);
    else {
      avatarToken.current += 1;
      setGenerating(false);
      setGenError(false);
      setOtherAvatar(value);
    }
  }

  /* -------------------------------------------------------------- */
  /* Avatar upload + proportional square crop                        */
  /* -------------------------------------------------------------- */
  function chooseFile(target: AvatarTarget) {
    pendingTarget.current = target;
    setAvatarError('');
    fileInput.current?.click();
  }

  async function handleFile(file: File | null | undefined, target: AvatarTarget) {
    setAvatarError('');
    const result = await loadAvatarFile(file);
    if (!result.ok) {
      setAvatarError(avatarErrorText(result.error, locale));
      return;
    }
    setAdjust(DEFAULT_CROP_ADJUST);
    setEditing({ target, loaded: result.loaded });
  }

  function dropAvatar(event: DragEvent<HTMLDivElement>, target: AvatarTarget) {
    event.preventDefault();
    setDragging(null);
    const file = event.dataTransfer.files?.[0];
    void handleFile(file, target);
  }

  const cropPreview = useMemo(() => {
    if (!editing) return null;
    try {
      const crop = computeSquareCrop(editing.loaded.width, editing.loaded.height, adjust);
      return { crop, dataUrl: cropSquare(editing.loaded, crop, 256) };
    } catch {
      return null;
    }
  }, [editing, adjust]);

  function commitCrop() {
    if (!editing || !cropPreview) {
      setAvatarError(avatarErrorText('canvas_unavailable', locale));
      return;
    }
    setUserAvatar(editing.target, cropPreview.dataUrl);
    setEditing(null);
    setAvatarError('');
  }

  /* -------------------------------------------------------------- */
  /* Finish: save or skip                                            */
  /* -------------------------------------------------------------- */
  async function finish(mode: 'save' | 'skip') {
    if (!userId || busy) return;
    setBusy(true);
    setSaveError('');
    try {
      const revision = server?.revision ?? 0;
      const updated = await savePreferences(
        userId,
        mode === 'save'
          ? { revision, myAvatar, otherAvatar, showFictionalMark, onboardingStatus: 'completed' }
          : { revision, onboardingStatus: 'completed' },
      );
      setServer(updated);
      clearOnboardingDraft(userId);
      trackPreferenceEvent(mode === 'save' ? 'onboarding_saved' : 'onboarding_skipped');
      location.hash = safeNext(settings ? '/account' : next);
    } catch (error) {
      // Keep every draft value and the current page so the user can retry.
      setSaveError(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  const selfName = user?.name?.trim() || (locale === 'en' ? 'You' : '我');
  const otherName = locale === 'en' ? 'Ava' : '对方';
  const previewScene: Scene = useMemo(
    () => ({
      id: 'onboarding-preview',
      title: c.previewTitle,
      platform: locale === 'en' ? 'whatsapp' : 'wechat',
      deviceTime: '09:41',
      date: locale === 'en' ? 'Today 09:38' : '今天 09:38',
      selfId: 'me',
      participants: [
        { id: 'me', name: selfName, ...(myAvatar ? { avatar: myAvatar } : {}) },
        { id: 'other', name: otherName, ...(otherAvatar ? { avatar: otherAvatar } : {}) },
      ],
      messages: [
        { id: 'm-1', participantId: 'other', type: 'text', text: locale === 'en' ? 'A sample line to preview avatars and the mark.' : '这是一句示例对话，用来预览头像与标记。', time: '09:38' },
        { id: 'm-2', participantId: 'me', type: 'text', text: locale === 'en' ? 'Settings update live in this preview.' : '设置会实时反映在这张预览里。', time: '09:39' },
      ],
      watermark: showFictionalMark ? label : '',
    }),
    [c.previewTitle, locale, selfName, otherName, myAvatar, otherAvatar, showFictionalMark, label],
  );

  if (!user) return null;

  if (loading) {
    return (
      <section className="prefs-page" aria-label={c.title}>
        <p className="page-loading" role="status">{c.loading}</p>
      </section>
    );
  }

  if (loadError && !server) {
    return (
      <section className="prefs-page" aria-label={c.title}>
        <div className="prefs-error" role="alert">
          <p>{c.loadFailed}</p>
          <div className="prefs-actions">
            <button className="btn btn-secondary" onClick={() => setRetry((value) => value + 1)}>{c.retry}</button>
            {/* Safe fallback: continue creating without writing anything. This
                never marks onboarding complete and keeps any local draft. */}
            <a className="btn btn-primary" href={`#${safeNext(settings ? '/account' : next)}`}>{c.offlineContinue}</a>
          </div>
          <p className="prefs-help">{c.offlineNote}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="prefs-page" aria-label={settings ? c.settingsTitle : c.title}>
      <header className="prefs-header">
        {settings && <a className="text-link prefs-back" href="#/account"><IconArrowLeft size={16} /> {c.back}</a>}
        <h1>{settings ? c.settingsTitle : c.title}</h1>
        <p>{c.lede}</p>
      </header>

      {(restored || storageError) && (
        <p className="prefs-notice" role="status">{restored ? c.draftNotice : c.storageNotice}</p>
      )}

      <div className="prefs-layout">
        <form className="prefs-groups" onSubmit={(event) => { event.preventDefault(); void finish('save'); }}>
          {/* My avatar */}
          <fieldset className="prefs-group">
            <legend>{c.myAvatar.title}</legend>
            <p className="prefs-help">{c.myAvatar.help}</p>
            <div className="prefs-avatar-row">
              <span className="prefs-avatar" aria-hidden={myAvatar ? undefined : true}>
                {myAvatar ? <img src={myAvatar} alt={c.avatarAlt} /> : <span className="prefs-avatar-initial">{selfName.slice(0, 1)}</span>}
              </span>
              <div className="prefs-avatar-actions">
                <button type="button" className="btn btn-secondary" data-testid="prefs-upload-my" disabled={busy} onClick={() => chooseFile('my')}>
                  <IconUpload size={16} /> {myAvatar ? c.replace : c.upload}
                </button>
                {myAvatar && (
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setUserAvatar('my', null)}>
                    <IconTrash size={16} /> {c.restore}
                  </button>
                )}
              </div>
            </div>
            <div
              className={`prefs-drop${dragging === 'my' ? ' is-dragging' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragging('my'); }}
              onDragLeave={() => setDragging((value) => (value === 'my' ? null : value))}
              onDrop={(event) => dropAvatar(event, 'my')}
            >
              <strong>{c.dropTitle}</strong>
              <span>{c.dropHint}</span>
              <small>{c.formats}</small>
            </div>
            {avatarError && editing?.target !== 'other' && <p className="prefs-error-text" role="alert">{avatarError}</p>}
          </fieldset>

          {/* Other default avatar */}
          <fieldset className="prefs-group">
            <legend>{c.otherAvatar.title}</legend>
            <p className="prefs-help">{c.otherAvatar.help}</p>
            <div className="prefs-avatar-row">
              <span className="prefs-avatar" data-testid="prefs-other-avatar">
                {otherAvatar ? <img src={otherAvatar} alt={c.otherAvatarAlt} /> : <span className="prefs-avatar-initial">{otherName.slice(0, 1)}</span>}
              </span>
              <div className="prefs-avatar-actions">
                <button type="button" className="btn btn-secondary" disabled={busy || generating} onClick={() => void regenerate()}>
                  <IconRefresh size={16} /> {generating ? c.otherAvatar.generating : c.otherAvatar.generate}
                </button>
                <button type="button" className="btn btn-ghost" data-testid="prefs-upload-other" disabled={busy} onClick={() => chooseFile('other')}>
                  <IconUpload size={16} /> {c.upload}
                </button>
              </div>
            </div>
            {genError && <p className="prefs-error-text" role="status">{c.builtinFallback} <button type="button" className="text-link" onClick={() => void regenerate()}>{c.retry}</button></p>}
            <div
              className={`prefs-drop${dragging === 'other' ? ' is-dragging' : ''}`}
              onDragOver={(event) => { event.preventDefault(); setDragging('other'); }}
              onDragLeave={() => setDragging((value) => (value === 'other' ? null : value))}
              onDrop={(event) => dropAvatar(event, 'other')}
            >
              <strong>{c.dropTitle}</strong>
              <span>{c.dropHint}</span>
              <small>{c.formats}</small>
            </div>
          </fieldset>

          {/* Fictional mark */}
          <fieldset className="prefs-group">
            <legend>{c.mark.title}</legend>
            <label className="prefs-switch">
              <input
                type="checkbox"
                checked={showFictionalMark}
                disabled={busy}
                onChange={(event) => setShowFictionalMark(event.target.checked)}
              />
              <span>{c.mark.label}</span>
            </label>
            <p className="prefs-help">{c.mark.help}</p>
            <p className="prefs-help" role="status">{showFictionalMark ? c.markOnNote : c.markOffNote}</p>
          </fieldset>

          {saveError && (
            <div className="prefs-error" role="alert">
              <p>{saveError || c.saveFailed}</p>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void finish('save')}>{c.retry}</button>
            </div>
          )}

          <div className="prefs-actions">
            <button type="submit" className="btn btn-primary" data-testid="prefs-save" disabled={busy}>
              <IconCheck size={17} /> {busy ? c.saving : c.save}
            </button>
            <button type="button" className="btn btn-secondary" data-testid="prefs-skip" disabled={busy} onClick={() => void finish('skip')}>
              <IconWand size={16} /> {c.useDefaults}
            </button>
          </div>
          <p className="prefs-skip-note">{c.skipNote}</p>
        </form>

        <aside className="prefs-preview" aria-label={c.preview}>
          <h2>{c.previewTitle}</h2>
          <div className="prefs-preview-viewport">
            <DevicePreview scene={previewScene} full={false}>
              <SceneView scene={previewScene} exportMode locale={locale} />
            </DevicePreview>
          </div>
          <p className="prefs-preview-note">{showFictionalMark ? c.markOnNote : c.markOffNote}</p>
        </aside>
      </div>

      {editing && cropPreview && (
        <div className="prefs-crop" role="dialog" aria-modal="true" aria-label={c.crop.legend}>
          <fieldset>
            <legend>{c.crop.legend}</legend>
            <div className="prefs-crop-body">
              <img className="prefs-crop-preview" src={cropPreview.dataUrl} alt={c.preview} />
              <div className="prefs-crop-controls">
                <label htmlFor="crop-zoom">{c.crop.zoom}</label>
                <input id="crop-zoom" type="range" min={100} max={300} step={5} value={Math.round(adjust.zoom * 100)} onChange={(event) => setAdjust((value) => ({ ...value, zoom: Number(event.target.value) / 100 }))} />
                <label htmlFor="crop-x">{c.crop.x}</label>
                <input id="crop-x" type="range" min={-100} max={100} step={1} value={Math.round(adjust.x)} onChange={(event) => setAdjust((value) => ({ ...value, x: Number(event.target.value) }))} />
                <label htmlFor="crop-y">{c.crop.y}</label>
                <input id="crop-y" type="range" min={-100} max={100} step={1} value={Math.round(adjust.y)} onChange={(event) => setAdjust((value) => ({ ...value, y: Number(event.target.value) }))} />
              </div>
            </div>
            {avatarError && <p className="prefs-error-text" role="alert">{avatarError}</p>}
            <div className="prefs-crop-actions">
              <button type="button" className="btn btn-primary" onClick={commitCrop}>{c.confirmCrop}</button>
              <button type="button" className="btn btn-secondary" onClick={() => { setEditing(null); setAvatarError(''); }}>{c.cancelCrop}</button>
            </div>
          </fieldset>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void handleFile(file, pendingTarget.current);
        }}
      />
    </section>
  );
}

export type { AvatarCrop };

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { useAuth } from './Auth';
import { api, errorText, loginLink, type SavedScene } from './api';
import { setNavigationGuard } from './navigation';
import { createScene, validateScene, type Scene } from '../studio/model';
import { useCloudAutosave, scenePayload, readWorkRevision, type CloudAutosave, type CloudSaveStatus } from '../cloudAutosave';
import { useCopy, type AppCopy } from '../i18n';
const Studio = lazy(() => import('../agent/AgentStudio'));

function cloudLabel(save: CloudAutosave, copy: AppCopy): string {
  const labels: Record<CloudSaveStatus, string> = {
    idle: '', local: copy.account.cloudPending, saving: copy.account.cloudSaving, saved: copy.account.cloudSaved,
    offline: copy.account.cloudOffline, conflict: copy.account.cloudConflict, error: copy.account.cloudError,
  };
  return labels[save.status];
}

/** Compact status shared by creation sessions, the local studio and the editor. */
function CloudStatus({ save, sceneId, locked, recovered = false, onSaveCopy, savingCopy = false, copyHref, children }: { save: CloudAutosave; sceneId: string; locked: boolean; recovered?: boolean; onSaveCopy?: () => void; savingCopy?: boolean; copyHref?: string; children?: React.ReactNode }) {
  const copy = useCopy();
  const needsRetry = save.status === 'offline' || save.status === 'error';
  const text = save.deleted
    ? copy.account.deletedNotice
    : save.status === 'conflict'
      ? copy.account.conflictNotice
      : recovered ? copy.account.recoveredNote : cloudLabel(save, copy);
  if (!text && !needsRetry && !children) return null;
  return <span className="account-save-message" role="status" data-cloud={save.status}>
    {text && <span>{text}</span>}
    {needsRetry && <button type="button" disabled={locked} onClick={save.retry}>{copy.common.retry}</button>}
    {save.status === 'conflict' && onSaveCopy && <button type="button" disabled={locked || savingCopy} onClick={onSaveCopy}>{copy.account.saveCopy}</button>}
    {copyHref && <a href={copyHref}>{copy.account.openServerVersion}</a>}
    {!copyHref && !save.deleted && save.revision > 0 && save.status !== 'conflict' && <a href={`#/workspace?scene=${sceneId}`}>{copy.account.openServerVersion}</a>}
    {children}
  </span>;
}

/** A stable id for surfaces without a creation session (the local studio). */
function stableStudioId(userId?: string): string {
  if (!userId) return crypto.randomUUID();
  const key = `imstage.work-link.${userId}.studio-current`;
  try {
    const existing = localStorage.getItem(key);
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) return existing;
    const next = crypto.randomUUID();
    localStorage.setItem(key, next);
    return next;
  } catch {
    return crypto.randomUUID();
  }
}

export function AccountSave({ scene, disabled = false, projectId, localSessionId, autosave = true }: { scene: Scene; disabled?: boolean; projectId?: string; localSessionId?: string; autosave?: boolean }) {
  const { user } = useAuth();
  const copy = useCopy();
  const id = useMemo(() => localSessionId || stableStudioId(user?.id), [localSessionId, user?.id]);
  const [copyId, setCopyId] = useState('');
  const [savingCopy, setSavingCopy] = useState(false);
  const [copyError, setCopyError] = useState('');
  const save = useCloudAutosave({
    sceneId: id,
    userId: user?.id,
    projectId: projectId || '',
    scene,
    enabled: Boolean(user),
    blocked: disabled || savingCopy,
    autosave,
    initialRevision: user ? readWorkRevision(user.id, id) : 0,
    probe: autosave && Boolean(user),
  });
  async function saveIndependentCopy() {
    if (!user || savingCopy) return;
    setSavingCopy(true); setCopyError('');
    const target = crypto.randomUUID();
    try {
      await api(`/scenes/${target}`, { method: 'PUT', body: { scene: { ...scene, id: target }, revision: 0, projectId } });
      setCopyId(target);
    } catch (error) { setCopyError(errorText(error)); }
    finally { setSavingCopy(false); }
  }
  if (!user) return <a className="studio-btn" href={loginLink('/studio')}>{copy.common.signInToSave}</a>;
  if (autosave) return <div className="account-save"><CloudStatus save={save} sceneId={id} locked={disabled} onSaveCopy={() => void saveIndependentCopy()} savingCopy={savingCopy} copyHref={copyId ? `#/workspace?scene=${copyId}` : undefined} />{copyError && <span role="alert">{copyError}</span>}</div>;
  const dirty = save.dirty;
  return <div className="account-save">
    <button className="studio-btn" onClick={() => void save.saveNow(true)} disabled={disabled || save.status === 'saving' || (!dirty && save.status !== 'error' && save.status !== 'offline' && save.status !== 'local')}>
      <IconDeviceFloppy size={16} />{save.status === 'saving' ? copy.account.savingToAccount : copy.account.saveWorks}
    </button>
    <CloudStatus save={save} sceneId={id} locked={disabled} onSaveCopy={() => void saveIndependentCopy()} savingCopy={savingCopy} copyHref={copyId ? `#/workspace?scene=${copyId}` : undefined} />
    {copyError && <span role="alert">{copyError}</span>}
  </div>;
}

export default function AccountEditor({ sceneId }: { sceneId: string }) {
  const { user } = useAuth();
  const copy = useCopy();
  const [item, setItem] = useState<SavedScene | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setItem(null);
    if (sceneId === 'new') {
      const id = crypto.randomUUID();
      setItem({ id, revision: 0, updatedAt: '', scene: { ...createScene(), id, title: copy.account.newSceneTitle, selfId: 'me', participants: [{ id: 'me', name: copy.account.selfName }, { id: 'other', name: copy.account.otherName }], messages: [] } });
      return;
    }
    api<{ item: SavedScene }>(`/scenes/${encodeURIComponent(sceneId)}`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setItem(data.item); }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => controller.abort();
  }, [sceneId, retry]);
  if (error) return <section className="account-gate"><h1>{copy.account.openWorkFailed}</h1><p role="alert">{error}</p><button className="btn btn-secondary" onClick={() => setRetry(retry + 1)}>{copy.common.retry}</button> <a className="text-link" href="#/workspace">{copy.account.backToWorks}</a></section>;
  if (!item || !user) return <p className="page-loading" role="status">{copy.account.openingWork}</p>;
  return <EditorSession key={`${user.id}:${sceneId}:${retry}`} item={item} userId={user.id} draftId={sceneId} />;
}

function EditorSession({ item, userId, draftId }: { item: SavedScene; userId: string; draftId: string }) {
  const copy = useCopy();
  const draftKey = `imstage.account.${userId}.${draftId}`;
  const [initial] = useState(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      const parsed = validateScene(draft?.scene);
      if (parsed.ok && parsed.scene && typeof draft.id === 'string' && /^[a-f0-9-]{36}$/.test(draft.id) && Number.isSafeInteger(draft.revision) && draft.revision >= 0) return { scene: parsed.scene, id: draft.id, revision: draft.revision, projectId: typeof draft.projectId === 'string' ? draft.projectId : item.projectIds?.[0] || '', recovered: true };
    } catch { /* ignore unavailable/corrupt local recovery */ }
    return { scene: item.scene, id: item.id, revision: item.revision, projectId: item.projectIds?.[0] || '', recovered: false };
  });
  const [projectId, setProjectId] = useState(initial.projectId);
  const [scene, setScene] = useState(initial.scene);
  const [recovered, setRecovered] = useState(initial.recovered);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentStorageError, setAgentStorageError] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copying, setCopying] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const liveScene = useRef(scene); liveScene.current = scene;

  const save = useCloudAutosave({
    sceneId: initial.id,
    userId,
    projectId,
    scene,
    enabled: true,
    blocked: agentBusy || copying,
    autosave: true,
    initialRevision: initial.revision,
    initialSavedRaw: initial.recovered ? undefined : scenePayload(item.scene, item.projectIds?.[0] || '', initial.id),
    onSaved: () => { if (draftId === 'new') { try { history.replaceState(null, '', `${location.pathname}${location.search}#/workspace?scene=${initial.id}`); } catch { /* the scene is already saved */ } } },
  });
  useEffect(() => {
    try {
      if (save.dirty) sessionStorage.setItem(draftKey, JSON.stringify({ id: initial.id, scene, revision: save.revision, projectId }));
      else { sessionStorage.removeItem(draftKey); setRecovered(false); }
      setStorageError(false);
    } catch { setStorageError(true); }
  }, [scene, projectId, save.dirty, save.revision, draftKey, initial.id]);
  useEffect(() => {
    if (!storageError && !agentStorageError) return;
    return setNavigationGuard(() => window.confirm(copy.account.beforeUnload));
  }, [storageError, agentStorageError, copy.account.beforeUnload]);
  async function saveCopy() {
    if (copying || agentBusy) return;
    setCopying(true); setCopyError('');
    const target = crypto.randomUUID();
    try {
      const sent = liveScene.current;
      const data = await api<{ item: SavedScene }>(`/scenes/${target}`, { method: 'PUT', body: { scene: { ...sent, id: target }, revision: 0, projectId } });
      if (!active.current) return;
      try { sessionStorage.removeItem(draftKey); } catch { /* navigation still works */ }
      location.hash = `/workspace?scene=${data.item.id}`;
    } catch (error) { if (active.current) setCopyError(errorText(error)); }
    finally { if (active.current) setCopying(false); }
  }
  return <><div className="account-editor-bar"><a href="#/workspace">{copy.account.backWorks}</a><p>{save.dirty ? copy.account.workDirty : copy.account.savedToAccount} · {storageError || agentStorageError ? copy.account.draftStorageFailed : copy.account.draftRecoverable}</p></div>
    {copyError && <div className="account-error" role="alert">{copyError}</div>}
    <Suspense fallback={<p className="page-loading" role="status">{copy.common.loading}</p>}><Studio initialProjectId={projectId} onProjectChange={setProjectId} initialScene={initial.scene} persistLocal={false} disabled={copying} onBusyChange={setAgentBusy} onStorageError={setAgentStorageError} onSceneChange={setScene} accountAction={(_, locked) => <CloudStatus save={save} sceneId={initial.id} locked={locked || copying} recovered={recovered} onSaveCopy={() => void saveCopy()} savingCopy={copying} />} /></Suspense>
  </>;
}

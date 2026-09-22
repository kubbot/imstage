/**
 * Shared cloud autosave for accounts.
 *
 * One implementation backs both the in-creation account save (`AccountSave`)
 * and the saved-scene editor (`AccountEditor`). Correctness rules:
 *
 * - Debounced after a completed edit; never while the Agent streams.
 * - Single-flight with a versioned snapshot: edits made during a save keep
 *   flowing, and the newest snapshot is written once the current one resolves.
 * - The compared payload canonicalises `scene.id` to the work id, because the
 *   PUT rewrites it; otherwise a session-vs-scene id mismatch would report a
 *   false conflict for an identical server scene.
 * - A probe reconciles the local base revision with the server before any
 *   write. A newer divergent cloud revision is a conflict: it is never adopted
 *   and never overwritten. Both versions stay reachable (open + save copy).
 * - A known revision > 0 with a server 404 means the work was deleted remotely;
 *   it is reported and not silently recreated.
 * - Offline/unknown probe failure blocks writes, so nothing is written blindly.
 * - Every dispatch re-checks mounted/epoch/target/owner, and the recursive
 *   queued dispatch does too. Because `api()` uses the globally bound identity,
 *   a stale account-A closure must never start a request after account B binds.
 * - Account switches advance the epoch and pause the queue; in-flight results
 *   from a previous identity/scene can never update the new state.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type SavedScene } from './account/api';
import type { Scene } from './studio/model';

export const AUTOSAVE_DELAY = 800;

export type CloudSaveStatus = 'idle' | 'local' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error';

/** Canonical payload: the work id is authoritative, exactly as the PUT stores it. */
export function scenePayload(scene: Scene, projectId: string, sceneId?: string): string {
  const canonical = sceneId && scene.id !== sceneId ? { ...scene, id: sceneId } : scene;
  return JSON.stringify({ scene: canonical, projectId });
}

function linkKeyFor(userId: string, sceneId: string): string {
  return `imstage.work-link.${userId}.${sceneId}`;
}

export function readWorkRevision(userId: string | undefined, sceneId: string): number {
  if (!userId) return 0;
  try {
    const value = Number(localStorage.getItem(linkKeyFor(userId, sceneId)));
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeWorkRevision(userId: string, sceneId: string, revision: number) {
  try { localStorage.setItem(linkKeyFor(userId, sceneId), String(revision)); } catch { /* local link is a convenience */ }
}

export interface CloudAutosaveOptions {
  sceneId: string;
  userId?: string;
  projectId: string;
  scene: Scene;
  enabled: boolean;
  blocked: boolean;
  autosave: boolean;
  initialRevision?: number;
  initialSavedRaw?: string;
  probe?: boolean;
  onSaved?: (revision: number) => void;
  onConflict?: () => void;
}

export interface CloudAutosave {
  status: CloudSaveStatus;
  dirty: boolean;
  revision: number;
  conflict: boolean;
  /** True when the work was deleted on the server while we held a revision. */
  deleted: boolean;
  saveNow: (force?: boolean) => Promise<void>;
  retry: () => void;
  markSaved: (scene: Scene, projectId: string, revision: number) => void;
}

export function useCloudAutosave(options: CloudAutosaveOptions): CloudAutosave {
  const { sceneId, userId, projectId, scene, enabled, blocked, autosave, initialRevision = 0, initialSavedRaw, probe = false, onSaved, onConflict } = options;
  const raw = useMemo(() => scenePayload(scene, projectId, sceneId), [scene, projectId, sceneId]);
  const rawRef = useRef(raw); rawRef.current = raw;
  const sceneIdRef = useRef(sceneId); sceneIdRef.current = sceneId;
  const blockedRef = useRef(blocked); blockedRef.current = blocked;
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const ownerRef = useRef(userId); ownerRef.current = userId;
  const [revision, setRevisionState] = useState(initialRevision);
  const revisionRef = useRef(initialRevision);
  const [savedRaw, setSavedRaw] = useState<string | null>(initialSavedRaw ?? null);
  const [phase, setPhase] = useState<CloudSaveStatus>('idle');
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const [deleted, setDeleted] = useState(false);
  const deletedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const [probeState, setProbeState] = useState<'pending' | 'ready' | 'failed'>(probe ? 'pending' : 'ready');
  const probeStateRef = useRef(probeState); probeStateRef.current = probeState;
  const [probeAttempt, setProbeAttempt] = useState(0);
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved;
  const conflictCallback = useRef(onConflict); conflictCallback.current = onConflict;

  const setRevision = useCallback((next: number) => {
    revisionRef.current = next;
    if (mounted.current) setRevisionState(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    epoch.current += 1;
    conflictRef.current = false;
    deletedRef.current = false;
    queued.current = false;
    clearTimeout(timer.current);
    inFlight.current = false;
    revisionRef.current = initialRevision;
    setRevisionState(initialRevision);
    setSavedRaw(initialSavedRaw ?? null);
    setPhase('idle');
    setConflict(false);
    setDeleted(false);
    setProbeState(probe ? 'pending' : 'ready');
    return () => {
      mounted.current = false;
      epoch.current += 1;
      queued.current = false;
      clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId, userId]);

  // Reconcile the base revision before any write. Divergent newer content is a
  // conflict; a deleted work is reported instead of silently recreated.
  useEffect(() => {
    if (!probe || !enabled || !sceneId || !userId) { setProbeState(probe ? 'failed' : 'ready'); return; }
    let cancelled = false;
    const myEpoch = epoch.current;
    void (async () => {
      try {
        const data = await api<{ item: SavedScene }>(`/scenes/${encodeURIComponent(sceneId)}`);
        if (cancelled || epoch.current !== myEpoch || ownerRef.current !== userId || !mounted.current) return;
        const serverRaw = scenePayload(data.item.scene, data.item.projectIds?.[0] ?? '', sceneId);
        const localRaw = rawRef.current;
        const localRevision = revisionRef.current;
        if (serverRaw === localRaw) {
          setRevision(data.item.revision);
          writeWorkRevision(userId, sceneId, data.item.revision);
          if (mounted.current) setSavedRaw(localRaw);
          setProbeState('ready');
          return;
        }
        if (localRevision === 0 || data.item.revision !== localRevision) {
          // Unrelated/remote-newer content: keep both, never overwrite.
          conflictRef.current = true;
          if (mounted.current) { setConflict(true); setPhase('conflict'); }
          conflictCallback.current?.();
          setProbeState('ready');
          return;
        }
        // Local edits on top of the known base revision: safe to autosave.
        setRevision(data.item.revision);
        setProbeState('ready');
      } catch (error) {
        if (cancelled || epoch.current !== myEpoch) return;
        if (error instanceof ApiError && error.status === 404) {
          if (revisionRef.current > 0) {
            // Deleted remotely while we held a revision: never recreate silently.
            deletedRef.current = true;
            if (mounted.current) { setDeleted(true); setPhase('conflict'); }
          } else {
            setRevision(0);
          }
          setProbeState('ready');
          return;
        }
        if (mounted.current) setPhase('offline');
        setProbeState('failed');
      }
    })();
    return () => { cancelled = true; };
  }, [probe, enabled, sceneId, userId, probeAttempt, setRevision]);

  const eligible = sceneId !== '' && (revisionRef.current > 0 || scene.messages.length > 0 || Boolean(scene.reference));

  const run = useCallback(async (force: boolean) => {
    if (!sceneId || !enabledRef.current || !mounted.current) return;
    if (sceneIdRef.current !== sceneId) return;
    if (blockedRef.current || conflictRef.current || deletedRef.current) return;
    if (probe && probeStateRef.current !== 'ready') return;
    if (!force && !eligible) return;
    if (inFlight.current) { queued.current = true; return; }
    const owner = ownerRef.current;
    const myEpoch = epoch.current;
    // Owner/target/epoch are re-checked immediately before dispatch. `api()`
    // sends the globally bound identity, so a stale closure must never start.
    if (owner !== userId || epoch.current !== myEpoch) return;
    const sentRaw = rawRef.current;
    const sentRevision = revisionRef.current;
    let payload: { scene: Scene; projectId: string };
    try { payload = JSON.parse(sentRaw) as { scene: Scene; projectId: string }; } catch { return; }
    inFlight.current = true; queued.current = false;
    if (mounted.current) setPhase('saving');
    try {
      const data = await api<{ item: SavedScene }>(`/scenes/${encodeURIComponent(sceneId)}`, {
        method: 'PUT',
        body: { scene: { ...payload.scene, id: sceneId }, revision: sentRevision, projectId: payload.projectId },
      });
      if (epoch.current !== myEpoch || ownerRef.current !== owner || !mounted.current) return;
      setRevision(data.item.revision);
      if (owner) writeWorkRevision(owner, sceneId, data.item.revision);
      conflictRef.current = false; if (mounted.current) setConflict(false);
      savedCallback.current?.(data.item.revision);
      if (sentRaw === rawRef.current) { if (mounted.current) setSavedRaw(sentRaw); if (mounted.current) setPhase('saved'); }
      else { queued.current = true; if (mounted.current) setPhase('saving'); }
    } catch (error) {
      if (epoch.current !== myEpoch || ownerRef.current !== owner || !mounted.current) return;
      if (error instanceof ApiError && error.status === 404) {
        deletedRef.current = true; if (mounted.current) { setDeleted(true); setPhase('conflict'); }
      } else if (error instanceof ApiError && error.status === 409) {
        conflictRef.current = true; if (mounted.current) { setConflict(true); setPhase('conflict'); }
        conflictCallback.current?.();
      } else if (error instanceof ApiError && error.status === 0) {
        if (mounted.current) setPhase('offline');
      } else if (mounted.current) setPhase('error');
    } finally {
      if (epoch.current === myEpoch) {
        inFlight.current = false;
        const stillCurrent = mounted.current && sceneIdRef.current === sceneId && ownerRef.current === owner;
        if (stillCurrent && queued.current && !conflictRef.current && !deletedRef.current && !blockedRef.current) {
          queued.current = false;
          void run(false);
        }
      }
    }
  }, [sceneId, userId, eligible, probe, setRevision]);

  useEffect(() => {
    if (!autosave || !enabled || blocked || conflict || deleted || !eligible) return;
    if (probe && probeState !== 'ready') return;
    if (savedRaw === raw) { setPhase((current) => (current === 'conflict' || current === 'offline' || current === 'error' ? current : 'saved')); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void run(false), AUTOSAVE_DELAY);
    return () => clearTimeout(timer.current);
  }, [autosave, enabled, blocked, conflict, deleted, eligible, savedRaw, raw, run, probe, probeState]);

  useEffect(() => {
    const online = () => {
      if (!enabledRef.current || conflictRef.current || deletedRef.current || blockedRef.current) return;
      if (probe && probeStateRef.current === 'failed') { setProbeAttempt((value) => value + 1); return; }
      void run(false);
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [run, probe]);

  const retry = useCallback(() => {
    if (blockedRef.current || conflictRef.current || deletedRef.current) return;
    if (probe && probeStateRef.current !== 'ready') { setProbeAttempt((value) => value + 1); return; }
    setPhase('idle');
    void run(true);
  }, [run, probe]);

  const markSaved = useCallback((nextScene: Scene, nextProjectId: string, nextRevision: number) => {
    const nextRaw = scenePayload(nextScene, nextProjectId, sceneId);
    setRevision(nextRevision);
    if (ownerRef.current) writeWorkRevision(ownerRef.current, sceneId, nextRevision);
    if (mounted.current) { setSavedRaw(nextRaw); conflictRef.current = false; deletedRef.current = false; setConflict(false); setDeleted(false); setPhase('saved'); }
  }, [sceneId, setRevision]);

  const dirty = savedRaw !== raw;
  let status: CloudSaveStatus;
  if (conflict || deleted) status = 'conflict';
  else if (phase === 'saving') status = 'saving';
  else if (dirty && phase === 'offline') status = 'offline';
  else if (dirty && phase === 'error') status = 'error';
  else if (dirty) status = 'local';
  else if (phase === 'idle') status = savedRaw === null ? 'idle' : 'saved';
  else status = 'saved';

  return { status, dirty, revision, conflict: conflict || deleted, deleted, saveNow: (force = false) => run(force), retry, markSaved };
}

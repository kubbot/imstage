/**
 * Project settings autosave.
 *
 * A Project is small, account-owned metadata (name, rules, default platform).
 * The user explicitly asked for Notion-like saving, so every completed edit is
 * persisted locally first and then written to the account without a manual
 * Save button. Correctness rules:
 *
 * - The draft is persisted synchronously to a sessionStorage cache scoped by
 *   account + project (sessionStorage already isolates each browser tab). A
 *   cache write failure downgrades the status but never drops the edit.
 * - Writes are serialised. While a PUT is in flight the form stays editable;
 *   the next draft is rebased onto the acknowledged revision and drained, so a
 *   later response can never erase newer input.
 * - The outbound snapshot is marked uncertain before dispatch. If the ack is
 *   lost (timeout or a drop into offline), the next run resolves it with a GET:
 *   an equal body means the write landed and its revision is adopted before the
 *   latest draft drains; a revision that never moved means it did not apply and
 *   the PUT is retried; anything else is an external update and becomes a
 *   conflict without overwriting it. The marker is cached, so a reload resolves
 *   the same ambiguity instead of sending a stale revision and rejecting a 409.
 * - Equality uses the server's own contract: the project name is trimmed before
 *   comparing, so `" Name "` is not a false conflict with a stored `"Name"`.
 * - The acknowledged revision is the only base for the next PUT. Background
 *   GETs never overwrite a live draft, and a snapshot older than the confirmed
 *   revision is ignored so a slow response cannot roll the UI back.
 * - A 404 means the project was deleted and is never recreated.
 * - Network failures pause the queue and retry on `online` or explicit Retry.
 * - Only the exact acknowledged draft token is removed from the cache.
 * - Account switches and unmounts advance an epoch so a stale response cannot
 *   write into a new owner's state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorText, type Project } from '../account/api';
import { PLATFORMS, type Platform } from '../studio/model';

export const PROJECT_AUTOSAVE_DELAY = 800;
export const PROJECT_DRAFT_PREFIX = 'imstage.project.draft';

export type ProjectSaveStatus = 'local' | 'saving' | 'saved' | 'conflict' | 'error';

export interface ProjectSettings {
  name: string;
  rules: string;
  platform: Platform;
}

export interface ProjectDraft {
  token: string;
  userId: string;
  projectId: string;
  baseRevision: number;
  settings: ProjectSettings;
  /** Exact snapshot of the last PUT whose acknowledgement was never seen. */
  uncertain?: ProjectSettings;
}

/** The server stores `name.trim()`, so equality must use the same contract. */
export function normalizeProjectSettings(settings: ProjectSettings): ProjectSettings {
  return { name: settings.name.trim(), rules: settings.rules, platform: settings.platform };
}

/** Stable content identity for "same project settings on the server". */
export function projectContent(settings: ProjectSettings): string {
  return JSON.stringify(normalizeProjectSettings(settings));
}

/** Exact local content identity; used to ignore truly no-op edits. */
export function projectRawContent(settings: ProjectSettings): string {
  return JSON.stringify({ name: settings.name, rules: settings.rules, platform: settings.platform });
}

export function projectDraftKey(userId: string, projectId: string): string {
  return `${PROJECT_DRAFT_PREFIX}.${userId}.${projectId}`;
}

function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

function readSettings(raw: unknown): ProjectSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const settings = raw as Record<string, unknown>;
  if (typeof settings.name !== 'string' || settings.name.length > 80) return null;
  if (typeof settings.rules !== 'string' || settings.rules.length > 4000) return null;
  if (!isPlatform(settings.platform)) return null;
  return { name: settings.name, rules: settings.rules, platform: settings.platform };
}

/** Parse and validate a cached draft; anything malformed is ignored. */
export function parseProjectDraft(raw: string | null, userId: string, projectId: string): ProjectDraft | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.userId !== userId || record.projectId !== projectId) return null;
  if (typeof record.token !== 'string' || record.token === '') return null;
  if (!Number.isSafeInteger(record.baseRevision) || (record.baseRevision as number) < 0) return null;
  const settings = readSettings(record.settings);
  if (!settings) return null;
  // A corrupt uncertain marker must not invalidate the recoverable draft.
  const uncertain = readSettings(record.uncertain) ?? undefined;
  return {
    token: record.token,
    userId,
    projectId,
    baseRevision: record.baseRevision as number,
    settings,
    uncertain,
  };
}

function readCachedDraft(userId: string, projectId: string): { draft: ProjectDraft | null; failed: boolean } {
  try {
    return { draft: parseProjectDraft(sessionStorage.getItem(projectDraftKey(userId, projectId)), userId, projectId), failed: false };
  } catch {
    return { draft: null, failed: true };
  }
}

function removeExactDraft(userId: string, projectId: string, token: string): void {
  try {
    const key = projectDraftKey(userId, projectId);
    const raw = sessionStorage.getItem(key);
    if (raw === null) return;
    let parsed: { token?: unknown } | null = null;
    try { parsed = JSON.parse(raw) as { token?: unknown }; } catch { return; }
    if (parsed && parsed.token === token) sessionStorage.removeItem(key);
  } catch { /* the local cache is a convenience */ }
}

export interface ProjectAutosaveOptions {
  userId?: string;
  projectId: string;
  /** Latest project snapshot from a server GET; a new identity re-runs reconciliation. */
  remote: Project | null;
  /** Called after `discardLocal` so the caller can re-fetch the cloud snapshot. */
  onReload?: () => void;
}

export interface ProjectAutosave {
  settings: ProjectSettings;
  setName: (value: string) => void;
  setRules: (value: string) => void;
  setPlatform: (value: Platform) => void;
  status: ProjectSaveStatus;
  dirty: boolean;
  conflict: boolean;
  deleted: boolean;
  recovered: boolean;
  cacheFailed: boolean;
  error: string;
  revision: number;
  /** True while a batch must not read the stored rules. */
  syncBlocked: boolean;
  retry: () => void;
  discardLocal: () => void;
}

export function useProjectAutosave({ userId, projectId, remote, onReload }: ProjectAutosaveOptions): ProjectAutosave {
  const [settings, setSettingsState] = useState<ProjectSettings>({ name: '', rules: '', platform: 'wechat' });
  const settingsRef = useRef(settings);
  const [revision, setRevisionState] = useState(0);
  const confirmedRevision = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'saving' | 'error'>('idle');
  const [conflict, setConflict] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [cacheFailed, setCacheFailed] = useState(false);
  const [error, setError] = useState('');

  const draftRef = useRef<ProjectDraft | null>(null);
  const savedContentRef = useRef<string | null>(null);
  const ownerRef = useRef(userId);
  const mounted = useRef(true);
  const epoch = useRef(0);
  const conflictRef = useRef(false);
  const deletedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const onReloadRef = useRef(onReload);
  onReloadRef.current = onReload;

  const commitSettings = useCallback((next: ProjectSettings) => {
    settingsRef.current = next;
    if (mounted.current) setSettingsState(next);
  }, []);

  const persist = useCallback((record: ProjectDraft) => {
    try {
      sessionStorage.setItem(projectDraftKey(record.userId, record.projectId), JSON.stringify(record));
      if (mounted.current) setCacheFailed(false);
    } catch {
      if (mounted.current) setCacheFailed(true);
    }
  }, []);

  const flush = useCallback(async () => {
    const owner = ownerRef.current;
    if (!owner || owner !== userId || !mounted.current) return;
    if (!draftRef.current || conflictRef.current || deletedRef.current) return;
    if (inFlight.current) return; // serialised; the running loop drains the next draft
    const myEpoch = epoch.current;
    const same = () => mounted.current && epoch.current === myEpoch && ownerRef.current === owner;
    inFlight.current = true;

    const removeDraft = (record: ProjectDraft) => {
      if (draftRef.current?.token !== record.token) return;
      draftRef.current = null;
      if (mounted.current) { setDirty(false); setRecovered(false); setPhase('idle'); }
      removeExactDraft(record.userId, record.projectId, record.token);
    };

    const settle = (item: Project, sent: ProjectDraft) => {
      confirmedRevision.current = item.revision;
      savedContentRef.current = projectContent(item);
      conflictRef.current = false;
      deletedRef.current = false;
      if (!mounted.current) return;
      setRevisionState(item.revision);
      setConflict(false);
      setDeleted(false);
      const current = draftRef.current;
      if (current && current.token === sent.token) {
        // No newer edit arrived during the PUT: adopt the canonical server value
        // (the server trims the name) and stop being dirty.
        commitSettings({ name: item.name, rules: item.rules, platform: item.platform });
        removeDraft(sent);
      } else if (current) {
        // Keep the newer edit, rebase it on the acknowledged revision and persist.
        const rebased: ProjectDraft = { ...current, baseRevision: item.revision, uncertain: undefined };
        draftRef.current = rebased;
        persist(rebased);
      }
    };

    /**
     * Resolve an outbound snapshot whose ack was lost. Mutates local state on
     * 'accepted'/'not-applied' so the caller can drain the next draft.
     */
    const resolveUncertain = async (current: ProjectDraft): Promise<'accepted' | 'not-applied' | 'conflict' | 'deleted' | 'retry'> => {
      const uncertain = current.uncertain;
      if (!uncertain) return 'not-applied';
      try {
        const data = await api<{ item: Project }>(`/projects/${encodeURIComponent(projectId)}`);
        if (!same()) return 'retry';
        // Edits may arrive during both the PUT and this reconciliation GET.
        // Resolve the outbound marker against the latest draft, never its snapshot.
        const latest = draftRef.current;
        if (!latest || latest.userId !== current.userId || latest.projectId !== current.projectId
          || !latest.uncertain || projectContent(latest.uncertain) !== projectContent(uncertain)) return 'retry';
        const serverContent = projectContent(data.item);
        if (serverContent === projectContent(uncertain)) {
          confirmedRevision.current = data.item.revision;
          savedContentRef.current = serverContent;
          if (mounted.current) setRevisionState(data.item.revision);
          if (projectContent(latest.settings) === serverContent) {
            // The unresolved write matches the latest draft: it is acknowledged.
            if (mounted.current) commitSettings({ name: data.item.name, rules: data.item.rules, platform: data.item.platform });
            removeDraft(latest);
          } else {
            const rebased: ProjectDraft = { ...latest, baseRevision: data.item.revision, uncertain: undefined };
            draftRef.current = rebased;
            persist(rebased);
          }
          return 'accepted';
        }
        if (data.item.revision === current.baseRevision) {
          // The write never applied; drop the marker and retry with the same base.
          const cleared: ProjectDraft = { ...latest, uncertain: undefined };
          draftRef.current = cleared;
          persist(cleared);
          return 'not-applied';
        }
        // A different writer advanced the project: never overwrite it.
        return 'conflict';
      } catch (failure) {
        if (failure instanceof ApiError && failure.status === 404) return 'deleted';
        return 'retry';
      }
    };

    try {
      while (same() && draftRef.current && !conflictRef.current && !deletedRef.current) {
        const current = draftRef.current;
        if (current.uncertain) {
          const outcome = await resolveUncertain(current);
          if (!same()) return;
          if (outcome === 'deleted') { deletedRef.current = true; if (mounted.current) { setDeleted(true); setPhase('idle'); } return; }
          if (outcome === 'conflict') { conflictRef.current = true; if (mounted.current) { setConflict(true); setPhase('idle'); } return; }
          if (outcome === 'retry') { if (mounted.current) { setPhase('error'); setError(''); setRevisionState(confirmedRevision.current); } return; }
          // 'accepted' resolved the ambiguity (the draft may be gone or rebased)
          // and 'not-applied' cleared the marker: send the latest draft next.
          continue;
        }

        const sent = current;
        // An empty name cannot be written; keep the draft local until it is fixed.
        if (sent.settings.name.trim() === '') {
          if (mounted.current) { setPhase('idle'); setError(''); }
          return;
        }
        // Remember the exact outbound body before dispatch so a lost ack can be
        // reconciled on the next run, including after a reload.
        const outboundSettings = normalizeProjectSettings(sent.settings);
        const outbound: ProjectDraft = { ...sent, uncertain: outboundSettings };
        draftRef.current = outbound;
        persist(outbound);
        if (mounted.current) { setPhase('saving'); setError(''); }
        // Optimistic revision for the header; the ack is authoritative.
        if (mounted.current) setRevisionState(sent.baseRevision + 1);

        let acknowledged = false;
        try {
          const data = await api<{ item: Project }>(`/projects/${encodeURIComponent(projectId)}`, {
            method: 'PUT',
            body: {
              name: outboundSettings.name,
              rules: outboundSettings.rules,
              platform: outboundSettings.platform,
              revision: sent.baseRevision,
            },
          });
          if (!same()) return;
          settle(data.item, outbound);
          acknowledged = true;
        } catch (failure) {
          if (!same()) return;
          if (failure instanceof ApiError && failure.status === 404) {
            deletedRef.current = true;
            if (mounted.current) { setDeleted(true); setPhase('idle'); }
            return;
          }
          if (failure instanceof ApiError && failure.status === 409) {
            conflictRef.current = true;
            if (mounted.current) { setConflict(true); setPhase('idle'); }
            return;
          }
          // status 0 is a network failure or a timeout. Only probe when the
          // browser believes it is online; offline pauses for a later retry.
          if (failure instanceof ApiError && failure.status === 0 && navigator.onLine !== false) {
            const outcome = await resolveUncertain(outbound);
            if (!same()) return;
            if (outcome === 'accepted') {
              // The write landed; drain whatever newer draft remains in this run.
              acknowledged = true;
            } else if (outcome === 'deleted') {
              deletedRef.current = true;
              if (mounted.current) { setDeleted(true); setPhase('idle'); }
              return;
            } else if (outcome === 'conflict') {
              conflictRef.current = true;
              if (mounted.current) { setConflict(true); setPhase('idle'); }
              return;
            } else {
              // 'retry' or 'not-applied': pause instead of spinning on a failing PUT.
              if (mounted.current) { setPhase('error'); setError(errorText(failure)); setRevisionState(confirmedRevision.current); }
              return;
            }
          } else {
            if (mounted.current) { setPhase('error'); setError(errorText(failure)); setRevisionState(confirmedRevision.current); }
            return;
          }
        }
        if (!acknowledged) return;
      }
      if (same() && !draftRef.current && !conflictRef.current && !deletedRef.current && mounted.current) setPhase('idle');
    } finally {
      if (epoch.current === myEpoch) inFlight.current = false;
    }
  }, [commitSettings, persist, projectId, userId]);

  const applyEdit = useCallback((patch: Partial<ProjectSettings>) => {
    const owner = ownerRef.current;
    if (!owner || !mounted.current) return;
    const current = draftRef.current?.settings ?? settingsRef.current;
    const next = { ...current, ...patch };
    if (projectRawContent(next) === projectRawContent(current)) return;
    const record: ProjectDraft = {
      token: crypto.randomUUID(),
      userId: owner,
      projectId,
      baseRevision: confirmedRevision.current,
      settings: next,
      uncertain: draftRef.current?.uncertain,
    };
    draftRef.current = record;
    commitSettings(next);
    setDirty(true);
    setPhase('idle');
    setError('');
    persist(record);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, PROJECT_AUTOSAVE_DELAY);
  }, [commitSettings, flush, persist, projectId]);

  // Owner/project identity: reset, then recover this tab's draft if any.
  useEffect(() => {
    mounted.current = true;
    epoch.current += 1;
    clearTimeout(timer.current);
    inFlight.current = false;
    conflictRef.current = false;
    deletedRef.current = false;
    draftRef.current = null;
    savedContentRef.current = null;
    confirmedRevision.current = 0;
    setConflict(false); setDeleted(false); setDirty(false); setPhase('idle');
    setError(''); setCacheFailed(false); setRecovered(false); setRevisionState(0);
    commitSettings({ name: '', rules: '', platform: 'wechat' });
    if (userId) {
      const cached = readCachedDraft(userId, projectId);
      if (cached.failed) setCacheFailed(true);
      if (cached.draft) {
        draftRef.current = cached.draft;
        confirmedRevision.current = cached.draft.baseRevision;
        commitSettings(cached.draft.settings);
        setRevisionState(cached.draft.baseRevision);
        setDirty(true);
        setRecovered(true);
      }
    }
    return () => {
      mounted.current = false;
      epoch.current += 1;
      inFlight.current = false;
      clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, projectId]);

  // Reconcile the cloud snapshot. Background GETs never overwrite a live draft
  // and a response older than the confirmed revision is ignored.
  useEffect(() => {
    if (!remote || !userId) return;
    if (ownerRef.current !== userId || !mounted.current) return;
    if (inFlight.current) return; // the running PUT settles this draft
    if (remote.revision < confirmedRevision.current) return; // stale snapshot
    const serverContent = projectContent(remote);
    const draft = draftRef.current;
    if (draft) {
      const uncertain = draft.uncertain;
      if (uncertain) {
        if (serverContent === projectContent(uncertain)) {
          // The ambiguous write is confirmed by content: adopt its revision.
          confirmedRevision.current = remote.revision;
          savedContentRef.current = serverContent;
          if (mounted.current) setRevisionState(remote.revision);
          if (projectContent(draft.settings) === serverContent) {
            if (mounted.current) commitSettings({ name: remote.name, rules: remote.rules, platform: remote.platform });
            draftRef.current = null;
            setDirty(false); setRecovered(false);
            setConflict(false); conflictRef.current = false;
            setPhase('idle');
            removeExactDraft(draft.userId, draft.projectId, draft.token);
            return;
          }
          const rebased: ProjectDraft = { ...draft, baseRevision: remote.revision, uncertain: undefined };
          draftRef.current = rebased;
          persist(rebased);
          void flush();
          return;
        }
        if (remote.revision === draft.baseRevision) {
          // The ambiguous write did not apply; clear the marker and sync.
          const cleared: ProjectDraft = { ...draft, uncertain: undefined };
          draftRef.current = cleared;
          persist(cleared);
          confirmedRevision.current = remote.revision;
          setRevisionState(remote.revision);
          void flush();
          return;
        }
        // The project moved on independently; require an explicit decision.
        conflictRef.current = true;
        setConflict(true);
        setPhase('idle');
        return;
      }
      if (serverContent === projectContent(draft.settings)) {
        // The cloud already holds this edit (for example a lost ack): adopt it.
        confirmedRevision.current = remote.revision;
        savedContentRef.current = serverContent;
        draftRef.current = null;
        setDirty(false);
        setRecovered(false);
        setConflict(false); conflictRef.current = false;
        commitSettings({ name: remote.name, rules: remote.rules, platform: remote.platform });
        setRevisionState(remote.revision);
        setPhase('idle');
        removeExactDraft(draft.userId, draft.projectId, draft.token);
        return;
      }
      if (remote.revision === draft.baseRevision) {
        // The edit sits on the current server revision: safe to sync.
        confirmedRevision.current = remote.revision;
        setRevisionState(remote.revision);
        void flush();
        return;
      }
      // The project moved on independently; require an explicit decision.
      conflictRef.current = true;
      setConflict(true);
      setPhase('idle');
      return;
    }
    if (conflictRef.current || deletedRef.current) return;
    if (remote.revision === confirmedRevision.current && savedContentRef.current === serverContent) return;
    // No local draft: adopt the server snapshot as the baseline.
    confirmedRevision.current = remote.revision;
    savedContentRef.current = serverContent;
    commitSettings({ name: remote.name, rules: remote.rules, platform: remote.platform });
    setRevisionState(remote.revision);
    setRecovered(false);
    setDirty(false);
    setPhase('idle');
  }, [remote, userId, commitSettings, flush, persist]);

  useEffect(() => {
    const online = () => {
      if (conflictRef.current || deletedRef.current || !draftRef.current) return;
      void flush();
    };
    window.addEventListener('online', online);
    return () => window.removeEventListener('online', online);
  }, [flush]);

  const retry = useCallback(() => {
    if (conflictRef.current || deletedRef.current) return;
    setPhase('idle');
    setError('');
    void flush();
  }, [flush]);

  const discardLocal = useCallback(() => {
    const draft = draftRef.current;
    if (draft) removeExactDraft(draft.userId, draft.projectId, draft.token);
    draftRef.current = null;
    conflictRef.current = false;
    deletedRef.current = false;
    savedContentRef.current = null;
    setConflict(false); setDeleted(false); setDirty(false); setRecovered(false);
    setPhase('idle'); setError('');
    onReloadRef.current?.();
  }, []);

  const setName = useCallback((value: string) => applyEdit({ name: value }), [applyEdit]);
  const setRules = useCallback((value: string) => applyEdit({ rules: value }), [applyEdit]);
  const setPlatform = useCallback((value: Platform) => applyEdit({ platform: value }), [applyEdit]);

  let status: ProjectSaveStatus;
  if (conflict || deleted) status = 'conflict';
  else if (phase === 'saving') status = 'saving';
  else if (dirty && phase === 'error') status = 'error';
  else if (dirty) status = 'local';
  else status = 'saved';

  return {
    settings,
    setName,
    setRules,
    setPlatform,
    status,
    dirty,
    conflict,
    deleted,
    recovered,
    cacheFailed,
    error,
    revision,
    syncBlocked: dirty || status === 'saving' || conflict || deleted,
    retry,
    discardLocal,
  };
}

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorText } from '../account/api';
import { retainContacts, type ContactLibrary } from './model';
import type { Participant } from '../studio/model';

export const CONTACT_DEBOUNCE = 800;
type CacheRecord = { key: string; token: string; userId: string; baseRevision: number; library: ContactLibrary };
const tabId = (() => {
  try {
    const key = 'imstage.contacts.tab';
    const id = sessionStorage.getItem(key) || crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  } catch { return crypto.randomUUID(); }
})();
// Serialize this tab's writes and acknowledgements. Separate tab keys keep one
// tab's acknowledged save from deleting another tab's pending draft.
let cacheQueue: Promise<unknown> = Promise.resolve();
function cacheAction<T>(action: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const operation = cacheQueue.catch(() => {}).then(() => new Promise<T>((resolve, reject) => {
    const request = indexedDB.open('imstage-contact-cache', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('drafts')) request.result.createObjectStore('drafts', { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('drafts', 'readwrite');
      let value: T;
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error('Local cache unavailable')); };
      try { action(tx.objectStore('drafts'), next => { value = next; }); } catch (error) { tx.abort(); reject(error); }
    };
  }));
  cacheQueue = operation;
  return operation;
}
const keyFor = (owner: string) => `${owner}:${tabId}`;
const readCache = (owner: string) => cacheAction<CacheRecord | null>((store, result) => {
  const request = store.get(keyFor(owner));
  request.onsuccess = () => result(request.result ?? null);
});
const writeCache = (record: CacheRecord) => cacheAction<void>((store) => { store.put(record); });
const clearCache = (owner: string, token?: string) => cacheAction<void>((store) => {
  const key = keyFor(owner);
  const request = store.get(key);
  request.onsuccess = () => { if (!request.result || token === undefined || request.result.token === token) store.delete(key); };
});
const content = (library: ContactLibrary) => JSON.stringify({ contacts: library.contacts, selfContactId: library.selfContactId, autoSave: library.autoSave });
function valid(library: ContactLibrary): boolean {
  return Array.isArray(library.contacts) && library.contacts.length <= 100 && typeof library.autoSave === 'boolean' &&
    library.contacts.every(c => typeof c.id === 'string' && typeof c.name === 'string' && c.name.trim().length >= 1 && c.name.trim().length <= 100 &&
      (!c.avatar || (typeof c.avatar === 'string' && c.avatar.length <= 2 * 1024 * 1024)) && (c.subtitle?.length || 0) <= 200);
}
export type ContactSource = 'none' | 'cloud' | 'cache' | 'memory';

export function useContactLibrary(userId?: string) {
  const [library, setLibrary] = useState<ContactLibrary | null>(null);
  const [loading, setLoading] = useState(Boolean(userId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [cacheError, setCacheError] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [validation, setValidation] = useState('');
  const [source, setSource] = useState<ContactSource>('none');
  const owner = useRef(userId); owner.current = userId;
  const mounted = useRef(false);
  const epoch = useRef(0);
  const current = useRef<ContactLibrary | null>(null);
  const pending = useRef<CacheRecord | null>(null);
  const conflictRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const same = (mine: number) => mounted.current && epoch.current === mine && owner.current === userId;

  function show(value: ContactLibrary, nextSource: ContactSource) { current.current = value; setLibrary(value); setSource(nextSource); }
  async function persist(record: CacheRecord) {
    const mine = epoch.current;
    try {
      await writeCache(record);
      if (same(mine) && pending.current?.token === record.token) { setCacheError(false); setSource('cache'); }
    } catch { if (same(mine)) { setCacheError(true); setSource('memory'); } }
  }
  async function load(discard = false) {
    if (!userId) return;
    const mine = epoch.current;
    // Reconciliation must wait for this writer's uncertain PUT acknowledgement.
    if (inFlight.current) await inFlight.current;
    if (!same(mine)) return;
    setLoading(true); setLoadError('');
    let cached = pending.current;
    try { if (!cached) cached = await readCache(userId); } catch { if (same(mine)) setCacheError(true); }
    if (!same(mine)) return;
    try {
      const remote = await api<ContactLibrary>('/contact-library');
      if (!same(mine)) return;
      // Keep edits made while this read was in flight.
      cached = pending.current ?? cached;
      if (cached && !discard) {
        if (cached.userId !== userId || !cached.library || !Array.isArray(cached.library.contacts)) throw new Error('Invalid local contact cache');
        pending.current = cached;
        show(cached.library, 'cache');
        if (content(cached.library) === content(remote)) {
          await clearCache(userId, cached.token);
          if (!same(mine)) return;
          if (pending.current?.token === cached.token) { pending.current = null; show(remote, 'cloud'); }
        } else if (cached.baseRevision !== remote.revision) {
          conflictRef.current = true; setConflict(true);
        } else { conflictRef.current = false; setConflict(false); void flush(); }
      } else {
        if (discard) await clearCache(userId);
        if (!same(mine)) return;
        pending.current = null; conflictRef.current = false; setConflict(false); setError(''); setValidation(''); show(remote, 'cloud');
      }
    } catch (failure) {
      if (!same(mine)) return;
      if (cached && !current.current) { pending.current = cached; show(cached.library, 'cache'); }
      setLoadError(errorText(failure));
    } finally { if (same(mine)) setLoading(false); }
  }

  function edit(transform: (library: ContactLibrary) => ContactLibrary) {
    if (!userId || !current.current || !mounted.current) return;
    const base = pending.current?.library ?? current.current;
    const next = transform(base);
    if (content(next) === content(base)) return;
    const record = { key: keyFor(userId), token: crypto.randomUUID(), userId, baseRevision: base.revision, library: next };
    pending.current = record; show(next, 'memory'); setError(''); setValidation(valid(next) ? '' : 'name');
    void persist(record);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), CONTACT_DEBOUNCE);
  }

  async function flush(): Promise<boolean> {
    if (!userId || !mounted.current || owner.current !== userId || conflictRef.current) return false;
    if (inFlight.current) return inFlight.current;
    if (!pending.current) return true;
    if (!valid(pending.current.library)) { setValidation('name'); return false; }
    const mine = epoch.current;
    const task = (async () => {
      setSaving(true); setError('');
      while (same(mine) && pending.current && !conflictRef.current) {
        const sent = pending.current;
        if (!valid(sent.library)) { setValidation('name'); return false; }
        try {
          const result = await api<ContactLibrary>('/contact-library', { method: 'PUT', body: { ...sent.library, revision: sent.baseRevision } });
          if (!same(mine)) return false;
          if (pending.current?.token === sent.token) {
            pending.current = null;
            show(result, 'cloud');
            try { await clearCache(userId, sent.token); } catch { setCacheError(true); }
          } else if (pending.current) {
            // Rebase only this writer's next edit onto its just-acknowledged PUT.
            const next = { ...pending.current, baseRevision: result.revision, library: { ...pending.current.library, revision: result.revision } };
            pending.current = next; show(next.library, 'memory'); await persist(next);
          }
          if (same(mine)) setValidation('');
        } catch (failure) {
          if (!same(mine)) return false;
          setError(errorText(failure));
          if (failure instanceof ApiError && failure.status === 409) { conflictRef.current = true; setConflict(true); }
          return false;
        }
      }
      return same(mine) && !pending.current;
    })();
    inFlight.current = task;
    try { return await task; }
    finally { if (same(mine) && inFlight.current === task) { inFlight.current = null; setSaving(false); } }
  }

  useEffect(() => {
    mounted.current = true; epoch.current++; pending.current = null; current.current = null; inFlight.current = null;
    conflictRef.current = false; setConflict(false); setSaving(false); setLibrary(null); setSource('none'); setError(''); setCacheError(false);
    void load();
    const online = () => { if (!conflictRef.current) void load(); };
    window.addEventListener('online', online);
    return () => { mounted.current = false; epoch.current++; clearTimeout(timer.current); window.removeEventListener('online', online); };
  }, [userId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (cacheError && pending.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [cacheError]);

  async function capture(people: Participant[]): Promise<boolean> {
    if (!userId) return false;
    if (!current.current) await load();
    if (!current.current?.autoSave) return true;
    // No fresh GET can replace the edits already queued in this tab.
    edit(base => retainContacts(base, people));
    return flush();
  }
  return { library, loading, saving, error, loadError, cacheError: cacheError && pending.current !== null, conflict, validation, source, edit,
    retry: () => { if (!conflictRef.current) void load(); }, reload: () => void load(),
    resolveWithCloud: () => void load(true), capture };
}

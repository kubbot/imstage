// A transaction, rather than a read-then-write localStorage pair, gives tabs
// one stable random cancellation context even on their very first visit.
let cached: string | null = null;
let opening: Promise<string | null> | null = null;
export function browserAuthContext(): Promise<string | null> {
  if (cached) return Promise.resolve(cached);
  if (opening) return opening;
  opening = new Promise<string | null>(resolve => {
    let settled = false;
    let db: IDBDatabase | undefined;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); db?.close();
      if (value) cached = value;
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 5000);
    try {
      if (typeof indexedDB === 'undefined') { finish(null); return; }
      const request = indexedDB.open('imstage-auth-context', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('context');
      request.onerror = () => finish(null);
      request.onblocked = () => finish(null);
      request.onsuccess = () => {
        db = request.result;
        if (settled) { db.close(); return; }
        try {
          const tx = db.transaction('context', 'readwrite');
          const store = tx.objectStore('context');
          let value: string | null = null;
          const read = store.get('browser');
          read.onsuccess = () => {
            if (/^[A-Za-z0-9_-]{43}$/.test(read.result ?? '')) value = read.result;
            else {
              const bytes = crypto.getRandomValues(new Uint8Array(32));
              value = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
              store.put(value, 'browser');
            }
          };
          tx.oncomplete = () => finish(value);
          tx.onabort = tx.onerror = () => finish(null);
        } catch { finish(null); }
      };
    } catch { finish(null); }
  }).finally(() => { opening = null; });
  return opening;
}

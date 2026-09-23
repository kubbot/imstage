import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, bindIdentity, clearAccountDrafts, type User } from './api';
import { clearPreferencesCache, ensurePreferences } from '../preferences/api';
type AuthState = { user: User | null; loading: boolean; unavailable: boolean; refresh: () => Promise<void>; accept: (user: User) => void; logout: () => Promise<void> };
const Context = createContext<AuthState | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try { const result = await api<{ user: User | null }>('/auth/session'); if (version === generation.current) { bindIdentity(result.user); setUser(result.user); setUnavailable(false); if (result.user) void ensurePreferences(result.user.id); } }
    catch { if (version === generation.current) setUnavailable(true); }
    finally { if (version === generation.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const expired = () => { generation.current++; bindIdentity(null); setUser(null); setLoading(false); };
    const focus = () => { void refresh(); };
    window.addEventListener('imstage-session-expired', expired);
    window.addEventListener('focus', focus);
    if ('BroadcastChannel' in window) { channel.current = new BroadcastChannel('imstage-auth'); channel.current.onmessage = focus; }
    return () => { generation.current++; window.removeEventListener('imstage-session-expired', expired); window.removeEventListener('focus', focus); channel.current?.close(); };
  }, [refresh]);
  const accept = (value: User) => { generation.current++; bindIdentity(value); void ensurePreferences(value.id); setUser(value); setLoading(false); setUnavailable(false); channel.current?.postMessage('changed'); };
  const logout = async () => {
    const version = generation.current;
    await api('/auth/logout', { method: 'POST', body: {} });
    if (generation.current !== version) { await refresh(); return; }
    generation.current++; if (user) { clearAccountDrafts(user.id); clearPreferencesCache(user.id); } bindIdentity(null); setUser(null); channel.current?.postMessage('changed');
    location.hash = '/login';
  };
  return <Context.Provider value={{ user, loading, unavailable, refresh, accept, logout }}>{children}</Context.Provider>;
}
export function useAuth() { const context = useContext(Context); if (!context) throw new Error('AuthProvider missing'); return context; }

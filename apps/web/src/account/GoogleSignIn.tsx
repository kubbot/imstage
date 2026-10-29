import { useEffect, useRef, useState } from 'react';
import { api, authOperationVersion, errorText, type User } from './api';
import { browserAuthContext } from './authContext';
import { TermsConsent } from './TermsConsent';
import { useLocale } from '../marketing/LocaleContext';

type Pending = { flowId: string; profile: { email: string; name: string } };
type Config = { enabled: boolean; clientId: string | null; pending: Pending | null };
type Result = { user?: User; linked?: boolean; registrationRequired?: boolean } & Partial<Pending>;
type IdentitySdk = { initialize: (config: Record<string, unknown>) => void; renderButton: (node: HTMLElement, config: Record<string, unknown>) => void; cancel: () => void; disableAutoSelect: () => void };
const sdk = () => (window as unknown as { google?: { accounts: { id: IdentitySdk } } }).google?.accounts.id;
let loading: Promise<IdentitySdk> | null = null;
let owner = 0;
function loadSdk(): Promise<IdentitySdk> {
  if (sdk()) return Promise.resolve(sdk()!);
  if (loading) return loading;
  loading = new Promise<IdentitySdk>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
    const fail = () => { clearTimeout(timer); script.remove(); loading = null; reject(new Error('Google SDK unavailable')); };
    const timer = setTimeout(fail, 9000);
    script.onerror = fail;
    script.onload = () => { clearTimeout(timer); if (sdk()) resolve(sdk()!); else fail(); };
    document.head.append(script);
  });
  return loading;
}
export default function GoogleSignIn({ intent = 'signin', onSuccess, disabled = false }: { intent?: 'signin' | 'link'; onSuccess: (user: User) => void; disabled?: boolean }) {
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [password, setPassword] = useState('');
  const [linkStarted, setLinkStarted] = useState(intent === 'signin');
  const node = useRef<HTMLDivElement>(null);
  const active = useRef(false);
  const flow = useRef<string | null>(null);
  const lease = useRef(0);
  const settled = useRef(false);
  const success = useRef(onSuccess); success.current = onSuccess;
  useEffect(() => {
    active.current = true;
    let cancelled = false;
    const mine = ++owner;
    settled.current = false;
    async function prepare() {
      setError('');
      try {
        const config = await api<Config>('/auth/google/config', { optional: true });
        if (cancelled) return;
        setEnabled(config.enabled);
        if (!config.enabled) return;
        if (!await browserAuthContext()) throw new Error(zh ? '浏览器安全存储不可用，请使用邮箱密码登录。' : 'Secure browser storage is unavailable. Use your email and password.');
        if (cancelled || owner !== mine) return;
        if (intent === 'signin' && config.pending) {
          settled.current = true; flow.current = config.pending.flowId;
          setPending(config.pending); setName(config.pending.profile.name); return;
        }
        if (!linkStarted) return;
        const id = await loadSdk();
        if (cancelled || owner !== mine) return;
        const challenge = await api<{ flowId: string; nonce: string; clientId: string }>('/auth/google/challenge', { method: 'POST', body: { intent, ...(intent === 'link' ? { password } : {}) }, optional: true });
        flow.current = challenge.flowId; lease.current = authOperationVersion();
        setPassword('');
        if (cancelled || owner !== mine) { if (authOperationVersion() === lease.current) void api('/auth/google/cancel', { method: 'POST', body: { flowId: challenge.flowId }, optional: true }).catch(() => {}); return; }
        id.initialize({ client_id: challenge.clientId, nonce: challenge.nonce, auto_select: false, ux_mode: 'popup', use_fedcm_for_button: false,
          callback: async (response: { credential?: string }) => {
            if (cancelled || owner !== mine || authOperationVersion() !== lease.current || !response.credential || disabled) return;
            setBusy(true); setError('');
            try {
              const request = api<Result>('/auth/google/credential', { method: 'POST', body: { flowId: challenge.flowId, credential: response.credential }, optional: true });
              lease.current = authOperationVersion();
              const result = await request;
              lease.current = authOperationVersion();
              if (cancelled || owner !== mine) return;
              if (result.user) { settled.current = true; success.current(result.user); }
              else if (result.registrationRequired && result.profile && result.flowId) {
                settled.current = true;
                setPending({ flowId: result.flowId, profile: result.profile }); setName(result.profile.name);
              }
            } catch (error) { if (!cancelled) setError(errorText(error)); }
            finally { if (!cancelled) setBusy(false); }
          },
        });
        if (node.current) { node.current.replaceChildren(); id.renderButton(node.current, { type: 'standard', theme: 'outline', size: 'large', text: intent === 'link' ? 'continue_with' : 'signin_with', locale: zh ? 'zh_CN' : 'en', width: Math.min(node.current.clientWidth || 320, 400) }); }
      } catch (error) {
        if (!cancelled) { setError(error instanceof Error && error.message === 'Google SDK unavailable' ? (zh ? '暂时无法加载 Google 登录，请重试或使用密码。' : 'Google sign-in could not load. Retry or use your password.') : errorText(error)); setLinkStarted(intent === 'signin'); }
      }
    }
    void prepare();
    return () => {
      cancelled = true; active.current = false;
      if (owner === mine) { owner++; sdk()?.cancel(); }
      if (flow.current && !settled.current && authOperationVersion() === lease.current) void api('/auth/google/cancel', { method: 'POST', body: { flowId: flow.current }, optional: true }).catch(() => {});
    };
    // A new attempt creates a new nonce. Password is read only when the explicit
    // link action increments attempt; keystrokes must never start challenges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, locale, attempt, linkStarted]);
  async function register() {
    if (!pending || !agreed || busy) return;
    setBusy(true); setError('');
    try {
      settled.current = false;
      const request = api<{ user: User }>('/auth/google/register', { method: 'POST', body: { flowId: pending.flowId, termsAccepted: true, name }, optional: true });
      lease.current = authOperationVersion();
      const result = await request;
      if (active.current) { settled.current = true; success.current(result.user); }
    } catch (error) { if (active.current) { settled.current = true; setError(errorText(error)); } }
    finally { if (active.current) setBusy(false); }
  }
  async function cancelPending() {
    if (!pending) return;
    setBusy(true);
    try { await api('/auth/google/cancel', { method: 'POST', body: { flowId: pending.flowId }, optional: true }); if (active.current) { setPending(null); setAgreed(false); setAttempt(v => v + 1); } }
    catch (error) { if (active.current) setError(errorText(error)); }
    finally { if (active.current) setBusy(false); }
  }
  if (!enabled) return null;
  return <div className="google-signin" aria-busy={busy}>
    {pending ? <div data-testid="google-registration" className="account-form"><h2>{zh ? '完成 Google 注册' : 'Complete Google registration'}</h2><p>{pending.profile.email}</p><label>{zh ? '怎么称呼你' : 'Your name'}<input maxLength={60} value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label><TermsConsent checked={agreed} onChange={setAgreed} testId="google-terms-consent" /><button type="button" className="btn btn-primary" disabled={busy || !agreed || !name.trim()} onClick={() => void register()}>{zh ? '同意并创建账号' : 'Accept and create account'}</button><button type="button" className="text-link" disabled={busy} onClick={() => void cancelPending()}>{zh ? '取消 Google 注册' : 'Cancel Google registration'}</button></div>
      : intent === 'link' && !linkStarted ? <form className="account-form" onSubmit={e => { e.preventDefault(); if (password && !disabled) { setLinkStarted(true); setAttempt(v => v + 1); } }}><label>{zh ? '关联前确认当前密码' : 'Confirm your password before linking'}<input type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={e => setPassword(e.target.value)} /></label><button className="btn btn-secondary" disabled={disabled || !password}>{zh ? '开始关联 Google' : 'Start linking Google'}</button></form>
      : <><div ref={node} className="google-button" inert={disabled || busy} /><p className="field-hint">{busy ? (zh ? '正在确认 Google 身份…' : 'Verifying Google identity…') : (zh ? 'Google 仅提供基本身份信息。' : 'Google shares only basic identity information.')}</p></>}
    {error && <><p role="alert" className="account-error">{error}</p><button type="button" className="text-link" disabled={busy || disabled} onClick={() => { setPending(null); setAttempt(v => v + 1); }}>{zh ? '重试 Google 登录' : 'Retry Google sign-in'}</button></>}
  </div>;
}

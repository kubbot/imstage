import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { IconArrowRight, IconEye, IconEyeOff, IconLock } from '@tabler/icons-react';
import { useAuth } from './Auth';
import GoogleSignIn from './GoogleSignIn';
import { TermsConsent } from './TermsConsent';
import { api, ApiError, errorText, safeNext, type User } from './api';
import { cachedPreferences, ensurePreferences } from '../preferences/api';
import { useCopy } from '../i18n';
import { useLocale } from '../marketing/LocaleContext';
import { createScenario } from '../marketing/scenes';
import { ScaledSceneFrame } from '../marketing/DeviceFrame';
import { SceneView } from '../studio/SceneView';
const remembered = { email: '', name: '' };
export default function AuthPage({ mode, next }: { mode: 'login' | 'register'; next: string }) {
  const { user, accept, refresh } = useAuth();
  const a = useCopy().account;
  const { locale } = useLocale();
  const example = useMemo(() => createScenario('evaluation', locale), [locale]);
  const story = locale === 'zh'
    ? { label: '你的场景工作室', title: ['把设定留好。', '下次继续。'], body: '保存合成场景，让每一次测试都有可复用的起点。', caption: '虚构人物 · 合成测试样本' }
    : { label: 'Your conversation studio', title: ['Keep your context.', 'Continue the scene.'], body: 'Save synthetic scenes and keep a reusable starting point for every test.', caption: 'Fictional people · synthetic test sample' };
  const [email, setEmail] = useState(remembered.email);
  const [name, setName] = useState(remembered.name);
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [googleAttempt, setGoogleAttempt] = useState(0);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const register = mode === 'register';
  useEffect(() => { setError(''); setPassword(''); setVisible(false); }, [mode]);
  // After a successful Web login/registration the first visit enters the
  // one-time onboarding, preserving the safe original `next`. OAuth connect
  // pages are intentionally excluded so the authorization callback finishes
  // first; an interrupted visit is re-entered from account settings instead of
  // being auto-prompted again.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const target = safeNext(next);
      if (!target.startsWith('/connect')) {
        const prefs = cachedPreferences(user.id) ?? (await ensurePreferences(user.id));
        if (cancelled) return;
        if (prefs && prefs.onboardingStatus === 'pending' && !prefs.onboardingShown) {
          location.hash = `/welcome?next=${encodeURIComponent(target)}`;
          return;
        }
      }
      if (!cancelled) location.hash = target;
    })();
    return () => { cancelled = true; };
  }, [user, next]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ user: User }>(`/auth/${mode}`, { method: 'POST', body: { email: email.trim(), password, ...(register ? { name: name.trim() } : {}) } });
      if (!active.current) { void refresh(); return; }
      accept(result.user); setPassword('');
    } catch (error) { if (!active.current) return; setError(register && error instanceof ApiError && error.status === 0 ? a.registrationUncertain : errorText(error)); }
    finally { if (active.current) { setBusy(false); setGoogleAttempt(value => value + 1); } }
  }
  return <section className="auth-layout">
    <div className="auth-story" aria-hidden="true"><span className="account-kicker">{story.label}</span><h2>{story.title[0]}<br />{story.title[1]}</h2><p>{story.body}</p><div className="auth-specimen"><ScaledSceneFrame><SceneView scene={example} exportMode locale={locale} /></ScaledSceneFrame></div><span className="auth-caption">{story.caption}</span></div>
    <div className="auth-form-panel"><div className="auth-form-heading"><span className="account-kicker">{register ? a.registerKicker : a.loginKicker}</span><h1>{register ? a.registerTitle : a.loginTitle}</h1><p>{register ? a.registerLede : a.loginLede}</p></div>
      <GoogleSignIn key={googleAttempt} onSuccess={accept} disabled={busy} />
      <form onSubmit={submit} className="account-form" aria-label={register ? a.registerTitle : a.loginTitle}>
        <fieldset disabled={busy}>
          {register && <label>{a.nameLabel}<input name="name" autoComplete="nickname" required maxLength={60} value={name} onChange={e => { remembered.name = e.target.value; setName(e.target.value); }} placeholder={a.namePlaceholder} /></label>}
          <label>{a.emailLabel}<input name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254} value={email} onChange={e => { remembered.email = e.target.value; setEmail(e.target.value); }} placeholder="you@example.com" /></label>
          <label>{a.passwordLabel}<span className="password-field"><input name="password" type={visible ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 6 : undefined} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} aria-describedby={register ? 'password-hint' : undefined} /><button type="button" aria-label={visible ? a.hidePassword : a.showPassword} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <IconEyeOff size={19} /> : <IconEye size={19} />}</button></span></label>
          {register && <p id="password-hint" className="field-hint">{a.passwordHint}</p>}
          {register && <TermsConsent checked={agreed} onChange={setAgreed} />}
        </fieldset>
        {error && <p className="account-error" role="alert">{error}</p>}
        <button className="btn btn-primary auth-submit" disabled={busy || (register && !agreed)} type="submit">{busy ? (register ? a.registerBusy : a.loginBusy) : (register ? a.createAccount : a.login)} {!busy && <IconArrowRight size={18} />}</button>
        <p className="auth-switch">{register ? a.haveAccount : a.firstTime} <a aria-disabled={busy} onClick={e => { if (busy) e.preventDefault(); }} href={`#/${register ? 'login' : 'register'}?next=${encodeURIComponent(safeNext(next))}`}>{register ? a.goLogin : a.goRegister}</a></p>
      </form>
      <div className="auth-help"><button type="button" onClick={() => setHelp(!help)} aria-expanded={help}>{a.cannotLogin}</button><a href="#/studio">{a.tryEditor} <IconArrowRight size={14} /></a></div>
      {help && <p className="field-hint" role="status">{a.loginHelp}</p>}
      <p className="auth-instance"><IconLock size={14} /> {a.instanceNote}</p>
    </div>
  </section>;
}

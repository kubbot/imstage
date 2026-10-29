import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from './Auth';
import GoogleSignIn from './GoogleSignIn';
import { api, clearAccountDrafts, errorText } from './api';
import { useLocale } from '../marketing/LocaleContext';
import { useCopy } from '../i18n';
export default function AccountPage() {
  const { user, logout, refresh, accept } = useAuth();
  const a = useCopy().account;
  const { locale } = useLocale();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [methods, setMethods] = useState<{password: boolean; google: {configured: boolean; linked: boolean; email: string | null}} | null>(null);
  const [proof, setProof] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => { let active = true; void api<typeof methods>('/auth/methods').then(value => { if (active) setMethods(value); }).catch(error => { if (active) setError(errorText(error)); }); return () => { active = false; }; }, [user?.id, reload]);
  async function unlinkGoogle(e: FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await api('/auth/google/unlink', {method: 'POST', body: {password: proof}}); setProof(''); await refresh(); location.hash = '/login'; }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  async function changePassword(e: FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await api('/auth/password', { method: 'POST', body: { currentPassword: oldPassword, newPassword } }); if (user) clearAccountDrafts(user.id); setOldPassword(''); setNewPassword(''); await refresh(); location.hash = '/login'; }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <section className="account-settings"><a className="text-link" href="#/workspace">{a.backWorksLong}</a><h1>{a.accountTitle}</h1><p>{a.accountLede}</p><div className="account-profile"><span>{user?.name.slice(0, 1)}</span><div><h2>{user?.name}</h2><p>{user?.email}</p></div></div><p className="account-connections-link"><a className="btn btn-secondary" href="#/welcome?from=settings">{locale === 'zh' ? '头像与虚构标记偏好' : 'Avatar & fictional-mark preferences'}</a> <a className="btn btn-secondary" href="#/connect">{locale === 'zh' ? '已连接应用与访问令牌' : 'Connected apps & access tokens'}</a></p>{methods?.google.linked ? <div className="account-google"><h2>{locale === 'zh' ? '已关联 Google' : 'Google linked'}</h2><p>{methods.google.email}</p>{methods.password ? <form className="account-form" onSubmit={unlinkGoogle}><label>{locale === 'zh' ? '解除关联前确认当前密码' : 'Confirm your password before unlinking'}<input type="password" autoComplete="current-password" required maxLength={128} value={proof} onChange={e => setProof(e.target.value)} disabled={busy} /></label><button className="btn btn-secondary" disabled={busy}>{locale === 'zh' ? '解除 Google 关联' : 'Unlink Google'}</button></form> : <p className="field-hint">{locale === 'zh' ? 'Google 是此账号的登录方式。' : 'This account signs in with Google.'}</p>}</div> : methods?.google.configured && <div className="account-google"><h2>{locale === 'zh' ? '关联 Google' : 'Link Google'}</h2><GoogleSignIn intent="link" disabled={busy} onSuccess={value => { accept(value); setReload(v => v + 1); }} /></div>}{methods?.password && <form className="account-form" onSubmit={changePassword}><h2>{a.changePassword}</h2><p>{a.changePasswordBody}</p><fieldset disabled={busy}><label>{a.currentPassword}<input type="password" autoComplete="current-password" required maxLength={128} value={oldPassword} onChange={e => setOldPassword(e.target.value)} /></label><label>{a.newPassword}<input type="password" autoComplete="new-password" required minLength={6} maxLength={128} value={newPassword} onChange={e => setNewPassword(e.target.value)} aria-describedby="new-password-hint" /></label><p id="new-password-hint" className="field-hint">{a.passwordMinHint}</p></fieldset><button className="btn btn-primary" disabled={busy}>{busy ? a.updating : a.updatePassword}</button></form>}{error && <p className="account-error" role="alert">{error}</p>}<div className="account-signout"><p>{a.signOutBody}</p><button className="btn btn-secondary" disabled={busy} onClick={async () => { setBusy(true); try { await logout(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } }}>{a.logout}</button></div></section>;
}

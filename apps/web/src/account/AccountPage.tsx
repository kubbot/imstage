import { useState, type FormEvent } from 'react';
import { useAuth } from './Auth';
import { api, clearAccountDrafts, errorText } from './api';
import { useCopy } from '../i18n';
export default function AccountPage() {
  const { user, logout, refresh } = useAuth();
  const a = useCopy().account;
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function changePassword(e: FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await api('/auth/password', { method: 'POST', body: { currentPassword: oldPassword, newPassword } }); if (user) clearAccountDrafts(user.id); setOldPassword(''); setNewPassword(''); await refresh(); location.hash = '/login'; }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <section className="account-settings"><a className="text-link" href="#/workspace">{a.backWorksLong}</a><h1>{a.accountTitle}</h1><p>{a.accountLede}</p><div className="account-profile"><span>{user?.name.slice(0, 1)}</span><div><h2>{user?.name}</h2><p>{user?.email}</p></div></div><form className="account-form" onSubmit={changePassword}><h2>{a.changePassword}</h2><p>{a.changePasswordBody}</p><fieldset disabled={busy}><label>{a.currentPassword}<input type="password" autoComplete="current-password" required maxLength={128} value={oldPassword} onChange={e => setOldPassword(e.target.value)} /></label><label>{a.newPassword}<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newPassword} onChange={e => setNewPassword(e.target.value)} aria-describedby="new-password-hint" /></label><p id="new-password-hint" className="field-hint">{a.passwordMinHint}</p></fieldset>{error && <p className="account-error" role="alert">{error}</p>}<button className="btn btn-primary" disabled={busy}>{busy ? a.updating : a.updatePassword}</button></form><div className="account-signout"><p>{a.signOutBody}</p><button className="btn btn-secondary" disabled={busy} onClick={async () => { setBusy(true); try { await logout(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } }}>{a.logout}</button></div></section>;
}

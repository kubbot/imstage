import { useState, type FormEvent } from 'react';
import { useAuth } from './Auth';
import { api, clearAccountDrafts, errorText } from './api';
export default function AccountPage() {
  const { user, logout, refresh } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function changePassword(e: FormEvent) {
    e.preventDefault(); if (busy) return; setBusy(true); setError('');
    try { await api('/auth/password', { method: 'POST', body: { currentPassword: oldPassword, newPassword } }); if (user) clearAccountDrafts(user.id); setOldPassword(''); setNewPassword(''); await refresh(); location.hash = '/login'; }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <section className="account-settings"><a className="text-link" href="#/workspace">← 返回我的作品</a><h1>账号设置</h1><p>管理你的账号与登录凭据。</p><div className="account-profile"><span>{user?.name.slice(0, 1)}</span><div><h2>{user?.name}</h2><p>{user?.email}</p></div></div><form className="account-form" onSubmit={changePassword}><h2>修改密码</h2><p>修改后所有设备的登录都会失效，需要使用新密码重新登录。</p><fieldset disabled={busy}><label>当前密码<input type="password" autoComplete="current-password" required maxLength={128} value={oldPassword} onChange={e => setOldPassword(e.target.value)} /></label><label>新密码<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={newPassword} onChange={e => setNewPassword(e.target.value)} aria-describedby="new-password-hint" /></label><p id="new-password-hint" className="field-hint">至少 12 个字符。</p></fieldset>{error && <p className="account-error" role="alert">{error}</p>}<button className="btn btn-primary" disabled={busy}>{busy ? '正在更新…' : '更新密码'}</button></form><div className="account-signout"><p>当前作品保存在此 IMStage 实例。</p><button className="btn btn-secondary" disabled={busy} onClick={async () => { setBusy(true); try { await logout(); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } }}>退出登录</button></div></section>;
}

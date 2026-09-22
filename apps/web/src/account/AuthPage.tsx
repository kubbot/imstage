import { useEffect, useRef, useState, type FormEvent } from 'react';
import { IconArrowRight, IconEye, IconEyeOff, IconLock, IconMessageCircle } from '@tabler/icons-react';
import { useAuth } from './Auth';
import { api, ApiError, errorText, safeNext, type User } from './api';
const remembered = { email: '', name: '' };
export default function AuthPage({ mode, next }: { mode: 'login' | 'register'; next: string }) {
  const { user, accept, refresh } = useAuth();
  const [email, setEmail] = useState(remembered.email);
  const [name, setName] = useState(remembered.name);
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const register = mode === 'register';
  useEffect(() => { setError(''); setPassword(''); setVisible(false); }, [mode]);
  useEffect(() => { if (user) location.hash = safeNext(next); }, [user, next]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ user: User }>(`/auth/${mode}`, { method: 'POST', body: { email: email.trim(), password, ...(register ? { name: name.trim() } : {}) } });
      if (!active.current) { void refresh(); return; }
      accept(result.user); setPassword(''); location.hash = safeNext(next);
    } catch (error) { if (!active.current) return; setError(register && error instanceof ApiError && error.status === 0 ? '暂未确认账号是否创建成功。请先切换到登录，使用刚才的邮箱和密码尝试。' : errorText(error)); }
    finally { if (active.current) setBusy(false); }
  }
  return <section className="auth-layout">
    <div className="auth-story" aria-hidden="true"><span className="account-kicker">YOUR NEXT CONVERSATION</span><h2>好故事，<br />值得留下来。</h2><p>从一句台词到一整段对话。<br />把灵感存好，下次接着创作。</p><div className="auth-conversation"><div className="auth-bubble">下一站，去哪里？</div><div className="auth-bubble mine">去想象力能到的地方。</div><div className="auth-bubble small"><IconMessageCircle size={18} /> 故事未完，待你续写。</div></div><span className="auth-caption">IMStage / 给每段对话，一个舞台。</span></div>
    <div className="auth-form-panel"><div className="auth-form-heading"><span className="account-kicker">{register ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</span><h1>{register ? '开始你的创作空间' : '欢迎回来'}</h1><p>{register ? '创建账号，保存和管理你的对话作品。' : '登录 IMStage，继续上一次的灵感。'}</p></div>
      <form onSubmit={submit} className="account-form" aria-label={register ? '注册账号' : '登录账号'}>
        <fieldset disabled={busy}>
          {register && <label>怎么称呼你<input name="name" autoComplete="nickname" required maxLength={60} value={name} onChange={e => { remembered.name = e.target.value; setName(e.target.value); }} placeholder="你的名字" /></label>}
          <label>邮箱<input name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254} value={email} onChange={e => { remembered.email = e.target.value; setEmail(e.target.value); }} placeholder="you@example.com" /></label>
          <label>密码<span className="password-field"><input name="password" type={visible ? 'text' : 'password'} autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : undefined} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} aria-describedby={register ? 'password-hint' : undefined} /><button type="button" aria-label={visible ? '隐藏密码' : '显示密码'} aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? <IconEyeOff size={19} /> : <IconEye size={19} />}</button></span></label>
          {register && <p id="password-hint" className="field-hint">至少 12 个字符，可以使用便于记忆的长密码。</p>}
        </fieldset>
        {error && <p className="account-error" role="alert">{error}</p>}
        <button className="btn btn-primary auth-submit" disabled={busy} type="submit">{busy ? (register ? '正在创建账号…' : '正在登录…') : (register ? '创建账号' : '登录')} {!busy && <IconArrowRight size={18} />}</button>
        <p className="auth-switch">{register ? '已经有账号？' : '第一次来？'} <a aria-disabled={busy} onClick={e => { if (busy) e.preventDefault(); }} href={`#/${register ? 'login' : 'register'}?next=${encodeURIComponent(safeNext(next))}`}>{register ? '去登录' : '创建账号'}</a></p>
      </form>
      <div className="auth-help"><button type="button" onClick={() => setHelp(!help)} aria-expanded={help}>无法登录？</button><a href="#/studio">先试用编辑器 <IconArrowRight size={14} /></a></div>
      {help && <p className="field-hint" role="status">确认正在访问创建账号时的同一个 IMStage 实例。当前版本尚未配置邮件找回；忘记密码请联系实例管理员。已有作品不会因为登录失败而删除。</p>}
      <p className="auth-instance"><IconLock size={14} /> 账号和作品保存在当前 IMStage 实例</p>
    </div>
  </section>;
}

import { useEffect, useState, type FormEvent } from 'react';
import { IconArrowUpRight, IconBrandOpenai, IconCheck, IconCopy, IconKey, IconLink } from '@tabler/icons-react';
import { useAuth } from '../account/Auth';
import { api, errorText, loginLink } from '../account/api';
import { useLocale } from '../marketing/LocaleContext';
import { STARTER_PROMPTS } from '../marketing/ConnectionSection';
import './connections.css';

type Connection = { id: string; clientName: string; createdAt: string; lastUsedAt: string | null; scopes: string[]; kind: 'oauth' | 'token' };
type Config = { mcpUrl: string; authorizationSupported: boolean; directoryUrl: string | null; manualSetupRequired: boolean };
type Consent = { requestId: string; clientName: string; scopes: string[]; redirectHost: string };

function CopyButton({ value, label }: { value: string; label: string }) {
  const { locale } = useLocale();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => setState('idle'), [value]);
  return <div className="connection-copy-control"><button type="button" className="btn btn-secondary" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setState('copied'); } catch { setState('failed'); }
  }}>{state === 'copied' ? <IconCheck size={17} aria-hidden="true" /> : <IconCopy size={17} aria-hidden="true" />}{label}</button>
  <span role="status">{state === 'copied' ? (locale === 'zh' ? '已复制' : 'Copied') : state === 'failed' ? (locale === 'zh' ? '请选择内容后手动复制。' : 'Select the text and copy it manually.') : ''}</span></div>;
}

function ConsentView({ requestId }: { requestId?: string }) {
  const { locale } = useLocale();
  const zh = locale === 'zh';
  const { user } = useAuth();
  const [details, setDetails] = useState<Consent | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDetails(null); setError('');
    if (!requestId) { setError(zh ? '授权链接不完整，请回到 ChatGPT 重新连接。' : 'The authorization link is incomplete. Start the connection again in ChatGPT.'); return; }
    void api<Consent>(`/oauth/consent?request=${encodeURIComponent(requestId)}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setDetails(value); })
      .catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => controller.abort();
  }, [requestId, user?.id, attempt, zh]);
  async function decide(approved: boolean) {
    if (!details || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ redirectUrl: string }>('/oauth/consent', { method: 'POST', body: { requestId: details.requestId, approved } });
      const target = new URL(result.redirectUrl);
      if (target.username || target.password || !['https:', 'http:'].includes(target.protocol) || (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) throw new Error(zh ? '返回地址无效，请重新连接。' : 'Invalid return URL. Start the connection again.');
      window.location.assign(target.href);
    } catch (reason) { setError(errorText(reason)); setBusy(false); }
  }
  return <section className="connection-consent">
    <IconLink size={32} aria-hidden="true" /><h1>{zh ? '允许连接你的 IMStage？' : 'Connect to your IMStage account?'}</h1>
    <p>{zh ? '当前账号' : 'Signed in as'} <strong>{user?.email}</strong></p>
    {!details && !error && <p role="status">{zh ? '正在读取授权请求…' : 'Loading the authorization request…'}</p>}
    {details && <><div className="connection-consent-details"><h2>{details.clientName}</h2><p>{zh ? '将获得以下权限：' : 'Requests permission to:'}</p>
      <ul>{details.scopes.map(scope => <li key={scope}>{scope === 'imstage.scenes' ? (zh ? '读取、创建、修改你的聊天作品，并渲染为图片' : 'Read, create, edit and render your scenes') : scope}</li>)}</ul>
      <p className="connection-note">{zh ? '授权后返回：' : 'Return to: '}<strong>{details.redirectHost}</strong></p>
      <p className="connection-note">{zh ? '可以随时在「已连接应用」中断开。' : 'You can disconnect at any time from Connected apps.'}</p></div>
      <div className="connection-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void decide(true)}>{busy ? (zh ? '正在处理…' : 'Working…') : (zh ? '允许连接' : 'Allow connection')}</button><button className="btn btn-secondary" disabled={busy} onClick={() => void decide(false)}>{zh ? '取消' : 'Cancel'}</button></div></>}
    {error && <div className="connection-error" role="alert"><p>{error}</p>{!details && <button className="btn btn-secondary" onClick={() => setAttempt(n => n + 1)}>{zh ? '重试' : 'Retry'}</button>} <a href="#/connect">{zh ? '返回连接页面' : 'Back to connections'}</a></div>}
  </section>;
}

function ConnectionManager() {
  const { locale } = useLocale(); const zh = locale === 'zh';
  const [items, setItems] = useState<Connection[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    void api<{ items: Connection[] }>('/connections', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setItems(result.items);
    }).catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => controller.abort();
  }, [attempt]);
  async function revoke(id: string) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try {
      await api(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} });
      setItems(current => current?.filter(item => item.id !== id) ?? null); setConfirm(null);
      if (tokenId === id) { setToken(''); setTokenId(''); }
      setNotice(zh ? '已断开，该连接无法再访问你的作品。' : 'Disconnected. This connection can no longer access your scenes.');
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  async function createToken(event: FormEvent) {
    event.preventDefault(); if (busy || !name.trim()) return; setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ token: string; connection: Connection }>('/connections/tokens', { method: 'POST', body: { name: name.trim() } });
      setToken(result.token); setTokenId(result.connection.id); setItems(current => [result.connection, ...(current ?? [])]); setName('');
    } catch (reason) { setError(errorText(reason)); } finally { setBusy(false); }
  }
  return <section className="connection-manager" aria-labelledby="connection-manager-title"><div className="connection-section-heading"><h2 id="connection-manager-title">{zh ? '已连接应用' : 'Connected apps'}</h2><button className="text-link" disabled={busy} onClick={() => setAttempt(n => n + 1)}>{zh ? '刷新状态' : 'Refresh status'}</button></div>
    {items === null && !error && <p role="status">{zh ? '正在读取连接…' : 'Loading connections…'}</p>}
    {items?.length === 0 && <p className="connection-note">{zh ? '还没有授权连接。完成 ChatGPT 中的设置后，在这里查看。' : 'No authorized connections yet. Finish setup in ChatGPT to see it here.'}</p>}
    {items && items.length > 0 && <ul className="connection-list">{items.map(item => <li key={item.id}><div><strong>{item.clientName}</strong><p>{item.kind === 'token' ? (zh ? '个人访问令牌' : 'Personal access token') : item.lastUsedAt ? (zh ? '已使用' : 'Used') : (zh ? '已授权，等待首次使用' : 'Authorized, awaiting first use')}{item.lastUsedAt && <> · {new Date(item.lastUsedAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</>}</p></div>
      {confirm === item.id ? <div className="connection-revoke"><p>{zh ? '断开后，此应用需要重新授权。' : 'This app will need authorization again.'}</p><button disabled={busy} className="btn btn-secondary" onClick={() => void revoke(item.id)}>{zh ? '确认断开' : 'Disconnect now'}</button><button disabled={busy} className="text-link" onClick={() => setConfirm(null)}>{zh ? '取消' : 'Cancel'}</button></div> : <button className="text-link" disabled={busy} onClick={() => setConfirm(item.id)}>{zh ? '断开' : 'Disconnect'}</button>}</li>)}</ul>}
    <p className="connection-note" role="status">{notice}</p>
    <details className="connection-advanced"><summary><IconKey size={18} aria-hidden="true" />{zh ? '高级接入：个人访问令牌' : 'Advanced: personal access tokens'}</summary>
      <p>{zh ? '用于支持 Bearer token 的客户端，有效期 90 天。ChatGPT 连接请使用上方的登录授权流程。' : 'For clients that support Bearer tokens. Tokens expire after 90 days. Use the authorization flow above for ChatGPT.'}</p>
      <form onSubmit={createToken}><label htmlFor="connection-token-name">{zh ? '令牌名称' : 'Token name'}</label><div className="connection-token-form"><input id="connection-token-name" required maxLength={60} value={name} placeholder={zh ? '例如：我的本地工具' : 'e.g. My local tool'} onChange={event => setName(event.target.value)} disabled={busy} /><button className="btn btn-secondary" disabled={busy || !name.trim() || Boolean(token)}>{zh ? '生成令牌' : 'Create token'}</button></div></form>
      {token && <div className="connection-token-result"><label htmlFor="connection-new-token">{zh ? '仅显示这一次，请保存到客户端的凭据设置。不要粘贴到聊天里。' : 'Shown only once. Save it in your client’s credential settings, not in a chat.'}</label><textarea id="connection-new-token" readOnly value={token} spellCheck={false} /><CopyButton value={token} label={zh ? '复制令牌' : 'Copy token'} /><button className="text-link" onClick={() => setToken('')}>{zh ? '我已保存，隐藏令牌' : 'Saved. Hide token'}</button></div>}
    </details>
    {error && <p className="connection-error" role="alert">{error}</p>}
  </section>;
}

export default function ConnectionsPage({ requestId, consent = false }: { requestId?: string; consent?: boolean }) {
  const { locale } = useLocale(); const zh = locale === 'zh';
  const { user, loading, unavailable, refresh } = useAuth();
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (consent) return;
    const controller = new AbortController(); setConfig(null); setError('');
    void api<Config>('/connections/config', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setConfig(result);
    }).catch(reason => { if (!controller.signal.aborted) setError(errorText(reason)); });
    return () => controller.abort();
  }, [consent, attempt]);
  const next = consent ? `/connect/authorize${requestId ? `?request=${encodeURIComponent(requestId)}` : ''}` : '/connect';
  if (consent && user && !unavailable) return <div className="connections-page"><ConsentView requestId={requestId} /></div>;
  const signIn = <div className="connection-signin"><p>{unavailable ? (zh ? '账号服务暂时不可用，请重试。' : 'Account service is unavailable. Please retry.') : (zh ? '使用你的 IMStage 账号，作品会保存在同一个工作台。' : 'Use your IMStage account to keep your scenes in the same workspace.')}</p>{unavailable ? <button className="btn btn-secondary" onClick={() => void refresh()}>{zh ? '重新连接' : 'Retry'}</button> : <a className="btn btn-primary" href={loginLink(next)}>{zh ? '登录并继续' : 'Sign in to continue'}<IconArrowUpRight size={17} aria-hidden="true" /></a>}</div>;
  return <div className="connections-page"><a className="text-link" href={user ? '#/account' : '#/'}>{zh ? '返回' : 'Back'}</a>
    <header className="connection-intro"><IconBrandOpenai size={38} aria-hidden="true" /><h1>{zh ? '把 IMStage 带进 ChatGPT。' : 'Bring IMStage into ChatGPT.'}</h1><p>{zh ? '连接一次。之后，说一句就开始创作。' : 'Connect once. Then start creating with a sentence.'}</p></header>
    {loading ? <p role="status">{zh ? '正在读取账号…' : 'Loading your account…'}</p> : (!user || unavailable) && signIn}
    {!consent && <>
      {error && <div className="connection-error" role="alert"><p>{error}</p><button className="btn btn-secondary" onClick={() => setAttempt(n => n + 1)}>{zh ? '重试' : 'Retry'}</button></div>}
      {!config && !error && <p role="status">{zh ? '正在读取接入方式…' : 'Loading connection details…'}</p>}
      {config?.authorizationSupported && <ol className="connection-steps">
        <li><div><h2>{zh ? '复制连接地址' : 'Copy the connection URL'}</h2><p>{zh ? '这只是服务地址，不包含你的密码或令牌。' : 'This is the service address. It contains no password or token.'}</p><label className="sr-only" htmlFor="connection-url">{zh ? '连接地址' : 'Connection URL'}</label><input id="connection-url" readOnly value={config.mcpUrl} /><CopyButton value={config.mcpUrl} label={zh ? '复制地址' : 'Copy URL'} /></div></li>
        <li><div><h2>{zh ? '在 ChatGPT 添加 IMStage' : 'Add IMStage in ChatGPT'}</h2><p>{zh ? '打开 Plugins，点击加号，进入 Create app / Create MCP App。名称填 IMStage，Server URL 粘贴上面的地址，Authentication 选择 OAuth。' : 'Open Plugins, click +, then Create app / Create MCP App. Set the name to IMStage, paste the URL into Server URL, and choose OAuth for Authentication.'}</p><a className="btn btn-secondary" href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">{zh ? '打开 ChatGPT' : 'Open ChatGPT'}<IconArrowUpRight size={17} aria-hidden="true" /></a><details className="connection-help"><summary>{zh ? '没有看到添加入口？' : 'Can’t find the add button?'}</summary><p>{zh ? '在 ChatGPT 设置中的「安全与登录」开启开发者模式。入口可能受账号和工作区策略限制；当前需要手动添加，尚未通过公开目录安装。' : 'Enable Developer mode under Security and login in ChatGPT settings. Availability depends on your account and workspace policy. This connection currently requires manual setup; directory installation is not available.'}</p><a className="text-link" href="https://developers.openai.com/plugins/deploy/connect-chatgpt" target="_blank" rel="noreferrer">{zh ? '查看官方连接说明' : 'Official connection guide'}</a></details></div></li>
        <li><div><h2>{zh ? '授权后，说出第一句' : 'Authorize, then try your first prompt'}</h2><p>{zh ? '在授权页确认你的账号。回到 ChatGPT，选择 IMStage，再发送：' : 'Confirm your account on the authorization page. Return to ChatGPT, select IMStage, and send:'}</p><blockquote>{STARTER_PROMPTS[locale]}</blockquote><CopyButton value={STARTER_PROMPTS[locale]} label={zh ? '复制示例指令' : 'Copy starter prompt'} /></div></li>
      </ol>}
      {user && !unavailable && <ConnectionManager key={user.id} />}
    </>}
  </div>;
}

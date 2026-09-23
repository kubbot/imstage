import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { IconArrowUpRight, IconBrandOpenai, IconCheck, IconCopy, IconKey, IconLink } from '@tabler/icons-react';
import { useAuth } from '../account/Auth';
import { api, errorText, loginLink } from '../account/api';
import { useLocale } from '../marketing/LocaleContext';
import { STARTER_PROMPTS } from '../marketing/ConnectionSection';
import './connections.css';

type ConnectionStatus = 'awaiting_auth' | 'authenticated' | 'connected';
type Connection = {
  id: string;
  clientName: string;
  createdAt: string;
  lastUsedAt: string | null;
  toolsDiscoveredAt?: string | null;
  status?: ConnectionStatus;
  scopes: string[];
  kind: 'oauth' | 'token';
};
type Config = {
  mcpUrl: string;
  authorizationSupported: boolean;
  directoryUrl: string | null;
  manualSetupRequired: boolean;
  loopbackRedirectsSupported?: boolean;
};
type Consent = { requestId: string; clientName: string; scopes: string[]; redirectHost: string };
type ClientKind = 'chatgpt' | 'codex' | 'other';

const CLIENT_OPTIONS: ReadonlyArray<{ id: ClientKind; zh: string; en: string; zhHint: string; enHint: string }> = [
  { id: 'chatgpt', zh: 'ChatGPT', en: 'ChatGPT', zhHint: '在网页版 ChatGPT 的 Plugins 中手动添加', enHint: 'Add it manually under Plugins in ChatGPT' },
  { id: 'codex', zh: 'Codex', en: 'Codex', zhHint: '使用 Codex CLI 的官方 mcp 命令', enHint: 'Use the official Codex CLI mcp commands' },
  { id: 'other', zh: '其他客户端', en: 'Other clients', zhHint: '任意支持远程 HTTP MCP + OAuth 2.1 的客户端', enHint: 'Any client that supports remote HTTP MCP + OAuth 2.1' },
];

function readClientFromLocation(): ClientKind {
  try {
    const query = location.hash.split('?')[1] ?? '';
    const value = new URLSearchParams(query).get('client');
    return value === 'codex' || value === 'other' ? value : 'chatgpt';
  } catch {
    return 'chatgpt';
  }
}

/** Loopback redirects are the norm, so an older config without the flag still works. */
function loopbackSupported(config: Config | null): boolean {
  return config?.loopbackRedirectsSupported !== false;
}

function CopyButton({ value, label, ariaLabel }: { value: string; label: string; ariaLabel?: string }) {
  const { locale } = useLocale();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => setState('idle'), [value]);
  return <div className="connection-copy-control"><button type="button" className="btn btn-secondary" aria-label={ariaLabel ?? label} onClick={async () => {
    try { await navigator.clipboard.writeText(value); setState('copied'); } catch { setState('failed'); }
  }}>{state === 'copied' ? <IconCheck size={17} aria-hidden="true" /> : <IconCopy size={17} aria-hidden="true" />}{label}</button>
  <span role="status">{state === 'copied' ? (locale === 'zh' ? '已复制' : 'Copied') : state === 'failed' ? (locale === 'zh' ? '请选择内容后手动复制。' : 'Select the text and copy it manually.') : ''}</span></div>;
}

function CommandBlock({ command, label }: { command: string; label: string }) {
  return <div className="connection-command-block">
    <pre className="connection-command"><code>{command}</code></pre>
    <CopyButton value={command} label={label} ariaLabel={label} />
  </div>;
}

function ClientPicker({ value, onChange, zh }: { value: ClientKind; onChange: (next: ClientKind) => void; zh: boolean }) {
  const legendId = useId();
  return <fieldset className="connection-clients" aria-labelledby={legendId}>
    <legend id={legendId}>{zh ? '选择要连接的客户端' : 'Choose the client to connect'}</legend>
    <div className="connection-client-options">
      {CLIENT_OPTIONS.map(option => <label key={option.id} className={`connection-client${value === option.id ? ' is-selected' : ''}`}>
        <input type="radio" name="connection-client" value={option.id} checked={value === option.id} onChange={() => onChange(option.id)} />
        <span className="connection-client-body"><strong>{zh ? option.zh : option.en}</strong><span>{zh ? option.zhHint : option.enHint}</span></span>
      </label>)}
    </div>
  </fieldset>;
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
    if (!requestId) { setError(zh ? '授权链接不完整，请回到客户端重新连接。' : 'The authorization link is incomplete. Start the connection again in your client.'); return; }
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
  const loopbackReturn = details ? /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(details.redirectHost) : false;
  return <section className="connection-consent">
    <IconLink size={32} aria-hidden="true" /><h1>{zh ? '允许连接你的 IMStage？' : 'Connect to your IMStage account?'}</h1>
    <p>{zh ? '当前账号' : 'Signed in as'} <strong>{user?.email}</strong></p>
    {!details && !error && <p role="status">{zh ? '正在读取授权请求…' : 'Loading the authorization request…'}</p>}
    {details && <><div className="connection-consent-details"><h2>{details.clientName}</h2><p>{zh ? '将获得以下权限：' : 'Requests permission to:'}</p>
      <ul>{details.scopes.map(scope => <li key={scope}>{scope === 'imstage.scenes' ? (zh ? '读取、创建、修改你的聊天作品，并渲染为图片' : 'Read, create, edit and render your scenes') : scope}</li>)}</ul>
      <p className="connection-note">{zh ? '授权后返回：' : 'Return to: '}<strong>{details.redirectHost}</strong></p>
      {loopbackReturn && <p className="connection-note">{zh ? '这是本机客户端。授权后会由浏览器自动返回，无需复制令牌或地址。' : 'This is a local client. The browser returns to it automatically; there is no token or URL to copy.'}</p>}
      <p className="connection-note">{zh ? '可以随时在「已连接应用」中断开。' : 'You can disconnect at any time from Connected apps.'}</p></div>
      <div className="connection-actions"><button className="btn btn-primary" disabled={busy} onClick={() => void decide(true)}>{busy ? (zh ? '正在处理…' : 'Working…') : (zh ? '允许连接' : 'Allow connection')}</button><button className="btn btn-secondary" disabled={busy} onClick={() => void decide(false)}>{zh ? '取消' : 'Cancel'}</button></div></>}
    {error && <div className="connection-error" role="alert"><p>{error}</p>{!details && <button className="btn btn-secondary" onClick={() => setAttempt(n => n + 1)}>{zh ? '重试' : 'Retry'}</button>} <a href="#/connect">{zh ? '返回连接页面' : 'Back to connections'}</a></div>}
  </section>;
}

function ChatGPTInstructions({ mcpUrl, zh }: { mcpUrl: string; zh: boolean }) {
  return <ol className="connection-steps">
    <li><div><h2>{zh ? '复制连接地址' : 'Copy the connection URL'}</h2><p>{zh ? '这只是服务地址，不包含你的密码或令牌。' : 'This is the service address. It contains no password or token.'}</p><label className="sr-only" htmlFor="connection-url">{zh ? '连接地址' : 'Connection URL'}</label><input id="connection-url" readOnly value={mcpUrl} /><CopyButton value={mcpUrl} label={zh ? '复制地址' : 'Copy URL'} /></div></li>
    <li><div><h2>{zh ? '在 ChatGPT 添加 IMStage' : 'Add IMStage in ChatGPT'}</h2><p>{zh ? '打开 Plugins，点击加号，进入 Create app / Create MCP App。名称填 IMStage，Server URL 粘贴上面的地址，Authentication 选择 OAuth。' : 'Open Plugins, click +, then Create app / Create MCP App. Set the name to IMStage, paste the URL into Server URL, and choose OAuth for Authentication.'}</p><a className="btn btn-secondary" href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">{zh ? '打开 ChatGPT' : 'Open ChatGPT'}<IconArrowUpRight size={17} aria-hidden="true" /></a><details className="connection-help"><summary>{zh ? '没有看到添加入口？' : 'Can’t find the add button?'}</summary><p>{zh ? '在 ChatGPT 设置中的「安全与登录」开启开发者模式。入口可能受账号和工作区策略限制；当前需要手动添加，尚未通过公开目录安装。' : 'Enable Developer mode under Security and login in ChatGPT settings. Availability depends on your account and workspace policy. This connection currently requires manual setup; directory installation is not available.'}</p><a className="text-link" href="https://developers.openai.com/plugins/deploy/connect-chatgpt" target="_blank" rel="noreferrer">{zh ? '查看官方连接说明' : 'Official connection guide'}</a></details></div></li>
    <li><div><h2>{zh ? '确认授权并检查工具' : 'Authorize and check the tools'}</h2><p>{zh ? '在授权页确认你的账号，回到 ChatGPT 选择 IMStage。连接页只有在真实的工具列表请求成功后才会显示“已连接”。' : 'Confirm your account on the authorization page and select IMStage back in ChatGPT. This page shows “Connected” only after a real tools list request succeeds.'}</p></div></li>
  </ol>;
}

function CodexInstructions({ mcpUrl, supported, zh }: { mcpUrl: string; supported: boolean; zh: boolean }) {
  const name = 'imstage';
  const addCommand = `codex mcp add ${name} --url ${mcpUrl}`;
  const loginCommand = `codex mcp login ${name}`;
  return <>
    <ol className="connection-steps">
      <li><div><h2>{zh ? '在终端添加 IMStage 连接' : 'Add the IMStage connection in your terminal'}</h2><p>{zh ? '名称使用 imstage，--url 指向本服务的 MCP 地址。这是 Codex CLI 的官方命令，不是一次性链接。' : 'The name is imstage and --url points at this MCP server. This is the official Codex CLI command, not a one-click link.'}</p><CommandBlock command={addCommand} label={zh ? '复制添加命令' : 'Copy add command'} /><details className="connection-help"><summary>{zh ? '命令是否正确？' : 'Is this command correct?'}</summary><p>{zh ? '写法与 codex mcp add --help 一致（codex-cli 0.149+）。如果你的版本没有 mcp 子命令，请改用「其他客户端」或下方的高级个人访问令牌。' : 'This matches codex mcp add --help (codex-cli 0.149+). If your version has no mcp command, choose “Other clients” or use the advanced personal access token below.'}</p></details></div></li>
      <li><div><h2>{zh ? '在浏览器完成登录授权' : 'Sign in and authorize in the browser'}</h2><CommandBlock command={loginCommand} label={zh ? '复制登录命令' : 'Copy login command'} /><p>{zh ? 'Codex 会打开浏览器，使用本账号登录并点击“允许连接”。授权后浏览器自动回到本机 Codex，不需要复制或粘贴 token。' : 'Codex opens the browser. Sign in and click Allow; the browser returns to Codex automatically. No token to copy or paste.'}</p>{!supported && <p className="connection-error" role="alert">{zh ? '当前服务未开启本地回环回调，Codex 的浏览器授权无法完成。请改用「其他客户端」，或在下方高级设置创建个人访问令牌。' : 'This server has local loopback redirects disabled, so Codex browser authorization cannot complete. Choose “Other clients” or create a personal access token under Advanced below.'}</p>}</div></li>
      <li><div><h2>{zh ? '确认工具发现' : 'Confirm tool discovery'}</h2><p>{zh ? '回到 Codex，让它列出 IMStage 工具，或发送下面的示例指令。连接页只有在真实的 tools/list 成功后才会显示“已连接”。' : 'Back in Codex, ask it to list IMStage tools or send the starter prompt below. This page shows “Connected” only after a real tools/list succeeds.'}</p></div></li>
    </ol>
    <details className="connection-help"><summary>{zh ? '直接用命令行验证' : 'Verify from the command line'}</summary><p>{zh ? '也可以运行 codex mcp list 查看已配置的服务器；登录后可运行 codex mcp get imstage 检查 OAuth 状态。' : 'You can also run codex mcp list to review configured servers, and codex mcp get imstage after login to check the OAuth state.'}</p></details>
  </>;
}

function OtherInstructions({ mcpUrl, supported, zh }: { mcpUrl: string; supported: boolean; zh: boolean }) {
  return <ol className="connection-steps">
    <li><div><h2>{zh ? '添加远程 MCP 服务器' : 'Add the remote MCP server'}</h2><p>{zh ? '在客户端里选择“远程 / Streamable HTTP MCP”，服务器地址填：' : 'In your client, choose a remote / Streamable HTTP MCP server and enter:'}</p><label className="sr-only" htmlFor="connection-url-other">{zh ? '连接地址' : 'Connection URL'}</label><input id="connection-url-other" readOnly value={mcpUrl} /><CopyButton value={mcpUrl} label={zh ? '复制地址' : 'Copy URL'} /></div></li>
    <li><div><h2>{zh ? '认证方式选择 OAuth 2.1' : 'Choose OAuth 2.1 authentication'}</h2><p>{zh ? '客户端会打开浏览器完成授权码 + PKCE (S256)。不要手填 token，也不要把账号密码交给客户端。' : 'The client opens a browser for authorization code + PKCE (S256). Never enter a token by hand or give a client your password.'}</p><p>{supported ? (zh ? '原生客户端使用 localhost / 127.0.0.1 / [::1] 回环回调时会由浏览器自动返回；本地端口可以随机（RFC 8252），但协议、主机、路径与查询必须与客户端注册的一致。公网回调仍然必须是 HTTPS。' : 'Native clients using a localhost / 127.0.0.1 / [::1] loopback redirect return automatically; the local port may be random (RFC 8252), while scheme, host, path and query must still match what the client registered. Public redirects must remain HTTPS.') : (zh ? '当前服务未开启本地回环回调；如果客户端使用回环回调将无法完成授权。' : 'This server has local loopback redirects disabled; authorization cannot complete for clients that use a loopback redirect.')}</p></div></li>
    <li><div><h2>{zh ? '只能使用 Bearer 令牌？' : 'Bearer tokens only?'}</h2><p>{zh ? '在下方「高级接入：个人访问令牌」生成一个一次性令牌，粘贴到客户端的凭据设置。它不能用于浏览器授权流程。' : 'Create a one-time token under “Advanced: personal access tokens” below and paste it into your client’s credential settings. It cannot be used for the browser authorization flow.'}</p></div></li>
  </ol>;
}

function StarterPrompt({ zh }: { zh: boolean }) {
  const { locale } = useLocale();
  return <section className="connection-starter" aria-labelledby="connection-starter-title">
    <h2 id="connection-starter-title">{zh ? '授权后，说出第一句' : 'After authorizing, try your first prompt'}</h2>
    <p>{zh ? '在客户端选择 IMStage，然后发送：' : 'Select IMStage in your client, then send:'}</p>
    <blockquote>{STARTER_PROMPTS[locale]}</blockquote>
    <CopyButton value={STARTER_PROMPTS[locale]} label={zh ? '复制示例指令' : 'Copy starter prompt'} />
  </section>;
}

function connectionStatus(item: Connection, zh: boolean): ReactNode {
  if (item.status === 'connected') return zh ? '已连接，工具已发现' : 'Connected — tools discovered';
  if (item.status === 'authenticated') return zh ? '已认证，等待工具发现' : 'Authenticated — verifying tools';
  if (item.kind === 'token') return zh ? '等待首次使用' : 'Awaiting first use';
  return zh ? '已授权，等待客户端连接' : 'Authorized — waiting for the client';
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
    {items?.length === 0 && <p className="connection-note">{zh ? '还没有授权连接。按上面的步骤添加客户端后，在这里查看状态。' : 'No authorized connections yet. Add a client with the steps above and check back here.'}</p>}
    {items && items.length > 0 && <ul className="connection-list">{items.map(item => <li key={item.id}><div><strong>{item.clientName}</strong><p className="connection-status-line"><span className={`connection-status connection-status-${item.status ?? 'awaiting_auth'}`}>{connectionStatus(item, zh)}</span>{item.kind === 'token' && <>{' · '}{zh ? '个人访问令牌' : 'Personal access token'}</>}</p>
      <p className="connection-meta">{item.lastUsedAt ? <>{zh ? '最近认证' : 'Last authenticated'} · {new Date(item.lastUsedAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</> : <>{zh ? '创建于' : 'Created'} · {new Date(item.createdAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</>}{item.toolsDiscoveredAt && <>{' · '}{zh ? '工具发现于' : 'Tools discovered'} · {new Date(item.toolsDiscoveredAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</>}</p></div>
      {confirm === item.id ? <div className="connection-revoke"><p>{zh ? '断开后，此应用需要重新授权。' : 'This app will need authorization again.'}</p><button disabled={busy} className="btn btn-secondary" onClick={() => void revoke(item.id)}>{zh ? '确认断开' : 'Disconnect now'}</button><button disabled={busy} className="text-link" onClick={() => setConfirm(null)}>{zh ? '取消' : 'Cancel'}</button></div> : <button className="text-link" disabled={busy} onClick={() => setConfirm(item.id)}>{zh ? '断开' : 'Disconnect'}</button>}</li>)}</ul>}
    <p className="connection-note" role="status">{notice}</p>
    <details className="connection-advanced"><summary><IconKey size={18} aria-hidden="true" />{zh ? '高级接入：个人访问令牌' : 'Advanced: personal access tokens'}</summary>
      <p>{zh ? '仅用于只支持 Bearer token 的客户端，有效期 90 天；不能用于浏览器 OAuth 授权。不需要令牌时请忽略这里。' : 'Only for clients that support Bearer tokens. Tokens expire after 90 days and cannot be used for the browser OAuth flow. Ignore this if you do not need it.'}</p>
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
  const [client, setClient] = useState<ClientKind>(readClientFromLocation);
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
  function choose(next: ClientKind) {
    setClient(next);
    if (consent) return;
    const target = next === 'chatgpt' ? '#/connect' : `#/connect?client=${next}`;
    if (location.hash !== target) history.replaceState(null, '', target);
  }
  const next = consent ? `/connect/authorize${requestId ? `?request=${encodeURIComponent(requestId)}` : ''}` : client === 'chatgpt' ? '/connect' : `/connect?client=${client}`;
  if (consent && user && !unavailable) return <div className="connections-page"><ConsentView requestId={requestId} /></div>;
  const signIn = <div className="connection-signin"><p>{unavailable ? (zh ? '账号服务暂时不可用，请重试。' : 'Account service is unavailable. Please retry.') : (zh ? '使用你的 IMStage 账号，作品会保存在同一个工作台。' : 'Use your IMStage account to keep your scenes in the same workspace.')}</p>{unavailable ? <button className="btn btn-secondary" onClick={() => void refresh()}>{zh ? '重新连接' : 'Retry'}</button> : <a className="btn btn-primary" href={loginLink(next)}>{zh ? '登录并继续' : 'Sign in to continue'}<IconArrowUpRight size={17} aria-hidden="true" /></a>}</div>;
  const supported = loopbackSupported(config);
  return <div className="connections-page"><a className="text-link" href={user ? '#/account' : '#/'}>{zh ? '返回' : 'Back'}</a>
    <header className="connection-intro"><IconBrandOpenai size={38} aria-hidden="true" /><h1>{zh ? '把 IMStage 带进你的 AI 客户端。' : 'Bring IMStage into your AI client.'}</h1><p>{zh ? '先选择客户端，按对应步骤连接一次；之后用一句话开始创作。' : 'Choose your client, connect once with the matching steps, then start creating with a sentence.'}</p></header>
    {loading ? <p role="status">{zh ? '正在读取账号…' : 'Loading your account…'}</p> : (!user || unavailable) && signIn}
    {!consent && <>
      {error && <div className="connection-error" role="alert"><p>{error}</p><button className="btn btn-secondary" onClick={() => setAttempt(n => n + 1)}>{zh ? '重试' : 'Retry'}</button></div>}
      {!config && !error && <p role="status">{zh ? '正在读取接入方式…' : 'Loading connection details…'}</p>}
      {config && config.authorizationSupported && <>
        <ClientPicker value={client} onChange={choose} zh={zh} />
        {client === 'chatgpt' ? <ChatGPTInstructions mcpUrl={config.mcpUrl} zh={zh} /> : client === 'codex' ? <CodexInstructions mcpUrl={config.mcpUrl} supported={supported} zh={zh} /> : <OtherInstructions mcpUrl={config.mcpUrl} supported={supported} zh={zh} />}
        <StarterPrompt zh={zh} />
      </>}
      {config && !config.authorizationSupported && <p className="connection-note" role="note">{zh ? '该服务未启用授权连接。请使用下方的高级个人访问令牌。' : 'This server has authorization disabled. Use the advanced personal access token below.'}</p>}
      {user && !unavailable && <ConnectionManager key={user.id} />}
    </>}
  </div>;
}

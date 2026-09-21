import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { IconArrowUp, IconCheck, IconDownload, IconMessageCircle, IconPaperclip, IconPlayerStop, IconSparkles, IconWand, IconX, IconArrowBackUp, IconLoader2 } from '@tabler/icons-react';
import { useAuth } from '../account/Auth';
import { api, loginLink } from '../account/api';
import { setNavigationGuard } from '../account/navigation';
import { SceneView } from '../studio/SceneView';
import { createScene, validateScene, PLATFORMS, PLATFORM_LABELS, type Scene, type Platform } from '../studio/model';
import { readImageFile, waitForImages, downloadText } from '../studio/storage';
import { runAgent, type ChatEntry, type ToolEvent } from './client';
import './agent.css';

type Props = { initialScene?: Scene; onSceneChange?: (scene: Scene) => void; accountAction?: (scene: Scene, locked: boolean) => ReactNode; persistLocal?: boolean; disabled?: boolean; onBusyChange?: (busy: boolean) => void; onStorageError?: (error: boolean) => void };
type Turn = ChatEntry & { id: string; tools?: ToolEvent[]; target?: string; failed?: boolean };
const ideas = ['和朋友约周末去上海看展，聊得轻松一点', '生成一段 WhatsApp 英文旅行对话，最后发一个地点', '根据截图重建聊天，把对方名字改成小满'];
const labels: Record<string,string> = { create_scene: '编排对话', upsert_message: '更新消息', delete_message: '移除消息', generate_image: '生成图片' };
export default function AgentStudio({ initialScene, onSceneChange, accountAction, persistLocal = true, disabled = false, onBusyChange, onStorageError }: Props) {
  const { user } = useAuth();
  const recoveryKey = `imstage.agent.${user?.id || 'guest'}.${initialScene?.id || 'draft'}`;
  const [cached] = useState(() => { try { return JSON.parse(sessionStorage.getItem(recoveryKey) || 'null'); } catch { return null; } });
  const [handoff] = useState(() => { if (!user || initialScene) return null; try { return JSON.parse(sessionStorage.getItem('imstage.agent.login-handoff') || 'null'); } catch { return null; } });
  const [scene, setScene] = useState<Scene>(() => {
    if (initialScene) return initialScene;
    const transferred = validateScene(handoff?.scene); if (transferred.ok && transferred.scene) return transferred.scene;
    try { const parsed = validateScene(JSON.parse(sessionStorage.getItem(recoveryKey) || 'null')?.scene); if (parsed.ok && parsed.scene) return parsed.scene; } catch {}
    return { ...createScene(), id: crypto.randomUUID(), title: '新的对话', selfId: 'me', participants: [{id:'me',name:'我'},{id:'other',name:'对方'}], messages: [] };
  });
  const [prompt, setPrompt] = useState(() => { if (typeof handoff?.prompt === 'string') return handoff.prompt.slice(0,4000); try { return JSON.parse(sessionStorage.getItem(recoveryKey) || 'null')?.prompt || ''; } catch { return ''; } });
  const [editPrompt, setEditPrompt] = useState(typeof cached?.editPrompt === 'string' ? cached.editPrompt.slice(0,4000) : '');
  const [turns, setTurns] = useState<Turn[]>(() => { try { const cached = JSON.parse(sessionStorage.getItem(`${recoveryKey}.chat`) || 'null'); return Array.isArray(cached) ? cached.filter(t => ['user','assistant'].includes(t.role) && typeof t.content === 'string' && typeof t.id === 'string').slice(-30) : []; } catch { return []; } });
  const [attachments, setAttachments] = useState<string[]>(() => Array.isArray((handoff || cached)?.attachments) ? (handoff || cached).attachments.filter((a: unknown) => typeof a === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(a) && a.length < 6*1024*1024).slice(0,3) : []);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState(typeof cached?.selected === 'string' ? cached.selected : '');
  const [drawer, setDrawer] = useState(Boolean(cached?.editPrompt));
  const [tab, setTab] = useState<'chat'|'canvas'>('chat');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [caps, setCaps] = useState<{ configured: boolean; model: string; imageConfigured: boolean } | null>(null);
  const [capError, setCapError] = useState(false);
  const [capRetry, setCapRetry] = useState(0);
  const [history, setHistory] = useState<Scene[]>([]);
  const [exporting, setExporting] = useState(false);
  const [full, setFull] = useState(true);
  const [exportScene, setExportScene] = useState<Scene | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const active = useRef(true);
  const liveScene = useRef(scene); liveScene.current = scene;
  const callback = useRef(onSceneChange); callback.current = onSceneChange;
  const input = useRef<HTMLTextAreaElement>(null);
  const editInput = useRef<HTMLTextAreaElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current++; controller.current?.abort(); }; }, []);
  useEffect(() => { callback.current?.(scene); }, [scene]);
  useEffect(() => { onStorageError?.(storageError); }, [storageError, onStorageError]);
  useEffect(() => { try { sessionStorage.setItem(`${recoveryKey}.chat`, JSON.stringify(turns.slice(-30))); } catch {} }, [turns, recoveryKey]);
  useEffect(() => { if (handoff) try { sessionStorage.removeItem('imstage.agent.login-handoff'); } catch {} }, [handoff]);
  useEffect(() => { try { sessionStorage.setItem(recoveryKey, JSON.stringify({ scene: persistLocal ? scene : undefined, prompt, attachments, editPrompt, selected })); setStorageError(false); } catch { setStorageError(true); } }, [scene, prompt, attachments, editPrompt, selected, persistLocal, recoveryKey]);
  useEffect(() => { const abort = new AbortController(); setCapError(false); api<{ configured:boolean;model:string;imageConfigured:boolean }>('/agent/capabilities', { signal: abort.signal }).then(setCaps).catch(() => { if (!abort.signal.aborted) setCapError(true); }); return () => abort.abort(); }, [capRetry]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [turns.length, busy]);
  useEffect(() => { if (drawer) editInput.current?.focus(); }, [drawer, selected]);
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (busy || storageError) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [busy, storageError]);
  useEffect(() => { if (persistLocal && storageError) return setNavigationGuard(() => window.confirm('浏览器无法保留当前内容。离开会丢失未保存的修改，确定离开？')); }, [persistLocal, storageError]);
  const chosen = scene.messages.find(m => m.id === selected);
  const locked = busy || exporting || reading || disabled;
  useEffect(() => { onBusyChange?.(busy || exporting || reading); }, [busy, exporting, reading, onBusyChange]);
  function checkpoint() { setHistory(current => [...current.slice(-9), liveScene.current]); }
  function patch(scene: Scene) { checkpoint(); setScene(scene); }
  async function addFiles(files: File[]) {
    if (locked) return; setReading(true); setFailure('');
    const results: string[] = [];
    for (const file of files.slice(0, 3 - attachments.length)) { const result = await readImageFile(file); if (result.ok) results.push(result.dataUrl); else setFailure(result.error); }
    if (active.current) { setAttachments(old => [...old, ...results].slice(0,3)); setReading(false); }
  }
  async function send(event?: FormEvent, edit = false) {
    event?.preventDefault(); if (locked || controller.current) return;
    const text = (edit ? editPrompt : prompt).trim(); if (!text) { (edit ? editInput : input).current?.focus(); return; }
    if (!user) { setFailure('登录后即可让 Agent 开始创作。'); return; }
    const run = ++sequence.current; const abort = new AbortController(); controller.current = abort;
    const snapshot = liveScene.current; const id = crypto.randomUUID(); const targetId = edit && chosen ? chosen.id : undefined;
    const previous = turns.filter(t => !t.failed).slice(-10).map(({ role, content }) => ({ role, content: content.slice(0,4000) }));
    setTurns(old => [...old, { role: 'user', content: text, id: `${id}-user`, target: targetId }, { role: 'assistant', content: '正在理解你的想法…', id, tools: [], target: targetId }]);
    setBusy(true); setFailure(''); setNotice(''); checkpoint();
    if (edit) setEditPrompt(''); else setPrompt('');
    let completed = false; let changed = false;
    const timeout = setTimeout(() => abort.abort(), 125000);
    const updateTurn = (transform: (turn: Turn) => Turn) => setTurns(old => old.map(turn => turn.id === id ? transform(turn) : turn));
    try {
      for await (const item of runAgent({ prompt: text, scene: snapshot, targetId, attachments: edit ? [] : attachments, history: previous }, user.id, abort.signal)) {
        if (run !== sequence.current) return;
        if (abort.signal.aborted) throw new Error('已停止');
        if (item.type === 'scene') { setScene(item.scene); changed ||= JSON.stringify(item.scene) !== JSON.stringify(snapshot); }
        if (item.type === 'tool') updateTurn(t => ({ ...t, content: '正在更新画面…', tools: [...(t.tools || []).filter(tool => tool.id !== item.id), item] }));
        if (item.type === 'assistant') updateTurn(t => ({ ...t, content: item.text }));
        if (item.type === 'done') completed = true;
      }
      if (run !== sequence.current) return;
      if (!completed || !changed) throw new Error('Agent 没有返回可用的场景修改，请补充需求后重试。');
      setAttachments([]); setNotice('画面已更新，可以继续说想改哪里。');
      updateTurn(t => ({ ...t, content: t.content === '正在更新画面…' ? '画面已更新。' : t.content }));
    } catch (error) {
      if (run !== sequence.current) return;
      const message = abort.signal.aborted ? '已停止，收到的内容已保留。' : error instanceof Error ? error.message : '生成失败，请重试。';
      setFailure(message); updateTurn(t => ({ ...t, content: message, failed: true, tools: t.tools?.map(tool => tool.state === 'running' ? { ...tool, state: 'error', detail: '未完成' } : tool) }));
      if (edit) setEditPrompt(text); else setPrompt(text);
    } finally { clearTimeout(timeout); if (run === sequence.current) { setBusy(false); controller.current = null; } }
  }
  async function exportPng() {
    if (locked || !scene.messages.length) return; setExporting(true); setNotice('正在导出…');
    try {
      flushSync(() => setExportScene(scene)); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!exportRef.current) throw new Error('画面尚未准备好');
      await waitForImages(exportRef.current); await document.fonts.ready;
      const { toPng } = await import('html-to-image');
      const url = await toPng(exportRef.current, { pixelRatio: 2, skipFonts: true });
      const link = document.createElement('a'); link.href = url; link.download = `imstage-${full ? 'long' : '720x1280'}.png`; link.click(); setNotice('PNG 已导出。');
    } catch { setFailure('图片导出失败，画面仍保留，请重试或下载场景文件。'); }
    finally { setExporting(false); setExportScene(null); }
  }
  function transcript(edit = false) {
    return <div className="agent-transcript">{turns.filter(t => !edit || (selected ? t.target === selected : !t.target)).map(turn => <article key={turn.id} className={`agent-turn ${turn.role}${turn.failed ? ' failed' : ''}`}><span>{turn.role === 'user' ? '你' : 'IMStage'}{turn.target && ' · 局部编辑'}</span><p>{turn.content}</p>{!!turn.tools?.length && <details className="agent-tools" open={busy}><summary>{turn.tools.length} 个工具步骤</summary>{turn.tools.map(tool => <div key={tool.id} data-state={tool.state}>{tool.state === 'running' ? <IconLoader2 size={14} className="spinning" /> : tool.state === 'error' ? <IconX size={14} /> : <IconCheck size={14} />}<span>{labels[tool.name] || tool.name}<small>{tool.detail}</small></span></div>)}</details>}</article>)}{!edit && <div ref={endRef} />}</div>;
  }
  function composer(edit = false) {
    return <form className="agent-composer" onSubmit={event => void send(event, edit)}><label className="sr-only" htmlFor={edit ? 'vibe-prompt' : 'agent-prompt'}>{edit ? '描述想怎样修改' : '描述想生成的聊天'}</label><textarea id={edit ? 'vibe-prompt' : 'agent-prompt'} ref={edit ? editInput : input} rows={3} maxLength={4000} disabled={locked} value={edit ? editPrompt : prompt} placeholder={edit ? chosen ? '把这句话改得更自然…' : '让整段对话更有生活感…' : '写一句话，或粘贴一张聊天截图…'} onChange={e => edit ? setEditPrompt(e.target.value) : setPrompt(e.target.value)} onPaste={e => { if (!edit && e.clipboardData.files.length) { e.preventDefault(); void addFiles(Array.from(e.clipboardData.files)); } }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(undefined, edit); } }} />{!edit && attachments.length > 0 && <div className="agent-attachments">{attachments.map((src,i) => <div key={src.slice(-60)}><img src={src} alt={`参考图片 ${i+1}`} /><button type="button" aria-label={`移除参考图片 ${i+1}`} disabled={locked} onClick={() => setAttachments(old => old.filter((_,n) => n !== i))}><IconX size={14} /></button></div>)}</div>}<div className="agent-composer-actions">{!edit && <button type="button" disabled={locked || attachments.length >= 3} aria-label="添加参考图片" onClick={() => fileRef.current?.click()}><IconPaperclip size={18} /></button>}<span>{edit ? chosen ? '仅修改选中消息' : '编辑整个对话' : '⌘ / Ctrl + Enter'}</span>{busy ? <button key="stop" type="button" className="agent-send" aria-label="停止生成" onClick={() => controller.current?.abort()}><IconPlayerStop size={18} /></button> : user ? <button key="send" type="submit" className="agent-send" aria-label={edit ? '发送修改' : '开始生成'} disabled={locked || !(edit ? editPrompt : prompt).trim()}><IconArrowUp size={19} /></button> : <a className="agent-login" href={loginLink('/create')} onClick={e => { try { sessionStorage.setItem('imstage.agent.login-handoff', JSON.stringify({ scene, prompt, attachments })); } catch { e.preventDefault(); setFailure('暂时无法保留登录前的输入，请先下载场景文件，并复制你的需求。'); } }}>登录创作 →</a>}</div></form>;
  }
  return <section className="agent-workspace" aria-label="Agent 对话创作台" data-tab={tab} data-edit={drawer}>
    <header className="agent-heading"><div><IconSparkles size={20} /><h1>对话创作</h1><span>把想法聊成画面</span></div><div className="agent-heading-actions">{user && accountAction?.(scene, locked)}<button className="agent-button" disabled={locked || !history.length} aria-label="撤销上次修改" onClick={() => { const old = history.at(-1); if (old) { setScene(old); setSelected(''); setHistory(h => h.slice(0,-1)); setNotice('已撤销画面修改。'); } }}><IconArrowBackUp size={17} /></button><details className="agent-more"><summary>更多</summary><button onClick={() => downloadText('imstage-scene.json', JSON.stringify(scene, null, 2))}>下载场景 JSON</button></details></div></header>
    <div className="agent-mobile-tabs"><button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>创作 Chat</button><button aria-pressed={tab === 'canvas'} onClick={() => setTab('canvas')}>渲染画面 {busy && '· 生成中'}</button></div>
    <div className="agent-body"><aside className="agent-chat"><div className="agent-panel-label"><IconMessageCircle size={17} /><strong>创作 Chat</strong><span>{busy ? '正在创作' : 'Agent'}</span></div>{!turns.length && <div className="agent-welcome"><div className="agent-emblem"><IconSparkles size={27} stroke={1.3}/></div><h2>想聊一个<br/>什么样的故事？</h2><p>描述人物和情节，或放入一张截图。<br/>AI 编排对话，你随时接着改。</p><div className="agent-ideas">{ideas.map(idea => <button key={idea} onClick={() => { setPrompt(idea); input.current?.focus(); }}>{idea}<IconArrowUp size={14}/></button>)}</div></div>}{transcript()}<div className="agent-input-dock">{capError ? <button className="agent-capability" onClick={() => setCapRetry(v => v+1)}>连接状态读取失败 · 重试</button> : <p className="agent-capability">{caps ? caps.configured ? `${caps.model} · ${caps.imageConfigured ? '消息配图已连接' : '生图服务待配置'}` : '模型服务待配置' : '正在连接 Agent…'}</p>}{composer()}<input hidden ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => { void addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /><small>支持截图、图片 · 最多 3 张，每张 4 MB</small></div></aside>
    <div className="agent-render"><div className="agent-render-toolbar"><label><span className="sr-only">目标聊天平台</span><select aria-label="目标聊天平台" disabled={locked} value={scene.platform} onChange={e => patch({ ...scene, platform: e.target.value as Platform })}>{PLATFORMS.map(p => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}</select></label><span>{busy ? '正在更新画面…' : `${scene.messages.length} 条消息`}</span><div><select aria-label="导出图片范围" value={full ? 'full':'standard'} disabled={locked} onChange={e => setFull(e.target.value === 'full')}><option value="full">长截图</option><option value="standard">普通截图</option></select><button className="agent-button agent-primary" disabled={locked || !scene.messages.length} onClick={() => void exportPng()}><IconDownload size={16}/>{exporting ? '导出中' : '导出 PNG'}</button></div></div><div className="agent-canvas" tabIndex={0} aria-label="实时聊天画面">{!scene.messages.length && <div className="agent-empty-hint"><span>实时渲染</span><p>你的第一句话，从这里开始。</p></div>}<div className={`agent-phone ${!scene.messages.length ? 'empty' : ''}`}><SceneView scene={scene} pendingAssets={busy} selectedId={selected} onSelect={locked ? undefined : id => { setSelected(id); setDrawer(true); }} /></div><p className="agent-canvas-caption">点选画面中的消息，让 AI 继续打磨</p></div><footer className="agent-render-footer"><span role="status">{notice || '每次修改都会同步到画面'}</span><button className="agent-button" aria-expanded={drawer} onClick={() => { setDrawer(!drawer); setSelected(''); }}><IconWand size={17}/>Vibe Edit</button></footer></div>
    {drawer && <aside className="agent-vibe" aria-label="Vibe Edit" onKeyDown={e => { if (e.key === 'Escape') { setDrawer(false); setSelected(''); } }}><div className="agent-panel-label"><IconWand size={18}/><strong>Vibe Edit</strong><button aria-label="关闭 AI 编辑" onClick={() => { setDrawer(false); setSelected(''); }}><IconX size={19}/></button></div><div className="agent-edit-context"><span>{chosen ? '已选中一条消息' : '整个对话'}</span><p>{chosen?.text || '描述你想调整的语气、人物或情节。'}</p>{chosen && <button onClick={() => setSelected('')}>切换到整个对话</button>}</div>{transcript(true)}{chosen && <details className="agent-manual"><summary>手动微调文字</summary><textarea aria-label="选中消息文字" value={chosen.text} disabled={locked} onFocus={() => checkpoint()} onChange={e => setScene(current => ({ ...current, messages: current.messages.map(m => m.id === chosen.id ? { ...m, text: e.target.value } : m) }))}/></details>}<div className="agent-vibe-composer">{composer(true)}</div></aside>}
    </div>{(failure || storageError) && <div className="agent-error" role="alert">{failure || '浏览器暂时无法保存草稿，请保存作品或下载场景 JSON。'}<button aria-label="关闭提示" onClick={() => setFailure('')}><IconX size={16}/></button></div>}
    {exportScene && <div className="agent-export" aria-hidden="true"><div ref={exportRef} style={{ width:360, height:full ? 'auto':640, overflow:'hidden' }}><SceneView scene={exportScene} exportMode/></div></div>}
  </section>;
}

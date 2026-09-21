import DevicePreview from '../studio/DevicePreview';
import {DEVICE_PROFILES,deviceProfile} from '../studio/device-profiles';
import ContactPanel from '../contacts/ContactPanel';
import {useContactLibrary} from '../contacts/useContactLibrary';
import {applySelfDefault} from '../contacts/model';
import ReferenceView from '../studio/ReferenceView';
import ReferenceInspector from './ReferenceInspector';
import ElementInspector from './ElementInspector';
import ElementNavigator from './ElementNavigator';
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { IconArrowUp, IconCheck, IconDownload, IconMessageCircle, IconPaperclip, IconPlayerStop, IconSparkles, IconWand, IconX, IconArrowBackUp, IconArrowForwardUp, IconLayoutSidebarLeftCollapse, IconListDetails, IconPlus, IconMinus, IconLoader2 } from '@tabler/icons-react';
import { useAuth } from '../account/Auth';
import { api, loginLink } from '../account/api';
import { setNavigationGuard } from '../account/navigation';
import { SceneView } from '../studio/SceneView';
import { createScene, validateScene, PLATFORMS, PLATFORM_LABELS, type Scene, type Platform } from '../studio/model';
import { readImageFile, waitForImages, downloadText } from '../studio/storage';
import { runAgent, type ChatEntry, type ToolEvent } from './client';
import './agent.css';

type Props = { initialScene?: Scene; initialProjectId?:string; onProjectChange?:(id:string)=>void; onSceneChange?: (scene: Scene) => void; accountAction?: (scene: Scene, locked: boolean, projectId?:string) => ReactNode; persistLocal?: boolean; disabled?: boolean; onBusyChange?: (busy: boolean) => void; onStorageError?: (error: boolean) => void };
type Turn = ChatEntry & { id: string; tools?: ToolEvent[]; target?: string; failed?: boolean };
const ideas = ['和朋友约周末去上海看展，聊得轻松一点', '生成一段 WhatsApp 英文旅行对话，最后发一个地点', '根据截图重建聊天，把对方名字改成小满'];
const labels: Record<string,string> = { update_element:'调整元素', read_text:'读取文字位置',inspect_region:'查看局部',set_edits:'修改编辑层',render_preview:'检查渲染', create_scene: '编排对话', upsert_message: '更新消息', delete_message: '移除消息', generate_image: '生成图片' };
export default function AgentStudio({ initialScene, initialProjectId, onProjectChange, onSceneChange, accountAction, persistLocal = true, disabled = false, onBusyChange, onStorageError }: Props) {
  const { user } = useAuth();
  const contacts=useContactLibrary(user?.id);
  const [peopleOpen,setPeopleOpen]=useState(false);
  const recoveryKey = `imstage.agent.${user?.id || 'guest'}.${initialScene?.id || 'draft'}`;
  const [cached] = useState(() => { try { return JSON.parse(sessionStorage.getItem(recoveryKey) || 'null'); } catch { return null; } });
  const [handoff] = useState(() => { if (!user || initialScene) return null; try { return JSON.parse(sessionStorage.getItem('imstage.agent.login-handoff') || 'null'); } catch { return null; } });
  const [scene, setScene] = useState<Scene>(() => {
    if (initialScene) return initialScene;
    const transferred = validateScene(handoff?.scene); if (transferred.ok && transferred.scene) return transferred.scene;
    try { const parsed = validateScene(JSON.parse(sessionStorage.getItem(recoveryKey) || 'null')?.scene); if (parsed.ok && parsed.scene) return parsed.scene; } catch {}
    return { ...createScene(), id: crypto.randomUUID(), title: '新的对话', surface:'ios',deviceProfileId:'iphone-17-pro', selfId: 'me', participants: [{id:'me',name:'我'},{id:'other',name:'对方'}], messages: [] };
  });
  const [prompt, setPrompt] = useState(() => { if (typeof handoff?.prompt === 'string') return handoff.prompt.slice(0,4000); try { return JSON.parse(sessionStorage.getItem(recoveryKey) || 'null')?.prompt || ''; } catch { return ''; } });
  const [editPrompt, setEditPrompt] = useState(typeof cached?.editPrompt === 'string' ? cached.editPrompt.slice(0,4000) : '');
  const [turns, setTurns] = useState<Turn[]>(() => { try { const cached = JSON.parse(sessionStorage.getItem(`${recoveryKey}.chat`) || 'null'); return Array.isArray(cached) ? cached.filter(t => ['user','assistant'].includes(t.role) && typeof t.content === 'string' && typeof t.id === 'string').slice(-30) : []; } catch { return []; } });
  const [attachments, setAttachments] = useState<string[]>(() => Array.isArray((handoff || cached)?.attachments) ? (handoff || cached).attachments.filter((a: unknown) => typeof a === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(a) && a.length < 6*1024*1024).slice(0,3) : []);
  const [projectId,setProjectId]=useState(initialProjectId ?? new URLSearchParams(location.hash.split('?')[1]).get('project') ?? (typeof cached?.projectId==='string'?cached.projectId:''));
  const [projects,setProjects]=useState<{id:string;name:string;platform:Platform}[]>([]);
  useEffect(()=>{if(!user)return;const ac=new AbortController();api<{items:{id:string;name:string;platform:Platform}[]}>('/projects',{signal:ac.signal}).then(d=>setProjects(d.items)).catch(()=>{});return()=>ac.abort();},[user]);
  useEffect(()=>{onProjectChange?.(projectId);},[projectId,onProjectChange]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState(typeof cached?.selected === 'string' ? cached.selected : '');
  const [drawer, setDrawer] = useState(() => window.innerWidth > 1100 || Boolean(cached?.editPrompt));
  const [inspectorTab, setInspectorTab] = useState<'properties'|'ai'>('properties');
  const [leftTab, setLeftTab] = useState<'ai'|'elements'>('ai');
  useEffect(() => { const media = matchMedia('(max-width: 1100px)'); const close = () => { if (media.matches) { setDrawer(false); setPeopleOpen(false); } }; media.addEventListener('change', close); return () => media.removeEventListener('change', close); }, []);
  const [chatOpen, setChatOpen] = useState(true);
  const [scopeSelected, setScopeSelected] = useState(false);
  const [zoom, setZoom] = useState<'fit'|number>('fit');
  const [scale, setScale] = useState(1);
  const [future, setFuture] = useState<Scene[]>([]);
  const [tab, setTab] = useState<'chat'|'canvas'>('chat');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [caps, setCaps] = useState<{ configured: boolean; model: string; imageConfigured: boolean } | null>(null);
  const [capError, setCapError] = useState(false);
  const [capRetry, setCapRetry] = useState(0);
  const [history, setHistory] = useState<Scene[]>([]);
  const [exporting, setExporting] = useState(false);
  const [full, setFull] = useState(false);
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
  useEffect(() => { try { sessionStorage.setItem(recoveryKey, JSON.stringify({ scene: persistLocal ? scene : undefined, prompt, attachments, editPrompt, selected, projectId })); setStorageError(false); } catch { setStorageError(true); } }, [scene, prompt, attachments, editPrompt, selected, projectId, persistLocal, recoveryKey]);
  useEffect(() => { const abort = new AbortController(); setCapError(false); api<{ configured:boolean;model:string;imageConfigured:boolean }>('/agent/capabilities', { signal: abort.signal }).then(setCaps).catch(() => { if (!abort.signal.aborted) setCapError(true); }); return () => abort.abort(); }, [capRetry]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [turns.length, busy]);
  useEffect(() => { if (drawer && inspectorTab === 'ai') editInput.current?.focus(); }, [drawer, inspectorTab]);
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (busy || storageError) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [busy, storageError]);
  useEffect(() => { if (persistLocal && storageError) return setNavigationGuard(() => window.confirm('浏览器无法保留当前内容。离开会丢失未保存的修改，确定离开？')); }, [persistLocal, storageError]);
  const chosen = scene.messages.find(m => m.id === selected);
  const locked = busy || exporting || reading || disabled || contacts.saving;
  useEffect(() => { onBusyChange?.(busy || exporting || reading); }, [busy, exporting, reading, onBusyChange]);
  const editGroup = useRef<{ element: Element | null; time: number }>({ element: null, time: 0 });
  function checkpoint() { setHistory(current => [...current.slice(-49), liveScene.current]); setFuture([]); }
  function patch(scene: Scene) {
    if (locked) return;
    const element = document.activeElement;
    const typing = element?.matches('input:not([type=file]),textarea');
    if (!typing || editGroup.current.element !== element || Date.now() - editGroup.current.time > 700) checkpoint();
    else setFuture([]);
    editGroup.current = { element: typing ? element : null, time: Date.now() };
    setScene(scene);
  }
  function selectElement(id: string) {
    editGroup.current.element = null;
    const row = Array.from(document.querySelectorAll<HTMLElement>('.agent-canvas [data-message-id]')).find(el => el.dataset.messageId === id);
    const viewport = row?.closest('.scene-messages');
    if (!full && row && viewport && row.getBoundingClientRect().bottom > viewport.getBoundingClientRect().bottom) { setFull(true); setNotice('已展开长截图，显示选中的消息。'); }
    setSelected(id); setDrawer(true); setPeopleOpen(false); setInspectorTab('properties'); }
  function undo() { editGroup.current.element = null; const old = history.at(-1); if (!old || locked) return; setFuture(f => [...f, scene]); setScene(old); setHistory(h => h.slice(0, -1)); setNotice('已撤销画面修改。'); }
  function redo() { editGroup.current.element = null; const next = future.at(-1); if (!next || locked) return; setHistory(h => [...h, scene]); setScene(next); setFuture(f => f.slice(0, -1)); setNotice('已重做画面修改。'); }
  useEffect(() => { if (selected && selected !== '@scene' && !selected.startsWith('@patch:') && !scene.messages.some(m => m.id === selected) && !scene.participants.some(p => `@participant:${p.id}` === selected)) setSelected(''); }, [scene, selected]);
  useEffect(() => {
    const properties = document.querySelector('.editor-properties'); if (properties) properties.scrollTop = 0;
    if (!selected) return;
    const frame = requestAnimationFrame(() => document.querySelector('.agent-canvas .scene-selectable.is-selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selected, full]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z' || (event.target as HTMLElement)?.closest('input,textarea,[contenteditable=true]')) return;
      event.preventDefault(); if (event.shiftKey) redo(); else undo();
    };
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle);
  }, [history, future, scene, locked]);
  const selectionLabel = chosen ? `消息 ${scene.messages.indexOf(chosen) + 1}` : selected.startsWith('@participant:') ? scene.participants.find(p => `@participant:${p.id}` === selected)?.name || '人物' : selected.startsWith('@patch:') ? '截图编辑层' : selected ? '画面与界面' : '整个对话';
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
    const scoped = edit || (scopeSelected && !!selected);
    const snapshot = scoped ? liveScene.current : applySelfDefault(liveScene.current,contacts.library); const id = crypto.randomUUID(); const targetId = scoped && selected ? selected : undefined;
    const previous = turns.filter(t => !t.failed).slice(-10).map(({ role, content }) => ({ role, content: content.slice(0,4000) }));
    setTurns(old => [...old, { role: 'user', content: text, id: `${id}-user`, target: targetId }, { role: 'assistant', content: '正在理解你的想法…', id, tools: [], target: targetId }]);
    setBusy(true); setFailure(''); setNotice(''); checkpoint();
    if (edit) setEditPrompt(''); else setPrompt('');
    let completed = false; let changed = false; let finalScene = snapshot;
    const defaultSelf = snapshot !== liveScene.current ? snapshot.participants.find(p=>p.id===snapshot.selfId) : undefined;
    const timeout = setTimeout(() => abort.abort(), 125000);
    const updateTurn = (transform: (turn: Turn) => Turn) => setTurns(old => old.map(turn => turn.id === id ? transform(turn) : turn));
    try {
      for await (const item of runAgent({ prompt: text, projectId:projectId||undefined, scene: snapshot, targetId, attachments: scoped ? [] : attachments, history: previous }, user.id, abort.signal)) {
        if (run !== sequence.current) return;
        if (abort.signal.aborted) throw new Error('已停止');
        if (item.type === 'scene') { const generated=snapshot.deviceProfileId&&!item.scene.reference?{...item.scene,deviceProfileId:snapshot.deviceProfileId,surface:snapshot.surface}:item.scene; const next=defaultSelf&&!item.scene.reference ? {...generated,participants:generated.participants.map(p=>p.id===generated.selfId?{...defaultSelf,id:p.id}:p)} : generated; finalScene=next;setScene(next); changed ||= JSON.stringify(next) !== JSON.stringify(snapshot); }
        if (item.type === 'tool') updateTurn(t => ({ ...t, content: '正在更新画面…', tools: [...(t.tools || []).filter(tool => tool.id !== item.id), item] }));
        if (item.type === 'assistant') updateTurn(t => ({ ...t, content: item.text }));
        if (item.type === 'done') completed = true;
      }
      if (run !== sequence.current) return;
      if (!completed || !changed) throw new Error('Agent 没有返回可用的场景修改，请补充需求后重试。');
      if (!scoped) setAttachments([]); setNotice('画面已更新，可以继续说想改哪里。');
      if(!finalScene.reference && contacts.library?.autoSave) { try { await contacts.capture(finalScene.participants); if(active.current)setNotice('画面已更新，人物与头像已存入人物库。'); } catch(e) { if(active.current)setFailure(`画面已保留，但人物未保存：${e instanceof Error?e.message:'请在人物库重试'}`); } }
      updateTurn(t => ({ ...t, content: t.content === '正在更新画面…' ? '画面已更新。' : t.content }));
    } catch (error) {
      if (run !== sequence.current) return;
      const message = abort.signal.aborted ? '已停止，收到的内容已保留。' : error instanceof Error ? error.message : '生成失败，请重试。';
      setFailure(message); updateTurn(t => ({ ...t, content: message, failed: true, tools: t.tools?.map(tool => tool.state === 'running' ? { ...tool, state: 'error', detail: '未完成' } : tool) }));
      if (edit) setEditPrompt(text); else setPrompt(text);
    } finally { clearTimeout(timeout); if (run === sequence.current) { setBusy(false); controller.current = null; } }
  }
  async function exportPng() {
    if (locked || (!scene.messages.length && !scene.reference)) return; setExporting(true); setNotice('正在导出…');
    try {
      if (scene.reference) {
        const result = await fetch('/api/agent/render',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-IMStage-Request':'1',...(user?{'X-IMStage-User':user.id}:{})},body:JSON.stringify({scene}),signal:AbortSignal.timeout(45000)});
        if(!result.ok) throw new Error('渲染失败');
        const blob=await result.blob();const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='imstage-edited.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice('已按源图尺寸导出 PNG。');return;
      }
      flushSync(() => setExportScene(scene)); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!exportRef.current) throw new Error('画面尚未准备好');
      await waitForImages(exportRef.current); await document.fonts.ready;
      const { toPng } = await import('html-to-image');
      const profile=deviceProfile(scene);
      const url = await toPng(exportRef.current, { pixelRatio: profile.pixelRatio, skipFonts: true });
      const link = document.createElement('a'); link.href = url; link.download = `imstage-${full ? 'long' : `${profile.width*profile.pixelRatio}x${profile.height*profile.pixelRatio}`}.png`; link.click(); setNotice('PNG 已导出。');
    } catch { setFailure('图片导出失败，画面仍保留，请重试或下载场景文件。'); }
    finally { setExporting(false); setExportScene(null); }
  }
  function transcript(edit = false) {
    return <div className="agent-transcript">{turns.filter(t => !edit || (selected ? t.target === selected : !t.target)).map(turn => <article key={turn.id} className={`agent-turn ${turn.role}${turn.failed ? ' failed' : ''}`}><span>{turn.role === 'user' ? '你' : 'IMStage'}{turn.target && ' · 局部编辑'}</span><p>{turn.content}</p>{!!turn.tools?.length && <details className="agent-tools" open={busy}><summary>{turn.tools.length} 个工具步骤</summary>{turn.tools.map(tool => <div key={tool.id} data-state={tool.state}>{tool.state === 'running' ? <IconLoader2 size={14} className="spinning" /> : tool.state === 'error' ? <IconX size={14} /> : <IconCheck size={14} />}<span>{labels[tool.name] || tool.name}<small>{tool.detail}</small></span></div>)}</details>}</article>)}{!edit && <div ref={endRef} />}</div>;
  }
  function composer(edit = false) {
    return <form className="agent-composer" onSubmit={event => void send(event, edit)}>{!edit && selected && <button type="button" className="composer-scope" aria-pressed={scopeSelected} disabled={locked} onClick={() => setScopeSelected(!scopeSelected)}><IconWand size={13}/>{scopeSelected ? `仅修改 · ${selectionLabel}` : '当前范围 · 整个对话'}<span>切换</span></button>}<label className="sr-only" htmlFor={edit ? 'vibe-prompt' : 'agent-prompt'}>{edit ? '描述想怎样修改' : '描述想生成的聊天'}</label><textarea id={edit ? 'vibe-prompt' : 'agent-prompt'} ref={edit ? editInput : input} rows={3} maxLength={4000} disabled={locked} value={edit ? editPrompt : prompt} placeholder={edit ? chosen ? '把这句话改得更自然…' : '让整段对话更有生活感…' : '写一句话，或粘贴一张聊天截图…'} onChange={e => edit ? setEditPrompt(e.target.value) : setPrompt(e.target.value)} onPaste={e => { if (!edit && e.clipboardData.files.length) { e.preventDefault(); void addFiles(Array.from(e.clipboardData.files)); } }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(undefined, edit); } }} />{!edit && attachments.length > 0 && <div className="agent-attachments">{attachments.map((src,i) => <div key={src.slice(-60)}><img src={src} alt={`参考图片 ${i+1}`} /><button type="button" aria-label={`移除参考图片 ${i+1}`} disabled={locked} onClick={() => setAttachments(old => old.filter((_,n) => n !== i))}><IconX size={14} /></button></div>)}</div>}<div className="agent-composer-actions">{!edit && <button type="button" disabled={locked || attachments.length >= 3} aria-label="添加参考图片" onClick={() => fileRef.current?.click()}><IconPaperclip size={18} /></button>}<span>{edit ? selected ? '仅修改选中元素' : '编辑整个对话' : '⌘ / Ctrl + Enter'}</span>{busy ? <button key="stop" type="button" className="agent-send" aria-label="停止生成" onClick={() => controller.current?.abort()}><IconPlayerStop size={18} /></button> : user ? <button key="send" type="submit" className="agent-send" aria-label={edit ? '发送修改' : '开始生成'} disabled={locked || !(edit ? editPrompt : prompt).trim()}><IconArrowUp size={19} /></button> : <a className="agent-login" href={loginLink('/create')} onClick={e => { try { sessionStorage.setItem('imstage.agent.login-handoff', JSON.stringify({ scene, prompt, attachments })); } catch { e.preventDefault(); setFailure('暂时无法保留登录前的输入，请先下载场景文件，并复制你的需求。'); } }}>登录创作 →</a>}</div></form>;
  }
  return <section className="agent-workspace" aria-label="Agent 对话创作台" data-tab={tab} data-edit={drawer} data-chat-open={chatOpen}>
    <header className="agent-heading"><div><IconSparkles size={20} /><h1>对话工作台</h1><span>让每个细节，都如你所想</span></div><div className="agent-heading-actions"><button className="agent-button" disabled={locked||!user} aria-expanded={peopleOpen} onClick={()=>{setPeopleOpen(!peopleOpen);setDrawer(false);}}>人物与头像</button>{user && accountAction?.(scene, locked, projectId)}<button className="agent-button" disabled={locked || !history.length} aria-label="撤销上次修改" onClick={undo} title="撤销 · ⌘/Ctrl Z"><IconArrowBackUp size={17} /></button><button className="agent-button" disabled={locked || !future.length} aria-label="重做上次修改" title="重做 · ⌘/Ctrl Shift Z" onClick={redo}><IconArrowForwardUp size={17}/></button><details className="agent-more"><summary>更多</summary><button onClick={() => downloadText('imstage-scene.json', JSON.stringify(scene, null, 2))}>下载场景 JSON</button></details></div></header>
    <div className="agent-mobile-tabs"><button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>创作 Chat</button><button aria-pressed={tab === 'canvas'} onClick={() => setTab('canvas')}>渲染画面 {busy && '· 生成中'}</button></div>
    <div className="agent-body"><aside className="agent-chat"><div className="agent-panel-label"><IconMessageCircle size={17} /><strong>创作助手</strong><span>{busy ? '正在创作' : 'Agent'}</span></div><div className="editor-tabs" role="group" aria-label="左侧面板"><button aria-pressed={leftTab==='ai'} onClick={()=>setLeftTab('ai')}><IconSparkles size={15}/>AI 创作</button><button aria-pressed={leftTab==='elements'} onClick={()=>setLeftTab('elements')}><IconListDetails size={15}/>元素 <span>{scene.messages.length}</span></button></div>{leftTab==='elements' ? <ElementNavigator scene={scene} selected={selected} locked={locked} onSelect={id=>{selectElement(id);setTab('canvas');}} onChange={patch}/> : <>{user&&<button className="agent-identity-summary" disabled={locked} onClick={()=>{setPeopleOpen(true);setDrawer(false);}}>{contacts.loading?'正在读取人物…':contacts.error?'人物库连接失败 · 点击重试':`我的默认人物：${contacts.library?.contacts.find(c=>c.id===contacts.library?.selfContactId)?.name||'尚未设置'}`}<span>配置 →</span></button>}<label className="agent-project">项目规则<select aria-label="当前项目" value={projectId} disabled={locked} onChange={e=>{setProjectId(e.target.value);const p=projects.find(p=>p.id===e.target.value);if(p&&!scene.messages.length&&!scene.reference)patch({...scene,platform:p.platform});}}><option value="">独立创作</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><a href="#/projects">管理项目 →</a></label>{!turns.length && <div className="agent-welcome"><div className="agent-emblem"><IconSparkles size={27} stroke={1.3}/></div><h2>想聊一个<br/>什么样的故事？</h2><p>描述人物和情节，或放入一张截图。<br/>AI 编排对话，你随时接着改。</p><div className="agent-ideas">{ideas.map(idea => <button key={idea} onClick={() => { setPrompt(idea); input.current?.focus(); }}>{idea}<IconArrowUp size={14}/></button>)}</div></div>}{transcript()}<div className="agent-input-dock">{capError ? <button className="agent-capability" onClick={() => setCapRetry(v => v+1)}>连接状态读取失败 · 重试</button> : <p className="agent-capability">{caps ? caps.configured ? `${caps.model} · ${caps.imageConfigured ? '消息配图已连接' : '生图服务待配置'}` : '模型服务待配置' : '正在连接 Agent…'}</p>}{attachments.length>0&&!scene.reference&&<button type="button" className="agent-button" disabled={locked} onClick={async()=>{setReading(true);try{const source=attachments[0];const img=new Image();img.src=source;await img.decode();const im=['wechat','whatsapp','instagram'].includes(scene.platform)?scene.platform:'wechat';patch({...scene,platform:im as Platform,reference:{source,plan:{schemaVersion:1,im,surface:scene.surface==='desktop'?'desktop':'ios',width:img.naturalWidth,height:img.naturalHeight,edits:[],warnings:[]},assets:[]}});setAttachments([]);setSelected('');setNotice('已保留原截图布局，输入想修改的内容。');}catch{setFailure('图片无法读取，请重试。');}finally{setReading(false);}}}>保留原截图布局进行编辑</button>}{composer()}<input hidden ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => { void addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /><small>支持截图、图片 · 最多 3 张，每张 4 MB</small></div></>}</aside>
    <div className="agent-render"><div className="agent-render-toolbar"><button className="canvas-tool" aria-label={chatOpen ? "收起左侧面板" : "展开左侧面板"} onClick={()=>setChatOpen(!chatOpen)}><IconLayoutSidebarLeftCollapse size={18}/></button><label><span className="sr-only">目标聊天平台</span><select aria-label="目标聊天平台" disabled={locked} value={scene.platform} onChange={e => { if(scene.reference){ setAttachments([scene.reference.source]); patch({...scene,reference:undefined,platform:e.target.value as Platform});setNotice('已切换平台，请描述需求生成新的聊天画面。'); } else patch({ ...scene, platform: e.target.value as Platform }); }}>{PLATFORMS.map(p => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}</select></label><select aria-label="截图设备" value={scene.deviceProfileId||''} disabled={locked||!!scene.reference} onChange={e=>{if(!e.target.value){patch({...scene,deviceProfileId:undefined});return;}const p=DEVICE_PROFILES.find(p=>p.id===e.target.value);if(p)patch({...scene,deviceProfileId:p.id,surface:p.surface});}}><option value="">通用尺寸（当前系统）</option>{DEVICE_PROFILES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select><span>{busy ? '正在更新画面…' : scene.reference ? `${scene.reference.plan.edits.length} 个编辑层` : `${scene.messages.length} 条消息`}</span><div><select aria-label="导出图片范围" value={full ? 'full':'standard'} disabled={locked} onChange={e => setFull(e.target.value === 'full')}><option value="full">长截图</option><option value="standard">普通截图</option></select><button className="agent-button agent-primary" disabled={locked || (!scene.messages.length && !scene.reference)} onClick={() => void exportPng()}><IconDownload size={16}/>{exporting ? '导出中' : '导出 PNG'}</button></div></div><div className="agent-canvas" tabIndex={0} aria-label="实时聊天画面">{!scene.messages.length && !scene.reference && <div className="agent-empty-hint"><span>实时渲染</span><p>你的第一句话，从这里开始。</p></div>}<DevicePreview scene={scene} full={full} zoom={zoom} onScale={setScale}>{scene.reference ? <ReferenceView document={scene.reference} onSelect={locked?undefined:id=>selectElement(`@patch:${id}`)}/> : <SceneView scene={scene} pendingAssets={busy} onSelectElement={locked ? undefined : selectElement} selectedId={selected} onSelect={locked ? undefined : selectElement} />}</DevicePreview><p className="agent-canvas-caption">{scene.reference?'按原图布局编辑':`${deviceProfile(scene).label} · ${deviceProfile(scene).width*deviceProfile(scene).pixelRatio} × ${full?'自动高度':deviceProfile(scene).height*deviceProfile(scene).pixelRatio} px`} · 点选消息或头像编辑</p></div><footer className="agent-render-footer"><span role="status">{notice || '点选画面中的元素，即可编辑'}</span><div className="canvas-zoom" role="group" aria-label="画布缩放"><button aria-label="缩小画布" onClick={()=>setZoom(Math.max(.25,scale-.1))}><IconMinus size={14}/></button><button aria-label="适应画布" title="点击恢复自适应" onClick={()=>setZoom('fit')}>{zoom==='fit' ? '适应' : `${Math.round(scale*100)}%`}</button><button aria-label="放大画布" onClick={()=>setZoom(Math.min(1.5,scale+.1))}><IconPlus size={14}/></button></div><button className="agent-button" aria-expanded={drawer} onClick={() => { setDrawer(!drawer); setPeopleOpen(false); setSelected(''); }}><IconWand size={17}/>元素编辑</button></footer></div>
    {peopleOpen&&user&&<aside className="agent-vibe" aria-label="人物与头像" onKeyDown={e=>{if(e.key==='Escape'&&!locked)setPeopleOpen(false);}}><div className="agent-panel-label"><strong>人物与头像</strong><button disabled={locked} aria-label="关闭人物库" onClick={()=>setPeopleOpen(false)}><IconX size={19}/></button></div><ContactPanel key={user.id} userId={user.id} scene={scene} store={contacts} locked={locked} onChange={patch} onBusy={setReading}/></aside>}
    {drawer && <aside className="agent-vibe editor-inspector" aria-label="Vibe Edit" onKeyDown={e => { if (e.key === 'Escape') { setDrawer(false); setSelected(''); } }}>
      <div className="agent-panel-label"><IconWand size={18}/><strong>元素编辑</strong><button aria-label="关闭 AI 编辑" onClick={() => { setDrawer(false); setSelected(''); }}><IconX size={19}/></button></div>
      <div className="editor-selection"><span>{selectionLabel}</span><p>{chosen?.text || (selected.startsWith('@participant:') ? '姓名、头像与人物资料' : '调整对话的内容与视觉细节')}</p>{selected && <button disabled={locked} onClick={()=>setSelected('')}>切换为整个对话</button>}</div>
      <div className="editor-tabs" role="group" aria-label="编辑方式"><button aria-pressed={inspectorTab==='properties'} onClick={()=>setInspectorTab('properties')}>属性</button><button aria-pressed={inspectorTab==='ai'} onClick={()=>setInspectorTab('ai')}><IconSparkles size={15}/>AI 修改</button></div>
      {inspectorTab==='properties' ? <div className="editor-properties">{scene.reference ? <ReferenceInspector scene={scene} selected={selected} locked={locked} onChange={patch} onSelect={selectElement}/> : <ElementInspector scene={scene} selected={selected} locked={locked} onSelect={selectElement} onChange={patch} onBusy={setReading}/>}</div> : <><div className="editor-ai-intro"><span><IconSparkles size={16}/> {selected ? `只修改${selectionLabel}` : '改进整个对话'}</span><p>说出想要的效果，修改后可以随时撤销。</p><div className="editor-ai-suggestions">{(chosen ? ['表达更自然','更简短一点','补充一点细节'] : selected.startsWith('@participant:') ? ['生成自然光头像','改成插画风头像'] : ['让对话更自然','统一气泡与文字风格']).map(text=><button disabled={locked} key={text} onClick={()=>{setEditPrompt(text);editInput.current?.focus();}}>{text}</button>)}</div></div>{transcript(true)}<div className="agent-vibe-composer">{composer(true)}</div></>}
      {inspectorTab==='properties' && <div className="editor-ai-entry"><button className="agent-button" onClick={()=>setInspectorTab('ai')}><IconSparkles size={16}/>让 AI 改进{selected ? '这个元素' : '整个对话'}<IconArrowUp size={15}/></button><small>直接编辑即时生效 · 所有修改均可撤销</small></div>}
    </aside>}

    </div>{(failure || storageError) && <div className="agent-error" role="alert">{failure || '浏览器暂时无法保存草稿，请保存作品或下载场景 JSON。'}<button aria-label="关闭提示" onClick={() => setFailure('')}><IconX size={16}/></button></div>}
    {exportScene && <div className="agent-export" aria-hidden="true"><div ref={exportRef} className="agent-export-frame" data-mode={full ? 'full' : 'standard'} style={{ width:deviceProfile(exportScene).width, height:full ? 'auto':deviceProfile(exportScene).height, overflow:'hidden' }}><SceneView scene={exportScene} exportMode/></div></div>}
  </section>;
}

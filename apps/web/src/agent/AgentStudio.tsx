import { calendarToday } from '../../../../packages/schema/timeline.mjs';
import loanCase from '../../../../tools/eval/fixtures/loan-anniversary.json';
import DevicePreview from '../studio/DevicePreview';
import {DEVICE_PROFILES,deviceProfile} from '../studio/device-profiles';
import ContactPanel from '../contacts/ContactPanel';
import {useContactLibrary} from '../contacts/useContactLibrary';
import {applySelfDefault} from '../contacts/model';
import ReferenceView from '../studio/ReferenceView';
import ReferenceInspector from './ReferenceInspector';
import ElementInspector from './ElementInspector';
import ElementNavigator from './ElementNavigator';
import { useEffect, useRef, useState, type ReactNode, type FormEvent, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';
import { IconArrowsHorizontal, IconCopy, IconUpload, IconArrowUp, IconCheck, IconDownload, IconMessageCircle, IconPaperclip, IconPlayerStop, IconSparkles, IconWand, IconX, IconArrowBackUp, IconArrowForwardUp, IconLayoutSidebarLeftCollapse, IconListDetails, IconPlus, IconMinus, IconLoader2 } from '@tabler/icons-react';
import { useAuth } from '../account/Auth';
import { api, loginLink } from '../account/api';
import { setNavigationGuard } from '../account/navigation';
import { SceneView } from '../studio/SceneView';
import { createScene, validateScene, PLATFORMS, type Scene, type Platform } from '../studio/model';
import { readImageFile, waitForImages, downloadText, downloadBlob } from '../studio/storage';
import { runAgent, type ToolEvent } from './client';
import { createSendIntent, intentNeedsAttention, isAutoStartable, type SendIntent } from '../sendIntent';
import { useCopy } from '../i18n';
import './agent.css';
import './creation-layout.css';
import CreationDivider, { useCreationWidth } from './CreationDivider';
import TemplateSavePanel from '../templates/TemplateSavePanel';
import type { SessionDraft, Turn } from './sessions';

type Props = { creationSessionId?: string; initialDraft?: SessionDraft; onDraftChange?: (draft:SessionDraft)=>void; sessionControls?: ReactNode; initialScene?: Scene; initialProjectId?:string; onProjectChange?:(id:string)=>void; onSceneChange?: (scene: Scene) => void; accountAction?: (scene: Scene, locked: boolean, projectId?:string, sessionId?:string) => ReactNode; persistLocal?: boolean; disabled?: boolean; onBusyChange?: (busy: boolean) => void; onStorageError?: (error: boolean) => void; pendingIntent?: SendIntent | null; onIntentChange?: (intent: SendIntent | null) => boolean | void | Promise<boolean | void> };
export default function AgentStudio({ creationSessionId, initialDraft, onDraftChange, sessionControls, initialScene, initialProjectId, onProjectChange, onSceneChange, accountAction, persistLocal = true, disabled = false, onBusyChange, onStorageError, pendingIntent, onIntentChange }: Props) {
  const { user } = useAuth();
  const copy = useCopy();
  const [creationWidth,setCreationWidth]=useCreationWidth();
  const sample = new URLSearchParams(location.hash.split('?')[1]).get('case') === 'loan-anniversary' ? loanCase : null;
  const contacts=useContactLibrary(user?.id);
  const [peopleOpen,setPeopleOpen]=useState(false);
  const recoveryKey = `imstage.agent.${user?.id || 'guest'}.${initialScene?.id || (sample ? 'case-loan-anniversary' : 'draft')}`;
  const [cached] = useState(() => { if(initialDraft)return initialDraft; try { return JSON.parse(sessionStorage.getItem(recoveryKey) || 'null'); } catch { return null; } });
  const [handoff] = useState(() => { if (initialDraft || !user || initialScene) return null; try { return JSON.parse(sessionStorage.getItem('imstage.agent.login-handoff') || 'null'); } catch { return null; } });
  const [scene, setScene] = useState<Scene>(() => {
    if (initialDraft) return initialDraft.scene;
    if (initialScene) return initialScene;
    const transferred = validateScene(handoff?.scene); if (transferred.ok && transferred.scene) return transferred.scene;
    try { const parsed = validateScene(JSON.parse(sessionStorage.getItem(recoveryKey) || 'null')?.scene); if (parsed.ok && parsed.scene) return parsed.scene; } catch {}
    if (sample) { const result = validateScene(sample.scene); if (result.ok && result.scene) return result.scene; }
    return { ...createScene(), id: crypto.randomUUID(), title: '新的对话', referenceDate:calendarToday(), surface:'ios',deviceProfileId:'iphone-17-pro', selfId: 'me', participants: [{id:'me',name:'我'},{id:'other',name:'对方'}], messages: [] };
  });
  const [prompt, setPrompt] = useState(() => { if(initialDraft)return initialDraft.prompt; if (typeof handoff?.prompt === 'string') return handoff.prompt.slice(0,4000); try { return JSON.parse(sessionStorage.getItem(recoveryKey) || 'null')?.prompt || ''; } catch { return ''; } });
  const [editPrompt, setEditPrompt] = useState(typeof cached?.editPrompt === 'string' ? cached.editPrompt.slice(0,4000) : '');
  const [turns, setTurns] = useState<Turn[]>(() => { if(initialDraft)return initialDraft.turns; try { const cached = JSON.parse(sessionStorage.getItem(`${recoveryKey}.chat`) || 'null'); return Array.isArray(cached) ? cached.filter(t => ['user','assistant'].includes(t.role) && typeof t.content === 'string' && typeof t.id === 'string').slice(-30) : []; } catch { return []; } });
  const [attachments, setAttachments] = useState<string[]>(() => Array.isArray((handoff || cached)?.attachments) ? (handoff || cached).attachments.filter((a: unknown) => typeof a === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(a) && a.length < 6*1024*1024).slice(0,3) : []);
  const [projectId,setProjectId]=useState(initialDraft?.projectId ?? initialProjectId ?? new URLSearchParams(location.hash.split('?')[1]).get('project') ?? (typeof cached?.projectId==='string'?cached.projectId:''));
  const [projects,setProjects]=useState<{id:string;name:string;platform:Platform}[]>([]);
  useEffect(()=>{if(!user)return;const ac=new AbortController();api<{items:{id:string;name:string;platform:Platform}[]}>('/projects',{signal:ac.signal}).then(d=>setProjects(d.items)).catch(()=>{});return()=>ac.abort();},[user]);
  useEffect(()=>{onProjectChange?.(projectId);},[projectId,onProjectChange]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState(typeof cached?.selected === 'string' ? cached.selected : '');
  const [drawer, setDrawer] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'properties'|'ai'>('properties');
  const [leftTab, setLeftTab] = useState<'ai'|'elements'>('ai');
  useEffect(() => { const media = matchMedia('(max-width: 1100px)'); const close = () => { if (media.matches) { setDrawer(false); setPeopleOpen(false); } }; media.addEventListener('change', close); return () => media.removeEventListener('change', close); }, []);
  const [chatOpen, setChatOpen] = useState(true);
  const [scopeSelected, setScopeSelected] = useState(initialDraft?.scopeSelected??false);
  const [zoom, setZoom] = useState<'fit'|number>('fit');
  const [scale, setScale] = useState(1);
  const [future, setFuture] = useState<Scene[]>([]);
  const [tab, setTab] = useState<'chat'|'canvas'>(sample && initialDraft?.scene.messages.length !== 0 ? 'canvas' : 'chat');
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [caps, setCaps] = useState<{ configured: boolean; model: string; imageConfigured: boolean } | null>(null);
  const [capError, setCapError] = useState(false);
  const [capRetry, setCapRetry] = useState(0);
  const [history, setHistory] = useState<Scene[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const attachmentRead = useRef(false);
  const [copying, setCopying] = useState(false);
  const [copyFallback, setCopyFallback] = useState<Blob | null>(null);
  const [copyPreview, setCopyPreview] = useState('');
  useEffect(() => { if (!copyFallback) { setCopyPreview(''); return; } const url=URL.createObjectURL(copyFallback); setCopyPreview(url); return () => URL.revokeObjectURL(url); }, [copyFallback]);
  const [exporting, setExporting] = useState(false);
  const [full, setFull] = useState(initialDraft?.full??Boolean(sample));
  const [exportScene, setExportScene] = useState<Scene | null>(null);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const active = useRef(true);
  const liveScene = useRef(scene); liveScene.current = scene;
  const callback = useRef(onSceneChange); callback.current = onSceneChange;
  const input = useRef<HTMLTextAreaElement>(null);
  const editInput = useRef<HTMLTextAreaElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current++; controller.current?.abort(); }; }, []);
  useEffect(() => { callback.current?.(scene); }, [scene]);
  useEffect(() => { onStorageError?.(storageError); }, [storageError, onStorageError]);
  useEffect(() => { if(onDraftChange)return; try { sessionStorage.setItem(`${recoveryKey}.chat`, JSON.stringify(turns.slice(-30))); } catch {} }, [turns, recoveryKey]);
  useEffect(() => { if (handoff) try { sessionStorage.removeItem('imstage.agent.login-handoff'); } catch {} }, [handoff]);
  useEffect(() => { if(onDraftChange)return; try { sessionStorage.setItem(recoveryKey, JSON.stringify({ scene: persistLocal ? scene : undefined, prompt, attachments, editPrompt, selected, projectId })); setStorageError(false); } catch { setStorageError(true); } }, [scene, prompt, attachments, editPrompt, selected, projectId, persistLocal, recoveryKey]);
  useEffect(() => { const abort = new AbortController(); setCapError(false); api<{ configured:boolean;model:string;imageConfigured:boolean }>('/agent/capabilities', { signal: abort.signal }).then(setCaps).catch(() => { if (!abort.signal.aborted) setCapError(true); }); return () => abort.abort(); }, [capRetry]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [turns.length, busy]);
  useEffect(() => { if (drawer && inspectorTab === 'ai') editInput.current?.focus(); }, [drawer, inspectorTab]);
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (storageError) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [storageError]);
  useEffect(() => { if ((persistLocal && storageError) || contacts.cacheError) return setNavigationGuard(() => window.confirm(copy.agent.leaveConfirm)); }, [persistLocal, storageError, contacts.cacheError, copy.agent.leaveConfirm]);
  const [viewportTop,setViewportTop]=useState(initialDraft?.viewportTop??0);
  const initialViewport=useRef(initialDraft?.viewportTop??0);
  useEffect(()=>{
    const el=canvasRef.current?.querySelector<HTMLElement>('.scene-messages');if(!el||full)return;
    el.scrollTop=initialViewport.current;
    const track=()=>{initialViewport.current=el.scrollTop;setViewportTop(el.scrollTop);};el.addEventListener('scroll',track,{passive:true});
    return()=>el.removeEventListener('scroll',track);
  },[full,!!scene.reference]);
  useEffect(()=>{onDraftChange?.({scene,prompt,attachments,editPrompt,selected,projectId,turns,full,scopeSelected,viewportTop,generating:busy,intent:intentRef.current});},[busy,scene,prompt,attachments,editPrompt,selected,projectId,turns,full,scopeSelected,viewportTop,onDraftChange]);
  const chosen = scene.messages.find(m => m.id === selected);
  const locked = busy || exporting || copying || reading || disabled;
  useEffect(() => { onBusyChange?.(busy || exporting || copying || reading); }, [busy, exporting, copying, reading, onBusyChange]);
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
    setSelected(id); setDrawer(true); setPeopleOpen(false); setInspectorTab('properties'); }
  function undo() { editGroup.current.element = null; const old = history.at(-1); if (!old || locked) return; setFuture(f => [...f, scene]); setScene(old); setHistory(h => h.slice(0, -1)); setNotice(copy.agent.undoNotice); }
  function redo() { editGroup.current.element = null; const next = future.at(-1); if (!next || locked) return; setHistory(h => [...h, scene]); setScene(next); setFuture(f => f.slice(0, -1)); setNotice(copy.agent.redoNotice); }
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
  const selectionLabel = chosen ? copy.agent.inspectorMessage(scene.messages.indexOf(chosen) + 1) : selected.startsWith('@participant:') ? scene.participants.find(p => `@participant:${p.id}` === selected)?.name || copy.agent.inspectorPerson : selected.startsWith('@patch:') ? copy.agent.inspectorPatch : selected ? copy.agent.inspectorFrame : copy.agent.inspectorSelectionAll;
  async function addFiles(files: File[]) {
    if (locked || attachmentRead.current) return;
    if (attachments.length >= 3) { setFailure(copy.agent.maxAttachments); return; }
    attachmentRead.current = true; setReading(true); setFailure(''); setLeftTab('ai');
    const results: string[] = [];
    try {
      if (files.length > 3 - attachments.length) setFailure(copy.agent.extraAttachments);
      for (const file of files.slice(0, 3 - attachments.length)) { const result = await readImageFile(file); if (result.ok) results.push(result.dataUrl); else setFailure(result.error); }
      if (active.current) setAttachments(old => [...old, ...results].slice(0, 3));
    } finally { attachmentRead.current = false; if (active.current) setReading(false); }
  }
  function dropFiles(event: React.DragEvent) {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (event.dataTransfer.files.length) void addFiles(Array.from(event.dataTransfer.files));
  }
  async function send(event?: FormEvent, edit = false, override?: { text: string; intent?: SendIntent }): Promise<{ ok: boolean; cancelled: boolean; error?: string }> {
    event?.preventDefault(); if (locked || controller.current) return { ok: false, cancelled: false, error: 'busy' };
    const text = (override?.text ?? (edit ? editPrompt : prompt)).trim(); if (!text) { (edit ? editInput : input).current?.focus(); return { ok: false, cancelled: false, error: 'empty' }; }
    if (!user) { setFailure(copy.agent.signInToCreate); return { ok: false, cancelled: false, error: 'auth' }; }
    const run = ++sequence.current; const abort = new AbortController(); controller.current = abort;
    const scoped = edit || (scopeSelected && !!selected);
    const snapshot = scoped ? liveScene.current : applySelfDefault(liveScene.current,contacts.library); const id = crypto.randomUUID(); const targetId = scoped && selected ? selected : undefined;
    const previous = turns.filter(t => !t.failed).slice(-10).map(({ role, content }) => ({ role, content: content.slice(0,4000) }));
    const submittedAttachments = edit ? [] : [...attachments];
    setTurns(old => [...old, { role: 'user', content: text, id: `${id}-user`, target: targetId, attachments: submittedAttachments }, { role: 'assistant', content: copy.agent.thinking, id, tools: [], target: targetId }]);
    setBusy(true); setFailure(''); setNotice(''); checkpoint();
    if (edit) setEditPrompt(''); else { setPrompt(''); setAttachments([]); }
    let completed = false; let changed = false; let finalScene = snapshot;
    const defaultSelf = snapshot !== liveScene.current ? snapshot.participants.find(p=>p.id===snapshot.selfId) : undefined;
    const timeout = setTimeout(() => abort.abort(), 125000);
    const updateTurn = (transform: (turn: Turn) => Turn) => setTurns(old => old.map(turn => turn.id === id ? transform(turn) : turn));
    try {
      for await (const item of runAgent({ prompt: text, projectId:projectId||undefined, scene: snapshot, targetId, attachments: submittedAttachments, history: previous }, user.id, abort.signal)) {
        if (run !== sequence.current) return { ok: false, cancelled: true, error: 'superseded' };
        if (abort.signal.aborted) throw new Error('已停止');
        if (item.type === 'scene') { const generated=snapshot.deviceProfileId&&!item.scene.reference?{...item.scene,deviceProfileId:snapshot.deviceProfileId,surface:snapshot.surface}:item.scene; const next=defaultSelf&&!item.scene.reference ? {...generated,participants:generated.participants.map(p=>p.id===generated.selfId?{...defaultSelf,id:p.id}:p)} : generated; finalScene=next;setScene(next); changed ||= JSON.stringify(next) !== JSON.stringify(snapshot); }
        if (item.type === 'tool') updateTurn(t => ({ ...t, content: copy.agent.transcriptToolRunning, tools: [...(t.tools || []).filter(tool => tool.id !== item.id), item] }));
        if (item.type === 'assistant') updateTurn(t => ({ ...t, content: item.text }));
        if (item.type === 'done') completed = true;
      }
      if (run !== sequence.current) return { ok: false, cancelled: true, error: 'superseded' };
      if (!completed || !changed) throw new Error(copy.agent.noChanges);
      setNotice(copy.agent.sceneUpdated);
      if(!finalScene.reference && contacts.library?.autoSave) { try { const saved = await contacts.capture(finalScene.participants); if(active.current && saved)setNotice(copy.agent.peopleSaved); } catch(e) { if(active.current)setFailure(copy.agent.peopleSaveFailed(e instanceof Error?e.message:String(e))); } }
      updateTurn(t => ({ ...t, content: t.content === copy.agent.transcriptToolRunning ? copy.agent.sceneUpdatedShort : t.content }));
      return { ok: true, cancelled: false };
    } catch (error) {
      if (run !== sequence.current) return { ok: false, cancelled: true, error: 'superseded' };
      const message = abort.signal.aborted ? copy.agent.stopped : error instanceof Error ? error.message : copy.agent.generateFailed;
      setFailure(message); updateTurn(t => ({ ...t, content: message, failed: true, tools: t.tools?.map(tool => tool.state === 'running' ? { ...tool, state: 'error', detail: copy.agent.transcriptToolError } : tool) }));
      if (edit) setEditPrompt(text); else { setPrompt(text); setAttachments(submittedAttachments); }
      return { ok: false, cancelled: abort.signal.aborted, error: message };
    } finally { clearTimeout(timeout); if (run === sequence.current) { setBusy(false); controller.current = null; } }
  }
  const [intent, setIntent] = useState<SendIntent | null>(pendingIntent ?? null);
  const intentRef = useRef<SendIntent | null>(pendingIntent ?? null);
  const autoStarted = useRef<string | null>(null);
  const dispatching = useRef(false);
  const sessionRef = useRef(creationSessionId); sessionRef.current = creationSessionId;
  const userRef = useRef(user?.id); userRef.current = user?.id;
  useEffect(() => { intentRef.current = pendingIntent ?? null; setIntent(pendingIntent ?? null); }, [pendingIntent]);
  /** Persist first. Returns false when the durable write failed. */
  async function applyIntent(next: SendIntent | null): Promise<boolean> {
    intentRef.current = next;
    setIntent(next);
    try { const result = await onIntentChange?.(next); return result !== false; } catch { return false; }
  }
  /**
   * Persist `running` before the provider call. If the durable write fails the
   * request is never dispatched: the intent stays staged and a clear retry is
   * shown. Dispatch is guarded against unmount, session/identity change and
   * concurrent clicks.
   */
  async function startIntent(target: SendIntent, auto = false) {
    if (auto) { if (autoStarted.current === target.id) return; autoStarted.current = target.id; }
    if (dispatching.current || controller.current) return;
    dispatching.current = true;
    const ownerAtStart = userRef.current;
    const sessionAtStart = sessionRef.current;
    const running: SendIntent = { ...target, status: 'running', attempts: target.attempts + 1 };
    delete running.error;
    const stored = await applyIntent(running);
    if (!stored) {
      intentRef.current = { ...target, status: 'failed', error: 'persist' };
      setIntent(intentRef.current);
      setFailure('');
      dispatching.current = false;
      return;
    }
    if (!active.current || userRef.current !== ownerAtStart || sessionRef.current !== sessionAtStart) { dispatching.current = false; return; }
    const result = await send(undefined, false, { text: target.prompt, intent: running });
    dispatching.current = false;
    if (!active.current || userRef.current !== ownerAtStart || sessionRef.current !== sessionAtStart) return;
    if (result.ok) await applyIntent({ ...running, status: 'done' });
    else if (result.cancelled) await applyIntent({ ...running, status: 'failed', error: 'cancelled' });
    else await applyIntent({ ...running, status: 'failed', error: result.error });
  }
  // Auto-start exactly once, only for a staged intent, and only when both the
  // account and the session are ready. Guests keep the request staged until
  // they explicitly sign in.
  useEffect(() => {
    if (!pendingIntent || !isAutoStartable(pendingIntent)) return;
    if (!user || disabled || busy || controller.current) return;
    void startIntent(pendingIntent, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingIntent, user, disabled, busy]);
  async function renderPng(): Promise<Blob> {
    // Freeze the visible crop at the click, in unscaled scene pixels.
    const viewportTop = full ? 0 : canvasRef.current?.querySelector<HTMLElement>('.scene-messages')?.scrollTop || 0;
    if (scene.reference) {
      const response = await fetch('/api/agent/render', { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-IMStage-Request':'1',...(user ? {'X-IMStage-User':user.id} : {})}, body:JSON.stringify({scene}), signal:AbortSignal.timeout(45000) });
      if (!response.ok) throw new Error(copy.agent.renderFailed);
      return response.blob();
    }
    flushSync(() => setExportScene(scene));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!exportRef.current) throw new Error(copy.agent.frameNotReady);
    await waitForImages(exportRef.current); await document.fonts.ready;
    // DOM cloning does not preserve scrollTop. Translate only message content in
    // the fixed export viewport; header, input bar and background stay in place.
    const messages = exportRef.current.querySelector<HTMLElement>('.scene-messages');
    if (messages && viewportTop) {
      const top = Math.min(viewportTop, Math.max(0, messages.scrollHeight - messages.clientHeight));
      for (const child of Array.from(messages.children)) (child as HTMLElement).style.transform = `translateY(-${top}px)`;
    }
    const { toBlob } = await import('html-to-image');
    const blob = await toBlob(exportRef.current, { pixelRatio:deviceProfile(scene).pixelRatio, skipFonts:true });
    if (!blob) throw new Error(copy.agent.imageFailed);
    return blob;
  }
  function pngName() { const profile=deviceProfile(scene); return `imstage-${scene.reference ? 'edited' : full ? 'long' : `${profile.width*profile.pixelRatio}x${profile.height*profile.pixelRatio}`}.png`; }
  async function exportPng() {
    if (locked || (!scene.messages.length && !scene.reference)) return;
    setExporting(true); setNotice(copy.agent.exportPreparing);
    try { downloadBlob(await renderPng(), pngName()); setNotice(copy.agent.exportDone); }
    catch { setFailure(copy.agent.exportFailed); }
    finally { setExporting(false); setExportScene(null); }
  }
  async function copyPng() {
    if (locked || (!scene.messages.length && !scene.reference)) return;
    setCopying(true); setFailure(''); setNotice(copy.agent.copyPreparing); setCopyFallback(null);
    const image = renderPng();
    try {
      // WebKit requires write() during the user gesture. The PNG promise resolves afterwards.
      // https://webkit.org/blog/10855/async-clipboard-api/
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('clipboard_unavailable');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
      setNotice(copy.agent.copyDone);
    } catch {
      try { setCopyFallback(await image); setNotice(copy.agent.copyBlocked); }
      catch { setFailure(copy.agent.copyFailed); }
    } finally { setCopying(false); setExportScene(null); }
  }
  function transcript(edit = false) {
    return <div className="agent-transcript" tabIndex={0} role="region" aria-label={edit ? copy.agent.transcriptEdit : copy.agent.transcriptAi}>{turns.filter(t => !edit || (selected ? t.target === selected : !t.target)).map(turn => <article key={turn.id} className={`agent-turn ${turn.role}${turn.failed ? ' failed' : ''}`}><span>{turn.role === 'user' ? copy.agent.transcriptYou : copy.agent.transcriptModel}{turn.target && copy.agent.transcriptScoped}</span><p>{turn.content}</p>{!!turn.attachments?.length && <div className="agent-sent-attachments" aria-label={copy.agent.transcriptAttachments}>{turn.attachments.map((src,i)=><img key={i} src={src} alt={copy.agent.transcriptAttachmentAlt(i+1)}/>)}<small>{copy.agent.transcriptSubmitted}</small></div>}{!!turn.tools?.length && <details className="agent-tools" open={busy}><summary>{copy.agent.transcriptTools(turn.tools.length)}</summary>{turn.tools.map(tool => <div key={tool.id} data-state={tool.state}>{tool.state === 'running' ? <IconLoader2 size={14} className="spinning" /> : tool.state === 'error' ? <IconX size={14} /> : <IconCheck size={14} />}<span>{copy.agent.toolLabels[tool.name] || tool.name}<small>{tool.detail}</small></span></div>)}</details>}</article>)}{!edit && <div ref={endRef} />}</div>;
  }
  function composer(edit = false) {
    return <form className="agent-composer" onSubmit={event => void send(event, edit)}>{!edit && selected && <button type="button" className="composer-scope" aria-pressed={scopeSelected} disabled={locked} onClick={() => setScopeSelected(!scopeSelected)}><IconWand size={13}/>{scopeSelected ? copy.agent.composerScopeOnly(selectionLabel) : copy.agent.composerScopeAll}<span>{copy.agent.composerScopeSwitch}</span></button>}<label className="sr-only" htmlFor={edit ? 'vibe-prompt' : 'agent-prompt'}>{edit ? copy.agent.editLabel : copy.agent.composerLabel}</label><textarea id={edit ? 'vibe-prompt' : 'agent-prompt'} ref={edit ? editInput : input} rows={3} maxLength={4000} disabled={locked} value={edit ? editPrompt : prompt} placeholder={edit ? chosen ? copy.agent.composerEditPlaceholder : copy.agent.editAllPlaceholder : copy.agent.composerPlaceholder} onChange={e => edit ? setEditPrompt(e.target.value) : setPrompt(e.target.value)} onPaste={e => { if (!edit && e.clipboardData.files.length) { e.preventDefault(); void addFiles(Array.from(e.clipboardData.files)); } }} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(undefined, edit); } }} />{!edit && attachments.length > 0 && <div className="agent-attachments">{attachments.map((src,i) => <div key={src.slice(-60)}><img src={src} alt={copy.agent.attachmentAlt(i+1)} /><button type="button" aria-label={copy.agent.removeAttachment(i+1)} disabled={locked} onClick={() => setAttachments(old => old.filter((_,n) => n !== i))}><IconX size={14} /></button></div>)}</div>}<div className="agent-composer-actions">{!edit && <button type="button" disabled={locked || attachments.length >= 3} aria-label={copy.agent.addAttachment} onClick={() => fileRef.current?.click()}><IconPaperclip size={18} /></button>}<span>{edit ? selected ? copy.agent.composerEditSelected : copy.agent.composerEditAll : copy.agent.composerShortcut}</span>{busy ? <button key="stop" type="button" className="agent-send" aria-label={copy.agent.stop} onClick={() => controller.current?.abort()}><IconPlayerStop size={18} /></button> : user ? <button key="send" type="submit" className="agent-send" aria-label={edit ? copy.agent.sendEdit : copy.agent.send} disabled={locked || !(edit ? editPrompt : prompt).trim()}><IconArrowUp size={19} /></button> : <a className="agent-login" href={loginLink('/create')} onClick={e => { try { sessionStorage.setItem('imstage.agent.login-handoff', JSON.stringify({ scene, prompt, attachments, turns, editPrompt, selected, projectId, full, scopeSelected, viewportTop, intent })); } catch { e.preventDefault(); setFailure(copy.agent.loginHandoffFailed); } }}>{copy.agent.loginCreate}</a>}</div></form>;
  }
  return <section className="agent-workspace" aria-label={copy.agent.workspaceLabel} data-tab={tab} data-edit={drawer} data-chat-open={chatOpen} style={{'--creation-width':`${creationWidth}px`} as CSSProperties}>
    <header className="agent-heading agent-heading-compact"><div className="agent-heading-title"><IconSparkles size={18} stroke={1.6}/><span className="agent-scene-title" title={scene.title}>{scene.title || copy.agent.welcomeLabel}</span><span className="agent-scene-count">{copy.agent.messageCount(scene.messages.length)}</span></div><div className="agent-heading-actions"><button className="agent-button" disabled={locked||!user} aria-expanded={peopleOpen} onClick={()=>{setPeopleOpen(!peopleOpen);setDrawer(false);}}>{copy.agent.peopleTitle}</button>{user && accountAction?.(scene, locked, projectId, creationSessionId)}<button className="agent-button" disabled={locked || !history.length} aria-label={copy.agent.undo} onClick={undo} title={`${copy.agent.undo} · ⌘/Ctrl Z`}><IconArrowBackUp size={17} /></button><button className="agent-button" disabled={locked || !future.length} aria-label={copy.agent.redo} title={`${copy.agent.redo} · ⌘/Ctrl Shift Z`} onClick={redo}><IconArrowForwardUp size={17}/></button><details className="agent-more"><summary>{copy.agent.more}</summary><button onClick={() => downloadText('imstage-scene.json', JSON.stringify(scene, null, 2))}>{copy.agent.downloadJson}</button></details></div></header>
    {(failure || storageError) && <div className="agent-error" role="alert">{failure || copy.agent.errorStorage}<button aria-label={copy.agent.closeNotice} onClick={() => setFailure('')}><IconX size={16}/></button></div>}
    {!failure && !storageError && intentNeedsAttention(intent) && <div className="agent-error agent-intent" role="alert">{intent!.status === 'interrupted' ? copy.agent.intentInterrupted : intent!.error === 'persist' ? copy.agent.intentPersistFailed : copy.agent.intentFailed}{intent!.error && !['cancelled', 'persist'].includes(intent!.error) ? ` ${intent!.error}` : ''}<button disabled={locked} onClick={() => void startIntent(intent!)}>{copy.agent.intentRetry}</button><button disabled={locked} onClick={() => void applyIntent({ ...intent!, status: 'done' })}>{copy.agent.intentDismiss}</button></div>}
    <div className="agent-mobile-tabs"><button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>{copy.agent.mobileChat}</button><button aria-pressed={tab === 'canvas'} onClick={() => setTab('canvas')}>{copy.agent.mobileCanvas} {busy && `· ${copy.agent.mobileBusy}`}</button></div>
    <div className="agent-body"><aside id="creation-panel" aria-label={copy.agent.creationArea} className={`agent-chat${dragging ? ' is-dragging' : ''}`} onDragEnter={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth.current++;setDragging(true);}}} onDragOver={e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect=locked?'none':'copy';}}} onDragLeave={e=>{e.preventDefault();dragDepth.current=Math.max(0,dragDepth.current-1);if(!dragDepth.current)setDragging(false);}} onDrop={dropFiles}>{dragging && <div className="agent-drop-overlay"><IconUpload size={30}/><strong>{locked?copy.agent.dragWaiting:copy.agent.dragReady}</strong><span>{copy.agent.dragFormats}</span></div>}{!sessionControls&&<div className="agent-panel-label"><IconMessageCircle size={17} /><strong>{copy.agent.panelLabel}</strong><span>{busy ? copy.agent.panelBusy : 'Agent'}</span></div>}{sessionControls}<div className="editor-tabs" role="group" aria-label={copy.agent.leftPanelLabel}><button aria-pressed={leftTab==='ai'} onClick={()=>setLeftTab('ai')}><IconSparkles size={15}/>{copy.agent.tabAi}</button><button aria-pressed={leftTab==='elements'} onClick={()=>setLeftTab('elements')}><IconListDetails size={15}/>{copy.agent.tabElements} <span>{scene.messages.length}</span></button><button className="creation-expand" aria-label={creationWidth>500?copy.agent.expandWide:copy.agent.expandNarrow} title={copy.agent.expandHint} onClick={()=>setCreationWidth(creationWidth>500?480:640)}><IconArrowsHorizontal size={17}/></button></div>{leftTab==='elements' ? <ElementNavigator scene={scene} selected={selected} locked={locked} onSelect={id=>{selectElement(id);setTab('canvas');}} onChange={patch}/> : <><details className="creation-context"><summary>{copy.agent.contextSummary}<span>{projects.find(p=>p.id===projectId)?.name||copy.agent.standalone}</span></summary>{user&&<button className="agent-identity-summary" disabled={locked} onClick={()=>{setPeopleOpen(true);setDrawer(false);}}>{contacts.loading?copy.agent.readingPeople:(contacts.error||contacts.loadError)?copy.agent.peopleFailed:copy.agent.defaultPerson(contacts.library?.contacts.find(c=>c.id===contacts.library?.selfContactId)?.name||copy.agent.defaultPersonUnset)}<span>{copy.agent.configure}</span></button>}<label className="agent-project">{copy.agent.projectRules}<select aria-label={copy.agent.currentProject} value={projectId} disabled={locked} onChange={e=>{setProjectId(e.target.value);const p=projects.find(p=>p.id===e.target.value);if(p&&!scene.messages.length&&!scene.reference)patch({...scene,platform:p.platform});}}><option value="">{copy.agent.standalone}</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><a href="#/projects">{copy.agent.manageProjects}</a></label></details>{!turns.length && <div className="agent-welcome"><button className="agent-drop-entry" disabled={locked || attachments.length>=3} onClick={()=>fileRef.current?.click()}><IconUpload size={20}/><span>{copy.agent.dropEntry}<strong>{copy.agent.dropEntryAction}</strong></span></button><div className="agent-ideas">{copy.agent.ideas.map((idea, index) => <button key={idea} onClick={() => { setPrompt(idea); input.current?.focus(); }}><span>{copy.agent.ideaLabels[index] || idea}</span><IconArrowUp size={14}/></button>)}</div></div>}{transcript()}<div className="agent-input-dock">{capError ? <button className="agent-capability" onClick={() => setCapRetry(v => v+1)}>{copy.agent.capabilitiesError}</button> : <p className="agent-capability">{caps ? caps.configured ? (caps.imageConfigured ? copy.agent.capabilityConnected(caps.model) : `${caps.model} · ${copy.agent.capabilityImageMissing}`) : copy.agent.capabilityModelMissing : copy.agent.capabilityConnecting}</p>}{attachments.length>0&&!scene.reference&&<button type="button" className="agent-button" disabled={locked} onClick={async()=>{setReading(true);try{const source=attachments[0];const img=new Image();img.src=source;await img.decode();const im=['wechat','whatsapp','instagram'].includes(scene.platform)?scene.platform:'wechat';patch({...scene,platform:im as Platform,reference:{source,plan:{schemaVersion:1,im,surface:scene.surface==='desktop'?'desktop':'ios',width:img.naturalWidth,height:img.naturalHeight,edits:[],warnings:[]},assets:[]}});setAttachments([]);setSelected('');setNotice(copy.agent.keepScreenshotNotice);}catch{setFailure(copy.agent.imageReadFailed);}finally{setReading(false);}}}>{copy.agent.keepScreenshot}</button>}{composer()}<input hidden ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => { void addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /><small>{copy.agent.uploadHint}</small></div></>}</aside>{chatOpen&&<CreationDivider width={creationWidth} onChange={setCreationWidth}/>}
    <div className="agent-render"><div className="agent-render-toolbar"><button className="canvas-tool" aria-label={chatOpen ? copy.agent.collapsePanel : copy.agent.expandPanel} onClick={()=>setChatOpen(!chatOpen)}><IconLayoutSidebarLeftCollapse size={18}/></button><label><span className="sr-only">{copy.agent.platform}</span><select aria-label={copy.agent.platform} disabled={locked} value={scene.platform} onChange={e => { if(scene.reference){ setAttachments([scene.reference.source]); patch({...scene,reference:undefined,platform:e.target.value as Platform});setNotice(copy.agent.platformSwitched); } else patch({ ...scene, platform: e.target.value as Platform }); }}>{PLATFORMS.map(p => <option key={p} value={p}>{copy.platforms[p]}</option>)}</select></label><select aria-label={copy.agent.device} value={scene.deviceProfileId||''} disabled={locked||!!scene.reference} onChange={e=>{if(!e.target.value){patch({...scene,deviceProfileId:undefined});return;}const p=DEVICE_PROFILES.find(p=>p.id===e.target.value);if(p)patch({...scene,deviceProfileId:p.id,surface:p.surface});}}><option value="">{copy.agent.genericDevice}</option>{DEVICE_PROFILES.map(p=><option key={p.id} value={p.id}>{copy.devices[p.id] || p.label}</option>)}</select><span>{busy ? copy.agent.updating : scene.reference ? copy.agent.editLayers(scene.reference.plan.edits.length) : copy.agent.messageCount(scene.messages.length)}</span><div><select aria-label={copy.agent.exportRange} value={full ? 'full':'standard'} disabled={locked} onChange={e => setFull(e.target.value === 'full')}><option value="full">{copy.agent.longShot}</option><option value="standard">{copy.agent.standardShot}</option></select><button className="agent-button agent-copy" aria-label={copy.agent.copyPng} disabled={locked || (!scene.messages.length && !scene.reference)} onClick={() => void copyPng()}><IconCopy size={16}/>{copying ? copy.agent.copying : copy.agent.copyPng}</button><button className="agent-button agent-primary" disabled={locked || (!scene.messages.length && !scene.reference)} onClick={() => void exportPng()}><IconDownload size={16}/>{exporting ? copy.agent.exporting : copy.agent.exportPng}</button><TemplateSavePanel scene={scene} locked={locked}/></div></div><div className="agent-canvas" ref={canvasRef} tabIndex={0} aria-label={copy.agent.liveCanvas}>{!scene.messages.length && !scene.reference && <div className="agent-empty-hint"><span>{copy.agent.canvasEmptyTitle}</span><p>{copy.agent.canvasEmptyBody}</p></div>}<DevicePreview scene={scene} full={full} zoom={zoom} onScale={setScale}>{scene.reference ? <ReferenceView document={scene.reference} onSelect={locked?undefined:id=>selectElement(`@patch:${id}`)}/> : <SceneView scene={scene} interactiveViewport={!full} pendingAssets={busy} onSelectElement={locked ? undefined : selectElement} selectedId={selected} onSelect={locked ? undefined : selectElement} />}</DevicePreview><p className="agent-canvas-caption">{scene.reference ? copy.agent.referenceCaption : copy.agent.canvasCaption(copy.devices[deviceProfile(scene).id] || deviceProfile(scene).label, deviceProfile(scene).width*deviceProfile(scene).pixelRatio, deviceProfile(scene).height*deviceProfile(scene).pixelRatio, full)}</p></div><footer className="agent-render-footer"><span role="status">{notice || copy.agent.pointHint}</span><div className="canvas-zoom" role="group" aria-label={copy.agent.canvasZoom}><button aria-label={copy.agent.zoomOut} onClick={()=>setZoom(Math.max(.25,scale-.1))}><IconMinus size={14}/></button><button aria-label={copy.agent.zoomFit} title={copy.agent.zoomFitHint} onClick={()=>setZoom('fit')}>{zoom==='fit' ? copy.agent.zoomFitShort : `${Math.round(scale*100)}%`}</button><button aria-label={copy.agent.zoomIn} onClick={()=>setZoom(Math.min(1.5,scale+.1))}><IconPlus size={14}/></button></div><button className="agent-button" aria-expanded={drawer} onClick={() => { setDrawer(!drawer); setPeopleOpen(false); setSelected(''); }}><IconWand size={17}/>{copy.agent.elements}</button></footer></div>
    {peopleOpen&&user&&<aside className="agent-vibe" aria-label={copy.agent.peopleTitle} onKeyDown={e=>{if(e.key==='Escape'&&!locked)setPeopleOpen(false);}}><div className="agent-panel-label"><strong>{copy.agent.peopleTitle}</strong><button disabled={locked} aria-label={copy.agent.peopleClose} onClick={()=>setPeopleOpen(false)}><IconX size={19}/></button></div><ContactPanel key={user.id} userId={user.id} scene={scene} store={contacts} locked={locked} onChange={patch} onBusy={setReading}/></aside>}
    {drawer && <aside className="agent-vibe editor-inspector" aria-label={copy.agent.inspectorLabel} onKeyDown={e => { if (e.key === 'Escape') { setDrawer(false); setSelected(''); } }}>
      <div className="agent-panel-label"><IconWand size={18}/><strong>{copy.agent.elements}</strong><button aria-label={copy.agent.inspectorClose} onClick={() => { setDrawer(false); setSelected(''); }}><IconX size={19}/></button></div>
      <div className="editor-selection"><span>{selectionLabel}</span><p>{chosen?.text || (selected.startsWith('@participant:') ? copy.agent.selectionPersonHint : copy.agent.selectionFrameHint)}</p>{selected && <button disabled={locked} onClick={()=>setSelected('')}>{copy.agent.switchWhole}</button>}</div>
      <div className="editor-tabs" role="group" aria-label={copy.agent.inspectorTabs}><button aria-pressed={inspectorTab==='properties'} onClick={()=>setInspectorTab('properties')}>{copy.agent.inspectorProperties}</button><button aria-pressed={inspectorTab==='ai'} onClick={()=>setInspectorTab('ai')}><IconSparkles size={15}/>{copy.agent.inspectorAi}</button></div>
      {inspectorTab==='properties' ? <div className="editor-properties">{scene.reference ? <ReferenceInspector scene={scene} selected={selected} locked={locked} onChange={patch} onSelect={selectElement}/> : <ElementInspector scene={scene} selected={selected} locked={locked} onSelect={selectElement} onChange={patch} onBusy={setReading}/>}</div> : <><div className="editor-ai-intro"><span><IconSparkles size={16}/> {selected ? copy.agent.inspectorAiTitleSelected(selectionLabel) : copy.agent.inspectorAiTitleAll}</span><p>{copy.agent.inspectorAiIntro}</p><div className="editor-ai-suggestions">{(chosen ? copy.agent.inspectorSuggestionsMessage : selected.startsWith('@participant:') ? copy.agent.inspectorSuggestionsPerson : copy.agent.inspectorSuggestionsAll).map(text=><button disabled={locked} key={text} onClick={()=>{setEditPrompt(text);editInput.current?.focus();}}>{text}</button>)}</div></div>{transcript(true)}<div className="agent-vibe-composer">{composer(true)}</div></>}
      {inspectorTab==='properties' && <div className="editor-ai-entry"><button className="agent-button" onClick={()=>setInspectorTab('ai')}><IconSparkles size={16}/>{copy.agent.inspectorAiEntry(!!selected)}<IconArrowUp size={15}/></button><small>{copy.agent.inspectorAiNote}</small></div>}
    </aside>}

    </div>
    {copyFallback && <div className="copy-result" role="dialog" aria-modal="false" aria-label={copy.agent.copyDialogLabel}><div><strong>{copy.agent.copyReady}</strong><button className="icon-btn" aria-label={copy.agent.closePreview} onClick={()=>setCopyFallback(null)}><IconX size={18}/></button></div><p>{copy.agent.copyInstruction}</p>{copyPreview && <img src={copyPreview} alt={copy.agent.copyAlt}/>}<button className="agent-button" onClick={()=>downloadBlob(copyFallback,pngName())}><IconDownload size={16}/>{copy.agent.copyDownload}</button></div>}
    {exportScene && <div className="agent-export" aria-hidden="true"><div ref={exportRef} className="agent-export-frame" data-mode={full ? 'full' : 'standard'} style={{ width:deviceProfile(exportScene).width, height:full ? 'auto':deviceProfile(exportScene).height, overflow:'hidden' }}><SceneView scene={exportScene} exportMode/></div></div>}
  </section>;
}

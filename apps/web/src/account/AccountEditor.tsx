import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { IconDeviceFloppy } from '@tabler/icons-react';
import { useAuth } from './Auth';
import { api, ApiError, errorText, loginLink, type SavedScene } from './api';
import { setNavigationGuard } from './navigation';
import { createScene, validateScene, type Scene } from '../studio/model';
const Studio = lazy(() => import('../agent/AgentStudio'));
export function AccountSave({ scene, disabled = false, projectId, localSessionId }: { scene: Scene; disabled?: boolean; projectId?:string; localSessionId?:string }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const id = useRef(localSessionId || crypto.randomUUID());
  const linkKey = localSessionId ? `imstage.work-link.${user?.id}.${localSessionId}` : null;
  const [conflict,setConflict]=useState(false);
  const [revision, setRevision] = useState(() => { try { const value=linkKey?Number(localStorage.getItem(linkKey)):0;return Number.isSafeInteger(value)&&value>0?value:0; } catch { return 0; } });
  const snapshot = useRef('');
  if (!user) return <a className="studio-btn" href={loginLink('/studio')}>登录保存作品</a>;
  async function save() {
    if (busy) return; setBusy(true); setStatus(''); const raw = JSON.stringify({scene,projectId});
    try { const data = await api<{ item: SavedScene }>(`/scenes/${id.current}`, { method: 'PUT', body: { scene: { ...scene, id: id.current }, revision, projectId } }); setRevision(data.item.revision); snapshot.current = raw; setConflict(false); setStatus('已保存到我的作品');if(linkKey)try{localStorage.setItem(linkKey,String(data.item.revision));}catch{setStatus('作品已保存，但本机无法记录版本。下次请从我的作品打开。');} }
    catch (error) { setConflict(error instanceof ApiError && error.status===409);setStatus(errorText(error)); } finally { setBusy(false); }
  }
  return <div className="account-save"><button className="studio-btn" onClick={save} disabled={disabled || busy || snapshot.current === JSON.stringify({scene,projectId})}><IconDeviceFloppy size={16} />{busy ? '正在保存…' : '保存到我的作品'}</button>{(status || revision>0) && <span className="account-save-message" role="status">{status || '已关联我的作品'} {(revision > 0 || conflict) && <a href={`#/workspace?scene=${id.current}`}>打开作品 →</a>}</span>}</div>;
}
export default function AccountEditor({ sceneId }: { sceneId: string }) {
  const { user } = useAuth();
  const [item, setItem] = useState<SavedScene | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError(''); setItem(null);
    if (sceneId === 'new') { const id = crypto.randomUUID(); setItem({ id, revision: 0, updatedAt: '', scene: { ...createScene(), id, title: '新的对话', selfId: 'me', participants: [{id:'me',name:'我'},{id:'other',name:'对方'}], messages: [] } }); return; }
    api<{ item: SavedScene }>(`/scenes/${encodeURIComponent(sceneId)}`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setItem(data.item); }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    return () => controller.abort();
  }, [sceneId, retry]);
  if (error) return <section className="account-gate"><h1>暂时打不开这份作品</h1><p role="alert">{error}</p><button className="btn btn-secondary" onClick={() => setRetry(retry + 1)}>重试</button> <a className="text-link" href="#/workspace">返回我的作品</a></section>;
  if (!item || !user) return <p className="page-loading" role="status">正在打开作品…</p>;
  return <EditorSession key={`${user.id}:${sceneId}:${retry}`} item={item} userId={user.id} draftId={sceneId} />;
}
function EditorSession({ item, userId, draftId }: { item: SavedScene; userId: string; draftId: string }) {
  const draftKey = `imstage.account.${userId}.${draftId}`;
  const [initial] = useState(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      const parsed = validateScene(draft?.scene);
      if (parsed.ok && parsed.scene && typeof draft.id === 'string' && /^[a-f0-9-]{36}$/.test(draft.id) && Number.isSafeInteger(draft.revision) && draft.revision >= 0) return { scene: parsed.scene, id: draft.id, revision: draft.revision, projectId: typeof draft.projectId === 'string' ? draft.projectId : item.projectIds?.[0] || '', recovered: true };
    } catch { /* ignore unavailable/corrupt local recovery */ }
    return { scene: item.scene, id: item.id, revision: item.revision, projectId: item.projectIds?.[0] || '', recovered: false };
  });
  const [projectId,setProjectId]=useState(initial.projectId);
  const [scene, setScene] = useState(initial.scene);
  const [revision, setRevision] = useState(initial.revision);
  const [id, setId] = useState(initial.id);
  const [savedRaw, setSavedRaw] = useState(initial.recovered ? '' : item.revision ? JSON.stringify({scene:item.scene,projectId:item.projectIds?.[0] || ''}) : '');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(initial.recovered ? '已恢复此标签页未保存的内容，请确认后保存。' : '');
  const [conflict, setConflict] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentStorageError, setAgentStorageError] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const liveScene = useRef(scene); liveScene.current = scene;
  const dirty = savedRaw !== JSON.stringify({scene,projectId});
  useEffect(() => {
    try { if (dirty) sessionStorage.setItem(draftKey, JSON.stringify({ id, scene, revision, projectId })); else sessionStorage.removeItem(draftKey); setStorageError(false); }
    catch { setStorageError(true); }
  }, [scene, revision, id, dirty, draftKey, projectId]);
  useEffect(() => { const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  useEffect(() => {
    if ((!dirty || !storageError) && !agentStorageError) return;
    return setNavigationGuard(() => window.confirm('当前修改尚未保存，浏览器也无法保存恢复副本。离开会丢失这些修改，确定离开？'));
  }, [dirty, storageError, agentStorageError]);
  async function save(copy = false) {
    if (busy || agentBusy) return; setBusy(true); setStatus('');
    const sent = liveScene.current; const raw = JSON.stringify({scene:sent,projectId}); const target = copy ? crypto.randomUUID() : id;
    try {
      const result = await api<{ item: SavedScene }>(`/scenes/${target}`, { method: 'PUT', body: { scene: { ...sent, id: target }, revision: copy ? 0 : revision, projectId } });
      if (!active.current) return;
      setId(target); setRevision(result.item.revision); setSavedRaw(raw); setConflict(false); setStatus('已保存到账号');
      if (JSON.stringify({scene:liveScene.current,projectId}) === raw && (draftId === 'new' || copy)) { try { sessionStorage.removeItem(draftKey); } catch {} location.hash = `/workspace?scene=${target}`; }
    } catch (error) { if (!active.current) return; setStatus(errorText(error)); setConflict(error instanceof ApiError && error.status === 409); }
    finally { if (active.current) setBusy(false); }
  }
  return <><div className="account-editor-bar"><a href="#/workspace">← 我的作品</a><p>{dirty ? '有未保存的修改' : '已保存到账号'} · {storageError || agentStorageError ? '无法保存恢复副本，请先保存作品或导出 JSON' : '未保存的内容可在此标签页恢复'}</p></div>
    {conflict && <div className="account-error account-editor-error" role="alert">服务端的版本已经改变，当前修改仍保留。可以下载场景 JSON，或另存一份作品。<button disabled={busy || agentBusy} onClick={() => save(true)}>另存为新作品</button></div>}
    <Suspense fallback={<p className="page-loading" role="status">正在准备编辑器…</p>}><Studio initialProjectId={projectId} onProjectChange={setProjectId} initialScene={initial.scene} persistLocal={false} disabled={busy} onBusyChange={setAgentBusy} onStorageError={setAgentStorageError} onSceneChange={setScene} accountAction={(_, locked) => <div className="account-save"><button className="studio-btn" disabled={busy || locked || !dirty} onClick={() => save()}><IconDeviceFloppy size={16} />{busy ? '正在保存…' : '保存作品'}</button>{status && <span className="account-save-message" role="status">{status}</span>}</div>} /></Suspense>
  </>;
}

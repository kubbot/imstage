import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { IconChevronDown, IconPlus, IconSearch, IconPencil, IconCopy, IconTrash, IconX, IconMessageCircle } from '@tabler/icons-react';
import { useAuth } from '../account/Auth';
import AgentStudio from './AgentStudio';
import { setNavigationGuard } from '../account/navigation';
import { useLocale } from '../marketing/LocaleContext';
import { clearHandoffScene, readHandoffScene } from '../marketing/handoff';
import loanCase from '../../../../tools/eval/fixtures/loan-anniversary.json';
import { emptyDraft, recoverDraft, newSession, readSession, writeSession, listSessions, removeSession, type SessionDraft, type SessionMeta, type SessionRecord } from './sessions';
import './sessions.css';

export default function AgentWorkspace(props:ComponentProps<typeof AgentStudio>) {
  const {user}=useAuth();const owner=user?.id||'guest';
  const {locale}=useLocale();
  const params=new URLSearchParams(location.hash.split('?')[1]);const sample=params.get('case')==='loan-anniversary';
  // Explicit launch handoff from the public site. It is only honoured while
  // creating a brand new session, so an existing draft can never be replaced.
  const launchNew=params.get('new')==='1';
  const requestedLocale=params.get('lang')==='en'?'en':params.get('lang')==='zh'?'zh':undefined;
  const seedScenario=params.get('scenario')||undefined;
  const handoffToken=params.get('handoff')||undefined;
  const origin=`${sample?'case-loan-anniversary':'draft'}:${params.get('project')||''}`;
  const pointer=`imstage.sessions.active.${owner}.${origin}`;
  const [record,setRecord]=useState<SessionRecord|null>(null),[items,setItems]=useState<SessionMeta[]>([]);
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[switching,setSwitching]=useState(false);
  const [status,setStatus]=useState('正在读取会话…'),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const [renaming,setRenaming]=useState(''),[name,setName]=useState(''),[deleting,setDeleting]=useState('');
  const current=useRef<SessionRecord|null>(null),latest=useRef<SessionDraft|null>(null);
  const version=useRef(0),saved=useRef(0),queue=useRef(Promise.resolve()),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const mounted=useRef(true),boot=useRef<Promise<SessionRecord>|null>(null),operation=useRef(false);
  // The current UI language seeds genuinely new sessions without re-running the
  // load effect when the visitor switches language.
  const localeRef=useRef(locale);localeRef.current=locale;
  const seedLocale=requestedLocale??localeRef.current;
  const panel=useRef<HTMLDivElement>(null),toggle=useRef<HTMLButtonElement>(null);
  const refresh=useCallback(async()=>{const rows=await listSessions(owner);if(mounted.current)setItems(rows);},[owner]);
  const adopt=useCallback((next:SessionRecord)=>{
    current.current=next;latest.current=next.draft;version.current=0;saved.current=0;
    try{sessionStorage.setItem(pointer,next.id);}catch{/* IndexedDB still owns the draft. */}
    if(mounted.current){setRecord(next);setStatus('已保存到本机');setError('');setOpen(false);setRenaming('');setDeleting('');setQuery('');setBusy(false);}
  },[pointer]);
  const persist=useCallback(async()=>{
    clearTimeout(timer.current);const id=current.current?.id,draft=latest.current,v=version.current;
    if(!id||!draft)return;
    const work=queue.current.catch(()=>{}).then(async()=>{
      if(current.current?.id!==id||saved.current>=v)return;
      if(mounted.current)setStatus('正在保存…');
      const next=await writeSession({...current.current,draft});
      current.current=next;saved.current=v;
      if(mounted.current){setRecord(next);setStatus(version.current===v?'已保存到本机':'等待保存…');setError('');}
    });
    queue.current=work;
    try{await work;}catch(e){if(mounted.current){setStatus('尚未保存');setError(e instanceof Error?e.message:'无法保存会话，请检查浏览器存储空间。');}throw e;}
  },[]);
  const change=useCallback((draft:SessionDraft)=>{
    const old=latest.current;
    if(old&&(Object.keys(draft) as (keyof SessionDraft)[]).every(key=>{const a=draft[key],b=old[key];return a===b||(Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>v===b[i]));}))return;
    latest.current=draft;version.current++;setStatus('等待保存…');clearTimeout(timer.current);
    timer.current=setTimeout(()=>void persist().catch(()=>{}),300);
  },[persist]);
  useEffect(()=>{
    mounted.current=true;
    async function initialize(){
      if(user){
        let handoff:Partial<SessionDraft>|null=null;
        try{handoff=JSON.parse(sessionStorage.getItem('imstage.agent.login-handoff')||'null');}catch{}
        if(handoff){const next=await writeSession(newSession(owner,origin,recoverDraft(handoff,emptyDraft(params.get('project')||'',{locale:seedLocale}))));try{sessionStorage.removeItem('imstage.agent.login-handoff');}catch{}return next;}
      }
      if(launchNew){
        const fallback=emptyDraft(params.get('project')||'',{locale:seedLocale,scenario:seedScenario});
        // A handed-off scene was written to sessionStorage before navigation and
        // is validated here; invalid or missing payloads fall back to the seed.
        const stored=readHandoffScene(handoffToken);
        const draft=stored?recoverDraft({scene:stored} as Partial<SessionDraft>,fallback):fallback;
        draft.scene.id=crypto.randomUUID();
        const created=await writeSession(newSession(owner,origin,draft));
        clearHandoffScene(handoffToken);
        try{const [path,query='']=location.hash.slice(1).split('?');const p=new URLSearchParams(query);p.delete('new');p.delete('handoff');p.delete('scenario');history.replaceState(null,'',`${location.pathname}${location.search}#${path}${p.toString()?`?${p.toString()}`:''}`);}catch{/* The session exists; the URL hint is only a convenience. */}
        return created;
      }
      let activeId:string|null=null;try{activeId=sessionStorage.getItem(pointer);}catch{}
      if(activeId){try{return await readSession(owner,activeId);}catch(e){if(!(e instanceof Error)||!e.message.startsWith('会话已被删除'))throw e;}}
      const key=`imstage.agent.${owner}.${sample?'case-loan-anniversary':'draft'}`;
      let legacy:Partial<SessionDraft>|null=null;
      try{legacy=JSON.parse(sessionStorage.getItem(key)||'null');if(legacy)legacy.turns=JSON.parse(sessionStorage.getItem(`${key}.chat`)||'[]');}catch{}
      const fallback=emptyDraft(params.get('project')||'',{locale:seedLocale});if(sample){fallback.scene=loanCase.scene as SessionDraft['scene'];fallback.full=true;}
      if(!legacy){const recent=(await listSessions(owner)).find(s=>s.origin===origin);if(recent)return readSession(owner,recent.id);}
      const created=await writeSession(newSession(owner,origin,recoverDraft(legacy,fallback),sample?'去年借款，今天归还':undefined));
      // Remove only after durable migration, never before a successful transaction.
      try{sessionStorage.removeItem(key);sessionStorage.removeItem(`${key}.chat`);if(user)sessionStorage.removeItem('imstage.agent.login-handoff');}catch{}
      return created;
    }
    boot.current??=initialize();let cancelled=false;
    void boot.current.then(next=>{if(!cancelled){adopt(next);void refresh();}}).catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:'会话库无法打开');});
    return()=>{cancelled=true;mounted.current=false;clearTimeout(timer.current);void persist().catch(()=>{});};
  },[retry]); // The App keys this workspace by account and entry point.
  useEffect(()=>setNavigationGuard(()=>{
    if(version.current>saved.current){const destination=location.hash;void persist().then(()=>{location.hash=destination;}).catch(()=>{});return false;}
    return true;
  }),[busy,persist]);
  useEffect(()=>{
    const unload=(e:BeforeUnloadEvent)=>{if(version.current>saved.current||operation.current){void persist().catch(()=>{});e.preventDefault();e.returnValue='';}};
    const hide=()=>{if(document.visibilityState==='hidden')void persist().catch(()=>{});};
    window.addEventListener('beforeunload',unload);document.addEventListener('visibilitychange',hide);
    return()=>{window.removeEventListener('beforeunload',unload);document.removeEventListener('visibilitychange',hide);};
  },[persist]);
  useEffect(()=>{
    if(!open)return;
    const dismiss=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);toggle.current?.focus();}};
    document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);};
  },[open]);
  async function action(task:()=>Promise<void>){
    if(busy||operation.current)return;operation.current=true;setSwitching(true);setError('');
    try{await task();await refresh();}catch(e){setError(e instanceof Error?e.message:'操作失败，当前内容已保留。');}finally{operation.current=false;setSwitching(false);}
  }
  const create=(copy=false)=>action(async()=>{
    // Explicit recovery copy preserves local edits even after a stale-tab conflict.
    if(!copy)await persist();else{clearTimeout(timer.current);await queue.current.catch(()=>{});}
    const draft=copy&&latest.current?structuredClone(latest.current):emptyDraft(latest.current?.projectId,{locale:localeRef.current});
    draft.scene.id=crypto.randomUUID();
    const next=await writeSession(newSession(owner,origin,draft,copy?`${current.current?.title||'会话'} · 副本`:undefined));adopt(next);
  });
  async function switchTo(id:string){await action(async()=>{await persist();if(current.current?.id!==id)adopt(await readSession(owner,id));else setOpen(false);});}
  async function rename(id:string){await action(async()=>{if(!name.trim())return;await persist();const existing=await readSession(owner,id);const next=await writeSession({...existing,title:name.trim().slice(0,60),named:true});if(current.current?.id===id){current.current=next;setRecord(next);}setRenaming('');});}
  async function remove(id:string){await action(async()=>{
    await persist();const existing=await readSession(owner,id);await removeSession(existing);
    if(current.current?.id===id){const rest=await listSessions(owner);const next=rest[0]?await readSession(owner,rest[0].id):await writeSession(newSession(owner,origin,emptyDraft('',{locale:localeRef.current})));adopt(next);}
    setDeleting('');
  });}
  if(!record)return <div className="page-loading" role="status">{error||'正在恢复创作会话…'}{error&&<button onClick={()=>{boot.current=null;setError('');setRetry(n=>n+1);}}>重试读取会话</button>}</div>;
  const locked=busy||switching;const filtered=items.filter(s=>`${s.title} ${s.preview}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const controls=<div className="session-toolbar" ref={panel}>
    <div className="session-current"><button ref={toggle} className="session-toggle" aria-label="管理创作会话" aria-expanded={open} aria-controls="creation-sessions" onClick={()=>{setOpen(!open);if(!open)void refresh().catch(e=>setError(e.message));}}><IconMessageCircle size={17}/><span><strong>{record.title}</strong><small>{busy?'AI 正在创作 · 停止后可切换':status}</small></span><IconChevronDown size={15}/></button><button className="session-new" aria-label="新建会话" title="新建会话，保留当前内容" disabled={locked} onClick={()=>void create()}><IconPlus size={19}/></button></div>
    {error&&<div className="session-error" role="alert"><p>{error}</p><button disabled={locked} onClick={()=>void action(persist)}>重试保存</button><button disabled={locked} onClick={()=>void create(true)}>另存为新会话</button></div>}
    {open&&<section id="creation-sessions" className="session-list-panel" aria-label="创作会话列表"><header><strong>创作会话 <span>{items.length}</span></strong><button aria-label="关闭会话列表" onClick={()=>{setOpen(false);toggle.current?.focus();}}><IconX size={18}/></button></header><label className="session-search"><IconSearch size={16}/><input autoFocus aria-label="搜索会话" placeholder="搜索名称或内容" value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="session-list">{filtered.length===0?<p className="session-no-results">没有找到相关会话，试试其他关键词。</p>:filtered.map(item=><article key={item.id} className={`session-item${item.id===record.id?' is-active':''}`}>
      {renaming===item.id?<form onSubmit={e=>{e.preventDefault();void rename(item.id);}}><input autoFocus aria-label="会话名称" maxLength={60} value={name} onChange={e=>setName(e.target.value)}/><button disabled={locked||!name.trim()} type="submit">保存名称</button><button type="button" onClick={()=>setRenaming('')}>取消</button></form>:<><button className="session-select" disabled={locked} aria-label={`打开会话：${item.title}`} aria-current={item.id===record.id?'true':undefined} onClick={()=>void switchTo(item.id)}><strong>{item.title}</strong><span>{item.preview}</span><small>{item.id===record.id?'当前会话 · ':''}{new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(item.updatedAt)} · {item.count} 条消息</small></button><div className="session-item-actions"><button aria-label={`重命名：${item.title}`} title="重命名" disabled={locked} onClick={()=>{setRenaming(item.id);setName(item.title);}}><IconPencil size={15}/></button>{item.id===record.id&&<button aria-label="复制当前会话" title="复制当前会话" disabled={locked} onClick={()=>void create(true)}><IconCopy size={15}/></button>}<button aria-label={`删除：${item.title}`} title="删除会话" disabled={locked} onClick={()=>setDeleting(item.id)}><IconTrash size={15}/></button></div></>}
      {deleting===item.id&&<div className="session-delete-confirm"><p>删除「{item.title}」的本机会话？已保存到“我的作品”的内容不受影响。</p><button disabled={locked} onClick={()=>void remove(item.id)}>确认删除会话</button><button onClick={()=>setDeleting('')}>保留会话</button></div>}
    </article>)}</div><footer>会话仅存此浏览器 · 画面可另存到“我的作品”</footer></section>}
  </div>;
  return <AgentStudio {...props} key={record.id} creationSessionId={record.id} initialDraft={record.draft} onDraftChange={change} sessionControls={controls} disabled={switching} onBusyChange={setBusy}/>;
}

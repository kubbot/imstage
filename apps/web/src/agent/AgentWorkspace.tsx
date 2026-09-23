import { useCallback, useEffect, useRef, useState, type ComponentProps } from 'react';
import { IconChevronDown, IconPlus, IconSearch, IconPencil, IconCopy, IconTrash, IconX, IconMessageCircle } from '@tabler/icons-react';
import { useAuth } from '../account/Auth';
import AgentStudio from './AgentStudio';
import { setNavigationGuard } from '../account/navigation';
import { useCopy, useFormatLocale } from '../i18n';
import { clearHandoffScene, readHandoffPayload } from '../marketing/handoff';
import type { SendIntent } from '../sendIntent';
import loanCase from '../../../../tools/eval/fixtures/loan-anniversary.json';
import { emptyDraft, recoverDraft, newSession, readSession, writeSession, listSessions, removeSession, type SessionDraft, type SessionMeta, type SessionRecord } from './sessions';
import { isTemplateScreenshotMode, readTemplateScreenshot, clearTemplateScreenshot } from '../templates/screenshotSeed';
import { applyNewSceneDefaults, ensurePreferences } from '../preferences/api';
import type { Scene } from '../studio/model';
import './sessions.css';

/** Build a preserve-source reference document from an uploaded screenshot. */
async function referenceFromSource(source: string, platform: Scene["platform"]): Promise<Partial<Scene> | null> {
  try {
    const img = new Image();
    img.src = source;
    await img.decode();
    const width = img.naturalWidth || 360;
    const height = img.naturalHeight || 640;
    return { reference: { source, assets: [], plan: { schemaVersion: 1 as const, im: platform === 'whatsapp' ? 'whatsapp' as const : platform === 'instagram' ? 'instagram' as const : 'wechat' as const, surface: 'ios' as const, width, height, edits: [], warnings: [] } } };
  } catch {
    return null;
  }
}

export default function AgentWorkspace(props:ComponentProps<typeof AgentStudio>) {
  const {user}=useAuth();const owner=user?.id||'guest';
  // Brand-new sessions inherit the saved account defaults. Existing sessions
  // (and duplicated ones) are never rewritten.
  const withDefaults=<T extends {scene:Scene}>(draft:T):T=>({...draft,scene:applyNewSceneDefaults(draft.scene,user?.id)});
  const copy=useCopy();
  const formatLocale=useFormatLocale();
  const params=new URLSearchParams(location.hash.split('?')[1]);const sample=params.get('case')==='loan-anniversary';
  // Explicit launch handoff from the public site. It is only honoured while
  // creating a brand new session, so an existing draft can never be replaced.
  const launchNew=params.get('new')==='1';
  const requestedLocale=params.get('lang')==='en'?'en':params.get('lang')==='zh'?'zh':undefined;
  const seedScenario=params.get('scenario')||undefined;
  const handoffToken=params.get('handoff')||undefined;
  const templateFlow=params.get('templateFlow');
  const origin=`${sample?'case-loan-anniversary':'draft'}:${params.get('project')||''}`;
  const pointer=`imstage.sessions.active.${owner}.${origin}`;
  const [record,setRecord]=useState<SessionRecord|null>(null),[items,setItems]=useState<SessionMeta[]>([]);
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[switching,setSwitching]=useState(false);
  const [status,setStatus]=useState(copy.sessions.reading),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const [renaming,setRenaming]=useState(''),[name,setName]=useState(''),[deleting,setDeleting]=useState('');
  const current=useRef<SessionRecord|null>(null),latest=useRef<SessionDraft|null>(null);
  const version=useRef(0),saved=useRef(0),queue=useRef(Promise.resolve()),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const mounted=useRef(true),boot=useRef<Promise<SessionRecord>|null>(null),operation=useRef(false);
  // The current UI language seeds genuinely new sessions without re-running the
  // load effect when the visitor switches language.
  const localeRef=useRef(formatLocale);localeRef.current=formatLocale;
  const seedLocale: 'zh'|'en'=requestedLocale??(formatLocale==='zh-CN'?'zh':'en');
  const panel=useRef<HTMLDivElement>(null),toggle=useRef<HTMLButtonElement>(null);
  const refresh=useCallback(async()=>{const rows=await listSessions(owner);if(mounted.current)setItems(rows);},[owner]);
  const adopt=useCallback((next:SessionRecord)=>{
    current.current=next;latest.current=next.draft;version.current=0;saved.current=0;
    try{sessionStorage.setItem(pointer,next.id);}catch{/* IndexedDB still owns the draft. */}
    if(mounted.current){setRecord(next);setStatus(copy.sessions.savedLocal);setError('');setOpen(false);setRenaming('');setDeleting('');setQuery('');setBusy(false);}
  },[pointer,copy.sessions.savedLocal]);
  const persist=useCallback(async()=>{
    clearTimeout(timer.current);const id=current.current?.id,draft=latest.current,v=version.current;
    if(!id||!draft)return;
    const work=queue.current.catch(()=>{}).then(async()=>{
      if(current.current?.id!==id||saved.current>=v)return;
      if(mounted.current)setStatus(copy.sessions.saving);
      const next=await writeSession({...current.current,draft});
      current.current=next;saved.current=v;
      if(mounted.current){setRecord(next);setStatus(version.current===v?copy.sessions.savedLocal:copy.sessions.waiting);setError('');}
    });
    queue.current=work;
    try{await work;}catch(e){if(mounted.current){setStatus(copy.sessions.notSaved);setError(e instanceof Error?e.message:copy.sessions.saveFailed);}throw e;}
  },[copy.sessions.savedLocal,copy.sessions.saving,copy.sessions.waiting,copy.sessions.notSaved,copy.sessions.saveFailed]);
  const change=useCallback((draft:SessionDraft)=>{
    const old=latest.current;
    if(old&&(Object.keys(draft) as (keyof SessionDraft)[]).every(key=>{const a=draft[key],b=old[key];return a===b||(Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>v===b[i]));}))return;
    latest.current=draft;version.current++;setStatus(copy.sessions.waiting);clearTimeout(timer.current);
    timer.current=setTimeout(()=>void persist().catch(()=>{}),300);
  },[persist,copy.sessions.waiting]);
  // A send intent must be durable before the provider request starts, so this
  // path bypasses the debounce and awaits the IndexedDB transaction.
  const updateIntent=useCallback(async(next:SendIntent|null):Promise<boolean>=>{
    if(!current.current)return false;
    const draft={...(latest.current ?? current.current.draft),intent:next};
    latest.current=draft;version.current++;
    try{await persist();return true;}catch{return false;}
  },[persist]);
  useEffect(()=>{
    mounted.current=true;
    async function initialize(){
      // Guarantee the account defaults are cached before the first new scene is
      // built, so a freshly registered account gets its avatars/mark.
      if(user)await ensurePreferences(user.id).catch(()=>null);
      if(user){
        let handoff:Partial<SessionDraft>|null=null;
        try{handoff=JSON.parse(sessionStorage.getItem('imstage.agent.login-handoff')||'null');}catch{}
        if(handoff){const next=await writeSession(newSession(owner,origin,recoverDraft(handoff,emptyDraft(params.get('project')||'',{locale:seedLocale}))));try{sessionStorage.removeItem('imstage.agent.login-handoff');}catch{}return next;}
      }
      if(launchNew){
        // Screenshot → template starter: the uploaded image and the explicit
        // reconstruct/preserve choice arrive before navigation. Nothing is sent
        // to a provider here; the visitor reviews the composer first.
        if(isTemplateScreenshotMode(templateFlow)){
          const seed=readTemplateScreenshot();
          if(seed){
            const draft=emptyDraft(params.get('project')||'',{locale:seedLocale});
            if(seed.mode==='preserve'){
              const reference=await referenceFromSource(seed.source, draft.scene.platform);
              // A decode failure must not silently create an empty scene: throw so
              // the seed stays stored and the visitor can retry the upload.
              if(!reference)throw new Error(copy.templates.screenshotDecodeFailed);
              draft.scene={...draft.scene,...reference};
              draft.prompt=copy.templates.flowPreservePrompt;
            }else{
              draft.attachments=[seed.source];
              draft.prompt=copy.templates.flowReconstructPrompt;
            }
            draft.scene.id=crypto.randomUUID();
            // Only clear the exact payload after the session is durably written.
            const created=await writeSession(newSession(owner,origin,withDefaults(draft)));
            clearTemplateScreenshot(seed);
            try{const [path,query='']=location.hash.slice(1).split('?');const p=new URLSearchParams(query);p.delete('new');p.delete('templateFlow');history.replaceState(null,'',`${location.pathname}${location.search}#${path}${p.toString()?`?${p.toString()}`:''}`);}catch{/* The session exists; the URL hint is only a convenience. */}
            return created;
          }
        }
        const fallback=emptyDraft(params.get('project')||'',{locale:seedLocale,scenario:seedScenario});
        // A handed-off scene was written to sessionStorage before navigation and
        // is validated here; invalid or missing payloads fall back to the seed.
        // An explicit Send/Create payload also carries a one-shot send intent.
        const handoff=readHandoffPayload(handoffToken);
        const draft=handoff?recoverDraft({scene:handoff.scene,prompt:handoff.prompt,intent:handoff.intent} as Partial<SessionDraft>,fallback):fallback;
        draft.scene.id=crypto.randomUUID();
        // An authored handoff scene keeps its explicit values; only the blank
        // fallback seed receives account defaults.
        const created=await writeSession(newSession(owner,origin,handoff?draft:withDefaults(draft)));
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
      // A migrated legacy local draft is an existing scene: it must keep its own
      // avatars/watermark (including empty/off). Defaults apply only when this is
      // a genuinely new fallback scene.
      const migrated=recoverDraft(legacy,fallback);
      // Only a genuinely blank new scene receives defaults; migrated drafts and
      // authored sample scenes keep their own avatars/watermark.
      const created=await writeSession(newSession(owner,origin,(legacy||sample)?migrated:withDefaults(migrated),sample?'去年借款，今天归还':undefined));
      // Remove only after durable migration, never before a successful transaction.
      try{sessionStorage.removeItem(key);sessionStorage.removeItem(`${key}.chat`);if(user)sessionStorage.removeItem('imstage.agent.login-handoff');}catch{}
      return created;
    }
    boot.current??=initialize();let cancelled=false;
    void boot.current.then(next=>{if(!cancelled){adopt(next);void refresh();}}).catch(e=>{if(!cancelled)setError(e instanceof Error?e.message:copy.sessions.openFailed);});
    return()=>{cancelled=true;mounted.current=false;clearTimeout(timer.current);void persist().catch(()=>{});};
  },[retry]); // The App keys this workspace by account and entry point.
  useEffect(()=>setNavigationGuard(()=>{
    if(version.current>saved.current){const destination=location.hash;void persist().then(()=>{location.hash=destination;}).catch(()=>{});return false;}
    return true;
  }),[busy,persist]);
  useEffect(()=>{
    // The IndexedDB draft is the durable local copy. Flush a pending debounce on
    // unload, but never block the visitor when that copy can be written.
    const unload=(e:BeforeUnloadEvent)=>{if(error){e.preventDefault();e.returnValue='';return;}void persist().catch(()=>{});};
    const hide=()=>{if(document.visibilityState==='hidden')void persist().catch(()=>{});};
    window.addEventListener('beforeunload',unload);document.addEventListener('visibilitychange',hide);
    return()=>{window.removeEventListener('beforeunload',unload);document.removeEventListener('visibilitychange',hide);};
  },[persist,error]);
  useEffect(()=>{
    if(!open)return;
    const dismiss=(event:PointerEvent)=>{if(!panel.current?.contains(event.target as Node))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);toggle.current?.focus();}};
    document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);};
  },[open]);
  async function action(task:()=>Promise<void>){
    if(busy||operation.current)return;operation.current=true;setSwitching(true);setError('');
    try{await task();await refresh();}catch(e){setError(e instanceof Error?e.message:copy.sessions.actionFailed);}finally{operation.current=false;setSwitching(false);}
  }
  const create=(dup=false)=>action(async()=>{
    // Explicit recovery copy preserves local edits even after a stale-tab conflict.
    if(!dup)await persist();else{clearTimeout(timer.current);await queue.current.catch(()=>{});}
    const draft=dup&&latest.current?structuredClone(latest.current):emptyDraft(latest.current?.projectId,{locale:seedLocale});
    draft.scene.id=crypto.randomUUID();
    const next=await writeSession(newSession(owner,origin,dup?draft:withDefaults(draft),dup?`${current.current?.title||''} · ${copy.sessions.duplicateSuffix}`:undefined));adopt(next);
  });
  async function switchTo(id:string){await action(async()=>{await persist();if(current.current?.id!==id)adopt(await readSession(owner,id));else setOpen(false);});}
  async function rename(id:string){await action(async()=>{if(!name.trim())return;await persist();const existing=await readSession(owner,id);const next=await writeSession({...existing,title:name.trim().slice(0,60),named:true});if(current.current?.id===id){current.current=next;setRecord(next);}setRenaming('');});}
  async function remove(id:string){await action(async()=>{
    await persist();const existing=await readSession(owner,id);await removeSession(existing);
    if(current.current?.id===id){const rest=await listSessions(owner);const next=rest[0]?await readSession(owner,rest[0].id):await writeSession(newSession(owner,origin,withDefaults(emptyDraft('',{locale:seedLocale}))));adopt(next);}
    setDeleting('');
  });}
  if(!record)return <div className="page-loading" role="status">{error||copy.sessions.restoring}{error&&<button onClick={()=>{boot.current=null;setError('');setRetry(n=>n+1);}}>{copy.sessions.retryRead}</button>}</div>;
  const sessionTitle = (item: SessionRecord | SessionMeta) => !item.named && (!item.preview || item.preview === '还没有开始创作') && item.title === '新的会话' ? copy.sessions.newSession : item.title;
  const locked=busy||switching;const filtered=items.filter(s=>`${s.title} ${s.preview}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const controls=<div className="session-toolbar" ref={panel}>
    <div className="session-current"><button ref={toggle} className="session-toggle" aria-label={copy.sessions.manage} aria-expanded={open} aria-controls="creation-sessions" onClick={()=>{setOpen(!open);if(!open)void refresh().catch(e=>setError(e.message));}}><IconMessageCircle size={17}/><span><strong>{sessionTitle(record)}</strong><small>{busy?copy.sessions.busySwitch:status}</small></span><IconChevronDown size={15}/></button><button className="session-new" aria-label={copy.sessions.newSession} title={copy.sessions.newSessionHint} disabled={locked} onClick={()=>void create()}><IconPlus size={19}/></button></div>
    {error&&<div className="session-error" role="alert"><p>{error}</p><button disabled={locked} onClick={()=>void action(persist)}>{copy.sessions.retrySave}</button><button disabled={locked} onClick={()=>void create(true)}>{copy.sessions.saveAsNew}</button></div>}
    {open&&<section id="creation-sessions" className="session-list-panel" aria-label={copy.sessions.listLabel}><header><strong>{copy.sessions.listTitle} <span>{items.length}</span></strong><button aria-label={copy.sessions.closeList} onClick={()=>{setOpen(false);toggle.current?.focus();}}><IconX size={18}/></button></header><label className="session-search"><IconSearch size={16}/><input autoFocus aria-label={copy.sessions.searchLabel} placeholder={copy.sessions.searchPlaceholder} value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="session-list">{filtered.length===0?<p className="session-no-results">{copy.sessions.noResults}</p>:filtered.map(item=><article key={item.id} className={`session-item${item.id===record.id?' is-active':''}`}>
      {renaming===item.id?<form onSubmit={e=>{e.preventDefault();void rename(item.id);}}><input autoFocus aria-label={copy.sessions.nameLabel} maxLength={60} value={name} onChange={e=>setName(e.target.value)}/><button disabled={locked||!name.trim()} type="submit">{copy.sessions.saveName}</button><button type="button" onClick={()=>setRenaming('')}>{copy.common.cancel}</button></form>:<><button className="session-select" disabled={locked} aria-label={copy.sessions.openSession(sessionTitle(item))} aria-current={item.id===record.id?'true':undefined} onClick={()=>void switchTo(item.id)}><strong>{sessionTitle(item)}</strong><span>{item.preview === '还没有开始创作' ? '' : item.preview}</span><small>{item.id===record.id?copy.sessions.current:''}{new Intl.DateTimeFormat(formatLocale,{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(item.updatedAt)} · {copy.sessions.messages(item.count)}</small></button><div className="session-item-actions"><button aria-label={copy.sessions.rename(sessionTitle(item))} title={copy.sessions.renameTitle} disabled={locked} onClick={()=>{setRenaming(item.id);setName(item.title);}}><IconPencil size={15}/></button>{item.id===record.id&&<button aria-label={copy.sessions.duplicate} title={copy.sessions.duplicate} disabled={locked} onClick={()=>void create(true)}><IconCopy size={15}/></button>}<button aria-label={copy.sessions.deleteLabel(sessionTitle(item))} title={copy.sessions.deleteTitle} disabled={locked} onClick={()=>setDeleting(item.id)}><IconTrash size={15}/></button></div></>}
      {deleting===item.id&&<div className="session-delete-confirm"><p>{copy.sessions.deleteConfirm(item.title)}</p><button disabled={locked} onClick={()=>void remove(item.id)}>{copy.sessions.confirmDelete}</button><button onClick={()=>setDeleting('')}>{copy.sessions.keep}</button></div>}
    </article>)}</div><footer>{copy.sessions.footer}</footer></section>}
  </div>;
  return <AgentStudio {...props} key={record.id} creationSessionId={record.id} initialDraft={record.draft} onDraftChange={change} onIntentChange={updateIntent} pendingIntent={record.draft.intent ?? null} sessionControls={controls} disabled={switching} onBusyChange={setBusy}/>;
}

import { useEffect,useRef,useState } from 'react';
import { IconPlus, IconSparkles, IconTrash, IconUpload, IconUser, IconX } from '@tabler/icons-react';
import { errorText } from '../account/api';
import { runAgent } from '../agent/client';
import { createScene,type Scene } from '../studio/model';
import { readImageFile } from '../studio/storage';
import { useCopy } from '../i18n';
import { retainContacts,useContact,type Contact,type ContactLibrary } from './model';
import type { useContactLibrary } from './useContactLibrary';

type Props={userId:string;scene:Scene;store:ReturnType<typeof useContactLibrary>;locked:boolean;onChange:(s:Scene)=>void;onBusy:(b:boolean)=>void};

/** Downscale any accepted image to a bounded avatar data URL. */
async function prepareAvatar(file:File):Promise<string> {
  const result=await readImageFile(file);
  if(!result.ok)throw new Error(result.error);
  const image=new Image();image.src=result.dataUrl;await image.decode();
  const canvas=document.createElement('canvas');
  const ratio=Math.min(1,512/Math.max(image.width,image.height));
  canvas.width=Math.round(image.width*ratio);canvas.height=Math.round(image.height*ratio);
  canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/png');
}

export default function ContactPanel({userId,scene,store,locked,onChange,onBusy}:Props) {
  const copy=useCopy();
  const [portrait,setPortrait]=useState('');
  const [target,setTarget]=useState(scene.selfId);
  const [portraitFor,setPortraitFor]=useState('');
  const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [generating,setGenerating]=useState(false);
  const [focusId,setFocusId]=useState('');
  const upload=useRef<HTMLInputElement>(null);const uploadFor=useRef('');
  const abort=useRef<AbortController|null>(null);
  useEffect(()=>()=>abort.current?.abort(),[]);
  useEffect(()=>{if(!scene.participants.some(p=>p.id===target))setTarget(scene.selfId);},[scene.participants,scene.selfId,target]);
  const blocked=locked||store.loading||generating;
  const library=store.library;

  function edit(transform:(library:ContactLibrary)=>ContactLibrary) {
    setError('');setNotice('');
    try{store.edit(transform);}catch(e){setError(errorText(e));}
  }
  async function pickAvatar(id:string,file:File) {
    onBusy(true);setError('');
    try {
      const avatar=await prepareAvatar(file);
      edit(l=>({...l,contacts:l.contacts.map(c=>c.id===id?{...c,avatar}:c)}));
      setNotice(copy.people.localPending);
    } catch(e){setError(errorText(e));}
    finally{onBusy(false);}
  }
  async function generatePortrait(id:string) {
    const description=portrait.trim();
    if(!description){setError(copy.people.describePortrait);return;}
    const ac=new AbortController();abort.current=ac;setGenerating(true);onBusy(true);setError('');setNotice('');
    const timeout=setTimeout(()=>ac.abort(),125000);
    try {
      const contact=library?.contacts.find(c=>c.id===id);
      const source={...createScene(),id:crypto.randomUUID(),selfId:'portrait',participants:[{id:'portrait',name:contact?.name?.trim()||copy.people.avatar}],messages:[]};
      let avatar:string|undefined;let complete=false;
      for await(const event of runAgent({scene:source,targetId:'@participant:portrait',prompt:`请调用 generate_image 生成此人物的头像：${description}。只更新头像，不更改姓名。`,attachments:[],history:[]},userId,ac.signal)) {
        if(event.type==='scene')avatar=event.scene.participants.find(p=>p.id==='portrait')?.avatar;
        if(event.type==='done')complete=true;
      }
      if(!complete||!avatar)throw new Error(copy.people.portraitFailed);
      const response=await fetch(avatar);
      const dataUrl=await prepareAvatar(new File([await response.blob()],'avatar.png',{type:'image/png'}));
      edit(l=>({...l,contacts:l.contacts.map(c=>c.id===id?{...c,avatar:dataUrl,subtitle:c.subtitle}:c)}));
      setNotice(copy.people.portraitGenerated);
    }catch(e){setError(ac.signal.aborted?copy.people.stopGenerating:errorText(e));}
    finally{clearTimeout(timeout);abort.current=null;setGenerating(false);onBusy(false);}
  }
  function addPerson() {
    const contact:Contact={id:crypto.randomUUID(),name:copy.people.newMemberHint,avatar:null};
    edit(l=>({...l,contacts:[...l.contacts,contact]}));
    setFocusId(contact.id);setNotice('');
  }
  const statusText = store.cacheError ? copy.people.cacheFailed : store.source==='memory' ? copy.people.caching : store.saving ? copy.people.syncing : store.source==='cache' ? copy.people.localPending : library ? copy.people.cloudSynced : '';
  return <div className="contact-panel">
    <p className="contact-help">{copy.people.help}</p>
    {store.cacheError&&<p role="alert" className="contact-error">{copy.people.cacheFailed}</p>}
    {store.loading&&<p role="status">{copy.people.reading}</p>}
    {store.loadError&&<div role="alert" className="contact-error">{copy.people.loadFailed}：{store.loadError}<button className="agent-button" disabled={store.saving} onClick={store.reload}>{copy.people.reload}</button></div>}
    {store.error&&!store.conflict&&<div role="alert" className="contact-error">{store.error}<button className="agent-button" disabled={store.saving} onClick={store.retry}>{copy.people.retrySave}</button></div>}
    {store.conflict&&<div role="alert" className="contact-error">{copy.people.conflict} · {copy.people.conflictNotice}<button className="agent-button" disabled={store.saving} onClick={store.retry}>{copy.people.retrySave}</button><button className="agent-button" onClick={()=>void store.resolveWithCloud()}>{copy.people.useCloudVersion}</button></div>}
    {store.validation&&<p className="contact-validation" role="status">{copy.people.nameInvalid}</p>}
    {library&&<>
      <div className="contact-status-row"><label className="contact-check"><input type="checkbox" checked={library.autoSave} disabled={blocked} onChange={e=>edit(l=>({...l,autoSave:e.target.checked}))}/>{copy.people.autoSave}</label><span className="contact-sync" role="status" data-source={store.source}>{statusText}</span></div>
      <label>{copy.people.applyTo}<select value={target} disabled={blocked||!!scene.reference} onChange={e=>setTarget(e.target.value)}>{scene.participants.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===scene.selfId?copy.people.selfSuffix:''}</option>)}</select></label>
      <div className="contact-list">{library.contacts.map(c=><article key={c.id} className="contact-row">
        <button type="button" className="contact-avatar-button" disabled={blocked} aria-label={`${copy.people.upload}：${c.name}`} onClick={()=>{uploadFor.current=c.id;upload.current?.click();}}>{c.avatar?<img src={c.avatar} alt={copy.people.avatarAlt(c.name)}/>:<span className="contact-monogram">{c.name.slice(0,1)||copy.people.noAvatar}</span>}<span className="contact-avatar-edit"><IconUpload size={13}/></span></button>
        <div className="contact-inline">
          <input className="contact-name-input" maxLength={100} value={c.name} disabled={blocked} aria-label={`${copy.people.name}：${c.name}`} placeholder={copy.people.name} onChange={e=>{const name=e.target.value;edit(l=>({...l,contacts:l.contacts.map(x=>x.id===c.id?{...x,name}:x)}));}} autoFocus={focusId===c.id}/>
          <small>{library.selfContactId===c.id?copy.people.defaultPerson:copy.people.savedPerson} · {statusText}</small>
          <div className="contact-actions">
            <button disabled={blocked||!!scene.reference} onClick={()=>{onChange(useContact(scene,target,c));setNotice(copy.people.applied(c.name));}}>{copy.people.use}</button>
            <button disabled={blocked} onClick={()=>edit(l=>({...l,selfContactId:library.selfContactId!==c.id?c.id:null}))}>{library.selfContactId===c.id?copy.people.clearDefault:copy.people.defaultPerson}</button>
            <button disabled={blocked} aria-label={`${copy.people.generateAvatar}：${c.name}`} onClick={()=>setPortraitFor(portraitFor===c.id?'':c.id)}><IconSparkles size={14}/></button>
            <button disabled={blocked} aria-label={`${copy.people.remove}：${c.name}`} onClick={()=>edit(l=>({...l,contacts:l.contacts.filter(p=>p.id!==c.id),selfContactId:l.selfContactId===c.id?null:l.selfContactId}))}><IconTrash size={14}/></button>
          </div>
        </div>
      </article>)}</div>
      {!library.contacts.length&&<p className="contact-help">{copy.people.empty}</p>}
      <div className="contact-row-actions"><button className="agent-button" disabled={blocked||library.contacts.length>=100} onClick={addPerson}><IconPlus size={15}/>{copy.people.addPerson}</button><button className="agent-button" disabled={blocked||!!scene.reference} onClick={()=>void store.capture(scene.participants)}><IconUser size={15}/>{copy.people.saveCurrent}</button></div>
      {portraitFor&&library.contacts.some(c=>c.id===portraitFor)&&<div className="contact-portrait">
        <div className="contact-portrait-head"><strong>{copy.people.generateAvatar}</strong><button className="icon-btn" aria-label={copy.common.close} onClick={()=>setPortraitFor('')}><IconX size={16}/></button></div>
        <label>{copy.people.describePortrait}<textarea aria-label={copy.people.describePortrait} rows={2} maxLength={1200} value={portrait} onChange={e=>setPortrait(e.target.value)} disabled={generating}/></label>
        {library.contacts.find(c=>c.id===portraitFor)?.avatar&&<img className="contact-portrait-preview" src={library.contacts.find(c=>c.id===portraitFor)!.avatar!} alt={copy.people.pendingAlt}/>}
        {generating?<button className="agent-button" onClick={()=>abort.current?.abort()}>{copy.people.stopGenerating}</button>:<button className="agent-button agent-primary" disabled={!portrait.trim()} onClick={()=>void generatePortrait(portraitFor)}>{copy.people.generateAvatar}</button>}
      </div>}
    </>}
    <input hidden ref={upload} type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const file=e.target.files?.[0];if(file&&uploadFor.current)void pickAvatar(uploadFor.current,file);e.target.value='';}}/>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </div>;
}

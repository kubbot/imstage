import { useEffect,useRef,useState } from 'react';
import { errorText } from '../account/api';
import { runAgent } from '../agent/client';
import { createScene,type Scene } from '../studio/model';
import { readImageFile } from '../studio/storage';
import { retainContacts,useContact,type Contact } from './model';
import type { useContactLibrary } from './useContactLibrary';

type Props={userId:string;scene:Scene;store:ReturnType<typeof useContactLibrary>;locked:boolean;onChange:(s:Scene)=>void;onBusy:(b:boolean)=>void};
export default function ContactPanel({userId,scene,store,locked,onChange,onBusy}:Props) {
  const [draft,setDraft]=useState<Contact>({id:crypto.randomUUID(),name:'我',avatar:null});
  const [portrait,setPortrait]=useState('自然光下的真实摄影头像，简洁背景，轻松的微笑');
  const [target,setTarget]=useState(scene.selfId);
  const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [generating,setGenerating]=useState(false);const [makeDefault,setMakeDefault]=useState(true);
  const upload=useRef<HTMLInputElement>(null);const abort=useRef<AbortController|null>(null);
  useEffect(()=>()=>abort.current?.abort(),[]);
  useEffect(()=>{if(!scene.participants.some(p=>p.id===target))setTarget(scene.selfId);},[scene.participants,scene.selfId,target]);
  const blocked=locked||store.loading||store.saving||generating;
  const library=store.library;
  async function action(fn:()=>Promise<unknown>,message:string) {setError('');setNotice('');try{await fn();setNotice(message);}catch(e){setError(errorText(e));}}
  async function imageFile(file:File) {
    onBusy(true);setError('');try{const result=await readImageFile(file);if(!result.ok)throw new Error(result.error);const image=new Image();image.src=result.dataUrl;await image.decode();const canvas=document.createElement('canvas');const ratio=Math.min(1,512/Math.max(image.width,image.height));canvas.width=Math.round(image.width*ratio);canvas.height=Math.round(image.height*ratio);canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);setDraft(d=>({...d,avatar:canvas.toDataURL('image/png')}));}catch(e){setError(errorText(e));}finally{onBusy(false);}
  }
  async function generatePortrait() {
    const ac=new AbortController();abort.current=ac;setGenerating(true);onBusy(true);setError('');setNotice('');
    const timeout=setTimeout(()=>ac.abort(),125000);
    try {
      const source={...createScene(),id:crypto.randomUUID(),selfId:'portrait',participants:[{id:'portrait',name:draft.name.trim()||'我'}],messages:[]};
      let avatar:string|undefined;let complete=false;
      for await(const event of runAgent({scene:source,targetId:'@participant:portrait',prompt:`请调用 generate_image 生成此人物的头像：${portrait}。只更新头像，不更改姓名。`,attachments:[],history:[]},userId,ac.signal)) {
        if(event.type==='scene')avatar=event.scene.participants.find(p=>p.id==='portrait')?.avatar;
        if(event.type==='done')complete=true;
      }
      if(!complete||!avatar)throw new Error('未收到生成的头像，请重试。');
      const response=await fetch(avatar);await imageFile(new File([await response.blob()],'avatar.png',{type:'image/png'}));
      setNotice('头像已生成。保存后可在之后的对话中复用。');
    }catch(e){setError(ac.signal.aborted?'头像生成已停止。':errorText(e));}
    finally{clearTimeout(timeout);abort.current=null;setGenerating(false);onBusy(false);}
  }
  return <div className="contact-panel">
    <p className="contact-help">保存人物与头像，在每次创作时复用。应用到画面的是独立副本。</p>
    {store.loading&&<p role="status">正在读取人物库…</p>}
    {store.error&&<div role="alert">{store.error}<button className="agent-button" disabled={store.saving} onClick={store.reload}>重新读取</button></div>}
    {library&&<>
      <label className="contact-check"><input type="checkbox" checked={library.autoSave} disabled={blocked} onChange={e=>void action(()=>store.save(l=>({...l,autoSave:e.target.checked})),'自动保存设置已更新。')}/>生成成功后保存人物与头像</label>
      <label>应用到画面中的谁<select value={target} disabled={blocked||!!scene.reference} onChange={e=>setTarget(e.target.value)}>{scene.participants.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===scene.selfId?'（我）':''}</option>)}</select></label>
      <div className="contact-list">{library.contacts.map(c=><article key={c.id} className="contact-row">{c.avatar?<img src={c.avatar} alt={`${c.name}的头像`}/>:<span className="contact-monogram">{c.name.slice(0,1)}</span>}<div><strong>{c.name}</strong><small>{library.selfContactId===c.id?'我的默认人物':c.subtitle||'已保存人物'}</small><div className="contact-actions"><button disabled={blocked||!!scene.reference} onClick={()=>{onChange(useContact(scene,target,c));setNotice(`已应用 ${c.name}，姓名和头像一起更新。`);}}>使用</button><button disabled={blocked} onClick={()=>{setDraft({...c});setMakeDefault(library.selfContactId===c.id);}}>编辑</button><button disabled={blocked} onClick={()=>void action(()=>store.save(l=>({...l,contacts:l.contacts.filter(p=>p.id!==c.id),selfContactId:l.selfContactId===c.id?null:l.selfContactId})),'已从人物库移除，现有画面保持不变。')}>移除</button></div></div></article>)}</div>
      {!library.contacts.length&&<p className="contact-help">还没有保存的人物。先设置自己的头像，或生成一段聊天。</p>}
      <button className="agent-button" disabled={blocked||!!scene.reference} onClick={()=>void action(()=>store.save(l=>retainContacts(l,scene.participants)),'当前人物已保存。')}>保存当前对话中的人物</button>
      {library.selfContactId&&<button className="agent-button" disabled={blocked} onClick={()=>void action(()=>store.save(l=>({...l,selfContactId:null})),'已取消默认人物。')}>取消我的默认人物</button>}
    </>}
    <div className="contact-form"><h3>{library?.contacts.some(c=>c.id===draft.id)?'编辑人物':'创建人物'}</h3>
      <fieldset disabled={blocked}>
        <label>人物姓名<input maxLength={100} value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))}/></label>
        <label>备注<input maxLength={200} value={draft.subtitle||''} onChange={e=>setDraft(d=>({...d,subtitle:e.target.value}))}/></label>
        <div className="contact-avatar-preview">{draft.avatar?<img src={draft.avatar} alt="待保存的头像"/>:<span className="contact-monogram">{draft.name.slice(0,1)||'我'}</span>}<button className="agent-button" onClick={()=>upload.current?.click()}>上传头像</button><button className="agent-button" disabled={!draft.avatar} onClick={()=>setDraft(d=>({...d,avatar:null}))}>清除</button></div>
        <label>描述想生成的头像<textarea aria-label="描述想生成的头像" rows={3} maxLength={1200} value={portrait} onChange={e=>setPortrait(e.target.value)}/></label>
        <button className="agent-button" disabled={!portrait.trim()} onClick={()=>void generatePortrait()}>AI 生成头像</button>
        <label className="contact-check"><input type="checkbox" checked={makeDefault} onChange={e=>setMakeDefault(e.target.checked)}/>作为我的默认人物（新对话自动使用）</label>
        <button className="agent-button agent-primary" disabled={!library||!draft.name.trim()} onClick={()=>void action(()=>store.save(l=>({...l,contacts:[...l.contacts.filter(c=>c.id!==draft.id),{...draft,name:draft.name.trim()}],selfContactId:makeDefault?draft.id:l.selfContactId===draft.id?null:l.selfContactId})),'人物已保存。新对话会使用默认人物；当前画面可点击“使用”。')}>保存人物</button>
        <button className="agent-button" onClick={()=>{setDraft({id:crypto.randomUUID(),name:'新人物',avatar:null});setMakeDefault(false);setNotice('');}}>新建另一个人物</button>
      </fieldset>
      {generating&&<button className="agent-button" onClick={()=>abort.current?.abort()}>停止生成头像</button>}
      <input ref={upload} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{if(e.target.files?.[0])void imageFile(e.target.files[0]);e.target.value='';}}/>
    </div>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </div>;
}

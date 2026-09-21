import { useEffect,useRef,useState } from 'react';
import { api,errorText } from '../account/api';
import { retainContacts,type ContactLibrary } from './model';
import type { Participant } from '../studio/model';
export function useContactLibrary(userId?:string) {
  const [library,setLibrary]=useState<ContactLibrary|null>(null);
  const [loading,setLoading]=useState(Boolean(userId));
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  const identity=useRef(userId);identity.current=userId;
  const mounted=useRef(true);const mutation=useRef(false);const current=useRef(library);current.current=library;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    setLibrary(null);setError('');setLoading(Boolean(userId));
    if(!userId)return;
    const ac=new AbortController();
    api<ContactLibrary>('/contact-library',{signal:ac.signal}).then(v=>{if(!ac.signal.aborted){setLibrary(v);setLoading(false);}}).catch(e=>{if(!ac.signal.aborted){setError(errorText(e));setLoading(false);}});
    return()=>ac.abort();
  },[userId,retry]);
  async function save(transform:(library:ContactLibrary)=>ContactLibrary, fresh=false) {
    if(!userId || !current.current || mutation.current) throw new Error('联系人库尚未就绪，请稍后重试。');
    const owner=userId;mutation.current=true;setSaving(true);setError('');
    try {
      const base=fresh?await api<ContactLibrary>('/contact-library'):current.current;
      if(identity.current!==owner || !mounted.current) throw new Error('账户已切换');
      const next=transform(base);
      if(JSON.stringify(next)===JSON.stringify(base)){setLibrary(base);return base;}
      const result=await api<ContactLibrary>('/contact-library',{method:'PUT',body:next});
      if(identity.current===owner&&mounted.current){current.current=result;setLibrary(result);}
      return result;
    } catch(e) {
      if(identity.current===owner&&mounted.current)setError(errorText(e));
      throw e;
    } finally {mutation.current=false;if(identity.current===owner&&mounted.current)setSaving(false);}
  }
  async function capture(people:Participant[]) {
    // Re-read before appending, so another tab's saved default is never replaced.
    return save(base=>base.autoSave?retainContacts(base,people):base,true);
  }
  return {library,loading,saving,error,save,capture,reload:()=>setRetry(v=>v+1)};
}

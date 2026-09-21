import { calendarToday } from '../../../../packages/schema/timeline.mjs';
import { createScene, validateScene, type Scene } from '../studio/model';
import type { ChatEntry, ToolEvent } from './client';

export type Turn = ChatEntry & { id: string; tools?: ToolEvent[]; target?: string; failed?: boolean; attachments?: string[] };
export type SessionDraft = { scene: Scene; prompt: string; editPrompt: string; turns: Turn[]; attachments: string[]; selected: string; projectId: string; full: boolean; scopeSelected: boolean; viewportTop: number; generating: boolean };
export type SessionMeta = { owner: string; id: string; title: string; named: boolean; origin: string; updatedAt: number; createdAt: number; revision: number; preview: string; count: number };
export type SessionRecord = SessionMeta & { draft: SessionDraft };
const DB = 'imstage-creation-sessions';
export class SessionConflict extends Error { constructor() { super('这个会话已在其他标签页更新或删除。请将当前内容另存为新会话，避免覆盖。'); } }

export function emptyDraft(projectId = ''): SessionDraft {
  return { scene: { ...createScene(), id: crypto.randomUUID(), title:'新的对话', referenceDate:calendarToday(), surface:'ios', deviceProfileId:'iphone-17-pro', selfId:'me', participants:[{id:'me',name:'我'},{id:'other',name:'对方'}], messages:[] }, prompt:'', editPrompt:'', turns:[], attachments:[], selected:'', projectId, full:false, scopeSelected:false, viewportTop:0, generating:false };
}
export function recoverDraft(raw: Partial<SessionDraft> | null, fallback = emptyDraft()): SessionDraft {
  const scene = validateScene(raw?.scene);
  return { ...fallback, scene:scene.ok && scene.scene ? scene.scene : fallback.scene,
    prompt:typeof raw?.prompt==='string'?raw.prompt.slice(0,4000):'', editPrompt:typeof raw?.editPrompt==='string'?raw.editPrompt.slice(0,4000):'',
    turns:Array.isArray(raw?.turns)?raw.turns.filter(t=>['user','assistant'].includes(t.role)&&typeof t.id==='string'&&typeof t.content==='string').map((t,i)=>({...t,...(raw.generating&&i===raw.turns!.length-1&&t.role==='assistant'?{failed:true,content:'上次生成已中断，已保留收到的内容。可以继续输入需求。'}:{}),tools:t.tools?.map(tool=>tool.state==='running'?{...tool,state:'error',detail:'上次生成已中断'}:tool)})):[],
    attachments:Array.isArray(raw?.attachments)?raw.attachments.filter(a=>typeof a==='string'&&/^data:image\/(png|jpeg|webp);base64,/.test(a)&&a.length<6*1024*1024).slice(0,3):[],
    selected:typeof raw?.selected==='string'?raw.selected:'', projectId:typeof raw?.projectId==='string'?raw.projectId:fallback.projectId,
    full:typeof raw?.full==='boolean'?raw.full:fallback.full,scopeSelected:!!raw?.scopeSelected,generating:false,viewportTop:typeof raw?.viewportTop==='number'&&Number.isFinite(raw.viewportTop)?Math.max(0,raw.viewportTop):0 };
}
export function newSession(owner:string, origin:string, draft:SessionDraft, title?:string):SessionRecord {
  return {owner,id:crypto.randomUUID(),title:title||'新的会话',named:!!title,origin,updatedAt:Date.now(),createdAt:Date.now(),revision:0,preview:'',count:0,draft};
}
function metadata(record:SessionRecord):SessionMeta {
  const {draft,...meta}=record;
  const first=draft.turns.find(t=>t.role==='user')?.content || draft.prompt || (draft.scene.messages.length?draft.scene.title:'');
  return {...meta,title:meta.named?meta.title:first.trim().slice(0,32)||'新的会话',preview:(draft.turns.at(-1)?.content||draft.prompt||'还没有开始创作').slice(0,100),count:draft.scene.messages.length};
}
async function database():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB,1);
    request.onupgradeneeded=()=>{for(const name of ['meta','drafts']){const store=request.result.createObjectStore(name,{keyPath:['owner','id']});store.createIndex('owner','owner');}};
    request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('会话库被其他标签页占用，请关闭旧版页面后重试。'));
  });
}
export async function listSessions(owner:string):Promise<SessionMeta[]> {
  const db=await database();try{return await new Promise((resolve,reject)=>{const request=db.transaction('meta').objectStore('meta').index('owner').getAll(owner);request.onsuccess=()=>resolve(request.result.sort((a:SessionMeta,b:SessionMeta)=>b.updatedAt-a.updatedAt));request.onerror=()=>reject(request.error);});}finally{db.close();}
}
export async function readSession(owner:string,id:string):Promise<SessionRecord> {
  const db=await database();try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(['meta','drafts']);const meta=tx.objectStore('meta').get([owner,id]),draft=tx.objectStore('drafts').get([owner,id]);
    tx.oncomplete=()=>{if(!meta.result||!draft.result)reject(new Error('会话已被删除，请重新打开会话列表。'));else if(!validateScene(draft.result.draft?.scene).ok)reject(new Error('会话数据不完整，已保留原始数据，请重试读取。'));else resolve({...meta.result,draft:recoverDraft(draft.result.draft)});};tx.onerror=()=>reject(tx.error);
  });}finally{db.close();}
}
/** Compare-and-swap both stores atomically; stale tabs cannot overwrite or resurrect a session. */
export async function writeSession(record:SessionRecord):Promise<SessionRecord> {
  const db=await database();try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(['meta','drafts'],'readwrite');const store=tx.objectStore('meta');let conflict=false;let next:SessionRecord;
    const request=store.get([record.owner,record.id]);request.onsuccess=()=>{
      if((request.result?.revision??0)!==record.revision || (!request.result&&record.revision!==0)){conflict=true;tx.abort();return;}
      const meta=metadata({...record,updatedAt:Date.now(),revision:record.revision+1});next={...meta,draft:record.draft};
      store.put(meta);tx.objectStore('drafts').put({owner:record.owner,id:record.id,draft:record.draft});
    };
    tx.oncomplete=()=>resolve(next);tx.onabort=()=>reject(conflict?new SessionConflict():tx.error||new Error('会话未保存'));tx.onerror=()=>{};
  });}finally{db.close();}
}
export async function removeSession(record:SessionMeta):Promise<void> {
  const db=await database();try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction(['meta','drafts'],'readwrite');const store=tx.objectStore('meta');let conflict=false;
    const request=store.get([record.owner,record.id]);request.onsuccess=()=>{if(request.result?.revision!==record.revision){conflict=true;tx.abort();return;}store.delete([record.owner,record.id]);tx.objectStore('drafts').delete([record.owner,record.id]);};
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(conflict?new SessionConflict():tx.error);tx.onerror=()=>{};
  });}finally{db.close();}
}

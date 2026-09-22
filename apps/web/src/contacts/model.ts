import type { Participant, Scene } from '../studio/model';
export type Contact = { id:string; name:string; subtitle?:string; avatar?:string|null };
export type ContactLibrary = { revision:number; contacts:Contact[]; selfContactId:string|null; autoSave:boolean };
export function sameContact(a:Contact|Participant,b:Contact|Participant) {
  return a.name.trim()===b.name.trim() && (a.avatar||'')===(b.avatar||'') && (a.subtitle||'')===(b.subtitle||'');
}
/** Snapshots, not live links: deleting a library item never alters saved scenes. */
export function retainContacts(library:ContactLibrary, people:Participant[], id=()=>crypto.randomUUID()):ContactLibrary {
  const contacts=[...library.contacts];
  for(const p of people) {
    if(!p.name.trim() || contacts.some(c=>sameContact(c,p))) continue;
    if(contacts.length>=100) throw new Error('联系人库已满（100 位），请删除不用的人物后再保存。');
    if(p.name.trim().length>100 || (p.subtitle?.length||0)>200 || (p.avatar?.length||0)>2*1024*1024) throw new Error('人物资料或头像超过联系人库上限，请缩小头像或精简资料后保存。');
    contacts.push({id:id(),name:p.name.trim(),subtitle:p.subtitle||'',avatar:p.avatar||null});
  }
  return {...library,contacts};
}
export function useContact(scene:Scene, participantId:string, contact:Contact):Scene {
  return {...scene,participants:scene.participants.map(p=>p.id===participantId?{...p,name:contact.name,subtitle:contact.subtitle||'',avatar:contact.avatar||undefined}:p)};
}
/** A default fills a fresh creation only; opening existing work never overwrites it. */
export function applySelfDefault(scene:Scene,library:ContactLibrary|null):Scene {
  if(scene.reference || scene.messages.length) return scene;
  const self=scene.participants.find(p=>p.id===scene.selfId);
  if(self?.avatar || self?.name!=='我') return scene;
  const contact=library?.contacts.find(c=>c.id===library.selfContactId);
  return contact ? useContact(scene,scene.selfId,contact) : scene;
}

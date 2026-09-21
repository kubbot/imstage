import {applySelfDefault,retainContacts} from '../../apps/web/src/contacts/model.ts';
import {getContactLibrary,putContactLibrary} from './store.mjs';
import {normalizeContactLibraryInput} from './model.mjs';
import {validateContactAvatars} from './image.mjs';

/** Same identity lifecycle for interactive and batch Agent calls. */
export function withContactLibrary(runtime,{db,nowMs}) {
 return {...runtime,async run(input){
  if(!input.userId||input.scene.reference||input.targetId)return runtime.run(input);
  const library=getContactLibrary(db,input.userId);
  const starting=applySelfDefault(input.scene,library);
  const boundSelf=starting!==input.scene?starting.participants.find(p=>p.id===starting.selfId):null;
  const bind=scene=>boundSelf?{...scene,participants:scene.participants.map(p=>p.id===scene.selfId?{...boundSelf,id:p.id}:p)}:scene;
  let done=false;
  const result=await runtime.run({...input,scene:starting,onEvent:async event=>{
   if(event.type==='done'){done=true;return;}
   await input.onEvent(event.type==='scene'?{...event,scene:bind(event.scene)}:event);
  }});
  const final=result.scene?bind(result.scene):result.scene;
  if(result.ok&&done&&!input.signal?.aborted&&final&&!final.reference){
   try{
    // Decode first; re-read and append synchronously afterwards, so a concurrent
    // contact edit/default change is never overwritten by the Agent result.
    const proposed=normalizeContactLibraryInput(retainContacts(getContactLibrary(db,input.userId),final.participants));
    if(proposed.autoSave){
     await validateContactAvatars(proposed.contacts);
     if(input.signal?.aborted)throw new Error('aborted');
     const latest=getContactLibrary(db,input.userId);
     if(latest.autoSave){
      const merged=normalizeContactLibraryInput(retainContacts(latest,final.participants));
      const totalBytes=merged.contacts.reduce((sum,c)=>sum+(c.avatar?Buffer.from(c.avatar.split(',')[1],'base64').length:0),0);
      if(totalBytes>8*1024*1024)throw new Error('library full');
      if(merged.contacts.length!==latest.contacts.length)putContactLibrary(db,{...merged,userId:input.userId,nowMs:nowMs()});
     }
    }
   }catch{
    if(!input.signal?.aborted)await input.onEvent({type:'assistant',text:'画面已生成，但人物库保存未完成。请打开人物与头像，检查容量或重试保存。'});
   }
  }
  if(done&&!input.signal?.aborted)await input.onEvent({type:'done'});
  return {...result,scene:final};
 }};
}

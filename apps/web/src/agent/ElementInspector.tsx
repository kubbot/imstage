import {DEVICE_PROFILES} from '../studio/device-profiles';
import { useEffect, useRef, useState } from 'react';
import { MESSAGE_TYPES, MESSAGE_TYPE_LABELS, validateScene, type Message, type Scene } from '../studio/model';
import { readImageFile } from '../studio/storage';

type Props = { scene:Scene; selected:string; locked:boolean; onSelect:(id:string)=>void; onChange:(scene:Scene)=>void; onBusy:(busy:boolean)=>void };
export default function ElementInspector({scene,selected,locked,onSelect,onChange,onBusy}:Props) {
  const [error,setError]=useState(''); const file=useRef<HTMLInputElement>(null); const [slot,setSlot]=useState('');
  useEffect(()=>{setError('');setSlot('');},[selected]);
  const message=scene.messages.find(m=>m.id===selected);
  const person=scene.participants.find(p=>`@participant:${p.id}`===selected);
  function apply(next:Scene) { const result=validateScene(next); if(!result.ok || !result.scene) {setError(result.errors.join('；'));return;} setError('');onChange(result.scene); }
  function update(patch:Partial<Scene> | Partial<Message>) { apply(message ? {...scene,messages:scene.messages.map(m=>m.id===message.id?{...m,...patch}:m)} : person ? {...scene,participants:scene.participants.map(p=>p.id===person.id?{...p,...patch}:p)} : {...scene,...patch}); }
  function text(label:string,key:string,value:string,multiline=false) {return <label>{label}{multiline ? <textarea value={value} onChange={e=>update({[key]:e.target.value})} maxLength={4000}/> : <input value={value} onChange={e=>update({[key]:e.target.value})} maxLength={4000}/>}</label>;}
  async function upload(f:File) {onBusy(true);try {const result=await readImageFile(f);if(!result.ok){setError(result.error);return;} if(slot.startsWith('item:')&&message)update({items:message.items?.map(i=>i.id===slot.slice(5)?{...i,asset:result.dataUrl}:i)});else update({[slot]:result.dataUrl});} finally {onBusy(false);} }
  const style=message?.appearance || scene.appearance || {};
  return <details className="agent-manual agent-inspector" open><summary>元素与外观</summary><fieldset disabled={locked}>
    <label>选中元素<select aria-label="选中元素" value={selected || '@scene'} onChange={e=>onSelect(e.target.value)}><option value="@scene">背景、标题与界面</option>{scene.participants.map(p=><option key={p.id} value={`@participant:${p.id}`}>人物 · {p.name}</option>)}{scene.messages.map((m,i)=><option key={m.id} value={m.id}>{i+1} · {m.text.slice(0,24)||MESSAGE_TYPE_LABELS[m.type]}</option>)}</select></label>
    {person ? <>{text('姓名','name',person.name)}{text('资料说明','subtitle',person.subtitle||'')}<button type="button" className="agent-button" onClick={()=>{setSlot('avatar');file.current?.click();}}>上传头像</button></> : message ? <>
      {text('消息文字','text',message.text,true)}{text('说明 / 地址 / 时长','subtitle',message.subtitle||'')}{text('引用内容','quote',message.quote||'',true)}{text('消息时间','time',message.time)}
      <label>消息类型<select value={message.type} onChange={e=>update({type:e.target.value as Message['type']})}>{MESSAGE_TYPES.map(t=><option key={t} value={t}>{MESSAGE_TYPE_LABELS[t]}</option>)}</select></label>
      <label>发送者<select value={message.participantId} onChange={e=>update({participantId:e.target.value})}>{message.type==='system'&&<option value="">系统</option>}{scene.participants.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <div className="inspector-pair">{(['width','height'] as const).map(k=><label key={k}>{k==='width'?'宽度':'高度'}<input type="number" min={k==='width'?40:24} max={k==='width'?1200:1800} value={message[k]??''} placeholder="自动" onChange={e=>update({[k]:e.target.value?Number(e.target.value):undefined})}/></label>)}</div>
      <button type="button" className="agent-button" onClick={()=>{setSlot('asset');file.current?.click();}}>上传消息配图</button>
      {message.type==='album'&&<>{message.items?.map(i=><button key={i.id} type="button" className="agent-button" onClick={()=>{setSlot(`item:${i.id}`);file.current?.click();}}>替换 {i.caption||i.id}</button>)}<button className="agent-button" disabled={(message.items?.length||0)>=9} onClick={()=>update({items:[...(message.items||[]),{id:crypto.randomUUID(),kind:'image',caption:'新照片'}]})}>添加相册图片</button></>}
      <div className="inspector-pair"><button className="agent-button" disabled={scene.messages[0]?.id===message.id} onClick={()=>{const ms=[...scene.messages];const n=ms.findIndex(m=>m.id===message.id);[ms[n-1],ms[n]]=[ms[n],ms[n-1]];apply({...scene,messages:ms});}}>上移</button><button className="agent-button" onClick={()=>{apply({...scene,messages:scene.messages.filter(m=>m.id!==message.id)});onSelect('@scene');}}>删除消息</button></div>
    </> : <>
      {text('会话标题','headerText',scene.headerText??scene.title)}{text('设备时间','deviceTime',scene.deviceTime)}{text('日期文字','date',scene.date)}{text('输入栏提示','composerText',scene.composerText??'输入消息')}{text('水印','watermark',scene.watermark)}
      <label>截图设备<select value={scene.deviceProfileId||''} onChange={e=>{if(!e.target.value){update({deviceProfileId:undefined});return;}const p=DEVICE_PROFILES.find(p=>p.id===e.target.value);if(p)update({deviceProfileId:p.id,surface:p.surface});}}><option value="">通用尺寸（当前系统）</option>{DEVICE_PROFILES.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <label>电量<input type="number" min={0} max={100} value={scene.battery??60} onChange={e=>update({battery:Number(e.target.value)})}/></label>
      <label>聊天背景<input type="color" value={scene.background||'#ededed'} onChange={e=>update({background:e.target.value})}/></label>
      <div className="inspector-pair"><button className="agent-button" onClick={()=>{setSlot('backgroundImage');file.current?.click();}}>上传背景</button><button className="agent-button" disabled={!scene.backgroundImage} onClick={()=>update({backgroundImage:''})}>清除背景图</button></div>
      <button className="agent-button" onClick={()=>{const m:Message={id:crypto.randomUUID(),participantId:scene.selfId,type:'text',text:'新消息',time:scene.deviceTime};apply({...scene,messages:[...scene.messages,m]});onSelect(m.id);}}>添加消息</button>
      <button className="agent-button" disabled={scene.participants.length>=20} onClick={()=>{const p={id:crypto.randomUUID(),name:'新成员'};apply({...scene,participants:[...scene.participants,p]});onSelect(`@participant:${p.id}`);}}>添加成员</button>
    </>}
    {!person&&<><label>文字颜色<input type="color" value={style.color||'#222222'} onChange={e=>update({appearance:{...style,color:e.target.value}})}/></label><label>气泡颜色<input type="color" value={style.background||'#ffffff'} onChange={e=>update({appearance:{...style,background:e.target.value}})}/></label><div className="inspector-pair"><label>字号<input type="number" min={10} max={40} value={style.fontSize||15} onChange={e=>update({appearance:{...style,fontSize:Number(e.target.value)}})}/></label><label>圆角<input type="number" min={0} max={40} value={style.radius??8} onChange={e=>update({appearance:{...style,radius:Number(e.target.value)}})}/></label></div><button className="agent-button" onClick={()=>update({appearance:undefined})}>恢复平台默认外观</button></>}
    <input hidden ref={file} type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{if(e.target.files?.[0])void upload(e.target.files[0]);e.target.value='';}}/>
    </fieldset>{error&&<p role="alert">{error}</p>}</details>;
}

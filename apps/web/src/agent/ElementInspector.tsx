import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconArrowDown, IconArrowUp, IconCopy, IconPhoto, IconPlus, IconTrash } from '@tabler/icons-react';
import { DEVICE_PROFILES } from '../studio/device-profiles';
import { MESSAGE_TYPES, validateScene, type Message, type Scene } from '../studio/model';
import { readImageFile } from '../studio/storage';
import { useCopy } from '../i18n';

type Props = { scene: Scene; selected: string; locked: boolean; onSelect: (id: string) => void; onChange: (scene: Scene) => void; onBusy: (busy: boolean) => void };
function Section({ title, children, advanced = false }: { title: string; children: ReactNode; advanced?: boolean }) {
  return advanced ? <details className="property-section property-advanced"><summary>{title}</summary><div>{children}</div></details> : <section className="property-section"><h3>{title}</h3>{children}</section>;
}
export default function ElementInspector({ scene, selected, locked, onSelect, onChange, onBusy }: Props) {
  const copy = useCopy();
  const e = copy.elements;
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const slot = useRef('');
  useEffect(() => { setError(''); }, [selected]);
  const message = scene.messages.find(m => m.id === selected);
  const person = scene.participants.find(p => `@participant:${p.id}` === selected);
  const index = scene.messages.findIndex(m => m.id === selected);
  function apply(next: Scene) {
    const result = validateScene(next);
    if (!result.ok || !result.scene) { setError(result.errors.join('；')); return; }
    setError(''); onChange(result.scene);
  }
  function update(patch: Partial<Scene> | Partial<Message> | { name?: string; subtitle?: string; avatar?: string }) {
    apply(message ? { ...scene, messages: scene.messages.map(m => m.id === message.id ? { ...m, ...patch } : m) } : person ? { ...scene, participants: scene.participants.map(p => p.id === person.id ? { ...p, ...patch } : p) } : { ...scene, ...patch });
  }
  function text(label: string, key: string, value: string, multiline = false) {
    return <label>{label}{multiline ? <textarea aria-label={label} value={value} rows={3} onChange={e => update({ [key]: e.target.value })} maxLength={4000}/> : <input aria-label={label} value={value} onChange={e => update({ [key]: e.target.value })} maxLength={4000}/>}</label>;
  }
  function pick(key: string) { slot.current = key; file.current?.click(); }
  async function upload(f: File) {
    onBusy(true);
    try {
      const result = await readImageFile(f);
      if (!result.ok) { setError(result.error); return; }
      if (slot.current.startsWith('item:') && message) update({ items: message.items?.map(i => i.id === slot.current.slice(5) ? { ...i, asset: result.dataUrl } : i) });
      else update({ [slot.current]: result.dataUrl });
    } catch { setError(e.readFailed); }
    finally { onBusy(false); }
  }
  function addMessage() {
    const m: Message = { id: crypto.randomUUID(), participantId: scene.selfId, type: 'text', text: e.newMessage, time: scene.deviceTime, ...(scene.referenceDate ? {date:scene.referenceDate} : {}) };
    apply({ ...scene, messages: [...scene.messages, m] }); onSelect(m.id);
  }
  function move(delta: number) {
    const messages = [...scene.messages];
    [messages[index], messages[index + delta]] = [messages[index + delta], messages[index]];
    apply({ ...scene, messages });
  }
  const style = message?.appearance || (!message ? scene.appearance : undefined) || {};
  const media = message && ['image', 'video', 'album', 'contact', 'location', 'link'].includes(message.type);
  return <div className="agent-inspector property-inspector"><fieldset disabled={locked}>
    <label className="property-element-picker">{e.pickerLabel}<select aria-label={e.pickerLabel} value={selected || '@scene'} onChange={e => onSelect(e.target.value)}><option value="@scene">{e.sceneOption}</option>{scene.participants.map(p => <option key={p.id} value={`@participant:${p.id}`}>{e.personOption(p.name)}</option>)}{scene.messages.map((m, i) => <option key={m.id} value={m.id}>{e.messageOption(i + 1, m.text.slice(0, 24) || copy.messageTypes[m.type])}</option>)}</select></label>
    {person ? <>
      <Section title={e.personSection}><div className="property-avatar">{person.avatar ? <img src={person.avatar} alt={e.avatarAlt(person.name)}/> : <span>{person.name.slice(0, 1)}</span>}<div><button type="button" className="agent-button" onClick={() => pick('avatar')}><IconPhoto size={15}/>{e.changeAvatar}</button>{person.avatar && <button className="property-text-button" onClick={() => update({ avatar: undefined })}>{e.removeAvatar}</button>}</div></div>{text(e.name, 'name', person.name)}{scene.platform !== 'wechat' && <Section title={e.subtitle} advanced>{text(e.subtitle, 'subtitle', person.subtitle || '')}</Section>}<label>{e.messagePosition}<select value={scene.selfId === person.id ? 'self' : 'other'} onChange={e => { const selfId = e.target.value === 'self' ? person.id : scene.participants.find(p => p.id !== person.id)?.id; if (selfId) apply({ ...scene, selfId }); }}><option value="self">{e.selfSide}</option><option value="other" disabled={scene.participants.length < 2}>{e.otherSide}</option></select></label></Section>
    </> : message ? <>
      <Section title={e.messageSection}>{text(e.messageText, 'text', message.text, true)}<label>{e.sendDate}<input aria-label={e.sendDate} type="date" value={message.date || ''} onChange={e => update({date:e.target.value || undefined})}/></label><div className="inspector-pair"><label>{e.sender}<select value={message.participantId} onChange={e => update({ participantId: e.target.value })}>{message.type === 'system' && <option value="">{e.system}</option>}{scene.participants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{text(e.messageTime, 'time', message.time)}</div><label>{e.messageType}<select value={message.type} onChange={e => update({ type: e.target.value as Message['type'], participantId: e.target.value !== 'system' && !message.participantId ? scene.selfId : message.participantId })}>{MESSAGE_TYPES.map(t => <option key={t} value={t}>{copy.messageTypes[t]}</option>)}</select></label></Section>
      {media && <Section title={e.mediaSection}>{message.asset && <img className="property-media" src={message.asset} alt={e.currentMedia}/>}<button type="button" className="agent-button" onClick={() => pick('asset')}><IconPhoto size={15}/>{message.asset ? e.replaceMedia : e.uploadMedia}</button>{message.asset && <button className="property-text-button" onClick={() => update({ asset: undefined })}>{e.removeMedia}</button>}{message.type === 'album' && <>{message.items?.map((i, n) => <div key={i.id} className="property-album-item"><label>{e.albumCaption(n + 1)}<input aria-label={e.albumCaption(n + 1)} value={i.caption} onChange={e => update({items:message.items?.map(item => item.id===i.id ? {...item,caption:e.target.value} : item)})}/></label><div className="inspector-pair"><button type="button" className="agent-button" onClick={() => pick(`item:${i.id}`)}>{e.replaceImage}</button><button className="agent-button" onClick={()=>update({items:message.items?.filter(item=>item.id!==i.id)})}>{e.removeImage}</button></div></div>)}<button className="agent-button" disabled={(message.items?.length || 0) >= 9} onClick={() => update({ items: [...(message.items || []), { id: crypto.randomUUID(), kind: 'image', caption: e.newPhoto }] })}>{e.addAlbumImage}</button></>}</Section>}
      <Section title={e.quoteSection} advanced>{text(e.subtitleField, 'subtitle', message.subtitle || '')}{text(e.quoteField, 'quote', message.quote || '', true)}</Section>
    </> : <>
      <Section title={e.frameSection}>{text(e.headerText, 'headerText', scene.headerText ?? (scene.participants.length <= 2 ? scene.participants.find(p => p.id !== scene.selfId)?.name || scene.title : scene.title))}<div className="inspector-pair">{text(e.deviceTime, 'deviceTime', scene.deviceTime)}<label>{e.battery}<input type="number" min={0} max={100} value={scene.battery ?? 80} onChange={e => update({ battery: Number(e.target.value) })}/></label></div><label>{e.storyToday}<input aria-label={e.storyToday} type="date" value={scene.referenceDate || ''} onChange={e => update({referenceDate:e.target.value || undefined})}/></label>{scene.messages.some(m=>m.date) ? <p className="property-help">{e.dateHelp}</p> : text(e.dateText, 'date', scene.date)}{text(e.composerText, 'composerText', scene.composerText ?? '')}{text(e.watermark, 'watermark', scene.watermark)}</Section>
      <Section title={e.backgroundSection}><label className="property-color">{e.background}<input type="color" value={scene.background || '#ededed'} onChange={e => update({ background: e.target.value })}/></label><div className="inspector-pair"><button className="agent-button" onClick={() => pick('backgroundImage')}><IconPhoto size={15}/>{e.backgroundImage}</button><button className="agent-button" disabled={!scene.backgroundImage} onClick={() => update({ backgroundImage: '' })}>{e.clearImage}</button></div></Section>
      <Section title={e.deviceSection} advanced><label>{e.device}<select value={scene.deviceProfileId || ''} onChange={e => { const p = DEVICE_PROFILES.find(p => p.id === e.target.value); update(p ? { deviceProfileId: p.id, surface: p.surface } : { deviceProfileId: undefined }); }}><option value="">{e.genericDevice}</option>{DEVICE_PROFILES.map(p => <option key={p.id} value={p.id}>{copy.devices[p.id] || p.label}</option>)}</select></label></Section>
      <Section title={e.addSection}><div className="inspector-pair"><button className="agent-button" disabled={scene.messages.length >= 200} onClick={addMessage}><IconPlus size={15}/>{e.addMessage}</button><button className="agent-button" disabled={scene.participants.length >= 20} onClick={() => { const p = { id: crypto.randomUUID(), name: e.newMember }; apply({ ...scene, participants: [...scene.participants, p] }); onSelect(`@participant:${p.id}`); }}>{e.addMember}</button></div></Section>
    </>}
    {!person && <Section title={e.appearanceSection} advanced><div className="inspector-pair"><label>{e.textColor}<input type="color" value={style.color || '#222222'} onChange={e => update({ appearance: { ...style, color: e.target.value } })}/></label><label>{e.bubbleColor}<input type="color" value={style.background || '#ffffff'} onChange={e => update({ appearance: { ...style, background: e.target.value } })}/></label></div><div className="inspector-pair"><label>{e.fontSize}<input type="number" min={10} max={40} value={style.fontSize || 15} onChange={e => update({ appearance: { ...style, fontSize: Number(e.target.value) } })}/></label><label>{e.radius}<input type="number" min={0} max={40} value={style.radius ?? 8} onChange={e => update({ appearance: { ...style, radius: Number(e.target.value) } })}/></label></div>{!message && <label>{e.spacing}<input type="number" min={0} max={48} value={style.spacing ?? 8} onChange={e => update({appearance:{...style,spacing:Number(e.target.value)}})}/></label>}{message && <div className="inspector-pair">{(['width', 'height'] as const).map(k => <label key={k}>{k === 'width' ? e.width : e.height}<input type="number" min={k === 'width' ? 40 : 24} max={k === 'width' ? 1200 : 1800} value={message[k] ?? ''} placeholder={e.auto} onChange={e => update({ [k]: e.target.value ? Number(e.target.value) : undefined })}/></label>)}</div>}<button className="property-text-button" onClick={() => update({ appearance: undefined, ...(message ? { width: undefined, height: undefined } : {}) })}>{e.restoreAppearance}</button></Section>}
    {message && <Section title={e.arrangeSection}><div className="property-message-actions"><button className="agent-button" aria-label={e.moveUp} disabled={index === 0} onClick={() => move(-1)}><IconArrowUp size={15}/></button><button className="agent-button" aria-label={e.moveDown} disabled={index === scene.messages.length - 1} onClick={() => move(1)}><IconArrowDown size={15}/></button><button className="agent-button" disabled={scene.messages.length >= 200} onClick={() => { const copy = { ...message, id: crypto.randomUUID() }; const messages = [...scene.messages]; messages.splice(index + 1, 0, copy); apply({ ...scene, messages }); onSelect(copy.id); }}><IconCopy size={15}/>{e.duplicate}</button><button className="agent-button property-delete" aria-label={e.deleteMessage} onClick={() => { apply({ ...scene, messages: scene.messages.filter(m => m.id !== message.id) }); onSelect(scene.messages[index + 1]?.id || scene.messages[index - 1]?.id || '@scene'); }}><IconTrash size={15}/></button></div></Section>}
    <input hidden ref={file} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { if (e.target.files?.[0]) void upload(e.target.files[0]); e.target.value = ''; }}/>
  </fieldset>{error && <p role="alert">{error}</p>}</div>;
}

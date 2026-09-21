import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconArrowDown, IconArrowUp, IconCopy, IconPhoto, IconPlus, IconTrash } from '@tabler/icons-react';
import { DEVICE_PROFILES } from '../studio/device-profiles';
import { MESSAGE_TYPES, MESSAGE_TYPE_LABELS, validateScene, type Message, type Scene } from '../studio/model';
import { readImageFile } from '../studio/storage';

type Props = { scene: Scene; selected: string; locked: boolean; onSelect: (id: string) => void; onChange: (scene: Scene) => void; onBusy: (busy: boolean) => void };
function Section({ title, children, advanced = false }: { title: string; children: ReactNode; advanced?: boolean }) {
  return advanced ? <details className="property-section property-advanced"><summary>{title}</summary><div>{children}</div></details> : <section className="property-section"><h3>{title}</h3>{children}</section>;
}
export default function ElementInspector({ scene, selected, locked, onSelect, onChange, onBusy }: Props) {
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
    } catch { setError('图片读取失败，请重新选择。'); }
    finally { onBusy(false); }
  }
  function addMessage() {
    const m: Message = { id: crypto.randomUUID(), participantId: scene.selfId, type: 'text', text: '新消息', time: scene.deviceTime };
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
    <label className="property-element-picker">选中元素<select aria-label="选中元素" value={selected || '@scene'} onChange={e => onSelect(e.target.value)}><option value="@scene">背景、标题与界面</option>{scene.participants.map(p => <option key={p.id} value={`@participant:${p.id}`}>人物 · {p.name}</option>)}{scene.messages.map((m, i) => <option key={m.id} value={m.id}>{i + 1} · {m.text.slice(0, 24) || MESSAGE_TYPE_LABELS[m.type]}</option>)}</select></label>
    {person ? <>
      <Section title="人物资料"><div className="property-avatar">{person.avatar ? <img src={person.avatar} alt={`${person.name} 的头像预览`}/> : <span>{person.name.slice(0, 1)}</span>}<div><button type="button" className="agent-button" onClick={() => pick('avatar')}><IconPhoto size={15}/>更换头像</button>{person.avatar && <button className="property-text-button" onClick={() => update({ avatar: undefined })}>移除头像</button>}</div></div>{text('姓名', 'name', person.name)}{text('资料说明', 'subtitle', person.subtitle || '')}<label>消息位置<select value={scene.selfId === person.id ? 'self' : 'other'} onChange={e => { const selfId = e.target.value === 'self' ? person.id : scene.participants.find(p => p.id !== person.id)?.id; if (selfId) apply({ ...scene, selfId }); }}><option value="self">我 · 右侧</option><option value="other" disabled={scene.participants.length < 2}>对方 · 左侧</option></select></label></Section>
    </> : message ? <>
      <Section title="消息内容">{text('消息文字', 'text', message.text, true)}<div className="inspector-pair"><label>发送者<select value={message.participantId} onChange={e => update({ participantId: e.target.value })}>{message.type === 'system' && <option value="">系统</option>}{scene.participants.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>{text('消息时间', 'time', message.time)}</div><label>消息类型<select value={message.type} onChange={e => update({ type: e.target.value as Message['type'], participantId: e.target.value !== 'system' && !message.participantId ? scene.selfId : message.participantId })}>{MESSAGE_TYPES.map(t => <option key={t} value={t}>{MESSAGE_TYPE_LABELS[t]}</option>)}</select></label></Section>
      {media && <Section title="消息素材">{message.asset && <img className="property-media" src={message.asset} alt="当前消息素材"/>}<button type="button" className="agent-button" onClick={() => pick('asset')}><IconPhoto size={15}/>{message.asset ? '替换消息配图' : '上传消息配图'}</button>{message.asset && <button className="property-text-button" onClick={() => update({ asset: undefined })}>移除配图</button>}{message.type === 'album' && <>{message.items?.map((i, n) => <div key={i.id} className="property-album-item"><label>图片 {n + 1} 说明<input aria-label={`图片 ${n + 1} 说明`} value={i.caption} onChange={e => update({items:message.items?.map(item => item.id===i.id ? {...item,caption:e.target.value} : item)})}/></label><div className="inspector-pair"><button type="button" className="agent-button" onClick={() => pick(`item:${i.id}`)}>替换图片</button><button className="agent-button" onClick={()=>update({items:message.items?.filter(item=>item.id!==i.id)})}>移除图片</button></div></div>)}<button className="agent-button" disabled={(message.items?.length || 0) >= 9} onClick={() => update({ items: [...(message.items || []), { id: crypto.randomUUID(), kind: 'image', caption: '新照片' }] })}>添加相册图片</button></>}</Section>}
      <Section title="引用与补充" advanced>{text('说明 / 地址 / 时长', 'subtitle', message.subtitle || '')}{text('引用内容', 'quote', message.quote || '', true)}</Section>
    </> : <>
      <Section title="对话界面">{text('会话标题', 'headerText', scene.headerText ?? (scene.participants.length <= 2 ? scene.participants.find(p => p.id !== scene.selfId)?.name || scene.title : scene.title))}<div className="inspector-pair">{text('设备时间', 'deviceTime', scene.deviceTime)}<label>电量 %<input type="number" min={0} max={100} value={scene.battery ?? 80} onChange={e => update({ battery: Number(e.target.value) })}/></label></div>{text('日期文字', 'date', scene.date)}{text('输入栏提示', 'composerText', scene.composerText ?? '')}{text('水印', 'watermark', scene.watermark)}</Section>
      <Section title="聊天背景"><label className="property-color">背景颜色<input type="color" value={scene.background || '#ededed'} onChange={e => update({ background: e.target.value })}/></label><div className="inspector-pair"><button className="agent-button" onClick={() => pick('backgroundImage')}><IconPhoto size={15}/>背景图片</button><button className="agent-button" disabled={!scene.backgroundImage} onClick={() => update({ backgroundImage: '' })}>清除图片</button></div></Section>
      <Section title="设备与尺寸" advanced><label>截图设备<select value={scene.deviceProfileId || ''} onChange={e => { const p = DEVICE_PROFILES.find(p => p.id === e.target.value); update(p ? { deviceProfileId: p.id, surface: p.surface } : { deviceProfileId: undefined }); }}><option value="">通用尺寸（当前系统）</option>{DEVICE_PROFILES.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label></Section>
      <Section title="添加元素"><div className="inspector-pair"><button className="agent-button" disabled={scene.messages.length >= 200} onClick={addMessage}><IconPlus size={15}/>添加消息</button><button className="agent-button" disabled={scene.participants.length >= 20} onClick={() => { const p = { id: crypto.randomUUID(), name: '新成员' }; apply({ ...scene, participants: [...scene.participants, p] }); onSelect(`@participant:${p.id}`); }}>添加成员</button></div></Section>
    </>}
    {!person && <Section title="外观与排版" advanced><div className="inspector-pair"><label>文字颜色<input type="color" value={style.color || '#222222'} onChange={e => update({ appearance: { ...style, color: e.target.value } })}/></label><label>气泡颜色<input type="color" value={style.background || '#ffffff'} onChange={e => update({ appearance: { ...style, background: e.target.value } })}/></label></div><div className="inspector-pair"><label>字号<input type="number" min={10} max={40} value={style.fontSize || 15} onChange={e => update({ appearance: { ...style, fontSize: Number(e.target.value) } })}/></label><label>圆角<input type="number" min={0} max={40} value={style.radius ?? 8} onChange={e => update({ appearance: { ...style, radius: Number(e.target.value) } })}/></label></div>{!message && <label>消息间距<input type="number" min={0} max={48} value={style.spacing ?? 8} onChange={e => update({appearance:{...style,spacing:Number(e.target.value)}})}/></label>}{message && <div className="inspector-pair">{(['width', 'height'] as const).map(k => <label key={k}>{k === 'width' ? '宽度' : '高度'}<input type="number" min={k === 'width' ? 40 : 24} max={k === 'width' ? 1200 : 1800} value={message[k] ?? ''} placeholder="自动" onChange={e => update({ [k]: e.target.value ? Number(e.target.value) : undefined })}/></label>)}</div>}<button className="property-text-button" onClick={() => update({ appearance: undefined, ...(message ? { width: undefined, height: undefined } : {}) })}>恢复默认外观</button></Section>}
    {message && <Section title="排列与操作"><div className="property-message-actions"><button className="agent-button" aria-label="上移消息" disabled={index === 0} onClick={() => move(-1)}><IconArrowUp size={15}/></button><button className="agent-button" aria-label="下移消息" disabled={index === scene.messages.length - 1} onClick={() => move(1)}><IconArrowDown size={15}/></button><button className="agent-button" disabled={scene.messages.length >= 200} onClick={() => { const copy = { ...message, id: crypto.randomUUID() }; const messages = [...scene.messages]; messages.splice(index + 1, 0, copy); apply({ ...scene, messages }); onSelect(copy.id); }}><IconCopy size={15}/>复制</button><button className="agent-button property-delete" aria-label="删除消息" onClick={() => { apply({ ...scene, messages: scene.messages.filter(m => m.id !== message.id) }); onSelect(scene.messages[index + 1]?.id || scene.messages[index - 1]?.id || '@scene'); }}><IconTrash size={15}/></button></div></Section>}
    <input hidden ref={file} type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { if (e.target.files?.[0]) void upload(e.target.files[0]); e.target.value = ''; }}/>
  </fieldset>{error && <p role="alert">{error}</p>}</div>;
}

import { IconLayout, IconMessageCircle, IconPlus, IconUser } from '@tabler/icons-react';
import { type Scene } from '../studio/model';
import { useCopy } from '../i18n';
export default function ElementNavigator({ scene, selected, locked, onSelect, onChange }: {
  scene: Scene; selected: string; locked: boolean; onSelect: (id: string) => void; onChange: (scene: Scene) => void;
}) {
  const copy = useCopy();
  const e = copy.elements;
  if (scene.reference) return <div className="element-navigator" aria-label={e.navMessageSection}><p className="element-help">{e.navReferenceHelp}</p><button className="element-item" disabled={locked} onClick={() => onSelect('')}><IconLayout size={17}/><span><strong>{e.navReferenceFull}</strong><small>{scene.reference.plan.width} × {scene.reference.plan.height} px</small></span></button>{scene.reference.plan.edits.map((edit, i) => <button key={edit.id} className="element-item" disabled={locked} aria-pressed={selected === `@patch:${edit.id}`} onClick={() => onSelect(`@patch:${edit.id}`)}><span className="element-index">{i + 1}</span><span><strong>{edit.text || edit.assetId || edit.id}</strong><small>{edit.kind === 'text' ? e.navReferenceText : e.navReferenceImage}</small></span></button>)}{!scene.reference.plan.edits.length && <p className="element-help">{e.navReferenceEmpty}</p>}</div>;
  return <div className="element-navigator" aria-label={e.navFrame}>
    <p className="element-help">{e.navHelp}</p>
    <button className="element-item" aria-pressed={selected === '@scene'} disabled={locked} onClick={() => onSelect('@scene')}><IconLayout size={17}/><span><strong>{e.navFrame}</strong></span></button>
    <div className="element-section-title">{e.navPersonSection} <span>{scene.participants.length}</span></div>
    {scene.participants.map(p => <button key={p.id} className="element-item" disabled={locked} aria-pressed={selected === `@participant:${p.id}`} onClick={() => onSelect(`@participant:${p.id}`)}>{p.avatar ? <img src={p.avatar} alt=""/> : <IconUser size={17}/>}<span><strong>{p.name}</strong><small>{p.id === scene.selfId ? e.navSelf : e.navOther}</small></span></button>)}
    <div className="element-section-title">{e.navMessageSection} <span>{scene.messages.length}</span><button className="icon-btn" aria-label={e.navAddMessage} disabled={locked || scene.messages.length >= 200} onClick={() => { const id = crypto.randomUUID(); onChange({ ...scene, messages: [...scene.messages, { id, participantId: scene.selfId, type: 'text', text: e.newMessage, time: scene.deviceTime, ...(scene.referenceDate ? {date:scene.referenceDate} : {}) }] }); onSelect(id); }}><IconPlus size={16}/></button></div>
    {scene.messages.map((m, i) => <button key={m.id} className="element-item" disabled={locked} aria-pressed={selected === m.id} onClick={() => onSelect(m.id)}><span className="element-index">{String(i + 1).padStart(2, '0')}</span><span><strong>{m.text || copy.messageTypes[m.type]}</strong><small>{scene.participants.find(p => p.id === m.participantId)?.name || e.system} · {copy.messageTypes[m.type]}{m.time && ` · ${m.time}`}</small></span><IconMessageCircle size={14}/></button>)}
    {!scene.messages.length && <p className="element-help">{e.navEmpty}</p>}
  </div>;
}

import { IconLayout, IconMessageCircle, IconPlus, IconUser } from '@tabler/icons-react';
import { MESSAGE_TYPE_LABELS, type Scene } from '../studio/model';
export default function ElementNavigator({ scene, selected, locked, onSelect, onChange }: {
  scene: Scene; selected: string; locked: boolean; onSelect: (id: string) => void; onChange: (scene: Scene) => void;
}) {
  if (scene.reference) return <div className="element-navigator" aria-label="截图编辑层列表"><p className="element-help">保留原截图布局，选择编辑层继续修改。</p><button className="element-item" disabled={locked} onClick={() => onSelect('')}><IconLayout size={17}/><span><strong>完整截图</strong><small>{scene.reference.plan.width} × {scene.reference.plan.height} px</small></span></button>{scene.reference.plan.edits.map((edit, i) => <button key={edit.id} className="element-item" disabled={locked} aria-pressed={selected === `@patch:${edit.id}`} onClick={() => onSelect(`@patch:${edit.id}`)}><span className="element-index">{i + 1}</span><span><strong>{edit.text || edit.assetId || edit.id}</strong><small>{edit.kind === 'text' ? '文字层' : '图片层'}</small></span></button>)}{!scene.reference.plan.edits.length && <p className="element-help">尚无编辑层。在 AI 创作中描述想修改的位置与内容。</p>}</div>;
  return <div className="element-navigator" aria-label="画面元素列表">
    <p className="element-help">选择一个元素，直接编辑或交给 AI。</p>
    <button className="element-item" aria-pressed={selected === '@scene'} disabled={locked} onClick={() => onSelect('@scene')}><IconLayout size={17}/><span><strong>画面与界面</strong><small>标题 · 时间 · 背景 · 输入栏</small></span></button>
    <div className="element-section-title">人物 <span>{scene.participants.length}</span></div>
    {scene.participants.map(p => <button key={p.id} className="element-item" disabled={locked} aria-pressed={selected === `@participant:${p.id}`} onClick={() => onSelect(`@participant:${p.id}`)}>{p.avatar ? <img src={p.avatar} alt=""/> : <IconUser size={17}/>}<span><strong>{p.name}</strong><small>{p.id === scene.selfId ? '我 · 右侧消息' : '对方 · 左侧消息'}</small></span></button>)}
    <div className="element-section-title">消息 <span>{scene.messages.length}</span><button className="icon-btn" aria-label="添加消息" disabled={locked || scene.messages.length >= 200} onClick={() => { const id = crypto.randomUUID(); onChange({ ...scene, messages: [...scene.messages, { id, participantId: scene.selfId, type: 'text', text: '新消息', time: scene.deviceTime, ...(scene.referenceDate ? {date:scene.referenceDate} : {}) }] }); onSelect(id); }}><IconPlus size={16}/></button></div>
    {scene.messages.map((m, i) => <button key={m.id} className="element-item" disabled={locked} aria-pressed={selected === m.id} onClick={() => onSelect(m.id)}><span className="element-index">{String(i + 1).padStart(2, '0')}</span><span><strong>{m.text || MESSAGE_TYPE_LABELS[m.type]}</strong><small>{scene.participants.find(p => p.id === m.participantId)?.name || '系统'} · {MESSAGE_TYPE_LABELS[m.type]}{m.time && ` · ${m.time}`}</small></span><IconMessageCircle size={14}/></button>)}
    {!scene.messages.length && <p className="element-help">还没有消息。点击 + 手动添加，或切换到 AI 创作。</p>}
  </div>;
}

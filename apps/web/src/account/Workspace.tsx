import { useEffect, useRef, useState } from 'react';
import { IconArrowRight, IconDeviceFloppy, IconEdit, IconLayoutGrid, IconMessageCircle, IconPlus, IconSearch, IconSettings, IconTrash } from '@tabler/icons-react';
import { useAuth } from './Auth';
import { api, errorText, type SceneSummary } from './api';
import { PLATFORM_LABELS } from '../studio/model';
export default function Workspace() {
  const { user } = useAuth();
  const [items, setItems] = useState<SceneSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [reload, setReload] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [selected, setSelected] = useState<SceneSummary | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(''); api<{ items: SceneSummary[] }>('/scenes', { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setItems(data.items); }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [reload]);
  useEffect(() => { if (selected) dialog.current?.showModal(); else dialog.current?.close(); }, [selected]);
  async function remove() {
    if (!selected || deleting) return; setDeleting(true);
    try { await api(`/scenes/${selected.id}`, { method: 'DELETE', body: { revision: selected.revision } }); setItems(items => items.filter(item => item.id !== selected.id)); setSelected(null); }
    catch (error) { setSelected(null); setError(errorText(error)); }
    finally { setDeleting(false); }
  }
  const filtered = items.filter(item => `${item.title} ${PLATFORM_LABELS[item.platform]}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="workspace-shell">
    <aside className="workspace-sidebar"><span className="account-kicker">WORKSPACE</span><a href="#/workspace" className="workspace-nav active" aria-current="page"><IconLayoutGrid size={19} /> 我的作品</a><a href="#/projects" className="workspace-nav"><IconLayoutGrid size={19} /> 项目与批量生成</a><a href="#/templates" className="workspace-nav"><IconMessageCircle size={19} /> 场景灵感</a><a href="#/studio" className="workspace-nav"><IconEdit size={19} /> 本机草稿</a><a href="#/account" className="workspace-nav"><IconSettings size={19} /> 账号设置</a><div className="workspace-sidebar-note"><IconDeviceFloppy size={20} /><p>每一次保存，<br />都让灵感有迹可循。</p></div></aside>
    <section className="workspace-content"><header className="workspace-heading"><div><span className="account-kicker">YOUR STORIES, IN ONE PLACE</span><h1>{user?.name}的创作空间</h1><p>一个念头，一段对话。一切从这里开始。</p></div><a className="btn btn-primary" href="#/workspace?scene=new"><IconPlus size={18} /> 新建对话</a></header>
      <div className="workspace-start"><div><span className="account-kicker">START WITH A CONVERSATION</span><h2>下一段故事，<br />由你来开场。</h2><p>写台词、选平台、调整画面，再导出聊天截图。</p><a href="#/workspace?scene=new" className="text-link">打开对话编辑器 <IconArrowRight size={18} /></a></div><div className="workspace-mini" aria-hidden="true"><span className="workspace-mini-title">周末出逃计划</span><div>周末，要不要去看海？</div><div>好呀！这次把日落也装进口袋。</div><span>灵感正在发生 ···</span></div></div>
      <div className="workspace-library-heading"><h2>我的作品 <span>{items.length}</span></h2><label className="workspace-search"><IconSearch size={17} /><input aria-label="搜索作品" placeholder="搜索作品或平台" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
      {error && <div role="alert" className="account-error">{error} <button onClick={() => setReload(reload + 1)}>重新加载</button></div>}
      {loading ? <p role="status" className="workspace-empty">正在取回你的作品…</p> : !items.length ? <div className="workspace-empty"><IconMessageCircle size={30} /><h3>{error ? '作品暂时无法加载' : '还没有保存的作品'}</h3><p>{error ? '恢复连接后重新加载，已保存的内容仍在。' : '新建一段对话，或把本机草稿保存到这里。'}</p>{!error && <a className="text-link" href="#/studio">打开本机草稿 <IconArrowRight size={16} /></a>}</div> : !filtered.length ? <div className="workspace-empty"><p>没有找到“{search}”相关的作品。</p><button className="text-link" onClick={() => setSearch('')}>清除搜索</button></div> : <div className="workspace-grid">{filtered.map(item => <article key={item.id} className="work-card"><a href={`#/workspace?scene=${encodeURIComponent(item.id)}`} aria-label={`编辑 ${item.title || '未命名对话'}`}><div className={`work-card-art platform-${item.platform}`}><IconMessageCircle size={38} stroke={1.2} /><span>{PLATFORM_LABELS[item.platform]}</span><strong>{item.title || '未命名对话'}</strong><small>{item.messageCount} 条消息</small></div><h3>{item.title || '未命名对话'}</h3><p>{new Date(item.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 保存</p></a><button className="icon-btn work-delete" aria-label={`删除 ${item.title || '未命名对话'}`} onClick={() => setSelected(item)}><IconTrash size={17} /></button></article>)}</div>}
    </section><dialog ref={dialog} className="account-dialog" onCancel={e => { if (deleting) e.preventDefault(); else setSelected(null); }}><h2>删除这份作品？</h2><p>“{selected?.title || '未命名对话'}”将从账号中永久删除。已导出的文件不受影响。</p><div><button className="btn btn-secondary" disabled={deleting} onClick={() => setSelected(null)}>保留作品</button><button className="btn btn-primary" disabled={deleting} onClick={remove}>{deleting ? '正在删除…' : '确认删除'}</button></div></dialog>
  </div>;
}

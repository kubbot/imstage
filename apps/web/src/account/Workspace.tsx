import { useEffect, useRef, useState } from 'react';
import { IconArrowRight, IconDeviceFloppy, IconEdit, IconLayoutGrid, IconMessageCircle, IconPlus, IconSearch, IconSettings, IconTrash } from '@tabler/icons-react';
import { useAuth } from './Auth';
import { api, errorText, type SceneSummary } from './api';
import { useCopy, useFormatLocale } from '../i18n';

export default function Workspace() {
  const { user } = useAuth();
  const copy = useCopy();
  const a = copy.account;
  const formatLocale = useFormatLocale();
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
  const title = (item: SceneSummary) => item.title || a.untitled;
  const filtered = items.filter(item => `${item.title} ${copy.platforms[item.platform]}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="workspace-shell">
    <aside className="workspace-sidebar"><span className="account-kicker">{a.workspaceKicker}</span><a href="#/workspace" className="workspace-nav active" aria-current="page"><IconLayoutGrid size={19} /> {a.navWorks}</a><a href="#/projects" className="workspace-nav"><IconLayoutGrid size={19} /> {a.navProjects}</a><a href="#/templates" className="workspace-nav"><IconMessageCircle size={19} /> {a.navTemplates}</a><a href="#/studio" className="workspace-nav"><IconEdit size={19} /> {a.navLocalDraft}</a><a href="#/account" className="workspace-nav"><IconSettings size={19} /> {a.navAccount}</a><div className="workspace-sidebar-note"><IconDeviceFloppy size={20} /><p>{a.sidebarNote}</p></div></aside>
    <section className="workspace-content"><header className="workspace-heading"><div><h1>{a.workspaceTitle(user?.name || '')}</h1></div><a className="btn btn-primary" href="#/workspace?scene=new"><IconPlus size={18} /> {a.newConversation}</a></header>
      <div className="workspace-library-heading"><h2>{a.libraryTitle} <span>{items.length}</span></h2><label className="workspace-search"><IconSearch size={17} /><input aria-label={a.searchLabel} placeholder={a.searchPlaceholder} value={search} onChange={e => setSearch(e.target.value)} /></label></div>
      {error && <div role="alert" className="account-error">{error} <button onClick={() => setReload(reload + 1)}>{a.reload}</button></div>}
      {loading ? <p role="status" className="workspace-empty">{a.fetching}</p> : !items.length ? <div className="workspace-empty"><IconMessageCircle size={30} /><h3>{error ? a.emptyErrorTitle : a.emptyTitle}</h3><p>{error ? a.emptyErrorBody : a.emptyBody}</p>{!error && <a className="text-link" href="#/studio">{a.openLocalDraft} <IconArrowRight size={16} /></a>}</div> : !filtered.length ? <div className="workspace-empty"><p>{a.noMatch(search)}</p><button className="text-link" onClick={() => setSearch('')}>{a.clearSearch}</button></div> : <div className="workspace-grid">{filtered.map(item => <article key={item.id} className="work-card"><a href={`#/workspace?scene=${encodeURIComponent(item.id)}`} aria-label={a.cardEdit(title(item))}><div className={`work-card-art platform-${item.platform}`}><IconMessageCircle size={38} stroke={1.2} /><span>{copy.platforms[item.platform]}</span><strong>{title(item)}</strong><small>{a.cardMessages(item.messageCount)}</small></div><h3>{title(item)}</h3><p>{new Date(item.updatedAt).toLocaleString(formatLocale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} {a.cardSaved}</p></a><button className="icon-btn work-delete" aria-label={a.cardDelete(title(item))} onClick={() => setSelected(item)}><IconTrash size={17} /></button></article>)}</div>}
    </section><dialog ref={dialog} className="account-dialog" onCancel={e => { if (deleting) e.preventDefault(); else setSelected(null); }}><h2>{a.deleteTitle}</h2><p>{a.deleteBody(selected?.title || a.untitled)}</p><div><button className="btn btn-secondary" disabled={deleting} onClick={() => setSelected(null)}>{a.keepWork}</button><button className="btn btn-primary" disabled={deleting} onClick={remove}>{deleting ? a.deleting : a.confirmDelete}</button></div></dialog>
  </div>;
}

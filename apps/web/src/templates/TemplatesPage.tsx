import { useEffect, useRef, useState } from 'react';
import {
  IconArrowLeft,
  IconBookmark,
  IconDeviceDesktop,
  IconLayoutGrid,
  IconLoader2,
  IconMessageCircle,
  IconPencil,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconScissors,
  IconSettings,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { api, errorText, type SavedScene, type SceneSummary, type TemplateDetail, type TemplateSummary, type TemplateVariable } from '../account/api';
import { useAuth } from '../account/Auth';
import { useCopy } from '../i18n';
import { useLocale } from '../marketing/LocaleContext';
import { createHandoffHref } from '../marketing/locale';
import { writeHandoffScene } from '../marketing/handoff';
import { discoverTemplateVariables } from '../../../../packages/schema/templates.ts';
import { createScene, type Scene } from '../studio/model';
import { readImageFile } from '../studio/storage';
import { TEMPLATE_SCREENSHOT_KEY } from './screenshotSeed';
import './templates.css';

const MAX_VARIABLES = 50;

export default function TemplatesPage({ sceneId }: { sceneId?: string }) {
  const copy = useCopy();
  const t = copy.templates;
  const a = copy.account;
  const { locale } = useLocale();
  const { user } = useAuth();
  const ownerId = user?.id ?? null;

  // A delayed response must never apply to a different account or a torn-down
  // page: every async action captures the owner + epoch and re-checks it before
  // any state, sessionStorage handoff or navigation side effect.
  const mounted = useRef(true);
  const ownerRef = useRef(ownerId);
  const epochRef = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; epochRef.current += 1; }; }, []);
  useEffect(() => {
    if (ownerRef.current === ownerId) return;
    ownerRef.current = ownerId;
    epochRef.current += 1;
  }, [ownerId]);
  const capture = () => ({ owner: ownerRef.current, epoch: epochRef.current });
  const stale = (token: { owner: string | null; epoch: number }) =>
    !mounted.current || token.epoch !== epochRef.current || token.owner !== ownerRef.current;

  const [items, setItems] = useState<TemplateSummary[]>([]);
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  const [selectedSceneId, setSelectedSceneId] = useState(sceneId ?? '');
  const [sourceScene, setSourceScene] = useState<Scene | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [variables, setVariables] = useState<TemplateVariable[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState('');

  const [usingId, setUsingId] = useState('');
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [renaming, setRenaming] = useState<TemplateSummary | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);

  const [screenshot, setScreenshot] = useState('');
  const [screenshotMode, setScreenshotMode] = useState<'reconstruct' | 'preserve'>('reconstruct');
  const screenshotInput = useRef<HTMLInputElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const renameDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const token = capture();
    setLoading(true);
    setError('');
    Promise.all([
      api<{ items: TemplateSummary[] }>('/templates', { signal: controller.signal }),
      api<{ items: SceneSummary[] }>('/scenes', { signal: controller.signal }),
    ])
      .then(([templates, sceneList]) => {
        if (controller.signal.aborted || stale(token)) return;
        setItems(templates.items);
        setScenes(sceneList.items);
      })
      .catch(err => { if (!controller.signal.aborted && !stale(token)) setError(errorText(err)); })
      .finally(() => { if (!controller.signal.aborted && !stale(token)) setLoading(false); });
    return () => controller.abort();
  }, [reload, ownerId]);

  // Load the source scene and refresh the discoverable variable list. The scene
  // itself is frozen only when the creator submits, never while browsing.
  useEffect(() => {
    setSourceScene(null); setVariables([]); setEnabled(new Set());
    if (!selectedSceneId) return undefined;
    const controller = new AbortController();
    const token = capture();
    api<{ item: SavedScene }>(`/scenes/${encodeURIComponent(selectedSceneId)}`, { signal: controller.signal })
      .then(data => {
        if (controller.signal.aborted || stale(token)) return;
        const scene = data.item.scene;
        setSourceScene(scene);
        const discovered = discoverTemplateVariables(scene).slice(0, MAX_VARIABLES);
        setVariables(discovered);
        setLabels(Object.fromEntries(discovered.map(variable => [variable.key, variable.label])));
        setEnabled(new Set(discovered.map(variable => variable.key)));
        setName(current => current || scene.title || '');
      })
      .catch(err => { if (!controller.signal.aborted && !stale(token)) setError(errorText(err)); });
    return () => controller.abort();
  }, [selectedSceneId, reload, ownerId]);

  useEffect(() => { if (deleting) deleteDialog.current?.showModal(); else deleteDialog.current?.close(); }, [deleting]);
  useEffect(() => { if (renaming) renameDialog.current?.showModal(); else renameDialog.current?.close(); }, [renaming]);

  async function create() {
    if (creating) return;
    if (name.trim() === '') { setError(t.needName); return; }
    if (!sourceScene || sourceScene.id !== selectedSceneId) { setError(t.needScene); return; }
    const token = capture();
    setCreating(true);
    setError('');
    setNotice('');
    try {
      const chosen = variables
        .filter(variable => enabled.has(variable.key))
        .map(variable => ({ ...variable, label: (labels[variable.key] || variable.label).slice(0, 80) }));
      const data = await api<{ item: TemplateDetail }>('/templates', {
        method: 'POST',
        body: { name: name.trim(), description: description.trim(), scene: sourceScene, variables: chosen },
      });
      if (stale(token)) return;
      setNotice(t.created);
      setItems(current => [data.item, ...current.filter(item => item.id !== data.item.id)]);
      setDescription('');
      setSelectedSceneId('');
      setName('');
    } catch (err) {
      if (!stale(token)) setError(errorText(err));
    } finally {
      if (!stale(token)) setCreating(false);
    }
  }

  /**
   * Reuse opens a brand new creator session with the instantiated scene. No
   * provider call is made; the workspace validates the handed-off scene and
   * autosaves it through the normal account path. A delayed response is
   * discarded when the page unmounted or the signed-in owner changed.
   */
  async function use(item: TemplateSummary) {
    if (usingId) return;
    const token = capture();
    setUsingId(item.id);
    setError('');
    try {
      const data = await api<{ scene: Scene }>(`/templates/${encodeURIComponent(item.id)}/instantiate`, {
        method: 'POST',
        body: { values: {} },
      });
      if (stale(token)) return;
      const handoff = writeHandoffScene(data.scene);
      if (!handoff) { setError(t.useFailed); return; }
      if (stale(token)) return;
      location.hash = createHandoffHref(locale, undefined, handoff).slice(1);
    } catch (err) {
      if (!stale(token)) setError(errorText(err));
    } finally {
      if (!stale(token)) setUsingId('');
    }
  }

  async function rename() {
    if (!renaming || renameBusy || renameValue.trim() === '') return;
    const token = capture();
    const target = renaming;
    setRenameBusy(true);
    setError('');
    try {
      const detail = await api<{ item: TemplateDetail }>(`/templates/${encodeURIComponent(target.id)}`);
      if (stale(token)) return;
      const updated = await api<{ item: TemplateDetail }>(`/templates/${encodeURIComponent(target.id)}`, {
        method: 'PUT',
        body: {
          revision: detail.item.revision,
          name: renameValue.trim(),
          description: detail.item.definition.description,
          scene: detail.item.definition.scene,
          variables: detail.item.definition.variables,
        },
      });
      if (stale(token)) return;
      setItems(current => current.map(item => (item.id === updated.item.id ? updated.item : item)));
      setRenaming(null);
    } catch (err) {
      if (!stale(token)) setError(errorText(err));
    } finally {
      if (!stale(token)) setRenameBusy(false);
    }
  }

  async function remove() {
    if (!deleting || deleteBusy) return;
    const token = capture();
    const target = deleting;
    setDeleteBusy(true);
    setError('');
    try {
      await api(`/templates/${encodeURIComponent(target.id)}`, { method: 'DELETE', body: { revision: target.revision } });
      if (stale(token)) return;
      setItems(current => current.filter(item => item.id !== target.id));
      setDeleting(null);
    } catch (err) {
      if (!stale(token)) { setDeleting(null); setError(errorText(err)); }
    } finally {
      if (!stale(token)) setDeleteBusy(false);
    }
  }

  async function readScreenshot(file: File | undefined) {
    if (!file) return;
    const token = capture();
    const result = await readImageFile(file);
    if (stale(token)) return;
    if (!result.ok) { setError(t.screenshotReadFailed); return; }
    setScreenshot(result.dataUrl);
    setError('');
  }

  function openScreenshotCreator() {
    if (!screenshot) return;
    try {
      sessionStorage.setItem(TEMPLATE_SCREENSHOT_KEY, JSON.stringify({ source: screenshot, mode: screenshotMode }));
    } catch {
      setError(t.useFailed);
      return;
    }
    location.hash = `/create?new=1&lang=${locale}&templateFlow=${screenshotMode}`;
  }

  /** Examples open a real creator session with a concrete, bounded intent. */
  function openExample(prompt: string) {
    const token = writeHandoffScene(createScene('weekend'), prompt);
    if (!token) { setError(t.useFailed); return; }
    location.hash = createHandoffHref(locale, undefined, token).slice(1);
  }

  const examples: [string, string][] = [
    [t.exampleSupport, t.exampleSupportPrompt],
    [t.exampleEvent, t.exampleEventPrompt],
    [t.exampleOnboarding, t.exampleOnboardingPrompt],
    [t.exampleNarrative, t.exampleNarrativePrompt],
    [t.exampleEval, t.exampleEvalPrompt],
  ];

  return <div className="workspace-shell templates-shell">
    <aside className="workspace-sidebar">
      <span className="account-kicker">{t.kicker}</span>
      <a href="#/workspace" className="workspace-nav"><IconLayoutGrid size={19} /> {a.navWorks}</a>
      <a href="#/projects" className="workspace-nav"><IconLayoutGrid size={19} /> {a.navProjects}</a>
      <a href="#/templates" className="workspace-nav active" aria-current="page"><IconBookmark size={19} /> {t.nav}</a>
      <a href="#/create" className="workspace-nav"><IconSettings size={19} /> {a.newConversation}</a>
    </aside>
    <section className="workspace-content">
      <header className="workspace-heading">
        <div>
          <span className="account-kicker">{t.kicker}</span>
          <h1>{t.title}</h1>
          <p>{t.lede}</p>
        </div>
      </header>

      {error && <div role="alert" className="account-error">{error} <button onClick={() => setReload(value => value + 1)}>{t.reload}</button></div>}
      {notice && <p role="status" className="template-notice">{notice}</p>}

      <div className="templates-columns">
        <section className="template-panel" aria-label={t.createTitle}>
          <h2><IconScissors size={18} /> {t.createTitle}</h2>
          <p className="template-muted">{t.createBody}</p>
          <label>{t.sceneLabel}
            <select aria-label={t.sceneLabel} value={selectedSceneId} onChange={event => setSelectedSceneId(event.target.value)}>
              <option value="">{t.chooseScene}</option>
              {scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.title || a.untitled}</option>)}
            </select>
          </label>
          {sourceScene?.id === selectedSceneId && sourceScene && <>
            <label>{t.nameLabel}<input aria-label={t.nameLabel} value={name} maxLength={80} placeholder={t.namePlaceholder} onChange={event => setName(event.target.value)} /></label>
            <label>{t.descriptionLabel}<textarea aria-label={t.descriptionLabel} value={description} rows={2} maxLength={500} placeholder={t.descriptionPlaceholder} onChange={event => setDescription(event.target.value)} /></label>
            {variables.length > 0 ? <fieldset className="template-variable-list">
              <legend>{t.variablesTitle} <span>{t.variablesSelected(enabled.size, variables.length)}</span></legend>
              <p className="template-muted">{t.variablesHint}</p>
              <div className="template-list-actions">
                <button type="button" className="text-link" onClick={() => setEnabled(new Set(variables.map(variable => variable.key)))}>{t.selectAll}</button>
                <button type="button" className="text-link" onClick={() => setEnabled(new Set())}>{t.clearAll}</button>
              </div>
              {variables.map(variable => <div key={variable.key} className="template-variable-row">
                <label className="template-check"><input type="checkbox" checked={enabled.has(variable.key)} onChange={event => setEnabled(current => { const next = new Set(current); if (event.target.checked) next.add(variable.key); else next.delete(variable.key); return next; })} /> <span>{copy.messageTypes[variable.type]}</span></label>
                <label>{t.variableLabel}<input aria-label={`${t.variableLabel} ${variable.key}`} value={labels[variable.key] ?? variable.label} maxLength={80} onChange={event => setLabels(current => ({ ...current, [variable.key]: event.target.value }))} /></label>
                <small>{t.variableTarget(variable.target.entity, variable.target.field)}</small>
              </div>)}
            </fieldset> : <p className="template-muted">{t.noVariables}</p>}
            <button className="btn btn-primary" disabled={creating || name.trim() === ''} onClick={() => void create()}>
              {creating ? <IconLoader2 size={16} className="projects-spin" /> : <IconPlus size={16} />} {creating ? t.creating : t.create}
            </button>
          </>}
        </section>

        <section className="template-panel" aria-label={t.screenshotTitle}>
          <h2><IconPhoto size={18} /> {t.screenshotTitle}</h2>
          <p className="template-muted">{t.screenshotBody}</p>
          {screenshot ? <img className="template-shot" src={screenshot} alt={t.screenshotTitle} /> : null}
          <input hidden ref={screenshotInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void readScreenshot(event.target.files?.[0]); event.target.value = ''; }} />
          <button type="button" className="agent-button" onClick={() => screenshotInput.current?.click()}><IconUpload size={15} /> {screenshot ? t.screenshotChange : t.screenshotUpload}</button>
          <fieldset className="template-modes">
            <legend>{t.screenshotTitle}</legend>
            <label className="template-check"><input type="radio" name="template-screenshot-mode" checked={screenshotMode === 'reconstruct'} onChange={() => setScreenshotMode('reconstruct')} /> {t.reconstruct}</label>
            <p className="template-muted">{t.reconstructHint}</p>
            <label className="template-check"><input type="radio" name="template-screenshot-mode" checked={screenshotMode === 'preserve'} onChange={() => setScreenshotMode('preserve')} /> {t.preserve}</label>
            <p className="template-muted">{t.preserveHint}</p>
          </fieldset>
          <button className="btn btn-secondary" disabled={!screenshot} onClick={openScreenshotCreator}><IconDeviceDesktop size={15} /> {t.openCreator}</button>
          <p className="template-muted">{t.referenceNote}</p>
        </section>

        <section className="template-panel" aria-label={t.examplesTitle}>
          <h2><IconMessageCircle size={18} /> {t.examplesTitle}</h2>
          <p className="template-muted">{t.examplesHint}</p>
          <div className="template-examples">
            {examples.map(([label, prompt]) => <button key={label} type="button" className="agent-button" onClick={() => openExample(prompt)}>{label}</button>)}
          </div>
        </section>
      </div>

      <div className="workspace-library-heading">
        <h2>{t.title} <span>{items.length}</span></h2>
        <button className="text-link" onClick={() => setReload(value => value + 1)}><IconRefresh size={15} /> {t.reload}</button>
      </div>
      {loading ? <p role="status" className="workspace-empty">{t.loading}</p> : !items.length ? <div className="workspace-empty"><IconBookmark size={30} /><h3>{error ? t.emptyErrorTitle : t.emptyTitle}</h3><p>{error ? t.emptyErrorBody : t.emptyBody}</p></div> : <div className="templates-grid">
        {items.map(item => <article key={item.id} className="template-card">
          <div className="template-card-body">
            <strong>{item.name}</strong>
            <small>{t.mode[item.mode] ?? item.mode} · {t.variableCount(item.variableCount)} · {t.revision(item.revision)}</small>
            {item.description && <p>{item.description}</p>}
          </div>
          <div className="template-card-actions">
            <button className="btn btn-primary" disabled={Boolean(usingId)} onClick={() => void use(item)}>{usingId === item.id ? <IconLoader2 size={15} className="projects-spin" /> : <IconRefresh size={15} />} {usingId === item.id ? t.using : t.use}</button>
            <button className="icon-btn" aria-label={`${t.rename} ${item.name}`} onClick={() => { setRenaming(item); setRenameValue(item.name); }}><IconPencil size={16} /></button>
            <button className="icon-btn" aria-label={`${t.delete} ${item.name}`} onClick={() => setDeleting(item)}><IconTrash size={16} /></button>
          </div>
        </article>)}
      </div>}
      <p className="template-muted templates-hint">{t.useHint}</p>
      <p className="projects-back"><a className="text-link" href="#/workspace"><IconArrowLeft size={15} /> {t.back}</a></p>
    </section>

    <dialog ref={deleteDialog} className="account-dialog" onCancel={event => { if (deleteBusy) event.preventDefault(); else setDeleting(null); }}>
      <h2>{t.deleteTitle}</h2>
      <p>{t.deleteBody(deleting?.name || '')}</p>
      <div>
        <button className="btn btn-secondary" disabled={deleteBusy} onClick={() => setDeleting(null)}>{t.keep}</button>
        <button className="btn btn-primary" disabled={deleteBusy} onClick={() => void remove()}>{deleteBusy ? t.deleting : t.confirmDelete}</button>
      </div>
    </dialog>

    <dialog ref={renameDialog} className="account-dialog" onCancel={event => { if (renameBusy) event.preventDefault(); else setRenaming(null); }}>
      <h2>{t.renameTitle}</h2>
      <label>{t.nameLabel}<input aria-label={t.nameLabel} value={renameValue} maxLength={80} onChange={event => setRenameValue(event.target.value)} /></label>
      <div>
        <button className="btn btn-secondary" disabled={renameBusy} onClick={() => setRenaming(null)}>{copy.common.cancel}</button>
        <button className="btn btn-primary" disabled={renameBusy || renameValue.trim() === ''} onClick={() => void rename()}>{renameBusy ? t.saving : t.saveName}</button>
      </div>
    </dialog>
  </div>;
}

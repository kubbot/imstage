import { setNavigationGuard } from '../account/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconFolder,
  IconLayoutGrid,
  IconLoader2,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconSettings,
  IconTrash,
  IconX,
} from '@tabler/icons-react';
import {
  api,
  ApiError,
  errorText,
  type BatchJob,
  type BatchTask,
  type Project,
  type SceneSummary,
  type TemplateDetail,
  type TemplateSummary,
} from '../account/api';
import { PLATFORMS, type Platform } from '../studio/model';
import { readImageFile } from '../studio/storage';
import { useAuth } from '../account/Auth';
import { useCopy } from '../i18n';
import { useProjectAutosave } from './useProjectAutosave';
import './projects.css';

const MAX_PROMPTS = 10;
const MAX_VARIANTS = 10;
const MAX_ITEMS = 20;
const POLL_MS = 2_000;
const TERMINAL_JOB_STATUSES: BatchJob['status'][] = ['done', 'partial', 'failed', 'cancelled', 'interrupted'];

function isTerminal(status: BatchJob['status']) {
  return TERMINAL_JOB_STATUSES.includes(status);
}

function jobProgress(job: BatchJob) {
  const finished = job.succeeded + job.failed;
  if (job.total <= 0) return 0;
  return Math.min(100, Math.round((finished / job.total) * 100));
}

/* ------------------------------------------------------------------ */
/* Project list                                                        */
/* ------------------------------------------------------------------ */

export default function ProjectsPage({ projectId }: { projectId?: string }) {
  return projectId ? <ProjectDetail key={projectId} projectId={projectId} /> : <ProjectList />;
}

function ProjectList() {
  const PLATFORM_LABELS = useCopy().platforms;
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [name, setName] = useState('');
  const [rules, setRules] = useState('');
  const [platform, setPlatform] = useState<Platform>('wechat');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const p = useCopy().projects;
  const a = useCopy().account;
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<{ items: Project[] }>('/projects', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setItems(data.items);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorText(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (selected) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selected]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || name.trim() === '') return;
    setBusy(true);
    setError('');
    try {
      const data = await api<{ item: Project }>('/projects', {
        method: 'POST',
        body: { name: name.trim(), rules, platform },
      });
      location.hash = `/projects?project=${encodeURIComponent(data.item.id)}`;
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected || deleting) return;
    setDeleting(true);
    try {
      await api(`/projects/${selected.id}`, {
        method: 'DELETE',
        body: { revision: selected.revision },
      });
      setItems((current) => current.filter((item) => item.id !== selected.id));
      setSelected(null);
    } catch (err) {
      setSelected(null);
      setError(errorText(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="projects-shell">
      <header className="projects-heading">
        <div>
          <span className="account-kicker">{p.listKicker}</span>
          <h1>{p.listTitle}</h1>
          <p>{p.listLede}</p>
        </div>
      </header>

      <form className="project-create" onSubmit={create}>
        <h2>{p.newProject}</h2>
        <label>
          {p.nameLabel}
          <input
            value={name}
            maxLength={80}
            placeholder={p.namePlaceholder}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {p.platformLabel}
          <select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>
            {PLATFORMS.map((value) => (
              <option key={value} value={value}>{PLATFORM_LABELS[value]}</option>
            ))}
          </select>
        </label>
        <label>
          {p.rulesLabel}
          <textarea
            value={rules}
            maxLength={4000}
            rows={3}
            placeholder={p.rulesPlaceholder}
            onChange={(event) => setRules(event.target.value)}
          />
        </label>
        <button className="btn btn-primary" disabled={busy || name.trim() === ''}>
          {busy ? <IconLoader2 size={16} className="projects-spin" /> : <IconPlus size={16} />}
          {busy ? p.creating : p.create}
        </button>
      </form>

      {error && (
        <div role="alert" className="account-error projects-error">
          {error} <button onClick={() => setReload(reload + 1)}>{p.reload}</button>
        </div>
      )}

      {loading ? (
        <p role="status" className="page-loading">{p.loading}</p>
      ) : !items.length ? (
        <div className="workspace-empty">
          <IconFolder size={30} />
          <h3>{p.emptyTitle}</h3>
          <p>{p.emptyBody}</p>
        </div>
      ) : (
        <div className="projects-grid">
          {items.map((item) => (
            <article key={item.id} className="project-card">
              <a href={`#/projects?project=${encodeURIComponent(item.id)}`} aria-label={`${p.open} ${item.name}`}>
                <div className="project-card-body">
                  <IconFolder size={26} stroke={1.4} />
                  <strong>{item.name}</strong>
                  <small>{PLATFORM_LABELS[item.platform]} · {p.sceneCount(item.sceneCount)}</small>
                  <p>{item.rules.trim() ? item.rules.trim().slice(0, 80) : p.noRules}</p>
                </div>
              </a>
              <button
                className="icon-btn project-delete"
                aria-label={`${p.delete} ${item.name}`}
                onClick={() => setSelected(item)}
              >
                <IconTrash size={17} />
              </button>
            </article>
          ))}
        </div>
      )}

      <p className="projects-back"><a className="text-link" href="#/workspace"><IconArrowLeft size={15} /> {a.backWorks}</a></p>

      <dialog
        ref={dialog}
        className="account-dialog"
        onCancel={(event) => {
          if (deleting) event.preventDefault();
          else setSelected(null);
        }}
      >
        <h2>{p.deleteTitle}</h2>
        <p>
          {p.deleteConfirm} {p.cancelWarning}
        </p>
        <div>
          <button className="btn btn-secondary" disabled={deleting} onClick={() => setSelected(null)}>{p.keep}</button>
          <button className="btn btn-primary" disabled={deleting} onClick={remove}>
            {deleting ? p.deleting : p.confirmDelete}
          </button>
        </div>
      </dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Project detail                                                      */
/* ------------------------------------------------------------------ */

function ProjectDetail({ projectId }: { projectId: string }) {
  const PLATFORM_LABELS = useCopy().platforms;
  const platformLabel = (im: string | undefined) => (im && PLATFORM_LABELS[im as Platform]) || im || "";
  const { user } = useAuth();
  const [item, setItem] = useState<Project | null>(null);
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [remote, setRemote] = useState<Project | null>(null);

  const [available, setAvailable] = useState<SceneSummary[]>([]);
  const [attachId, setAttachId] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [detachingId, setDetachingId] = useState('');

  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [job, setJob] = useState<BatchJob | null>(null);
  const [promptsText, setPromptsText] = useState('');
  const [batchMode, setBatchMode] = useState<'prompts' | 'variants'>('prompts');
  const [variants, setVariants] = useState<{ id: string; name: string; prompt: string; values: Record<string, string> }[]>(() => [{ id: crypto.randomUUID(), name: '', prompt: '', values: {} }]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [templateDetail, setTemplateDetail] = useState<TemplateDetail | null>(null);
  const selectedTemplate = useRef(templateId); selectedTemplate.current = templateId;
  const [platforms, setPlatforms] = useState<Platform[]>(['wechat']);
  const [submitting, setSubmitting] = useState(false);
  const [batchError, setBatchError] = useState('');
  const clientBatchId = useRef('');
  const lastJobStatus = useRef('');
  const retrying=useRef(false);
  const [retryBusy,setRetryBusy]=useState(false);
  const p = useCopy().projects;
  const a = useCopy().account;
  const autosave = useProjectAutosave({
    userId: user?.id,
    projectId,
    remote,
    onReload: () => setReload((value) => value + 1),
  });
  const projectKey = item?.id ?? projectId;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<{ item: Project; scenes: SceneSummary[] }>(`/projects/${encodeURIComponent(projectId)}`, {
      signal: controller.signal,
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setScenes(data.scenes);
        setPlatforms([data.item.platform]);
        setItem(data.item);
        setRemote(data.item);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(errorText(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, reload]);

  useEffect(() => {
    const controller = new AbortController();
    api<{ items: SceneSummary[] }>('/scenes', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setAvailable(data.items);
      })
      .catch(() => { /* the attach picker is optional */ });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    api<{ items: TemplateSummary[] }>('/templates', { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setTemplates(data.items);
      })
      .catch(() => { /* template reuse is optional; legacy batches still work */ });
    return () => controller.abort();
  }, [reload]);

  // Load the declared variables of the selected template so each variant can
  // carry explicit typed values. The revision is captured at submit time.
  useEffect(() => {
    setTemplateDetail(null);
    setVariants(current => current.map(variant => ({...variant, values:{}})));
    if (!templateId) return undefined;
    const controller = new AbortController();
    api<{ item: TemplateDetail }>(`/templates/${encodeURIComponent(templateId)}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setTemplateDetail(data.item);
        // A reference template cannot be rendered on another platform, so pin
        // the selection to its source platform instead of silently converting.
        const source = data.item.definition.scene.reference?.plan?.im;
        if (source && PLATFORMS.includes(source as Platform)) setPlatforms([source as Platform]);
      })
      .catch((err) => { if (!controller.signal.aborted) setBatchError(errorText(err)); });
    return () => controller.abort();
  }, [templateId]);

  useEffect(() => {
    const controller = new AbortController();
    api<{ items: BatchJob[] }>(`/projects/${encodeURIComponent(projectId)}/batch-jobs`, { signal: controller.signal })
      .then(async (data) => {
        if (controller.signal.aborted) return;
        setJobs(data.items);
        const latest = data.items[0];
        if (!latest) return;
        const detail = await api<{ item: BatchJob }>(
          `/projects/${encodeURIComponent(projectId)}/batch-jobs/${latest.id}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setJob(detail.item);
      })
      .catch(() => { /* keep the previous job view */ });
    return () => controller.abort();
  }, [projectId, reload]);

  // Poll only while a job is still making progress; every status read is a
  // short GET, never a long-lived request.
  useEffect(() => {
    if (!job || isTerminal(job.status)) return undefined;
    const id = job.id;
    const timer = setInterval(async () => {
      try {
        const data = await api<{ item: BatchJob }>(
          `/projects/${encodeURIComponent(projectId)}/batch-jobs/${id}`,
        );
        setJob(data.item);
      } catch {
        /* keep the last known state until the next poll */
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job?.id, job?.status, projectId]);

  // Refresh the attached scene list once a finished job published something.
  useEffect(() => {
    if (!job || !isTerminal(job.status)) return;
    if (lastJobStatus.current === job.id) return;
    if (job.succeeded > 0) {
      lastJobStatus.current = job.id;
      setReload((value) => value + 1);
    }
  }, [job]);

  // Local input is only guarded when the cache is unavailable and cloud has not
  // caught up; otherwise a reload recovers the draft from the tab cache.
  const guardLocalDraft = autosave.cacheFailed && autosave.dirty;
  useEffect(() => {
    if (!guardLocalDraft) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [guardLocalDraft]);
  useEffect(() => (guardLocalDraft ? setNavigationGuard(() => window.confirm(p.leaveConfirm)) : undefined), [guardLocalDraft, p.leaveConfirm]);
  const attachedIds = useMemo(() => new Set(scenes.map((scene) => scene.id)), [scenes]);
  const attachable = useMemo(() => available.filter((scene) => !attachedIds.has(scene.id)), [available, attachedIds]);

  const promptLines = promptsText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const totalItems = promptLines.length * platforms.length;
  const batchItems = batchMode === 'variants' ? variants.length * platforms.length : totalItems;
  const templateReady = !templateId || templateDetail?.id === templateId;
  const templateVariables = templateReady ? templateDetail?.definition.variables ?? [] : [];

  function updateVariant(id: string, patch: Partial<{ name: string; prompt: string; values: Record<string, string> }>) {
    setVariants(current => current.map(variant => (variant.id === id ? { ...variant, ...patch } : variant)));
  }
  function setVariantValue(id: string, key: string, value: string) {
    setVariants(current => current.map(variant => (variant.id === id ? { ...variant, values: { ...variant.values, [key]: value } } : variant)));
  }
  async function readVariantImage(id: string, key: string, file: File | undefined) {
    if (!file) return;
    const targetTemplate = templateId;
    const result = await readImageFile(file);
    if (selectedTemplate.current !== targetTemplate) return;
    if (!result.ok) { setBatchError(result.error); return; }
    setVariantValue(id, key, result.dataUrl);
  }

  const autosaveLabel = autosave.status === 'local' ? p.autosaveLocal
    : autosave.status === 'saving' ? p.autosaveSaving
      : autosave.status === 'conflict' ? p.autosaveConflict
        : autosave.status === 'error' ? p.autosaveError
          : p.autosaveSaved;

  function discardLocal() {
    if (!window.confirm(p.reloadConfirm)) return;
    autosave.discardLocal();
  }

  async function attach(event: FormEvent) {
    event.preventDefault();
    if (!attachId || attaching) return;
    setAttaching(true);
    setError('');
    try {
      await api(`/projects/${encodeURIComponent(projectKey)}/scenes`, { method: 'POST', body: { sceneId: attachId } });
      setAttachId('');
      setReload((value) => value + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAttaching(false);
    }
  }

  async function detach(sceneId: string) {
    if (detachingId) return;
    setDetachingId(sceneId);
    try {
      await api(`/projects/${encodeURIComponent(projectKey)}/scenes/${sceneId}`, { method: 'DELETE', body: {} });
      setScenes((current) => current.filter((scene) => scene.id !== sceneId));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDetachingId('');
    }
  }

  function togglePlatform(value: Platform) {
    setPlatforms((current) => (current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]));
  }

  async function startBatch(event: FormEvent) {
    event.preventDefault();
    if (submitting || !templateReady) return;
    // The stored rules are only safe once every edit has been acknowledged.
    if (autosave.syncBlocked) {
      setBatchError(p.batchBlockedSync);
      return;
    }
    if (platforms.length === 0) {
      setBatchError(p.needPlatform);
      return;
    }
    let payload: Record<string, unknown>;
    if (batchMode === 'variants') {
      const cleaned = variants.map(variant => {
        const values: Record<string, string> = {};
        if (templateId) {
          for (const [key, value] of Object.entries(variant.values)) if (value.trim() !== '') values[key] = value;
        }
        return { name: variant.name.trim(), prompt: variant.prompt.trim(), values };
      });
      if (cleaned.length === 0 || cleaned.length > MAX_VARIANTS) { setBatchError(p.maxVariants(MAX_VARIANTS)); return; }
      if (cleaned.some(variant => variant.name === '')) { setBatchError(p.needVariantName); return; }
      if (cleaned.some(variant => variant.prompt === '')) { setBatchError(p.needVariantPrompt); return; }
      if (cleaned.length * platforms.length > MAX_ITEMS) { setBatchError(p.maxItems(MAX_ITEMS)); return; }
      payload = { variants: cleaned, platforms };
    } else {
      if (promptLines.length === 0) { setBatchError(p.needPrompt); return; }
      if (promptLines.length > MAX_PROMPTS) { setBatchError(p.maxPrompts(MAX_PROMPTS)); return; }
      if (totalItems > MAX_ITEMS) { setBatchError(p.maxItems(MAX_ITEMS)); return; }
      payload = { prompts: promptLines, platforms };
    }
    if (templateId) {
      payload.templateId = templateId;
      payload.templateRevision = templateDetail?.revision ?? undefined;
    }
    // One stable key per submit attempt: a timed-out retry returns the same job
    // instead of creating duplicates.
    if (!clientBatchId.current) clientBatchId.current = crypto.randomUUID();
    payload.clientBatchId = clientBatchId.current;
    setSubmitting(true);
    setBatchError('');
    try {
      const data = await api<{ item: BatchJob }>(`/projects/${encodeURIComponent(projectKey)}/batch-jobs`, {
        method: 'POST',
        body: payload,
      });
      clientBatchId.current = '';
      lastJobStatus.current = '';
      setJob(data.item);
      setJobs((current) => [data.item, ...current.filter((entry) => entry.id !== data.item.id)]);
    } catch (err) {
      setBatchError(err instanceof ApiError && err.code === 'reference_platform_mismatch'
        ? p.platformMismatch(platformLabel(templateDetail?.definition.scene.reference?.plan?.im))
        : errorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    try {
      const data = await api<{ item: BatchJob }>(
        `/projects/${encodeURIComponent(projectKey)}/batch-jobs/${job.id}/cancel`,
        { method: 'POST', body: {} },
      );
      setJob(data.item);
    } catch (err) {
      setBatchError(errorText(err));
    }
  }

  async function retryJob() {
    if (!job || retrying.current) return;retrying.current=true;setRetryBusy(true);
    try {
      const data = await api<{ item: BatchJob }>(
        `/projects/${encodeURIComponent(projectKey)}/batch-jobs/${job.id}/retry`,
        { method: 'POST', body: {} },
      );
      lastJobStatus.current = '';
      setJob(data.item);
      setJobs((current) => [data.item, ...current]);
    } catch (err) {
      setBatchError(errorText(err));
    } finally {retrying.current=false;setRetryBusy(false);}
  }

  if (loading && !item && !autosave.recovered) return <p role="status" className="page-loading">{p.loading}</p>;
  if (!item && !autosave.recovered) {
    return (
      <section className="account-gate">
        <h1>{p.openFailed}</h1>
        <p role="alert">{error || p.missing}</p>
        <a className="btn btn-secondary" href="#/projects">{p.back}</a>
      </section>
    );
  }

  const canRetry = job !== null && isTerminal(job.status) && /failed|interrupted|cancelled|partial/.test(job.status);
  const running = job !== null && !isTerminal(job.status);

  return (
    <div className="projects-shell projects-detail">
      <p className="projects-back"><a className="text-link" href="#/projects"><IconArrowLeft size={15} /> {p.back}</a></p>
      <header className="projects-heading">
        <div>
          <span className="account-kicker">PROJECT</span>
          <h1>{autosave.settings.name || item?.name || ''}</h1>
          <p>{PLATFORM_LABELS[autosave.settings.platform]} · {p.scenesVersion(scenes.length, autosave.revision)}</p>
        </div>
      </header>

      {error && <div role="alert" className="account-error projects-error">{error}</div>}

      <div className="projects-columns">
        <section className="project-panel">
          <h2><IconSettings size={18} /> {p.detailRules}</h2>
          {(autosave.conflict || autosave.deleted) && (
            <div className="account-error" role="alert">
              {autosave.deleted ? p.autosaveDeleted : p.conflictNotice}
              <button type="button" onClick={discardLocal}>{p.autosaveDiscard}</button>
            </div>
          )}
          <fieldset className="project-form" style={{ border: 0, padding: 0, margin: 0 }}>
            <label>
              {p.nameLabel}
              <input value={autosave.settings.name} maxLength={80} onChange={(event) => autosave.setName(event.target.value)} />
            </label>
            <label>
              {p.platformLabel}
              <select value={autosave.settings.platform} onChange={(event) => autosave.setPlatform(event.target.value as Platform)}>
                {PLATFORMS.map((value) => (
                  <option key={value} value={value}>{PLATFORM_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label>
              {p.rulesLabel}
              <textarea
                value={autosave.settings.rules}
                maxLength={4000}
                rows={5}
                placeholder={p.rulesNote}
                onChange={(event) => autosave.setRules(event.target.value)}
              />
            </label>
            <div className="project-autosave" role="status" data-autosave={autosave.status}>
              <span>{autosaveLabel}</span>
              {autosave.recovered && <span>{p.autosaveRecovered}</span>}
              {autosave.status === 'error' && autosave.error && <span>{autosave.error}</span>}
              {autosave.status === 'error' && (
                <button type="button" className="text-link" onClick={autosave.retry}>{p.autosaveRetry}</button>
              )}
              {autosave.cacheFailed && <span role="alert">{p.autosaveCacheFailed}</span>}
            </div>
          </fieldset>
        </section>

        <section className="project-panel">
          <h2><IconLayoutGrid size={18} /> {p.works} <span>{scenes.length}</span></h2>
          {scenes.length === 0 ? (
            <p className="project-muted">{p.noWorks}</p>
          ) : (
            <ul className="project-scene-list">
              {scenes.map((scene) => (
                <li key={scene.id}>
                  <a href={`#/workspace?scene=${encodeURIComponent(scene.id)}`}>
                    <strong>{scene.title || a.untitled}</strong>
                    <small>{PLATFORM_LABELS[scene.platform]} · {a.cardMessages(scene.messageCount)}</small>
                  </a>
                  <button
                    className="icon-btn"
                    aria-label={`${p.detach} ${scene.title || a.untitled}`}
                    disabled={detachingId === scene.id}
                    onClick={() => void detach(scene.id)}
                  >
                    {detachingId === scene.id ? <IconLoader2 size={15} className="projects-spin" /> : <IconX size={15} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form className="project-attach" onSubmit={attach}>
            <label>
              {p.attachWork}
              <select value={attachId} onChange={(event) => setAttachId(event.target.value)}>
                <option value="">{p.chooseWork}</option>
                {attachable.map((scene) => (
                  <option key={scene.id} value={scene.id}>{scene.title || a.untitled}</option>
                ))}
              </select>
            </label>
            <button className="btn btn-secondary" disabled={!attachId || attaching}>
              {attaching ? <IconLoader2 size={15} className="projects-spin" /> : <IconPlus size={15} />} {p.attach}
            </button>
          </form>
        </section>
      </div>

      <section className="project-panel project-batch">
        <h2><IconRefresh size={18} /> {p.batch}</h2>
        <p className="project-muted">
          {p.batchHint(MAX_PROMPTS, MAX_ITEMS)}
        </p>
        <form onSubmit={startBatch}>
          <div className="project-batch-mode" role="group" aria-label={p.batch}>
            <button type="button" aria-pressed={batchMode === 'prompts'} onClick={() => setBatchMode('prompts')}>{p.modePrompts}</button>
            <button type="button" aria-pressed={batchMode === 'variants'} onClick={() => setBatchMode('variants')}>{p.modeVariants}</button>
          </div>
          <label>
            {p.templateLabel}
            <select aria-label={p.templateLabel} value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">{p.templateNone}</option>
              {templates.map((template) => <option key={template.id} value={template.id}>{p.templateSummary(template.name, template.revision)}</option>)}
            </select>
          </label>
          {templateId && <p className="project-muted">{p.templateHint}{templateVariables.length > 0 ? ` ${p.variantValuesHint}` : ''}{templateDetail?.definition.scene.reference ? ` ${p.referencePlatformNote(platformLabel(templateDetail.definition.scene.reference.plan.im))}` : ''}</p>}
          {batchMode === 'prompts' ? <label>
            {p.prompts}
            <textarea
              value={promptsText}
              rows={4}
              placeholder={p.promptsHint}
              onChange={(event) => setPromptsText(event.target.value)}
            />
          </label> : <fieldset className="project-variants">
            <legend>{p.variantsLegend} <span>{variants.length}/{MAX_VARIANTS}</span></legend>
            {variants.map((variant) => <div key={variant.id} className="project-variant">
              <label>{p.variantName}<input aria-label={p.variantName} value={variant.name} maxLength={80} onChange={(event) => updateVariant(variant.id, { name: event.target.value })} /></label>
              <label>{p.variantPrompt}<textarea aria-label={p.variantPrompt} value={variant.prompt} rows={2} maxLength={4000} onChange={(event) => updateVariant(variant.id, { prompt: event.target.value })} /></label>
              {templateVariables.length > 0 && <div className="project-variant-values">{templateVariables.map((variable) => <label key={variable.key}>{variable.label}
                {variable.type === 'image'
                  ? <span className="project-variant-image"><input aria-label={variable.label} value={variant.values[variable.key] ?? ''} onChange={(event) => setVariantValue(variant.id, variable.key, event.target.value)} /><input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`${variable.label} · image`} onChange={(event) => { void readVariantImage(variant.id, variable.key, event.target.files?.[0]); event.target.value = ''; }} /></span>
                  : <input aria-label={variable.label} value={variant.values[variable.key] ?? ''} maxLength={4000} onChange={(event) => setVariantValue(variant.id, variable.key, event.target.value)} />}
              </label>)}</div>}
              <button type="button" className="text-link" disabled={variants.length <= 1} onClick={() => setVariants(current => current.filter(entry => entry.id !== variant.id))}><IconX size={14} /> {p.removeVariant}</button>
            </div>)}
            <button type="button" className="agent-button" disabled={variants.length >= MAX_VARIANTS} onClick={() => setVariants(current => [...current, { id: crypto.randomUUID(), name: '', prompt: '', values: {} }])}><IconPlus size={15} /> {p.addVariant}</button>
          </fieldset>}
          <fieldset className="project-platforms">
            <legend>{p.platformShort}</legend>
            {PLATFORMS.map((value) => (
              <label key={value} className="project-checkbox">
                <input type="checkbox" checked={platforms.includes(value)} onChange={() => togglePlatform(value)} />
                {PLATFORM_LABELS[value]}
              </label>
            ))}
          </fieldset>
          <div className="project-form-actions">
            <button className="btn btn-primary" disabled={submitting || running || !templateReady || autosave.syncBlocked}>
              {submitting ? <IconLoader2 size={16} className="projects-spin" /> : <IconPlus size={16} />}
              {submitting ? p.generating : running ? p.taskRunning : `${p.generate} ${platforms.length ? batchItems : 0}`}
            </button>
            <span className="project-status">{batchMode === 'variants' ? `${p.promptCount(variants.length)}/${MAX_VARIANTS}` : `${p.promptCount(promptLines.length)}/${MAX_PROMPTS}`} · {p.sceneCount(batchItems)}/{MAX_ITEMS}</span>
          </div>
          {autosave.syncBlocked && <p className="project-muted project-sync-note">{p.batchBlockedSync}</p>}
          {batchError && <p className="account-error" role="alert">{batchError}</p>}
        </form>

        {job && (
          <div className="project-job">
            <div className="project-job-head">
              <strong>{p.history} {p.jobStatus[job.status]}</strong>
              <span>{p.success} {job.succeeded} · {p.failed} {job.failed} · {p.total(job.total)}</span>
            </div>
            <div className="project-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={jobProgress(job)}>
              <span style={{ width: `${jobProgress(job)}%` }} />
            </div>
            {job.reason && <p className="project-muted">{job.reason}</p>}
            {job.tasks && (
              <ul className="project-task-list">
                {job.tasks.map((task) => (
                  <li key={task.id} className={`task-${task.status}`}>
                    <span className="task-index">{task.ordinal + 1}</span>
                    <span className="task-text">{task.name ? `${task.name} · ${task.prompt}` : task.prompt}</span>
                    <span className="task-platform">{PLATFORM_LABELS[task.platform]}</span>
                    <span className="task-status">
                      {task.status === 'done' && task.sceneId ? (
                        <a href={`#/workspace?scene=${encodeURIComponent(task.sceneId)}`}>
                          <IconCheck size={14} /> {p.openScene}
                        </a>
                      ) : (
                        p.taskStatus[task.status]
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="project-form-actions">
              {running && (
                <button className="btn btn-secondary" onClick={cancelJob} type="button">
                  <IconPlayerStop size={16} /> {p.cancel}
                </button>
              )}
              {canRetry && (
                <button className="btn btn-secondary" onClick={retryJob} disabled={retryBusy} type="button">
                  <IconRefresh size={16} /> {p.retryFailed}
                </button>
              )}
            </div>
          </div>
        )}

        {jobs.length > 1 && (
          <details className="project-history">
            <summary>{p.history} ({jobs.length})</summary>
            <ul>
              {jobs.map((entry) => (
                <li key={entry.id}>
                  <span>{p.jobStatus[entry.status]}</span>
                  <span>{p.success} {entry.succeeded} · {p.failed} {entry.failed} · {p.total(entry.total)}</span>
                  <button className="text-link" type="button" onClick={async () => {
                    const data = await api<{ item: BatchJob }>(`/projects/${encodeURIComponent(projectKey)}/batch-jobs/${entry.id}`);
                    lastJobStatus.current = '';
                    setJob(data.item);
                  }}>{p.view}</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="project-panel project-warning">
        <h2><IconAlertTriangle size={18} /> {p.aboutBatch}</h2>
        <p>
          {p.batchNote} {p.batchNote2}
        </p>
        <p><a className="text-link" href="#/workspace">{p.manageAll} <IconArrowRight size={15} /></a></p>
      </section>
    </div>
  );
}

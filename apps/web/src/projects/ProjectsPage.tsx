import { setNavigationGuard } from '../account/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconDeviceFloppy,
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
} from '../account/api';
import { PLATFORMS, PLATFORM_LABELS, type Platform } from '../studio/model';
import './projects.css';

const MAX_PROMPTS = 10;
const MAX_ITEMS = 20;
const POLL_MS = 2_000;
const TERMINAL_JOB_STATUSES: BatchJob['status'][] = ['done', 'partial', 'failed', 'cancelled', 'interrupted'];

const JOB_STATUS_LABELS: Record<BatchJob['status'], string> = {
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

const TASK_STATUS_LABELS: Record<BatchTask['status'], string> = {
  queued: '等待中',
  running: '生成中',
  done: '已保存',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};

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
          <span className="account-kicker">PROJECTS</span>
          <h1>项目与批量生成</h1>
          <p>为一个主题保存规则和默认平台，一次生成最多 {MAX_ITEMS} 个新作品。</p>
        </div>
      </header>

      <form className="project-create" onSubmit={create}>
        <h2>新建项目</h2>
        <label>
          项目名称
          <input
            value={name}
            maxLength={80}
            placeholder="例如：秋季新品发布"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          默认平台
          <select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>
            {PLATFORMS.map((value) => (
              <option key={value} value={value}>{PLATFORM_LABELS[value]}</option>
            ))}
          </select>
        </label>
        <label>
          项目规则（可选，最多 4000 字）
          <textarea
            value={rules}
            maxLength={4000}
            rows={3}
            placeholder="例如：保持轻松语气，只写中文，不要出现真实品牌。"
            onChange={(event) => setRules(event.target.value)}
          />
        </label>
        <button className="btn btn-primary" disabled={busy || name.trim() === ''}>
          {busy ? <IconLoader2 size={16} className="projects-spin" /> : <IconPlus size={16} />}
          {busy ? '正在创建…' : '创建项目'}
        </button>
      </form>

      {error && (
        <div role="alert" className="account-error projects-error">
          {error} <button onClick={() => setReload(reload + 1)}>重新加载</button>
        </div>
      )}

      {loading ? (
        <p role="status" className="page-loading">正在读取项目…</p>
      ) : !items.length ? (
        <div className="workspace-empty">
          <IconFolder size={30} />
          <h3>还没有项目</h3>
          <p>先创建一个项目，把场景灵感和项目规则放在一起。</p>
        </div>
      ) : (
        <div className="projects-grid">
          {items.map((item) => (
            <article key={item.id} className="project-card">
              <a href={`#/projects?project=${encodeURIComponent(item.id)}`} aria-label={`打开项目 ${item.name}`}>
                <div className="project-card-body">
                  <IconFolder size={26} stroke={1.4} />
                  <strong>{item.name}</strong>
                  <small>{PLATFORM_LABELS[item.platform]} · {item.sceneCount} 个作品</small>
                  <p>{item.rules.trim() ? item.rules.trim().slice(0, 80) : '未设置项目规则'}</p>
                </div>
              </a>
              <button
                className="icon-btn project-delete"
                aria-label={`删除项目 ${item.name}`}
                onClick={() => setSelected(item)}
              >
                <IconTrash size={17} />
              </button>
            </article>
          ))}
        </div>
      )}

      <p className="projects-back"><a className="text-link" href="#/workspace"><IconArrowLeft size={15} /> 返回我的作品</a></p>

      <dialog
        ref={dialog}
        className="account-dialog"
        onCancel={(event) => {
          if (deleting) event.preventDefault();
          else setSelected(null);
        }}
      >
        <h2>删除项目「{selected?.name}」？</h2>
        <p>
          项目会被永久删除，其中关联的 {selected?.sceneCount ?? 0} 个作品会保留在「我的作品」中，只解除关联。
          进行中的批量生成会同时取消。
        </p>
        <div>
          <button className="btn btn-secondary" disabled={deleting} onClick={() => setSelected(null)}>保留项目</button>
          <button className="btn btn-primary" disabled={deleting} onClick={remove}>
            {deleting ? '正在删除…' : '确认删除项目'}
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
  const [item, setItem] = useState<Project | null>(null);
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [name, setName] = useState('');
  const [rules, setRules] = useState('');
  const [platform, setPlatform] = useState<Platform>('wechat');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [conflict, setConflict] = useState(false);

  const [available, setAvailable] = useState<SceneSummary[]>([]);
  const [attachId, setAttachId] = useState('');
  const [attaching, setAttaching] = useState(false);
  const [detachingId, setDetachingId] = useState('');

  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [job, setJob] = useState<BatchJob | null>(null);
  const [promptsText, setPromptsText] = useState('');
  const [platforms, setPlatforms] = useState<Platform[]>(['wechat']);
  const [submitting, setSubmitting] = useState(false);
  const [batchError, setBatchError] = useState('');
  const clientBatchId = useRef('');
  const lastJobStatus = useRef('');
  const initializedProject=useRef('');
  const dirtyRef=useRef(false);dirtyRef.current=Boolean(item)&&saved!==JSON.stringify({name,rules,platform});
  const retrying=useRef(false);
  const [retryBusy,setRetryBusy]=useState(false);

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
        if (initializedProject.current===projectId && dirtyRef.current) return;
        initializedProject.current=projectId;
        setItem(data.item);
        setName(data.item.name);
        setRules(data.item.rules);
        setPlatform(data.item.platform);
        setPlatforms([data.item.platform]);
        setSaved(JSON.stringify({ name: data.item.name, rules: data.item.rules, platform: data.item.platform }));
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

  const dirty = Boolean(item) && saved !== JSON.stringify({ name, rules, platform });
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[dirty]);
  useEffect(()=>dirty?setNavigationGuard(()=>window.confirm('项目规则尚未保存，离开会丢失修改，确定离开？')):undefined,[dirty]);
  const attachedIds = useMemo(() => new Set(scenes.map((scene) => scene.id)), [scenes]);
  const attachable = useMemo(() => available.filter((scene) => !attachedIds.has(scene.id)), [available, attachedIds]);

  const promptLines = promptsText.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  const totalItems = promptLines.length * platforms.length;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !item || !dirty) return;
    setBusy(true);
    setStatus('');
    try {
      const data = await api<{ item: Project }>(`/projects/${item.id}`, {
        method: 'PUT',
        body: { name, rules, platform, revision: item.revision },
      });
      setItem(data.item);
      setName(data.item.name);
      setRules(data.item.rules);
      setPlatform(data.item.platform);
      setSaved(JSON.stringify({ name: data.item.name, rules: data.item.rules, platform: data.item.platform }));
      setConflict(false);
      setStatus('已保存项目设置');
    } catch (err) {
      setStatus(errorText(err));
      setConflict(err instanceof ApiError && err.status === 409);
    } finally {
      setBusy(false);
    }
  }

  async function attach(event: FormEvent) {
    event.preventDefault();
    if (!attachId || attaching) return;
    setAttaching(true);
    setError('');
    try {
      await api(`/projects/${item?.id}/scenes`, { method: 'POST', body: { sceneId: attachId } });
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
      await api(`/projects/${item?.id}/scenes/${sceneId}`, { method: 'DELETE', body: {} });
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
    if (submitting) return;
    if (promptLines.length === 0) {
      setBatchError('请至少输入 1 条提示词，每行一条。');
      return;
    }
    if (promptLines.length > MAX_PROMPTS) {
      setBatchError(`最多 ${MAX_PROMPTS} 条提示词。`);
      return;
    }
    if (platforms.length === 0) {
      setBatchError('请至少选择一个平台。');
      return;
    }
    if (totalItems > MAX_ITEMS) {
      setBatchError(`一次最多 ${MAX_ITEMS} 个作品（提示词 × 平台）。`);
      return;
    }
    // One stable key per submit attempt: a timed-out retry returns the same job
    // instead of creating duplicates.
    if (!clientBatchId.current) clientBatchId.current = crypto.randomUUID();
    setSubmitting(true);
    setBatchError('');
    try {
      const data = await api<{ item: BatchJob }>(`/projects/${item?.id}/batch-jobs`, {
        method: 'POST',
        body: { prompts: promptLines, platforms, clientBatchId: clientBatchId.current },
      });
      clientBatchId.current = '';
      lastJobStatus.current = '';
      setJob(data.item);
      setJobs((current) => [data.item, ...current.filter((entry) => entry.id !== data.item.id)]);
    } catch (err) {
      setBatchError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelJob() {
    if (!job) return;
    try {
      const data = await api<{ item: BatchJob }>(
        `/projects/${item?.id}/batch-jobs/${job.id}/cancel`,
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
        `/projects/${item?.id}/batch-jobs/${job.id}/retry`,
        { method: 'POST', body: {} },
      );
      lastJobStatus.current = '';
      setJob(data.item);
      setJobs((current) => [data.item, ...current]);
    } catch (err) {
      setBatchError(errorText(err));
    } finally {retrying.current=false;setRetryBusy(false);}
  }

  if (loading && !item) return <p role="status" className="page-loading">正在打开项目…</p>;
  if (!item) {
    return (
      <section className="account-gate">
        <h1>暂时打不开这个项目</h1>
        <p role="alert">{error || '项目不存在或已删除。'}</p>
        <a className="btn btn-secondary" href="#/projects">返回项目列表</a>
      </section>
    );
  }

  const canRetry = job !== null && isTerminal(job.status) && /failed|interrupted|cancelled|partial/.test(job.status);
  const running = job !== null && !isTerminal(job.status);

  return (
    <div className="projects-shell projects-detail">
      <p className="projects-back"><a className="text-link" href="#/projects"><IconArrowLeft size={15} /> 返回项目列表</a></p>
      <header className="projects-heading">
        <div>
          <span className="account-kicker">PROJECT</span>
          <h1>{item.name}</h1>
          <p>{PLATFORM_LABELS[item.platform]} · {scenes.length} 个作品 · 版本 {item.revision}</p>
        </div>
      </header>

      {error && <div role="alert" className="account-error projects-error">{error}</div>}

      <div className="projects-columns">
        <section className="project-panel">
          <h2><IconSettings size={18} /> 项目规则</h2>
          {conflict && (
            <div className="account-error" role="alert">
              项目已在其他标签页更新。当前修改仍保留，请重新加载后再保存。
              <button onClick={() => { if(window.confirm("重新加载会放弃当前未保存的项目规则，继续？")){initializedProject.current="";setReload((value)=>value+1);} }}>重新加载</button>
            </div>
          )}
          <form className="project-form" onSubmit={save}><fieldset disabled={busy} style={{border:0,padding:0,margin:0}}>
            <label>
              名称
              <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              默认平台
              <select value={platform} onChange={(event) => setPlatform(event.target.value as Platform)}>
                {PLATFORMS.map((value) => (
                  <option key={value} value={value}>{PLATFORM_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label>
              规则（最多 4000 字）
              <textarea
                value={rules}
                maxLength={4000}
                rows={5}
                placeholder="规则会作为独立说明提供给生成任务，不会写入你的作品。"
                onChange={(event) => setRules(event.target.value)}
              />
            </label>
            <div className="project-form-actions">
              <button className="btn btn-primary" disabled={busy || !dirty}>
                <IconDeviceFloppy size={16} /> {busy ? '正在保存…' : '保存项目'}
              </button>
              {status && <span className="project-status" role="status">{status}</span>}
            </div>
          </fieldset></form>
        </section>

        <section className="project-panel">
          <h2><IconLayoutGrid size={18} /> 项目作品 <span>{scenes.length}</span></h2>
          {scenes.length === 0 ? (
            <p className="project-muted">还没有作品。可以在下方批量生成，或从「我的作品」中关联已有作品。</p>
          ) : (
            <ul className="project-scene-list">
              {scenes.map((scene) => (
                <li key={scene.id}>
                  <a href={`#/workspace?scene=${encodeURIComponent(scene.id)}`}>
                    <strong>{scene.title || '未命名对话'}</strong>
                    <small>{PLATFORM_LABELS[scene.platform]} · {scene.messageCount} 条消息</small>
                  </a>
                  <button
                    className="icon-btn"
                    aria-label={`解除关联 ${scene.title || '未命名对话'}`}
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
              关联已有作品
              <select value={attachId} onChange={(event) => setAttachId(event.target.value)}>
                <option value="">选择我的作品…</option>
                {attachable.map((scene) => (
                  <option key={scene.id} value={scene.id}>{scene.title || '未命名对话'}</option>
                ))}
              </select>
            </label>
            <button className="btn btn-secondary" disabled={!attachId || attaching}>
              {attaching ? <IconLoader2 size={15} className="projects-spin" /> : <IconPlus size={15} />} 关联
            </button>
          </form>
        </section>
      </div>

      <section className="project-panel project-batch">
        <h2><IconRefresh size={18} /> 批量生成</h2>
        <p className="project-muted">
          每行一条提示词，最多 {MAX_PROMPTS} 条；提示词 × 平台最多 {MAX_ITEMS} 个作品。规则和平台会在提交时快照。
        </p>
        <form onSubmit={startBatch}>
          <label>
            提示词（每行一条）
            <textarea
              value={promptsText}
              rows={4}
              placeholder={'和朋友约周末去看展，聊得轻松一点\n写一段新品发布的群聊预告'}
              onChange={(event) => setPromptsText(event.target.value)}
            />
          </label>
          <fieldset className="project-platforms">
            <legend>平台</legend>
            {PLATFORMS.map((value) => (
              <label key={value} className="project-checkbox">
                <input type="checkbox" checked={platforms.includes(value)} onChange={() => togglePlatform(value)} />
                {PLATFORM_LABELS[value]}
              </label>
            ))}
          </fieldset>
          <div className="project-form-actions">
            <button className="btn btn-primary" disabled={submitting || running}>
              {submitting ? <IconLoader2 size={16} className="projects-spin" /> : <IconPlus size={16} />}
              {submitting ? '正在提交…' : running ? '已有任务进行中' : `生成 ${promptLines.length && platforms.length ? totalItems : 0} 个作品`}
            </button>
            <span className="project-status">提示词 {promptLines.length}/{MAX_PROMPTS} · 作品 {totalItems}/{MAX_ITEMS}</span>
          </div>
          {batchError && <p className="account-error" role="alert">{batchError}</p>}
        </form>

        {job && (
          <div className="project-job">
            <div className="project-job-head">
              <strong>任务 {JOB_STATUS_LABELS[job.status]}</strong>
              <span>{job.succeeded} 成功 · {job.failed} 失败 · 共 {job.total}</span>
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
                    <span className="task-text">{task.prompt}</span>
                    <span className="task-platform">{PLATFORM_LABELS[task.platform]}</span>
                    <span className="task-status">
                      {task.status === 'done' && task.sceneId ? (
                        <a href={`#/workspace?scene=${encodeURIComponent(task.sceneId)}`}>
                          <IconCheck size={14} /> 打开作品
                        </a>
                      ) : (
                        TASK_STATUS_LABELS[task.status]
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="project-form-actions">
              {running && (
                <button className="btn btn-secondary" onClick={cancelJob} type="button">
                  <IconPlayerStop size={16} /> 取消生成
                </button>
              )}
              {canRetry && (
                <button className="btn btn-secondary" onClick={retryJob} disabled={retryBusy} type="button">
                  <IconRefresh size={16} /> 重试失败项
                </button>
              )}
            </div>
          </div>
        )}

        {jobs.length > 1 && (
          <details className="project-history">
            <summary>历史任务（{jobs.length}）</summary>
            <ul>
              {jobs.map((entry) => (
                <li key={entry.id}>
                  <span>{JOB_STATUS_LABELS[entry.status]}</span>
                  <span>{entry.succeeded} 成功 · {entry.failed} 失败 · 共 {entry.total}</span>
                  <button className="text-link" type="button" onClick={async () => {
                    const data = await api<{ item: BatchJob }>(`/projects/${item.id}/batch-jobs/${entry.id}`);
                    lastJobStatus.current = '';
                    setJob(data.item);
                  }}>查看</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="project-panel project-warning">
        <h2><IconAlertTriangle size={18} /> 关于批量生成</h2>
        <p>
          只有模型完整生成并通过校验的作品才会作为新作品保存；失败、取消或服务重启中断的任务会如实记录，不会伪装成成功。
          项目删除只解除关联，不会删除作品。
        </p>
        <p><a className="text-link" href="#/workspace">在我的作品中管理全部作品 <IconArrowRight size={15} /></a></p>
      </section>
    </div>
  );
}

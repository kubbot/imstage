/**
 * Project → Scenario → Cases panel (primary workflow, first viewport).
 *
 * Owns the full batch-C workflow on the project detail page:
 *   - scenario creation (name/brief/preset, 50 default of 1–100, the shared
 *     7-platform previews + watermark, locale, autoExport default on) with the
 *     current module's platform/watermark/language inherited ONLY until the
 *     user touches the form (pristine/dirty guard);
 *   - the meaningful case plan (stable keys, objective/context/variation,
 *     submitted scene links, missing keys) with ≤20 rendered case rows per
 *     page and filter — never 50 previews at once;
 *   - explicit "AI 生成案例" (existing paid Web generator, persisted jobs,
 *     runs without the tab open) strictly separated from "导出文件"
 *     (deterministic server delivery). Nothing runs on page open. The
 *     evaluation-dataset block uses the SELECTED scenario's frozen recipe.
 *   - real generation/export progress with retry-missing-only, cancel,
 *     truthful errors, and downloads only for real completed or explicitly
 *     partial validated bundles; expired bundles are disabled and renew with
 *     the ORIGINAL scope; current packs stay downloadable outside the bounded
 *     history list and are visually distinguished from historical ones.
 *
 * Polling is bounded: fast only while a generation/export is active, a modest
 * poll + on-focus refresh while cases are pending (MCP-side progress shows up
 * without any Web job), and nothing after completion. Async loads are scoped to
 * the current selection so a stale response never overwrites another
 * scenario's state. No fake thumbnails or ZIP links are ever rendered.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  IconAlertTriangle,
  IconDownload,
  IconLoader2,
  IconPlayerStop,
  IconPlus,
  IconRefresh,
  IconSparkles,
  IconZip,
} from '@tabler/icons-react';
import {
  api,
  errorText,
  type CaseItem,
  type CasePlanEntry,
  type GenerationStatus,
  type GenerationView,
  type ProjectDeliverySummary,
  type ProjectExportItem,
  type ProjectType,
  type ScenarioDetail,
  type ScenarioSummary,
} from '../account/api';
import { type Platform } from '../studio/model';
import { PlatformCards } from './PlatformTemplatePicker';
import { useScenarioCopy } from './scenarioCopy';
import { useCopy } from '../i18n';
import { localizeRecipeText } from '../../../../packages/schema/project-recipes.mjs';

const CASES_PER_PAGE = 20;
const ACTIVE_POLL_MS = 2_000;
const PENDING_POLL_MS = 10_000;
const EXPORT_ACTIVE_POLL_MS = 2_500;

type CaseFilter = 'all' | 'pending' | 'submitted';

export interface ScenarioPanelProjectDefaults {
  platform: Platform;
  watermarkEnabled: boolean;
  language?: string;
}

export function ProjectScenarioPanel({ projectId, recipeType, recipeLabel, syncBlocked, projectDefaults, onContentChange }: {
  projectId: string;
  /** Current module recipe (new scenarios); the selected scenario stays frozen. */
  recipeType: ProjectType;
  recipeLabel: string;
  syncBlocked: boolean;
  projectDefaults: ScenarioPanelProjectDefaults;
  onContentChange?: () => void;
}) {
  const s = useScenarioCopy();
  const copy = useCopy().projects;
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<ScenarioDetail | null>(null);
  const [generation, setGeneration] = useState<GenerationStatus | null>(null);
  const [delivery, setDelivery] = useState<ProjectDeliverySummary | null>(null);
  const [history, setHistory] = useState<ProjectExportItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reload, setReload] = useState(0);

  // scenario creation form
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [preset, setPreset] = useState('friendship');
  const [caseCount, setCaseCount] = useState(50);
  const [platform, setPlatform] = useState<Platform>(projectDefaults.platform);
  const [locale, setLocale] = useState(projectDefaults.language ?? 'zh-CN');
  const [autoExport, setAutoExport] = useState(true);
  const [watermarkEnabled, setWatermarkEnabled] = useState(projectDefaults.watermarkEnabled);

  const [filter, setFilter] = useState<CaseFilter>('all');
  const [page, setPage] = useState(1);
  const [allowPartial, setAllowPartial] = useState(false);
  const [exportScope, setExportScope] = useState<'scenario' | 'project'>('scenario');

  // Request keys are bound to the complete immutable request snapshot: a retry
  // of the SAME uncertain request reuses its key (never double-pay), a new
  // intent (other scenario / retry / scope / options) gets a new key.
  const requestKeys = useRef<Record<string, { key: string; sig: string }>>({});
  function keyFor(kind: string, sig: string): string {
    const current = requestKeys.current[kind];
    if (current && current.sig === sig) return current.key;
    const key = crypto.randomUUID();
    requestKeys.current[kind] = { key, sig };
    return key;
  }
  function settleKey(kind: string) {
    delete requestKeys.current[kind];
  }

  // Pristine/dirty guard: async initial loads and module edits never overwrite
  // the user's explicit form choices.
  const touched = useRef({ platform: false, watermark: false, language: false });
  useEffect(() => {
    if (!touched.current.platform) setPlatform(projectDefaults.platform);
    if (!touched.current.watermark) setWatermarkEnabled(projectDefaults.watermarkEnabled);
    if (!touched.current.language) setLocale(projectDefaults.language ?? 'zh-CN');
  }, [projectDefaults.platform, projectDefaults.watermarkEnabled, projectDefaults.language]);

  // Async loads are scoped to the current selection: a slow response for a
  // previously selected scenario never overwrites the current one.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const mountedRef = useRef(true);
  const readSequence = useRef({ scenarios: 0, detail: 0, generation: 0, delivery: 0 });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const key of ['scenarios', 'detail', 'generation', 'delivery'] as const) readSequence.current[key] += 1;
    };
  }, []);

  /* ---------------- data ---------------- */

  const loadScenarios = useCallback(async () => {
    const sequence = ++readSequence.current.scenarios;
    const data = await api<{ items: ScenarioSummary[] }>(`/projects/${encodeURIComponent(projectId)}/scenarios`);
    if (!mountedRef.current || sequence !== readSequence.current.scenarios) return data.items;
    setScenarios(data.items);
    setSelectedId((current) => current || data.items[0]?.scenarioId || '');
    return data.items;
  }, [projectId]);

  const loadDetail = useCallback(async (scenarioId: string) => {
    const sequence = ++readSequence.current.detail;
    if (!scenarioId) { setDetail(null); return; }
    const data = await api<ScenarioDetail>(`/projects/${encodeURIComponent(projectId)}/scenarios/${encodeURIComponent(scenarioId)}`);
    if (!mountedRef.current || selectedRef.current !== scenarioId || sequence !== readSequence.current.detail) return;
    setDetail(data);
  }, [projectId]);

  const loadGeneration = useCallback(async (scenarioId: string) => {
    const sequence = ++readSequence.current.generation;
    if (!scenarioId) { setGeneration(null); return; }
    const data = await api<GenerationStatus>(`/projects/${encodeURIComponent(projectId)}/scenarios/${encodeURIComponent(scenarioId)}/generation`);
    if (!mountedRef.current || selectedRef.current !== scenarioId || sequence !== readSequence.current.generation) return;
    setGeneration(data);
  }, [projectId]);

  const loadDelivery = useCallback(async () => {
    const sequence = ++readSequence.current.delivery;
    const [status, list] = await Promise.all([
      api<{ delivery: ProjectDeliverySummary }>(`/projects/${encodeURIComponent(projectId)}/status`),
      api<{ items: ProjectExportItem[] }>(`/projects/${encodeURIComponent(projectId)}/exports`),
    ]);
    if (!mountedRef.current || sequence !== readSequence.current.delivery) return;
    setDelivery(status.delivery);
    setHistory(list.items);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setError('');
    Promise.all([loadScenarios(), loadDelivery()])
      .catch((err) => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [loadScenarios, loadDelivery, reload]);

  useEffect(() => {
    let cancelled = false;
    setError('');
    Promise.all([loadDetail(selectedId), loadGeneration(selectedId)])
      .catch((err) => { if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [selectedId, loadDetail, loadGeneration, reload]);

  const activeGeneration = generation?.active && ['queued', 'running'].includes(generation.active.status)
    ? generation.active
    : null;
  const lastGeneration = generation?.generation ?? null;
  const activeExports = (delivery?.currentExports ?? []).filter((item) => ['queued', 'running'].includes(item.status))
    .concat(history.filter((item) => ['queued', 'running'].includes(item.status) && !(delivery?.currentExports ?? []).some((entry) => entry.exportId === item.exportId)));
  const pendingCases = (detail?.counts.missing ?? 0) > 0;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  const lastSubmittedRef = useRef(-1);

  // Bounded polling: fast only while a generation/export is active; a modest
  // poll plus on-focus refresh while cases are pending (MCP progress shows up
  // without any Web job); nothing to poll after completion. Scenario tab
  // counts refresh too, so MCP-side completion never leaves a stale 0/50.
  useEffect(() => {
    const refresh = () => {
      if (!selectedId) return;
      Promise.all([loadScenarios(), loadDetail(selectedId), loadGeneration(selectedId), loadDelivery()])
        .then(() => {
          const submitted = detailRef.current?.counts.submitted ?? -1;
          if (submitted !== lastSubmittedRef.current) {
            lastSubmittedRef.current = submitted;
            onContentChangeRef.current?.();
          }
        })
        .catch(() => { /* keep last state */ });
    };
    window.addEventListener('focus', refresh);
    let timer: ReturnType<typeof setInterval> | undefined;
    if (activeGeneration) timer = setInterval(refresh, ACTIVE_POLL_MS);
    else if (activeExports.length > 0) timer = setInterval(refresh, EXPORT_ACTIVE_POLL_MS);
    else if (pendingCases) timer = setInterval(refresh, PENDING_POLL_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, Boolean(activeGeneration), activeExports.length, pendingCases, loadScenarios, loadDetail, loadGeneration, loadDelivery]);

  const detailRef = useRef(detail);
  detailRef.current = detail;

  /* ---------------- scenario creation ---------------- */

  async function createScenario(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (name.trim() === '') { setError(s.scenarioNeedName); return; }
    if (syncBlocked) return;
    setBusy('scenario');
    setError('');
    try {
      const data = await api<{ scenario: { scenarioId: string } }>(`/projects/${encodeURIComponent(projectId)}/scenarios`, {
        method: 'POST',
        body: {
          scenario: {
            name: name.trim(),
            brief: brief.trim(),
            preset,
            caseCount,
            platform,
            locale,
            autoExport,
            watermarkEnabled,
          },
        },
      });
      setName('');
      setBrief('');
      setSelectedId(data.scenario.scenarioId);
      setReload((value) => value + 1);
      onContentChangeRef.current?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  /* ---------------- AI generation (explicit click only) ---------------- */

  // The SELECTED scenario's frozen recipe decides the block — a module type
  // change never unlocks/locks existing scenarios.
  const selectedRecipe = detail?.scenario.recipeType ?? recipeType;
  const evaluationBlocked = selectedRecipe === 'evaluation_dataset';
  const canGenerate = !syncBlocked && !activeGeneration && !evaluationBlocked && (detail?.counts.missing ?? 0) > 0;

  async function startGeneration(mode: 'generate' | 'retry') {
    if ((mode === 'generate' && !canGenerate) || busy) return;
    if (mode === 'retry' && (syncBlocked || evaluationBlocked)) return;
    const sig = JSON.stringify({ op: mode, scenarioId: selectedId, sourceGenerationId: mode === 'retry' ? lastGeneration?.generationId ?? null : null });
    const idempotencyKey = keyFor('generation', sig);
    setBusy(mode);
    setError('');
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/scenarios/${encodeURIComponent(selectedId)}/generation${mode === 'retry' ? '/retry' : ''}`, {
        method: 'POST',
        body: {
          ...(mode === 'retry' && lastGeneration?.generationId ? { generationId: lastGeneration.generationId } : {}),
          idempotencyKey,
        },
      });
      settleKey('generation');
      setReload((value) => value + 1);
      onContentChangeRef.current?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function cancelGeneration() {
    if (!activeGeneration || busy) return;
    setBusy('cancel');
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/scenarios/${encodeURIComponent(selectedId)}/generation/cancel`, {
        method: 'POST',
        body: { generationId: activeGeneration.generationId },
      });
      setReload((value) => value + 1);
      onContentChangeRef.current?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  /* ---------------- deterministic exports ---------------- */

  function exportSnapshot(scope: 'scenario' | 'project', partial: boolean, scenarioId: string) {
    return JSON.stringify({ op: 'export', projectId, scenarioId: scope === 'scenario' ? scenarioId : null, allowPartial: partial });
  }

  async function startExport(scope: 'scenario' | 'project' = exportScope, partial: boolean = allowPartial, scenarioId: string = selectedId) {
    if (busy || syncBlocked) return;
    if (scope === 'scenario' && !scenarioId) return;
    const idempotencyKey = keyFor('export', exportSnapshot(scope, partial, scenarioId));
    setBusy('export');
    setError('');
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/exports`, {
        method: 'POST',
        body: {
          ...(scope === 'scenario' ? { scenarioId } : {}),
          allowPartial: partial,
          idempotencyKey,
        },
      });
      settleKey('export');
      setReload((value) => value + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  async function exportAction(item: ProjectExportItem, action: 'retry' | 'cancel') {
    if (busy) return;
    setBusy(`export-${action}-${item.exportId}`);
    setError('');
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/exports/${item.exportId}/${action}`, { method: 'POST', body: {} });
      setReload((value) => value + 1);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy('');
    }
  }

  /** Renew keeps the ORIGINAL scope (whole project vs single scenario). */
  function renew(item: ProjectExportItem) {
    setExportScope(item.scenarioId ? 'scenario' : 'project');
    void startExport(item.scenarioId ? 'scenario' : 'project', item.status === 'partial', item.scenarioId ?? '');
  }

  /* ---------------- derived lists ---------------- */

  const planByKey = useMemo(() => {
    const map = new Map<string, CasePlanEntry>();
    for (const entry of detail?.casePlan.cases ?? []) map.set(entry.itemKey, entry);
    return map;
  }, [detail]);

  const filteredCases = useMemo(() => {
    const cases = detail?.cases ?? [];
    if (filter === 'pending') return cases.filter((item) => !item.submitted);
    if (filter === 'submitted') return cases.filter((item) => item.submitted);
    return cases;
  }, [detail, filter]);

  const pages = Math.max(1, Math.ceil(filteredCases.length / CASES_PER_PAGE));
  const currentPage = Math.min(page, pages);
  const visibleCases = filteredCases.slice((currentPage - 1) * CASES_PER_PAGE, currentPage * CASES_PER_PAGE);

  // Real packages only: current unexpired packs first, then bounded history —
  // a current pack outside the first history page stays downloadable.
  const currentIds = new Set((delivery?.currentExports ?? []).map((item) => item.exportId));
  const rows: Array<{ item: ProjectExportItem; kind: 'current' | 'history' }> = [];
  for (const item of delivery?.currentExports ?? []) rows.push({ item, kind: 'current' });
  if (delivery?.current && !currentIds.has(delivery.current.exportId)) {
    rows.push({ item: delivery.current, kind: 'current' });
    currentIds.add(delivery.current.exportId);
  }
  for (const item of history) {
    if (currentIds.has(item.exportId)) continue;
    rows.push({ item, kind: 'history' });
  }
  const activeExporting = activeExports.length > 0;

  return (
    <section className="project-panel project-scenarios" aria-label={s.scenarioLegend}>
      <h2><IconSparkles size={18} /> {s.hierarchy}</h2>
      <p className="project-muted">{s.projectLabel}: {recipeLabel}</p>

      {/* -------- create scenario -------- */}
      <form className="scenario-create" onSubmit={createScenario}>
        <h3>{s.scenarioNew}</h3>
        <label>
          {s.scenarioName}
          <input
            value={name}
            maxLength={80}
            placeholder={s.scenarioNamePlaceholder}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {s.scenarioBrief}
          <textarea
            value={brief}
            rows={2}
            maxLength={4000}
            placeholder={s.scenarioBriefPlaceholder}
            onChange={(event) => setBrief(event.target.value)}
          />
        </label>
        <div className="scenario-form-row">
          <label>
            {s.scenarioPreset}
            <select aria-label={s.scenarioPreset} value={preset} onChange={(event) => setPreset(event.target.value)}>
              <option value="friendship">friendship</option>
              <option value="support">support</option>
              <option value="teaching">teaching</option>
              <option value="story">story</option>
              <option value="custom">custom</option>
            </select>
          </label>
          <label>
            {s.scenarioCaseCount}
            <input
              aria-label={s.scenarioCaseCount}
              type="number"
              min={1}
              max={100}
              value={caseCount}
              onChange={(event) => setCaseCount(Math.max(1, Math.min(100, Number(event.target.value) || 1)))}
            />
          </label>
          <label>
            {s.scenarioLocale}
            <select
              aria-label={s.scenarioLocale}
              value={locale}
              onChange={(event) => { touched.current.language = true; setLocale(event.target.value); }}
            >
              <option value="zh-CN">zh-CN</option>
              <option value="en">en</option>
            </select>
          </label>
        </div>
        <p className="project-muted">{s.scenarioCaseCountHint}</p>
        <label className="project-watermark-toggle">
          <input
            type="checkbox"
            checked={autoExport}
            onChange={(event) => setAutoExport(event.target.checked)}
          />
          {s.scenarioAutoExport}
        </label>
        <p className="project-muted">{s.scenarioAutoExportHelp}</p>
        <label className="project-watermark-toggle">
          <input
            type="checkbox"
            checked={watermarkEnabled}
            onChange={(event) => { touched.current.watermark = true; setWatermarkEnabled(event.target.checked); }}
          />
          {copy.watermarkToggle}
        </label>
        <PlatformCards
          group="scenario-create-template"
          value={platform}
          watermarkEnabled={watermarkEnabled}
          onChange={(next) => { touched.current.platform = true; setPlatform(next); }}
          copy={copy}
        />
        <button className="btn btn-primary" disabled={busy !== '' || name.trim() === '' || syncBlocked}>
          {busy === 'scenario' ? <IconLoader2 size={16} className="projects-spin" /> : <IconPlus size={16} />}
          {busy === 'scenario' ? s.scenarioSubmitting : s.scenarioSubmit}
        </button>
        {syncBlocked && <p className="project-muted scenario-sync-note">{copy.batchBlockedSync}</p>}
      </form>

      {/* -------- scenario list (honest selection buttons) -------- */}
      {scenarios.length === 0 ? (
        <p className="project-muted">{s.scenarioEmpty}</p>
      ) : (
        <ul className="scenario-list">
          {scenarios.map((item) => (
            <li key={item.scenarioId}>
              <button
                type="button"
                aria-pressed={item.scenarioId === selectedId}
                className={`scenario-tab${item.scenarioId === selectedId ? ' is-selected' : ''}`}
                onClick={() => { setSelectedId(item.scenarioId); setPage(1); }}
              >
                <strong>{item.name}</strong>
                <small>
                  {s.scenarioProgress(item.submitted, item.caseCount)} ·{' '}
                  {item.contentStatus === 'ready' ? s.scenarioStatusReady : s.scenarioStatusCollecting}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <div role="alert" className="account-error projects-error">{error}</div>}

      {/* -------- generation + delivery -------- */}
      {detail && (
        <>
          <div className="scenario-actions">
            <div className="scenario-action-group">
              <strong>{s.aiLegend}</strong>
              <p className="project-muted">{s.aiHint} {s.aiUsageNote}</p>
              {evaluationBlocked && <p className="project-muted" role="note">{s.aiEvaluationBlocked}</p>}
              <div className="project-form-actions">
                <button
                  className="btn btn-primary"
                  disabled={!canGenerate || busy !== ''}
                  onClick={() => void startGeneration('generate')}
                >
                  {busy === 'generate' ? <IconLoader2 size={16} className="projects-spin" /> : <IconSparkles size={16} />}
                  {activeGeneration ? s.aiGenerating : s.aiGenerate}
                </button>
                {activeGeneration && (
                  <button className="btn btn-secondary" disabled={busy !== ''} onClick={() => void cancelGeneration()}>
                    <IconPlayerStop size={16} /> {s.aiCancel}
                  </button>
                )}
                {!activeGeneration && detail.counts.missing > 0 && lastGeneration && (
                  <button className="btn btn-secondary" disabled={busy !== '' || syncBlocked || evaluationBlocked} onClick={() => void startGeneration('retry')}>
                    <IconRefresh size={16} /> {s.aiRetryMissing}
                  </button>
                )}
              </div>
              {(() => {
                const shown: GenerationView | null = activeGeneration ?? lastGeneration;
                if (!shown) return null;
                return (
                  <p className="project-status" role="status">
                    {s.aiStatus[shown.status] ?? shown.status} · {s.aiProgress(shown.done, shown.failed, shown.caseTotal)}
                    {shown.pending > 0 && ` · ${s.aiPending(shown.pending)}`}
                  </p>
                );
              })()}
              {(() => {
                const shown: GenerationView | null = activeGeneration ?? lastGeneration;
                if (!shown?.failures?.length) return null;
                return (
                  <ul className="scenario-failures">
                    {shown.failures.slice(0, 5).map((failure) => (
                      <li key={failure.itemKey}>
                        <IconAlertTriangle size={13} /> {failure.itemKey}: {failure.error ?? failure.errorCode}
                      </li>
                    ))}
                  </ul>
                );
              })()}
            </div>

            <div className="scenario-action-group">
              <strong>{s.exportLegend}</strong>
              <p className="project-muted">{s.exportReadyHint} {s.exportCoverageNote}</p>
              <div className="project-batch-mode" role="group" aria-label={s.exportLegend}>
                <button type="button" aria-pressed={exportScope === 'scenario'} onClick={() => setExportScope('scenario')}>{s.exportScopeScenario}</button>
                <button type="button" aria-pressed={exportScope === 'project'} onClick={() => setExportScope('project')}>{s.exportScopeProject}</button>
              </div>
              <label className="project-watermark-toggle">
                <input type="checkbox" checked={allowPartial} onChange={(event) => setAllowPartial(event.target.checked)} />
                {s.exportPartialTag} ({s.exportMissing(detail.counts.missing)})
              </label>
              <div className="project-form-actions">
                <button className="btn btn-primary" disabled={busy !== '' || syncBlocked || activeExporting} onClick={() => void startExport()}>
                  {busy === 'export' ? <IconLoader2 size={16} className="projects-spin" /> : <IconZip size={16} />}
                  {activeExporting ? s.exportExporting : s.exportNow}
                </button>
              </div>
            </div>
          </div>

          {/* -------- real packages: current + history, never one fake ZIP -------- */}
          {rows.length === 0 ? (
            <p className="project-muted">{s.exportEmpty}</p>
          ) : (
            <ul className="scenario-exports">
              {rows.map(({ item, kind }) => {
                const downloadAllowed = item.delivery.available && ['completed', 'partial'].includes(item.status);
                const expired = item.delivery.state === 'expired'
                  || (item.delivery.expiresAt !== null && item.delivery.expiresAt !== undefined && Date.parse(item.delivery.expiresAt) <= Date.now());
                return (
                  <li key={item.exportId} className={`scenario-export-row scenario-export-${kind}`}>
                    <span>
                      <b>{kind === 'current' ? s.exportCurrentLabel : s.exportHistory}</b>
                      {' · '}
                      {item.scenarioId ? s.exportScopeScenario : s.exportScopeProject} ·{' '}
                      {s.exportStatus[item.status] ?? item.status}
                      {item.status === 'partial' && ` · ${s.exportPartialTag}`}
                      {item.missingItemKeys.length > 0 && ` · ${s.exportMissing(item.missingItemKeys.length)}`}
                    </span>
                    {downloadAllowed && !expired ? (
                      <a className="btn btn-secondary" href={`/api/projects/${encodeURIComponent(projectId)}/exports/${item.exportId}/download`}>
                        <IconDownload size={15} /> {s.exportDownload}
                        {item.delivery.expiresAt ? ` · ${s.exportExpires(new Date(item.delivery.expiresAt).toLocaleString())}` : ''}
                      </a>
                    ) : expired && ['completed', 'partial'].includes(item.status) ? (
                      <span className="project-muted">
                        {s.exportExpired}{' '}
                        <button type="button" className="text-link" disabled={busy !== '' || syncBlocked} onClick={() => renew(item)}>{s.exportRenew}</button>
                      </span>
                    ) : (
                      <span className="project-muted">{s.exportStatus[item.status] ?? item.status}</span>
                    )}
                    {['failed', 'partial', 'interrupted'].includes(item.status) && (
                      <button type="button" className="text-link" disabled={busy !== ''} onClick={() => void exportAction(item, 'retry')}>
                        {s.exportRetryFailed}
                      </button>
                    )}
                    {['queued', 'running'].includes(item.status) && (
                      <button type="button" className="text-link" disabled={busy !== ''} onClick={() => void exportAction(item, 'cancel')}>
                        {s.exportCancel}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* -------- case plan -------- */}
          <h3>{s.caseLegend} <span>{s.scenarioProgress(detail.counts.submitted, detail.counts.planned)}</span></h3>
          <p className="project-muted">{s.casePlanHint}</p>
          {detail.counts.missing > 0 && (
            <p className="project-muted">
              {s.caseMissingKeys(detail.counts.missing)}: {detail.missingItemKeys.slice(0, 8).join(', ')}
              {detail.missingTruncated ? '…' : ''}
            </p>
          )}
          <div className="project-batch-mode" role="group" aria-label={s.caseFilter}>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => { setFilter('all'); setPage(1); }}>{s.caseFilterAll}</button>
            <button type="button" aria-pressed={filter === 'pending'} onClick={() => { setFilter('pending'); setPage(1); }}>{s.caseFilterPending}</button>
            <button type="button" aria-pressed={filter === 'submitted'} onClick={() => { setFilter('submitted'); setPage(1); }}>{s.caseFilterSubmitted}</button>
          </div>
          {visibleCases.length === 0 ? (
            <p className="project-muted">{s.caseEmpty}</p>
          ) : (
            <ul className="case-list">
              {visibleCases.map((item: CaseItem) => {
                const plan = planByKey.get(item.itemKey);
                return (
                  <li key={item.itemKey} className={`case-card${item.submitted ? ' is-submitted' : ''}`}>
                    <div className="case-head">
                      <code>{item.itemKey}</code>
                      <strong>{item.name || plan?.name}</strong>
                      <span className={`case-state case-state-${item.submitted ? 'submitted' : 'pending'}`}>
                        {item.submitted ? s.caseSubmitted : s.casePending}
                      </span>
                    </div>
                    <p><b>{s.caseObjective}:</b> {item.objective || plan?.objective}</p>
                    <p><b>{s.caseContext}:</b> {item.context || plan?.context}</p>
                    {plan?.variation && plan.variation.length > 0 && (
                      <p className="case-variation">
                        <b>{s.caseVariation}:</b> {plan.variation.map((entry) => `${localizeRecipeText(entry.label, detail.scenario.locale)}=${localizeRecipeText(entry.value, detail.scenario.locale)}`).join(' · ')}
                      </p>
                    )}
                    {item.submitted && item.sceneId && (
                      <a className="text-link" href={`#/workspace?scene=${encodeURIComponent(item.sceneId)}`}>{s.caseOpenScene}</a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {pages > 1 && (
            <div className="case-pagination">
              <button type="button" className="btn btn-secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>{s.casePrev}</button>
              <span>{s.casePageInfo(currentPage, pages)}</span>
              <button type="button" className="btn btn-secondary" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>{s.caseNext}</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

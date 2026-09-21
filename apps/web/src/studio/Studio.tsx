import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowDown,
  IconArrowForwardUp,
  IconArrowUp,
  IconCircleCheck,
  IconCode,
  IconCopy,
  IconDeviceFloppy,
  IconDownload,
  IconFileDownload,
  IconInfoCircle,
  IconPhotoPlus,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUserPlus,
} from '@tabler/icons-react';
import {
  MESSAGE_TYPES,
  MESSAGE_TYPE_LABELS,
  PLATFORMS,
  PLATFORM_LABELS,
  TEMPLATE_IDS,
  TEMPLATE_LABELS,
  addMessage,
  addParticipant,
  canRedo,
  canUndo,
  cloneScene,
  commit,
  createHistory,
  createScene,
  deleteMessage,
  moveMessage,
  nextMessageId,
  redo,
  resetHistory,
  serializeDraft,
  serializeScene,
  undo,
  updateMessage,
  updateParticipant,
  updateScene,
  type History,
  type MessageType,
  type Platform,
  type Scene,
  type TemplateId,
} from './model';
import { SceneView, initials } from './SceneView';
import {
  DRAFT_KEY,
  clearDraft,
  copyText,
  downloadText,
  loadDraft,
  readImageFile,
  saveDraft,
  slugify,
  waitForImages,
} from './storage';
import './studio.css';

export interface StudioProps {
  initialTemplate?: TemplateId;
  initialScene?: Scene;
  persistLocal?: boolean;
  onSceneChange?: (scene: Scene) => void;
  accountAction?: (scene: Scene) => ReactNode;
}

interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => void;
}

interface Note {
  code: string;
  message: string;
}

type ExportMode = 'standard' | 'full';
type ExportStatus = 'idle' | 'working' | 'error' | 'success';

function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return ref;
}

function useDraftField(value: string, onCommit: (next: string) => void) {
  return { value, onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onCommit(event.target.value) };
}

function messagePreview(scene: Scene, type: MessageType): string {
  if (type === 'system') return '系统提示';
  const participant = scene.participants.find((item) => item.id === scene.selfId);
  return participant?.name ?? '';
}

export default function Studio({ initialTemplate, initialScene, persistLocal = true, onSceneChange, accountAction }: StudioProps) {
  const [initialLoad] = useState(() => persistLocal ? loadDraft() : { status: 'empty' as const, scene: initialScene, raw: undefined, message: undefined });
  const [history, setHistory] = useState<History>(() => createHistory(initialLoad.scene ?? createScene(initialTemplate)));
  const [savePause, setSavePause] = useState<string | null>(initialLoad.status === 'corrupt' ? 'corrupt' : null);
  const uploadGeneration = useRef(0);
  useEffect(() => () => { uploadGeneration.current++; }, []);
  const scene = history.present;
  useEffect(() => { onSceneChange?.(scene); }, [scene, onSceneChange]);

  const [activeTemplate, setActiveTemplate] = useState<TemplateId>(initialTemplate ?? 'weekend');
  const [selectedId, setSelectedId] = useState<string>('');
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [note, setNote] = useState<Note | null>(null);
  const [crossTabRaw, setCrossTabRaw] = useState<string | null>(null);
  const [corruptRaw, setCorruptRaw] = useState<string | null>(null);
  const [imageError, setImageError] = useState('');
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);

  const [exportMode, setExportMode] = useState<ExportMode>('standard');
  const [exportStatus, setExportStatus] = useState<ExportStatus>('idle');
  const [exportMessage, setExportMessage] = useState('');
  const [exportScene, setExportScene] = useState<Scene | null>(null);
  const [exporting, setExporting] = useState(false);
  const [cropWarning, setCropWarning] = useState(false);

  const [composerText, setComposerText] = useState('');
  const [composerType, setComposerType] = useState<MessageType>('text');
  const [composerSender, setComposerSender] = useState('');
  const [composerTime, setComposerTime] = useState('');
  const [composerAsset, setComposerAsset] = useState('');

  const savedRawRef = useRef<string>(initialLoad.raw ?? '');
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const pendingAvatarIdRef = useRef<string>('');
  const selectedImageRef = useRef<HTMLInputElement>(null);
  const composerImageRef = useRef<HTMLInputElement>(null);
  const stageRootRef = useRef<HTMLDivElement>(null);
  const standardFrameRef = useRef<HTMLDivElement>(null);

  const mutate = useCallback((updater: (current: Scene) => Scene) => {
    uploadGeneration.current++;
    setSavePause(pause => pause === 'cleared' ? null : pause);
    setHistory((current) => commit(current, updater(current.present)));
  }, []);

  /* ---------------------------------------------------------------- */
  /* Draft lifecycle                                                   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    if (initialLoad.status === 'corrupt') {
      setCorruptRaw(initialLoad.raw ?? null);
      setNote({ code: 'corrupt', message: initialLoad.message ?? '本机草稿无法读取，已暂停自动保存' });
    } else if (initialLoad.status === 'unavailable') {
      setNote({ code: 'unavailable', message: initialLoad.message ?? '本机存储不可用' });
    }
    if (initialTemplate && initialLoad.scene && JSON.stringify(initialLoad.scene) !== JSON.stringify(createScene(initialTemplate))) {
      setSavePause('choice');
      setConfirm({ title: '使用这个场景模板？', body: '当前浏览器有一份草稿。取消会保留原草稿；使用模板后也可以撤销恢复。', confirmLabel: '使用模板', action: () => {
        uploadGeneration.current++;
        setHistory(h => commit(h, createScene(initialTemplate)));
        setSavePause(null);
      }});
    }
    setDraftLoaded(true);
  }, [initialLoad, initialTemplate]);

  useEffect(() => {
    if (!persistLocal || !draftLoaded || savePause) return;
    // Compare before writing as well as listening for cross-tab events.
    try {
      const stored = localStorage.getItem(DRAFT_KEY) ?? '';
      if (stored !== savedRawRef.current) { setCrossTabRaw(stored); setSavePause('conflict'); return; }
    } catch { /* saveDraft reports unavailable storage */ }
    const raw = serializeDraft(scene);
    const result = saveDraft(scene, raw);
    if (result.ok) {
      savedRawRef.current = raw;
      setNote({ code: 'ok', message: '草稿已保存到本机浏览器' });
    } else setNote({ code: result.code, message: result.message });
  }, [scene, draftLoaded, savePause, persistLocal]);

  useEffect(() => {
    if (!persistLocal) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== DRAFT_KEY && event.key !== null) return;
      if ((event.newValue ?? '') === savedRawRef.current) return;
      setCrossTabRaw(event.newValue ?? '');
      setSavePause('conflict');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    setSelectedId((current) => {
      if (current && scene.messages.some((message) => message.id === current)) return current;
      return scene.messages[0]?.id ?? '';
    });
  }, [scene.messages]);

  useEffect(() => {
    const root = stageRootRef.current;
    if (!root) return;
    setCropWarning(root.scrollHeight > 640);
  }, [scene, exportScene]);

  const pristine = useMemo(
    () => JSON.stringify(scene) === JSON.stringify(createScene(activeTemplate)),
    [scene, activeTemplate],
  );

  const selected = scene.messages.find((message) => message.id === selectedId) ?? null;
  const composerSenderId = scene.participants.some(p => p.id === composerSender) ? composerSender : scene.selfId;

  const titleField = useDraftField(scene.title, (next) => mutate((s) => updateScene(s, { title: next })));
  const deviceTimeField = useDraftField(scene.deviceTime, (next) =>
    mutate((s) => updateScene(s, { deviceTime: next })),
  );
  const dateField = useDraftField(scene.date, (next) => mutate((s) => updateScene(s, { date: next })));
  const watermarkField = useDraftField(scene.watermark, (next) =>
    mutate((s) => updateScene(s, { watermark: next })),
  );
  const messageTextField = useDraftField(selected?.text ?? '', (next) => {
    if (!selectedId) return;
    mutate((s) => updateMessage(s, selectedId, { text: next }));
  });
  const messageTimeField = useDraftField(selected?.time ?? '', (next) => {
    if (!selectedId) return;
    mutate((s) => updateMessage(s, selectedId, { time: next }));
  });

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  const applyScene = (next: Scene) => {
    uploadGeneration.current++;
    setComposerSender(''); setComposerTime(''); setComposerText(''); setComposerAsset(''); setImageError('');
    setSavePause(pause => pause === 'cleared' ? null : pause);
    setHistory((current) => commit(current, next));
  };

  const runConfirmed = (next: ConfirmState) => setConfirm(next);

  const requestTemplate = (template: TemplateId) => {
    const run = () => {
      const next = createScene(template);
      applyScene(next);
      setActiveTemplate(template);
      setSelectedId(next.messages[0]?.id ?? '');
      setExportStatus('idle');
      setExportMessage('');
    };
    if (!pristine) {
      runConfirmed({
        title: '切换或重置模板',
        body: '这会用模板内容替换当前场景。当前编辑仍可通过“撤销”找回。',
        confirmLabel: '替换场景',
        action: run,
      });
    } else {
      run();
    }
  };

  const requestNewScene = () => {
    const run = () => {
      const next = { ...createScene(activeTemplate), id: `scene-${crypto.randomUUID()}`, title: '未命名场景', messages: [] };
      applyScene(next);
      setSelectedId('');
    };
    if (!pristine) {
      runConfirmed({
        title: '新建场景',
        body: '会创建一个没有消息的空白场景。你可以用“撤销”恢复刚才的编辑。',
        confirmLabel: '新建场景',
        action: run,
      });
    } else {
      run();
    }
  };

  const requestReset = () => {
    runConfirmed({
      title: '重置当前场景',
      body: '会丢弃撤销历史并回到当前模板的示例内容，此操作不可撤销。',
      confirmLabel: '重置',
      danger: true,
      action: () => {
        uploadGeneration.current++;
        setComposerSender(''); setComposerText(''); setComposerAsset('');
        const next = createScene(activeTemplate);
        setHistory(resetHistory(next));
        setSelectedId(next.messages[0]?.id ?? '');
        setExportStatus('idle');
        setExportMessage('');
      },
    });
  };

  const requestClearDraft = () => {
    runConfirmed({
      title: '清除本机草稿',
      body: '只会删除浏览器本地保存的草稿，当前正在编辑的内容仍保留在页面上（可继续撤销）。',
      confirmLabel: '清除草稿',
      danger: true,
      action: () => {
        const result = clearDraft();
        if (result.ok) { setSavePause('cleared'); savedRawRef.current = ''; }
        setNote({ code: result.code, message: result.message });
      },
    });
  };

  const handleImage = async (file: File | undefined, apply: (dataUrl: string) => void) => {
    setImageError('');
    const generation = ++uploadGeneration.current;
    const result = await readImageFile(file);
    if (generation !== uploadGeneration.current) return;
    if (!result.ok) {
      setImageError(result.error);
      return;
    }
    apply(result.dataUrl);
  };

  const addComposerMessage = () => {
    if (composerType === 'image' && !composerAsset) {
      setImageError('请先选择一张 PNG / JPEG / WebP 图片');
      return;
    }
    if (composerType !== 'image' && composerText.trim() === '') {
      setImageError('请输入台词内容');
      return;
    }
    const newId = nextMessageId(scene);
    mutate((current) =>
      addMessage(current, {
        type: composerType,
        text: composerText,
        participantId: composerType === 'system' ? '' : composerSenderId,
        time: composerTime || current.deviceTime,
        asset: composerType === 'image' ? composerAsset : undefined,
      }),
    );
    setSelectedId(newId);
    setComposerText('');
    setComposerAsset('');
    setComposerTime('');
    setImageError('');
  };

  const handleJsonCopy = async () => {
    const ok = await copyText(serializeScene(scene));
    setNote({
      code: ok ? 'ok' : 'error',
      message: ok ? '场景 JSON 已复制到剪贴板' : '复制失败，请手动选择文本复制',
    });
  };

  const handleJsonDownload = () => {
    downloadText(`imstage-${slugify(scene.title)}.json`, serializeScene(scene));
  };

  const handleExport = async (mode: ExportMode = exportMode) => {
    if (exporting) return;
    const snapshot = cloneScene(scene);
    setExportScene(snapshot);
    setExporting(true);
    setExportStatus('working');
    setExportMessage('正在等待图片与字体加载，然后生成 PNG…');
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const root = stageRootRef.current;
      if (!root) throw new Error('导出容器未就绪');
      await waitForImages(root);
      if (document.fonts?.ready) await document.fonts.ready;
      const { toPng } = await import('html-to-image');
      const target = mode === 'standard' ? standardFrameRef.current : stageRootRef.current;
      if (!target) throw new Error('导出目标未就绪');
      const dataUrl = await toPng(target, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: getComputedStyle(root.querySelector('.scene-view')!).backgroundColor,
        skipFonts: true,
      });
      const suffix = mode === 'standard' ? '360x640' : 'long';
      const filename = `imstage-${slugify(snapshot.title)}-${snapshot.platform}-${suffix}.png`;
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setExportStatus('success');
      setExportMessage(`已导出 ${filename}`);
    } catch (error) {
      setExportStatus('error');
      setExportMessage(
        `导出失败，草稿已保留：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setExporting(false);
      setExportScene(null);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  const jsonDialogRef = useDialog(jsonOpen);
  const confirmDialogRef = useDialog(confirm !== null);

  return (
    <div className="studio" data-view={view}>
      <header className="studio-head">
        <div className="studio-heading">
          <h1>对话导演台</h1>
          <p>写好台词，点选画面，把每个细节改到刚刚好。</p>
        </div>
        <div className="studio-toolbar">
          {accountAction?.(scene)}
          <button
            className="studio-btn studio-btn-icon"
            type="button"
            title="撤销"
            aria-label="撤销"
            onClick={() => { uploadGeneration.current++; setSavePause(p => p === 'cleared' ? null : p); setHistory(current => undo(current)); }}
            disabled={!canUndo(history) || exporting}
          >
            <IconArrowBackUp size={17} stroke={1.8} />
          </button>
          <button
            className="studio-btn studio-btn-icon"
            type="button"
            title="重做"
            aria-label="重做"
            onClick={() => { uploadGeneration.current++; setSavePause(p => p === 'cleared' ? null : p); setHistory(current => redo(current)); }}
            disabled={!canRedo(history) || exporting}
          >
            <IconArrowForwardUp size={17} stroke={1.8} />
          </button>
          <button
            className="studio-btn"
            type="button"
            onClick={requestNewScene}
            disabled={exporting}
          >
            <IconPlus size={16} stroke={1.8} />
            新建场景
          </button>
          <button className="studio-btn" type="button" onClick={() => setJsonOpen(true)} disabled={exporting}>
            <IconCode size={16} stroke={1.8} />
            场景 JSON
          </button>
        </div>
      </header>

      <div className="studio-tabs" role="tablist" aria-label="编辑视图切换">
        <button
          className={`studio-tab${view === 'edit' ? ' is-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={view === 'edit'}
          onClick={() => setView('edit')}
        >
          <IconDeviceFloppy size={16} stroke={1.8} /> 编辑
        </button>
        <button
          className={`studio-tab${view === 'preview' ? ' is-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={view === 'preview'}
          onClick={() => setView('preview')}
        >
          <IconPhotoPlus size={16} stroke={1.8} /> 预览
        </button>
      </div>

      <div className="studio-layout">
        <div className="studio-controls" inert={exporting}>
          {crossTabRaw !== null ? (
            <div className="studio-banner studio-banner-warn" role="status">
              <IconAlertTriangle size={16} stroke={1.8} />
              <div>
                <div>另一个标签页更新了本机草稿。已暂停自动保存，请选择要保留哪一份。</div>
                <div className="studio-row" style={{ marginTop: 6 }}>
                  <button
                    className="studio-btn"
                    type="button"
                    onClick={() => {
                      const result = loadDraft();
                      if (result.status === 'ok' && result.scene) {
                        setHistory(resetHistory(result.scene));
                        savedRawRef.current = result.raw ?? serializeDraft(result.scene);
                        setSelectedId(result.scene.messages[0]?.id ?? '');
                        setCrossTabRaw(null); setSavePause(null); uploadGeneration.current++;
                        setNote({ code: 'ok', message: '已重新载入本机草稿' });
                      } else {
                        setNote({
                          code: 'corrupt',
                          message: result.message ?? '无法载入另一个标签页的草稿',
                        });
                      }
                    }}
                  >
                    <IconRefresh size={15} stroke={1.8} />
                    重新载入草稿
                  </button>
                  <button className="studio-btn studio-btn-ghost" type="button" onClick={() => { try { savedRawRef.current = localStorage.getItem(DRAFT_KEY) ?? ''; } catch {} setCrossTabRaw(null); setSavePause(null); }}>
                    保留当前并覆盖
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {note && note.code !== 'ok' ? (
            <div className="studio-banner studio-banner-error" role="alert">
              <IconAlertTriangle size={16} stroke={1.8} />
              <div>
                <div>{note.message}</div>
                <div className="studio-row" style={{ marginTop: 6 }}>
                  <button className="studio-btn" type="button" onClick={handleJsonDownload}>
                    <IconFileDownload size={15} stroke={1.8} />
                    下载场景 JSON
                  </button>
                  {corruptRaw ? (
                    <button
                      className="studio-btn"
                      type="button"
                      onClick={() => {
                        downloadText('imstage-corrupt-draft.json', corruptRaw);
                        setNote({ code: 'corrupt', message: '已下载原始草稿，自动保存仍暂停。' });
                      }}
                    >
                      <IconDownload size={15} stroke={1.8} />
                      下载损坏草稿
                    </button>
                  ) : null}
                  {note.code === 'corrupt' ? (
                    <button
                      className="studio-btn studio-btn-danger"
                      type="button"
                      onClick={() => {
                        runConfirmed({ title: '删除损坏草稿？', body: '请先下载备份。删除后开始保存当前场景。', confirmLabel: '删除并继续', danger: true, action: () => { const result = clearDraft(); if (result.ok) { savedRawRef.current = ''; setCorruptRaw(null); setSavePause(null); } setNote({ code: result.code, message: result.message }); } });
                      }}
                    >
                      <IconTrash size={15} stroke={1.8} />
                      删除损坏草稿
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          <section className="studio-panel">
            <h2 className="studio-panel-title">
              <span>
                <IconInfoCircle size={15} stroke={1.8} />
                模板
              </span>
              {!pristine ? <span className="studio-badge">已修改</span> : null}
            </h2>
            <div className="studio-row">
              {TEMPLATE_IDS.map((template) => (
                <button
                  key={template}
                  className={`studio-btn${template === activeTemplate ? ' studio-btn-primary' : ''}`}
                  type="button"
                  onClick={() => requestTemplate(template)}
                  disabled={exporting}
                >
                  {TEMPLATE_LABELS[template]}
                </button>
              ))}
            </div>
            <p className="studio-hint">
              切换模板会先确认；替换后仍可用撤销找回当前编辑。
            </p>
          </section>





          <details className="studio-panel studio-advanced">
            <summary className="studio-panel-title">
              <span>
                <IconCode size={15} stroke={1.8} />
                消息（{scene.messages.length}）
              </span>
            </summary>
            <div className="studio-msg-list">
              {scene.messages.map((message) => {
                const participant = scene.participants.find((item) => item.id === message.participantId);
                return (
                  <button
                    key={message.id}
                    className={`studio-msg-item${message.id === selectedId ? ' is-selected' : ''}`}
                    type="button"
                    aria-pressed={message.id === selectedId}
                    onClick={() => setSelectedId(message.id)}
                  >
                    <span className="studio-msg-main">
                      <span className="studio-msg-text">
                        {message.type === 'system'
                          ? message.text || '（系统提示）'
                          : `${participant?.name ?? messagePreview(scene, message.type)}：${message.text || `（${MESSAGE_TYPE_LABELS[message.type]}）`}`}
                      </span>
                      <span className="studio-msg-meta">
                        {MESSAGE_TYPE_LABELS[message.type]} · {message.time || '未设置时间'}
                      </span>
                    </span>
                  </button>
                );
              })}
              {scene.messages.length === 0 ? (
                <p className="studio-hint">还没有消息，在下方添加第一条台词。</p>
              ) : null}
            </div>
          </details>

          {selected ? (
            <section className="studio-panel">
              <h2 className="studio-panel-title">
                <span>
                  <IconCode size={15} stroke={1.8} />
                  选中消息
                </span>
                <span className="studio-row">
                  <button
                    className="studio-btn studio-btn-icon"
                    type="button"
                    title="上移"
                    aria-label="上移消息"
                    onClick={() => mutate((s) => moveMessage(s, selected.id, -1))}
                    disabled={exporting}
                  >
                    <IconArrowUp size={16} stroke={1.8} />
                  </button>
                  <button
                    className="studio-btn studio-btn-icon"
                    type="button"
                    title="下移"
                    aria-label="下移消息"
                    onClick={() => mutate((s) => moveMessage(s, selected.id, 1))}
                    disabled={exporting}
                  >
                    <IconArrowDown size={16} stroke={1.8} />
                  </button>
                  <button
                    className="studio-btn studio-btn-icon studio-btn-danger"
                    type="button"
                    title="删除消息"
                    aria-label="删除消息"
                    onClick={() => {
                      mutate((s) => deleteMessage(s, selected.id));
                    }}
                    disabled={exporting}
                  >
                    <IconTrash size={16} stroke={1.8} />
                  </button>
                </span>
              </h2>

              {selected.type !== 'system' ? (
                <label className="studio-field">
                  <span className="studio-label">发送者</span>
                  <select
                    className="studio-select"
                    value={selected.participantId}
                    onChange={(event) =>
                      mutate((s) => updateMessage(s, selected.id, { participantId: event.target.value }))
                    }
                    disabled={exporting}
                  >
                    {scene.participants.map((participant) => (
                      <option key={participant.id} value={participant.id}>
                        {participant.name}
                        {participant.id === scene.selfId ? '（我方）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <div className="studio-grid-2">
                <label className="studio-field">
                  <span className="studio-label">类型</span>
                  <select
                    className="studio-select"
                    value={selected.type}
                    onChange={(event) => {
                      const type = event.target.value as MessageType;
                      mutate((s) =>
                        updateMessage(s, selected.id, {
                          type,
                          participantId: type === 'system' ? '' : s.selfId,
                        }),
                      );
                    }}
                    disabled={exporting}
                  >
                    {MESSAGE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {MESSAGE_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="studio-field">
                  <span className="studio-label">时间</span>
                  <input className="studio-input" {...messageTimeField} disabled={exporting} />
                </label>
              </div>

              <label className="studio-field">
                <span className="studio-label">
                  {selected.type === 'location' ? '地点名称' : '文本内容'}
                </span>
                <textarea className="studio-textarea" {...messageTextField} disabled={exporting} />
              </label>

              {selected.type === 'image' ? (
                <div className="studio-field">
                  <span className="studio-label">图片（PNG / JPEG / WebP，≤4MB）</span>
                  <div className="studio-row">
                    {selected.asset ? (
                      <img className="studio-avatar-preview" src={selected.asset} alt="" />
                    ) : null}
                    <button
                      className="studio-btn"
                      type="button"
                      onClick={() => selectedImageRef.current?.click()}
                      disabled={exporting}
                    >
                      <IconPhotoPlus size={16} stroke={1.8} />
                      {selected.asset ? '更换图片' : '选择图片'}
                    </button>
                    {selected.asset ? (
                      <button
                        className="studio-btn studio-btn-danger"
                        type="button"
                        onClick={() => mutate((s) => updateMessage(s, selected.id, { asset: undefined }))}
                        disabled={exporting}
                      >
                        <IconTrash size={15} stroke={1.8} />
                        移除
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </section>
          ) : (
            <section className="studio-panel">
              <p className="studio-hint">选择上方任意消息即可编辑发送者、类型、时间与文本。</p>
            </section>
          )}

          <section className="studio-panel">
            <h2 className="studio-panel-title">
              <span>
                <IconPlus size={15} stroke={1.8} />
                添加一条台词
              </span>
            </h2>
            <textarea
              className="studio-textarea"
              aria-label="添加一条台词" placeholder="添加一条台词"
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              disabled={exporting}
            />
            <div className="studio-grid-2">
              <label className="studio-field">
                <span className="studio-label">类型</span>
                <select
                  className="studio-select"
                  value={composerType}
                  onChange={(event) => setComposerType(event.target.value as MessageType)}
                  disabled={exporting}
                >
                  {MESSAGE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {MESSAGE_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="studio-field">
                <span className="studio-label">时间</span>
                <input
                  className="studio-input"
                  value={composerTime}
                  placeholder={scene.deviceTime}
                  onChange={(event) => setComposerTime(event.target.value)}
                  disabled={exporting}
                />
              </label>
            </div>
            {composerType !== 'system' ? (
              <label className="studio-field">
                <span className="studio-label">发送者</span>
                <select
                  className="studio-select"
                  value={composerSenderId}
                  onChange={(event) => setComposerSender(event.target.value)}
                  disabled={exporting}
                >
                  {scene.participants.map((participant) => (
                    <option key={participant.id} value={participant.id}>
                      {participant.name}
                      {participant.id === scene.selfId ? '（我方）' : ''}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {composerType === 'image' ? (
              <div className="studio-field">
                <span className="studio-label">图片（PNG / JPEG / WebP，≤4MB）</span>
                <div className="studio-row">
                  {composerAsset ? (
                    <img className="studio-avatar-preview" src={composerAsset} alt="" />
                  ) : null}
                  <button
                    className="studio-btn"
                    type="button"
                    onClick={() => composerImageRef.current?.click()}
                    disabled={exporting}
                  >
                    <IconPhotoPlus size={16} stroke={1.8} />
                    {composerAsset ? '更换图片' : '选择图片'}
                  </button>
                </div>
              </div>
            ) : null}
            {imageError ? (
              <div className="studio-banner studio-banner-error" role="alert">
                <IconAlertTriangle size={16} stroke={1.8} />
                <span>{imageError}</span>
              </div>
            ) : null}
            <p className="studio-hint">
              这是手动编辑器。自然语言和截图创作请进入 Agent 创作台。
            </p>
            <button className="studio-btn studio-btn-primary studio-btn-block" type="button" onClick={addComposerMessage} disabled={exporting}>
              <IconPlus size={16} stroke={1.8} />
              添加这条台词
            </button>
          </section>

          <details className="studio-panel studio-advanced">
            <summary className="studio-panel-title">
              <span>
                <IconDeviceFloppy size={15} stroke={1.8} />
                场景设置
              </span>
            </summary>
            <label className="studio-field">
              <span className="studio-label">场景标题</span>
              <input className="studio-input" {...titleField} disabled={exporting} />
            </label>
            <label className="studio-field">
              <span className="studio-label">平台</span>
              <select
                className="studio-select"
                value={scene.platform}
                onChange={(event) =>
                  mutate((s) => updateScene(s, { platform: event.target.value as Platform }))
                }
                disabled={exporting}
              >
                {PLATFORMS.map((platform) => (
                  <option key={platform} value={platform}>
                    {PLATFORM_LABELS[platform]}
                  </option>
                ))}
              </select>
            </label>
            <div className="studio-grid-2">
              <label className="studio-field">
                <span className="studio-label">设备时间</span>
                <input className="studio-input" {...deviceTimeField} disabled={exporting} />
              </label>
              <label className="studio-field">
                <span className="studio-label">对话日期</span>
                <input className="studio-input" {...dateField} disabled={exporting} />
              </label>
            </div>
            <label className="studio-field">
              <span className="studio-label">水印（默认关闭）</span>
              <input
                className="studio-input"
                {...watermarkField}
                placeholder="留空则不显示"
                disabled={exporting}
              />
            </label>
          </details>

<details className="studio-panel studio-advanced">
            <summary className="studio-panel-title">
              <span>
                <IconUserPlus size={15} stroke={1.8} />
                人物
              </span>

            </summary>
              <button
                className="studio-btn studio-btn-ghost studio-btn-icon"
                type="button"
                title="添加人物"
                aria-label="添加人物"
                onClick={() => mutate((s) => addParticipant(s, '新角色'))}
                disabled={exporting}
              >
                <IconPlus size={16} stroke={1.8} />
              </button>
            {scene.participants.map((participant) => (
              <div className="studio-avatar-row" key={participant.id}>
                {participant.avatar ? (
                  <img className="studio-avatar-preview" src={participant.avatar} alt="" />
                ) : (
                  <span className="studio-avatar-initials" aria-hidden="true">
                    {initials(participant.name)}
                  </span>
                )}
                <input
                  className="studio-input"
                  key={`${participant.id}:${participant.name}`}
                  defaultValue={participant.name}
                  aria-label={`${participant.name} 的名称`}
                  onBlur={(event) =>
                    mutate((s) => updateParticipant(s, participant.id, { name: event.target.value.trim() || participant.name }))
                  }
                  disabled={exporting}
                />
                <button
                  className="studio-btn studio-btn-icon"
                  type="button"
                  title="上传头像"
                  aria-label={`上传 ${participant.name} 的头像`}
                  onClick={() => {
                    pendingAvatarIdRef.current = participant.id;
                    avatarInputRef.current?.click();
                  }}
                  disabled={exporting}
                >
                  <IconPhotoPlus size={16} stroke={1.8} />
                </button>
                {participant.id === scene.selfId ? <span className="studio-badge">我方</span> : null}
              </div>
            ))}
            <p className="studio-hint">为角色起个名字，也可以上传自己的头像。</p>
          </details>

          {persistLocal && <>
          <details className="studio-panel studio-advanced">
            <summary className="studio-panel-title">
              <span>
                <IconDeviceFloppy size={15} stroke={1.8} />
                本机草稿
              </span>
            </summary>
            <p className="studio-hint">
              草稿保存在本机浏览器，不是云端。刷新后可恢复，换设备不会同步。
            </p>
            {note?.code === 'ok' ? (
              <div className="studio-banner studio-banner-ok">
                <IconCircleCheck size={16} stroke={1.8} />
                <span>{note.message}</span>
              </div>
            ) : null}
            <div className="studio-row">
              <button className="studio-btn" type="button" onClick={requestClearDraft} disabled={exporting}>
                <IconTrash size={15} stroke={1.8} />
                清除本机草稿
              </button>
              <button className="studio-btn" type="button" onClick={requestReset} disabled={exporting}>
                <IconRefresh size={15} stroke={1.8} />
                重置当前场景
              </button>
            </div>
          </details>
          </>}
        </div>

        <div className="studio-canvas">
          <div className="studio-canvas-tools">
            <div className="studio-seg" role="group" aria-label="导出尺寸">
              <button
                type="button"
                className={exportMode === 'standard' ? 'is-active' : ''}
                disabled={exporting}
                onClick={() => setExportMode('standard')}
              >
                普通 360×640
              </button>
              <button
                type="button"
                className={exportMode === 'full' ? 'is-active' : ''}
                disabled={exporting}
                onClick={() => setExportMode('full')}
              >
                长截图
              </button>
            </div>
            <button
              className="studio-btn studio-btn-primary"
              type="button"
              onClick={() => handleExport()}
              disabled={exporting}
            >
              {exporting ? <IconRefresh size={16} stroke={1.8} /> : <IconDownload size={16} stroke={1.8} />}
              {exporting ? '正在导出…' : '导出 PNG'}
            </button>
          </div>

          {exportStatus !== 'idle' ? (
            <div
              className={`studio-banner${exportStatus === 'error' ? ' studio-banner-error' : exportStatus === 'success' ? ' studio-banner-ok' : ''}`}
              role="status"
            >
              {exportStatus === 'error' ? (
                <IconAlertTriangle size={16} stroke={1.8} />
              ) : (
                <IconInfoCircle size={16} stroke={1.8} />
              )}
              <div>
                <div>{exportMessage}</div>
                {exportStatus === 'error' ? (
                  <div className="studio-row" style={{ marginTop: 6 }}>
                    <button className="studio-btn" type="button" onClick={() => handleExport()}>
                      <IconRefresh size={15} stroke={1.8} />
                      重试导出
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {cropWarning && exportMode === 'standard' ? (
            <div className="studio-banner studio-banner-warn" role="status">
              <IconAlertTriangle size={16} stroke={1.8} />
              <span>当前内容高度超过 640px，普通模式会裁切；需要完整内容请选择“长截图”。</span>
            </div>
          ) : null}

          <div className="studio-phone" data-mode={exportMode}>
            <SceneView scene={scene} selectedId={selectedId} onSelect={exporting ? undefined : id => { setSelectedId(id); setView('edit'); }} />
          </div>
          <p className="studio-hint">
            点选画面中的消息，继续编辑。平台画面为风格预览。
          </p>
        </div>
      </div>

      {/* Hidden render stage used only for PNG capture. */}
      <div className="studio-export-stage" aria-hidden="true">
        <div className="studio-export-frame" data-mode={exportMode} ref={standardFrameRef}>
          <div ref={stageRootRef}>
            <SceneView scene={exportScene ?? scene} exportMode />
          </div>
        </div>
      </div>

      <input
        ref={avatarInputRef}
        aria-label="选择人物头像文件"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="studio-sr"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          const id = pendingAvatarIdRef.current;
          event.target.value = '';
          void handleImage(file, (dataUrl) =>
            mutate((s) => updateParticipant(s, id, { avatar: dataUrl })),
          );
        }}
      />
      <input
        ref={selectedImageRef}
        aria-label="选择当前消息图片文件"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="studio-sr"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          const id = selectedId;
          event.target.value = '';
          void handleImage(file, (dataUrl) =>
            mutate((s) => updateMessage(s, id, { asset: dataUrl })),
          );
        }}
      />
      <input
        ref={composerImageRef}
        aria-label="选择新消息图片文件"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="studio-sr"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          void handleImage(file, (dataUrl) => setComposerAsset(dataUrl));
        }}
      />

      <dialog
        className="studio-dialog"
        ref={jsonDialogRef}
        onClose={() => setJsonOpen(false)}
        aria-label="场景 JSON"
      >
        <div className="studio-dialog-body">
          <h2 className="studio-dialog-title">场景 JSON</h2>
          <textarea className="studio-json" aria-label="场景 JSON 内容" readOnly value={serializeScene(scene)} />
          <div className="studio-dialog-actions">
            <button className="studio-btn" type="button" onClick={handleJsonCopy}>
              <IconCopy size={15} stroke={1.8} />
              复制
            </button>
            <button className="studio-btn" type="button" onClick={handleJsonDownload}>
              <IconDownload size={15} stroke={1.8} />
              下载
            </button>
            <button className="studio-btn studio-btn-primary" type="button" onClick={() => setJsonOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      </dialog>

      <dialog
        className="studio-dialog"
        ref={confirmDialogRef}
        onClose={() => { setConfirm(null); setSavePause(pause => pause === 'choice' ? null : pause); }}
        aria-label={confirm?.title ?? '确认操作'}
      >
        <div className="studio-dialog-body">
          <h2 className="studio-dialog-title">{confirm?.title}</h2>
          <p className="studio-hint">{confirm?.body}</p>
          <div className="studio-dialog-actions">
            <button className="studio-btn" type="button" onClick={() => { setConfirm(null); setSavePause(pause => pause === 'choice' ? null : pause); }}>
              取消
            </button>
            <button
              className={`studio-btn ${confirm?.danger ? 'studio-btn-danger' : 'studio-btn-primary'}`}
              type="button"
              onClick={() => {
                const action = confirm?.action;
                setConfirm(null);
                action?.();
              }}
            >
              {confirm?.confirmLabel ?? '确认'}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

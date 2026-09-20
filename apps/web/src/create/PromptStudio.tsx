import { flushSync } from 'react-dom';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { IconArrowRight, IconArrowUp, IconCheck, IconChevronDown, IconDownload, IconExternalLink, IconLoader2, IconMessageCircle, IconPlayerStop, IconRefresh, IconSettings2, IconSparkles, IconWorld, IconX } from '@tabler/icons-react';
import { SceneView } from '../studio/SceneView';
import type { Platform, Scene } from '../studio/model';
import { serializeScene } from '../studio/model';
import { DRAFT_KEY, downloadText, loadDraft, saveDraft, waitForImages } from '../studio/storage';
import { applyGenerationEvent, isMarsPrompt, streamDemo, streamRemote } from './stream';
import { avatarSource, demoAssets, loadDemoAssets, makePortable, MARS_PROMPT_TEXT, previewScene } from './assets';
import '../studio/studio.css';
import './create.css';

type RunState = 'idle' | 'running' | 'done' | 'cancelled' | 'error';
const examplePrompts = [MARS_PROMPT_TEXT, '明天和马斯克去火星，他发来定位和我们的合影'];

export default function PromptStudio({ embedded = false }: { embedded?: boolean }) {
  const [prompt, setPrompt] = useState(MARS_PROMPT_TEXT);
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [scene, setScene] = useState<Scene>(previewScene);
  const [runState, setRunState] = useState<RunState>('idle');
  const [step, setStep] = useState('understanding');
  const [status, setStatus] = useState('写下一个场景，看它变成对话。');
  const [error, setError] = useState('');
  const [brief, setBrief] = useState('');
  const [view, setView] = useState<'write' | 'preview'>('write');
  const [sources, setSources] = useState(false);
  const [selected, setSelected] = useState('');
  const [edited, setEdited] = useState(false);
  const [sceneOrigin, setSceneOrigin] = useState<'demo'|'live'>('demo');
  const [exportMode, setExportMode] = useState<'standard' | 'full'>('full');
  const [exporting, setExporting] = useState(false);
  const [exportScene, setExportScene] = useState<Scene | null>(null);
  const [handoff, setHandoff] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [outputNote, setOutputNote] = useState('');
  const generation = useRef<AbortController | null>(null);
  const runId = useRef(0);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const exportRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const savedBeforeHandoff = useRef('');
  const busy = runState === 'running';

  useEffect(() => () => { runId.current++; generation.current?.abort(); }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (handoff && !dialog?.open) dialog?.showModal();
    else if (!handoff && dialog?.open) dialog.close();
  }, [handoff]);

  async function generate(event?: FormEvent) {
    event?.preventDefault();
    if (busy || exporting || handoffBusy) return;
    const text = prompt.trim();
    if (!text) { setError('先写下一句话，告诉我这个场景。'); inputRef.current?.focus(); return; }
    if (mode === 'demo' && !isMarsPrompt(text)) {
      setError('示例模式演示“和马斯克去火星”。自由场景请切换 AI 生成；它需要已连接的生成服务。'); return;
    }
    const id = ++runId.current;
    generation.current?.abort();
    const controller = new AbortController(); generation.current = controller;
    setRunState('running'); setError(''); setOutputNote(''); setBrief(text); setStep('understanding');
    setStatus(mode === 'demo' ? '正在载入火星示例…' : '正在理解你的场景…');
    setSelected(''); setEdited(false);
    let next: Scene | null = null;
    try {
      const input = { prompt: text, platform: sceneRef.current.platform };
      const iterator = mode === 'demo'
        ? streamDemo({ ...input, ...await loadDemoAssets(controller.signal) }, controller.signal)
        : streamRemote({ ...input }, controller.signal);
      for await (const item of iterator) {
        if (id !== runId.current || controller.signal.aborted) return;
        if (item.type === 'status') { setStep(item.stage); setStatus(item.message); }
        next = applyGenerationEvent(next, item);
        if (next) { setScene(next); setSceneOrigin(mode); }
        if (item.type === 'done') { setStep('complete'); }
      }
      if (id !== runId.current || controller.signal.aborted) return;
      setRunState('done'); setStatus(mode === 'demo' ? '示例已完成。点选一句话，还可以继续打磨。' : '你的场景已生成。每条消息都可以继续修改。');
    } catch (cause) {
      if (id !== runId.current) return;
      if (controller.signal.aborted) { setRunState('cancelled'); setStatus('已停止，已呈现的内容仍然保留。'); }
      else { setRunState('error'); setError(cause instanceof Error ? cause.message : '生成失败，请重试。'); setStatus(next ? '已保留部分结果，可以重试或继续编辑。' : '上一份画面已保留。'); }
    }
  }

  function cancel() {
    generation.current?.abort(); runId.current++;
    setRunState('cancelled'); setStatus('已停止，已呈现的内容仍然保留。');
  }
  function changePlatform(platform: Platform) { setScene(current => ({ ...current, platform })); }
  function updateSelected(value: string) {
    setScene(current => ({ ...current, messages: current.messages.map(message => message.id === selected ? { ...message, text: value } : message) }));
    setEdited(true);
  }
  async function exportPng() {
    if (busy || exporting || !scene.messages.length) return;
    setExporting(true); setOutputNote('正在准备图片…');
    try {
      const portable = await makePortable(scene);
      // Commit the export DOM before the third-party image renderer reads its ref.
      flushSync(() => setExportScene(portable));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const target = exportRef.current;
      if (!target) throw new Error('画面尚未准备好');
      await waitForImages(target); await document.fonts.ready;
      const { toPng } = await import('html-to-image');
      const dataUrl = await toPng(target, { pixelRatio: 2, skipFonts: true, backgroundColor: getComputedStyle(target.querySelector('.scene-view')!).backgroundColor });
      const link = document.createElement('a'); link.href = dataUrl;
      link.download = `imstage-scene-${exportMode === 'full' ? 'long' : '360x640'}.png`;
      document.body.append(link); link.click(); link.remove();
      setOutputNote('PNG 已导出。');
    } catch (cause) { setOutputNote(`导出失败：${cause instanceof Error ? cause.message : '请重试'}。当前画面已保留。`); }
    finally { setExporting(false); setExportScene(null); }
  }
  async function openEditor(replace = false) {
    setHandoffBusy(true); setOutputNote('');
    try {
      const portable = await makePortable(scene);
      const existing = loadDraft();
      if (existing.status === 'unavailable') throw new Error('浏览器存储不可用，可先下载场景 JSON 备份。');
      if (!replace && existing.status !== 'empty') { savedBeforeHandoff.current = existing.raw ?? ''; setHandoff(true); return; }
      if (replace && (localStorage.getItem(DRAFT_KEY) ?? '') !== savedBeforeHandoff.current) {
        savedBeforeHandoff.current = localStorage.getItem(DRAFT_KEY) ?? '';
        throw new Error('草稿刚被其他页面修改，请再次确认要替换的内容。');
      }
      const result = saveDraft(portable);
      if (!result.ok) throw new Error(result.message);
      setHandoff(false); location.hash = '/studio';
    } catch (cause) { setOutputNote(cause instanceof Error ? cause.message : '进入编辑器失败，画面仍保留。'); }
    finally { setHandoffBusy(false); }
  }
  async function downloadScene() {
    try { downloadText('imstage-scene.json', serializeScene(await makePortable(scene))); setOutputNote('场景 JSON 已下载。'); }
    catch { setOutputNote('素材读取失败，请重试。'); }
  }
  const chosen = scene.messages.find(message => message.id === selected);
  const hasMars = scene.messages.some(message => /火星/.test(message.text));


  return <div className={`prompt-studio${embedded ? ' embedded' : ''}`} data-view={view}>
    <div className="creation-topbar"><span><IconSparkles size={17} /> 对话创作</span><div><span className="creation-mode-dot" />{mode === 'demo' ? '交互示例' : 'AI 生成'}<a href="#/studio">手动编辑 <IconArrowRight size={14} /></a></div></div>
    <div className="creation-mobile-tabs" role="tablist" aria-label="创作视图"><button role="tab" aria-selected={view === 'write'} onClick={() => setView('write')}>写下场景</button><button role="tab" aria-selected={view === 'preview'} onClick={() => setView('preview')}>实时画面{busy && <span className="live-dot" />}</button></div>
    <div className="creation-layout">
      <div className="creation-input-panel">
        <div className="creation-intro"><span className="section-label">从想象，到一段对话</span><h2>你负责脑洞。<br />让故事自己展开。</h2><p>人物、台词、地点和照片，<br />一起出现在聊天画面里。</p></div>
        <form onSubmit={generate} className="creation-prompt-form">
          <label htmlFor={embedded ? 'home-scene-prompt' : 'scene-prompt'}>描述你想创作的场景</label>
          <textarea ref={inputRef} id={embedded ? 'home-scene-prompt' : 'scene-prompt'} value={prompt} maxLength={2000} rows={3} placeholder="比如：我和 Elon Musk 在明天一起去火星漫游…" onChange={event => setPrompt(event.target.value)} disabled={busy || exporting} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void generate(); } }} />
          <div className="creation-prompt-bottom"><label className="creation-mode-select"><select aria-label="生成模式" value={mode} onChange={event => { setMode(event.target.value as 'demo' | 'live'); setError(''); }} disabled={busy || exporting}><option value="demo">示例体验</option><option value="live">AI 生成</option></select><IconChevronDown size={13} /></label><span className="prompt-shortcut">⌘ / Ctrl + Enter</span>{busy ? <button key="stop" className="creation-send" type="button" onClick={event => { event.preventDefault(); cancel(); }} aria-label="停止生成"><IconPlayerStop size={19} /></button> : <button key="generate" className="creation-send" type="submit" disabled={exporting || handoffBusy} aria-label={runState === 'done' ? '重新生成场景' : '生成场景'}><IconArrowUp size={21} /></button>}</div>
        </form>
        <div className="creation-example"><span>试试这个</span><button disabled={busy || exporting} onClick={() => { setPrompt(examplePrompts[prompt === examplePrompts[0] ? 1 : 0]); setMode('demo'); setError(''); inputRef.current?.focus(); }}>和马斯克去火星 <IconArrowRight size={13} /></button></div>
        <div className="creation-mode-note">{mode === 'demo' ? '示例模式 · 分步回放预设故事与已生成素材' : '真实生成服务需连接 · 请求会发送至配置的模型'}</div>
        {(brief || error) && <div className="creation-progress" aria-live="polite"><div className="creation-progress-title">{busy ? <IconLoader2 className="spinning" size={17} /> : runState === 'done' ? <IconCheck size={17} /> : <IconMessageCircle size={17} />}<strong>{busy ? '故事正在展开' : runState === 'done' ? '画面已经就绪' : runState === 'cancelled' ? '已暂停创作' : '继续你的故事'}</strong></div><p>{status}</p>{busy && <div className="creation-steps">{[['understanding','理解场景'],['writing','编排对话'],['assets','填入素材']].map(([id,label]) => <span key={id} className={step === id ? 'active' : ''}>{label}</span>)}</div>}{error && <div className="creation-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => void generate()}><IconRefresh size={14} />重试</button></div>}</div>}
        {chosen && !busy && <div className="creation-inline-editor"><div><strong>{chosen.type === 'location' ? '改一个地点' : chosen.type === 'image' ? '修改图片说明' : '打磨这句台词'}</strong><button className="icon-btn" aria-label="关闭消息编辑" onClick={() => setSelected('')}><IconX size={16} /></button></div><textarea aria-label="当前消息内容" value={chosen.text} onChange={event => updateSelected(event.target.value)} rows={2} disabled={exporting} /><span>{edited ? '已更新画面，其他内容保持原样。' : '只修改选中的这一条。'}</span></div>}
        <div className="creation-source-summary"><div className="source-avatars">{sceneOrigin === 'demo' && <img src={demoAssets.avatar} alt="Elon Musk 的 X 头像参考" />}<span>我</span></div><div><strong>一个场景，多种素材</strong><p>{sceneOrigin === 'demo' ? 'X 头像参考 · 示意定位 · AI 合成照片' : 'AI 创作内容 · 可点选修改'}</p></div><button className="icon-btn" aria-label="查看素材来源" aria-expanded={sources} onClick={() => setSources(!sources)}><IconExternalLink size={17} /></button></div>
        {sources && <div className="creation-sources"><h3>画面中的素材</h3>{sceneOrigin === 'demo' ? <><p><a href={avatarSource.profile} target="_blank" rel="noreferrer">@elonmusk 的 X 头像 <IconExternalLink size={12} /></a><br />2026-09-20 通过公开资料代理核对，图片来自 X CDN。当前示例是火箭发射图，并非实时同步。</p><p>火星合影由 AI 生成；同行者为虚构人物。未上传你的照片，因此不代表你的真实长相。</p><p>火星位置是叙事中的示意定位，不是实际导航坐标。</p></> : <p>当前为模型生成的虚构场景。尚未提供可核验的图片来源时，不将人物头像标记为真实来源。</p>}</div>}
      </div>
      <div className="creation-output-panel">
        <div className="creation-output-toolbar"><div className="platform-switch" role="group" aria-label="创作平台">{([['wechat','微信'],['xiaohongshu','小红书']] as const).map(([platform,label]) => <button key={platform} disabled={busy || exporting} aria-pressed={scene.platform === platform} onClick={() => changePlatform(platform)}>{label}</button>)}</div><span className="creation-live-label"><span className={busy ? 'live-dot' : ''} />{busy ? '逐步呈现中' : runState === 'idle' ? '示例画面' : '可继续编辑'}{busy && <button type="button" className="creation-stop-preview" aria-label="停止画面生成" onClick={cancel}><IconPlayerStop size={12} />停止</button>}</span></div>
        <div className="creation-canvas"><div className="creation-orbit orbit-one" /><div className="creation-orbit orbit-two" /><div className="creation-canvas-label"><IconWorld size={14} /> {hasMars ? 'MARS / NEXT STOP' : 'YOUR STORY'}</div><div className="creation-phone"><SceneView scene={scene} pendingAssets={busy} selectedId={selected} onSelect={busy || exporting ? undefined : id => { setSelected(id); setView('write'); }} /></div><div className="creation-caption">{hasMars ? '明天，去一个从没去过的地方。' : scene.title}</div></div>
        <div className="creation-output-actions"><div className="creation-export-mode"><select aria-label="图片导出范围" value={exportMode} disabled={busy || exporting} onChange={event => setExportMode(event.target.value as 'standard'|'full')}><option value="full">完整长图</option><option value="standard">普通 360×640</option></select></div><button className="creation-edit" disabled={busy || exporting || handoffBusy || !scene.messages.length} onClick={() => void openEditor()}><IconSettings2 size={16} />编辑细节</button><button className="btn btn-primary" disabled={busy || exporting || !scene.messages.length} onClick={() => void exportPng()}>{exporting ? <IconLoader2 size={16} className="spinning" /> : <IconDownload size={16} />}导出 PNG</button></div>
        <p className="creation-output-note" role="status">{outputNote || (busy ? '文字先出现，图片就绪后填入。可以随时停止。' : '点选消息即可修改 · 图片与对话均为虚构创作')}</p>
        {outputNote.includes('失败') || outputNote.includes('存储') ? <button className="creation-json" onClick={() => void downloadScene()}>下载场景 JSON 备份</button> : null}
      </div>
    </div>
    <dialog ref={dialogRef} className="studio-dialog" onClose={() => setHandoff(false)} aria-label="保留已有草稿"><div className="studio-dialog-body"><h2 className="studio-dialog-title">工作台里已有一份草稿</h2><p>先下载原草稿备份，再把当前场景带入编辑器。</p><div className="studio-dialog-actions"><button className="studio-btn" onClick={() => { downloadText('imstage-previous-draft.json', savedBeforeHandoff.current); }}>下载原草稿</button><button className="studio-btn" onClick={() => setHandoff(false)}>取消</button><button className="studio-btn studio-btn-primary" disabled={handoffBusy} onClick={() => void openEditor(true)}>使用当前场景</button></div>{outputNote && <p role="alert">{outputNote}</p>}</div></dialog>
    {exportScene && <div className="creation-export-offscreen" aria-hidden="true"><div ref={exportRef} className="creation-export-frame" style={{ height: exportMode === 'standard' ? 640 : 'auto', overflow: 'hidden' }}><SceneView scene={exportScene} exportMode /></div></div>}
  </div>;
}

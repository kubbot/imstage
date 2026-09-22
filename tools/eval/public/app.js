const $ = (id) => document.getElementById(id);
const labels = { wechat: '微信', telegram: 'Telegram', whatsapp: 'WhatsApp', custom: '自定义', ios: 'iOS', android: 'Android', desktop: '桌面端', web: 'Web', screenshot: '普通截图', 'long-screenshot': '长截图' };
const fields = { content: '内容准确', imFidelity: '平台还原', layout: '排版质量', completeness: '内容完整' };
const draftKey = 'imstage.scene-note.v1';
let store = { revision: 0, cases: [] }, config = {}, selected = null, filter = 'all', images = [], generation = null, busy = false, reviewDirty = false, draftSafe = true, verdict = null, scores = {}, requestId = null, toastTimer;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const active = () => store.cases.find((c) => c.id === selected);
const newId = () => crypto.randomUUID();
const imageUrl = (item) => `data:${item.mime};base64,${item.dataBase64}`;
const endpoint = (c, suffix = '') => `/api/cases/${encodeURIComponent(c.id)}${suffix}`;

function notify(message, retry = false) {
  $('notice-new-generation').hidden = true;
  $('notice-text').textContent = message;
  $('notice-retry').hidden = !retry;
  $('notice').hidden = false;
}
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3800);
}
async function api(url, body, method = 'POST', signal) {
  const response = await fetch(url, { method: body === undefined ? 'GET' : method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('服务返回异常，请重新连接后重试。'); }
  if (!response.ok) {
    const error = new Error(result.error || '操作失败，请重试。');
    error.code = result.code;
    error.status = response.status;
    throw error;
  }
  return result;
}
function report(error) {
  if (error.code === 'generation_outcome_unknown') {
    notify('上一次 AI 请求的结果未能确认。输入仍在；点击“重新生成一版”会发起一次新的生成。');
    $('notice-new-generation').hidden = false;
  } else if (['generation_not_found', 'ai_invalid_json', 'ai_invalid_scene', 'ai_empty_response', 'ai_invalid_response'].includes(error.code)) {
    notify(`${error.message}。输入已保留，可以重新生成一版。`);
    $('notice-new-generation').hidden = false;
  } else if (error.code === 'revision_conflict') notify('记录已在其他窗口更新。你的输入仍在，请重新连接后再操作。', true);
  else notify(error.message || '暂时无法连接服务，请重试。', true);
}
function mode(name) {
  for (const item of ['composer', 'generating', 'result']) $(`${item}-view`).hidden = item !== name;
  $('page-label').textContent = name === 'composer' ? '新场景' : name === 'generating' ? '正在生成' : '标注记录';
  $('new-note').disabled = name === 'generating' || busy;
  $('collection-tools').disabled = name === 'generating' || busy;
}
function composerValue() {
  return { text: $('note-text').value, images, targetIM: $('target-im').value, surface: $('surface').value, outputKind: $('output-kind').value, synthetic: $('synthetic').checked };
}
function persistDraft(changed = true) {
  if (changed) requestId = null;
  try {
    localStorage.setItem(draftKey, JSON.stringify({ ...composerValue(), requestId }));
    draftSafe = true;
    $('draft-status').textContent = '草稿已保存在本机';
  } catch {
    draftSafe = false;
    $('draft-status').textContent = '草稿空间不足，关闭前请保留输入';
  }
  updateGenerate();
}
function updateGenerate() {
  $('generate').disabled = !config.configured || busy || !!generation || (!$('note-text').value.trim() && !images.length);
}
function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (!draft) return;
    $('note-text').value = typeof draft.text === 'string' ? draft.text.slice(0, 4000) : '';
    for (const [id, key, fallback] of [['target-im', 'targetIM', 'wechat'], ['surface', 'surface', 'ios'], ['output-kind', 'outputKind', 'screenshot']]) {
      $(id).value = labels[draft[key]] ? draft[key] : fallback;
      if (!$(id).value) $(id).value = fallback;
    }
    $('synthetic').checked = draft.synthetic === true;
    images = (Array.isArray(draft.images) ? draft.images : []).filter((i) => i && ['image/png', 'image/jpeg', 'image/webp'].includes(i.mime) && typeof i.dataBase64 === 'string' && i.dataBase64.length <= 2.8e6 && /^[A-Za-z0-9+/]*={0,2}$/.test(i.dataBase64)).slice(0, 3);
    requestId = typeof draft.requestId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(draft.requestId) ? draft.requestId : null;
    renderImages();
    $('draft-status').textContent = '已恢复本机草稿';
  } catch { /* An invalid local draft must not prevent opening saved records. */ }
}
function renderImages() {
  $('input-images').innerHTML = images.map((item, i) => `<div class="input-image"><img src="${imageUrl(item)}" alt="${esc(item.name)}"><button type="button" data-remove="${i}" aria-label="移除 ${esc(item.name)}">×</button></div>`).join('');
}
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name || '粘贴图片.png', mime: file.type, dataBase64: String(reader.result).split(',')[1] });
    reader.onerror = () => reject(new Error('图片读取失败，请重新选择。'));
    reader.readAsDataURL(file);
  });
}
async function addImages(files) {
  if (generation || busy) return;
  const incoming = Array.from(files);
  if (images.length + incoming.length > 3) return notify('一次最多添加 3 张图片。');
  if (incoming.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return notify('请选择 PNG、JPEG 或 WebP 图片。');
  if (incoming.some((file) => file.size > 2 * 1024 * 1024)) return notify('每张图片不能超过 2 MB，请压缩后重试。');
  try {
    busy = true; updateGenerate();
    const added = await Promise.all(incoming.map(readFile));
    images.push(...added); renderImages(); persistDraft();
  } catch (error) { report(error); }
  finally { busy = false; updateGenerate(); }
}
function renderHistory() {
  const query = $('search').value.trim().toLowerCase();
  const list = [...store.cases].reverse().filter((c) => (!query || `${c.question} ${c.notes || ''}`.toLowerCase().includes(query)) && (filter !== 'golden' || c.computed?.goldenCurrent) && (filter !== 'unreviewed' || !c.computed?.reviewCurrent));
  $('case-count').textContent = String(store.cases.length);
  $('history').innerHTML = list.map((c) => `<button class="history-item" data-id="${esc(c.id)}" aria-current="${selected === c.id}"><strong>${esc(c.question || '图片场景')}</strong><small><span>${esc(labels[c.targetIM] || c.targetIM)} · ${esc(labels[c.surface] || c.surface)}</span><em>${c.computed?.goldenCurrent ? '金标' : c.computed?.reviewCurrent ? c.review.verdict === 'good' ? '好结果' : '待改进' : '待标注'}</em></small></button>`).join('');
  $('history-empty').hidden = list.length > 0;
  $('history-empty').textContent = store.cases.length ? '还没有符合条件的记录。' : '第一条场景，从一句话开始。';
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
}
function renderScoreFields() {
  $('score-fields').innerHTML = Object.entries(fields).map(([key, label]) => `<label class="score-field">${label}<select data-score="${key}" aria-label="${label}"><option value="">未评分</option>${[0, 1, 2].map((v) => `<option value="${v}" ${scores[key] === v ? 'selected' : ''}>${v} · ${['不符合', '部分符合', '符合'][v]}</option>`).join('')}</select></label>`).join('');
}
function updateReview() {
  const c = active();
  const current = c?.computed?.candidateCurrent;
  $('new-note').disabled = $('collection-tools').disabled = busy || !!generation;
  $('review-reason').disabled = busy || !current;
  $('record-synthetic').disabled = busy;
  for (const element of document.querySelectorAll('[data-score], [data-issue]')) element.disabled = busy || !current;
  $('judge-good').setAttribute('aria-pressed', String(verdict === 'good'));
  $('judge-bad').setAttribute('aria-pressed', String(verdict === 'bad'));
  $('judge-good').disabled = $('judge-bad').disabled = !current || busy;
  $('feedback').hidden = verdict !== 'bad';
  for (const button of document.querySelectorAll('[data-issue]')) button.setAttribute('aria-pressed', String(scores[button.dataset.issue] === 0));
  $('save-review').disabled = !current || busy || !reviewDirty || !verdict || Object.keys(fields).some((key) => !Number.isInteger(scores[key])) || (verdict === 'bad' && !$('review-reason').value.trim());
  $('save-review').textContent = reviewDirty ? '保存标注' : c?.computed?.reviewCurrent ? '标注已保存' : '保存标注';
  $('review-status').textContent = reviewDirty ? '尚未保存' : c?.computed?.goldenCurrent ? '已确认为金标' : c?.computed?.reviewCurrent ? '已标注' : '待标注';
  const eligible = c?.computed?.reviewCurrent && c.review?.verdict === 'good';
  $('golden-area').hidden = !eligible || reviewDirty;
  $('promote').hidden = !!c?.computed?.goldenCurrent;
  $('revoke').hidden = !c?.computed?.goldenCurrent;
  $('golden-explainer').textContent = c?.computed?.goldenCurrent ? '已保留为金标，可用于后续回归比较。' : '这个结果值得保留。确认后，将作为后续回归的参考。';
  for (const id of ['promote', 'revoke', 'remix', 'save-record-policy', 'delete-record']) $(id).disabled = busy;
}
function showCase(id) {
  selected = id;
  const c = active();
  if (!c) return showComposer();
  reviewDirty = false;
  const review = c.computed?.reviewCurrent ? c.review : null;
  verdict = review?.verdict === 'unreviewed' ? null : review?.verdict || null;
  scores = { ...(review?.scores || {}) };
  $('review-reason').value = review?.reason || '';
  $('result-title').textContent = '这一版，符合你的想法吗？';
  $('result-subtitle').textContent = `${labels[c.targetIM] || c.targetIM} · ${labels[c.surface] || c.surface} · ${labels[c.outputKind] || c.outputKind}`;
  $('source-text').textContent = (c.generation ? c.generation.input.text : c.question) || '用图片作为输入';
  $('source-images').innerHTML = (c.attachments || []).filter((a) => a.mime?.startsWith('image/')).map((a) => `<a href="${endpoint(c, `/attachments/${encodeURIComponent(a.id)}/raw`)}" target="_blank" rel="noopener"><img src="${endpoint(c, `/attachments/${encodeURIComponent(a.id)}/raw`)}" alt="${esc(a.name)}"></a>`).join('');
  $('source-chips').innerHTML = [labels[c.targetIM], labels[c.surface], labels[c.outputKind], c.synthetic ? '合成素材' : '私有素材'].map((label) => `<span>${esc(label)}</span>`).join('');
  $('result-image').hidden = !c.candidate;
  $('no-result').hidden = !!c.candidate;
  if (c.candidate) $('result-image').src = `${endpoint(c, '/candidate.png')}?v=${encodeURIComponent(c.candidate.sha256)}`;
  else $('result-image').removeAttribute('src');
  $('download-image').hidden = !c.candidate;
  $('download-image').href = endpoint(c, '/candidate.png');
  $('download-image').download = `${c.id}.png`;
  $('image-spec').textContent = c.candidate ? `${c.candidate.width} × ${c.candidate.height} · PNG${c.computed?.candidateCurrent ? '' : ' · 输入已变化，需重新生成'}` : '暂无输出';
  $('record-meta').textContent = `${c.id}\n${c.candidate?.provenance?.model || c.provenance?.model || ''}${c.notes ? `\n${c.notes}` : ''}`;
  $('record-synthetic').checked = c.synthetic === true;
  renderScoreFields(); updateReview(); renderHistory(); mode('result');
}
async function confirmAction(title, message, label = '确认') {
  const dialog = $('confirm-dialog');
  if (dialog.open) return false;
  $('confirm-title').textContent = title; $('confirm-text').textContent = message; $('confirm-ok').textContent = label;
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.showModal();
  });
}
async function leaveReview() {
  if (busy || generation) return false;
  return !reviewDirty || await confirmAction('标注尚未保存', '离开将放弃这次未保存的评价，生成的图片仍会保留。', '放弃评价');
}
function showComposer() {
  selected = null; reviewDirty = false; mode('composer'); renderHistory(); updateGenerate(); $('note-text').focus();
}
async function reloadStore() {
  store = await api('/api/store');
  $('connection').textContent = '本机已连接';
  $('connection').dataset.state = 'ok';
  renderHistory();
}
async function mutate(suffix, body, method = 'POST') {
  if (busy || generation || !active()) return;
  const id = selected;
  busy = true; updateReview();
  try {
    await api(endpoint(active(), suffix), { revision: store.revision, ...body }, method);
    await reloadStore();
    showCase(id);
    return true;
  } catch (error) { report(error); return false; }
  finally { busy = false; updateReview(); }
}
async function generate(event) {
  event?.preventDefault();
  if (busy || generation || $('generate').disabled) return;
  $('notice').hidden = true;
  const input = composerValue();
  requestId ||= newId(); persistDraft(false);
  const controller = new AbortController();
  generation = controller; mode('generating'); updateGenerate();
  $('generating-input').textContent = input.text.trim() || `${images.length} 张图片`;
  try {
    const result = await api('/api/generate', { revision: store.revision, requestId, input }, 'POST', controller.signal);
    if (controller.signal.aborted) return;
    await reloadStore();
    requestId = null;
    $('note-text').value = ''; $('synthetic').checked = false; images = []; renderImages(); persistDraft(false);
    showCase(result.case.id);
    if (result.warnings?.length) notify(result.warnings.join('；'));
    else toast('聊天图已生成，原始输入也已保留。');
  } catch (error) {
    mode('composer');
    if (error.name === 'AbortError') notify('已停止等待，输入仍保留。如果服务已完成，结果会出现在左侧记录中。');
    else report(error);
    try { await reloadStore(); } catch { /* Keep the original error and the draft. */ }
  } finally {
    generation = null; $('new-note').disabled = false; $('collection-tools').disabled = false; updateGenerate();
  }
}
async function remix() {
  if (!(await leaveReview())) return;
  const c = active();
  const hasDraft = $('note-text').value.trim() || images.length;
  if (hasDraft && !(await confirmAction('用这条记录继续创作？', '当前便签草稿将替换为这条记录的输入，原记录与标注会保留。', '使用这条输入'))) return;
  busy = true; updateReview();
  try {
    const source = (c.attachments || []).filter((a) => ['image/png', 'image/jpeg', 'image/webp'].includes(a.mime));
    if (source.length > 3) throw new Error('这条旧记录超过 3 张图片，请新建场景并选择需要的图片。');
    const loaded = await Promise.all(source.map(async (a) => {
      const response = await fetch(endpoint(c, `/attachments/${encodeURIComponent(a.id)}/raw`));
      if (!response.ok) throw new Error('原始图片读取失败，请重试。');
      const blob = await response.blob();
      if (blob.size > 2 * 1024 * 1024) throw new Error('原始图片超过 2 MB，请新建场景并压缩图片后再试。');
      return readFile(new File([blob], a.name, { type: a.mime }));
    }));
    $('note-text').value = c.generation ? c.generation.input.text : c.question;
    $('target-im').value = ['wechat', 'telegram', 'whatsapp'].includes(c.targetIM) ? c.targetIM : 'wechat';
    $('surface').value = c.surface; $('output-kind').value = c.outputKind; $('synthetic').checked = c.synthetic;
    images = loaded; renderImages(); persistDraft(); showComposer();
    if (c.targetIM === 'custom') notify('这条旧记录使用自定义 IM，已先选为微信，你可以重新选择。');
  } catch (error) { report(error); }
  finally { busy = false; updateGenerate(); updateReview(); $('new-note').disabled = false; $('collection-tools').disabled = false; }
}
async function exportGoldens(scope) {
  try {
    const bundle = await api('/api/export', { scope });
    if (!bundle.cases?.length) { $('tools-dialog').close(); return notify('还没有符合条件的金标。先保存“好”的标注，再确认为金标。'); }
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `imstage-${scope}-goldens.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`已导出 ${bundle.cases.length} 条金标。`);
  } catch (error) { $('tools-dialog').close(); report(error); }
}

$('compose-form').addEventListener('submit', generate);
for (const id of ['note-text', 'target-im', 'surface', 'output-kind', 'synthetic']) $(id).addEventListener(id === 'note-text' ? 'input' : 'change', () => persistDraft());
$('add-images').addEventListener('click', () => $('image-files').click());
$('image-files').addEventListener('change', async () => { await addImages($('image-files').files); $('image-files').value = ''; });
$('input-images').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove]');
  if (!button || busy || generation) return;
  images.splice(Number(button.dataset.remove), 1); renderImages(); persistDraft();
});
$('compose-form').addEventListener('paste', (event) => {
  const files = Array.from(event.clipboardData?.files || []);
  if (files.length) { event.preventDefault(); addImages(files); }
});
$('compose-form').addEventListener('dragover', (event) => { event.preventDefault(); $('compose-form').classList.add('dragging'); });
$('compose-form').addEventListener('dragleave', () => $('compose-form').classList.remove('dragging'));
$('compose-form').addEventListener('drop', (event) => { event.preventDefault(); $('compose-form').classList.remove('dragging'); addImages(event.dataTransfer?.files || []); });
$('suggestions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-prompt]');
  if (!button) return;
  $('note-text').value = button.dataset.prompt; persistDraft(); $('note-text').focus();
});
$('new-note').addEventListener('click', async () => { if (await leaveReview()) showComposer(); });
$('search').addEventListener('input', renderHistory);
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; renderHistory(); });
$('history').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-id]');
  if (button && await leaveReview()) showCase(button.dataset.id);
});
$('cancel-generation').addEventListener('click', () => generation?.abort());
$('remix').addEventListener('click', remix);
for (const choice of ['good', 'bad']) $(`judge-${choice}`).addEventListener('click', () => {
  if (busy || !active()?.computed?.candidateCurrent) return;
  verdict = choice; scores = Object.fromEntries(Object.keys(fields).map((key) => [key, choice === 'good' ? 2 : 1]));
  reviewDirty = true; renderScoreFields(); updateReview();
});
for (const button of document.querySelectorAll('[data-issue]')) button.addEventListener('click', () => {
  if (busy) return;
  scores[button.dataset.issue] = scores[button.dataset.issue] === 0 ? 1 : 0;
  reviewDirty = true; renderScoreFields(); updateReview();
});
$('score-fields').addEventListener('change', (event) => {
  const key = event.target.dataset.score;
  if (!fields[key]) return;
  scores[key] = event.target.value === '' ? null : Number(event.target.value); reviewDirty = true; updateReview();
});
$('review-reason').addEventListener('input', () => { reviewDirty = true; updateReview(); });
$('save-review').addEventListener('click', async () => {
  if ($('save-review').disabled) return;
  if (await mutate('/review', { review: { verdict, scores, reason: $('review-reason').value } }, 'PUT')) toast('标注已保存。');
});
$('promote').addEventListener('click', async () => { if (await mutate('/golden', {})) toast('已确认为金标。'); });
$('revoke').addEventListener('click', async () => { if (await mutate('/golden', {}, 'DELETE')) toast('已撤销金标，图片和标注仍保留。'); });
$('save-record-policy').addEventListener('click', async () => {
  if (!active() || active().synthetic === $('record-synthetic').checked || !(await leaveReview())) return;
  if (!(await confirmAction('修改素材标记？', '修改会撤销现有评审和金标，需重新确认。只有虚构、合成素材才应标为公开。', '保存标记'))) return;
  if (await mutate('', { case: { synthetic: $('record-synthetic').checked } }, 'PUT')) toast('素材标记已更新。');
});
$('delete-record').addEventListener('click', async () => {
  if (!(await leaveReview()) || !(await confirmAction('删除这条记录？', '原始输入、图片、标注和金标都会删除，无法恢复。', '删除记录'))) return;
  if (await mutate('', {}, 'DELETE')) { showComposer(); toast('记录已删除。'); }
});
$('collection-tools').addEventListener('click', () => $('tools-dialog').showModal());
$('tools-close').addEventListener('click', () => $('tools-dialog').close());
$('export-synthetic').addEventListener('click', () => exportGoldens('synthetic'));
$('export-private').addEventListener('click', () => exportGoldens('private'));
$('import-open').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; $('import-file').value = '';
  if (!file) return;
  $('tools-dialog').close();
  if (!(await leaveReview())) return;
  try {
    busy = true; updateGenerate(); updateReview();
    if (file.size > 24 * 1024 * 1024) throw new Error('备份文件超过 24 MB 请求上限。');
    const bundle = JSON.parse(await file.text());
    if (new TextEncoder().encode(JSON.stringify({ revision: store.revision, bundle })).length > 24 * 1024 * 1024) throw new Error('备份内容超过 24 MB 请求上限。');
    await api('/api/import', { revision: store.revision, bundle });
    await reloadStore(); if (selected) showCase(selected);
    toast('金标已恢复，原有记录已保留。');
  } catch (error) { report(error); }
  finally { busy = false; updateGenerate(); updateReview(); }
});
$('notice-new-generation').addEventListener('click', () => {
  if (generation || busy || $('composer-view').hidden) return;
  requestId = null; persistDraft(false); generate();
});
$('notice-close').addEventListener('click', () => { $('notice').hidden = true; });
$('notice-retry').addEventListener('click', async () => {
  if (busy || generation) return;
  const before = active();
  const pendingReview = reviewDirty ? { verdict, scores: { ...scores }, reason: $('review-reason').value } : null;
  busy = true; updateGenerate(); updateReview();
  try {
    const nextStore = await api('/api/store');
    const after = nextStore.cases.find((c) => c.id === selected);
    const sameBasis = before && after && before.computed?.inputFingerprint === after.computed?.inputFingerprint && before.candidate?.sha256 === after.candidate?.sha256 && before.review?.fingerprint === after.review?.fingerprint;
    if (pendingReview && !sameBasis && !(await confirmAction('这条记录已经变化', '当前输出或已有标注已被其他窗口修改。放弃未保存的评价后，可查看最新记录。', '查看最新记录'))) return;
    store = nextStore;
    config = await api('/api/generation');
    $('connection').textContent = '本机已连接'; $('connection').dataset.state = 'ok';
    $('generation-hint').textContent = config.configured ? '文字与图片会交给 AI 理解，语言自动识别。' : 'AI 尚未配置。已有记录仍可查看和标注。';
    if (selected) showCase(selected); else renderHistory();
    if (pendingReview && sameBasis) {
      verdict = pendingReview.verdict; scores = pendingReview.scores; $('review-reason').value = pendingReview.reason;
      reviewDirty = true; renderScoreFields(); toast('已同步记录，你未保存的评价已保留。');
    }
    $('notice').hidden = true;
  } catch (error) { report(error); }
  finally { busy = false; updateGenerate(); updateReview(); }
});
$('result-image').addEventListener('error', () => notify('输出图片暂时无法读取，请重新连接后重试。', true));
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !$('composer-view').hidden) { event.preventDefault(); generate(); }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); $('new-note').click(); }
});
window.addEventListener('beforeunload', (event) => {
  if (generation || reviewDirty || !draftSafe) { event.preventDefault(); event.returnValue = ''; }
});
async function load() {
  await reloadStore();
  config = await api('/api/generation');
  $('generation-hint').textContent = config.configured ? '文字与图片会交给 AI 理解，语言自动识别。' : 'AI 尚未配置。已有记录仍可查看和标注。';
  updateGenerate();
}
async function init() {
  restoreDraft(); renderImages(); mode('composer'); updateGenerate();
  try { await load(); }
  catch (error) { $('connection').textContent = '连接异常'; $('connection').dataset.state = 'error'; report(error); }
}
init();

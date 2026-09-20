// IMStage eval lab UI — vanilla ES module, no build step.

const $ = (id) => document.getElementById(id);

const state = {
  meta: null,
  revision: 0,
  cases: [],
  selectedId: null,
  draft: null,
  dirty: false,
  reviewDirty: false,
  busy: false,
  filters: { q: '', targetIM: '', surface: '', status: '', outputKind: '' },
};

// Human-readable option labels (raw enum values stay as the option value).
const OPTION_LABELS = {
  wechat: '微信 wechat',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  custom: '自定义 custom',
  ios: 'iOS',
  android: 'Android',
  desktop: 'Desktop',
  web: 'Web',
  'zh-CN': '简体中文 zh-CN',
  'zh-TW': '繁体中文 zh-TW',
  en: 'English en',
  ja: '日本語 ja',
  ko: '한국어 ko',
  other: '其他 other',
  screenshot: '普通截图 screenshot',
  'long-screenshot': '长截图 long-screenshot',
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function setStatusChip(el, stateName, text) {
  if (!el) return;
  el.hidden = false;
  el.dataset.state = stateName;
  el.textContent = text;
}

function showToast(message, kind = 'info') {
  const el = $('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

function showBanner(message, { kind = 'warn', actionLabel, action } = {}) {
  const banner = $('banner');
  banner.dataset.kind = kind;
  $('banner-text').textContent = message;
  const btn = $('banner-action');
  if (actionLabel && action) {
    btn.hidden = false;
    btn.textContent = actionLabel;
    btn.onclick = () => action();
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  banner.hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    const dlg = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = 'cancel';
    dlg.showModal();
  });
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status, code, payload) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

async function api(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text };
  }
  if (!res.ok) {
    throw new ApiError(payload?.error ?? `请求失败 (${res.status})`, res.status, payload?.code, payload);
  }
  return payload;
}

function handleMutationError(err) {
  if (err instanceof ApiError && err.status === 409) {
    showBanner('数据已被其他操作修改（revision 冲突）。请重新加载后重试。', {
      kind: 'error',
      actionLabel: '重新加载',
      action: () => withDiscardGuard(() => reloadStore()),
    });
    setStatusChip($('store-status'), 'warn', '冲突');
    return;
  }
  if (err instanceof ApiError && err.payload?.corrupt) {
    showBanner(`存储损坏，已保留原文件，不会覆盖：${err.message}`, { kind: 'error' });
    setStatusChip($('store-status'), 'error', '存储损坏');
    return;
  }
  showBanner(err.message ?? String(err), { kind: 'error' });
  showToast('操作失败', 'error');
}

// ---------------------------------------------------------------------------
// Store loading + list
// ---------------------------------------------------------------------------

function fillSelect(select, values, { placeholder } = {}) {
  if (!select) return;
  const current = select.value;
  select.innerHTML = '';
  if (placeholder !== undefined) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    select.appendChild(opt);
  }
  for (const value of values) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = OPTION_LABELS[value] ?? value;
    select.appendChild(opt);
  }
  if (values.includes(current)) {
    select.value = current;
  } else if (placeholder !== undefined) {
    select.value = '';
  } else {
    select.value = values[0] ?? '';
  }
}

function updateLimitHints() {
  const meta = state.meta;
  const hint = $('attachment-hint');
  if (hint) {
    hint.textContent = `每个用例最多 ${meta.maxAttachments} 个附件，单个不超过 ${formatBytes(
      meta.maxAttachmentBytes,
    )}。支持图片（PNG/JPEG/WebP/GIF）、视频（MP4/WebM/MOV）、音频（MP3/WAV/OGG）以及 PDF/文本；图片、视频、音频可内联预览，其余仅下载。`;
  }
  const candidateHint = $('candidate-hint');
  if (candidateHint) {
    candidateHint.textContent = `候选必须是 PNG，单个不超过 ${formatBytes(
      meta.maxCandidateBytes,
    )}，总像素不超过 ${Number(meta.maxPixels ?? 8000000).toLocaleString('en-US')}。像素尺寸会与用例设定的宽高比对，不一致的候选不能设为金标。`;
  }
}

async function loadMeta() {
  state.meta = await api('GET', '/api/meta');
  fillSelect($('f-language'), state.meta.inputLanguages);
  fillSelect($('f-im'), state.meta.targetIMs);
  fillSelect($('f-surface'), state.meta.surfaces);
  fillSelect($('f-kind'), state.meta.outputKinds);
  fillSelect($('filter-im'), state.meta.targetIMs, { placeholder: '全部' });
  fillSelect($('filter-surface'), state.meta.surfaces, { placeholder: '全部' });
  fillSelect($('filter-kind'), state.meta.outputKinds, { placeholder: '全部' });
  updateLimitHints();
  renderScoreGroups();
}

async function reloadStore() {
  setStatusChip($('store-status'), 'idle', '加载中…');
  try {
    const data = await api('GET', '/api/store');
    state.revision = data.revision;
    state.cases = data.cases;
    hideBanner();
    setStatusChip($('store-status'), 'ok', `rev ${data.revision} · ${data.cases.length} 用例`);
    if (state.selectedId && !state.cases.some((c) => c.id === state.selectedId)) {
      state.selectedId = null;
    }
    renderAll();
  } catch (err) {
    setStatusChip($('store-status'), 'error', '加载失败');
    if (err instanceof ApiError && err.payload?.corrupt) {
      showBanner(`store.json 损坏，已保留原文件，不会静默覆盖：${err.message}`, { kind: 'error' });
    } else {
      showBanner(`加载失败：${err.message}`, { kind: 'error' });
    }
    // Never leave a stale "ok" view on screen after a failed reload.
    state.cases = [];
    renderList();
  }
}

function caseStatus(c) {
  if (c.computed?.goldenCurrent) return { key: 'golden', label: '金标', tone: 'golden' };
  if (c.computed?.candidateCurrent === false && c.candidate) return { key: 'stale', label: '候选过期', tone: 'warn' };
  if (c.review?.verdict === 'bad') return { key: 'bad', label: '坏例', tone: 'bad' };
  if (c.review?.status === 'reviewed') return { key: 'reviewed', label: '已评审', tone: 'reviewed' };
  return { key: 'unreviewed', label: '未评审', tone: 'default' };
}

function filterCases() {
  const { q, targetIM, surface, status, outputKind } = state.filters;
  const needle = q.trim().toLowerCase();
  return state.cases.filter((c) => {
    if (targetIM && c.targetIM !== targetIM) return false;
    if (surface && c.surface !== surface) return false;
    if (outputKind && c.outputKind !== outputKind) return false;
    if (status) {
      const s = caseStatus(c).key;
      if (status === 'stale' && s !== 'stale') return false;
      if (status !== 'stale' && s !== status) return false;
    }
    if (needle) {
      const hay = `${c.question} ${c.notes ?? ''} ${c.targetIM} ${c.surface}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

function renderList() {
  const list = $('case-list');
  const items = filterCases();
  $('list-loading').hidden = true;
  list.innerHTML = '';
  const empty = $('list-empty');
  if (state.cases.length === 0) {
    empty.hidden = false;
    empty.textContent = '还没有用例。点击「新建」或「加载合成示例」开始。';
    list.hidden = true;
    return;
  }
  if (items.length === 0) {
    empty.hidden = false;
    empty.textContent = '没有符合筛选条件的用例。';
    list.hidden = true;
    return;
  }
  empty.hidden = true;
  list.hidden = false;
  for (const c of items) {
    const st = caseStatus(c);
    const li = document.createElement('li');
    li.className = 'case-item';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(c.id === state.selectedId));
    li.tabIndex = 0;
    li.innerHTML = `
      <div class="case-q">${escapeHtml(c.question)}</div>
      <div class="case-meta">
        <span class="chip">${escapeHtml(c.targetIM)}</span>
        <span class="chip">${escapeHtml(c.surface)}</span>
        <span class="chip">${escapeHtml(c.inputLanguage)}</span>
        <span class="chip" data-tone="${st.tone}">${st.label}</span>
        ${c.synthetic ? '<span class="chip">合成</span>' : ''}
      </div>`;
    const select = () => withDiscardGuard(() => selectCase(c.id));
    li.addEventListener('click', select);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select();
      }
    });
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function selectedCase() {
  return state.cases.find((c) => c.id === state.selectedId) ?? null;
}

function markDirty() {
  state.dirty = true;
  $('input-dirty').hidden = false;
  updateActionGates();
}

function clearDirty() {
  state.dirty = false;
  $('input-dirty').hidden = true;
  updateActionGates();
}

function markReviewDirty() {
  state.reviewDirty = true;
  $('review-dirty').hidden = false;
  updateActionGates();
}

function clearReviewDirty() {
  state.reviewDirty = false;
  $('review-dirty').hidden = true;
  updateActionGates();
}

function applyCaseToForm(c) {
  $('f-question').value = c.question ?? '';
  $('f-language').value = c.inputLanguage;
  $('f-im').value = c.targetIM;
  $('f-surface').value = c.surface;
  $('f-kind').value = c.outputKind;
  $('f-width').value = c.width;
  $('f-height').value = c.height;
  $('f-notes').value = c.notes ?? '';
  $('f-maxdiff').value = c.maxDiffRatio ?? 0.005;
  $('f-synthetic').checked = c.synthetic === true;
  state.draft = collectDraft();
  clearDirty();
}

function collectDraft() {
  return {
    question: $('f-question').value,
    inputLanguage: $('f-language').value,
    targetIM: $('f-im').value,
    surface: $('f-surface').value,
    outputKind: $('f-kind').value,
    width: Number($('f-width').value),
    height: Number($('f-height').value),
    notes: $('f-notes').value,
    maxDiffRatio: Number($('f-maxdiff').value),
    synthetic: $('f-synthetic').checked,
  };
}

function renderAll() {
  renderList();
  renderEditor();
}

function renderEditor() {
  const c = selectedCase();
  const placeholder = $('input-placeholder');
  const form = $('case-form');
  if (!c) {
    placeholder.hidden = false;
    placeholder.textContent = '选择左侧用例，或新建一个。';
    form.hidden = true;
    clearReviewDirty();
    return;
  }
  placeholder.hidden = true;
  form.hidden = false;
  applyCaseToForm(c);
  renderAttachments();
  renderResult();
  updateActionGates();
}

function renderAttachments() {
  const c = selectedCase();
  const list = $('attachment-list');
  const empty = $('attachment-empty');
  list.innerHTML = '';
  const atts = c?.attachments ?? [];
  empty.hidden = atts.length > 0;
  for (const att of atts) {
    const li = document.createElement('li');
    li.className = 'attachment-item';
    const src = `/api/cases/${encodeURIComponent(c.id)}/attachments/${encodeURIComponent(att.id)}/raw`;
    let thumb = '<span class="chip">文件</span>';
    if (att.kind === 'image') {
      thumb = `<img class="attachment-thumb" src="${src}" alt="${escapeHtml(att.name)}" loading="lazy" />`;
    } else if (att.kind === 'video') {
      thumb = `<video class="attachment-thumb" src="${src}" muted preload="metadata"></video>`;
    } else if (att.kind === 'audio') {
      thumb = '<span class="chip">音频</span>';
    }
    li.innerHTML = `
      ${thumb}
      <div class="att-body">
        <div class="att-name">${escapeHtml(att.name)}</div>
        <div class="att-meta">${escapeHtml(att.kind)} · ${escapeHtml(att.mime)} · ${(att.size / 1024).toFixed(1)} KB</div>
        <audio controls preload="none" src="${src}" hidden></audio>
      </div>
      <a class="btn btn-ghost btn-small" href="${src}" download="${escapeHtml(att.name)}">下载</a>
      <button type="button" class="btn btn-ghost btn-small" data-remove-att="${escapeHtml(att.id)}">移除</button>
    `;
    if (att.kind === 'audio') {
      const audio = li.querySelector('audio');
      audio.hidden = false;
    }
    li.querySelector('[data-remove-att]').addEventListener('click', () => removeAttachment(att.id));
    list.appendChild(li);
  }
}

async function withDiscardGuard(action, { message } = {}) {
  if (state.dirty || state.reviewDirty) {
    const ok = await confirmDialog(
      '放弃未保存的修改？',
      message ?? '当前有未保存的输入或评审变更，继续将丢失这些修改。',
    );
    if (!ok) return;
  }
  return action();
}

async function selectCase(id) {
  state.selectedId = id;
  renderList();
  renderEditor();
}

function newCase() {
  if (!state.meta) {
    showToast('元数据尚未加载，请先刷新', 'error');
    return;
  }
  return withDiscardGuard(() => {
    state.selectedId = null;
    state.draft = null;
    clearDirty();
    clearReviewDirty();
    $('input-placeholder').hidden = true;
    $('case-form').hidden = false;
    $('case-form').reset();
    $('f-language').value = state.meta.inputLanguages[0];
    $('f-im').value = state.meta.targetIMs[0];
    $('f-surface').value = state.meta.surfaces[0];
    $('f-kind').value = state.meta.outputKinds[0];
    $('f-width').value = 390;
    $('f-height').value = 844;
    $('f-maxdiff').value = state.meta.defaultMaxDiffRatio;
    $('f-synthetic').checked = false;
    $('attachment-list').innerHTML = '';
    $('attachment-empty').hidden = false;
    $('result-placeholder').hidden = false;
    $('result-body').hidden = true;
    state.dirty = true;
    $('input-dirty').hidden = false;
    $('input-placeholder').textContent = '新建用例：填写后点击「保存用例」。';
    renderList();
    updateActionGates();
    $('f-question').focus();
  });
}

function applyCaseUpdate(updated) {
  const idx = state.cases.findIndex((c) => c.id === updated.id);
  if (idx >= 0) state.cases[idx] = updated;
  else state.cases.push(updated);
  state.selectedId = updated.id;
}

async function saveCase(event) {
  event.preventDefault();
  if (state.busy) return;
  if (state.reviewDirty) {
    const ok = await confirmDialog(
      '保存用例会丢弃未保存的评审修改？',
      '输入变更会撤销现有评审；未保存的评分/结论修改将丢失。',
    );
    if (!ok) return;
  }
  const draft = collectDraft();
  if (!draft.question || draft.question.trim().length === 0) {
    showToast('请填写问题 / 场景描述', 'error');
    return;
  }
  state.busy = true;
  $('btn-save-case').disabled = true;
  try {
    let payload;
    if (state.selectedId) {
      payload = await api('PUT', `/api/cases/${encodeURIComponent(state.selectedId)}`, {
        revision: state.revision,
        case: draft,
      });
    } else {
      payload = await api('POST', '/api/cases', { revision: state.revision, case: draft });
    }
    state.revision = payload.revision;
    applyCaseUpdate(payload.case);
    applyCaseToForm(payload.case);
    hideBanner();
    setStatusChip($('store-status'), 'ok', `rev ${state.revision} · ${state.cases.length} 用例`);
    showToast('用例已保存');
    renderList();
    renderAttachments();
    renderResult();
    updateActionGates();
  } catch (err) {
    handleMutationError(err);
  } finally {
    state.busy = false;
    $('btn-save-case').disabled = false;
  }
}

async function deleteCase() {
  const c = selectedCase();
  if (!c) return;
  const ok = await confirmDialog('删除用例？', `将永久删除「${c.question.slice(0, 40)}…」。此操作不可撤销。`);
  if (!ok) return;
  try {
    const payload = await api('DELETE', `/api/cases/${encodeURIComponent(c.id)}`, {
      revision: state.revision,
    });
    state.revision = payload.revision;
    state.cases = state.cases.filter((x) => x.id !== c.id);
    state.selectedId = null;
    clearDirty();
    clearReviewDirty();
    showToast('用例已删除');
    renderAll();
  } catch (err) {
    handleMutationError(err);
  }
}

async function addAttachments(files) {
  const c = selectedCase();
  if (!c) {
    showToast('请先保存用例，再添加附件', 'error');
    return;
  }
  for (const file of files) {
    try {
      const dataBase64 = await fileToBase64(file);
      const payload = await api('POST', `/api/cases/${encodeURIComponent(c.id)}/attachments`, {
        revision: state.revision,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        dataBase64,
      });
      state.revision = payload.revision;
      applyCaseUpdate(payload.case);
      clearReviewDirty();
      renderAttachments();
      renderResult();
      renderList();
      showToast(`已添加附件 ${file.name}`);
    } catch (err) {
      handleMutationError(err);
    }
  }
}

async function removeAttachment(attId) {
  const c = selectedCase();
  if (!c) return;
  const ok = await confirmDialog('移除附件？', '移除后将撤销已有的评审与金标绑定。');
  if (!ok) return;
  try {
    const payload = await api(
      'DELETE',
      `/api/cases/${encodeURIComponent(c.id)}/attachments/${encodeURIComponent(attId)}`,
      { revision: state.revision },
    );
    state.revision = payload.revision;
    applyCaseUpdate(payload.case);
    applyCaseToForm(payload.case);
    renderAttachments();
    renderResult();
    renderList();
  } catch (err) {
    handleMutationError(err);
  }
}

// ---------------------------------------------------------------------------
// Result + review
// ---------------------------------------------------------------------------

async function uploadCandidate(file) {
  return withDiscardGuard(
    async () => {
      const c = selectedCase();
      if (!c) {
        showToast('请先保存用例，再上传候选 PNG', 'error');
        return;
      }
      try {
        const dataBase64 = await fileToBase64(file);
        const payload = await api('POST', `/api/cases/${encodeURIComponent(c.id)}/candidate`, {
          revision: state.revision,
          name: file.name,
          mime: 'image/png',
          dataBase64,
        });
        state.revision = payload.revision;
        applyCaseUpdate(payload.case);
        clearReviewDirty();
        renderResult();
        renderList();
        if (!payload.dimensionsMatchCase) {
          showBanner('候选 PNG 尺寸与用例设定的宽高不一致，不能设为金标；可在评审中标记为坏例。', {
            kind: 'warn',
          });
        } else {
          hideBanner();
          showToast('候选 PNG 已上传');
        }
      } catch (err) {
        handleMutationError(err);
      }
    },
    { message: '上传候选会重置当前评审状态，未保存的评审修改将丢失。' },
  );
}

async function removeCandidate() {
  const c = selectedCase();
  if (!c) return;
  const ok = await confirmDialog('移除候选 PNG？', '移除后将同时撤销评审与金标绑定。');
  if (!ok) return;
  try {
    const payload = await api('DELETE', `/api/cases/${encodeURIComponent(c.id)}/candidate`, {
      revision: state.revision,
    });
    state.revision = payload.revision;
    applyCaseUpdate(payload.case);
    clearReviewDirty();
    renderResult();
    renderList();
  } catch (err) {
    handleMutationError(err);
  }
}

function renderScoreGroups() {
  const container = $('score-groups');
  if (!state.meta) return;
  container.innerHTML = '';
  const labels = {
    content: '内容正确性',
    imFidelity: 'IM 风格还原',
    layout: '布局',
    completeness: '完整性',
  };
  for (const field of state.meta.scoreFields) {
    const rubric = state.meta.rubric[field];
    const group = document.createElement('div');
    group.className = 'score-group';
    group.innerHTML = `
      <div class="score-label">${escapeHtml(labels[field] ?? field)}</div>
      <div class="score-rubric">0 ${escapeHtml(rubric['0'])} · 1 ${escapeHtml(rubric['1'])} · 2 ${escapeHtml(rubric['2'])}</div>
      <div class="score-options">
        ${state.meta.scoreValues
          .map(
            (v) => `<label><input type="radio" name="score-${field}" value="${v}" /> ${v}</label>`,
          )
          .join('')}
      </div>`;
    container.appendChild(group);
  }
}

function applyReviewToForm(c) {
  const review = c?.review;
  for (const field of state.meta.scoreFields) {
    const inputs = document.querySelectorAll(`input[name="score-${field}"]`);
    for (const input of inputs) {
      input.checked = review?.scores?.[field] === Number(input.value);
    }
  }
  $('r-verdict').value = review?.verdict ?? 'unreviewed';
  $('r-reason').value = review?.reason ?? '';
  clearReviewDirty();
}

function renderResult() {
  const c = selectedCase();
  const placeholder = $('result-placeholder');
  const body = $('result-body');
  const gate = $('result-gate');
  if (!c || !c.id || !state.cases.some((x) => x.id === c.id)) {
    placeholder.hidden = false;
    body.hidden = true;
    gate.hidden = true;
    return;
  }
  placeholder.hidden = true;
  body.hidden = false;

  // Candidate preview
  const preview = $('candidate-preview');
  if (c.candidate) {
    const src = `/api/cases/${encodeURIComponent(c.id)}/candidate.png?v=${encodeURIComponent(c.candidate.sha256).slice(0, 12)}`;
    const staleNote = c.computed?.candidateCurrent
      ? ''
      : '<p class="preview-caption" style="color:#9a6a00">⚠ 候选已过期：输入/目标已变更，必须重新上传后才能评审或设为金标。</p>';
    preview.innerHTML = `
      <img src="${src}" alt="候选输出预览" />
      <p class="preview-caption">${c.candidate.width}×${c.candidate.height} px · ${(c.candidate.size / 1024).toFixed(1)} KB · sha256 ${escapeHtml(c.candidate.sha256).slice(0, 12)}…</p>
      <p><a class="btn btn-ghost btn-small" href="${src}" download="${escapeHtml(c.candidate.name || 'candidate.png')}">下载候选 PNG</a></p>
      ${staleNote}`;
  } else {
    preview.innerHTML = '<p class="empty small">尚未上传候选 PNG。</p>';
  }

  applyReviewToForm(c);

  const goldenCurrent = c.computed?.goldenCurrent;
  if (goldenCurrent) setStatusChip(gate, 'ok', '已绑定金标');
  else if (!c.candidate) setStatusChip(gate, 'idle', '无候选');
  else if (!c.computed?.candidateCurrent) setStatusChip(gate, 'warn', '候选过期');
  else if (c.review?.verdict === 'good') setStatusChip(gate, 'ok', '可设金标');
  else if (c.review?.verdict === 'bad') setStatusChip(gate, 'error', '坏例');
  else setStatusChip(gate, 'idle', '未评审');
  updateActionGates();
}

function updateActionGates() {
  const c = selectedCase();
  const canReview =
    !!c && !!c.candidate && c.computed?.candidateCurrent === true && !state.dirty && !state.busy;
  $('btn-save-review').disabled = !canReview;
  $('btn-promote').disabled = !(
    canReview &&
    c.review?.verdict === 'good' &&
    !state.reviewDirty
  );
  $('btn-revoke-golden').disabled = !(c?.golden?.approved);
  $('btn-remove-candidate').disabled = !c?.candidate;
}

async function saveReview() {
  const c = selectedCase();
  if (!c) return;
  const scores = {};
  for (const field of state.meta.scoreFields) {
    const checked = document.querySelector(`input[name="score-${field}"]:checked`);
    scores[field] = checked ? Number(checked.value) : null;
  }
  const verdict = $('r-verdict').value;
  const reason = $('r-reason').value;
  try {
    const payload = await api('PUT', `/api/cases/${encodeURIComponent(c.id)}/review`, {
      revision: state.revision,
      review: { scores, verdict, reason },
    });
    state.revision = payload.revision;
    applyCaseUpdate(payload.case);
    renderResult();
    renderList();
    showToast('评审已保存');
  } catch (err) {
    handleMutationError(err);
  }
}

async function promoteGolden() {
  const c = selectedCase();
  if (!c) return;
  if (state.reviewDirty) {
    showToast('请先保存评审，再设为金标', 'error');
    return;
  }
  const ok = await confirmDialog(
    '设为金标？',
    '这将把当前已评审为 good 的候选 PNG 绑定为金标基线，导出时的指纹与容差会一并固定。任何后续评审修改都会撤销该绑定。',
  );
  if (!ok) return;
  try {
    const payload = await api('POST', `/api/cases/${encodeURIComponent(c.id)}/golden`, {
      revision: state.revision,
    });
    state.revision = payload.revision;
    applyCaseUpdate(payload.case);
    renderResult();
    renderList();
    showToast('已设为金标');
  } catch (err) {
    handleMutationError(err);
  }
}

async function revokeGolden() {
  const c = selectedCase();
  if (!c) return;
  const ok = await confirmDialog('撤销金标？', '撤销后该用例不再属于可导出的金标集合。');
  if (!ok) return;
  try {
    const payload = await api('DELETE', `/api/cases/${encodeURIComponent(c.id)}/golden`, {
      revision: state.revision,
    });
    state.revision = payload.revision;
    applyCaseUpdate(payload.case);
    renderResult();
    renderList();
    showToast('已撤销金标');
  } catch (err) {
    handleMutationError(err);
  }
}

// ---------------------------------------------------------------------------
// Export / import / starters
// ---------------------------------------------------------------------------

function openExportDialog() {
  const dlg = $('export-dialog');
  dlg.returnValue = 'cancel';
  dlg.showModal();
}

async function runExport() {
  const scope = document.querySelector('input[name="export-scope"]:checked')?.value ?? 'private';
  try {
    const bundle = await api('POST', '/api/export', { scope });
    const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `imstage-golden-${scope}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    if (bundle.cases.length === 0) {
      showBanner(
        scope === 'synthetic'
          ? '没有明确标记为合成的已批准金标用例，未导出任何内容。'
          : '没有已批准的金标用例，未导出任何内容。',
        { kind: 'warn' },
      );
    } else {
      showToast(`已导出 ${bundle.cases.length} 条金标用例`);
      hideBanner();
    }
  } catch (err) {
    handleMutationError(err);
  }
}

async function importBundle(file) {
  return withDiscardGuard(async () => {
    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('选择的文件不是合法 JSON');
      }
      const payload = await api('POST', '/api/import', {
        bundle: parsed,
        revision: state.revision,
      });
      state.revision = payload.revision;
      showToast(`已导入 ${payload.imported.length} 条用例（新 ID）`);
      hideBanner();
      await reloadStore();
    } catch (err) {
      handleMutationError(err);
    }
  });
}

async function loadStarters() {
  return withDiscardGuard(async () => {
    const ok = await confirmDialog(
      '加载合成起始用例？',
      '将添加 3 条明确标记为合成的几何占位用例（未评审，不是真实 UI，也不是已批准的金标）。不会自动写入你的私有数据。',
    );
    if (!ok) return;
    try {
      const payload = await api('POST', '/api/starter', { revision: state.revision });
      state.revision = payload.revision;
      showToast(`已加载 ${payload.imported.length} 条合成用例`);
      await reloadStore();
    } catch (err) {
      handleMutationError(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function bindFormDirtyTracking() {
  const form = $('case-form');
  form.addEventListener('input', (e) => {
    if (e.target.type === 'file') return;
    if (e.target.closest('#case-form')) markDirty();
  });
  form.addEventListener('change', (e) => {
    if (e.target.type === 'file') return;
    markDirty();
  });
  form.addEventListener('submit', saveCase);
}

function isReviewControl(el) {
  if (!el) return false;
  if (el.id === 'r-verdict' || el.id === 'r-reason') return true;
  return typeof el.name === 'string' && el.name.startsWith('score-');
}

function bindResultDirtyTracking() {
  const body = $('result-body');
  const handler = (e) => {
    if (isReviewControl(e.target)) markReviewDirty();
  };
  body.addEventListener('input', handler);
  body.addEventListener('change', handler);
}

function bindFilters() {
  $('filter-q').addEventListener('input', (e) => {
    state.filters.q = e.target.value;
    renderList();
  });
  $('filter-im').addEventListener('change', (e) => {
    state.filters.targetIM = e.target.value;
    renderList();
  });
  $('filter-surface').addEventListener('change', (e) => {
    state.filters.surface = e.target.value;
    renderList();
  });
  $('filter-status').addEventListener('change', (e) => {
    state.filters.status = e.target.value;
    renderList();
  });
  $('filter-kind').addEventListener('change', (e) => {
    state.filters.outputKind = e.target.value;
    renderList();
  });
}

function bindActions() {
  $('btn-refresh').addEventListener('click', () => withDiscardGuard(() => reloadStore()));
  $('btn-new-case').addEventListener('click', newCase);
  $('btn-revert').addEventListener('click', () => {
    const c = selectedCase();
    if (!c) return;
    applyCaseToForm(c);
    applyReviewToForm(c);
    showToast('已放弃修改');
  });
  $('btn-delete-case').addEventListener('click', deleteCase);
  $('btn-save-review').addEventListener('click', saveReview);
  $('btn-promote').addEventListener('click', promoteGolden);
  $('btn-revoke-golden').addEventListener('click', revokeGolden);
  $('btn-remove-candidate').addEventListener('click', removeCandidate);
  $('btn-starter').addEventListener('click', loadStarters);
  $('btn-export').addEventListener('click', openExportDialog);
  $('btn-import').addEventListener('click', async () => {
    if (state.dirty || state.reviewDirty) {
      const ok = await confirmDialog('放弃未保存的修改？', '导入前需要放弃未保存的输入或评审修改。');
      if (!ok) return;
    }
    $('import-file').value = '';
    $('import-file').click();
  });
  $('import-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importBundle(file);
  });
  $('attachment-file').addEventListener('change', (e) => {
    if (e.target.files?.length) addAttachments([...e.target.files]);
    e.target.value = '';
  });
  $('candidate-file').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) uploadCandidate(file);
    e.target.value = '';
  });
  $('banner-close').addEventListener('click', hideBanner);
  $('export-confirm').addEventListener('click', runExport);
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty || state.reviewDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function init() {
  bindFormDirtyTracking();
  bindResultDirtyTracking();
  bindFilters();
  bindActions();
  try {
    await loadMeta();
  } catch (err) {
    showBanner(`初始化失败：${err.message}`, { kind: 'error' });
    setStatusChip($('store-status'), 'error', '初始化失败');
    return;
  }
  await reloadStore();
}

init();

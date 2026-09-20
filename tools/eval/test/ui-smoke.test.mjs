import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { PACKAGE_DIR } from '../src/util.mjs';

// Minimal DOM stub good enough to execute public/app.js's real init() flow.
// This catches module-level runtime errors such as a call to an undefined
// function that a static check would miss.
function createElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    hidden: false,
    disabled: false,
    checked: false,
    dataset: {},
    style: {},
    tabIndex: 0,
    value: '',
    textContent: '',
    _innerHTML: '',
    returnValue: 'cancel',
    get innerHTML() {
      return this._innerHTML;
    },
    set innerHTML(v) {
      this._innerHTML = String(v);
      this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
    },
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      if (this._listeners[type]) {
        this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
      }
    },
    dispatch(type, event = {}) {
      return Promise.all((this._listeners[type] ?? []).map((fn) => fn(event)));
    },
    _listeners: {},
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    removeAttribute(key) { delete this.attributes[key]; },
    getAttribute(key) {
      return this.attributes[key];
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    focus() {},
    reset() {},
    click() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    remove() {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      },
    },
  };
}

function installDom() {
  const byId = new Map();
  const document = {
    getElementById(id) {
      if (!byId.has(id)) {
        const element = createElement('div');
        element.value = ({ 'target-im': 'wechat', surface: 'ios', 'output-kind': 'screenshot' })[id] || '';
        byId.set(id, element);
      }
      return byId.get(id);
    },
    createElement(tag) {
      return createElement(tag);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    body: createElement('body'),
  };
  const window = { addEventListener() {}, location: { href: 'http://127.0.0.1:4421/' } };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  globalThis.document = document;
  globalThis.window = window;
  return { document, window, byId };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
  };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('note composer boots with generation defaults and restores no required form fields', async () => {
  const { document, byId } = installDom();
  globalThis.fetch = async (url) => {
    if (url === '/api/store') return jsonResponse({ revision: 0, cases: [] });
    if (url === '/api/generation') return jsonResponse({ configured: true, model: 'test' });
    throw new Error(`unexpected fetch ${url}`);
  };
  await import(`${pathToFileURL(path.join(PACKAGE_DIR, 'public', 'app.js')).href}?boot=${Date.now()}`);
  assert.equal(await waitFor(() => byId.get('generation-hint')?.textContent.includes('自动识别')), true);
  assert.equal(document.getElementById('connection').dataset.state, 'ok');
  assert.equal(document.getElementById('target-im').value, 'wechat');
  assert.equal(document.getElementById('surface').value, 'ios');
  assert.equal(document.getElementById('generate').disabled, true, 'empty note cannot invoke a paid call');
  const note = document.getElementById('note-text');
  note.value = '两位同事商量周末露营';
  await note.dispatch('input');
  assert.equal(document.getElementById('generate').disabled, false);
  assert.equal(document.getElementById('result-view').hidden, true);
});

test('selecting a case renders the result/review panes without runtime errors', async () => {
  const { document, byId } = installDom();
  const candidateSha = 'a'.repeat(64);
  const caseObj = {
    id: 'c_smoke',
    revision: 1,
    createdAt: 'x',
    updatedAt: 'x',
    question: 'smoke case',
    inputLanguage: 'zh-CN',
    targetIM: 'wechat',
    surface: 'ios',
    outputKind: 'screenshot',
    width: 64,
    height: 64,
    notes: '',
    maxDiffRatio: 0.005,
    synthetic: false,
    attachments: [],
    candidate: {
      id: 'cand',
      name: 'c_smoke.png',
      mime: 'image/png',
      size: 1234,
      sha256: candidateSha,
      width: 64,
      height: 64,
      uploadedAt: 'x',
      inputFingerprint: `sha256:${'b'.repeat(64)}`,
    },
    review: {
      status: 'reviewed',
      scores: { content: 2, imFidelity: 2, layout: 2, completeness: 2 },
      verdict: 'good',
      reason: '',
      rubricVersion: 'v1',
      candidateSha256: candidateSha,
      inputFingerprint: `sha256:${'b'.repeat(64)}`,
      fingerprint: `sha256:${'c'.repeat(64)}`,
    },
    golden: null,
    computed: {
      inputFingerprint: `sha256:${'b'.repeat(64)}`,
      candidateCurrent: true,
      reviewCurrent: true,
      goldenCurrent: false,
      exportable: false,
    },
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/generation')) return jsonResponse({ configured: true });
    if (String(url).endsWith('/api/store')) {
      return jsonResponse({ schemaVersion: 1, revision: 3, updatedAt: 'x', cases: [caseObj] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const appUrl = `${pathToFileURL(path.join(PACKAGE_DIR, 'public', 'app.js')).href}?smoke-case=${Date.now()}`;
  await import(appUrl);
  assert.equal(await waitFor(() => byId.get('connection')?.dataset.state === 'ok'), true);
  const list = document.getElementById('history');
  assert.match(list.innerHTML, /smoke case/);
  await list.dispatch('click', { target: { closest() { return { dataset: { id: 'c_smoke' } }; } } });
  assert.equal(document.getElementById('composer-view').hidden, true);
  assert.equal(document.getElementById('result-view').hidden, false);
  assert.equal(document.getElementById('source-text').textContent, 'smoke case');
  assert.match(document.getElementById('result-image').src, /c_smoke\/candidate\.png/);
  assert.equal(document.getElementById('golden-area').hidden, false);
  assert.equal(document.getElementById('promote').disabled, false);
  // A new bad judgement immediately withdraws promotion and needs an explanation.
  await document.getElementById('judge-bad').dispatch('click');
  assert.equal(document.getElementById('golden-area').hidden, true);
  assert.equal(document.getElementById('save-review').disabled, true);
  document.getElementById('review-reason').value = '关键消息遗漏';
  await document.getElementById('review-reason').dispatch('input');
  assert.equal(document.getElementById('save-review').disabled, false);
});

test('every DOM id referenced by app.js exists in index.html', () => {
  const appJs = fs.readFileSync(path.join(PACKAGE_DIR, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(PACKAGE_DIR, 'public', 'index.html'), 'utf8');
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...appJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !defined.has(id));
  assert.deepEqual(missing, []);
});

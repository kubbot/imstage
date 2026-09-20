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
      for (const fn of this._listeners[type] ?? []) fn(event);
    },
    _listeners: {},
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
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
      if (!byId.has(id)) byId.set(id, createElement('div'));
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

const META = {
  version: '0.1.0',
  rubricVersion: 'v1',
  threshold: 0.1,
  defaultMaxDiffRatio: 0.005,
  maxDiffRatioLimit: 0.05,
  maxAttachments: 8,
  maxAttachmentBytes: 2 * 1024 * 1024,
  maxCandidateBytes: 8 * 1024 * 1024,
  maxPixels: 8_000_000,
  targetIMs: ['wechat', 'telegram', 'whatsapp', 'custom'],
  surfaces: ['ios', 'android', 'desktop', 'web'],
  inputLanguages: ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'other'],
  outputKinds: ['screenshot', 'long-screenshot'],
  scoreFields: ['content', 'imFidelity', 'layout', 'completeness'],
  scoreValues: [0, 1, 2],
  verdicts: ['good', 'bad', 'unreviewed'],
  rubric: {
    content: { 0: 'a', 1: 'b', 2: 'c' },
    imFidelity: { 0: 'a', 1: 'b', 2: 'c' },
    layout: { 0: 'a', 1: 'b', 2: 'c' },
    completeness: { 0: 'a', 1: 'b', 2: 'c' },
  },
};

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

test('app.js boots through its real init flow with a stubbed DOM and API', async () => {
  const { document, byId } = installDom();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/meta')) return jsonResponse(META);
    if (String(url).endsWith('/api/store')) {
      return jsonResponse({ schemaVersion: 1, revision: 0, updatedAt: 'x', cases: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const appUrl = `${pathToFileURL(path.join(PACKAGE_DIR, 'public', 'app.js')).href}?smoke=${Date.now()}`;
  await import(appUrl);

  const settled = await waitFor(() => byId.get('store-status')?.dataset.state === 'ok');
  const status = document.getElementById('store-status');
  const bannerText = document.getElementById('banner-text').textContent;
  assert.equal(
    settled,
    true,
    `UI did not finish init: state=${status.dataset.state} banner=${bannerText}`,
  );
  assert.equal(status.dataset.state, 'ok');
  assert.match(status.textContent, /rev 0/);
  assert.ok(calls.some((c) => c.endsWith('/api/meta')));
  assert.ok(calls.some((c) => c.endsWith('/api/store')));

  // Filter selects must keep the 全部 placeholder and show labelled options.
  const filterIm = document.getElementById('filter-im');
  assert.equal(filterIm.children[0].value, '');
  assert.equal(filterIm.children[0].textContent, '全部');
  const wechatOption = filterIm.children.find((c) => c.value === 'wechat');
  assert.ok(wechatOption, 'wechat option missing');
  assert.notEqual(wechatOption.textContent, 'wechat', 'option should have a human label');
  assert.match(wechatOption.textContent, /微信/);

  // Form selects default to a real value, not a blank.
  assert.equal(document.getElementById('f-language').value, 'zh-CN');
  assert.equal(document.getElementById('f-im').value, 'wechat');

  // Dynamic, human-readable limits are rendered.
  assert.match(document.getElementById('attachment-hint').textContent, /最多 8 个附件/);
  assert.match(document.getElementById('attachment-hint').textContent, /2 MB/);
  assert.match(document.getElementById('candidate-hint').textContent, /8 MB/);
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
    if (String(url).endsWith('/api/meta')) return jsonResponse(META);
    if (String(url).endsWith('/api/store')) {
      return jsonResponse({ schemaVersion: 1, revision: 3, updatedAt: 'x', cases: [caseObj] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const appUrl = `${pathToFileURL(path.join(PACKAGE_DIR, 'public', 'app.js')).href}?smoke-case=${Date.now()}`;
  await import(appUrl);
  const settled = await waitFor(() => byId.get('store-status')?.dataset.state === 'ok');
  assert.equal(settled, true, 'UI did not finish init');

  const list = document.getElementById('case-list');
  assert.equal(list.children.length, 1);
  // Clicking the list item runs the real selection flow synchronously.
  list.children[0].dispatch('click', {});

  assert.equal(document.getElementById('input-placeholder').hidden, true);
  assert.equal(document.getElementById('case-form').hidden, false);
  assert.equal(document.getElementById('result-body').hidden, false);
  assert.equal(document.getElementById('f-question').value, 'smoke case');
  assert.match(
    document.getElementById('candidate-preview').innerHTML,
    /c_smoke\/candidate\.png/,
  );
  assert.equal(document.getElementById('result-gate').textContent, '可设金标');
  assert.equal(document.getElementById('btn-promote').disabled, false);
});

test('every DOM id referenced by app.js exists in index.html', () => {
  const appJs = fs.readFileSync(path.join(PACKAGE_DIR, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(PACKAGE_DIR, 'public', 'index.html'), 'utf8');
  const defined = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...appJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !defined.has(id));
  assert.deepEqual(missing, []);
});

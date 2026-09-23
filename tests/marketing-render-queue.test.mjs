/**
 * Ordering rules for the landing export preview.
 *
 * The renderer is async, so the queue must guarantee that only the newest
 * revision can publish, that a request arriving mid-render triggers a rerun,
 * and that cancellation discards stale success and failure alike.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRevisionQueue } from '../apps/web/src/marketing/renderQueue.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('only the newest revision publishes', async () => {
  const gates = [];
  const commits = [];
  const queue = createRevisionQueue({
    render: () => { const gate = deferred(); gates.push(gate); return gate.promise; },
    commit: (value) => commits.push(value),
  });

  queue.request();
  assert.equal(gates.length, 1);
  queue.request();
  // The second request must not start a parallel render.
  assert.equal(gates.length, 1);
  gates[0].resolve('first');
  await tick();
  // Dirty rerun picks up the newest revision.
  assert.equal(gates.length, 2);
  gates[1].resolve('second');
  await tick();
  assert.deepEqual(commits, ['second']);
});

test('cancel discards an in-flight result and does not rerun', async () => {
  const gates = [];
  const commits = [];
  const failures = [];
  const queue = createRevisionQueue({
    render: () => { const gate = deferred(); gates.push(gate); return gate.promise; },
    commit: (value) => commits.push(value),
    fail: (error) => failures.push(error.message),
  });

  queue.request();
  queue.cancel();
  gates[0].resolve('stale');
  await tick();
  assert.deepEqual(commits, []);
  assert.deepEqual(failures, []);
  assert.equal(gates.length, 1);
});

test('a stale failure is ignored while the current revision still fails loudly', async () => {
  const gates = [];
  const failures = [];
  const commits = [];
  const queue = createRevisionQueue({
    render: () => { const gate = deferred(); gates.push(gate); return gate.promise; },
    commit: (value) => commits.push(value),
    fail: (error) => failures.push(error.message),
  });

  queue.request();
  queue.cancel();
  queue.request();
  gates[0].reject(new Error('stale failure'));
  await tick();
  assert.deepEqual(failures, []);
  // The cancel also marked the queue dirty through the new request.
  assert.equal(gates.length, 2);
  gates[1].reject(new Error('current failure'));
  await tick();
  assert.deepEqual(failures, ['current failure']);
  assert.deepEqual(commits, []);
  assert.equal(queue.revision, 3);
});

test('a settled queue renders again on the next request', async () => {
  const values = ['a', 'b', 'c'];
  const commits = [];
  let call = 0;
  const queue = createRevisionQueue({
    render: async () => values[call++],
    commit: (value) => commits.push(value),
  });

  queue.request();
  await tick();
  queue.request();
  await tick();
  assert.deepEqual(commits, ['a', 'b']);
});

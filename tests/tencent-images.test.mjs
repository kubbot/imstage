/**
 * Unit tests for the Tencent TokenHub WAND-Vega async image provider.
 *
 * Every test injects a fake `fetchImpl`: there is no network access, no real
 * credential and no paid call. The suite proves the async submit/poll/terminal
 * flow, the bounded abortable deadline (with no resubmission), reference
 * presence, download SSRF hardening and honest failure semantics.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
  assertAllowedCosUrl,
  createTencentImageProvider,
  normalizeReferenceImage,
} from '../services/agent/tencent-images.mjs';
import { ProviderError } from '../services/agent/providers.mjs';

const PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#c0392b' } })
  .png()
  .toBuffer();
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
]);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeProvider(fetchImpl, overrides = {}) {
  return createTencentImageProvider({
    baseUrl: 'https://tokenhub.tencentmaas.com/v1',
    apiKey: 'wand-secret-key',
    model: 'wand-vega-image-lite',
    fetchImpl,
    pollIntervalMs: 1,
    deadlineMs: 5_000,
    ...overrides,
  });
}

/** Routes a task flow; `statuses` is consumed one poll at a time. */
function scriptedFetch({ statuses, imageUrl = 'https://aigc-image.cos.myqcloud.com/r.png', image = PNG, calls = [] }) {
  let poll = 0;
  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      const href = String(url);
      calls.push({ href, init });
      if (href.endsWith('/wand/vega-images/generations')) {
        return jsonResponse({ task_id: 'task-1', request_id: 'req-1' });
      }
      if (href.includes('/wand/vega-images/tasks/')) {
        const status = statuses[Math.min(poll, statuses.length - 1)];
        poll += 1;
        if (status === 'completed') return jsonResponse({ status, data: [{ url: imageUrl }] });
        return jsonResponse({ status });
      }
      if (href.startsWith('https://aigc-image.cos.myqcloud.com/') || imageUrl.startsWith(href.split('?')[0])) {
        return new Response(image, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      throw new Error(`unexpected request: ${href}`);
    },
  };
}

test('text-to-image submits once, polls to completion and validates the downloaded raster', async () => {
  const { fetchImpl, calls } = scriptedFetch({ statuses: ['queued', 'in_progress', 'completed'] });
  const provider = makeProvider(fetchImpl);

  const result = await provider.generate({ prompt: 'a red apple on white' });

  const submits = calls.filter((call) => call.href.endsWith('/wand/vega-images/generations'));
  assert.equal(submits.length, 1, 'the task must be submitted exactly once');
  assert.equal(submits[0].init.method, 'POST');
  assert.equal(submits[0].init.headers.authorization, 'Bearer wand-secret-key');
  const body = JSON.parse(submits[0].init.body);
  assert.equal(body.model, 'wand-vega-image-lite');
  assert.equal(body.size, '1024x1024');
  assert.equal('input' in body, false, 'text-to-image must not send an input array');

  const polls = calls.filter((call) => call.href.includes('/wand/vega-images/tasks/'));
  assert.equal(polls.length, 3);
  assert.equal(polls[0].href, 'https://tokenhub.tencentmaas.com/v1/wand/vega-images/tasks/task-1');
  assert.equal(polls[0].init.method, 'GET');

  const download = calls.find((call) => call.href.startsWith('https://aigc-image.cos.myqcloud.com/'));
  assert.ok(download, 'completed image must be downloaded by the runtime');
  assert.equal(download.init.method, 'GET');
  assert.equal(download.init.redirect, 'error');
  assert.equal(download.init.headers.accept, 'image/*');
  assert.equal(download.init.headers.authorization, undefined, 'downloads must not forward credentials');
  assert.equal(download.init.headers.cookie, undefined);

  assert.deepEqual(Object.keys(result).sort(), ['bytes', 'dataUrl', 'mime']);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.bytes, PNG.length);
  assert.equal(result.dataUrl, PNG_DATA_URL);
});

test('a reference edit transmits the actual inline data URL and never drops it', async () => {
  const { fetchImpl, calls } = scriptedFetch({ statuses: ['completed'] });
  const provider = makeProvider(fetchImpl);

  await provider.generate({ prompt: 'turn the apple green', referenceImage: PNG_DATA_URL });

  const submit = calls.find((call) => call.href.endsWith('/wand/vega-images/generations'));
  const body = JSON.parse(submit.init.body);
  assert.deepEqual(body.input, [
    { content: [{ type: 'input_image', image_url: PNG_DATA_URL }] },
  ]);
  const sent = body.input[0].content[0].image_url;
  assert.equal(
    Buffer.from(sent.slice(sent.indexOf(',') + 1), 'base64').equals(PNG),
    true,
    'the exact reference bytes must be sent, not a placeholder',
  );
});

test('unsupported or malformed references fail closed before any network call', async () => {
  let requests = 0;
  const provider = makeProvider(async () => {
    requests += 1;
    return jsonResponse({ task_id: 'task-1' });
  });

  await assert.rejects(
    () => provider.generate({ prompt: 'x', referenceImage: 'data:image/webp;base64,AAAA' }),
    /参考图片格式不受支持/,
  );
  await assert.rejects(
    () => provider.generate({ prompt: 'x', referenceImage: 'https://example.com/ref.png' }),
    /参考图片格式无效/,
  );
  await assert.rejects(() => provider.generate({ prompt: 'x', referenceImage: 42 }), /参考图片格式无效/);
  assert.equal(requests, 0, 'no submit may happen for an invalid reference');
});

test('reference normalization returns null only when no reference was supplied', () => {
  assert.equal(normalizeReferenceImage(undefined), null);
  assert.equal(normalizeReferenceImage(null), null);
  assert.equal(normalizeReferenceImage(''), null);
  assert.equal(normalizeReferenceImage(PNG_DATA_URL), PNG_DATA_URL);
  assert.throws(() => normalizeReferenceImage('data:image/gif;base64,AAAA'), /不受支持/);
});

test('terminal task failures are reported honestly without echoing upstream data', async () => {
  for (const status of ['failed', 'cancelled', 'incomplete']) {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
      if (href.includes('/wand/vega-images/tasks/')) {
        return jsonResponse({
          status,
          request_id: 'SECRET-REQUEST-ID',
          data: [{ url: 'https://attacker.example/steal?token=SECRET' }],
          message: 'upstream raw secret wand-secret-key',
        });
      }
      throw new Error('no download should happen');
    };
    const provider = makeProvider(fetchImpl);
    await assert.rejects(
      () => provider.generate({ prompt: 'x' }),
      (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.message.includes('SECRET-REQUEST-ID'), false);
        assert.equal(error.message.includes('attacker.example'), false);
        assert.equal(error.message.includes('wand-secret-key'), false);
        assert.equal(error.message.includes('upstream raw secret'), false);
        return true;
      },
    );
  }
});

test('an unknown task status fails closed', async () => {
  const { fetchImpl } = scriptedFetch({ statuses: ['weird-status'] });
  const provider = makeProvider(fetchImpl);
  await assert.rejects(() => provider.generate({ prompt: 'x' }), /未知的任务状态/);
});

test('submit HTTP errors are sanitized to a status-only message', async () => {
  const provider = makeProvider(async () =>
    new Response('secret-key echo wand-secret-key', { status: 401, headers: { 'content-type': 'text/plain' } }),
  );
  await assert.rejects(
    () => provider.generate({ prompt: 'x' }),
    (error) => {
      assert.match(error.message, /鉴权失败/);
      assert.equal(error.message.includes('wand-secret-key'), false);
      assert.equal(error.message.includes('secret-key echo'), false);
      return true;
    },
  );
});

test('caller abort during polling rejects with AbortError', async () => {
  const controller = new AbortController();
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
    if (href.includes('/wand/vega-images/tasks/')) return jsonResponse({ status: 'in_progress' });
    throw new Error('no download');
  };
  const provider = makeProvider(fetchImpl, { pollIntervalMs: 60_000, deadlineMs: 60_000 });
  const promise = provider.generate({ prompt: 'x', signal: controller.signal });
  setTimeout(() => controller.abort(), 15);
  await assert.rejects(() => promise, (error) => error.name === 'AbortError');
});

test('the deadline bounds polling and never resubmits the task', async () => {
  let submits = 0;
  let polls = 0;
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith('/wand/vega-images/generations')) {
      submits += 1;
      return jsonResponse({ task_id: 'task-1' });
    }
    if (href.includes('/wand/vega-images/tasks/')) {
      polls += 1;
      return jsonResponse({ status: 'in_progress' });
    }
    throw new Error('no download');
  };
  const provider = makeProvider(fetchImpl, { pollIntervalMs: 5, deadlineMs: 40 });
  await assert.rejects(() => provider.generate({ prompt: 'x' }), /超时/);
  assert.equal(submits, 1, 'a timed-out task must never be resubmitted');
  assert.ok(polls >= 1);
});

test('a non-string or empty prompt is rejected', async () => {
  const provider = makeProvider(async () => jsonResponse({ task_id: 'task-1' }));
  await assert.rejects(() => provider.generate({ prompt: '' }), /提示词/);
  await assert.rejects(() => provider.generate({ prompt: 'x'.repeat(3000) }), /长度限制/);
});

test('completed-image downloads only allowlisted Tencent COS hosts', async () => {
  const rejected = [
    ['https://aigc-image.cos.myqcloud.com:8443/r.png', /无效/],
    ['https://user:pass@aigc-image.cos.myqcloud.com/r.png', /无效/],
    ['https://evil.example/r.png', /COS 域名/],
    ['https://evilcos.myqcloud.com/r.png', /COS 域名/],
    ['https://cos.myqcloud.com/r.png', /COS 域名/],
    ['https://127.0.0.1/r.png', /COS 域名/],
    ['https://localhost/r.png', /COS 域名/],
    ['https://bucket.cos.ap-guangzhou.myqcloud.com.evil.com/r.png', /COS 域名/],
    ['ftp://bucket.cos.myqcloud.com/r.png', /协议/],
    ['file:///etc/passwd', /协议/],
    ['not a url at all', /无效/],
  ];
  for (const [imageUrl, pattern] of rejected) {
    let downloads = 0;
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
      if (href.includes('/wand/vega-images/tasks/')) return jsonResponse({ status: 'completed', data: [{ url: imageUrl }] });
      downloads += 1;
      throw new Error('download must not run for a rejected URL');
    };
    const provider = makeProvider(fetchImpl);
    await assert.rejects(() => provider.generate({ prompt: 'x' }), pattern, `url: ${imageUrl}`);
    assert.equal(downloads, 0, `no download for ${imageUrl}`);
  }
});

test('allowlisted COS host shapes are accepted and plain HTTP is upgraded', () => {
  for (const url of [
    'https://aigc-image.cos.myqcloud.com/r.png?sig=abc',
    'https://bucket.cos.ap-guangzhou.myqcloud.com/r.png',
    'https://bucket-1.cos.na-siliconvalley.myqcloud.com/cmd.png',
  ]) {
    assert.equal(assertAllowedCosUrl(url).protocol, 'https:');
  }

  // The live WAND API has returned a plain-HTTP COS URL. It must validate as an
  // allowlisted COS host and then be upgraded before any request is issued.
  const observed =
    'http://data-shanghai-1378942524.cos.ap-shanghai.myqcloud.com/result/abc.png?q-sign-algorithm=sha1&q-ak=AKID';
  const upgraded = assertAllowedCosUrl(observed);
  assert.equal(upgraded.protocol, 'https:');
  assert.equal(upgraded.hostname, 'data-shanghai-1378942524.cos.ap-shanghai.myqcloud.com');
  assert.equal(upgraded.port, '');
  assert.equal(upgraded.username, '');
});

test('an HTTP result URL is fetched over HTTPS and never insecurely', async () => {
  const observed =
    'http://data-shanghai-1378942524.cos.ap-shanghai.myqcloud.com/result/abc.png?q-sign-algorithm=sha1&q-ak=AKID';
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
    if (href.includes('/wand/vega-images/tasks/')) {
      return jsonResponse({ status: 'completed', data: [{ url: observed }] });
    }
    return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const result = await makeProvider(fetchImpl).generate({ prompt: 'x' });
  assert.equal(result.mime, 'image/png');
  assert.equal(result.dataUrl, PNG_DATA_URL);
  assert.equal(
    calls.some((call) => call.href.startsWith('http://')),
    false,
    'a plain-HTTP request must never be issued',
  );
  const download = calls.find((call) => call.href.startsWith('https://data-shanghai-1378942524'));
  assert.ok(download, 'the upgraded HTTPS URL must be fetched');
  assert.match(download.href, /^https:\/\/data-shanghai-1378942524\.cos\.ap-shanghai\.myqcloud\.com\//);
});

test('auth-bearing submit and poll requests are never redirected', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
    if (href.includes('/wand/vega-images/tasks/')) {
      return jsonResponse({ status: 'completed', data: [{ url: 'https://bucket.cos.myqcloud.com/r.png' }] });
    }
    return new Response(PNG, { status: 200 });
  };
  await makeProvider(fetchImpl).generate({ prompt: 'x' });
  const submit = calls.find((call) => call.href.endsWith('/wand/vega-images/generations'));
  const poll = calls.find((call) => call.href.includes('/wand/vega-images/tasks/'));
  assert.equal(submit.init.redirect, 'error');
  assert.equal(poll.init.redirect, 'error');
  assert.equal(submit.init.headers.authorization, 'Bearer wand-secret-key');
  assert.equal(poll.init.headers.authorization, 'Bearer wand-secret-key');
});

test('a redirecting download is rejected and never followed', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
    if (href.includes('/wand/vega-images/tasks/')) {
      return jsonResponse({ status: 'completed', data: [{ url: 'https://bucket.cos.myqcloud.com/r.png' }] });
    }
    return new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } });
  };
  const provider = makeProvider(fetchImpl);
  await assert.rejects(() => provider.generate({ prompt: 'x' }), /无法下载/);
  const downloads = calls.filter((call) => call.href.startsWith('https://bucket.cos.myqcloud.com/'));
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].init.redirect, 'error');
  assert.equal(downloads[0].init.headers.authorization, undefined);
});

test('a fetch-level redirect rejection is mapped to a sanitized download error', async () => {
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
    if (href.includes('/wand/vega-images/tasks/')) {
      return jsonResponse({ status: 'completed', data: [{ url: 'https://bucket.cos.myqcloud.com/r.png' }] });
    }
    throw new TypeError('redirect not allowed to https://evil.example/steal');
  };
  const provider = makeProvider(fetchImpl);
  await assert.rejects(
    () => provider.generate({ prompt: 'x' }),
    (error) => {
      assert.match(error.message, /无法下载/);
      assert.equal(error.message.includes('evil.example'), false);
      return true;
    },
  );
});

test('downloads are byte-limited', async () => {
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
    if (href.includes('/wand/vega-images/tasks/')) {
      return jsonResponse({ status: 'completed', data: [{ url: 'https://bucket.cos.myqcloud.com/r.png' }] });
    }
    return new Response(Buffer.alloc(100_000, 7), { status: 200 });
  };
  const provider = makeProvider(fetchImpl, { maxDownloadBytes: 1_000 });
  await assert.rejects(() => provider.generate({ prompt: 'x' }), /大小限制/);
});

test('downloaded bytes must decode as a real image', async () => {
  const runWith = async (image) => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.endsWith('/wand/vega-images/generations')) return jsonResponse({ task_id: 'task-1' });
      if (href.includes('/wand/vega-images/tasks/')) {
        return jsonResponse({ status: 'completed', data: [{ url: 'https://bucket.cos.myqcloud.com/r.png' }] });
      }
      return new Response(image, { status: 200 });
    };
    return makeProvider(fetchImpl).generate({ prompt: 'x' });
  };

  await assert.rejects(() => runWith(Buffer.from('not an image at all')), /格式不受支持/);
  // A forged PNG magic header must not pass the post-download decode check.
  await assert.rejects(() => runWith(FAKE_PNG), /无法解码/);
});

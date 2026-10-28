import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, bindIdentity, safeNext } from '../apps/web/src/account/api.ts';

test('proxy HTML errors report account service unavailability in the selected language', async () => {
  const previousFetch = globalThis.fetch, previousDocument = globalThis.document;
  try {
    for (const [locale, message] of [
      ['zh', '账号服务暂时不可用，请稍后重试。'],
      ['en', 'The account service is temporarily unavailable. Try again shortly.'],
    ]) {
      globalThis.document = { documentElement: { dataset: { locale } } };
      for (const status of [403, 421, 502]) {
        globalThis.fetch = async () => new Response('<html><title>Upstream unavailable</title></html>', { status, headers: { 'Content-Type': 'text/html' } });
        await assert.rejects(api('/auth/login', { method: 'POST', body: { email: 'synthetic@example.test', password: 'synthetic-password' } }), error => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, status);
          assert.equal(error.code, 'unavailable');
          assert.equal(error.message, message);
          return true;
        });
      }
    }
  } finally { globalThis.fetch = previousFetch; globalThis.document = previousDocument; }
});

test('an upstream HTML 401 cannot expire a valid application identity', async () => {
  const previousFetch = globalThis.fetch, previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  let expired = 0;
  window.addEventListener('imstage-session-expired', () => expired++);
  try {
    bindIdentity({ id: 'synthetic-current-user' });
    globalThis.fetch = async () => new Response('<html>Gateway authentication failed</html>', { status: 401, headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(api('/scenes'), error => error instanceof ApiError && error.status === 401 && error.code === 'unavailable');
    assert.equal(expired, 0);
  } finally { globalThis.fetch = previousFetch; globalThis.window = previousWindow; bindIdentity(null); }
});

test('only a current identity unauthorized response expires the session', async () => {
  const previousFetch=globalThis.fetch, previousWindow=globalThis.window;
  globalThis.window=new EventTarget(); let events=0;
  window.addEventListener('imstage-session-expired',()=>events++);
  try {
    let complete;
    globalThis.fetch=()=>new Promise(resolve=>{complete=resolve;});
    bindIdentity({id:'A'}); const old=api('/scenes').catch(e=>e);
    bindIdentity({id:'B'});
    complete(new Response(JSON.stringify({error:{code:'unauthorized',message:'expired'}}),{status:401}));
    await old; assert.equal(events,0);
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'unauthorized',message:'expired'}}),{status:401});
    await assert.rejects(api('/scenes')); assert.equal(events,1);
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{code:'invalid_credentials',message:'wrong password'}}),{status:401});
    await assert.rejects(api('/auth/password')); assert.equal(events,1);
  } finally {globalThis.fetch=previousFetch;globalThis.window=previousWindow;bindIdentity(null);}
});

test('login destinations stay on permitted internal pages',()=>{
  for(const value of ['https://evil.test','//evil.test','/\\evil.test','/docs','#/workspace','/workspace#evil','/login']) assert.equal(safeNext(value),'/workspace');
  assert.equal(safeNext('/studio'),'/studio'); assert.equal(safeNext('/workspace?scene=abc'),'/workspace?scene=abc');
});

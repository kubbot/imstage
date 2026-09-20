import test from 'node:test';
import assert from 'node:assert/strict';
import { api, bindIdentity, safeNext } from '../apps/web/src/account/api.ts';

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

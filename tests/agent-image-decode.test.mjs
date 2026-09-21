import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {assertDecodableImage} from '../services/agent/image-decode.mjs';
test('generated images must actually decode; a forged PNG header cannot succeed', async()=>{
  const invalid = `data:image/png;base64,${Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]).toString('base64')}`;
  await assert.rejects(assertDecodableImage(invalid),/无法解码/);
  for(const type of ['png','jpeg','webp']) {
    const data=await sharp({create:{width:8,height:8,channels:3,background:'#457aff'}}).toFormat(type).toBuffer();
    await assertDecodableImage(`data:image/${type};base64,${data.toString('base64')}`);
  }
});
test('cancelled image validation never reports success',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(assertDecodableImage('data:image/png;base64,AAAA',controller.signal));
});

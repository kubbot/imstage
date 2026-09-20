import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PNG_BYTES } from '../src/constants.mjs';
import { PNG_MAGIC, decodePng, encodePng, isPng, parsePngHeader } from '../src/png.mjs';
import { renderSyntheticChatPng } from '../src/fixtures.mjs';

function ihdrBuffer({ width, height, colorType = 6, bitDepth = 8, chunkType = 'IHDR', chunkLength = 13 }) {
  const buf = Buffer.alloc(33);
  PNG_MAGIC.copy(buf, 0);
  buf.writeUInt32BE(chunkLength, 8);
  buf.write(chunkType, 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt8(bitDepth, 24);
  buf.writeUInt8(colorType, 25);
  buf.writeUInt8(0, 26);
  buf.writeUInt8(0, 27);
  buf.writeUInt8(0, 28);
  return buf;
}

test('valid synthetic PNG decodes with matching dimensions', () => {
  const buf = renderSyntheticChatPng({ width: 48, height: 32, im: 'wechat' });
  assert.ok(isPng(buf));
  const header = parsePngHeader(buf);
  assert.equal(header.width, 48);
  assert.equal(header.height, 32);
  const decoded = decodePng(buf);
  assert.equal(decoded.width, 48);
  assert.equal(decoded.height, 32);
  assert.equal(decoded.data.length, 48 * 32 * 4);
});

test('rejects bad magic bytes', () => {
  const buf = renderSyntheticChatPng({ width: 16, height: 16 });
  const corrupted = Buffer.from(buf);
  corrupted[0] = 0x00;
  assert.equal(isPng(corrupted), false);
  assert.throws(() => parsePngHeader(corrupted), /magic/);
});

test('rejects truncated buffer', () => {
  const buf = renderSyntheticChatPng({ width: 16, height: 16 });
  const truncated = buf.subarray(0, 12);
  assert.throws(() => parsePngHeader(truncated), /最小长度/);
});

test('rejects non-IHDR first chunk', () => {
  const buf = ihdrBuffer({ width: 16, height: 16, chunkType: 'IDAT' });
  assert.throws(() => parsePngHeader(buf), /IHDR/);
});

test('rejects zero dimensions', () => {
  const buf = ihdrBuffer({ width: 0, height: 16 });
  assert.throws(() => parsePngHeader(buf), /宽高/);
});

test('rejects oversized pixel count before allocation', () => {
  const buf = ihdrBuffer({ width: 9000, height: 9000 });
  assert.throws(() => parsePngHeader(buf), /像素上限/);
});

test('rejects per-side dimension over limit', () => {
  const buf = ihdrBuffer({ width: 30000, height: 2 });
  assert.throws(() => parsePngHeader(buf), /单边/);
});

test('rejects invalid color type and bit depth combination', () => {
  const badColor = ihdrBuffer({ width: 8, height: 8, colorType: 7 });
  assert.throws(() => parsePngHeader(badColor), /colorType/);
  const badDepth = ihdrBuffer({ width: 8, height: 8, colorType: 2, bitDepth: 4 });
  assert.throws(() => parsePngHeader(badDepth), /bitDepth/);
});

test('rejects malformed IDAT after a valid header', () => {
  const buf = renderSyntheticChatPng({ width: 40, height: 40 });
  const truncated = buf.subarray(0, 90); // header intact, pixel data incomplete
  assert.ok(truncated.length >= 33);
  assert.throws(() => decodePng(truncated), /解码失败|像素数据/);
});

test('rejects files over the size bound', () => {
  const buf = Buffer.alloc(MAX_PNG_BYTES + 1, 0);
  PNG_MAGIC.copy(buf, 0);
  assert.throws(() => decodePng(buf), /字节上限/);
});

test('decodePng respects a tighter maxBytes option', () => {
  const buf = renderSyntheticChatPng({ width: 64, height: 64 });
  assert.throws(() => decodePng(buf, { maxBytes: 10 }), /字节上限/);
});

test('encodePng round-trips pixel data', () => {
  const data = Buffer.alloc(4 * 4 * 4, 128);
  const encoded = encodePng({ width: 4, height: 4, data });
  const decoded = decodePng(encoded);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 4);
  assert.ok(decoded.data.equals(data));
});

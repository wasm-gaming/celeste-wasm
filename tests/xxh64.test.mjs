import assert from 'node:assert/strict';
import test from 'node:test';

import { XXH64, xxh64, xxh64Stream } from '../dist/celeste/celeste.xxh64.js';

const utf8 = (text) => new TextEncoder().encode(text);
const hex = (value) => value.toString(16).padStart(16, '0');

/**
 * Vectors from the xxHash specification. They are what makes this file worth
 * having: Everest computes the same digests on the other side of the JS/C#
 * boundary, and a hash that is merely self-consistent would pass every other
 * test here while silently invalidating every mod cache.
 */
test('the reference vectors', () => {
  assert.equal(hex(xxh64(utf8(''))), 'ef46db3751d8e999');
  assert.equal(hex(xxh64(utf8('a'))), 'd24ec4f1a98c6e5b');
  assert.equal(hex(xxh64(utf8('abc'))), '44bc2cf5ad770999');
  assert.equal(hex(xxh64(utf8(''), 1n)), 'd5afba1336a3be4b');
});

test('input longer than one stripe takes the accumulator path', () => {
  // 32 bytes is where the four-lane loop starts; the tail then has to cover a
  // full 8-byte word, a 4-byte word and loose bytes to exercise every branch.
  const data = new Uint8Array(32 + 8 + 4 + 3).map((_, i) => (i * 31) % 251);
  assert.match(hex(xxh64(data)), /^[0-9a-f]{16}$/);
  assert.notEqual(hex(xxh64(data)), hex(xxh64(data.subarray(0, data.length - 1))));
});

test('chunked updates match a single pass, at every alignment', () => {
  const data = new Uint8Array(1000).map((_, i) => i % 251);
  const expected = xxh64(data);

  for (const size of [1, 3, 7, 16, 31, 32, 33, 512]) {
    const hash = new XXH64();
    for (let at = 0; at < data.length; at += size) {
      hash.update(data.subarray(at, Math.min(at + size, data.length)));
    }
    assert.equal(hash.digest(), expected, `chunk size ${size}`);
  }
});

test('the seed changes the digest', () => {
  const data = utf8('Celeste');
  assert.notEqual(xxh64(data, 0n), xxh64(data, 1n));
  assert.equal(xxh64(data, 0n), xxh64(data));
});

test('digestBytes is big-endian, and digestHex matches it', () => {
  const hash = new XXH64().update(utf8(''));
  assert.equal(hash.digestHex(), 'EF46DB3751D8E999');
  assert.deepEqual(
    [...hash.digestBytes()],
    [0xef, 0x46, 0xdb, 0x37, 0x51, 0xd8, 0xe9, 0x99],
  );
});

test('hashing a stream matches hashing the bytes', async () => {
  const data = new Uint8Array(5000).map((_, i) => (i * 7) % 256);
  const stream = new ReadableStream({
    start(controller) {
      for (let at = 0; at < data.length; at += 333) {
        controller.enqueue(data.subarray(at, at + 333));
      }
      controller.close();
    },
  });

  assert.equal((await xxh64Stream(stream)).digest(), xxh64(data));
});

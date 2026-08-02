import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFLATED, ZipReader } from '../dist/celeste/celeste.zip.js';

import { buildZip } from './fake-zip.mjs';

const utf8 = (text) => new TextEncoder().encode(text);
const text = (bytes) => new TextDecoder().decode(bytes);

// ------------------------------------------------------------------ tests --

test('stored entries are read back verbatim', async () => {
  const zip = buildZip([{ name: 'Celeste.exe', data: utf8('MZ not really') }]);
  const reader = await ZipReader.open(zip);

  assert.deepEqual(
    reader.entries.map((entry) => entry.name),
    ['Celeste.exe'],
  );
  assert.equal(text(await reader.read(reader.entries[0])), 'MZ not really');
});

test('deflated entries are inflated', async () => {
  // Compressible enough that deflate actually shrinks it, so the stored and
  // compressed sizes differ and a wrong length would truncate the output.
  const body = 'strawberry '.repeat(500);
  const zip = buildZip([{ name: 'Content/Dialog/English.txt', data: utf8(body), method: DEFLATED }]);
  const reader = await ZipReader.open(zip);

  const entry = reader.get('Content/Dialog/English.txt');
  assert.ok(entry);
  assert.equal(entry.method, DEFLATED);
  assert.ok(entry.compressedSize < entry.uncompressedSize);
  assert.equal(text(await reader.read(entry)), body);
});

test('a local extra field does not shift the data offset', async () => {
  const zip = buildZip([
    { name: 'a.txt', data: utf8('first'), localExtra: 0 },
    { name: 'b.txt', data: utf8('second'), localExtra: 24 },
    { name: 'c.txt', data: utf8('third'), method: DEFLATED, localExtra: 9 },
  ]);
  const reader = await ZipReader.open(zip);

  assert.equal(text(await reader.read(reader.get('a.txt'))), 'first');
  assert.equal(text(await reader.read(reader.get('b.txt'))), 'second');
  assert.equal(text(await reader.read(reader.get('c.txt'))), 'third');
});

test('directory entries are flagged and refuse to be read', async () => {
  const zip = buildZip([{ name: 'Content/Maps/' }, { name: 'Content/Maps/1.bin', data: utf8('x') }]);
  const reader = await ZipReader.open(zip);

  const directory = reader.get('Content/Maps/');
  assert.equal(directory.isDirectory, true);
  await assert.rejects(() => reader.read(directory), /is a directory/);
  assert.equal(reader.get('Content/Maps/1.bin').isDirectory, false);
});

test('an entry can be streamed instead of buffered', async () => {
  const body = 'x'.repeat(100_000);
  const zip = buildZip([{ name: 'big', data: utf8(body), method: DEFLATED }]);
  const reader = await ZipReader.open(zip);

  const stream = await reader.stream(reader.get('big'));
  let total = 0;
  const chunks = [];
  for await (const chunk of stream) {
    total += chunk.length;
    chunks.push(chunk);
  }
  assert.equal(total, body.length);
  assert.equal(chunks.length > 0, true);
});

test('the same archive reads identically from a Blob', async () => {
  const zip = buildZip([{ name: 'Celeste.exe', data: utf8('MZ'), method: DEFLATED }]);
  const reader = await ZipReader.open(new Blob([zip]));

  assert.equal(text(await reader.read(reader.get('Celeste.exe'))), 'MZ');
});

test('unknown names resolve to null rather than throwing', async () => {
  const reader = await ZipReader.open(buildZip([{ name: 'a', data: utf8('a') }]));
  assert.equal(reader.get('Celeste.exe'), null);
});

test('something that is not a zip is rejected with a readable message', async () => {
  await assert.rejects(
    () => ZipReader.open(utf8('this is not an archive, it is a sentence')),
    /not a zip archive/,
  );
});

test('an unsupported compression method names itself', async () => {
  // Method 14 is LZMA: legal in the format, and not something this reader does.
  const zip = buildZip([{ name: 'weird', data: utf8('...') }]);
  const patched = Buffer.from(zip);
  patched.writeUInt16LE(14, 8); // local header method
  const centralAt = patched.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  patched.writeUInt16LE(14, centralAt + 10);

  const reader = await ZipReader.open(patched);
  await assert.rejects(() => reader.read(reader.get('weird')), /compression method 14/);
});

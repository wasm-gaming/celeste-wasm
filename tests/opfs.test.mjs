import assert from 'node:assert/strict';
import test from 'node:test';

import { copyDirectoryInto, listPaths } from '../dist/celeste/celeste.opfs.js';
import { FakeDirectoryHandle, read, stats, tree } from './fake-opfs.mjs';

const INSTALL = {
  'Celeste.exe': 'mz',
  'Content/Dialog/english.txt': 'dialog',
  'Content/Maps/1-ForsakenCity.bin': 'map',
};

// ------------------------------------------------------------ copying over --

test('an empty destination gets every file', async () => {
  stats.writes = 0;
  const destination = new FakeDirectoryHandle();
  const copied = await copyDirectoryInto(tree(INSTALL), destination);

  assert.equal(copied, 3);
  assert.equal(stats.writes, 3);
  assert.deepEqual(read(destination), INSTALL);
});

test('a second copy of the same install writes nothing', async () => {
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(INSTALL), destination);

  stats.writes = 0;
  const copied = await copyDirectoryInto(tree(INSTALL), destination);

  assert.equal(copied, 0);
  assert.equal(stats.writes, 0);
  assert.deepEqual(read(destination), INSTALL);
});

test('progress still counts the files that were skipped', async () => {
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(INSTALL), destination);

  const seen = [];
  await copyDirectoryInto(tree(INSTALL), destination, '', (progress) => seen.push(progress));

  assert.equal(seen.length, 3);
  assert.deepEqual(
    seen.map((progress) => progress.done),
    [1, 2, 3],
  );
  assert.equal(seen.at(-1).total, 3);
});

test('a file left truncated by an interrupted copy is rewritten', async () => {
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(INSTALL), destination);

  // What an aborted write leaves behind: the right name, the wrong length.
  const content = await destination.getDirectoryHandle('Content');
  const dialog = await content.getDirectoryHandle('Dialog');
  (await dialog.getFileHandle('english.txt')).bytes = new TextEncoder().encode('dia');

  stats.writes = 0;
  const copied = await copyDirectoryInto(tree(INSTALL), destination);

  assert.equal(copied, 1);
  assert.equal(stats.writes, 1);
  assert.deepEqual(read(destination), INSTALL);
});

test('a file that changed but kept its size is not noticed', async () => {
  // Size is the only identity this can afford — hashing 1.3 GB to answer the
  // question costs more than the copy it saves. Pinned so the limit is a
  // decision on record rather than a surprise.
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(INSTALL), destination);

  stats.writes = 0;
  const copied = await copyDirectoryInto(tree({ ...INSTALL, 'Celeste.exe': 'ZZ' }), destination);

  assert.equal(copied, 0);
  assert.equal(stats.writes, 0);
  assert.equal(read(destination)['Celeste.exe'], 'mz');
});

test('into puts the copy under a subdirectory, and resumes there too', async () => {
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(INSTALL), destination, 'celeste');

  assert.deepEqual(
    read(destination),
    Object.fromEntries(Object.entries(INSTALL).map(([path, body]) => [`celeste/${path}`, body])),
  );

  stats.writes = 0;
  assert.equal(await copyDirectoryInto(tree(INSTALL), destination, 'celeste'), 0);
  assert.equal(stats.writes, 0);
});

// -------------------------------------------------------------- listing it --

test('depth stops the walk before it descends into Content', async () => {
  const root = tree(INSTALL);

  assert.deepEqual((await listPaths(root, '', { depth: 1 })).sort(), ['Celeste.exe', 'Content']);
  assert.ok((await listPaths(root, '', { depth: 3 })).includes('Content/Dialog/english.txt'));
  assert.ok(!(await listPaths(root, '', { depth: 2 })).includes('Content/Dialog/english.txt'));
});

test('a full walk is still the default', async () => {
  // Directories are listed alongside their contents — the install check reads
  // `Content/Maps` as a required entry in its own right.
  assert.deepEqual((await listPaths(tree(INSTALL))).sort(), [
    'Celeste.exe',
    'Content',
    'Content/Dialog',
    'Content/Dialog/english.txt',
    'Content/Maps',
    'Content/Maps/1-ForsakenCity.bin',
  ]);
});

test('limit caps the walk wherever it has got to', async () => {
  assert.equal((await listPaths(tree(INSTALL), '', { limit: 2 })).length, 2);
});

test('a path that is not there lists as empty rather than throwing', async () => {
  assert.deepEqual(await listPaths(tree(INSTALL), 'Mods'), []);
});

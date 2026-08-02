import assert from 'node:assert/strict';
import test from 'node:test';

import {
  copyDirectoryInto,
  listPaths,
  STAGE_CONCURRENCY,
  stageInto,
} from '../dist/celeste/celeste.opfs.js';
import { stageWithWorker } from '../dist/celeste/celeste.stage.js';
import { DEFLATED } from '../dist/celeste/celeste.zip.js';
import { capabilities, FakeDirectoryHandle, read, stats, tree } from './fake-opfs.mjs';
import { buildZip } from './fake-zip.mjs';

const INSTALL = {
  'Celeste.exe': 'mz',
  'Content/Dialog/english.txt': 'dialog',
  'Content/Maps/1-ForsakenCity.bin': 'map',
};

test.beforeEach(() => {
  stats.reset();
  capabilities.syncAccess = false;
});

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
  await copyDirectoryInto(tree(INSTALL), destination, '', {
    onProgress: (progress) => seen.push(progress),
  });

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

// ------------------------------------------------------- what makes it fast --
//
// A real install is ~1,240 files and the copy used to be latency bound: one
// write at a time, and every one of them re-resolving its parent directories
// from the root. These pin the two things that fixed it, because both are
// invisible in the output — the same files land either way, just far slower.

/** Many files, few directories: the shape the directory cache is about. */
const ATLASES = Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => [`Content/Graphics/Atlases/gameplay${i}.data`, `px${i}`]),
);

test('directories are resolved once each, not once per file', async () => {
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(ATLASES), destination);

  // Content, Graphics, Atlases. Resolving them per file would be 120.
  assert.equal(stats.directories, 3);
  assert.equal(Object.keys(read(destination)).length, 40);
});

test('files are written several at a time', async () => {
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(ATLASES), destination);

  assert.ok(stats.peakOpen > 1, `expected overlapping writes, saw ${stats.peakOpen}`);
  assert.ok(stats.peakOpen <= STAGE_CONCURRENCY);
  // Every one of them closed again, whichever route it took.
  assert.equal(stats.open, 0);
});

test('a sync access handle is used wherever one is offered', async () => {
  capabilities.syncAccess = true;
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(INSTALL), destination);

  assert.equal(stats.syncWrites, 3);
  assert.deepEqual(read(destination), INSTALL);
});

test('a sync access handle rewrites a longer file without leaving its tail behind', async () => {
  capabilities.syncAccess = true;
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree({ 'Celeste.exe': 'a much longer build' }), destination);
  await copyDirectoryInto(tree({ 'Celeste.exe': 'short' }), destination);

  assert.equal(read(destination)['Celeste.exe'], 'short');
});

test('the first failure stops the copy instead of being buried by the rest', async () => {
  const source = tree(ATLASES);
  const atlases = await (
    await (await source.getDirectoryHandle('Content')).getDirectoryHandle('Graphics')
  ).getDirectoryHandle('Atlases');
  atlases.children.get('gameplay7.data').getFile = async () => {
    throw new Error('the folder went away mid-copy');
  };

  await assert.rejects(
    copyDirectoryInto(source, new FakeDirectoryHandle()),
    /the folder went away mid-copy/,
  );
});

// ------------------------------------------------------------ staging, once --

test('a directory install stages, minus the prefixes it was told to skip', async () => {
  const destination = new FakeDirectoryHandle();
  const written = await stageInto({
    root: destination,
    source: { kind: 'directory', handle: tree({ ...INSTALL, 'orig/Celeste.exe': 'vanilla' }) },
    into: 'celeste',
    skip: ['orig/'],
  });

  assert.equal(written, 3);
  assert.deepEqual(
    read(destination),
    Object.fromEntries(Object.entries(INSTALL).map(([path, body]) => [`celeste/${path}`, body])),
  );
});

test('a zip install stages through the same call', async () => {
  const utf8 = (body) => new TextEncoder().encode(body);
  const archive = buildZip([
    { name: 'Celeste/Celeste.exe', data: utf8('mz'), method: DEFLATED },
    { name: 'Celeste/Content/Dialog/english.txt', data: utf8('dialog'), method: DEFLATED },
    { name: 'Celeste/orig/Celeste.exe', data: utf8('vanilla') },
  ]);

  const destination = new FakeDirectoryHandle();
  const written = await stageInto({
    root: destination,
    source: { kind: 'zip', archive: new Blob([archive]), strip: 'Celeste/' },
    skip: ['orig/'],
  });

  assert.equal(written, 2);
  assert.deepEqual(read(destination), {
    'Celeste.exe': 'mz',
    'Content/Dialog/english.txt': 'dialog',
  });
});

test('with no Worker to be had, staging runs here and still stages', async () => {
  // Which is the case in node, and the case in any host that bundled this
  // package without emitting the worker beside it.
  assert.equal(typeof Worker, 'undefined');

  const destination = new FakeDirectoryHandle();
  const seen = [];
  const written = await stageWithWorker(
    { root: destination, source: { kind: 'directory', handle: tree(INSTALL) } },
    (progress) => seen.push(progress),
  );

  assert.equal(written, 3);
  assert.equal(seen.at(-1).done, 3);
  assert.deepEqual(read(destination), INSTALL);
});

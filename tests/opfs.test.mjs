import assert from 'node:assert/strict';
import test from 'node:test';

import { copyDirectoryInto, listPaths } from '../dist/celeste/celeste.opfs.js';

// ------------------------------------------------------------------ a fake --
//
// Enough of the File System Access API for the staging code to run in node:
// directory and file handles, `entries()`, and a writable that collects what is
// piped into it. Writes are counted, because the thing under test is which
// files get written at all.

let writes = 0;

class FakeFileHandle {
  kind = 'file';

  constructor(name, bytes = new Uint8Array()) {
    this.name = name;
    this.bytes = bytes;
  }

  async getFile() {
    return new Blob([this.bytes]);
  }

  async createWritable() {
    writes++;
    const chunks = [];
    const handle = this;
    return new WritableStream({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
      },
      close() {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.length;
        }
        handle.bytes = out;
      },
    });
  }
}

class FakeDirectoryHandle {
  kind = 'directory';

  constructor(name = '') {
    this.name = name;
    this.children = new Map();
  }

  async *entries() {
    for (const entry of [...this.children]) yield entry;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    const found = this.children.get(name);
    if (found) {
      if (found.kind !== 'directory') throw new Error(`${name} is a file`);
      return found;
    }
    if (!create) throw new Error(`no such directory: ${name}`);
    const directory = new FakeDirectoryHandle(name);
    this.children.set(name, directory);
    return directory;
  }

  async getFileHandle(name, { create = false } = {}) {
    const found = this.children.get(name);
    if (found) {
      if (found.kind !== 'file') throw new Error(`${name} is a directory`);
      return found;
    }
    if (!create) throw new Error(`no such file: ${name}`);
    const file = new FakeFileHandle(name);
    this.children.set(name, file);
    return file;
  }
}

/** Build a tree from `{ 'a/b.txt': 'contents' }`. */
function tree(files) {
  const root = new FakeDirectoryHandle();
  for (const [path, contents] of Object.entries(files)) {
    const segments = path.split('/');
    const name = segments.pop();
    let directory = root;
    for (const segment of segments) {
      if (!directory.children.has(segment)) {
        directory.children.set(segment, new FakeDirectoryHandle(segment));
      }
      directory = directory.children.get(segment);
    }
    directory.children.set(name, new FakeFileHandle(name, new TextEncoder().encode(contents)));
  }
  return root;
}

/** Every file in the tree, as `{ path: contents }`. */
function read(root) {
  const out = {};
  const walk = (directory, prefix) => {
    for (const [name, entry] of directory.children) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') walk(entry, path);
      else out[path] = new TextDecoder().decode(entry.bytes);
    }
  };
  walk(root, '');
  return out;
}

const INSTALL = {
  'Celeste.exe': 'mz',
  'Content/Dialog/english.txt': 'dialog',
  'Content/Maps/1-ForsakenCity.bin': 'map',
};

// ------------------------------------------------------------ copying over --

test('an empty destination gets every file', async () => {
  writes = 0;
  const destination = new FakeDirectoryHandle();
  const copied = await copyDirectoryInto(tree(INSTALL), destination);

  assert.equal(copied, 3);
  assert.equal(writes, 3);
  assert.deepEqual(read(destination), INSTALL);
});

test('a second copy of the same install writes nothing', async () => {
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(INSTALL), destination);

  writes = 0;
  const copied = await copyDirectoryInto(tree(INSTALL), destination);

  assert.equal(copied, 0);
  assert.equal(writes, 0);
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

  writes = 0;
  const copied = await copyDirectoryInto(tree(INSTALL), destination);

  assert.equal(copied, 1);
  assert.equal(writes, 1);
  assert.deepEqual(read(destination), INSTALL);
});

test('a file that changed but kept its size is not noticed', async () => {
  // Size is the only identity this can afford — hashing 1.3 GB to answer the
  // question costs more than the copy it saves. Pinned so the limit is a
  // decision on record rather than a surprise.
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(INSTALL), destination);

  writes = 0;
  const copied = await copyDirectoryInto(tree({ ...INSTALL, 'Celeste.exe': 'ZZ' }), destination);

  assert.equal(copied, 0);
  assert.equal(writes, 0);
  assert.equal(read(destination)['Celeste.exe'], 'mz');
});

test('into puts the copy under a subdirectory, and resumes there too', async () => {
  const destination = new FakeDirectoryHandle();
  await copyDirectoryInto(tree(INSTALL), destination, 'celeste');

  assert.deepEqual(
    read(destination),
    Object.fromEntries(Object.entries(INSTALL).map(([path, body]) => [`celeste/${path}`, body])),
  );

  writes = 0;
  assert.equal(await copyDirectoryInto(tree(INSTALL), destination, 'celeste'), 0);
  assert.equal(writes, 0);
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

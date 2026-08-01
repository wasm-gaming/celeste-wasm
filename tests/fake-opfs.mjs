// A fake File System Access API, enough for the staging and archive code to run
// in node: directory and file handles, `entries()`, and a writable that collects
// what is piped into it. Writes are counted, because "which files get written at
// all" is what several of these tests are actually about.
//
// Not a .test.mjs, so the runner does not collect it.

export const stats = { writes: 0 };

export class FakeFileHandle {
  kind = 'file';

  constructor(name, bytes = new Uint8Array()) {
    this.name = name;
    this.bytes = bytes;
  }

  async getFile() {
    return new Blob([this.bytes]);
  }

  async createWritable() {
    stats.writes++;
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

export class FakeDirectoryHandle {
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
export function tree(files) {
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
export function read(root) {
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

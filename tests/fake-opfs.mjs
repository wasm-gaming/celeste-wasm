// A fake File System Access API, enough for the staging and archive code to run
// in node: directory and file handles, `entries()`, and a writable that collects
// what is piped into it. Writes are counted, because "which files get written at
// all" is what several of these tests are actually about.
//
// Not a .test.mjs, so the runner does not collect it.

export const stats = {
  /** Files opened for writing, by either route. */
  writes: 0,
  /** Of those, the ones that went through a sync access handle. */
  syncWrites: 0,
  /** `getDirectoryHandle` calls, which is what the directory cache is about. */
  directories: 0,
  /** Writes open at this moment, and the most there have ever been at once. */
  open: 0,
  peakOpen: 0,
  reset() {
    this.writes = 0;
    this.syncWrites = 0;
    this.directories = 0;
    this.open = 0;
    this.peakOpen = 0;
  },
};

/**
 * Whether file handles offer `createSyncAccessHandle`.
 *
 * In a browser that answer is "only in a worker", which is the fork
 * `writeContents` takes; here it is a switch, so both sides of it are covered.
 */
export const capabilities = { syncAccess: false };

function opened() {
  stats.writes++;
  stats.open++;
  stats.peakOpen = Math.max(stats.peakOpen, stats.open);
}

export class FakeFileHandle {
  kind = 'file';

  constructor(name, bytes = new Uint8Array()) {
    this.name = name;
    this.bytes = bytes;
  }

  async getFile() {
    return new Blob([this.bytes]);
  }

  get createSyncAccessHandle() {
    if (!capabilities.syncAccess) return undefined;
    return async () => {
      opened();
      stats.syncWrites++;
      const handle = this;
      let bytes = handle.bytes;

      return {
        truncate(size) {
          bytes = bytes.subarray(0, size);
          handle.bytes = bytes;
        },
        write(chunk, { at = 0 } = {}) {
          const grown = new Uint8Array(Math.max(bytes.length, at + chunk.length));
          grown.set(bytes);
          grown.set(chunk, at);
          bytes = grown;
          handle.bytes = bytes;
          return chunk.length;
        },
        flush() {},
        close() {
          stats.open--;
        },
      };
    };
  }

  async createWritable() {
    opened();
    const chunks = [];
    const handle = this;

    const stream = new WritableStream({
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
        stats.open--;
      },
    });

    // A real FileSystemWritableFileStream is a WritableStream *plus* its own
    // write()/close(), and `writeFile` uses those directly when it already has
    // the bytes rather than a stream to pipe. The writer is acquired lazily so
    // that pipeTo, which locks the stream itself, still works.
    let writer = null;
    stream.write = async (chunk) => {
      writer ??= stream.getWriter();
      await writer.write(chunk);
    };
    stream.close = async () => {
      writer ??= stream.getWriter();
      await writer.close();
    };

    return stream;
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
    stats.directories++;
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

  async removeEntry(name, { recursive = false } = {}) {
    const found = this.children.get(name);
    // The real API rejects rather than resolving quietly, and `removePath`
    // reads that rejection as "there was nothing there".
    if (!found) throw new Error(`no such entry: ${name}`);
    if (found.kind === 'directory' && found.children.size > 0 && !recursive) {
      throw new Error(`${name} is not empty`);
    }
    this.children.delete(name);
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

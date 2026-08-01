// Staging the game into the runtime's filesystem.
//
// The loader mounts the origin private filesystem at /libsdl and then works
// entirely in terms of native paths: it reads /libsdl/Celeste.exe, writes the
// patched assembly to /libsdl/CustomCeleste.dll, and symlinks /Content at
// /libsdl/Content so FNA finds the game's assets where it expects them.
//
// So OPFS *is* the game directory. Everything here is about getting the
// player's files into it — from a zip, from a directory they picked, or from a
// previous session that already has them — and taking them back out again.

import { ZipReader, type ZipEntry } from './celeste.zip.js';

/** Where the loader mounts OPFS. Paths below are relative to this. */
export const VFS_ROOT = '/libsdl';

/** The Everest build, read by `Patcher.ExtractEverest()`. */
export const EVEREST_ZIP = 'everest.zip';

/** Where that zip is unpacked to, and where the patcher looks for the loader. */
export const EVEREST_DIR = 'Celeste/Everest';

/** Marker file inside `EVEREST_DIR` that says the loader is unpacked. */
export const EVEREST_MARKER = `${EVEREST_DIR}/Celeste.Mod.mm.dll`;

/** MonoMod's output: the game, patched for WebAssembly (and for Everest). */
export const PATCHED_ASSEMBLY = 'CustomCeleste.dll';

/** Directories the loader creates on mount; mods and saves persist in them. */
export const MODS_DIR = 'Celeste/Mods';
export const SAVES_DIR = 'Celeste/Saves';

/** `navigator.storage.getDirectory()`, with a readable failure. */
export async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error(
      'celeste: this browser has no origin private filesystem, which is where the game is staged',
    );
  }
  return navigator.storage.getDirectory();
}

/** Async iteration over a directory, which lib.dom does not always type. */
type IterableDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** `mkdir -p`, returning the leaf. */
export async function ensureDirectory(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let handle = root;
  for (const segment of splitPath(path)) {
    handle = await handle.getDirectoryHandle(segment, { create: true });
  }
  return handle;
}

async function directoryOf(
  root: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  let handle = root;
  for (const segment of splitPath(path)) {
    try {
      handle = await handle.getDirectoryHandle(segment, { create });
    } catch {
      return null;
    }
  }
  return handle;
}

/** Write a file, creating its parent directories. */
export async function writeFile(
  root: FileSystemDirectoryHandle,
  path: string,
  data: Uint8Array | ReadableStream<Uint8Array>,
): Promise<void> {
  const segments = splitPath(path);
  const name = segments.pop();
  if (!name) throw new Error(`celeste: "${path}" is not a file path`);

  const parent = await ensureDirectory(root, segments.join('/'));
  const file = await parent.getFileHandle(name, { create: true });
  const writable = await file.createWritable();

  if (data instanceof Uint8Array) {
    // A `Uint8Array` over a SharedArrayBuffer is still a valid write chunk;
    // lib.dom's signature just does not say so.
    await writable.write(data as BufferSource);
    await writable.close();
    return;
  }

  // Piping keeps a 200 MB asset off the heap: it lands in storage a chunk at a
  // time, straight out of the inflate stream.
  await data.pipeTo(writable);
}

export async function readFile(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<Uint8Array | null> {
  const segments = splitPath(path);
  const name = segments.pop();
  if (!name) return null;

  const parent = await directoryOf(root, segments.join('/'), false);
  if (!parent) return null;
  try {
    const handle = await parent.getFileHandle(name, { create: false });
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch {
    return null;
  }
}

export async function exists(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  const segments = splitPath(path);
  const name = segments.pop();
  if (!name) return true;

  const parent = await directoryOf(root, segments.join('/'), false);
  if (!parent) return false;
  try {
    await parent.getFileHandle(name, { create: false });
    return true;
  } catch {
    // Not a file — it may still be a directory, which is what the install check
    // asks about for Content/Maps and friends.
  }
  try {
    await parent.getDirectoryHandle(name, { create: false });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every path under `path`, relative to it. Used to run the install check
 * against what actually made it into storage, and to decide whether a previous
 * session already staged the game.
 */
export async function listPaths(
  root: FileSystemDirectoryHandle,
  path = '',
  limit = Infinity,
): Promise<string[]> {
  const start = await directoryOf(root, path, false);
  if (!start) return [];

  const out: string[] = [];
  const walk = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, entry] of (handle as IterableDirectory).entries()) {
      if (out.length >= limit) return;
      const child = prefix ? `${prefix}/${name}` : name;
      out.push(child);
      if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, child);
      }
    }
  };

  await walk(start, '');
  return out;
}

/** Remove a file or directory. Returns whether anything was there. */
export async function removePath(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  const segments = splitPath(path);
  const name = segments.pop();
  if (!name) return false;

  const parent = await directoryOf(root, segments.join('/'), false);
  if (!parent) return false;
  try {
    await parent.removeEntry(name, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export interface StageProgress {
  /** Entries written so far. */
  done: number;
  /** Entries to write in total. */
  total: number;
  /** Path of the entry that was just written. */
  path: string;
}

export interface ExtractOptions {
  /** Strip this prefix off every entry — the install root inside the archive. */
  strip?: string;
  /** Write entries under this path instead of at the root. */
  into?: string;
  /** Skip entries for which this returns false. */
  filter?: (path: string) => boolean;
  onProgress?: (progress: StageProgress) => void;
}

/**
 * Unpack an archive into storage.
 *
 * Entries are written one at a time and streamed through the inflater, because
 * a Celeste install is ~1.3 GB and the browser will not hold it twice.
 */
export async function extractInto(
  reader: ZipReader,
  root: FileSystemDirectoryHandle,
  options: ExtractOptions = {},
): Promise<number> {
  const { strip = '', into = '', filter, onProgress } = options;

  const wanted = reader.entries.filter((entry: ZipEntry) => {
    if (entry.isDirectory) return false;
    if (strip && !entry.name.startsWith(strip)) return false;
    const relative = entry.name.slice(strip.length);
    // Zip entries are allowed to contain "..", and this writes into a directory
    // the game later executes code from.
    if (!relative || relative.split('/').includes('..')) return false;
    return filter ? filter(relative) : true;
  });

  let done = 0;
  for (const entry of wanted) {
    const relative = entry.name.slice(strip.length);
    const target = into ? `${into}/${relative}` : relative;
    await writeFile(root, target, await reader.stream(entry));
    done++;
    onProgress?.({ done, total: wanted.length, path: relative });
  }

  return done;
}

/**
 * Copy a directory the player picked straight across.
 *
 * This is the path worth taking when the browser has `showDirectoryPicker`: no
 * archive to build on the player's side, no inflate on ours, and the copy can
 * be resumed because it skips files that are already there at the same size.
 */
export async function copyDirectoryInto(
  source: FileSystemDirectoryHandle,
  root: FileSystemDirectoryHandle,
  into = '',
  onProgress?: (progress: StageProgress) => void,
): Promise<number> {
  const files: Array<{ path: string; handle: FileSystemFileHandle }> = [];

  const collect = async (handle: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, entry] of (handle as IterableDirectory).entries()) {
      const child = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') {
        await collect(entry as FileSystemDirectoryHandle, child);
      } else {
        files.push({ path: child, handle: entry as FileSystemFileHandle });
      }
    }
  };
  await collect(source, '');

  let done = 0;
  for (const { path, handle } of files) {
    const target = into ? `${into}/${path}` : path;
    const file = await handle.getFile();
    await writeFile(root, target, file.stream() as ReadableStream<Uint8Array>);
    done++;
    onProgress?.({ done, total: files.length, path });
  }

  return done;
}

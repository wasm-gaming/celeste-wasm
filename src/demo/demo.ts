// Typed side of the demo page.
//
// The shared template (dist/demo/, copied from @wasm-gaming/engine-specs) is
// plain JS and gets wired up in index.html, which is its documented integration
// point. Everything that benefits from type checking lives here and is handed
// to the page on `window.CELESTE`.
//
// The one thing this adds beyond the smaller engine demos is a second way in.
// A Celeste install is ~1.3 GB, and asking a player to zip it up so the
// template's file picker can read it is a poor trade when the browser can hand
// over the folder directly. So the page offers both: pick the folder where it
// works, fall back to an archive where it does not.

import sdk from '@wasm-gaming/celeste-wasm';
import { inspectInstall, type InstallCheck } from '@wasm-gaming/celeste-wasm/install';
import { ZipReader } from '@wasm-gaming/celeste-wasm/zip';

declare global {
  interface Window {
    /** Convention the shared template's sdk.js looks for. */
    SDK?: typeof sdk;
    CELESTE?: {
      sdk: typeof sdk;
      manifest: typeof sdk.manifest;
      /** The folder the player picked, if they picked one. */
      gameDirectory(): FileSystemDirectoryHandle | null;
      /** Ask for a folder. Returns the check, or null if the player cancelled. */
      pickGameDirectory(): Promise<InstallCheck | null>;
      /** The install a previous session left in storage, if there is one. */
      stagedInstall(): Promise<InstallCheck>;
      /** Saves and settings out of storage, as one gzipped tar. */
      exportSaves(): Promise<ReadableStream<Uint8Array>>;
      /** Put such an archive back. Returns how many files were written. */
      importSaves(archive: Blob): Promise<number>;
      /** Drop the staged install *and* the saves. Says which of the two it found. */
      purgeStorage(): Promise<{ data: boolean; settings: boolean }>;
      /** Run the same check over an archive, without unpacking it. */
      checkArchive(bytes: ArrayBuffer | Uint8Array | Blob): Promise<InstallCheck>;
      /** Whether this browser can hand over a directory at all. */
      canPickDirectory: boolean;
    };
  }
}

type DirectoryPicker = () => Promise<FileSystemDirectoryHandle>;

const showDirectoryPicker = (globalThis as { showDirectoryPicker?: DirectoryPicker })
  .showDirectoryPicker;

let picked: FileSystemDirectoryHandle | null = null;

async function listDirectory(handle: FileSystemDirectoryHandle): Promise<string[]> {
  const paths: string[] = [];

  const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
    const entries = (directory as FileSystemDirectoryHandle & {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    }).entries();

    for await (const [name, entry] of entries) {
      const path = prefix ? `${prefix}/${name}` : name;
      paths.push(path);
      // The check only looks at the top of the tree, so there is no reason to
      // walk the whole of Content/ — most of a Celeste install's ~1,200 files
      // are portrait frames nothing here asks about.
      //
      // The ceiling this puts on nesting is real, though: a player who hands
      // over the *parent* of their install puts `Master Bank.bank` at 5
      // segments, past this, and the check will not find it. The SDK's own
      // walk is deliberately uncapped for that reason; this one is the demo
      // being cheap before anything has been staged.
      if (entry.kind === 'directory' && path.split('/').length < 4) {
        await walk(entry as FileSystemDirectoryHandle, path);
      }
    }
  };

  await walk(handle, '');
  return paths;
}

window.SDK = sdk;
window.CELESTE = {
  sdk,
  manifest: sdk.manifest,
  canPickDirectory: typeof showDirectoryPicker === 'function',

  gameDirectory: () => picked,

  stagedInstall: () => sdk.stagedInstall(),
  exportSaves: () => sdk.exportSaves(),
  importSaves: (archive) => sdk.importSaves(archive),
  purgeStorage: () => sdk.purgeStorage(),

  async pickGameDirectory(): Promise<InstallCheck | null> {
    if (!showDirectoryPicker) {
      throw new Error('This browser cannot hand over a folder — supply a zip of your Celeste install instead.');
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await showDirectoryPicker();
    } catch {
      return null; // The player closed the dialog.
    }

    const check = inspectInstall(await listDirectory(handle));
    picked = check.ok ? handle : null;
    return check;
  },

  async checkArchive(bytes): Promise<InstallCheck> {
    const reader = await ZipReader.open(
      bytes instanceof Blob ? bytes : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    return inspectInstall(reader.entries.map((entry) => entry.name));
  },
};

// The runtime is built with threads, so the page has to be cross-origin
// isolated before any of this can run. `make preview` sends the headers;
// coi.js installs a service worker that adds them on hosts that will not.
const isolation = document.getElementById('isolation');
if (isolation) {
  isolation.textContent = window.crossOriginIsolated === true ? 'isolated' : 'not isolated';
  isolation.classList.toggle('bad', window.crossOriginIsolated !== true);
}

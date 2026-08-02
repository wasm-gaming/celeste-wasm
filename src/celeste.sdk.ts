import type {
  AssetData,
  EngineConfig,
  EngineEvent,
  EngineInstance,
  InputPreset,
  KeyMap,
} from '@wasm-gaming/engine-specs';
import { inspectInstall, REQUIRED_ENTRIES, type InstallCheck } from './celeste.install.js';
import { manifest } from './celeste.manifest.js';
import {
  ensureDirectory,
  EVEREST_DIR,
  EVEREST_MARKER,
  EVEREST_ZIP,
  exists,
  extractInto,
  inNamespace,
  listFiles,
  listPaths,
  MODS_DIR,
  opfsRoot,
  PATCHED_ASSEMBLY,
  PATCHER_ASSEMBLIES,
  readFile,
  removePath,
  SAVES_DIR,
  STAGED_MANIFEST,
  VFS_ROOT,
  writeFile,
  type StageProgress,
} from './celeste.opfs.js';
import { DEFAULT_CELESTE_OPTIONS, type CelesteOptions } from './celeste.options.js';
import { stageWithWorker } from './celeste.stage.js';
import {
  assemblyList,
  hostImports,
  JITERPRETER_OPTIONS,
  loadDotnetModule,
  readRuntimeDescriptor,
  resolveEverestBuild,
  resolveStorageNamespace,
  runtimeFiles,
  splitWasmLoader,
  steamStorageKey,
  type CelesteExports,
  type DotnetRuntimeAPI,
  type SplashProgress,
} from './celeste.runtime.js';
import { readTar, tarStream, type TarSource } from './celeste.tar.js';
import { ZipReader } from './celeste.zip.js';

export { manifest };

/**
 * The runtime transfers the canvas to a worker by CSS selector — the glue's
 * `transferredCanvasNames` is `[".canvas"]` — so the element the game draws
 * into has to carry this class, whoever created it.
 */
const CANVAS_CLASS = 'canvas';

/**
 * ...and the id has to be exactly this.
 *
 * The transferred canvas arrives on the worker as `GL.offscreenCanvases[id]`,
 * and that map is the only way to reach it — a worker has no `document` to
 * query. SDL then asks for its window by `SDL_EMSCRIPTEN_CANVAS_SELECTOR`,
 * which defaults to `#canvas`, so the lookup is `GL.offscreenCanvases['canvas']`.
 * Any other id misses, `SDL_GL_CreateContext` quietly yields no context, and
 * the first FNA3D call into GL dies on an undefined `GLctx`.
 */
const CANVAS_ID = 'canvas';

/**
 * Where the runtime says the game's loop has stopped.
 *
 * `CelesteLoader.MainLoop()` is a promise that never settles: FNA hands the
 * loop to `emscripten_set_main_loop(cb, 0, 1)`, which unwinds the stack on the
 * way in, so nothing after `Game.Run()` is ever reached — not the task's
 * completion and not `Cleanup()`. What the game does do on its way out is
 * `emscripten_cancel_main_loop()`, and `scripts/verify-runtime.mjs` patches the
 * glue to announce that here. The loop runs on the deputy worker, which shares
 * no scope with the page, hence a channel rather than a callback.
 *
 * A BroadcastChannel carries no addressing, so a second tab running Celeste on
 * this origin would hear it too. That is not a state this package supports in
 * the first place — the staged install is one set of exclusive OPFS handles —
 * and what the collision costs is an exit event arriving early, not a wrong one.
 * SDL_Quit() reaches the same glue from `Cleanup()`, one line further down the
 * exit path; `exited` is what keeps that from being a second event.
 */
const EXIT_CHANNEL = 'celeste-wasm:runtime';

export type CelesteInstance = EngineInstance & {
  /** What the acceptance check made of the install that booted. */
  readonly install: InstallCheck;
  /** Managed heap in MB, as last reported by the runtime. -1 before the first report. */
  readonly memoryMB: number;
  /** The live .NET runtime, for hosts that need to go below the contract. */
  readonly runtime: DotnetRuntimeAPI;
  /** The loader's exported entry points. */
  readonly exports: CelesteExports;
};

export type CelesteLoadConfig = EngineConfig & {
  /**
   * The player's Celeste folder, handed over directly.
   *
   * Preferred over `assets.game` wherever `showDirectoryPicker` exists: the
   * install is ~1.3 GB, and this copies it across file by file instead of
   * asking the player to build an archive of it first.
   */
  gameDirectory?: FileSystemDirectoryHandle;
  /** Lazy alternative to `assets.game`, resolved only if staging is needed. */
  gameProvider?: () => Promise<AssetData | Blob> | AssetData | Blob;
  /** Staging progress, in files. The runtime download is reported by the browser. */
  onProgress?: (current: number, total: number) => void;
  /**
   * Everest's splash messages while it loads mods. `null` when it closes.
   *
   * `progress` is present on the messages that carry a mod count, which is what
   * a determinate loading bar needs; the rest are prose.
   */
  onSplash?: (message: string | null, progress?: SplashProgress) => void;
  /** Managed heap size, sampled by the runtime every 30 seconds. */
  onMemory?: (megabytes: number) => void;
  /**
   * A Steam achievement the game just unlocked, by id.
   *
   * There is no Steam here, so the unlocked set is kept in the page's
   * `localStorage` under the storage namespace and this is the only way a host
   * hears about one — the game itself shows nothing.
   */
  onAchievement?: (achievement: string) => void;
  /** Used for the Everest updater, which may need a proxy. Defaults to `fetch`. */
  fetchImpl?: typeof fetch;
  /** Deprecated alias for `canvasEl`, kept for hosts written against 0.0.x. */
  canvas?: HTMLCanvasElement;
};

/**
 * One instance per page.
 *
 * The canvas is transferred to a worker and the .NET runtime is a singleton
 * inside the page's module graph; neither can be handed back. A second `load()`
 * would silently draw nothing, so it fails loudly instead.
 */
let pageInstance: CelesteInstance | null = null;

/**
 * The directory of the OPFS mount this page's runtime keeps the game in.
 *
 * Page-scoped rather than passed around, for the same reason `pageInstance` is:
 * there is one runtime per page, it resolves its own paths, and every function
 * here that touches storage has to agree with it. `load()` sets it from the
 * runtime it booted — `options.storageNamespace` when the host named one, the
 * runtime's own `runtime.json` when it did not.
 *
 * Until then it is the default, which is the stock root layout: the standalone
 * storage functions run before any runtime has been asked. They take an
 * override for a host that knows better.
 */
let pageNamespace: string = DEFAULT_CELESTE_OPTIONS.storageNamespace;

/** A storage path inside the active namespace. */
function at(path: string, namespace: string = pageNamespace): string {
  return inNamespace(namespace, path);
}

/**
 * How deep the install check can see, in path segments.
 *
 * Nothing past the longest path it asks about tells it anything, and the walk
 * is not free: against a vanilla install this reads 209 entries out of storage
 * instead of 1,289.
 */
const INSTALL_CHECK_DEPTH = Math.max(...REQUIRED_ENTRIES.map((entry) => entry.split('/').length));

/**
 * The acceptance check, run against storage.
 *
 * Depth-capped because this package stages flat: whatever route the install
 * came in through, `Celeste.exe` lands at the top and the check has no question
 * that a deeper entry could answer.
 */
async function checkStaged(
  root: FileSystemDirectoryHandle,
  namespace: string = pageNamespace,
): Promise<InstallCheck> {
  return inspectInstall(
    await listPaths(root, at('', namespace), { depth: INSTALL_CHECK_DEPTH }),
  );
}

/**
 * What a previous session left in storage.
 *
 * The staged install persists, so after a reload `load()` will boot from it
 * with no game supplied at all. This is how a host finds that out *before*
 * asking the player for their Celeste folder again — which is friction on the
 * archive route and a second ~1.3 GB copy on the folder one.
 *
 * The check is the same one the boot path runs. Throws where there is no
 * origin private filesystem, which is a browser that cannot run the game either.
 */
export async function stagedInstall(namespace?: string): Promise<InstallCheck> {
  return checkStaged(await opfsRoot(), namespace ?? pageNamespace);
}

// ----------------------------------------------------------------- the saves

/**
 * `CompressionStream` and its inverse declare a `BufferSource` writable side,
 * which will not unify with a `ReadableStream<Uint8Array>` however the pipe is
 * written — lib.dom types the pair more loosely than `pipeThrough` accepts.
 * The bytes on the wire are the same either way.
 */
function bytePipe(pair: CompressionStream | DecompressionStream): ReadableWritablePair<
  Uint8Array,
  Uint8Array
> {
  return pair as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

export interface ExportOptions {
  /** Storage namespace to read from. Defaults to the page's. */
  namespace?: string;
  /**
   * Compress the archive. Celeste's saves are YAML and shrink by a lot, and the
   * whole point of the archive is that it crosses a network, so this is on.
   */
  gzip?: boolean;
}

/**
 * The player's saves and settings, as one archive.
 *
 * Meant for a host that syncs storage somewhere the player owns — a Drive, a
 * Box, a server of their own. It is one archive rather than a file listing
 * because those APIs charge per object, and `Celeste/Saves` is small but not
 * always one file: Everest gives every mod a save of its own.
 *
 * Nothing is buffered. The result is a stream that reads out of storage as it
 * is consumed, so it can go straight into an upload.
 *
 * Paths inside the archive are relative to the save directory — `0.celeste`,
 * not `Celeste/Saves/0.celeste`. That is deliberate: where this package keeps
 * its files is its own business and may yet change, and an archive already
 * sitting in someone's Drive should not stop restoring when it does.
 */
export async function exportSaves(options: ExportOptions = {}): Promise<ReadableStream<Uint8Array>> {
  const { gzip = true } = options;

  const files = await listFiles(await opfsRoot(), at(SAVES_DIR, options.namespace ?? pageNamespace));
  const archive = tarStream(
    (async function* (): AsyncGenerator<TarSource> {
      for (const { path, handle } of files) {
        // One File snapshot per entry: `size` goes in the header and the body
        // has to be the bytes that size describes.
        const file = await handle.getFile();
        yield {
          path,
          size: file.size,
          body: () => file.stream() as ReadableStream<Uint8Array>,
        };
      }
    })(),
  );

  if (!gzip) return archive;
  if (typeof CompressionStream === 'undefined') {
    throw new Error(
      'celeste: this browser has no CompressionStream — call exportSaves({ gzip: false }) and compress the stream yourself',
    );
  }
  return archive.pipeThrough(bytePipe(new CompressionStream('gzip')));
}

/**
 * Put an archive from `exportSaves()` back.
 *
 * gzip is detected rather than declared, so an archive compressed on the way
 * out restores without the caller having to remember which it was.
 *
 * This merges: a save the archive carries replaces the one in storage, and a
 * save only storage has is left alone. Restoring should not be able to destroy
 * a file the backup never knew about — a host that wants the archive to be the
 * whole truth should `purgeStorage()` first.
 *
 * Returns how many files were written.
 */
export async function importSaves(
  archive: ReadableStream<Uint8Array> | Blob | Uint8Array,
  namespace: string = pageNamespace,
): Promise<number> {
  const root = await opfsRoot();

  let restored = 0;
  for await (const entry of readTar(await inflateIfGzipped(toStream(archive)))) {
    // `readTar` has already refused anything that climbs out of the archive,
    // which matters here: this writes into a directory the game reads.
    await writeFile(root, `${at(SAVES_DIR, namespace)}/${entry.path}`, entry.body);
    restored++;
  }
  return restored;
}

// --------------------------------------------------------------- the manifest

/** Top-level names present in storage right now. */
async function rootEntries(
  root: FileSystemDirectoryHandle,
  namespace: string = pageNamespace,
): Promise<string[]> {
  return listPaths(root, at('', namespace), { depth: 1 });
}

/** The names this package has claimed at the root, or null if it never recorded any. */
async function readStaged(
  root: FileSystemDirectoryHandle,
  namespace: string = pageNamespace,
): Promise<string[] | null> {
  const raw = await readFile(root, at(STAGED_MANIFEST, namespace));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries.filter((e) => typeof e === 'string') : null;
  } catch {
    // A manifest we cannot read is the same as not having one: fall back to the
    // fixed list rather than deleting on a guess.
    return null;
  }
}

/**
 * Record the root entries staging just created.
 *
 * `before` is the listing from before it ran, so what goes in the manifest is
 * the difference — the names this package is responsible for, and not whatever
 * a sibling engine on the same origin had already put there. Unioned with any
 * previous record, because a second staging adds to storage rather than
 * replacing it.
 */
async function recordStaged(
  root: FileSystemDirectoryHandle,
  before: string[],
  namespace: string = pageNamespace,
): Promise<void> {
  const added = (await rootEntries(root, namespace)).filter((name) => !before.includes(name));
  const known = (await readStaged(root, namespace)) ?? [];
  const entries = [...new Set([...known, ...added])].sort();

  if (entries.length === known.length && entries.every((name, at) => name === known[at])) return;

  await writeFile(
    root,
    at(STAGED_MANIFEST, namespace),
    new TextEncoder().encode(`${JSON.stringify({ version: 1, entries }, null, 2)}\n`),
  );
}

/**
 * Drop what this package put in storage.
 *
 * The derived artefacts are a fixed list, but the install is not: it is the
 * player's folder, whatever that held. So staging records the top-level names it
 * created ([[STAGED_MANIFEST]]) and this removes exactly those — which is how it
 * can clear ~1.1 GB without touching anything else sharing the origin.
 *
 * Storage staged before this package kept that record has no manifest, and falls
 * back to the fixed list. That leaves the player's stray assemblies behind, as
 * it always did; re-staging writes a manifest and the next purge is complete.
 *
 * `settings` is Celeste's save directory, which holds the save files *and* the
 * settings file. Mods are left alone: they are the player's, they are not part
 * of the install, and nothing regenerates them.
 */
export async function purgeStorage(
  namespace: string = pageNamespace,
): Promise<{ data: boolean; settings: boolean }> {
  const root = await opfsRoot();

  const staged = await readStaged(root, namespace);
  const fixed = ['Content', 'Celeste.exe', 'Celeste.dll', PATCHED_ASSEMBLY, ...PATCHER_ASSEMBLIES];
  const targets = new Set([...(staged ?? fixed), EVEREST_ZIP, EVEREST_DIR]);

  // Never through the manifest: `Celeste/` holds the saves and the mods, and
  // dropping the whole directory would take both with the install.
  targets.delete('Celeste');

  const removed = await Promise.all(
    [...targets].map((path) => removePath(root, at(path, namespace))),
  );
  await removePath(root, at(STAGED_MANIFEST, namespace));

  // The unlocked achievements are the one piece of game state that is not in
  // OPFS — a synchronous import cannot read OPFS, so they sit in localStorage
  // (see `steamImports`) — and "everything in storage" has to include them.
  try {
    globalThis.localStorage?.removeItem(steamStorageKey(namespace));
  } catch {
    // Same as never having had one.
  }

  const settings = await removePath(root, at(SAVES_DIR, namespace));
  return { data: removed.some(Boolean), settings };
}

// ---------------------------------------------------------------- the install

/**
 * What `exportInstall()` leaves out of the archive.
 *
 * Every one of these is either derived from the rest of it — MonoMod's output,
 * the unpacked Everest build — or fetched, so carrying them would charge the
 * player upload and storage for bytes the next boot produces anyway. `orig/` is
 * Everest's backup of the vanilla game, which is a second copy of files the
 * archive already has.
 *
 * Saves are excluded for a different reason: they have their own pair of
 * functions and their own cadence. An install moves once; saves move every
 * session, and nobody wants to push a gigabyte to move a checkpoint.
 */
const DERIVED_PATHS: readonly string[] = [
  PATCHED_ASSEMBLY,
  ...PATCHER_ASSEMBLIES,
  EVEREST_ZIP,
  EVEREST_DIR,
  SAVES_DIR,
  'orig',
];

function isDerived(path: string): boolean {
  return DERIVED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface InstallExportOptions {
  /** Storage namespace to read from. Defaults to the page's. */
  namespace?: string;
  /**
   * Compress the archive. Off, unlike `exportSaves()`, and measured rather than
   * assumed: 634 MB of a 1.1 GB install are FMOD banks, which gzip takes about
   * 1% off. The rest — atlases, assemblies — gives up around 67%, so the whole
   * archive comes out roughly 29% smaller for the cost of pushing every byte
   * through a compressor, most of them for nothing. Worth turning on for a slow
   * connection; not worth doing to everyone by default.
   */
  gzip?: boolean;
}

/**
 * The staged game, as one archive: what the player would otherwise have to
 * supply all over again on another machine.
 *
 * The install is ~1.1 GB and arrives either as a folder the player picks or a
 * zip they build. Neither is something to ask for twice, and a host that syncs
 * storage can carry this instead — one object rather than the ~1,240 files the
 * tree actually is, which matters when the far end charges per object.
 *
 * Streamed, so the archive is never resident. Paths are relative to the install
 * root for the same reason the save archive's are.
 */
export async function exportInstall(
  options: InstallExportOptions = {},
): Promise<ReadableStream<Uint8Array>> {
  const { gzip = false } = options;

  const root = await opfsRoot();
  const ns = options.namespace ?? pageNamespace;
  const files = (await listFiles(root, at('', ns))).filter(({ path }) => !isDerived(path));

  const archive = tarStream(
    (async function* (): AsyncGenerator<TarSource> {
      for (const { path, handle } of files) {
        const file = await handle.getFile();
        yield { path, size: file.size, body: () => file.stream() as ReadableStream<Uint8Array> };
      }
    })(),
  );

  if (!gzip) return archive;
  if (typeof CompressionStream === 'undefined') {
    throw new Error(
      'celeste: this browser has no CompressionStream — call exportInstall({ gzip: false })',
    );
  }
  return archive.pipeThrough(bytePipe(new CompressionStream('gzip')));
}

export interface InstallImportOptions {
  /** Storage namespace to write into. Defaults to the page's. */
  namespace?: string;
  /**
   * Called as files land. There is no total: a tar carries no manifest, so the
   * count is only ever "so far" — which is still what a gigabyte-long restore
   * needs to show.
   */
  onProgress?: (files: number, bytes: number) => void;
}

/**
 * Put an archive from `exportInstall()` back, and say what arrived.
 *
 * The return value is the same acceptance check `load()` runs, so a host can
 * tell a restore that produced a bootable game from one that produced a
 * directory of files. gzip is detected rather than declared.
 *
 * This trusts the archive exactly as much as `gameDirectory` trusts a folder
 * the player picks — its contents become the game the runtime patches and
 * executes. Paths that climb out of the archive are refused; what is inside it
 * is the caller's to vouch for.
 */
export async function importInstall(
  archive: ReadableStream<Uint8Array> | Blob | Uint8Array,
  options: InstallImportOptions = {},
): Promise<InstallCheck> {
  const root = await opfsRoot();
  const ns = options.namespace ?? pageNamespace;
  const before = await rootEntries(root, ns);

  let files = 0;
  let bytes = 0;
  for await (const entry of readTar(await inflateIfGzipped(toStream(archive)))) {
    await writeFile(root, at(entry.path, ns), entry.body);
    files++;
    bytes += entry.size;
    options.onProgress?.(files, bytes);
  }

  await recordStaged(root, before, ns);
  return checkStaged(root, ns);
}

function toStream(archive: ReadableStream<Uint8Array> | Blob | Uint8Array): ReadableStream<Uint8Array> {
  if (archive instanceof Blob) return archive.stream() as ReadableStream<Uint8Array>;
  if (archive instanceof Uint8Array) {
    return new Blob([archive as BufferSource]).stream() as ReadableStream<Uint8Array>;
  }
  return archive;
}

/**
 * Unwrap gzip if that is what this is, by looking rather than asking.
 *
 * The first two bytes say so, so the stream is peeked and then handed on with
 * those bytes put back in front of it.
 */
async function inflateIfGzipped(
  stream: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader();

  let head = new Uint8Array(0);
  while (head.length < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    const next = new Uint8Array(head.length + value.length);
    next.set(head);
    next.set(value, head.length);
    head = next;
  }

  const rejoined = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(head);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else if (value?.length) controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });

  if (head[0] !== 0x1f || head[1] !== 0x8b) return rejoined;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('celeste: this archive is gzipped and this browser has no DecompressionStream');
  }
  return rejoined.pipeThrough(bytePipe(new DecompressionStream('gzip')));
}

function toBytes(value: unknown): Uint8Array | Blob | null {
  if (value == null) return null;
  if (value instanceof Blob) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('celeste: assets must be Blob | Uint8Array | ArrayBuffer | string');
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export async function load(config: CelesteLoadConfig): Promise<CelesteInstance> {
  if (pageInstance) {
    throw new Error(
      'celeste: this page already has a running instance. The runtime and the transferred canvas cannot be replaced without a reload.',
    );
  }

  const { assets, onEvent, attachTo } = config;

  const emit = (event: EngineEvent): void => {
    try {
      onEvent?.(event);
    } catch {
      // A host callback must not break the engine runtime.
    }
  };

  const requested = (config.options ?? {}) as CelesteOptions;
  const opts = { ...DEFAULT_CELESTE_OPTIONS, ...stripUndefined(requested) };
  const fetchImpl = config.fetchImpl ?? fetch;

  // ------------------------------------------------------------- prerequisites

  if (typeof window === 'undefined') {
    throw new Error('celeste: the runtime needs a DOM');
  }
  if (window.crossOriginIsolated !== true) {
    throw new Error(
      'celeste: this page is not cross-origin isolated. The runtime is built with threads, so it needs SharedArrayBuffer — serve the page with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.',
    );
  }

  // ------------------------------------------------------------- render target

  const providedCanvas = config.canvasEl ?? config.canvas ?? null;
  if (!providedCanvas && !attachTo) {
    throw new Error('celeste: config.canvasEl or config.attachTo is required');
  }

  const ownsCanvas = providedCanvas === null;
  const canvas = providedCanvas ?? document.createElement('canvas');
  canvas.classList.add(CANVAS_CLASS);
  if (canvas.id !== CANVAS_ID) {
    if (canvas.id) {
      console.warn(
        `celeste: renaming the render target's id from "${canvas.id}" to "${CANVAS_ID}" — SDL looks the canvas up by that id inside the worker it was transferred to.`,
      );
    }
    canvas.id = CANVAS_ID;
  }

  let restoreContainerPosition: (() => void) | null = null;

  if (ownsCanvas) {
    canvas.style.display = 'block';

    if (opts.fit === 'container' && attachTo) {
      // Absolute inside the container, so the canvas takes its size *from* the
      // box and never contributes back to it — an unsized container would
      // otherwise collapse around a canvas trying to fill it.
      if (getComputedStyle(attachTo).position === 'static') {
        const previous = attachTo.style.position;
        attachTo.style.position = 'relative';
        restoreContainerPosition = () => {
          attachTo.style.position = previous;
        };
      }
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      // Auto margins against `inset: 0` are what centre the letterboxed
      // picture once `fitPicture()` below gives it a size of its own.
      canvas.style.margin = 'auto';
    } else if (opts.fit === 'window') {
      canvas.style.position = 'fixed';
      canvas.style.inset = '0';
      canvas.style.margin = 'auto';
    } else {
      // A fixed buffer is scaled by CSS, and the canvas carries its own aspect
      // ratio, so bounding it on both axes is what keeps it inside the page
      // whichever way the window is resized.
      canvas.style.maxWidth = '100%';
      canvas.style.maxHeight = '100%';
      canvas.style.height = 'auto';
    }

    attachTo?.appendChild(canvas);
  }

  if (opts.pixelated) canvas.style.imageRendering = 'pixelated';

  // ------------------------------------------------------------------ sizing

  /** The box the picture has to fit inside, in CSS pixels. */
  const boxElement = ownsCanvas && attachTo ? attachTo : canvas;

  const measureBox = (): { width: number; height: number } => {
    if (opts.fit === 'window') return { width: window.innerWidth, height: window.innerHeight };
    const rect = boxElement.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;

  /**
   * The resolution the game will run at, as Celeste's own `WindowScale`.
   *
   * Not a free choice: the browser build hooks `Settings.ApplyScreen()` and
   * pins the window to `WindowScale × 320` by `WindowScale × 180` with
   * fullscreen off, so every resolution it can run at is a whole multiple of
   * the gameplay buffer — and 16:9, whatever shape the page's box is.
   */
  let windowScale = MIN_WINDOW_SCALE;
  let pictureWidth = manifest.video.baseWidth;
  let pictureHeight = manifest.video.baseHeight;

  /**
   * Fit the picture to the page, on every resize.
   *
   * Only the box moves: the resolution is settled before the game boots and
   * cannot be changed afterwards. So the job here is to give the canvas the
   * largest rectangle of the picture's shape that fits its box and centre it,
   * letting the container show through around it. Stretching it to a box of
   * another shape would distort a picture the game has already letterboxed
   * itself. The shape is all this needs, and the shape is always 16:9 — so it
   * stays right even when the resolution is the player's rather than ours.
   */
  const fitPicture = (): void => {
    // A canvas the host styles is the host's to lay out, and a 'fixed' buffer
    // is scaled by host CSS by definition.
    if (!ownsCanvas || opts.fit === 'fixed') return;

    const box = measureBox();
    if (box.width < 1 || box.height < 1) return;

    const scale = Math.min(box.width / pictureWidth, box.height / pictureHeight);
    canvas.style.width = `${Math.round(pictureWidth * scale)}px`;
    canvas.style.height = `${Math.round(pictureHeight * scale)}px`;
  };

  /**
   * Work the resolution out from what the page has settled on *now*.
   *
   * Called twice: once here, so the element has a sane shape while the game is
   * still being staged, and once again just before the game reads its settings
   * — the box is often not final at `load()` time (a host that sizes its
   * container afterwards, the demo taking the page over on boot) and staging
   * can take minutes.
   *
   * The drawing buffer it writes is only what the element shows until the first
   * frame arrives: the game sets its own window size on the way up, which SDL
   * puts straight into the canvas from inside the render worker, and after
   * `transferControlToOffscreen()` the setter throws.
   */
  const resolveResolution = (warn: boolean): void => {
    const box = measureBox();
    const sized = box.width >= 1 && box.height >= 1;

    if (!sized && warn && opts.fit !== 'fixed') {
      console.warn(
        `celeste: the render target has no size; rendering at ${opts.renderWidth}×${opts.renderHeight}. Give the container a width and height in CSS.`,
      );
    }

    windowScale =
      opts.fit === 'fixed' || !sized
        ? windowScaleFor(opts.renderWidth, opts.renderHeight)
        : windowScaleFor(box.width * ratio, box.height * ratio);
    pictureWidth = windowScale * manifest.video.baseWidth;
    pictureHeight = windowScale * manifest.video.baseHeight;

    if (
      warn &&
      opts.fit === 'fixed' &&
      (pictureWidth !== opts.renderWidth || pictureHeight !== opts.renderHeight)
    ) {
      const why =
        windowScale === MAX_WINDOW_SCALE
          ? `is past what the game composes — every frame goes through a 1922×1082 target before it reaches the window, so ${pictureWidth}×${pictureHeight} is the last resolution that adds anything`
          : `is not a whole multiple of ${manifest.video.baseWidth}×${manifest.video.baseHeight}, which is the only shape the browser build's window comes in — rendering at ${pictureWidth}×${pictureHeight}`;
      console.warn(`celeste: ${opts.renderWidth}×${opts.renderHeight} ${why}.`);
    }

    try {
      canvas.width = pictureWidth;
      canvas.height = pictureHeight;
    } catch {
      // Already transferred: a host reusing a canvas from a previous instance.
    }
    fitPicture();
  };

  resolveResolution(false);

  const onResize = (): void => fitPicture();
  window.addEventListener('resize', onResize);
  // The window is not the only thing that moves the box: a host panel opening,
  // a header going away, the demo taking the page over on boot.
  const boxObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onResize);
  boxObserver?.observe(boxElement);

  const swallowContextMenu = (event: Event): void => event.preventDefault();
  canvas.addEventListener('contextmenu', swallowContextMenu);

  // A canvas is not in the tab order and `focus()` on one is a silent no-op
  // until it has a tabindex. -1 makes it focusable without adding a tab stop.
  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '-1');
  // …and the focus ring that comes with it would draw a browser-blue box around
  // the picture. Nothing is keyboard-reachable here — the canvas is focused
  // programmatically, never tabbed to — so the ring marks nothing.
  canvas.style.outline = 'none';

  const focusCanvas = (): void => {
    if (!opts.focusCanvas) return;
    // The canvas being the active element is not enough on its own: leaving
    // fullscreen can hand focus to the browser's own UI, and a document that
    // does not have focus receives no keys at all.
    if (!document.hasFocus()) window.focus();
    canvas.focus({ preventScroll: true });
  };

  /**
   * Fullscreen, in both directions, costs the game its input.
   *
   * Leaving it hands focus back to whatever the browser last considered the
   * page's active element — never the canvas, and sometimes nothing in the page
   * at all — and SDL reports that as a window focus loss, which is the state
   * Celeste stops reading the keyboard in. Entering it is the only moment the
   * Keyboard Lock API will take, and the call at boot ran when the page was
   * still windowed, so it did nothing.
   *
   * The refocus is retried rather than done once: during the transition the
   * element is not reliably focusable yet, a focus() that lands there is
   * dropped, and the transition is longer than a frame on every browser that
   * animates it. Each attempt is a frame apart and they stop as soon as one
   * takes — or after ~15 frames, at which point the click handler below is the
   * way back in.
   */
  const refocusCanvas = (): void => {
    if (!opts.focusCanvas) return;
    let attempts = 0;
    const attempt = (): void => {
      if (!canvas.isConnected) return;
      focusCanvas();
      if (document.activeElement === canvas && document.hasFocus()) return;
      if (++attempts < 15) requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  };

  const onFullscreenChange = (): void => {
    if (document.fullscreenElement && opts.lockKeyboard) void lockKeyboard();
    // Entering or leaving fullscreen changes the box without always changing
    // the window, and the transition outlasts this event on most browsers.
    fitPicture();
    requestAnimationFrame(fitPicture);
    refocusCanvas();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // Whatever took the focus away — the fullscreen exit, a devtools panel,
  // another tab — the moment the page has it back the game should too.
  const onWindowFocus = (): void => focusCanvas();
  window.addEventListener('focus', onWindowFocus);

  // Clicking the picture is the other way back in, and the one a player reaches
  // for when the game has stopped responding.
  const onPointerDown = (): void => focusCanvas();
  canvas.addEventListener('pointerdown', onPointerDown);

  // ------------------------------------------------------- the storage layout
  //
  // Where the game lives in storage is settled by the *runtime*, not by
  // preference, so the descriptor it was built with decides it and the option
  // is only a claim to check against — see `resolveStorageNamespace`. Both
  // happen here, before a byte moves.

  const baseUrlForRuntime = config.jsUrl ? new URL('../', config.jsUrl).href : null;

  const descriptor = await readRuntimeDescriptor(
    baseUrlForRuntime ??
      (opts.runtimeBaseUrl
        ? new URL(opts.runtimeBaseUrl, location.href).href.replace(/\/?$/, '/')
        : new URL('.', import.meta.url).href),
    fetchImpl,
  );

  opts.storageNamespace = resolveStorageNamespace(
    requested.storageNamespace,
    descriptor,
    DEFAULT_CELESTE_OPTIONS.storageNamespace,
  );

  pageNamespace = opts.storageNamespace;

  // ------------------------------------------------------------------- staging

  const root = await opfsRoot();
  const report = (progress: StageProgress): void => {
    config.onProgress?.(progress.done, progress.total);
  };

  const install = await stageGame(root, config, opts, report);
  if (!install.ok) throw new Error(`celeste: ${install.reason}`);

  if (opts.installEverest) {
    await stageEverest(root, config, opts, fetchImpl);
  }

  await ensureDirectory(root, at(MODS_DIR));
  await ensureDirectory(root, at(SAVES_DIR));

  // Last chance to read the page: the game deserialises its settings inside
  // `Init()`, a few lines below, and from then on the resolution is its own.
  resolveResolution(true);
  await applyWindowScale(root, opts.syncResolution ? windowScale : null);

  // ------------------------------------------------------------------- runtime

  const baseUrl = opts.runtimeBaseUrl
    ? new URL(opts.runtimeBaseUrl, typeof location === 'undefined' ? undefined : location.href).href
    : new URL('.', import.meta.url).href;
  const files = runtimeFiles(config.jsUrl ? new URL('../', config.jsUrl).href : baseUrl);

  const imports = hostImports({
    onSplash: config.onSplash,
    onAchievement: config.onAchievement,
    storageNamespace: opts.storageNamespace,
  });

  let runtime: DotnetRuntimeAPI | null = null;
  let exports: CelesteExports | null = null;
  let booted = false;
  let destroyed = false;
  let memoryMB = -1;
  let stopWatchingMemory: (() => void) | null = null;
  let exitChannel: BroadcastChannel | null = null;
  let exited = false;

  const suspendables: AudioContext[] = [];
  const trackAudio = opts.suspendAudioWhenHidden ? watchAudioContexts(suspendables) : null;

  async function boot(): Promise<void> {
    const { dotnet } = await loadDotnetModule(config.jsUrl ?? files.dotnetJs);

    runtime = await dotnet
      .withConfig({ pthreadPoolInitialSize: opts.pthreadPoolSize })
      .withRuntimeOptions([
        ...(opts.jiterpreter ? JITERPRETER_OPTIONS : []),
        ...(opts.extraRuntimeOptions ?? []),
      ])
      .withResourceLoader(splitWasmLoader(fetchImpl))
      .create();

    for (const [name, module] of Object.entries(imports)) {
      runtime.setModuleImports(name, module);
    }

    const monoConfig = runtime.getConfig();
    exports = (await runtime.getAssemblyExports(
      monoConfig.mainAssemblyName ?? 'CelesteLoader',
    )) as unknown as CelesteExports;

    // runMain has to come first: it is what starts the deputy thread the
    // renderer lives on. Mounting before it would put the filesystem on the
    // wrong side of the thread boundary.
    await runtime.runMain();
    await exports.CelesteBootstrap.MountFilesystems(
      files.root,
      assemblyList(monoConfig),
      opts.storageNamespace,
    );
    await exports.CelesteLoader.PreInit();

    if (destroyed) return;

    await patchGame(root, exports, opts);

    if (destroyed) return;

    stopWatchingMemory = watchMemory(exports, (mb) => {
      memoryMB = mb;
      config.onMemory?.(mb);
    });

    await exports.CelesteLoader.Init(false);

    // Run the first frames one at a time. They are the ones still being jitted,
    // and letting the game's own loop hit them means a visible stall instead of
    // a fade-in.
    for (let frame = 0; frame < opts.seamlessFrames; frame++) {
      if (!(await exports.CelesteLoader.RunOneFrame())) break;
    }

    booted = true;
    focusCanvas();
    if (opts.lockKeyboard) void lockKeyboard();
    emit({ type: 'ready' });

    /**
     * The game has stopped ticking, from whichever half noticed first.
     *
     * The event goes out before the teardown rather than after it. `Cleanup()`
     * joins Celeste's own threads (`RunThread.WaitAll()`) before it unloads the
     * audio and disposes the game, and a thread that never comes back would
     * hold the exit event forever — which is a host left showing a black
     * canvas, the exact failure this is here to end. So tell the host, then
     * tidy up on whatever time is left: a host that reloads on `exit` (the
     * runtime cannot be started twice in one page, so most will) takes the
     * audio down with the page anyway, and one that stays gets it unloaded
     * here.
     */
    const stopped = (): void => {
      if (exited || destroyed) return;
      exited = true;
      booted = false;
      stopWatchingMemory?.();
      emit({ type: 'exit' });
      try {
        void exports?.CelesteLoader.Cleanup().catch(() => {});
      } catch {
        // The runtime is on its way down; a teardown that will not start is
        // not something the host can act on.
      }
    };

    // The signal that actually arrives — see EXIT_CHANNEL.
    if (typeof BroadcastChannel !== 'undefined') {
      exitChannel = new BroadcastChannel(EXIT_CHANNEL);
      exitChannel.onmessage = (event: MessageEvent<{ type?: string }>): void => {
        if (event.data?.type === 'mainloop-stopped') stopped();
      };
    }

    // …and the one the loader's signature promises, kept for the runtime that
    // one day returns from `Game.Run()` normally. It is deliberately not
    // awaited by load(): it resolves only once the game is over.
    void exports.CelesteLoader.MainLoop()
      .then(stopped)
      .catch((err: unknown) => {
        emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      });
  }

  if (opts.autoStart) {
    await boot();
  }

  let inputWarned = false;
  let pauseWarned = false;

  const instance: CelesteInstance = {
    start(): void {
      if (booted || destroyed) return;
      void boot().catch((err: unknown) => {
        emit({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      });
    },

    /**
     * FNA drives its own loop on the deputy thread and exposes no handle on it,
     * so there is nothing to suspend from out here. Escape opens Celeste's own
     * pause menu, which is the real pause.
     */
    pause(): void {
      if (!pauseWarned) {
        pauseWarned = true;
        console.warn('celeste: the game owns its main loop; pause() has no effect. Press Escape instead.');
      }
    },
    resume(): void {},

    /**
     * There is one .NET runtime per page and the canvas has already been
     * transferred to a worker, so a power cycle means a reload. The contract
     * allows this to throw, and a silent no-op would be worse.
     */
    reset(): never {
      throw new Error(
        'celeste: the runtime cannot be reset in-process — reload the page. Saves and mods survive in storage.',
      );
    },

    /** Celeste ships a key-mapping screen, and Everest adds its own. */
    setInput(_map: InputPreset | KeyMap): void {
      if (!inputWarned) {
        inputWarned = true;
        console.warn(
          'celeste: input is remapped inside the game (Options → Key Config); setInput() has no effect.',
        );
      }
    },

    /**
     * Drops what this package staged — see the standalone `purgeStorage()`,
     * which this is. Exposed on the instance because the engine contract asks
     * for it there, and exported as well because a host may want it before
     * `load()` has ever run.
     *
     * The loader mounts one OPFS root per origin, so this ignores
     * `storageNamespace`.
     */
    purgeStorage,

    destroy(): void {
      destroyed = true;
      pageInstance = null;
      stopWatchingMemory?.();
      exitChannel?.close();
      exitChannel = null;
      trackAudio?.();
      canvas.removeEventListener('contextmenu', swallowContextMenu);
      canvas.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      window.removeEventListener('focus', onWindowFocus);
      window.removeEventListener('resize', onResize);
      boxObserver?.disconnect();
      if (ownsCanvas) canvas.remove();
      restoreContainerPosition?.();
      // The .NET runtime itself stays: a wasm module with live worker threads
      // cannot be torn down from the page that started it. This releases the
      // SDK's own hold on it, and a reload releases the rest.
    },

    install,
    get memoryMB(): number {
      return memoryMB;
    },
    get runtime(): DotnetRuntimeAPI {
      if (!runtime) throw new Error('celeste: the runtime has not booted yet — call start() first');
      return runtime;
    },
    get exports(): CelesteExports {
      if (!exports) throw new Error('celeste: the runtime has not booted yet — call start() first');
      return exports;
    },
  };

  pageInstance = instance;
  return instance;
}

// -------------------------------------------------------------------- sizing

/**
 * The window scales worth asking for.
 *
 * `WindowScale` is Celeste's own "Window Size" setting and multiplies the
 * 320×180 gameplay buffer, so 6 is 1920×1080. The ceiling is there because the
 * game composes every frame — the upscaled gameplay buffer, the HUD, the menus
 * and the hi-res fonts — into a single 1922×1082 target and only then blits it
 * to the window. Past 6 there is no more picture to see: the same 1080p frame
 * is scaled up further, for nothing but fill rate.
 */
const MIN_WINDOW_SCALE = 1;
const MAX_WINDOW_SCALE = 6;

/** Celeste's settings file, inside the save directory it shares with the saves. */
const SETTINGS_FILE = `${SAVES_DIR}/settings.celeste`;

/** …inside the namespace, which is where the game will read it from. */
const settingsPath = (): string => at(SETTINGS_FILE);

/** Largest whole multiple of the gameplay buffer that fits in `width`×`height`. */
export function windowScaleFor(width: number, height: number): number {
  const scale = Math.floor(
    Math.min(width / manifest.video.baseWidth, height / manifest.video.baseHeight),
  );
  return Math.max(MIN_WINDOW_SCALE, Math.min(MAX_WINDOW_SCALE, scale || MIN_WINDOW_SCALE));
}

/**
 * A `settings.celeste` written from scratch, for a first run.
 *
 * Every element but the one below is left out on purpose: `XmlSerializer`
 * leaves a missing member at the value the `Settings` constructor gave it, so
 * this deserialises to exactly what the game would have built for itself —
 * language picked from the browser, the vanilla bindings, the first-run flow
 * intact — with the resolution the page asked for and nothing else decided
 * here.
 */
function emptySettings(scale: number): string {
  return [
    '<?xml version="1.0"?>',
    '<Settings xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <WindowScale>${scale}</WindowScale>`,
    '</Settings>',
    '',
  ].join('\n');
}

/**
 * Drop a `WindowScale: N` line, which is not part of this file.
 *
 * Everest's *mod* settings are YAML; Celeste's own are XML, and versions of
 * this package up to 0.1.4 wrote the YAML form into the XML one. Appended after
 * `</Settings>` it is trailing content past the root element, so the whole
 * document fails to deserialise and the game starts from its defaults — which
 * is a player's language, bindings and volumes gone on every reload. Stripping
 * it puts the document back the way Celeste wrote it.
 */
function withoutStrayScaleLine(settings: string): string {
  return settings.replace(/^[ \t]*WindowScale:[^\n]*(\n|$)/gm, '');
}

/** `<WindowScale>4</WindowScale>`, or the self-closing form of an empty one. */
const WINDOW_SCALE_ELEMENT = /<WindowScale\s*(?:\/>|>[^<]*<\/WindowScale\s*>)/;

/**
 * `settings.celeste`, with the window scale set to `scale`.
 *
 * The file is the XML Celeste serialises itself, and the rest of it is the
 * player's — key bindings, audio levels, language — so the one element is
 * edited in place and everything else is left byte for byte. `null` is a first
 * run, and so is a file too broken to edit: the game fills in every other field
 * from its own defaults and writes the whole document back.
 */
export function settingsWithWindowScale(settings: string | null, scale: number): string {
  if (settings === null) return emptySettings(scale);

  const repaired = withoutStrayScaleLine(settings);
  const element = `<WindowScale>${scale}</WindowScale>`;

  if (WINDOW_SCALE_ELEMENT.test(repaired)) {
    return repaired.replace(WINDOW_SCALE_ELEMENT, element);
  }

  // No scale in it, but a document to put one in: in front of the closing tag.
  // A serialiser that put that tag on a line of its own gets the element on one
  // too, indented to match; one that wrote the document flat gets it inline.
  const closing = repaired.search(/<\/Settings\s*>/);
  if (closing >= 0) {
    const lineStart = repaired.lastIndexOf('\n', closing) + 1;
    const indent = repaired.slice(lineStart, closing);
    if (indent.trim() !== '') {
      return `${repaired.slice(0, closing)}${element}${repaired.slice(closing)}`;
    }
    return `${repaired.slice(0, lineStart)}${indent}  ${element}\n${repaired.slice(lineStart)}`;
  }

  return emptySettings(scale);
}

/**
 * Put the resolution in Celeste's settings, before Celeste reads them.
 *
 * The page has no other way to ask for one. The browser build hooks
 * `Settings.ApplyScreen()` and forces the window to `WindowScale × 320` by
 * `WindowScale × 180`, so it never looks at the canvas; the canvas belongs to
 * the render worker from the first pthread onwards, so nothing on the page can
 * resize it afterwards either; and the loader exports no way in. What is left
 * is the settings file the game deserialises during `Init()`.
 *
 * `scale` is null when the host turned `syncResolution` off. The file is still
 * read, because a settings file the versions up to 0.1.4 broke is broken
 * whether or not the resolution is being synced, and one pass of
 * `withoutStrayScaleLine` is what puts it back.
 */
async function applyWindowScale(root: FileSystemDirectoryHandle, scale: number | null): Promise<void> {
  const existing = await readFile(root, settingsPath());
  if (!existing && scale === null) return;

  const before = existing ? new TextDecoder().decode(existing) : null;
  const after =
    scale === null ? withoutStrayScaleLine(before ?? '') : settingsWithWindowScale(before, scale);

  if (after === before) return;
  await writeFile(root, settingsPath(), new TextEncoder().encode(after));
}

// ---------------------------------------------------------------------- steps

/**
 * Get the player's Celeste into storage, and check it is Celeste.
 *
 * A reload is the common case, and re-staging 1.3 GB on every one of them would
 * be absurd — so an install already in storage is accepted as-is unless the
 * host explicitly hands over a new one.
 */
async function stageGame(
  root: FileSystemDirectoryHandle,
  config: CelesteLoadConfig,
  opts: typeof DEFAULT_CELESTE_OPTIONS & CelesteOptions,
  report: (progress: StageProgress) => void,
): Promise<InstallCheck> {
  const supplied =
    config.gameDirectory ??
    toBytes(config.assets?.game ?? config.assets?.data) ??
    (config.gameProvider ? toBytes(await config.gameProvider()) : null);

  // What was at the root before this ran, so the manifest can record only what
  // this package added rather than whatever else shares the origin.
  const before = await rootEntries(root);

  if (!supplied) {
    const existing = await checkStaged(root);
    if (existing.ok) return existing;
    throw new Error(
      'celeste: no game supplied and none in storage — pass assets.game (a zip of your Celeste folder), options.gameDirectory, or gameProvider',
    );
  }

  // Everest's backup of the vanilla game doubles the size of an install that
  // was already patched once, and the browser patcher makes its own.
  const skip = ['orig/'];

  if (supplied instanceof Uint8Array || supplied instanceof Blob) {
    // Opened here only to read the listing — the staging worker opens its own
    // over the same archive, which costs one read of the central directory.
    const reader = await ZipReader.open(supplied);
    const listing = inspectInstall(reader.entries.map((entry) => entry.name));
    if (opts.verifyInstall && !listing.ok) return listing;

    await stageWithWorker(
      {
        root,
        source: { kind: 'zip', archive: supplied, strip: listing.root },
        into: at(''),
        skip,
      },
      report,
    );
    await recordStaged(root, before);
    return checkStaged(root);
  }

  // The one walk that has to be exhaustive. `root` above is this package's own
  // layout — always flat, always shallow — but this is the folder the *player*
  // picked, and they are allowed to hand over a parent of their install: the
  // `descend` below exists for exactly that. Capping the depth here would put a
  // ceiling on how deeply nested a folder may be before the check stops finding
  // Celeste in it, which is a worse trade than the walk costs. The copy is
  // about to enumerate the same tree anyway.
  const listing = inspectInstall(await listPaths(supplied));
  if (opts.verifyInstall && !listing.ok) return listing;

  await stageWithWorker(
    {
      root,
      source: {
        kind: 'directory',
        handle: listing.root ? await descend(supplied, listing.root) : supplied,
      },
      into: at(''),
      skip,
    },
    report,
  );
  await recordStaged(root, before);
  return checkStaged(root);
}

async function descend(
  handle: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let current = handle;
  for (const segment of path.split('/').filter(Boolean)) {
    current = await current.getDirectoryHandle(segment, { create: false });
  }
  return current;
}

/** Put an Everest build where `Patcher.ExtractEverest()` reads it from. */
async function stageEverest(
  root: FileSystemDirectoryHandle,
  config: CelesteLoadConfig,
  opts: typeof DEFAULT_CELESTE_OPTIONS & CelesteOptions,
  fetchImpl: typeof fetch,
): Promise<void> {
  const supplied = toBytes(config.assets?.everest);
  if (supplied) {
    await writeFile(root, at(EVEREST_ZIP), supplied instanceof Blob ? new Uint8Array(await supplied.arrayBuffer()) : supplied);
    return;
  }

  // Already unpacked by a previous session, and not being replaced.
  if (!opts.repatch && (await exists(root, at(EVEREST_MARKER)))) return;
  if (await exists(root, at(EVEREST_ZIP))) return;

  const url =
    opts.everestSource === 'updater'
      ? (await resolveEverestBuild(opts.everestBranch, fetchImpl)).mainDownload
      : new URL(
          `${EVEREST_ZIP}`,
          opts.runtimeBaseUrl
            ? new URL(opts.runtimeBaseUrl, location.href).href.replace(/\/?$/, '/')
            : new URL('.', import.meta.url).href,
        ).href;

  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    throw new Error(`celeste: could not fetch the Everest build from ${url} (${response.status})`);
  }
  await writeFile(root, at(EVEREST_ZIP), response.body as ReadableStream<Uint8Array>);
}

/**
 * MonoMod, in the browser, over the player's own copy of the game.
 *
 * This is the expensive step — minutes, and most of the runtime's memory
 * footprint — so its output is cached in storage and only redone when the host
 * asks for it or when there is nothing to reuse.
 */
async function patchGame(
  root: FileSystemDirectoryHandle,
  exports: CelesteExports,
  opts: typeof DEFAULT_CELESTE_OPTIONS & CelesteOptions,
): Promise<void> {
  const patched = await exists(root, at(PATCHED_ASSEMBLY));
  if (patched && !opts.repatch) return;

  if (opts.installEverest && (opts.repatch || !(await exists(root, at(EVEREST_MARKER))))) {
    if (!(await exports.Patcher.ExtractEverest())) {
      throw new Error('celeste: could not unpack the Everest build');
    }
  }

  if (!(await exports.Patcher.PatchCeleste(opts.installEverest))) {
    throw new Error(
      'celeste: MonoMod could not patch this copy of Celeste. Check the console for the failing hook — an install the game itself will not run is the usual cause.',
    );
  }
}

function watchMemory(exports: CelesteExports, onSample: (megabytes: number) => void): () => void {
  let stop = false;
  void exports.CelesteLoader.WatchMemoryUsage((megabytes: number) => {
    onSample(megabytes);
    return stop;
  });
  return () => {
    stop = true;
  };
}

/**
 * FMOD keeps its mixer running on a hidden tab, which is both audible and
 * expensive. The contexts it creates are not reachable from here, so they are
 * collected as they are constructed.
 */
function watchAudioContexts(contexts: AudioContext[]): () => void {
  if (typeof AudioContext === 'undefined') return () => {};

  const Original = AudioContext;
  const Patched = new Proxy(Original, {
    construct(target, args: ConstructorParameters<typeof AudioContext>) {
      const context = new target(...args);
      contexts.push(context);
      return context;
    },
  });
  (globalThis as { AudioContext: typeof AudioContext }).AudioContext = Patched;

  const onVisibility = (): void => {
    const hidden = document.visibilityState !== 'visible';
    for (const context of contexts) {
      void (hidden ? context.suspend() : context.resume()).catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    (globalThis as { AudioContext: typeof AudioContext }).AudioContext = Original;
  };
}

/**
 * Escape is Celeste's pause key and the browser's "leave fullscreen" gesture.
 * The Keyboard Lock API is what lets the game have it; it is Chromium-only and
 * only takes effect in fullscreen, so failure here is expected and ignored.
 */
async function lockKeyboard(): Promise<void> {
  const keyboard = (navigator as Navigator & { keyboard?: { lock(): Promise<void> } }).keyboard;
  try {
    await keyboard?.lock();
  } catch {
    // Not available, or the page is not fullscreen. Escape goes to the browser.
  }
}

export default {
  manifest,
  load,
  stagedInstall,
  purgeStorage,
  exportSaves,
  importSaves,
  exportInstall,
  importInstall,
};

import type {
  AssetData,
  EngineConfig,
  EngineEvent,
  EngineInstance,
  InputPreset,
  KeyMap,
} from '@wasm-gaming/engine-specs';
import { inspectInstall, type InstallCheck } from './celeste.install.js';
import { manifest } from './celeste.manifest.js';
import {
  copyDirectoryInto,
  ensureDirectory,
  EVEREST_DIR,
  EVEREST_MARKER,
  EVEREST_ZIP,
  exists,
  extractInto,
  listPaths,
  MODS_DIR,
  opfsRoot,
  PATCHED_ASSEMBLY,
  readFile,
  removePath,
  SAVES_DIR,
  VFS_ROOT,
  writeFile,
  type StageProgress,
} from './celeste.opfs.js';
import { DEFAULT_CELESTE_OPTIONS, type CelesteOptions } from './celeste.options.js';
import {
  assemblyList,
  hostImports,
  JITERPRETER_OPTIONS,
  loadDotnetModule,
  resolveEverestBuild,
  runtimeFiles,
  splitWasmLoader,
  type CelesteExports,
  type DotnetRuntimeAPI,
  type SplashProgress,
} from './celeste.runtime.js';
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

  await ensureDirectory(root, MODS_DIR);
  await ensureDirectory(root, SAVES_DIR);

  // Last chance to read the page: the game deserialises its settings inside
  // `Init()`, a few lines below, and from then on the resolution is its own.
  resolveResolution(true);
  if (opts.syncResolution) await applyWindowScale(root, windowScale);

  // ------------------------------------------------------------------- runtime

  const baseUrl = opts.runtimeBaseUrl
    ? new URL(opts.runtimeBaseUrl, typeof location === 'undefined' ? undefined : location.href).href
    : new URL('.', import.meta.url).href;
  const files = runtimeFiles(config.jsUrl ? new URL('../', config.jsUrl).href : baseUrl);

  const imports = hostImports({ onSplash: config.onSplash });

  let runtime: DotnetRuntimeAPI | null = null;
  let exports: CelesteExports | null = null;
  let booted = false;
  let destroyed = false;
  let memoryMB = -1;
  let stopWatchingMemory: (() => void) | null = null;

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
    await exports.CelesteBootstrap.MountFilesystems(files.root, assemblyList(monoConfig));
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

    // MainLoop only resolves when the game exits, so it is deliberately not
    // awaited by load().
    void exports.CelesteLoader.MainLoop()
      .then(async () => {
        stopWatchingMemory?.();
        await exports?.CelesteLoader.Cleanup();
        booted = false;
        emit({ type: 'exit' });
      })
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
     * Drops what this package staged. `data` is the game itself — the install,
     * the patched assembly and the Everest build; `settings` is Celeste's save
     * directory, which holds the save files *and* the settings file.
     *
     * The loader mounts one OPFS root per origin, so this ignores
     * `storageNamespace`. Call it on a destroyed instance, or before `load()`.
     */
    async purgeStorage(): Promise<{ data: boolean; settings: boolean }> {
      const removals = await Promise.all([
        removePath(root, 'Content'),
        removePath(root, 'Celeste.exe'),
        removePath(root, 'Celeste.dll'),
        removePath(root, PATCHED_ASSEMBLY),
        removePath(root, EVEREST_ZIP),
        removePath(root, EVEREST_DIR),
      ]);
      const settings = await removePath(root, SAVES_DIR);
      return { data: removals.some(Boolean), settings };
    },

    destroy(): void {
      destroyed = true;
      pageInstance = null;
      stopWatchingMemory?.();
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

/** Largest whole multiple of the gameplay buffer that fits in `width`×`height`. */
export function windowScaleFor(width: number, height: number): number {
  const scale = Math.floor(
    Math.min(width / manifest.video.baseWidth, height / manifest.video.baseHeight),
  );
  return Math.max(MIN_WINDOW_SCALE, Math.min(MAX_WINDOW_SCALE, scale || MIN_WINDOW_SCALE));
}

/**
 * `settings.celeste`, with the window scale set to `scale`.
 *
 * The file is the YAML Celeste writes itself, and the rest of it is the
 * player's — key bindings, audio levels, language — so the one line is edited
 * in place and everything else is left byte for byte. `null` is a first run:
 * the game fills in every other field from its own defaults and writes the
 * whole file back.
 */
export function settingsWithWindowScale(settings: string | null, scale: number): string {
  const line = `WindowScale: ${scale}`;
  if (settings === null) return `${line}\n`;
  if (/^WindowScale:[^\n]*$/m.test(settings)) {
    return settings.replace(/^WindowScale:[^\n]*$/m, line);
  }
  return `${settings.endsWith('\n') ? settings : `${settings}\n`}${line}\n`;
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
 */
async function applyWindowScale(root: FileSystemDirectoryHandle, scale: number): Promise<void> {
  const existing = await readFile(root, SETTINGS_FILE);
  const before = existing ? new TextDecoder().decode(existing) : null;
  const after = settingsWithWindowScale(before, scale);

  if (after === before) return;
  await writeFile(root, SETTINGS_FILE, new TextEncoder().encode(after));
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

  if (!supplied) {
    const existing = inspectInstall(await listPaths(root));
    if (existing.ok) return existing;
    throw new Error(
      'celeste: no game supplied and none in storage — pass assets.game (a zip of your Celeste folder), options.gameDirectory, or gameProvider',
    );
  }

  if (supplied instanceof Uint8Array || supplied instanceof Blob) {
    const reader = await ZipReader.open(supplied);
    const listing = inspectInstall(reader.entries.map((entry) => entry.name));
    if (opts.verifyInstall && !listing.ok) return listing;

    // Everest's backup of the vanilla game doubles the size of an install that
    // was already patched once, and the browser patcher makes its own.
    await extractInto(reader, root, {
      strip: listing.root,
      filter: (path) => !path.startsWith('orig/'),
      onProgress: report,
    });
    return inspectInstall(await listPaths(root));
  }

  const listing = inspectInstall(await listPaths(supplied));
  if (opts.verifyInstall && !listing.ok) return listing;

  await copyDirectoryInto(
    listing.root ? await descend(supplied, listing.root) : supplied,
    root,
    '',
    report,
  );
  return inspectInstall(await listPaths(root));
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
    await writeFile(root, EVEREST_ZIP, supplied instanceof Blob ? new Uint8Array(await supplied.arrayBuffer()) : supplied);
    return;
  }

  // Already unpacked by a previous session, and not being replaced.
  if (!opts.repatch && (await exists(root, EVEREST_MARKER))) return;
  if (await exists(root, EVEREST_ZIP)) return;

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
  await writeFile(root, EVEREST_ZIP, response.body as ReadableStream<Uint8Array>);
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
  const patched = await exists(root, PATCHED_ASSEMBLY);
  if (patched && !opts.repatch) return;

  if (opts.installEverest && (opts.repatch || !(await exists(root, EVEREST_MARKER)))) {
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

export default { manifest, load };

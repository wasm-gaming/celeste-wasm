// Typed handle on the .NET WebAssembly runtime the game runs inside.
//
// `make build-wasm` writes that runtime into dist/celeste/_framework/: Mono
// compiled to wasm with threads and SIMD, the FNA/FNA3D/SDL3/FMOD statics
// linked into it, MonoMod.WASM, and the loader assemblies that drive Celeste.
// Nothing in this file talks to the game — it describes the runtime's surface,
// boots it, and supplies the handful of functions the loader imports back out
// of JavaScript.
//
// The three exported classes it drives:
//
//   CelesteBootstrap.MountFilesystems(root, dlls, ns)  mount OPFS at /libsdl
//   Patcher.ExtractEverest() / PatchCeleste(bool)  MonoMod over the player's copy
//   CelesteLoader.PreInit/Init/RunOneFrame/MainLoop/Cleanup   the game itself

import { opfsRoot, VFS_ROOT } from './celeste.opfs.js';
import { XXH64 } from './celeste.xxh64.js';

/** Runtime subdirectory holding dotnet.js and the assemblies. */
export const FRAMEWORK_DIR = '_framework';

export interface MonoResource {
  name: string;
  virtualPath?: string;
}

export interface MonoConfig {
  mainAssemblyName?: string;
  resources?: {
    coreAssembly?: MonoResource[];
    assembly?: MonoResource[];
  };
}

export interface DotnetRuntimeAPI {
  getConfig(): MonoConfig;
  getAssemblyExports(assemblyName: string): Promise<Record<string, unknown>>;
  setModuleImports(moduleName: string, imports: Record<string, unknown>): void;
  runMain(mainAssemblyName?: string, args?: string[]): Promise<number>;
  Module: { FS?: unknown } & Record<string, unknown>;
}

export type ResourceLoader = (
  type: string,
  name: string,
  defaultUri: string,
  integrity: string,
  behavior: string,
) => Promise<Response> | Response | undefined;

export interface DotnetHostBuilder {
  withConfig(config: Record<string, unknown>): DotnetHostBuilder;
  withRuntimeOptions(options: string[]): DotnetHostBuilder;
  withResourceLoader(loader: ResourceLoader): DotnetHostBuilder;
  create(): Promise<DotnetRuntimeAPI>;
}

/** The `[JSExport]`s the loader publishes, as seen from JavaScript. */
export interface CelesteExports {
  CelesteBootstrap: {
    /**
     * `storageNamespace` exists only on a runtime built from source here — the
     * stock loader resolves its paths against the mount root. `load()` checks
     * `runtime.json` before passing one, so a mismatch is an error rather than
     * a game that stages where it will not look.
     */
    MountFilesystems(root: string, dlls: string[], storageNamespace?: string): Promise<void>;
  };
  Patcher: {
    /** Unpack /libsdl/everest.zip into /libsdl/Celeste/Everest/. */
    ExtractEverest(): Promise<boolean>;
    /** Run MonoMod over the player's Celeste, writing /libsdl/CustomCeleste.dll. */
    PatchCeleste(installEverest: boolean): Promise<boolean>;
  };
  CelesteLoader: {
    PreInit(): Promise<void>;
    Init(tailcalls: boolean): Promise<void>;
    /** Advances one frame; false once the game has asked to quit. */
    RunOneFrame(): Promise<boolean>;
    /** Hands control to FNA's own loop. Resolves when the game exits. */
    MainLoop(): Promise<void>;
    Cleanup(): Promise<void>;
    WatchMemoryUsage(callback: (megabytes: number) => boolean): Promise<void>;
  };
}

/**
 * Mono's jiterpreter, tuned the way the upstream loader tunes it.
 *
 * The defaults are set for a web app that runs a little managed code; Celeste
 * runs a 60 Hz game loop through it. Left alone, the interpreter never promotes
 * the hot traces and the game sits at single-digit frame rates.
 */
export const JITERPRETER_OPTIONS: readonly string[] = [
  // Trace sooner, and keep tracing methods that look marginal.
  '--jiterpreter-minimum-trace-hit-count=500',
  '--jiterpreter-trace-monitoring-period=100',
  '--jiterpreter-trace-monitoring-max-average-penalty=150',
  // Celeste plus Everest plus mods is far more code than the default budgets.
  '--jiterpreter-wasm-bytes-limit=67108864',
  '--jiterpreter-table-size=32768',
];

/**
 * `runtime.json`, written beside `_framework/` by scripts/build-celeste-runtime.sh.
 *
 * Provenance, and — since the loader can now be built with its storage under a
 * namespace — the one place a host can find out which layout the runtime it is
 * about to boot expects.
 */
export interface RuntimeDescriptor {
  repository?: string;
  revision?: string | null;
  builtFromSource?: boolean;
  /** Namespace the loader was built with; null or absent means the mount root. */
  storageNamespace?: string | null;
}

/**
 * Read it, tolerating its absence.
 *
 * A host may serve `_framework/` from somewhere that never had the file — a CDN
 * copy, an older release — so this answers `null` rather than failing, and the
 * caller decides what an unknown layout means.
 */
export async function readRuntimeDescriptor(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RuntimeDescriptor | null> {
  try {
    const response = await fetchImpl(new URL('runtime.json', baseUrl).href);
    if (!response.ok) return null;
    return (await response.json()) as RuntimeDescriptor;
  } catch {
    return null;
  }
}

/**
 * Which OPFS layout to stage into, given what the host asked for and what the
 * runtime says it was built with.
 *
 * The runtime has the final word — it resolves its own absolute paths, and a
 * namespace it was not built with is 1.1 GB staged where it will never look. So
 * a host that asked for nothing gets the runtime's answer, and a host that
 * asked for something the runtime contradicts is stopped here rather than at
 * "Celeste was not found" twenty minutes later.
 *
 * With no descriptor there is nothing to check against and the host's word, or
 * the fallback, stands: an unlabelled `_framework/` is trusted rather than
 * refused, because a CDN copy of one may simply not carry the file.
 *
 * @param requested What the host set, or `undefined` if it said nothing.
 * @param descriptor The runtime's `runtime.json`, or `null` if it has none.
 * @param fallback Layout to assume when neither has an opinion.
 */
export function resolveStorageNamespace(
  requested: string | undefined,
  descriptor: RuntimeDescriptor | null,
  fallback = '',
): string {
  const runtime = descriptor?.storageNamespace ?? '';

  if (requested === undefined) return descriptor ? runtime : fallback;
  if (!descriptor || runtime === requested) return requested;

  throw new Error(
    `celeste: options.storageNamespace is ${JSON.stringify(requested)}, but this runtime keeps the game ` +
      (runtime
        ? `under ${JSON.stringify(runtime)}.`
        : 'at the root of the origin private filesystem — the stock loader does not take a namespace.') +
      ` Set storageNamespace to ${JSON.stringify(runtime)}, or build a runtime with LOADER_NAMESPACE=${requested || '-'} (make build-runtime-docker).`,
  );
}

export interface RuntimeFiles {
  /** Directory holding `_framework/`, with a trailing slash. */
  root: string;
  /** ES module entry point of the runtime. */
  dotnetJs: string;
}

export function runtimeFiles(baseUrl: string): RuntimeFiles {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return { root, dotnetJs: new URL(`${FRAMEWORK_DIR}/dotnet.js`, root).href };
}

/**
 * The runtime's wasm binary is published in 20 MB pieces.
 *
 * A single `dotnet.native.wasm` here is ~100 MB, which is past what several
 * CDNs and every GitHub Release will serve in one object, so the build splits
 * it and this stitches it back together. The pieces are `…wasm0`, `…wasm1`, …;
 * the run ends at the first request that 404s or comes back as an error page.
 */
export function splitWasmLoader(fetchImpl: typeof fetch = fetch): ResourceLoader {
  return (type, _name, defaultUri, _integrity, behavior) => {
    if (type !== 'dotnetwasm' || behavior !== 'dotnetwasm') return undefined;

    let index = 0;
    const nextPiece = async (): Promise<ReadableStreamDefaultReader<Uint8Array> | null> => {
      const response = await fetchImpl(`${defaultUri}${index++}`);
      if (!response.body) return null;
      const isPiece =
        response.status === 200 && !(response.headers.get('content-type') ?? '').includes('text/html');
      return isPiece ? (response.body as ReadableStream<Uint8Array>).getReader() : null;
    };

    return (async () => {
      let current = await nextPiece();
      if (!current) {
        throw new Error(`celeste: the runtime binary is missing (${defaultUri}0 did not load)`);
      }

      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          for (;;) {
            const { done, value } = await current!.read();
            if (!done && value) {
              controller.enqueue(value);
              return;
            }
            current = await nextPiece();
            if (!current) {
              controller.close();
              return;
            }
          }
        },
      });

      return new Response(stream, { headers: { 'Content-Type': 'application/wasm' } });
    })();
  };
}

declare global {
  interface Window {
    /** Set by the runtime's own glue; used to detect a second boot. */
    TRANSFERRED_CANVAS?: boolean;
  }
}

const moduleCache = new Map<string, Promise<{ dotnet: DotnetHostBuilder }>>();

/**
 * Import the runtime's ES module.
 *
 * The URL is only known at runtime (`options.runtimeBaseUrl`), and a bundler
 * that sees a bare `import()` of it will try to resolve and inline ~250 MB of
 * runtime at build time. The indirection through a variable is what stops that.
 */
export function loadDotnetModule(dotnetJsUrl: string): Promise<{ dotnet: DotnetHostBuilder }> {
  const cached = moduleCache.get(dotnetJsUrl);
  if (cached) return cached;

  const dynamicImport = new Function('url', 'return import(url)') as (
    url: string,
  ) => Promise<{ dotnet: DotnetHostBuilder }>;

  const pending = dynamicImport(dotnetJsUrl).catch((cause: unknown) => {
    moduleCache.delete(dotnetJsUrl);
    throw new Error(`celeste: failed to load the runtime from ${dotnetJsUrl}`, { cause });
  });

  moduleCache.set(dotnetJsUrl, pending);
  return pending;
}

/** Assembly list in the `name|virtualPath` form `MountFilesystems` parses. */
export function assemblyList(config: MonoConfig): string[] {
  const resources = [...(config.resources?.coreAssembly ?? []), ...(config.resources?.assembly ?? [])];
  return resources.map((resource) => `${resource.name}|${resource.virtualPath ?? resource.name}`);
}

/** How far Everest has got through the mod list, when it says so. */
export interface SplashProgress {
  loaded: number;
  total: number;
  /** The mod it just finished with, if the message named one. */
  mod?: string;
  /** Everest is done with the list and the splash is about to go. */
  done: boolean;
}

/**
 * Everest's splash messages are a wire protocol, not prose.
 *
 * On the desktop the splash is a separate process reading lines off a named
 * pipe, and those lines are what reach `JsSplash.OnMessage` here — verbatim.
 * Handing them to a host as-is puts `#finish0;Almost done...` on its loading
 * screen, so they get read the way EverestSplash reads them:
 *
 *   #progress{loaded};{total};{mod}   one mod finished loading
 *   #finish{total};{message}          the whole list is done
 *   #stop                             close the splash
 *
 * Anything else is a plain message and is passed through untouched.
 */
export function parseSplashMessage(
  raw: string,
): { text: string | null; progress?: SplashProgress } {
  if (raw === '#stop') return { text: null };

  if (raw.startsWith('#progress')) {
    const [loaded, total, ...rest] = raw.slice('#progress'.length).split(';');
    const mod = rest.join(';');
    return {
      text: mod ? `Loading mods… ${mod}` : 'Loading mods…',
      progress: { loaded: Number(loaded) || 0, total: Number(total) || 0, mod, done: false },
    };
  }

  if (raw.startsWith('#finish')) {
    const [total, ...rest] = raw.slice('#finish'.length).split(';');
    const count = Number(total) || 0;
    return {
      text: rest.join(';') || 'Almost done…',
      progress: { loaded: count, total: count, done: true },
    };
  }

  return { text: raw };
}

/** What the game has unlocked and counted, as this package keeps it. */
export interface SteamProgress {
  /** Achievement ids the game has unlocked, in the order it unlocked them. */
  achievements: string[];
  /** Steam stats, by name. Celeste keeps its own totals in the save file. */
  stats: Record<string, number>;
}

/**
 * Where that record lives, per storage namespace.
 *
 * `localStorage` rather than OPFS because the game asks for an achievement
 * *synchronously* — `GetAchievement` returns a bool to managed code with no
 * await in between — and OPFS cannot be read that way from the page.
 */
export function steamStorageKey(namespace: string): string {
  return namespace ? `celeste-wasm:${namespace}:steam` : 'celeste-wasm:steam';
}

/** The page's `localStorage`, or null where reading it throws (sandboxed frames). */
function pageStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Read the record back, treating anything unexpected as "nothing yet". */
export function readSteamProgress(
  namespace: string,
  storage: Pick<Storage, 'getItem'> | null = pageStorage(),
): SteamProgress {
  const empty: SteamProgress = { achievements: [], stats: {} };
  if (!storage) return empty;

  try {
    const raw = storage.getItem(steamStorageKey(namespace));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<SteamProgress>;
    return {
      achievements: Array.isArray(parsed.achievements)
        ? parsed.achievements.filter((id): id is string => typeof id === 'string')
        : [],
      stats: parsed.stats && typeof parsed.stats === 'object' ? { ...parsed.stats } : {},
    };
  } catch {
    return empty;
  }
}

/**
 * Steam's stats and achievements, answered on the page.
 *
 * The loader is built against Steamworks.NET, so the game asks for these the
 * way it does on the desktop — five functions a Steam client normally answers.
 * There is no Steam client here, and an unregistered module is *fatal* to the
 * runtime rather than merely unavailable: the first call the game makes aborts
 * with "ES6 module SteamJS was not imported yet" and the session goes with it.
 * Which is why this exists even though nothing it records leaves the browser.
 *
 * `NewQR` belongs to the Steam depot sign-in that this package does not do (see
 * `encryptrsa` below) and is only reachable through `SteamJS.InitSteam`, which
 * nothing here calls — it is answered so that the surface is complete.
 */
export function steamImports(options: {
  /** Which record to use; matches the OPFS namespace the game is staged in. */
  storageNamespace?: string;
  onAchievement?: (achievement: string) => void;
  /** Override for tests, and for a host that keeps this somewhere else. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}): Record<string, unknown> {
  const namespace = options.storageNamespace ?? '';
  const storage = options.storage === undefined ? pageStorage() : options.storage;

  const progress = readSteamProgress(namespace, storage);

  const save = (): void => {
    try {
      storage?.setItem(steamStorageKey(namespace), JSON.stringify(progress));
    } catch {
      // A full or disabled store costs the record, not the run.
    }
  };

  return {
    GetAchievement: (achievement: string): boolean => progress.achievements.includes(achievement),
    SetAchievement: (achievement: string): void => {
      if (progress.achievements.includes(achievement)) return;
      progress.achievements.push(achievement);
      save();
      options.onAchievement?.(achievement);
    },

    // `GetStat` is typed `int` on the managed side, and a value that is not one
    // aborts the runtime the same way a missing module does — so a record that
    // has been edited or truncated reads as zero rather than as a crash.
    GetStat: (stat: string): number => {
      const value = progress.stats[stat];
      return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
    },
    SetStat: (stat: string, value: number): void => {
      progress.stats[stat] = value;
      save();
    },

    NewQR: (): void => {},
  };
}

/**
 * The functions the loader imports out of JavaScript.
 *
 * `JsSplash` is wired to Everest's own splash handler, so its messages are the
 * mod loader reporting progress — the host gets them as `onSplash`, parsed out
 * of the protocol above. `interop.js` covers two things Mono cannot do quickly
 * enough by itself, and `SteamJS` stands in for the Steam client.
 */
export function hostImports(options: {
  onSplash?: (message: string | null, progress?: SplashProgress) => void;
  onAchievement?: (achievement: string) => void;
  storageNamespace?: string;
}): Record<string, Record<string, unknown>> {
  const { onSplash } = options;

  return {
    SteamJS: steamImports({
      storageNamespace: options.storageNamespace,
      onAchievement: options.onAchievement,
    }),
    JsSplash: {
      StartSplash: () => onSplash?.(''),
      OnMessage: (message: string) => {
        const { text, progress } = parseSplashMessage(message);
        onSplash?.(text, progress);
      },
      EndSplash: () => onSplash?.(null),
    },
    'interop.js': {
      /**
       * Everest fingerprints mod archives with XXH64. Doing it in the
       * interpreter takes tens of seconds per gigabyte of mods; doing it here
       * takes about one.
       */
      XXHash64_Fast: async (path: string): Promise<{ ret: Uint8Array }> => {
        const prefix = `${VFS_ROOT}/`;
        if (!path.startsWith(prefix)) {
          throw new Error(`celeste: refusing to hash ${path}, which is outside ${VFS_ROOT}`);
        }

        const root = await opfsRoot();
        const segments = path.slice(prefix.length).split('/').filter(Boolean);
        const name = segments.pop();
        if (!name) throw new Error(`celeste: ${path} is not a file`);

        let directory = root;
        for (const segment of segments) {
          directory = await directory.getDirectoryHandle(segment, { create: false });
        }
        const file = await (await directory.getFileHandle(name, { create: false })).getFile();

        const hash = new XXH64(0n);
        const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) hash.update(value);
        }
        return { ret: hash.digestBytes() };
      },

      /**
       * SteamKit's login handshake. This package stages a copy of the game the
       * player already has on disk rather than pulling one out of a Steam
       * depot, so nothing here should ever reach it.
       */
      encryptrsa: (): never => {
        throw new Error(
          'celeste: Steam sign-in is not part of this package — supply the game through assets.game or options.gameDirectory',
        );
      },
    },
  };
}

export interface EverestBuild {
  branch: string;
  commit?: string;
  date?: string;
  /** URL of the build's main zip, the same artifact the desktop installer takes. */
  mainDownload: string;
  version?: string;
}

/** Where the Everest updater publishes the address of its version index. */
export const EVEREST_UPDATER_URL = 'https://everestapi.github.io/everestupdater.txt';

/**
 * Resolve the current Everest build on a branch, the way the desktop installer
 * does: one text file names the version index, the index lists every build.
 *
 * Neither host sends permissive CORS headers for every client, so a page that
 * needs this may have to route it through its own proxy — hence `fetchImpl`.
 * `options.everestSource = 'bundled'` avoids the network entirely and is the
 * default for that reason.
 */
export async function resolveEverestBuild(
  branch = 'stable',
  fetchImpl: typeof fetch = fetch,
): Promise<EverestBuild> {
  const indexUrl = (await (await fetchImpl(EVEREST_UPDATER_URL)).text()).trim();
  const builds = (await (
    await fetchImpl(`${indexUrl}?supportsNativeBuilds=true`)
  ).json()) as EverestBuild[];

  const build = builds.find((candidate) => candidate.branch === branch);
  if (!build) {
    throw new Error(`celeste: the Everest updater lists no build on the "${branch}" branch`);
  }
  return build;
}

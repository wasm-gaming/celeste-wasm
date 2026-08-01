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
//   CelesteBootstrap.MountFilesystems(root, dlls)  mount OPFS at /libsdl
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
    MountFilesystems(root: string, dlls: string[]): Promise<void>;
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

/**
 * The functions the loader imports out of JavaScript.
 *
 * `JsSplash` is wired to Everest's own splash handler, so its messages are the
 * mod loader reporting progress — the host gets them as `onSplash`. `interop.js`
 * covers two things Mono cannot do quickly enough by itself.
 */
export function hostImports(options: {
  onSplash?: (message: string | null) => void;
}): Record<string, Record<string, unknown>> {
  const { onSplash } = options;

  return {
    JsSplash: {
      StartSplash: () => onSplash?.(''),
      OnMessage: (message: string) => onSplash?.(message),
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

# @wasm-gaming/celeste-wasm

[![Build](https://github.com/wasm-gaming/celeste-wasm/actions/workflows/build.yml/badge.svg)](https://github.com/wasm-gaming/celeste-wasm/actions/workflows/build.yml)
[![Release](https://github.com/wasm-gaming/celeste-wasm/actions/workflows/release.yml/badge.svg)](https://github.com/wasm-gaming/celeste-wasm/actions/workflows/release.yml)

[Celeste](https://www.celestegame.com/) with the
[Everest](https://github.com/EverestAPI/Everest) mod loader, running on the .NET
WebAssembly runtime and packaged as a wasm-gaming engine SDK.

This subproject follows the same engine-package approach as the other engines:

- typed `manifest`
- typed `options`
- `load(config)` engine SDK surface
- Makefile-driven build (`build-sdk`, `build-wasm`, `preview`)

> **You need your own copy of Celeste.** No part of the game is in this
> repository, in anything it builds, or in anything it publishes. The player
> supplies the installation they already own; it is staged into their browser's
> private filesystem, patched there, and never leaves their machine.

## What is actually built here

Two upstreams, and it is worth being precise about which is which.

**Everest is built from source.** `make build-everest` checks out the pinned
revision of [EverestAPI/Everest](https://github.com/EverestAPI/Everest),
stamps a version onto it the way the upstream pipeline's prebuild step does
(see [scripts/patch-everest-source.mjs](scripts/patch-everest-source.mjs)),
publishes `NETCoreifier`, `Celeste.Mod.mm` and `MiniInstaller`, and packs them
into `dist/celeste/everest.zip` — the same one-directory archive the desktop
installer takes. None of that needs Celeste: Everest compiles against the
stripped, body-less vanilla assemblies upstream keeps in `lib-stripped/`.

**The runtime is pinned, not reimplemented.** Getting Mono, FNA, FMOD and
MonoMod's detour engine to work under WebAssembly at all is
[a year of work](https://velzie.rip/blog/celeste-wasm) by
[MercuryWorkshop](https://github.com/MercuryWorkshop/celeste-wasm) and
[r58Playz](https://github.com/r58Playz/FNA-WASM-Build), and `make build-runtime`
takes their pinned build the way an engine package takes an export template —
by revision, recorded in `dist/celeste/runtime.json`. It can also be built from
source, in a container (`make build-runtime-docker`) or in CI (the
[Runtime (from source)](.github/workflows/runtime-source.yml) workflow); see
[Building the runtime from source](#building-the-runtime-from-source).

What this repository adds on top is the packaging: the engine contract, the
staging path from a player's install into the runtime's filesystem, the install
check, and the build that pins both upstreams together.

## Contract surface

```js
import { manifest, load } from '@wasm-gaming/celeste-wasm';

const engine = await load({
  attachTo: containerEl,             // or canvasEl: someCanvas
  gameDirectory: folderHandle,       // or assets: { game: zipBytes }
  options: { installEverest: true },
  onProgress: (current, total) => { /* files staged */ },
  onSplash: (message, progress) => { /* Everest, loading mods; progress = {loaded,total,mod,done} */ },
  onEvent: (e) => { /* ready | error | exit */ },
});

engine.start();
await engine.purgeStorage();
engine.destroy();
```

### How the game reaches the runtime

The loader mounts the origin private filesystem at `/libsdl` and then works in
native paths: it reads `/libsdl/Celeste.exe`, symlinks `/Content` to
`/libsdl/Content` so FNA finds the assets, and writes the patched game to
`/libsdl/CustomCeleste.dll`. So OPFS *is* the game directory, and staging is the
whole job:

1. **The folder route.** Where `showDirectoryPicker` exists, pass the handle as
   `gameDirectory` and the SDK copies the install across file by file. This is
   the one to prefer — a Celeste install is ~1.3 GB and asking a player to zip
   it first is a poor trade. The copy is resumable: a file already in storage at
   the same size is left alone, so handing the folder over again after an
   interrupted copy finishes the job instead of redoing it.
2. **The archive route.** Otherwise pass a zip as `assets.game`. It is read
   through [src/celeste.zip.ts](src/celeste.zip.ts) — central directory off a
   `Blob`, each entry inflated straight into storage — so the archive is never
   resident in memory.
3. **Neither.** If storage already holds a valid install from a previous
   session, `load()` uses it. That is the common case on a reload.

Ask before you offer, with `stagedInstall()`: it runs the same acceptance check
over what is in storage, so a host can turn its Start button on after a refresh
instead of sending the player back to the folder picker.

```js
import { stagedInstall } from '@wasm-gaming/celeste-wasm';

if ((await stagedInstall()).ok) {
  // Nothing to supply — load() will boot what is already there.
}
```

### What Celeste occupies in OPFS

Depends on the runtime. A **downloaded** one claims the root of it. A runtime
**built from source here** puts everything under one directory
(`options.storageNamespace`, `celeste` by default), which is what lets other
engines share the origin.

The loader mounts the origin private filesystem at `/libsdl` and then reads and
writes absolute paths under it — `/libsdl/Celeste.exe`, `/libsdl/Content`,
`/libsdl/CustomCeleste.dll` and the rest are string literals inside
`CelesteLoader.dll`. Since the mount *is* the origin's root, those literals are
top-level OPFS entries — and being literals, no option can move them. Only
rebuilding the loader can, which is what the source build does below.

Either way the tree is the same shape; a namespace only puts it one segment
deeper. What lands in it falls into two groups.

**This package's own, and a closed set:**

| Entry | What it is |
| --- | --- |
| `Content/` | the game's assets, straight from the player's folder |
| `Celeste.exe` / `Celeste.dll` | whichever executable their install presents |
| `CustomCeleste.dll` | MonoMod's output: the game patched for WebAssembly |
| `MMHOOK_Celeste.dll` | MonoMod's hook assembly |
| `Celeste.Mod.mm.dll` | Everest's loader assembly |
| `everest.zip` | the Everest build, before it is unpacked |
| `Celeste/` | `Everest/`, `Mods/`, `Saves/` and `staged.json` under one directory |

**The player's install, and an open one.** Everything else in the folder they
hand over is copied to the root as-is. A vanilla macOS install is 25 top-level
entries — `FNA.dll`, `FNA3D.dll`, `mscorlib.dll`, nine `System.*.dll`,
`Steamworks.NET.dll`, `gamecontrollerdb.txt`, `vulkan/` and so on — and the exact
set varies by platform, by Steam vs itch, and by whether Everest has already
been run on it. **This set cannot be enumerated in advance**, because it is
whatever the player's Celeste directory contains.

Two consequences worth planning around:

- **On a downloaded runtime, a sibling engine needs a distinctive prefix of its
  own.** Not because the names above are likely to collide — because the open
  set makes "avoid Celeste's names" unverifiable. `snes/` is fine; a bare
  `Content/` or `System.dll` is not. A namespaced runtime removes the problem
  instead of managing it.
- **`purgeStorage()` removes the open set too, without emptying the root.**
  Staging records the top-level names it created in `Celeste/staged.json`, so a
  purge can drop the player's `FNA.dll` and `mscorlib.dll` — which no fixed list
  here could have named — and still leave a sibling engine's directory
  untouched. Mods are kept: they are the player's, they are not part of the
  install, and nothing regenerates them.

  Storage staged before this package kept that record has no manifest and falls
  back to the fixed list, leaving the stray assemblies behind as it always did.
  Re-staging writes a manifest and the next purge is complete.

#### Getting a namespace

`scripts/patch-loader-source.mjs` rewrites those literals during the source
build, so the loader resolves them against a directory it is told about instead
of against the mount. `MountFilesystems` gains a third argument, `load()` passes
`options.storageNamespace`, and everything above moves one segment down:
`celeste/Content`, `celeste/Celeste/Saves`, `celeste/staged.json`.

It is a **pure prefix** of the stock layout rather than a flattening — which is
why nothing else in this package needs a second code path, only a different
string. `LOADER_NAMESPACE=-` builds the stock layout back.

The namespace belongs to the runtime, not to preference: the loader resolves its
own paths, so asking a downloaded runtime for one would stage 1.1 GB where it
will never look. The build records what it produced in `runtime.json` and
`load()` refuses a mismatch before anything moves:

```
celeste: options.storageNamespace is "celeste", but this runtime keeps the game
at the root of the origin private filesystem — the stock loader does not take a
namespace. Set storageNamespace to "", or build a runtime with
LOADER_NAMESPACE=celeste (make build-runtime-docker).
```

A runtime served from somewhere without a `runtime.json` is trusted rather than
refused: a CDN copy of `_framework/` may not carry the file, and failing to boot
over missing metadata would be worse than the mismatch it guards against.

### Taking the saves somewhere else

Storage is per origin and per browser, so a player who switches machines loses
their progress unless the host moves it for them. `exportSaves()` and
`importSaves()` are the substrate for that — a gzipped tar of Celeste's save
directory, streamed in both directions so nothing is ever resident:

```js
import { exportSaves, importSaves } from '@wasm-gaming/celeste-wasm';

// Upload. The stream reads out of storage as the request consumes it.
await upload(await exportSaves());

// Restore. gzip is detected, not declared.
const restored = await importSaves(await download());
```

Three things worth knowing:

- **Paths inside the archive are relative to the save directory** — `0.celeste`,
  not `Celeste/Saves/0.celeste`. Where this package keeps its files may change;
  an archive already in someone's Drive should keep restoring when it does.
- **Import merges.** A save the archive carries replaces the one in storage; a
  save only storage has is left alone. Restoring cannot destroy a file the
  backup never knew about. Call `purgeStorage()` first if the archive should be
  the whole truth.
- **It is tar, not zip**, because a zip cannot be finished until its central
  directory is written at the end — you would have to buffer the archive or seek
  back over it, and a page piping storage into an upload can do neither. The
  format is plain USTAR, and the test suite checks it against the system `tar`
  in both directions rather than only against itself.

### And the install

`exportInstall()` / `importInstall()` are the same idea for the game itself — so
a player who already staged 1.1 GB on one machine does not hand over their
Celeste folder again on the next:

```js
const check = await importInstall(await download(), {
  onProgress: (files, bytes) => report(files, bytes),
});
if (!check.ok) throw new Error(check.reason);
```

Import returns the same acceptance check `load()` runs, so a restore that
produced a directory of files rather than a bootable game says so.

Two differences from the saves:

- **It leaves out what the next boot rebuilds** — `CustomCeleste.dll`,
  `everest.zip`, the unpacked `Celeste/Everest`, and Everest's `orig/` backup of
  files the archive already carries. The player's `Celeste/Mods` *is* included;
  nothing regenerates those. Saves are not, because they move on a different
  cadence — an install goes once, a save goes every session.
- **gzip is off by default**, and that is measured rather than assumed. 634 MB of
  a 1.1 GB install are FMOD banks, which gzip takes about 1% off; the rest gives
  up around 67%, for roughly 29% over the whole archive. Worth `{ gzip: true }`
  on a slow connection, not worth pushing 634 MB through a compressor for
  everyone by default.

The demo wires the save half of this to two header buttons, which is the
shortest way to see it work.

Either way the listing goes through
[`inspectInstall`](src/celeste.install.ts) first: it finds the install root
(players zip the folder about as often as its contents), skips Everest's `orig/`
backup, and checks for the files the game actually reads. A wrong folder is
rejected in milliseconds instead of part-way through a multi-minute patch.

Then `everest.zip` is staged, `Patcher.ExtractEverest()` unpacks it, and
`Patcher.PatchCeleste()` runs MonoMod over the player's assembly. That step
costs minutes and most of the runtime's memory, so its output is cached in
storage — `options.repatch` is what redoes it.

### Options

Everything a host can set is declared once in
[src/celeste.options.ts](src/celeste.options.ts); the manifest's options schema
and the defaults are derived from that catalog.

Celeste is a full game, not a core: it ships its own settings menu and Everest
adds a second one. Video, audio, key bindings, language and every mod toggle
live there, and this package deliberately does not put a third settings overlay
in front of them. What is left is the boot-time surface the browser owns:
`fit`, `renderWidth`/`renderHeight`, `syncResolution`, `installEverest`, `everestSource`,
`everestBranch`, `repatch`, `verifyInstall`, `pixelated`, `focusCanvas`,
`lockKeyboard`, `suspendAudioWhenHidden`, `autoStart`, `jiterpreter`,
`pthreadPoolSize`, `seamlessFrames`, `runtimeBaseUrl`, `extraRuntimeOptions`.

### Sizing: `options.fit`

A canvas has two sizes — the **box** it occupies on the page and the **drawing
buffer** it renders into — and neither of them is the page's to set here.

The drawing buffer is the game's window, and the browser build decides that on
its own. Upstream hooks `Settings.ApplyScreen()` and pins the window to
`WindowScale × 320` by `WindowScale × 180` with fullscreen off, so **every
resolution the game can run at is a whole multiple of the 320×180 gameplay
buffer, and always 16:9**. FNA pushes that size into the canvas through SDL from
inside the render worker, over anything the page wrote there. The canvas is also
**transferred to that worker** at boot, after which the page cannot resize the
buffer at all — and the game never learns of a page resize, because an
`OffscreenCanvas` in a worker raises no resize events and the loader exports no
way in.

So the SDK does the only two things that work:

1. **It picks the resolution before the game reads it.** Just before boot it
   measures the box, works out the largest window scale that fits (times the
   device pixel ratio, capped at 6 — 1920×1080, because the game composes every
   frame into a 1922×1082 target before it ever reaches the window, so a larger
   one only upscales the same picture), and writes that one line into
   `Saves/settings.celeste`, editing the file in place so the player's other
   settings survive. `options.syncResolution: false` turns this off and leaves
   whatever the player chose in Options → Video alone.
2. **It keeps the box fitted.** On window resizes, on container resizes and
   across fullscreen, the canvas is scaled to the largest 16:9 rectangle that
   fits its container and centred there, with the container showing through
   around it. Only for a canvas the SDK created; one supplied through `canvasEl`
   is laid out by whoever supplied it.

What no resize can do is change the resolution mid-run. That takes a reload —
or Celeste's own Options → Video, which the hook honours because it goes through
`ApplyScreen()`.

**`'container'` (default)** — the resolution comes from the element's box, and
the picture is letterboxed inside it. Give the container a size:

```css
#game-root { width: 100vw; height: 100vh; }
```

An unsized container falls back to `renderWidth`×`renderHeight` and warns.

**`'fixed'`** — the resolution is `renderWidth`×`renderHeight` (1920×1080 by
default), rounded to the nearest whole multiple of 320×180, and host CSS scales
the result. The predictable choice for a page whose layout moves.

**`'window'`** — the canvas is `position: fixed` over the viewport, resolution
taken from the viewport. Right for a page that is nothing but the game, wrong
inside a host container.

### Contract notes

Where the contract and a full desktop game do not line up exactly:

| Method | Behaviour |
| --- | --- |
| `start()` | No-op after `load()` unless `options.autoStart` is `false`, which defers the runtime download and the patch to the first call. |
| `pause()` / `resume()` | No-ops with a warning. FNA drives its own loop on the render worker and exposes no handle on it; Escape opens Celeste's pause menu, which is the real pause. |
| `reset()` | **Throws.** There is one .NET runtime per page and the canvas has already been transferred to a worker, so a power cycle means a reload. The contract allows this, and a silent no-op would be worse. |
| `setInput()` | No-op with a warning. The game ships a key-mapping screen and Everest adds its own. |
| `purgeStorage()` | Drops the staged install, the patched assemblies and the Everest build (`data`), and Celeste's save directory (`settings`). Mods are kept. Removes what staging recorded rather than emptying the root, so a sibling engine on the same origin survives — see [What Celeste occupies in OPFS](#what-celeste-occupies-in-opfs). Also exported standalone, for hosts that want it before `load()`. The loader mounts one OPFS root per origin, so this ignores `storageNamespace`. |
| `saveState()` / `loadState()` | Not implemented; `capabilities.saveStates` is `false`. Celeste has its own save files. |
| `load()` twice | Throws. The canvas cannot be transferred twice and the runtime cannot be unloaded. |

## Cross-origin isolation

The runtime is built with threads, so it needs `SharedArrayBuffer`, so the page
must be cross-origin isolated. `load()` checks `crossOriginIsolated` first and
fails with that message rather than somewhere deep in the runtime.

- `make preview` sends `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- `dist/_headers` carries the same two for hosts that read it (Cloudflare Pages,
  Netlify).
- `dist/coi.js` installs a service worker that adds them from inside the browser,
  for hosts that will not — GitHub Pages among them. The demo shell loads it
  before anything else.

## Build

```bash
make build          # runtime + Everest (in Docker) + SDK
make build-sdk      # TS only, on the host
make preview        # serves dist/ with COOP/COEP
make test           # typecheck + node test runner
```

**`make build` runs the native half in Docker, always.** That half wants the
.NET 9 SDK, mono's `ilasm` (MonoMod's IL projects assemble through
`Microsoft.Net.Sdk.IL`, which ships no cross-platform assembler) and mono's `sn`
to strong-name NLua. Nobody should have to install three toolchains to work on a
TypeScript SDK, and missing any of them surfaces minutes into a build as a
linker error that looks like nothing to do with the cause. The TypeScript half
runs on the host and needs only node.

The container bind-mounts the workspace, so `.tmp/` (upstream checkout, NuGet
cache) and `dist/` land on the host and a second run reuses them. The image is
built for the host's own architecture; `PLATFORM=linux/amd64` gets CI's instead.

For a machine that does have the toolchain, the same build without the
container:

```bash
make build-wasm     # runtime + Everest, on the host
make build-runtime  # install the .NET WASM runtime → dist/celeste/_framework/
make build-everest  # compile the pinned Everest → dist/celeste/everest.zip
```

### Building the runtime from source

`make build-runtime` downloads the pinned prebuilt bundle. To build it instead:

```bash
make build-runtime-docker
```

You want this when you are **changing the loader**. The game's paths in storage
are string literals inside `CelesteLoader.dll` — `/libsdl/Celeste.exe`,
`/libsdl/Content` and the rest — so moving them, to namespace this engine's OPFS
entries for instance, means rebuilding it.

Swapping a recompiled assembly into the prebuilt bundle is not a shortcut: the
boot manifest inside `dotnet.js` names it by content hash, and the same assembly
is AOT compiled into the native binary (`<RunAOTCompilation>true`). From source,
the assembly, its AOT code and the manifest are regenerated together and neither
problem exists.

It gets its own container rather than sharing the Everest one. Everest targets
net8.0 and needs mono's `ilasm`; the loader targets **net10.0** and links through
Emscripten. Keeping them apart means neither toolchain can move under the other.
Note that upstream's README asks for .NET 9.0.4 — that is stale against the
pinned revision, whose `loader.csproj` says `net10.0`.

Less exotic than its reputation, incidentally: emsdk and the .NET runtime pack
are not compiled: upstream downloads both, already patched, from an
[FNA-WASM-Build](https://github.com/r58Playz/FNA-WASM-Build) release into
`statics/`, and the loader's csproj points `EmsdkRoot` there. The container just
supplies dotnet 10, the `wasm-tools` workload, pnpm and mono.

The first run is long — it clones FNA, MonoMod, NLua and SteamKit2.WASM,
downloads a runtime pack and an emsdk, then AOT compiles and links a ~100 MB
wasm binary. All of it caches under `.tmp/`, so later runs reuse it. Point it at
a fork with `RUNTIME_REPO` / `RUNTIME_REV`.

**On Apple Silicon it runs emulated**, and the image carries two workarounds for
that. Both are recorded here because each one failed hundreds of lines into an
otherwise healthy build:

- The emsdk in `statics/emsdk.zip` is a prebuilt x86-64 toolchain with no arm64
  build in the release, so an arm64 container dies invoking its clang
  (`rosetta error: failed to open elf at /lib64/ld-linux-x86-64.so.2`). The
  platform is pinned to `linux/amd64`.
- Under that emulation mono's JIT asserts — it assumes JIT-emitted code sits
  within a 32-bit displacement of the runtime, and the emulated address space
  does not oblige — surfacing as `sn` exiting 134 while NLua is strong-named.
  `sn` and `ilasm` are wrapped to run through mono's interpreter. **Scoped to
  those two**: `MONO_ENV_OPTIONS` is read by *every* mono runtime including the
  AOT cross-compiler, which aborts on `--interp` and fails identically, later.

Measured at **31 minutes** on an M-series Mac with the toolchains already
cached. Native x86-64 is considerably faster.

**Or skip the local build entirely.** `.github/workflows/runtime-source.yml`
runs it on `ubuntu-latest`, which is native x86-64 — no emulation and none of
the above. `workflow_dispatch` only; it takes `repository` and `revision` inputs
so you can point it at a fork, and uploads `_framework/` as an artifact with a
week's retention.

### Testing against a real install

Most of the test suite works from listings it writes itself, which only proves
the code agrees with the tests. Symlink a Celeste install in and a few of them
run against the real thing instead — the acceptance check, and the depth cap
`stagedInstall()` walks with:

```bash
ln -s /path/to/Celeste .tmp/Celeste-game
```

They skip when it is not there, so this is optional. Nothing is copied and
nothing is written to it.

Everest pulls MonoMod, NLua and `lib-ext` in as **submodules**, and
`Celeste.Mod.mm` and `NETCoreifier` reference them by project path. The build
script initialises them — worth knowing because `dotnet restore` reports a
missing `ProjectReference` as a *skipped project* and still exits 0, so the
failure surfaces hundreds of lines later as `MonoModLinkFrom could not be
found`. The script checks for them up front instead.

`make build-runtime` needs `curl` and `zstd`, and caches the ~43 MB bundle under
`.tmp/runtime/`. `make clean-all` throws the caches away.

Pins live at the top of the [Makefile](Makefile) and can be overridden:

```bash
make build-everest UPSTREAM_REF=dev EVEREST_BUILD=1234
make build-runtime RUNTIME_SOURCE=1
```

Every runtime install is checked by
[scripts/verify-runtime.mjs](scripts/verify-runtime.mjs), which asserts the four
modifications the SDK is written against — the transferred canvas, the proxied
`EM_ASM`, the raised jiterpreter table limit, and the split wasm binary. A
runtime without them fails in ways that look like SDK bugs, so it fails at build
time instead.

That script also applies two modifications of its own, which upstream does not
make.

The first is how the SDK knows the game has quit. FNA never returns from
`Game.Run()` here: on Emscripten it hands the loop to
`emscripten_set_main_loop(cb, 0, 1)`, and that third argument makes the glue
`throw "unwind"` and discard the C stack, so nothing after that call runs —
including the completion of `CelesteLoader.MainLoop()`, the promise upstream's
frontend and this SDK both await to learn that the game is over. Quitting
therefore left the last (black) frame on the canvas with the music still
playing and the page none the wiser. What the game *does* do on the way out is
call `emscripten_cancel_main_loop()`, so that is wrapped to announce itself on a
`BroadcastChannel` — the loop runs on the deputy worker, which shares no scope
with the page — and the SDK turns the announcement into the contract's `exit`
event.

The second routes SDL's three emscripten joystick helpers away from
`navigator.getGamepads()`. They are `EM_JS`, so they run on the thread that
called them — the worker FNA's loop lives on, where the Gamepad API does not
exist — and they threw inside SDL's `gamepadconnected` handler before it could
add the pad, so no controller ever reached the game. Every other gamepad call in
the driver is already proxied to the main thread, and the pad's `id` is a field
of the event those calls fill in, so off the window the helpers read it back out
of that instead.

### dist/ layout

```
dist/
  celeste/
    _framework/          the .NET WASM runtime + loader assemblies (~250 MB)
    everest.zip          the mod loader, built from the pinned Everest
    everest.json         what was built, and from where
    runtime.json         which runtime revision was installed
    celeste.sdk.js       the compiled SDK, next to the runtime it loads
  demo/                  the shared template, copied from @wasm-gaming/engine-specs
  index.html             the page shell that wires that template to this SDK
  theme.celeste.css      the mountain skin
  demo.js                compiled from src/demo/demo.ts
  coi.js                 cross-origin isolation service worker
  _headers               the same isolation headers, for hosts that read them
  manifest.json
```

Unlike the other engine packages, the upstream shell is not snapshotted here.
The loader bundle's own `index.html` is a Vite build that resolves `_framework`
from its page path, pulls in assets from outside that directory, and loads a
third-party analytics beacon — none of which belongs in an artifact this
repository publishes. Run the upstream site if you want the upstream UI.

## npm

Only the SDK is published. The runtime is a quarter of a gigabyte and carries
several third-party licences; the Everest build is a compiled form of an
upstream project. Both belong on a GitHub Release rather than in a package
tarball — point the SDK at them with `options.runtimeBaseUrl`.

## Licensing

- This packaging code (`src/`, `scripts/`, `tests/`) is MIT — see [LICENSE](LICENSE).
- **Celeste is a commercial game and is not distributed here in any form.** It
  is supplied by the player, at runtime, from a copy they own.
- Everest is MIT. `dist/celeste/everest.zip` is a build of it and stays MIT.
- The runtime in `dist/celeste/_framework/` links .NET (MIT), FNA (Ms-PL),
  FNA3D/FAudio/SDL3 (zlib), MonoMod (MIT) and **FMOD**, which is proprietary and
  redistributable only under FMOD's own licence terms.

Read [NOTICE.md](NOTICE.md) before you publish any of it.

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
by revision, recorded in `dist/celeste/runtime.json`. `RUNTIME_SOURCE=1` builds
it from source instead, which needs a patched emsdk, a patched .NET runtime pack
and about an hour.

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
   it first is a poor trade.
2. **The archive route.** Otherwise pass a zip as `assets.game`. It is read
   through [src/celeste.zip.ts](src/celeste.zip.ts) — central directory off a
   `Blob`, each entry inflated straight into storage — so the archive is never
   resident in memory.
3. **Neither.** If storage already holds a valid install from a previous
   session, `load()` uses it. That is the common case on a reload.

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
| `purgeStorage()` | Drops the staged install, the patched assembly and the Everest build (`data`), and Celeste's save directory (`settings`). The loader mounts one OPFS root per origin, so this ignores `storageNamespace`. |
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
make build          # runtime + Everest + SDK
make build-sdk      # TS only
make build-runtime  # install the .NET WASM runtime → dist/celeste/_framework/
make build-everest  # compile the pinned Everest → dist/celeste/everest.zip
make preview        # serves dist/ with COOP/COEP
make test           # typecheck + node test runner
```

`make build-everest` needs the .NET 9 SDK and, on Linux and macOS, mono for
`ilasm` — MonoMod's IL projects assemble through `Microsoft.Net.Sdk.IL`, which
has no cross-platform assembler of its own. If you would rather not install
either:

```bash
make build-everest-docker   # just Everest, in a container that has both
make build-wasm-docker      # runtime + Everest, same container
```

Both bind-mount the workspace, so `.tmp/` (upstream checkout, NuGet cache) and
`dist/` land on the host and a second run reuses them. The image is built for
the host's own architecture; `PLATFORM=linux/amd64` gets CI's instead.

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

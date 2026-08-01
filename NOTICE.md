# Notices

## Celeste is not here

**Celeste** is a commercial game by Maddy Makes Games Inc. Nothing in this
repository, in anything it builds, or in anything it publishes contains any part
of it — no executable, no `Content/`, no assets, no save data.

The player supplies their own installation at runtime. It is staged into the
origin private filesystem *of their own browser*, patched there by MonoMod, and
read from there by the runtime. It is never uploaded anywhere: the SDK writes it
into local storage the browser already gives the page, and there is no code path
in this package that sends it over the network.

Do not commit game files to this repository. `.gitignore` refuses the obvious
names, but that is a safety net, not permission. If you host a build of this,
host it without the game, exactly as this repository does.

Maddy Makes Games is not affiliated with, and has not endorsed, this project.

## This repository's own code

`src/`, `scripts/`, `tests/`, the Makefile and the configuration around them are
MIT licensed. See [LICENSE](LICENSE).

## Everest

[Everest](https://github.com/EverestAPI/Everest) is the Celeste mod loader and
base API, **MIT licensed**, © Everest Team. None of it is vendored here:
`make build-everest` checks out a pinned upstream revision at build time.

`dist/celeste/everest.zip` is a compiled form of that source and stays MIT. If
you distribute it, keep the licence and the attribution with it. The exact
revision and the build number stamped into it are recorded next to it in
`dist/celeste/everest.json`.

Everest is created and maintained by volunteers. If you package this for anyone
else, keep the credit intact — and the desktop builds it was designed for are
worth using.

## The WebAssembly runtime

`dist/celeste/_framework/` is **not built from this repository's sources**. It is
a pinned build of the loader from
[MercuryWorkshop/celeste-wasm](https://github.com/MercuryWorkshop/celeste-wasm)
("Webleste"), by velzie, r58Playz and contributors, whose write-up of the work is
at <https://velzie.rip/blog/celeste-wasm>. The exact release and revision are
recorded in `dist/celeste/runtime.json`.

That directory links together, at minimum:

| Component | Licence |
| --- | --- |
| [.NET](https://github.com/dotnet/runtime) runtime (Mono, the jiterpreter, the BCL) | MIT |
| [FNA](https://github.com/FNA-XNA/FNA) | Ms-PL |
| [FNA3D](https://github.com/FNA-XNA/FNA3D), [FAudio](https://github.com/FNA-XNA/FAudio), [MojoShader](https://github.com/icculus/mojoshader) | zlib |
| [SDL3](https://github.com/libsdl-org/SDL) | zlib |
| [MonoMod](https://github.com/MonoMod/MonoMod), [Mono.Cecil](https://github.com/jbevain/cecil) | MIT |
| [NLua](https://github.com/EverestAPI/NLua) / KeraLua / Lua | MIT |
| **FMOD Studio** | **proprietary — FMOD's own licence** |

**FMOD is the one to read before you publish.** Celeste's audio is FMOD, the
runtime links FMOD's libraries, and FMOD is redistributable only under the terms
of a licence granted by Firelight Technologies — which, among other things,
requires attribution in the product. Those terms are at
<https://www.fmod.com/licensing>. Hosting this yourself means satisfying them
yourself; nothing about this repository grants you anything.

The upstream loader repository publishes no licence file of its own. If you plan
to redistribute `_framework/`, ask its authors first.

## Summary, if you are about to host this

- Ship the SDK: MIT, no conditions beyond the notice.
- Ship `everest.zip`: MIT, keep the notice and the attribution.
- Ship `_framework/`: several licences at once, one of them proprietary. Read
  the table above, satisfy FMOD's terms, and check with the loader's authors.
- Ship the game: **no.**

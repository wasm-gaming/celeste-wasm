#!/usr/bin/env bash
set -euo pipefail

# Build the .NET WebAssembly runtime from source, inside a pinned Linux
# container → dist/celeste/_framework/
#
#   scripts/build-runtime-docker.sh
#
# The default `make build-runtime` downloads the pinned prebuilt bundle, which
# is what almost everyone wants. This is the other path: it clones
# MercuryWorkshop/celeste-wasm, builds the loader against a patched emsdk and a
# patched .NET runtime pack, and installs the result the same way.
#
# You need this when you are changing the loader itself — the game's paths in
# storage are string literals inside CelesteLoader.dll, so moving them (to
# namespace this engine's OPFS entries, say) means rebuilding it. Swapping the
# assembly into the prebuilt bundle is not an alternative: the boot manifest
# inside dotnet.js names it by content hash, and the same assembly is AOT
# compiled into the native binary. From source, all three are regenerated
# together and the question does not arise.
#
# The workspace is bind-mounted, so the upstream checkout, the downloaded
# statics and the NuGet/pnpm caches land under .tmp/ on the host and survive
# between runs. The first build is long — it downloads a runtime pack and an
# emsdk, then AOT compiles and links a ~100 MB wasm binary. Later ones reuse all
# of that.
#
# ---------------------------------------------------------------------------
# THIS NEEDS AN x86-64 HOST. It does not complete on Apple Silicon, and the
# reason is a vice rather than a bug:
#
#   * The emsdk in `statics/emsdk.zip` is a prebuilt x86-64 Linux toolchain, and
#     the release has no arm64 build of it. In an arm64 container the build runs
#     healthily for minutes and then dies invoking its clang:
#       rosetta error: failed to open elf at /lib64/ld-linux-x86-64.so.2
#       emcc: error: '.../statics/emsdk/bin/clang --version' failed (returned 133)
#
#   * So the platform is pinned to linux/amd64 below — and under that emulation
#     *mono* is what breaks. NLua strong-names its assembly with mono's `sn`,
#     which SIGABRTs:
#       Got a SIGABRT while executing native code ... fatal error in the mono runtime
#       error MSB3073: The command "sn -q -R obj/Release/net6.0/NLua.dll ..." exited with code 134
#
# Squeezed from both ends: the toolchain that has to be emulated and the one
# that cannot survive emulation are in the same build. Run this on an x86-64
# machine, or in CI — `ubuntu-latest` is amd64 and does it natively.
#
#   PLATFORM=linux/arm64   override, if upstream ever ships an arm64 emsdk
#   RUNTIME_REV=<sha>      build a revision other than the pinned one
#   RUNTIME_REPO=<url>     build your own fork

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${RUNTIME_IMAGE:-celeste-wasm-runtime-builder}"
DOCKERFILE="${PROJECT_DIR}/scripts/celeste-runtime-builder.Dockerfile"
PLATFORM="${PLATFORM:-linux/amd64}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

platform_args=(--platform "$PLATFORM")

echo "[celeste] building ${IMAGE} for ${PLATFORM}"
docker build "${platform_args[@]}" -f "$DOCKERFILE" -t "$IMAGE" "${PROJECT_DIR}/scripts"

echo "[celeste] running 'make build-runtime' (from source) inside ${IMAGE}"
docker run --rm \
  "${platform_args[@]}" \
  -v "${PROJECT_DIR}:/workspace" \
  -e RUNTIME_REPO \
  -e RUNTIME_REF \
  -e RUNTIME_REV \
  -e RUNTIME_SOURCE=1 \
  "$IMAGE" build-runtime

echo "[celeste] artifacts available in ${PROJECT_DIR}/dist/celeste/_framework"

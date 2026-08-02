#!/usr/bin/env bash
set -euo pipefail

# Put the .NET WebAssembly runtime in place → dist/celeste/_framework/
#
# This is the piece that makes Celeste run in a browser at all: Mono compiled to
# wasm with threads and SIMD, FNA/FNA3D/SDL3/FMOD linked in as static archives,
# MonoMod.WASM for the runtime detours Everest needs, and the loader assemblies
# that patch and drive the game. It is the analogue of an engine's export
# template — a toolchain artifact, pinned by revision, not something this repo
# reimplements.
#
# By default the pinned prebuilt bundle is downloaded, which is what almost
# everyone wants. RUNTIME_SOURCE=1 builds it instead.
#
# That source build is less exotic than its reputation: emsdk and the .NET
# runtime pack are not compiled here, they are downloaded already patched from
# an FNA-WASM-Build release into the checkout's `statics/`, and the loader's
# csproj points `EmsdkRoot` at that directory. What it does need is dotnet 10
# (the loader targets net10.0), the wasm-tools workload, pnpm and mono — which
# is what `make build-runtime-docker` supplies. Running it on the host means
# installing all four.
#
# Env knobs (all optional):
#   RUNTIME_REPO     Loader repository
#   RUNTIME_REF      Release tag to download        (default: latest)
#   RUNTIME_REV      Commit the release was cut at  (recorded for provenance)
#   RUNTIME_SOURCE   Set to 1 to build from source instead of downloading

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="${PROJECT_DIR}/.tmp"
CACHE_DIR="${TMP_DIR}/runtime"
SRC_DIR="${TMP_DIR}/celeste-loader-src"
DIST_DIR="${PROJECT_DIR}/dist/celeste"

RUNTIME_REPO="${RUNTIME_REPO:-https://github.com/MercuryWorkshop/celeste-wasm}"
RUNTIME_REF="${RUNTIME_REF:-latest}"
RUNTIME_REV="${RUNTIME_REV:-}"
RUNTIME_SOURCE="${RUNTIME_SOURCE:-0}"

BUNDLE_NAME="webleste-loader.tar.zst"
BUNDLE_URL="${RUNTIME_REPO}/releases/download/${RUNTIME_REF}/${BUNDLE_NAME}"

log() { printf '[celeste/runtime] %s\n' "$*"; }
die() { printf '[celeste/runtime] error: %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null || die "$1 is required"; }

# ----------------------------------------------------------------- download --

extract_bundle() {
  local archive="$1" into="$2"
  mkdir -p "$into"
  if tar --help 2>&1 | grep -q -- '--use-compress-program'; then
    tar --use-compress-program=unzstd -xf "$archive" -C "$into"
  else
    zstd -dc "$archive" | tar -xf - -C "$into"
  fi
}

fetch_runtime() {
  need curl
  need zstd

  mkdir -p "$CACHE_DIR"
  local archive="${CACHE_DIR}/${RUNTIME_REF}-${BUNDLE_NAME}"
  local unpacked="${CACHE_DIR}/${RUNTIME_REF}"

  if [[ ! -s "$archive" ]]; then
    log "downloading ${BUNDLE_URL}"
    curl -fL --retry 3 --retry-delay 2 -o "${archive}.part" "$BUNDLE_URL"
    mv "${archive}.part" "$archive"
  fi

  if [[ ! -d "${unpacked}/_framework" ]]; then
    log "extracting ${BUNDLE_NAME}"
    rm -rf "$unpacked"
    extract_bundle "$archive" "$unpacked"
  fi

  [[ -d "${unpacked}/_framework" ]] || die "no _framework/ inside ${BUNDLE_NAME}"
  RUNTIME_BUILD_DIR="$unpacked"
}

# ------------------------------------------------------------------- source --

build_runtime() {
  need git
  need dotnet
  need make

  if [[ ! -d "${SRC_DIR}/.git" ]]; then
    log "cloning ${RUNTIME_REPO}"
    git clone --recursive "$RUNTIME_REPO" "$SRC_DIR"
  fi

  # --force always, not only when a revision is pinned: the patch below rewrites
  # tracked files, and a second run has to start from a clean tree or its anchors
  # are already gone.
  if [[ -n "$RUNTIME_REV" ]]; then
    log "checking out ${RUNTIME_REV}"
    git -C "$SRC_DIR" fetch origin
    git -C "$SRC_DIR" checkout --quiet --force --detach "$RUNTIME_REV"
  else
    log "resetting the checkout"
    git -C "$SRC_DIR" checkout --quiet --force HEAD
  fi
  git -C "$SRC_DIR" clean -qfd -- loader patcher

  log "namespacing storage under ${LOADER_NAMESPACE:-celeste}/"
  node "${PROJECT_DIR}/scripts/patch-loader-source.mjs" "$SRC_DIR"

  log "building the loader (~30 min emulated on arm64, less on x86-64; longer on a cold cache)"
  (cd "${SRC_DIR}/loader" && dotnet workload restore)
  make -C "$SRC_DIR" publish

  [[ -d "${SRC_DIR}/frontend/dist/_framework" ]] || die "the loader build produced no _framework/"
  RUNTIME_BUILD_DIR="${SRC_DIR}/frontend/dist"
}

# -------------------------------------------------------------------- install --

main() {
  need node

  if [[ "$RUNTIME_SOURCE" == "1" ]]; then
    build_runtime
  else
    fetch_runtime
  fi

  log "installing runtime → dist/celeste/_framework"
  mkdir -p "$DIST_DIR"
  rm -rf "${DIST_DIR}/_framework"
  cp -R "${RUNTIME_BUILD_DIR}/_framework" "${DIST_DIR}/_framework"

  # The upstream bundle's own index.html is deliberately *not* snapshotted the
  # way the other engine packages keep their stock shell. It is a Vite build
  # that resolves `_framework` from its own page path and pulls in assets from
  # outside this directory, so it would only work as a byte-for-byte copy of the
  # whole bundle — and it loads a third-party analytics beacon, which has no
  # business in an artifact this repository publishes. Run the upstream site if
  # you want the upstream UI.

  # Record what actually went in. The runtime carries several third-party
  # licences (see NOTICE.md) and "which build is this" has to be answerable
  # from the artifact alone.
  node -e '
    const fs = require("fs");
    const [dest, repo, ref, rev, source, ns] = process.argv.slice(1);
    fs.writeFileSync(dest, JSON.stringify({
      repository: repo, ref, revision: rev || null,
      builtFromSource: source === "1",
      storageNamespace: source === "1" ? (ns || null) : null,
      installedAt: new Date().toISOString(),
    }, null, 2) + "\n");
  ' "${DIST_DIR}/runtime.json" "$RUNTIME_REPO" "$RUNTIME_REF" "$RUNTIME_REV" "$RUNTIME_SOURCE" "${LOADER_NAMESPACE:-}"

  node "${PROJECT_DIR}/scripts/verify-runtime.mjs" "${DIST_DIR}/_framework"

  log "runtime artifacts:"
  du -sh "${DIST_DIR}/_framework"
}

main "$@"

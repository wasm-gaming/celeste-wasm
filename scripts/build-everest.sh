#!/usr/bin/env bash
set -euo pipefail

# Build the Everest mod loader → dist/celeste/everest.zip
#
#   1. check out the pinned upstream revision into .tmp/everest-src
#   2. stamp the version the way the upstream pipeline's prebuild step does
#   3. publish NETCoreifier, Celeste.Mod.mm and MiniInstaller
#   4. pack them into the same one-directory zip the desktop installer takes,
#      which is what `Patcher.ExtractEverest()` unpacks in the browser
#
# Nothing about Celeste is needed for this: Everest compiles against the
# stripped, body-less vanilla assemblies in the upstream repo's lib-stripped/,
# which is exactly why the mod loader can be built by anyone and the game
# cannot.
#
# Env knobs (all optional):
#   UPSTREAM_REPO   Everest repository
#   UPSTREAM_REF    Commit/tag/branch to build
#   EVEREST_BUILD   Build number stamped into the version string

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="${PROJECT_DIR}/.tmp"
SRC_DIR="${TMP_DIR}/everest-src"
STAGE_DIR="${TMP_DIR}/everest-stage"
DIST_DIR="${PROJECT_DIR}/dist/celeste"

UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/EverestAPI/Everest.git}"
UPSTREAM_REF="${UPSTREAM_REF:-a756f4710f81dd30e41469a950fd245451dd55d9}"
EVEREST_BUILD="${EVEREST_BUILD:-0}"

# Must match TargetFramework in the upstream csprojs.
RUNTIME_VERSION="net8.0"
PROJECTS=(NETCoreifier Celeste.Mod.mm MiniInstaller)

log() { printf '[celeste/everest] %s\n' "$*"; }
die() { printf '[celeste/everest] error: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "node is required"
command -v dotnet >/dev/null || die "the .NET SDK is required (9.x; MonoMod needs net9.0 to build)"

# MonoMod's IL projects assemble through the Microsoft.Net.Sdk.IL SDK, which
# shells out to ilasm; on Linux and macOS that comes from mono.
command -v ilasm >/dev/null || command -v mono >/dev/null || \
  log "warning: neither mono nor ilasm is on PATH. If the build fails in an IL project, install mono-devel."

# ----------------------------------------------------------------- upstream --

sync_upstream() {
  mkdir -p "$SRC_DIR"
  if [[ ! -d "${SRC_DIR}/.git" ]]; then
    log "initializing upstream repo at ${SRC_DIR}"
    git -C "$SRC_DIR" init --quiet
    git -C "$SRC_DIR" remote add origin "$UPSTREAM_REPO" 2>/dev/null \
      || git -C "$SRC_DIR" remote set-url origin "$UPSTREAM_REPO"
  fi

  log "checking out ${UPSTREAM_REF}"
  git -C "$SRC_DIR" fetch --filter=blob:none origin "$UPSTREAM_REF" 2>/dev/null \
    || git -C "$SRC_DIR" fetch --filter=blob:none origin
  git -C "$SRC_DIR" checkout --quiet --force --detach "$UPSTREAM_REF"

  # Drop the previous run's stamping so the patch script always starts from
  # pristine upstream sources; keep bin/obj, which is the build cache.
  git -C "$SRC_DIR" checkout --quiet -- .
  git -C "$SRC_DIR" clean --quiet -fd -e bin -e obj

  # MonoMod and NLua are submodules, and Celeste.Mod.mm/NETCoreifier reference
  # them by project path rather than by package. Without them the restore
  # silently *skips* those references and the build fails much later with a few
  # hundred "MonoModLinkFrom could not be found" errors, which is a long way
  # from the actual problem.
  log "updating submodules"
  git -C "$SRC_DIR" submodule update --init --recursive

  # `dotnet restore` reports a missing ProjectReference as a skipped project and
  # still exits 0, so the only place this can be caught early is here.
  [[ -f "${SRC_DIR}/external/MonoMod/src/MonoMod.Patcher/MonoMod.Patcher.csproj" ]] \
    || die "external/MonoMod is empty — the submodule checkout did not take"
}

# -------------------------------------------------------------------- build --

publish_projects() {
  log "restoring"
  dotnet restore "${SRC_DIR}/Everest.sln" >"${TMP_DIR}/everest-restore.log" 2>&1 \
    || { tail -40 "${TMP_DIR}/everest-restore.log" >&2; die "restore failed (${TMP_DIR}/everest-restore.log)"; }

  for project in "${PROJECTS[@]}"; do
    log "publishing ${project}"
    dotnet publish "${SRC_DIR}/${project}/${project}.csproj" \
      --configuration Release --no-restore \
      >"${TMP_DIR}/everest-${project}.log" 2>&1 \
      || { tail -40 "${TMP_DIR}/everest-${project}.log" >&2; die "${project} failed (${TMP_DIR}/everest-${project}.log)"; }
  done
}

# --------------------------------------------------------------------- pack --

pack() {
  rm -rf "$STAGE_DIR"
  mkdir -p "${STAGE_DIR}/main"

  for project in "${PROJECTS[@]}"; do
    local publish="${SRC_DIR}/${project}/bin/Release/${RUNTIME_VERSION}/publish"
    [[ -d "$publish" ]] || die "${project} produced no publish output at ${publish}"
    cp -R "${publish}/." "${STAGE_DIR}/main/"
  done

  [[ -f "${STAGE_DIR}/main/Celeste.Mod.mm.dll" ]] || die "no Celeste.Mod.mm.dll in the packed output"
  [[ -f "${STAGE_DIR}/main/MiniInstaller.dll" ]] || die "no MiniInstaller.dll in the packed output"

  mkdir -p "$DIST_DIR"
  rm -f "${DIST_DIR}/everest.zip"

  # One top-level directory, because the browser patcher strips the first path
  # segment off every entry — the same shape the official artifact has.
  (cd "$STAGE_DIR" && zip -qr "${DIST_DIR}/everest.zip" main)

  # The demo shell's favicon. Emitted beside the zip rather than committed to
  # src/demo, so it stays what NOTICE.md says every piece of Everest here is:
  # taken from the pinned checkout at build time, never vendored. MIT, © Everest
  # Team — the same terms as everest.zip, and it travels with it.
  cp "${STAGE_DIR}/main/Celeste-icon.png" "${DIST_DIR}/celeste-icon.png"

  node -e '
    const fs = require("fs");
    const [dest, repo, ref, build] = process.argv.slice(1);
    fs.writeFileSync(dest, JSON.stringify({
      repository: repo, ref, build: Number(build),
      builtAt: new Date().toISOString(),
    }, null, 2) + "\n");
  ' "${DIST_DIR}/everest.json" "$UPSTREAM_REPO" "$UPSTREAM_REF" "$EVEREST_BUILD"
}

main() {
  command -v zip >/dev/null || die "zip is required"

  sync_upstream

  log "stamping version 1.${EVEREST_BUILD}.0"
  node "${PROJECT_DIR}/scripts/patch-everest-source.mjs" "$SRC_DIR"

  publish_projects
  pack

  log "everest build:"
  ls -la "${DIST_DIR}/everest.zip"
}

main "$@"

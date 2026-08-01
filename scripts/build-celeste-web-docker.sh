#!/usr/bin/env bash
set -euo pipefail

# Run a build target inside a pinned Linux container.
#
#   scripts/build-celeste-web-docker.sh [target]     (default: build-wasm)
#
# `make build-everest` needs the .NET 9 SDK and mono's ilasm, which is a lot to
# ask of a laptop; this wrapper supplies both. It produces the same
# dist/celeste/ from the same scripts, only on Ubuntu.
#
# The workspace is bind-mounted, so .tmp/ (runtime bundle + upstream checkout)
# and dist/ are shared with the host and survive between runs.
#
# The image is built for the host's own architecture by default, because
# emulating amd64 turns a five-minute .NET build into a forty-minute one. Set
# PLATFORM=linux/amd64 for byte-for-byte parity with CI.

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-celeste-wasm-builder}"
DOCKERFILE="${PROJECT_DIR}/scripts/celeste-builder.Dockerfile"
TARGET="${1:-build-wasm}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

# An empty array is "unbound" under `set -u` in bash 3.2, which is what macOS
# still ships, so every expansion of it needs the +alternate form.
platform_args=()
if [[ -n "${PLATFORM:-}" ]]; then
  platform_args=(--platform "$PLATFORM")
fi

echo "[celeste] building ${IMAGE}"
docker build ${platform_args[@]+"${platform_args[@]}"} -f "$DOCKERFILE" -t "$IMAGE" "${PROJECT_DIR}/scripts"

echo "[celeste] running 'make ${TARGET}' inside ${IMAGE}"
docker run --rm \
  ${platform_args[@]+"${platform_args[@]}"} \
  -v "${PROJECT_DIR}:/workspace" \
  -e UPSTREAM_REPO \
  -e UPSTREAM_REF \
  -e EVEREST_BUILD \
  -e RUNTIME_REPO \
  -e RUNTIME_REF \
  -e RUNTIME_REV \
  -e RUNTIME_SOURCE \
  "$IMAGE" "$TARGET"

echo "[celeste] artifacts available in ${PROJECT_DIR}/dist/celeste"

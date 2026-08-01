#!/usr/bin/env bash
set -euo pipefail

# Build Everest inside the pinned Linux container → dist/celeste/everest.zip
#
# `make build-everest` runs on the host and wants two things that are awkward to
# have lying around: the .NET 9 SDK, and mono for ilasm (MonoMod's IL projects
# assemble through Microsoft.Net.Sdk.IL, which has no cross-platform assembler).
# This is the same build with both supplied.
#
# The workspace is bind-mounted, so the upstream checkout, the NuGet cache and
# dist/ all land on the host and survive between runs — a second build reuses
# them and takes a fraction of the time.
#
#   PLATFORM=linux/amd64  build for CI's architecture instead of the host's
#   UPSTREAM_REF=dev      track a different Everest revision
#   EVEREST_BUILD=1234    build number stamped into the version string

exec bash "$(dirname "${BASH_SOURCE[0]}")/build-celeste-web-docker.sh" build-everest

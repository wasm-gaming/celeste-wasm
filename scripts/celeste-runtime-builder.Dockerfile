# Linux image for building the .NET WebAssembly runtime from source.
#
# Separate from celeste-builder.Dockerfile on purpose. That one builds Everest,
# which targets net8.0 and needs mono's ilasm; this one builds the loader, which
# targets net10.0 and links a wasm binary through Emscripten. Keeping them apart
# means neither build's toolchain can move under the other.
#
# What the upstream build actually needs is smaller than its reputation. emsdk
# and the .NET runtime pack are *not* compiled here: upstream downloads both,
# already patched, from an FNA-WASM-Build release into `statics/`, and the
# loader's csproj points `EmsdkRoot` at that directory. So this image only has
# to supply the tools its Makefile shells out to:
#
#   dotnet 10   the loader targets net10.0, and publishes with RunAOTCompilation
#   pnpm        the frontend is a Vite app, and `make publish` runs `pnpm build`
#   wget        how `make deps` fetches the statics
#   mono-devel  as upstream's README asks for
#   git         the deps target clones FNA, MonoMod, NLua and SteamKit2.WASM
#
# The wasm-tools workload is installed at image build time rather than by the
# build script, so a rerun does not re-resolve it.

FROM mcr.microsoft.com/dotnet/sdk:10.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      make \
      mono-devel \
      nodejs \
      npm \
      python3 \
      unzip \
      wget \
      zip \
      zstd \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10 \
    && npm cache clean --force

WORKDIR /workspace

# Keep the SDK's first-run chatter and telemetry out of the build logs, and both
# package caches inside the bind-mounted workspace so a rerun does not
# re-download them.
ENV DOTNET_NOLOGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    NUGET_PACKAGES=/workspace/.tmp/nuget \
    PNPM_HOME=/workspace/.tmp/pnpm \
    RUNTIME_SOURCE=1

# Mono's JIT cannot run in this image on an Apple Silicon host. The image is
# amd64 — the emsdk in upstream's statics is x86-64 only, so it has to be — and
# under that emulation the address space puts JIT-emitted code more than 2 GB
# from the runtime it calls into. Mono assumes that gap fits in the 32-bit
# displacement of an x86-64 instruction and asserts when it does not:
#
#   Assertion at mono/arch/amd64/../x86/x86-codegen.h:410,
#   condition `offset == (gint32)offset' not met
#
# …surfacing as `sn` exiting 134 while NLua is being strong-named. Mono's
# interpreter emits no machine code, so the assertion cannot fire, and the two
# tools that need it — strong-naming an assembly, assembling MonoMod's IL
# projects — are short enough not to mind the speed.
#
# Scoped to those two rather than set as MONO_ENV_OPTIONS in the environment,
# because that variable is read by *every* mono runtime, including the AOT
# cross-compiler in the .NET pack — and `--interp` makes no sense to an AOT
# compiler, which aborts on it. That failure looks identical (exit 134) and
# lands hundreds of lines further into the build.
#
# On an x86-64 host none of this matters; the wrappers cost a fork each.
RUN for tool in sn ilasm; do \
      printf '#!/bin/sh\nMONO_ENV_OPTIONS=--interp exec /usr/bin/%s "$@"\n' "$tool" \
        > "/usr/local/bin/$tool" && chmod +x "/usr/local/bin/$tool"; \
    done

# `Microsoft.NET.Sdk.WebAssembly` needs this to link native wasm at all, and
# resolving it is slow enough to be worth baking in.
RUN dotnet workload install wasm-tools --skip-sign-check

ENTRYPOINT ["make"]
CMD ["build-runtime"]

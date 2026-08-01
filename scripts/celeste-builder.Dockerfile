# Linux image for a reproducible Everest build + runtime install.
#
# The build scripts download and cache the runtime bundle and the upstream
# checkout under .tmp/, so this image only has to supply the tools they shell
# out to. Keeping those caches in the (bind-mounted) workspace means a container
# rebuild does not re-download them.
#
# mono-devel is here for ilasm: MonoMod's IL projects assemble through the
# Microsoft.Net.Sdk.IL SDK, which has no cross-platform assembler of its own.

FROM mcr.microsoft.com/dotnet/sdk:9.0-noble

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      make \
      mono-devel \
      nodejs \
      python3 \
      unzip \
      zip \
      zstd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

# Keep the SDK's first-run chatter and telemetry out of the build logs, and the
# NuGet cache inside the bind-mounted workspace so a rerun does not re-download.
ENV DOTNET_NOLOGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    NUGET_PACKAGES=/workspace/.tmp/nuget

ENTRYPOINT ["make"]
CMD ["build-wasm"]

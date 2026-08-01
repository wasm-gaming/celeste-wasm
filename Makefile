# @wasm-gaming/celeste-wasm — build & preview
#
#   make build     Full build → dist/ (.NET WASM runtime + Everest + TypeScript SDK)
#   make preview   Serve dist/ at http://localhost:$(PORT) with COOP/COEP
#
# Nothing from Celeste lives in this repo, and nothing it builds contains any
# of the game. `make build-everest` compiles the Everest mod loader from a
# pinned upstream checkout; `make build-runtime` fetches the pinned .NET
# WebAssembly runtime that hosts it. The game itself is supplied by the player
# at runtime and never leaves their browser.

BIN := node_modules/.bin

PORT ?= 8031

# --- Everest -----------------------------------------------------------------
# The mod loader this package is built around. Pinned so a build is
# reproducible; override on the command line to track a newer revision
# (make build-everest UPSTREAM_REF=dev).
UPSTREAM_REPO ?= https://github.com/EverestAPI/Everest.git
UPSTREAM_REF  ?= a756f4710f81dd30e41469a950fd245451dd55d9

# Version string stamped into the build, standing in for the Azure build id the
# official pipeline uses. Anything Everest's own updater will not mistake for a
# release build.
EVEREST_BUILD ?= 0

# --- Runtime -----------------------------------------------------------------
# The .NET-for-WebAssembly runtime that loads and patches the player's Celeste:
# dotnet.js, the split dotnet.native.wasm, FNA/FMOD/SDL3 statics and the
# MonoMod.WASM assemblies. Built from the loader repo below; by default the
# pinned prebuilt bundle is downloaded instead, because building it from source
# needs a patched emsdk, a patched .NET runtime pack and about an hour.
RUNTIME_REPO ?= https://github.com/MercuryWorkshop/celeste-wasm
RUNTIME_REF  ?= latest
RUNTIME_REV  ?= 70ab8ae24e0ea9f06bc9c9248278038a89cd2a59

# Shared demo template shipped by the engine contract package; this repo only
# adds index.html + theme.celeste.css on top of it.
SPECS_DEMO := node_modules/@wasm-gaming/engine-specs/demo

export UPSTREAM_REPO UPSTREAM_REF EVEREST_BUILD RUNTIME_REPO RUNTIME_REF RUNTIME_REV

.PHONY: build build-sdk build-lib build-manifest build-demo build-wasm \
	build-runtime build-everest build-wasm-docker build-everest-docker \
	preview preview.single typecheck test release-check i install \
	clean clean-all help

i: install
install: ## Install dev dependencies
	npm install

node_modules: package.json
	npm install
	@touch node_modules

build: build-wasm build-sdk ## Full build → dist/ (runtime + Everest first, then SDK/demo)

build-sdk: build-lib build-manifest build-demo ## TypeScript + manifest + demo shell

build-lib: node_modules ## Compile SDK/options/manifest → dist/celeste/
	$(BIN)/tsc -p tsconfig.json

build-manifest: build-lib ## Serialize typed manifest → dist/manifest.json
	node scripts/emit-manifest.mjs

build-demo: build-lib ## Compile the demo page + copy the shared template
	$(BIN)/tsc -p tsconfig.demo.json
	rm -rf dist/demo
	cp -R $(SPECS_DEMO) dist/demo
	cp src/demo/index.html dist/index.html
	cp src/demo/theme.celeste.css dist/theme.celeste.css
	cp src/demo/coi.js dist/coi.js
	cp src/demo/_headers dist/_headers

build-wasm: build-runtime build-everest ## Runtime + Everest → dist/celeste/

build-runtime: ## Fetch (or build) the .NET WASM runtime → dist/celeste/_framework/
	bash scripts/build-celeste-runtime.sh

build-everest: ## Compile the pinned Everest checkout → dist/celeste/everest.zip
	bash scripts/build-everest.sh

build-wasm-docker: ## Same build, inside a pinned Linux container (has dotnet + ilasm)
	bash scripts/build-celeste-web-docker.sh build-wasm

build-everest-docker: ## Just the Everest build, in that container
	bash scripts/build-everest-docker.sh

typecheck: build-lib
	$(BIN)/tsc -p tsconfig.json --noEmit
	$(BIN)/tsc -p tsconfig.demo.json --noEmit

test: typecheck build-manifest
	node --test tests/*.test.mjs

release-check: test
	npm config get registry
	npm pack --dry-run

preview: ## Serve dist/ with COOP/COEP headers (required: the runtime needs threads)
	@echo "Serving dist/ at http://localhost:$(PORT) (Ctrl+C to stop)"
	python3 scripts/preview-server.py --port $(PORT) --directory dist

preview.single: ## Serve dist/ without COOP/COEP, to see the isolation check fail
	@echo "Serving dist/ at http://localhost:$(PORT) (Ctrl+C to stop)"
	python3 -m http.server $(PORT) --directory dist

clean: ## Remove build outputs
	@if [ -d dist ]; then find dist -mindepth 1 -delete; fi

clean-all: clean ## Also drop the cached runtime bundle and upstream checkouts
	rm -rf .tmp

help: ## List targets
	@grep -E '^[a-zA-Z_.-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help

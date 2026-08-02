import type { EngineManifest } from '@wasm-gaming/engine-specs';
import { CELESTE_OPTIONS_SCHEMA } from './celeste.options.js';
import { EVEREST_ZIP, VFS_ROOT } from './celeste.opfs.js';

export const manifest: EngineManifest = {
  id: 'celeste',
  version: '0.1.6',
  name: 'Celeste + Everest (WebAssembly)',
  description:
    "Celeste (2018) on the .NET WebAssembly runtime, with the Everest mod loader patched in by MonoMod in the browser. Ships none of the game: the player supplies the Celeste installation they already own, it is staged into the origin private filesystem, and it never leaves their machine.",
  artifacts: {
    // The runtime resolves its own binary — the published file is content
    // hashed and split into 20 MB pieces (dotnet.native.<hash>.wasm0…4), which
    // `splitWasmLoader` stitches back together. This is the unhashed name it
    // derives those from.
    wasm: 'celeste/_framework/dotnet.native.wasm',
    js: 'celeste/_framework/dotnet.js',
    data: `celeste/${EVEREST_ZIP}`,
  },
  assets: [
    {
      key: 'game',
      mountPath: VFS_ROOT,
      required: true,
      accept: ['.zip'],
      description:
        "A zip of your own Celeste installation — the folder the game runs from, with Celeste.exe and Content/ inside it. Unpacked into the runtime's filesystem before boot and patched there. Hosts with `showDirectoryPicker` should pass the folder directly as `gameDirectory` instead and skip the archive.",
    },
    {
      key: 'everest',
      mountPath: `${VFS_ROOT}/${EVEREST_ZIP}`,
      required: false,
      accept: ['.zip'],
      description:
        "An Everest build to patch in, in the layout the desktop installer takes. Defaults to the one this package built from its pinned upstream checkout; set `options.everestSource = 'updater'` to fetch the current one instead.",
    },
  ],
  // Celeste's own keyboard defaults. The game ships a key-mapping screen and
  // Everest adds its own on top, which is what actually rebinds these.
  input: {
    up: 'ArrowUp',
    down: 'ArrowDown',
    left: 'ArrowLeft',
    right: 'ArrowRight',
    jump: 'KeyC',
    dash: 'KeyX',
    grab: 'KeyZ',
    talk: 'KeyC',
    confirm: 'KeyC',
    cancel: 'KeyX',
    journal: 'Tab',
    pause: 'Escape',
  },
  // The gameplay buffer Celeste renders into before it upscales. The window
  // itself is normally far larger — see `options.fit`.
  video: { baseWidth: 320, baseHeight: 180, aspect: '16:9' },
  options: CELESTE_OPTIONS_SCHEMA,
  // Celeste keeps its own save files; the runtime has no state snapshot to take.
  capabilities: { saveStates: false, sram: true, coreSelectable: false },
};

export default manifest;

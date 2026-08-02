import type { JSONSchema } from '@wasm-gaming/engine-specs';

/**
 * Everything a host can set on `load()`.
 *
 * Celeste is a full game, not a core: it ships its own settings menu, and
 * Everest adds a second one on top. Video scaling, audio levels, key bindings,
 * language and every mod toggle belong there, and this package deliberately
 * does not put a third settings overlay in front of them. What is left is the
 * boot-time surface the browser owns — where the runtime comes from, how the
 * canvas is sized, and whether the mod loader gets installed at all.
 *
 * The catalog is the single source of truth: the manifest's options schema and
 * the defaults are both derived from it.
 */

interface OptionSpecBase {
  /** Option key, as used in `EngineConfig.options` and the manifest schema. */
  key: string;
  label: string;
  description: string;
}

export type CelesteOptionSpec = OptionSpecBase &
  (
    | { type: 'boolean'; default: boolean }
    | { type: 'integer'; default: number; minimum?: number; maximum?: number }
    | { type: 'enum'; default: string; values: Array<{ value: string; label: string }> }
  );

export const CELESTE_ENGINE_OPTIONS: CelesteOptionSpec[] = [
  {
    key: 'fit',
    label: 'Canvas fit',
    description:
      "Where the picture is laid out, and which box the resolution is taken from. 'container' letterboxes the game inside the element it is mounted in and derives the resolution from that box. 'fixed' asks for renderWidth×renderHeight and lets host CSS scale the result, the equivalent of choosing a resolution in the video menu. 'window' letterboxes it over the browser window — only correct on a page that is nothing but the game. Whichever is chosen, the picture is always 16:9: the browser build renders at a whole multiple of 320×180 and cannot be stretched to another shape.",
    type: 'enum',
    default: 'container',
    values: [
      { value: 'container', label: 'Fill the container' },
      { value: 'fixed', label: 'Fixed resolution' },
      { value: 'window', label: 'Fill the browser window' },
    ],
  },
  {
    key: 'renderWidth',
    label: 'Render width',
    description:
      "Requested resolution width when fit is 'fixed'. Rounded down to a whole multiple of 320, because the game's window is always WindowScale×320 by WindowScale×180, and capped at 1920: every frame is composed in a 1922×1082 target before it reaches the window, so a larger one shows nothing more. Ignored otherwise.",
    type: 'integer',
    default: 1920,
    minimum: 320,
  },
  {
    key: 'renderHeight',
    label: 'Render height',
    description:
      "Requested resolution height when fit is 'fixed'. Rounded down to a whole multiple of 180 and capped at 1080 — and the smaller of the two axes wins, since the picture cannot be anything but 16:9. Ignored otherwise.",
    type: 'integer',
    default: 1080,
    minimum: 180,
  },
  {
    key: 'syncResolution',
    label: 'Match the resolution to the page',
    description:
      "Write the window scale the fit above works out into Celeste's own settings file before the game reads it. This is the only way the resolution can follow the page: the browser build pins the window to WindowScale×320 by WindowScale×180 and the canvas belongs to a worker, so nothing on the page can resize it once the game is up. Turn it off to leave whatever the player chose in Options → Video alone and just scale the picture.",
    type: 'boolean',
    default: true,
  },
  {
    key: 'installEverest',
    label: 'Install Everest',
    description:
      'Patch the game with the Everest mod loader before booting it. With this off the runtime patches vanilla Celeste for WebAssembly and nothing else — no mods, no Everest menu.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'everestSource',
    label: 'Everest build',
    description:
      "Where the mod loader comes from. 'bundled' uses the everest.zip this package built from its pinned upstream checkout, which is the reproducible one. 'updater' asks everestapi.github.io for the current build of `everestBranch` at load time, which is what the desktop installer does.",
    type: 'enum',
    default: 'bundled',
    values: [
      { value: 'bundled', label: 'Bundled with this build' },
      { value: 'updater', label: 'Everest updater' },
    ],
  },
  {
    key: 'everestBranch',
    label: 'Everest branch',
    description: "Branch to pull when everestSource is 'updater'.",
    type: 'enum',
    default: 'stable',
    values: [
      { value: 'stable', label: 'Stable' },
      { value: 'beta', label: 'Beta' },
      { value: 'dev', label: 'Dev' },
    ],
  },
  {
    key: 'repatch',
    label: 'Re-patch on load',
    description:
      'Run MonoMod over the install again even when a patched build is already in storage. The patch takes minutes; it is cached precisely so a reload does not pay for it twice. Turn this on after replacing the game or changing the Everest build.',
    type: 'boolean',
    default: false,
  },
  {
    key: 'verifyInstall',
    label: 'Verify the install',
    description:
      'Check the supplied Celeste installation for the files the game reads before staging it, so a wrong folder fails in milliseconds instead of part-way through a multi-minute patch.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'pixelated',
    label: 'Crisp pixels',
    description:
      'Upscale the canvas with nearest-neighbour (image-rendering: pixelated). Only visible when the drawing buffer is smaller than the box it is displayed in.',
    type: 'boolean',
    default: false,
  },
  {
    key: 'focusCanvas',
    label: 'Focus on start',
    description: 'Give the canvas keyboard focus as soon as the game starts.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'lockKeyboard',
    label: 'Capture system keys',
    description:
      'Hold the Keyboard Lock API while the game is running, so Escape and the browser shortcuts reach Celeste instead of the browser. Chromium-only, and only on a fullscreen page; ignored elsewhere.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'suspendAudioWhenHidden',
    label: 'Mute in the background',
    description:
      "Suspend the page's audio contexts while the tab is hidden. FMOD keeps its own mixer running otherwise, which is loud and expensive on a backgrounded tab.",
    type: 'boolean',
    default: true,
  },
  {
    key: 'autoStart',
    label: 'Start on load',
    description:
      'Boot the game as part of load(). Turn it off to stage the install and the runtime, then defer the ~250 MB runtime download and the patch to the first start() call.',
    type: 'boolean',
    default: true,
  },
  {
    key: 'jiterpreter',
    label: 'Tune the jiterpreter',
    description:
      "Pass Mono's jiterpreter tuning flags at startup: trace more methods, sooner, with larger limits. Celeste is unplayable in the plain interpreter, so this is on unless you are debugging the runtime.",
    type: 'boolean',
    default: true,
  },
  {
    key: 'pthreadPoolSize',
    label: 'Thread pool size',
    description:
      'Web workers the runtime pre-spawns. The rendering thread, the audio mixer and Celeste’s own worker threads all come out of this pool; too small a pool deadlocks the boot.',
    type: 'integer',
    default: 16,
    minimum: 4,
    maximum: 64,
  },
  {
    key: 'seamlessFrames',
    label: 'Warm-up frames',
    description:
      'Frames to run one at a time before handing control to the game’s own main loop. They cover the gap where the first frames are still being jitted, so the game fades in instead of stuttering.',
    type: 'integer',
    default: 5,
    minimum: 0,
    maximum: 60,
  },
];

/** How the SDK reconciles the render size with the page. */
export type CelesteFit = 'container' | 'fixed' | 'window';

export interface CelesteOptions {
  fit?: CelesteFit;
  renderWidth?: number;
  renderHeight?: number;
  syncResolution?: boolean;
  installEverest?: boolean;
  everestSource?: 'bundled' | 'updater';
  everestBranch?: 'stable' | 'beta' | 'dev';
  repatch?: boolean;
  verifyInstall?: boolean;
  pixelated?: boolean;
  focusCanvas?: boolean;
  lockKeyboard?: boolean;
  suspendAudioWhenHidden?: boolean;
  autoStart?: boolean;
  jiterpreter?: boolean;
  pthreadPoolSize?: number;
  seamlessFrames?: number;
  /** Where the runtime lives: the directory that contains `_framework/`. Defaults to this package's dist/celeste/. */
  runtimeBaseUrl?: string;
  /**
   * Directory of the OPFS mount the game lives in.
   *
   * A property of the *runtime build*, not a free choice: the loader resolves
   * its own paths, and only a runtime built from source here understands this.
   * A downloaded runtime uses the mount root and needs `''`. `load()` reads
   * `runtime.json` and refuses a mismatch rather than staging where the game
   * will not look.
   */
  storageNamespace?: string;
  /** Name of the archive the player picked, shown in host UI and logs. */
  installFileName?: string;
  /** Alias for `installFileName`, for hosts that report the picked name here. */
  fileName?: string;
  /** Extra Mono runtime options, appended after the SDK's own. */
  extraRuntimeOptions?: string[];
}

export const DEFAULT_CELESTE_OPTIONS: Required<
  Pick<
    CelesteOptions,
    | 'fit'
    | 'renderWidth'
    | 'renderHeight'
    | 'syncResolution'
    | 'installEverest'
    | 'everestSource'
    | 'everestBranch'
    | 'repatch'
    | 'verifyInstall'
    | 'pixelated'
    | 'focusCanvas'
    | 'lockKeyboard'
    | 'suspendAudioWhenHidden'
    | 'autoStart'
    | 'jiterpreter'
    | 'pthreadPoolSize'
    | 'seamlessFrames'
    | 'installFileName'
    | 'storageNamespace'
  >
> = {
  fit: 'container',
  renderWidth: 1920,
  renderHeight: 1080,
  syncResolution: true,
  installEverest: true,
  everestSource: 'bundled',
  everestBranch: 'stable',
  repatch: false,
  verifyInstall: true,
  pixelated: false,
  focusCanvas: true,
  lockKeyboard: true,
  suspendAudioWhenHidden: true,
  autoStart: true,
  jiterpreter: true,
  pthreadPoolSize: 16,
  seamlessFrames: 5,
  installFileName: 'Celeste.zip',
  storageNamespace: 'celeste',
};

function schemaForOption(option: CelesteOptionSpec): JSONSchema {
  if (option.type === 'boolean') {
    return {
      type: 'boolean',
      default: option.default,
      title: option.label,
      description: option.description,
    };
  }

  if (option.type === 'integer') {
    return {
      type: 'integer',
      default: option.default,
      ...(option.minimum === undefined ? {} : { minimum: option.minimum }),
      ...(option.maximum === undefined ? {} : { maximum: option.maximum }),
      title: option.label,
      description: option.description,
    };
  }

  return {
    type: 'string',
    enum: option.values.map((value) => value.value),
    default: option.default,
    title: option.label,
    description: option.description,
    'x-labels': Object.fromEntries(option.values.map((value) => [value.value, value.label])),
  };
}

export const CELESTE_OPTIONS_SCHEMA: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...Object.fromEntries(CELESTE_ENGINE_OPTIONS.map((option) => [option.key, schemaForOption(option)])),
    runtimeBaseUrl: {
      type: 'string',
      description:
        'Directory holding the runtime — the one with _framework/ inside it. Defaults to the dist/celeste/ folder shipped next to this SDK.',
    },
    storageNamespace: {
      type: 'string',
      default: 'celeste',
      description:
        "Directory of the OPFS mount the game lives in, so other engines can share the origin. Only a runtime built from source understands it; a downloaded one needs ''. Checked against runtime.json at boot.",
    },
    installFileName: {
      type: 'string',
      default: 'Celeste.zip',
      description: 'Name of the install archive the player supplied. Display only.',
    },
    fileName: {
      type: 'string',
      description: 'Alias for installFileName, accepted for hosts that report the picked file name here.',
    },
    extraRuntimeOptions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Additional Mono runtime options, appended after the ones the SDK passes.',
    },
  },
};

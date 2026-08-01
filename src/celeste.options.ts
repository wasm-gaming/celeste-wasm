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
      "How the picture is sized. 'container' renders at the size of the element the game is mounted in, which is what makes the game's own fullscreen and scaling settings behave the way they do on the desktop build. 'fixed' pins the drawing buffer to renderWidth×renderHeight and lets host CSS scale it, the equivalent of choosing a resolution in the video menu. 'window' fills the browser window — only correct on a page that is nothing but the game.",
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
    description: "Drawing buffer width when fit is 'fixed'. Ignored otherwise.",
    type: 'integer',
    default: 1920,
    minimum: 320,
  },
  {
    key: 'renderHeight',
    label: 'Render height',
    description: "Drawing buffer height when fit is 'fixed'. Ignored otherwise.",
    type: 'integer',
    default: 1080,
    minimum: 180,
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
  >
> = {
  fit: 'container',
  renderWidth: 1920,
  renderHeight: 1080,
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

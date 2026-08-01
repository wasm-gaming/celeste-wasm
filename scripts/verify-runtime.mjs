#!/usr/bin/env node
// Check that the installed runtime carries the modifications the SDK relies on.
//
// The loader's build rewrites four things in the runtime glue after .NET emits
// it. They are not cosmetic — the SDK is written against every one of them, and
// a runtime without them fails in ways that look like SDK bugs (a black canvas,
// a jiterpreter that refuses to grow, a 100 MB request that no CDN will serve).
// So they are asserted here, at build time, where the message can say what is
// actually wrong.
//
//   usage: verify-runtime.mjs <_framework dir> [--fix]
//
// `--fix` applies the two rewrites that are safe to apply idempotently, for
// runtimes built from source outside the upstream Makefile.
//
// On top of those, this script applies one rewrite of its own — the gamepad
// patch below. Upstream will never ship it, so it is applied on every build
// rather than asserted.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...flags] = process.argv.slice(2);
if (!dir) {
  console.error('usage: verify-runtime.mjs <_framework dir> [--fix]');
  process.exit(1);
}
const fix = flags.includes('--fix');

const files = readdirSync(dir);
const find = (pattern) => files.filter((name) => pattern.test(name));

const problems = [];
const fixes = [];
/** Problems `--fix` would have taken care of, so the report can say so. */
let fixable = 0;

// -------------------------------------------------------------------- files --

if (!files.includes('dotnet.js')) {
  problems.push('dotnet.js is missing — this is not a .NET WebAssembly runtime directory');
}

const nativeGlue = find(/^dotnet\.native\..*\.js$/);
const runtimeGlue = find(/^dotnet\.runtime\..*\.js$/);
if (nativeGlue.length === 0) problems.push('dotnet.native.*.js is missing');
if (runtimeGlue.length === 0) problems.push('dotnet.runtime.*.js is missing');

// The binary is published in 20 MB pieces; `splitWasmLoader` reassembles them.
// An unsplit dotnet.native.wasm means the SDK's loader will 404 on piece 0.
const pieces = find(/^dotnet\.native\..*\.wasm\d+$/);
const whole = find(/^dotnet\.native\..*\.wasm$/);
if (find(/^dotnet\.native\..*\.wasm0$/).length === 0) {
  problems.push(
    whole.length > 0
      ? `${whole[0]} was not split — the SDK fetches ${whole[0]}0, ${whole[0]}1, … ` +
        '(upstream: `split -b20M -d -a1 dotnet.native.*.wasm dotnet.native.*.wasm`)'
      : 'no dotnet.native.*.wasm pieces found',
  );
}

// ------------------------------------------------------------------ patches --

const rewrite = (name, { probe, from, to, why }) => {
  const path = join(dir, name);
  const source = readFileSync(path, 'utf8');
  if (probe.test(source)) return;

  if (from.test(source)) {
    if (fix) {
      writeFileSync(path, source.replace(from, to));
      fixes.push(`${name}: ${why}`);
      return;
    }
    fixable++;
  }
  problems.push(`${name}: ${why}`);
};

/**
 * A rewrite this repository owns rather than one the upstream build is expected
 * to have made. Nothing upstream applies it, so there is no point asserting it:
 * it goes in on every build, guarded by `probe` so a second run is a no-op, and
 * fails the build if the code it rewrites has moved.
 */
const patch = (name, { probe, from, to, why }) => {
  const path = join(dir, name);
  const source = readFileSync(path, 'utf8');
  if (probe.test(source)) return;

  if (!from.test(source)) {
    problems.push(`${name}: cannot patch ${why} — the runtime code it rewrites has moved`);
    return;
  }

  writeFileSync(path, source.replace(from, to));
  fixes.push(`${name}: ${why}`);
};

/**
 * Gamepads, on the thread the game actually runs on.
 *
 * `navigator.getGamepads` exists on the window and nowhere else, so every
 * gamepad call SDL's emscripten joystick driver makes is proxied to the main
 * thread — `emscripten_sample_gamepad_data`, `emscripten_get_num_gamepads`,
 * `emscripten_get_gamepad_status`. Three helpers in that driver are not.
 * `SDL_GetEmscriptenJoystickVendor`, `…Product` and `SDL_IsEmscriptenJoystick-
 * XInput` are EM_JS, which runs on whichever thread called it, and the thread
 * that calls them is the deputy worker FNA's loop lives on. There, `navigator`
 * has no `getGamepads`, so all three throw — inside
 * `Emscripten_JoyStickConnected`, before it reaches `SDL_PrivateJoystickAdded`.
 * The pad is never added, and the game sees no controller at all however
 * healthy the browser's own gamepad events look.
 *
 * What those helpers want has already been proxied across, though: the pad's
 * `id` is a field of the `EmscriptenGamepadEvent` that the status call fills
 * in. So off the window, read it back out of that instead. SDL then derives the
 * same vendor and product it would have derived on the main thread, and its
 * mapping database matches the controller the way it does on the desktop.
 */
const patchGamepadHelpers = (name) => {
  const source = readFileSync(join(dir, name), 'utf8');

  // Struct size and the offset of its `id`, read off the glue's own writer
  // rather than hardcoded — emscripten has moved that layout before.
  const size = /JSEvents\.gamepadEvent = _malloc\((\d+)\)/.exec(source);
  const id = /stringToUTF8\(e\.id, eventStruct \+ (\d+), (\d+)\)/.exec(source);
  if (!size || !id) {
    problems.push(
      `${name}: cannot patch the gamepad helpers — EmscriptenGamepadEvent's layout ` +
        'is no longer readable out of the glue',
    );
    return;
  }

  // One event struct per thread, kept for the life of the runtime — the same
  // way `JSEvents.gamepadEvent` above it is allocated once and never freed.
  const reader = `
var SDL_EmscriptenGamepadEvent = 0;

function SDL_GetEmscriptenGamepad(device_index) {
 if (typeof navigator != "undefined" && navigator.getGamepads) {
  return navigator.getGamepads()[device_index] || { id: "" };
 }
 if (!SDL_EmscriptenGamepadEvent) SDL_EmscriptenGamepadEvent = _malloc(${size[1]});
 if (!SDL_EmscriptenGamepadEvent) return { id: "" };
 _emscripten_sample_gamepad_data();
 if (_emscripten_get_gamepad_status(device_index, SDL_EmscriptenGamepadEvent) != 0) {
  return { id: "" };
 }
 return { id: UTF8ToString(SDL_EmscriptenGamepadEvent + ${id[1]}, ${id[2]}) };
}
`;

  patch(name, {
    probe: /function SDL_GetEmscriptenGamepad\(/,
    from: /function SDL_GetEmscriptenJoystickVendor\(device_index\) \{/,
    to: `${reader}\nfunction SDL_GetEmscriptenJoystickVendor(device_index) {`,
    why: 'the worker-side gamepad reader',
  });

  patch(name, {
    probe: /let gamepad = SDL_GetEmscriptenGamepad\(device_index\);/,
    // The three joystick helpers, and only those: SDL's rumble EM_ASM reads
    // `navigator["getGamepads"]()` too, but it is a MAIN_THREAD_EM_ASM and is
    // already on the side of the boundary that has the API.
    from: /let gamepad = navigator\["getGamepads"\]\(\)\[device_index\];/g,
    to: 'let gamepad = SDL_GetEmscriptenGamepad(device_index);',
    why: 'the joystick helpers reading the Gamepad API off the window',
  });
};

/**
 * Tell the page when the game's main loop stops.
 *
 * FNA does not return from `Game.Run()` on this platform. `RunLoop()` sees
 * `NeedsPlatformMainLoop()` and hands control to `emscripten_set_main_loop(cb,
 * 0, 1)`, whose third argument makes the glue `throw "unwind"` — the C stack is
 * discarded on the way in and nothing after that call ever runs. So
 * `CelesteLoader.MainLoop()`, which the SDK awaits for exactly this, is a
 * promise that never settles: quitting the game leaves the last (black) frame
 * on the canvas, FMOD still playing on its own thread, and the host with no way
 * to know the game is gone. Upstream's frontend awaits the same promise and has
 * the same hole.
 *
 * What does happen on quit is `emscripten_cancel_main_loop()`, from FNA's own
 * emscripten iteration callback the moment `RunApplication` goes false. That is
 * the signal, and this puts it on a channel the page can hear.
 *
 * A BroadcastChannel rather than anything of emscripten's own: this runs on the
 * deputy worker the loop lives on, which shares no scope with the page, and the
 * proxying the glue does have is for C functions registered at link time.
 * `EXIT_CHANNEL` in celeste.sdk.ts is the other end.
 */
const patchExitSignal = (name) => {
  patch(name, {
    probe: /celesteAnnounceMainLoopStopped/,
    from: /var _emscripten_cancel_main_loop = \(\) => \{\n Browser\.mainLoop\.pause\(\);\n Browser\.mainLoop\.func = null;\n\};/,
    to: `function celesteAnnounceMainLoopStopped() {
 try {
  var channel = new BroadcastChannel("celeste-wasm:runtime");
  channel.postMessage({ type: "mainloop-stopped" });
  channel.close();
 } catch (e) {}
}

var _emscripten_cancel_main_loop = () => {
 Browser.mainLoop.pause();
 Browser.mainLoop.func = null;
 celesteAnnounceMainLoopStopped();
};`,
    why: 'the main-loop-stopped signal the SDK turns into an exit event',
  });
};

for (const name of nativeGlue) {
  // The canvas is transferred to the worker the renderer runs on, selected by
  // CSS class. `CANVAS_CLASS` in celeste.sdk.ts is the other half of this.
  rewrite(name, {
    probe: /transferredCanvasNames\s*=\s*\[\s*["']\.canvas["']\s*\]/,
    from: /var offscreenCanvases ?= ?\{\};/,
    to: 'var offscreenCanvases={};if(globalThis.window&&!window.TRANSFERRED_CANVAS){transferredCanvasNames=[".canvas"];window.TRANSFERRED_CANVAS=true;}',
    why: 'the canvas is not registered for transfer to the render worker (the game would draw nowhere)',
  });

  // EM_ASM bodies have to run on the main thread; on the deputy thread the DOM
  // calls inside them throw.
  rewrite(name, {
    probe: /runMainThreadEmAsm\(code, sigPtr, argbuf, 1\)/,
    from: /return runEmAsmFunction\(code, sigPtr, argbuf\);/,
    to: 'return runMainThreadEmAsm(code, sigPtr, argbuf, 1);',
    why: 'EM_ASM is not proxied to the main thread',
  });

  patchGamepadHelpers(name);
  patchExitSignal(name);
}

for (const name of runtimeGlue) {
  // The jiterpreter's wasm module table is capped at 32768 entries by default;
  // Celeste plus Everest plus a mod pack needs the full 16-bit range.
  rewrite(name, {
    probe: /this\.appendULeb\(65535\)/,
    from: /this\.appendULeb\(32768\)/,
    to: 'this.appendULeb(65535)',
    why: 'the jiterpreter table limit was not raised to 65535',
  });
}

// ------------------------------------------------------------------- report --

for (const applied of fixes) {
  console.log(`[verify-runtime] fixed ${applied}`);
}

if (problems.length > 0) {
  console.error('[verify-runtime] this runtime is not usable by the SDK:');
  for (const problem of problems) console.error(`  - ${problem}`);
  if (fixable > 0) console.error('\nSome of these can be applied automatically: re-run with --fix.');
  process.exit(1);
}

console.log(`[verify-runtime] ok — ${files.length} files, ${pieces.length} wasm pieces`);

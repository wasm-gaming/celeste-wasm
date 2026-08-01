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

  if (fix && from.test(source)) {
    writeFileSync(path, source.replace(from, to));
    fixes.push(`${name}: ${why}`);
    return;
  }
  problems.push(`${name}: ${why}`);
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
  if (!fix) console.error('\nSome of these can be applied automatically: re-run with --fix.');
  process.exit(1);
}

console.log(`[verify-runtime] ok — ${files.length} files, ${pieces.length} wasm pieces`);

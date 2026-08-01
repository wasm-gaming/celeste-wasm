#!/usr/bin/env node
// Prepare an Everest checkout for the browser build: stamp a version onto it,
// and drop the one boot-time call the browser can never make.
//
// Upstream does this in .azure-pipelines/prebuild.ps1, from Azure build
// variables that do not exist outside their pipeline. Two things come out of
// it, and Everest does not work properly without either:
//
//   1. `Everest.VersionString`, which ships as "0.0.0-dev" in the tree. Everest
//      parses it into `Everest.Version` at startup and every mod's
//      `everest.yaml` dependency constraint is checked against it — an
//      unstamped build satisfies none of them.
//   2. `Celeste.Mod.Helpers.EverestBuild<N>`, a generated marker type. The
//      build number is read back off the type's *name* at runtime, which is why
//      the file is generated rather than a constant.
//
// The suffix says where the build came from, so a browser build is never
// mistaken for an official one by the updater or by a bug report.
//
//   usage: patch-everest-source.mjs <upstream-checkout>

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const srcDir = process.argv[2];
if (!srcDir) {
  console.error('usage: patch-everest-source.mjs <upstream-checkout>');
  process.exit(1);
}

const build = Number(process.env.EVEREST_BUILD ?? 0);
if (!Number.isInteger(build) || build < 0) {
  console.error(`[patch] EVEREST_BUILD must be a non-negative integer, got ${process.env.EVEREST_BUILD}`);
  process.exit(1);
}

const revision = (() => {
  try {
    return execFileSync('git', ['-C', srcDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
})();

const versionString = `1.${build}.0-wasm${revision ? `-${revision.slice(0, 5)}` : ''}`;

const changes = [];

// ------------------------------------------------------------ VersionString --

{
  const rel = 'Celeste.Mod.mm/Mod/Everest/Everest.cs';
  const path = join(srcDir, rel);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(
    /(public readonly static string VersionString = ")[^"]*(")/,
    `$1${versionString}$2`,
  );
  if (after === before) {
    console.error(`[patch] could not find VersionString in ${rel}`);
    process.exit(1);
  }
  writeFileSync(path, after);
  changes.push(`${rel}: VersionString = "${versionString}"`);
}

// ----------------------------------------------------------- EverestVersion --

{
  const rel = 'Celeste.Mod.mm/Mod/Helpers/EverestVersion.cs';
  const path = join(srcDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `namespace Celeste.Mod.Helpers {
    internal static class EverestBuild${build} {
        public static string EverestBuild = "EverestBuild${build}";
    }
}
`,
  );
  changes.push(`${rel}: EverestBuild${build}`);
}

// ------------------------------------------------------- rich presence icons --
//
// Everest ends its boot by asking celestemodupdater.0x0a.de for the list of
// Discord rich-presence icon hashes. That host sends no CORS headers, and the
// page the runtime needs is cross-origin isolated, so the browser blocks the
// request before it leaves — every boot, with a console error to match. The
// call buys nothing here either way: rich presence needs the Discord Game SDK's
// native library, which no WebAssembly build has.

{
  const rel = 'Celeste.Mod.mm/Mod/Everest/Everest.cs';
  const path = join(srcDir, rel);
  const before = readFileSync(path, 'utf8');
  const after = before.replace(
    /^([ \t]*)DiscordSDK\.LoadRichPresenceIcons\(\);[ \t]*$/m,
    '$1// [wasm] Removed: the icon host sends no CORS headers, and a cross-origin\n' +
      '$1// isolated page cannot reach it. Discord rich presence needs a native\n' +
      '$1// library that does not exist in this build anyway.',
  );
  if (after === before) {
    console.error(`[patch] could not find the LoadRichPresenceIcons() call in ${rel}`);
    process.exit(1);
  }
  writeFileSync(path, after);
  changes.push(`${rel}: dropped the Discord rich-presence icon fetch`);
}

for (const change of changes) {
  console.log(`[patch] ${change}`);
}

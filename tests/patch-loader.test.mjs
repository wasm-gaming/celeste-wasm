import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The patch script rewrites a checkout this repo does not own, inside a build
// that takes half an hour to tell you it went wrong. Running it against a
// fixture is the difference between finding out here and finding out there —
// and it catches the script simply failing to parse, which has happened.

const SCRIPT = fileURLToPath(new URL('../scripts/patch-loader-source.mjs', import.meta.url));

/** The shapes the script anchors on, reduced to what it actually matches. */
const FIXTURE = {
  'loader/CelesteBootstrap.cs': `public static partial class CelesteBootstrap
{
    [JSExport]
    public static async Task MountFilesystems(string root, string[] rawDlls)
    {
        try
        {
            int ret = mount_opfs();
            TryCreateDirectory("/libsdl/Celeste/Mods");
            TryCreateDirectory("/libsdl/Celeste/Saves");
            File.CreateSymbolicLink("/Content", "/libsdl/Content");
        }
        catch (Exception err) { Console.WriteLine(err); }
    }
}
`,
  'loader/Celeste.cs': `class Celeste {
    void Boot() {
        File.CreateSymbolicLink("/bin/Celeste.exe", "/libsdl/CustomCeleste.dll");
        if (Directory.Exists("/libsdl/Celeste/Everest")) { }
        asm = ctx.LoadFromAssemblyPath($"/libsdl/Celeste/Everest/{name.Name}.dll");
    }
}
`,
  'loader/Patcher.cs': `class Patcher {
    void Run() {
        patcher.write("/libsdl/CustomCeleste.dll");
        string everestPath = "/libsdl/Celeste/Everest/";
    }
}
`,
  'patcher/EverestPaths.cs': `namespace Celeste.Mod
{
    public static partial class patch_Everest
    {
        public static class patch_Loader
        {
            public static string PathMods { get { return "/libsdl/Celeste/Mods"; } set { } }
        }
    }
}
`,
};

function patch(namespace, files = FIXTURE) {
  const dir = mkdtempSync(join(tmpdir(), 'loader-patch-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }

  try {
    execFileSync('node', [SCRIPT, dir], {
      env: { ...process.env, LOADER_NAMESPACE: namespace },
      stdio: 'pipe',
    });
    const out = {};
    for (const rel of Object.keys(files)) out[rel] = readFileSync(join(dir, rel), 'utf8');
    out['loader/CelestePaths.cs'] = readFileSync(join(dir, 'loader/CelestePaths.cs'), 'utf8');
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('every path literal goes through CelestePaths', () => {
  const out = patch('celeste');

  for (const [rel, body] of Object.entries(out)) {
    if (rel === 'loader/CelestePaths.cs' || rel === 'patcher/EverestPaths.cs') continue;
    assert.ok(!/"\/libsdl\//.test(body), `${rel} still has a hardcoded path`);
  }

  assert.match(out['loader/Celeste.cs'], /\$"\{CelestePaths\.Install\}\/CustomCeleste\.dll"/);
  assert.match(out['loader/Patcher.cs'], /\$"\{CelestePaths\.State\}\/Everest\/"/);
});

test('an already-interpolated literal keeps its interpolation', () => {
  // The one that would break if the `$` were added twice, or the braces eaten.
  assert.match(
    patch('celeste')['loader/Celeste.cs'],
    /\$"\{CelestePaths\.State\}\/Everest\/\{name\.Name\}\.dll"/,
  );
});

test('Install and State are a pure prefix of the default layout', () => {
  const paths = patch('celeste')['loader/CelestePaths.cs'];

  // What makes the SDK side one code path rather than two: a namespaced
  // runtime puts everything exactly one segment deeper.
  assert.match(paths, /Install = Mount \+ "\/" \+ ns;/);
  assert.match(paths, /State = Install \+ "\/Celeste";/);
  assert.match(paths, /State = Mount \+ "\/Celeste";/); // the default branch
});

test('MountFilesystems takes the namespace, and applies it before mounting', () => {
  const boot = patch('celeste')['loader/CelesteBootstrap.cs'];

  assert.match(boot, /MountFilesystems\(string root, string\[\] rawDlls, string storageNamespace = ""\)/);
  // Order matters: a path read before this would resolve against the default.
  assert.ok(
    boot.indexOf('CelestePaths.UseNamespace') < boot.indexOf('mount_opfs()'),
    'the namespace must be set before the filesystem is mounted',
  );
});

test('the baked default is what the build asked for', () => {
  assert.match(patch('mygame')['loader/CelestePaths.cs'], /ns = "mygame";/);
});

test("Everest's mod path follows the loader, across the assembly boundary", () => {
  const everest = patch('celeste')['patcher/EverestPaths.cs'];
  assert.match(everest, /GetEnvironmentVariable\("CELESTE_STATE"\)/);
  assert.match(everest, /\+ "\/Mods"/);
});

test('a namespace that is not one path segment is refused', () => {
  assert.throws(() => patch('a/b'), /must be a single path segment/);
});

test('a checkout that no longer has the anchors fails the build', () => {
  // What upstream moving looks like: the script must stop, not silently
  // produce a runtime that reads from the wrong place.
  const moved = { ...FIXTURE, 'loader/Patcher.cs': 'class Patcher { void Run() { } }\n' };
  assert.throws(() => patch('celeste', moved), /nothing to change/);
});

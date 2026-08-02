import assert from 'node:assert/strict';
import test from 'node:test';

import { FakeDirectoryHandle, read, tree } from './fake-opfs.mjs';

// The archive functions reach storage through `navigator.storage.getDirectory`,
// which is the only thing standing between them and node. Stub it and the real
// `exportInstall`/`importSaves` run here — against the fake filesystem, but
// otherwise unmodified. That is worth more than restating their rules in a test:
// what these check is the code that ships, not a second copy of its logic.

let storage = new FakeDirectoryHandle();
globalThis.navigator ??= {};
Object.defineProperty(globalThis.navigator, 'storage', {
  configurable: true,
  value: { getDirectory: async () => storage },
});

const { exportInstall, exportSaves, importInstall, importSaves, purgeStorage } = await import(
  '../dist/celeste/celeste.sdk.js'
);

// These fixtures are the stock layout — the one a downloaded runtime uses — so
// every call says so. `load()` sets the page's namespace from the runtime it
// booted; nothing here boots one. The namespaced layout gets its own tests at
// the bottom.
const ROOT = '';
const { readTar } = await import('../dist/celeste/celeste.tar.js');

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** An archive, back as `{ path: contents }`. */
async function unpack(archive) {
  const out = {};
  for await (const entry of readTar(new Blob([archive]).stream())) {
    out[entry.path] = new TextDecoder().decode(await collect(entry.body));
  }
  return out;
}

const SAVES = {
  'Celeste/Saves/0.celeste': 'AreaKey: 1\nTime: 12345\n',
  'Celeste/Saves/settings.celeste': 'WindowScale: 6\n',
};

const STAGED = {
  ...SAVES,
  'Celeste.exe': 'mz',
  'FNA.dll': 'fna',
  'Content/Dialog/english.txt': 'dialog',
  'Content/Maps/1-ForsakenCity.bin': 'map',
  'Content/Graphics/Atlases/Gameplay.data': 'atlas',
  'Content/FMOD/Desktop/Master Bank.bank': 'bank',
  'Celeste/Mods/SomeMod.zip': 'mod',
  // Everything a boot puts back on its own:
  'CustomCeleste.dll': 'patched',
  // Hardcoded inside CelesteLoader.dll rather than written by the SDK, so they
  // appear in storage without anything here naming them.
  'MMHOOK_Celeste.dll': 'hooks',
  'Celeste.Mod.mm.dll': 'everest loader',
  'everest.zip': 'everest',
  'Celeste/Everest/Celeste.Mod.mm.dll': 'loader',
  'orig/Celeste.exe': 'vanilla backup',
};

// ------------------------------------------------------------------- saves --

test('saves round-trip, with paths relative to the save directory', async () => {
  storage = tree(STAGED);
  const archive = await collect(await exportSaves({ gzip: false, namespace: ROOT }));

  // Relative to Celeste/Saves — an archive in someone's Drive should keep
  // restoring if this package ever moves where it keeps its files.
  assert.deepEqual(await unpack(archive), {
    '0.celeste': SAVES['Celeste/Saves/0.celeste'],
    'settings.celeste': SAVES['Celeste/Saves/settings.celeste'],
  });

  storage = tree({ 'Celeste.exe': 'mz' });
  assert.equal(await importSaves(archive, ROOT), 2);
  assert.equal(read(storage)['Celeste/Saves/0.celeste'], SAVES['Celeste/Saves/0.celeste']);
});

test('gzip is on by default, and detected rather than declared on the way back', async () => {
  storage = tree(SAVES);
  const archive = await collect(await exportSaves({ namespace: ROOT }));

  assert.equal(archive[0], 0x1f);
  assert.equal(archive[1], 0x8b);

  storage = new FakeDirectoryHandle();
  assert.equal(await importSaves(archive, ROOT), 2);
  assert.equal(read(storage)['Celeste/Saves/settings.celeste'], 'WindowScale: 6\n');
});

test('importing merges, so a save the archive does not carry survives', async () => {
  storage = tree(SAVES);
  const archive = await collect(await exportSaves({ gzip: false, namespace: ROOT }));

  storage = tree({ 'Celeste/Saves/9.celeste': 'a save only storage has' });
  await importSaves(archive, ROOT);

  const after = read(storage);
  assert.equal(after['Celeste/Saves/9.celeste'], 'a save only storage has');
  assert.equal(after['Celeste/Saves/0.celeste'], SAVES['Celeste/Saves/0.celeste']);
});

// ----------------------------------------------------------------- install --

test('the install archive leaves out what the next boot rebuilds', async () => {
  storage = tree(STAGED);
  const packed = await unpack(await collect(await exportInstall({ namespace: ROOT })));

  assert.deepEqual(Object.keys(packed).sort(), [
    'Celeste.exe',
    'Celeste/Mods/SomeMod.zip',
    'Content/Dialog/english.txt',
    'Content/FMOD/Desktop/Master Bank.bank',
    'Content/Graphics/Atlases/Gameplay.data',
    'Content/Maps/1-ForsakenCity.bin',
    'FNA.dll',
  ]);

  // The player's mods come along — nothing regenerates those. The saves do not:
  // they have their own pair of functions and their own cadence.
  assert.equal(packed['Celeste/Mods/SomeMod.zip'], 'mod');
  assert.ok(!Object.keys(packed).some((path) => path.startsWith('Celeste/Saves')));
});

test('the install archive is uncompressed unless asked', async () => {
  storage = tree(STAGED);

  const plain = await collect(await exportInstall({ namespace: ROOT }));
  assert.notEqual(plain[0], 0x1f);

  const gzipped = await collect(await exportInstall({ gzip: true, namespace: ROOT }));
  assert.equal(gzipped[0], 0x1f);
  assert.equal(gzipped[1], 0x8b);
});

test('restoring an install produces a game that checks out', async () => {
  storage = tree(STAGED);
  const archive = await collect(await exportInstall({ namespace: ROOT }));

  storage = new FakeDirectoryHandle();
  const check = await importInstall(archive, { namespace: ROOT });

  assert.equal(check.ok, true, check.reason);
  assert.equal(check.executable, 'Celeste.exe');
  assert.equal(check.flavor, 'fna');
  assert.equal(read(storage)['Content/Dialog/english.txt'], 'dialog');
});

test('a restore that is missing Content says so rather than half-booting', async () => {
  storage = tree({ 'Celeste.exe': 'mz', 'FNA.dll': 'fna' });
  const archive = await collect(await exportInstall({ namespace: ROOT }));

  storage = new FakeDirectoryHandle();
  const check = await importInstall(archive, { namespace: ROOT });

  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, [
    'Content/Dialog/english.txt',
    'Content/Maps',
    'Content/Graphics',
    'Content/FMOD/Desktop/Master Bank.bank',
  ]);
});

test('progress counts files and bytes as they land', async () => {
  storage = tree(STAGED);
  const archive = await collect(await exportInstall({ namespace: ROOT }));

  storage = new FakeDirectoryHandle();
  const seen = [];
  await importInstall(archive, { namespace: ROOT, onProgress: (files, bytes) => seen.push([files, bytes]) });

  assert.equal(seen.length, 7);
  assert.deepEqual(
    seen.map(([files]) => files),
    [1, 2, 3, 4, 5, 6, 7],
  );
  // Bytes only ever go up, and end at the real total.
  assert.ok(seen.every(([, bytes], at) => at === 0 || bytes > seen[at - 1][1]));
});

test('an install with nothing staged exports an archive rather than throwing', async () => {
  storage = new FakeDirectoryHandle();
  assert.deepEqual(await unpack(await collect(await exportInstall({ namespace: ROOT }))), {});
  assert.deepEqual(await unpack(await collect(await exportSaves({ gzip: false, namespace: ROOT }))), {});
});

// ------------------------------------------------------------------ purging --

test('purging removes the whole staged install, not just the names we know', async () => {
  // The point of the manifest: `FNA.dll` and friends are the player's install,
  // and no fixed list in this package could have named them.
  storage = new FakeDirectoryHandle();
  await importInstall(await withInstall(STAGED), { namespace: ROOT });

  assert.ok(Object.keys(read(storage)).some((path) => path.startsWith('Content/')));

  const { data, settings } = await purgeStorage(ROOT);
  assert.equal(data, true);
  assert.equal(settings, false); // the install archive carries no saves

  // Everything the install brought is gone — including `FNA.dll`, which is the
  // whole point. Mods stay by design; see purgeStorage's contract.
  assert.deepEqual(Object.keys(read(storage)), ['Celeste/Mods/SomeMod.zip']);
});

test('purging leaves a sibling on the same origin alone', async () => {
  storage = tree({ 'snes/rom.sfc': 'another engine', 'snes/state.bin': 'its data' });
  await importInstall(await withInstall(STAGED), { namespace: ROOT });

  await purgeStorage(ROOT);

  assert.deepEqual(read(storage), {
    'snes/rom.sfc': 'another engine',
    'snes/state.bin': 'its data',
    'Celeste/Mods/SomeMod.zip': 'mod',
  });
});

test('purging keeps mods and reports the saves separately', async () => {
  storage = new FakeDirectoryHandle();
  await importInstall(await withInstall(STAGED), { namespace: ROOT });
  await importSaves(await collect(await exportSavesFrom(SAVES)), ROOT);

  const { data, settings } = await purgeStorage(ROOT);

  assert.equal(data, true);
  assert.equal(settings, true);
  // Mods are the player's, are not part of the install, and nothing rebuilds them.
  assert.equal(read(storage)['Celeste/Mods/SomeMod.zip'], 'mod');
});

test('storage with no manifest still purges what the old fixed list covered', async () => {
  // What an install staged before this package kept a record looks like.
  storage = tree(STAGED);

  const { data } = await purgeStorage(ROOT);

  assert.equal(data, true);
  const left = Object.keys(read(storage));
  assert.ok(!left.includes('Celeste.exe'));
  assert.ok(!left.some((path) => path.startsWith('Content/')));
  // …and the documented shortfall: the player's own assemblies stay.
  assert.ok(left.includes('FNA.dll'));
});

/** An install archive built from `files`, leaving storage as it was. */
async function withInstall(files) {
  const keep = storage;
  storage = tree(files);
  const archive = await collect(await exportInstall({ namespace: ROOT }));
  storage = keep;
  return archive;
}

/** A save archive built from `files`, leaving storage as it was. */
async function exportSavesFrom(files) {
  const keep = storage;
  storage = tree(files);
  const archive = await exportSaves({ gzip: false, namespace: ROOT });
  storage = keep;
  return archive;
}

// ------------------------------------------------------------- namespaced --
//
// What a runtime built from source here does: the same tree, one segment
// deeper. A pure prefix, which is why everything above needs no second code
// path — only a different string.

const NS = 'celeste';
const under = (files, ns) =>
  Object.fromEntries(Object.entries(files).map(([path, body]) => [`${ns}/${path}`, body]));

test('a namespaced install is the same tree, one segment down', async () => {
  storage = tree(under(STAGED, NS));

  const packed = await unpack(await collect(await exportInstall({ namespace: NS })));

  // Paths inside the archive stay relative to the install root, so an archive
  // survives the layout changing under it.
  assert.deepEqual(Object.keys(packed).sort(), [
    'Celeste.exe',
    'Celeste/Mods/SomeMod.zip',
    'Content/Dialog/english.txt',
    'Content/FMOD/Desktop/Master Bank.bank',
    'Content/Graphics/Atlases/Gameplay.data',
    'Content/Maps/1-ForsakenCity.bin',
    'FNA.dll',
  ]);
});

test('an archive moves between the two layouts', async () => {
  // The reason paths are relative: a player who backed up on a stock runtime
  // restores onto a namespaced one, and neither knows about the other.
  storage = tree(STAGED);
  const archive = await collect(await exportInstall({ namespace: ROOT }));

  storage = new FakeDirectoryHandle();
  const check = await importInstall(archive, { namespace: NS });

  assert.equal(check.ok, true, check.reason);
  assert.equal(read(storage)[`${NS}/Content/Dialog/english.txt`], 'dialog');
  assert.ok(!Object.keys(read(storage)).some((path) => !path.startsWith(`${NS}/`)));
});

test('saves round-trip within a namespace', async () => {
  storage = tree(under(SAVES, NS));
  const archive = await collect(await exportSaves({ gzip: false, namespace: NS }));

  assert.deepEqual(Object.keys(await unpack(archive)).sort(), ['0.celeste', 'settings.celeste']);

  storage = new FakeDirectoryHandle();
  assert.equal(await importSaves(archive, NS), 2);
  assert.equal(read(storage)[`${NS}/Celeste/Saves/0.celeste`], SAVES['Celeste/Saves/0.celeste']);
});

test('purging a namespace leaves everything outside it alone', async () => {
  const archive = await withInstall(STAGED);

  // Start from just the sibling, so the import is what creates the namespace —
  // which is what lets staging record a manifest. Pre-populating and then
  // importing records nothing, because nothing was added.
  storage = tree({ 'snes/rom.sfc': 'another engine' });
  await importInstall(archive, { namespace: NS });

  const { data } = await purgeStorage(NS);

  assert.equal(data, true);
  const left = Object.keys(read(storage));
  assert.ok(left.includes('snes/rom.sfc'));
  assert.ok(!left.some((path) => path.startsWith(`${NS}/Content`)));
  assert.ok(!left.includes(`${NS}/FNA.dll`));
});

test('the check reads the namespace, not the root', async () => {
  const { stagedInstall } = await import('../dist/celeste/celeste.sdk.js');

  storage = tree(under(STAGED, NS));
  assert.equal((await stagedInstall(NS)).ok, true);
  // …and the root, where a stock runtime would look, has nothing.
  assert.equal((await stagedInstall(ROOT)).ok, false);
});

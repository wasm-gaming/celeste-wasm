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
  const archive = await collect(await exportSaves({ gzip: false }));

  // Relative to Celeste/Saves — an archive in someone's Drive should keep
  // restoring if this package ever moves where it keeps its files.
  assert.deepEqual(await unpack(archive), {
    '0.celeste': SAVES['Celeste/Saves/0.celeste'],
    'settings.celeste': SAVES['Celeste/Saves/settings.celeste'],
  });

  storage = tree({ 'Celeste.exe': 'mz' });
  assert.equal(await importSaves(archive), 2);
  assert.equal(read(storage)['Celeste/Saves/0.celeste'], SAVES['Celeste/Saves/0.celeste']);
});

test('gzip is on by default, and detected rather than declared on the way back', async () => {
  storage = tree(SAVES);
  const archive = await collect(await exportSaves());

  assert.equal(archive[0], 0x1f);
  assert.equal(archive[1], 0x8b);

  storage = new FakeDirectoryHandle();
  assert.equal(await importSaves(archive), 2);
  assert.equal(read(storage)['Celeste/Saves/settings.celeste'], 'WindowScale: 6\n');
});

test('importing merges, so a save the archive does not carry survives', async () => {
  storage = tree(SAVES);
  const archive = await collect(await exportSaves({ gzip: false }));

  storage = tree({ 'Celeste/Saves/9.celeste': 'a save only storage has' });
  await importSaves(archive);

  const after = read(storage);
  assert.equal(after['Celeste/Saves/9.celeste'], 'a save only storage has');
  assert.equal(after['Celeste/Saves/0.celeste'], SAVES['Celeste/Saves/0.celeste']);
});

// ----------------------------------------------------------------- install --

test('the install archive leaves out what the next boot rebuilds', async () => {
  storage = tree(STAGED);
  const packed = await unpack(await collect(await exportInstall()));

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

  const plain = await collect(await exportInstall());
  assert.notEqual(plain[0], 0x1f);

  const gzipped = await collect(await exportInstall({ gzip: true }));
  assert.equal(gzipped[0], 0x1f);
  assert.equal(gzipped[1], 0x8b);
});

test('restoring an install produces a game that checks out', async () => {
  storage = tree(STAGED);
  const archive = await collect(await exportInstall());

  storage = new FakeDirectoryHandle();
  const check = await importInstall(archive);

  assert.equal(check.ok, true, check.reason);
  assert.equal(check.executable, 'Celeste.exe');
  assert.equal(check.flavor, 'fna');
  assert.equal(read(storage)['Content/Dialog/english.txt'], 'dialog');
});

test('a restore that is missing Content says so rather than half-booting', async () => {
  storage = tree({ 'Celeste.exe': 'mz', 'FNA.dll': 'fna' });
  const archive = await collect(await exportInstall());

  storage = new FakeDirectoryHandle();
  const check = await importInstall(archive);

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
  const archive = await collect(await exportInstall());

  storage = new FakeDirectoryHandle();
  const seen = [];
  await importInstall(archive, { onProgress: (files, bytes) => seen.push([files, bytes]) });

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
  assert.deepEqual(await unpack(await collect(await exportInstall())), {});
  assert.deepEqual(await unpack(await collect(await exportSaves({ gzip: false }))), {});
});

// ------------------------------------------------------------------ purging --

test('purging removes the whole staged install, not just the names we know', async () => {
  // The point of the manifest: `FNA.dll` and friends are the player's install,
  // and no fixed list in this package could have named them.
  storage = new FakeDirectoryHandle();
  await importInstall(await withInstall(STAGED));

  assert.ok(Object.keys(read(storage)).some((path) => path.startsWith('Content/')));

  const { data, settings } = await purgeStorage();
  assert.equal(data, true);
  assert.equal(settings, false); // the install archive carries no saves

  // Everything the install brought is gone — including `FNA.dll`, which is the
  // whole point. Mods stay by design; see purgeStorage's contract.
  assert.deepEqual(Object.keys(read(storage)), ['Celeste/Mods/SomeMod.zip']);
});

test('purging leaves a sibling on the same origin alone', async () => {
  storage = tree({ 'snes/rom.sfc': 'another engine', 'snes/state.bin': 'its data' });
  await importInstall(await withInstall(STAGED));

  await purgeStorage();

  assert.deepEqual(read(storage), {
    'snes/rom.sfc': 'another engine',
    'snes/state.bin': 'its data',
    'Celeste/Mods/SomeMod.zip': 'mod',
  });
});

test('purging keeps mods and reports the saves separately', async () => {
  storage = new FakeDirectoryHandle();
  await importInstall(await withInstall(STAGED));
  await importSaves(await collect(await exportSavesFrom(SAVES)));

  const { data, settings } = await purgeStorage();

  assert.equal(data, true);
  assert.equal(settings, true);
  // Mods are the player's, are not part of the install, and nothing rebuilds them.
  assert.equal(read(storage)['Celeste/Mods/SomeMod.zip'], 'mod');
});

test('storage with no manifest still purges what the old fixed list covered', async () => {
  // What an install staged before this package kept a record looks like.
  storage = tree(STAGED);

  const { data } = await purgeStorage();

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
  const archive = await collect(await exportInstall());
  storage = keep;
  return archive;
}

/** A save archive built from `files`, leaving storage as it was. */
async function exportSavesFrom(files) {
  const keep = storage;
  storage = tree(files);
  const archive = await exportSaves({ gzip: false });
  storage = keep;
  return archive;
}

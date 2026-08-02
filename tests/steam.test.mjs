import assert from 'node:assert/strict';
import test from 'node:test';

import { hostImports, readSteamProgress, steamImports, steamStorageKey } from '../dist/celeste/celeste.runtime.js';

/** The two methods `steamImports` asks of a Storage, over a plain object. */
function fakeStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => void items.set(key, value),
  };
}

test('the runtime gets a SteamJS module, or the first stat read kills it', () => {
  const modules = hostImports({});
  assert.ok(modules.SteamJS, 'SteamJS is not registered');
  for (const name of ['GetAchievement', 'SetAchievement', 'GetStat', 'SetStat', 'NewQR']) {
    assert.equal(typeof modules.SteamJS[name], 'function', `SteamJS.${name} is missing`);
  }
});

test('an unlocked achievement is remembered, and only reported once', () => {
  const storage = fakeStorage();
  const unlocked = [];
  const steam = steamImports({ storage, onAchievement: (id) => unlocked.push(id) });

  assert.equal(steam.GetAchievement('CH1_COMPLETE'), false);
  steam.SetAchievement('CH1_COMPLETE');
  steam.SetAchievement('CH1_COMPLETE');

  assert.equal(steam.GetAchievement('CH1_COMPLETE'), true);
  assert.deepEqual(unlocked, ['CH1_COMPLETE']);
  assert.deepEqual(readSteamProgress('', storage).achievements, ['CH1_COMPLETE']);
});

test('a stat reads back as it was written, and as zero before that', () => {
  const storage = fakeStorage();
  const steam = steamImports({ storage });

  assert.equal(steam.GetStat('TOTAL_DEATHS'), 0);
  steam.SetStat('TOTAL_DEATHS', 412);
  assert.equal(steam.GetStat('TOTAL_DEATHS'), 412);

  // A second boot of the same page picks the record back up.
  assert.equal(steamImports({ storage }).GetStat('TOTAL_DEATHS'), 412);
});

test('each storage namespace keeps its own record', () => {
  const storage = fakeStorage();
  steamImports({ storage, storageNamespace: 'celeste' }).SetAchievement('CH1_COMPLETE');

  assert.equal(steamImports({ storage, storageNamespace: 'other' }).GetAchievement('CH1_COMPLETE'), false);
  assert.ok(storage.items.has(steamStorageKey('celeste')));
  assert.notEqual(steamStorageKey('celeste'), steamStorageKey(''));
});

test('a record that cannot be read is an empty one, not a crash', () => {
  assert.deepEqual(readSteamProgress('', fakeStorage({ 'celeste-wasm:steam': '{oh no' })), {
    achievements: [],
    stats: {},
  });
  assert.deepEqual(readSteamProgress('', null), { achievements: [], stats: {} });
});

test('a stat that is not an int reads as zero, since the import is typed int', () => {
  const storage = fakeStorage({
    'celeste-wasm:steam': JSON.stringify({ stats: { TOTAL_DEATHS: 'lots', BERRIES: 1.5 } }),
  });
  const steam = steamImports({ storage });

  assert.equal(steam.GetStat('TOTAL_DEATHS'), 0);
  assert.equal(steam.GetStat('BERRIES'), 1);
});

test('no storage at all still answers the game', () => {
  const steam = steamImports({ storage: null });
  steam.SetAchievement('CH1_COMPLETE');
  steam.SetStat('TOTAL_DEATHS', 1);

  assert.equal(steam.GetAchievement('CH1_COMPLETE'), true);
  assert.equal(steam.GetStat('TOTAL_DEATHS'), 1);
});

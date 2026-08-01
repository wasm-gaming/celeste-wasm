import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXECUTABLES,
  inspectInstall,
  REQUIRED_ENTRIES,
} from '../dist/celeste/celeste.install.js';

/** A listing that passes, optionally moved under `prefix`. */
function installListing(prefix = '', executable = 'Celeste.exe') {
  return [
    `${prefix}${executable}`,
    `${prefix}FNA.dll`,
    `${prefix}BuildIsFNA.txt`,
    // Directories arrive implied by their contents, which is what a recursive
    // walk gives you.
    `${prefix}Content/Dialog/english.txt`,
    `${prefix}Content/Maps/1-ForsakenCity.bin`,
    `${prefix}Content/Graphics/Atlases/Gameplay.data`,
    `${prefix}Content/FMOD/Desktop/Master Bank.bank`,
  ];
}

test('a flat install is accepted', () => {
  const check = inspectInstall(installListing());
  assert.equal(check.ok, true);
  assert.equal(check.root, '');
  assert.equal(check.executable, 'Celeste.exe');
  assert.equal(check.flavor, 'fna');
  assert.deepEqual(check.missing, []);
  assert.equal(check.reason, '');
});

test('an install nested inside a folder is found, and the root reported', () => {
  const check = inspectInstall(installListing('Celeste/'));
  assert.equal(check.ok, true);
  assert.equal(check.root, 'Celeste/');
});

test('the .NET Core executable Everest leaves behind is accepted', () => {
  const check = inspectInstall(installListing('', 'Celeste.dll'));
  assert.equal(check.ok, true);
  assert.equal(check.executable, 'Celeste.dll');
});

test("Everest's vanilla backup is not mistaken for the install root", () => {
  // orig/ holds the pre-patch copy of the game and looks exactly like an
  // install; picking it would stage a game with no Content next to it.
  const check = inspectInstall([...installListing(), 'orig/Celeste.exe', 'orig/FNA.dll']);
  assert.equal(check.ok, true);
  assert.equal(check.root, '');
});

test('a previous Everest install is reported, not rejected', () => {
  const check = inspectInstall([...installListing(), 'Everest/Celeste.Mod.mm.dll']);
  assert.equal(check.ok, true);
  assert.equal(check.hasEverest, true);
});

/**
 * The layout a Steam macOS install actually has, read off one:
 * Celeste.app/Contents/Resources is the game root, `english.txt` is lowercase
 * while its neighbours are not, and there is no BuildIs*.txt because only
 * Everest writes those. A case-sensitive check fails this — and fails it only
 * in the browser, where OPFS is case-sensitive and the disk it came from was
 * not.
 */
test('a vanilla Steam install inside Celeste.app is accepted', () => {
  const root = 'Celeste.app/Contents/Resources/';
  const check = inspectInstall([
    `${root}Celeste.exe`,
    `${root}FNA.dll`,
    `${root}Steamworks.NET.dll`,
    `${root}Content/Dialog/english.txt`,
    `${root}Content/Dialog/French.txt`,
    `${root}Content/Maps/1-ForsakenCity.bin`,
    `${root}Content/Graphics/Atlases/Gameplay.data`,
    `${root}Content/FMOD/Desktop/Master Bank.bank`,
  ]);

  assert.equal(check.ok, true);
  assert.equal(check.root, root);
  // Recovered from FNA.dll, since a vanilla install carries no marker file.
  assert.equal(check.flavor, 'fna');
  assert.equal(check.hasEverest, false);
});

test('required entries match whatever case the install uses', () => {
  const shouted = installListing().map((path) => path.toUpperCase());
  assert.equal(inspectInstall(shouted).ok, true);
});

test('the XNA build is recognised as such', () => {
  const listing = installListing().map((path) => (path === 'BuildIsFNA.txt' ? 'BuildIsXNA.txt' : path));
  assert.equal(inspectInstall(listing).flavor, 'xna');
});

test('a build with no marker falls back to the assembly it links', () => {
  const listing = installListing().filter((path) => path !== 'BuildIsFNA.txt');
  const check = inspectInstall(listing);
  assert.equal(check.ok, true);
  assert.equal(check.flavor, 'fna', 'recovered from FNA.dll');
});

test('a build with nothing to go on is flagged unknown but still accepted', () => {
  const listing = installListing().filter(
    (path) => path !== 'BuildIsFNA.txt' && path !== 'FNA.dll',
  );
  const check = inspectInstall(listing);
  assert.equal(check.ok, true);
  assert.equal(check.flavor, 'unknown');
});

test('an executable with no Content is rejected, listing what is missing', () => {
  const check = inspectInstall(['Celeste.exe', 'FNA.dll']);
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, [...REQUIRED_ENTRIES]);
  assert.match(check.reason, /Content\//);
});

test('a listing with no executable says so', () => {
  const listing = installListing().filter((path) => !EXECUTABLES.some((exe) => path.endsWith(exe)));
  const check = inspectInstall(listing);
  assert.equal(check.ok, false);
  assert.equal(check.executable, null);
  assert.match(check.reason, /No Celeste\.exe or Celeste\.dll/);
});

test('backslashes and trailing slashes are normalised', () => {
  const check = inspectInstall([
    'Celeste\\Celeste.exe',
    'Celeste\\Content\\Dialog\\English.txt',
    'Celeste\\Content\\Maps\\',
    'Celeste\\Content\\Graphics\\',
    'Celeste\\Content\\FMOD\\Desktop\\Master Bank.bank',
  ]);
  assert.equal(check.ok, true);
  assert.equal(check.root, 'Celeste/');
});

test('an empty listing is rejected rather than throwing', () => {
  const check = inspectInstall([]);
  assert.equal(check.ok, false);
  assert.equal(check.root, '');
});

// ------------------------------------------------------- against a real one --
//
// Every listing above is one this file wrote, which means they all agree with
// whatever this file believes a Celeste install looks like. Point the check at
// an actual install and that assumption is the thing being tested.
//
// Symlink one in to enable this:  ln -s /path/to/Celeste .tmp/Celeste-game

const GAME_DIR = fileURLToPath(new URL('../.tmp/Celeste-game', import.meta.url));
const HAS_GAME = existsSync(GAME_DIR);

/** Every path under `dir`, the way a recursive walk of storage would give it. */
function walkGame(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = prefix ? `${prefix}/${name}` : name;
    out.push(path);
    try {
      if (statSync(join(dir, name)).isDirectory()) out.push(...walkGame(join(dir, name), path));
    } catch {
      // A dangling symlink inside the install is not this check's problem.
    }
  }
  return out;
}

test('a real Celeste install is accepted', { skip: !HAS_GAME }, () => {
  const check = inspectInstall(walkGame(GAME_DIR));

  assert.equal(check.ok, true, check.reason);
  assert.equal(check.root, '');
  assert.deepEqual(check.missing, []);
  assert.ok(EXECUTABLES.includes(check.executable));
});

test('and is still accepted at the depth the SDK actually walks', { skip: !HAS_GAME }, () => {
  // `stagedInstall()` caps its walk at the longest required path. That is only
  // sound if the cap can still see everything the check asks for.
  const deepest = Math.max(...REQUIRED_ENTRIES.map((entry) => entry.split('/').length));
  const capped = walkGame(GAME_DIR).filter((path) => path.split('/').length <= deepest);

  assert.equal(inspectInstall(capped).ok, true);
});

test('a nested install needs the walk the SDK gives the player folder', () => {
  // Why `stageGame` does *not* cap the walk over the directory the player
  // picked: they are allowed to hand over a parent, and that pushes the
  // deepest required entry past any fixed ceiling. Real listing, moved down one.
  const nested = installListing('Celeste/');
  const deepest = Math.max(...REQUIRED_ENTRIES.map((entry) => entry.split('/').length));

  assert.equal(inspectInstall(nested).ok, true);
  assert.equal(
    inspectInstall(nested.filter((path) => path.split('/').length <= deepest)).ok,
    false,
  );
});

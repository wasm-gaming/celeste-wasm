import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { validateManifest } from '@wasm-gaming/engine-specs';

import { manifest } from '../dist/celeste/celeste.manifest.js';
import { EVEREST_ZIP, VFS_ROOT } from '../dist/celeste/celeste.opfs.js';
import { FRAMEWORK_DIR } from '../dist/celeste/celeste.runtime.js';

test('the manifest satisfies the engine contract', () => {
  const result = validateManifest(manifest);
  assert.deepEqual(result.errors ?? [], []);
  assert.equal(result.valid, true);
});

test('dist/manifest.json is in sync with the typed manifest', () => {
  const emitted = JSON.parse(readFileSync(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(emitted, JSON.parse(JSON.stringify(manifest)));
});

// The version is written in two files and `npm version` only knows about one of
// them, so nothing but this test stops a release from shipping a manifest that
// claims the previous one. `node scripts/sync-version.mjs` is the fix.
test('the manifest version matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.version, pkg.version);
});

test('the game asset points at the directory the loader mounts', () => {
  const game = manifest.assets.find((asset) => asset.key === 'game');
  assert.ok(game, 'manifest declares a game asset');
  assert.equal(game.required, true);
  assert.equal(game.mountPath, VFS_ROOT);
});

test('the Everest asset points at the path the patcher reads', () => {
  const everest = manifest.assets.find((asset) => asset.key === 'everest');
  assert.ok(everest, 'manifest declares an everest asset');
  assert.equal(everest.required, false);
  assert.equal(everest.mountPath, `${VFS_ROOT}/${EVEREST_ZIP}`);
});

test('artifact paths point into the runtime directory the build writes', () => {
  assert.equal(manifest.artifacts.js, `celeste/${FRAMEWORK_DIR}/dotnet.js`);
  assert.equal(manifest.artifacts.wasm, `celeste/${FRAMEWORK_DIR}/dotnet.native.wasm`);
  assert.equal(manifest.artifacts.data, `celeste/${EVEREST_ZIP}`);
});

test('save states are not claimed, because the runtime has none', () => {
  assert.equal(manifest.capabilities.saveStates, false);
  assert.equal(manifest.capabilities.sram, true);
});

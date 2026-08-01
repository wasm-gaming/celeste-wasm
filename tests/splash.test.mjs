import assert from 'node:assert/strict';
import test from 'node:test';

import { parseSplashMessage } from '../dist/celeste/celeste.runtime.js';

// The lines EverestSplash reads off its pipe, verbatim from
// Celeste.Mod.mm/Mod/Everest/EverestSplashHandler.cs.

test('a progress line becomes a message and a mod count', () => {
  const { text, progress } = parseSplashMessage('#progress3;57;Helper Mod');
  assert.equal(text, 'Loading mods… Helper Mod');
  assert.deepEqual(progress, { loaded: 3, total: 57, mod: 'Helper Mod', done: false });
});

test('a mod name containing a semicolon survives', () => {
  const { progress } = parseSplashMessage('#progress1;2;Weird;Name');
  assert.equal(progress.mod, 'Weird;Name');
});

test('the finish line carries its own prose', () => {
  const { text, progress } = parseSplashMessage('#finish0;Almost done...');
  assert.equal(text, 'Almost done...');
  assert.deepEqual(progress, { loaded: 0, total: 0, done: true });
});

test('#stop closes the splash', () => {
  assert.deepEqual(parseSplashMessage('#stop'), { text: null });
});

test('anything that is not the protocol is passed through', () => {
  assert.deepEqual(parseSplashMessage('Loading Celeste'), { text: 'Loading Celeste' });
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { settingsWithWindowScale, windowScaleFor } from '../dist/celeste/celeste.sdk.js';

// The browser build pins the window to WindowScale × 320 by WindowScale × 180
// (upstream patcher/WindowedHook.cs), so the resolution the page asks for can
// only ever be a whole multiple of the gameplay buffer.

test('the scale is the largest whole multiple that fits', () => {
  assert.equal(windowScaleFor(1920, 1080), 6);
  assert.equal(windowScaleFor(1280, 720), 4);
  // 960×540 fits three times over; the extra width buys nothing without the
  // height to go with it.
  assert.equal(windowScaleFor(1600, 540), 3);
});

test('a box smaller than the gameplay buffer still renders', () => {
  assert.equal(windowScaleFor(200, 100), 1);
  assert.equal(windowScaleFor(0, 0), 1);
});

// The game composes every frame into a 1922×1082 target before it reaches the
// window, so 6 (1920×1080) is the last scale that shows anything more.
test('the scale is capped at 1080p', () => {
  assert.equal(windowScaleFor(2560, 1440), 6);
  assert.equal(windowScaleFor(3840, 2160), 6);
});

test('a first run writes the one line', () => {
  assert.equal(settingsWithWindowScale(null, 6), 'WindowScale: 6\n');
});

test('an existing scale is replaced where it stands', () => {
  const before = 'Language: english\nWindowScale: 3\nVSync: true\n';
  assert.equal(
    settingsWithWindowScale(before, 6),
    'Language: english\nWindowScale: 6\nVSync: true\n',
  );
});

test("the player's other settings survive untouched", () => {
  const before = 'Language: english\nMusicVolume: 7\n';
  assert.equal(settingsWithWindowScale(before, 4), 'Language: english\nMusicVolume: 7\nWindowScale: 4\n');
});

test('a file with no trailing newline gains one', () => {
  assert.equal(settingsWithWindowScale('Language: english', 4), 'Language: english\nWindowScale: 4\n');
});

test('only a key of its own is rewritten', () => {
  // Everest adds settings of its own, and a substring match would corrupt them.
  const before = 'CelesteNetWindowScale: 2\nWindowScale: 2\n';
  assert.equal(settingsWithWindowScale(before, 5), 'CelesteNetWindowScale: 2\nWindowScale: 5\n');
});

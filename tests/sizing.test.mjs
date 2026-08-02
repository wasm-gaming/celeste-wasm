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

// `settings.celeste` is what `XmlSerializer` wrote — Celeste's own settings are
// XML, unlike Everest's *mod* settings, which are YAML. A document that does not
// parse is not a document the game repairs: it starts from its defaults, which
// is the player's language, bindings and volumes gone.

/** What the game writes, near enough: the shape and the indentation are its. */
const settingsFile = (body) =>
  '<?xml version="1.0"?>\n' +
  '<Settings xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' +
  body +
  '</Settings>\n';

test('a first run writes a document the game can read', () => {
  assert.equal(settingsWithWindowScale(null, 6), settingsFile('  <WindowScale>6</WindowScale>\n'));
});

test('an existing scale is replaced where it stands', () => {
  const body = (scale) =>
    `  <Language>spanish</Language>\n  <WindowScale>${scale}</WindowScale>\n  <VSync>true</VSync>\n`;
  assert.equal(settingsWithWindowScale(settingsFile(body(3)), 6), settingsFile(body(6)));
});

test("the player's other settings survive untouched", () => {
  const before = settingsFile('  <Language>spanish</Language>\n  <MusicVolume>7</MusicVolume>\n');
  assert.equal(
    settingsWithWindowScale(before, 4),
    settingsFile(
      '  <Language>spanish</Language>\n  <MusicVolume>7</MusicVolume>\n  <WindowScale>4</WindowScale>\n',
    ),
  );
});

test('an empty element is filled in rather than doubled', () => {
  const before = settingsFile('  <WindowScale />\n');
  assert.equal(settingsWithWindowScale(before, 5), settingsFile('  <WindowScale>5</WindowScale>\n'));
});

test('a document written flat keeps its shape', () => {
  const before = '<Settings><Language>spanish</Language></Settings>';
  assert.equal(
    settingsWithWindowScale(before, 2),
    '<Settings><Language>spanish</Language><WindowScale>2</WindowScale></Settings>',
  );
});

test('the YAML line older versions appended is taken back out', () => {
  // Up to 0.1.4 this package wrote Everest's mod-settings syntax into Celeste's
  // own file. After `</Settings>` it is content past the root element, so the
  // game read no settings at all and started from its defaults every time.
  const body = '  <Language>spanish</Language>\n  <WindowScale>3</WindowScale>\n';
  assert.equal(
    settingsWithWindowScale(`${settingsFile(body)}WindowScale: 6\n`, 6),
    settingsFile('  <Language>spanish</Language>\n  <WindowScale>6</WindowScale>\n'),
  );
});

test('a file that is nothing but the old line becomes a document', () => {
  assert.equal(settingsWithWindowScale('WindowScale: 6\n', 4), settingsFile('  <WindowScale>4</WindowScale>\n'));
});

test('only the element itself is rewritten', () => {
  // A substring match would corrupt whatever else carries the name.
  const before = settingsFile('  <CelesteNetWindowScale>2</CelesteNetWindowScale>\n  <WindowScale>2</WindowScale>\n');
  assert.equal(
    settingsWithWindowScale(before, 5),
    settingsFile('  <CelesteNetWindowScale>2</CelesteNetWindowScale>\n  <WindowScale>5</WindowScale>\n'),
  );
});

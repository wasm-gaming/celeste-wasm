import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BLOCK, guardPath, readTar, tarStream } from '../dist/celeste/celeste.tar.js';

// ------------------------------------------------------------------ helpers --

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);

/** The sources `tarStream` takes, from `{ path: 'contents' }`. */
function sources(files) {
  return Object.entries(files).map(([path, contents]) => {
    const bytes = encode(contents);
    return {
      path,
      size: bytes.length,
      body: () => new Blob([bytes]).stream(),
    };
  });
}

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

/** Unpack an archive back into `{ path: contents }`. */
async function unpack(archive) {
  const out = {};
  for await (const entry of readTar(new Blob([archive]).stream())) {
    out[entry.path] = decode(await collect(entry.body));
  }
  return out;
}

const SAVES = {
  '0.celeste': 'AreaKey: 1\nTime: 12345\n',
  '1.celeste': 'AreaKey: 2\n',
  'settings.celeste': 'WindowScale: 6\n',
  'sync/0-modsave-SpeedrunTool.celeste': 'Enabled: true\n',
};

// ------------------------------------------------------------- the round trip --

test('what goes in comes back out', async () => {
  const archive = await collect(tarStream(sources(SAVES)));
  assert.deepEqual(await unpack(archive), SAVES);
});

test('an empty archive is still a valid one', async () => {
  const archive = await collect(tarStream([]));
  assert.equal(archive.length, BLOCK * 2);
  assert.ok(archive.every((byte) => byte === 0));
  assert.deepEqual(await unpack(archive), {});
});

test('a file that is an exact multiple of the block size gets no padding', async () => {
  const body = 'x'.repeat(BLOCK);
  const archive = await collect(tarStream(sources({ 'exact.celeste': body })));

  // header + body + the two closing blocks, and nothing else.
  assert.equal(archive.length, BLOCK * 4);
  assert.deepEqual(await unpack(archive), { 'exact.celeste': body });
});

test('an empty file survives the trip', async () => {
  const archive = await collect(tarStream(sources({ 'new.celeste': '' })));
  assert.deepEqual(await unpack(archive), { 'new.celeste': '' });
});

test('bodies larger than one chunk are streamed through intact', async () => {
  const body = 'celeste'.repeat(50_000); // ~350 KB, many reads
  const archive = await collect(tarStream(sources({ 'big.celeste': body })));
  assert.deepEqual(await unpack(archive), { 'big.celeste': body });
});

// ----------------------------------------------------------------- the format --

test('the header says ustar, and the checksum agrees', async () => {
  const archive = await collect(tarStream(sources({ 'a.celeste': 'x' })));

  assert.equal(decode(archive.subarray(0, 9)), 'a.celeste');
  assert.equal(decode(archive.subarray(257, 263)), 'ustar\0');
  assert.equal(archive[156], 0x30); // a regular file

  let sum = 0;
  for (let at = 0; at < BLOCK; at++) {
    sum += at >= 148 && at < 156 ? 0x20 : archive[at];
  }
  assert.equal(Number.parseInt(decode(archive.subarray(148, 154)), 8), sum);
});

test('a damaged header is refused rather than unpacked', async () => {
  const archive = await collect(tarStream(sources({ 'a.celeste': 'x' })));
  archive[2] = 0x5a; // change the name, leave the checksum

  await assert.rejects(() => unpack(archive), /not a tar archive, or it is damaged/);
});

test('a truncated archive is refused rather than half-restored', async () => {
  const archive = await collect(tarStream(sources({ 'a.celeste': 'hello' })));
  await assert.rejects(() => unpack(archive.subarray(0, BLOCK + 2)), /ends/);
});

test('a long path is split across name and prefix', async () => {
  const directory = 'nested'.padEnd(120, 'x');
  const path = `${directory}/save.celeste`;

  const archive = await collect(tarStream(sources({ [path]: 'deep' })));
  assert.equal(decode(archive.subarray(0, 13)), 'save.celeste\0');
  assert.equal(decode(archive.subarray(345, 345 + directory.length)), directory);
  assert.deepEqual(await unpack(archive), { [path]: 'deep' });
});

test('a path too long for any split is refused, not truncated', async () => {
  const path = 'a'.repeat(300);
  await assert.rejects(() => collect(tarStream(sources({ [path]: 'x' }))), /too long/);
});

// -------------------------------------------------------------------- safety --

test('paths that climb out of the archive are refused', () => {
  assert.throws(() => guardPath('../../etc/passwd'), /climbs out/);
  assert.throws(() => guardPath('saves/../../x'), /climbs out/);
  assert.throws(() => guardPath('/etc/passwd'), /not a relative path/);
  assert.throws(() => guardPath('C:/Windows/x'), /not a relative path/);
  assert.throws(() => guardPath(''), /not a relative path/);
});

test('a hostile path is refused on the way in as well as out', async () => {
  // Hand-built, because the writer would not produce one.
  const archive = await collect(tarStream(sources({ 'a.celeste': 'x' })));
  const evil = encode('../../../escape');
  archive.fill(0, 0, 100);
  archive.set(evil, 0);

  // Fix the checksum, so it is the path check that has to catch this.
  archive.fill(0x20, 148, 156);
  let sum = 0;
  for (let at = 0; at < BLOCK; at++) sum += archive[at];
  archive.set(encode(sum.toString(8).padStart(6, '0')), 148);
  archive[154] = 0;
  archive[155] = 0x20;

  await assert.rejects(() => unpack(archive), /climbs out/);
});

// ------------------------------------------------------------------ the sizes --

test('a body that does not match its header is refused', async () => {
  const lying = [
    {
      path: 'a.celeste',
      size: 100, // the header will say 100…
      body: () => new Blob([encode('short')]).stream(), // …and this is 5.
    },
  ];
  await assert.rejects(() => collect(tarStream(lying)), /changed size while it was being archived/);
});

// ------------------------------------------------------------------ interop --
//
// The point of writing tar rather than reusing the zip reader next door is that
// the archive leaves the browser: it lands in someone's Drive, and one day
// someone unpacks it with whatever they have. Round-tripping through our own
// reader would not catch a header this package is simply wrong about — only
// something that did not come from here can.

const HAS_TAR = (() => {
  try {
    execFileSync('tar', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('system tar reads what we write, and we read what it writes', { skip: !HAS_TAR }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'celeste-tar-'));
  try {
    // Ours → tar.
    writeFileSync(join(dir, 'mine.tar'), await collect(tarStream(sources(SAVES))));
    execFileSync('tar', ['-xf', 'mine.tar'], { cwd: dir });

    for (const [path, contents] of Object.entries(SAVES)) {
      assert.equal(readFileSync(join(dir, path), 'utf8'), contents, path);
    }

    // tar → ours.
    const source = join(dir, 'src');
    for (const [path, contents] of Object.entries(SAVES)) {
      const full = join(source, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents);
    }
    execFileSync('tar', ['-cf', join(dir, 'theirs.tar'), '-C', source, '.'], { cwd: dir });

    const read = {};
    for await (const entry of readTar(new Blob([readFileSync(join(dir, 'theirs.tar'))]).stream())) {
      // bsdtar puts an AppleDouble sidecar next to every file on macOS. They
      // are real entries, correctly read — just not ours.
      const path = entry.path.replace(/^\.\//, '');
      if (path.startsWith('._') || path.includes('/._')) continue;
      read[path] = decode(await collect(entry.body));
    }
    assert.deepEqual(read, SAVES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('records that are not regular files are skipped', async () => {
  const archive = await collect(tarStream(sources({ 'a.celeste': 'x' })));

  // Turn the entry into a directory record, which carries no data.
  const directory = new Uint8Array(archive);
  directory[156] = 0x35; // '5'
  directory.fill(0x20, 148, 156);
  let sum = 0;
  for (let at = 0; at < BLOCK; at++) sum += directory[at];
  directory.set(encode(sum.toString(8).padStart(6, '0')), 148);
  directory[154] = 0;
  directory[155] = 0x20;

  assert.deepEqual(await unpack(directory), {});
});

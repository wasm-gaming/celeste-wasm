// Building the archives the zip tests read rather than checking one in keeps
// them honest about the format: every offset the reader follows is one this
// file wrote. Shared with the staging tests, which need a real archive to
// unpack.
//
// Not a .test.mjs, so the runner does not collect it.

import { deflateRawSync } from 'node:zlib';

import { DEFLATED, STORED } from '../dist/celeste/celeste.zip.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {Array<{name: string, data?: Uint8Array, method?: number, localExtra?: number}>} entries
 */
export function buildZip(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const raw = entry.data ?? new Uint8Array(0);
    const method = entry.method ?? STORED;
    const stored = method === DEFLATED ? new Uint8Array(deflateRawSync(raw)) : raw;
    // Local headers are allowed to carry extra fields the central directory
    // does not, which is exactly why the reader re-reads the local header
    // instead of trusting a fixed offset.
    const localExtra = new Uint8Array(entry.localExtra ?? 0);

    const local = new Uint8Array(30 + name.length + localExtra.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(8, method, true);
    view.setUint32(14, crc32(raw), true);
    view.setUint32(18, stored.length, true);
    view.setUint32(22, raw.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, localExtra.length, true);
    local.set(name, 30);
    local.set(localExtra, 30 + name.length);

    const header = new Uint8Array(46 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(6, 20, true);
    headerView.setUint16(10, method, true);
    headerView.setUint32(16, crc32(raw), true);
    headerView.setUint32(20, stored.length, true);
    headerView.setUint32(24, raw.length, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint32(42, offset, true);
    header.set(name, 46);

    parts.push(local, stored);
    central.push(header);
    offset += local.length + stored.length;
  }

  const centralSize = central.reduce((total, header) => total + header.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  return Buffer.concat([...parts, ...central, eocd].map((part) => Buffer.from(part)));
}

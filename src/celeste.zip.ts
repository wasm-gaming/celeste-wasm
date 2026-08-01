// A zip reader, because the player's Celeste arrives as one.
//
// The SDK has to unpack a game install (~1.3 GB) and an Everest build into the
// runtime's OPFS root before the loader can see them. Doing that with a
// dependency would put a bundler between the host and this package, so it is
// done here instead: the central directory is parsed off a `Blob` and each
// entry is inflated through `DecompressionStream('deflate-raw')`, which every
// browser that can run the runtime already has.
//
// Reading from a `Blob` rather than a `Uint8Array` is what keeps this viable —
// entries are sliced out one at a time, so a 1.3 GB archive never has to be
// resident.

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Zip's "this value lives in the zip64 extra field" sentinel. */
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

/** Maximum EOCD size: the 22-byte record plus a 64 KB comment. */
const EOCD_SEARCH_BYTES = 22 + U16_MAX;

export const STORED = 0;
export const DEFLATED = 8;

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  /** Compression method: 0 stored, 8 deflate. Anything else cannot be read. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  /** Offset of the local file header, not of the data. */
  localHeaderOffset: number;
  /** Directory entries carry no data and are recognised by the trailing slash. */
  isDirectory: boolean;
}

/** Random-access byte source. A `Blob` reads lazily; a `Uint8Array` does not. */
interface ByteSource {
  readonly size: number;
  slice(start: number, end: number): Promise<Uint8Array>;
  stream(start: number, end: number): Promise<ReadableStream<Uint8Array>>;
}

function sourceOf(input: Blob | Uint8Array | ArrayBuffer): ByteSource {
  if (input instanceof Blob) {
    return {
      size: input.size,
      async slice(start, end) {
        return new Uint8Array(await input.slice(start, end).arrayBuffer());
      },
      async stream(start, end) {
        return input.slice(start, end).stream() as ReadableStream<Uint8Array>;
      },
    };
  }

  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return {
    size: bytes.length,
    async slice(start, end) {
      return bytes.subarray(start, end);
    },
    async stream(start, end) {
      const chunk = bytes.subarray(start, end);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      });
    },
  };
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Entry names are UTF-8 when the language-encoding flag is set and CP437
 * otherwise. Every archiver in use writes UTF-8 for anything outside ASCII, and
 * a mis-decoded accent in a filename is not worth a code-page table, so this
 * decodes as UTF-8 and lets invalid sequences become replacement characters.
 */
const decoder = new TextDecoder('utf-8');

export class ZipReader {
  private constructor(
    private readonly source: ByteSource,
    /** Every entry in the central directory, in the order it was written. */
    readonly entries: ZipEntry[],
  ) {}

  static async open(input: Blob | Uint8Array | ArrayBuffer): Promise<ZipReader> {
    const source = sourceOf(input);
    const { offset, size, count } = await readEndOfCentralDirectory(source);
    const central = await source.slice(offset, offset + size);
    return new ZipReader(source, parseCentralDirectory(central, count));
  }

  /** The entry at `name`, or `null`. Names are matched exactly. */
  get(name: string): ZipEntry | null {
    return this.entries.find((entry) => entry.name === name) ?? null;
  }

  /** Inflate an entry into memory. */
  async read(entry: ZipEntry): Promise<Uint8Array> {
    const stream = await this.stream(entry);
    const chunks: Uint8Array[] = [];
    let total = 0;

    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.length;
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /**
   * Inflate an entry as a stream, so a 200 MB asset can be written straight
   * through to storage.
   */
  async stream(entry: ZipEntry): Promise<ReadableStream<Uint8Array>> {
    if (entry.isDirectory) {
      throw new Error(`celeste/zip: "${entry.name}" is a directory`);
    }
    if (entry.method !== STORED && entry.method !== DEFLATED) {
      throw new Error(
        `celeste/zip: "${entry.name}" uses compression method ${entry.method}; only stored and deflate are supported`,
      );
    }

    const start = await this.dataOffset(entry);
    const raw = await this.source.stream(start, start + entry.compressedSize);
    if (entry.method === STORED) return raw;
    // `DecompressionStream` accepts any BufferSource, which lib.dom models as a
    // writable side too wide to line up with a Uint8Array stream.
    const inflate = new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
    return raw.pipeThrough(inflate);
  }

  /**
   * Where an entry's bytes begin. The central directory records the local
   * header offset, and the local header's own name/extra lengths are the only
   * reliable way to skip past it — they are allowed to differ from the central
   * copy.
   */
  private async dataOffset(entry: ZipEntry): Promise<number> {
    const header = await this.source.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30);
    const view = viewOf(header);
    if (view.getUint32(0, true) !== LOCAL_SIGNATURE) {
      throw new Error(`celeste/zip: no local header for "${entry.name}"`);
    }
    return entry.localHeaderOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  }
}

async function readEndOfCentralDirectory(
  source: ByteSource,
): Promise<{ offset: number; size: number; count: number }> {
  const searchFrom = Math.max(0, source.size - EOCD_SEARCH_BYTES);
  const tail = await source.slice(searchFrom, source.size);
  const view = viewOf(tail);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('celeste/zip: not a zip archive (no end-of-central-directory record)');
  }

  let count = view.getUint16(eocd + 10, true);
  let size = view.getUint32(eocd + 12, true);
  let offset = view.getUint32(eocd + 16, true);

  // Any of the three saturating means the real values are in the zip64 record,
  // which a Celeste install zip is big enough to need.
  if (count === U16_MAX || size === U32_MAX || offset === U32_MAX) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new Error('celeste/zip: archive needs zip64 but has no zip64 locator');
    }
    const zip64At = Number(view.getBigUint64(locator + 8, true));
    const record = await source.slice(zip64At, zip64At + 56);
    const zip64 = viewOf(record);
    if (zip64.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) {
      throw new Error('celeste/zip: zip64 locator points at something else');
    }
    count = Number(zip64.getBigUint64(32, true));
    size = Number(zip64.getBigUint64(40, true));
    offset = Number(zip64.getBigUint64(48, true));
  }

  return { offset, size, count };
}

function parseCentralDirectory(central: Uint8Array, count: number): ZipEntry[] {
  const view = viewOf(central);
  const entries: ZipEntry[] = [];
  let cursor = 0;

  for (let i = 0; i < count; i++) {
    if (cursor + 46 > central.length || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`celeste/zip: malformed central directory at entry ${i}`);
    }

    const method = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);

    const name = decoder.decode(central.subarray(cursor + 46, cursor + 46 + nameLength));

    let compressedSize = view.getUint32(cursor + 20, true);
    let uncompressedSize = view.getUint32(cursor + 24, true);
    let localHeaderOffset = view.getUint32(cursor + 42, true);

    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX || localHeaderOffset === U32_MAX) {
      const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
      const zip64 = readZip64Extra(extra);
      if (!zip64) {
        throw new Error(`celeste/zip: "${name}" needs a zip64 extra field but has none`);
      }
      // The zip64 field holds only the values that saturated, in this order.
      let at = 0;
      if (uncompressedSize === U32_MAX) {
        uncompressedSize = Number(zip64.getBigUint64(at, true));
        at += 8;
      }
      if (compressedSize === U32_MAX) {
        compressedSize = Number(zip64.getBigUint64(at, true));
        at += 8;
      }
      if (localHeaderOffset === U32_MAX) {
        localHeaderOffset = Number(zip64.getBigUint64(at, true));
      }
    }

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      crc32,
      localHeaderOffset,
      isDirectory: name.endsWith('/'),
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readZip64Extra(extra: Uint8Array): DataView | null {
  const view = viewOf(extra);
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (id === 0x0001) {
      return viewOf(extra.subarray(cursor + 4, cursor + 4 + size));
    }
    cursor += 4 + size;
  }
  return null;
}

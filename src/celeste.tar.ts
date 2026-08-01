// Tar, as a stream in both directions.
//
// Why tar, with a perfectly good zip reader next door: this is the format that
// crosses the network, and a zip cannot be finished until its central directory
// is written at the end. Producing one means either buffering the whole archive
// or seeking back over it, and neither is available to a page piping storage
// into an upload. Tar is a pure stream — header, bytes, padding, repeat — so an
// archive can be generated straight out of OPFS and consumed the same way
// coming back, without ever being resident.
//
// This is USTAR: the subset every extractor since 1988 understands. No GNU
// extensions, no pax records. Paths longer than a header can hold are rejected
// rather than encoded in a way something on the other end might not read.

/** Everything in a tar is a whole number of these. */
export const BLOCK = 512;

const NAME_MAX = 100;
const PREFIX_MAX = 155;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A file to put in an archive. `size` has to be right: it goes in the header. */
export interface TarSource {
  /** Path inside the archive. Relative, with no `..` segment. */
  path: string;
  size: number;
  body(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
}

/** A file found in an archive. */
export interface TarEntry {
  path: string;
  size: number;
  /**
   * The entry's bytes. Read it before advancing the iterator — one reader runs
   * underneath the whole archive, and the next header is behind these bytes.
   * Whatever is left unread is skipped for you.
   */
  body: ReadableStream<Uint8Array>;
}

function streamFrom(source: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await source.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      void source.return?.(reason);
    },
  });
}

/**
 * A path an archive is allowed to carry.
 *
 * Import writes into the directory the game reads its saves from, so an entry
 * that escapes it is the whole attack. Checked on the way out too: an archive
 * this package produced should never be the thing that fails to import.
 */
export function guardPath(path: string): void {
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new Error(`celeste: "${path}" is not a relative path`);
  }
  if (path.split('/').includes('..')) {
    throw new Error(`celeste: "${path}" climbs out of the archive`);
  }
}

/** Octal, NUL-terminated, in a field of `length` bytes. */
function octal(value: number, length: number): string {
  const digits = value.toString(8);
  if (digits.length > length - 1) {
    throw new Error(`celeste: ${value} does not fit in a ${length}-byte tar field`);
  }
  return `${digits.padStart(length - 1, '0')}\0`;
}

/**
 * A path across the header's two name fields.
 *
 * USTAR stores up to 100 bytes in `name` and can put a leading directory in
 * `prefix`, for 255 across the two — but only split on a separator. The first
 * split that leaves a short enough name is the one taken.
 */
function splitName(path: string): { name: string; prefix: string } {
  if (encoder.encode(path).length <= NAME_MAX) return { name: path, prefix: '' };

  for (let at = path.indexOf('/'); at !== -1; at = path.indexOf('/', at + 1)) {
    const prefix = path.slice(0, at);
    const name = path.slice(at + 1);
    if (
      encoder.encode(prefix).length <= PREFIX_MAX &&
      encoder.encode(name).length <= NAME_MAX
    ) {
      return { name, prefix };
    }
  }

  throw new Error(
    `celeste: "${path}" is too long for a tar header — ${NAME_MAX} bytes, or ${NAME_MAX + PREFIX_MAX} split on a directory`,
  );
}

function header(path: string, size: number, mtime: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, at: number, max: number): void => {
    const bytes = encoder.encode(text);
    if (bytes.length > max) throw new Error(`celeste: "${text}" overflows its tar field`);
    block.set(bytes, at);
  };

  const { name, prefix } = splitName(path);
  put(name, 0, NAME_MAX);
  put(octal(0o644, 8), 100, 8); // mode
  put(octal(0, 8), 108, 8); // uid
  put(octal(0, 8), 116, 8); // gid
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  // The checksum is computed over a header whose checksum field is spaces.
  block.fill(0x20, 148, 156);
  block[156] = 0x30; // '0' — a regular file
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, PREFIX_MAX);

  let sum = 0;
  for (const byte of block) sum += byte;
  // Six digits and a NUL, then the space the field was filled with.
  put(octal(sum, 7), 148, 7);
  block[155] = 0x20;

  return block;
}

/**
 * Pack files into an archive.
 *
 * Nothing is buffered: each entry's body is read a chunk at a time and passed
 * straight through, so the peak cost is one chunk regardless of how big the
 * archive gets.
 */
export function tarStream(
  entries: Iterable<TarSource> | AsyncIterable<TarSource>,
): ReadableStream<Uint8Array> {
  async function* blocks(): AsyncGenerator<Uint8Array> {
    const mtime = Math.floor(Date.now() / 1000);

    for await (const entry of entries as AsyncIterable<TarSource>) {
      guardPath(entry.path);
      yield header(entry.path, entry.size, mtime);

      let written = 0;
      const reader = (await entry.body()).getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          written += value.length;
          if (written > entry.size) break;
          yield value;
        }
      } finally {
        reader.releaseLock();
      }

      // The header has already gone out with the old size, so there is no
      // recovering from this — and a save file that grew mid-archive means the
      // game is still writing to it.
      if (written !== entry.size) {
        throw new Error(
          `celeste: "${entry.path}" changed size while it was being archived — ${written} bytes, header says ${entry.size}. Something is still writing to it.`,
        );
      }

      const padding = (BLOCK - (written % BLOCK)) % BLOCK;
      if (padding) yield new Uint8Array(padding);
    }

    // Two zero blocks are how a tar says it is over.
    yield new Uint8Array(BLOCK * 2);
  }

  return streamFrom(blocks());
}

/** Buffered reads over a byte stream, which is what parsing records needs. */
class ByteStream {
  private pending = new Uint8Array(0);
  private ended = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const { done, value } = await this.reader.read();
    if (done) {
      this.ended = true;
      return false;
    }
    if (value?.length) {
      const next = new Uint8Array(this.pending.length + value.length);
      next.set(this.pending);
      next.set(value, this.pending.length);
      this.pending = next;
    }
    return true;
  }

  /** Exactly `n` bytes. `null` when the stream ended cleanly on a boundary. */
  async exact(n: number): Promise<Uint8Array | null> {
    while (this.pending.length < n) {
      if (!(await this.fill())) {
        if (this.pending.length === 0) return null;
        throw new Error('celeste: the archive ends in the middle of a record');
      }
    }
    const out = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return out;
  }

  /** Up to `n` bytes, as soon as there are any. `null` at the end. */
  async some(n: number): Promise<Uint8Array | null> {
    while (this.pending.length === 0) {
      if (!(await this.fill())) return null;
    }
    const take = Math.min(n, this.pending.length);
    const out = this.pending.subarray(0, take);
    this.pending = this.pending.subarray(take);
    return out;
  }

  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      const chunk = await this.some(left);
      if (!chunk) return;
      left -= chunk.length;
    }
  }
}

function readString(block: Uint8Array, at: number, length: number): string {
  const field = block.subarray(at, at + length);
  const end = field.indexOf(0);
  return decoder.decode(end === -1 ? field : field.subarray(0, end));
}

function readOctal(block: Uint8Array, at: number, length: number): number {
  const text = readString(block, at, length).trim();
  if (!text) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`celeste: "${text}" is not a tar number field`);
  }
  return value;
}

/**
 * A header block is only a header if its checksum agrees.
 *
 * Worth the check: the failure it catches is an archive that lost alignment
 * somewhere, and the alternative to noticing is unpacking its noise into the
 * player's save directory.
 */
function verifyChecksum(block: Uint8Array): void {
  const claimed = readOctal(block, 148, 8);
  let sum = 0;
  for (let at = 0; at < BLOCK; at++) {
    sum += at >= 148 && at < 156 ? 0x20 : block[at];
  }
  if (sum !== claimed) {
    throw new Error('celeste: this is not a tar archive, or it is damaged (header checksum)');
  }
}

/**
 * Walk an archive.
 *
 * Directory and link records are skipped: the paths carry their own
 * directories, so a writer that creates parents as it goes needs nothing else.
 */
export async function* readTar(
  archive: ReadableStream<Uint8Array>,
): AsyncGenerator<TarEntry> {
  const bytes = new ByteStream(archive.getReader());

  for (;;) {
    const head = await bytes.exact(BLOCK);
    if (!head) return;
    if (head.every((byte) => byte === 0)) return;

    verifyChecksum(head);

    const name = readString(head, 0, NAME_MAX);
    const prefix = readString(head, 345, PREFIX_MAX);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(head, 124, 12);
    const type = head[156];
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;

    // '0' and NUL both mean a regular file; anything else carries no bytes this
    // needs — and '5' (a directory) has a size of zero anyway.
    if (type !== 0x30 && type !== 0x00) {
      await bytes.skip(size + padding);
      continue;
    }

    guardPath(path);

    let left = size;
    const body = streamFrom(
      (async function* (): AsyncGenerator<Uint8Array> {
        while (left > 0) {
          const chunk = await bytes.some(left);
          if (!chunk) throw new Error(`celeste: the archive ends inside "${path}"`);
          left -= chunk.length;
          yield chunk;
        }
      })(),
    );

    yield { path, size, body };

    // A consumer that took less than the whole entry would otherwise leave the
    // next header behind the bytes it skipped.
    await bytes.skip(left + padding);
  }
}

// XXH64, the digest Everest uses to fingerprint mod archives.
//
// The loader declares `XXHash64_Fast` as a JS import (Celeste.cs) and calls out
// to the host for it: hashing a multi-hundred-megabyte mod folder through the
// interpreter is slow enough to be worth doing in JS, where the bytes already
// live. If the import is missing the call throws, so the SDK always registers
// this implementation.
//
// Reference: https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md

const MASK = (1n << 64n) - 1n;

const PRIME1 = 11400714785074694791n;
const PRIME2 = 14029467366897019727n;
const PRIME3 = 1609587929392839161n;
const PRIME4 = 9650029242287828579n;
const PRIME5 = 2870177450012600261n;

const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK;
const add = (a: bigint, b: bigint): bigint => (a + b) & MASK;

function rotl(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & MASK;
}

function round(acc: bigint, input: bigint): bigint {
  return mul(rotl(add(acc, mul(input, PRIME2)), 31n), PRIME1);
}

function mergeRound(acc: bigint, value: bigint): bigint {
  return add(mul(acc ^ round(0n, value), PRIME1), PRIME4);
}

function avalanche(hash: bigint): bigint {
  let h = hash;
  h = mul(h ^ (h >> 33n), PRIME2);
  h = mul(h ^ (h >> 29n), PRIME3);
  return h ^ (h >> 32n);
}

/**
 * Incremental XXH64.
 *
 * Streaming matters here: a mod archive can be hundreds of megabytes, and the
 * SDK hashes it straight off a `ReadableStream` rather than materialising it.
 */
export class XXH64 {
  private v1: bigint;
  private v2: bigint;
  private v3: bigint;
  private v4: bigint;
  private readonly seed: bigint;
  /** Bytes that did not fill a 32-byte stripe yet. */
  private readonly buffer = new Uint8Array(32);
  private buffered = 0;
  private total = 0n;

  constructor(seed: bigint | number = 0n) {
    this.seed = BigInt(seed) & MASK;
    this.v1 = add(add(this.seed, PRIME1), PRIME2);
    this.v2 = add(this.seed, PRIME2);
    this.v3 = this.seed;
    this.v4 = (this.seed - PRIME1) & MASK;
  }

  update(chunk: Uint8Array): this {
    this.total += BigInt(chunk.length);

    let offset = 0;

    if (this.buffered > 0) {
      const wanted = Math.min(32 - this.buffered, chunk.length);
      this.buffer.set(chunk.subarray(0, wanted), this.buffered);
      this.buffered += wanted;
      offset = wanted;
      if (this.buffered < 32) return this;
      this.stripe(new DataView(this.buffer.buffer, this.buffer.byteOffset, 32), 0);
      this.buffered = 0;
    }

    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (; offset + 32 <= chunk.length; offset += 32) {
      this.stripe(view, offset);
    }

    if (offset < chunk.length) {
      this.buffer.set(chunk.subarray(offset), 0);
      this.buffered = chunk.length - offset;
    }
    return this;
  }

  private stripe(view: DataView, offset: number): void {
    this.v1 = round(this.v1, view.getBigUint64(offset, true));
    this.v2 = round(this.v2, view.getBigUint64(offset + 8, true));
    this.v3 = round(this.v3, view.getBigUint64(offset + 16, true));
    this.v4 = round(this.v4, view.getBigUint64(offset + 24, true));
  }

  digest(): bigint {
    let hash: bigint;

    if (this.total >= 32n) {
      hash = add(
        add(rotl(this.v1, 1n), rotl(this.v2, 7n)),
        add(rotl(this.v3, 12n), rotl(this.v4, 18n)),
      );
      hash = mergeRound(hash, this.v1);
      hash = mergeRound(hash, this.v2);
      hash = mergeRound(hash, this.v3);
      hash = mergeRound(hash, this.v4);
    } else {
      hash = add(this.seed, PRIME5);
    }

    hash = add(hash, this.total & MASK);

    const tail = this.buffer.subarray(0, this.buffered);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let offset = 0;

    for (; offset + 8 <= tail.length; offset += 8) {
      hash = add(mul(rotl(hash ^ round(0n, view.getBigUint64(offset, true)), 27n), PRIME1), PRIME4);
    }

    if (offset + 4 <= tail.length) {
      hash = add(mul(rotl(hash ^ mul(BigInt(view.getUint32(offset, true)), PRIME1), 23n), PRIME2), PRIME3);
      offset += 4;
    }

    for (; offset < tail.length; offset++) {
      hash = mul(rotl(hash ^ mul(BigInt(tail[offset]!), PRIME5), 11n), PRIME1);
    }

    return avalanche(hash);
  }

  /** Big-endian bytes of the digest, the order the loader's marshaller expects. */
  digestBytes(): Uint8Array {
    const hash = this.digest();
    const bytes = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
      bytes[i] = Number((hash >> BigInt((7 - i) * 8)) & 0xffn);
    }
    return bytes;
  }

  /** Uppercase 16-digit hex, the form Everest prints. */
  digestHex(): string {
    return this.digest().toString(16).toUpperCase().padStart(16, '0');
  }
}

export function xxh64(data: Uint8Array, seed: bigint | number = 0n): bigint {
  return new XXH64(seed).update(data).digest();
}

/** Hash a stream without holding it in memory. */
export async function xxh64Stream(
  stream: ReadableStream<Uint8Array>,
  seed: bigint | number = 0n,
): Promise<XXH64> {
  const hash = new XXH64(seed);
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) hash.update(value);
  }
  return hash;
}

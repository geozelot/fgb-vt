/**
 * Mutation fuzzing of the header, index and feature decoders through the
 * whole tile pipeline.
 *
 * Real fixtures are corrupted with seeded random mutations (bit flips,
 * random bytes, boundary values at size prefixes and offsets, truncation)
 * and tiled. Every outcome must be either a valid MVT tile or an
 * `FgbVtError`; anything else (TypeError, RangeError from typed arrays,
 * plain Error, a hang) is a bug.
 *
 * Set FUZZ_ITERATIONS to run longer (default 150 per fixture), and
 * FUZZ_SEED to reproduce a run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { tile } from '../src/tile.js';
import type { Connector, ReadHeadResult, ReadOptions } from '../src/connectors/connector.js';
import { FgbVtError } from '../src/errors.js';
import { parseHeader } from '../src/fgb/header.js';
import { fixture, tileAt } from './helpers/tiles.js';
import { validateMvt } from './helpers/mvt-validate.js';

const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 150);
const SEED = Number(process.env.FUZZ_SEED ?? 20261104);

/** Connector serving byte arrays from memory. */
class MemoryConnector implements Connector {
  constructor(private readonly files: Map<string, Uint8Array>) {}
  private bytes(path: string): Uint8Array {
    const b = this.files.get(path);
    if (!b) throw new Error(`no such file ${path}`);
    return b;
  }
  async readHead(path: string, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    options?.signal?.throwIfAborted();
    const b = this.bytes(path);
    return { bytes: b.slice(0, length), size: b.length, etag: null };
  }
  async read(path: string, offset: number, length: number, options?: ReadOptions): Promise<Uint8Array> {
    options?.signal?.throwIfAborted();
    return this.bytes(path).slice(offset, offset + length);
  }
  async readRanges(path: string, ranges: ReadonlyArray<{ offset: number; length: number }>, options?: ReadOptions) {
    return Promise.all(ranges.map(r => this.read(path, r.offset, r.length, options)));
  }
  async close() {}
}

/** Deterministic PRNG (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n) };
}

const BOUNDARY = [0, 1, 2, 3, 4, 7, 8, 0x7f, 0x80, 0xff, 0x7fff, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff];

/** Apply 1–3 random mutations, biased towards the header and index. */
function mutate(original: Uint8Array, rand: ReturnType<typeof prng>): Uint8Array {
  let bytes = original.slice();
  let featuresOffset = bytes.length;
  try {
    featuresOffset = parseHeader(original).featuresOffset;
  } catch {
    // keep the whole file as the target region
  }
  const position = () => {
    const r = rand.next();
    if (r < 0.35) return rand.int(Math.min(bytes.length, featuresOffset));                  // header and index
    if (r < 0.5) return Math.min(bytes.length - 1, featuresOffset + rand.int(256));         // first features
    return rand.int(bytes.length);
  };
  const rounds = 1 + rand.int(3);
  for (let k = 0; k < rounds && bytes.length > 0; k++) {
    const kind = rand.int(5);
    const view = new DataView(bytes.buffer);
    if (kind === 0) {
      const p = position();
      bytes[p] ^= 1 << rand.int(8);
    } else if (kind === 1) {
      const p = position();
      for (let n = 1 + rand.int(8); n > 0 && p + n < bytes.length; n--) bytes[p + n] = rand.int(256);
    } else if (kind === 2) {
      const p = position() & ~3;
      if (p + 4 <= bytes.length) view.setUint32(p, BOUNDARY[rand.int(BOUNDARY.length)] >>> 0, true);
    } else if (kind === 3) {
      const p = position() & ~7;
      if (p + 8 <= bytes.length) view.setFloat64(p, [NaN, Infinity, -Infinity, 1e308, -1e308, 0][rand.int(6)], true);
    } else {
      bytes = bytes.slice(0, position());
    }
  }
  return bytes;
}

/** Run a promise with a deadline. */
async function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`hang: no result after ${ms} ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const TARGETS: Array<[string, Array<[number, number, number]>]> = [
  ['points.fgb', [[0, 0, 0], [6, tileAt(-96, 32, 6).x, tileAt(-96, 32, 6).y]]],
  ['multipolygons.fgb', [[0, 0, 0], [5, tileAt(-80, 40, 5).x, tileAt(-80, 40, 5).y]]],
  ['curves.fgb', [[0, 0, 0], [5, tileAt(-96, 38, 5).x, tileAt(-96, 38, 5).y]]],
  ['collections.fgb', [[0, 0, 0]]],
  ['no-index.fgb', [[0, 0, 0]]],
  ['grid-5k.fgb', [[4, tileAt(-100, 40, 4).x, tileAt(-100, 40, 4).y]]],
  ['gogama-points.fgb', [[0, 0, 0], [6, tileAt(-96, 32, 6).x, tileAt(-96, 32, 6).y]]],
];

describe('mutation fuzzing', () => {
  it.each(TARGETS)('%s: corrupt input yields a valid tile or an FgbVtError', async (file, tiles) => {
    const original = new Uint8Array(readFileSync(fixture(file)));
    const rand = prng(SEED ^ [...file].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0));
    const failures: string[] = [];
    for (let iteration = 0; iteration < ITERATIONS; iteration++) {
      const bytes = mutate(original, rand);
      const connector = new MemoryConnector(new Map([['f', bytes]]));
      for (const [z, x, y] of tiles) {
        try {
          const pbf = await within(5000, tile(connector, z, x, y, { name: 'l', path: 'f' }, {
            cache: false,
            maxReadBytes: 64 * 1024 * 1024,
            maxFeatureBytes: 16 * 1024 * 1024,
          }));
          const issues = validateMvt(pbf);
          if (issues.length > 0) failures.push(`#${iteration} ${z}/${x}/${y}: invalid tile: ${issues[0].message}`);
        } catch (err) {
          if (!(err instanceof FgbVtError)) {
            failures.push(`#${iteration} ${z}/${x}/${y}: ${(err as Error)?.name}: ${(err as Error)?.message}`);
          }
        }
      }
    }
    expect(failures.slice(0, 10), `seed ${SEED}`).toEqual([]);
  }, Math.max(10_000, ITERATIONS * 20));
});

/**
 * Tests for the range-efficient source reader: index search correctness
 * against brute force, request counts with and without caching, source
 * change detection, unindexed files and typed errors.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FgbSource, createIoContext } from '../../src/fgb/reader.js';
import { parseHeader } from '../../src/fgb/header.js';
import { decodeFeatures } from '../../src/fgb/feature.js';
import { LocalConnector } from '../../src/connectors/local.js';
import type { Connector, ReadOptions } from '../../src/connectors/connector.js';
import { MemoryCache } from '../../src/cache.js';
import { tile } from '../../src/tile.js';
import { TileClient } from '../../src/client.js';
import { FormatError, LimitExceededError } from '../../src/errors.js';
import type { BBox, RawFeature } from '../../src/types.js';
import { fixture, decodeLayer, tileAt } from '../helpers/tiles.js';

/** Connector wrapper that records every request. */
class Recorder implements Connector {
  readonly inner = new LocalConnector();
  heads = 0;
  calls = 0;
  requests = 0;
  bytes = 0;
  get hints() { return this.inner.hints; }
  reset() { this.heads = this.calls = this.requests = this.bytes = 0; }
  async readHead(path: string, length: number, options?: ReadOptions) {
    this.heads++; this.requests++;
    const r = await this.inner.readHead(path, length, options);
    this.bytes += r.bytes.length;
    return r;
  }
  async read(path: string, offset: number, length: number, options?: ReadOptions) {
    this.calls++; this.requests++;
    const b = await this.inner.read(path, offset, length, options);
    this.bytes += b.length;
    return b;
  }
  async readRanges(path: string, ranges: ReadonlyArray<{ offset: number; length: number }>, options?: ReadOptions) {
    this.calls++; this.requests += ranges.length;
    const out = await this.inner.readRanges(path, ranges, options);
    for (const b of out) this.bytes += b.length;
    return out;
  }
  close() { return this.inner.close(); }
}

/** Features whose bbox intersects `q`, by decoding the whole file. */
function bruteForce(file: string, q: BBox): Set<number> {
  const bytes = new Uint8Array(readFileSync(fixture(file)));
  const header = parseHeader(bytes);
  const out = new Set<number>();
  for (const f of decodeFeatures(bytes.subarray(header.featuresOffset), header)) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < f.xy.length; i += 2) {
      minX = Math.min(minX, f.xy[i]); maxX = Math.max(maxX, f.xy[i]);
      minY = Math.min(minY, f.xy[i + 1]); maxY = Math.max(maxY, f.xy[i + 1]);
    }
    if (maxX >= q.minX && minX <= q.maxX && maxY >= q.minY && minY <= q.maxY) out.add(Number(f.id));
  }
  return out;
}

const ids = (features: RawFeature[]) => new Set(features.map(f => Number(f.id)));

/** Deterministic pseudo-random query boxes over the grid's extent, small to large. */
function queries(count: number): BBox[] {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out: BBox[] = [{ minX: -180, minY: -90, maxX: 180, maxY: 90 }];
  for (let i = 0; i < count; i++) {
    const w = 0.05 * 2 ** (rand() * 10), h = 0.05 * 2 ** (rand() * 10);
    const x = -128 + rand() * 62, y = 22 + rand() * 30;
    out.push({ minX: x, minY: y, maxX: x + w, maxY: y + h });
  }
  return out;
}

describe('index search matches brute force', () => {
  const qs = queries(60);
  const configs: Array<[string, () => { connector: Connector; cache: MemoryCache | false; prefetch?: number; coalesceGap?: number }]> = [
    ['without cache', () => ({ connector: new LocalConnector(), cache: false })],
    ['with cache', () => ({ connector: new LocalConnector(), cache: new MemoryCache() })],
    ['tiny pages, no merging', () => ({ connector: new LocalConnector(), cache: new MemoryCache(), prefetch: 2048, coalesceGap: 0 })],
  ];

  it.each(configs)('%s', async (_, make) => {
    const { connector, cache, prefetch, coalesceGap } = make();
    const context = createIoContext({ cache, prefetch, coalesceGap }, new MemoryCache());
    for (const q of qs) {
      // reopen per query without a cache, reuse with one
      const fgb = await FgbSource.open(connector, fixture('grid-5k.fgb'), context);
      const got = ids(await fgb.readFeatures(q, { coalesceGap }));
      expect(got).toEqual(bruteForce('grid-5k.fgb', q));
    }
    await connector.close();
  });

  it('works after warming the upper index levels', async () => {
    const connector = new LocalConnector();
    const context = createIoContext({}, new MemoryCache());
    const fgb = await FgbSource.open(connector, fixture('grid-5k.fgb'), context);
    expect(await fgb.warmIndex(1 << 20)).toBe(true);
    for (const q of qs.slice(0, 20)) {
      expect(ids(await fgb.readFeatures(q))).toEqual(bruteForce('grid-5k.fgb', q));
    }
    await connector.close();
  });
});

describe('request counts', () => {
  it('reads only the header region, never the whole index, for a high-zoom tile', async () => {
    const rec = new Recorder();
    const { x, y } = tileAt(-100, 40, 12);
    await tile(rec, 12, x, y, { name: 'l', path: fixture('grid-5k.fgb') }, { cache: false });
    const header = parseHeader(new Uint8Array(readFileSync(fixture('grid-5k.fgb'))));
    expect(rec.heads).toBe(1);
    expect(rec.bytes).toBeLessThan(header.indexSize);
    await rec.close();
  });

  it('serves a repeated tile from cache with a single feature read', async () => {
    const rec = new Recorder();
    const client = new TileClient(rec);
    const source = { name: 'l', path: fixture('grid-5k.fgb') };
    const { x, y } = tileAt(-100, 40, 8);
    const first = await client.tile(8, x, y, source);
    rec.reset();
    const second = await client.tile(8, x, y, source);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    expect(rec.heads).toBe(0);
    expect(rec.calls).toBe(1); // features only: header and index pages are cached
    await client.close();
  });

  it('needs no index reads beyond the first request for a whole-dataset query', async () => {
    const rec = new Recorder();
    const context = createIoContext({ cache: new MemoryCache() }, new MemoryCache());
    const fgb = await FgbSource.open(rec, fixture('grid-5k.fgb'), context);
    rec.reset();
    const ranges = await fgb.featureRanges({ minX: -180, minY: -90, maxX: 180, maxY: 90 });
    // the root lies inside the query: no descent, only the first leaf is read
    expect(rec.calls).toBeLessThanOrEqual(1);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].offset).toBe(fgb.header.featuresOffset);
    expect(ranges[0].offset + ranges[0].length).toBe(fgb.size);
    await rec.close();
  });

  it('opens a source once for concurrent tiles', async () => {
    const rec = new Recorder();
    const client = new TileClient(rec);
    const source = { name: 'l', path: fixture('grid-5k.fgb') };
    await Promise.all(Array.from({ length: 8 }, (_, i) => client.tile(6, 12 + (i % 4), 23 + (i >> 2), source)));
    expect(rec.heads).toBe(1);
    await client.close();
  });

  it('preloads headers and upper index levels with open()', async () => {
    const rec = new Recorder();
    const client = new TileClient(rec);
    const source = { name: 'l', path: fixture('grid-5k.fgb') };
    await client.open(source);
    rec.reset();
    const { x, y } = tileAt(-100, 40, 10);
    await client.tile(10, x, y, source);
    expect(rec.heads).toBe(0);
    expect(rec.calls).toBeLessThanOrEqual(2); // leaf page + features
    await client.close();
  });
});

describe('connectors without metadata', () => {
  it('recovers the last feature without knowing the file size', async () => {
    const local = new LocalConnector();
    const plain: Connector = {
      read: (p, o, l, opts) => local.read(p, o, l, opts),
      readRanges: (p, r, opts) => local.readRanges(p, r, opts),
      close: () => local.close(),
    };
    const pbf = await tile(plain, 0, 0, 0, { name: 'l', path: fixture('last-feature.fgb'), options: { tolerance: 0 } }, { cache: false });
    expect(decodeLayer(pbf, 'l')?.length).toBe(50);
    await plain.close();
  });
});

describe('source changes', () => {
  it('reopens a file that was replaced while its header was cached', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fgb-vt-change-'));
    const path = join(dir, 'data.fgb');
    copyFileSync(fixture('points.fgb'), path);

    const client = new TileClient(new LocalConnector());
    const source = { name: 'l', path };
    expect(decodeLayer(await client.tile(0, 0, 0, source), 'l')?.length).toBe(200);

    copyFileSync(fixture('single.fgb'), path);
    expect(decodeLayer(await client.tile(0, 0, 0, source), 'l')?.length).toBe(1);
    await client.close();
  });
});

describe('files without a spatial index', () => {
  it('scans them', async () => {
    const connector = new LocalConnector();
    const pbf = await tile(connector, 0, 0, 0, { name: 'l', path: fixture('no-index.fgb') });
    expect(decodeLayer(pbf, 'l')?.length).toBe(200);
    const { x, y } = tileAt(-95, 32, 6);
    const indexed = await tile(connector, 6, x, y, { name: 'l', path: fixture('points.fgb') });
    const scanned = await tile(connector, 6, x, y, { name: 'l', path: fixture('no-index.fgb') });
    expect(decodeLayer(scanned, 'l')?.length).toBe(decodeLayer(indexed, 'l')?.length);
    await connector.close();
  });

  it('refuses to scan beyond the budget', async () => {
    const connector = new LocalConnector();
    await expect(tile(connector, 0, 0, 0, { name: 'l', path: fixture('no-index.fgb') }, { maxScanBytes: 1000, cache: false }))
      .rejects.toBeInstanceOf(LimitExceededError);
    await connector.close();
  });
});

describe('typed errors', () => {
  it('reports format errors with the source path', async () => {
    const connector = new LocalConnector();
    const path = fixture('generate.py');
    const err = await tile(connector, 0, 0, 0, { name: 'l', path }, { cache: false }).catch(e => e);
    expect(err).toBeInstanceOf(FormatError);
    expect(err.path).toBe(path);
    await connector.close();
  });

  it('rejects invalid tile coordinates', async () => {
    const connector = new LocalConnector();
    await expect(tile(connector, 3, 8, 0, { name: 'l', path: fixture('points.fgb') })).rejects.toThrow(RangeError);
    await connector.close();
  });
});

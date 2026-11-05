/**
 * Pipeline behaviour added after 1.0.5: option validation, cancellation
 * of sibling sources, feature filters, coarsening to fit maxTileBytes,
 * tile ETags, invalidation, and recovery of sources without version tags.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tile, tileETag, clearTileCache } from '../src/tile.js';
import { TileServer } from '../src/server.js';
import { TileClient } from '../src/client.js';
import { LocalConnector } from '../src/connectors/local.js';
import { ConnectorError, LimitExceededError } from '../src/errors.js';
import type { Connector, ReadOptions } from '../src/connectors/connector.js';
import type { TileStats } from '../src/pipeline.js';
import { fixture, decodeLayer, features, tileAt } from './helpers/tiles.js';

const connector = new LocalConnector();
afterAll(() => connector.close());

const POINTS = fixture('points.fgb');

/** In-memory connector over replaceable files, without version tags. */
class Untagged implements Connector {
  readonly files = new Map<string, Uint8Array>();
  reads = 0;
  async read(path: string, offset: number, length: number) {
    this.reads++;
    return this.files.get(path)!.slice(offset, offset + length);
  }
  async readRanges(path: string, ranges: ReadonlyArray<{ offset: number; length: number }>) {
    return Promise.all(ranges.map(r => this.read(path, r.offset, r.length)));
  }
  async close() {}
}

describe('option validation', () => {
  const source = { name: 'p', path: POINTS };

  it.each([
    [{ extent: 0 }, /extent/],
    [{ extent: 4096.5 }, /extent/],
    [{ extent: 2 ** 30 }, /extent/],
    [{ buffer: NaN }, /buffer/],
    [{ buffer: -1 }, /buffer/],
    [{ tolerance: -3 }, /tolerance/],
    [{ pointGrid: Infinity }, /pointGrid/],
    [{ minZoom: 10, maxZoom: 2 }, /minZoom/],
    [{ maxZoom: 31 }, /maxZoom/],
    [{ maxFeatures: NaN }, /maxFeatures/],
  ])('rejects %j before reading', async (options, message) => {
    const counting = new Untagged();
    await expect(tile(counting, 0, 0, 0, { ...source, options }, { cache: false })).rejects.toThrow(message);
    expect(counting.reads).toBe(0);
  });

  it('rejects invalid source names, paths and I/O options', async () => {
    await expect(tile(connector, 0, 0, 0, { name: '', path: POINTS })).rejects.toThrow(TypeError);
    await expect(tile(connector, 0, 0, 0, { name: 'p', path: '' })).rejects.toThrow(TypeError);
    await expect(tile(connector, 0, 0, 0, source, { prefetch: -1 })).rejects.toThrow(/prefetch/);
    expect(() => new TileServer({ connector, sources: { name: 'p', path: POINTS, options: { extent: 0 } } })).toThrow(RangeError);
  });
});

describe('sibling cancellation', () => {
  it('aborts the other sources of a tile when one fails', async () => {
    let aborted = false;
    const slow: Connector = {
      read: (path, offset, length, options) => slow.readRanges(path, [{ offset, length }], options).then(r => r[0]),
      readRanges: (path, ranges, options?: ReadOptions) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(connector.readRanges(path, ranges)), 2000);
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(timer);
          reject(options.signal!.reason);
        });
      }),
      close: async () => {},
    };
    const server = new TileServer([
      { connector: slow, sources: { name: 'slow', path: POINTS } },
      { connector, sources: { name: 'missing', path: fixture('does-not-exist.fgb') } },
    ], { cache: false });
    const started = Date.now();
    const err = await server.tile(0, 0, 0).catch(e => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.status).toBe(404);
    expect(err.path).toBe(fixture('does-not-exist.fgb'));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe('filter', () => {
  it('filters on properties left out of the tile', async () => {
    const all = features(decodeLayer(await tile(connector, 0, 0, 0, { name: 'p', path: POINTS }), 'p'));
    const kept = features(decodeLayer(await tile(connector, 0, 0, 0, {
      name: 'p',
      path: POINTS,
      properties: ['label'],
      filter: (f, z) => z === 0 && f.type === 'Point' && (f.properties.small as number) < 0,
    }), 'p'));
    expect(all).toHaveLength(200);
    expect(kept).toHaveLength(100);
    expect(Object.keys(kept[0].properties)).toEqual(['label']);
  });

  it('sees the shared properties of every part of a geometry collection', async () => {
    const path = fixture('collections.fgb');
    const seen: string[] = [];
    const layer = decodeLayer(await tile(connector, 0, 0, 0, {
      name: 'c',
      path,
      properties: [],
      filter: (f) => {
        seen.push(`${f.type}:${String(f.properties.kind)}`);
        return f.properties.kind === 'mixed';
      },
    }), 'c');
    expect(features(layer).map(f => f.type)).toEqual([3, 2, 1]); // polygon, line, point of feature 1
    expect(seen.filter(s => s.endsWith(':mixed'))).toHaveLength(3);
    expect(features(layer).every(f => Object.keys(f.properties).length === 0)).toBe(true);
  });

  it('reports filtered features in the stats', async () => {
    let stats: TileStats | undefined;
    await tile(connector, 0, 0, 0, { name: 'p', path: POINTS, filter: f => f.id === 7 }, { onTile: s => { stats = s; } });
    expect(stats!.sources[0]).toMatchObject({ featuresRead: 200, featuresEncoded: 1 });
  });
});

describe('reduceToFit', () => {
  const grid = { name: 'g', path: fixture('grid-5k.fgb') };

  it('coarsens a tile until it fits maxTileBytes', async () => {
    const full = await tile(connector, 0, 0, 0, grid);
    const max = Math.floor(full.length / 3);
    await expect(tile(connector, 0, 0, 0, grid, { maxTileBytes: max })).rejects.toThrow(LimitExceededError);
    let stats: TileStats | undefined;
    const reduced = await tile(connector, 0, 0, 0, grid, { maxTileBytes: max, reduceToFit: true, onTile: s => { stats = s; } });
    expect(reduced.length).toBeLessThanOrEqual(max);
    expect(stats!.reduced).toBeGreaterThan(0);
    expect(features(decodeLayer(reduced, 'g')).length).toBeGreaterThan(0);
  });

  it('still fails when even the coarsest tile is too large', async () => {
    const err = await tile(connector, 0, 0, 0, grid, { maxTileBytes: 10, reduceToFit: true }).catch(e => e);
    expect(err).toBeInstanceOf(LimitExceededError);
    expect(err.message).toMatch(/coarsening steps/);
  });
});

describe('tile ETags', () => {
  it('identifies the tile by file version and settings', async () => {
    const source = { name: 'p', path: POINTS };
    const a = await tileETag(connector, 3, 1, 3, source);
    expect(a).toMatch(/^"[0-9a-z]+"$/);
    expect(await tileETag(connector, 3, 1, 3, source)).toBe(a);
    expect(await tileETag(connector, 3, 2, 3, source)).not.toBe(a);
    expect(await tileETag(connector, 3, 1, 3, { ...source, options: { tolerance: 1 } })).not.toBe(a);
    expect(await tileETag(connector, 3, 1, 3, { ...source, filter: () => true })).not.toBe(a);
    expect(await tileETag(connector, 3, 1, 3, source, { omitEmptyLayers: true })).not.toBe(a);
  });

  it('changes when the file changes, without rendering the tile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fgbvt-etag-'));
    try {
      const path = join(dir, 'data.fgb');
      copyFileSync(POINTS, path);
      const local = new LocalConnector();
      const server = new TileServer({ connector: local, sources: { name: 'p', path } });
      const before = await server.tileETag(0, 0, 0);
      await new Promise(resolve => setTimeout(resolve, 20));
      copyFileSync(fixture('grid-5k.fgb'), path);
      await server.invalidate(path);
      expect(await server.tileETag(0, 0, 0)).not.toBe(before);
      await server.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is null for sources without version tags, and skips sources outside their zooms', async () => {
    const untagged = new Untagged();
    untagged.files.set('p', new Uint8Array(readFileSync(POINTS)));
    expect(await new TileClient(untagged).tileETag(0, 0, 0, { name: 'p', path: 'p' })).toBeNull();
    const reads = untagged.reads;
    const etag = await new TileClient(untagged).tileETag(5, 0, 0, { name: 'p', path: 'p', options: { maxZoom: 4 } });
    expect(etag).not.toBeNull();
    expect(untagged.reads).toBe(reads);
  });
});

describe('sources without version tags', () => {
  const at = tileAt(-95, 32, 4);

  it('recover by themselves when a replaced file no longer matches the cached index', async () => {
    const untagged = new Untagged();
    untagged.files.set('f', new Uint8Array(readFileSync(POINTS)));
    const client = new TileClient(untagged);
    const source = { name: 'l', path: 'f' };
    expect(features(decodeLayer(await client.tile(4, at.x, at.y, source), 'l')).length).toBeGreaterThan(0);
    untagged.files.set('f', new Uint8Array(readFileSync(fixture('grid-5k.fgb'))));
    const fresh = await new TileClient(untagged).tile(4, at.x, at.y, source);
    expect(Buffer.from(await client.tile(4, at.x, at.y, source)).equals(Buffer.from(fresh))).toBe(true);
  });

  it('re-read their header and index after invalidate()', async () => {
    const untagged = new Untagged();
    const offsets: number[] = [];
    const read = untagged.read.bind(untagged);
    untagged.read = async (path, offset, length) => {
      offsets.push(offset);
      return read(path, offset, length);
    };
    untagged.files.set('f', new Uint8Array(readFileSync(POINTS)));
    const client = new TileClient(untagged);
    const source = { name: 'p', path: 'f' };
    await client.tile(0, 0, 0, source);
    offsets.length = 0;
    await client.tile(0, 0, 0, source);
    expect(offsets).not.toContain(0); // header and index from the cache
    await client.invalidate('f');
    await client.tile(0, 0, 0, source);
    expect(offsets).toContain(0);
  });

  it('clearTileCache() forgets what tile() cached', async () => {
    const untagged = new Untagged();
    const source = { name: 'p', path: 'f-shared' };
    untagged.files.set('f-shared', new Uint8Array(readFileSync(POINTS)));
    await tile(untagged, 0, 0, 0, source);
    const cachedReads = untagged.reads;
    await tile(untagged, 0, 0, 0, source);
    const warm = untagged.reads - cachedReads;
    await clearTileCache(untagged, 'f-shared');
    const before = untagged.reads;
    await tile(untagged, 0, 0, 0, source);
    expect(untagged.reads - before).toBeGreaterThan(warm);
    await clearTileCache();
  });
});

describe('streaming', () => {
  it('produces the same tiles from batched reads as from one read', async () => {
    const source = { name: 'g', path: fixture('grid-5k.fgb') };
    for (const [z, x, y] of [[0, 0, 0], [2, 1, 1], [5, 9, 12]] as const) {
      const batched = await tile(connector, z, x, y, source, { coalesceGap: 0, cache: false });
      const merged = await tile(connector, z, x, y, source, { coalesceGap: 1 << 30, cache: false });
      expect(Buffer.from(batched).equals(Buffer.from(merged))).toBe(true);
    }
  });
});

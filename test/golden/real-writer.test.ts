/**
 * End-to-end tests against FlatGeobuf files written by GDAL (see
 * test/fixtures/generate.py). Every tile is decoded with @mapbox/vector-tile.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { tile } from '../../src/tile.js';
import { LocalConnector } from '../../src/connectors/local.js';
import type { Connector } from '../../src/connectors/connector.js';
import { parseHeader } from '../../src/fgb/header.js';
import { ColumnType } from '../../src/types.js';
import { fixture, decodeLayer, features, tileAt, geometryDefects } from '../helpers/tiles.js';

const connector = new LocalConnector();
afterAll(() => connector.close());

async function layerOf(file: string, z: number, x: number, y: number, options?: Record<string, number>) {
  const pbf = await tile(connector, z, x, y, { name: 'l', path: fixture(file), options });
  return decodeLayer(pbf, 'l');
}

describe('header parsing (GDAL output)', () => {
  it('applies schema defaults for fields the writer omitted', () => {
    const header = parseHeader(new Uint8Array(readFileSync(fixture('points.fgb'))));
    expect(header.indexNodeSize).toBe(16);
    expect(header.featuresCount).toBe(200);
    const types = Object.fromEntries(header.columns.map(c => [c.name, c.type]));
    expect(types).toMatchObject({
      id: ColumnType.Int, big: ColumnType.Long, ts: ColumnType.Long, neg: ColumnType.Long,
      ratio: ColumnType.Double, label: ColumnType.String,
    });
  });
});

describe('feature completeness', () => {
  it.each([
    ['points.fgb', 200],
    ['single.fgb', 1],
    ['tile-edge.fgb', 5],
    ['multipolygons.fgb', 3],
    ['lines.fgb', 3],
  ])('%s: z0 tile contains every feature', async (file, count) => {
    const layer = await layerOf(file, 0, 0, 0, { tolerance: 0 });
    expect(layer?.length ?? 0).toBe(count);
  });

  it('keeps a last feature that is larger than the index can predict', async () => {
    const layer = await layerOf('last-feature.fgb', 0, 0, 0, { tolerance: 0 });
    const ks = features(layer).map(f => f.properties.k).sort((a, b) => Number(a) - Number(b));
    expect(ks).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it('includes features inside the tile buffer but outside the tile', async () => {
    const { x, y } = tileAt(-95, 32, 10);
    const layer = await layerOf('tile-edge.fgb', 10, x, y);
    const where = features(layer).map(f => f.properties.where).sort();
    expect(where).toEqual(['east-buffer', 'inside']);
  });
});

describe('property and id fidelity', () => {
  it('round-trips integers beyond 32 bits exactly', async () => {
    const layer = await layerOf('points.fgb', 0, 0, 0);
    const all = features(layer);
    expect(all).toHaveLength(200);
    for (const f of all) {
      const i = Number(f.id);
      expect(f.properties).toMatchObject({
        big: 5_000_000_000 + i,
        ts: 1_700_000_000_000 + i,
        neg: -3_000_000_000 - i,
        small: i - 100,
        ratio: i / 8,
        label: `p${i}`,
      });
      expect(f.properties.id).toBeUndefined();
    }
  });

  it('writes ids above 2^32 exactly and keeps negative ids as properties', async () => {
    const layer = await layerOf('tile-edge.fgb', 0, 0, 0);
    const byWhere = Object.fromEntries(features(layer).map(f => [f.properties.where, f]));
    expect(byWhere['big-id'].id).toBe(4_294_967_301);
    expect(byWhere['negative-id'].id).toBeUndefined();
    expect(byWhere['negative-id'].properties.id).toBe(-5);
  });
});

describe('geometry validity', () => {
  const zooms = [0, 2, 4, 6, 8];

  it.each(['multipolygons.fgb', 'lines.fgb'])('%s: no zero-length segments or degenerate rings', async (file) => {
    for (const z of zooms) {
      const { x, y } = tileAt(-90, 40, z);
      const layer = await layerOf(file, z, x, y);
      const d = geometryDefects(layer);
      expect({ z, ...d, vertices: undefined }).toEqual({ z, zeroLength: 0, degenerateRings: 0, vertices: undefined });
    }
  });

  it('simplifies single-part multi geometries at low zoom', async () => {
    const polys = geometryDefects(await layerOf('multipolygons.fgb', 2, 0, 1));
    const lines = geometryDefects(await layerOf('lines.fgb', 2, 0, 1));
    // 1500 + 1600 + 1800 source vertices; 3000 for lines
    expect(polys.vertices).toBeLessThan(400);
    expect(lines.vertices).toBeLessThan(300);
  });

  it('preserves polygon structure (parts and holes)', async () => {
    const { x, y } = tileAt(-80, 40, 3);
    const layer = await layerOf('multipolygons.fgb', 3, x, y);
    const byName = Object.fromEntries(features(layer).map(f => [f.properties.name, f.toGeoJSON(x, y, 3)]));
    expect(byName.circle.geometry.type).toBe('Polygon');
    expect(byName.pair.geometry.type).toBe('MultiPolygon');
    expect((byName.pair.geometry as any).coordinates).toHaveLength(2);
    expect(byName.donut.geometry.type).toBe('Polygon');
    expect((byName.donut.geometry as any).coordinates).toHaveLength(2);
  });

  it('winds rings per the MVT spec: exterior positive, holes negative (surveyor formula)', async () => {
    const { x, y } = tileAt(-80, 40, 3);
    const layer = await layerOf('multipolygons.fgb', 3, x, y);
    const surveyor = (r: Array<{ x: number; y: number }>) => {
      let a = 0;
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        a += p.x * q.y - q.x * p.y;
      }
      return a;
    };
    const donut = features(layer).find(f => f.properties.name === 'donut')!;
    const [exterior, hole] = donut.loadGeometry();
    expect(surveyor(exterior)).toBeGreaterThan(0);
    expect(surveyor(hole)).toBeLessThan(0);
    for (const f of features(layer).filter(f => f.properties.name !== 'donut')) {
      for (const ring of f.loadGeometry()) expect(surveyor(ring)).toBeGreaterThan(0);
    }
  });

  it('keeps line parts separate', async () => {
    const layer = await layerOf('lines.fgb', 4, 3, 5);
    const byName = Object.fromEntries(features(layer).map(f => [f.properties.name, f.toGeoJSON(3, 5, 4)]));
    expect(byName['multi-2'].geometry.type).toBe('MultiLineString');
    expect(byName.line.geometry.type).toBe('LineString');
  });
});

describe('connector buffer ownership', () => {
  it('produces identical tiles when the connector returns cached buffers', async () => {
    const inner = new LocalConnector();
    const cache = new Map<string, Uint8Array>();
    const caching: Connector = {
      async read(path, offset, length) {
        const key = `${path}:${offset}:${length}`;
        let hit = cache.get(key);
        if (!hit) { hit = await inner.read(path, offset, length); cache.set(key, hit); }
        return hit;
      },
      readRanges(path, ranges) { return Promise.all(ranges.map(r => this.read(path, r.offset, r.length))); },
      close: () => inner.close(),
    };
    for (const file of ['points.fgb', 'lines.fgb', 'multipolygons.fgb']) {
      const source = { name: 'l', path: fixture(file) };
      const first = await tile(caching, 2, 0, 1, source);
      const second = await tile(caching, 2, 0, 1, source);
      expect(decodeLayer(first, 'l')?.length ?? 0).toBeGreaterThan(0);
      expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    }
    await caching.close();
  });
});

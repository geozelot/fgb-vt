/**
 * Encoding quality: float values, seam-consistent simplification,
 * antimeridian world copies and point thinning.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tile } from '../src/tile.js';
import { LocalConnector } from '../src/connectors/local.js';
import { buildMvtLayer } from '../src/mvt/layer.js';
import { encodePbf } from '../src/pbf/encode.js';
import { tileClipBounds } from '../src/tiles.js';
import type { Source } from '../src/source.js';
import type { TileStats } from '../src/pipeline.js';
import { GeomType, type PropertyValue, type RawFeature } from '../src/types.js';
import { fixture, decodeLayer, features, tileAt } from './helpers/tiles.js';
import { writeFgb, prop } from './helpers/fgb-writer.js';

const connector = new LocalConnector();
afterAll(() => connector.close());

async function layerOf(source: Source, z: number, x: number, y: number, options = {}) {
  return decodeLayer(await tile(connector, z, x, y, source, options), source.name);
}

// == P6.1 Float values ========================================================

describe('float values', () => {
  function layerWith(values: number[]) {
    const fs: RawFeature[] = values.map((v, i) => ({
      type: GeomType.Point,
      xy: new Float64Array([0, 0]),
      ends: null,
      parts: null,
      properties: new Map<string, PropertyValue>([['v', v]]),
      id: i,
    }));
    return buildMvtLayer(fs, 'l', 0, 0, 0, tileClipBounds(0, 0, 0, 64, 4096), 4096, 0);
  }

  it('uses float for fractions a 32-bit float holds exactly, double otherwise', () => {
    const layer = layerWith([0.125, Math.fround(1.1), 0.1, 3, -2, 1e300]);
    expect(layer.values.map(v => v.type)).toEqual(['float', 'float', 'double', 'uint', 'int', 'double']);
  });

  it('round-trips every value exactly', () => {
    const input = [0.125, Math.fround(1.1), 0.1, Math.PI, Math.fround(Math.PI), -0.5];
    const decoded = features(decodeLayer(encodePbf([layerWith(input)]), 'l')).map(f => f.properties.v);
    expect(decoded).toEqual(input);
  });

  it('writes Float columns as float values', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fgb-vt-float-')), 'f.fgb');
    const floatBits = (v: number) => {
      const b = new Uint8Array(6);
      const d = new DataView(b.buffer);
      d.setUint16(0, 0, true);
      d.setFloat32(2, v, true);
      return b;
    };
    writeFileSync(path, writeFgb({
      geometryType: GeomType.Point,
      columns: [{ name: 'f', type: 9 /* Float */ }],
      features: [1.1, 2.2, 3.3].map(v => ({ geometry: { xy: [0, 0] }, properties: floatBits(v) })),
    }));
    const pbf = await tile(connector, 0, 0, 0, { name: 'l', path });
    // Three 4-byte float values instead of 8-byte doubles: field 2, wire type 5
    expect(pbf.filter(b => b === ((2 << 3) | 5)).length).toBeGreaterThanOrEqual(3);
    expect(features(decodeLayer(pbf, 'l')).map(f => f.properties.f)).toEqual([1.1, 2.2, 3.3].map(Math.fround));
  });
});

// == P6.2 Simplification across tile seams ===================================

describe('simplification across tile seams', () => {
  const extent = 4096;

  /**
   * The rendered wave line of one tile as a function of global x (tile
   * units), by linear interpolation along its segments.
   */
  async function polyline(z: number, tx: number, y: number, simplifyBeforeClip: boolean) {
    const layer = await layerOf({ name: 'l', path: fixture('lines.fgb'), options: { simplifyBeforeClip } }, z, tx, y);
    const segments: number[][] = [];
    for (const f of features(layer).filter(f => f.properties.name === 'line')) {
      for (const part of f.loadGeometry()) {
        for (let i = 1; i < part.length; i++) {
          segments.push([tx * extent + part[i - 1].x, part[i - 1].y, tx * extent + part[i].x, part[i].y]);
        }
      }
    }
    return (gx: number) => {
      for (const [x0, y0, x1, y1] of segments) {
        if (x0 !== x1 && (gx - x0) * (gx - x1) <= 0) return y0 + ((y1 - y0) * (gx - x0)) / (x1 - x0);
      }
      return NaN;
    };
  }

  /** Largest vertical distance between two adjacent tiles' lines across the shared buffer band. */
  async function seamGap(simplifyBeforeClip: boolean) {
    const z = 10;
    const { x, y } = tileAt(-99, 45, z);
    const left = await polyline(z, x, y, simplifyBeforeClip);
    const right = await polyline(z, x + 1, y, simplifyBeforeClip);
    const seam = (x + 1) * extent;
    let max = 0;
    for (let gx = seam - 60; gx <= seam + 60; gx += 4) {
      const d = Math.abs(left(gx) - right(gx));
      expect(Number.isNaN(d)).toBe(false);
      max = Math.max(max, d);
    }
    return max;
  }

  it('gives adjacent tiles the same line along the seam', async () => {
    // Only integer rounding remains
    expect(await seamGap(true)).toBeLessThanOrEqual(1);
  });

  it('can differ along the seam when clipped parts are simplified (default)', async () => {
    expect(await seamGap(false)).toBeGreaterThan(1);
  });
});

// == P6.3 Antimeridian ========================================================

describe('antimeridian', () => {
  const unindexed = (() => {
    const path = join(mkdtempSync(join(tmpdir(), 'fgb-vt-am-')), 'points.fgb');
    writeFileSync(path, writeFgb({
      geometryType: GeomType.Point,
      columns: [{ name: 'id', type: 5 }],
      features: [
        { geometry: { xy: [179.9, 10] }, properties: prop.int(0, 1) },
        { geometry: { xy: [-179.9, 10] }, properties: prop.int(0, 2) },
      ],
    }));
    return path;
  })();

  /** Tile coordinates of each feature's first vertex, by id. */
  async function positions(path: string, z: number, x: number, y: number) {
    const out = new Map<number, Array<[number, number]>>();
    for (const f of features(await layerOf({ name: 'l', path }, z, x, y))) {
      const p = f.loadGeometry()[0][0];
      out.set(f.id, [...(out.get(f.id) ?? []), [p.x, p.y]]);
    }
    return out;
  }

  it.each([['indexed', fixture('antimeridian.fgb')], ['unindexed', unindexed]])(
    'copies points across the antimeridian into the buffer (%s)', async (_, path) => {
      const { y } = tileAt(0, 10, 2);
      // West edge tile: the point at 179.9° appears just left of the tile
      const west = await positions(path, 2, 0, y);
      expect(west.get(2)![0][0]).toBeGreaterThan(0);
      expect(west.get(1)![0][0]).toBeLessThan(0);
      expect(west.get(1)![0][0]).toBeGreaterThanOrEqual(-64);
      // East edge tile: the point at -179.9° appears just right of it
      const east = await positions(path, 2, 3, y);
      expect(east.get(1)![0][0]).toBeLessThan(4096);
      expect(east.get(2)![0][0]).toBeGreaterThan(4096);
      expect(east.get(2)![0][0]).toBeLessThanOrEqual(4096 + 64);
    });

  it('shows data stored beyond 180° on both sides', async () => {
    const z = 2;
    const { y } = tileAt(0, -7, z);
    const extentOf = async (x: number) => {
      const poly = features(await layerOf({ name: 'l', path: fixture('antimeridian.fgb') }, z, x, y)).find(f => f.id === 3);
      const xs = poly!.loadGeometry()[0].map(p => p.x);
      return [Math.min(...xs), Math.max(...xs)];
    };
    // 170..190°: the east tile shows 170..180°, the west tile -180..-170°
    const [eastMin, eastMax] = await extentOf(3);
    expect(eastMin).toBe(Math.round(((170 + 180) / 360 * 4 - 3) * 4096));
    expect(eastMax).toBe(4096 + 64);
    const [westMin, westMax] = await extentOf(0);
    expect(westMin).toBe(-64);
    expect(westMax).toBe(Math.round(((-170 + 180) / 360 * 4) * 4096));
  });

  it('adds no copies for data away from the antimeridian', async () => {
    let stats: TileStats | undefined;
    await tile(connector, 0, 0, 0, { name: 'p', path: fixture('points.fgb') }, { onTile: s => { stats = s; } });
    expect(stats!.sources[0].featuresRead).toBe(200);
  });
});

// == P6.4 Point thinning ======================================================

describe('point thinning', () => {
  it('keeps at most one point per grid cell', async () => {
    const source = { name: 'g', path: fixture('grid-5k.fgb') };
    const all = features(await layerOf(source, 0, 0, 0));
    const grid = 256;
    const thinned = features(await layerOf({ ...source, options: { pointGrid: grid } }, 0, 0, 0));
    expect(all).toHaveLength(5000);
    expect(thinned.length).toBeGreaterThan(0);
    expect(thinned.length).toBeLessThan(all.length);
    const cells = thinned.map(f => {
      const p = f.loadGeometry()[0][0];
      return `${Math.floor(p.x / grid)},${Math.floor(p.y / grid)}`;
    });
    expect(new Set(cells).size).toBe(cells.length);
  });

  it('leaves lines and polygons alone', async () => {
    const source = { name: 'l', path: fixture('lines.fgb') };
    const plain = await tile(connector, 3, 1, 2, source);
    const thinned = await tile(connector, 3, 1, 2, { ...source, options: { pointGrid: 512 } });
    expect(Buffer.from(thinned).equals(Buffer.from(plain))).toBe(true);
  });

  it('thins the points of multipoints individually', () => {
    const f: RawFeature = {
      type: GeomType.MultiPoint,
      // Two points in one cell, one in another (mercator, tile 0/0/0)
      xy: new Float64Array([0.1, 0.1, 0.1001, 0.1001, 0.6, 0.6]),
      ends: null,
      parts: null,
      properties: new Map(),
      id: null,
    };
    const layer = buildMvtLayer([f], 'm', 0, 0, 0, tileClipBounds(0, 0, 0, 64, 4096), 4096, 0, () => {}, { pointGrid: 64 });
    const decoded = features(decodeLayer(encodePbf([layer]), 'm'));
    expect(decoded[0].loadGeometry().flat()).toHaveLength(2);
  });
});


// == Sources sharing a layer name =============================================

describe('sources sharing a name', () => {
  it('merge into one layer with a shared key and value table', async () => {
    const pbf = await tile(connector, 0, 0, 0, [
      { name: 'both', path: fixture('points.fgb') },
      { name: 'both', path: fixture('tile-edge.fgb') },
    ]);
    const layer = decodeLayer(pbf, 'both');
    expect(layer?.length).toBe(205);
    // Properties survive the re-indexing on both sides
    const fs = features(layer);
    expect(fs.filter(f => f.properties.where === 'inside')).toHaveLength(1);
    expect(fs.filter(f => typeof f.properties.label === 'string')).toHaveLength(200);
    // Exactly one layer message named "both"
    const text = Buffer.from(pbf).toString('latin1');
    expect(text.split('both').length - 1).toBe(1);
  });

  it('serve an overview and a detailed file by zoom', async () => {
    const sources: Source[] = [
      { name: 'poi', path: fixture('tile-edge.fgb'), options: { maxZoom: 3 } },
      { name: 'poi', path: fixture('points.fgb'), options: { minZoom: 4 } },
    ];
    expect(decodeLayer(await tile(connector, 0, 0, 0, sources), 'poi')?.length).toBe(5);
    const { x, y } = tileAt(-97, 32, 4);
    const detailed = features(decodeLayer(await tile(connector, 4, x, y, sources), 'poi'));
    expect(detailed.every(f => typeof f.properties.label === 'string')).toBe(true);
  });

  it('reject different extents', async () => {
    await expect(tile(connector, 0, 0, 0, [
      { name: 'x', path: fixture('points.fgb') },
      { name: 'x', path: fixture('single.fgb'), options: { extent: 512 } },
    ])).rejects.toThrow(/different extents/);
  });

  it('are listed once in TileJSON', async () => {
    const { TileServer } = await import('../src/server.js');
    const server = new TileServer({
      connector: new LocalConnector(),
      sources: [
        { name: 'poi', path: fixture('tile-edge.fgb'), options: { maxZoom: 3 } },
        { name: 'poi', path: fixture('points.fgb'), options: { minZoom: 4, maxZoom: 14 } },
      ],
    });
    const { vector_layers: layers } = await server.tileJSON();
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({ id: 'poi', minzoom: 0, maxzoom: 14 });
    expect(Object.keys(layers[0].fields)).toEqual(expect.arrayContaining(['where', 'label']));
    await server.close();
  });
});

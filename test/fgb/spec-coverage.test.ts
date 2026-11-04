/**
 * FlatGeobuf 3.x coverage beyond the basic geometry types: curves,
 * surfaces and collections (GDAL-written), per-feature column schemas,
 * CRS handling, envelope fallback and Z/M/T/TM dimensions.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tile } from '../../src/tile.js';
import { TileServer } from '../../src/server.js';
import { LocalConnector } from '../../src/connectors/local.js';
import { parseHeader } from '../../src/fgb/header.js';
import { decodeFeatureChunk } from '../../src/fgb/feature.js';
import { UnsupportedFormatError } from '../../src/errors.js';
import type { Source } from '../../src/source.js';
import type { Projection } from '../../src/geometry/crs.js';
import { ColumnType, GeomType, type RawFeature } from '../../src/types.js';
import { fixture, decodeLayer, features, tileAt } from '../helpers/tiles.js';
import { writeFgb, prop, type FileSpec } from '../helpers/fgb-writer.js';

const connector = new LocalConnector();
afterAll(() => connector.close());

const dir = mkdtempSync(join(tmpdir(), 'fgb-vt-spec-'));
let written = 0;
/** Write a test file and return its path. */
function file(spec: FileSpec | Uint8Array): string {
  const path = join(dir, `t${written++}.fgb`);
  writeFileSync(path, spec instanceof Uint8Array ? spec : writeFgb(spec));
  return path;
}

/** Decode every feature of a file (in file order) with an optional curve tolerance. */
function decodeFile(path: string, curveTolerance = 0.001) {
  const bytes = new Uint8Array(readFileSync(path));
  const header = parseHeader(bytes);
  return decodeFeatureChunk(bytes.subarray(header.featuresOffset), header, { curveTolerance });
}

/** Decoded features keyed by their `kind` property (several per GeometryCollection). */
function byKind(path: string): Map<string, RawFeature[]> {
  const out = new Map<string, RawFeature[]>();
  for (const f of decodeFile(path).features) {
    const kind = String(f.properties.get('kind'));
    out.set(kind, [...(out.get(kind) ?? []), f]);
  }
  return out;
}

const points = (f: RawFeature) => Array.from({ length: f.xy.length / 2 }, (_, i) => [f.xy[2 * i], f.xy[2 * i + 1]]);

/** All vertices lie on the circle around (cx, cy) with radius r. */
function onCircle(xy: Float64Array | number[][], cx: number, cy: number, r: number) {
  const pts = Array.isArray(xy) ? xy : Array.from({ length: xy.length / 2 }, (_, i) => [xy[2 * i], xy[2 * i + 1]]);
  return pts.every(([x, y]) => Math.abs(Math.hypot(x - cx, y - cy) - r) < 1e-9);
}

async function layerOf(source: Source, z: number, x: number, y: number) {
  return decodeLayer(await tile(connector, z, x, y, source), source.name);
}

// == P2.2 Geometry types ======================================================

describe('curves (GDAL)', () => {
  const curves = byKind(fixture('curves.fgb'));

  it('linearises a circular string between its exact end points', () => {
    const [arc] = curves.get('arc')!;
    expect(arc.type).toBe(GeomType.LineString);
    expect(points(arc)[0]).toEqual([-101, 40]);
    expect(points(arc).at(-1)).toEqual([-99, 40]);
    expect(onCircle(arc.xy, -100, 40, 1)).toBe(true);
    expect(arc.id).toBe(1);
  });

  it('joins compound curve segments without repeating the joint', () => {
    const [line] = curves.get('compound')!;
    expect(line.type).toBe(GeomType.LineString);
    const pts = points(line);
    expect(pts.slice(0, 2)).toEqual([[-103, 38], [-102, 38]]);
    expect(pts.at(-1)).toEqual([-100, 38]);
    expect(pts.filter(([x, y]) => x === -102 && y === 38)).toHaveLength(1);
    expect(onCircle(pts.slice(1), -101, 38, 1)).toBe(true);
  });

  it('reads a curve polygon with a circular exterior and a linear hole', () => {
    const [disc] = curves.get('disc')!;
    expect(disc.type).toBe(GeomType.Polygon);
    expect(disc.ends).toHaveLength(2);
    expect(onCircle(disc.xy.subarray(0, disc.ends![0] * 2), -95, 40, 1)).toBe(true);
    expect(disc.ends![1] - disc.ends![0]).toBe(4);
  });

  it('closes a ring made of a compound curve', () => {
    const [half] = curves.get('half-disc')!;
    expect(half.type).toBe(GeomType.Polygon);
    const pts = points(half);
    expect(pts[0]).toEqual(pts.at(-1));
  });

  it('turns multi curves and multi surfaces into multi lines and multi polygons', () => {
    const [multicurve] = curves.get('multicurve')!;
    expect(multicurve.type).toBe(GeomType.MultiLineString);
    expect(multicurve.ends).toHaveLength(2);
    const [multisurface] = curves.get('multisurface')!;
    expect(multisurface.type).toBe(GeomType.MultiPolygon);
    expect(Array.from(multisurface.parts!)).toEqual([0, 1]);
    expect(onCircle(multisurface.xy.subarray(multisurface.ends![0] * 2), -96, 30, 1)).toBe(true);
  });

  it('adds vertices as the tolerance shrinks (zoom-aware linearisation)', () => {
    const coarse = decodeFile(fixture('curvepolygons.fgb'), 0.1).features[0].xy.length;
    const fine = decodeFile(fixture('curvepolygons.fgb'), 0.0001).features[0].xy.length;
    expect(fine).toBeGreaterThan(coarse);
  });

  it('reads a typed CurvePolygon layer', () => {
    const { features: fs, skipped } = decodeFile(fixture('curvepolygons.fgb'));
    expect(skipped).toBe(0);
    expect(fs.map(f => f.type)).toEqual([GeomType.Polygon, GeomType.Polygon]);
  });

  it('renders curves smoothly at high zoom and coarsely at low zoom', async () => {
    const source = { name: 'c', path: fixture('curvepolygons.fgb'), options: { tolerance: 0 } };
    const disc = (layer: ReturnType<typeof decodeLayer>) =>
      features(layer).find(f => f.id === 1)!.loadGeometry()[0].length;
    // The disc (radius 1°) lies inside both tiles
    const low = await layerOf(source, 3, tileAt(-100, 40, 3).x, tileAt(-100, 40, 3).y);
    const high = await layerOf(source, 6, tileAt(-100, 40, 6).x, tileAt(-100, 40, 6).y);
    expect(disc(high)).toBeGreaterThan(disc(low));
    expect(disc(low)).toBeGreaterThanOrEqual(8);
  });
});

describe('surfaces (GDAL)', () => {
  const surfaces = byKind(fixture('surfaces.fgb'));

  it('turns TIN and PolyhedralSurface into multi polygons, one polygon per face', () => {
    for (const kind of ['tin', 'polyhedral']) {
      const [f] = surfaces.get(kind)!;
      expect(f.type).toBe(GeomType.MultiPolygon);
      expect(Array.from(f.ends!)).toEqual([4, 8]);
      expect(Array.from(f.parts!)).toEqual([0, 1]);
    }
  });

  it('turns a triangle into a polygon', () => {
    const [f] = surfaces.get('triangle')!;
    expect(f.type).toBe(GeomType.Polygon);
    expect(f.xy.length / 2).toBe(4);
  });

  it('reads a typed 3D TIN layer', () => {
    const { features: [f] } = decodeFile(fixture('tin-z.fgb'));
    expect(f.type).toBe(GeomType.MultiPolygon);
    expect(Array.from(f.parts!)).toEqual([0, 1]);
  });

  it('encodes every face as an exterior ring', async () => {
    const { x, y } = tileAt(-100.5, 40.5, 6);
    const layer = await layerOf({ name: 's', path: fixture('surfaces.fgb') }, 6, x, y);
    const tin = features(layer).find(f => f.id === 1)!;
    expect(tin.type).toBe(3);
    // Two faces, each its own polygon (@mapbox/vector-tile groups rings by winding)
    expect(tin.toGeoJSON(x, y, 6).geometry.type).toBe('MultiPolygon');
  });
});

describe('geometry collections (GDAL)', () => {
  const collections = byKind(fixture('collections.fgb'));

  it('splits a collection into one feature per family, sharing id and properties', () => {
    const parts = collections.get('mixed')!;
    expect(parts.map(f => f.type)).toEqual([GeomType.Polygon, GeomType.LineString, GeomType.Point]);
    expect(new Set(parts.map(f => f.id))).toEqual(new Set([1]));
    expect(parts[0].properties).toBe(parts[1].properties);
  });

  it('merges members of the same family, including nested multi geometries and curves', () => {
    const parts = collections.get('nested')!;
    expect(parts.map(f => f.type)).toEqual([GeomType.MultiPolygon, GeomType.LineString, GeomType.MultiPoint]);
    expect(Array.from(parts[0].parts!)).toEqual([0, 1]);
    expect(onCircle(parts[1].xy, -94, 38, 1)).toBe(true);
    expect(parts[2].xy.length / 2).toBe(2);
  });

  it('produces a single feature for a single-family collection', () => {
    expect(collections.get('points')!.map(f => f.type)).toEqual([GeomType.MultiPoint]);
  });

  it('emits one MVT feature per family', async () => {
    const { x, y } = tileAt(-100, 40, 5);
    const layer = await layerOf({ name: 'g', path: fixture('collections.fgb') }, 5, x, y);
    const mixed = features(layer).filter(f => f.properties.kind === 'mixed');
    expect(mixed.map(f => f.type).sort()).toEqual([1, 2, 3]);
    expect(mixed.every(f => f.id === 1)).toBe(true);
  });
});

describe('mixed layers (GDAL, header type Unknown)', () => {
  it('uses each feature\'s own geometry type', () => {
    const kinds = byKind(fixture('mixed.fgb'));
    expect(Object.fromEntries([...kinds].map(([k, [f]]) => [k, f.type]))).toEqual({
      point: GeomType.Point,
      line: GeomType.LineString,
      polygon: GeomType.Polygon,
      multipoint: GeomType.MultiPoint,
      multiline: GeomType.MultiLineString,
      multipolygon: GeomType.MultiPolygon,
    });
  });
});

describe('unknown and abstract geometry types', () => {
  it('skips and counts them, never emitting points', async () => {
    const point = { xy: [-100, 40] };
    const path = file({
      geometryType: GeomType.Unknown,
      columns: [{ name: 'n', type: ColumnType.Int }],
      features: [
        { geometry: { ...point }, properties: prop.int(0, 0) },              // no type: Unknown
        { geometry: { ...point, type: 13 }, properties: prop.int(0, 1) },    // Curve (abstract)
        { geometry: { ...point, type: 14 }, properties: prop.int(0, 2) },    // Surface (abstract)
        { geometry: { ...point, type: 42 }, properties: prop.int(0, 3) },    // beyond the schema
        { geometry: { type: 7, parts: [] }, properties: prop.int(0, 4) },    // empty collection
        { properties: prop.int(0, 5) },                                      // no geometry
        { geometry: { ...point, type: 1 }, properties: prop.int(0, 6) },
      ],
    });
    const chunk = decodeFile(path);
    expect(chunk.skipped).toBe(6);
    expect(chunk.features.map(f => f.properties.get('n'))).toEqual([6]);

    const layer = await layerOf({ name: 'u', path }, 0, 0, 0);
    expect(features(layer).map(f => f.properties.n)).toEqual([6]);
  });
});

// == P2.3 Per-feature column schema ===========================================

describe('per-feature column schema', () => {
  it('decodes properties with the feature\'s own columns when present', () => {
    const path = file({
      geometryType: GeomType.Point,
      columns: [{ name: 'height', type: ColumnType.Double }],
      features: [
        { geometry: { xy: [1, 1] }, properties: prop.double(0, 12.5) },
        {
          geometry: { xy: [2, 2] },
          columns: [{ name: 'id', type: ColumnType.Int }, { name: 'name', type: ColumnType.String }],
          properties: prop.concat(prop.int(0, 77), prop.string(1, 'own schema')),
        },
      ],
    });
    const [a, b] = decodeFile(path).features;
    expect([...a.properties]).toEqual([['height', 12.5]]);
    expect(a.id).toBeNull();
    expect([...b.properties]).toEqual([['name', 'own schema']]);
    expect(b.id).toBe(77);
  });

  it('rejects an unknown column type in a feature schema', () => {
    const path = file({
      geometryType: GeomType.Point,
      features: [{ geometry: { xy: [1, 1] }, columns: [{ name: 'x', type: 99 }], properties: prop.int(0, 1) }],
    });
    expect(() => decodeFile(path)).toThrow(UnsupportedFormatError);
  });
});

// == P2.4 CRS =================================================================

/** Decoded point features keyed by id: tile-space coordinates. */
async function pointsById(source: Source, z: number, x: number, y: number) {
  const out = new Map<number, number[]>();
  for (const f of features(await layerOf(source, z, x, y))) {
    const [p] = f.loadGeometry()[0];
    out.set(f.id, [p.x, p.y]);
  }
  return out;
}

/** World Equidistant Cylindrical (EPSG:4087): x = R·λ, y = R·φ. */
const R = 6378137;
const equirectangular: Projection = {
  toWgs84: (x, y) => [(x / R) * (180 / Math.PI), (y / R) * (180 / Math.PI)],
  fromWgs84: (lon, lat) => [(lon * Math.PI / 180) * R, (lat * Math.PI / 180) * R],
};

describe('coordinate reference systems', () => {
  const tiles = [[0, 0, 0], [5, ...Object.values(tileAt(-97, 32, 5))], [9, ...Object.values(tileAt(-97, 32, 9))]];

  it('reads Web Mercator (EPSG:3857) natively', async () => {
    for (const [z, x, y] of tiles) {
      const lonlat = await pointsById({ name: 'l', path: fixture('points.fgb') }, z, x, y);
      const mercator = await pointsById({ name: 'l', path: fixture('points-3857.fgb') }, z, x, y);
      expect(mercator.size).toBe(lonlat.size);
      for (const [id, [px, py]] of lonlat) {
        const [qx, qy] = mercator.get(id)!;
        expect(Math.abs(px - qx)).toBeLessThanOrEqual(1);
        expect(Math.abs(py - qy)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rejects other CRSs unless a projection is given', async () => {
    const path = fixture('points-4087.fgb');
    const err = await tile(connector, 0, 0, 0, { name: 'l', path }).catch(e => e);
    expect(err).toBeInstanceOf(UnsupportedFormatError);
    expect(err.message).toMatch(/EPSG:4087/);
    expect(err.path).toBe(path);

    for (const [z, x, y] of tiles) {
      const lonlat = await pointsById({ name: 'l', path: fixture('points.fgb') }, z, x, y);
      const projected = await pointsById({ name: 'l', path, crs: equirectangular }, z, x, y);
      expect(projected.size).toBe(lonlat.size);
      for (const [id, [px, py]] of lonlat) {
        const [qx, qy] = projected.get(id)!;
        expect(Math.abs(px - qx)).toBeLessThanOrEqual(1);
        expect(Math.abs(py - qy)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('lets a source declare its coordinates as lon/lat', async () => {
    const path = file({
      geometryType: GeomType.Point,
      crs: { org: 'EPSG', code: 4258, name: 'ETRS89' },
      features: [{ geometry: { xy: [10, 50] } }],
    });
    await expect(tile(connector, 0, 0, 0, { name: 'l', path })).rejects.toThrow(/EPSG:4258/);
    const layer = await layerOf({ name: 'l', path, crs: 'lonlat' }, 0, 0, 0);
    expect(layer?.length).toBe(1);
  });

  it('reports TileJSON bounds in WGS 84', async () => {
    const lonlat = parseHeader(new Uint8Array(readFileSync(fixture('points.fgb')))).bbox!;
    for (const source of [
      { name: 'm', path: fixture('points-3857.fgb') },
      { name: 'e', path: fixture('points-4087.fgb'), crs: equirectangular },
    ]) {
      const server = new TileServer({ connector: new LocalConnector(), sources: source });
      const { bounds } = await server.tileJSON();
      expect(bounds[0]).toBeCloseTo(lonlat.minX, 6);
      expect(bounds[1]).toBeCloseTo(lonlat.minY, 6);
      expect(bounds[2]).toBeCloseTo(lonlat.maxX, 6);
      expect(bounds[3]).toBeCloseTo(lonlat.maxY, 6);
      await server.close();
    }
  });
});

// == P2.5 Envelope ============================================================

describe('envelope', () => {
  it('drops an invalid envelope', () => {
    for (const envelope of [[NaN, NaN, NaN, NaN], [10, 10, 0, 0], [0, 0, Infinity, 1], [1, 2, 3]]) {
      const bytes = writeFgb({ geometryType: GeomType.Point, envelope, features: [{ geometry: { xy: [1, 1] } }] });
      expect(parseHeader(bytes).bbox).toBeNull();
    }
  });

  it('falls back to the index root for TileJSON bounds', async () => {
    const bytes = new Uint8Array(readFileSync(fixture('points.fgb')));
    const header = parseHeader(bytes);
    // Overwrite the envelope values with NaN, as some writers do
    const view = new DataView(bytes.buffer);
    let at = -1;
    for (let i = 12; i + 32 <= header.headerSize; i++) {
      if (view.getFloat64(i, true) === header.bbox!.minX && view.getFloat64(i + 16, true) === header.bbox!.maxX) {
        at = i;
        break;
      }
    }
    expect(at).toBeGreaterThan(0);
    for (let k = 0; k < 4; k++) view.setFloat64(at + k * 8, NaN, true);
    const path = file(bytes);
    expect(parseHeader(bytes).bbox).toBeNull();

    const server = new TileServer({ connector: new LocalConnector(), sources: { name: 'p', path } });
    const { bounds } = await server.tileJSON();
    expect(bounds).toEqual([header.bbox!.minX, header.bbox!.minY, header.bbox!.maxX, header.bbox!.maxY]);
    await server.close();
  });
});

// == P2.6 Z, M, T and TM ======================================================

describe('Z, M, T and TM dimensions', () => {
  it('produces identical tiles whatever dimensions the file carries', async () => {
    const { x, y } = tileAt(-97, 40, 5);
    const reference = await tile(connector, 5, x, y, { name: 'd', path: fixture('dims-xy.fgb') });
    expect(decodeLayer(reference, 'd')?.length).toBe(3);
    for (const dims of ['xyz', 'xym', 'xyzm']) {
      const header = parseHeader(new Uint8Array(readFileSync(fixture(`dims-${dims}.fgb`))));
      expect(header.geometryType).toBe(GeomType.Unknown);
      const pbf = await tile(connector, 5, x, y, { name: 'd', path: fixture(`dims-${dims}.fgb`) });
      expect(Buffer.from(pbf).equals(Buffer.from(reference))).toBe(true);
    }
  });

  it('ignores T and TM vectors', () => {
    const geometry = { xy: [0, 0, 1, 1, 2, 0] };
    const plain = file({ geometryType: GeomType.LineString, features: [{ geometry }] });
    const timed = file({
      geometryType: GeomType.LineString,
      features: [{ geometry: { ...geometry, z: [1, 2, 3], m: [4, 5, 6], t: [7, 8, 9], tm: [10, 11, 12] } }],
    });
    expect(decodeFile(timed).features).toEqual(decodeFile(plain).features);
  });
});

describe('open()', () => {
  it('fails early for a CRS without projection', async () => {
    const { TileClient } = await import('../../src/client.js');
    const client = new TileClient(new LocalConnector());
    await expect(client.open({ name: 'l', path: fixture('points-4087.fgb') })).rejects.toBeInstanceOf(UnsupportedFormatError);
    await client.open({ name: 'l', path: fixture('points-4087.fgb'), crs: equirectangular });
    await client.close();
  });
});

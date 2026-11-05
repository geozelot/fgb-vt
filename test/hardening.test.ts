/**
 * Regression tests for defects found in the 1.0.5 review: decoder bounds,
 * corrupt geometry and properties, index reads with unknown file size, and
 * geometry edge cases in clipping, simplification and encoding.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VectorTile } from '@mapbox/vector-tile';
import Protobuf from 'pbf';
import { FlatBufferReader } from '../src/fgb/flatbuffers.js';
import { decodeFeatureChunk } from '../src/fgb/feature.js';
import { parseHeader } from '../src/fgb/header.js';
import { FgbSource, createIoContext } from '../src/fgb/reader.js';
import { MemoryCache } from '../src/cache.js';
import { buildMvtLayer } from '../src/mvt/layer.js';
import { zigzag } from '../src/mvt/geometry.js';
import { encodePbf } from '../src/pbf/encode.js';
import { tileClipBounds } from '../src/tiles.js';
import { GeomType, type RawFeature, type PropertyValue } from '../src/types.js';
import { FormatError, IndexMismatchError } from '../src/errors.js';
import type { Connector, ReadOptions, ReadHeadResult } from '../src/connectors/connector.js';
import { writeFgb, prop } from './helpers/fgb-writer.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const WORLD = { minX: -180, minY: -90, maxX: 180, maxY: 90 };

/** In-memory connector over one file, logging reads; `readHead` optional. */
class MemoryConnector implements Connector {
  readonly log: string[] = [];
  readHead?: (path: string, length: number) => Promise<ReadHeadResult>;

  constructor(private readonly bytes: Uint8Array, withHead = true) {
    if (withHead) {
      this.readHead = async (_path, length) => ({ bytes: this.bytes.slice(0, length), size: this.bytes.length, etag: null });
    }
  }

  async read(_path: string, offset: number, length: number, _options?: ReadOptions): Promise<Uint8Array> {
    this.log.push(`${offset}+${length}`);
    return this.bytes.slice(offset, offset + length);
  }

  async readRanges(path: string, ranges: ReadonlyArray<{ offset: number; length: number }>, options?: ReadOptions) {
    return Promise.all(ranges.map(r => this.read(path, r.offset, r.length, options)));
  }

  async close(): Promise<void> {}
}

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/** Decode the features of a hand-written file. */
function decodeFile(file: Uint8Array) {
  const header = parseHeader(file);
  return decodeFeatureChunk(file.subarray(header.featuresOffset), header);
}

function sizePrefixed(fb: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + fb.length);
  new DataView(out.buffer).setUint32(0, fb.length, true);
  out.set(fb, 4);
  return out;
}

/**
 * A feature whose geometry nests `parts` four levels deep, every entry of
 * each parts vector pointing at the same child table (valid FlatBuffers).
 */
function aliasedPartsFeature(n: number): Uint8Array {
  const buf = new Uint8Array(1 << 16);
  const v = new DataView(buf.buffer);
  let pos = 0;
  const u8 = (x: number) => { v.setUint8(pos, x); pos += 1; };
  const u16 = (x: number) => { v.setUint16(pos, x, true); pos += 2; };
  const u32 = (x: number) => { v.setUint32(pos, x, true); pos += 4; };
  const i32 = (x: number) => { v.setInt32(pos, x, true); pos += 4; };
  const align = (k: number) => { while (pos % k) u8(0); };

  u32(0); // root offset
  const featureVtable = pos; u16(6); u16(8); u16(4); align(4);
  const feature = pos; i32(feature - featureVtable); const geometrySlot = pos; u32(0);
  v.setUint32(0, feature, true);
  const partsVtable = pos; u16(20); u16(12); for (let f = 0; f < 8; f++) u16(f === 7 ? 4 : f === 6 ? 8 : 0); align(4);
  const xyVtable = pos; u16(20); u16(12); for (let f = 0; f < 8; f++) u16(f === 1 ? 4 : f === 6 ? 8 : 0); align(4);

  for (let level = 0; level < 4; level++) {
    align(4);
    const table = pos; i32(table - partsVtable); const partsSlot = pos; u32(0); u8(6); align(4);
    if (level === 0) v.setUint32(geometrySlot, table - geometrySlot, true);
    const vector = pos; u32(n);
    v.setUint32(partsSlot, vector - partsSlot, true);
    const elements = pos; for (let i = 0; i < n; i++) u32(0);
    align(4);
    const next = pos;
    for (let i = 0; i < n; i++) v.setUint32(elements + i * 4, next - (elements + i * 4), true);
    if (level === 3) {
      const leaf = pos; i32(leaf - xyVtable); const xySlot = pos; u32(0); u8(3); align(4);
      while ((pos + 4) % 8) u8(0);
      const xy = pos; u32(8); for (let k = 0; k < 4; k++) { v.setFloat64(pos, k, true); pos += 8; v.setFloat64(pos, k * 2, true); pos += 8; }
      v.setUint32(xySlot, xy - xySlot, true);
    }
  }
  return buf.slice(0, pos);
}

describe('FlatBufferReader bounds', () => {
  it('bounds reads by its view, not the whole buffer', () => {
    const backing = new Uint8Array(64);
    const fb = new FlatBufferReader(backing.subarray(0, 8));
    expect(() => fb.readBytes(0, 16)).toThrow(RangeError);
    expect(() => fb.readFloat64Array(0, 4)).toThrow(RangeError);
    expect(() => fb.readUint32Array(4, 2)).toThrow(RangeError);
    new DataView(backing.buffer).setUint32(0, 20, true);
    expect(() => fb.readString(0)).toThrow(RangeError);
  });

  it('rejects huge counts before allocating', () => {
    const fb = new FlatBufferReader(new Uint8Array(15), 1);
    expect(() => fb.readFloat64Array(0, 2 ** 31)).toThrow(RangeError);
  });

  it('keeps a leading U+FEFF in strings', () => {
    const text = new TextEncoder().encode('﻿name');
    const bytes = new Uint8Array(4 + text.length);
    new DataView(bytes.buffer).setUint32(0, text.length, true);
    bytes.set(text, 4);
    expect(new FlatBufferReader(bytes).readString(0)).toBe('﻿name');
  });
});

describe('feature decoding', () => {
  it('fails fast on aliased parts instead of decoding N^4 copies', () => {
    const file = writeFgb({ geometryType: GeomType.MultiPolygon, features: [{ geometry: { xy: [0, 0] } }] });
    const header = parseHeader(file);
    for (const n of [30, 120]) {
      const started = performance.now();
      expect(() => decodeFeatureChunk(sizePrefixed(aliasedPartsFeature(n)), header)).toThrow(FormatError);
      expect(performance.now() - started).toBeLessThan(1000);
    }
    const collection = parseHeader(writeFgb({ geometryType: GeomType.GeometryCollection, features: [{ geometry: { xy: [0, 0] } }] }));
    expect(() => decodeFeatureChunk(sizePrefixed(aliasedPartsFeature(120)), collection)).toThrow(FormatError);
  });

  it('takes the header type when a geometry stores type 0', () => {
    const file = writeFgb({ geometryType: GeomType.Point, features: [{ geometry: { type: 0, xy: [1, 2] } }] });
    const { features, skipped } = decodeFile(file);
    expect(skipped).toBe(0);
    expect(features[0].type).toBe(GeomType.Point);
  });

  it('reports inconsistent ends and odd coordinate counts as corrupt', () => {
    const badEnds = writeFgb({ geometryType: GeomType.Polygon, features: [{ geometry: { xy: [0, 0, 1, 0, 1, 1, 0, 0], ends: [3] } }] });
    expect(() => decodeFile(badEnds)).toThrow(/ring ends do not match/);
    const odd = writeFgb({ geometryType: GeomType.LineString, features: [{ geometry: { xy: [0, 0, 1] } }] });
    expect(() => decodeFile(odd)).toThrow(/odd number/);
  });

  it('reports truncated and unknown-column properties as corrupt', () => {
    const columns = [{ name: 'a', type: 11 }, { name: 'b', type: 5 }];
    const truncated = new Uint8Array([0, 0, 1, 0, 0, 1, 0x2a, 0]); // string of length 0x01000001
    expect(() => decodeFile(writeFgb({ geometryType: 1, columns, features: [{ geometry: { xy: [1, 2] }, properties: truncated }] })))
      .toThrow(/extends beyond the properties/);
    expect(() => decodeFile(writeFgb({ geometryType: 1, columns, features: [{ geometry: { xy: [1, 2] }, properties: prop.int(9, 7) }] })))
      .toThrow(/column 9 does not exist/);
  });

  it('keeps a leading U+FEFF in property values', () => {
    const file = writeFgb({
      geometryType: 1,
      columns: [{ name: 's', type: 11 }],
      features: [{ geometry: { xy: [1, 2] }, properties: prop.string(0, '﻿hello') }],
    });
    expect(decodeFile(file).features[0].properties.get('s')).toBe('﻿hello');
  });
});

describe('index reads', () => {
  it('reads every feature of a large run ending at the last feature without the file size', async () => {
    const connector = new MemoryConnector(fixture('grid-5k.fgb'), false);
    const source = await FgbSource.open(connector, 'grid-5k.fgb', createIoContext({ cache: false }, new MemoryCache()));
    expect(source.size).toBeNull();
    expect(await source.readFeatures(WORLD)).toHaveLength(5000);
  });

  it('blames the index for a feature longer than its entry, without an unbudgeted re-read', async () => {
    const bytes = fixture('points.fgb');
    const header = parseHeader(bytes);
    const view = new DataView(bytes.buffer);
    let offset = header.featuresOffset;
    for (let i = 0; i < 2; i++) offset += 4 + view.getUint32(offset, true);
    view.setUint32(offset, 3_000_000, true);
    const connector = new MemoryConnector(bytes);
    const source = await FgbSource.open(connector, 'points.fgb', createIoContext({ cache: false }, new MemoryCache()));
    connector.log.length = 0;
    await expect(source.readFeatures(WORLD, { maxReadBytes: 1_000_000 })).rejects.toThrow(IndexMismatchError);
    expect(connector.log.every(r => Number(r.split('+')[1]) < 1_000_000)).toBe(true);
  });

  it('reads nothing for a NaN query box', async () => {
    const connector = new MemoryConnector(fixture('grid-5k.fgb'));
    const source = await FgbSource.open(connector, 'grid-5k.fgb', createIoContext({ cache: false }, new MemoryCache()));
    connector.log.length = 0;
    expect(await source.readFeatures({ minX: NaN, minY: NaN, maxX: NaN, maxY: NaN })).toEqual([]);
    expect(connector.log).toEqual([]);
  });

  it('shares index page reads between concurrent cold queries', async () => {
    const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const indexBytes = async (concurrent: number) => {
      const connector = new MemoryConnector(fixture('grid-5k.fgb'));
      const source = await FgbSource.open(connector, 'g', createIoContext({ prefetch: 1024 }, new MemoryCache()));
      const stats = Array.from({ length: concurrent }, () => ({ requests: 0, indexBytes: 0, featureBytes: 0 }));
      await Promise.all(stats.map(s => source.readFeatures(box, { stats: s })));
      return stats.reduce((sum, s) => sum + s.indexBytes, 0);
    };
    const one = await indexBytes(1);
    expect(one).toBeGreaterThan(0);
    expect(await indexBytes(3)).toBe(one);
  });
});

// == Geometry ================================================================

/** Build a single layer in tile 5/16/16 (lon 0..11.25, lat -11.18..0) from lon/lat features. */
function layerOf(features: RawFeature[], tolerance = 3) {
  const clip = tileClipBounds(5, 16, 16, 64, 4096);
  const layer = buildMvtLayer(features, 'l', 5, 16, 16, clip, 4096, tolerance);
  return { layer, tile: new VectorTile(new Protobuf(encodePbf([layer]))) };
}

function feature(type: GeomType, xy: number[], ends: number[] | null = null, properties = new Map<string, PropertyValue>()): RawFeature {
  return { type, xy: new Float64Array(xy), ends: ends ? new Uint32Array(ends) : null, parts: null, properties, id: null };
}

describe('geometry edge cases', () => {
  it('keeps axis-aligned line parts when simplifying', () => {
    const lines = () => feature(GeomType.MultiLineString, [5.625, -10, 5.625, -1, 1, -10, 10, -1], [2, 4]);
    for (const tolerance of [3, 0]) {
      const { tile } = layerOf([lines()], tolerance);
      expect(tile.layers.l.feature(0).loadGeometry()).toHaveLength(2);
    }
    const grid = feature(GeomType.MultiLineString, [2, -10, 2, -1, 4, -10, 4, -1], [2, 4]);
    expect(layerOf([grid]).tile.layers.l.feature(0).loadGeometry()).toHaveLength(2);
  });

  it('drops features with NaN or infinite coordinates instead of emitting a vertex at 0', () => {
    const polygon = feature(GeomType.Polygon, [1, -1, 10, -1, NaN, NaN, 10, -10, 1, -10, 1, -1]);
    const line = feature(GeomType.LineString, [1, -1, Infinity, -5, 10, -10]);
    const { layer } = layerOf([polygon, line]);
    expect(layer.features).toHaveLength(0);
  });

  it('clips the implicit closing edge of unclosed polygon rings', () => {
    // Triangle with one vertex inside the tile and the closing edge crossing it
    const open = feature(GeomType.Polygon, [5, -5, 30, -5, 30, -30]);
    const closed = feature(GeomType.Polygon, [5, -5, 30, -5, 30, -30, 5, -5]);
    const a = layerOf([open]).tile.layers.l.feature(0).loadGeometry();
    const b = layerOf([closed]).tile.layers.l.feature(0).loadGeometry();
    expect(a).toEqual(b);
    expect(a[0].length).toBeGreaterThanOrEqual(4);
  });

  it('drops a polygon whose hole covers the whole tile', () => {
    const covered = feature(GeomType.Polygon, [
      -50, 50, 50, 50, 50, -50, -50, -50, -50, 50, // exterior
      -20, 20, -20, -20, 20, -20, 20, 20, -20, 20, // hole containing the tile
    ], [5, 10]);
    expect(layerOf([covered]).layer.features).toHaveLength(0);
  });

  it('skips NaN and infinite property values', () => {
    const properties = new Map<string, PropertyValue>([['a', NaN], ['b', Infinity], ['c', 1.5], ['d', -Infinity]]);
    const { tile } = layerOf([feature(GeomType.Point, [5, -5], null, properties)]);
    expect(tile.layers.l.feature(0).properties).toEqual({ c: 1.5 });
  });

  it('zigzag-encodes large deltas as unsigned', () => {
    expect(zigzag(2 ** 30)).toBe(2 ** 31);
    expect(zigzag(-(2 ** 30))).toBe(2 ** 31 - 1);
  });
});

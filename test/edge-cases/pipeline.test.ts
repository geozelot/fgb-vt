import { describe, it, expect } from 'vitest';
import { buildMvtLayer } from '../../src/mvt/layer.js';
import { encodePbf } from '../../src/pbf/encode.js';
import { tileClipBounds, tileBBox } from '../../src/tiles.js';
import type { RawFeature } from '../../src/types.js';
import { GeomType } from '../../src/types.js';
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

const extent = 4096;
const buffer = 64;
const tolerance = 3;

function buildAndEncode(
  features: RawFeature[],
  name: string,
  z: number, x: number, y: number,
): Uint8Array {
  const clip = tileClipBounds(z, x, y, buffer, extent);
  const layer = buildMvtLayer(features, name, z, x, y, clip, extent, tolerance);
  return encodePbf([layer]);
}

describe('Pipeline edge cases', () => {
  // ─── Empty tiles ──────────────────────────────────────────────────────

  it('should produce a valid (possibly empty) PBF for empty feature array', () => {
    const pbf = buildAndEncode([], 'empty', 5, 16, 16);
    expect(pbf).toBeInstanceOf(Uint8Array);
    // Valid PBF, even if empty
    expect(() => new VectorTile(new Pbf(pbf))).not.toThrow();
  });

  it('should produce an empty tile when all features are outside the tile', () => {
    // Feature at (0, 0) — won't intersect tile at z=5, x=31, y=0
    const features: RawFeature[] = [{
      type: GeomType.Point,
      xy: new Float64Array([0, 0]),
      ends: null,
      properties: new Map(),
      id: 1,
    }];
    const clip = tileClipBounds(5, 31, 0, buffer, extent);
    const layer = buildMvtLayer(features, 'test', 5, 31, 0, clip, extent, tolerance);
    expect(layer.features.length).toBe(0);
  });

  // ─── Features at exact tile boundary ─────────────────────────────────

  it('should handle features at exact tile boundaries', () => {
    const z = 5, x = 16, y = 16;
    const bbox = tileBBox(z, x, y);
    // Place point exactly at the top-left corner of the tile
    const features: RawFeature[] = [{
      type: GeomType.Point,
      xy: new Float64Array([bbox.minX, bbox.maxY]),
      ends: null,
      properties: new Map([['edge', 'top-left']]),
      id: 1,
    }];
    const clip = tileClipBounds(z, x, y, buffer, extent);
    const layer = buildMvtLayer(features, 'boundary', z, x, y, clip, extent, tolerance);
    // With buffer, the point should be included
    expect(layer.features.length).toBe(1);
  });

  // ─── Very small feature at high zoom ─────────────────────────────────

  it('should handle a tiny polygon at high zoom', () => {
    const z = 18, x = 131072, y = 131072;
    const bbox = tileBBox(z, x, y);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const d = 0.00001; // very small

    const features: RawFeature[] = [{
      type: GeomType.Polygon,
      xy: new Float64Array([
        cx - d, cy - d,
        cx + d, cy - d,
        cx + d, cy + d,
        cx - d, cy + d,
        cx - d, cy - d,
      ]),
      ends: new Uint32Array([5]),
      properties: new Map([['type', 'micro']]),
      id: 1,
    }];

    const clip = tileClipBounds(z, x, y, buffer, extent);
    const layer = buildMvtLayer(features, 'micro', z, x, y, clip, extent, tolerance);
    // May or may not survive simplification — shouldn't crash
    expect(layer).toBeDefined();
    expect(layer.name).toBe('micro');
  });

  // ─── Feature with many properties ────────────────────────────────────

  it('should handle features with many properties', () => {
    const z = 5, x = 16, y = 16;
    const bbox = tileBBox(z, x, y);
    const props = new Map<string, string | number | boolean>();
    for (let i = 0; i < 100; i++) {
      props.set(`key_${i}`, `value_${i}`);
    }
    props.set('number_prop', 42);
    props.set('bool_prop', true);
    props.set('float_prop', 3.14);
    props.set('negative_prop', -100);

    const features: RawFeature[] = [{
      type: GeomType.Point,
      xy: new Float64Array([(bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2]),
      ends: null,
      properties: props,
      id: 1,
    }];

    const pbf = buildAndEncode(features, 'props', z, x, y);
    const tile = new VectorTile(new Pbf(pbf));
    if (tile.layers.props) {
      const f = tile.layers.props.feature(0);
      expect(f.properties.key_0).toBe('value_0');
      expect(f.properties.key_99).toBe('value_99');
      expect(f.properties.number_prop).toBe(42);
      expect(f.properties.bool_prop).toBe(true);
      expect(f.properties.float_prop).toBeCloseTo(3.14);
      expect(f.properties.negative_prop).toBe(-100);
    }
  });

  // ─── Feature with null properties ────────────────────────────────────

  it('should skip null and binary property values', () => {
    const z = 5, x = 16, y = 16;
    const bbox = tileBBox(z, x, y);

    const features: RawFeature[] = [{
      type: GeomType.Point,
      xy: new Float64Array([(bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2]),
      ends: null,
      properties: new Map<string, any>([
        ['name', 'test'],
        ['nullable', null],
        ['binary', new Uint8Array([1, 2, 3])],
      ]),
      id: 1,
    }];

    const pbf = buildAndEncode(features, 'nulls', z, x, y);
    const tile = new VectorTile(new Pbf(pbf));
    if (tile.layers.nulls) {
      const f = tile.layers.nulls.feature(0);
      expect(f.properties.name).toBe('test');
      expect(f.properties.nullable).toBeUndefined();
      expect(f.properties.binary).toBeUndefined();
    }
  });

  // ─── Feature with no ID ─────────────────────────────────────────────

  it('should handle features with null id', () => {
    const z = 5, x = 16, y = 16;
    const bbox = tileBBox(z, x, y);

    const features: RawFeature[] = [{
      type: GeomType.Point,
      xy: new Float64Array([(bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2]),
      ends: null,
      properties: new Map([['name', 'no-id']]),
      id: null,
    }];

    const pbf = buildAndEncode(features, 'noid', z, x, y);
    const tile = new VectorTile(new Pbf(pbf));
    if (tile.layers.noid) {
      expect(tile.layers.noid.length).toBe(1);
    }
  });

  // ─── Large number of features ────────────────────────────────────────

  it('should handle hundreds of features in a single tile', () => {
    const z = 10, x = 512, y = 340;
    const bbox = tileBBox(z, x, y);
    const features: RawFeature[] = [];
    for (let i = 0; i < 500; i++) {
      const lng = bbox.minX + Math.random() * (bbox.maxX - bbox.minX);
      const lat = bbox.minY + Math.random() * (bbox.maxY - bbox.minY);
      features.push({
        type: GeomType.Point,
        xy: new Float64Array([lng, lat]),
        ends: null,
        properties: new Map([['idx', i]]),
        id: i,
      });
    }

    const pbf = buildAndEncode(features, 'many', z, x, y);
    const tile = new VectorTile(new Pbf(pbf));
    expect(tile.layers.many).toBeDefined();
    expect(tile.layers.many.length).toBe(500);
  });

  // ─── MultiLineString / MultiPolygon ──────────────────────────────────

  it('should handle a MultiLineString feature', () => {
    const z = 5, x = 16, y = 16;
    const bbox = tileBBox(z, x, y);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const d = (bbox.maxX - bbox.minX) * 0.1;

    const features: RawFeature[] = [{
      type: GeomType.MultiLineString,
      xy: new Float64Array([
        cx - d, cy, cx, cy + d,     // line 1
        cx, cy - d, cx + d, cy,     // line 2
      ]),
      ends: new Uint32Array([2, 4]),
      properties: new Map([['type', 'multi']]),
      id: 1,
    }];

    const clip = tileClipBounds(z, x, y, buffer, extent);
    const layer = buildMvtLayer(features, 'multiline', z, x, y, clip, extent, tolerance);
    expect(layer.name).toBe('multiline');
    // Should not crash
  });

  it('should handle a polygon with a hole', () => {
    const z = 5, x = 16, y = 16;
    const bbox = tileBBox(z, x, y);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const d1 = (bbox.maxX - bbox.minX) * 0.3;
    const d2 = d1 * 0.3;

    const features: RawFeature[] = [{
      type: GeomType.Polygon,
      xy: new Float64Array([
        // Exterior ring
        cx - d1, cy - d1,
        cx + d1, cy - d1,
        cx + d1, cy + d1,
        cx - d1, cy + d1,
        cx - d1, cy - d1,
        // Interior ring (hole)
        cx - d2, cy - d2,
        cx + d2, cy - d2,
        cx + d2, cy + d2,
        cx - d2, cy + d2,
        cx - d2, cy - d2,
      ]),
      ends: new Uint32Array([5, 10]),
      properties: new Map([['type', 'holed']]),
      id: 1,
    }];

    const pbf = buildAndEncode(features, 'holes', z, x, y);
    const tile = new VectorTile(new Pbf(pbf));
    if (tile.layers.holes) {
      expect(tile.layers.holes.length).toBe(1);
      expect(tile.layers.holes.feature(0).type).toBe(3); // POLYGON
    }
  });

  // ─── Multi-layer encoding ─────────────────────────────────────────────

  it('should encode multiple empty layers without crashing', () => {
    const z = 5, x = 16, y = 16;
    const clip = tileClipBounds(z, x, y, buffer, extent);

    const layers = [
      buildMvtLayer([], 'empty1', z, x, y, clip, extent, tolerance),
      buildMvtLayer([], 'empty2', z, x, y, clip, extent, tolerance),
    ];

    const pbf = encodePbf(layers);
    expect(pbf).toBeInstanceOf(Uint8Array);
    expect(() => new VectorTile(new Pbf(pbf))).not.toThrow();
  });

  // ─── Properties deduplication ─────────────────────────────────────────

  it('should deduplicate property keys and values across features', () => {
    const z = 5, x = 16, y = 16;
    const bbox = tileBBox(z, x, y);
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    const d = (bbox.maxX - bbox.minX) * 0.1;

    const features: RawFeature[] = [];
    for (let i = 0; i < 10; i++) {
      features.push({
        type: GeomType.Point,
        xy: new Float64Array([cx + d * (i - 5), cy]),
        ends: null,
        properties: new Map([
          ['type', 'poi'],        // same across all
          ['category', 'food'],   // same across all
          ['idx', i],             // different per feature
        ]),
        id: i,
      });
    }

    const clip = tileClipBounds(z, x, y, buffer, extent);
    const layer = buildMvtLayer(features, 'dedup', z, x, y, clip, extent, tolerance);

    // 'type' and 'category' should appear once each in keys
    expect(layer.keys.filter(k => k === 'type').length).toBe(1);
    expect(layer.keys.filter(k => k === 'category').length).toBe(1);

    // 'poi' and 'food' should appear once each in values
    const stringVals = layer.values.filter(v => v.type === 'string').map(v => v.value);
    expect(stringVals.filter(v => v === 'poi').length).toBe(1);
    expect(stringVals.filter(v => v === 'food').length).toBe(1);
  });
});

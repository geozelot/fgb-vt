import { describe, it, expect } from 'vitest';
import { encodePbf } from '../../src/pbf/encode.js';
import type { MvtLayer, MvtFeature, MvtValue } from '../../src/types.js';
import { MvtGeomType } from '../../src/types.js';

// We'll use @mapbox/vector-tile + pbf to decode and verify our output
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

describe('encodePbf', () => {
  it('should encode an empty tile', () => {
    const result = encodePbf([]);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  it('should encode a single layer with no features', () => {
    const layer: MvtLayer = {
      name: 'test',
      extent: 4096,
      features: [],
      keys: [],
      values: [],
    };

    const result = encodePbf([layer]);
    expect(result.length).toBeGreaterThan(0);

    // Decode with @mapbox/vector-tile
    // Note: @mapbox/vector-tile may or may not include empty layers
    // (layers with 0 features). We verify the PBF is valid.
    const tile = new VectorTile(new Pbf(result));
    if (tile.layers.test) {
      expect(tile.layers.test.length).toBe(0);
      expect(tile.layers.test.name).toBe('test');
      expect(tile.layers.test.extent).toBe(4096);
    }
    // If the decoder skips empty layers, that's also fine
    // The important thing is the PBF is valid and doesn't error
  });

  it('should encode a point feature with properties', () => {
    const feature: MvtFeature = {
      id: 42,
      type: MvtGeomType.POINT,
      geometry: [9, 100, 200], // MoveTo(1), zigzag(50)=100, zigzag(100)=200
      tags: [0, 0, 1, 1], // name=hello, count=5
    };

    const layer: MvtLayer = {
      name: 'points',
      extent: 4096,
      features: [feature],
      keys: ['name', 'count'],
      values: [
        { type: 'string', value: 'hello' } as MvtValue,
        { type: 'uint', value: 5 } as MvtValue,
      ],
    };

    const result = encodePbf([layer]);

    // Decode with @mapbox/vector-tile
    const tile = new VectorTile(new Pbf(result));
    const decoded = tile.layers.points;
    expect(decoded).toBeDefined();
    expect(decoded.length).toBe(1);

    const f = decoded.feature(0);
    expect(f.id).toBe(42);
    expect(f.type).toBe(1); // POINT
    expect(f.properties.name).toBe('hello');
    expect(f.properties.count).toBe(5);
  });

  it('should encode multiple layers', () => {
    const layer1: MvtLayer = {
      name: 'buildings',
      extent: 4096,
      features: [{
        id: 1,
        type: MvtGeomType.POLYGON,
        geometry: [9, 0, 0, 26, 20, 0, 0, 20, 20, 0, 15],
        tags: [],
      }],
      keys: [],
      values: [],
    };

    const layer2: MvtLayer = {
      name: 'roads',
      extent: 4096,
      features: [{
        id: 2,
        type: MvtGeomType.LINESTRING,
        geometry: [9, 4, 2, 18, 4, 6],
        tags: [],
      }],
      keys: [],
      values: [],
    };

    const result = encodePbf([layer1, layer2]);

    const tile = new VectorTile(new Pbf(result));
    expect(tile.layers.buildings).toBeDefined();
    expect(tile.layers.roads).toBeDefined();
    expect(tile.layers.buildings.length).toBe(1);
    expect(tile.layers.roads.length).toBe(1);
    expect(tile.layers.buildings.feature(0).type).toBe(3); // POLYGON
    expect(tile.layers.roads.feature(0).type).toBe(2); // LINESTRING
  });

  it('should encode various value types', () => {
    const feature: MvtFeature = {
      id: null,
      type: MvtGeomType.POINT,
      geometry: [9, 0, 0],
      tags: [0, 0, 1, 1, 2, 2, 3, 3],
    };

    const layer: MvtLayer = {
      name: 'test',
      extent: 4096,
      features: [feature],
      keys: ['str', 'num', 'flag', 'neg'],
      values: [
        { type: 'string', value: 'world' } as MvtValue,
        { type: 'double', value: 3.14 } as MvtValue,
        { type: 'bool', value: true } as MvtValue,
        { type: 'int', value: -7 } as MvtValue,
      ],
    };

    const result = encodePbf([layer]);
    const tile = new VectorTile(new Pbf(result));
    const f = tile.layers.test.feature(0);

    expect(f.properties.str).toBe('world');
    expect(f.properties.num).toBeCloseTo(3.14, 10);
    expect(f.properties.flag).toBe(true);
    expect(f.properties.neg).toBe(-7);
  });

  it('should handle features without IDs', () => {
    const feature: MvtFeature = {
      id: null,
      type: MvtGeomType.POINT,
      geometry: [9, 0, 0],
      tags: [],
    };

    const layer: MvtLayer = {
      name: 'test',
      extent: 4096,
      features: [feature],
      keys: [],
      values: [],
    };

    const result = encodePbf([layer]);
    const tile = new VectorTile(new Pbf(result));
    const f = tile.layers.test.feature(0);

    // ID should be undefined or 0 (no ID field written)
    expect(f.id).toBeFalsy();
  });
});

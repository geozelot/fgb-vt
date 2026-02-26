import { describe, it, expect } from 'vitest';
import { buildMvtLayer } from '../../src/mvt/layer.js';
import { encodePbf } from '../../src/pbf/encode.js';
import type { RawFeature } from '../../src/types.js';
import { GeomType } from '../../src/types.js';
import type { BBox } from '../../src/types.js';
import { tileClipBounds, tileBBox } from '../../src/tiles.js';

// Use @mapbox/vector-tile + pbf for roundtrip validation
import Pbf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';

describe('Full pipeline: RawFeature → MVT → PBF → decode', () => {
  it('should process a point feature through the entire pipeline', () => {
    // Create a point feature at Berlin (13.4, 52.5)
    const features: RawFeature[] = [{
      type: GeomType.Point,
      xy: new Float64Array([13.4, 52.5]),
      ends: null,
      properties: new Map([
        ['name', 'Berlin'],
        ['population', 3_748_148],
      ]),
      id: 1,
    }];

    // Use z=5, find which tile Berlin falls into
    const z = 5;
    const z2 = 1 << z;
    // Approximate tile for Berlin at z=5
    const x = Math.floor((13.4 / 360 + 0.5) * z2);
    const sinLat = Math.sin(52.5 * Math.PI / 180);
    const y = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * z2);

    const extent = 4096;
    const buffer = 64;
    const tolerance = 3;
    const clipBounds = tileClipBounds(z, x, y, buffer, extent);

    const layer = buildMvtLayer(
      features, 'cities', z, x, y,
      clipBounds, extent, tolerance,
    );

    expect(layer.name).toBe('cities');
    expect(layer.extent).toBe(4096);
    expect(layer.features.length).toBe(1);

    // Keys and values should be populated
    expect(layer.keys).toContain('name');
    expect(layer.keys).toContain('population');
    expect(layer.values.length).toBeGreaterThanOrEqual(2);

    // Encode to PBF
    const pbf = encodePbf([layer]);
    expect(pbf.length).toBeGreaterThan(0);

    // Decode with @mapbox/vector-tile
    const tile = new VectorTile(new Pbf(pbf));
    const decodedLayer = tile.layers.cities;
    expect(decodedLayer).toBeDefined();
    expect(decodedLayer.length).toBe(1);

    const f = decodedLayer.feature(0);
    expect(f.id).toBe(1);
    expect(f.type).toBe(1); // POINT
    expect(f.properties.name).toBe('Berlin');
    expect(f.properties.population).toBe(3_748_148);
  });

  it('should process a polygon feature through the pipeline', () => {
    // Create a small square polygon in WGS84
    // Centered roughly at (10, 50) — Central Europe
    const features: RawFeature[] = [{
      type: GeomType.Polygon,
      xy: new Float64Array([
        9.5, 49.5,
        10.5, 49.5,
        10.5, 50.5,
        9.5, 50.5,
        9.5, 49.5, // closed ring
      ]),
      ends: new Uint32Array([5]),
      properties: new Map([['type', 'zone']]),
      id: 2,
    }];

    const z = 8;
    const z2 = 1 << z;
    const x = Math.floor((10 / 360 + 0.5) * z2);
    const sinLat = Math.sin(50 * Math.PI / 180);
    const y = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * z2);

    const extent = 4096;
    const buffer = 64;
    const tolerance = 3;
    const clipBounds = tileClipBounds(z, x, y, buffer, extent);

    const layer = buildMvtLayer(
      features, 'zones', z, x, y,
      clipBounds, extent, tolerance,
    );

    expect(layer.name).toBe('zones');
    expect(layer.features.length).toBe(1);

    const pbf = encodePbf([layer]);
    const tile = new VectorTile(new Pbf(pbf));

    expect(tile.layers.zones).toBeDefined();
    expect(tile.layers.zones.length).toBe(1);

    const f = tile.layers.zones.feature(0);
    expect(f.id).toBe(2);
    expect(f.type).toBe(3); // POLYGON
    expect(f.properties.type).toBe('zone');
  });

  it('should process a linestring through the pipeline', () => {
    // A line from London to Paris (approximate)
    const features: RawFeature[] = [{
      type: GeomType.LineString,
      xy: new Float64Array([
        -0.1, 51.5,   // London
        1.0, 50.5,    // midpoint
        2.35, 48.86,  // Paris
      ]),
      ends: null,
      properties: new Map([
        ['name', 'London-Paris'],
        ['distance_km', 340],
      ]),
      id: 3,
    }];

    // Use z=6 — both cities should be visible
    const z = 6;
    const z2 = 1 << z;
    // Tile containing midpoint
    const x = Math.floor((1.0 / 360 + 0.5) * z2);
    const sinLat = Math.sin(50.0 * Math.PI / 180);
    const y = Math.floor((0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * z2);

    const extent = 4096;
    const buffer = 64;
    const tolerance = 3;
    const clipBounds = tileClipBounds(z, x, y, buffer, extent);

    const layer = buildMvtLayer(
      features, 'routes', z, x, y,
      clipBounds, extent, tolerance,
    );

    expect(layer.name).toBe('routes');

    if (layer.features.length > 0) {
      const pbf = encodePbf([layer]);
      const tile = new VectorTile(new Pbf(pbf));
      const f = tile.layers.routes.feature(0);
      expect(f.type).toBe(2); // LINESTRING
      expect(f.properties.name).toBe('London-Paris');
    }
  });

  it('should process multiple layers into a single PBF', () => {
    // Two different feature sets at the same tile
    const z = 10, x = 512, y = 340;
    const extent = 4096;
    const buffer = 64;
    const clipBounds = tileClipBounds(z, x, y, buffer, extent);

    // Layer 1: point
    const wgs84 = tileBBox(z, x, y);
    const midLon = (wgs84.minX + wgs84.maxX) / 2;
    const midLat = (wgs84.minY + wgs84.maxY) / 2;

    const pointFeatures: RawFeature[] = [{
      type: GeomType.Point,
      xy: new Float64Array([midLon, midLat]),
      ends: null,
      properties: new Map([['type', 'poi']]),
      id: 1,
    }];

    const layer1 = buildMvtLayer(
      pointFeatures, 'pois', z, x, y,
      clipBounds, extent, 3,
    );

    // Layer 2: polygon covering tile center
    const dLon = (wgs84.maxX - wgs84.minX) * 0.3;
    const dLat = (wgs84.maxY - wgs84.minY) * 0.3;
    const polyFeatures: RawFeature[] = [{
      type: GeomType.Polygon,
      xy: new Float64Array([
        midLon - dLon, midLat - dLat,
        midLon + dLon, midLat - dLat,
        midLon + dLon, midLat + dLat,
        midLon - dLon, midLat + dLat,
        midLon - dLon, midLat - dLat,
      ]),
      ends: new Uint32Array([5]),
      properties: new Map([['type', 'building']]),
      id: 2,
    }];

    const layer2 = buildMvtLayer(
      polyFeatures, 'buildings', z, x, y,
      clipBounds, extent, 3,
    );

    // Encode both layers
    const pbf = encodePbf([layer1, layer2]);
    const tile = new VectorTile(new Pbf(pbf));

    expect(tile.layers.pois).toBeDefined();
    expect(tile.layers.buildings).toBeDefined();
    expect(tile.layers.pois.length).toBe(1);
    expect(tile.layers.buildings.length).toBe(1);
    expect(tile.layers.pois.feature(0).properties.type).toBe('poi');
    expect(tile.layers.buildings.feature(0).properties.type).toBe('building');
  });
});

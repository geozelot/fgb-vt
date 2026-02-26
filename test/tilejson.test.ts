import { describe, it, expect, beforeEach } from 'vitest';
import { TileServer } from '../src/server.js';
import type { Source } from '../src/source.js';
import { buildMockFgb, calcMockIndexSize, MockConnector } from './helpers/mock-fgb.js';

describe('TileJSON metadata generation', () => {
  let connector: MockConnector;

  beforeEach(() => {
    connector = new MockConnector();
  });

  function addMockFgb(
    path: string,
    opts: {
      geometryType?: number;
      featuresCount?: number;
      indexNodeSize?: number;
      bbox?: [number, number, number, number];
      columns?: Array<{ name: string; type: number }>;
    } = {},
  ): void {
    const headerBytes = buildMockFgb(opts);
    // Build full "file": header + index bytes (zeros)
    const fc = opts.featuresCount ?? 10;
    const ns = opts.indexNodeSize ?? 16;
    const indexSize = calcMockIndexSize(fc, ns);
    const fullFile = new Uint8Array(headerBytes.length + indexSize);
    fullFile.set(headerBytes);
    connector.addFile(path, fullFile);
  }

  // ─── Basic TileJSON structure ──────────────────────────────────────

  it('should produce valid TileJSON 3.0.0', async () => {
    addMockFgb('/data/points.fgb', {
      geometryType: 1,
      featuresCount: 100,
      bbox: [-10, 40, 10, 60],
    });

    const source: Source = { name: 'points', path: '/data/points.fgb' };
    const server = new TileServer({ connector, sources: source });

    try {
      const tj = await server.tileJSON();

      expect(tj.tilejson).toBe('3.0.0');
      expect(tj.vector_layers).toHaveLength(1);
      expect(tj.vector_layers[0].id).toBe('points');
      expect(tj.minzoom).toBe(0);
      expect(tj.maxzoom).toBe(24);
    } finally {
      await server.close();
    }
  });

  // ─── Bounds from FGB bbox ────────────────────────────────────────

  it('should use FGB header bbox for bounds', async () => {
    addMockFgb('/data/cities.fgb', {
      bbox: [-73.9, 40.7, -73.8, 40.8],
    });

    const source: Source = { name: 'cities', path: '/data/cities.fgb' };
    const server = new TileServer({ connector, sources: source });

    try {
      const tj = await server.tileJSON();

      expect(tj.bounds[0]).toBeCloseTo(-73.9, 5);
      expect(tj.bounds[1]).toBeCloseTo(40.7, 5);
      expect(tj.bounds[2]).toBeCloseTo(-73.8, 5);
      expect(tj.bounds[3]).toBeCloseTo(40.8, 5);
    } finally {
      await server.close();
    }
  });

  // ─── Default bounds when no bbox ──────────────────────────────────

  it('should use world bounds when no FGB bbox available', async () => {
    addMockFgb('/data/nobbox.fgb', {
      // No bbox specified
    });

    const source: Source = { name: 'nobbox', path: '/data/nobbox.fgb' };
    const server = new TileServer({ connector, sources: source });

    try {
      const tj = await server.tileJSON();

      // Default world bounds
      expect(tj.bounds[0]).toBe(-180);
      expect(tj.bounds[2]).toBe(180);
    } finally {
      await server.close();
    }
  });

  // ─── Multiple sources / layers ────────────────────────────────────

  it('should aggregate multiple sources into vector_layers', async () => {
    addMockFgb('/data/roads.fgb', {
      bbox: [-10, 40, 10, 60],
      columns: [
        { name: 'name', type: 11 },   // String
        { name: 'lanes', type: 5 },    // Int
      ],
    });

    addMockFgb('/data/buildings.fgb', {
      bbox: [-5, 45, 5, 55],
      columns: [
        { name: 'height', type: 10 },  // Double
        { name: 'type', type: 11 },    // String
      ],
    });

    const sources: Source[] = [
      { name: 'roads', path: '/data/roads.fgb' },
      { name: 'buildings', path: '/data/buildings.fgb' },
    ];

    const server = new TileServer({ connector, sources }, { minZoom: 2, maxZoom: 18 });

    try {
      const tj = await server.tileJSON();

      expect(tj.vector_layers).toHaveLength(2);
      expect(tj.vector_layers[0].id).toBe('roads');
      expect(tj.vector_layers[1].id).toBe('buildings');

      // Verify fields mapping
      expect(tj.vector_layers[0].fields).toHaveProperty('name', 'String');
      expect(tj.vector_layers[0].fields).toHaveProperty('lanes', 'Number');
      expect(tj.vector_layers[1].fields).toHaveProperty('height', 'Number');
      expect(tj.vector_layers[1].fields).toHaveProperty('type', 'String');

      // Verify aggregated bounds (union of both bboxes)
      expect(tj.bounds[0]).toBe(-10);
      expect(tj.bounds[1]).toBe(40);
      expect(tj.bounds[2]).toBe(10);
      expect(tj.bounds[3]).toBe(60);

      // Verify zoom range from TileOptions
      expect(tj.minzoom).toBe(2);
      expect(tj.maxzoom).toBe(18);
    } finally {
      await server.close();
    }
  });

  // ─── Per-source zoom overrides ──────────────────────────────────────

  it('should respect per-source zoom overrides', async () => {
    addMockFgb('/data/detail.fgb', { bbox: [0, 0, 1, 1] });
    addMockFgb('/data/overview.fgb', { bbox: [-1, -1, 2, 2] });

    const sources: Source[] = [
      { name: 'detail', path: '/data/detail.fgb', options: { minZoom: 10, maxZoom: 20 } },
      { name: 'overview', path: '/data/overview.fgb', options: { minZoom: 0, maxZoom: 10 } },
    ];

    const server = new TileServer({ connector, sources });

    try {
      const tj = await server.tileJSON();

      expect(tj.vector_layers[0].minzoom).toBe(10);
      expect(tj.vector_layers[0].maxzoom).toBe(20);
      expect(tj.vector_layers[1].minzoom).toBe(0);
      expect(tj.vector_layers[1].maxzoom).toBe(10);

      // Global min/max zoom should be the union
      expect(tj.minzoom).toBe(0);
      expect(tj.maxzoom).toBe(20);
    } finally {
      await server.close();
    }
  });

  // ─── Multi-connector layers ──────────────────────────────────────

  it('should handle multi-connector TileServer layers', async () => {
    const connector2 = new MockConnector();

    addMockFgb('/data/local.fgb', { bbox: [-10, 40, 10, 60] });

    const remoteHeader = buildMockFgb({
      bbox: [100, -10, 120, 10],
      columns: [{ name: 'status', type: 11 }],
    });
    const indexSize = calcMockIndexSize(10, 16);
    const remoteFile = new Uint8Array(remoteHeader.length + indexSize);
    remoteFile.set(remoteHeader);
    connector2.addFile('/data/remote.fgb', remoteFile);

    const server = new TileServer([
      { connector, sources: { name: 'local', path: '/data/local.fgb' } },
      { connector: connector2, sources: { name: 'remote', path: '/data/remote.fgb' } },
    ]);

    try {
      const tj = await server.tileJSON();

      expect(tj.vector_layers).toHaveLength(2);
      expect(tj.vector_layers[0].id).toBe('local');
      expect(tj.vector_layers[1].id).toBe('remote');

      // Bounds should span both
      expect(tj.bounds[0]).toBe(-10);
      expect(tj.bounds[1]).toBe(-10);
      expect(tj.bounds[2]).toBe(120);
      expect(tj.bounds[3]).toBe(60);
    } finally {
      await server.close();
    }
  });

  // ─── Column type mapping ──────────────────────────────────────────

  it('should map all column types correctly', async () => {
    addMockFgb('/data/typed.fgb', {
      columns: [
        { name: 'byte_col', type: 0 },      // Byte → Number
        { name: 'ubyte_col', type: 1 },     // UByte → Number
        { name: 'bool_col', type: 2 },      // Bool → Boolean
        { name: 'short_col', type: 3 },     // Short → Number
        { name: 'int_col', type: 5 },       // Int → Number
        { name: 'long_col', type: 7 },      // Long → Number
        { name: 'float_col', type: 9 },     // Float → Number
        { name: 'double_col', type: 10 },   // Double → Number
        { name: 'string_col', type: 11 },   // String → String
        { name: 'json_col', type: 12 },     // Json → String
        { name: 'datetime_col', type: 13 }, // DateTime → String
        { name: 'binary_col', type: 14 },   // Binary → String
      ],
    });

    const source: Source = { name: 'typed', path: '/data/typed.fgb' };
    const server = new TileServer({ connector, sources: source });

    try {
      const tj = await server.tileJSON();
      const fields = tj.vector_layers[0].fields;

      expect(fields.byte_col).toBe('Number');
      expect(fields.ubyte_col).toBe('Number');
      expect(fields.bool_col).toBe('Boolean');
      expect(fields.short_col).toBe('Number');
      expect(fields.int_col).toBe('Number');
      expect(fields.long_col).toBe('Number');
      expect(fields.float_col).toBe('Number');
      expect(fields.double_col).toBe('Number');
      expect(fields.string_col).toBe('String');
      expect(fields.json_col).toBe('String');
      expect(fields.datetime_col).toBe('String');
      expect(fields.binary_col).toBe('String');
    } finally {
      await server.close();
    }
  });

  // ─── Lazy initialization ──────────────────────────────────────────

  it('should lazily initialize on first tileJSON call', async () => {
    addMockFgb('/data/lazy.fgb', {
      bbox: [0, 0, 10, 10],
    });

    const source: Source = { name: 'lazy', path: '/data/lazy.fgb' };
    const server = new TileServer({ connector, sources: source });

    try {
      // First call should trigger initialization
      const tj1 = await server.tileJSON();
      expect(tj1.vector_layers[0].id).toBe('lazy');

      // Second call should reuse cache
      const tj2 = await server.tileJSON();
      expect(tj2.vector_layers[0].id).toBe('lazy');
    } finally {
      await server.close();
    }
  });

  // ─── Server close and reuse ───────────────────────────────────────

  it('should allow reinitialization after close', async () => {
    addMockFgb('/data/reuse.fgb', {
      bbox: [0, 0, 5, 5],
    });

    const source: Source = { name: 'reuse', path: '/data/reuse.fgb' };
    const server = new TileServer({ connector, sources: source });

    try {
      const tj1 = await server.tileJSON();
      expect(tj1.bounds[2]).toBe(5);

      await server.close();

      // After close, server should reinitialize on next call
      const tj2 = await server.tileJSON();
      expect(tj2.bounds[2]).toBe(5);
    } finally {
      await server.close();
    }
  });
});

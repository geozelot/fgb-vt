/**
 * Per-source property selection and id options, empty-layer handling, the
 * onTile statistics hook and TileJSON output.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tile } from '../src/tile.js';
import { TileClient } from '../src/client.js';
import { TileServer } from '../src/server.js';
import { LocalConnector } from '../src/connectors/local.js';
import type { Connector, ReadOptions } from '../src/connectors/connector.js';
import type { TileStats } from '../src/pipeline.js';
import type { Source } from '../src/source.js';
import { parseHeader } from '../src/fgb/header.js';
import { decodeFeatureChunk } from '../src/fgb/feature.js';
import { featureSchema } from '../src/schema.js';
import { ColumnType, GeomType } from '../src/types.js';
import { fixture, decodeLayer, features, tileAt } from './helpers/tiles.js';
import { writeFgb, prop } from './helpers/fgb-writer.js';

const connector = new LocalConnector();
afterAll(() => connector.close());

const POINTS = fixture('points.fgb');

async function featuresOf(source: Source, z = 0, x = 0, y = 0) {
  return features(decodeLayer(await tile(connector, z, x, y, source), source.name));
}

/** LocalConnector wrapper counting requests (one per range) and bytes. */
class Counting implements Connector {
  readonly inner = new LocalConnector();
  requests = 0;
  bytes = 0;
  headBytes = 0;
  get hints() { return this.inner.hints; }
  async readHead(path: string, length: number, options?: ReadOptions) {
    const r = await this.inner.readHead(path, length, options);
    this.headBytes += r.bytes.length;
    return r;
  }
  async read(path: string, offset: number, length: number, options?: ReadOptions) {
    const b = await this.inner.read(path, offset, length, options);
    this.requests++;
    this.bytes += b.length;
    return b;
  }
  async readRanges(path: string, ranges: ReadonlyArray<{ offset: number; length: number }>, options?: ReadOptions) {
    const out = await this.inner.readRanges(path, ranges, options);
    this.requests += ranges.length;
    for (const b of out) this.bytes += b.length;
    return out;
  }
  close() { return this.inner.close(); }
}

// == P5.1 Property selection ==================================================

describe('property selection', () => {
  it('keeps only the listed properties', async () => {
    const fs = await featuresOf({ name: 'p', path: POINTS, properties: ['label', 'ratio'] });
    expect(fs).toHaveLength(200);
    for (const f of fs) expect(Object.keys(f.properties).sort()).toEqual(['label', 'ratio']);
    // The id column still provides ids
    expect(new Set(fs.map(f => f.id)).size).toBe(200);
  });

  it('drops excluded properties', async () => {
    const fs = await featuresOf({ name: 'p', path: POINTS, properties: { exclude: ['big', 'ts', 'label'] } });
    expect(Object.keys(fs[0].properties).sort()).toEqual(['neg', 'ratio', 'small']);
  });

  it('writes geometry only with an empty list', async () => {
    const fs = await featuresOf({ name: 'p', path: POINTS, properties: [] });
    expect(fs.every(f => Object.keys(f.properties).length === 0)).toBe(true);
    expect(fs.every(f => f.id !== undefined)).toBe(true);
  });

  it('does not decode dropped properties', () => {
    const bytes = new Uint8Array(readFileSync(POINTS));
    const header = parseHeader(bytes);
    const { features: fs } = decodeFeatureChunk(bytes.subarray(header.featuresOffset), header, {
      schema: featureSchema({ name: 'p', path: POINTS, properties: ['small'] }),
    });
    expect([...fs[0].properties.keys()]).toEqual(['small']);
  });

  it('applies to features with their own column schema', () => {
    const bytes = writeFgb({
      geometryType: GeomType.Point,
      features: [{
        geometry: { xy: [1, 1] },
        columns: [{ name: 'a', type: ColumnType.Int }, { name: 'b', type: ColumnType.String }],
        properties: prop.concat(prop.int(0, 1), prop.string(1, 'x')),
      }],
    });
    const header = parseHeader(bytes);
    const { features: [f] } = decodeFeatureChunk(bytes.subarray(header.featuresOffset), header, {
      schema: featureSchema({ name: 'p', path: 'mem', properties: { exclude: ['a'] } }),
    });
    expect([...f.properties]).toEqual([['b', 'x']]);
  });
});

// == P5.2 Feature ids =========================================================

describe('feature id options', () => {
  it('writes no ids with idColumn: false, keeping the column as a property', async () => {
    const fs = await featuresOf({ name: 'p', path: POINTS, idColumn: false });
    expect(fs.every(f => f.id === undefined)).toBe(true);
    expect(fs.map(f => f.properties.id).sort((a, b) => Number(a) - Number(b))[199]).toBe(199);
  });

  it('takes ids from a named integer column; invalid values stay properties', async () => {
    const fs = await featuresOf({ name: 'p', path: POINTS, idColumn: 'small' });
    for (const f of fs) {
      const label = Number(String(f.properties.label).slice(1));
      const small = label - 100;
      if (small >= 0) {
        expect(f.id).toBe(small);
        expect(f.properties.small).toBeUndefined();
      } else {
        expect(f.id).toBeUndefined();
        expect(f.properties.small).toBe(small);
      }
      // the auto-detected id column is an ordinary property now
      expect(f.properties.id).toBe(label);
    }
  });

  it('keeps the id column as a property on request', async () => {
    const fs = await featuresOf({ name: 'p', path: POINTS, keepIdProperty: true });
    expect(fs.every(f => f.id === f.properties.id)).toBe(true);
    const narrowed = await featuresOf({ name: 'p', path: POINTS, keepIdProperty: true, properties: ['label'] });
    expect(narrowed.every(f => f.properties.id === undefined && f.id !== undefined)).toBe(true);
  });

  it('rejects an id column that does not exist or is not an integer column', async () => {
    await expect(tile(connector, 0, 0, 0, { name: 'p', path: POINTS, idColumn: 'nope' }))
      .rejects.toThrow(/idColumn "nope" is not a column/);
    await expect(tile(connector, 0, 0, 0, { name: 'p', path: POINTS, idColumn: 'label' }))
      .rejects.toThrow(RangeError);
    const client = new TileClient(new LocalConnector());
    await expect(client.open({ name: 'p', path: POINTS, idColumn: 'ratio' })).rejects.toThrow(/not an integer column/);
    await client.close();
  });
});

// == P5.3 Empty layers ========================================================

describe('empty layers', () => {
  // Far from every point in points.fgb
  const empty = tileAt(100, -40, 8);
  const sources: Source[] = [{ name: 'a', path: POINTS }, { name: 'b', path: fixture('lines.fgb') }];

  it('keeps empty layers by default', async () => {
    // Two layer messages with name, extent and version, but no features
    // (@mapbox/vector-tile hides such layers, so check the bytes)
    const pbf = await tile(connector, 8, empty.x, empty.y, sources);
    expect(pbf.length).toBeGreaterThan(0);
    expect(new TextDecoder().decode(pbf)).toContain('a');
  });

  it('encodes a tile without features to zero bytes with omitEmptyLayers', async () => {
    const pbf = await tile(connector, 8, empty.x, empty.y, sources, { omitEmptyLayers: true });
    expect(pbf.length).toBe(0);
  });

  it('keeps only layers with features', async () => {
    const { x, y } = tileAt(-97, 32, 4);
    const pbf = await tile(connector, 4, x, y, [{ name: 'a', path: POINTS }, { name: 'b', path: fixture('curves.fgb'), options: { minZoom: 10 } }], { omitEmptyLayers: true });
    expect(decodeLayer(pbf, 'a')?.length).toBeGreaterThan(0);
    expect(decodeLayer(pbf, 'b')).toBeUndefined();
  });
});

// == P5.4 Observability =======================================================

describe('onTile statistics', () => {
  it('reports per-source counts that match the reads', async () => {
    const counting = new Counting();
    const seen: TileStats[] = [];
    const { x, y } = tileAt(-97, 32, 6);
    const pbf = await tile(counting, 6, x, y, [
      { name: 'grid', path: fixture('grid-5k.fgb') },
      { name: 'late', path: POINTS, options: { minZoom: 10 } },
    ], { cache: false, onTile: s => seen.push(s) });

    expect(seen).toHaveLength(1);
    const [stats] = seen;
    expect(stats).toMatchObject({ z: 6, x, y, tileBytes: pbf.length });
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    const [grid, late] = stats.sources;
    expect(late).toMatchObject({ name: 'late', skipped: 'zoom', featuresRead: 0, requests: 0 });
    expect(grid.name).toBe('grid');
    expect(grid.featuresRead).toBeGreaterThan(0);
    expect(grid.featuresEncoded).toBe(decodeLayer(pbf, 'grid')?.length);
    // Everything except the header read at open is attributed to the tile
    expect(grid.requests).toBe(counting.requests);
    expect(grid.indexBytes + grid.featureBytes).toBe(counting.bytes);
    expect(grid.featureBytes).toBeGreaterThan(0);
    await counting.close();
  });

  it('counts no index reads for cached pages', async () => {
    const client = new TileClient(new LocalConnector());
    const source = { name: 'g', path: fixture('grid-5k.fgb') };
    const { x, y } = tileAt(-97, 32, 6);
    await client.tile(6, x, y, source);
    let stats: TileStats | undefined;
    await client.tile(6, x, y, source, { onTile: s => { stats = s; } });
    expect(stats!.sources[0].indexBytes).toBe(0);
    expect(stats!.sources[0].requests).toBeGreaterThan(0); // features
    await client.close();
  });

  it('accepts a default hook on TileClient and TileServer, overridable per request', async () => {
    const calls: string[] = [];
    const client = new TileClient(new LocalConnector(), { onTile: () => calls.push('client') });
    await client.tile(0, 0, 0, { name: 'p', path: POINTS });
    await client.tile(0, 0, 0, { name: 'p', path: POINTS }, { onTile: () => calls.push('request') });
    await client.close();
    const server = new TileServer({ connector: new LocalConnector(), sources: { name: 'p', path: POINTS } }, {
      onTile: () => calls.push('server'),
    });
    await server.tile(0, 0, 0);
    await server.close();
    expect(calls).toEqual(['client', 'request', 'server']);
  });

  it('ignores errors thrown by the hook', async () => {
    const pbf = await tile(connector, 0, 0, 0, { name: 'p', path: POINTS }, { onTile: () => { throw new Error('metrics down'); } });
    expect(decodeLayer(pbf, 'p')?.length).toBe(200);
  });
});

// == P5.7 TileJSON ============================================================

describe('TileJSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fgb-vt-tilejson-'));

  it('includes tile URLs and descriptive metadata', async () => {
    const server = new TileServer({ connector: new LocalConnector(), sources: { name: 'p', path: POINTS } });
    const tj = await server.tileJSON({
      tiles: ['https://example.com/{z}/{x}/{y}.mvt'],
      name: 'Points',
      attribution: '© Example',
      version: '1.2.0',
    });
    expect(tj).toMatchObject({
      tilejson: '3.0.0',
      tiles: ['https://example.com/{z}/{x}/{y}.mvt'],
      name: 'Points',
      attribution: '© Example',
      version: '1.2.0',
    });
    expect((await server.tileJSON()).tiles).toEqual([]);
    await server.close();
  });

  it('takes name and descriptions from file headers', async () => {
    const path = join(dir, 'described.fgb');
    writeFileSync(path, writeFgb({
      title: 'Parcels',
      description: 'Cadastral parcels',
      geometryType: GeomType.Point,
      features: [{ geometry: { xy: [1, 1] } }],
    }));
    const single = new TileServer({ connector: new LocalConnector(), sources: { name: 'p', path } });
    const tj = await single.tileJSON();
    expect(tj.name).toBe('Parcels');
    expect(tj.description).toBe('Cadastral parcels');
    expect(tj.vector_layers[0].description).toBe('Cadastral parcels');
    await single.close();

    // With several sources only the layers are described
    const multi = new TileServer({ connector: new LocalConnector(), sources: [{ name: 'p', path }, { name: 'q', path: POINTS }] });
    const tj2 = await multi.tileJSON();
    expect(tj2.name).toBeUndefined();
    expect(tj2.vector_layers[0].description).toBe('Cadastral parcels');
    expect(tj2.vector_layers[1].description).toBeUndefined();
    await multi.close();
  });

  it('lists only the fields written to tiles', async () => {
    const server = new TileServer({
      connector: new LocalConnector(),
      sources: [
        { name: 'all', path: POINTS },
        { name: 'some', path: POINTS, properties: { exclude: ['big'] }, keepIdProperty: true },
        { name: 'none', path: POINTS, idColumn: false, properties: ['id'] },
      ],
    });
    const [all, some, none] = (await server.tileJSON()).vector_layers;
    expect(Object.keys(all.fields).sort()).toEqual(['big', 'label', 'neg', 'ratio', 'small', 'ts']);
    expect(Object.keys(some.fields).sort()).toEqual(['id', 'label', 'neg', 'ratio', 'small', 'ts']);
    expect(none.fields).toEqual({ id: 'Number' });
    await server.close();
  });

  it('reports the zoom range of the sources, including maxZoom 0', async () => {
    const server = new TileServer({
      connector: new LocalConnector(),
      sources: [{ name: 'a', path: POINTS, options: { minZoom: 0, maxZoom: 0 } }],
    });
    const tj = await server.tileJSON();
    expect([tj.minzoom, tj.maxzoom]).toEqual([0, 0]);
    await server.close();
  });
});

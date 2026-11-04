/**
 * Every tile fgb-vt produces must be a valid MVT 2.1 tile: a sweep over
 * all fixtures, zoom levels and encoding options through the strict
 * validator in helpers/mvt-validate.ts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tile } from '../src/tile.js';
import { LocalConnector } from '../src/connectors/local.js';
import { parseHeader } from '../src/fgb/header.js';
import type { Source, TileOptions } from '../src/source.js';
import { fixture, tileAt } from './helpers/tiles.js';
import { validateMvt } from './helpers/mvt-validate.js';

const connector = new LocalConnector();
afterAll(() => connector.close());

const R = 6378137;
const FILES = readdirSync(dirname(fixture('points.fgb'))).filter(f => f.endsWith('.fgb')).sort();

/** Source settings needed to read a fixture at all. */
function sourceFor(file: string): Source {
  const source: Source = { name: 'l', path: fixture(file) };
  if (file === 'points-4087.fgb') {
    source.crs = {
      toWgs84: (x, y) => [(x / R) * (180 / Math.PI), (y / R) * (180 / Math.PI)],
      fromWgs84: (lon, lat) => [(lon * Math.PI / 180) * R, (lat * Math.PI / 180) * R],
    };
  }
  if (file.startsWith('gogama-indexdata-')) source.useIndex = false;
  return source;
}

/** The fixture's center in lon/lat. */
function center(file: string): [number, number] {
  const b = parseHeader(new Uint8Array(readFileSync(fixture(file)))).bbox;
  if (!b) return [0, 0];
  if (file === 'points-3857.fgb' || file === 'points-4087.fgb') return [-95, 32];
  return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
}

/** z0 plus, at a few zooms, the tile at the data center and its neighbours. */
function tilesFor(file: string): Array<[number, number, number]> {
  const [lon, lat] = center(file);
  const out: Array<[number, number, number]> = [[0, 0, 0]];
  for (const z of [2, 5, 8, 11]) {
    const n = 2 ** z;
    const c = tileAt(Math.max(-179.9, Math.min(179.9, lon)), Math.max(-85, Math.min(85, lat)), z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = (c.x + dx + n) % n, y = c.y + dy;
        if (y >= 0 && y < n) out.push([z, x, y]);
      }
    }
  }
  return out;
}

const VARIANTS: Array<[string, TileOptions]> = [
  ['defaults', {}],
  ['no simplification', { tolerance: 0 }],
  ['simplify before clip', { simplifyBeforeClip: true }],
  ['point grid', { pointGrid: 64 }],
  ['small extent', { extent: 512, buffer: 8, tolerance: 1 }],
];

describe.each(FILES)('%s', (file) => {
  it.each(VARIANTS)('produces valid tiles (%s)', async (_, options) => {
    for (const [z, x, y] of tilesFor(file)) {
      const pbf = await tile(connector, z, x, y, sourceFor(file), { ...options, cache: false });
      const issues = validateMvt(pbf);
      expect(issues, `${file} ${z}/${x}/${y}`).toEqual([]);
    }
  });
});

describe('validator', () => {
  it('reports spec violations', () => {
    // Layer "l" (version 2, extent 4096) with one polygon feature whose
    // ring is counter-clockwise (interior first) and has a zero-length LineTo
    const zz = (n: number) => (n << 1) ^ (n >> 31);
    const geometry = [9, zz(0), zz(0), (3 << 3) | 2, zz(0), zz(10), zz(10), zz(0), zz(0), zz(0), 15];
    const packed = geometry.map(v => [v]).flat();
    const feature = [0x18, 3, 0x22, packed.length, ...packed];
    const layer = [0x78, 2, 0x0a, 1, 0x6c, 0x12, feature.length, ...feature, 0x28, 0x80, 0x20];
    const tileBytes = new Uint8Array([0x1a, layer.length, ...layer]);
    const messages = validateMvt(tileBytes).map(i => i.message);
    expect(messages).toContain('zero-length LineTo');
    expect(messages).toContain('polygon starts with an interior ring');
  });
});

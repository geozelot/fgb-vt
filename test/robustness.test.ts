/**
 * Cancellation, per-tile budgets and corrupt input.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tile } from '../src/tile.js';
import { TileClient } from '../src/client.js';
import { TileServer } from '../src/server.js';
import { LocalConnector } from '../src/connectors/local.js';
import { HttpConnector } from '../src/connectors/http.js';
import type { Connector, ReadOptions } from '../src/connectors/connector.js';
import { parseHeader } from '../src/fgb/header.js';
import { computeLevelBounds } from '../src/fgb/index.js';
import { FormatError, LimitExceededError } from '../src/errors.js';
import { fixture, decodeLayer } from './helpers/tiles.js';

/** LocalConnector wrapper counting bytes returned and the furthest byte read. */
class Counting implements Connector {
  readonly inner = new LocalConnector();
  bytes = 0;
  furthest = 0;
  get hints() { return this.inner.hints; }
  async readHead(path: string, length: number, options?: ReadOptions) {
    const r = await this.inner.readHead(path, length, options);
    this.bytes += r.bytes.length;
    this.furthest = Math.max(this.furthest, r.bytes.length);
    return r;
  }
  async read(path: string, offset: number, length: number, options?: ReadOptions) {
    const b = await this.inner.read(path, offset, length, options);
    this.bytes += b.length;
    this.furthest = Math.max(this.furthest, offset + b.length);
    return b;
  }
  async readRanges(path: string, ranges: ReadonlyArray<{ offset: number; length: number }>, options?: ReadOptions) {
    const out = await this.inner.readRanges(path, ranges, options);
    out.forEach((b, i) => {
      this.bytes += b.length;
      this.furthest = Math.max(this.furthest, ranges[i].offset + b.length);
    });
    return out;
  }
  close() { return this.inner.close(); }
}

const GRID = fixture('grid-5k.fgb');
const GRID_HEADER = parseHeader(new Uint8Array(readFileSync(GRID)));

describe('cancellation', () => {
  let server: Server;
  let url = '';
  const body = readFileSync(GRID);

  beforeAll(async () => {
    // Serves the grid with a 3 s stall on every feature read
    server = createServer((req, res) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')!;
      const start = Number(m[1]), end = Math.min(Number(m[2]), body.length - 1);
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 });
      if (start >= GRID_HEADER.featuresOffset) {
        res.write(body.subarray(start, start + 1));
        setTimeout(() => res.end(body.subarray(start + 1, end + 1)), 3000).unref();
      } else {
        res.end(body.subarray(start, end + 1));
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address && typeof address === 'object') url = `http://127.0.0.1:${address.port}/grid.fgb`;
  });
  afterAll(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('rejects an already-aborted request without any I/O', async () => {
    const c = new Counting();
    const controller = new AbortController();
    controller.abort();
    await expect(tile(c, 0, 0, 0, { name: 'l', path: GRID }, { signal: controller.signal, cache: false }))
      .rejects.toThrow(/abort/i);
    expect(c.bytes).toBe(0);
    await c.close();
  });

  it('stops a stalled read when the deadline passes', async () => {
    const started = Date.now();
    const err = await tile(new HttpConnector(), 6, 14, 24, { name: 'l', path: url }, {
      signal: AbortSignal.timeout(200),
      cache: false,
    }).catch(e => e);
    expect(err?.name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('accepts a signal on TileClient and TileServer', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = new TileClient(new LocalConnector());
    await expect(client.tile(0, 0, 0, { name: 'l', path: GRID }, { signal: controller.signal })).rejects.toThrow(/abort/i);
    await client.close();
    const server = new TileServer({ connector: new LocalConnector(), sources: { name: 'l', path: GRID } });
    await expect(server.tile(0, 0, 0, { signal: controller.signal })).rejects.toThrow(/abort/i);
    await server.close();
  });
});

describe('per-tile budgets', () => {
  it('rejects a tile with too many features before reading feature data', async () => {
    const c = new Counting();
    const err = await tile(c, 0, 0, 0, { name: 'l', path: GRID }, { maxFeatures: 100, cache: false }).catch(e => e);
    expect(err).toBeInstanceOf(LimitExceededError);
    expect(err).toMatchObject({ code: 'FGB_LIMIT', limit: 'features', max: 100, actual: 5000, path: GRID });
    // Only the header and index were read: nothing at or past the first feature
    expect(c.furthest).toBeLessThanOrEqual(GRID_HEADER.featuresOffset);
    await c.close();
  });

  it('rejects a tile that would read too many feature bytes', async () => {
    const c = new LocalConnector();
    const err = await tile(c, 0, 0, 0, { name: 'l', path: GRID }, { maxReadBytes: 10_000 }).catch(e => e);
    expect(err).toMatchObject({ limit: 'readBytes', max: 10_000 });
    await c.close();
  });

  it('lets source options override tile-level budgets', async () => {
    const c = new LocalConnector();
    const pbf = await tile(c, 0, 0, 0, { name: 'l', path: GRID, options: { maxFeatures: 10_000 } }, { maxFeatures: 100 });
    expect(decodeLayer(pbf, 'l')?.length).toBe(5000);
    await c.close();
  });

  it('rejects tiles larger than maxTileBytes', async () => {
    const c = new LocalConnector();
    const err = await tile(c, 0, 0, 0, { name: 'l', path: fixture('points.fgb') }, { maxTileBytes: 1000 }).catch(e => e);
    expect(err).toMatchObject({ limit: 'tileBytes', max: 1000 });
    expect(err.actual).toBeGreaterThan(1000);
    await c.close();
  });

  it('applies feature and byte budgets to unindexed files', async () => {
    const c = new LocalConnector();
    const path = fixture('no-index.fgb');
    await expect(tile(c, 0, 0, 0, { name: 'l', path }, { maxFeatures: 50 })).rejects.toMatchObject({ limit: 'features' });
    await expect(tile(c, 0, 0, 0, { name: 'l', path }, { maxReadBytes: 1000 })).rejects.toMatchObject({ limit: 'readBytes' });
    await c.close();
  });
});

describe('corrupt input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fgb-vt-corrupt-'));

  function corrupt(name: string, patch: (bytes: Uint8Array, view: DataView) => void): string {
    const bytes = new Uint8Array(readFileSync(fixture(name)));
    patch(bytes, new DataView(bytes.buffer));
    const path = join(dir, `${name}.${Math.random().toString(36).slice(2)}`);
    writeFileSync(path, bytes);
    return path;
  }

  /** Absolute offset of the feature referenced by the last leaf of the index. */
  function lastFeatureOffset(bytes: Uint8Array, view: DataView): number {
    const header = parseHeader(bytes);
    const [, leafEnd] = computeLevelBounds(header.featuresCount, header.indexNodeSize)[0];
    return header.featuresOffset + view.getUint32(header.indexOffset + (leafEnd - 1) * 40 + 32, true);
  }

  it('reports a corrupt feature as FormatError with path and offset', async () => {
    const path = corrupt('points.fgb', (bytes, view) => {
      const off = parseHeader(bytes).featuresOffset;
      view.setUint32(off + 4, 0xffffff00, true); // root table offset of the first feature
    });
    const c = new LocalConnector();
    const err = await tile(c, 0, 0, 0, { name: 'l', path }, { cache: false }).catch(e => e);
    expect(err).toBeInstanceOf(FormatError);
    expect(err.path).toBe(path);
    expect(typeof err.offset).toBe('number');
    await c.close();
  });

  it('reports a corrupt header as FormatError', async () => {
    const path = corrupt('points.fgb', (_, view) => view.setUint32(12, 0xffffff00, true));
    const c = new LocalConnector();
    await expect(tile(c, 0, 0, 0, { name: 'l', path }, { cache: false })).rejects.toBeInstanceOf(FormatError);
    await c.close();
  });

  it('refuses to read a feature whose size prefix is implausibly large', async () => {
    const path = corrupt('points.fgb', (bytes, view) => view.setUint32(lastFeatureOffset(bytes, view), 0x7fffffff, true));
    const local = new LocalConnector();
    // Without readHead the file size is unknown, so the last feature is re-read by its prefix
    const plain: Connector = {
      read: (p, o, l, opts) => local.read(p, o, l, opts),
      readRanges: (p, r, opts) => local.readRanges(p, r, opts),
      close: () => local.close(),
    };
    const err = await tile(plain, 0, 0, 0, { name: 'l', path }, { cache: false }).catch(e => e);
    expect(err).toMatchObject({ limit: 'featureBytes', actual: 0x7fffffff });
    await plain.close();
  });
});

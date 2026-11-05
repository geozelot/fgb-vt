/**
 * Memory soak test for fgb-vt.
 *
 * Serves many random tiles from one long-lived {@link TileServer} (local
 * fixtures, default cache) and watches the heap after forced garbage
 * collections. Once the cache and the JIT have warmed up, the heap must stay
 * flat: growth beyond `--max-growth-mb` between the end of the warm-up and
 * the end of the run fails the run (exit code 1) as a likely leak.
 *
 * Run: node --expose-gc --import tsx bench/soak.ts
 *      node --expose-gc --import tsx bench/soak.ts --tiles 50000 --concurrency 32
 *
 * Options:
 *   --tiles N           tiles to serve (default 20000)
 *   --concurrency N     tiles in flight per batch (default 16)
 *   --max-growth-mb N   allowed heap growth after warm-up (default 32)
 *   --seed N            seed of the tile sequence (default 1)
 *
 * Tiles are drawn across zooms 0–14 at random points inside a random
 * fixture's bounds, so most of them have features. The first 10% are the
 * warm-up; the heap is sampled after a forced GC every further 10%.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TileServer } from '../src/server.js';
import { LocalConnector } from '../src/connectors/local.js';
import { parseHeader } from '../src/fgb/header.js';
import type { Source } from '../src/source.js';

// == Options ================================================================

function argument(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${name} needs a non-negative number`);
    process.exit(2);
  }
  return value;
}

const TILES = Math.floor(argument('--tiles', 20000));
const CONCURRENCY = Math.max(1, Math.floor(argument('--concurrency', 16)));
const MAX_GROWTH_MB = argument('--max-growth-mb', 32);
const SEED = Math.floor(argument('--seed', 1));

const gc = (globalThis as { gc?: () => void }).gc;
if (typeof gc !== 'function') {
  console.error('Run with --expose-gc: node --expose-gc --import tsx bench/soak.ts');
  process.exit(2);
}

// == Fixtures ===============================================================

const FIXTURES = fileURLToPath(new URL('../test/fixtures/', import.meta.url));

/**
 * Indexed and unindexed points, lines, detailed polygons and curves (all
 * lon/lat), with the file whose envelope bounds the data where the file
 * has none (GDAL writes no envelope without an index).
 */
const FILES: Array<[file: string, envelopeOf?: string]> = [
  ['grid-5k.fgb'], ['points.fgb'], ['no-index.fgb', 'points.fgb'], ['lines.fgb'], ['multipolygons.fgb'], ['curves.fgb'],
];

const files = FILES.map(([file, envelopeOf = file]) => {
  const bbox = parseHeader(new Uint8Array(readFileSync(FIXTURES + envelopeOf))).bbox;
  if (!bbox) throw new Error(`${envelopeOf} has no envelope`);
  return { file, path: FIXTURES + file, bbox };
});

const sources: Source[] = files.map(({ file, path }) => ({ name: file.replace(/\.fgb$/, ''), path }));

// == Tile sequence ==========================================================

/** Mulberry32: small, fast, seedable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = rng(SEED);

/** A random tile at zoom 0–14 containing a random point of a random fixture. */
function randomTile(): [number, number, number] {
  const { bbox } = files[Math.floor(random() * files.length)];
  const z = Math.floor(random() * 15);
  const lon = bbox.minX + random() * (bbox.maxX - bbox.minX);
  const lat = bbox.minY + random() * (bbox.maxY - bbox.minY);
  return tileAt(lon, Math.max(-85, Math.min(85, lat)), z);
}

/** Slippy tile containing a lon/lat. */
function tileAt(lon: number, lat: number, z: number): [number, number, number] {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [z, Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

// == Memory =================================================================

interface Sample {
  label: string;
  tiles: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  rss: number;
  tilesPerSec: number;
}

/** Collect garbage until the heap stops shrinking, then read memory usage. */
function settle(): NodeJS.MemoryUsage {
  let previous = Infinity;
  for (let i = 0; i < 5; i++) {
    gc!();
    const used = process.memoryUsage().heapUsed;
    if (used >= previous) break;
    previous = used;
  }
  return process.memoryUsage();
}

const MB = 1024 * 1024;
const mb = (bytes: number) => (bytes / MB).toFixed(1);

// == Main ===================================================================

let nonEmpty = 0;
let features = 0;
let served = 0;
let servingMs = 0;
const samples: Sample[] = [];

// Default cache (a 64 MiB MemoryCache owned by the server)
const server = new TileServer(
  { connector: new LocalConnector(), sources },
  {
    onTile: (stats) => {
      let encoded = 0;
      for (const s of stats.sources) encoded += s.featuresEncoded;
      if (encoded > 0) nonEmpty++;
      features += encoded;
    },
  },
);

/** Serve `count` tiles in batches of CONCURRENCY; returns the serving time in ms. */
async function serve(count: number): Promise<number> {
  const start = performance.now();
  for (let done = 0; done < count; done += CONCURRENCY) {
    const batch = Math.min(CONCURRENCY, count - done);
    const requests: Array<Promise<Uint8Array>> = [];
    for (let i = 0; i < batch; i++) {
      const [z, x, y] = randomTile();
      requests.push(server.tile(z, x, y));
    }
    await Promise.all(requests);
  }
  served += count;
  return performance.now() - start;
}

function sample(label: string, ms: number, count: number): void {
  const m = settle();
  samples.push({
    label, tiles: served, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss,
    tilesPerSec: ms > 0 ? (count / ms) * 1000 : 0,
  });
}

console.log(`fgb-vt soak: ${TILES} tiles, concurrency ${CONCURRENCY}, seed ${SEED}, Node ${process.version}`);
console.log(`sources: ${files.map(f => f.file).join(', ')}`);

const before = settle();
const warmup = Math.max(1, Math.round(TILES / 10));
let ms = await serve(warmup);
servingMs += ms;
sample('warm-up', ms, warmup);

const steps = 9;
let remaining = TILES - warmup;
for (let step = 1; step <= steps && remaining > 0; step++) {
  const count = step === steps ? remaining : Math.min(remaining, Math.max(1, Math.round((TILES - warmup) / steps)));
  ms = await serve(count);
  servingMs += ms;
  remaining -= count;
  sample(`${Math.round((served / TILES) * 100)}%`, ms, count);
}

// == Report =================================================================

const base = samples[0];
const final = samples[samples.length - 1];
const growth = final.heapUsed - base.heapUsed;

const header = ['', 'tiles', 'heapUsed MB', 'Δ heap MB', 'external MB', 'arrayBuffers MB', 'rss MB', 'tiles/s'];
const rows = samples.map(s => [
  s.label, String(s.tiles), mb(s.heapUsed), (s.heapUsed >= base.heapUsed ? '+' : '') + mb(s.heapUsed - base.heapUsed),
  mb(s.external), mb(s.arrayBuffers), mb(s.rss), s.tilesPerSec.toFixed(0),
]);
const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
console.log(`\nbefore: heapUsed ${mb(before.heapUsed)} MB, external ${mb(before.external)} MB, ` +
  `arrayBuffers ${mb(before.arrayBuffers)} MB, rss ${mb(before.rss)} MB\n`);
console.log(line(header));
console.log(widths.map(w => '-'.repeat(w)).join('  '));
for (const r of rows) console.log(line(r));

console.log(`\n${served} tiles in ${(servingMs / 1000).toFixed(1)} s: ${((served / servingMs) * 1000).toFixed(0)} tiles/s; ` +
  `${nonEmpty} non-empty (${((nonEmpty / served) * 100).toFixed(0)}%), ${features} features encoded`);
console.log(`heap growth after warm-up: ${growth >= 0 ? '+' : ''}${mb(growth)} MB (limit ${MAX_GROWTH_MB} MB); ` +
  `external ${final.external >= base.external ? '+' : ''}${mb(final.external - base.external)} MB`);

await server.close();

if (growth > MAX_GROWTH_MB * MB) {
  console.error(`FAIL: heap grew by ${mb(growth)} MB after warm-up, more than ${MAX_GROWTH_MB} MB: possible leak`);
  process.exitCode = 1;
} else {
  console.log('OK');
}

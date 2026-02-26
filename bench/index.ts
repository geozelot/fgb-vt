/**
 * Performance benchmarks for fgb-vt.
 *
 * These benchmarks exercise the internal pipeline stages independently and
 * end-to-end, measuring throughput in features/sec and tiles/sec.
 *
 * Run: npm run bench
 */

import { projectToMercator } from '../src/geometry/project.js';
import { clipFeatures } from '../src/geometry/clip.js';
import { simplify, sqToleranceForZoom } from '../src/geometry/simplify.js';
import { encodeGeometry, toMvtGeomType } from '../src/mvt/geometry.js';
import { buildMvtLayer } from '../src/mvt/layer.js';
import { encodePbf } from '../src/pbf/encode.js';
import { tileClipBounds, tileBBox } from '../src/tiles.js';
import type { RawFeature, BBox } from '../src/types.js';
import { GeomType } from '../src/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function bench(name: string, fn: () => void, iterations: number): void {
  // Warmup
  for (let i = 0; i < Math.min(iterations, 100); i++) fn();

  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const elapsed = performance.now() - start;

  const opsPerSec = (iterations / elapsed) * 1000;
  const usPerOp = (elapsed / iterations) * 1000;

  console.log(
    `  ${name.padEnd(45)} ${fmt(opsPerSec, 0).padStart(12)} ops/s  ${fmt(usPerOp, 1).padStart(10)} µs/op`,
  );
}

function fmt(n: number, decimals: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: decimals });
}

// ─── Synthetic data generators ──────────────────────────────────────────────

function generatePoints(count: number, bbox: BBox): RawFeature[] {
  const features: RawFeature[] = [];
  for (let i = 0; i < count; i++) {
    const lng = bbox.minX + Math.random() * (bbox.maxX - bbox.minX);
    const lat = bbox.minY + Math.random() * (bbox.maxY - bbox.minY);
    features.push({
      type: GeomType.Point,
      xy: new Float64Array([lng, lat]),
      ends: null,
      properties: new Map([
        ['name', `point-${i}`],
        ['value', Math.random() * 100],
      ]),
      id: i,
    });
  }
  return features;
}

function generatePolygons(count: number, bbox: BBox, verticesPerRing: number = 20): RawFeature[] {
  const features: RawFeature[] = [];
  const dx = (bbox.maxX - bbox.minX) / Math.sqrt(count);
  const dy = (bbox.maxY - bbox.minY) / Math.sqrt(count);

  for (let i = 0; i < count; i++) {
    const cx = bbox.minX + Math.random() * (bbox.maxX - bbox.minX);
    const cy = bbox.minY + Math.random() * (bbox.maxY - bbox.minY);
    const radius = Math.min(dx, dy) * 0.3;

    const coords = new Float64Array((verticesPerRing + 1) * 2);
    for (let j = 0; j < verticesPerRing; j++) {
      const angle = (j / verticesPerRing) * Math.PI * 2;
      const jitter = 1 + (Math.random() - 0.5) * 0.3;
      coords[j * 2] = cx + Math.cos(angle) * radius * jitter;
      coords[j * 2 + 1] = cy + Math.sin(angle) * radius * jitter;
    }
    // Close the ring
    coords[verticesPerRing * 2] = coords[0];
    coords[verticesPerRing * 2 + 1] = coords[1];

    features.push({
      type: GeomType.Polygon,
      xy: coords,
      ends: new Uint32Array([verticesPerRing + 1]),
      properties: new Map([
        ['type', 'building'],
        ['area', radius * radius * Math.PI],
      ]),
      id: i,
    });
  }
  return features;
}

function generateLines(count: number, bbox: BBox, pointsPerLine: number = 30): RawFeature[] {
  const features: RawFeature[] = [];
  for (let i = 0; i < count; i++) {
    const coords = new Float64Array(pointsPerLine * 2);
    let x = bbox.minX + Math.random() * (bbox.maxX - bbox.minX);
    let y = bbox.minY + Math.random() * (bbox.maxY - bbox.minY);
    const dx = (bbox.maxX - bbox.minX) / pointsPerLine;
    const dy = (bbox.maxY - bbox.minY) / pointsPerLine;

    for (let j = 0; j < pointsPerLine; j++) {
      coords[j * 2] = x;
      coords[j * 2 + 1] = y;
      x += (Math.random() - 0.3) * dx;
      y += (Math.random() - 0.5) * dy;
    }

    features.push({
      type: GeomType.LineString,
      xy: coords,
      ends: null,
      properties: new Map([
        ['name', `road-${i}`],
        ['length', pointsPerLine],
      ]),
      id: i,
    });
  }
  return features;
}

function cloneFeatures(features: RawFeature[]): RawFeature[] {
  return features.map(f => ({
    ...f,
    xy: new Float64Array(f.xy),
    ends: f.ends ? new Uint32Array(f.ends) : null,
    properties: new Map(f.properties),
  }));
}

// ─── Benchmark suites ───────────────────────────────────────────────────────

function benchProjection() {
  console.log('\n── Projection (WGS84 → Mercator) ──');

  const coords100 = new Float64Array(200);
  const coords1000 = new Float64Array(2000);
  const coords10000 = new Float64Array(20000);
  for (const arr of [coords100, coords1000, coords10000]) {
    for (let i = 0; i < arr.length; i += 2) {
      arr[i] = -180 + Math.random() * 360;
      arr[i + 1] = -85 + Math.random() * 170;
    }
  }

  bench('100 coordinate pairs', () => {
    const c = new Float64Array(coords100);
    projectToMercator(c);
  }, 50000);

  bench('1,000 coordinate pairs', () => {
    const c = new Float64Array(coords1000);
    projectToMercator(c);
  }, 10000);

  bench('10,000 coordinate pairs', () => {
    const c = new Float64Array(coords10000);
    projectToMercator(c);
  }, 1000);
}

function benchClipping() {
  console.log('\n── Clipping (Sutherland-Hodgman) ──');

  const z = 12, x = 2048, y = 1360;
  const wgs84 = tileBBox(z, x, y);
  const clip = tileClipBounds(z, x, y, 64, 4096);

  const points = generatePoints(100, wgs84);
  const polys = generatePolygons(50, wgs84, 20);
  const lines = generateLines(50, wgs84, 30);

  // Project first (clipping operates in mercator space)
  for (const f of [...points, ...polys, ...lines]) {
    projectToMercator(f.xy);
  }

  bench('100 points', () => clipFeatures(cloneFeatures(points), clip), 5000);
  bench('50 polygons (20 vertices each)', () => clipFeatures(cloneFeatures(polys), clip), 2000);
  bench('50 linestrings (30 points each)', () => clipFeatures(cloneFeatures(lines), clip), 2000);
}

function benchSimplification() {
  console.log('\n── Simplification (Douglas-Peucker) ──');

  const sqTol = sqToleranceForZoom(3, 12, 4096);

  for (const n of [50, 200, 1000]) {
    const xy = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      xy[i * 2] = i / n + (Math.random() - 0.5) * 0.01;
      xy[i * 2 + 1] = Math.sin(i / n * Math.PI * 4) * 0.1 + (Math.random() - 0.5) * 0.005;
    }

    bench(`${n}-point linestring`, () => simplify(new Float64Array(xy), sqTol), 5000);
  }
}

function benchMvtEncoding() {
  console.log('\n── MVT Geometry Encoding ──');

  for (const n of [10, 100, 500]) {
    const coords = new Int32Array(n * 2);
    for (let i = 0; i < n * 2; i++) {
      coords[i] = Math.floor(Math.random() * 4096);
    }

    bench(`${n}-point linestring → commands`, () => {
      encodeGeometry(coords, null, toMvtGeomType(GeomType.LineString));
    }, 10000);
  }
}

function benchPbfEncoding() {
  console.log('\n── PBF Encoding ──');

  const z = 12, x = 2048, y = 1360;
  const wgs84 = tileBBox(z, x, y);
  const clip = tileClipBounds(z, x, y, 64, 4096);

  for (const featureCount of [10, 100, 500]) {
    const features = generatePoints(featureCount, wgs84);
    const layer = buildMvtLayer(features, 'bench', z, x, y, clip, 4096, 3);

    bench(`${featureCount}-feature layer → PBF`, () => {
      encodePbf([layer]);
    }, 5000);
  }
}

function benchFullPipeline() {
  console.log('\n── Full Pipeline (features → PBF) ──');

  const z = 12, x = 2048, y = 1360;
  const wgs84 = tileBBox(z, x, y);
  const clip = tileClipBounds(z, x, y, 64, 4096);

  for (const [label, featuresFn] of [
    ['50 points', () => generatePoints(50, wgs84)],
    ['20 polygons (20v)', () => generatePolygons(20, wgs84, 20)],
    ['20 linestrings (30p)', () => generateLines(20, wgs84, 30)],
    ['100 mixed features', () => [
      ...generatePoints(40, wgs84),
      ...generatePolygons(30, wgs84, 15),
      ...generateLines(30, wgs84, 20),
    ]],
  ] as const) {
    bench(label, () => {
      const features = (featuresFn as () => RawFeature[])();
      const layer = buildMvtLayer(features, 'bench', z, x, y, clip, 4096, 3);
      encodePbf([layer]);
    }, 1000);
  }
}

function benchMultiLayer() {
  console.log('\n── Multi-Layer Tile ──');

  const z = 12, x = 2048, y = 1360;
  const wgs84 = tileBBox(z, x, y);
  const clip = tileClipBounds(z, x, y, 64, 4096);

  for (const numLayers of [2, 5, 10]) {
    bench(`${numLayers} layers × 50 features`, () => {
      const layers = [];
      for (let i = 0; i < numLayers; i++) {
        const features = generatePoints(50, wgs84);
        layers.push(buildMvtLayer(features, `layer-${i}`, z, x, y, clip, 4096, 3));
      }
      encodePbf(layers);
    }, 500);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

console.log('╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  fgb-vt Performance Benchmarks                                     ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');

benchProjection();
benchClipping();
benchSimplification();
benchMvtEncoding();
benchPbfEncoding();
benchFullPipeline();
benchMultiLayer();

console.log('\nDone.');

// Writes FlatGeobuf fixtures with the flatgeobuf npm package (the reference
// JavaScript writer, `geojson.serialize`), independent of GDAL and fgb-vt,
// for interoperability tests (test/golden/other-writers.test.ts).
//
// The features are those of GDAL fixtures written by ../../generate.py, built
// the same way, so tiles can be compared with tiles of the GDAL files:
//
//   flatgeobuf-js-points.fgb        points.fgb / no-index.fgb (200 points)
//   flatgeobuf-js-lines.fgb         lines.fgb
//   flatgeobuf-js-multipolygons.fgb multipolygons.fgb (with a hole)
//   flatgeobuf-js-single.fgb        single.fgb (Polygon layer)
//   flatgeobuf-js-mixed.fgb         mixed.fgb (six basic types)
//   flatgeobuf-js-dims-*.fgb        dims-*.fgb (polygon with a hole; Z, M)
//
// What this writer (4.6.1) does differently from GDAL, by design of its API:
// - It never writes a spatial index (index_node_size = 0, explicitly) and
//   no envelope: every file is unindexed, and features stay in input order.
// - Column types come from the first feature's values, and every number is
//   a Double: there are no integer columns, so no `id` column is detected.
// - A CRS is written as a bare code (org null, which means EPSG), and only
//   when one is passed; lines.fgb uses the default, no CRS.
// - Layers of mixed types get header type Unknown and per-feature types;
//   MultiPolygons are stored as Polygon parts.
// - A single-part MultiLineString has no `ends` (allowed by the spec; GDAL
//   3.4.1 cannot read such features, so ogrinfo fails on the lines file).
// - Z and M are written per feature, but has_z/has_m are not set in the
//   header (GDAL then reads the files as 2D). The header name is always "L1".
//
// Coordinates equal GDAL's except for a few ring and wave vertices, where
// V8's sin/cos differ from the C library's in the last bit; no tile changes.
//
// Usage (from this directory): npm ci && node generate.mjs ../..
import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { serialize } from 'flatgeobuf/geojson';

if (process.argv.length !== 3) {
  console.error('usage: node generate.mjs <output directory>');
  process.exit(2);
}
const out = process.argv[2];

const fc = (features) => ({ type: 'FeatureCollection', features });
const feature = (properties, geometry) => ({ type: 'Feature', properties, geometry });

// Same arithmetic, in the same order, as generate.py
function ring(cx, cy, r, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push([cx + r * Math.cos(2 * Math.PI * i / n), cy + r * Math.sin(2 * Math.PI * i / n)]);
  }
  pts.push(pts[0]);
  return pts;
}

const polygon = (cx, cy, r, n = 8) => ({ type: 'Polygon', coordinates: [ring(cx, cy, r, n)] });

function write(name, collection, crsCode = 4326) {
  const path = join(out, name);
  const bytes = serialize(collection, crsCode);
  writeFileSync(path, bytes);
  console.log(`wrote ${basename(path)} (${bytes.length} bytes)`);
}

// 200 points on a grid with 64-bit integer properties (all Double here)
const points = [];
for (let i = 0; i < 200; i++) {
  points.push(feature(
    { id: i, big: 5_000_000_000 + i, ts: 1_700_000_000_000 + i, neg: -3_000_000_000 - i, small: i - 100, ratio: i / 8, label: `p${i}` },
    { type: 'Point', coordinates: [-100 + (i % 20) * 0.5, 30 + Math.floor(i / 20) * 0.5] },
  ));
}
write('flatgeobuf-js-points.fgb', fc(points));

// A single Polygon feature
write('flatgeobuf-js-single.fgb', fc([feature({ name: 'solo', id: 7 }, polygon(10, 10, 1))]));

// Detailed (Multi)Polygons: single-part, multi-part and with a hole
write('flatgeobuf-js-multipolygons.fgb', fc([
  feature({ name: 'circle' }, { type: 'MultiPolygon', coordinates: [[ring(-90, 40, 2, 1500)]] }),
  feature({ name: 'pair' }, { type: 'MultiPolygon', coordinates: [[ring(-80, 40, 1, 800)], [ring(-76, 40, 1, 800)]] }),
  feature({ name: 'donut' }, { type: 'MultiPolygon', coordinates: [[ring(-70, 40, 2, 1200), ring(-70, 40, 1, 600).reverse()]] }),
]));

// Lines: LineString, single-part and two-part MultiLineString; no CRS
function wave(x0, y0, n) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([x0 + i * 0.01, y0 + 0.2 * Math.sin(i / 20)]);
  return pts;
}
write('flatgeobuf-js-lines.fgb', fc([
  feature({ name: 'line' }, { type: 'LineString', coordinates: wave(-100, 45, 1000) }),
  feature({ name: 'multi-1' }, { type: 'MultiLineString', coordinates: [wave(-100, 44, 1000)] }),
  feature({ name: 'multi-2' }, { type: 'MultiLineString', coordinates: [wave(-100, 43, 500), wave(-94, 43, 500)] }),
]), 0);

// Basic types in a mixed layer (header Unknown, per-feature types)
const tri = (x0, y0) => [[[x0, y0], [x0 + 1, y0], [x0 + 1, y0 + 1], [x0, y0]]];
write('flatgeobuf-js-mixed.fgb', fc([
  feature({ id: 1, kind: 'point' }, { type: 'Point', coordinates: [-100, 40] }),
  feature({ id: 2, kind: 'line' }, { type: 'LineString', coordinates: [[-101, 39], [-99, 39]] }),
  feature({ id: 3, kind: 'polygon' }, { type: 'Polygon', coordinates: [[[-101, 41], [-99, 41], [-100, 42], [-101, 41]]] }),
  feature({ id: 4, kind: 'multipoint' }, { type: 'MultiPoint', coordinates: [[-95, 39], [-94, 39]] }),
  feature({ id: 5, kind: 'multiline' }, { type: 'MultiLineString', coordinates: [[[-95, 38], [-94, 38]], [[-93, 38], [-92, 38]]] }),
  feature({ id: 6, kind: 'multipolygon' }, { type: 'MultiPolygon', coordinates: [tri(-95, 40), tri(-93, 40)] }),
]));

// The same geometries with XY, XYZ, XYM and XYZM coordinates. GeoJSON has
// no M; this writer takes it from a fourth ordinate (Z null for XYM).
for (const [suffix, hasZ, hasM] of [['xy', false, false], ['xyz', true, false], ['xym', false, true], ['xyzm', true, true]]) {
  const c = (x, y) => (hasM ? [x, y, hasZ ? 7 : null, 9] : hasZ ? [x, y, 7] : [x, y]);
  write(`flatgeobuf-js-dims-${suffix}.fgb`, fc([
    feature({ id: 1 }, { type: 'Point', coordinates: c(-100, 40) }),
    feature({ id: 2 }, { type: 'LineString', coordinates: [c(-101, 39), c(-100, 39.5), c(-99, 39)] }),
    feature({ id: 3 }, {
      type: 'Polygon', coordinates: [
        [c(-96, 39), c(-94, 39), c(-94, 41), c(-96, 41), c(-96, 39)],
        [c(-95.5, 39.5), c(-95.5, 40.5), c(-94.5, 40.5), c(-94.5, 39.5), c(-95.5, 39.5)],
      ],
    }),
  ]));
}

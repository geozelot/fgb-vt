[![npm version](https://img.shields.io/npm/v/@geozelot/fgb-vt)](https://www.npmjs.com/package/@geozelot/fgb-vt)
[![CI](https://github.com/geozelot/fgb-vt/actions/workflows/ci.yml/badge.svg)](https://github.com/geozelot/fgb-vt/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@geozelot/fgb-vt)](LICENSE)
[![node](https://img.shields.io/node/v/@geozelot/fgb-vt)](package.json)
[![types](https://img.shields.io/npm/types/@geozelot/fgb-vt)](https://www.npmjs.com/package/@geozelot/fgb-vt)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@geozelot/fgb-vt)](https://bundlephobia.com/package/@geozelot/fgb-vt)

# fgb-vt

**Mapbox Vector Tiles on the fly, straight from [FlatGeobuf](https://flatgeobuf.org/) files: local, over HTTP(S) or in S3.**

`fgb-vt` turns a FlatGeobuf file into a [vector tile](https://github.com/mapbox/vector-tile-spec) source without a tile pyramid, a database or a GeoJSON detour. It uses the file's packed Hilbert R-tree to read only the bytes a tile needs, through range requests. That makes a large single file in object storage directly servable, from a long-running server, from a stateless function such as AWS Lambda, or from the browser.

It is binary all the way: FlatBuffers in, Protocol Buffers out, with projection, clipping, simplification and encoding implemented on flat coordinate arrays.

### Highlights

- **Reads only what a tile needs.** The header and the top of the spatial index come in one request. The index is searched level by level, and whole subtrees inside the tile are resolved without descending. Features are fetched in merged range requests. Header and index pages are cached, so a warm process typically needs a single read per tile and source.
- **Built for serverless.** Module-scope caching, `open()` warm-up during init, per-tile budgets, cancellation and deadlines, change detection through ETags, tile ETags for `304 Not Modified`, and an `onTile` metrics hook.
- **All of FlatGeobuf 3.x.** All 17 geometry types (curves are linearised per zoom), mixed-geometry layers, per-feature column schemas, and files without an index. WGS 84 and Web Mercator are built in; any other CRS works through a projection hook.
- **Spec-valid output.** MVT 2.1 with correct ring winding and no degenerate geometry, checked by a strict validator across all test files at several zooms. Also exact 64-bit integers, lossless float values, world copies at the antimeridian, and optional seam-free simplification.
- **Fails loudly, not wrongly.** Typed errors with stable codes for corrupt files, inconsistent indexes, unsupported data, storage failures and exceeded budgets (checked before feature data is read). The decoders are fuzzed against corrupted input, and bound the work a crafted file can cause.
- **Checks files before you deploy them.** `npx @geozelot/fgb-vt check file.fgb` verifies every index node and every feature against the index, the defects that otherwise surface only when a tile reaches them.
- **Three API tiers, three connectors.** `TileServer`, `TileClient` and `tile()` over `LocalConnector`, `HttpConnector` and `S3Connector`, plus a browser bundle.

### Contents

[Quick start](#quick-start) · [API tiers](#api-tiers) · [Browser](#browser) · [Connectors](#connectors) · [Options](#options) · [Sources](#sources) · [Data support](#data-support) · [I/O and caching](#io-and-caching) · [Errors](#errors) · [Checking files](#checking-files) · [Guides](#guides) · [Development](#development) · [API docs](https://geozelot.github.io/fgb-vt/) · [Example app](examples/single-file-server)

---

## Quick start

```bash
npm install @geozelot/fgb-vt
# for S3, add the optional peer dependency:
npm install @aws-sdk/client-s3
```

`fgb-vt` runs on Node.js 18 and later, as an ES module or through `require()`.

```typescript
import { TileClient, LocalConnector } from '@geozelot/fgb-vt';

const client = new TileClient(new LocalConnector());

// Tile 4/3/6 of one layer; sources are given per call
const pbf = await client.tile(4, 3, 6, { name: 'counties', path: './data/us_counties.fgb' });

// pbf: a ready-to-serve Uint8Array (MVT, Protocol Buffers)
await client.close();
```

A complete tile endpoint:

```typescript
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { TileServer, LocalConnector } from '@geozelot/fgb-vt';

const tiles = new TileServer(
  { connector: new LocalConnector(), sources: { name: 'counties', path: './data/us_counties.fgb' } },
  { omitEmptyLayers: true }, // tiles without features encode to zero bytes
);
await tiles.open(); // read headers and upper index levels up front

createServer(async (req, res) => {
  const m = /^\/(\d+)\/(\d+)\/(\d+)\.mvt$/.exec(req.url ?? '');
  if (!m) return void res.writeHead(404).end();
  const [z, x, y] = m.slice(1).map(Number);
  try {
    // Changes with the files and settings; answer revalidations without rendering
    const etag = await tiles.tileETag(z, x, y);
    const headers = etag ? { etag } : {};
    if (etag && req.headers['if-none-match'] === etag) return void res.writeHead(304, headers).end();

    const pbf = await tiles.tile(z, x, y);
    if (pbf.length === 0) return void res.writeHead(204, headers).end();
    res.writeHead(200, { ...headers, 'content-type': 'application/vnd.mapbox-vector-tile', 'content-encoding': 'gzip' });
    res.end(gzipSync(pbf));
  } catch (err) {
    res.writeHead(err instanceof RangeError ? 400 : 500).end();
  }
}).listen(8080);
```

---

## API tiers

| Tier | Bound at construction | Per call | Use it for |
|------|----------------------|----------|-----------|
| `TileServer` | connectors and sources | `z/x/y` | long-running servers with a fixed set of layers |
| `TileClient` | one connector | `z/x/y` and sources | middleware choosing sources per request |
| `tile()` | nothing | connector, `z/x/y`, sources | one-off tiles, functions |

All three cache file headers and index pages (`TileServer` and `TileClient` per instance, `tile()` in a shared 64 MiB module-level cache), accept the same [options](#options), and take an abort `signal` and an `onTile` hook per call. Each also computes [tile ETags](#io-and-caching) (`tileETag`) and forgets cached files on request (`invalidate`, or `clearTileCache()` for `tile()`).

### `TileServer`

```typescript
import { TileServer, LocalConnector, HttpConnector } from '@geozelot/fgb-vt';

// One connector, layered tiles
const server = new TileServer({
  connector: new LocalConnector(),
  sources: [
    { name: 'buildings', path: './data/buildings.fgb' },
    { name: 'roads', path: './data/roads.fgb', options: { maxZoom: 16 } },
  ],
});

// Several connectors in one tile stack
const mixed = new TileServer([
  { connector: new LocalConnector(), sources: { name: 'local', path: './local.fgb' } },
  { connector: new HttpConnector(), sources: { name: 'remote', path: 'https://cdn.example.com/remote.fgb' } },
]);

const pbf = await server.tile(14, 8192, 5461);
const meta = await server.tileJSON({ tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt'] }); // TileJSON 3.0.0
await server.close();
```

Sources are opened on first use; `open()` preloads them.

### `TileClient`

```typescript
import { TileClient, HttpConnector } from '@geozelot/fgb-vt';

const client = new TileClient(new HttpConnector({ headers: { Authorization: 'Bearer ...' } }));

const pbf = await client.tile(12, 2048, 1365, [
  { name: 'water', path: 'https://data.example.com/water.fgb' },
  { name: 'roads', path: 'https://data.example.com/roads.fgb' },
]);
await client.close();
```

### `tile()`

```typescript
import { tile, S3Connector } from '@geozelot/fgb-vt';

const connector = new S3Connector({ region: 'us-east-1' }); // module scope: reused by warm invocations

const pbf = await tile(connector, 14, 8192, 5461, { name: 'poi', path: 's3://bucket/poi.fgb' }, {
  signal: AbortSignal.timeout(3000),
});
```

Pass `{ cache: false }` for no state at all. See the [serverless guide](guide/serverless.md) for a complete Lambda setup.

---

## Browser

The browser bundle includes everything except `LocalConnector` and `S3Connector`, and turns any hosted `.fgb` into a tile source without a tile server. With [MapLibre GL](https://maplibre.org/):

```html
<script type="module">
  import { TileClient, HttpConnector } from 'https://unpkg.com/@geozelot/fgb-vt@1/dist/fgb-vt.esm.min.js';

  const client = new TileClient(new HttpConnector());
  const counties = { name: 'counties', path: 'https://data.example.com/counties.fgb' };

  maplibregl.addProtocol('fgb', async (params, abort) => {
    const [z, x, y] = params.url.split('/').slice(-3).map(Number);
    const pbf = await client.tile(z, x, y, counties, { signal: abort.signal });
    return { data: pbf.slice().buffer };
  });
  // in the style: { type: 'vector', tiles: ['fgb://counties/{z}/{x}/{y}'] }
</script>
```

The UMD build (`dist/fgb-vt.umd.min.js`) exposes the same API as the global `fgbvt`. The file's server must answer range requests. For cross-origin files, CORS must allow the `Range` header and should expose `Content-Range` and `ETag` (`Access-Control-Expose-Headers`) for size and change detection; `Last-Modified` is used when there is no `ETag`.

---

## Connectors

| Connector | Reads from | Path format |
|-----------|-----------|-------------|
| `LocalConnector` | filesystem | `./data/buildings.fgb` |
| `HttpConnector` | HTTP(S) with range requests | `https://cdn.example.com/roads.fgb` |
| `S3Connector` | Amazon S3 and compatible stores | `s3://bucket/key.fgb` |

```typescript
new LocalConnector({ maxOpenFiles: 64 });

new HttpConnector({
  headers: { Authorization: 'Bearer ...' },
  timeout: 30_000,                       // per attempt, body included; 0 or Infinity: none
  maxConcurrency: 32,
  retry: { attempts: 3, backoff: 200 },  // exponential with jitter; honours Retry-After
  conditionalRequests: false,            // true: also send If-Match (bypasses HTTP caches)
  cacheNamespace: undefined,             // default: per set of headers (see Changing files)
});

new S3Connector({
  region: 'us-east-1',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
  endpoint: 'http://localhost:9000', // MinIO, R2, ... (with forcePathStyle if needed)
  timeout: 30_000,                   // per GetObject, body included
  requestPayer: 'requester',         // Requester Pays buckets
  expectedBucketOwner: '123456789012',
  getObjectParams: { SSECustomerAlgorithm: 'AES256', SSECustomerKey: '...' }, // e.g. SSE-C
});

// Reuse the application's client; pass the SDK module when bundling it
import * as s3 from '@aws-sdk/client-s3';
new S3Connector({ client: existingS3Client, sdk: s3 });
```

- **`maxConcurrency`** bounds the requests in flight across all reads through a connector (every tile and source sharing it); further requests wait in arrival order, and waiting does not count towards `timeout`. Defaults: 32 for HTTP in Node.js (6 in browsers), 50 for S3 (the SDK's socket pool). When one range of a multi-range read fails, the others are cancelled.
- **Responses are verified.** A server that ignores `Range`, returns another range than asked, or sends a body shorter than announced raises an error or is retried; a server that caps range sizes is asked for the rest. A whole-file response is never downloaded beyond what was requested.
- **`@aws-sdk/client-s3`** is imported on first use unless `sdk` is given. A `client` passed in is not destroyed by `close()`. A specific version of a versioned object is read with `s3://bucket/key.fgb?versionId=...`.
- **Custom connectors** implement `Connector` (`read`, `readRanges`, `close`); the optional `readHead`, `hints`, `cacheNamespace` and `ReadOptions` (`ifMatch`, `signal`) add single-request opens, change detection, cache sharing and cancellation.

---

## Options

Options cascade: **source** `options` override **tile-level** options (constructor or `tile()` call), which override the built-in defaults.

| Option | Default | Description |
|--------|---------|-------------|
| `extent` | `4096` | Tile coordinate extent |
| `buffer` | `64` | Buffer around the tile, in tile units |
| `tolerance` | `3` | Douglas-Peucker simplification tolerance, in tile units (`0` = off) |
| `minZoom` / `maxZoom` | `0` / `24` | Zoom range in which the source contributes (`maxZoom: Infinity` for no limit) |
| `simplifyBeforeClip` | `false` | Simplify whole features before clipping, so adjacent tiles match exactly along their edges (costs simplifying every feature in full) |
| `pointGrid` | `0` | Keep at most one point per cell of this size in tile units (`0` = off); use a divisor of `extent` |
| `maxFeatures` | `Infinity` | Most features a source may contribute to one tile |
| `maxReadBytes` | `256 MiB` | Most feature bytes read from a source for one tile |
| `maxTileBytes` | `Infinity` | Largest encoded tile (tile level only) |
| `reduceToFit` | `false` | When a tile exceeds `maxTileBytes`, encode it again with coarser simplification and point thinning (up to four times) before failing (tile level only) |
| `omitEmptyLayers` | `false` | Leave out layers without features (tile level only); a tile without any features encodes to **zero bytes**, e.g. for `204 No Content` |

```typescript
const server = new TileServer(
  {
    connector: new LocalConnector(),
    sources: [
      { name: 'detail', path: './detail.fgb', options: { tolerance: 1 } }, // tolerance 1
      { name: 'overview', path: './overview.fgb' },                        // tolerance 5, from the tile level
    ],
  },
  { tolerance: 5, maxZoom: 18 },
);
```

Invalid values (an `extent` of 0, a negative `buffer`, `minZoom` above `maxZoom`, ...) raise `RangeError` before anything is read.

**Budgets** (`maxFeatures`, `maxReadBytes`, `maxTileBytes`) are checked against the spatial index before any feature data is read, and raise `LimitExceededError` (with `limit`, `max` and `actual`); with `reduceToFit`, an oversized tile is first coarsened. For dense data at low zooms, an overview file serves better than larger budgets: `pointGrid` bounds the tile size, but every point is still read. Sources sharing a name are merged into one layer, so a dataset can be split by zoom:

```typescript
sources: [
  { name: 'poi', path: 'poi-overview.fgb', options: { maxZoom: 9 } },
  { name: 'poi', path: 'poi.fgb', options: { minZoom: 10 } },
]
```

---

## Sources

| Field | Default | Description |
|-------|---------|-------------|
| `name` | required | Layer name; sources sharing a name form one layer |
| `path` | required | File path, URL or S3 URI, as the connector expects |
| `options` | | Per-source [options](#options) |
| `crs` | `'auto'` | Coordinate reference system: from the header, `'lonlat'`, `'webmercator'` or a `Projection` (see [Data support](#data-support)) |
| `properties` | all | Names to keep (`['name', 'class']`, `[]` for none), or `{ exclude: [...] }`. Dropped strings are never decoded |
| `idColumn` | auto-detected | Integer column providing the MVT feature id, or `false` for none. By default the first integer column named `id`, `fid`, `gid` or `ogc_fid` |
| `keepIdProperty` | `false` | Also write the id column as a property |
| `useIndex` | `true` | `false` ignores the spatial index and scans the file (within `maxScanBytes`), e.g. for files whose index is broken |
| `filter` | | `(feature, zoom) => boolean`: write only some features. Sees every property (also those left out by `properties`), the id and the geometry family |
| `revision` | | Part of the source's [tile ETags](#io-and-caching): change it when a `filter` or projection behaves differently with the same source text, e.g. because it reads configuration |

```typescript
{
  name: 'roads',
  path: 's3://bucket/roads.fgb',
  properties: ['name', 'class'],
  idColumn: 'osm_id',
  // Only major roads below zoom 10
  filter: (f, z) => z >= 10 || f.properties.class === 'motorway' || f.properties.class === 'trunk',
  options: { minZoom: 6 },
}
```

A `filter` makes tiles smaller, not reads: features are read and decoded before they are filtered, and budgets count them. To read less at low zooms, add an overview file.

---

## Data support

**Format** — FlatGeobuf 3.x of any patch level, with or without a spatial index (files without one are scanned, up to `maxScanBytes`). Versions 1.x and 2.x raise `UnsupportedFormatError`.

**Geometry** — all 17 FlatGeobuf types, including layers that mix types:

| FlatGeobuf | MVT |
|------------|-----|
| Point, MultiPoint | `POINT` |
| LineString, MultiLineString | `LINESTRING` |
| Polygon, MultiPolygon, Triangle | `POLYGON` |
| CircularString, CompoundCurve, MultiCurve | `LINESTRING`, arcs linearised |
| CurvePolygon, MultiSurface | `POLYGON`, arcs linearised |
| TIN, PolyhedralSurface | `POLYGON`, one polygon per face |
| GeometryCollection | one feature per geometry family (polygons, lines, points), sharing id and properties |

Arcs are linearised per tile so that no chord deviates from the curve by more than one tile unit (up to 128 chords per arc). Z, M, T and TM values are ignored. Features of unknown or abstract geometry types are skipped.

**Antimeridian** — tiles at the world's east and west edges include features from the other side in their buffer, and data stored with longitudes beyond ±180° (such as a polygon from 170° to 190°) appears on both sides. A ring that jumps from 179° to -179° is indistinguishable from one spanning the globe: split such data at ±180° or store it beyond 180°.

**Properties** — all 15 column types. Binary columns are dropped (MVT has no binary values), and a feature's own column schema overrides the header's. 64-bit integers are written exactly (as `bigint` beyond 2^53); fractional numbers become MVT `float` when a 32-bit float holds them exactly, `double` otherwise.

**Coordinate reference systems** — built in:

- WGS 84 longitude/latitude: EPSG:4326, OGC:CRS84, or no CRS declared;
- geographic CRSs on datums within about 2 m of WGS 84: NAD83, ETRS89, GDA94, GDA2020, NZGD2000, SIRGAS 2000, JGD2000/2011;
- Web Mercator: EPSG:3857 and its aliases.

Any other CRS raises `UnsupportedFormatError` unless the source sets `crs`, for example with [proj4](https://github.com/proj4js/proj4js):

```typescript
import proj4 from 'proj4';

const utm = proj4('EPSG:25832', 'WGS84');
const parcels = {
  name: 'parcels',
  path: 's3://bucket/parcels-utm32.fgb',
  crs: {
    toWgs84: (x: number, y: number) => utm.forward([x, y]),
    fromWgs84: (lon: number, lat: number) => utm.inverse([lon, lat]),
  },
};
```

`crs: 'lonlat'` reads coordinates as longitude/latitude whatever the header says.

---

## I/O and caching

I/O options are accepted alongside the [options](#options) by `tile()`, `TileClient` and `TileServer`:

| Option | Default | Description |
|--------|---------|-------------|
| `cache` | shared 64 MiB `MemoryCache` (`tile()`), one per instance (`TileClient`, `TileServer`) | Header and index page cache: any `ByteCache` (`get`/`set`/`delete`), or `false` |
| `prefetch` | connector hint: 64 KiB local, 256 KiB HTTP/S3 (16 KiB HTTP in browsers) | Size of the first read of each file |
| `coalesceGap` | connector hint: 4 KiB local, 64 KiB HTTP/S3 | Merge byte ranges at most this far apart |
| `maxScanBytes` | 32 MiB | Largest feature section scanned for files **without** a spatial index |
| `maxFeatureBytes` | 256 MiB | Largest single feature read (guards against corrupt size prefixes) |

```typescript
import { TileClient, S3Connector, MemoryCache } from '@geozelot/fgb-vt';

const client = new TileClient(new S3Connector({ region: 'us-east-1' }), {
  cache: new MemoryCache({ maxBytes: 128 * 1024 * 1024 }),
});

// e.g. during a function's init phase: headers and upper index levels
await client.open({ name: 'parcels', path: 's3://bucket/parcels.fgb' });
```

**Cancellation** — every tile call accepts an `AbortSignal`, e.g. `{ signal: AbortSignal.timeout(3000) }` for a deadline. Pending reads are cancelled and the call rejects with the signal's reason.

**Metrics** — an `onTile` hook (per call, or as a `TileClient` / `TileServer` default) receives the tile size and duration and, per source, the features read and encoded, range requests, and index and feature bytes:

```typescript
const server = new TileServer(layers, {
  onTile: ({ z, tileBytes, durationMs, sources }) => {
    for (const s of sources) metrics.record(z, s.name, s.requests, s.indexBytes + s.featureBytes);
  },
});
```

**Changing files** — cache entries are keyed by connector, path and version tag (ETag or `Last-Modified` over HTTP, ETag in S3, inode, size and modification time locally). Every response is checked against the version tag; when a file is changed or replaced (also by renaming a new file over it), its source is reopened automatically. Without version tags, a replaced file is detected when its data no longer matches the cached index, and `invalidate(path)` (or `clearTileCache()` for `tile()`) forgets it explicitly; `invalidate()` without a path re-reads every file. Cache entries are shared between connectors of the same kind (`local`, `s3:<endpoint>`); `HttpConnector`s share them only with the same `headers`, which may select different content at the same URL, unless their `cacheNamespace` says otherwise.

**Tile ETags** — `tileETag(z, x, y)` (on `TileServer`, `TileClient`, and as a function next to `tile()`) returns a strong ETag computed from the files' version tags, the tile coordinates and every setting that affects the tile, without rendering it: answer `If-None-Match` with `304`, and let CDNs revalidate cheaply. Each file's version is confirmed with a one-byte read (at most once a second per file), so the ETag changes as soon as a file does. It is `null` when a connector reports no version tag. A `filter` or projection counts by its source text; set the source's `revision` when its behaviour changes otherwise.

**Cache failures** — a failing `ByteCache` (a full `/tmp`, an unreachable key-value store) never fails a tile: failed reads are misses, failed writes are skipped.

**TileJSON** — `server.tileJSON({ tiles, name, description, attribution, version })` returns TileJSON 3.0.0. Bounds come from the file headers (or index roots) in WGS 84, fields list the properties actually written, and names and descriptions default to the file headers.

---

## Errors

Data and I/O problems raise subclasses of `FgbVtError` with a stable `code` and the source `path`:

| Class | `code` | Raised when |
|-------|--------|-------------|
| `FormatError` | `FGB_FORMAT` | The file is not valid FlatGeobuf (corrupt, truncated, inconsistent) |
| `IndexMismatchError` | `FGB_FORMAT` | A `FormatError`: the spatial index does not match the feature data (a faulty writer). Rewrite the file, or set `useIndex: false` |
| `UnsupportedFormatError` | `FGB_UNSUPPORTED` | Valid FlatGeobuf that cannot be read: major version other than 3, unknown column type, or an unsupported CRS without `crs` on the source |
| `ConnectorError` | `FGB_IO` | Storage access failed: `status` (the HTTP or S3 status; 404 or 403 for local files), `retryable`, and `retryAfterMs` when the server asked to wait |
| `RangeNotSupportedError` | `FGB_RANGE_UNSUPPORTED` | An HTTP server ignores range requests |
| `SourceChangedError` | `FGB_SOURCE_CHANGED` | A file kept changing between reads |
| `LimitExceededError` | `FGB_LIMIT` | A budget was exceeded: `limit` names it (`features`, `readBytes`, `tileBytes`, `scanBytes`, `featureBytes`) |

Invalid tile coordinates and options, and an `idColumn` that is not an integer column of the file, raise `RangeError`; a source without a name or path, or an invalid URL, raises `TypeError`. Error messages show URLs without their query and user info, which may hold credentials; `err.path` keeps the path as given.

All option and result types are exported for TypeScript, e.g. `Source`, `TileOptions`, `IoOptions`, `RequestOptions`, `TileStats`, `Projection`, `TileJSON`; see the [API docs](https://geozelot.github.io/fgb-vt/).

---

## Checking files

`fgb-vt check` verifies files completely before you deploy them: tiles read only what they need, so a defect elsewhere in a file shows only when some tile reaches it.

```bash
npx @geozelot/fgb-vt check data/buildings.fgb https://cdn.example.com/roads.fgb s3://bucket/poi.fgb
```

For example, a file written by GDAL and one written with gogama/flatgeobuf's `IndexData` (see [Producing files](guide/producing-files.md#other-writers)):

```
test/fixtures/grid-5k.fgb  OK
  FlatGeobuf 3.0.1, 599.7 KiB, Point, 5000 features, 1 column
  CRS: EPSG:4326 (longitude/latitude), feature ids from "id"
  Index: node size 16, 5 levels, 208.4 KiB, node overlap 1.15
  Features: 5000 checked (390.6 KiB)
test/fixtures/gogama-indexdata-polygons.fgb  ERRORS
  FlatGeobuf 3.0.1, 35.6 KiB, MultiPolygon, 30 features, 6 columns
  CRS: EPSG:4326 (longitude/latitude), feature ids from "id"
  Index: node size 16, 3 levels, 1.3 KiB
  Features: 30 checked (34.0 KiB)
  error: The index root box [Infinity, Infinity, -Infinity, -Infinity] is empty: no query finds anything
  …
```

It checks the header and CRS, every spatial index node (valid boxes, parents containing their children, leaf offsets in order), and every feature: decoded, at the offset its index entry says, and inside the entry's box (or tiles can never find it). `--quick` checks the header and index only, `--max-bytes <n>` limits the features read, and `--json` prints the reports. The exit code is 1 if any file has errors. In code: `checkFile(connector, path, options)`.

---

## Guides

- [Serverless deployment](guide/serverless.md): Lambda and S3 setup, caching, budgets, error mapping, metrics
- [Producing files](guide/producing-files.md): writing FlatGeobuf for fast tiles, overviews, CRS, other writers

---

## Development

```bash
npm test               # unit, golden-file, validity and fuzz tests (Vitest; Node.js 22.12+)
npm run build          # ES module, CommonJS and browser builds
npm run test:smoke     # runtime check of the build (any supported Node.js)
npm run bench          # benchmarks; --json <file> and --summary <file> for machine-readable output
npm run bench:soak     # memory soak: 20,000 random tiles from one TileServer
npm run docs           # API docs (TypeDoc), including the guides
```

- **Golden files** in `test/fixtures` are written by GDAL (`python3 test/fixtures/generate.py`), by gogama/flatgeobuf (`cd test/fixtures/writers/gogama && go run . ../..`) and by the flatgeobuf JavaScript library (`cd test/fixtures/writers/flatgeobuf-js && npm ci && node generate.mjs ../..`).
- **Validity sweep:** every tile in the tests is checked by a strict MVT 2.1 validator (`test/helpers/mvt-validate.ts`).
- **Fuzzing:** `test/fuzz.test.ts` tiles randomly corrupted files and requires a valid tile or a typed error. Run longer with `FUZZ_ITERATIONS=20000`, and reproduce a failure with its `FUZZ_SEED`. A weekly CI workflow runs the long version.

Tile generation from the test files, measured locally (Node 24, warm cache):

| File | Tile | Time per tile |
|------|------|--------------:|
| 5,000 points | z8 | 0.05 ms |
| 5,000 points | z0 (all points) | 4.6 ms |
| detailed polygons (600–1,500 vertices per ring) | z7 | 0.19 ms |
| detailed polygons | z3 | 0.47 ms |
| curves, linearised | z5 | 0.10 ms |
| 5,000 points, no cache (header and index read per tile) | z8 | 0.15 ms |

CI publishes the full benchmark results for every commit in the job summary.

---

## License

[MIT](LICENSE)

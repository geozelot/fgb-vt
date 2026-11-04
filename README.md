[![npm version](https://img.shields.io/npm/v/@geozelot/fgb-vt)](https://www.npmjs.com/package/@geozelot/fgb-vt)
[![license](https://img.shields.io/npm/l/@geozelot/fgb-vt)](LICENSE)
[![node](https://img.shields.io/node/v/@geozelot/fgb-vt)](package.json)
[![types](https://img.shields.io/npm/types/@geozelot/fgb-vt)](https://www.npmjs.com/package/@geozelot/fgb-vt)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@geozelot/fgb-vt)](https://bundlephobia.com/package/@geozelot/fgb-vt)

# fgb-vt

---

Native _Node/TypeScript_ library for high-performance [_Vector Tile_](https://github.com/mapbox/vector-tile-spec) layering, encoding and serving - directly from [_FlatGeobuf_](https://flatgeobuf.org/) files. Fully utilizes _FlatGeobuf's_ _Packed Hilbert R-tree_ for tile-sized byte-range reads over the main feature storage.

`fgb-vt` attempts to conceptually close the gap between full tile pyramid creation on the backend, database-driven tile servers and processing static datasets on the client. It is specifically designed to access large, single-file objects on cloud storage via load-efficient _(HTTP) Range Requests_ and stateless deployment (e.g. via _AWS Lambda_) - targeting highly dynamic geospatial big-data mapping requirements.

Under the hood it's binary all the way down - no _GeoJSON_ detour, no intermediate format, just _FlatBuffers_ in and _Protobuf_ out, with projection, clipping and simplification natively implemented at the lowest level the types allow.

`fgb-vt` supports multi-layered tiles via concurrent access to different sources - even across different storage backends. It follows a slim, three-tier API layer approach for different use cases:
- `TileServer` - a semi-stateful, lazy-caching tile server over an initially configured set of sources
- `TileClient` - semi-stateful, connection-optimized tile client middleware with dynamic source selection
- `tile()` - semi-stateless, request-scoped, one-off tile generation function, suitable for Lambda-driven setups

and includes a Browser bundle for client-side _HTTP(S)_ source access.

Shipped with three concurrency-optimized connectors:
- `LocalConnector` - for local filesystem access
- `HttpConnector` - for _HTTP(S)_ with _Range Requests_
- `S3Connector` - for Amazon S3 / compatible storage backends with _Byte Range_ reads

___

### Quick Start

#### [Examples](examples) | [API Docs](https://geozelot.github.io/fgb-vt/)


```bash
npm install @geozelot/fgb-vt
```

```typescript
import { TileClient, LocalConnector } from '@geozelot/fgb-vt';

// set up a client with a filesystem connector
const client = new TileClient(new LocalConnector());

// request tile z=4, x=4, y=6 - sources are passed per call
const pbf = await client.tile(4, 4, 6, {
  name: 'counties',
  path: './data/us_counties.fgb',
});

// pbf is a ready-to-serve Uint8Array (MVT/PBF encoded)
await client.close();
```
<br>

***

# Usage

## Installation

    ```bash
    npm install @geozelot/fgb-vt
    ```
    
    For S3 support, add the optional peer dependency:
    
    ```bash
    npm install @aws-sdk/client-s3
    ```

**Browser**
     
    ```html
    <!-- UMD -->
    <script src="https://unpkg.com/@geozelot/fgb-vt/dist/fgb-vt.umd.min.js"></script>
    
    <!-- ESM -->
    <script type="module">
      import { tile, HttpConnector } from 'https://unpkg.com/@geozelot/fgb-vt/dist/fgb-vt.esm.min.js';
    </script>
    ```

  **Note:** Browser builds ship with `HttpConnector` only!

---

## Setup


### `TileServer`

Bind connectors and sources once; call `tile()` for the life of the process. File headers and spatial index pages are read on first access and kept in a bounded cache; `await server.open()` preloads them at start-up.

- **Single connector:**

    ```typescript
    import { TileServer, LocalConnector } from '@geozelot/fgb-vt';

    const server = new TileServer({
      connector: new LocalConnector(),
      sources: { name: 'counties', path: './data/us_counties.fgb' },
    });

    const pbf = await server.tile(4, 4, 6);
    const meta = await server.tileJSON();   // TileJSON 3.0.0
    await server.close();
    ```

- **Multi source (layered tiles):**

    ```typescript
    const server = new TileServer({
      connector: new LocalConnector(),
      sources: [
        { name: 'buildings', path: './data/buildings.fgb' },
        { name: 'roads', path: './data/roads.fgb', options: { maxZoom: 16 } },
      ],
    });
    ```

- **Multi connector:**

    ```typescript
    const server = new TileServer([
      { connector: new LocalConnector(), sources: { name: 'local', path: './local.fgb' } },
      { connector: new HttpConnector(), sources: { name: 'remote', path: 'https://cdn.example.com/remote.fgb' } },
    ]);
    ```
---
### `TileClient`

Connector bound at construction; sources provided per call. One connector, varying datasets - well suited for middleware or request-scoped source selection.

- **Single source:**

    ```typescript
    import { TileClient, HttpConnector } from '@geozelot/fgb-vt';

    const client = new TileClient(
      new HttpConnector({ headers: { Authorization: 'Bearer ...' } }),
    );

    const pbf = await client.tile(14, 8192, 5461, {
      name: 'parcels', path: 'https://data.example.com/parcels.fgb',
    });
    await client.close();
    ```

- **Multi source (layered tiles):**

    ```typescript
    const pbf = await client.tile(12, 2048, 1365, [
      { name: 'water', path: '/data/water.fgb' },
      { name: 'roads', path: '/data/roads.fgb' },
    ]);
    ```

___

### `tile()`

Everything per call - connector, coordinates, sources. The only state is a bounded module-level cache of headers and index pages (64 MiB), which warm serverless containers reuse; pass `{ cache: false }` for none. Drop it into a Lambda and call it a day.

- **Single source:**

    ```typescript
    import { tile, LocalConnector } from '@geozelot/fgb-vt';

    const connector = new LocalConnector();
    const pbf = await tile(connector, 14, 8192, 5461, {
      name: 'poi', path: './data/poi.fgb',
    });
    await connector.close();
    ```

- **Multi source:**

    ```typescript
    const pbf = await tile(connector, 14, 8192, 5461, [
      { name: 'buildings', path: './data/buildings.fgb' },
      { name: 'roads', path: './data/roads.fgb' },
    ]);
    ```

---

### Browser bundle

Use the browser bundle to turn any hosted `.fgb` into a vector tile source - no tile server required:

```html
<script src="https://unpkg.com/@geozelot/fgb-vt/dist/fgb-vt.umd.min.js"></script>
<script>
  const client = new fgbvt.TileClient(new fgbvt.HttpConnector());

  // generate tiles on demand, client-side
  const pbf = await client.tile(14, 8192, 5461, {
    name: 'counties', path: 'https://data.example.com/counties.fgb',
  });
</script>
```

---

## API Reference

### Connectors

Connectors abstract concurrent byte-range I/O across storage backends. Each implements the `Connector` interface.

| Connector | Reads from | Path format |
|-----------|-----------|-------------|
| `LocalConnector` | filesystem | `./data/buildings.fgb` |
| `HttpConnector` | HTTP(S) with Range Requests | `https://cdn.example.com/roads.fgb` |
| `S3Connector` | Amazon S3 / compatible | `s3://bucket/key.fgb` |

```typescript
new LocalConnector({ maxOpenFiles: 64 })

new HttpConnector({
  headers: { Authorization: 'Bearer ...' },
  timeout: 30_000,
  maxConcurrency: 6,
  retry: { attempts: 3, backoff: 200 },
})

new S3Connector({
  region: 'us-east-1', 
  credentials: { accessKeyId: '...', secretAccessKey: '...' }, 
  maxConcurrency: 6,
  endpoint: 'http://localhost:9000'   // for S3-compatible storage backends
})
```
---

### Options

Options cascade through three levels - **source** overrides **tile-level defaults** overrides **built-in defaults**:

| Option | Default | Description |
|--------|---------|-------------|
| `extent` | `4096` | Tile coordinate extent |
| `buffer` | `64` | Buffer around tile in tile-coordinate pixels |
| `tolerance` | `3` | Douglas-Peucker simplification tolerance |
| `minZoom` | `0` | Skip source below this zoom |
| `maxZoom` | `24` | Skip source above this zoom |
| `maxFeatures` | `Infinity` | Most features a source may contribute to one tile |
| `maxReadBytes` | `256 MiB` | Most feature bytes read from a source for one tile |
| `maxTileBytes` | `Infinity` | Largest encoded tile (tile level only) |

Budgets are checked against the spatial index **before** any feature data is read; an exceeded budget raises `LimitExceededError` (with `limit`, `max` and `actual`). For dense data at low zooms, prefer a higher `minZoom` or an overview file over large budgets.

```typescript
const server = new TileServer(
  {
    connector: new LocalConnector(),
    sources: [
      { name: 'detail', path: './detail.fgb', options: { tolerance: 1 } },  // tolerance=1
      { name: 'overview', path: './overview.fgb' },                         // tolerance=5 (from tile defaults)
    ],
  },
  { tolerance: 5, maxZoom: 18 },  // tile-level defaults
);
```
---

### I/O and caching

Tiles read only what they need: one initial request returns the header and the top of the spatial index, the index is searched level by level (whole subtrees inside the tile are resolved without descending), and matching features are fetched with merged range requests. Headers and index pages are cached, so repeated requests against the same files — including requests to a warm serverless container — typically need a single feature read.

I/O options are accepted alongside the tiling options by `tile()`, `TileClient` and `TileServer`:

| Option | Default | Description |
|--------|---------|-------------|
| `cache` | shared 64 MiB `MemoryCache` (`tile()`), one per instance (`TileClient`, `TileServer`) | Header and index page cache; any `ByteCache` (`get`/`set`/`delete`), or `false` |
| `prefetch` | connector hint: 64 KiB local, 256 KiB HTTP/S3 (16 KiB HTTP in browsers) | Size of the first read of each file |
| `coalesceGap` | connector hint: 4 KiB local, 64 KiB HTTP/S3 | Merge byte ranges at most this far apart |
| `maxScanBytes` | 32 MiB | Largest feature section scanned for files **without** a spatial index |
| `maxFeatureBytes` | 256 MiB | Largest single feature read (guards against corrupt size prefixes) |

```typescript
import { TileClient, S3Connector, MemoryCache } from '@geozelot/fgb-vt';

// module scope: survives warm invocations
const client = new TileClient(new S3Connector({ region: 'us-east-1' }), {
  cache: new MemoryCache({ maxBytes: 128 * 1024 * 1024 }),
});

// optional, e.g. during init: read headers and upper index levels up front
await client.open({ name: 'parcels', path: 's3://bucket/parcels.fgb' });
```

Every tile call accepts an `AbortSignal`, e.g. for a deadline: `tile(connector, z, x, y, sources, { signal: AbortSignal.timeout(3000) })`, `client.tile(z, x, y, sources, { signal })`, `server.tile(z, x, y, { signal })`. Pending reads are cancelled and the call rejects with the signal's reason.

Cache entries are keyed by path and version tag (ETag, or inode/size/mtime for local files). Every read carries the version tag; if a file is replaced, the source is reopened automatically. With custom connectors that report no version tag, cached files must not change in place.

---

### Errors

Data and I/O problems raise subclasses of `FgbVtError` with a stable `code` and the source `path`:

| Class | `code` | Raised when |
|-------|--------|-------------|
| `FormatError` | `FGB_FORMAT` | The file is not valid FlatGeobuf (corrupt, truncated, inconsistent) |
| `UnsupportedFormatError` | `FGB_UNSUPPORTED` | Valid FlatGeobuf this reader does not support (major versions other than 3) |
| `ConnectorError` | `FGB_IO` | Storage access failed |
| `RangeNotSupportedError` | `FGB_RANGE_UNSUPPORTED` | An HTTP server ignores `Range` requests |
| `SourceChangedError` | `FGB_SOURCE_CHANGED` | A file kept changing between reads |
| `LimitExceededError` | `FGB_LIMIT` | A budget is exceeded (`maxFeatures`, `maxReadBytes`, `maxTileBytes`, `maxScanBytes`, `maxFeatureBytes`); `limit` names which |

Invalid tile coordinates raise `RangeError`.

---

### Types

```typescript
import type {
  Connector, ReadOptions, ReadHeadResult, ConnectorHints,
  Source, SourceOptions, TileOptions, IoOptions, OpenOptions, RequestOptions, LimitKind,
  ByteCache, MemoryCacheOptions,
  TileServerLayer, TileJSON, BBox,
  LocalConnectorOptions, HttpConnectorOptions, S3ConnectorOptions,
} from '@geozelot/fgb-vt';
```

***

# Testing

### Unit Tests

```bash
npm test
```

Runs the full test suite via [Vitest](https://vitest.dev/).

### Benchmarks

```bash
npm run bench
```

| Stage | Input | Throughput |
|-------|-------|-----------|
| Projection | 1,000 coord pairs | ~38k ops/s |
| Clipping | 50 polygons (20v) | ~22k ops/s |
| Simplification | 200-point line | ~91k ops/s |
| MVT Encoding | 100-point line | ~1.6M ops/s |
| PBF Encoding | 100-feature layer | ~17k ops/s |
| Full Pipeline | 100 mixed features | ~2.6k ops/s |


<br>

***
# License

[MIT](LICENSE)

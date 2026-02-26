[![npm version](https://img.shields.io/npm/v/@geozelot/fgb-vt)](https://www.npmjs.com/package/@geozelot/fgb-vt)
[![license](https://img.shields.io/npm/l/@geozelot/fgb-vt)](LICENSE)
[![node](https://img.shields.io/node/v/@geozelot/fgb-vt)](package.json)
[![types](https://img.shields.io/npm/types/@geozelot/fgb-vt)](https://www.npmjs.com/package/@geozelot/fgb-vt)
[![bundle size](https://img.shields.io/bundlephobia/minzip/@geozelot/fgb-vt)](https://bundlephobia.com/package/@geozelot/fgb-vt)

# fgb-vt

#### [Mapbox Vector Tiles](https://github.com/mapbox/vector-tile-spec) straight from [FlatGeobuf](https://flatgeobuf.org/) - no pre-tiling, no ingestion pipeline, no dependencies.

The classic tile trade-off goes something like this: either you pre-generate a pyramid of millions of tiles, or you send raw geometries to the client and let the browser figure it out. `fgb-vt` is built to provide the best of both worlds, suitable for highly dynamic deployments. Point it at one or multiple `.fgb` file, ask for a tile, get a PBF. The data stays where it is - on disk, behind a CDN, in an S3 bucket - and every request reads only the bytes it actually needs, honoring the beauty of FlatGeobuf's packed Hilbert R-tree: byte-range reads _are_ spatial queries, so there's nothing to pre-process and nothing to cache. Constant memory, single file, arbitrary zoom.

`fgb-vt` supports multi-layered tiles via concurrent access to different sources - even across different storage. It fully utilizes _FlatGeobuf's_ ranged access for cloud-optimized deployment.

Under the hood it's binary all the way down - no _GeoJSON_ detour, no intermediate format, just _FlatBuffers_ in and _Protobuf_ out, with projection, clipping and simplification squeezed in between at the lowest level the types allow. The API ranges from a slim `TileServer` with lazy header caching and concurrent multi-source fetches, through a `TileClient` that works as middleware, down to a bare `tile()` function you could drop into a Lambda. Browser builds included.

---

# Quick Start

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

See [`examples/tile-server`](examples/tile-server) for a full interactive demo with a Node tile server, MapLibre GL frontend, live API tier switching and both local and HTTP connectors side by side.

---

# Setup

### Install

- **Node**

    ```bash
    npm install @geozelot/fgb-vt
    ```
    
    For S3 support, add the optional peer dependency:
    
    ```bash
    npm install @aws-sdk/client-s3
    ```

- **Browser**
     
    ```html
    <!-- UMD -->
    <script src="https://unpkg.com/@geozelot/fgb-vt/dist/fgb-vt.umd.min.js"></script>
    
    <!-- ESM -->
    <script type="module">
      import { tile, HttpConnector } from 'https://unpkg.com/@geozelot/fgb-vt/dist/fgb-vt.esm.min.js';
    </script>
    ```
    **Note:** Browser builds ship with `HttpConnector` only!

<br>

### `TileServer` - stateful

Bind connectors and sources once; call `tile()` for the life of the process. Headers and spatial index metadata are lazily cached on first access - maximum throughput after warm-up.

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
<br>

### `TileClient` - semi-stateful

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
<br>

### `tile()` - semi-stateless

Everything per call - connector, coordinates, sources. No instance state beyond a module-level tile bounds cache. Drop it into a Lambda and call it a day.

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

<br>

### Browser

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

<br>

---
# API Reference

#### [> Full API docs](https://geozelot.github.io/fgb-vt/)

## Connectors

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

## Options

Options cascade through three levels - **source** overrides **tile-level defaults** overrides **built-in defaults**:

| Option | Default | Description |
|--------|---------|-------------|
| `extent` | `4096` | Tile coordinate extent |
| `buffer` | `64` | Buffer around tile in tile-coordinate pixels |
| `tolerance` | `3` | Douglas-Peucker simplification tolerance |
| `minZoom` | `0` | Skip source below this zoom |
| `maxZoom` | `24` | Skip source above this zoom |

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

## Types

```typescript
import type {
  Connector,
  Source, SourceOptions, TileOptions,
  TileServerLayer, TileJSON, BBox,
  LocalConnectorOptions, HttpConnectorOptions, S3ConnectorOptions,
} from '@geozelot/fgb-vt';
```
<br>

---
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

---
# License

[MIT](LICENSE)

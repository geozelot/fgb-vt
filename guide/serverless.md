---
title: Serverless deployment
---

# Serverless deployment

fgb-vt renders tiles straight from FlatGeobuf files in object storage, so a tile endpoint can be a single function with no tile cache and no database. This guide covers AWS Lambda with S3; the same points apply to other function platforms and to `HttpConnector`.

## What a tile costs

For an indexed file, a tile needs:

1. **The header and the top of the spatial index** in one request: the first `prefetch` bytes (256 KiB for S3 and HTTP). This happens once per file per container, then comes from the cache.
2. **Index pages** for the part of the R-tree the tile reaches, merged into as few requests as possible. Subtrees entirely inside the tile are not descended. Pages are cached.
3. **The matching features**, merged into ranges (features up to `coalesceGap`, 64 KiB, apart share a request).

A warm container typically needs one request per tile and source: the features. On a 1-million-point file, a cold tile reads between 0.3 and 5 MB of index, instead of the whole 40 MB index.

## Keep state at module scope

Create the client (or server) outside the handler so that the connector, the cache and opened files survive warm invocations. Open the sources during the init phase, where time is not billed against the request:

```typescript
import { TileClient, S3Connector, MemoryCache } from '@geozelot/fgb-vt';

const client = new TileClient(new S3Connector({ region: process.env.AWS_REGION }), {
  cache: new MemoryCache({ maxBytes: 128 * 1024 * 1024 }), // headers and index pages
  maxTileBytes: 4 * 1024 * 1024,                          // stay below the response limit
  omitEmptyLayers: true,                                  // empty tiles encode to 0 bytes
});

const sources = [
  { name: 'parcels', path: 's3://bucket/parcels.fgb', properties: ['id', 'use'] },
];

// Reads headers and the upper index levels (up to 4 MiB per file)
await client.open(sources);
```

Size the cache to the index pages your traffic touches: the upper levels of each file plus the leaf pages of popular areas. 64–256 MiB is typical; the Lambda function's memory must cover it.

## The handler

```typescript
import { gzipSync } from 'node:zlib';
import { FgbVtError, LimitExceededError, FormatError, ConnectorError } from '@geozelot/fgb-vt';

export const handler = async (event, context) => {
  const [z, x, y] = event.rawPath.match(/(\d+)\/(\d+)\/(\d+)/).slice(1).map(Number);
  // Leave a second to answer before the function times out
  const signal = AbortSignal.timeout(context.getRemainingTimeInMillis() - 1000);
  try {
    // Revalidation (from a CDN or browser) costs only the cached headers
    const etag = await client.tileETag(z, x, y, sources, { signal });
    const cacheHeaders = { 'cache-control': 'public, max-age=3600', ...(etag ? { etag } : {}) };
    if (etag && event.headers?.['if-none-match'] === etag) return { statusCode: 304, headers: cacheHeaders };

    const pbf = await client.tile(z, x, y, sources, { signal });
    if (pbf.length === 0) return { statusCode: 204, headers: cacheHeaders };
    return {
      statusCode: 200,
      headers: {
        ...cacheHeaders,
        'content-type': 'application/vnd.mapbox-vector-tile',
        'content-encoding': 'gzip',
      },
      isBase64Encoded: true,
      body: gzipSync(pbf).toString('base64'),
    };
  } catch (err) {
    const status = statusFor(err);
    const retryAfter = err instanceof ConnectorError && err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : null;
    return { statusCode: status, ...(retryAfter ? { headers: { 'retry-after': String(retryAfter) } } : {}) };
  }
};

function statusFor(err: unknown): number {
  if (err instanceof RangeError) return 400;                  // invalid z/x/y
  if (err instanceof LimitExceededError) return 422;           // tile too large for the budgets
  if (err instanceof ConnectorError) {
    if (err.status === 404) return 404;                        // the file is gone
    return err.retryable ? 503 : 502;                          // throttled or down: retry later
  }
  if (err instanceof FormatError) return 500;                  // broken file: log it
  if ((err as Error)?.name === 'TimeoutError') return 504;
  return 500;
}
```

Messages of fgb-vt errors show URLs without their query, so presigned URLs do not leak into logs through `err.message`; `err.path` holds the path as given.

Responses through API Gateway or function URLs are base64-encoded, which adds a third: a 6 MB response limit leaves about 4.5 MB of (gzipped) tile, hence `maxTileBytes` above. With `reduceToFit: true`, a tile over the limit is encoded again with coarser simplification and point thinning before it fails; `TileStats.reduced` counts how often that happens, a sign that the zoom range needs an overview file.

## Budgets

Budgets turn tiles that would be slow or huge into fast, explicit errors. They are checked against the index before any feature data is read:

| Option | Use |
|--------|-----|
| `maxFeatures` | Most features one source contributes to a tile |
| `maxReadBytes` | Most feature bytes read from one source (default 256 MiB) |
| `maxTileBytes` | Largest encoded tile |
| `maxScanBytes` | Largest unindexed file that will be scanned (default 32 MiB) |

When low zooms hit the budgets, don't raise them: serve an overview file at low zooms (see [Producing files](./producing-files.md)), or set `minZoom` on the detailed source.

## Concurrency

A Lambda container handles one request at a time, but one tile can read several sources and ranges at once. `maxConcurrency` limits the requests in flight per connector (S3: 50, matching the SDK's socket pool). In a long-running server that shares one connector between many concurrent tiles, this limit is what keeps the server from opening hundreds of connections; requests beyond it queue in arrival order.

Share one `S3Client` between fgb-vt and the rest of the function with `new S3Connector({ client, sdk })`. If you bundle the AWS SDK into the function, pass the module as `sdk` so that fgb-vt does not import it at runtime.

## Observability

`onTile` reports, per tile and source, the features read and encoded, range requests, and index and feature bytes. For example, as CloudWatch embedded metrics:

```typescript
const client = new TileClient(connector, {
  onTile: ({ z, durationMs, tileBytes, sources }) => {
    console.log(JSON.stringify({
      _aws: { CloudWatchMetrics: [{ Namespace: 'tiles', Dimensions: [['zoom']],
        Metrics: [{ Name: 'durationMs' }, { Name: 'tileBytes' }, { Name: 'requests' }] }] },
      zoom: String(z), durationMs, tileBytes,
      requests: sources.reduce((n, s) => n + s.requests, 0),
    }));
  },
});
```

Rising `indexBytes` on warm containers means the cache is too small for the traffic; rising `requests` per tile means features are spread out (consider coarser zoom ranges per file).

## Files that change

Every response is checked against the version tag (S3 `ETag`) of the file as it was opened. If a file is replaced, the next tile notices the mismatch, drops the cached header and index pages, and reopens the file. Replacing files in place is therefore safe; for atomic switches of several files, write new keys and change the source paths instead. Tile ETags change with the files, so CDNs revalidate replaced tiles.

Connectors and HTTP servers that report no version tag (neither `ETag` nor `Last-Modified`) cannot detect a replacement before the data stops matching the cached index; call `client.invalidate(path)` after replacing such a file. Check new files with `npx @geozelot/fgb-vt check` before uploading them.

A custom `ByteCache` backed by `/tmp` or a key-value store may fail (a full disk, an unreachable store): failed reads count as misses and failed writes are skipped, so tiles still render.

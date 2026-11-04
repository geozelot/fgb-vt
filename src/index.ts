/**
 * @module fgb-vt
 *
 * Public API surface for the fgb-vt library.
 *
 * fgb-vt generates Mapbox Vector Tiles (MVT) on the fly from cloud-optimized
 * FlatGeobuf files using HTTP range requests, without any intermediate tile
 * storage. The library is organized around a **three-tier API** and a
 * **three-connector** model:
 *
 * ---
 *
 * ### API Tiers
 *
 * Each tier offers a different trade-off between convenience and flexibility:
 *
 * | Tier | Export | State | Use case |
 * |------|--------|-------|----------|
 * | **Stateful** | {@link TileServer} | Connectors, sources, header and index page cache | Long-running server with a fixed source set. Maximum throughput -- all per-source overhead is amortized across requests. |
 * | **Semi-stateful** | {@link TileClient} | Single connector, header and index page cache | Application sharing one connector but varying sources per request (e.g. dynamic layer selection). |
 * | **Stateless** | {@link tile} | Shared module-level page cache only (or none with `cache: false`) | One-off or ad-hoc tile generation. Everything is provided per call. |
 *
 * ---
 *
 * ### Connectors
 *
 * Connectors abstract byte-range I/O to FlatGeobuf files across storage
 * backends. Each connector implements the {@link Connector} interface:
 *
 * | Connector | Backend | Path format |
 * |-----------|---------|-------------|
 * | {@link LocalConnector} | Local filesystem (Node.js `FileHandle`) | `./data/buildings.fgb` |
 * | {@link HttpConnector} | HTTP/HTTPS with Range Requests | `https://cdn.example.com/roads.fgb` |
 * | {@link S3Connector} | AWS S3 / S3-compatible stores | `s3://bucket/key.fgb` |
 *
 * ---
 *
 * ### Types
 *
 * Supporting interfaces and option types are re-exported for consumer
 * convenience:
 *
 * - {@link Source} / {@link SourceOptions} -- per-source descriptors and
 *   tiling parameter overrides.
 * - {@link TileOptions} -- tile-level default parameters.
 * - {@link TileServerLayer} -- binds a connector to one or more sources
 *   for {@link TileServer}.
 * - {@link TileJSON} -- TileJSON 3.0.0 metadata descriptor.
 * - {@link BBox} -- axis-aligned bounding box used throughout the pipeline.
 * - Connector option interfaces: {@link LocalConnectorOptions},
 *   {@link HttpConnectorOptions}, {@link S3ConnectorOptions}.
 */

// == API Tiers ==============================================================

export { TileServer } from './server.js';
export { TileClient } from './client.js';
export { tile } from './tile.js';

// == Connectors =============================================================

export { LocalConnector } from './connectors/local.js';
export { HttpConnector } from './connectors/http.js';
export { S3Connector } from './connectors/s3.js';

// == Types ==================================================================

export type { Connector, ReadOptions, ReadHeadResult, ConnectorHints } from './connectors/connector.js';
export type { LocalConnectorOptions } from './connectors/local.js';
export type { HttpConnectorOptions } from './connectors/http.js';
export type { S3ConnectorOptions, S3ClientLike, S3SdkModule } from './connectors/s3.js';
export type { Source, SourceOptions, TileOptions } from './source.js';
export type { Projection, SourceCrs } from './geometry/crs.js';
export type { TileServerLayer, TileJSONOptions } from './server.js';
export type { TileJSON, BBox } from './types.js';
export type { ByteCache, MemoryCacheOptions } from './cache.js';
export type { IoOptions } from './fgb/reader.js';
export type { OpenOptions } from './client.js';
export type { RequestOptions, TileStats, SourceStats } from './pipeline.js';
export type { PropertySelection } from './schema.js';
export type { LimitKind } from './errors.js';

// == Caching & errors =======================================================

export { MemoryCache } from './cache.js';
export {
  FgbVtError,
  FormatError,
  IndexMismatchError,
  UnsupportedFormatError,
  ConnectorError,
  RangeNotSupportedError,
  SourceChangedError,
  LimitExceededError,
} from './errors.js';

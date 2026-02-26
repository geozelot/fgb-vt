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
 * | **Stateful** | {@link TileServer} | Connectors, sources, headers, indices | Long-running server with a fixed source set. Maximum throughput -- all per-source overhead is amortized across requests. |
 * | **Semi-stateful** | {@link TileClient} | Single connector, tile bounds cache | Application sharing one connector but varying sources per request (e.g. dynamic layer selection). |
 * | **Stateless** | {@link tile} | Module-level tile bounds cache only | One-off or ad-hoc tile generation. Everything is provided per call. |
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

// ─── API Tiers ──────────────────────────────────────────────────────────────

export { TileServer } from './server.js';
export { TileClient } from './client.js';
export { tile } from './tile.js';

// ─── Connectors ─────────────────────────────────────────────────────────────

export { LocalConnector } from './connectors/local.js';
export { HttpConnector } from './connectors/http.js';
export { S3Connector } from './connectors/s3.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type { Connector } from './connectors/connector.js';
export type { LocalConnectorOptions } from './connectors/local.js';
export type { HttpConnectorOptions } from './connectors/http.js';
export type { S3ConnectorOptions } from './connectors/s3.js';
export type { Source, SourceOptions, TileOptions } from './source.js';
export type { TileServerLayer } from './server.js';
export type { TileJSON, BBox } from './types.js';

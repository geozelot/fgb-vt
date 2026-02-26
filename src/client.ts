/**
 * @module client
 *
 * Semi-stateful tile client for FlatGeobuf vector tile generation.
 *
 * The {@link TileClient} binds a single {@link Connector} at construction
 * time while leaving source selection to each `tile()` call. An
 * instance-level {@link TileBoundsCache} is shared across calls, amortizing
 * tile-bound computation for repeated zoom levels.
 *
 * This tier sits between the fully stateless {@link tile} function (where
 * everything is provided per call) and the fully stateful {@link TileServer}
 * (where both connectors and sources are fixed up front). It is well suited
 * for applications that share a single authenticated HTTP connector but
 * serve different FGB sources depending on request context.
 *
 * @example
 * ```typescript
 * import { TileClient } from 'fgb-vt';
 * import { HttpConnector } from 'fgb-vt/connectors';
 *
 * const client = new TileClient(
 *   new HttpConnector({ headers: { Authorization: 'Bearer ...' } }),
 *   { extent: 4096, buffer: 64 },
 * );
 *
 * const source = { name: 'parcels', path: 'https://data.example.com/parcels.fgb' };
 * const pbf = await client.tile(14, 8192, 5461, source);
 *
 * await client.close();
 * ```
 */

import type { Connector } from './connectors/connector.js';
import type { Source, TileOptions } from './source.js';
import { TileBoundsCache } from './tiles.js';
import { processTile } from './pipeline.js';

/**
 * Semi-stateful tile client.
 *
 * A single {@link Connector} is bound at construction; {@link Source}
 * descriptors are provided per `tile()` call. An instance-level tile bounds
 * cache is shared across calls, avoiding redundant tile-to-mercator
 * calculations.
 *
 * Use case: application sharing one HTTP connector (with auth headers) but
 * querying different FGB sources depending on request context.
 *
 * @example
 * ```typescript
 * const client = new TileClient(connector, { tolerance: 2 });
 *
 * // Different sources per request
 * const buildingsTile = await client.tile(14, 8192, 5461, buildingsSource);
 * const roadsTile = await client.tile(14, 8192, 5461, roadsSource);
 *
 * // Multi-source layered tile
 * const layered = await client.tile(14, 8192, 5461, [buildingsSource, roadsSource]);
 *
 * await client.close();
 * ```
 */
export class TileClient {
  private readonly connector: Connector;
  private readonly options: TileOptions | undefined;
  private readonly boundsCache = new TileBoundsCache();

  /**
   * Create a new tile client bound to the given connector.
   *
   * @param connector - Byte-range reader for accessing FGB files. Shared
   *   across all subsequent `tile()` calls.
   * @param options - Tile-level tiling option defaults applied to every call
   *   unless overridden by per-source options.
   */
  constructor(connector: Connector, options?: TileOptions) {
    this.connector = connector;
    this.options = options;
  }

  /**
   * Generate a vector tile from multiple FlatGeobuf sources.
   *
   * Each source produces one MVT layer in the output PBF. Layer ordering
   * matches the order of the `sources` array.
   *
   * @param z - Tile zoom level.
   * @param x - Tile column.
   * @param y - Tile row.
   * @param sources - Array of source descriptors; each becomes one MVT layer.
   * @returns PBF-encoded Mapbox Vector Tile containing one layer per source.
   *
   * @example
   * ```typescript
   * const pbf = await client.tile(12, 2048, 1365, [
   *   { name: 'water', path: '/data/water.fgb' },
   *   { name: 'roads', path: '/data/roads.fgb' },
   * ]);
   * ```
   */
  tile(
    z: number,
    x: number,
    y: number,
    sources: Source[],
  ): Promise<Uint8Array>;

  /**
   * Generate a vector tile from a single FlatGeobuf source.
   *
   * Convenience overload that wraps the source in a single-element array
   * and delegates to the multi-source implementation.
   *
   * @param z - Tile zoom level.
   * @param x - Tile column.
   * @param y - Tile row.
   * @param source - Single source descriptor; produces one MVT layer.
   * @returns PBF-encoded Mapbox Vector Tile containing one layer.
   *
   * @example
   * ```typescript
   * const pbf = await client.tile(14, 8192, 5461, {
   *   name: 'buildings',
   *   path: 'https://cdn.example.com/buildings.fgb',
   * });
   * ```
   */
  tile(
    z: number,
    x: number,
    y: number,
    source: Source,
  ): Promise<Uint8Array>;

  // Implementation
  tile(
    z: number,
    x: number,
    y: number,
    sourceOrSources: Source | Source[],
  ): Promise<Uint8Array> {
    const sources = Array.isArray(sourceOrSources)
      ? sourceOrSources
      : [sourceOrSources];

    return processTile(
      this.connector,
      z, x, y,
      sources,
      this.options,
      this.boundsCache,
    );
  }

  /**
   * Release connector resources (pooled connections, file handles, etc.).
   *
   * After calling `close()`, this client instance must not be used again.
   *
   * @returns Resolves when the underlying connector has been closed.
   */
  async close(): Promise<void> {
    await this.connector.close();
  }
}

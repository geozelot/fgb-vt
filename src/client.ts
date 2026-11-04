/**
 * @module client
 *
 * Semi-stateful tile client for FlatGeobuf vector tile generation.
 *
 * The {@link TileClient} binds a single {@link Connector} at construction
 * time while leaving source selection to each `tile()` call. File headers
 * and spatial index pages are cached per instance (a bounded
 * {@link MemoryCache} by default), so repeated requests against the same
 * files skip most index reads; {@link TileClient.open} preloads them.
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
import { processTile, type RequestOptions } from './pipeline.js';
import { MemoryCache } from './cache.js';
import { createIoContext, getSource, type IoContext, type IoOptions } from './fgb/reader.js';
import { withPath } from './errors.js';

/**
 * Options for {@link TileClient.open} and {@link TileServer.open}.
 */
export interface OpenOptions {
  /**
   * Also read every spatial index level above the leaves, in one request
   * per file, when it is at most this many bytes. Later tiles then need at
   * most one index read. `false` reads only the header and the top of the
   * index.
   *
   * @defaultValue 4194304 (4 MiB)
   */
  warmIndex?: number | false;
  /** Aborts opening. Opens shared with concurrent requests keep running. */
  signal?: AbortSignal;
}

/** Default budget for {@link OpenOptions.warmIndex}. */
export const DEFAULT_WARM_INDEX_BYTES = 4 * 1024 * 1024;

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
  private readonly context: IoContext;

  /**
   * Create a new tile client bound to the given connector.
   *
   * @param connector - Byte-range reader for accessing FGB files. Shared
   *   across all subsequent `tile()` calls.
   * @param options - Tile-level tiling option defaults applied to every call
   *   unless overridden by per-source options, plus I/O options (cache,
   *   prefetch, range merging, scan budget).
   */
  constructor(connector: Connector, options?: TileOptions & IoOptions) {
    this.connector = connector;
    this.options = options;
    this.context = createIoContext(options, new MemoryCache());
  }

  /**
   * Open sources ahead of the first tile request: read each file's header
   * and the top of its spatial index and, within the
   * {@link OpenOptions.warmIndex} budget, all upper index levels.
   *
   * Useful during the init phase of a serverless function or at server
   * start-up. Opening is otherwise lazy.
   *
   * @param sources - Sources (or a single source) to open.
   * @param options - Index warm-up budget.
   * @returns Resolves when every source is open.
   * @throws {FgbVtError} If a source cannot be opened (annotated with its path).
   */
  async open(sources: Source | Source[], options?: OpenOptions): Promise<void> {
    await openSources(this.connector, Array.isArray(sources) ? sources : [sources], this.context, options);
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
   * @param request - Optional abort `signal`.
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
    request?: RequestOptions,
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
   * @param request - Optional abort `signal`.
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
    request?: RequestOptions,
  ): Promise<Uint8Array>;

  // Implementation
  tile(
    z: number,
    x: number,
    y: number,
    sourceOrSources: Source | Source[],
    request?: RequestOptions,
  ): Promise<Uint8Array> {
    const sources = Array.isArray(sourceOrSources)
      ? sourceOrSources
      : [sourceOrSources];

    return processTile(
      this.connector,
      z, x, y,
      sources,
      this.options,
      this.context,
      request?.signal,
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

/**
 * Open sources and optionally warm their upper index levels.
 *
 * @param connector - Connector for all sources.
 * @param sources - Sources to open.
 * @param context - I/O context (its cache receives the warmed pages).
 * @param options - Warm-up budget.
 */
export async function openSources(
  connector: Connector,
  sources: Source[],
  context: IoContext,
  options?: OpenOptions,
): Promise<void> {
  const budget = options?.warmIndex === false ? 0 : (options?.warmIndex ?? DEFAULT_WARM_INDEX_BYTES);
  await Promise.all(sources.map(async (source) => {
    try {
      const fgb = await getSource(connector, source.path, context, options?.signal);
      if (budget > 0) await fgb.warmIndex(budget, options?.signal);
    } catch (err) {
      throw withPath(err, source.path);
    }
  }));
}

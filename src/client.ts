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
 * import { TileClient, HttpConnector } from '@geozelot/fgb-vt';
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
import { validateSource } from './source.js';
import { computeTileETag, processTile, withSource, type RequestOptions } from './pipeline.js';
import { MemoryCache, type ByteCache } from './cache.js';
import { createIoContext, forgetHeaders, forgetSources, invalidateSource, type IoContext, type IoOptions } from './fgb/reader.js';
import { resolveFrame } from './geometry/crs.js';
import { featureSchema, validateSchema } from './schema.js';
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
 * descriptors are provided per `tile()` call. File headers and spatial
 * index pages are cached per instance (see {@link IoOptions.cache}), so
 * repeated tiles from the same files skip most index reads.
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
  private readonly onTile: RequestOptions['onTile'];
  /** The cache in use, as passed or created (before error guarding), or `null`. */
  private readonly cache: ByteCache | null;
  /** Whether {@link cache} was created here (and is cleared by this client). */
  private readonly ownsCache: boolean;

  /**
   * Create a new tile client bound to the given connector.
   *
   * @param connector - Byte-range reader for accessing FGB files. Shared
   *   across all subsequent `tile()` calls.
   * @param options - Tile-level tiling option defaults applied to every call
   *   unless overridden by per-source options, plus I/O options (cache,
   *   prefetch, range merging, scan budget) and a default `onTile` hook.
   * @throws {RangeError} If an I/O option is invalid.
   */
  constructor(connector: Connector, options?: TileOptions & IoOptions & Pick<RequestOptions, 'onTile'>) {
    this.connector = connector;
    this.options = options;
    this.cache = options?.cache === false ? null : (options?.cache ?? new MemoryCache());
    this.ownsCache = options?.cache === undefined;
    this.context = createIoContext(options, this.cache ?? new MemoryCache());
    this.onTile = options?.onTile;
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
   * @throws {FgbVtError} If a source cannot be opened (annotated with its path),
   *   including `UnsupportedFormatError` for a CRS without a configured projection.
   * @throws {RangeError} If a source's `idColumn` is not an integer column of its file.
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
   * @param request - Optional abort `signal` and `onTile` hook (overrides the constructor's).
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
   * @param request - Optional abort `signal` and `onTile` hook (overrides the constructor's).
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
      { onTile: this.onTile, ...request },
    );
  }

  /**
   * Compute the ETag of a tile without rendering it, e.g. to answer
   * `If-None-Match` with `304 Not Modified`. It changes whenever a source
   * file, a setting or the library's tile encoding changes.
   *
   * @param z - Tile zoom level.
   * @param x - Tile column.
   * @param y - Tile row.
   * @param sources - The sources (or source) the tile is rendered from.
   * @param request - Optional abort signal.
   * @returns A strong, quoted ETag, or `null` when a source's connector
   *   reports no version tag (e.g. an HTTP server without `ETag` or
   *   `Last-Modified`).
   * @throws {FgbVtError} If a source cannot be opened (annotated with its path).
   */
  tileETag(
    z: number,
    x: number,
    y: number,
    sources: Source | Source[],
    request?: Pick<RequestOptions, 'signal'>,
  ): Promise<string | null> {
    const list = Array.isArray(sources) ? sources : [sources];
    return computeTileETag(
      list.map(source => [this.connector, source]), z, x, y, this.options, this.context, request?.signal,
    );
  }

  /**
   * Forget what is cached about a file, so the next request re-reads its
   * header and index, e.g. after the file was replaced at the same path.
   * Without a path, every source is reopened from its file (the client's
   * own cache is cleared; in a cache passed as an option, the entries are
   * replaced as the files are read again).
   *
   * Files with version tags are detected as changed automatically; this is
   * for connectors and servers that report none.
   *
   * @param path - Source path, or omitted for all sources.
   * @returns Resolves when the entries are removed from the cache.
   */
  async invalidate(path?: string): Promise<void> {
    if (path !== undefined) return invalidateSource(this.connector, path, this.context);
    // A shared cache cannot be cleared, and its header entries name no
    // client: distrust every header cached until now instead
    forgetHeaders(this.context);
    if (this.cache) {
      forgetSources(this.cache);
      if (this.ownsCache) (this.cache as MemoryCache).clear();
    }
  }

  /**
   * Release connector resources (pooled connections, file handles, etc.)
   * and the client's own cache.
   *
   * After calling `close()`, this client instance must not be used again.
   *
   * @returns Resolves when the underlying connector has been closed.
   */
  async close(): Promise<void> {
    if (this.cache && this.ownsCache) {
      forgetSources(this.cache);
      (this.cache as MemoryCache).clear();
    }
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
  for (const source of sources) validateSource(source);
  await Promise.all(sources.map(async (source) => {
    try {
      await withSource(connector, source, context, options?.signal, async (fgb) => {
        // Fail now rather than on the first tile if the CRS or id column do not fit
        resolveFrame(fgb.header.crs, source.crs, source.path);
        validateSchema(featureSchema(source), fgb.header, source.path);
        if (budget > 0) await fgb.warmIndex(budget, options?.signal);
      });
    } catch (err) {
      throw withPath(err, source.path);
    }
  }));
}

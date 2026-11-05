/**
 * @module tile
 *
 * Semi-stateless tile generation from FlatGeobuf sources.
 *
 * This is the lowest-ceremony entry point in the fgb-vt API. Every
 * dependency — connector, sources, and options — is provided per call.
 *
 * The only state is a bounded module-level {@link MemoryCache} (64 MiB) of
 * file headers and spatial index pages, shared by all calls. In a
 * serverless function it survives warm invocations, so repeat requests
 * against the same files skip most index reads. Pass `cache: false` for
 * fully stateless operation, or your own {@link ByteCache}.
 *
 * For binding a connector or a fixed set of sources, see the
 * {@link TileClient} and {@link TileServer} tiers.
 *
 * @example
 * ```typescript
 * import { tile, HttpConnector } from '@geozelot/fgb-vt';
 *
 * const connector = new HttpConnector();
 * const source = { name: 'buildings', path: 'https://cdn.example.com/buildings.fgb' };
 *
 * // Single-source — returns a single-layer PBF
 * const pbf = await tile(connector, 14, 8192, 5461, source);
 *
 * // Multi-source — returns a layered PBF with layers ordered per array
 * const roads = { name: 'roads', path: 'https://cdn.example.com/roads.fgb' };
 * const layered = await tile(connector, 14, 8192, 5461, [source, roads]);
 * ```
 */

import type { Connector } from './connectors/connector.js';
import type { Source, TileOptions } from './source.js';
import { computeTileETag, processTile, type RequestOptions } from './pipeline.js';
import { MemoryCache } from './cache.js';
import { createIoContext, forgetSources, invalidateSource, type IoOptions } from './fgb/reader.js';

/** Module-level header and index cache shared by all `tile()` calls. */
const sharedCache = new MemoryCache({ maxBytes: 64 * 1024 * 1024 });

/**
 * Generate a vector tile from multiple FlatGeobuf sources.
 *
 * Each source produces one MVT layer in the output PBF. Layer ordering
 * matches the order of the `sources` array.
 *
 * @param connector - Byte-range reader for accessing FGB files.
 * @param z - Tile zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param sources - Array of source descriptors; each becomes one MVT layer.
 * @param options - Tile-level tiling option defaults and budgets (overridden
 *   by per-source options), I/O options (cache, prefetch, range merging, scan
 *   budget) and an optional abort `signal`.
 * @returns PBF-encoded Mapbox Vector Tile containing one layer per source.
 *
 * @example
 * ```typescript
 * const pbf = await tile(connector, 12, 2048, 1365, [
 *   { name: 'water', path: '/data/water.fgb' },
 *   { name: 'roads', path: '/data/roads.fgb', options: { tolerance: 1 } },
 * ]);
 * ```
 */
export async function tile(
  connector: Connector,
  z: number,
  x: number,
  y: number,
  sources: Source[],
  options?: TileOptions & IoOptions & RequestOptions,
): Promise<Uint8Array>;

/**
 * Generate a vector tile from a single FlatGeobuf source.
 *
 * Convenience overload that wraps the source in a single-element array
 * and delegates to the multi-source implementation.
 *
 * @param connector - Byte-range reader for accessing FGB files.
 * @param z - Tile zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param source - Single source descriptor; produces one MVT layer.
 * @param options - Tile-level tiling option defaults and budgets (overridden
 *   by per-source options), I/O options (cache, prefetch, range merging, scan
 *   budget) and an optional abort `signal`.
 * @returns PBF-encoded Mapbox Vector Tile containing one layer.
 *
 * @example
 * ```typescript
 * const pbf = await tile(connector, 14, 8192, 5461, {
 *   name: 'buildings',
 *   path: 'https://cdn.example.com/buildings.fgb',
 * });
 * ```
 */
export async function tile(
  connector: Connector,
  z: number,
  x: number,
  y: number,
  source: Source,
  options?: TileOptions & IoOptions & RequestOptions,
): Promise<Uint8Array>;

// Implementation
export async function tile(
  connector: Connector,
  z: number,
  x: number,
  y: number,
  sourceOrSources: Source | Source[],
  options?: TileOptions & IoOptions & RequestOptions,
): Promise<Uint8Array> {
  const sources = Array.isArray(sourceOrSources)
    ? sourceOrSources
    : [sourceOrSources];

  return processTile(
    connector,
    z, x, y,
    sources,
    options,
    createIoContext(options, sharedCache),
    options,
  );
}

/**
 * Compute the ETag of a tile without rendering it (see
 * {@link TileServer.tileETag}), using the same cache as {@link tile}.
 *
 * @param connector - Byte-range reader for accessing FGB files.
 * @param z - Tile zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param sources - The sources (or source) the tile is rendered from.
 * @param options - The tiling and I/O options the tile is rendered with,
 *   and an optional abort `signal`.
 * @returns A strong, quoted ETag, or `null` when a source's connector
 *   reports no version tag.
 */
export function tileETag(
  connector: Connector,
  z: number,
  x: number,
  y: number,
  sources: Source | Source[],
  options?: TileOptions & IoOptions & Pick<RequestOptions, 'signal'>,
): Promise<string | null> {
  const list = Array.isArray(sources) ? sources : [sources];
  return computeTileETag(
    list.map(source => [connector, source]), z, x, y, options, createIoContext(options, sharedCache), options?.signal,
  );
}

/**
 * Forget what the module-level cache of {@link tile} holds: the header
 * and index of one file read through `connector`, or (without arguments)
 * everything.
 *
 * Files with version tags are detected as changed automatically; this is
 * for connectors and servers that report none.
 *
 * @param connector - Connector the file is read through (with `path`).
 * @param path - Source path.
 * @returns Resolves when the entries are removed.
 */
export async function clearTileCache(connector?: Connector, path?: string): Promise<void> {
  if (connector && path !== undefined) {
    await invalidateSource(connector, path, createIoContext(undefined, sharedCache));
    return;
  }
  forgetSources(sharedCache);
  sharedCache.clear();
}

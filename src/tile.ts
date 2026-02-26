/**
 * @module tile
 *
 * Semi-stateless tile generation from FlatGeobuf sources.
 *
 * This is the lowest-ceremony entry point in the fgb-vt API. Every
 * dependency — connector, sources, and options — is provided per call.
 * The **only** state held at module level is a shared
 * {@link globalTileBoundsCache | tile bounds cache}, which stores purely
 * mathematical tile-to-mercator bounding box mappings (no I/O, no source
 * dependency). This makes the function safe to call from stateless
 * request handlers where no persistent context is desired.
 *
 * For use cases that benefit from binding a connector or caching FGB
 * headers across calls, see the {@link TileClient} and {@link TileServer}
 * tiers instead.
 *
 * @example
 * ```typescript
 * import { tile } from 'fgb-vt';
 * import { HttpConnector } from 'fgb-vt/connectors';
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
import { globalTileBoundsCache } from './tiles.js';
import { processTile } from './pipeline.js';

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
 * @param options - Tile-level tiling option defaults (overridden by per-source options).
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
  options?: TileOptions,
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
 * @param options - Tile-level tiling option defaults (overridden by per-source options).
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
  options?: TileOptions,
): Promise<Uint8Array>;

// Implementation
export async function tile(
  connector: Connector,
  z: number,
  x: number,
  y: number,
  sourceOrSources: Source | Source[],
  options?: TileOptions,
): Promise<Uint8Array> {
  const sources = Array.isArray(sourceOrSources)
    ? sourceOrSources
    : [sourceOrSources];

  return processTile(
    connector,
    z, x, y,
    sources,
    options,
    globalTileBoundsCache,
  );
}

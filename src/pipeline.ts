/**
 * @module pipeline
 *
 * Core pipeline wiring for the fgb-vt library.
 *
 * This module orchestrates the end-to-end flow from FlatGeobuf byte-range
 * reading through geometry processing to Mapbox Vector Tile (MVT) encoding.
 * The pipeline stages are:
 *
 * 1. **Open** — read (or take from cache) the FGB header and the top of the
 *    spatial index via an {@link FgbSource}.
 * 2. **Spatial query** — walk the packed Hilbert R-tree level by level,
 *    reading only the index pages the buffered tile box reaches.
 * 3. **Feature read** — issue coalesced byte-range reads through the
 *    Connector for the matching features only.
 * 4. **Decode** — deserialize FlatGeobuf features into {@link RawFeature}
 *    objects with flat coordinate arrays and typed properties.
 * 5. **MVT build** — project WGS84 coordinates to Mercator, clip to tile
 *    bounds, simplify with Douglas-Peucker, and encode as MVT command
 *    geometry with deduplicated key/value tables.
 * 6. **PBF encode** — serialize one or more {@link MvtLayer} objects into a
 *    single Protocol Buffer binary payload.
 *
 * Three entry-point functions cover different use cases:
 *
 * - {@link processSource} — single source, returns one {@link MvtLayer}.
 * - {@link processTile} / {@link processTileLayers} — multiple sources
 *   sharing one Connector, returns PBF bytes or layer array.
 * - {@link processMultiConnectorTile} — multiple
 *   {@link ConnectorSourceGroup}s (distinct connectors), returns PBF bytes.
 *
 * All multi-source variants process sources concurrently via `Promise.all`.
 */

import type { Connector } from './connectors/connector.js';
import type { Source, TileOptions } from './source.js';
import { resolveOptions, DEFAULT_TILE_OPTIONS } from './source.js';
import type { MvtLayer, BBox, RawFeature } from './types.js';
import { getSource, invalidateSource, type IoContext } from './fgb/reader.js';
import { buildMvtLayer } from './mvt/layer.js';
import { encodePbf } from './pbf/encode.js';
import { tileClipBounds, mercatorToWgs84BBox, validateTile } from './tiles.js';
import { LimitExceededError, SourceChangedError, withPath } from './errors.js';

/**
 * Per-request options for tile generation.
 */
export interface RequestOptions {
  /**
   * Aborts the tile: pending reads are cancelled and the call rejects with
   * the signal's reason. Use `AbortSignal.timeout(ms)` for a deadline.
   */
  signal?: AbortSignal;
}

// == Single-source pipeline =================================================

/**
 * Execute the full pipeline for a single source:
 * FGB read -> feature decode -> project -> clip -> simplify -> transform -> MVT layer.
 *
 * If the requested zoom level falls outside the source's configured
 * `[minZoom, maxZoom]` range, an empty layer is returned immediately
 * without issuing any I/O.
 *
 * @param connector - The {@link Connector} used to issue byte-range reads against the FGB file.
 * @param source - Source descriptor specifying the FGB path, layer name, and per-source options.
 * @param z - Tile zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param tileOpts - Fully resolved tiling options (extent, buffer, tolerance, zoom range, budgets).
 * @param context - I/O settings, cache and source registry.
 * @param signal - Optional abort signal.
 * @returns The encoded MVT layer for this source. Returns an empty layer (no features)
 *   when the zoom is out of range or no features intersect the tile.
 * @throws {FgbVtError} On format, I/O or limit errors, annotated with the source path.
 */
export async function processSource(
  connector: Connector,
  source: Source,
  z: number, x: number, y: number,
  tileOpts: Required<TileOptions>,
  context: IoContext,
  signal?: AbortSignal,
): Promise<MvtLayer> {
  // Skip if outside zoom range
  if (z < tileOpts.minZoom || z > tileOpts.maxZoom) {
    return emptyLayer(source.name, tileOpts.extent);
  }

  // Query with the buffered tile box, so features in the buffer zone are read
  const clipBounds = tileClipBounds(z, x, y, tileOpts.buffer, tileOpts.extent);
  const queryBBox = mercatorToWgs84BBox(clipBounds);

  let features: RawFeature[];
  try {
    features = await readSourceFeatures(connector, source.path, queryBBox, context, {
      maxFeatures: tileOpts.maxFeatures,
      maxReadBytes: tileOpts.maxReadBytes,
      signal,
    });
  } catch (err) {
    throw withPath(err, source.path);
  }
  signal?.throwIfAborted();

  if (features.length === 0) {
    return emptyLayer(source.name, tileOpts.extent);
  }

  // Build MVT layer (includes project → clip → simplify → transform → encode)
  return buildMvtLayer(
    features,
    source.name,
    z, x, y,
    clipBounds,
    tileOpts.extent,
    tileOpts.tolerance,
  );
}

/**
 * Read the features of one source intersecting `bbox`. If the file changed
 * since its header was cached, forget the cached state and retry once.
 *
 * @param connector - Connector to read through.
 * @param path - Source path.
 * @param bbox - WGS84 query box.
 * @param context - I/O settings.
 * @param request - Per-tile budgets and abort signal.
 * @returns Decoded features.
 */
async function readSourceFeatures(
  connector: Connector,
  path: string,
  bbox: BBox,
  context: IoContext,
  request: { maxFeatures: number; maxReadBytes: number; signal?: AbortSignal },
): Promise<RawFeature[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const fgb = await getSource(connector, path, context, request.signal);
      return await fgb.readFeatures(bbox, {
        coalesceGap: context.coalesceGap,
        maxScanBytes: context.maxScanBytes,
        maxFeatureBytes: context.maxFeatureBytes,
        ...request,
      });
    } catch (err) {
      if (err instanceof SourceChangedError && attempt === 0) {
        await invalidateSource(connector, path, context);
        continue;
      }
      throw err;
    }
  }
}

// == Multi-source pipeline ==================================================

/**
 * Execute the full pipeline for multiple sources sharing a single
 * {@link Connector}, producing a PBF-encoded binary tile.
 *
 * All sources are processed concurrently. The resulting layers are
 * serialized into a single Protocol Buffer payload ordered by the
 * input `sources` array.
 *
 * @param connector - Shared connector for all sources.
 * @param z - Tile zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param sources - Array of source descriptors to include in the tile.
 * @param tileOptions - Tile-level option defaults applied to sources
 *   that do not specify their own overrides.
 * @param context - I/O settings, cache and source registry.
 * @param signal - Optional abort signal.
 * @returns PBF-encoded binary tile containing one layer per source.
 * @throws {RangeError} If `z/x/y` is not a valid tile.
 * @throws {LimitExceededError} If the tile exceeds `maxTileBytes` or a source a budget.
 */
export async function processTile(
  connector: Connector,
  z: number, x: number, y: number,
  sources: Source[],
  tileOptions: TileOptions | undefined,
  context: IoContext,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const layers = await processTileLayers(connector, z, x, y, sources, tileOptions, context, signal);
  return encodeChecked(layers, z, x, y, tileOptions);
}

/**
 * Process multiple sources into MVT layers without PBF encoding.
 *
 * Useful when callers need to inspect or post-process individual layers
 * before final serialization. All sources are processed concurrently.
 *
 * @param connector - Shared connector for all sources.
 * @param z - Tile zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param sources - Array of source descriptors to include in the tile.
 * @param tileOptions - Tile-level option defaults applied to sources
 *   that do not specify their own overrides.
 * @param context - I/O settings, cache and source registry.
 * @param signal - Optional abort signal.
 * @returns Array of MVT layers in source-array order; empty layers are
 *   included for sources that produce no features.
 * @throws {RangeError} If `z/x/y` is not a valid tile.
 */
export async function processTileLayers(
  connector: Connector,
  z: number, x: number, y: number,
  sources: Source[],
  tileOptions: TileOptions | undefined,
  context: IoContext,
  signal?: AbortSignal,
): Promise<MvtLayer[]> {
  validateTile(z, x, y);
  signal?.throwIfAborted();
  return Promise.all(sources.map(source =>
    processSource(connector, source, z, x, y, resolveOptions(source.options, tileOptions), context, signal),
  ));
}

// == Multi-connector pipeline ===============================================

/**
 * A pairing of a {@link Connector} with the {@link Source} descriptors it
 * should serve.
 *
 * Used by {@link processMultiConnectorTile} to fan out tile requests across
 * heterogeneous storage backends (e.g. local files and S3 objects in the
 * same tile).
 */
export interface ConnectorSourceGroup {
  /** The connector responsible for reading byte ranges from the sources' FGB files. */
  connector: Connector;
  /** One or more source descriptors whose paths are resolvable by the connector. */
  sources: Source[];
}

/**
 * Process multiple {@link ConnectorSourceGroup}s into a single PBF-encoded
 * binary tile.
 *
 * Sources across all groups are flattened in order — group-0 sources appear
 * first, followed by group-1, and so on. All sources across all groups are
 * processed concurrently via `Promise.all`.
 *
 * @param groups - Array of connector-source pairings.
 * @param z - Tile zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param tileOptions - Tile-level option defaults applied to sources
 *   that do not specify their own overrides.
 * @param context - I/O settings, cache and source registry.
 * @param signal - Optional abort signal.
 * @returns PBF-encoded binary tile containing one layer per source, ordered
 *   by group then by source within each group.
 * @throws {RangeError} If `z/x/y` is not a valid tile.
 * @throws {LimitExceededError} If the tile exceeds `maxTileBytes` or a source a budget.
 */
export async function processMultiConnectorTile(
  groups: ConnectorSourceGroup[],
  z: number, x: number, y: number,
  tileOptions: TileOptions | undefined,
  context: IoContext,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  validateTile(z, x, y);
  signal?.throwIfAborted();

  const allLayerPromises: Promise<MvtLayer>[] = [];
  for (const group of groups) {
    for (const source of group.sources) {
      allLayerPromises.push(
        processSource(group.connector, source, z, x, y, resolveOptions(source.options, tileOptions), context, signal),
      );
    }
  }

  const layers = await Promise.all(allLayerPromises);
  return encodeChecked(layers, z, x, y, tileOptions);
}

// == Helpers ================================================================

/**
 * Encode layers into a PBF tile and enforce `maxTileBytes`.
 *
 * @param layers - Layers to encode.
 * @param z - Tile zoom level (for the error message).
 * @param x - Tile column.
 * @param y - Tile row.
 * @param tileOptions - Tile-level options carrying `maxTileBytes`.
 * @returns The encoded tile.
 * @throws {LimitExceededError} If the tile is larger than `maxTileBytes`.
 */
function encodeChecked(
  layers: MvtLayer[],
  z: number, x: number, y: number,
  tileOptions: TileOptions | undefined,
): Uint8Array {
  const pbf = encodePbf(layers);
  const max = tileOptions?.maxTileBytes ?? DEFAULT_TILE_OPTIONS.maxTileBytes;
  if (pbf.length > max) {
    throw new LimitExceededError(
      `Tile ${z}/${x}/${y} encodes to ${pbf.length} bytes, more than maxTileBytes (${max})`,
      { limit: 'tileBytes', max, actual: pbf.length },
    );
  }
  return pbf;
}

/**
 * Create an empty MVT layer with no features, keys, or values.
 *
 * @param name - Layer name.
 * @param extent - Tile coordinate extent.
 * @returns An {@link MvtLayer} with empty arrays for features, keys, and values.
 */
function emptyLayer(name: string, extent: number): MvtLayer {
  return { name, extent, features: [], keys: [], values: [] };
}

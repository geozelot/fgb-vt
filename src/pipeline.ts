/**
 * @module pipeline
 *
 * Core pipeline wiring for the fgb-vt library.
 *
 * This module orchestrates the end-to-end flow from FlatGeobuf byte-range
 * reading through geometry processing to Mapbox Vector Tile (MVT) encoding.
 * The pipeline stages are:
 *
 * 1. **Header read** — parse the FGB header and spatial index via a
 *    {@link Connector}, optionally caching the result in {@link FgbCache}.
 * 2. **Spatial query** — query the packed Hilbert R-tree index to determine
 *    which features intersect the requested tile bounding box.
 * 3. **Feature read** — issue byte-range reads through the Connector to
 *    fetch only the matching feature data.
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
import { resolveOptions } from './source.js';
import type { FgbHeader, MvtLayer, BBox, RawFeature } from './types.js';
import { parseHeader, headerByteSize, INITIAL_HEADER_READ_SIZE } from './fgb/header.js';
import { queryIndex } from './fgb/index.js';
import { decodeFeatures } from './fgb/feature.js';
import { buildMvtLayer } from './mvt/layer.js';
import { encodePbf } from './pbf/encode.js';
import { TileBoundsCache } from './tiles.js';

/**
 * Cached FGB metadata for a single source path.
 *
 * Stores the parsed header and raw spatial index bytes so that repeated
 * tile requests against the same FGB file can skip the two initial read
 * operations required by {@link readHeader}. Typically populated once at
 * startup and shared across all subsequent tile requests.
 */
export interface FgbCache {
  /** Parsed FlatGeobuf file header containing schema, offsets, and feature count. */
  header: FgbHeader;
  /** Raw bytes of the packed Hilbert R-tree spatial index. */
  indexBytes: Uint8Array;
}

// ─── Single-source pipeline ─────────────────────────────────────────────────

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
 * @param wgs84BBox - WGS84 bounding box of the tile, used for the spatial index query.
 * @param clipBounds - Mercator clip bounds (with buffer) for geometry clipping.
 * @param tileOpts - Fully resolved tiling options (extent, buffer, tolerance, zoom range).
 * @param cache - Optional pre-cached header and spatial index bytes; when provided,
 *   the two header-read I/O operations are skipped entirely.
 * @returns The encoded MVT layer for this source. Returns an empty layer (no features)
 *   when the zoom is out of range, the file has no spatial index, or no features
 *   intersect the tile.
 */
export async function processSource(
  connector: Connector,
  source: Source,
  z: number, x: number, y: number,
  wgs84BBox: BBox,
  clipBounds: BBox,
  tileOpts: Required<TileOptions>,
  cache?: FgbCache,
): Promise<MvtLayer> {
  // Skip if outside zoom range
  if (z < tileOpts.minZoom || z > tileOpts.maxZoom) {
    return emptyLayer(source.name, tileOpts.extent);
  }

  // Get header (from cache or by reading)
  let header: FgbHeader;
  let indexBytes: Uint8Array;

  if (cache) {
    header = cache.header;
    indexBytes = cache.indexBytes;
  } else {
    const hdr = await readHeader(connector, source.path);
    header = hdr.header;
    indexBytes = hdr.indexBytes;
  }

  // Query spatial index to find matching feature byte ranges
  if (header.indexNodeSize === 0 || header.featuresCount === 0) {
    return emptyLayer(source.name, tileOpts.extent);
  }

  const ranges = queryIndex(
    indexBytes,
    header.featuresCount,
    header.indexNodeSize,
    header.featuresOffset,
    wgs84BBox,
  );

  if (ranges.length === 0) {
    return emptyLayer(source.name, tileOpts.extent);
  }

  // Read feature data
  const featureChunks = await connector.readRanges(source.path, ranges);

  // Decode features from all chunks
  const allFeatures: RawFeature[] = [];
  for (const chunk of featureChunks) {
    const features = decodeFeatures(chunk, header);
    for (let i = 0; i < features.length; i++) {
      allFeatures.push(features[i]);
    }
  }

  if (allFeatures.length === 0) {
    return emptyLayer(source.name, tileOpts.extent);
  }

  // Build MVT layer (includes project → clip → simplify → transform → encode)
  return buildMvtLayer(
    allFeatures,
    source.name,
    z, x, y,
    clipBounds,
    tileOpts.extent,
    tileOpts.tolerance,
  );
}

// ─── Multi-source pipeline ──────────────────────────────────────────────────

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
 * @param boundsCache - Cached tile-coordinate-to-bounds lookup.
 * @param fgbCaches - Optional map of FGB path to pre-cached header/index data.
 * @returns PBF-encoded binary tile containing one layer per source.
 */
export async function processTile(
  connector: Connector,
  z: number, x: number, y: number,
  sources: Source[],
  tileOptions: TileOptions | undefined,
  boundsCache: TileBoundsCache,
  fgbCaches?: Map<string, FgbCache>,
): Promise<Uint8Array> {
  const layers = await processTileLayers(
    connector, z, x, y, sources, tileOptions, boundsCache, fgbCaches,
  );
  return encodePbf(layers);
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
 * @param boundsCache - Cached tile-coordinate-to-bounds lookup.
 * @param fgbCaches - Optional map of FGB path to pre-cached header/index data.
 * @returns Array of MVT layers in source-array order; empty layers are
 *   included for sources that produce no features.
 */
export async function processTileLayers(
  connector: Connector,
  z: number, x: number, y: number,
  sources: Source[],
  tileOptions: TileOptions | undefined,
  boundsCache: TileBoundsCache,
  fgbCaches?: Map<string, FgbCache>,
): Promise<MvtLayer[]> {
  // Compute tile bounds (cached)
  const wgs84BBox = boundsCache.getWgs84(z, x, y);

  // Process all sources concurrently
  const layerPromises = sources.map(source => {
    const opts = resolveOptions(source.options, tileOptions);
    const clipBounds = boundsCache.getClip(z, x, y, opts.buffer, opts.extent);
    const cache = fgbCaches?.get(source.path);

    return processSource(
      connector, source, z, x, y,
      wgs84BBox, clipBounds, opts, cache,
    );
  });

  return Promise.all(layerPromises);
}

// ─── Multi-connector pipeline ───────────────────────────────────────────────

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
 * @param boundsCache - Cached tile-coordinate-to-bounds lookup.
 * @param fgbCaches - Optional map of FGB path to pre-cached header/index data.
 * @returns PBF-encoded binary tile containing one layer per source, ordered
 *   by group then by source within each group.
 */
export async function processMultiConnectorTile(
  groups: ConnectorSourceGroup[],
  z: number, x: number, y: number,
  tileOptions: TileOptions | undefined,
  boundsCache: TileBoundsCache,
  fgbCaches?: Map<string, FgbCache>,
): Promise<Uint8Array> {
  const wgs84BBox = boundsCache.getWgs84(z, x, y);

  const allLayerPromises: Promise<MvtLayer>[] = [];

  for (const group of groups) {
    for (const source of group.sources) {
      const opts = resolveOptions(source.options, tileOptions);
      const clipBounds = boundsCache.getClip(z, x, y, opts.buffer, opts.extent);
      const cache = fgbCaches?.get(source.path);

      allLayerPromises.push(
        processSource(
          group.connector, source, z, x, y,
          wgs84BBox, clipBounds, opts, cache,
        ),
      );
    }
  }

  const layers = await Promise.all(allLayerPromises);
  return encodePbf(layers);
}

// ─── Header reading ─────────────────────────────────────────────────────────

/**
 * Read and parse an FGB header and spatial index from a {@link Connector}.
 *
 * This performs up to three byte-range reads:
 *
 * 1. An initial read of {@link INITIAL_HEADER_READ_SIZE} bytes to determine
 *    the full header size.
 * 2. If the initial read was too small, a second read for the complete
 *    header bytes.
 * 3. A read for the packed Hilbert R-tree spatial index (skipped when
 *    `indexSize` is zero).
 *
 * The returned object is suitable for caching in {@link FgbCache} to
 * eliminate these reads on subsequent tile requests.
 *
 * @param connector - The connector to read bytes from.
 * @param path - Connector-specific path to the FGB file.
 * @returns Parsed header metadata and raw spatial index bytes.
 * @throws {Error} If the file does not contain a valid FlatGeobuf header
 *   (propagated from the header parser).
 */
export async function readHeader(
  connector: Connector,
  path: string,
): Promise<{ header: FgbHeader; indexBytes: Uint8Array }> {
  // First read: get enough to parse header size
  const initialBytes = await connector.read(path, 0, INITIAL_HEADER_READ_SIZE);
  const hdrSize = headerByteSize(initialBytes);

  // Read full header if needed
  let headerBytes: Uint8Array;
  if (hdrSize <= initialBytes.length) {
    headerBytes = initialBytes.subarray(0, hdrSize);
  } else {
    headerBytes = await connector.read(path, 0, hdrSize);
  }

  const header = parseHeader(headerBytes);

  // Read spatial index
  let indexBytes: Uint8Array;
  if (header.indexSize > 0) {
    indexBytes = await connector.read(path, header.indexOffset, header.indexSize);
  } else {
    indexBytes = new Uint8Array(0);
  }

  return { header, indexBytes };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

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
 * 2. **Spatial query** — convert the buffered tile box to the source CRS and
 *    walk the packed Hilbert R-tree level by level, reading only the index
 *    pages it reaches.
 * 3. **Feature read** — issue coalesced byte-range reads through the
 *    Connector for the matching features only.
 * 4. **Decode** — deserialize FlatGeobuf features into {@link RawFeature}
 *    objects with flat coordinate arrays and typed properties.
 * 5. **MVT build** — project source coordinates to Mercator, clip to tile
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
import { getSource, invalidateSource, type FgbSource, type IoContext } from './fgb/reader.js';
import { buildMvtLayer, mergeLayers } from './mvt/layer.js';
import { encodePbf } from './pbf/encode.js';
import { tileClipBounds, validateTile } from './tiles.js';
import { resolveFrame, type CoordinateFrame } from './geometry/crs.js';
import { featureSchema, validateSchema } from './schema.js';
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
  /**
   * Called after a tile has been encoded, with per-source read and feature
   * counts and timings (e.g. for metrics or logs). Not called for failed
   * tiles. Errors thrown by the hook are ignored.
   */
  onTile?: (stats: TileStats) => void;
}

/**
 * Statistics of one generated tile, passed to {@link RequestOptions.onTile}.
 */
export interface TileStats {
  /** Tile zoom level. */
  z: number;
  /** Tile column. */
  x: number;
  /** Tile row. */
  y: number;
  /** Size of the encoded tile in bytes. */
  tileBytes: number;
  /** Wall-clock time to generate the tile, in milliseconds. */
  durationMs: number;
  /** One entry per source, in layer order. */
  sources: SourceStats[];
}

/**
 * Statistics of one source within a tile.
 */
export interface SourceStats {
  /** Layer name. */
  name: string;
  /** Source path. */
  path: string;
  /** `'zoom'` if the source was skipped because the zoom is outside its range. */
  skipped?: 'zoom';
  /** Features read from the file and decoded. */
  featuresRead: number;
  /** Features written to the layer (after clipping and simplification). */
  featuresEncoded: number;
  /**
   * Range requests issued for this tile (index pages and features). Header
   * reads when a source is opened, cached index pages and reads shared with
   * a concurrent tile are not counted.
   */
  requests: number;
  /** Bytes received for index pages. */
  indexBytes: number;
  /** Bytes received for feature data. */
  featureBytes: number;
  /** Time until this source's layer was built, in milliseconds. */
  durationMs: number;
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
 * @param stats - Receives read and feature counts, when given.
 * @returns The encoded MVT layer for this source. Returns an empty layer (no features)
 *   when the zoom is out of range or no features intersect the tile.
 * @throws {FgbVtError} On format, I/O or limit errors, annotated with the source path.
 * @throws {RangeError} If the source's `idColumn` is not an integer column of the file.
 */
export async function processSource(
  connector: Connector,
  source: Source,
  z: number, x: number, y: number,
  tileOpts: Required<TileOptions>,
  context: IoContext,
  signal?: AbortSignal,
  stats?: SourceStats,
): Promise<MvtLayer> {
  // Skip if outside zoom range
  if (z < tileOpts.minZoom || z > tileOpts.maxZoom) {
    if (stats) stats.skipped = 'zoom';
    return emptyLayer(source.name, tileOpts.extent);
  }

  // Query with the buffered tile box, so features in the buffer zone are read
  const clipBounds = tileClipBounds(z, x, y, tileOpts.buffer, tileOpts.extent);

  let features: RawFeature[];
  try {
    features = await readSourceFeatures(connector, source, clipBounds, tileOpts, context, signal, stats);
  } catch (err) {
    throw withPath(err, source.path);
  }
  signal?.throwIfAborted();
  if (stats) stats.featuresRead = features.length;

  if (features.length === 0) {
    return emptyLayer(source.name, tileOpts.extent);
  }

  // Build MVT layer (clip → simplify → transform → encode; already in mercator)
  const layer = buildMvtLayer(
    features,
    source.name,
    z, x, y,
    clipBounds,
    tileOpts.extent,
    tileOpts.tolerance,
    inMercator,
    { simplifyBeforeClip: tileOpts.simplifyBeforeClip, pointGrid: tileOpts.pointGrid },
  );
  if (stats) stats.featuresEncoded = layer.features.length;
  return layer;
}

/**
 * Read the features of one source reaching a tile's clip box, converted to
 * mercator [0, 1] space. If the file changed since its header was cached,
 * forget the cached state and retry once.
 *
 * At the antimeridian, features from the other side of the world that
 * reach into the tile's buffer (or data stored with longitudes beyond
 * ±180°) are added as world copies, shifted by ±1 in mercator x.
 *
 * @param connector - Connector to read through.
 * @param source - Source descriptor (path, CRS and schema settings).
 * @param clipBounds - Buffered tile box in mercator [0, 1] space.
 * @param tileOpts - Resolved options (extent, buffer and budgets).
 * @param context - I/O settings.
 * @param signal - Optional abort signal.
 * @param stats - Receives read counts, when given.
 * @returns Features in mercator space.
 * @throws {UnsupportedFormatError} If the source CRS is not supported.
 * @throws {RangeError} If the source's `idColumn` does not fit the file.
 */
async function readSourceFeatures(
  connector: Connector,
  source: Source,
  clipBounds: BBox,
  tileOpts: Required<TileOptions>,
  context: IoContext,
  signal: AbortSignal | undefined,
  stats: SourceStats | undefined,
): Promise<RawFeature[]> {
  const schema = featureSchema(source);
  for (let attempt = 0; ; attempt++) {
    try {
      const fgb = await getSource(connector, source.path, context, signal);
      const frame = resolveFrame(fgb.header.crs, source.crs, source.path);
      validateSchema(schema, fgb.header, source.path);

      const read = (clip: BBox) => {
        const query = frame.queryBBox(clip);
        return fgb.readFeatures(query, {
          coalesceGap: context.coalesceGap,
          maxScanBytes: context.maxScanBytes,
          maxFeatureBytes: context.maxFeatureBytes,
          maxFeatures: tileOpts.maxFeatures,
          maxReadBytes: tileOpts.maxReadBytes,
          curveTolerance: unitsPerTileUnit(query, tileOpts) * CURVE_TOLERANCE,
          schema,
          stats,
          useIndex: source.useIndex,
          signal,
        });
      };

      const features = await read(clipBounds);
      for (const f of features) frame.toMercator(f.xy);
      const shifts = frame.mercatorX ? await worldShifts(fgb, frame, clipBounds, signal) : [];
      if (shifts.length === 0) return features;

      const out = [...features];
      if (!fgb.hasIndex || source.useIndex === false) {
        // A scan already returned every feature: copy those reaching the tile
        for (const shift of shifts) {
          for (const f of features) {
            if (reachesX(f.xy, shift, clipBounds)) out.push(shifted(f, f.xy.slice(), shift));
          }
        }
        return out;
      }
      for (const shift of shifts) {
        const copies = await read({ ...clipBounds, minX: clipBounds.minX - shift, maxX: clipBounds.maxX - shift });
        for (const f of copies) {
          frame.toMercator(f.xy);
          out.push(shifted(f, f.xy, shift));
        }
      }
      return out;
    } catch (err) {
      if (err instanceof SourceChangedError && attempt === 0) {
        await invalidateSource(connector, source.path, context);
        continue;
      }
      throw err;
    }
  }
}

/**
 * World offsets (in mercator x) whose copies of the data reach the clip
 * box: `-1` brings data east of the antimeridian (x ≥ 1 − buffer) into a
 * tile at the west edge, `+1` data west of it into a tile at the east edge.
 *
 * @param fgb - Opened source.
 * @param frame - Its coordinate frame (with `mercatorX`).
 * @param clip - Buffered tile box in mercator space.
 * @param signal - Optional abort signal for reading the data extent.
 * @returns Offsets other than 0 to query; empty when none applies.
 */
async function worldShifts(
  fgb: FgbSource,
  frame: CoordinateFrame,
  clip: BBox,
  signal: AbortSignal | undefined,
): Promise<number[]> {
  // Only tiles near the world edge, or data beyond ±180°, need copies
  if (clip.minX > 0 && clip.maxX < 1 && fgb.header.bbox &&
      frame.mercatorX!(fgb.header.bbox.minX) >= 0 && frame.mercatorX!(fgb.header.bbox.maxX) <= 1) {
    return [];
  }
  const bounds = await fgb.bounds(signal);
  const dataMin = bounds ? frame.mercatorX!(bounds.minX) : 0;
  const dataMax = bounds ? frame.mercatorX!(bounds.maxX) : 1;
  const shifts: number[] = [];
  for (const shift of [-1, 1]) {
    // Copies shifted by `shift` come from data at [clip.minX - shift, clip.maxX - shift]
    if (clip.minX - shift <= dataMax && clip.maxX - shift >= dataMin) shifts.push(shift);
  }
  return shifts;
}

/** Whether a feature moved by `shift` overlaps the clip box horizontally. */
function reachesX(xy: Float64Array, shift: number, clip: BBox): boolean {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < xy.length; i += 2) {
    if (xy[i] < min) min = xy[i];
    if (xy[i] > max) max = xy[i];
  }
  return min + shift <= clip.maxX && max + shift >= clip.minX;
}

/** A copy of `feature` with coordinates `xy` moved by `shift` in x (in place). */
function shifted(feature: RawFeature, xy: Float64Array, shift: number): RawFeature {
  for (let i = 0; i < xy.length; i += 2) xy[i] += shift;
  return { ...feature, xy };
}

/**
 * Largest deviation of linearised arcs from the true curve, in tile
 * coordinate units: below what an MVT can represent.
 */
const CURVE_TOLERANCE = 1;

/**
 * Size of one tile coordinate unit in source coordinate units, from the
 * query box covering the buffered tile.
 *
 * @param query - Query box in source coordinates.
 * @param tileOpts - Extent and buffer the box was derived from.
 * @returns Source units per tile unit (the smaller of both axes; an axis
 *   that is open-ended at the poles is ignored).
 */
function unitsPerTileUnit(query: BBox, tileOpts: Required<TileOptions>): number {
  const span = tileOpts.extent + 2 * tileOpts.buffer;
  const sx = (query.maxX - query.minX) / span;
  const sy = (query.maxY - query.minY) / span;
  return Math.min(Number.isFinite(sx) ? sx : Infinity, Number.isFinite(sy) ? sy : Infinity);
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
 * @param request - Optional abort signal and statistics hook.
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
  request?: RequestOptions,
): Promise<Uint8Array> {
  return renderTile(sources.map(source => [connector, source]), z, x, y, tileOptions, context, request);
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
 * @param request - Optional abort signal and statistics hook.
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
  request?: RequestOptions,
): Promise<Uint8Array> {
  const entries: Array<[Connector, Source]> = [];
  for (const group of groups) {
    for (const source of group.sources) entries.push([group.connector, source]);
  }
  return renderTile(entries, z, x, y, tileOptions, context, request);
}

// == Helpers ================================================================

/**
 * Render and encode a tile from sources with their connectors, enforcing
 * `maxTileBytes` and reporting statistics to `request.onTile`.
 *
 * @param entries - Connector and source per layer, in layer order.
 * @param z - Tile zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param tileOptions - Tile-level options.
 * @param context - I/O settings, cache and source registry.
 * @param request - Optional abort signal and statistics hook.
 * @returns The encoded tile.
 */
async function renderTile(
  entries: Array<[Connector, Source]>,
  z: number, x: number, y: number,
  tileOptions: TileOptions | undefined,
  context: IoContext,
  request: RequestOptions | undefined,
): Promise<Uint8Array> {
  validateTile(z, x, y);
  const signal = request?.signal;
  signal?.throwIfAborted();

  const onTile = request?.onTile;
  const started = onTile ? now() : 0;
  const stats: SourceStats[] | undefined = onTile
    ? entries.map(([, source]) => ({
      name: source.name, path: source.path,
      featuresRead: 0, featuresEncoded: 0, requests: 0, indexBytes: 0, featureBytes: 0, durationMs: 0,
    }))
    : undefined;

  const layers = await Promise.all(entries.map(async ([connector, source], i) => {
    const layer = await processSource(
      connector, source, z, x, y, resolveOptions(source.options, tileOptions), context, signal, stats?.[i],
    );
    if (stats) stats[i].durationMs = now() - started;
    return layer;
  }));

  const pbf = encodeChecked(layers, z, x, y, tileOptions);
  if (onTile && stats) {
    try {
      onTile({ z, x, y, tileBytes: pbf.length, durationMs: now() - started, sources: stats });
    } catch {
      // Observability must not break tile serving
    }
  }
  return pbf;
}

/** Coordinate conversion for features already in mercator space. */
function inMercator(): void {}

/** Monotonic clock in milliseconds. */
function now(): number {
  return performance.now();
}

/**
 * Encode layers into a PBF tile, merging layers of sources that share a
 * name, leaving out empty layers when `omitEmptyLayers` is set, and
 * enforce `maxTileBytes`.
 *
 * @param layers - Layers to encode.
 * @param z - Tile zoom level (for the error message).
 * @param x - Tile column.
 * @param y - Tile row.
 * @param tileOptions - Tile-level options carrying `maxTileBytes` and
 *   `omitEmptyLayers`.
 * @returns The encoded tile (zero bytes when every layer was left out).
 * @throws {LimitExceededError} If the tile is larger than `maxTileBytes`.
 * @throws {RangeError} If sources sharing a name use different extents.
 */
function encodeChecked(
  layers: MvtLayer[],
  z: number, x: number, y: number,
  tileOptions: TileOptions | undefined,
): Uint8Array {
  const omitEmpty = tileOptions?.omitEmptyLayers ?? DEFAULT_TILE_OPTIONS.omitEmptyLayers;
  const merged = mergeLayers(layers);
  const pbf = encodePbf(omitEmpty ? merged.filter(l => l.features.length > 0) : merged);
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

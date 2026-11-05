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
 *    objects with flat coordinate arrays and typed properties, one read at
 *    a time.
 * 5. **MVT build** — project source coordinates to Mercator, clip to tile
 *    bounds, simplify with Douglas-Peucker, and encode as MVT command
 *    geometry with deduplicated key/value tables. Each decoded read is
 *    encoded before the next, so its features can be released.
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
 * All multi-source variants process sources concurrently; when one source
 * fails, the reads of the others are cancelled.
 */

import type { Connector } from './connectors/connector.js';
import type { FilterFeature, Source, TileOptions } from './source.js';
import { resolveOptions, validateSource } from './source.js';
import type { MvtLayer, BBox, RawFeature, PropertyValue } from './types.js';
import { GeomType } from './types.js';
import { getSource, invalidateSource, type FgbSource, type IoContext, type QueryOptions } from './fgb/reader.js';
import { LayerBuilder, buildMvtLayer, mergeLayers } from './mvt/layer.js';
import { encodePbf } from './pbf/encode.js';
import { tileClipBounds, validateTile } from './tiles.js';
import { resolveFrame, type CoordinateFrame } from './geometry/crs.js';
import { featureSchema, validateSchema, type FeatureSchema } from './schema.js';
import { FormatError, LimitExceededError, SourceChangedError, withPath } from './errors.js';

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
  /**
   * Coarsening steps taken to fit `maxTileBytes` (see
   * {@link TileOptions.reduceToFit}); `0` when the tile fit at once.
   */
  reduced: number;
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
  /** Features written to the layer (after filtering, clipping and simplification). */
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
  return (await renderSource(connector, source, z, x, y, tileOpts, context, signal, stats, false)).layer;
}

/** A rendered source layer, with its features when kept for re-rendering. */
interface RenderedSource {
  layer: MvtLayer;
  /** Features in mercator space (after filtering), or `null` when not kept. */
  features: RawFeature[] | null;
  clipBounds: BBox | null;
}

/**
 * Render one source into a layer, encoding each decoded read as it
 * arrives.
 *
 * @param keepFeatures - Keep the decoded features (in mercator space) for
 *   re-rendering with other settings.
 */
async function renderSource(
  connector: Connector,
  source: Source,
  z: number, x: number, y: number,
  tileOpts: Required<TileOptions>,
  context: IoContext,
  signal: AbortSignal | undefined,
  stats: SourceStats | undefined,
  keepFeatures: boolean,
): Promise<RenderedSource> {
  // Skip if outside zoom range
  if (z < tileOpts.minZoom || z > tileOpts.maxZoom) {
    if (stats) stats.skipped = 'zoom';
    return { layer: emptyLayer(source.name, tileOpts.extent), features: null, clipBounds: null };
  }

  // Query with the buffered tile box, so features in the buffer zone are read
  const clipBounds = tileClipBounds(z, x, y, tileOpts.buffer, tileOpts.extent);
  const filter = source.filter ? featureFilter(source, z) : null;

  try {
    return await withSource(connector, source, context, signal, async (fgb) => {
      const builder = new LayerBuilder(
        source.name, z, x, y, clipBounds, tileOpts.extent, tileOpts.tolerance, inMercator,
        { simplifyBeforeClip: tileOpts.simplifyBeforeClip, pointGrid: tileOpts.pointGrid },
      );
      const kept: RawFeature[] | null = keepFeatures ? [] : null;
      let read = 0;
      await readSourceFeatures(fgb, source, clipBounds, tileOpts, context, signal, stats, (features) => {
        read += features.length;
        const accepted = filter ? filter(features) : features;
        if (kept) for (const f of accepted) kept.push(f);
        builder.add(accepted);
      });
      signal?.throwIfAborted();
      if (stats) {
        stats.featuresRead = read;
        stats.featuresEncoded = builder.size;
      }
      return { layer: builder.finish(), features: kept, clipBounds };
    });
  } catch (err) {
    throw withPath(err, source.path);
  }
}

/**
 * Run `fn` with the opened source. If the file changed since its header
 * was cached, forget the cached state and run `fn` once more on the
 * reopened file.
 *
 * A change shows as {@link SourceChangedError} when the connector reports
 * version tags. Without tags it can only show as data that does not match
 * the cached header and index (a {@link FormatError}), so for such sources
 * a format error from cached state is also retried once on a fresh open.
 *
 * @param connector - Connector the source is read through.
 * @param source - Source descriptor.
 * @param context - I/O settings, cache and source registry.
 * @param signal - Optional abort signal.
 * @param fn - Work on the opened source; may run twice, so it must not
 *   leave partial results behind when it throws.
 * @returns `fn`'s result.
 */
export async function withSource<T>(
  connector: Connector,
  source: Source,
  context: IoContext,
  signal: AbortSignal | undefined,
  fn: (fgb: FgbSource) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let fgb: FgbSource | null = null;
    try {
      fgb = await getSource(connector, source.path, context, signal);
      return await fn(fgb);
    } catch (err) {
      const cached = context.registry !== null || context.cache !== null;
      const stale = err instanceof SourceChangedError ||
        (err instanceof FormatError && fgb !== null && fgb.etag === null && cached);
      if (attempt === 0 && stale && !signal?.aborted) {
        await invalidateSource(connector, source.path, context);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Read the features of one source reaching a tile's clip box, converted to
 * mercator [0, 1] space, handing them to `sink` one decoded read at a time.
 *
 * At the antimeridian, features from the other side of the world that
 * reach into the tile's buffer (or data stored with longitudes beyond
 * ±180°) are added as world copies, shifted by ±1 in mercator x.
 *
 * @param fgb - Opened source.
 * @param source - Source descriptor (path, CRS and schema settings).
 * @param clipBounds - Buffered tile box in mercator [0, 1] space.
 * @param tileOpts - Resolved options (extent, buffer and budgets).
 * @param context - I/O settings.
 * @param signal - Optional abort signal.
 * @param stats - Receives read counts, when given.
 * @param sink - Receives the features in mercator space.
 * @throws {UnsupportedFormatError} If the source CRS is not supported.
 * @throws {RangeError} If the source's `idColumn` does not fit the file.
 */
async function readSourceFeatures(
  fgb: FgbSource,
  source: Source,
  clipBounds: BBox,
  tileOpts: Required<TileOptions>,
  context: IoContext,
  signal: AbortSignal | undefined,
  stats: SourceStats | undefined,
  sink: (features: RawFeature[]) => void,
): Promise<void> {
  const frame = resolveFrame(fgb.header.crs, source.crs, source.path);
  const schema = featureSchema(source);
  validateSchema(schema, fgb.header, source.path);
  // A filter sees every property; the selection is applied after it
  const decodeSchema = source.filter ? filterSchema(schema) : schema;

  const query = (clip: BBox): [BBox, QueryOptions] => {
    const bbox = frame.queryBBox(clip);
    return [bbox, {
      coalesceGap: context.coalesceGap,
      maxScanBytes: context.maxScanBytes,
      maxFeatureBytes: context.maxFeatureBytes,
      maxFeatures: tileOpts.maxFeatures,
      maxReadBytes: tileOpts.maxReadBytes,
      curveTolerance: unitsPerTileUnit(bbox, tileOpts) * CURVE_TOLERANCE,
      schema: decodeSchema,
      stats,
      useIndex: source.useIndex,
      signal,
    }];
  };

  const shifts = frame.mercatorX ? await worldShifts(fgb, frame, clipBounds, signal) : [];
  // A scan returns every feature: world copies are made from those
  const scanned = shifts.length > 0 && (!fgb.hasIndex || source.useIndex === false) ? [] as RawFeature[] : null;

  await fgb.forEachFeatures(...query(clipBounds), (features) => {
    for (const f of features) frame.toMercator(f.xy);
    if (scanned) for (const f of features) scanned.push(f);
    sink(features);
  });

  for (const shift of shifts) {
    if (scanned) {
      const copies: RawFeature[] = [];
      for (const f of scanned) {
        if (reachesX(f.xy, shift, clipBounds)) copies.push(shifted(f, f.xy.slice(), shift));
      }
      if (copies.length > 0) sink(copies);
      continue;
    }
    await fgb.forEachFeatures(
      ...query({ ...clipBounds, minX: clipBounds.minX - shift, maxX: clipBounds.maxX - shift }),
      (copies) => {
        for (const f of copies) frame.toMercator(f.xy);
        sink(copies.map(f => shifted(f, f.xy, shift)));
      },
    );
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

// == Feature filter =========================================================

/** Decode schemas for filtered sources: every property, the same id handling. */
const filterSchemas = new WeakMap<FeatureSchema, FeatureSchema>();

function filterSchema(schema: FeatureSchema): FeatureSchema {
  let decode = filterSchemas.get(schema);
  if (!decode) {
    decode = { ...schema, keep: null };
    filterSchemas.set(schema, decode);
  }
  return decode;
}

/** Geometry family of a decoded feature, as written to the tile. */
function geometryFamily(type: GeomType): FilterFeature['type'] {
  if (type === GeomType.Point || type === GeomType.MultiPoint) return 'Point';
  if (type === GeomType.LineString || type === GeomType.MultiLineString) return 'LineString';
  return 'Polygon';
}

/**
 * Apply a source's `filter` to decoded features, then drop the properties
 * its `properties` selection leaves out.
 *
 * @param source - Source with a `filter`.
 * @param z - Tile zoom level passed to the filter.
 * @returns A function returning the accepted features of a batch.
 */
function featureFilter(source: Source, z: number): (features: RawFeature[]) => RawFeature[] {
  const test = source.filter!;
  const { keep } = featureSchema(source);
  return (features) => {
    // Decide for all features first: the parts of a GeometryCollection
    // share one property map, which is trimmed only afterwards
    const accepted = features.filter((f) => test({
      id: f.id,
      type: geometryFamily(f.type),
      properties: Object.fromEntries(f.properties) as Record<string, PropertyValue>,
    }, z));
    if (keep) {
      const trimmed = new Set<Map<string, PropertyValue>>();
      for (const f of accepted) {
        if (trimmed.has(f.properties)) continue;
        trimmed.add(f.properties);
        for (const key of [...f.properties.keys()]) {
          if (!keep(key)) f.properties.delete(key);
        }
      }
    }
    return accepted;
  };
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
 * @throws {RangeError} If `z/x/y` is not a valid tile or an option is invalid.
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
 * @throws {RangeError} If `z/x/y` is not a valid tile or an option is invalid.
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
  for (const source of sources) validateSource(source);
  const opts = sources.map(source => resolveOptions(source.options, tileOptions));
  return allOrCancel(sources.map((source, i) => (sibling: AbortSignal | undefined) =>
    processSource(connector, source, z, x, y, opts[i], context, sibling),
  ), signal);
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
 * processed concurrently.
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
 * @throws {RangeError} If `z/x/y` is not a valid tile or an option is invalid.
 * @throws {LimitExceededError} If the tile exceeds `maxTileBytes` or a source a budget.
 */
export async function processMultiConnectorTile(
  groups: ConnectorSourceGroup[],
  z: number, x: number, y: number,
  tileOptions: TileOptions | undefined,
  context: IoContext,
  request?: RequestOptions,
): Promise<Uint8Array> {
  return renderTile(flatten(groups), z, x, y, tileOptions, context, request);
}

/** Connector and source per layer, in layer order. */
export function flatten(groups: ConnectorSourceGroup[]): Array<[Connector, Source]> {
  const entries: Array<[Connector, Source]> = [];
  for (const group of groups) {
    for (const source of group.sources) entries.push([group.connector, source]);
  }
  return entries;
}

// == Tile ETags =============================================================

/**
 * Version of the tile encoding, part of every tile ETag. Increase it
 * whenever a change to the library alters the bytes of any tile.
 */
const TILE_ENCODING_VERSION = 2;

/**
 * Compute an ETag for a tile without rendering it: a hash of the
 * sources' file versions (their connector version tags), the tile
 * coordinates, and every setting that affects the tile's bytes.
 *
 * Sources outside their zoom range are not opened. Functions (a `filter`
 * or a `Projection`) are identified by their source text.
 *
 * @param entries - Connector and source per layer, in layer order.
 * @param z - Tile zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param tileOptions - Tile-level options.
 * @param context - I/O settings, cache and source registry.
 * @param signal - Optional abort signal.
 * @returns A strong ETag (quoted), or `null` if a source read for the tile
 *   has no version tag (the tile cannot be validated without rendering).
 * @throws {RangeError} If `z/x/y` is not a valid tile or an option is invalid.
 */
export async function computeTileETag(
  entries: Array<[Connector, Source]>,
  z: number, x: number, y: number,
  tileOptions: TileOptions | undefined,
  context: IoContext,
  signal?: AbortSignal,
): Promise<string | null> {
  validateTile(z, x, y);
  for (const [, source] of entries) validateSource(source);
  const parts: string[] = [
    String(TILE_ENCODING_VERSION), `${z}/${x}/${y}`, stableJson(resolveOptions(undefined, tileOptions)),
  ];
  const tags = await allOrCancel(entries.map(([connector, source]) => async (sibling: AbortSignal | undefined) => {
    const opts = resolveOptions(source.options, tileOptions);
    if (z < opts.minZoom || z > opts.maxZoom) return `${source.name}:skipped`;
    const fgb = await withSource(connector, source, context, sibling, async (opened) => opened)
      .catch((err: unknown) => { throw withPath(err, source.path); });
    if (fgb.etag === null) return null;
    return [
      source.name, connector.cacheNamespace ?? '', source.path, fgb.etag, stableJson(opts), describeSource(source),
    ].join('\u0001');
  }), signal);
  for (const tag of tags) {
    if (tag === null) return null;
    parts.push(tag);
  }
  const key = parts.join('\u0000');
  return `"${hash53(key, 1).toString(36)}${hash53(key, 2).toString(36)}"`;
}

/** Settings of a source that affect its layer, besides its options. */
function describeSource(source: Source): string {
  const { crs } = source;
  return stableJson({
    crs: crs === undefined || typeof crs === 'string' ? crs ?? 'auto' : `${crs.toWgs84}|${crs.fromWgs84}`,
    properties: source.properties ?? null,
    idColumn: source.idColumn ?? null,
    keepIdProperty: source.keepIdProperty ?? false,
    useIndex: source.useIndex ?? true,
    filter: source.filter ? String(source.filter) : null,
  });
}

/** JSON with sorted keys and non-finite numbers spelled out. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

/** A 53-bit string hash (cyrb53). */
function hash53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// == Helpers ================================================================

/** Coarsening steps tried by `reduceToFit`. */
const REDUCE_STEPS = 4;

/**
 * Render and encode a tile from sources with their connectors, enforcing
 * `maxTileBytes` (coarsening the tile first with `reduceToFit`) and
 * reporting statistics to `request.onTile`.
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
  for (const [, source] of entries) validateSource(source);
  const tileLevel = resolveOptions(undefined, tileOptions);
  const opts = entries.map(([, source]) => resolveOptions(source.options, tileOptions));
  const keepFeatures = tileLevel.reduceToFit && Number.isFinite(tileLevel.maxTileBytes);

  const onTile = request?.onTile;
  const started = onTile ? now() : 0;
  const stats: SourceStats[] | undefined = onTile
    ? entries.map(([, source]) => ({
      name: source.name, path: source.path,
      featuresRead: 0, featuresEncoded: 0, requests: 0, indexBytes: 0, featureBytes: 0, durationMs: 0,
    }))
    : undefined;

  const rendered = await allOrCancel(entries.map(([connector, source], i) => async (sibling: AbortSignal | undefined) => {
    const result = await renderSource(
      connector, source, z, x, y, opts[i], context, sibling, stats?.[i], keepFeatures,
    );
    if (stats) stats[i].durationMs = now() - started;
    return result;
  }), signal);

  let pbf = encodeLayers(rendered.map(r => r.layer), tileLevel);
  let reduced = 0;
  while (pbf.length > tileLevel.maxTileBytes && keepFeatures && reduced < REDUCE_STEPS) {
    reduced++;
    const factor = 2 ** reduced;
    const layers = rendered.map((r, i) => {
      if (!r.features || !r.clipBounds) return r.layer;
      const o = opts[i];
      const layer = buildMvtLayer(
        r.features, r.layer.name, z, x, y, r.clipBounds, o.extent,
        Math.max(o.tolerance, 1) * factor, inMercator,
        { simplifyBeforeClip: o.simplifyBeforeClip, pointGrid: (o.pointGrid > 0 ? o.pointGrid : o.extent / 512) * factor },
      );
      if (stats) stats[i].featuresEncoded = layer.features.length;
      return layer;
    });
    pbf = encodeLayers(layers, tileLevel);
  }
  if (pbf.length > tileLevel.maxTileBytes) {
    throw new LimitExceededError(
      `Tile ${z}/${x}/${y} encodes to ${pbf.length} bytes, more than maxTileBytes (${tileLevel.maxTileBytes})` +
      (reduced > 0 ? `, even after ${reduced} coarsening steps` : ''),
      { limit: 'tileBytes', max: tileLevel.maxTileBytes, actual: pbf.length },
    );
  }

  if (onTile && stats) {
    try {
      onTile({ z, x, y, tileBytes: pbf.length, durationMs: now() - started, reduced, sources: stats });
    } catch {
      // Observability must not break tile serving
    }
  }
  return pbf;
}

/**
 * Run tasks concurrently with a shared signal that aborts the others as
 * soon as one fails (or the caller's signal aborts), so a failed tile
 * stops reading the rest of its sources.
 *
 * @param tasks - Work items, each given the shared signal.
 * @param signal - Optional caller signal.
 * @returns The results, in task order.
 */
async function allOrCancel<T>(
  tasks: Array<(signal: AbortSignal | undefined) => Promise<T>>,
  signal: AbortSignal | undefined,
): Promise<T[]> {
  // A single task has no siblings to cancel
  if (tasks.length === 1) return [await tasks[0](signal)];
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.all(tasks.map(async (task) => {
      try {
        return await task(controller.signal);
      } catch (err) {
        controller.abort(err);
        throw err;
      }
    }));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Coordinate conversion for features already in mercator space. */
function inMercator(): void {}

/** Monotonic clock in milliseconds. */
function now(): number {
  return performance.now();
}

/**
 * Encode layers into a PBF tile, merging layers of sources that share a
 * name and leaving out empty layers when `omitEmptyLayers` is set.
 *
 * @param layers - Layers to encode.
 * @param tileOptions - Resolved tile-level options.
 * @returns The encoded tile (zero bytes when every layer was left out).
 * @throws {RangeError} If sources sharing a name use different extents.
 */
function encodeLayers(layers: MvtLayer[], tileOptions: Required<TileOptions>): Uint8Array {
  const merged = mergeLayers(layers);
  return encodePbf(tileOptions.omitEmptyLayers ? merged.filter(l => l.features.length > 0) : merged);
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


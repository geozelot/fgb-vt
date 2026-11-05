/**
 * @module source
 *
 * Source descriptors and tiling option resolution.
 *
 * **Sources** are stateless value objects describing *what* to read and *how
 * to tile it*: the FGB file path (interpreted by the Connector), the MVT
 * layer name, and per-source tiling options.
 *
 * Option values cascade through three levels:
 *
 * 1. {@link SourceOptions} — per-source overrides (highest priority)
 * 2. {@link TileOptions} — request-level or constructor-level defaults
 * 3. {@link DEFAULT_TILE_OPTIONS} — built-in fallbacks
 *
 * @example
 * ```typescript
 * const source: Source = {
 *   name: 'buildings',
 *   path: './data/buildings.fgb',
 *   options: { maxZoom: 18, tolerance: 1 },
 * };
 * ```
 */

import type { SourceCrs } from './geometry/crs.js';
import type { PropertySelection } from './schema.js';
import type { PropertyValue } from './types.js';

/**
 * A feature as seen by {@link Source.filter}.
 */
export interface FilterFeature {
  /** Feature id (from the id column), or `null`. */
  readonly id: number | bigint | null;
  /** Geometry family as written to the tile. */
  readonly type: 'Point' | 'LineString' | 'Polygon';
  /**
   * All properties of the stored feature, including columns that
   * {@link Source.properties} leaves out of the tile and the id column.
   */
  readonly properties: Readonly<Record<string, PropertyValue>>;
}

/**
 * Decides per feature and zoom whether a feature is written to the tile.
 * Called for every feature a tile reads, so keep it cheap.
 */
export type FeatureFilter = (feature: FilterFeature, zoom: number) => boolean;

/**
 * Per-source tiling option overrides.
 *
 * Any field left `undefined` falls through to the tile-level default
 * and then to the built-in default via {@link resolveOptions}.
 */
export interface SourceOptions {
  /** Tile coordinate extent: an integer from 1 to 2^28. @defaultValue 4096 */
  extent?: number;
  /** Buffer around tile in tile-coordinate pixels (`>= 0`). @defaultValue 64 */
  buffer?: number;
  /** Douglas-Peucker simplification tolerance in tile units (`>= 0`). @defaultValue 3 */
  tolerance?: number;
  /** Skip this source above this zoom level (an integer from 0 to 30). @defaultValue 24 */
  maxZoom?: number;
  /** Skip this source below this zoom level (an integer from 0 to 30, at most `maxZoom`). @defaultValue 0 */
  minZoom?: number;
  /**
   * Most features this source may contribute to one tile. Checked against
   * the spatial index before feature data is read; exceeding it raises
   * `LimitExceededError`. @defaultValue Infinity
   */
  maxFeatures?: number;
  /**
   * Most bytes of feature data read from this source for one tile.
   * Checked against the spatial index before feature data is read;
   * exceeding it raises `LimitExceededError`. @defaultValue 268435456 (256 MiB)
   */
  maxReadBytes?: number;
  /**
   * Simplify each feature as a whole before clipping it, so that adjacent
   * tiles get identical vertices along the tile edges (no gaps or overlaps
   * where a line or outline crosses a tile boundary). Costs the full
   * simplification of every feature reaching a tile, however little of it
   * is visible. @defaultValue false
   */
  simplifyBeforeClip?: boolean;
  /**
   * Keep at most one point per cell of this size, in tile units (`0`
   * disables thinning); the first point in file order wins. Bounds the
   * size of dense point layers at low zooms. Choose a divisor of `extent`
   * so that cells line up across tiles. @defaultValue 0
   */
  pointGrid?: number;
}

/**
 * A FlatGeobuf source descriptor.
 *
 * Binds a layer name and file path to optional tiling parameters.
 * The `path` format is interpreted by the Connector:
 *
 * | Connector | Path format |
 * |-----------|------------|
 * | `LocalConnector` | Filesystem path (`./data/buildings.fgb`) |
 * | `HttpConnector` | Full URL (`https://cdn.example.com/roads.fgb`) |
 * | `S3Connector` | S3 URI (`s3://bucket/key.fgb`) |
 */
export interface Source {
  /**
   * Layer name in the output MVT. Sources sharing a name are merged into
   * one layer, e.g. an overview file for low zooms and a detailed file for
   * high zooms, or one dataset split into several files.
   */
  name: string;
  /** Path to the FGB file, interpreted by the Connector. */
  path: string;
  /** Per-source tiling option overrides. */
  options?: SourceOptions;
  /**
   * Coordinate reference system of the file's coordinates. By default
   * (`'auto'`) it is taken from the file header: WGS 84 longitude/latitude
   * and Web Mercator are built in, and any other CRS raises
   * `UnsupportedFormatError` unless a `Projection` is given here.
   * @defaultValue 'auto'
   */
  crs?: SourceCrs;
  /**
   * Properties to write: the column names to keep (`[]` writes none), or
   * `{ exclude: [...] }` to drop some. Binary columns are always dropped
   * (MVT has no binary values). @defaultValue all properties
   */
  properties?: PropertySelection;
  /**
   * Column providing the MVT feature id, or `false` for no ids. By default
   * the first integer column named `id`, `fid`, `gid` or `ogc_fid` (case
   * insensitive) is used. A named column must be an integer column;
   * features whose value is negative or missing get no id.
   */
  idColumn?: string | false;
  /**
   * Also write the id column as a property (subject to `properties`).
   * @defaultValue false
   */
  keepIdProperty?: boolean;
  /**
   * `false` ignores the file's spatial index and scans its features
   * (bounded by `maxScanBytes`), e.g. for a file whose index does not match
   * its data (`IndexMismatchError`). @defaultValue true
   */
  useIndex?: boolean;
  /**
   * Write only the features for which this returns `true`, e.g. only major
   * roads below zoom 10: `(f, z) => z >= 10 || f.properties.class === 'major'`.
   *
   * The filter sees every property of a feature, also those left out by
   * {@link Source.properties}. It shrinks tiles, not reads: the features
   * are read and decoded first, and budgets such as `maxFeatures` count
   * them before filtering. To read less at low zooms, use an overview file
   * (a source with the same name and a lower `maxZoom`).
   */
  filter?: FeatureFilter;
}

/**
 * Tile-level tiling option defaults.
 *
 * Applied to all sources that do not specify their own override for a given
 * field. Typically set at the {@link TileClient} or {@link TileServer}
 * constructor level.
 */
export interface TileOptions {
  /** Default tile coordinate extent. @defaultValue 4096 */
  extent?: number;
  /** Default buffer around tile in tile-coordinate pixels. @defaultValue 64 */
  buffer?: number;
  /** Default simplification tolerance. @defaultValue 3 */
  tolerance?: number;
  /** Default maximum zoom level. @defaultValue 24 */
  maxZoom?: number;
  /** Default minimum zoom level. @defaultValue 0 */
  minZoom?: number;
  /** Default per-source feature limit per tile. @defaultValue Infinity */
  maxFeatures?: number;
  /** Default per-source limit on feature bytes read per tile. @defaultValue 268435456 (256 MiB) */
  maxReadBytes?: number;
  /** Default for simplifying whole features before clipping. @defaultValue false */
  simplifyBeforeClip?: boolean;
  /** Default point thinning cell size in tile units (`0`: off). @defaultValue 0 */
  pointGrid?: number;
  /**
   * Largest encoded tile, in bytes; larger tiles raise `LimitExceededError`
   * (e.g. to stay below a response size limit). Applies to the whole tile,
   * not per source. @defaultValue Infinity
   */
  maxTileBytes?: number;
  /**
   * When a tile exceeds `maxTileBytes`, encode it again with coarser
   * detail before giving up: up to four times, each time doubling the
   * simplification tolerance and the point grid (starting from `extent /
   * 512` for sources without one). `LimitExceededError` is raised only if
   * the coarsest attempt is still too large. The tile's
   * `TileStats.reduced` reports the steps taken.
   *
   * Costs memory: the decoded features of every source are kept until the
   * tile is encoded. @defaultValue false
   */
  reduceToFit?: boolean;
  /**
   * Leave layers without features out of the tile. A tile without any
   * features then encodes to zero bytes, which a server can answer with
   * `204 No Content`. Applies to the whole tile. @defaultValue false
   */
  omitEmptyLayers?: boolean;
}

/**
 * Built-in default values for all tiling options.
 *
 * Used as the final fallback when neither the source nor tile-level
 * options provide a value.
 */
export const DEFAULT_TILE_OPTIONS: Required<TileOptions> = {
  extent: 4096,
  buffer: 64,
  tolerance: 3,
  maxZoom: 24,
  minZoom: 0,
  maxFeatures: Infinity,
  maxReadBytes: 256 * 1024 * 1024,
  simplifyBeforeClip: false,
  pointGrid: 0,
  maxTileBytes: Infinity,
  reduceToFit: false,
  omitEmptyLayers: false,
};

/**
 * Resolve effective tiling options by cascading through three levels:
 * source options → tile options → built-in defaults.
 *
 * @param source - Per-source option overrides (highest priority).
 * @param tile - Tile-level option defaults (middle priority).
 * @returns Fully resolved options with no `undefined` fields.
 * @throws {RangeError} If a resolved option is invalid (see {@link validateTileOptions}).
 *
 * @example
 * ```typescript
 * const opts = resolveOptions(
 *   { tolerance: 1 },          // source override
 *   { tolerance: 5, buffer: 32 }, // tile defaults
 * );
 * // → { extent: 4096, buffer: 32, tolerance: 1, maxZoom: 24, minZoom: 0, ... }
 * ```
 */
export function resolveOptions(
  source?: SourceOptions,
  tile?: TileOptions,
): Required<TileOptions> {
  return validateTileOptions({
    extent: source?.extent ?? tile?.extent ?? DEFAULT_TILE_OPTIONS.extent,
    buffer: source?.buffer ?? tile?.buffer ?? DEFAULT_TILE_OPTIONS.buffer,
    tolerance: source?.tolerance ?? tile?.tolerance ?? DEFAULT_TILE_OPTIONS.tolerance,
    maxZoom: source?.maxZoom ?? tile?.maxZoom ?? DEFAULT_TILE_OPTIONS.maxZoom,
    minZoom: source?.minZoom ?? tile?.minZoom ?? DEFAULT_TILE_OPTIONS.minZoom,
    maxFeatures: source?.maxFeatures ?? tile?.maxFeatures ?? DEFAULT_TILE_OPTIONS.maxFeatures,
    maxReadBytes: source?.maxReadBytes ?? tile?.maxReadBytes ?? DEFAULT_TILE_OPTIONS.maxReadBytes,
    simplifyBeforeClip: source?.simplifyBeforeClip ?? tile?.simplifyBeforeClip ?? DEFAULT_TILE_OPTIONS.simplifyBeforeClip,
    pointGrid: source?.pointGrid ?? tile?.pointGrid ?? DEFAULT_TILE_OPTIONS.pointGrid,
    maxTileBytes: tile?.maxTileBytes ?? DEFAULT_TILE_OPTIONS.maxTileBytes,
    reduceToFit: tile?.reduceToFit ?? DEFAULT_TILE_OPTIONS.reduceToFit,
    omitEmptyLayers: tile?.omitEmptyLayers ?? DEFAULT_TILE_OPTIONS.omitEmptyLayers,
  });
}

/** Largest tile extent: coordinates and their deltas must stay within int32. */
const MAX_EXTENT = 2 ** 28;

/**
 * Check resolved tiling options. Invalid values would otherwise produce
 * empty tiles, invalid MVT (e.g. `extent: 0`) or errors only after all
 * data has been read.
 *
 * @param options - Resolved options.
 * @returns `options`.
 * @throws {RangeError} Naming the first invalid option.
 */
export function validateTileOptions(options: Required<TileOptions>): Required<TileOptions> {
  const { extent, buffer, minZoom, maxZoom } = options;
  if (!Number.isInteger(extent) || extent < 1 || extent > MAX_EXTENT) {
    throw new RangeError(`extent must be an integer from 1 to ${MAX_EXTENT}, got ${extent}`);
  }
  if (!(buffer >= 0 && extent + 2 * buffer <= 2 ** 30)) {
    throw new RangeError(`buffer must be a non-negative number (and extent + 2 * buffer at most 2^30), got ${buffer}`);
  }
  for (const key of ['tolerance', 'pointGrid'] as const) {
    const v = options[key];
    if (!(v >= 0 && v !== Infinity)) throw new RangeError(`${key} must be a non-negative finite number, got ${v}`);
  }
  for (const [key, v] of [['minZoom', minZoom], ['maxZoom', maxZoom]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 30) throw new RangeError(`${key} must be an integer from 0 to 30, got ${v}`);
  }
  if (minZoom > maxZoom) throw new RangeError(`minZoom (${minZoom}) is greater than maxZoom (${maxZoom})`);
  for (const key of ['maxFeatures', 'maxReadBytes', 'maxTileBytes'] as const) {
    const v = options[key];
    if (!(v >= 0)) throw new RangeError(`${key} must be a non-negative number, got ${v}`);
  }
  for (const key of ['simplifyBeforeClip', 'reduceToFit', 'omitEmptyLayers'] as const) {
    if (typeof options[key] !== 'boolean') throw new RangeError(`${key} must be a boolean, got ${String(options[key])}`);
  }
  return options;
}

/**
 * Check a source descriptor's name and path, which become the layer name
 * and the connector path.
 *
 * @param source - Source descriptor.
 * @throws {TypeError} If the name or path is not a non-empty string, or
 *   `filter` is not a function.
 */
export function validateSource(source: Source): void {
  if (typeof source?.name !== 'string' || source.name.length === 0) {
    throw new TypeError(`Source name must be a non-empty string, got ${JSON.stringify(source?.name)}`);
  }
  if (typeof source.path !== 'string' || source.path.length === 0) {
    throw new TypeError(`Source path of layer "${source.name}" must be a non-empty string`);
  }
  if (source.filter !== undefined && typeof source.filter !== 'function') {
    throw new TypeError(`Source filter of layer "${source.name}" must be a function`);
  }
}

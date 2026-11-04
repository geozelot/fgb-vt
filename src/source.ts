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

/**
 * Per-source tiling option overrides.
 *
 * Any field left `undefined` falls through to the tile-level default
 * and then to the built-in default via {@link resolveOptions}.
 */
export interface SourceOptions {
  /** Tile coordinate extent. @defaultValue 4096 */
  extent?: number;
  /** Buffer around tile in tile-coordinate pixels. @defaultValue 64 */
  buffer?: number;
  /** Douglas-Peucker simplification tolerance. @defaultValue 3 */
  tolerance?: number;
  /** Skip this source above this zoom level. @defaultValue 24 */
  maxZoom?: number;
  /** Skip this source below this zoom level. @defaultValue 0 */
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
  omitEmptyLayers: false,
};

/**
 * Resolve effective tiling options by cascading through three levels:
 * source options → tile options → built-in defaults.
 *
 * @param source - Per-source option overrides (highest priority).
 * @param tile - Tile-level option defaults (middle priority).
 * @returns Fully resolved options with no `undefined` fields.
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
  return {
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
    omitEmptyLayers: tile?.omitEmptyLayers ?? DEFAULT_TILE_OPTIONS.omitEmptyLayers,
  };
}

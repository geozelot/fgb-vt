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
  /** Layer name in the output MVT. Must be unique within a tile request. */
  name: string;
  /** Path to the FGB file, interpreted by the Connector. */
  path: string;
  /** Per-source tiling option overrides. */
  options?: SourceOptions;
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
 * // → { extent: 4096, buffer: 32, tolerance: 1, maxZoom: 24, minZoom: 0 }
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
  };
}

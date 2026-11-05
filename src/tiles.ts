/**
 * @module tiles
 *
 * Tile coordinate utilities for the fgb-vt pipeline.
 *
 * Provides pure-math conversions between slippy map tile coordinates
 * (z/x/y) and the two coordinate spaces used during tile generation:
 *
 * - **WGS84** bounding boxes (longitude/latitude) -- used for spatial
 *   index queries against FlatGeobuf files.
 * - **Mercator [0, 1]** clip bounds -- used by the Sutherland-Hodgman
 *   polygon clipper to trim geometry to tile edges with optional buffer.
 *
 * Tile coordinates are validated up front by {@link validateTile}. The
 * conversions are a handful of floating-point operations, so they are
 * computed per request rather than cached.
 *
 * All functions in this module are deterministic and side-effect-free.
 */

import type { BBox } from './types.js';

const PI = Math.PI;

// == Validation =============================================================

/**
 * Highest supported zoom level. Tile math uses 32-bit shifts (`1 << z`),
 * and tile-space coordinates must fit in 32-bit integers.
 */
export const MAX_ZOOM = 30;

/**
 * Check that `z/x/y` addresses an existing tile.
 *
 * @param z - Zoom level, an integer in `[0, MAX_ZOOM]`.
 * @param x - Tile column, an integer in `[0, 2^z)`.
 * @param y - Tile row, an integer in `[0, 2^z)`.
 * @throws {RangeError} If any coordinate is not an integer or is out of range.
 */
export function validateTile(z: number, x: number, y: number): void {
  if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM) {
    throw new RangeError(`Invalid zoom level ${z}: expected an integer in [0, ${MAX_ZOOM}]`);
  }
  const n = 2 ** z;
  if (!Number.isInteger(x) || x < 0 || x >= n || !Number.isInteger(y) || y < 0 || y >= n) {
    throw new RangeError(`Invalid tile ${z}/${x}/${y}: x and y must be integers in [0, ${n})`);
  }
}

// == Tile → WGS84 BBox =====================================================

/**
 * Convert slippy map tile coordinates to a WGS84 bounding box.
 *
 * Uses the standard Web Mercator tile grid where `y = 0` is the top
 * (north) edge of the projection. The returned bounding box has
 * longitude values in `[-180, 180]` and latitude values within the
 * Web Mercator limits (~`-85.051` to ~`85.051`).
 *
 * @param z - Zoom level.
 * @param x - Tile column.
 * @param y - Tile row (y = 0 at top / north).
 * @returns WGS84 bounding box with `minX`/`maxX` as longitude and
 *          `minY`/`maxY` as latitude.
 *
 * @example
 * ```typescript
 * const bbox = tileBBox(1, 0, 0);
 * // bbox.minX === -180, bbox.maxX === 0
 * // bbox.minY ≈ 0,     bbox.maxY ≈ 85.051
 * ```
 */
export function tileBBox(z: number, x: number, y: number): BBox {
  const n = 1 << z;
  return {
    minX: (x / n) * 360 - 180,
    minY: tileLatDeg(y + 1, n),
    maxX: ((x + 1) / n) * 360 - 180,
    maxY: tileLatDeg(y, n),
  };
}

/**
 * Convert a tile-grid Y position to latitude in degrees.
 *
 * Applies the inverse Mercator projection to translate a fractional row
 * position within a `n x n` tile grid back to WGS84 latitude.
 *
 * @param y - Fractional tile row position.
 * @param n - Grid size (`2^z`).
 * @returns Latitude in degrees.
 */
function tileLatDeg(y: number, n: number): number {
  const latRad = Math.atan(Math.sinh(PI - (2 * PI * y) / n));
  return (latRad * 180) / PI;
}

// == Tile → Mercator Clip Bounds ============================================

/**
 * Compute buffered clip bounds in Mercator [0, 1] space for a tile.
 *
 * The returned bounding box defines the region used by the
 * Sutherland-Hodgman clipper. The `buffer` parameter (in tile-coordinate
 * pixels) is divided by `extent` to produce a fractional overshoot
 * beyond the tile's true edges, ensuring that stroked lines and label
 * halos at tile boundaries are not abruptly truncated.
 *
 * @param z - Zoom level.
 * @param x - Tile column.
 * @param y - Tile row.
 * @param buffer - Buffer size in tile-coordinate pixels (e.g. 64).
 * @param extent - Tile coordinate extent (e.g. 4096).
 * @returns Axis-aligned bounding box in Mercator [0, 1] coordinate space,
 *          expanded by `buffer / extent` on each side.
 *
 * @example
 * ```typescript
 * // Tile 0/0/0 with 64px buffer at 4096 extent
 * const clip = tileClipBounds(0, 0, 0, 64, 4096);
 * // clip.minX ≈ -0.0156, clip.minY ≈ -0.0156
 * // clip.maxX ≈  1.0156, clip.maxY ≈  1.0156
 * ```
 */
export function tileClipBounds(
  z: number,
  x: number,
  y: number,
  buffer: number,
  extent: number,
): BBox {
  const z2 = 1 << z;
  const k = buffer / extent;
  return {
    minX: (x - k) / z2,
    minY: (y - k) / z2,
    maxX: (x + 1 + k) / z2,
    maxY: (y + 1 + k) / z2,
  };
}

// == Mercator → WGS84 =======================================================

/**
 * Convert a bounding box in mercator [0, 1] space to WGS84.
 *
 * Used to turn buffered clip bounds into the spatial index query box, so
 * that features inside the tile buffer — but outside the tile itself — are
 * read. Where the box touches or crosses the top or bottom edge of the
 * projection, latitude extends to the pole: projection clamps everything
 * beyond ±85.0511° onto that edge, so those features belong to edge tiles.
 *
 * @param bounds - Box in mercator [0, 1] space (y = 0 is north).
 * @returns The equivalent WGS84 bounding box.
 */
export function mercatorToWgs84BBox(bounds: BBox): BBox {
  return {
    minX: bounds.minX * 360 - 180,
    minY: bounds.maxY >= 1 ? -90 : mercatorYToLat(bounds.maxY),
    maxX: bounds.maxX * 360 - 180,
    maxY: bounds.minY <= 0 ? 90 : mercatorYToLat(bounds.minY),
  };
}

/**
 * Inverse Web Mercator for a y coordinate in [0, 1] space.
 *
 * @param y - Mercator y (0 = north edge, 1 = south edge).
 * @returns Latitude in degrees.
 */
function mercatorYToLat(y: number): number {
  return (Math.atan(Math.sinh(PI * (1 - 2 * y))) * 180) / PI;
}

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
 * The {@link TileBoundsCache} class memoizes both conversions so that
 * repeated requests for the same tile avoid redundant trigonometry.
 * A module-level singleton ({@link globalTileBoundsCache}) is exported
 * for the stateless {@link tile} API.
 *
 * All functions in this module are deterministic and side-effect-free;
 * the cache is safe to share across concurrent requests.
 */

import type { BBox } from './types.js';

const PI = Math.PI;

// ─── Tile ID ────────────────────────────────────────────────────────────────

/**
 * Encode tile coordinates into a unique numeric identifier.
 *
 * Uses the same encoding scheme as
 * {@link https://github.com/mapbox/geojson-vt | geojson-vt}: the tile's
 * position within its zoom level is packed alongside the zoom value into
 * a single integer. The resulting ID is used as a `Map` key inside
 * {@link TileBoundsCache}.
 *
 * @param z - Zoom level (0 = single world tile).
 * @param x - Tile column (0 = left edge, `2^z - 1` = right edge).
 * @param y - Tile row (0 = top edge in slippy map convention).
 * @returns A unique numeric identifier for the tile at (z, x, y).
 *
 * @example
 * ```typescript
 * import { tileId } from 'fgb-vt/tiles';
 *
 * tileId(0, 0, 0); // => 0
 * tileId(2, 3, 1); // => 230
 * ```
 */
export function tileId(z: number, x: number, y: number): number {
  return (((1 << z) * y + x) * 32) + z;
}

// ─── Tile → WGS84 BBox ─────────────────────────────────────────────────────

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
 * import { tileBBox } from 'fgb-vt/tiles';
 *
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

// ─── Tile → Mercator Clip Bounds ────────────────────────────────────────────

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
 * import { tileClipBounds } from 'fgb-vt/tiles';
 *
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

// ─── Cached Tile Bounds ─────────────────────────────────────────────────────

/**
 * A lazily-populated, dual-compartment cache for tile bounding boxes.
 *
 * Tile bounding boxes are purely mathematical -- they depend only on the
 * tile coordinates and (for clip bounds) the buffer/extent parameters.
 * Caching avoids repeated trigonometric calculations when the same tile
 * is requested across multiple sources or successive requests.
 *
 * Two separate caches are maintained:
 *
 * - **WGS84 cache** -- keyed by numeric tile ID from {@link tileId}.
 *   Used during FlatGeobuf spatial index queries.
 * - **Clip cache** -- keyed by a composite string of tile ID, buffer,
 *   and extent. Used during geometry clipping. The extra key components
 *   are necessary because different sources may use different buffer and
 *   extent values for the same tile.
 *
 * Instances are safe to share across concurrent async requests since all
 * cached values are immutable after creation.
 *
 * @example
 * ```typescript
 * import { TileBoundsCache } from 'fgb-vt/tiles';
 *
 * const cache = new TileBoundsCache();
 *
 * // First call computes; subsequent calls return the cached result.
 * const wgs84  = cache.getWgs84(14, 8192, 5461);
 * const clip   = cache.getClip(14, 8192, 5461, 64, 4096);
 * ```
 */
export class TileBoundsCache {
  private readonly wgs84 = new Map<number, BBox>();
  private readonly clip = new Map<string, BBox>();

  /**
   * Get or compute the WGS84 bounding box for a tile.
   *
   * @param z - Zoom level.
   * @param x - Tile column.
   * @param y - Tile row.
   * @returns Cached or freshly computed WGS84 bounding box.
   */
  getWgs84(z: number, x: number, y: number): BBox {
    const id = tileId(z, x, y);
    let bbox = this.wgs84.get(id);
    if (!bbox) {
      bbox = tileBBox(z, x, y);
      this.wgs84.set(id, bbox);
    }
    return bbox;
  }

  /**
   * Get or compute buffered Mercator clip bounds for a tile.
   *
   * The cache key includes `buffer` and `extent` alongside the tile ID
   * because different sources may specify different tiling parameters for
   * the same tile coordinates.
   *
   * @param z - Zoom level.
   * @param x - Tile column.
   * @param y - Tile row.
   * @param buffer - Buffer size in tile-coordinate pixels.
   * @param extent - Tile coordinate extent.
   * @returns Cached or freshly computed Mercator [0, 1] clip bounds.
   */
  getClip(z: number, x: number, y: number, buffer: number, extent: number): BBox {
    // Include buffer+extent in the key since they can vary per source
    const key = `${tileId(z, x, y)}:${buffer}:${extent}`;
    let bbox = this.clip.get(key);
    if (!bbox) {
      bbox = tileClipBounds(z, x, y, buffer, extent);
      this.clip.set(key, bbox);
    }
    return bbox;
  }
}

/** Module-level singleton for the semi-stateless {@link tile} API. */
export const globalTileBoundsCache = new TileBoundsCache();

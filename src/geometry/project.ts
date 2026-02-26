/**
 * @module geometry/project
 *
 * Web Mercator projection from WGS84 geographic coordinates to normalized
 * mercator [0, 1] space.
 *
 * All projection output lives in a **unit square** where both X and Y range
 * from 0 to 1. This convention decouples projection from any particular zoom
 * level or tile extent and simplifies downstream operations (clipping,
 * transformation) which only need to scale by powers of two.
 *
 * **Coordinate conventions:**
 * - **X**: 0 = antimeridian (180 W), 0.5 = prime meridian, 1 = antimeridian (180 E).
 *   Computed as `longitude / 360 + 0.5`.
 * - **Y**: 0 = north pole, 1 = south pole (screen-space / TMS convention).
 *   Computed via the standard Mercator latitude formula, clamped to [0, 1]
 *   (approximately +/-85.051 degrees).
 *
 * Coordinate arrays use the flat interleaved layout `[x0, y0, x1, y1, ...]`
 * shared across the entire pipeline.
 */

const PI = Math.PI;

/**
 * Project a WGS84 longitude to mercator X in [0, 1] space.
 *
 * The mapping is linear: -180 maps to 0, 0 (prime meridian) maps to 0.5,
 * and +180 maps to 1.
 *
 * @param lng - Longitude in decimal degrees, typically in [-180, 180].
 * @returns Mercator X coordinate in the range [0, 1].
 *
 * @example
 * ```ts
 * projectX(0);    // => 0.5   (prime meridian)
 * projectX(-180); // => 0     (antimeridian, west)
 * projectX(180);  // => 1     (antimeridian, east)
 * ```
 */
export function projectX(lng: number): number {
  return lng / 360 + 0.5;
}

/**
 * Project a WGS84 latitude to mercator Y in [0, 1] space.
 *
 * Uses the standard spherical Mercator formula and clamps the result to
 * [0, 1], which corresponds to the usable Mercator range of approximately
 * +/-85.051 degrees latitude.
 *
 * Y = 0 is the north pole (top of the map) and Y = 1 is the south pole
 * (bottom of the map), matching the screen-space / TMS tile convention.
 *
 * @param lat - Latitude in decimal degrees, typically in [-85.051, 85.051].
 * @returns Mercator Y coordinate clamped to the range [0, 1].
 *
 * @example
 * ```ts
 * projectY(0);      // => 0.5   (equator)
 * projectY(85.051); // => ~0    (near north pole)
 * projectY(-85.051);// => ~1    (near south pole)
 * ```
 */
export function projectY(lat: number): number {
  const sin = Math.sin(lat * PI / 180);
  const y = 0.5 - 0.25 * Math.log((1 + sin) / (1 - sin)) / PI;
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

/**
 * Project a flat coordinate array from WGS84 to mercator [0, 1] space
 * **in-place**.
 *
 * Iterates over interleaved `[x0, y0, x1, y1, ...]` pairs, replacing each
 * longitude with its mercator X and each latitude with its mercator Y. This
 * avoids allocating a new array and is safe because projection is a
 * one-to-one mapping.
 *
 * @param xy - Flat interleaved coordinate array `[lng0, lat0, lng1, lat1, ...]`.
 *   Modified in-place to `[mercX0, mercY0, mercX1, mercY1, ...]`.
 * @returns Nothing; the array is mutated in-place.
 *
 * @example
 * ```ts
 * const coords = new Float64Array([0, 0, -180, 85.051]);
 * projectToMercator(coords);
 * // coords is now approximately [0.5, 0.5, 0.0, 0.0]
 * ```
 */
export function projectToMercator(xy: Float64Array): void {
  for (let i = 0; i < xy.length; i += 2) {
    xy[i] = projectX(xy[i]);
    xy[i + 1] = projectY(xy[i + 1]);
  }
}

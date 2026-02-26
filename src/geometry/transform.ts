/**
 * @module geometry/transform
 *
 * Tile coordinate transformation and polygon winding order correction.
 *
 * This module bridges the gap between mercator [0, 1] space (used for
 * clipping and simplification) and tile-local integer coordinates
 * (used by the MVT encoding step). It provides two main operations:
 *
 * 1. **Coordinate transformation** -- {@link transformToTile} converts
 *    mercator coordinates to integer tile-space coordinates in the range
 *    `[0, extent]` for a given (z, x, y) tile address.
 *
 * 2. **Winding order correction** -- {@link correctWinding} enforces the
 *    MVT 2.1 specification's winding order convention for polygon rings:
 *    exterior rings must be clockwise, interior rings (holes) must be
 *    counter-clockwise (in screen / Y-down coordinates).
 *
 * All coordinates use the flat interleaved layout `[x0, y0, x1, y1, ...]`.
 */

import type { GeomType } from '../types.js';
import { GeomType as GT } from '../types.js';

/**
 * Transform mercator [0, 1] coordinates to tile-space integer coordinates.
 *
 * For a tile at position `(tx, ty)` in a `2^z x 2^z` tile grid, each
 * mercator coordinate is mapped to the tile-local range `[0, extent]` by:
 *
 * ```
 * tileX = round(extent * (mercX * 2^z - tx))
 * tileY = round(extent * (mercY * 2^z - ty))
 * ```
 *
 * The result is a new `Int32Array` -- the original `Float64Array` is not
 * modified.
 *
 * @param xy - Flat interleaved mercator coordinates
 *   `[mercX0, mercY0, mercX1, mercY1, ...]`.
 * @param z - Zoom level (integer >= 0).
 * @param tx - Tile column index at zoom `z`.
 * @param ty - Tile row index at zoom `z`.
 * @param extent - Tile coordinate extent (typically 4096).
 * @returns A new `Int32Array` with rounded tile-space coordinates.
 *
 * @example
 * ```ts
 * // Tile (0, 0) at zoom 1 covers the top-left quadrant of the world.
 * // A point at mercator (0.25, 0.25) is in the center of that tile.
 * const merc = new Float64Array([0.25, 0.25]);
 * const tile = transformToTile(merc, 1, 0, 0, 4096);
 * // tile => Int32Array [2048, 2048]
 * ```
 */
export function transformToTile(
  xy: Float64Array,
  z: number,
  tx: number,
  ty: number,
  extent: number,
): Int32Array {
  const z2 = 1 << z;
  const out = new Int32Array(xy.length);
  for (let i = 0; i < xy.length; i += 2) {
    out[i] = Math.round(extent * (xy[i] * z2 - tx));
    out[i + 1] = Math.round(extent * (xy[i + 1] * z2 - ty));
  }
  return out;
}

/**
 * Enforce MVT winding order on polygon rings.
 *
 * Per the MVT 2.1 specification:
 * - **Exterior rings** must be **clockwise** (positive signed area in
 *   Y-down screen coordinates).
 * - **Interior rings** (holes) must be **counter-clockwise** (negative
 *   signed area).
 *
 * For non-polygon geometry types (`Point`, `LineString`, etc.) this
 * function is a no-op.
 *
 * For simple Polygons (no `parts`), ring 0 is treated as exterior and
 * all subsequent rings as holes.
 *
 * For MultiPolygons, the `parts` array identifies which rings in `ends`
 * are exterior rings (each entry is an index into `ends` marking the
 * start of a polygon part). Rings not listed in `parts` are holes of the
 * preceding exterior ring.
 *
 * Operates **in-place** on the coordinate array.
 *
 * @param coords - Flat interleaved tile-space coordinates (Int32Array).
 * @param ends - Ring end indices as coordinate-pair counts, or `null` for
 *   single-ring geometries.
 * @param geomType - Geometry type constant; only `Polygon` and
 *   `MultiPolygon` trigger winding correction.
 * @param parts - For MultiPolygon: indices into `ends` marking exterior
 *   ring positions, or `null` for simple Polygon / single-part MultiPolygon.
 * @returns Nothing; the coordinate array is mutated in-place if needed.
 */
export function correctWinding(
  coords: Int32Array,
  ends: Uint32Array | null,
  geomType: GeomType,
  parts: Uint32Array | null = null,
): void {
  if (geomType !== GT.Polygon && geomType !== GT.MultiPolygon) return;

  if (!ends || ends.length <= 1) {
    // Single ring: must be exterior (clockwise)
    ensureWinding(coords, 0, coords.length, true);
    return;
  }

  // Build a set of exterior ring indices from `parts`.
  // For simple Polygon (parts === null), only ring 0 is exterior.
  // For MultiPolygon with parts, each entry in `parts` marks an exterior ring.
  let exteriorSet: Set<number>;
  if (parts) {
    exteriorSet = new Set<number>();
    for (let i = 0; i < parts.length; i++) {
      exteriorSet.add(parts[i]);
    }
  } else {
    exteriorSet = new Set([0]);
  }

  let start = 0;
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i] * 2;
    const isExterior = exteriorSet.has(i);
    ensureWinding(coords, start, end, isExterior);
    start = end;
  }
}

/**
 * Ensure a ring has the specified winding order, reversing it if necessary.
 *
 * Uses {@link signedArea} to determine the current winding direction.
 * A positive signed area means clockwise in tile coordinates (Y-down);
 * a negative value means counter-clockwise.
 *
 * @param coords - Flat interleaved tile-space coordinates.
 * @param start - Start element index (inclusive) of the ring within `coords`.
 * @param end - End element index (exclusive) of the ring within `coords`.
 * @param clockwise - Desired winding order: `true` for clockwise
 *   (exterior), `false` for counter-clockwise (interior / hole).
 */
function ensureWinding(
  coords: Int32Array,
  start: number,
  end: number,
  clockwise: boolean,
): void {
  const area = signedArea(coords, start, end);
  // Positive area = clockwise in screen coords (Y-down)
  if ((area > 0) !== clockwise) {
    reverseRing(coords, start, end);
  }
}

/**
 * Compute the signed area of a polygon ring using the shoelace formula.
 *
 * The sign indicates winding direction in a Y-down (screen / tile)
 * coordinate system:
 * - **Positive** = clockwise
 * - **Negative** = counter-clockwise
 * - **Zero** = degenerate (collinear or empty)
 *
 * Accepts both `Int32Array` (tile-space) and plain `number[]` for
 * flexibility.
 *
 * @param coords - Flat interleaved coordinates containing the ring.
 * @param start - Start element index (inclusive) of the ring.
 * @param end - End element index (exclusive) of the ring.
 * @returns Signed area of the ring (not divided by 2, since only the sign
 *   and relative magnitude matter for winding detection).
 *
 * @example
 * ```ts
 * // A clockwise unit square in Y-down coordinates:
 * const cw = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0];
 * signedArea(cw, 0, cw.length); // => positive (clockwise)
 * ```
 */
export function signedArea(coords: Int32Array | number[], start: number, end: number): number {
  let area = 0;
  for (let i = start, j = end - 2; i < end; j = i, i += 2) {
    area += (coords[i] - coords[j]) * (coords[i + 1] + coords[j + 1]);
  }
  return area;
}

/**
 * Reverse the order of coordinate pairs in a ring, in-place.
 *
 * Swaps pairs from the outside in, effectively reversing the winding
 * direction of the ring without allocating a new array.
 *
 * @param coords - Flat interleaved coordinates containing the ring.
 * @param start - Start element index (inclusive) of the ring.
 * @param end - End element index (exclusive) of the ring.
 */
function reverseRing(coords: Int32Array, start: number, end: number): void {
  const half = ((end - start) / 2) | 0; // number of elements / 2, floored to even
  for (let i = 0; i < half; i += 2) {
    const li = start + i;
    const ri = end - 2 - i;
    const tx = coords[li], ty = coords[li + 1];
    coords[li] = coords[ri];
    coords[li + 1] = coords[ri + 1];
    coords[ri] = tx;
    coords[ri + 1] = ty;
  }
}

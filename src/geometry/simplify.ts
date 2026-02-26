/**
 * @module geometry/simplify
 *
 * Douglas-Peucker line simplification for flat coordinate arrays.
 *
 * Reduces the number of vertices in a geometry while preserving its visual
 * shape within a configurable tolerance. This is essential for vector tile
 * generation: lower zoom levels require aggressively simplified geometry to
 * keep tile sizes small and rendering fast.
 *
 * **Algorithm overview:**
 *
 * The implementation follows the classic Douglas-Peucker recursive subdivision
 * approach. Unlike geojson-vt's two-phase strategy (mark importance across all
 * zoom levels, then filter), this module performs both steps in a single pass
 * because the fgb-vt pipeline processes one tile at a time.
 *
 * 1. **Mark** -- {@link dpMark} recursively finds the point with the greatest
 *    perpendicular distance from the baseline connecting the first and last
 *    points of a segment, recording each point's squared distance as its
 *    "importance" score.
 * 2. **Filter** -- Points whose importance exceeds the squared tolerance
 *    threshold are emitted into the simplified output.
 *
 * The module also provides helpers for computing zoom-dependent tolerance
 * values and detecting degenerate (sub-pixel) rings.
 *
 * All coordinates use the flat interleaved layout `[x0, y0, x1, y1, ...]`.
 */

/**
 * Simplify a flat coordinate array using the Douglas-Peucker algorithm.
 *
 * Points whose perpendicular distance from the baseline is less than or
 * equal to `sqTolerance` are removed. The first and last points are always
 * retained.
 *
 * @param xy - Flat interleaved coordinate array `[x0, y0, x1, y1, ...]`.
 * @param sqTolerance - Squared distance tolerance. Points with importance
 *   at or below this value are dropped. Use {@link sqToleranceForZoom} to
 *   derive this from a zoom level.
 * @returns A new `Float64Array` containing only the retained coordinate
 *   pairs. Returns the input unchanged if it has 2 or fewer points.
 *
 * @example
 * ```ts
 * const line = new Float64Array([0, 0, 0.5, 0.001, 1, 0]);
 * const simplified = simplify(line, 0.0001);
 * // With tolerance 0.0001 the near-collinear midpoint is removed:
 * // simplified => Float64Array [0, 0, 1, 0]
 * ```
 */
export function simplify(
  xy: Float64Array,
  sqTolerance: number,
): Float64Array {
  const n = xy.length;
  if (n <= 4) return xy; // 2 points or fewer: nothing to simplify

  // Mark importance values in a parallel array (one per coordinate pair)
  const importance = new Float64Array(n / 2);
  // First and last points are always kept
  importance[0] = Infinity;
  importance[n / 2 - 1] = Infinity;

  dpMark(xy, importance, 0, n / 2 - 1);

  // Filter: emit only points with importance > sqTolerance
  const out: number[] = [];
  for (let i = 0; i < n / 2; i++) {
    if (importance[i] > sqTolerance) {
      out.push(xy[i * 2], xy[i * 2 + 1]);
    }
  }

  return new Float64Array(out);
}

/**
 * Compute the squared simplification tolerance for a given zoom level.
 *
 * Converts a user-facing `tolerance` (in tile-extent units at the target
 * zoom) into the squared mercator-space distance used by {@link simplify}.
 *
 * The formula accounts for the fact that the mercator [0, 1] space is
 * subdivided into `2^zoom` tiles on each axis, and each tile is further
 * divided into `extent` discrete units.
 *
 * @param tolerance - Simplification tolerance in tile-extent units
 *   (e.g. 3 means "3 pixels at this zoom").
 * @param zoom - Target zoom level (integer >= 0).
 * @param extent - Tile coordinate extent (typically 4096).
 * @returns Squared distance tolerance in mercator [0, 1] space.
 *
 * @example
 * ```ts
 * // 3-pixel tolerance at zoom 14 with extent 4096
 * const sqTol = sqToleranceForZoom(3, 14, 4096);
 * const simplified = simplify(coords, sqTol);
 * ```
 */
export function sqToleranceForZoom(tolerance: number, zoom: number, extent: number): number {
  const t = tolerance / ((1 << zoom) * extent);
  return t * t;
}

/**
 * Check if a polygon ring is too small to be visible at the given tolerance.
 *
 * Uses the ring's bounding box area as a fast proxy for the actual polygon
 * area. If the bounding box area is smaller than `sqTolerance`, the ring
 * is considered degenerate (sub-pixel) and can be safely discarded.
 *
 * @param xy - Flat interleaved coordinate array containing the ring.
 * @param start - Start index (element offset, not pair offset) into `xy`.
 * @param end - End index (exclusive, element offset) into `xy`.
 * @param sqTolerance - Squared distance tolerance in the same coordinate
 *   space as `xy`.
 * @returns `true` if the ring's bounding box area is less than
 *   `sqTolerance`, indicating the ring is too small to render.
 *
 * @example
 * ```ts
 * const ring = new Float64Array([0, 0, 0.001, 0, 0.001, 0.001, 0, 0.001, 0, 0]);
 * ringTooSmall(ring, 0, ring.length, 0.01);
 * // => true (bounding box area 0.000001 < 0.01)
 * ```
 */
export function ringTooSmall(xy: Float64Array, start: number, end: number, sqTolerance: number): boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = start; i < end; i += 2) {
    const x = xy[i], y = xy[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  return dx * dy < sqTolerance;
}

// ─── Douglas-Peucker marking ────────────────────────────────────────────────

/**
 * Recursively mark the importance of each point in a coordinate range using
 * the Douglas-Peucker algorithm.
 *
 * For the segment between `first` and `last`, finds the interior point with
 * the maximum squared perpendicular distance from the baseline
 * (`first` -> `last`). That distance is recorded as the point's importance
 * in the parallel `importance` array. The function then recurses on the
 * two sub-segments on either side of the chosen point.
 *
 * When multiple points share the same maximum distance, the tie is broken
 * by preferring the point closest to the midpoint of the range, which
 * yields more balanced recursion and slightly better visual results.
 *
 * @param xy - Flat interleaved coordinates `[x0, y0, x1, y1, ...]`.
 * @param importance - Parallel array (one entry per coordinate pair) where
 *   each point's squared deviation is stored.
 * @param first - Index (pair offset) of the segment start point.
 * @param last - Index (pair offset) of the segment end point.
 */
function dpMark(
  xy: Float64Array,
  importance: Float64Array,
  first: number,
  last: number,
): void {
  let maxSqDist = 0;
  let index = -1;
  const mid = (first + last) >> 1;
  let minPosToMid = last - first;

  const ax = xy[first * 2], ay = xy[first * 2 + 1];
  const bx = xy[last * 2], by = xy[last * 2 + 1];

  for (let i = first + 1; i < last; i++) {
    const d = sqSegDist(xy[i * 2], xy[i * 2 + 1], ax, ay, bx, by);
    if (d > maxSqDist) {
      index = i;
      maxSqDist = d;
    } else if (d === maxSqDist) {
      // Tie-break: prefer the point closest to the midpoint for balanced recursion
      const posToMid = Math.abs(i - mid);
      if (posToMid < minPosToMid) {
        index = i;
        minPosToMid = posToMid;
      }
    }
  }

  if (index >= 0 && maxSqDist > 0) {
    importance[index] = maxSqDist;
    if (index - first > 1) dpMark(xy, importance, first, index);
    if (last - index > 1) dpMark(xy, importance, index, last);
  }
}

/**
 * Compute the squared perpendicular distance from point `(px, py)` to the
 * line segment from `(ax, ay)` to `(bx, by)`.
 *
 * The closest point on the segment is found by projecting `p` onto the
 * line defined by `a` and `b` and clamping the parameter `t` to [0, 1].
 * If the segment is degenerate (zero length), the distance to `a` is
 * returned.
 *
 * @param px - X of the query point.
 * @param py - Y of the query point.
 * @param ax - X of the segment start.
 * @param ay - Y of the segment start.
 * @param bx - X of the segment end.
 * @param by - Y of the segment end.
 * @returns Squared Euclidean distance from `(px, py)` to the nearest
 *   point on the segment.
 */
function sqSegDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  let dx = bx - ax;
  let dy = by - ay;

  let x = ax, y = ay;

  if (dx !== 0 || dy !== 0) {
    const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = bx;
      y = by;
    } else if (t > 0) {
      x = ax + dx * t;
      y = ay + dy * t;
    }
  }

  dx = px - x;
  dy = py - y;
  return dx * dx + dy * dy;
}

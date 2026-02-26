/**
 * @module geometry/clip
 *
 * Sutherland-Hodgman stripe clipping for vector tile feature geometry.
 *
 * Clips {@link RawFeature} geometry against an axis-aligned bounding box in
 * mercator [0, 1] space. The algorithm uses a **two-pass approach**: each
 * ring (or line segment) is first clipped against the X-axis slab
 * (left/right boundaries), then the resulting segments are clipped against
 * the Y-axis slab (top/bottom boundaries). This decomposition is simpler
 * and faster than a full 2D polygon clipper while producing identical
 * results for rectangular clip regions.
 *
 * **Feature handling by geometry type:**
 * - **Points / MultiPoints** -- simple containment test per coordinate pair.
 * - **LineStrings / MultiLineStrings** -- clipped segments may split a single
 *   line into multiple disjoint segments.
 * - **Polygons / MultiPolygons** -- clipped rings are closed (the closing
 *   vertex is re-appended if needed).
 *
 * **Performance fast-paths:**
 * - Features whose bounding box is entirely outside the clip region are
 *   trivially rejected.
 * - Features whose bounding box is entirely inside the clip region are
 *   passed through unchanged (zero-copy).
 *
 * All coordinates are in the flat interleaved layout `[x0, y0, x1, y1, ...]`.
 */

import type { BBox, GeomType, RawFeature } from '../types.js';
import { GeomType as GT } from '../types.js';

/**
 * Clip a list of {@link RawFeature}s to the given bounding box.
 *
 * Features entirely outside the clip bounds are discarded.
 * Features entirely inside are passed through unchanged.
 * Features crossing boundaries are clipped with new intersection points.
 *
 * Coordinates must already be in mercator [0, 1] space (see
 * {@link projectToMercator}).
 *
 * @param features - Array of raw features to clip.
 * @param clipBounds - Axis-aligned bounding box defining the clip region
 *   in mercator [0, 1] space.
 * @returns A new array containing only the features (or clipped portions
 *   thereof) that intersect `clipBounds`.
 */
export function clipFeatures(
  features: RawFeature[],
  clipBounds: BBox,
): RawFeature[] {
  const result: RawFeature[] = [];
  const { minX, minY, maxX, maxY } = clipBounds;

  for (const feature of features) {
    // Trivial reject: compute feature bbox for quick test
    const fbox = featureBBox(feature.xy);
    if (fbox.maxX < minX || fbox.minX > maxX || fbox.maxY < minY || fbox.minY > maxY) {
      continue;
    }
    // Trivial accept: feature entirely inside clip bounds
    if (fbox.minX >= minX && fbox.maxX <= maxX && fbox.minY >= minY && fbox.maxY <= maxY) {
      result.push(feature);
      continue;
    }

    const isPolygon = isPolygonType(feature.type);
    const isPoint = isPointType(feature.type);

    if (isPoint) {
      // Points: simple containment test per point
      const clipped = clipPoints(feature.xy, minX, minY, maxX, maxY);
      if (clipped.length > 0) {
        result.push({
          ...feature,
          xy: new Float64Array(clipped),
          ends: feature.ends,
        });
      }
      continue;
    }

    // Lines/Polygons: extract rings, clip each, tracking which original
    // ring index each clipped ring came from (for parts reconstruction).
    const rings = extractRings(feature.xy, feature.ends);
    const clippedRings: Float64Array[] = [];
    const ringOriginMap: number[] = [];

    for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
      const ring = rings[ringIdx];
      const clipped = clipRing(ring, minX, minY, maxX, maxY, isPolygon);
      for (const c of clipped) {
        if (c.length >= 4) { // at least 2 coordinate pairs
          clippedRings.push(c);
          ringOriginMap.push(ringIdx);
        }
      }
    }

    if (clippedRings.length === 0) continue;

    // Reassemble into flat arrays
    const totalLen = clippedRings.reduce((s, r) => s + r.length, 0);
    const xy = new Float64Array(totalLen);
    const ends = new Uint32Array(clippedRings.length);
    let offset = 0;
    for (let i = 0; i < clippedRings.length; i++) {
      xy.set(clippedRings[i], offset);
      offset += clippedRings[i].length;
      ends[i] = offset / 2; // end index in coordinate pairs
    }

    // Rebuild parts: map original exterior ring indices to new positions
    let newParts: Uint32Array | null = null;
    if (feature.parts && isPolygon) {
      const exteriorOrigSet = new Set<number>();
      for (let j = 0; j < feature.parts.length; j++) {
        exteriorOrigSet.add(feature.parts[j]);
      }
      const newPartStarts: number[] = [];
      for (let i = 0; i < ringOriginMap.length; i++) {
        if (exteriorOrigSet.has(ringOriginMap[i])) {
          newPartStarts.push(i);
        }
      }
      if (newPartStarts.length > 1) {
        newParts = new Uint32Array(newPartStarts);
      }
    }

    result.push({
      ...feature,
      xy,
      ends: clippedRings.length > 1 ? ends : null,
      parts: newParts,
    });
  }

  return result;
}

// ─── Internals ──────────────────────────────────────────────────────────────

/**
 * Test whether a geometry type represents a polygon variant.
 *
 * @param t - Geometry type constant.
 * @returns `true` for `Polygon` and `MultiPolygon`.
 */
function isPolygonType(t: GeomType): boolean {
  return t === GT.Polygon || t === GT.MultiPolygon;
}

/**
 * Test whether a geometry type represents a point variant.
 *
 * @param t - Geometry type constant.
 * @returns `true` for `Point` and `MultiPoint`.
 */
function isPointType(t: GeomType): boolean {
  return t === GT.Point || t === GT.MultiPoint;
}

/**
 * Compute the axis-aligned bounding box of a flat coordinate array.
 *
 * @param xy - Flat interleaved coordinates `[x0, y0, x1, y1, ...]`.
 * @returns The bounding box enclosing all coordinate pairs.
 */
function featureBBox(xy: Float64Array): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < xy.length; i += 2) {
    const x = xy[i], y = xy[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Clip point geometries by simple containment testing.
 *
 * Each coordinate pair is independently tested against the bounding box.
 * Points on the boundary are considered inside.
 *
 * @param xy - Flat interleaved point coordinates `[x0, y0, x1, y1, ...]`.
 * @param minX - Left edge of the clip region.
 * @param minY - Top edge of the clip region.
 * @param maxX - Right edge of the clip region.
 * @param maxY - Bottom edge of the clip region.
 * @returns A plain number array of the surviving coordinate pairs.
 */
function clipPoints(
  xy: Float64Array,
  minX: number, minY: number, maxX: number, maxY: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < xy.length; i += 2) {
    const x = xy[i], y = xy[i + 1];
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
      out.push(x, y);
    }
  }
  return out;
}

/**
 * Extract individual ring coordinate arrays from a flat xy buffer and an
 * `ends` index array.
 *
 * Each ring is returned as a `Float64Array` subarray (zero-copy view) of
 * the original buffer. If `ends` is `null` or has only one entry, the
 * entire coordinate array is treated as a single ring.
 *
 * @param xy - Flat interleaved coordinates `[x0, y0, x1, y1, ...]`.
 * @param ends - Ring end indices as coordinate-pair counts, or `null` for
 *   single-ring geometries.
 * @returns Array of per-ring coordinate subarrays.
 */
function extractRings(xy: Float64Array, ends: Uint32Array | null): Float64Array[] {
  if (!ends || ends.length <= 1) {
    return [xy];
  }
  const rings: Float64Array[] = [];
  let start = 0;
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i] * 2; // convert pair count to element count
    rings.push(xy.subarray(start, end));
    start = end;
  }
  return rings;
}

/**
 * Clip a single ring (line string or polygon ring) against a rectangular
 * bounding box using two-pass Sutherland-Hodgman stripe clipping.
 *
 * **Pass 1:** Clip against the X-axis slab `[minX, maxX]`.
 * **Pass 2:** Clip each resulting segment against the Y-axis slab
 * `[minY, maxY]`.
 *
 * For polygon rings the output is always a single closed ring (the
 * closing vertex is re-appended if removed by clipping). For line strings
 * the output may contain multiple disjoint segments.
 *
 * @param ring - Flat interleaved ring coordinates.
 * @param minX - Left edge of the clip region.
 * @param minY - Top edge of the clip region.
 * @param maxX - Right edge of the clip region.
 * @param maxY - Bottom edge of the clip region.
 * @param isPolygon - Whether the ring should be treated as a closed polygon
 *   ring (`true`) or an open line string (`false`).
 * @returns Array of clipped coordinate segments; may be empty if the ring
 *   is entirely outside the clip region.
 */
function clipRing(
  ring: Float64Array,
  minX: number, minY: number, maxX: number, maxY: number,
  isPolygon: boolean,
): Float64Array[] {
  // Pass 1: clip against X axis
  const xClipped = clipAxis(ring, minX, maxX, 0, isPolygon);
  if (xClipped.length === 0) return [];

  // Pass 2: clip each X-clipped segment against Y axis
  const result: Float64Array[] = [];
  for (const segment of xClipped) {
    const yClipped = clipAxis(segment, minY, maxY, 1, isPolygon);
    for (let i = 0; i < yClipped.length; i++) {
      result.push(yClipped[i]);
    }
  }
  return result;
}

/**
 * Clip a coordinate array against an axis-aligned slab `[k1, k2]`.
 *
 * This is the core Sutherland-Hodgman step, applied to one axis at a time.
 * For each consecutive edge (a -> b) in the coordinate sequence, the
 * function determines whether a and b are inside or outside the slab and
 * emits the appropriate points and intersection vertices.
 *
 * For **polygon rings**, all surviving points accumulate into a single
 * output slice which is closed at the end. For **line strings**, the
 * output is split into separate segments each time the geometry exits
 * the slab.
 *
 * @param coords - Flat interleaved coordinates `[x0, y0, x1, y1, ...]`.
 * @param k1 - Lower bound of the slab on the specified axis.
 * @param k2 - Upper bound of the slab on the specified axis.
 * @param axis - Which axis to clip against: `0` for X, `1` for Y.
 * @param isPolygon - Whether to treat the geometry as a closed ring.
 * @returns Array of clipped coordinate segments.
 */
function clipAxis(
  coords: Float64Array,
  k1: number,
  k2: number,
  axis: 0 | 1,
  isPolygon: boolean,
): Float64Array[] {
  const results: Float64Array[] = [];
  let slice: number[] = [];

  const n = coords.length;
  if (n < 4) return []; // need at least 2 points

  for (let i = 0; i < n - 2; i += 2) {
    const ax = coords[i], ay = coords[i + 1];
    const bx = coords[i + 2], by = coords[i + 3];
    const a = axis === 0 ? ax : ay;
    const b = axis === 0 ? bx : by;

    // Point a is inside [k1, k2]
    const aInside = a >= k1 && a <= k2;
    // Point b is inside [k1, k2]
    const bInside = b >= k1 && b <= k2;

    if (aInside) {
      // a is inside
      slice.push(ax, ay);

      if (!bInside) {
        // a→b exits: add intersection
        if (b < k1) {
          addIntersection(slice, ax, ay, bx, by, k1, axis);
        } else {
          addIntersection(slice, ax, ay, bx, by, k2, axis);
        }
        if (!isPolygon && slice.length >= 4) {
          results.push(new Float64Array(slice));
          slice = [];
        }
      }
    } else if (bInside) {
      // a is outside, b is inside: add intersection then b will be added next iteration
      if (a < k1) {
        addIntersection(slice, ax, ay, bx, by, k1, axis);
      } else {
        addIntersection(slice, ax, ay, bx, by, k2, axis);
      }
    } else {
      // Both outside: check if they straddle the slab
      if ((a < k1 && b > k2) || (a > k2 && b < k1)) {
        // Segment crosses both boundaries
        const enter = a < k1 ? k1 : k2;
        const exit = a < k1 ? k2 : k1;
        addIntersection(slice, ax, ay, bx, by, enter, axis);
        addIntersection(slice, ax, ay, bx, by, exit, axis);
        if (!isPolygon && slice.length >= 4) {
          results.push(new Float64Array(slice));
          slice = [];
        }
      }
      // else both on same outside: skip
    }
  }

  // Handle last point
  const lastIdx = n - 2;
  const lastA = axis === 0 ? coords[lastIdx] : coords[lastIdx + 1];
  if (lastA >= k1 && lastA <= k2) {
    slice.push(coords[lastIdx], coords[lastIdx + 1]);
  }

  // For polygons, close the ring if needed
  if (isPolygon && slice.length >= 6) {
    const fx = slice[0], fy = slice[1];
    const lx = slice[slice.length - 2], ly = slice[slice.length - 1];
    if (fx !== lx || fy !== ly) {
      slice.push(fx, fy);
    }
  }

  if (slice.length >= 4) {
    results.push(new Float64Array(slice));
  }

  return results;
}

/**
 * Compute and append a line-segment / axis-boundary intersection point.
 *
 * Given the edge from `(ax, ay)` to `(bx, by)`, computes the point where
 * the edge crosses the axis-aligned boundary at `k` and pushes the
 * resulting `(x, y)` pair onto `out`.
 *
 * @param out - Accumulator array to push the intersection coordinates into.
 * @param ax - X of the edge start point.
 * @param ay - Y of the edge start point.
 * @param bx - X of the edge end point.
 * @param by - Y of the edge end point.
 * @param k - The axis-aligned boundary value to intersect.
 * @param axis - Which axis the boundary lies on: `0` for X, `1` for Y.
 */
function addIntersection(
  out: number[],
  ax: number, ay: number,
  bx: number, by: number,
  k: number,
  axis: 0 | 1,
): void {
  if (axis === 0) {
    // Intersect at x = k
    const t = (k - ax) / (bx - ax);
    out.push(k, ay + (by - ay) * t);
  } else {
    // Intersect at y = k
    const t = (k - ay) / (by - ay);
    out.push(ax + (bx - ax) * t, k);
  }
}

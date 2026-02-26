/**
 * @module mvt/geometry
 *
 * MVT 2.1 geometry command encoding.
 *
 * The Mapbox Vector Tile specification encodes geometries as a sequence of
 * **command integers** interleaved with **parameter integers**. Three commands
 * are defined:
 *
 * | Command   | ID | Parameters           | Meaning                                |
 * |-----------|----|----------------------|----------------------------------------|
 * | MoveTo    |  1 | `count` x (dX, dY)   | Start `count` new path segment(s)      |
 * | LineTo    |  2 | `count` x (dX, dY)   | Extend the current path by `count` edges |
 * | ClosePath |  7 | *(none)*              | Close the current ring (polygon only)  |
 *
 * A **command integer** packs both the command ID and a repeat count into a
 * single unsigned integer:
 *
 *     command_integer = (command_id & 0x7) | (count << 3)
 *
 * Parameter integers are **zigzag-encoded deltas** relative to a running cursor
 * position that starts at (0, 0) and persists across all geometry parts within
 * a single feature.
 *
 * @see {@link https://github.com/mapbox/vector-tile-spec/blob/master/2.1/vector_tile.proto | MVT 2.1 Spec}
 */

import { MvtGeomType } from '../types.js';
import { GeomType } from '../types.js';

const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;
const CMD_CLOSE_PATH = 7;

/**
 * Zigzag-encode a signed 32-bit integer to an unsigned integer.
 *
 * Zigzag encoding maps signed integers to unsigned integers so that values
 * with small absolute values have small encoded representations, which is
 * essential for efficient varint encoding in Protocol Buffers.
 *
 * The mapping is: 0 -> 0, -1 -> 1, 1 -> 2, -2 -> 3, 2 -> 4, ...
 *
 * @param n - Signed 32-bit integer to encode.
 * @returns The zigzag-encoded unsigned integer.
 *
 * @example
 * ```ts
 * zigzag(0);   // 0
 * zigzag(-1);  // 1
 * zigzag(1);   // 2
 * zigzag(-2);  // 3
 * ```
 */
export function zigzag(n: number): number {
  return (n << 1) ^ (n >> 31);
}

/**
 * Map a FlatGeobuf geometry type to the corresponding MVT geometry type.
 *
 * MVT collapses multi-geometry variants into their single counterparts
 * (e.g. both `Point` and `MultiPoint` become `MvtGeomType.POINT`).
 * Unknown or unsupported types fall back to `POINT`.
 *
 * @param fgbType - FlatGeobuf `GeomType` enum value.
 * @returns The corresponding `MvtGeomType` enum value.
 */
export function toMvtGeomType(fgbType: GeomType): MvtGeomType {
  switch (fgbType) {
    case GeomType.Point:
    case GeomType.MultiPoint:
      return MvtGeomType.POINT;
    case GeomType.LineString:
    case GeomType.MultiLineString:
      return MvtGeomType.LINESTRING;
    case GeomType.Polygon:
    case GeomType.MultiPolygon:
      return MvtGeomType.POLYGON;
    default:
      return MvtGeomType.POINT; // fallback
  }
}

/**
 * Encode tile-space coordinates into an MVT command integer sequence.
 *
 * Dispatches to type-specific encoders for points, lines, and polygons.
 * All coordinate deltas are zigzag-encoded relative to a running cursor
 * starting at (0, 0). For polygons, explicitly closed rings (where the
 * last vertex equals the first) are detected and the redundant closing
 * vertex is replaced with a `ClosePath` command.
 *
 * @param coords - Flat `Int32Array` of interleaved tile coordinates
 *   `[x0, y0, x1, y1, ...]`.
 * @param ends - Ring/part end indices as coordinate-pair counts, or `null`
 *   for single-part geometries (e.g. a simple linestring or point).
 * @param mvtType - Target MVT geometry type that determines the encoding
 *   strategy.
 * @returns Array of unsigned command and parameter integers ready for PBF
 *   packed-varint encoding. Returns an empty array if `coords` is empty or
 *   `mvtType` is unrecognized.
 *
 * @example
 * ```ts
 * // Encode a single point at tile coordinate (25, 17)
 * const coords = new Int32Array([25, 17]);
 * const cmds = encodeGeometry(coords, null, MvtGeomType.POINT);
 * // cmds = [commandInt(MoveTo, 1), zigzag(25), zigzag(17)]
 * //      = [9, 50, 34]
 * ```
 */
export function encodeGeometry(
  coords: Int32Array,
  ends: Uint32Array | null,
  mvtType: MvtGeomType,
): number[] {
  if (coords.length === 0) return [];

  switch (mvtType) {
    case MvtGeomType.POINT:
      return encodePoints(coords);
    case MvtGeomType.LINESTRING:
      return encodeLines(coords, ends);
    case MvtGeomType.POLYGON:
      return encodePolygons(coords, ends);
    default:
      return [];
  }
}

// ─── Point encoding ─────────────────────────────────────────────────────────

/**
 * Encode one or more points as an MVT command sequence.
 *
 * Emits a single `MoveTo` command whose count equals the number of points,
 * followed by zigzag-encoded delta pairs for each point.
 *
 * @param coords - Flat interleaved tile coordinates `[x0, y0, x1, y1, ...]`.
 * @returns Array of command and parameter integers.
 */
function encodePoints(coords: Int32Array): number[] {
  const numPoints = coords.length / 2;
  const cmds: number[] = [];

  // Single MoveTo with count = numPoints
  cmds.push(commandInt(CMD_MOVE_TO, numPoints));

  let cx = 0, cy = 0;
  for (let i = 0; i < coords.length; i += 2) {
    const dx = coords[i] - cx;
    const dy = coords[i + 1] - cy;
    cmds.push(zigzag(dx), zigzag(dy));
    cx = coords[i];
    cy = coords[i + 1];
  }

  return cmds;
}

// ─── Line encoding ──────────────────────────────────────────────────────────

/**
 * Encode one or more linestrings as an MVT command sequence.
 *
 * Each line segment begins with a `MoveTo(1)` for the first vertex,
 * followed by a `LineTo(n-1)` for the remaining vertices. Segments
 * with fewer than 2 vertices are skipped.
 *
 * @param coords - Flat interleaved tile coordinates.
 * @param ends - Ring/part end indices (pair counts), or `null` for a single linestring.
 * @returns Array of command and parameter integers.
 */
function encodeLines(coords: Int32Array, ends: Uint32Array | null): number[] {
  const cmds: number[] = [];
  let cx = 0, cy = 0;

  const segments = getRingBounds(coords.length / 2, ends);

  for (const [startPair, endPair] of segments) {
    const numPairs = endPair - startPair;
    if (numPairs < 2) continue;

    // MoveTo(1) for the first point
    const si = startPair * 2;
    cmds.push(commandInt(CMD_MOVE_TO, 1));
    cmds.push(zigzag(coords[si] - cx), zigzag(coords[si + 1] - cy));
    cx = coords[si];
    cy = coords[si + 1];

    // LineTo(numPairs - 1) for the rest
    cmds.push(commandInt(CMD_LINE_TO, numPairs - 1));
    for (let i = startPair + 1; i < endPair; i++) {
      const idx = i * 2;
      cmds.push(zigzag(coords[idx] - cx), zigzag(coords[idx + 1] - cy));
      cx = coords[idx];
      cy = coords[idx + 1];
    }
  }

  return cmds;
}

// ─── Polygon encoding ───────────────────────────────────────────────────────

/**
 * Encode one or more polygon rings as an MVT command sequence.
 *
 * Each ring emits `MoveTo(1)` for the first vertex, `LineTo(n)` for interior
 * vertices, and `ClosePath(1)` to implicitly close the ring. If the input
 * ring is explicitly closed (last vertex equals first), the redundant closing
 * vertex is omitted. Rings with fewer than 3 effective vertices are skipped.
 *
 * @param coords - Flat interleaved tile coordinates.
 * @param ends - Ring end indices (pair counts), or `null` for a single ring.
 * @returns Array of command and parameter integers.
 */
function encodePolygons(coords: Int32Array, ends: Uint32Array | null): number[] {
  const cmds: number[] = [];
  let cx = 0, cy = 0;

  const rings = getRingBounds(coords.length / 2, ends);

  for (const [startPair, endPair] of rings) {
    const numPairs = endPair - startPair;
    if (numPairs < 3) continue;

    // For polygons, the last point should equal the first (closed ring).
    // MVT uses ClosePath command instead, so we skip the closing point.
    const si = startPair * 2;
    const lastIdx = (endPair - 1) * 2;
    const isClosed = coords[si] === coords[lastIdx] && coords[si + 1] === coords[lastIdx + 1];
    const lineCount = isClosed ? numPairs - 2 : numPairs - 1;

    if (lineCount < 2) continue;

    // MoveTo(1) for the first point
    cmds.push(commandInt(CMD_MOVE_TO, 1));
    cmds.push(zigzag(coords[si] - cx), zigzag(coords[si + 1] - cy));
    cx = coords[si];
    cy = coords[si + 1];

    // LineTo for interior points
    cmds.push(commandInt(CMD_LINE_TO, lineCount));
    const lineEnd = isClosed ? endPair - 1 : endPair;
    for (let i = startPair + 1; i < lineEnd; i++) {
      const idx = i * 2;
      cmds.push(zigzag(coords[idx] - cx), zigzag(coords[idx + 1] - cy));
      cx = coords[idx];
      cy = coords[idx + 1];
    }

    // ClosePath(1)
    cmds.push(commandInt(CMD_CLOSE_PATH, 1));
  }

  return cmds;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Pack a command ID and repeat count into a single MVT command integer.
 *
 * @param id - Command ID (1 = MoveTo, 2 = LineTo, 7 = ClosePath).
 * @param count - Number of times the command repeats.
 * @returns The encoded command integer `(id & 0x7) | (count << 3)`.
 */
function commandInt(id: number, count: number): number {
  return (id & 0x7) | (count << 3);
}

/**
 * Compute ring/part boundaries as `[startPairIndex, endPairIndex]` tuples.
 *
 * When `ends` is `null` or empty, the entire coordinate array is treated as
 * a single ring spanning `[0, totalPairs]`.
 *
 * @param totalPairs - Total number of coordinate pairs in the array.
 * @param ends - Cumulative ring end indices (pair counts), or `null`.
 * @returns Array of `[start, end)` pair-index tuples, one per ring/part.
 */
function getRingBounds(totalPairs: number, ends: Uint32Array | null): Array<[number, number]> {
  if (!ends || ends.length === 0) {
    return [[0, totalPairs]];
  }
  const bounds: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i];
    if (end > start) {
      bounds.push([start, end]);
    }
    start = end;
  }
  return bounds;
}

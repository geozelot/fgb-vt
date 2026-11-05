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
import { signedArea } from '../geometry/transform.js';

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
  // Unsigned result: deltas of 2^30 or more would otherwise turn negative
  return ((n << 1) ^ (n >> 31)) >>> 0;
}

/**
 * Map a FlatGeobuf geometry type to the corresponding MVT geometry type.
 *
 * MVT collapses multi-geometry variants into their single counterparts
 * (e.g. both `Point` and `MultiPoint` become `MvtGeomType.POINT`). The
 * feature decoder only produces the six basic types; anything else falls
 * back to `POINT`.
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

// == Point encoding =========================================================

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

// == Line encoding ==========================================================

/**
 * Encode one or more linestrings as an MVT command sequence.
 *
 * Each line segment begins with a `MoveTo(1)` for the first vertex,
 * followed by a `LineTo(n-1)` for the remaining vertices. Consecutive
 * duplicate vertices (e.g. from rounding to integer tile coordinates) are
 * dropped, because the MVT spec forbids zero-length `LineTo` parameters.
 * Segments with fewer than 2 distinct vertices are skipped.
 *
 * @param coords - Flat interleaved tile coordinates.
 * @param ends - Ring/part end indices (pair counts), or `null` for a single linestring.
 * @returns Array of command and parameter integers.
 */
function encodeLines(coords: Int32Array, ends: Uint32Array | null): number[] {
  const cmds: number[] = [];
  const cursor = { x: 0, y: 0 };

  for (const [startPair, endPair] of getRingBounds(coords.length / 2, ends)) {
    emitPath(cmds, cursor, coords, startPair, endPair, false);
  }

  return cmds;
}

// == Polygon encoding =======================================================

/**
 * Encode one or more polygon rings as an MVT command sequence.
 *
 * Each ring emits `MoveTo(1)` for the first vertex, `LineTo(n)` for the
 * remaining vertices, and `ClosePath(1)` to implicitly close the ring. The
 * explicit closing vertex and consecutive duplicate vertices are omitted.
 *
 * Rings are expected in MVT winding order (see {@link correctWinding}):
 * positive signed area for exteriors, negative for holes. Rings with zero
 * area (including those with fewer than 3 distinct vertices) are skipped,
 * and so are holes whose exterior ring was skipped — otherwise a hole would
 * open the polygon and decoders would infer the opposite winding convention.
 *
 * @param coords - Flat interleaved tile coordinates.
 * @param ends - Ring end indices (pair counts), or `null` for a single ring.
 * @returns Array of command and parameter integers.
 */
function encodePolygons(coords: Int32Array, ends: Uint32Array | null): number[] {
  const cmds: number[] = [];
  const cursor = { x: 0, y: 0 };
  let exteriorOpen = false;

  for (const [startPair, ringEnd] of getRingBounds(coords.length / 2, ends)) {
    // Drop the explicit closing vertex(es); ClosePath closes the ring
    let endPair = ringEnd;
    const sx = coords[startPair * 2], sy = coords[startPair * 2 + 1];
    while (endPair - startPair > 1 &&
           coords[(endPair - 1) * 2] === sx && coords[(endPair - 1) * 2 + 1] === sy) {
      endPair--;
    }

    const area = signedArea(coords, startPair * 2, endPair * 2);
    if (area === 0) continue;
    if (area > 0) {
      exteriorOpen = true;
    } else if (!exteriorOpen) {
      continue; // hole without an emitted exterior
    }

    emitPath(cmds, cursor, coords, startPair, endPair, true);
  }

  return cmds;
}

/**
 * Emit `MoveTo(1)`, `LineTo(n)` and optionally `ClosePath` for one path in
 * a single pass, skipping consecutive duplicate vertices.
 *
 * The `LineTo` count is patched in after the vertices are written. A path
 * left with too few distinct vertices (fewer than 2 for lines, 3 for rings)
 * is rolled back entirely, restoring `cmds` and `cursor`.
 *
 * @param cmds - Command array to append to.
 * @param cursor - Running cursor shared across all paths of the feature.
 * @param coords - Flat interleaved tile coordinates.
 * @param startPair - First pair index (inclusive).
 * @param endPair - Last pair index (exclusive).
 * @param close - Whether this is a polygon ring (appends `ClosePath(1)`).
 */
function emitPath(
  cmds: number[],
  cursor: { x: number; y: number },
  coords: Int32Array,
  startPair: number,
  endPair: number,
  close: boolean,
): void {
  if (endPair <= startPair) return;
  const rollbackLength = cmds.length;
  const rollbackX = cursor.x, rollbackY = cursor.y;

  const si = startPair * 2;
  let x = coords[si], y = coords[si + 1];
  cmds.push(commandInt(CMD_MOVE_TO, 1), zigzag(x - cursor.x), zigzag(y - cursor.y));

  const lineToIndex = cmds.length;
  cmds.push(0); // LineTo command, patched below
  let lineCount = 0;
  for (let i = startPair + 1; i < endPair; i++) {
    const nx = coords[i * 2], ny = coords[i * 2 + 1];
    if (nx === x && ny === y) continue;
    cmds.push(zigzag(nx - x), zigzag(ny - y));
    x = nx;
    y = ny;
    lineCount++;
  }

  if (lineCount < (close ? 2 : 1)) {
    cmds.length = rollbackLength;
    cursor.x = rollbackX;
    cursor.y = rollbackY;
    return;
  }

  cmds[lineToIndex] = commandInt(CMD_LINE_TO, lineCount);
  if (close) cmds.push(commandInt(CMD_CLOSE_PATH, 1));
  cursor.x = x;
  cursor.y = y;
}

// == Helpers ================================================================

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
    // Clamp defensively: never index past the coordinate array
    const end = Math.min(ends[i], totalPairs);
    if (end > start) {
      bounds.push([start, end]);
    }
    start = Math.max(start, end);
  }
  return bounds;
}

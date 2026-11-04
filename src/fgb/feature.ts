/** @module fgb/feature
 *
 * FlatGeobuf feature decoder.
 *
 * Decodes one or more length-prefixed feature FlatBuffers from a contiguous
 * byte buffer into {@link RawFeature} objects. Each feature contains a
 * geometry (coordinate arrays and ring ends) and a property map decoded from
 * FGB's custom binary property encoding.
 *
 * FGB features are stored sequentially, each preceded by a `uint32` size
 * prefix. The FlatBuffer payload uses the following schema:
 *
 * **Feature table** (`feature.fbs`):
 * |  #  | Field      | Type                                    |
 * | --- | ---------- | --------------------------------------- |
 * |  0  | geometry   | Geometry table                          |
 * |  1  | properties | ubyte vector (custom binary encoding)   |
 * |  2  | columns    | Column[] (usually absent; in header)    |
 *
 * **Geometry table** (nested inside feature):
 * |  #  | Field | Type              |
 * | --- | ----- | ----------------- |
 * |  0  | ends  | uint32 vector     |
 * |  1  | xy    | double vector     |
 * |  2  | z     | double vector     |
 * |  3  | m     | double vector     |
 * |  4  | t     | double vector     |
 * |  5  | tm    | double vector     |
 * |  6  | type  | ubyte (GeomType)  |
 * |  7  | parts | Geometry vector   |
 */

import { FlatBufferReader } from './flatbuffers.js';
import { parseColumns, detectIdColumn } from './header.js';
import type { RawFeature, FgbHeader, PropertyValue, ColumnMeta } from '../types.js';
import { ColumnType, GeomType } from '../types.js';
import { linearizeArcs } from '../geometry/curve.js';
import { FgbVtError, FormatError } from '../errors.js';

/**
 * Maximum recursion depth for nested geometry parts.
 *
 * FGB Multi* geometries use one level of nesting (e.g. MultiPolygon ->
 * Polygon). A depth limit guards against maliciously crafted files with
 * deeply nested parts that would otherwise cause a stack overflow.
 */
const MAX_GEOMETRY_DEPTH = 4;

/** Shared empty coordinate array for absent `xy` vectors. */
const EMPTY_XY = new Float64Array(0);

/** Shared {@link TextDecoder} instance for UTF-8 property string decoding. */
const textDecoder = new TextDecoder();

/**
 * Shared mutable result object for {@link readPropertyValue}, avoiding a
 * fresh `{value, bytesRead}` allocation on every property decode.
 */
const propResult: { value: PropertyValue; bytesRead: number } = { value: null, bytesRead: 0 };

/**
 * Options for {@link decodeFeatureChunk}.
 */
export interface DecodeOptions {
  /**
   * Filter on a feature's offset within the buffer; rejected features are
   * skipped without decoding (e.g. features that were only read because
   * they sit between two requested ranges).
   */
  accept?: (offset: number) => boolean;
  /** Absolute file offset of the buffer, used in error reports. Defaults to `0`. */
  fileOffset?: number;
  /**
   * Largest allowed deviation between a circular arc and the chords that
   * approximate it, in the file's coordinate units. Defaults to `0` (the
   * finest resolution).
   */
  curveTolerance?: number;
}

/**
 * Result of decoding a buffer of length-prefixed features.
 */
export interface FeatureChunk {
  /**
   * Features decoded completely from the buffer. A GeometryCollection
   * yields one entry per geometry family (polygons, lines, points), all
   * sharing the stored feature's id and properties.
   */
  features: RawFeature[];
  /**
   * Stored features that were skipped because their geometry is missing,
   * empty or of an unknown or abstract type (`Unknown`, `Curve`,
   * `Surface`).
   */
  skipped: number;
  /**
   * Byte offset (within the buffer) of a feature whose size prefix says it
   * extends past the end of the buffer, or `-1` if the buffer ended on a
   * feature boundary. The caller can re-read `truncatedLength` bytes from
   * here to obtain the complete feature.
   */
  truncatedAt: number;
  /**
   * Full byte length of the truncated feature, including its 4-byte size
   * prefix, or `0` when the buffer ended inside the size prefix itself.
   */
  truncatedLength: number;
  /**
   * Bytes consumed by the complete features. Smaller than the buffer when
   * decoding stopped at a truncated feature or at a zero size prefix
   * (end-of-data marker).
   */
  end: number;
}

/**
 * Decode features from a contiguous byte buffer that may contain one or
 * more length-prefixed feature FlatBuffers, reporting a trailing feature
 * that was cut off by the end of the buffer.
 *
 * The decoder walks the buffer sequentially, reading `uint32` size prefixes
 * to delimit individual features. Decoding stops when the buffer is
 * exhausted, a zero-length prefix is encountered, or a feature extends past
 * the end of the buffer.
 *
 * @param bytes - Contiguous buffer of one or more length-prefixed feature
 *   FlatBuffers.
 * @param header - Parsed FGB header providing the geometry type and column
 *   schema needed for decoding.
 * @param options - Feature filter, file offset and curve tolerance.
 * @returns Decoded features and the position of a truncated trailing
 *   feature, if any.
 * @throws {FormatError} If a feature's FlatBuffer is corrupt.
 * @throws {UnsupportedFormatError} If a feature declares its own column
 *   schema with a column type unknown to the 3.x specification.
 */
export function decodeFeatureChunk(
  bytes: Uint8Array,
  header: FgbHeader,
  options: DecodeOptions = {},
): FeatureChunk {
  const { accept, fileOffset = 0, curveTolerance = 0 } = options;
  const features: RawFeature[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let skipped = 0;

  while (offset + 4 <= bytes.length) {
    // Read feature size prefix (uint32 LE)
    const featureSize = view.getUint32(offset, true);
    if (featureSize === 0) break;

    if (offset + 4 + featureSize > bytes.length) {
      return { features, skipped, truncatedAt: offset, truncatedLength: 4 + featureSize, end: offset };
    }

    if (!accept || accept(offset)) {
      const featureBytes = bytes.subarray(offset + 4, offset + 4 + featureSize);
      try {
        if (!decodeSingleFeature(featureBytes, header, curveTolerance, features)) skipped++;
      } catch (err) {
        if (err instanceof FgbVtError) throw err;
        // Out-of-bounds FlatBuffer access in a corrupt feature
        throw new FormatError(
          `Corrupt FlatGeobuf feature: ${(err as Error).message}`,
          { offset: fileOffset + offset, cause: err },
        );
      }
    }

    offset += 4 + featureSize;
  }

  if (offset < bytes.length && offset + 4 > bytes.length) {
    // The buffer ended inside a size prefix
    return { features, skipped, truncatedAt: offset, truncatedLength: 0, end: offset };
  }
  return { features, skipped, truncatedAt: -1, truncatedLength: 0, end: offset };
}

/**
 * Decode all complete features from a contiguous byte buffer that may
 * contain one or more length-prefixed feature FlatBuffers.
 *
 * A trailing feature cut off by the end of the buffer is ignored; use
 * {@link decodeFeatureChunk} to detect and re-read it.
 *
 * @param bytes - Contiguous buffer of one or more length-prefixed feature
 *   FlatBuffers.
 * @param header - Parsed FGB header providing the geometry type and column
 *   schema needed for decoding.
 * @param maxFeatures - Upper limit on the number of features to return.
 *   Defaults to `Infinity` (decode all).
 * @returns Array of decoded {@link RawFeature} objects.
 */
export function decodeFeatures(
  bytes: Uint8Array,
  header: FgbHeader,
  maxFeatures: number = Infinity,
): RawFeature[] {
  const { features } = decodeFeatureChunk(bytes, header);
  return features.length > maxFeatures ? features.slice(0, maxFeatures) : features;
}

/**
 * Decode a single feature from its FlatBuffer bytes (without the `uint32`
 * size prefix) and append the result to `out`.
 *
 * Basic geometries (types 1–6) produce one feature. A GeometryCollection
 * produces one feature per geometry family it contains. Features without
 * usable geometry produce none.
 *
 * Feature table (`feature.fbs`): `0` geometry, `1` properties, `2` columns
 * (a per-feature schema that overrides the header's when present).
 *
 * @param bytes - Raw FlatBuffer bytes for one feature.
 * @param header - Parsed FGB header providing geometry type and column
 *   schema.
 * @param curveTolerance - Chord tolerance for circular arcs.
 * @param out - Receives the decoded features.
 * @returns `true` if at least one feature was produced.
 */
function decodeSingleFeature(
  bytes: Uint8Array,
  header: FgbHeader,
  curveTolerance: number,
  out: RawFeature[],
): boolean {
  const fb = new FlatBufferReader(bytes);
  const rootOffset = fb.rootTableOffset();

  // Geometry (field 0)
  const geomFieldOff = fb.fieldOffset(rootOffset, 0);
  if (!geomFieldOff) return false;

  const geomTableOffset = fb.indirect(geomFieldOff);
  const type = geometryType(fb, geomTableOffset, header.geometryType);
  let geoms: DecodedGeometry[];
  if (type >= GeomType.Point && type <= GeomType.MultiPolygon) {
    const geom = decodeGeometry(fb, geomTableOffset, type);
    geoms = geom ? [geom] : [];
  } else {
    const collector = new Collector(curveTolerance);
    collect(fb, geomTableOffset, type, 0, collector);
    geoms = collector.result();
  }
  if (geoms.length === 0) return false;

  // Columns (field 2) — a per-feature schema overrides the header's
  let columns = header.columns;
  let idColumnIndex = header.idColumnIndex;
  const colsFieldOff = fb.fieldOffset(rootOffset, 2);
  if (colsFieldOff) {
    const own = parseColumns(fb, fb.indirect(colsFieldOff));
    if (own.length > 0) {
      columns = own;
      idColumnIndex = detectIdColumn(own);
    }
  }

  // Properties (field 1) — custom binary encoding
  const propsFieldOff = fb.fieldOffset(rootOffset, 1);
  const properties = propsFieldOff
    ? decodeProperties(fb, fb.indirect(propsFieldOff), columns)
    : new Map<string, PropertyValue>();

  // Extract feature ID from a detected ID column (if any). MVT ids are
  // uint64, so only non-negative integers qualify; anything else stays a
  // regular property rather than being mangled.
  let id: number | bigint | null = null;
  if (idColumnIndex >= 0) {
    const idCol = columns[idColumnIndex];
    const rawId = properties.get(idCol.name);
    if ((typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId >= 0) ||
        (typeof rawId === 'bigint' && rawId >= 0n)) {
      id = rawId;
      properties.delete(idCol.name);
    }
  }

  for (const geom of geoms) {
    out.push({
      type: geom.type,
      xy: geom.xy,
      ends: geom.ends,
      parts: geom.parts,
      properties,
      id,
    });
  }
  return true;
}

// == Geometry decoding ======================================================

/** Intermediate representation of a decoded FGB geometry. */
interface DecodedGeometry {
  /** Geometry type enum value (one of the six basic types). */
  type: GeomType;
  /** Interleaved x/y coordinate pairs as `[x0, y0, x1, y1, ...]`. */
  xy: Float64Array;
  /** Ring/part end-indices for multi-ring geometries, or `null`. */
  ends: Uint32Array | null;
  /**
   * For MultiPolygon: indices into `ends` marking the start of each
   * polygon part's exterior ring, or `null` when not applicable.
   */
  parts: Uint32Array | null;
}

/**
 * Read a Geometry table's type (field 6), falling back to `fallback` when
 * the field is absent.
 */
function geometryType(fb: FlatBufferReader, tablePos: number, fallback: GeomType): GeomType {
  const typeFieldOff = fb.fieldOffset(tablePos, 6);
  return typeFieldOff ? fb.readUint8(typeFieldOff) : fallback;
}

/**
 * Decode a basic Geometry table (types 1–6) from the feature FlatBuffer.
 *
 * Reads the `xy` coordinate vector (field 1) and the optional `ends` ring
 * delimiter vector (field 0). The `z`, `m`, `t` and `tm` vectors (fields
 * 2–5) are ignored: MVT is two-dimensional.
 *
 * When the flat `xy` field is absent, the decoder falls back to the
 * nested `parts` vector (field 7), which is used by some writers (e.g.
 * GDAL) for multi-geometry types. In that case, coordinate arrays from
 * all parts are flattened into a single `xy` array with cumulative
 * `ends` indices.
 *
 * @param fb - FlatBuffer reader over the feature bytes.
 * @param tablePos - Absolute byte offset of the Geometry table.
 * @param type - Geometry type of this table (a part's own type field is
 *   not consulted: parts of a basic multi-geometry are its single variant).
 * @param depth - Current recursion depth for nested parts decoding.
 *   Capped at {@link MAX_GEOMETRY_DEPTH} to guard against malicious nesting.
 * @returns Decoded geometry, or `null` if neither `xy` nor `parts` can
 *   provide coordinate data, or if the recursion depth limit is exceeded.
 */
function decodeGeometry(
  fb: FlatBufferReader,
  tablePos: number,
  type: GeomType,
  depth: number = 0,
): DecodedGeometry | null {
  if (depth > MAX_GEOMETRY_DEPTH) return null;

  // xy (field 1) — vector of doubles (flat representation)
  const xy = readXy(fb, tablePos);
  if (xy === null) return null;
  if (xy.length > 0) {
    const ends = readEnds(fb, tablePos, xy.length / 2);
    if (ends === undefined) return null;
    return { type, xy, ends, parts: null };
  }

  // Fallback: parts (field 7) — vector of nested Geometry tables.
  // Used by GDAL and other writers for multi-geometry features.
  // Flatten all parts into a single xy array with cumulative ends.
  const partOffsets = readParts(fb, tablePos);
  if (partOffsets.length === 0) return null;

  // Collect coordinates and ring ends from all parts, tracking which
  // `allEnds` index starts each polygon part (for MultiPolygon exterior
  // ring identification).
  const allXy: Float64Array[] = [];
  const allEnds: number[] = [];
  const partStarts: number[] = [];
  let coordPairCount = 0;

  for (const partOffset of partOffsets) {
    const partGeom = decodeGeometry(fb, partOffset, type, depth + 1);
    if (!partGeom || partGeom.xy.length === 0) continue;

    // Record the current allEnds index as the start of this polygon part.
    // The ring at this index is the exterior ring; subsequent rings until
    // the next partStart are holes of this polygon.
    partStarts.push(allEnds.length);

    allXy.push(partGeom.xy);
    const partPairs = partGeom.xy.length / 2;

    if (partGeom.ends) {
      // Part has multiple rings — accumulate with global offset
      for (let j = 0; j < partGeom.ends.length; j++) {
        allEnds.push(partGeom.ends[j] + coordPairCount);
      }
    } else {
      // Single-ring part
      allEnds.push(coordPairCount + partPairs);
    }

    coordPairCount += partPairs;
  }

  if (allXy.length === 0) return null;

  const xyAll = concatFloat64(allXy);
  const ends = allEnds.length > 0 ? new Uint32Array(allEnds) : null;

  // For MultiPolygon with more than one polygon part, record the part
  // boundary indices so downstream stages can distinguish exterior rings
  // from holes. Single-part MultiPolygons use the standard convention
  // (ring 0 = exterior, rest = holes) and don't need explicit parts.
  const parts = (type === GeomType.MultiPolygon && partStarts.length > 1)
    ? new Uint32Array(partStarts)
    : null;

  return { type, xy: xyAll, ends, parts };
}

/**
 * Read the `xy` vector (field 1).
 *
 * @returns The coordinates; an empty array when the field is absent or
 *   empty; `null` when it holds an odd number of values (corrupt).
 */
function readXy(fb: FlatBufferReader, tablePos: number): Float64Array | null {
  const xyFieldOff = fb.fieldOffset(tablePos, 1);
  if (!xyFieldOff) return EMPTY_XY;
  const xyVecOffset = fb.indirect(xyFieldOff);
  const xyLen = fb.vectorLen(xyVecOffset);
  if (xyLen === 0) return EMPTY_XY;
  // Coordinates come in (x, y) pairs
  if (xyLen % 2 !== 0) return null;
  return fb.readFloat64Array(fb.vectorStart(xyVecOffset), xyLen);
}

/**
 * Read the `ends` vector (field 0) and check it against the number of
 * coordinate pairs.
 *
 * @returns The ring/part ends, `null` when absent or empty, or `undefined`
 *   when inconsistent with `pairCount` (corrupt).
 */
function readEnds(fb: FlatBufferReader, tablePos: number, pairCount: number): Uint32Array | null | undefined {
  const endsFieldOff = fb.fieldOffset(tablePos, 0);
  if (!endsFieldOff) return null;
  const endsVecOffset = fb.indirect(endsFieldOff);
  const endsLen = fb.vectorLen(endsVecOffset);
  if (endsLen === 0) return null;
  const ends = fb.readUint32Array(fb.vectorStart(endsVecOffset), endsLen);
  return validEnds(ends, pairCount) ? ends : undefined;
}

/**
 * Read the `parts` vector (field 7).
 *
 * @returns Absolute offsets of the nested Geometry tables (empty if absent).
 */
function readParts(fb: FlatBufferReader, tablePos: number): number[] {
  const partsFieldOff = fb.fieldOffset(tablePos, 7);
  if (!partsFieldOff) return [];
  const partsVecOffset = fb.indirect(partsFieldOff);
  const partsLen = fb.vectorLen(partsVecOffset);
  const partsDataStart = fb.vectorStart(partsVecOffset);
  const offsets: number[] = new Array(partsLen);
  for (let i = 0; i < partsLen; i++) {
    offsets[i] = fb.indirect(partsDataStart + i * 4);
  }
  return offsets;
}

/**
 * Check that ring/part end indices are strictly increasing and that the
 * last one covers exactly the coordinate pairs present.
 *
 * Every downstream stage indexes coordinates through `ends`, so malformed
 * values would otherwise read out of bounds.
 *
 * @param ends - End indices in coordinate pairs.
 * @param pairCount - Number of coordinate pairs in `xy`.
 * @returns `true` when `ends` is consistent with `pairCount`.
 */
function validEnds(ends: Uint32Array, pairCount: number): boolean {
  let prev = 0;
  for (let i = 0; i < ends.length; i++) {
    if (ends[i] <= prev) return false;
    prev = ends[i];
  }
  return prev === pairCount;
}

// == Extended geometry types (7–17) =========================================

/**
 * Accumulates the primitives of an extended geometry by family, so that a
 * GeometryCollection can be split into one basic geometry per family.
 */
class Collector {
  /** Point coordinate arrays. */
  readonly points: Float64Array[] = [];
  /** Line strings (curves are linearised). */
  readonly lines: Float64Array[] = [];
  /** Polygons as lists of rings, exterior first. */
  readonly polygons: Float64Array[][] = [];

  constructor(readonly curveTolerance: number) {}

  /**
   * Assemble the collected primitives into basic geometries: polygons,
   * then lines, then points (the usual drawing order).
   */
  result(): DecodedGeometry[] {
    const out: DecodedGeometry[] = [];
    if (this.polygons.length > 0) {
      const rings: Float64Array[] = [];
      const starts: number[] = [];
      for (const polygon of this.polygons) {
        starts.push(rings.length);
        for (const ring of polygon) rings.push(ring);
      }
      const multi = this.polygons.length > 1;
      out.push({
        type: multi ? GeomType.MultiPolygon : GeomType.Polygon,
        xy: concatFloat64(rings),
        ends: rings.length > 1 ? cumulativeEnds(rings) : null,
        parts: multi ? new Uint32Array(starts) : null,
      });
    }
    if (this.lines.length > 0) {
      const multi = this.lines.length > 1;
      out.push({
        type: multi ? GeomType.MultiLineString : GeomType.LineString,
        xy: concatFloat64(this.lines),
        ends: multi ? cumulativeEnds(this.lines) : null,
        parts: null,
      });
    }
    if (this.points.length > 0) {
      const xy = concatFloat64(this.points);
      out.push({
        type: xy.length > 2 ? GeomType.MultiPoint : GeomType.Point,
        xy,
        ends: null,
        parts: null,
      });
    }
    return out;
  }
}

/**
 * Decode an extended geometry (or any geometry nested in one) into the
 * collector.
 *
 * | Type | Stored as | Becomes |
 * |------|-----------|---------|
 * | GeometryCollection | `parts`, each with its own type | split by family |
 * | CircularString | `xy` | line string (linearised) |
 * | CompoundCurve | `parts`: LineString / CircularString | one line string |
 * | CurvePolygon | `parts`: one curve per ring | polygon |
 * | MultiCurve | `parts`: curves | multi line string |
 * | MultiSurface | `parts`: Polygon / CurvePolygon | multi polygon |
 * | PolyhedralSurface | `parts`: Polygon | multi polygon |
 * | TIN | `xy` + `ends`, one triangle per ring (or `parts`) | multi polygon |
 * | Triangle | `xy` | polygon |
 *
 * Parts without a type field take the natural type of their container
 * (e.g. Polygon inside a MultiSurface). `Unknown` and the abstract `Curve`
 * and `Surface` types contribute nothing.
 *
 * @param fb - FlatBuffer reader over the feature bytes.
 * @param tablePos - Absolute byte offset of the Geometry table.
 * @param type - Geometry type of this table.
 * @param depth - Nesting depth, capped at {@link MAX_GEOMETRY_DEPTH}.
 * @param c - Receives the primitives.
 */
function collect(fb: FlatBufferReader, tablePos: number, type: GeomType, depth: number, c: Collector): void {
  if (depth > MAX_GEOMETRY_DEPTH) return;
  const parts = (fallback: GeomType) => {
    for (const part of readParts(fb, tablePos)) {
      collect(fb, part, geometryType(fb, part, fallback), depth + 1, c);
    }
  };

  switch (type) {
    case GeomType.Point:
    case GeomType.MultiPoint: {
      const xy = readXy(fb, tablePos);
      if (xy && xy.length > 0) c.points.push(xy);
      else if (xy) parts(GeomType.Point);
      return;
    }
    case GeomType.LineString:
    case GeomType.CircularString:
    case GeomType.CompoundCurve: {
      const line = readCurve(fb, tablePos, type, depth, c);
      if (line) c.lines.push(line);
      return;
    }
    case GeomType.MultiLineString:
    case GeomType.MultiCurve: {
      const xy = readXy(fb, tablePos);
      if (xy && xy.length > 0) {
        for (const line of splitRings(fb, tablePos, xy)) c.lines.push(line);
      } else if (xy) {
        parts(GeomType.LineString);
      }
      return;
    }
    case GeomType.Polygon:
    case GeomType.Triangle:
    case GeomType.CurvePolygon: {
      const rings = readSurface(fb, tablePos, depth, c);
      if (rings.length > 0) c.polygons.push(rings);
      return;
    }
    case GeomType.TIN: {
      const xy = readXy(fb, tablePos);
      if (xy && xy.length > 0) {
        for (const triangle of splitRings(fb, tablePos, xy)) c.polygons.push([triangle]);
      } else if (xy) {
        parts(GeomType.Triangle);
      }
      return;
    }
    case GeomType.MultiPolygon:
    case GeomType.MultiSurface:
    case GeomType.PolyhedralSurface: {
      const xy = readXy(fb, tablePos);
      if (xy && xy.length > 0) {
        // Flat storage: a single polygon
        const rings = splitRings(fb, tablePos, xy);
        if (rings.length > 0) c.polygons.push(rings);
      } else if (xy) {
        parts(GeomType.Polygon);
      }
      return;
    }
    case GeomType.GeometryCollection:
      parts(GeomType.Unknown);
      return;
    default:
      // Unknown, Curve, Surface (abstract) or a type beyond the 3.x schema
      return;
  }
}

/**
 * Read a curve (LineString, CircularString or CompoundCurve) as a line
 * string, linearising arcs.
 *
 * @returns The line string, or `null` if the curve is empty or corrupt.
 */
function readCurve(
  fb: FlatBufferReader,
  tablePos: number,
  type: GeomType,
  depth: number,
  c: Collector,
): Float64Array | null {
  if (depth > MAX_GEOMETRY_DEPTH) return null;
  switch (type) {
    case GeomType.LineString: {
      const xy = readXy(fb, tablePos);
      return xy && xy.length > 0 ? xy : null;
    }
    case GeomType.CircularString: {
      const xy = readXy(fb, tablePos);
      return xy && xy.length > 0 ? linearizeArcs(xy, c.curveTolerance) : null;
    }
    case GeomType.CompoundCurve: {
      // Segments are joined end to start; drop each shared joint vertex
      const segments: Float64Array[] = [];
      let lastX = NaN, lastY = NaN;
      for (const part of readParts(fb, tablePos)) {
        const seg = readCurve(fb, part, geometryType(fb, part, GeomType.LineString), depth + 1, c);
        if (!seg) continue;
        const joined = seg[0] === lastX && seg[1] === lastY ? seg.subarray(2) : seg;
        if (joined.length > 0) segments.push(joined);
        lastX = seg[seg.length - 2];
        lastY = seg[seg.length - 1];
      }
      return segments.length > 0 ? concatFloat64(segments) : null;
    }
    default:
      return null;
  }
}

/**
 * Read the rings of a surface (Polygon, Triangle or CurvePolygon), exterior
 * first, linearising curved rings.
 *
 * @returns The rings, or an empty array if the exterior ring is missing.
 */
function readSurface(fb: FlatBufferReader, tablePos: number, depth: number, c: Collector): Float64Array[] {
  const xy = readXy(fb, tablePos);
  if (xy === null) return [];
  if (xy.length > 0) return splitRings(fb, tablePos, xy);

  // CurvePolygon: one curve per ring
  const rings: Float64Array[] = [];
  for (const part of readParts(fb, tablePos)) {
    const ring = readCurve(fb, part, geometryType(fb, part, GeomType.LineString), depth + 1, c);
    if (ring) rings.push(ring);
    else if (rings.length === 0) return []; // no exterior ring
  }
  return rings;
}

/**
 * Split flat coordinates into rings (or line strings) using the table's
 * `ends` vector.
 *
 * @returns One array per ring; empty if `ends` is inconsistent with `xy`.
 */
function splitRings(fb: FlatBufferReader, tablePos: number, xy: Float64Array): Float64Array[] {
  const ends = readEnds(fb, tablePos, xy.length / 2);
  if (ends === undefined) return [];
  if (ends === null) return [xy];
  const rings: Float64Array[] = [];
  let start = 0;
  for (let i = 0; i < ends.length; i++) {
    rings.push(xy.subarray(start * 2, ends[i] * 2));
    start = ends[i];
  }
  return rings;
}

/** Concatenate coordinate arrays. */
function concatFloat64(arrays: Float64Array[]): Float64Array {
  if (arrays.length === 1) return arrays[0];
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Float64Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

/** Cumulative end indices (in coordinate pairs) of consecutive arrays. */
function cumulativeEnds(arrays: Float64Array[]): Uint32Array {
  const ends = new Uint32Array(arrays.length);
  let pairs = 0;
  for (let i = 0; i < arrays.length; i++) {
    pairs += arrays[i].length / 2;
    ends[i] = pairs;
  }
  return ends;
}

// == Properties decoding ====================================================

/**
 * Decode properties from FGB's custom binary encoding.
 *
 * The properties vector is a flat byte array containing sequential pairs
 * of `[uint16 column_index][value_bytes]`. Value byte layout depends on
 * the column type declared in the header schema:
 *
 * | Column type            | Encoding                                 |
 * | ---------------------- | ---------------------------------------- |
 * | Bool                   | 1 byte (`0` / non-zero)                  |
 * | Byte / UByte           | 1 byte                                   |
 * | Short / UShort         | 2 bytes (LE)                             |
 * | Int / UInt / Float     | 4 bytes (LE)                             |
 * | Long / ULong / Double  | 8 bytes (LE)                             |
 * | String / Json / DateTime | `uint32` length + UTF-8 bytes          |
 * | Binary                 | `uint32` length + raw bytes              |
 *
 * @param fb - FlatBuffer reader over the feature bytes.
 * @param propsVecOffset - Byte offset of the properties byte-vector
 *   within the FlatBuffer.
 * @param columns - Column schema from the parsed header.
 * @returns Map from column name to decoded property value.
 */
function decodeProperties(
  fb: FlatBufferReader,
  propsVecOffset: number,
  columns: ColumnMeta[],
): Map<string, PropertyValue> {
  const props = new Map<string, PropertyValue>();

  const propsLen = fb.vectorLen(propsVecOffset);
  if (propsLen === 0) return props;

  const dataStart = fb.vectorStart(propsVecOffset);
  // The properties vector is a byte array; we need a view into it
  const propsBytes = fb.readBytes(dataStart, propsLen);
  const view = new DataView(propsBytes.buffer, propsBytes.byteOffset, propsBytes.byteLength);

  let offset = 0;
  while (offset < propsLen) {
    if (offset + 2 > propsLen) break;

    const colIdx = view.getUint16(offset, true);
    offset += 2;

    if (colIdx >= columns.length) break;
    const col = columns[colIdx];

    readPropertyValue(view, propsBytes, offset, col.type);
    offset += propResult.bytesRead;

    props.set(col.name, propResult.value);
  }

  return props;
}

/**
 * Read a single property value from the binary properties buffer.
 *
 * Writes the decoded value and bytes consumed into the shared
 * {@link propResult} object to avoid per-property object allocation.
 *
 * @param view - DataView over the properties byte vector.
 * @param bytes - Raw `Uint8Array` of the properties byte vector (used for
 *   string and binary slicing).
 * @param offset - Current read position within the properties vector.
 * @param type - Column type determining the encoding.
 */
function readPropertyValue(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  type: ColumnType,
): void {
  switch (type) {
    case ColumnType.Bool:
      propResult.value = view.getUint8(offset) !== 0;
      propResult.bytesRead = 1;
      return;

    case ColumnType.Byte:
      propResult.value = view.getInt8(offset);
      propResult.bytesRead = 1;
      return;

    case ColumnType.UByte:
      propResult.value = view.getUint8(offset);
      propResult.bytesRead = 1;
      return;

    case ColumnType.Short:
      propResult.value = view.getInt16(offset, true);
      propResult.bytesRead = 2;
      return;

    case ColumnType.UShort:
      propResult.value = view.getUint16(offset, true);
      propResult.bytesRead = 2;
      return;

    case ColumnType.Int:
      propResult.value = view.getInt32(offset, true);
      propResult.bytesRead = 4;
      return;

    case ColumnType.UInt:
      propResult.value = view.getUint32(offset, true);
      propResult.bytesRead = 4;
      return;

    case ColumnType.Float:
      propResult.value = view.getFloat32(offset, true);
      propResult.bytesRead = 4;
      return;

    case ColumnType.Long: {
      // number when exactly representable, bigint otherwise
      const lo = view.getUint32(offset, true);
      const hi = view.getInt32(offset + 4, true);
      const n = hi * 0x100000000 + lo;
      propResult.value = Number.isSafeInteger(n) ? n : view.getBigInt64(offset, true);
      propResult.bytesRead = 8;
      return;
    }

    case ColumnType.ULong: {
      const lo = view.getUint32(offset, true);
      const hi = view.getUint32(offset + 4, true);
      const n = hi * 0x100000000 + lo;
      propResult.value = Number.isSafeInteger(n) ? n : view.getBigUint64(offset, true);
      propResult.bytesRead = 8;
      return;
    }

    case ColumnType.Double:
      propResult.value = view.getFloat64(offset, true);
      propResult.bytesRead = 8;
      return;

    case ColumnType.String:
    case ColumnType.Json:
    case ColumnType.DateTime: {
      if (offset + 4 > bytes.length) { propResult.value = null; propResult.bytesRead = 0; return; }
      const strLen = view.getUint32(offset, true);
      if (offset + 4 + strLen > bytes.length) { propResult.value = null; propResult.bytesRead = 0; return; }
      propResult.value = textDecoder.decode(bytes.subarray(offset + 4, offset + 4 + strLen));
      propResult.bytesRead = 4 + strLen;
      return;
    }

    case ColumnType.Binary: {
      if (offset + 4 > bytes.length) { propResult.value = null; propResult.bytesRead = 0; return; }
      const binLen = view.getUint32(offset, true);
      if (offset + 4 + binLen > bytes.length) { propResult.value = null; propResult.bytesRead = 0; return; }
      propResult.value = new Uint8Array(bytes.buffer, bytes.byteOffset + offset + 4, binLen);
      propResult.bytesRead = 4 + binLen;
      return;
    }

    default:
      propResult.value = null;
      propResult.bytesRead = 0;
  }
}

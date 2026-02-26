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
import type { RawFeature, FgbHeader, PropertyValue, ColumnMeta } from '../types.js';
import { ColumnType, GeomType } from '../types.js';

/**
 * Maximum recursion depth for nested geometry parts.
 *
 * FGB Multi* geometries use one level of nesting (e.g. MultiPolygon ->
 * Polygon). A depth limit guards against maliciously crafted files with
 * deeply nested parts that would otherwise cause a stack overflow.
 */
const MAX_GEOMETRY_DEPTH = 4;

/** Shared {@link TextDecoder} instance for UTF-8 property string decoding. */
const textDecoder = new TextDecoder();

/**
 * Decode all features from a contiguous byte buffer that may contain one or
 * more length-prefixed feature FlatBuffers.
 *
 * The decoder walks the buffer sequentially, reading `uint32` size prefixes
 * to delimit individual features. Decoding stops when the buffer is
 * exhausted, a zero-length prefix is encountered, or `maxFeatures` have
 * been decoded.
 *
 * @param bytes - Contiguous buffer of one or more length-prefixed feature
 *   FlatBuffers.
 * @param header - Parsed FGB header providing the geometry type and column
 *   schema needed for decoding.
 * @param maxFeatures - Upper limit on the number of features to decode.
 *   Defaults to `Infinity` (decode all).
 * @returns Array of decoded {@link RawFeature} objects.
 */
export function decodeFeatures(
  bytes: Uint8Array,
  header: FgbHeader,
  maxFeatures: number = Infinity,
): RawFeature[] {
  const features: RawFeature[] = [];
  let offset = 0;

  while (offset < bytes.length && features.length < maxFeatures) {
    if (offset + 4 > bytes.length) break;

    // Read feature size prefix (uint32 LE)
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    const featureSize = view.getUint32(0, true);
    if (featureSize === 0) break;

    offset += 4;
    if (offset + featureSize > bytes.length) break;

    const featureBytes = bytes.subarray(offset, offset + featureSize);
    const feature = decodeSingleFeature(featureBytes, header);
    if (feature) {
      features.push(feature);
    }

    offset += featureSize;
  }

  return features;
}

/**
 * Decode a single feature from its FlatBuffer bytes (without the `uint32`
 * size prefix).
 *
 * Returns `null` if the feature has no geometry field or if the geometry
 * contains no coordinate data, both of which indicate a malformed record.
 *
 * @param bytes - Raw FlatBuffer bytes for one feature.
 * @param header - Parsed FGB header providing geometry type and column
 *   schema.
 * @returns A decoded {@link RawFeature}, or `null` if the feature cannot
 *   be decoded.
 */
function decodeSingleFeature(
  bytes: Uint8Array,
  header: FgbHeader,
): RawFeature | null {
  const fb = new FlatBufferReader(bytes);
  const rootOffset = fb.rootTableOffset();

  // Geometry (field 0)
  const geomFieldOff = fb.fieldOffset(rootOffset, 0);
  if (!geomFieldOff) return null;

  const geomTableOffset = fb.indirect(geomFieldOff);
  const geom = decodeGeometry(fb, geomTableOffset, header.geometryType);
  if (!geom) return null;

  // Properties (field 1) — custom binary encoding
  const propsFieldOff = fb.fieldOffset(rootOffset, 1);
  const properties = propsFieldOff
    ? decodeProperties(fb, fb.indirect(propsFieldOff), header.columns)
    : new Map<string, PropertyValue>();

  return {
    type: geom.type,
    xy: geom.xy,
    ends: geom.ends,
    parts: geom.parts,
    properties,
    id: null, // FGB features don't have a built-in ID field at the feature level
  };
}

// ─── Geometry decoding ──────────────────────────────────────────────────────

/** Intermediate representation of a decoded FGB geometry. */
interface DecodedGeometry {
  /** Geometry type enum value. */
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
 * Decode a Geometry table from the feature FlatBuffer.
 *
 * Reads the `xy` coordinate vector (field 1), optional `ends` ring
 * delimiter vector (field 0), and the per-feature geometry type override
 * (field 6), falling back to the header-level geometry type when the
 * per-feature field is absent.
 *
 * When the flat `xy` field is absent, the decoder falls back to the
 * nested `parts` vector (field 7), which is used by some writers (e.g.
 * GDAL) for multi-geometry types. In that case, coordinate arrays from
 * all parts are flattened into a single `xy` array with cumulative
 * `ends` indices.
 *
 * @param fb - FlatBuffer reader over the feature bytes.
 * @param tablePos - Absolute byte offset of the Geometry table.
 * @param headerGeomType - Default geometry type from the file header, used
 *   when the per-feature type field is absent.
 * @param depth - Current recursion depth for nested parts decoding.
 *   Capped at {@link MAX_GEOMETRY_DEPTH} to guard against malicious nesting.
 * @returns Decoded geometry, or `null` if neither `xy` nor `parts` can
 *   provide coordinate data, or if the recursion depth limit is exceeded.
 */
function decodeGeometry(
  fb: FlatBufferReader,
  tablePos: number,
  headerGeomType: GeomType,
  depth: number = 0,
): DecodedGeometry | null {
  if (depth > MAX_GEOMETRY_DEPTH) return null;
  // type (field 6) — ubyte enum; fallback to header's geometry type
  const typeFieldOff = fb.fieldOffset(tablePos, 6);
  const type: GeomType = typeFieldOff ? fb.readUint8(typeFieldOff) : headerGeomType;

  // xy (field 1) — vector of doubles (flat representation)
  const xyFieldOff = fb.fieldOffset(tablePos, 1);
  if (xyFieldOff) {
    const xyVecOffset = fb.indirect(xyFieldOff);
    const xyLen = fb.vectorLen(xyVecOffset);
    if (xyLen > 0) {
      const xyDataStart = fb.vectorStart(xyVecOffset);
      const xy = fb.readFloat64Array(xyDataStart, xyLen);

      // ends (field 0) — vector of uint32
      let ends: Uint32Array | null = null;
      const endsFieldOff = fb.fieldOffset(tablePos, 0);
      if (endsFieldOff) {
        const endsVecOffset = fb.indirect(endsFieldOff);
        const endsLen = fb.vectorLen(endsVecOffset);
        if (endsLen > 0) {
          const endsDataStart = fb.vectorStart(endsVecOffset);
          ends = fb.readUint32Array(endsDataStart, endsLen);
        }
      }

      return { type, xy, ends, parts: null };
    }
  }

  // Fallback: parts (field 7) — vector of nested Geometry tables.
  // Used by GDAL and other writers for multi-geometry features.
  // Flatten all parts into a single xy array with cumulative ends.
  const partsFieldOff = fb.fieldOffset(tablePos, 7);
  if (!partsFieldOff) return null;

  const partsVecOffset = fb.indirect(partsFieldOff);
  const partsLen = fb.vectorLen(partsVecOffset);
  if (partsLen === 0) return null;

  const partsDataStart = fb.vectorStart(partsVecOffset);

  // Collect coordinates and ring ends from all parts, tracking which
  // `allEnds` index starts each polygon part (for MultiPolygon exterior
  // ring identification).
  const allXy: Float64Array[] = [];
  const allEnds: number[] = [];
  const partStarts: number[] = [];
  let coordPairCount = 0;

  for (let i = 0; i < partsLen; i++) {
    const partOffset = fb.indirect(partsDataStart + i * 4);
    const partGeom = decodeGeometry(fb, partOffset, headerGeomType, depth + 1);
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

  // Merge all xy arrays into a single Float64Array
  const totalDoubles = allXy.reduce((sum, a) => sum + a.length, 0);
  const xy = new Float64Array(totalDoubles);
  let writePos = 0;
  for (const arr of allXy) {
    xy.set(arr, writePos);
    writePos += arr.length;
  }

  const ends = allEnds.length > 0 ? new Uint32Array(allEnds) : null;

  // For MultiPolygon with more than one polygon part, record the part
  // boundary indices so downstream stages can distinguish exterior rings
  // from holes. Single-part MultiPolygons use the standard convention
  // (ring 0 = exterior, rest = holes) and don't need explicit parts.
  const parts = (type === GeomType.MultiPolygon && partStarts.length > 1)
    ? new Uint32Array(partStarts)
    : null;

  return { type, xy, ends, parts };
}

// ─── Properties decoding ────────────────────────────────────────────────────

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

    const { value, bytesRead } = readPropertyValue(view, propsBytes, offset, col.type);
    offset += bytesRead;

    props.set(col.name, value);
  }

  return props;
}

/**
 * Read a single property value from the binary properties buffer.
 *
 * @param view - DataView over the properties byte vector.
 * @param bytes - Raw `Uint8Array` of the properties byte vector (used for
 *   string and binary slicing).
 * @param offset - Current read position within the properties vector.
 * @param type - Column type determining the encoding.
 * @returns An object containing the decoded `value` and the number of
 *   `bytesRead` so the caller can advance the offset.
 */
function readPropertyValue(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  type: ColumnType,
): { value: PropertyValue; bytesRead: number } {
  switch (type) {
    case ColumnType.Bool:
      return { value: view.getUint8(offset) !== 0, bytesRead: 1 };

    case ColumnType.Byte:
      return { value: view.getInt8(offset), bytesRead: 1 };

    case ColumnType.UByte:
      return { value: view.getUint8(offset), bytesRead: 1 };

    case ColumnType.Short:
      return { value: view.getInt16(offset, true), bytesRead: 2 };

    case ColumnType.UShort:
      return { value: view.getUint16(offset, true), bytesRead: 2 };

    case ColumnType.Int:
      return { value: view.getInt32(offset, true), bytesRead: 4 };

    case ColumnType.UInt:
      return { value: view.getUint32(offset, true), bytesRead: 4 };

    case ColumnType.Float:
      return { value: view.getFloat32(offset, true), bytesRead: 4 };

    case ColumnType.Long: {
      const lo = view.getUint32(offset, true);
      const hi = view.getInt32(offset + 4, true);
      return { value: hi * 0x100000000 + lo, bytesRead: 8 };
    }

    case ColumnType.ULong: {
      const lo = view.getUint32(offset, true);
      const hi = view.getUint32(offset + 4, true);
      return { value: hi * 0x100000000 + lo, bytesRead: 8 };
    }

    case ColumnType.Double:
      return { value: view.getFloat64(offset, true), bytesRead: 8 };

    case ColumnType.String:
    case ColumnType.Json:
    case ColumnType.DateTime: {
      if (offset + 4 > bytes.length) return { value: null, bytesRead: 0 };
      const strLen = view.getUint32(offset, true);
      if (offset + 4 + strLen > bytes.length) return { value: null, bytesRead: 0 };
      const strBytes = bytes.subarray(offset + 4, offset + 4 + strLen);
      const str = textDecoder.decode(strBytes);
      return { value: str, bytesRead: 4 + strLen };
    }

    case ColumnType.Binary: {
      if (offset + 4 > bytes.length) return { value: null, bytesRead: 0 };
      const binLen = view.getUint32(offset, true);
      if (offset + 4 + binLen > bytes.length) return { value: null, bytesRead: 0 };
      const bin = new Uint8Array(bytes.buffer, bytes.byteOffset + offset + 4, binLen);
      return { value: bin, bytesRead: 4 + binLen };
    }

    default:
      return { value: null, bytesRead: 0 };
  }
}

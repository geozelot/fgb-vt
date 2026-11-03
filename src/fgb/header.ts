/** @module fgb/header
 *
 * FlatGeobuf header parser.
 *
 * Reads and validates the fixed-format header at the beginning of every FGB
 * file. The header encodes the geometry type, feature count, column schema,
 * dataset bounding box, spatial index parameters, and byte offsets needed to
 * locate the index and feature sections of the file.
 *
 * FGB file layout:
 * ```
 * [8 bytes magic] [4 bytes header size] [header FlatBuffer] [spatial index] [features...]
 * ```
 */

import { FlatBufferReader } from './flatbuffers.js';
import { calcTreeSize } from './index.js';
import type { FgbHeader, ColumnMeta, BBox } from '../types.js';
import { ColumnType, GeomType } from '../types.js';
import { FormatError, UnsupportedFormatError } from '../errors.js';

/**
 * FGB file magic bytes: `"fgb"` followed by major version `0x03`, `"fgb"`,
 * and a patch level byte.
 *
 * The first 7 bytes are checked during verification; the trailing patch byte
 * is intentionally ignored because the specification requires readers of a
 * major version to accept every patch level (3.0.0 writes `0x00`, 3.0.1
 * writes `0x01`).
 */
const MAGIC_BYTES = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);

/** Byte length of the FGB magic signature. */
const HEADER_MAGIC_SIZE = 8;

/** The only FlatGeobuf major version this reader understands. */
const SUPPORTED_MAJOR_VERSION = 3;

/**
 * Smallest and largest accepted header FlatBuffer sizes, matching the
 * reference implementation. The lower bound guards FlatBuffer decoding, the
 * upper bound guards against allocating for a corrupt size prefix.
 */
const HEADER_MIN_SIZE = 8;
const HEADER_MAX_SIZE = 10 * 1024 * 1024;

/** Schema default for `Header.index_node_size`, applied when the field is absent. */
const DEFAULT_INDEX_NODE_SIZE = 16;

/**
 * Verify that the leading bytes of a buffer contain the FGB magic signature.
 *
 * Only the first 7 bytes are compared; the 8th byte (patch version) is
 * allowed to differ so that minor revisions pass validation.
 *
 * @param bytes - Raw bytes from the beginning of the file (at least 8 bytes).
 * @returns `true` if the magic bytes match, `false` otherwise.
 */
export function verifyMagic(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_MAGIC_SIZE) return false;
  for (let i = 0; i < HEADER_MAGIC_SIZE - 1; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) return false;
  }
  return true;
}

/**
 * Throw a descriptive error unless the buffer starts with the magic bytes
 * of a supported FlatGeobuf version.
 *
 * Distinguishes "not a FlatGeobuf file" from "FlatGeobuf, but a major
 * version other than 3" (1.x and 2.x were never widely implemented and use
 * an incompatible index layout).
 *
 * @param bytes - Raw bytes from the beginning of the file.
 * @throws {FormatError} If the signature is missing.
 * @throws {UnsupportedFormatError} If the major version is not 3.
 */
function assertMagic(bytes: Uint8Array): void {
  if (verifyMagic(bytes)) return;
  const looksLikeFgb = bytes.length >= HEADER_MAGIC_SIZE &&
    bytes[0] === 0x66 && bytes[1] === 0x67 && bytes[2] === 0x62 &&
    bytes[4] === 0x66 && bytes[5] === 0x67 && bytes[6] === 0x62;
  if (looksLikeFgb) {
    throw new UnsupportedFormatError(
      `Unsupported FlatGeobuf major version ${bytes[3]} (only ${SUPPORTED_MAJOR_VERSION}.x is supported)`,
    );
  }
  throw new FormatError('Invalid FlatGeobuf magic bytes', { offset: 0 });
}

/**
 * Parse a complete FGB header from the raw bytes of a file.
 *
 * The parser reads the magic signature, decodes the length-prefixed header
 * FlatBuffer, and computes derived offsets (index start, features start) so
 * that callers can seek directly to the data they need.
 *
 * FGB header FlatBuffer field indices (from `header.fbs`):
 * |  #  | Field           | Type               |
 * | --- | --------------- | ------------------ |
 * |  0  | name            | string             |
 * |  1  | envelope        | double[]           |
 * |  2  | geometry_type   | ubyte (GeomType)   |
 * |  3  | has_z           | bool               |
 * |  4  | has_m           | bool               |
 * |  5  | has_t           | bool               |
 * |  6  | has_tm          | bool               |
 * |  7  | columns         | Column[]           |
 * |  8  | features_count  | ulong              |
 * |  9  | index_node_size | ushort             |
 * | 10  | crs             | Crs table          |
 * | 11  | title           | string             |
 * | 12  | description     | string             |
 * | 13  | metadata        | string             |
 *
 * Absent fields take their schema defaults. FlatBuffers writers omit fields
 * whose value equals the default, so this matters in practice: GDAL and the
 * Go writer both leave out `index_node_size` when it is 16.
 *
 * @param bytes - Raw file bytes, starting at byte 0 (must include the full
 *   magic + header).
 * @returns Parsed header containing geometry type, column schema, feature
 *   count, spatial index parameters, bounding box, and byte offsets.
 * @throws {FormatError} If the magic bytes are invalid, the header is
 *   truncated or out of bounds, or the index parameters are invalid.
 * @throws {UnsupportedFormatError} If the major version is not 3, or a
 *   column uses a type this reader does not know.
 */
export function parseHeader(bytes: Uint8Array): FgbHeader {
  assertMagic(bytes);

  const totalHeaderSize = headerByteSize(bytes);
  if (bytes.length < totalHeaderSize) {
    throw new FormatError(
      `Truncated FlatGeobuf header: need ${totalHeaderSize} bytes, got ${bytes.length}`,
      { offset: bytes.length },
    );
  }
  const headerStart = HEADER_MAGIC_SIZE + 4; // offset where the flatbuffer data starts

  // Parse the header FlatBuffer
  const fb = new FlatBufferReader(bytes.subarray(headerStart, totalHeaderSize));
  const rootOffset = fb.rootTableOffset();

  // Geometry type (field 2, default Unknown)
  const geomTypeOff = fb.fieldOffset(rootOffset, 2);
  const geometryType: GeomType = geomTypeOff ? fb.readUint8(geomTypeOff) : GeomType.Unknown;

  // Features count (field 8, default 0 = unknown)
  const fcOff = fb.fieldOffset(rootOffset, 8);
  const featuresCount = fcOff ? fb.readUint64AsNumber(fcOff) : 0;
  if (!Number.isSafeInteger(featuresCount)) {
    throw new FormatError(`Invalid FlatGeobuf header: features_count ${featuresCount} is out of range`);
  }

  // Index node size (field 9, default 16; 0 = no index)
  const insOff = fb.fieldOffset(rootOffset, 9);
  const indexNodeSize = insOff ? fb.readUint16(insOff) : DEFAULT_INDEX_NODE_SIZE;
  if (indexNodeSize === 1) {
    throw new FormatError('Invalid FlatGeobuf header: index_node_size must be 0 or at least 2');
  }

  // Envelope / bbox (field 1) — vector of doubles: [minX, minY, maxX, maxY]
  let bbox: BBox | null = null;
  const envOff = fb.fieldOffset(rootOffset, 1);
  if (envOff) {
    const envVecOffset = fb.indirect(envOff);
    const envLen = fb.vectorLen(envVecOffset);
    if (envLen >= 4) {
      const dataStart = fb.vectorStart(envVecOffset);
      bbox = {
        minX: fb.readFloat64(dataStart),
        minY: fb.readFloat64(dataStart + 8),
        maxX: fb.readFloat64(dataStart + 16),
        maxY: fb.readFloat64(dataStart + 24),
      };
    }
  }

  // Columns (field 7) — vector of Column tables
  const columns: ColumnMeta[] = [];
  const colsOff = fb.fieldOffset(rootOffset, 7);
  if (colsOff) {
    const colsVecOffset = fb.indirect(colsOff);
    const colsLen = fb.vectorLen(colsVecOffset);
    const colsDataStart = fb.vectorStart(colsVecOffset);

    for (let i = 0; i < colsLen; i++) {
      const colOffset = fb.indirect(colsDataStart + i * 4);
      columns.push(parseColumn(fb, colOffset));
    }
  }

  // Detect an ID column among the parsed columns
  const idColumnIndex = detectIdColumn(columns);

  // Compute spatial index size and offsets. An index requires a known
  // feature count; with features_count = 0 (unknown) there is none.
  const indexOffset = totalHeaderSize;
  const indexSize = indexNodeSize > 0 && featuresCount > 0
    ? calcTreeSize(featuresCount, indexNodeSize)
    : 0;
  const featuresOffset = indexOffset + indexSize;

  return {
    geometryType,
    columns,
    featuresCount,
    indexNodeSize,
    bbox,
    indexOffset,
    indexSize,
    featuresOffset,
    headerSize: totalHeaderSize,
    idColumnIndex,
  };
}

/**
 * Determine the total byte length of the magic + header section without
 * fully parsing the header FlatBuffer.
 *
 * Reads only the 8-byte magic and the 4-byte header size prefix, making
 * this suitable for a two-pass loading strategy: first fetch enough bytes
 * to call this function, then fetch the remainder.
 *
 * @param bytes - At least the first 12 bytes of the FGB file.
 * @returns Total byte length occupied by the magic signature and the
 *   header FlatBuffer (i.e. `8 + 4 + headerFbSize`).
 * @throws {FormatError} If `bytes` contains fewer than 12 bytes, does not
 *   start with FlatGeobuf magic bytes, or declares a header size outside
 *   8 B..10 MiB.
 * @throws {UnsupportedFormatError} If the major version is not 3.
 */
export function headerByteSize(bytes: Uint8Array): number {
  if (bytes.length < HEADER_MAGIC_SIZE + 4) {
    throw new FormatError('Not enough bytes to read FGB header size', { offset: bytes.length });
  }
  assertMagic(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset + HEADER_MAGIC_SIZE, 4);
  const headerFbSize = view.getUint32(0, true);
  if (headerFbSize < HEADER_MIN_SIZE || headerFbSize > HEADER_MAX_SIZE) {
    throw new FormatError(`Invalid FlatGeobuf header size: ${headerFbSize} bytes`, { offset: HEADER_MAGIC_SIZE });
  }
  return HEADER_MAGIC_SIZE + 4 + headerFbSize;
}

// == ID column detection =====================================================

/**
 * Well-known column names that conventionally hold a feature identifier.
 *
 * Checked case-insensitively, in priority order: an exact `id` match is
 * preferred over `fid`, which is preferred over `gid`, etc.
 */
const ID_COLUMN_NAMES = ['id', 'fid', 'gid', 'ogc_fid'];

/**
 * Integer column types eligible as feature ID sources.
 *
 * Float and Double are excluded because MVT feature IDs are unsigned
 * integers, and floating-point values would need lossy truncation.
 */
function isIntegerColumnType(type: ColumnType): boolean {
  return type === ColumnType.Byte || type === ColumnType.UByte ||
    type === ColumnType.Short || type === ColumnType.UShort ||
    type === ColumnType.Int || type === ColumnType.UInt ||
    type === ColumnType.Long || type === ColumnType.ULong;
}

/**
 * Scan the column schema for a well-known integer ID column.
 *
 * @param columns - Parsed column metadata from the FGB header.
 * @returns Index into `columns` of the best-matching ID column, or `-1`
 *   if no suitable column was found.
 */
function detectIdColumn(columns: ColumnMeta[]): number {
  for (const candidateName of ID_COLUMN_NAMES) {
    for (let i = 0; i < columns.length; i++) {
      if (columns[i].name.toLowerCase() === candidateName && isIntegerColumnType(columns[i].type)) {
        return i;
      }
    }
  }
  return -1;
}

// == Column parsing =========================================================

/** Highest {@link ColumnType} value defined by the FlatGeobuf 3.x schema. */
const MAX_COLUMN_TYPE = ColumnType.Binary;

/**
 * Parse a single Column table from the header FlatBuffer.
 *
 * Column FlatBuffer schema field indices and defaults (`header.fbs`):
 * - `0`: name (string, required)
 * - `1`: type (ubyte / `ColumnType` enum, default `Byte` = 0)
 * - `7`: nullable (bool, default `true`)
 *
 * @param fb - FlatBuffer reader positioned over the header buffer.
 * @param tablePos - Absolute byte offset of the Column table within the
 *   header FlatBuffer.
 * @returns Decoded column metadata.
 * @throws {UnsupportedFormatError} If the column type is not defined by the
 *   3.x specification (its values could not be decoded, so the property
 *   stream would be misread).
 */
function parseColumn(fb: FlatBufferReader, tablePos: number): ColumnMeta {
  // Name (field 0)
  const nameOff = fb.fieldOffset(tablePos, 0);
  const name = nameOff ? fb.readString(fb.indirect(nameOff)) : '';

  // Type (field 1, default Byte)
  const typeOff = fb.fieldOffset(tablePos, 1);
  const type: ColumnType = typeOff ? fb.readUint8(typeOff) : ColumnType.Byte;
  if (type > MAX_COLUMN_TYPE) {
    throw new UnsupportedFormatError(`Unsupported FlatGeobuf column type ${type} (column "${name}")`);
  }

  // Nullable (field 7, default true)
  const nullOff = fb.fieldOffset(tablePos, 7);
  const nullable = nullOff ? fb.readUint8(nullOff) !== 0 : true;

  return { name, type, nullable };
}

/**
 * Number of bytes to read from the start of an FGB file on the first I/O
 * operation.
 *
 * The absolute minimum to determine the full header size is 12 bytes
 * (8-byte magic + 4-byte header size prefix), but FGB headers are
 * typically a few hundred bytes to a few kilobytes. Reading 4096 bytes
 * up front captures most headers in a single round-trip, avoiding the
 * latency of a second read on the cold path.
 */
export const INITIAL_HEADER_READ_SIZE = 4096;

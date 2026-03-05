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
import type { FgbHeader, ColumnMeta, BBox } from '../types.js';
import { ColumnType, GeomType } from '../types.js';

/**
 * FGB file magic bytes: `"fgb"` followed by version `0x03`, `"fgb"`, and
 * patch byte `0x00`.
 *
 * The first 7 bytes are checked during verification; the trailing patch byte
 * is intentionally ignored so that minor patch-level revisions remain
 * forward-compatible.
 */
const MAGIC_BYTES = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);

/** Byte length of the FGB magic signature. */
const HEADER_MAGIC_SIZE = 8;

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
 * @param bytes - Raw file bytes, starting at byte 0 (must include the full
 *   magic + header).
 * @returns Parsed header containing geometry type, column schema, feature
 *   count, spatial index parameters, bounding box, and byte offsets.
 * @throws {Error} If the magic bytes are invalid.
 */
export function parseHeader(bytes: Uint8Array): FgbHeader {
  if (!verifyMagic(bytes)) {
    throw new Error('Invalid FlatGeobuf magic bytes');
  }

  // Header size (uint32, little-endian) at offset 8
  const headerSizeView = new DataView(bytes.buffer, bytes.byteOffset + HEADER_MAGIC_SIZE, 4);
  const headerFbSize = headerSizeView.getUint32(0, true);
  const headerStart = HEADER_MAGIC_SIZE + 4; // offset where the flatbuffer data starts
  const totalHeaderSize = headerStart + headerFbSize;

  // Parse the header FlatBuffer
  const fb = new FlatBufferReader(bytes.subarray(headerStart, totalHeaderSize));
  const rootOffset = fb.rootTableOffset();

  // Geometry type (field 2)
  const geomTypeOff = fb.fieldOffset(rootOffset, 2);
  const geometryType: GeomType = geomTypeOff ? fb.readUint8(geomTypeOff) : GeomType.Unknown;

  // Features count (field 8)
  const fcOff = fb.fieldOffset(rootOffset, 8);
  const featuresCount = fcOff ? fb.readUint64AsNumber(fcOff) : 0;

  // Index node size (field 9)
  const insOff = fb.fieldOffset(rootOffset, 9);
  const indexNodeSize = insOff ? fb.readUint16(insOff) : 0;

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

  // Compute spatial index size and offsets
  const indexOffset = totalHeaderSize;
  const indexSize = indexNodeSize > 0 ? calcIndexSize(featuresCount, indexNodeSize) : 0;
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
 * @throws {Error} If `bytes` contains fewer than 12 bytes.
 */
export function headerByteSize(bytes: Uint8Array): number {
  if (bytes.length < HEADER_MAGIC_SIZE + 4) {
    throw new Error('Not enough bytes to read FGB header size');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + HEADER_MAGIC_SIZE, 4);
  return HEADER_MAGIC_SIZE + 4 + view.getUint32(0, true);
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

/**
 * Parse a single Column table from the header FlatBuffer.
 *
 * Column FlatBuffer schema field indices:
 * - `0`: name (string)
 * - `1`: type (ubyte / `ColumnType` enum)
 * - `14`: nullable (bool)
 *
 * @param fb - FlatBuffer reader positioned over the header buffer.
 * @param tablePos - Absolute byte offset of the Column table within the
 *   header FlatBuffer.
 * @returns Decoded column metadata.
 */
function parseColumn(fb: FlatBufferReader, tablePos: number): ColumnMeta {
  // Name (field 0)
  const nameOff = fb.fieldOffset(tablePos, 0);
  const name = nameOff ? fb.readString(fb.indirect(nameOff)) : '';

  // Type (field 1)
  const typeOff = fb.fieldOffset(tablePos, 1);
  const type: ColumnType = typeOff ? fb.readUint8(typeOff) : ColumnType.String;

  // Nullable (field 14)
  const nullOff = fb.fieldOffset(tablePos, 14);
  const nullable = nullOff ? fb.readUint8(nullOff) !== 0 : true;

  return { name, type, nullable };
}

// == Index size calculation =================================================

/**
 * Calculate the byte size of a packed Hilbert R-tree index.
 *
 * Each node occupies exactly 40 bytes: 4 x `float64` for the bounding box
 * (32 bytes) plus 1 x `uint64` for the offset (8 bytes).
 * The total size is the sum of nodes across all tree levels.
 *
 * @param featuresCount - Total number of features (leaf nodes).
 * @param nodeSize - Branching factor (max children per internal node).
 * @returns Total byte size of the packed R-tree, or `0` if there are no
 *   features or the node size is zero.
 */
function calcIndexSize(featuresCount: number, nodeSize: number): number {
  if (featuresCount === 0 || nodeSize === 0) return 0;

  const NODE_ITEM_BYTE_SIZE = 40; // 4 * 8 (bbox doubles) + 8 (offset)
  let n = featuresCount;
  let totalNodes = n;

  // Sum up all levels of the tree
  while (n > 1) {
    n = Math.ceil(n / nodeSize);
    totalNodes += n;
  }

  // The packed r-tree is just raw nodes without its own header.
  // The byte size is simply totalNodes * NODE_ITEM_BYTE_SIZE.
  return totalNodes * NODE_ITEM_BYTE_SIZE;
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

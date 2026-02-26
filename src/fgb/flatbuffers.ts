/** @module fgb/flatbuffers
 *
 * Minimal, read-only FlatBuffers decoder.
 *
 * FlatBuffers stores data in a binary format with a vtable for field offsets.
 * Tables start with a signed 32-bit offset (soffset) to the vtable, followed
 * by field data. The vtable contains the vtable size, table data size, and
 * per-field offsets (all uint16).
 *
 * This module implements just enough of the FlatBuffers wire format to read
 * FGB headers and features without requiring generated code or a full
 * FlatBuffers runtime.
 */

/**
 * Low-level, read-only FlatBuffers decoder backed by a {@link DataView}.
 *
 * Provides scalar reads, string reads, table/vtable navigation, and typed
 * array extraction -- the minimal surface needed to decode FlatGeobuf
 * header and feature tables.
 *
 * All multi-byte reads use **little-endian** byte order, matching the
 * FlatBuffers wire format.
 */
export class FlatBufferReader {
  /** Raw byte buffer backing this reader. */
  readonly view: DataView;
  /** The underlying `Uint8Array` from which {@link view} was derived. */
  readonly bytes: Uint8Array;

  /**
   * Create a new reader over a byte buffer.
   *
   * @param bytes - Source byte array.
   * @param offset - Optional byte offset into `bytes` where reading starts.
   *   Defaults to `0`.
   */
  constructor(bytes: Uint8Array, offset: number = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
  }

  // ─── Scalar reads ─────────────────────────────────────────────────────

  /**
   * Read an unsigned 8-bit integer at the given byte offset.
   *
   * @param offset - Byte offset relative to the start of the view.
   * @returns The `uint8` value.
   */
  readUint8(offset: number): number {
    return this.view.getUint8(offset);
  }

  /**
   * Read an unsigned 16-bit integer (little-endian) at the given byte offset.
   *
   * @param offset - Byte offset relative to the start of the view.
   * @returns The `uint16` value.
   */
  readUint16(offset: number): number {
    return this.view.getUint16(offset, true);
  }

  /**
   * Read a signed 32-bit integer (little-endian) at the given byte offset.
   *
   * @param offset - Byte offset relative to the start of the view.
   * @returns The `int32` value.
   */
  readInt32(offset: number): number {
    return this.view.getInt32(offset, true);
  }

  /**
   * Read an unsigned 32-bit integer (little-endian) at the given byte offset.
   *
   * @param offset - Byte offset relative to the start of the view.
   * @returns The `uint32` value.
   */
  readUint32(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  /**
   * Read a 64-bit IEEE 754 double (little-endian) at the given byte offset.
   *
   * @param offset - Byte offset relative to the start of the view.
   * @returns The `float64` value.
   */
  readFloat64(offset: number): number {
    return this.view.getFloat64(offset, true);
  }

  /**
   * Read a 32-bit IEEE 754 float (little-endian) at the given byte offset.
   *
   * @param offset - Byte offset relative to the start of the view.
   * @returns The `float32` value.
   */
  readFloat32(offset: number): number {
    return this.view.getFloat32(offset, true);
  }

  /**
   * Read a signed 16-bit integer (little-endian) at the given byte offset.
   *
   * @param offset - Byte offset relative to the start of the view.
   * @returns The `int16` value.
   */
  readInt16(offset: number): number {
    return this.view.getInt16(offset, true);
  }

  /**
   * Read a signed 64-bit integer as a JavaScript `number`.
   *
   * The value is reconstructed from two 32-bit halves rather than using
   * `BigInt`, which is sufficient for feature counts up to approximately
   * 9 x 10^15.
   *
   * @param offset - Byte offset relative to the start of the view.
   * @returns The `int64` value approximated as a `number`.
   */
  readInt64AsNumber(offset: number): number {
    // Read as BigInt then convert — sufficient for feature counts up to ~9e15
    const lo = this.view.getUint32(offset, true);
    const hi = this.view.getInt32(offset + 4, true);
    return hi * 0x100000000 + lo;
  }

  /**
   * Read an unsigned 64-bit integer as a JavaScript `number`.
   *
   * The value is reconstructed from two 32-bit halves. Precision is
   * maintained for values up to `Number.MAX_SAFE_INTEGER` (2^53 - 1).
   *
   * @param offset - Byte offset relative to the start of the view.
   * @returns The `uint64` value approximated as a `number`.
   */
  readUint64AsNumber(offset: number): number {
    const lo = this.view.getUint32(offset, true);
    const hi = this.view.getUint32(offset + 4, true);
    return hi * 0x100000000 + lo;
  }

  // ─── String reads ─────────────────────────────────────────────────────

  /**
   * Read a FlatBuffers-encoded UTF-8 string at the given byte offset.
   *
   * FlatBuffers strings are stored as a `uint32` length prefix followed by
   * the raw UTF-8 bytes (no null terminator is included in the length).
   *
   * @param offset - Byte offset of the string's length prefix, relative to
   *   the start of the view.
   * @returns The decoded string.
   */
  readString(offset: number): string {
    // Strings in FlatBuffers: uint32 length prefix, then UTF-8 bytes
    const len = this.view.getUint32(offset, true);
    const start = this.bytes.byteOffset + (this.view.byteOffset - this.bytes.byteOffset) + offset + 4;
    return new TextDecoder().decode(
      new Uint8Array(this.bytes.buffer, start, len),
    );
  }

  // ─── FlatBuffer Table navigation ──────────────────────────────────────

  /**
   * Read the root table offset from position 0 of the buffer.
   *
   * The first 4 bytes of a FlatBuffer are a `uint32` relative offset to the
   * root table.
   *
   * @returns Absolute byte offset of the root table within the buffer.
   */
  rootTableOffset(): number {
    return this.readUint32(0);
  }

  /**
   * Resolve the vtable for a table at the given position.
   *
   * A FlatBuffer table begins with a signed 32-bit offset (soffset) that
   * points backwards to its vtable.
   *
   * @param tablePos - Absolute byte offset of the table within the buffer.
   * @returns Absolute byte offset of the vtable.
   */
  vtableOffset(tablePos: number): number {
    // Table starts with a signed offset to its vtable
    const soffset = this.readInt32(tablePos);
    return tablePos - soffset;
  }

  /**
   * Get the byte offset of a field within a table, using the vtable.
   *
   * The vtable layout is:
   * ```
   * [uint16 vtable_size, uint16 table_data_size, uint16 field0_offset, ...]
   * ```
   *
   * @param tablePos - Absolute byte offset of the table within the buffer.
   * @param fieldIndex - Zero-based field number as defined in the schema.
   * @returns Absolute byte offset of the field data, or `0` if the field is
   *   absent from this table instance.
   */
  fieldOffset(tablePos: number, fieldIndex: number): number {
    const vtable = this.vtableOffset(tablePos);
    const vtableSize = this.readUint16(vtable);
    // vtable layout: [uint16 vtable_size, uint16 table_data_size, uint16 field0_offset, uint16 field1_offset, ...]
    const slotOffset = 4 + fieldIndex * 2; // 4 bytes for the two uint16 header fields
    if (slotOffset >= vtableSize) return 0; // field not present
    const fieldOff = this.readUint16(vtable + slotOffset);
    if (fieldOff === 0) return 0; // field not present
    return tablePos + fieldOff;
  }

  /**
   * Follow an indirect (relative) offset to obtain an absolute position.
   *
   * Used for navigating to vectors, strings, and sub-tables, all of which
   * are stored as `uint32` relative forward offsets.
   *
   * @param pos - Byte offset where the relative offset is stored.
   * @returns Absolute byte offset of the referenced data.
   */
  indirect(pos: number): number {
    return pos + this.readUint32(pos);
  }

  /**
   * Read the element count of a FlatBuffers vector.
   *
   * Vectors are stored as a `uint32` length prefix followed by tightly
   * packed elements.
   *
   * @param vectorOffset - Absolute byte offset of the vector (its length prefix).
   * @returns Number of elements in the vector.
   */
  vectorLen(vectorOffset: number): number {
    return this.readUint32(vectorOffset);
  }

  /**
   * Get the byte offset of the first element in a FlatBuffers vector.
   *
   * @param vectorOffset - Absolute byte offset of the vector (its length prefix).
   * @returns Byte offset of element 0 (immediately after the 4-byte length prefix).
   */
  vectorStart(vectorOffset: number): number {
    return vectorOffset + 4;
  }

  // ─── Typed array reads ────────────────────────────────────────────────

  /**
   * Read a contiguous sequence of `float64` values into a `Float64Array`.
   *
   * When the source data is 8-byte aligned, a direct typed array view is
   * returned (zero-copy). Otherwise, values are copied element-by-element
   * through a `DataView` to guarantee correct decoding regardless of
   * alignment.
   *
   * **Note:** callers that mutate the returned array in-place (e.g.
   * {@link projectToMercator}) will modify the underlying buffer when the
   * fast path is taken. This is intentional — it avoids an allocation for
   * coordinate arrays that are projected once and then discarded.
   *
   * @param offset - Byte offset of the first `float64`, relative to the view.
   * @param count - Number of `float64` elements to read.
   * @returns A `Float64Array` of length `count` — either a zero-copy view
   *   (when aligned) or a freshly allocated copy.
   */
  readFloat64Array(offset: number, count: number): Float64Array {
    const byteOffset = this.bytes.byteOffset + (this.view.byteOffset - this.bytes.byteOffset) + offset;

    // Fast path: direct view when 8-byte aligned
    if (byteOffset % 8 === 0) {
      return new Float64Array(this.bytes.buffer, byteOffset, count);
    }

    // Slow path: unaligned — copy element-by-element via DataView
    const result = new Float64Array(count);
    const view = new DataView(this.bytes.buffer, byteOffset, count * 8);
    for (let i = 0; i < count; i++) {
      result[i] = view.getFloat64(i * 8, true);
    }
    return result;
  }

  /**
   * Return a `Uint8Array` view over a range of the underlying buffer.
   *
   * No data is copied; the returned array shares the same `ArrayBuffer`.
   *
   * @param offset - Byte offset relative to the start of the view.
   * @param length - Number of bytes to include.
   * @returns A `Uint8Array` slice of the underlying buffer.
   */
  readBytes(offset: number, length: number): Uint8Array {
    const byteOffset = this.bytes.byteOffset + (this.view.byteOffset - this.bytes.byteOffset) + offset;
    return new Uint8Array(this.bytes.buffer, byteOffset, length);
  }

  /**
   * Read a contiguous sequence of `uint32` values into a `Uint32Array`.
   *
   * When the source data is 4-byte aligned, a direct typed array view is
   * returned (zero-copy). Otherwise, values are read individually through
   * the `DataView` to guarantee correct decoding.
   *
   * @param offset - Byte offset of the first `uint32`, relative to the view.
   * @param count - Number of `uint32` elements to read.
   * @returns A `Uint32Array` of length `count` — either a zero-copy view
   *   (when aligned) or a freshly allocated copy.
   */
  readUint32Array(offset: number, count: number): Uint32Array {
    const byteOffset = this.bytes.byteOffset + (this.view.byteOffset - this.bytes.byteOffset) + offset;

    // Fast path: direct view when 4-byte aligned
    if (byteOffset % 4 === 0) {
      return new Uint32Array(this.bytes.buffer, byteOffset, count);
    }

    // Slow path: unaligned — copy element-by-element
    const result = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = this.readUint32(offset + i * 4);
    }
    return result;
  }
}

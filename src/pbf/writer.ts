/**
 * @module pbf/writer
 *
 * Minimal Protocol Buffer binary writer for encoding MVT tiles.
 *
 * Implements just enough of the protobuf encoding specification to serialize
 * the MVT 2.1 message schema. The writer manages an auto-growing byte buffer
 * and supports the following protobuf wire types:
 *
 * | Wire Type | ID | Encoding             | Used For                                 |
 * |-----------|----|----------------------|------------------------------------------|
 * | VARINT    |  0 | Variable-length int  | uint32, uint64, bool, enum, sint (zigzag) |
 * | I64       |  1 | Fixed 64-bit         | double                                   |
 * | LEN       |  2 | Length-delimited     | string, bytes, nested messages, packed repeated |
 * | I32       |  5 | Fixed 32-bit         | float                                    |
 *
 * Nested messages are written using a begin/end pattern: {@link PbfWriter.beginMessage}
 * reserves a 5-byte length placeholder, and {@link PbfWriter.endMessage} patches
 * the actual length and shifts the payload to eliminate unused placeholder bytes.
 *
 * @see {@link https://protobuf.dev/programming-guides/encoding/ | Protobuf Encoding Guide}
 */

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

const INITIAL_SIZE = 8192;
const textEncoder = new TextEncoder();

/**
 * A low-level Protocol Buffer binary writer optimized for MVT tile encoding.
 *
 * The writer maintains an internal byte buffer that grows automatically as
 * data is appended. Nested messages are supported via a stack-based
 * begin/end pattern that patches length prefixes after the message body
 * has been written.
 *
 * @example
 * ```ts
 * const writer = new PbfWriter();
 *
 * // Write a simple message with a string field (field 1) and a varint field (field 2)
 * writer.writeStringField(1, "hello");
 * writer.writeVarintField(2, 42);
 *
 * // Write a nested message on field 3
 * writer.beginMessage(3);
 * writer.writeVarintField(1, 100);
 * writer.endMessage();
 *
 * const bytes = writer.finish();
 * ```
 */
export class PbfWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos: number = 0;

  /** Stack of length placeholder positions for nested messages. */
  private lengthStack: number[] = [];

  /**
   * Create a new PBF writer with an optional initial buffer size.
   *
   * @param initialSize - Initial byte buffer capacity. The buffer grows
   *   automatically by doubling when more space is needed. Defaults to 8192.
   */
  constructor(initialSize: number = INITIAL_SIZE) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
  }

  // ─── Varint encoding ────────────────────────────────────────────────

  /**
   * Write an unsigned varint (variable-length integer) to the buffer.
   *
   * Positive values use standard base-128 encoding (1--5 bytes for 32-bit
   * values). Negative values are sign-extended to 64 bits and encoded as
   * 10-byte varints per the protobuf specification.
   *
   * @param val - Unsigned integer value to encode. Negative values are
   *   handled as 64-bit two's complement.
   */
  writeVarint(val: number): void {
    if (val < 0) {
      // Negative numbers in protobuf varint are 10 bytes (sign-extended to 64 bits)
      // For our use case this shouldn't happen — use writeSVarint for signed values
      this.ensure(10);
      this.pos = writeBigVarint(val, this.buf, this.pos);
      return;
    }
    this.ensure(5);
    while (val > 0x7f) {
      this.buf[this.pos++] = (val & 0x7f) | 0x80;
      val >>>= 7;
    }
    this.buf[this.pos++] = val;
  }

  /**
   * Write a signed varint using zigzag encoding.
   *
   * Zigzag encoding maps signed integers to unsigned integers so that
   * small absolute values produce small varints:
   * `0 -> 0, -1 -> 1, 1 -> 2, -2 -> 3, ...`
   *
   * @param val - Signed 32-bit integer value to encode.
   */
  writeSVarint(val: number): void {
    // Zigzag encode, then write as varint
    this.writeVarint((val << 1) ^ (val >> 31));
  }

  // ─── Fixed-width types ──────────────────────────────────────────────

  /**
   * Write a 32-bit IEEE 754 float in little-endian byte order.
   *
   * @param val - Float value to encode.
   */
  writeFloat(val: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, val, true);
    this.pos += 4;
  }

  /**
   * Write a 64-bit IEEE 754 double in little-endian byte order.
   *
   * @param val - Double value to encode.
   */
  writeDouble(val: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, val, true);
    this.pos += 8;
  }

  // ─── String / bytes ─────────────────────────────────────────────────

  /**
   * Write a UTF-8 length-delimited string (varint length prefix followed
   * by the encoded bytes).
   *
   * @param str - String value to encode.
   */
  writeString(str: string): void {
    const encoded = textEncoder.encode(str);
    this.writeVarint(encoded.length);
    this.ensure(encoded.length);
    this.buf.set(encoded, this.pos);
    this.pos += encoded.length;
  }

  /**
   * Write a length-delimited byte array (varint length prefix followed
   * by the raw bytes).
   *
   * @param data - Raw byte data to encode.
   */
  writeBytes(data: Uint8Array): void {
    this.writeVarint(data.length);
    this.ensure(data.length);
    this.buf.set(data, this.pos);
    this.pos += data.length;
  }

  // ─── Field-level writes ─────────────────────────────────────────────

  /**
   * Write a complete varint field (tag + value) with wire type 0.
   *
   * @param fieldNum - Protobuf field number.
   * @param val - Unsigned integer value.
   */
  writeVarintField(fieldNum: number, val: number): void {
    this.writeTag(fieldNum, WIRE_VARINT);
    this.writeVarint(val);
  }

  /**
   * Write a complete signed varint field (tag + zigzag-encoded value)
   * with wire type 0.
   *
   * @param fieldNum - Protobuf field number.
   * @param val - Signed integer value.
   */
  writeSVarintField(fieldNum: number, val: number): void {
    this.writeTag(fieldNum, WIRE_VARINT);
    this.writeSVarint(val);
  }

  /**
   * Write a complete 32-bit float field (tag + value) with wire type 5.
   *
   * @param fieldNum - Protobuf field number.
   * @param val - Float value.
   */
  writeFloatField(fieldNum: number, val: number): void {
    this.writeTag(fieldNum, WIRE_I32);
    this.writeFloat(val);
  }

  /**
   * Write a complete 64-bit double field (tag + value) with wire type 1.
   *
   * @param fieldNum - Protobuf field number.
   * @param val - Double value.
   */
  writeDoubleField(fieldNum: number, val: number): void {
    this.writeTag(fieldNum, WIRE_I64);
    this.writeDouble(val);
  }

  /**
   * Write a complete length-delimited string field (tag + length + UTF-8 bytes)
   * with wire type 2.
   *
   * @param fieldNum - Protobuf field number.
   * @param val - String value.
   */
  writeStringField(fieldNum: number, val: string): void {
    this.writeTag(fieldNum, WIRE_LEN);
    this.writeString(val);
  }

  /**
   * Write a complete boolean field encoded as a varint (0 or 1) with
   * wire type 0.
   *
   * @param fieldNum - Protobuf field number.
   * @param val - Boolean value.
   */
  writeBoolField(fieldNum: number, val: boolean): void {
    this.writeVarintField(fieldNum, val ? 1 : 0);
  }

  // ─── Packed repeated fields ─────────────────────────────────────────

  /**
   * Write a packed repeated uint32 field.
   *
   * All values are concatenated into a single length-delimited payload
   * (wire type 2), which is more compact than writing each value as a
   * separate field. The byte length of all varints is pre-calculated to
   * write the length prefix in a single pass.
   *
   * No-ops if `values` is empty (packed fields omit the field entirely
   * when there are zero elements).
   *
   * @param fieldNum - Protobuf field number.
   * @param values - Array or typed array of unsigned integer values.
   */
  writePackedVarint(fieldNum: number, values: number[] | Uint32Array): void {
    if (values.length === 0) return;

    this.writeTag(fieldNum, WIRE_LEN);

    // Calculate the byte length of all varints first
    let byteLen = 0;
    for (let i = 0; i < values.length; i++) {
      byteLen += varintSize(values[i]);
    }

    this.writeVarint(byteLen);
    this.ensure(byteLen);

    for (let i = 0; i < values.length; i++) {
      this.writeVarint(values[i]);
    }
  }

  // ─── Nested messages ────────────────────────────────────────────────

  /**
   * Start writing a nested message for the given field.
   *
   * Writes the field tag with wire type LEN and reserves a 5-byte
   * placeholder for the message length (the maximum varint size for a
   * uint32). The current buffer position is pushed onto an internal
   * stack so that {@link endMessage} can patch the length and reclaim
   * any unused placeholder bytes.
   *
   * Every call to `beginMessage` **must** be paired with a corresponding
   * call to {@link endMessage}.
   *
   * @param fieldNum - Protobuf field number for the nested message.
   */
  beginMessage(fieldNum: number): void {
    this.writeTag(fieldNum, WIRE_LEN);
    // Write a placeholder for the length (we'll fill it in later)
    // We reserve 5 bytes (max varint size for uint32)
    this.ensure(5);
    this.lengthStack.push(this.pos);
    this.pos += 5; // placeholder
  }

  /**
   * Finalize the most recently started nested message.
   *
   * Calculates the actual byte length of the message body written since
   * the matching {@link beginMessage} call, writes the length as a varint
   * at the reserved placeholder position, and shifts the message data
   * left to eliminate any unused placeholder bytes (the placeholder
   * reserves 5 bytes but the actual length varint may be shorter).
   *
   * @throws {Error} Implicitly fails if called without a matching
   *   `beginMessage` (the internal length stack will be empty).
   */
  endMessage(): void {
    const placeholderPos = this.lengthStack.pop()!;
    const messageLen = this.pos - placeholderPos - 5;

    // Calculate actual varint size needed for the length
    const lenSize = varintSize(messageLen);

    if (lenSize < 5) {
      // Shift message data left to fill the gap
      const shift = 5 - lenSize;
      this.buf.copyWithin(placeholderPos + lenSize, placeholderPos + 5, this.pos);
      this.pos -= shift;
    }

    // Write the length varint at the placeholder position
    let val = messageLen;
    let p = placeholderPos;
    while (val > 0x7f) {
      this.buf[p++] = (val & 0x7f) | 0x80;
      val >>>= 7;
    }
    this.buf[p] = val;
  }

  // ─── Output ─────────────────────────────────────────────────────────

  /**
   * Finalize and return the encoded buffer trimmed to the actual data size.
   *
   * The returned `Uint8Array` is a subarray view of the internal buffer,
   * so it remains valid only as long as the writer is not reused.
   *
   * @returns A `Uint8Array` containing the complete PBF-encoded data.
   */
  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }

  // ─── Internal ───────────────────────────────────────────────────────

  /**
   * Write a protobuf field tag (field number + wire type).
   *
   * @param fieldNum - Protobuf field number.
   * @param wireType - Wire type constant (0, 1, 2, or 5).
   */
  private writeTag(fieldNum: number, wireType: number): void {
    this.writeVarint((fieldNum << 3) | wireType);
  }

  /**
   * Ensure that at least `bytes` bytes of capacity remain in the buffer,
   * growing if necessary.
   *
   * @param bytes - Number of bytes that will be written next.
   */
  private ensure(bytes: number): void {
    while (this.pos + bytes > this.buf.length) {
      this.grow();
    }
  }

  /**
   * Double the internal buffer capacity, preserving existing data and
   * re-creating the associated `DataView`.
   */
  private grow(): void {
    const newBuf = new Uint8Array(this.buf.length * 2);
    newBuf.set(this.buf);
    this.buf = newBuf;
    this.view = new DataView(this.buf.buffer);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the number of bytes needed to encode a value as a varint.
 *
 * Negative values require 10 bytes (64-bit sign extension). Non-negative
 * values use 1--5 bytes depending on magnitude.
 *
 * @param val - Integer value to measure.
 * @returns Byte count in the range [1, 10].
 */
function varintSize(val: number): number {
  if (val < 0) return 10;
  if (val < 0x80) return 1;
  if (val < 0x4000) return 2;
  if (val < 0x200000) return 3;
  if (val < 0x10000000) return 4;
  return 5;
}

/**
 * Encode a negative number as a 64-bit two's complement varint.
 *
 * Protobuf represents negative integers as 10-byte varints by
 * sign-extending to 64 bits. This function splits the value into
 * low and high 32-bit halves and encodes them using standard base-128
 * continuation bits.
 *
 * @param val - Negative integer to encode.
 * @param buf - Target byte buffer.
 * @param pos - Starting write position in `buf`.
 * @returns The new write position after encoding.
 */
function writeBigVarint(val: number, buf: Uint8Array, pos: number): number {
  // Handle negative numbers as 64-bit two's complement
  const lo = val >>> 0;
  const hi = Math.floor(val / 0x100000000) >>> 0;

  let loPart = lo;
  let hiPart = hi;

  while (hiPart > 0 || loPart > 0x7f) {
    buf[pos++] = (loPart & 0x7f) | 0x80;
    loPart = ((hiPart & 0x7f) << 25) | (loPart >>> 7);
    hiPart >>>= 7;
  }
  buf[pos++] = loPart;
  return pos;
}

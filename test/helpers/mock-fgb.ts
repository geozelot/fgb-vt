/**
 * Build a minimal valid FGB file as a Uint8Array.
 * This constructs raw FlatBuffer bytes for the header so that
 * parseHeader() can decode it correctly.
 */
export interface MockFgbOptions {
  geometryType?: number;   // GeomType enum value, default 1 (Point)
  featuresCount?: number;  // default 10
  indexNodeSize?: number;  // default 16
  bbox?: [number, number, number, number]; // [minX, minY, maxX, maxY]
  columns?: Array<{ name: string; type: number }>; // ColumnMeta-like
}

export function buildMockFgb(opts: MockFgbOptions = {}): Uint8Array {
  const geomType = opts.geometryType ?? 1;
  const featuresCount = opts.featuresCount ?? 10;
  const indexNodeSize = opts.indexNodeSize ?? 16;
  const bbox = opts.bbox;
  const columns = opts.columns ?? [];

  // We'll build the FlatBuffer header payload bottom-up into a growing buffer.
  // Then wrap it with magic + size prefix.

  const parts: Uint8Array[] = [];
  let totalFbSize = 0;

  // Track where we'll place things relative to the FB start
  // We build it linearly: [root_offset, vtable, table_data, extra_data...]

  // ─── Pre-compute column tables ──────────────────────────────────────
  // Each column is a sub-table. We need to know their positions relative to
  // the columns vector.
  // Column schema: field 0 = name (string), field 1 = type (uint8)

  // ─── Build the FlatBuffer ──────────────────────────────────────────
  // We'll use a simple linear layout:
  //
  // [root_offset: 4]
  // [vtable: 24]
  // [table: table_data_size]
  // [envelope_vector?]
  // [columns_vector + column_tables + column_strings?]

  // VTable: 10 field slots (fields 0-9)
  const vtableFieldCount = 10;
  const vtableSize = 4 + vtableFieldCount * 2; // 24 bytes
  const vtableStart = 4; // after root_offset

  // Table starts right after vtable
  const tableStart = vtableStart + vtableSize; // 28

  // Table inline data layout (offsets from tableStart):
  // offset 0: soffset (int32) → always 4 bytes
  // offset 4: geometry_type (uint8) → field 2
  // offset 5: padding
  // offset 6: index_node_size (uint16) → field 9
  // offset 8: features_count (uint64) → field 8  (8-byte aligned from table start + 4 soffset = ... hmm)
  // offset 16: envelope indirect (uint32) → field 1 (if bbox present)
  // offset 20: columns indirect (uint32) → field 7 (if columns present)
  const tableDataSize = 24; // 4 (soffset) + 1 (geom) + 1 (pad) + 2 (ins) + 8 (fc) + 4 (pad/align) + 4 (env) + 4 (cols) = wait, let me recount

  // Actually:
  // byte 0-3 of table:   soffset (int32)
  // byte 4:              geometry_type (field 2 → offset 4)
  // byte 5:              padding
  // byte 6-7:            index_node_size (field 9 → offset 6)
  // byte 8-15:           features_count (field 8 → offset 8)
  // byte 16-19:          envelope indirect offset (field 1 → offset 16)
  // byte 20-23:          columns indirect offset (field 7 → offset 20)
  // Total: 24 bytes
  const tableEnd = tableStart + tableDataSize;

  // Extra data starts after table
  let extraOffset = tableEnd;

  // ─── Envelope vector ────────────────────────────────────────────────
  let envVectorOffset = 0; // absolute offset in FB
  if (bbox) {
    envVectorOffset = extraOffset;
    extraOffset += 4 + 4 * 8; // uint32 length + 4 doubles
  }

  // ─── Columns vector + sub-tables ────────────────────────────────────
  let colsVectorOffset = 0;
  // For simplicity, build column data inline
  // Each column needs: [vtable(8 bytes)] [table(8 bytes)] [string data]
  // Column vtable: [vtableSize=8, tableDataSize=8, field0_off=4, field1_off=6]
  // Column table: [soffset(4), name_indirect_offset(uint32 at +4)]... wait this doesn't work.
  // Let me simplify: field 0 is a string (indirect), field 1 is a uint8 (inline)
  // Column table inline: soffset(4) + type(uint8 at +4) + padding(3) + name_indirect(uint32 at +8)
  //
  // Actually this is getting complex. Let me use a simpler layout for columns.
  // Column vtable: size=8 bytes (4 header + 2 fields), [8, tableSize, nameOff, typeOff]
  // Column table: soffset(4), uint8 type at +4, padding(3), uint32 name_indirect at +8
  // tableSize = 12
  //
  // Actually for maximum simplicity, let me just set type at offset 4 (1 byte) and
  // name indirect at offset 8 (4 bytes). Column vtable size = 4 + 2*2 = 8.
  //
  // Hmm, this is getting very involved. Let me build column sub-tables from scratch.

  interface ColLayout {
    vtableOffset: number;
    tableOffset: number;
    nameStringOffset: number;
  }

  const colLayouts: ColLayout[] = [];

  if (columns.length > 0) {
    colsVectorOffset = extraOffset;
    extraOffset += 4 + columns.length * 4; // vector length + offsets to column tables

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const nameBytes = new TextEncoder().encode(col.name);

      // Column vtable (8 bytes: size=8, tableDataSize=?, field0_off, field1_off)
      const colVtableOffset = extraOffset;
      extraOffset += 8;

      // Column table
      const colTableOffset = extraOffset;
      // Table: soffset(4) + type(1) + padding(3) + name_indirect(4) = 12
      extraOffset += 12;

      // Name string: length(4) + data + null terminator
      const colNameOffset = extraOffset;
      extraOffset += 4 + nameBytes.length + 1;
      // Align to 4 bytes
      extraOffset = (extraOffset + 3) & ~3;

      colLayouts.push({
        vtableOffset: colVtableOffset,
        tableOffset: colTableOffset,
        nameStringOffset: colNameOffset,
      });
    }
  }

  const fbSize = extraOffset;

  // ─── Write the FlatBuffer ──────────────────────────────────────────
  const fb = new Uint8Array(fbSize);
  const fbView = new DataView(fb.buffer);

  // Root offset (uint32 at 0): points to table
  fbView.setUint32(0, tableStart, true);

  // VTable at vtableStart (4)
  fbView.setUint16(vtableStart, vtableSize, true);       // vtable_size
  fbView.setUint16(vtableStart + 2, tableDataSize, true); // table_data_size

  // Field offsets in vtable (slots 0-9):
  // field 0 (name):            0 (absent)
  // field 1 (envelope):        16 if bbox present, else 0
  // field 2 (geometry_type):   4
  // field 3-6:                 0
  // field 7 (columns):         20 if columns present, else 0
  // field 8 (features_count):  8
  // field 9 (index_node_size): 6

  const fieldSlotBase = vtableStart + 4;
  fbView.setUint16(fieldSlotBase + 0, 0, true);                    // field 0
  fbView.setUint16(fieldSlotBase + 2, bbox ? 16 : 0, true);       // field 1
  fbView.setUint16(fieldSlotBase + 4, 4, true);                    // field 2
  fbView.setUint16(fieldSlotBase + 6, 0, true);                    // field 3
  fbView.setUint16(fieldSlotBase + 8, 0, true);                    // field 4
  fbView.setUint16(fieldSlotBase + 10, 0, true);                   // field 5
  fbView.setUint16(fieldSlotBase + 12, 0, true);                   // field 6
  fbView.setUint16(fieldSlotBase + 14, columns.length > 0 ? 20 : 0, true); // field 7
  fbView.setUint16(fieldSlotBase + 16, 8, true);                   // field 8
  fbView.setUint16(fieldSlotBase + 18, 6, true);                   // field 9

  // Table at tableStart (28)
  // soffset: tableStart - vtableStart = 28 - 4 = 24
  fbView.setInt32(tableStart, tableStart - vtableStart, true);

  // geometry_type at tableStart + 4
  fbView.setUint8(tableStart + 4, geomType);

  // index_node_size at tableStart + 6
  fbView.setUint16(tableStart + 6, indexNodeSize, true);

  // features_count at tableStart + 8 (uint64 as two uint32s)
  fbView.setUint32(tableStart + 8, featuresCount, true);
  fbView.setUint32(tableStart + 12, 0, true); // high 32 bits

  // envelope indirect offset at tableStart + 16
  if (bbox && envVectorOffset > 0) {
    // indirect offset: relative from this position to the vector
    fbView.setUint32(tableStart + 16, envVectorOffset - (tableStart + 16), true);
  }

  // columns indirect offset at tableStart + 20
  if (columns.length > 0 && colsVectorOffset > 0) {
    fbView.setUint32(tableStart + 20, colsVectorOffset - (tableStart + 20), true);
  }

  // ─── Envelope vector data ──────────────────────────────────────────
  if (bbox && envVectorOffset > 0) {
    fbView.setUint32(envVectorOffset, 4, true); // length = 4 doubles
    fbView.setFloat64(envVectorOffset + 4, bbox[0], true);      // minX
    fbView.setFloat64(envVectorOffset + 12, bbox[1], true);     // minY
    fbView.setFloat64(envVectorOffset + 20, bbox[2], true);     // maxX
    fbView.setFloat64(envVectorOffset + 28, bbox[3], true);     // maxY
  }

  // ─── Columns vector + tables ───────────────────────────────────────
  if (columns.length > 0 && colsVectorOffset > 0) {
    // Vector header: length
    fbView.setUint32(colsVectorOffset, columns.length, true);

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const layout = colLayouts[i];
      const nameBytes = new TextEncoder().encode(col.name);

      // Vector element: indirect offset from element position to column table
      const elemPos = colsVectorOffset + 4 + i * 4;
      fbView.setUint32(elemPos, layout.tableOffset - elemPos, true);

      // Column vtable (8 bytes)
      // vtable_size = 8, table_data_size = 12
      // field 0 (name) offset = 8 (indirect at table+8)
      // field 1 (type) offset = 4 (inline at table+4)
      fbView.setUint16(layout.vtableOffset, 8, true);     // vtable_size
      fbView.setUint16(layout.vtableOffset + 2, 12, true); // table_data_size
      fbView.setUint16(layout.vtableOffset + 4, 8, true);  // field 0 offset (name)
      fbView.setUint16(layout.vtableOffset + 6, 4, true);  // field 1 offset (type)

      // Column table (12 bytes)
      // soffset at +0: tableOffset - vtableOffset
      fbView.setInt32(layout.tableOffset, layout.tableOffset - layout.vtableOffset, true);
      // type at +4
      fbView.setUint8(layout.tableOffset + 4, col.type);
      // name indirect at +8: relative offset from this position to name string
      fbView.setUint32(layout.tableOffset + 8, layout.nameStringOffset - (layout.tableOffset + 8), true);

      // Name string: uint32 length + bytes + null
      fbView.setUint32(layout.nameStringOffset, nameBytes.length, true);
      fb.set(nameBytes, layout.nameStringOffset + 4);
      fb[layout.nameStringOffset + 4 + nameBytes.length] = 0; // null terminator
    }
  }

  // ─── Wrap with FGB magic + size prefix ─────────────────────────────
  const magic = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x00]);
  const sizePrefix = new Uint8Array(4);
  new DataView(sizePrefix.buffer).setUint32(0, fbSize, true);

  const fullHeader = new Uint8Array(8 + 4 + fbSize);
  fullHeader.set(magic, 0);
  fullHeader.set(sizePrefix, 8);
  fullHeader.set(fb, 12);

  return fullHeader;
}

/**
 * Compute spatial index size (same algorithm as in header.ts).
 */
export function calcMockIndexSize(featuresCount: number, nodeSize: number): number {
  if (featuresCount === 0 || nodeSize === 0) return 0;
  const NODE_ITEM_BYTE_SIZE = 40;
  let n = featuresCount;
  let totalNodes = n;
  while (n > 1) {
    n = Math.ceil(n / nodeSize);
    totalNodes += n;
  }
  return totalNodes * NODE_ITEM_BYTE_SIZE;
}

/**
 * Mock Connector that serves pre-built FGB files from memory.
 */
export class MockConnector {
  private files = new Map<string, Uint8Array>();

  addFile(path: string, data: Uint8Array): void {
    this.files.set(path, data);
  }

  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) throw new Error(`MockConnector: file not found: ${path}`);

    // Return zeros beyond file end (simulates index/feature reads)
    if (offset >= data.length) {
      return new Uint8Array(length);
    }

    const end = Math.min(offset + length, data.length);
    const result = new Uint8Array(length);
    result.set(data.subarray(offset, end));
    return result;
  }

  async readRanges(
    path: string,
    ranges: ReadonlyArray<{ offset: number; length: number }>,
  ): Promise<Uint8Array[]> {
    return Promise.all(ranges.map(r => this.read(path, r.offset, r.length)));
  }

  async close(): Promise<void> {}
}

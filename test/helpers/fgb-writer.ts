/**
 * Minimal FlatGeobuf writer for tests that need structures GDAL does not
 * produce: per-feature column schemas, T/TM vectors, unknown geometry
 * types, WKT-only CRSs and invalid envelopes.
 *
 * Files are written without a spatial index (`index_node_size` = 0), so the
 * reader scans them.
 */

/** A FlatBuffer table: field id → value. */
export interface FbTable { [field: number]: FbValue | undefined }

/** Values the builder can serialize. */
export type FbValue =
  | { u8: number }
  | { u16: number }
  | { i32: number }
  | { u64: number }
  | { str: string }
  | { bytes: Uint8Array }
  | { u32s: number[] }
  | { f64s: number[] }
  | { table: FbTable }
  | { tables: FbTable[] };

/** Serialize a FlatBuffer with `root` as its root table. */
export function buildFlatBuffer(root: FbTable): Uint8Array {
  const b = new Builder();
  b.u32(0);
  const rootPos = b.table(root);
  b.view.setUint32(0, rootPos, true);
  return b.finish();
}

/** A geometry, as the FlatGeobuf Geometry table's fields. */
export interface GeometrySpec {
  type?: number;
  xy?: number[];
  ends?: number[];
  z?: number[];
  m?: number[];
  t?: number[];
  tm?: number[];
  parts?: GeometrySpec[];
}

/** A column schema entry; types as in the FlatGeobuf `ColumnType` enum. */
export interface ColumnSpec { name: string; type: number }

/** A feature: geometry, encoded properties and an optional own schema. */
export interface FeatureSpec {
  geometry?: GeometrySpec;
  properties?: Uint8Array;
  columns?: ColumnSpec[];
}

/** Header fields of a test file. */
export interface FileSpec {
  geometryType?: number;
  columns?: ColumnSpec[];
  envelope?: number[];
  crs?: { org?: string; code?: number; codeString?: string; name?: string; wkt?: string };
  features: FeatureSpec[];
}

/** Write a complete FlatGeobuf file without spatial index. */
export function writeFgb(spec: FileSpec): Uint8Array {
  const header: FbTable = {
    2: { u8: spec.geometryType ?? 0 },
    8: { u64: spec.features.length },
    9: { u16: 0 }, // explicit: the schema default is 16
  };
  if (spec.envelope) header[1] = { f64s: spec.envelope };
  if (spec.columns) header[7] = { tables: spec.columns.map(columnTable) };
  if (spec.crs) {
    const crs: FbTable = {};
    if (spec.crs.org !== undefined) crs[0] = { str: spec.crs.org };
    if (spec.crs.code !== undefined) crs[1] = { i32: spec.crs.code };
    if (spec.crs.name !== undefined) crs[2] = { str: spec.crs.name };
    if (spec.crs.wkt !== undefined) crs[4] = { str: spec.crs.wkt };
    if (spec.crs.codeString !== undefined) crs[5] = { str: spec.crs.codeString };
    header[10] = { table: crs };
  }
  const headerBytes = buildFlatBuffer(header);

  const parts: Uint8Array[] = [];
  const magic = new Uint8Array([0x66, 0x67, 0x62, 0x03, 0x66, 0x67, 0x62, 0x01]);
  parts.push(magic, u32le(headerBytes.length), headerBytes);
  for (const f of spec.features) {
    const table: FbTable = {};
    if (f.geometry) table[0] = { table: geometryTable(f.geometry) };
    if (f.properties) table[1] = { bytes: f.properties };
    if (f.columns) table[2] = { tables: f.columns.map(columnTable) };
    const bytes = buildFlatBuffer(table);
    parts.push(u32le(bytes.length), bytes);
  }
  return concat(parts);
}

/** Property encoders: `[u16 column index][value]`. */
export const prop = {
  int: (col: number, v: number) => withIndex(col, 4, (d) => d.setInt32(0, v, true)),
  double: (col: number, v: number) => withIndex(col, 8, (d) => d.setFloat64(0, v, true)),
  string: (col: number, v: string) => {
    const s = new TextEncoder().encode(v);
    const out = withIndex(col, 4 + s.length, (d) => d.setUint32(0, s.length, true));
    out.set(s, 6);
    return out;
  },
  concat: (...p: Uint8Array[]) => concat(p),
};

function withIndex(col: number, size: number, write: (d: DataView) => void): Uint8Array {
  const out = new Uint8Array(2 + size);
  const d = new DataView(out.buffer);
  d.setUint16(0, col, true);
  write(new DataView(out.buffer, 2));
  return out;
}

function columnTable(c: ColumnSpec): FbTable {
  return { 0: { str: c.name }, 1: { u8: c.type } };
}

function geometryTable(g: GeometrySpec): FbTable {
  const t: FbTable = {};
  if (g.ends) t[0] = { u32s: g.ends };
  if (g.xy) t[1] = { f64s: g.xy };
  if (g.z) t[2] = { f64s: g.z };
  if (g.m) t[3] = { f64s: g.m };
  if (g.t) t[4] = { f64s: g.t };
  if (g.tm) t[5] = { f64s: g.tm };
  if (g.type !== undefined) t[6] = { u8: g.type };
  if (g.parts) t[7] = { tables: g.parts.map(geometryTable) };
  return t;
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/**
 * Front-to-back FlatBuffer builder: each table is written before its
 * children, so every offset points forward as the format requires.
 */
class Builder {
  buf = new Uint8Array(1024);
  view = new DataView(this.buf.buffer);
  pos = 0;

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  private reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  private align(n: number, extra = 0): void {
    while ((this.pos + extra) % n !== 0) this.u8(0);
  }

  u8(v: number): void { this.reserve(1); this.view.setUint8(this.pos, v); this.pos += 1; }
  u16(v: number): void { this.reserve(2); this.view.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v: number): void { this.reserve(4); this.view.setUint32(this.pos, v, true); this.pos += 4; }

  /** Write a table (vtable first, then the table, then its children). */
  table(t: FbTable): number {
    const ids = Object.keys(t).map(Number).filter((k) => t[k] !== undefined).sort((a, b) => a - b);
    const numFields = ids.length > 0 ? ids[ids.length - 1] + 1 : 0;

    // Table layout: soffset, then one 8-byte slot per field (simple, aligned)
    const slot = new Map<number, number>();
    ids.forEach((id, i) => slot.set(id, 8 + i * 8));
    const tableSize = 8 + ids.length * 8;

    this.align(2);
    const vtablePos = this.pos;
    this.u16(4 + 2 * numFields);
    this.u16(tableSize);
    for (let f = 0; f < numFields; f++) this.u16(slot.get(f) ?? 0);

    this.align(8);
    const tablePos = this.pos;
    this.reserve(tableSize);
    this.buf.fill(0, this.pos, this.pos + tableSize);
    this.view.setInt32(tablePos, tablePos - vtablePos, true);
    this.pos += tableSize;

    const children: Array<[number, FbValue]> = [];
    for (const id of ids) {
      const at = tablePos + slot.get(id)!;
      const v = t[id]!;
      if ('u8' in v) this.view.setUint8(at, v.u8);
      else if ('u16' in v) this.view.setUint16(at, v.u16, true);
      else if ('i32' in v) this.view.setInt32(at, v.i32, true);
      else if ('u64' in v) {
        this.view.setUint32(at, v.u64 % 2 ** 32, true);
        this.view.setUint32(at + 4, Math.floor(v.u64 / 2 ** 32), true);
      } else children.push([at, v]);
    }
    for (const [at, v] of children) {
      const target = this.value(v);
      this.view.setUint32(at, target - at, true);
    }
    return tablePos;
  }

  /** Write an offset-referenced value; returns its position. */
  private value(v: FbValue): number {
    if ('table' in v) return this.table(v.table);
    if ('str' in v) {
      const s = new TextEncoder().encode(v.str);
      this.align(4);
      const at = this.pos;
      this.u32(s.length);
      this.reserve(s.length + 1);
      this.buf.set(s, this.pos);
      this.pos += s.length;
      this.u8(0);
      return at;
    }
    if ('bytes' in v) {
      this.align(4);
      const at = this.pos;
      this.u32(v.bytes.length);
      this.reserve(v.bytes.length);
      this.buf.set(v.bytes, this.pos);
      this.pos += v.bytes.length;
      return at;
    }
    if ('u32s' in v) {
      this.align(4);
      const at = this.pos;
      this.u32(v.u32s.length);
      for (const n of v.u32s) this.u32(n);
      return at;
    }
    if ('f64s' in v) {
      this.align(8, 4); // data 8-byte aligned after the length
      const at = this.pos;
      this.u32(v.f64s.length);
      this.reserve(v.f64s.length * 8);
      for (const n of v.f64s) { this.view.setFloat64(this.pos, n, true); this.pos += 8; }
      return at;
    }
    if ('tables' in v) {
      this.align(4);
      const at = this.pos;
      this.u32(v.tables.length);
      const slots = v.tables.map(() => { const s = this.pos; this.u32(0); return s; });
      v.tables.forEach((t, i) => {
        const tp = this.table(t);
        this.view.setUint32(slots[i], tp - slots[i], true);
      });
      return at;
    }
    throw new Error('Unsupported FlatBuffer value');
  }
}

/**
 * @module types
 *
 * Shared type definitions for the fgb-vt pipeline.
 *
 * This module defines the data structures that flow between pipeline stages:
 *
 * - **Geometry enums** — FlatGeobuf and MVT geometry type constants
 * - **BBox** — axis-aligned bounding box used throughout spatial operations
 * - **RawFeature** — decoded FGB feature (flat coordinate arrays + properties)
 * - **FgbHeader** — parsed FGB file header with schema and index metadata
 * - **MvtFeature / MvtLayer** — intermediate MVT representation before PBF encoding
 * - **TileJSON** — TileJSON 3.0.0 metadata specification
 *
 * All coordinate arrays use the flat interleaved layout `[x0, y0, x1, y1, ...]`
 * to minimize allocations and improve cache locality.
 */

// ─── Geometry Types ─────────────────────────────────────────────────────────

/**
 * FlatGeobuf geometry type constants.
 *
 * These match the FlatGeobuf specification's `GeometryType` enum and are used
 * throughout the pipeline to dispatch type-specific logic (clipping, winding
 * order correction, MVT command encoding).
 */
export const enum GeomType {
  Unknown = 0,
  Point = 1,
  LineString = 2,
  Polygon = 3,
  MultiPoint = 4,
  MultiLineString = 5,
  MultiPolygon = 6,
}

/**
 * MVT geometry type constants per the Mapbox Vector Tile 2.1 specification.
 *
 * MVT collapses multi-geometry variants into their single counterparts
 * (e.g. both `Point` and `MultiPoint` become `POINT`).
 *
 * @see {@link https://github.com/mapbox/vector-tile-spec/blob/master/2.1/vector_tile.proto | MVT 2.1 Spec}
 */
export const enum MvtGeomType {
  POINT = 1,
  LINESTRING = 2,
  POLYGON = 3,
}

// ─── Bounding Box ───────────────────────────────────────────────────────────

/**
 * Axis-aligned bounding box.
 *
 * Used for WGS84 extents (longitude/latitude), mercator [0, 1] clip bounds,
 * and tile coordinate ranges throughout the pipeline.
 */
export interface BBox {
  /** Minimum X (western longitude or left edge). */
  minX: number;
  /** Minimum Y (southern latitude or bottom edge). */
  minY: number;
  /** Maximum X (eastern longitude or right edge). */
  maxX: number;
  /** Maximum Y (northern latitude or top edge). */
  maxY: number;
}

// ─── Raw Feature (FGB decode output) ────────────────────────────────────────

/**
 * A property value decoded from an FGB feature.
 *
 * Maps to the FlatGeobuf column types: numeric types → `number`,
 * string/json/datetime → `string`, bool → `boolean`, binary → `Uint8Array`.
 * Nullable columns may produce `null`.
 */
export type PropertyValue = string | number | boolean | Uint8Array | null;

/**
 * A decoded FlatGeobuf feature with flat coordinate arrays.
 *
 * This is the intermediate representation between FGB decoding and the
 * geometry pipeline. Coordinates start in WGS84 and are projected to
 * mercator [0, 1] space in-place during the pipeline.
 */
export interface RawFeature {
  /** Geometry type from the FGB header or per-feature override. */
  type: GeomType;
  /**
   * Flat interleaved coordinate array: `[x0, y0, x1, y1, ...]`.
   *
   * Initially WGS84 (longitude, latitude); mutated in-place to mercator
   * [0, 1] space by {@link projectToMercator}.
   */
  xy: Float64Array;
  /**
   * Ring/part end indices as coordinate-pair counts (not byte offsets).
   *
   * For a polygon with an exterior ring of 5 points and a hole of 4 points:
   * `Uint32Array([5, 9])`. `null` for single-ring geometries or points.
   */
  ends: Uint32Array | null;
  /**
   * For MultiPolygon geometries decoded from nested parts: indices into
   * the `ends` array that mark the start of each polygon's exterior
   * ring. Rings between consecutive `parts` entries belong to the same
   * polygon (first ring is exterior, subsequent rings are holes).
   *
   * Example: a MultiPolygon with 3 polygon parts where part 0 has an
   * exterior + 1 hole, part 1 has just an exterior, and part 2 has an
   * exterior + 2 holes would have `ends` with 6 entries and
   * `parts = Uint32Array([0, 2, 3])`.
   *
   * `null` for non-MultiPolygon types and for single-part MultiPolygons,
   * where the simple convention applies: ring 0 is exterior, the rest
   * are holes.
   */
  parts: Uint32Array | null;
  /** Decoded property key-value pairs. */
  properties: Map<string, PropertyValue>;
  /** FGB feature ID, or `null` if the feature has no ID. */
  id: number | null;
}

// ─── FGB Column Schema ──────────────────────────────────────────────────────

/**
 * FlatGeobuf column (property) type constants.
 *
 * These correspond to the `ColumnType` enum in the FlatGeobuf specification
 * and determine how property bytes are decoded.
 *
 * @see {@link https://flatgeobuf.org/ | FlatGeobuf Specification}
 */
export const enum ColumnType {
  Byte = 0,
  UByte = 1,
  Bool = 2,
  Short = 3,
  UShort = 4,
  Int = 5,
  UInt = 6,
  Long = 7,
  ULong = 8,
  Float = 9,
  Double = 10,
  String = 11,
  Json = 12,
  DateTime = 13,
  Binary = 14,
}

/**
 * Schema metadata for a single FGB column (property field).
 */
export interface ColumnMeta {
  /** Column name as declared in the FGB header. */
  name: string;
  /** Data type determining the binary encoding of values. */
  type: ColumnType;
  /** Whether the column permits null values. */
  nullable: boolean;
}

// ─── FGB Header ─────────────────────────────────────────────────────────────

/**
 * Parsed FlatGeobuf file header.
 *
 * Contains schema metadata (geometry type, columns), dataset-level bounding
 * box, feature count, and byte-offset information needed to locate the spatial
 * index and feature data within the file.
 */
export interface FgbHeader {
  /** Geometry type shared by all features in this file. */
  geometryType: GeomType;
  /** Column (property) schema definitions. */
  columns: ColumnMeta[];
  /** Total number of features in the file. */
  featuresCount: number;
  /** Hilbert R-tree node fan-out size (0 = no spatial index). */
  indexNodeSize: number;
  /** Dataset bounding box in WGS84, or `null` if not present in the header. */
  bbox: BBox | null;
  /** Byte offset where the packed Hilbert R-tree spatial index starts. */
  indexOffset: number;
  /** Byte size of the spatial index. */
  indexSize: number;
  /** Byte offset where length-prefixed feature data begins. */
  featuresOffset: number;
  /** Total header size in bytes (magic + size prefix + FlatBuffer payload). */
  headerSize: number;
}

// ─── MVT Types ──────────────────────────────────────────────────────────────

/**
 * A tagged MVT property value.
 *
 * MVT stores values in a typed oneof: string, double, float, int64, uint64,
 * sint64, or bool. We collapse float/double into `double` and all integer
 * variants into `int` (signed) or `uint` (unsigned).
 */
export type MvtValue =
  | { type: 'string'; value: string }
  | { type: 'double'; value: number }
  | { type: 'int'; value: number }
  | { type: 'uint'; value: number }
  | { type: 'bool'; value: boolean };

/**
 * A single feature within an MVT layer, ready for PBF encoding.
 */
export interface MvtFeature {
  /** Feature ID, or `null` if absent. Written as `uint64` in the PBF. */
  id: number | null;
  /** MVT geometry type (POINT, LINESTRING, or POLYGON). */
  type: MvtGeomType;
  /** Command-encoded geometry integers per the MVT 2.1 spec. */
  geometry: number[];
  /** Interleaved key/value index pairs: `[keyIdx, valIdx, keyIdx, valIdx, ...]`. */
  tags: number[];
}

/**
 * A complete MVT layer containing features with deduplicated keys and values.
 *
 * Keys and values are stored in flat arrays; features reference them by index
 * via {@link MvtFeature.tags}.
 */
export interface MvtLayer {
  /** Layer name (unique within a tile). */
  name: string;
  /** Tile coordinate extent (typically 4096). */
  extent: number;
  /** Encoded features in this layer. */
  features: MvtFeature[];
  /** Deduplicated property key strings. */
  keys: string[];
  /** Deduplicated property values. */
  values: MvtValue[];
}

// ─── TileJSON ───────────────────────────────────────────────────────────────

/**
 * TileJSON 3.0.0 metadata descriptor.
 *
 * Generated by {@link TileServer.tileJSON} from the FGB headers of all
 * configured sources. Bounds and zoom ranges are aggregated across sources.
 *
 * @see {@link https://github.com/mapbox/tilejson-spec/tree/master/3.0.0 | TileJSON 3.0.0 Spec}
 */
export interface TileJSON {
  /** Specification version — always `"3.0.0"`. */
  tilejson: '3.0.0';
  /** Human-readable tileset name. */
  name?: string;
  /** WGS84 bounding box: `[west, south, east, north]`. */
  bounds: [number, number, number, number];
  /** Minimum zoom level with tile coverage. */
  minzoom: number;
  /** Maximum zoom level with tile coverage. */
  maxzoom: number;
  /** Per-layer metadata including fields and zoom range. */
  vector_layers: Array<{
    /** Layer identifier (matches the source `name`). */
    id: string;
    /** Map of property names to type strings (`"Number"`, `"String"`, `"Boolean"`). */
    fields: Record<string, string>;
    /** Minimum zoom at which this layer appears. */
    minzoom: number;
    /** Maximum zoom at which this layer appears. */
    maxzoom: number;
  }>;
}

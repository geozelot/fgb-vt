/**
 * @module mvt/layer
 *
 * MVT layer builder -- the central pipeline stage that transforms decoded
 * FlatGeobuf features into a complete MVT layer ready for PBF encoding.
 *
 * The per-feature pipeline applies the following stages in order:
 *
 * 1. **Project** -- source coordinates (WGS84 longitude/latitude by
 *    default) to Web Mercator [0, 1] space ({@link projectToMercator}).
 * 2. **Clip** -- discard or cut geometry to the tile's bounding box, with an
 *    optional buffer for line/label overshoot ({@link clipFeatures}).
 * 3. **Simplify** -- reduce vertex count using squared-distance tolerance
 *    scaled to the current zoom level ({@link simplify}). Small rings that
 *    fall below the tolerance are dropped entirely.
 * 4. **Transform** -- convert mercator [0, 1] coordinates to integer tile
 *    coordinates in `[0, extent]` ({@link transformToTile}).
 * 5. **Wind** -- enforce MVT winding order (exterior CW, holes CCW)
 *    ({@link correctWinding}).
 * 6. **Encode** -- produce MVT command integers from tile coordinates
 *    ({@link encodeGeometry}).
 * 7. **Tag** -- build deduplicated key/value index arrays and per-feature
 *    tag pairs ({@link buildTags}).
 *
 * The resulting {@link MvtLayer} is a self-contained structure that can be
 * handed directly to {@link encodePbf} for binary serialization.
 */

import type {
  MvtLayer, MvtFeature, MvtValue, RawFeature, PropertyValue,
} from '../types.js';
import { GeomType } from '../types.js';
import { toMvtGeomType, encodeGeometry } from './geometry.js';
import { transformToTile, correctWinding } from '../geometry/transform.js';
import { projectToMercator } from '../geometry/project.js';
import { clipFeatures } from '../geometry/clip.js';
import { simplify, sqToleranceForZoom, ringTooSmall } from '../geometry/simplify.js';
import type { BBox } from '../types.js';

/**
 * Build an {@link MvtLayer} from an array of decoded FlatGeobuf features.
 *
 * This is the core pipeline function that takes raw FGB features (in WGS84)
 * and transforms them into a complete MVT layer ready for PBF encoding.
 * Features that become degenerate during clipping or simplification (e.g.
 * a polygon that collapses to fewer than 3 vertices) are silently dropped.
 *
 * **Side effect:** the `xy` coordinate arrays on each input `RawFeature` are
 * mutated in-place during the mercator projection step.
 *
 * @param features - Decoded FlatGeobuf features with WGS84 coordinates.
 * @param name - Layer name (must be unique within the tile).
 * @param z - Tile zoom level (0-based).
 * @param x - Tile column index at zoom level `z`.
 * @param y - Tile row index at zoom level `z`.
 * @param clipBounds - Bounding box in mercator [0, 1] space used for
 *   clipping. Typically includes a buffer margin around the tile.
 * @param extent - Tile coordinate extent (typically 4096).
 * @param tolerance - Simplification tolerance in tile coordinate units.
 *   Set to 0 to disable simplification entirely.
 * @param toMercator - Converts the features' coordinates to mercator
 *   [0, 1] space in place. Defaults to the WGS 84 longitude/latitude
 *   projection.
 * @param options - Simplification mode and point thinning.
 * @returns A fully assembled {@link MvtLayer} with deduplicated keys/values
 *   and encoded geometry commands for every surviving feature.
 */
export function buildMvtLayer(
  features: RawFeature[],
  name: string,
  z: number,
  x: number,
  y: number,
  clipBounds: BBox,
  extent: number,
  tolerance: number,
  toMercator: (xy: Float64Array) => void = projectToMercator,
  options: LayerOptions = {},
): MvtLayer {
  const builder = new LayerBuilder(name, z, x, y, clipBounds, extent, tolerance, toMercator, options);
  builder.add(features);
  return builder.finish();
}

/**
 * Options for {@link buildMvtLayer}.
 */
export interface LayerOptions {
  /**
   * Simplify each feature as a whole before clipping it to the tile, so
   * that every tile showing it gets identical vertices along shared
   * edges. Costs the full simplification of every feature reaching the
   * tile, however little of it is visible. @defaultValue false
   */
  simplifyBeforeClip?: boolean;
  /**
   * Keep at most one point per cell of this size (in tile units); `0`
   * disables thinning. @defaultValue 0
   */
  pointGrid?: number;
}

/**
 * Builds an {@link MvtLayer} from features added in batches, so a source
 * can be encoded while it is read: each batch is clipped, simplified and
 * encoded at once, and its decoded features can be released.
 *
 * Adding features in several batches yields the same layer as adding them
 * all at once (point thinning keeps the first point per cell across
 * batches).
 */
export class LayerBuilder {
  private readonly keys: string[] = [];
  private readonly keyIndex = new Map<string, number>();
  private readonly values: MvtValue[] = [];
  private readonly valueIndex = new Map<string, number>();
  private readonly features: MvtFeature[] = [];
  private readonly sqTol: number;
  private readonly before: boolean;
  private readonly grid: number;
  private readonly occupied: Set<number> | null;

  /**
   * @param name - Layer name.
   * @param z - Tile zoom level.
   * @param x - Tile column.
   * @param y - Tile row.
   * @param clipBounds - Clip box in mercator [0, 1] space (with buffer).
   * @param extent - Tile coordinate extent.
   * @param tolerance - Simplification tolerance in tile units (`0`: none).
   * @param toMercator - Converts added coordinates to mercator space in place.
   * @param options - Simplification mode and point thinning.
   */
  constructor(
    readonly name: string,
    private readonly z: number,
    private readonly x: number,
    private readonly y: number,
    private readonly clipBounds: BBox,
    readonly extent: number,
    tolerance: number,
    private readonly toMercator: (xy: Float64Array) => void = projectToMercator,
    options: LayerOptions = {},
  ) {
    this.sqTol = tolerance > 0 ? sqToleranceForZoom(tolerance, z, extent) : 0;
    this.before = options.simplifyBeforeClip === true && this.sqTol > 0;
    this.grid = options.pointGrid !== undefined && options.pointGrid > 0 ? options.pointGrid : 0;
    this.occupied = this.grid > 0 ? new Set<number>() : null;
  }

  /** Number of features written so far. */
  get size(): number {
    return this.features.length;
  }

  /**
   * Clip, simplify and encode a batch of features into the layer.
   *
   * **Side effect:** the features' `xy` arrays are converted to mercator
   * space in place.
   *
   * @param features - Decoded features, in file order.
   */
  add(features: RawFeature[]): void {
    const { sqTol, before, grid, occupied, z, x, y, extent } = this;

    // Project all features to mercator in-place
    for (const f of features) {
      this.toMercator(f.xy);
    }

    // Simplify whole features before clipping (same result in every tile),
    // or the clipped parts after
    let input = features;
    if (before) {
      input = [];
      for (const f of features) {
        const simplified = simplifyFeature(f, sqTol);
        if (simplified) input.push(simplified);
      }
    }
    const clipped = clipFeatures(input, this.clipBounds);

    for (const clippedFeature of clipped) {
      const feature = before || sqTol === 0 ? clippedFeature : simplifyFeature(clippedFeature, sqTol);
      if (!feature || feature.xy.length === 0) continue;

      // Transform to tile coordinates
      let tileCoords = transformToTile(feature.xy, z, x, y, extent);

      // Thin points: at most one per grid cell, the first in file order
      if (occupied && (feature.type === GeomType.Point || feature.type === GeomType.MultiPoint)) {
        tileCoords = thinPoints(tileCoords, grid, occupied);
        if (tileCoords.length === 0) continue;
      }

      // Correct polygon winding order (parts tracks which rings are exterior
      // for MultiPolygon geometries with multiple polygon parts)
      correctWinding(tileCoords, feature.ends, feature.type, feature.parts);

      // Encode geometry commands
      const mvtType = toMvtGeomType(feature.type);
      const geometry = encodeGeometry(tileCoords, feature.ends, mvtType);
      if (geometry.length === 0) continue;

      // Build tags
      const tags = buildTags(feature.properties, this.keys, this.keyIndex, this.values, this.valueIndex);

      this.features.push({
        id: feature.id,
        type: mvtType,
        geometry,
        tags,
      });
    }
  }

  /** The layer with every feature added so far. */
  finish(): MvtLayer {
    return {
      name: this.name,
      extent: this.extent,
      features: this.features,
      keys: this.keys,
      values: this.values,
    };
  }
}


// == Simplification =========================================================

/**
 * Simplify the lines and rings of a feature in mercator space, dropping
 * rings that collapse below the tolerance.
 *
 * @param feature - Feature in mercator [0, 1] space.
 * @param sqTol - Squared simplification tolerance in mercator units.
 * @returns The simplified feature (the input itself for points), or
 *   `null` if nothing remains.
 */
function simplifyFeature(feature: RawFeature, sqTol: number): RawFeature | null {
  if (feature.type === GeomType.Point || feature.type === GeomType.MultiPoint) return feature;
  const { xy, ends, parts } = feature;
  // Only polygon rings are dropped for their size: a line part along a
  // meridian or parallel has a zero-area bounding box but is not small
  const polygon = feature.type === GeomType.Polygon || feature.type === GeomType.MultiPolygon;

  if (!ends || ends.length <= 1) {
    if (polygon && ringTooSmall(xy, 0, xy.length, sqTol)) return null;
    const simplified = simplify(xy, sqTol);
    if (simplified.length < 4) return null; // degenerate
    // A single ring/part needs no ends; any existing ends indexed the
    // unsimplified coordinates and would now point past the array.
    return { ...feature, xy: simplified, ends: null };
  }

  // Multi-ring: simplify each ring independently, dropping small polygon rings.
  // Track which original ring index each surviving ring came from so we
  // can rebuild `parts` (MultiPolygon exterior ring tracking).
  const simplifiedRings: Float64Array[] = [];
  const newEnds: number[] = [];
  const ringOriginMap: number[] = [];
  let start = 0;
  let pairOffset = 0;
  for (let i = 0; i < ends.length; i++) {
    const end = ends[i] * 2; // to element index
    const ringXy = xy.subarray(start, end);
    start = end;

    // Drop small polygon rings
    if (polygon && ringTooSmall(ringXy, 0, ringXy.length, sqTol)) continue;

    const simplified = simplify(ringXy, sqTol);
    if (simplified.length >= 4) { // at least 2 points
      simplifiedRings.push(simplified);
      pairOffset += simplified.length / 2;
      newEnds.push(pairOffset);
      ringOriginMap.push(i);
    }
  }

  if (simplifiedRings.length === 0) return null;

  // Reassemble
  const totalLen = simplifiedRings.reduce((s, r) => s + r.length, 0);
  const out = new Float64Array(totalLen);
  let off = 0;
  for (const ring of simplifiedRings) {
    out.set(ring, off);
    off += ring.length;
  }

  // Rebuild parts: map original exterior ring indices to new positions
  let newParts: Uint32Array | null = null;
  if (parts) {
    const exteriorOrigSet = new Set<number>();
    for (let j = 0; j < parts.length; j++) {
      exteriorOrigSet.add(parts[j]);
    }
    const newPartStarts: number[] = [];
    for (let i = 0; i < ringOriginMap.length; i++) {
      if (exteriorOrigSet.has(ringOriginMap[i])) {
        newPartStarts.push(i);
      }
    }
    newParts = newPartStarts.length > 1 ? new Uint32Array(newPartStarts) : null;
  }

  return { ...feature, xy: out, ends: new Uint32Array(newEnds), parts: newParts };
}

// == Point thinning =========================================================

/** Offset making cell indices non-negative for the numeric cell key. */
const CELL_OFFSET = 0x100000;

/**
 * Drop points whose grid cell is already occupied, marking the cells of
 * the points kept.
 *
 * @param coords - Tile coordinates of one (multi)point feature.
 * @param grid - Cell size in tile units.
 * @param occupied - Cells taken by earlier points of the layer.
 * @returns The kept points (the input when all are kept).
 */
function thinPoints(coords: Int32Array, grid: number, occupied: Set<number>): Int32Array {
  let kept: number[] | null = null;
  for (let i = 0; i < coords.length; i += 2) {
    const cell = (Math.floor(coords[i] / grid) + CELL_OFFSET) * 0x200000 +
      (Math.floor(coords[i + 1] / grid) + CELL_OFFSET);
    if (occupied.has(cell)) {
      if (!kept) kept = Array.from(coords.subarray(0, i));
      continue;
    }
    occupied.add(cell);
    if (kept) kept.push(coords[i], coords[i + 1]);
  }
  return kept ? Int32Array.from(kept) : coords;
}

// == Layer merging ==========================================================

/**
 * Merge layers that share a name into one, in order of first appearance.
 *
 * The MVT spec forbids two layers with the same name in a tile. Sources
 * with the same name (e.g. a detailed file and an overview file with
 * disjoint zoom ranges, or one dataset split into several files) are
 * therefore combined: features are concatenated and their tags re-indexed
 * against the merged key and value tables.
 *
 * @param layers - Layers in tile order.
 * @returns Layers with unique names.
 * @throws {RangeError} If layers with the same name have different extents.
 */
export function mergeLayers(layers: MvtLayer[]): MvtLayer[] {
  const out: MvtLayer[] = [];
  const byName = new Map<string, number>();
  for (const layer of layers) {
    const at = byName.get(layer.name);
    if (at === undefined) {
      byName.set(layer.name, out.length);
      out.push(layer);
      continue;
    }
    const target = out[at];
    if (target.extent !== layer.extent) {
      throw new RangeError(
        `Sources named "${layer.name}" use different extents (${target.extent} and ${layer.extent})`,
      );
    }
    if (layer.features.length === 0) continue;
    if (target.features.length === 0) {
      out[at] = layer;
      continue;
    }
    out[at] = appendLayer(target, layer);
  }
  return out;
}

/** A new layer with the features of `a` followed by those of `b`. */
function appendLayer(a: MvtLayer, b: MvtLayer): MvtLayer {
  const keys = [...a.keys];
  const keyIndex = new Map(keys.map((k, i) => [k, i]));
  const values = [...a.values];
  const valueIndex = new Map(values.map((v, i) => [mvtValueKey(v), i]));
  const keyMap = b.keys.map((k) => {
    let i = keyIndex.get(k);
    if (i === undefined) {
      i = keys.length;
      keys.push(k);
      keyIndex.set(k, i);
    }
    return i;
  });
  const valueMap = b.values.map((v) => {
    const key = mvtValueKey(v);
    let i = valueIndex.get(key);
    if (i === undefined) {
      i = values.length;
      values.push(v);
      valueIndex.set(key, i);
    }
    return i;
  });
  const features = [...a.features];
  for (const f of b.features) {
    const tags = new Array<number>(f.tags.length);
    for (let i = 0; i < f.tags.length; i += 2) {
      tags[i] = keyMap[f.tags[i]];
      tags[i + 1] = valueMap[f.tags[i + 1]];
    }
    features.push({ ...f, tags });
  }
  return { name: a.name, extent: a.extent, features, keys, values };
}

// == Tag building ===========================================================

/**
 * Build interleaved key/value index tag pairs for a single feature.
 *
 * Property keys and values are deduplicated across the entire layer using
 * shared lookup maps. Each unique key string is appended to `keys` and
 * indexed in `keyIndex`; each unique typed value is appended to `values`
 * and indexed in `valueIndex`. The returned array contains alternating
 * key-index / value-index pairs: `[kIdx, vIdx, kIdx, vIdx, ...]`.
 *
 * Properties with `null`, `undefined`, `Uint8Array` (binary: MVT has no
 * binary value type), NaN or infinite values are skipped.
 *
 * @param properties - Feature property map from the decoded FGB feature.
 * @param keys - Shared mutable array of deduplicated key strings (layer-wide).
 * @param keyIndex - Shared mutable map from key string to its index in `keys`.
 * @param values - Shared mutable array of deduplicated MVT values (layer-wide).
 * @param valueIndex - Shared mutable map from value identity key to its index
 *   in `values`.
 * @returns Flat array of interleaved `[keyIndex, valueIndex]` pairs.
 */
function buildTags(
  properties: Map<string, PropertyValue>,
  keys: string[],
  keyIndex: Map<string, number>,
  values: MvtValue[],
  valueIndex: Map<string, number>,
): number[] {
  const tags: number[] = [];

  for (const [key, value] of properties) {
    if (value === null || value === undefined) continue;
    if (value instanceof Uint8Array) continue; // skip binary properties
    // NaN and infinities have no JSON form; style expressions cannot use them
    if (typeof value === 'number' && value - value !== 0) continue;

    // Key index
    let kIdx = keyIndex.get(key);
    if (kIdx === undefined) {
      kIdx = keys.length;
      keys.push(key);
      keyIndex.set(key, kIdx);
    }

    // Value index
    const mvtVal = toMvtValue(value);
    const valKey = mvtValueKey(mvtVal);
    let vIdx = valueIndex.get(valKey);
    if (vIdx === undefined) {
      vIdx = values.length;
      values.push(mvtVal);
      valueIndex.set(valKey, vIdx);
    }

    tags.push(kIdx, vIdx);
  }

  return tags;
}

/**
 * Convert a decoded FGB property value to a typed {@link MvtValue}.
 *
 * Integers that are exactly representable (safe-integer `number`s and
 * `bigint`s) are classified as `uint` (non-negative) or `int` (negative).
 * Fractional numbers, and integral doubles beyond the safe range (which
 * carry no exact integer value), become `float` when a 32-bit float
 * represents them exactly (every value of a FlatGeobuf `Float` column) and
 * `double` otherwise, so no precision is lost. Booleans map directly.
 * All other types (including unexpected ones) are coerced to strings.
 *
 * @param value - Raw property value from the FGB feature.
 * @returns A tagged MVT value suitable for PBF encoding.
 */
function toMvtValue(value: PropertyValue): MvtValue {
  if (typeof value === 'string') {
    return { type: 'string', value };
  }
  if (typeof value === 'boolean') {
    return { type: 'bool', value };
  }
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) {
      return value >= 0 ? { type: 'uint', value } : { type: 'int', value };
    }
    // Lossless and 4 bytes smaller when a 32-bit float holds the value exactly
    return Math.fround(value) === value ? { type: 'float', value } : { type: 'double', value };
  }
  if (typeof value === 'bigint') {
    return value >= 0n ? { type: 'uint', value } : { type: 'int', value };
  }
  return { type: 'string', value: String(value) };
}

/**
 * Produce a stable identity key for an {@link MvtValue} used to deduplicate
 * the layer-wide value array.
 *
 * The key format is `"type:value"`, which guarantees that values of different
 * types (e.g. the integer `1` vs. the string `"1"`) are stored separately.
 *
 * @param v - Tagged MVT value.
 * @returns A string key uniquely identifying this value.
 */
function mvtValueKey(v: MvtValue): string {
  return `${v.type}:${v.value}`;
}

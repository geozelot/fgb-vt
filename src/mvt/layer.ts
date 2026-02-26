/**
 * @module mvt/layer
 *
 * MVT layer builder -- the central pipeline stage that transforms decoded
 * FlatGeobuf features into a complete MVT layer ready for PBF encoding.
 *
 * The per-feature pipeline applies the following stages in order:
 *
 * 1. **Project** -- WGS84 longitude/latitude to Web Mercator [0, 1] space
 *    ({@link projectToMercator}).
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
): MvtLayer {
  const keys: string[] = [];
  const keyIndex = new Map<string, number>();
  const values: MvtValue[] = [];
  const valueIndex = new Map<string, number>();
  const mvtFeatures: MvtFeature[] = [];

  const sqTol = tolerance > 0 ? sqToleranceForZoom(tolerance, z, extent) : 0;

  // Project all features to mercator in-place
  for (const f of features) {
    projectToMercator(f.xy);
  }

  // Clip features to tile bounds
  const clipped = clipFeatures(features, clipBounds);

  for (const feature of clipped) {
    // Simplify (for line/polygon types)
    let xy = feature.xy;
    let ends = feature.ends;
    let parts = feature.parts;

    const isPoint = feature.type === GeomType.Point || feature.type === GeomType.MultiPoint;

    if (!isPoint && sqTol > 0) {
      if (ends && ends.length > 1) {
        // Multi-ring: simplify each ring independently, dropping small rings.
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

          // Drop small rings
          if (ringTooSmall(ringXy, 0, ringXy.length, sqTol)) {
            start = end;
            continue;
          }

          const simplified = simplify(ringXy, sqTol);
          if (simplified.length >= 4) { // at least 2 points
            simplifiedRings.push(simplified);
            pairOffset += simplified.length / 2;
            newEnds.push(pairOffset);
            ringOriginMap.push(i);
          }
          start = end;
        }

        if (simplifiedRings.length === 0) continue;

        // Reassemble
        const totalLen = simplifiedRings.reduce((s, r) => s + r.length, 0);
        xy = new Float64Array(totalLen);
        let off = 0;
        for (const ring of simplifiedRings) {
          xy.set(ring, off);
          off += ring.length;
        }
        ends = new Uint32Array(newEnds);

        // Rebuild parts: map original exterior ring indices to new positions
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
          parts = newPartStarts.length > 1 ? new Uint32Array(newPartStarts) : null;
        }
      } else {
        xy = simplify(xy, sqTol);
        if (xy.length < 4 && !isPoint) continue; // degenerate
      }
    }

    if (xy.length === 0) continue;

    // Transform to tile coordinates
    const tileCoords = transformToTile(xy, z, x, y, extent);

    // Correct polygon winding order (parts tracks which rings are exterior
    // for MultiPolygon geometries with multiple polygon parts)
    correctWinding(tileCoords, ends, feature.type, parts);

    // Encode geometry commands
    const mvtType = toMvtGeomType(feature.type);
    const geometry = encodeGeometry(tileCoords, ends, mvtType);
    if (geometry.length === 0) continue;

    // Build tags
    const tags = buildTags(feature.properties, keys, keyIndex, values, valueIndex);

    mvtFeatures.push({
      id: feature.id,
      type: mvtType,
      geometry,
      tags,
    });
  }

  return {
    name,
    extent,
    features: mvtFeatures,
    keys,
    values,
  };
}

// ─── Tag building ───────────────────────────────────────────────────────────

/**
 * Build interleaved key/value index tag pairs for a single feature.
 *
 * Property keys and values are deduplicated across the entire layer using
 * shared lookup maps. Each unique key string is appended to `keys` and
 * indexed in `keyIndex`; each unique typed value is appended to `values`
 * and indexed in `valueIndex`. The returned array contains alternating
 * key-index / value-index pairs: `[kIdx, vIdx, kIdx, vIdx, ...]`.
 *
 * Properties with `null`, `undefined`, or `Uint8Array` (binary) values are
 * silently skipped since MVT has no binary value type.
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
 * Numeric values are classified as `uint` (non-negative integers), `int`
 * (negative integers), or `double` (fractional). Booleans map directly.
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
    if (Number.isInteger(value)) {
      if (value >= 0) {
        return { type: 'uint', value };
      }
      return { type: 'int', value };
    }
    return { type: 'double', value };
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

import { describe, it, expect } from 'vitest';
import { clipFeatures } from '../../src/geometry/clip.js';
import { GeomType } from '../../src/types.js';
import type { RawFeature, BBox } from '../../src/types.js';

function makePoint(x: number, y: number, id = 0): RawFeature {
  return {
    type: GeomType.Point,
    xy: new Float64Array([x, y]),
    ends: null,
    properties: new Map(),
    id,
  };
}

function makeLine(coords: number[], id = 0): RawFeature {
  return {
    type: GeomType.LineString,
    xy: new Float64Array(coords),
    ends: null,
    properties: new Map(),
    id,
  };
}

function makePolygon(coords: number[], ends: number[], id = 0): RawFeature {
  return {
    type: GeomType.Polygon,
    xy: new Float64Array(coords),
    ends: new Uint32Array(ends),
    properties: new Map(),
    id,
  };
}

const clip: BBox = { minX: 0.2, minY: 0.2, maxX: 0.8, maxY: 0.8 };

describe('Clipping edge cases', () => {
  // ─── Empty input ──────────────────────────────────────────────────────

  it('should return empty array for empty input', () => {
    const result = clipFeatures([], clip);
    expect(result).toEqual([]);
  });

  // ─── Features entirely outside ──────────────────────────────────────

  it('should discard all features entirely outside bounds', () => {
    const features = [
      makePoint(0.0, 0.0),
      makePoint(0.9, 0.9),
      makePoint(0.1, 0.5),
      makePoint(0.5, 0.1),
    ];
    const result = clipFeatures(features, clip);
    expect(result.length).toBe(0);
  });

  // ─── Features entirely inside ─────────────────────────────────────────

  it('should pass through features entirely inside (trivial accept)', () => {
    const features = [
      makePoint(0.5, 0.5),
      makePoint(0.3, 0.7),
    ];
    const result = clipFeatures(features, clip);
    expect(result.length).toBe(2);
  });

  // ─── Point on boundary ──────────────────────────────────────────────

  it('should include points exactly on the clip boundary', () => {
    const features = [
      makePoint(0.2, 0.2), // bottom-left corner
      makePoint(0.8, 0.8), // top-right corner
      makePoint(0.5, 0.2), // bottom edge
      makePoint(0.2, 0.5), // left edge
    ];
    const result = clipFeatures(features, clip);
    expect(result.length).toBe(4);
  });

  // ─── Line crossing boundary ──────────────────────────────────────────

  it('should clip a line that crosses from inside to outside', () => {
    const line = makeLine([0.5, 0.5, 0.5, 0.9]);
    const result = clipFeatures([line], clip);
    expect(result.length).toBe(1);
    // The clipped line should end at y=0.8
    const xyArr = result[0].xy;
    const lastY = xyArr[xyArr.length - 1];
    expect(lastY).toBeCloseTo(0.8, 5);
  });

  it('should clip a line that crosses the clip region entirely (outside→inside→outside)', () => {
    const line = makeLine([0.1, 0.5, 0.5, 0.5, 0.9, 0.5]);
    const result = clipFeatures([line], clip);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // All resulting coordinates should be within bounds
    for (const f of result) {
      for (let i = 0; i < f.xy.length; i += 2) {
        expect(f.xy[i]).toBeGreaterThanOrEqual(0.2 - 1e-10);
        expect(f.xy[i]).toBeLessThanOrEqual(0.8 + 1e-10);
      }
    }
  });

  // ─── Line entirely outside ───────────────────────────────────────────

  it('should discard a line entirely outside the clip region', () => {
    const line = makeLine([0.0, 0.0, 0.1, 0.1]);
    const result = clipFeatures([line], clip);
    expect(result.length).toBe(0);
  });

  // ─── Degenerate geometries ───────────────────────────────────────────

  it('should handle a zero-length line (same start and end)', () => {
    const line = makeLine([0.5, 0.5, 0.5, 0.5]);
    // A zero-length line may or may not be kept, but should not crash
    expect(() => clipFeatures([line], clip)).not.toThrow();
  });

  it('should handle a polygon with only 3 points (degenerate triangle)', () => {
    const poly = makePolygon(
      [0.3, 0.3, 0.7, 0.3, 0.5, 0.7, 0.3, 0.3],
      [4],
    );
    const result = clipFeatures([poly], clip);
    // Triangle is inside bounds, should be kept
    expect(result.length).toBe(1);
  });

  // ─── Large polygon straddling clip bounds ─────────────────────────────

  it('should clip a large polygon that extends well beyond clip bounds', () => {
    // Polygon from (0,0) to (1,1) — much larger than clip (0.2,0.2)-(0.8,0.8)
    const poly = makePolygon(
      [0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 0.0],
      [5],
    );
    const result = clipFeatures([poly], clip);
    expect(result.length).toBe(1);
    // All clipped coords should be within clip bounds
    for (let i = 0; i < result[0].xy.length; i += 2) {
      expect(result[0].xy[i]).toBeGreaterThanOrEqual(0.2 - 1e-10);
      expect(result[0].xy[i]).toBeLessThanOrEqual(0.8 + 1e-10);
      expect(result[0].xy[i + 1]).toBeGreaterThanOrEqual(0.2 - 1e-10);
      expect(result[0].xy[i + 1]).toBeLessThanOrEqual(0.8 + 1e-10);
    }
  });

  // ─── MultiPoint clipping ──────────────────────────────────────────────

  it('should partially clip a MultiPoint (keep only inside points)', () => {
    const mp: RawFeature = {
      type: GeomType.MultiPoint,
      xy: new Float64Array([
        0.1, 0.1, // outside
        0.5, 0.5, // inside
        0.9, 0.9, // outside
        0.3, 0.3, // inside
      ]),
      ends: null,
      properties: new Map(),
      id: 1,
    };
    const result = clipFeatures([mp], clip);
    expect(result.length).toBe(1);
    expect(result[0].xy.length).toBe(4); // 2 inside points × 2 coords
  });

  // ─── Narrow sliver polygon ────────────────────────────────────────────

  it('should handle a very narrow sliver polygon', () => {
    // A nearly-degenerate sliver
    const poly = makePolygon(
      [0.5, 0.3, 0.500001, 0.3, 0.500001, 0.7, 0.5, 0.7, 0.5, 0.3],
      [5],
    );
    // Should not crash
    expect(() => clipFeatures([poly], clip)).not.toThrow();
  });

  // ─── Mixed geometry batch ──────────────────────────────────────────────

  it('should handle a mixed batch of geometry types', () => {
    const features: RawFeature[] = [
      makePoint(0.5, 0.5, 1),
      makeLine([0.3, 0.3, 0.7, 0.7], 2),
      makePolygon([0.3, 0.3, 0.7, 0.3, 0.7, 0.7, 0.3, 0.7, 0.3, 0.3], [5], 3),
      makePoint(0.0, 0.0, 4), // outside
    ];
    const result = clipFeatures(features, clip);
    // Point at 0.5,0.5 and line and polygon should survive; point at 0,0 discarded
    expect(result.length).toBe(3);
  });

  // ─── Full world clip bounds (no clipping) ─────────────────────────────

  it('should pass through everything with world-spanning clip bounds', () => {
    const worldClip: BBox = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    const features = [
      makePoint(0.5, 0.5),
      makeLine([0.1, 0.1, 0.9, 0.9]),
    ];
    const result = clipFeatures(features, worldClip);
    expect(result.length).toBe(2);
  });
});

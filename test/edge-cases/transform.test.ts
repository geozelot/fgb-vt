import { describe, it, expect } from 'vitest';
import { transformToTile, correctWinding, signedArea } from '../../src/geometry/transform.js';
import { GeomType } from '../../src/types.js';

describe('Transform edge cases', () => {
  // ─── Empty / single point ──────────────────────────────────────────

  it('should handle empty coordinate array', () => {
    const xy = new Float64Array(0);
    const result = transformToTile(xy, 0, 0, 0, 4096);
    expect(result.length).toBe(0);
  });

  it('should handle single point', () => {
    const xy = new Float64Array([0.5, 0.5]);
    const result = transformToTile(xy, 0, 0, 0, 4096);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(2048);
    expect(result[1]).toBe(2048);
  });

  // ─── Points in buffer zone (negative tile coords) ─────────────────

  it('should produce negative coordinates for points in buffer zone', () => {
    // z=1, x=1: tile covers [0.5, 1.0] in mercator
    // Point at x=0.49 is just outside the tile boundary
    const xy = new Float64Array([0.49, 0.25]);
    const result = transformToTile(xy, 1, 1, 0, 4096);
    expect(result[0]).toBeLessThan(0);
  });

  it('should produce coordinates > extent for points beyond far edge', () => {
    // z=1, x=0: tile covers [0, 0.5] in mercator
    // Point at x=0.51 is just outside the right edge
    const xy = new Float64Array([0.51, 0.25]);
    const result = transformToTile(xy, 1, 0, 0, 4096);
    expect(result[0]).toBeGreaterThan(4096);
  });

  // ─── High zoom level ──────────────────────────────────────────────

  it('should produce correct tile coords at high zoom', () => {
    const z = 18;
    const x = 131072; // midpoint of x range at z=18
    const y = 131072;
    const z2 = 1 << z;
    // Mercator center of this tile:
    const mercX = (x + 0.5) / z2;
    const mercY = (y + 0.5) / z2;
    const xy = new Float64Array([mercX, mercY]);
    const result = transformToTile(xy, z, x, y, 4096);
    // Should be near center of tile
    expect(result[0]).toBeCloseTo(2048, 0);
    expect(result[1]).toBeCloseTo(2048, 0);
  });

  // ─── Zoom 0 ───────────────────────────────────────────────────────

  it('should map [0,0] to tile origin at z=0', () => {
    const xy = new Float64Array([0, 0]);
    const result = transformToTile(xy, 0, 0, 0, 4096);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0);
  });

  it('should map [1,1] to tile extent at z=0', () => {
    const xy = new Float64Array([1, 1]);
    const result = transformToTile(xy, 0, 0, 0, 4096);
    expect(result[0]).toBe(4096);
    expect(result[1]).toBe(4096);
  });

  // ─── Different extents ─────────────────────────────────────────────

  it('should work with extent=512', () => {
    const xy = new Float64Array([0.5, 0.5]);
    const result = transformToTile(xy, 0, 0, 0, 512);
    expect(result[0]).toBe(256);
    expect(result[1]).toBe(256);
  });

  it('should work with extent=8192', () => {
    const xy = new Float64Array([0.5, 0.5]);
    const result = transformToTile(xy, 0, 0, 0, 8192);
    expect(result[0]).toBe(4096);
    expect(result[1]).toBe(4096);
  });
});

describe('correctWinding edge cases', () => {
  it('should be a no-op for point types', () => {
    const coords = new Int32Array([100, 200]);
    const original = new Int32Array(coords);
    correctWinding(coords, null, GeomType.Point);
    expect(coords).toEqual(original);
  });

  it('should be a no-op for linestring types', () => {
    const coords = new Int32Array([0, 0, 10, 10, 20, 0]);
    const original = new Int32Array(coords);
    correctWinding(coords, null, GeomType.LineString);
    expect(coords).toEqual(original);
  });

  it('should enforce CW for single polygon ring', () => {
    // CCW ring (in screen coords Y-down) → should be reversed to CW
    const coords = new Int32Array([0, 0, 0, 100, 100, 100, 100, 0]);
    correctWinding(coords, null, GeomType.Polygon);
    // After winding correction, signed area should be positive (CW)
    const area = signedArea(coords, 0, coords.length);
    expect(area).toBeGreaterThan(0);
  });

  it('should handle MultiPolygon type', () => {
    const coords = new Int32Array([0, 0, 100, 0, 100, 100, 0, 100]);
    // Should not crash with MultiPolygon
    expect(() => correctWinding(coords, null, GeomType.MultiPolygon)).not.toThrow();
  });
});

describe('signedArea edge cases', () => {
  it('should return 0 for degenerate (2-point) ring', () => {
    const coords = [0, 0, 10, 10];
    const area = signedArea(coords, 0, coords.length);
    // A 2-point "ring" has zero area
    expect(area).toBe(0);
  });

  it('should return 0 for single point', () => {
    const coords = [5, 5];
    const area = signedArea(coords, 0, coords.length);
    expect(area).toBe(0);
  });

  it('should handle very large coordinates without overflow', () => {
    // Use large but valid Int32 values
    const coords = [0, 0, 100000, 0, 100000, 100000, 0, 100000];
    const area = signedArea(coords, 0, coords.length);
    expect(Math.abs(area)).toBeGreaterThan(0);
  });
});

import { describe, it, expect } from 'vitest';
import { encodeGeometry, zigzag } from '../../src/mvt/geometry.js';
import { MvtGeomType } from '../../src/types.js';

describe('MVT encoding edge cases', () => {
  // ─── zigzag edge cases ──────────────────────────────────────────────

  it('should handle large positive values', () => {
    expect(zigzag(100000)).toBe(200000);
  });

  it('should handle large negative values', () => {
    expect(zigzag(-100000)).toBe(199999);
  });

  // Note: zigzag uses 32-bit shift so max safe range is ±(2^30 - 1)

  // ─── Empty geometry ──────────────────────────────────────────────────

  it('should return empty array for empty point coords', () => {
    const coords = new Int32Array(0);
    expect(encodeGeometry(coords, null, MvtGeomType.POINT)).toEqual([]);
  });

  it('should return empty array for empty linestring coords', () => {
    const coords = new Int32Array(0);
    expect(encodeGeometry(coords, null, MvtGeomType.LINESTRING)).toEqual([]);
  });

  it('should return empty array for empty polygon coords', () => {
    const coords = new Int32Array(0);
    expect(encodeGeometry(coords, null, MvtGeomType.POLYGON)).toEqual([]);
  });

  // ─── Single point at origin ──────────────────────────────────────────

  it('should encode point at (0, 0)', () => {
    const coords = new Int32Array([0, 0]);
    const result = encodeGeometry(coords, null, MvtGeomType.POINT);
    // MoveTo(1) = 9, zigzag(0)=0, zigzag(0)=0
    expect(result).toEqual([9, 0, 0]);
  });

  // ─── Points with negative coords (buffer zone) ──────────────────────

  it('should encode point with negative coordinates', () => {
    const coords = new Int32Array([-100, -50]);
    const result = encodeGeometry(coords, null, MvtGeomType.POINT);
    // MoveTo(1) = 9, zigzag(-100)=199, zigzag(-50)=99
    expect(result).toEqual([9, 199, 99]);
  });

  // ─── Linestring with 2 points (minimum valid) ──────────────────────

  it('should encode a 2-point linestring', () => {
    const coords = new Int32Array([0, 0, 100, 100]);
    const result = encodeGeometry(coords, null, MvtGeomType.LINESTRING);
    // MoveTo(1)=9, (0,0)→(0,0), LineTo(1)=10, delta(100,100)→(200,200)
    expect(result).toEqual([9, 0, 0, 10, 200, 200]);
  });

  // ─── Single-point linestring (degenerate) ────────────────────────────

  it('should return empty for single-point linestring (too few points)', () => {
    const coords = new Int32Array([10, 20]);
    const result = encodeGeometry(coords, null, MvtGeomType.LINESTRING);
    // A linestring with only 1 point doesn't have enough for MoveTo+LineTo
    expect(result).toEqual([]);
  });

  // ─── Polygon with 3 vertices (triangle, closed) ─────────────────────

  it('should encode a triangle polygon (minimum ring)', () => {
    const coords = new Int32Array([0, 0, 100, 0, 50, 100, 0, 0]);
    const ends = new Uint32Array([4]);
    const result = encodeGeometry(coords, ends, MvtGeomType.POLYGON);
    // MoveTo(1), LineTo(2), ClosePath(1)
    expect(result.length).toBeGreaterThan(0);
    // Last command should be ClosePath = (1 << 3) | 7 = 15
    expect(result[result.length - 1]).toBe(15);
  });

  // ─── Polygon with 2 vertices (degenerate, too few for ring) ────────

  it('should skip degenerate polygon ring with fewer than 3 vertices', () => {
    // 2 unique points + closing point = 3 coord pairs, but lineCount would be < 2
    const coords = new Int32Array([0, 0, 10, 10, 0, 0]);
    const ends = new Uint32Array([3]);
    const result = encodeGeometry(coords, ends, MvtGeomType.POLYGON);
    // Too few points for a valid polygon ring
    expect(result).toEqual([]);
  });

  // ─── Multi-ring polygon ─────────────────────────────────────────────

  it('should encode multi-ring polygon correctly', () => {
    const coords = new Int32Array([
      // Exterior ring
      0, 0, 100, 0, 100, 100, 0, 100, 0, 0,
      // Interior ring (hole)
      20, 20, 80, 20, 80, 80, 20, 80, 20, 20,
    ]);
    const ends = new Uint32Array([5, 10]);
    const result = encodeGeometry(coords, ends, MvtGeomType.POLYGON);
    // Should have two ClosePath commands
    const closeCount = result.filter(c => c === 15).length;
    expect(closeCount).toBe(2);
  });

  // ─── Point at extent boundary ────────────────────────────────────────

  it('should encode point at exact extent (4096)', () => {
    const coords = new Int32Array([4096, 4096]);
    const result = encodeGeometry(coords, null, MvtGeomType.POINT);
    expect(result).toEqual([9, zigzag(4096), zigzag(4096)]);
  });

  // ─── Large coordinate deltas ─────────────────────────────────────────

  it('should handle large coordinate deltas', () => {
    const coords = new Int32Array([0, 0, 4096, 4096]);
    const result = encodeGeometry(coords, null, MvtGeomType.LINESTRING);
    expect(result.length).toBeGreaterThan(0);
    // Should not crash
  });

  // ─── Zero-delta coordinates (colocated points) ───────────────────────

  it('should handle colocated linestring points (zero deltas)', () => {
    const coords = new Int32Array([50, 50, 50, 50, 100, 100]);
    const result = encodeGeometry(coords, null, MvtGeomType.LINESTRING);
    // Should include zero-delta encoding
    expect(result.length).toBeGreaterThan(0);
  });
});

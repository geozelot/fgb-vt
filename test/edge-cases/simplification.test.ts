import { describe, it, expect } from 'vitest';
import { simplify, sqToleranceForZoom, ringTooSmall } from '../../src/geometry/simplify.js';

describe('Simplification edge cases', () => {
  // ─── Empty / minimal input ──────────────────────────────────────────

  it('should handle 0-length array', () => {
    const result = simplify(new Float64Array(0), 0.01);
    expect(result.length).toBe(0);
  });

  it('should handle a single point (2 elements)', () => {
    const result = simplify(new Float64Array([1, 2]), 0.01);
    // 1 point → n <= 4, returned unchanged
    expect(result).toEqual(new Float64Array([1, 2]));
  });

  it('should handle exactly 2 points (4 elements)', () => {
    const result = simplify(new Float64Array([0, 0, 1, 1]), 0.01);
    // 2 points → n <= 4, returned unchanged
    expect(result.length).toBe(4);
  });

  // ─── Collinear points ──────────────────────────────────────────────

  it('should simplify perfectly collinear points down to 2', () => {
    // 10 points on a straight line from (0,0) to (1,1)
    const n = 10;
    const xy = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      xy[i * 2] = i / (n - 1);
      xy[i * 2 + 1] = i / (n - 1);
    }
    const result = simplify(xy, 0.001);
    // Collinear: only first and last should survive
    expect(result.length).toBe(4); // 2 points × 2 coords
  });

  // ─── Zero tolerance ────────────────────────────────────────────────

  it('should keep all points with zero tolerance', () => {
    const xy = new Float64Array([0, 0, 0.5, 0.1, 1, 0, 1.5, 0.1, 2, 0]);
    const result = simplify(xy, 0);
    // With sqTolerance = 0, all points with importance > 0 are kept
    // First and last always kept, intermediate if they deviate
    expect(result.length).toBe(xy.length);
  });

  // ─── Very large tolerance ─────────────────────────────────────────

  it('should reduce to 2 points with very large tolerance', () => {
    const n = 100;
    const xy = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      xy[i * 2] = i / n;
      xy[i * 2 + 1] = Math.sin(i / n * Math.PI * 4) * 0.01;
    }
    // Huge tolerance: everything except first and last should be removed
    const result = simplify(xy, 1000);
    expect(result.length).toBe(4);
  });

  // ─── Zigzag pattern ────────────────────────────────────────────────

  it('should simplify a zigzag pattern', () => {
    // Create a zigzag with alternating y
    const xy = new Float64Array([
      0, 0, 1, 1, 2, 0, 3, 1, 4, 0, 5, 1, 6, 0,
    ]);
    const result = simplify(xy, 0.001);
    // With a small tolerance, most points should be kept
    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result.length).toBeLessThanOrEqual(xy.length);
  });

  // ─── sqToleranceForZoom edge cases ────────────────────────────────

  it('should produce very small tolerance at high zoom', () => {
    const sqTol = sqToleranceForZoom(3, 22, 4096);
    expect(sqTol).toBeLessThan(1e-19);
    expect(sqTol).toBeGreaterThan(0);
  });

  it('should produce larger tolerance at low zoom', () => {
    const sqTolLow = sqToleranceForZoom(3, 0, 4096);
    const sqTolHigh = sqToleranceForZoom(3, 10, 4096);
    expect(sqTolLow).toBeGreaterThan(sqTolHigh);
  });

  it('should return zero tolerance when tolerance parameter is 0', () => {
    expect(sqToleranceForZoom(0, 5, 4096)).toBe(0);
  });

  // ─── ringTooSmall edge cases ──────────────────────────────────────

  it('should consider a zero-area ring as too small', () => {
    // A zero-area line (all same point)
    const xy = new Float64Array([1, 1, 1, 1, 1, 1]);
    expect(ringTooSmall(xy, 0, xy.length, 0.0001)).toBe(true);
  });

  it('should not consider a large ring as too small', () => {
    const xy = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(ringTooSmall(xy, 0, xy.length, 0.0001)).toBe(false);
  });

  it('should handle subarray ranges correctly', () => {
    // Two rings embedded in one array: [smallRing, bigRing]
    const xy = new Float64Array([
      0, 0, 0.001, 0, 0.001, 0.001, 0, 0.001, // small ring (4 points)
      0, 0, 10, 0, 10, 10, 0, 10,              // big ring (4 points)
    ]);
    expect(ringTooSmall(xy, 0, 8, 0.01)).toBe(true);   // small ring
    expect(ringTooSmall(xy, 8, 16, 0.01)).toBe(false);  // big ring
  });
});

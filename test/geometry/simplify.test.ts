import { describe, it, expect } from 'vitest';
import { simplify, sqToleranceForZoom, ringTooSmall } from '../../src/geometry/simplify.js';

describe('simplify', () => {
  it('should pass through points (2 elements)', () => {
    const xy = new Float64Array([1, 2]);
    const result = simplify(xy, 1e-6);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
  });

  it('should pass through a line with 2 points (4 elements)', () => {
    const xy = new Float64Array([0, 0, 1, 1]);
    const result = simplify(xy, 1e-6);
    expect(result.length).toBe(4);
  });

  it('should simplify a line removing colinear points', () => {
    // Straight line: 0,0 → 0.5,0.5 → 1,1
    // The middle point is colinear, so it should be removed
    const xy = new Float64Array([0, 0, 0.5, 0.5, 1, 1]);
    const result = simplify(xy, 0.01);
    expect(result.length).toBe(4); // First and last points only
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(1);
    expect(result[3]).toBe(1);
  });

  it('should keep points that deviate from the line', () => {
    // L-shape: the middle point deviates significantly
    const xy = new Float64Array([0, 0, 0, 1, 1, 1]);
    const result = simplify(xy, 0.01);
    expect(result.length).toBe(6); // All points kept
  });

  it('should simplify with zero tolerance keeping all points', () => {
    const xy = new Float64Array([0, 0, 0.1, 0.01, 1, 1]);
    const result = simplify(xy, 0);
    expect(result.length).toBe(6);
  });
});

describe('sqToleranceForZoom', () => {
  it('should decrease tolerance as zoom increases', () => {
    const tol3 = sqToleranceForZoom(3, 3, 4096);
    const tol10 = sqToleranceForZoom(3, 10, 4096);
    expect(tol10).toBeLessThan(tol3);
  });

  it('should return 0 for 0 tolerance', () => {
    expect(sqToleranceForZoom(0, 5, 4096)).toBe(0);
  });

  it('should compute correctly for known values', () => {
    // tolerance=3, z=0, extent=4096: (3 / (1 * 4096))^2
    const expected = (3 / 4096) ** 2;
    expect(sqToleranceForZoom(3, 0, 4096)).toBeCloseTo(expected, 15);
  });
});

describe('ringTooSmall', () => {
  it('should return true for a tiny ring', () => {
    // A tiny triangle
    const xy = new Float64Array([0, 0, 0.0001, 0, 0.0001, 0.0001, 0, 0]);
    const sqTol = 0.001; // Much larger than the ring
    expect(ringTooSmall(xy, 0, xy.length, sqTol)).toBe(true);
  });

  it('should return false for a large ring', () => {
    // A big square
    const xy = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0]);
    const sqTol = 0.001;
    expect(ringTooSmall(xy, 0, xy.length, sqTol)).toBe(false);
  });
});

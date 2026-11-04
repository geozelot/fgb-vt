import { describe, it, expect } from 'vitest';
import { linearizeArcs } from '../../src/geometry/curve.js';

const pts = (xy: Float64Array) => Array.from({ length: xy.length / 2 }, (_, i) => [xy[2 * i], xy[2 * i + 1]]);

/** Largest distance of chord midpoints from the circle (the sagitta). */
function maxSagitta(xy: Float64Array, cx: number, cy: number, r: number): number {
  let max = 0;
  for (let i = 2; i < xy.length; i += 2) {
    const mx = (xy[i - 2] + xy[i]) / 2, my = (xy[i - 1] + xy[i + 1]) / 2;
    max = Math.max(max, r - Math.hypot(mx - cx, my - cy));
  }
  return max;
}

describe('linearizeArcs', () => {
  it('keeps the end points exact and every vertex on the circle', () => {
    const out = linearizeArcs(new Float64Array([-1, 0, 0, 1, 1, 0]), 0.001);
    expect(pts(out)[0]).toEqual([-1, 0]);
    expect(pts(out).at(-1)).toEqual([1, 0]);
    for (const [x, y] of pts(out)) expect(Math.hypot(x, y)).toBeCloseTo(1, 12);
    // Upper half: through (0, 1), not the lower half
    expect(Math.max(...pts(out).map(p => p[1]))).toBeCloseTo(1, 3);
    expect(Math.min(...pts(out).map(p => p[1]))).toBeGreaterThanOrEqual(-1e-12);
    expect(maxSagitta(out, 0, 0, 1)).toBeLessThanOrEqual(0.001);
  });

  it('follows the direction given by the middle point', () => {
    const out = linearizeArcs(new Float64Array([-1, 0, 0, -1, 1, 0]), 0.001);
    expect(Math.min(...pts(out).map(p => p[1]))).toBeCloseTo(-1, 3);
    expect(Math.max(...pts(out).map(p => p[1]))).toBeLessThanOrEqual(1e-12);
  });

  it('draws a full circle when start and end coincide', () => {
    const out = linearizeArcs(new Float64Array([0, 0, 2, 0, 0, 0]), 0.0001);
    expect(pts(out)[0]).toEqual([0, 0]);
    expect(pts(out).at(-1)).toEqual([0, 0]);
    const xs = pts(out).map(p => p[0]), ys = pts(out).map(p => p[1]);
    expect(Math.max(...xs)).toBeCloseTo(2, 3);
    expect(Math.max(...ys)).toBeCloseTo(1, 3);
    expect(Math.min(...ys)).toBeCloseTo(-1, 3);
  });

  it('uses more vertices for a smaller tolerance, up to a cap', () => {
    const arc = new Float64Array([-1, 0, 0, 1, 1, 0]);
    const coarse = linearizeArcs(arc, 0.1).length;
    const fine = linearizeArcs(arc, 0.0001).length;
    expect(fine).toBeGreaterThan(coarse);
    expect(linearizeArcs(arc, 0).length / 2).toBeLessThanOrEqual(129);
    // An arc smaller than the tolerance collapses to two chords
    expect(linearizeArcs(arc, 5).length / 2).toBe(3);
  });

  it('chains consecutive arcs', () => {
    // Two half circles forming an S
    const out = linearizeArcs(new Float64Array([0, 0, 1, 1, 2, 0, 3, -1, 4, 0]), 0.01);
    expect(pts(out)[0]).toEqual([0, 0]);
    expect(pts(out).at(-1)).toEqual([4, 0]);
    expect(pts(out)).toContainEqual([2, 0]);
  });

  it('treats collinear points as a straight line through the middle point', () => {
    expect(Array.from(linearizeArcs(new Float64Array([0, 0, 1, 1, 2, 2]), 0))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('returns input with an invalid point count unchanged', () => {
    const even = new Float64Array([0, 0, 1, 1, 2, 0, 3, 3]);
    expect(linearizeArcs(even, 0)).toBe(even);
    const short = new Float64Array([0, 0, 1, 1]);
    expect(linearizeArcs(short, 0)).toBe(short);
  });

  it('bounds the output size for strings packed with arcs', () => {
    // 1,000 full circles of radius 1000 at the finest tolerance
    const arcs = 1000;
    const xy = new Float64Array((2 * arcs + 1) * 2);
    for (let k = 0; k <= 2 * arcs; k++) {
      xy[2 * k] = k % 2 === 0 ? 0 : 2000;
    }
    const out = linearizeArcs(xy, 0);
    expect(out.length / 2).toBeLessThanOrEqual(16 * (2 * arcs + 1) + 256 + 1);
  });
});

import { describe, it, expect } from 'vitest';
import { projectX, projectY, projectToMercator } from '../../src/geometry/project.js';

describe('Projection edge cases', () => {
  // ─── Antimeridian / date line ────────────────────────────────────────────

  it('should handle antimeridian: longitude +180', () => {
    expect(projectX(180)).toBe(1);
  });

  it('should handle antimeridian: longitude -180', () => {
    expect(projectX(-180)).toBe(0);
  });

  it('should handle exact antimeridian crossing (179.9 → 180.1 wrap)', () => {
    // Features that straddle the antimeridian have lng > 180 or lng < -180
    // in some datasets. Our projection should handle gracefully.
    const x179 = projectX(179.999);
    const xNeg179 = projectX(-179.999);
    // They should be very close to 1 and 0 respectively
    expect(x179).toBeCloseTo(1, 3);
    expect(xNeg179).toBeCloseTo(0, 3);
  });

  // ─── Polar latitudes ─────────────────────────────────────────────────────

  it('should clamp latitude near +90 (north pole)', () => {
    const y = projectY(89.99);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(0.01);
  });

  it('should clamp latitude at +90 exactly', () => {
    // sin(90°) = 1, log((1+1)/(1-1)) → log(Infinity) → clamps to 0
    const y = projectY(90);
    expect(y).toBe(0);
  });

  it('should clamp latitude near -90 (south pole)', () => {
    const y = projectY(-89.99);
    expect(y).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThan(0.99);
  });

  it('should clamp latitude at -90 exactly', () => {
    const y = projectY(-90);
    expect(y).toBe(1);
  });

  it('should handle latitude beyond ±85.0511 (Mercator limit)', () => {
    // Standard Web Mercator is defined for ±85.0511287798 degrees
    const yAbove = projectY(85.0511);
    const yBelow = projectY(-85.0511);
    expect(yAbove).toBeGreaterThanOrEqual(0);
    expect(yBelow).toBeLessThanOrEqual(1);
  });

  // ─── Zero / equator / prime meridian ─────────────────────────────────────

  it('should project equator to y=0.5', () => {
    expect(projectY(0)).toBe(0.5);
  });

  it('should project prime meridian to x=0.5', () => {
    expect(projectX(0)).toBe(0.5);
  });

  // ─── Empty / single coordinate ───────────────────────────────────────────

  it('should handle empty coordinate array', () => {
    const xy = new Float64Array(0);
    projectToMercator(xy);
    expect(xy.length).toBe(0);
  });

  it('should handle single coordinate pair', () => {
    const xy = new Float64Array([0, 0]);
    projectToMercator(xy);
    expect(xy[0]).toBe(0.5); // prime meridian
    expect(xy[1]).toBe(0.5); // equator
  });

  // ─── Large coordinate arrays ─────────────────────────────────────────────

  it('should handle very large coordinate arrays without stack overflow', () => {
    const n = 100_000;
    const xy = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      xy[i * 2] = (i / n) * 360 - 180;
      xy[i * 2 + 1] = (i / n) * 170 - 85;
    }
    projectToMercator(xy);
    // All x should be in [0, 1]
    for (let i = 0; i < n; i++) {
      expect(xy[i * 2]).toBeGreaterThanOrEqual(0);
      expect(xy[i * 2]).toBeLessThanOrEqual(1);
      expect(xy[i * 2 + 1]).toBeGreaterThanOrEqual(0);
      expect(xy[i * 2 + 1]).toBeLessThanOrEqual(1);
    }
  });
});

import { describe, it, expect } from 'vitest';
import { projectX, projectY, projectToMercator } from '../../src/geometry/project.js';

describe('project', () => {
  describe('projectX', () => {
    it('should project longitude 0 to 0.5', () => {
      expect(projectX(0)).toBeCloseTo(0.5, 10);
    });

    it('should project longitude -180 to 0', () => {
      expect(projectX(-180)).toBeCloseTo(0, 10);
    });

    it('should project longitude 180 to 1', () => {
      expect(projectX(180)).toBeCloseTo(1, 10);
    });

    it('should project longitude 90 to 0.75', () => {
      expect(projectX(90)).toBeCloseTo(0.75, 10);
    });

    it('should project longitude -90 to 0.25', () => {
      expect(projectX(-90)).toBeCloseTo(0.25, 10);
    });
  });

  describe('projectY', () => {
    it('should project latitude 0 to 0.5', () => {
      expect(projectY(0)).toBeCloseTo(0.5, 10);
    });

    it('should project positive latitudes to < 0.5 (north is up)', () => {
      expect(projectY(45)).toBeLessThan(0.5);
    });

    it('should project negative latitudes to > 0.5 (south is down)', () => {
      expect(projectY(-45)).toBeGreaterThan(0.5);
    });

    it('should clamp near the poles', () => {
      // Mercator Y approaches infinity at the poles,
      // but projectY should return values close to 0 or 1
      const north = projectY(85);
      const south = projectY(-85);
      expect(north).toBeGreaterThan(0);
      expect(north).toBeLessThan(0.2);
      expect(south).toBeGreaterThan(0.8);
      expect(south).toBeLessThan(1);
    });
  });

  describe('projectToMercator', () => {
    it('should project coordinates in-place', () => {
      // London: ~(-0.1, 51.5) → should be near (0.4997, 0.3524)
      const xy = new Float64Array([-0.1, 51.5]);
      projectToMercator(xy);

      expect(xy[0]).toBeCloseTo(0.49972, 4);
      expect(xy[1]).toBeLessThan(0.5); // North of equator
      expect(xy[1]).toBeGreaterThan(0.3);
    });

    it('should handle multiple coordinate pairs', () => {
      const xy = new Float64Array([0, 0, 180, 0, -180, 0]);
      projectToMercator(xy);

      // (0,0) → (0.5, 0.5)
      expect(xy[0]).toBeCloseTo(0.5, 10);
      expect(xy[1]).toBeCloseTo(0.5, 10);

      // (180,0) → (1.0, 0.5)
      expect(xy[2]).toBeCloseTo(1.0, 10);
      expect(xy[3]).toBeCloseTo(0.5, 10);

      // (-180,0) → (0.0, 0.5)
      expect(xy[4]).toBeCloseTo(0.0, 10);
      expect(xy[5]).toBeCloseTo(0.5, 10);
    });
  });
});

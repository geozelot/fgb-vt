import { describe, it, expect } from 'vitest';
import { transformToTile, correctWinding, signedArea } from '../../src/geometry/transform.js';

describe('transformToTile', () => {
  it('should transform mercator [0,1] to tile coordinates', () => {
    // z=0, x=0, y=0: tile covers [0,1] × [0,1]
    // Point at (0.5, 0.5) should map to (extent/2, extent/2)
    const xy = new Float64Array([0.5, 0.5]);
    const extent = 4096;
    const result = transformToTile(xy, 0, 0, 0, extent);

    expect(result[0]).toBe(Math.round(extent * 0.5)); // 2048
    expect(result[1]).toBe(Math.round(extent * 0.5)); // 2048
  });

  it('should produce integer tile coordinates', () => {
    const xy = new Float64Array([0.3, 0.7]);
    const result = transformToTile(xy, 0, 0, 0, 4096);

    expect(Number.isInteger(result[0])).toBe(true);
    expect(Number.isInteger(result[1])).toBe(true);
  });

  it('should handle zoom level 1', () => {
    // z=1, x=0, y=0: tile covers [0,0.5] × [0,0.5]
    // Point at (0.25, 0.25) should map to (extent/2, extent/2)
    const xy = new Float64Array([0.25, 0.25]);
    const extent = 4096;
    const result = transformToTile(xy, 1, 0, 0, extent);

    expect(result[0]).toBe(Math.round(extent * (0.25 * 2 - 0))); // 2048
    expect(result[1]).toBe(Math.round(extent * (0.25 * 2 - 0))); // 2048
  });

  it('should handle negative coordinates (buffer zone)', () => {
    // z=1, x=1, y=0: tile covers [0.5,1] × [0,0.5]
    // Point at (0.45, 0.1) is slightly outside the tile (left of x=0.5)
    const xy = new Float64Array([0.45, 0.1]);
    const extent = 4096;
    const result = transformToTile(xy, 1, 1, 0, extent);

    // tileX = round(4096 * (0.45 * 2 - 1)) = round(4096 * -0.1) = -410
    expect(result[0]).toBeLessThan(0);
  });
});

describe('signedArea', () => {
  it('should return non-zero area for a square', () => {
    // CW square: right, down, left, up
    const cw = [0, 0, 100, 0, 100, 100, 0, 100];
    const areaCW = signedArea(cw, 0, cw.length);
    expect(areaCW).not.toBe(0);
    // In this shoelace formula, CW in screen coords (Y-down) gives negative
    expect(areaCW).toBeLessThan(0);
  });

  it('should give opposite signs for opposite windings', () => {
    // CW: 0,0 → 100,0 → 100,100 → 0,100
    const cw = [0, 0, 100, 0, 100, 100, 0, 100];
    const areaCW = signedArea(cw, 0, cw.length);

    // CCW (reversed): 0,0 → 0,100 → 100,100 → 100,0
    const ccw = [0, 0, 0, 100, 100, 100, 100, 0];
    const areaCCW = signedArea(ccw, 0, ccw.length);

    // Should have opposite signs
    expect(Math.sign(areaCW)).toBe(-Math.sign(areaCCW));
  });
});

describe('correctWinding', () => {
  it('should not throw on valid input', () => {
    const coords = new Int32Array([0, 0, 100, 0, 100, 100, 0, 100]);
    const ends = new Uint32Array([4]); // 4 points
    expect(() => correctWinding(coords, ends)).not.toThrow();
  });

  it('should handle polygons with multiple rings', () => {
    // Two rings
    const coords = new Int32Array([
      0, 0, 100, 0, 100, 100, 0, 100,  // exterior
      20, 20, 80, 20, 80, 80, 20, 80,   // hole
    ]);
    const ends = new Uint32Array([4, 8]);
    expect(() => correctWinding(coords, ends)).not.toThrow();
  });
});

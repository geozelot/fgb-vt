import { describe, it, expect } from 'vitest';
import { tileBBox, tileClipBounds, validateTile, mercatorToWgs84BBox, MAX_ZOOM } from '../src/tiles.js';

describe('tileBBox', () => {
  it('should cover the world at z=0', () => {
    const bbox = tileBBox(0, 0, 0);
    expect(bbox.minX).toBeCloseTo(-180, 5);
    expect(bbox.maxX).toBeCloseTo(180, 5);
    // Y should cover ~(-85.05, 85.05) for Web Mercator
    expect(bbox.minY).toBeCloseTo(-85.0511, 1);
    expect(bbox.maxY).toBeCloseTo(85.0511, 1);
  });

  it('should split correctly at z=1', () => {
    const tl = tileBBox(1, 0, 0); // top-left
    const tr = tileBBox(1, 1, 0); // top-right
    const bl = tileBBox(1, 0, 1); // bottom-left
    const br = tileBBox(1, 1, 1); // bottom-right

    // X boundaries
    expect(tl.minX).toBeCloseTo(-180, 5);
    expect(tl.maxX).toBeCloseTo(0, 5);
    expect(tr.minX).toBeCloseTo(0, 5);
    expect(tr.maxX).toBeCloseTo(180, 5);

    // Y boundaries: tl/tr should have the same maxY (top),
    // bl/br should have the same minY (bottom)
    expect(tl.maxY).toBeCloseTo(tr.maxY, 5);
    expect(bl.minY).toBeCloseTo(br.minY, 5);

    // Lat 0 should be at the boundary between top and bottom rows
    expect(tl.minY).toBeCloseTo(0, 1);
    expect(bl.maxY).toBeCloseTo(0, 1);
  });

  it('should produce non-overlapping tiles at any zoom', () => {
    const z = 3;
    const t1 = tileBBox(z, 2, 3);
    const t2 = tileBBox(z, 3, 3);

    // Adjacent tiles should share a boundary
    expect(t1.maxX).toBeCloseTo(t2.minX, 10);
  });
});

describe('tileClipBounds', () => {
  it('should expand bounds by buffer', () => {
    const noBuf = tileClipBounds(5, 10, 10, 0, 4096);
    const withBuf = tileClipBounds(5, 10, 10, 64, 4096);

    expect(withBuf.minX).toBeLessThan(noBuf.minX);
    expect(withBuf.minY).toBeLessThan(noBuf.minY);
    expect(withBuf.maxX).toBeGreaterThan(noBuf.maxX);
    expect(withBuf.maxY).toBeGreaterThan(noBuf.maxY);
  });

  it('should produce bounds in [0,1] mercator space', () => {
    const bounds = tileClipBounds(3, 4, 4, 64, 4096);
    expect(bounds.minX).toBeGreaterThanOrEqual(-0.1);
    expect(bounds.maxX).toBeLessThanOrEqual(1.1);
    expect(bounds.minY).toBeGreaterThanOrEqual(-0.1);
    expect(bounds.maxY).toBeLessThanOrEqual(1.1);
  });
});

describe('validateTile', () => {
  it('accepts every tile of a zoom level', () => {
    expect(() => validateTile(0, 0, 0)).not.toThrow();
    expect(() => validateTile(3, 7, 7)).not.toThrow();
    expect(() => validateTile(MAX_ZOOM, 2 ** MAX_ZOOM - 1, 0)).not.toThrow();
  });

  it.each([
    [-1, 0, 0], [MAX_ZOOM + 1, 0, 0], [1.5, 0, 0], [NaN, 0, 0],
    [2, 4, 0], [2, 0, 4], [2, -1, 0], [2, 0.5, 0], [2, 0, Infinity],
  ])('rejects %s/%s/%s', (z, x, y) => {
    expect(() => validateTile(z, x, y)).toThrow(RangeError);
  });
});

describe('mercatorToWgs84BBox', () => {
  it('inverts tileClipBounds without buffer', () => {
    const bbox = tileBBox(5, 10, 12);
    const fromClip = mercatorToWgs84BBox(tileClipBounds(5, 10, 12, 0, 4096));
    expect(fromClip.minX).toBeCloseTo(bbox.minX, 9);
    expect(fromClip.minY).toBeCloseTo(bbox.minY, 9);
    expect(fromClip.maxX).toBeCloseTo(bbox.maxX, 9);
    expect(fromClip.maxY).toBeCloseTo(bbox.maxY, 9);
  });

  it('extends to the poles at the projection edges', () => {
    const top = mercatorToWgs84BBox(tileClipBounds(2, 1, 0, 64, 4096));
    const bottom = mercatorToWgs84BBox(tileClipBounds(2, 1, 3, 64, 4096));
    expect(top.maxY).toBe(90);
    expect(bottom.minY).toBe(-90);
  });
});

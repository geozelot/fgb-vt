import { describe, it, expect } from 'vitest';
import { tileId, tileBBox, tileClipBounds, TileBoundsCache } from '../src/tiles.js';

describe('tileId', () => {
  it('should produce unique IDs for different tiles', () => {
    const ids = new Set<number>();
    for (let z = 0; z <= 5; z++) {
      const n = 1 << z;
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
          ids.add(tileId(z, x, y));
        }
      }
    }
    // Total tiles for z0-5: 1 + 4 + 16 + 64 + 256 + 1024 = 1365
    expect(ids.size).toBe(1365);
  });

  it('should encode z=0 x=0 y=0 consistently', () => {
    expect(tileId(0, 0, 0)).toBe(0);
  });
});

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

describe('TileBoundsCache', () => {
  it('should cache and return consistent WGS84 bounds', () => {
    const cache = new TileBoundsCache();
    const b1 = cache.getWgs84(5, 10, 10);
    const b2 = cache.getWgs84(5, 10, 10);
    expect(b1).toBe(b2); // Same reference (cached)
  });

  it('should cache and return consistent clip bounds', () => {
    const cache = new TileBoundsCache();
    const b1 = cache.getClip(5, 10, 10, 64, 4096);
    const b2 = cache.getClip(5, 10, 10, 64, 4096);
    expect(b1).toBe(b2); // Same reference (cached)
  });

  it('should produce different clip bounds for different buffer/extent', () => {
    const cache = new TileBoundsCache();
    const b1 = cache.getClip(5, 10, 10, 64, 4096);
    const b2 = cache.getClip(5, 10, 10, 128, 4096);
    expect(b1).not.toBe(b2);
    expect(b2.minX).toBeLessThan(b1.minX);
  });
});

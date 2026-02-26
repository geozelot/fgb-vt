import { describe, it, expect } from 'vitest';
import { tileId, tileBBox, tileClipBounds, TileBoundsCache } from '../../src/tiles.js';

describe('Tile coordinate edge cases', () => {
  // ─── Zoom 0: single world tile ──────────────────────────────────────

  it('should produce world-spanning bbox at z=0', () => {
    const bbox = tileBBox(0, 0, 0);
    expect(bbox.minX).toBeCloseTo(-180, 5);
    expect(bbox.maxX).toBeCloseTo(180, 5);
    // Latitude range for Mercator
    expect(bbox.minY).toBeLessThan(-80);
    expect(bbox.maxY).toBeGreaterThan(80);
  });

  it('should produce a tile ID of 0 at z=0,x=0,y=0', () => {
    const id = tileId(0, 0, 0);
    // (((1 << 0) * 0 + 0) * 32) + 0 = 0
    expect(id).toBe(0);
  });

  // ─── High zoom levels ───────────────────────────────────────────────

  it('should produce very small bbox at z=20', () => {
    const bbox = tileBBox(20, 524288, 349526);
    const lngSpan = bbox.maxX - bbox.minX;
    const latSpan = bbox.maxY - bbox.minY;
    // At z=20 there are 2^20 = 1,048,576 tiles per axis
    // Each tile covers ~360/1048576 ≈ 0.000343 degrees of longitude
    expect(lngSpan).toBeCloseTo(360 / (1 << 20), 6);
    expect(latSpan).toBeGreaterThan(0);
    expect(latSpan).toBeLessThan(0.001);
  });

  it('should produce unique tile IDs at high zoom', () => {
    const id1 = tileId(20, 100, 200);
    const id2 = tileId(20, 100, 201);
    const id3 = tileId(20, 101, 200);
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
    expect(id2).not.toBe(id3);
  });

  // ─── Clip bounds with buffer ─────────────────────────────────────────

  it('should extend clip bounds beyond tile boundary with buffer > 0', () => {
    const noBuf = tileClipBounds(5, 16, 16, 0, 4096);
    const withBuf = tileClipBounds(5, 16, 16, 64, 4096);
    expect(withBuf.minX).toBeLessThan(noBuf.minX);
    expect(withBuf.minY).toBeLessThan(noBuf.minY);
    expect(withBuf.maxX).toBeGreaterThan(noBuf.maxX);
    expect(withBuf.maxY).toBeGreaterThan(noBuf.maxY);
  });

  it('should have no extension with buffer=0', () => {
    const clip = tileClipBounds(5, 16, 16, 0, 4096);
    const z2 = 1 << 5;
    expect(clip.minX).toBeCloseTo(16 / z2, 10);
    expect(clip.maxX).toBeCloseTo(17 / z2, 10);
    expect(clip.minY).toBeCloseTo(16 / z2, 10);
    expect(clip.maxY).toBeCloseTo(17 / z2, 10);
  });

  // ─── Edge tiles ──────────────────────────────────────────────────────

  it('should handle tile at x=0 (left edge of the world)', () => {
    const bbox = tileBBox(5, 0, 16);
    expect(bbox.minX).toBeCloseTo(-180, 5);
  });

  it('should handle tile at x=max (right edge of the world)', () => {
    const maxX = (1 << 5) - 1;
    const bbox = tileBBox(5, maxX, 16);
    expect(bbox.maxX).toBeCloseTo(180, 5);
  });

  it('should handle tile at y=0 (top of the world / north pole)', () => {
    const bbox = tileBBox(5, 16, 0);
    expect(bbox.maxY).toBeGreaterThan(80);
  });

  it('should handle tile at y=max (bottom / south pole)', () => {
    const maxY = (1 << 5) - 1;
    const bbox = tileBBox(5, 16, maxY);
    expect(bbox.minY).toBeLessThan(-80);
  });

  // ─── Clip bounds at world edges with buffer ───────────────────────

  it('should allow negative clip bounds (buffer extends beyond world)', () => {
    // At z=0, the tile is the entire world. Buffer extends beyond.
    const clip = tileClipBounds(0, 0, 0, 64, 4096);
    // With buffer, minX = (0 - 64/4096) / 1 < 0
    expect(clip.minX).toBeLessThan(0);
    expect(clip.maxX).toBeGreaterThan(1);
  });

  // ─── TileBoundsCache ──────────────────────────────────────────────────

  it('should return identical objects from cache on repeated calls', () => {
    const cache = new TileBoundsCache();
    const a = cache.getWgs84(5, 10, 10);
    const b = cache.getWgs84(5, 10, 10);
    expect(a).toBe(b); // same reference
  });

  it('should return different objects for different tiles', () => {
    const cache = new TileBoundsCache();
    const a = cache.getWgs84(5, 10, 10);
    const b = cache.getWgs84(5, 10, 11);
    expect(a).not.toBe(b);
  });

  it('should cache clip bounds with different buffer/extent independently', () => {
    const cache = new TileBoundsCache();
    const a = cache.getClip(5, 10, 10, 64, 4096);
    const b = cache.getClip(5, 10, 10, 128, 4096);
    expect(a.minX).not.toBe(b.minX);
  });
});

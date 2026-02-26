import { describe, it, expect } from 'vitest';
import { resolveOptions, DEFAULT_TILE_OPTIONS } from '../src/source.js';

describe('resolveOptions', () => {
  it('should return defaults when no options provided', () => {
    const opts = resolveOptions();
    expect(opts.extent).toBe(4096);
    expect(opts.buffer).toBe(64);
    expect(opts.tolerance).toBe(3);
    expect(opts.maxZoom).toBe(24);
    expect(opts.minZoom).toBe(0);
  });

  it('should use tile options over defaults', () => {
    const opts = resolveOptions(undefined, { extent: 512, buffer: 32 });
    expect(opts.extent).toBe(512);
    expect(opts.buffer).toBe(32);
    expect(opts.tolerance).toBe(3); // default
  });

  it('should use source options over tile options', () => {
    const opts = resolveOptions(
      { extent: 256 },
      { extent: 512, buffer: 32 },
    );
    expect(opts.extent).toBe(256);
    expect(opts.buffer).toBe(32); // from tile options
  });

  it('should cascade: source > tile > default', () => {
    const opts = resolveOptions(
      { tolerance: 5 },
      { buffer: 128, tolerance: 10 },
    );
    expect(opts.extent).toBe(4096); // default
    expect(opts.buffer).toBe(128);  // tile
    expect(opts.tolerance).toBe(5); // source overrides tile
    expect(opts.maxZoom).toBe(24);  // default
    expect(opts.minZoom).toBe(0);   // default
  });

  it('DEFAULT_TILE_OPTIONS should have correct values', () => {
    expect(DEFAULT_TILE_OPTIONS).toEqual({
      extent: 4096,
      buffer: 64,
      tolerance: 3,
      maxZoom: 24,
      minZoom: 0,
    });
  });
});

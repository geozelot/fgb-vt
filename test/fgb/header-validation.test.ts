import { describe, it, expect } from 'vitest';
import { parseHeader, headerByteSize } from '../../src/fgb/header.js';
import { calcTreeSize, computeLevelBounds } from '../../src/fgb/index.js';
import { buildMockFgb } from '../helpers/mock-fgb.js';

function withUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

describe('FlatGeobuf header validation', () => {
  it('accepts any 3.x patch level', () => {
    const bytes = buildMockFgb();
    for (const patch of [0, 1, 7]) {
      const copy = bytes.slice();
      copy[7] = patch;
      expect(parseHeader(copy).featuresCount).toBe(10);
    }
  });

  it('rejects other major versions with an explicit message', () => {
    const copy = buildMockFgb().slice();
    copy[3] = 2;
    expect(() => parseHeader(copy)).toThrow('Unsupported FlatGeobuf major version 2');
  });

  it('rejects non-FlatGeobuf input', () => {
    expect(() => parseHeader(new TextEncoder().encode('{"type":"FeatureCollection"}'))).toThrow('Invalid FlatGeobuf magic bytes');
  });

  it('rejects header sizes outside 8 B..10 MiB', () => {
    const bytes = buildMockFgb();
    expect(() => headerByteSize(withUint32(bytes, 8, 4))).toThrow('Invalid FlatGeobuf header size');
    expect(() => headerByteSize(withUint32(bytes, 8, 10 * 1024 * 1024 + 1))).toThrow('Invalid FlatGeobuf header size');
  });

  it('rejects a truncated header', () => {
    const bytes = buildMockFgb();
    const size = headerByteSize(bytes);
    expect(() => parseHeader(bytes.subarray(0, size - 1))).toThrow('Truncated FlatGeobuf header');
  });

  it('rejects index_node_size = 1 instead of looping forever', () => {
    expect(() => parseHeader(buildMockFgb({ indexNodeSize: 1 }))).toThrow('index_node_size');
  });

  it('treats index_node_size = 0 as "no index"', () => {
    const header = parseHeader(buildMockFgb({ indexNodeSize: 0 }));
    expect(header.indexSize).toBe(0);
    expect(header.featuresOffset).toBe(header.indexOffset);
  });
});

describe('packed R-tree layout', () => {
  it('gives a single feature a root above its leaf', () => {
    expect(calcTreeSize(1, 16)).toBe(80);
    expect(computeLevelBounds(1, 16)).toEqual([[1, 2], [0, 1]]);
  });

  it('matches the reference layout for a multi-level tree', () => {
    expect(computeLevelBounds(3221, 16)).toEqual([[216, 3437], [14, 216], [1, 14], [0, 1]]);
    expect(calcTreeSize(3221, 16)).toBe(3437 * 40);
  });

  it('handles exact powers of the node size', () => {
    expect(computeLevelBounds(16, 16)).toEqual([[1, 17], [0, 1]]);
    expect(computeLevelBounds(256, 16)).toEqual([[17, 273], [1, 17], [0, 1]]);
  });

  it('rejects invalid parameters', () => {
    expect(() => calcTreeSize(0, 16)).toThrow();
    expect(() => calcTreeSize(10, 1)).toThrow();
    expect(() => computeLevelBounds(10, 0)).toThrow();
  });
});

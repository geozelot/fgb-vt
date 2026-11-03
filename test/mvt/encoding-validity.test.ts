import { describe, it, expect } from 'vitest';
import { encodeGeometry, zigzag } from '../../src/mvt/geometry.js';
import { MvtGeomType } from '../../src/types.js';

const MOVE = (n: number) => (n << 3) | 1;
const LINE = (n: number) => (n << 3) | 2;
const CLOSE = (1 << 3) | 7;

describe('MVT geometry encoding validity', () => {
  it('drops consecutive duplicate line vertices (no zero-length LineTo)', () => {
    const coords = new Int32Array([0, 0, 0, 0, 10, 0, 10, 0, 20, 0]);
    expect(encodeGeometry(coords, null, MvtGeomType.LINESTRING))
      .toEqual([MOVE(1), 0, 0, LINE(2), zigzag(10), 0, zigzag(10), 0]);
  });

  it('skips a line that collapses to one point', () => {
    const coords = new Int32Array([5, 5, 5, 5, 5, 5]);
    expect(encodeGeometry(coords, null, MvtGeomType.LINESTRING)).toEqual([]);
  });

  it('drops duplicate and explicit closing vertices from polygon rings', () => {
    // clockwise (exterior) square with a doubled vertex and closing point
    const coords = new Int32Array([0, 0, 10, 0, 10, 0, 10, 10, 0, 10, 0, 0]);
    expect(encodeGeometry(coords, null, MvtGeomType.POLYGON)).toEqual([
      MOVE(1), 0, 0,
      LINE(3), zigzag(10), 0, 0, zigzag(10), zigzag(-10), 0,
      CLOSE,
    ]);
  });

  it('skips zero-area rings', () => {
    const coords = new Int32Array([0, 0, 10, 0, 20, 0, 0, 0]);
    expect(encodeGeometry(coords, null, MvtGeomType.POLYGON)).toEqual([]);
  });

  it('skips holes whose exterior ring was not emitted', () => {
    // exterior collapsed to a line, followed by a counter-clockwise hole
    const coords = new Int32Array([
      0, 0, 10, 0, 0, 0,
      2, 2, 2, 8, 8, 8, 8, 2, 2, 2,
    ]);
    const ends = new Uint32Array([3, 8]);
    expect(encodeGeometry(coords, ends, MvtGeomType.POLYGON)).toEqual([]);
  });

  it('never reads past the coordinate array when ends overshoot', () => {
    const coords = new Int32Array([0, 0, 10, 0, 20, 0]);
    const ends = new Uint32Array([1000]);
    expect(encodeGeometry(coords, ends, MvtGeomType.LINESTRING))
      .toEqual([MOVE(1), 0, 0, LINE(2), zigzag(10), 0, zigzag(10), 0]);
  });
});

import { describe, it, expect } from 'vitest';
import { encodeGeometry, toMvtGeomType, zigzag } from '../../src/mvt/geometry.js';
import { GeomType, MvtGeomType } from '../../src/types.js';

describe('zigzag', () => {
  it('should encode 0 as 0', () => {
    expect(zigzag(0)).toBe(0);
  });

  it('should encode -1 as 1', () => {
    expect(zigzag(-1)).toBe(1);
  });

  it('should encode 1 as 2', () => {
    expect(zigzag(1)).toBe(2);
  });

  it('should encode -2 as 3', () => {
    expect(zigzag(-2)).toBe(3);
  });

  it('should encode positive numbers to even values', () => {
    for (let i = 1; i <= 100; i++) {
      expect(zigzag(i) % 2).toBe(0);
    }
  });

  it('should encode negative numbers to odd values', () => {
    for (let i = 1; i <= 100; i++) {
      expect(zigzag(-i) % 2).toBe(1);
    }
  });
});

describe('toMvtGeomType', () => {
  it('should map Point and MultiPoint to POINT', () => {
    expect(toMvtGeomType(GeomType.Point)).toBe(MvtGeomType.POINT);
    expect(toMvtGeomType(GeomType.MultiPoint)).toBe(MvtGeomType.POINT);
  });

  it('should map LineString and MultiLineString to LINESTRING', () => {
    expect(toMvtGeomType(GeomType.LineString)).toBe(MvtGeomType.LINESTRING);
    expect(toMvtGeomType(GeomType.MultiLineString)).toBe(MvtGeomType.LINESTRING);
  });

  it('should map Polygon and MultiPolygon to POLYGON', () => {
    expect(toMvtGeomType(GeomType.Polygon)).toBe(MvtGeomType.POLYGON);
    expect(toMvtGeomType(GeomType.MultiPolygon)).toBe(MvtGeomType.POLYGON);
  });
});

describe('encodeGeometry', () => {
  it('should encode a single point', () => {
    const coords = new Int32Array([25, 17]);
    // encodeGeometry(coords, ends, mvtType)
    const result = encodeGeometry(coords, null, MvtGeomType.POINT);

    // MoveTo(1) = (1 << 3) | 1 = 9
    // zigzag(25) = 50, zigzag(17) = 34
    expect(result).toEqual([9, 50, 34]);
  });

  it('should encode a multipoint', () => {
    const coords = new Int32Array([5, 7, 3, 2]);
    const result = encodeGeometry(coords, null, MvtGeomType.POINT);

    // MoveTo(2) = (2 << 3) | 1 = 17
    // zigzag(5)=10, zigzag(7)=14
    // Delta from (5,7) to (3,2): (-2,-5) → zigzag(-2)=3, zigzag(-5)=9
    expect(result).toEqual([17, 10, 14, 3, 9]);
  });

  it('should encode a linestring', () => {
    const coords = new Int32Array([2, 1, 4, 4, 10, 8]);
    const result = encodeGeometry(coords, null, MvtGeomType.LINESTRING);

    // MoveTo(1) = 9
    // zigzag(2)=4, zigzag(1)=2
    // LineTo(2) = (2 << 3) | 2 = 18
    // delta (2,3) → zigzag(2)=4, zigzag(3)=6
    // delta (6,4) → zigzag(6)=12, zigzag(4)=8
    expect(result).toEqual([9, 4, 2, 18, 4, 6, 12, 8]);
  });

  it('should encode a polygon with ClosePath', () => {
    // Simple triangle (closed ring, last point same as first)
    const coords = new Int32Array([0, 0, 10, 0, 10, 10, 0, 0]);
    const ends = new Uint32Array([4]); // 4 coordinate pairs
    const result = encodeGeometry(coords, ends, MvtGeomType.POLYGON);

    // MoveTo(1) = 9
    // zigzag(0)=0, zigzag(0)=0
    // LineTo(2) = 18 (3 vertices minus 1 for MoveTo, minus 1 for closing = 2)
    // delta (10,0) → zigzag(10)=20, zigzag(0)=0
    // delta (0,10) → zigzag(0)=0, zigzag(10)=20
    // ClosePath(1) = (1 << 3) | 7 = 15
    expect(result).toEqual([9, 0, 0, 18, 20, 0, 0, 20, 15]);
  });

  it('should accumulate cursor across multi-line segments', () => {
    // Two line segments
    const coords = new Int32Array([0, 0, 10, 10, 20, 20, 30, 30]);
    const ends = new Uint32Array([2, 4]); // Two lines of 2 points each
    const result = encodeGeometry(coords, ends, MvtGeomType.LINESTRING);

    // Line 1: MoveTo(1)=9, (0,0)→(0,0), LineTo(1)=10, delta(10,10)→(20,20)
    // Line 2: MoveTo(1)=9, cursor at (10,10), delta to (20,20)=(10,10)→(20,20), LineTo(1)=10, delta(10,10)→(20,20)
    expect(result[0]).toBe(9);  // MoveTo(1)
    expect(result[3]).toBe(10); // LineTo(1)
    expect(result[6]).toBe(9);  // MoveTo(1) for second line
  });
});

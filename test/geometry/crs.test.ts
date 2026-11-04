import { describe, it, expect } from 'vitest';
import { classifyCrs, crsIdentifier, resolveFrame, LONLAT_FRAME, WEB_MERCATOR_FRAME } from '../../src/geometry/crs.js';
import { UnsupportedFormatError } from '../../src/errors.js';
import type { CrsInfo } from '../../src/types.js';

const crs = (fields: Partial<CrsInfo>): CrsInfo => ({
  org: null, code: 0, codeString: null, name: null, wkt: null, ...fields,
});

const WGS84_WKT1 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,' +
  'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const MERCATOR_WKT1 = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",' +
  'SPHEROID["WGS 84",6378137,298.257223563]],AUTHORITY["EPSG","4326"]],PROJECTION["Mercator_1SP"],' +
  'UNIT["metre",1,AUTHORITY["EPSG","9001"]]]';
const UTM_WKT2 = 'PROJCRS["ETRS89 / UTM zone 32N",BASEGEOGCRS["ETRS89",DATUM["ETRS89",' +
  'ELLIPSOID["GRS 1980",6378137,298.257222101]],ID["EPSG",4258]],CONVERSION["UTM zone 32N",' +
  'METHOD["Transverse Mercator",ID["EPSG",9807]]],USAGE[SCOPE["mapping"],AREA["Europe"]],ID["EPSG",25832]]';
const CUSTOM_TM_WKT1 = 'PROJCS["custom",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
  'AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],UNIT["metre",1,AUTHORITY["EPSG","9001"]]]';

describe('classifyCrs', () => {
  it.each<[string, CrsInfo | null, string]>([
    ['no CRS', null, 'lonlat'],
    ['EPSG:4326', crs({ org: 'EPSG', code: 4326 }), 'lonlat'],
    ['code without org (EPSG implied)', crs({ code: 4326 }), 'lonlat'],
    ['lower-case org', crs({ org: 'epsg', code: 4326 }), 'lonlat'],
    ['OGC:CRS84', crs({ org: 'OGC', codeString: 'CRS84' }), 'lonlat'],
    ['EPSG:3857', crs({ org: 'EPSG', code: 3857 }), 'webmercator'],
    ['EPSG:900913', crs({ code: 900913 }), 'webmercator'],
    ['ESRI:102100', crs({ org: 'ESRI', code: 102100 }), 'webmercator'],
    ['EPSG:25832', crs({ org: 'EPSG', code: 25832 }), 'other'],
    ['EPSG:4258 (ETRS89, within 2 m)', crs({ code: 4258 }), 'lonlat'],
    ['EPSG:4269 (NAD83, within 2 m)', crs({ org: 'EPSG', code: 4269 }), 'lonlat'],
    ['EPSG:4267 (NAD27, up to ~100 m off)', crs({ code: 4267 }), 'other'],
    ['EPSG:4301 (Tokyo, ~400 m off)', crs({ code: 4301 }), 'other'],
    ['WKT1 geographic NAD83 without authority', crs({ wkt: 'GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]' }), 'lonlat'],
    ['WKT1 geographic NAD27 without authority', crs({ wkt: 'GEOGCS["NAD27",DATUM["North_American_Datum_1927",SPHEROID["Clarke 1866",6378206.4,294.978698213898]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]' }), 'other'],
    ['empty CRS table', crs({}), 'lonlat'],
    ['name only', crs({ name: 'something' }), 'lonlat'],
    ['WKT1 geographic WGS 84 without top-level authority', crs({ wkt: WGS84_WKT1 }), 'lonlat'],
    ['WKT1 Pseudo-Mercator by name', crs({ wkt: MERCATOR_WKT1 }), 'webmercator'],
    ['WKT2 with top-level ID', crs({ wkt: UTM_WKT2 }), 'other'],
    ['WKT1 projected, nested authorities only', crs({ wkt: CUSTOM_TM_WKT1 }), 'other'],
    ['code wins over WKT', crs({ code: 4326, wkt: UTM_WKT2 }), 'lonlat'],
  ])('%s', (_, input, kind) => {
    expect(classifyCrs(input)).toBe(kind);
  });

  it('formats identifiers', () => {
    expect(crsIdentifier(crs({ code: 4326 }))).toBe('EPSG:4326');
    expect(crsIdentifier(crs({ org: 'ogc', codeString: 'crs84' }))).toBe('OGC:CRS84');
    expect(crsIdentifier(crs({}))).toBeNull();
  });
});

describe('resolveFrame', () => {
  it('picks built-in frames from the header', () => {
    expect(resolveFrame(null, undefined, 'a.fgb')).toBe(LONLAT_FRAME);
    expect(resolveFrame(crs({ code: 3857 }), 'auto', 'a.fgb')).toBe(WEB_MERCATOR_FRAME);
  });

  it('rejects other CRSs with an explicit error', () => {
    let err: unknown;
    try {
      resolveFrame(crs({ code: 25832 }), undefined, 'utm.fgb');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnsupportedFormatError);
    expect((err as Error).message).toMatch(/EPSG:25832/);
    expect((err as UnsupportedFormatError).path).toBe('utm.fgb');
  });

  it('lets the source override the header', () => {
    expect(resolveFrame(crs({ code: 4267 }), 'lonlat', 'a.fgb')).toBe(LONLAT_FRAME);
    expect(resolveFrame(null, 'webmercator', 'a.fgb')).toBe(WEB_MERCATOR_FRAME);
  });

  it('converts Web Mercator metres to mercator space and back', () => {
    const xy = new Float64Array([0, 0, 20037508.342789244, 20037508.342789244]);
    WEB_MERCATOR_FRAME.toMercator(xy);
    expect(xy[0]).toBeCloseTo(0.5, 12);
    expect(xy[1]).toBeCloseTo(0.5, 12);
    expect(xy[2]).toBeCloseTo(1, 12);
    expect(xy[3]).toBeCloseTo(0, 12);
    const q = WEB_MERCATOR_FRAME.queryBBox({ minX: 0.5, minY: 0.25, maxX: 0.75, maxY: 0.5 });
    expect(q.minX).toBeCloseTo(0, 6);
    expect(q.maxX).toBeCloseTo(20037508.342789244 / 2, 6);
    expect(q.minY).toBeCloseTo(0, 6);
    expect(q.maxY).toBeCloseTo(20037508.342789244 / 2, 6);
    const w = WEB_MERCATOR_FRAME.toWgs84BBox({ minX: -20037508.342789244, minY: 0, maxX: 0, maxY: 20037508.342789244 });
    expect(w.minX).toBeCloseTo(-180, 9);
    expect(w.maxY).toBeCloseTo(85.0511287798, 9);
  });
});

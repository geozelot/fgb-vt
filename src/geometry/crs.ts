/**
 * @module geometry/crs
 *
 * Coordinate reference systems of FlatGeobuf sources.
 *
 * Two systems are built in:
 *
 * - **WGS 84 longitude/latitude** — EPSG:4326, EPSG:4979, OGC:CRS84 and
 *   files that declare no CRS (or an unidentifiable one without WKT).
 * - **Web Mercator** — EPSG:3857 and its legacy aliases (EPSG:900913,
 *   EPSG:3785, ESRI:102100, ESRI:102113), read natively in metres.
 *
 * Any other CRS needs a {@link Projection} on the source; without one, the
 * source fails with {@link UnsupportedFormatError} rather than producing
 * misplaced tiles.
 *
 * A {@link CoordinateFrame} bundles what the pipeline needs for one CRS:
 * the index query box for a tile, the conversion of decoded coordinates to
 * mercator [0, 1] space, and the conversion of the data extent to WGS 84
 * (for TileJSON bounds).
 */

import type { BBox, CrsInfo } from '../types.js';
import { UnsupportedFormatError } from '../errors.js';
import { projectX, projectY, projectToMercator } from './project.js';
import { mercatorToWgs84BBox } from '../tiles.js';

/**
 * Conversion between a source's coordinate reference system and WGS 84
 * longitude/latitude, one coordinate at a time.
 *
 * Shaped to fit proj4js directly:
 *
 * ```ts
 * const utm = proj4('EPSG:25832', 'WGS84');
 * const projection: Projection = {
 *   toWgs84: (x, y) => utm.forward([x, y]),
 *   fromWgs84: (lon, lat) => utm.inverse([lon, lat]),
 * };
 * ```
 */
export interface Projection {
  /** Convert a coordinate in the source CRS to `[longitude, latitude]`. */
  toWgs84(x: number, y: number): ArrayLike<number>;
  /** Convert `[longitude, latitude]` to a coordinate in the source CRS. */
  fromWgs84(lon: number, lat: number): ArrayLike<number>;
}

/**
 * How a source's coordinates are interpreted:
 *
 * - `'auto'` (default) — from the CRS declared in the file header.
 * - `'lonlat'` — WGS 84 longitude/latitude, whatever the header says
 *   (e.g. for geographic CRSs within a metre or two of WGS 84, such as
 *   ETRS89 or NAD83, where that error is acceptable).
 * - `'webmercator'` — EPSG:3857 metres.
 * - a {@link Projection} — any other CRS.
 */
export type SourceCrs = 'auto' | 'lonlat' | 'webmercator' | Projection;

/** Classification of a declared CRS. */
export type CrsKind = 'lonlat' | 'webmercator' | 'other';

/**
 * Operations the tile pipeline needs for one coordinate reference system.
 */
export interface CoordinateFrame {
  /**
   * Index query box, in source coordinates, covering a clip box in
   * mercator [0, 1] space.
   */
  queryBBox(clip: BBox): BBox;
  /** Convert source coordinates to mercator [0, 1] space in place. */
  toMercator(xy: Float64Array): void;
  /** WGS 84 box covering a box in source coordinates. */
  toWgs84BBox(bbox: BBox): BBox;
}

/** Equatorial radius of the WGS 84 ellipsoid, the Web Mercator sphere radius. */
const EARTH_RADIUS = 6378137;
/** Length of the equator in Web Mercator metres. */
const CIRCUMFERENCE = 2 * Math.PI * EARTH_RADIUS;
/** Latitude limit of the Web Mercator square. */
const MAX_LATITUDE = 85.0511287798066;

const LONLAT_IDS = new Set(['EPSG:4326', 'EPSG:4979', 'OGC:CRS84', 'OGC:CRS84H']);
const WEB_MERCATOR_IDS = new Set([
  'EPSG:3857', 'EPSG:900913', 'EPSG:3785', 'EPSG:102100', 'EPSG:102113', 'ESRI:102100', 'ESRI:102113',
]);

/** WGS 84 longitude/latitude. */
export const LONLAT_FRAME: CoordinateFrame = {
  queryBBox: mercatorToWgs84BBox,
  toMercator: projectToMercator,
  toWgs84BBox: clampWgs84,
};

/** Web Mercator (EPSG:3857) metres. */
export const WEB_MERCATOR_FRAME: CoordinateFrame = {
  queryBBox(clip) {
    // Open-ended at the poles, like the lon/lat query
    return {
      minX: (clip.minX - 0.5) * CIRCUMFERENCE,
      minY: clip.maxY >= 1 ? -Infinity : (0.5 - clip.maxY) * CIRCUMFERENCE,
      maxX: (clip.maxX - 0.5) * CIRCUMFERENCE,
      maxY: clip.minY <= 0 ? Infinity : (0.5 - clip.minY) * CIRCUMFERENCE,
    };
  },
  toMercator(xy) {
    for (let i = 0; i < xy.length; i += 2) {
      xy[i] = xy[i] / CIRCUMFERENCE + 0.5;
      const y = 0.5 - xy[i + 1] / CIRCUMFERENCE;
      xy[i + 1] = y < 0 ? 0 : y > 1 ? 1 : y;
    }
  },
  toWgs84BBox(b) {
    const lon = (x: number) => (x / EARTH_RADIUS) * (180 / Math.PI);
    const lat = (y: number) => Math.atan(Math.sinh(y / EARTH_RADIUS)) * (180 / Math.PI);
    return clampWgs84({ minX: lon(b.minX), minY: lat(b.minY), maxX: lon(b.maxX), maxY: lat(b.maxY) });
  },
};

const projectionFrames = new WeakMap<Projection, CoordinateFrame>();

/**
 * Select the coordinate frame for a source.
 *
 * @param crs - CRS declared in the file header.
 * @param override - The source's `crs` setting.
 * @param path - Source path, for the error message.
 * @returns The frame to tile the source with.
 * @throws {UnsupportedFormatError} If the declared CRS is neither WGS 84
 *   nor Web Mercator and no projection is configured.
 */
export function resolveFrame(crs: CrsInfo | null, override: SourceCrs | undefined, path: string): CoordinateFrame {
  if (override !== undefined && override !== 'auto') {
    if (override === 'lonlat') return LONLAT_FRAME;
    if (override === 'webmercator') return WEB_MERCATOR_FRAME;
    let frame = projectionFrames.get(override);
    if (!frame) {
      frame = projectionFrame(override);
      projectionFrames.set(override, frame);
    }
    return frame;
  }
  switch (classifyCrs(crs)) {
    case 'lonlat':
      return LONLAT_FRAME;
    case 'webmercator':
      return WEB_MERCATOR_FRAME;
    default:
      throw new UnsupportedFormatError(
        `${path} uses ${describeCrs(crs!)}; only WGS 84 longitude/latitude and Web Mercator (EPSG:3857) ` +
        'are built in. Set the source\'s crs to a projection to read it.',
        { path },
      );
  }
}

const kinds = new WeakMap<CrsInfo, CrsKind>();

/**
 * Classify a declared CRS.
 *
 * The authority code is used when present (`org` + `code` or
 * `code_string`), otherwise the top-level authority in the WKT, otherwise
 * the WKT's structure (geographic on the WGS 84 datum, or a Pseudo-Mercator
 * projection). A missing CRS, or one with neither code nor WKT, counts as
 * longitude/latitude.
 *
 * @param crs - CRS declared in the file header.
 * @returns How the coordinates are interpreted.
 */
export function classifyCrs(crs: CrsInfo | null): CrsKind {
  if (!crs) return 'lonlat';
  let kind = kinds.get(crs);
  if (kind === undefined) {
    const id = crsIdentifier(crs) ?? (crs.wkt ? wktAuthority(crs.wkt) : null);
    if (id) {
      kind = LONLAT_IDS.has(id) ? 'lonlat' : WEB_MERCATOR_IDS.has(id) ? 'webmercator' : 'other';
    } else {
      kind = crs.wkt ? classifyWkt(crs.wkt) : 'lonlat';
    }
    kinds.set(crs, kind);
  }
  return kind;
}

/**
 * `ORG:CODE` identifier of a declared CRS, upper-cased, or `null` when it
 * has no code. A missing organisation means EPSG.
 *
 * @param crs - CRS declared in the file header.
 */
export function crsIdentifier(crs: CrsInfo): string | null {
  const org = crs.org?.trim().toUpperCase() || 'EPSG';
  const code = crs.codeString?.trim() || (crs.code !== 0 ? String(crs.code) : '');
  return code ? `${org}:${code.toUpperCase()}` : null;
}

/** Human-readable description of a CRS for error messages. */
function describeCrs(crs: CrsInfo): string {
  const id = crsIdentifier(crs) ?? (crs.wkt ? wktAuthority(crs.wkt) : null);
  if (id) return id;
  if (crs.name) return `CRS "${crs.name}"`;
  return 'a CRS defined only by WKT';
}

/**
 * Top-level `AUTHORITY["ORG","CODE"]` (WKT1) or `ID["ORG",CODE]` (WKT2)
 * of a WKT string, as `ORG:CODE`.
 *
 * Only the outermost node's authority counts: nested ones (datum, unit,
 * base CRS) identify something else.
 *
 * @param wkt - WKT definition.
 * @returns The identifier, or `null` if the top level has none.
 */
function wktAuthority(wkt: string): string | null {
  let depth = 0;
  let quoted = false;
  let found: string | null = null;
  for (let i = 0; i < wkt.length; i++) {
    const ch = wkt[i];
    if (quoted) {
      if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === '[' || ch === '(') {
      if (depth === 1) {
        const keyword = /([A-Za-z]+)\s*$/.exec(wkt.slice(Math.max(0, i - 16), i))?.[1].toUpperCase();
        if (keyword === 'AUTHORITY' || keyword === 'ID') {
          const m = /^\s*"([^"]*)"\s*,\s*"?([^",\])]*)"?/.exec(wkt.slice(i + 1));
          if (m && m[1].trim() && m[2].trim()) found = `${m[1].trim().toUpperCase()}:${m[2].trim().toUpperCase()}`;
        }
      }
      depth++;
    } else if (ch === ']' || ch === ')') {
      depth--;
    }
  }
  return found;
}

/**
 * Classify a WKT definition without a top-level authority by its
 * structure.
 */
function classifyWkt(wkt: string): CrsKind {
  const keyword = /^\s*([A-Za-z]+)/.exec(wkt)?.[1].toUpperCase();
  const upper = wkt.toUpperCase();
  if (keyword === 'GEOGCS' || keyword === 'GEOGCRS' || keyword === 'GEODCRS') {
    return /WGS[ _]?(19)?84/.test(upper) ? 'lonlat' : 'other';
  }
  if (keyword === 'PROJCS' || keyword === 'PROJCRS') {
    return /PSEUDO[ _-]MERCATOR|POPULAR[ _]VISUALISATION|MERCATOR_AUXILIARY_SPHERE/.test(upper)
      ? 'webmercator'
      : 'other';
  }
  return 'other';
}

/**
 * Frame for a user-supplied projection.
 *
 * Boxes are converted by sampling their edges (16 points per edge) and
 * padding the result by 1 % on each side, which covers the curvature of
 * common projections at tile scale.
 */
function projectionFrame(p: Projection): CoordinateFrame {
  return {
    queryBBox(clip) {
      const w = mercatorToWgs84BBox(clip);
      const box = sampleBBox(
        { ...w, minY: Math.max(w.minY, -MAX_LATITUDE), maxY: Math.min(w.maxY, MAX_LATITUDE) },
        (lon, lat) => p.fromWgs84(lon, lat),
      );
      return box ? pad(box, 0.01) : { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };
    },
    toMercator(xy) {
      for (let i = 0; i < xy.length; i += 2) {
        const c = p.toWgs84(xy[i], xy[i + 1]);
        xy[i] = projectX(c[0]);
        xy[i + 1] = projectY(c[1]);
      }
    },
    toWgs84BBox(b) {
      const box = sampleBBox(b, (x, y) => p.toWgs84(x, y));
      return box ? clampWgs84(box) : { minX: -180, minY: -90, maxX: 180, maxY: 90 };
    },
  };
}

/** Points sampled per box edge when converting boxes between systems. */
const EDGE_SAMPLES = 16;

/**
 * Bounding box of a box's edges after conversion, ignoring points that
 * fail to convert.
 *
 * @returns The box, or `null` if no sampled point converted.
 */
function sampleBBox(b: BBox, convert: (x: number, y: number) => ArrayLike<number>): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    const c = convert(x, y);
    if (Number.isFinite(c[0]) && Number.isFinite(c[1])) {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    }
  };
  for (let i = 0; i <= EDGE_SAMPLES; i++) {
    const t = i / EDGE_SAMPLES;
    const x = b.minX + (b.maxX - b.minX) * t;
    const y = b.minY + (b.maxY - b.minY) * t;
    add(x, b.minY);
    add(x, b.maxY);
    add(b.minX, y);
    add(b.maxX, y);
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

/** Grow a box by `fraction` of its size on each side. */
function pad(b: BBox, fraction: number): BBox {
  const dx = (b.maxX - b.minX) * fraction, dy = (b.maxY - b.minY) * fraction;
  return { minX: b.minX - dx, minY: b.minY - dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
}

/** Clamp a WGS 84 box to valid longitudes and latitudes. */
function clampWgs84(b: BBox): BBox {
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  return {
    minX: clamp(b.minX, -180, 180),
    minY: clamp(b.minY, -90, 90),
    maxX: clamp(b.maxX, -180, 180),
    maxY: clamp(b.maxY, -90, 90),
  };
}

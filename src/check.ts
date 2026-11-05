/**
 * @module check
 *
 * Whole-file verification of a FlatGeobuf file, for use before deploying
 * it (also available as the `fgb-vt check` command).
 *
 * Tiling reads only the parts of a file a tile needs, so a defect in other
 * parts surfaces only when some tile reaches it. {@link checkFile} reads
 * everything once:
 *
 * - **Header** — format version, schema, CRS (and whether fgb-vt can serve
 *   it without a projection), envelope.
 * - **Spatial index** — every node: valid boxes, parent boxes containing
 *   their children, child pointers in the packed layout, leaf offsets in
 *   increasing order starting at 0.
 * - **Features** — every feature is decoded; its byte offset must match its
 *   index entry, and its geometry must lie inside the entry's box (or the
 *   feature can never be found). The count must match the header.
 * - **Index quality** — how much the boxes of the nodes above the leaves
 *   overlap, which predicts how many bytes a tile reads.
 */

import type { Connector, ReadOptions } from './connectors/connector.js';
import type { BBox, FgbHeader } from './types.js';
import { ColumnType, GeomType } from './types.js';
import { headerByteSize, isValidBBox, parseHeader } from './fgb/header.js';
import { computeLevelBounds } from './fgb/index.js';
import { decodeFeatureChunk } from './fgb/feature.js';
import { classifyCrs, crsIdentifier } from './geometry/crs.js';
import { FgbVtError } from './errors.js';

/** A problem found by {@link checkFile}. */
export interface CheckProblem {
  /** `error`: tiles will be wrong or fail. `warning`: tiles work, but not as well as they could. */
  severity: 'error' | 'warning';
  /** What is wrong, and where. */
  message: string;
  /** Byte offset in the file, when the problem is located. */
  offset?: number;
}

/** Result of {@link checkFile}. */
export interface CheckReport {
  /** The path checked. */
  path: string;
  /** `true` when no errors were found (warnings allowed). */
  ok: boolean;
  /** Format version from the magic bytes, e.g. `3.0.1`, or `null` if unreadable. */
  version: string | null;
  /** File size in bytes, when the connector reports it. */
  size: number | null;
  /** Version tag reported by the connector (ETag, file metadata), or `null`. */
  etag: string | null;
  /** Header summary, or `null` if the header could not be read. */
  header: {
    name: string | null;
    title: string | null;
    description: string | null;
    geometryType: string;
    /** Feature count from the header (`0`: unknown). */
    featuresCount: number;
    columns: Array<{ name: string; type: string }>;
    /** Feature id column fgb-vt detects, or `null`. */
    idColumn: string | null;
    /** CRS identifier (e.g. `EPSG:4326`) or name, or `null` without one. */
    crs: string | null;
    /** How fgb-vt reads the CRS: natively, or only with a `Projection` on the source. */
    crsSupport: 'lonlat' | 'webmercator' | 'needs-projection';
    /** Envelope from the header, or `null`. */
    envelope: BBox | null;
  } | null;
  /** Spatial index summary, or `null` without an index. */
  index: {
    nodeSize: number;
    /** Tree levels, including leaves and root. */
    levels: number;
    bytes: number;
    /**
     * Total box area of the nodes directly above the leaves, divided by
     * the area of the root box (`null` for trees too small to tell). Close
     * to 1 means compact, well-sorted nodes; large values mean nodes that
     * overlap, so tiles read many features they do not need.
     */
    overlap: number | null;
  } | null;
  /** Feature scan summary, or `null` when skipped (`quick`) or impossible. */
  features: {
    /** Stored features read and decoded. */
    checked: number;
    /** Of those, features without usable geometry (empty, unknown or abstract types). */
    withoutGeometry: number;
    /** Feature bytes read. */
    bytes: number;
    /** Whether the whole feature section was read (see `maxBytes`). */
    complete: boolean;
    /** Extent of the decoded geometries, or `null` if none. */
    bbox: BBox | null;
  } | null;
  /** Problems found, errors first. */
  problems: CheckProblem[];
}

/** Options for {@link checkFile}. */
export interface CheckOptions {
  /** Check only the header and the spatial index, not the features. @defaultValue false */
  quick?: boolean;
  /** Read at most this many bytes of features. @defaultValue Infinity */
  maxBytes?: number;
  /** Aborts the check. */
  signal?: AbortSignal;
}

/** First read: header plus the top of the index. */
const HEAD_BYTES = 256 * 1024;
/** Index nodes read per request. */
const NODE_CHUNK = 65_536;
/** Feature bytes read per request. */
const FEATURE_CHUNK = 4 * 1024 * 1024;
/** Problems of one kind reported individually before they are only counted. */
const MAX_REPORTED = 10;
/** Byte size of one packed R-tree node. */
const NODE_BYTES = 40;

const GEOMETRY_TYPES = [
  'Unknown', 'Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon',
  'GeometryCollection', 'CircularString', 'CompoundCurve', 'CurvePolygon', 'MultiCurve',
  'MultiSurface', 'Curve', 'Surface', 'PolyhedralSurface', 'TIN', 'Triangle',
];
const COLUMN_TYPES = [
  'Byte', 'UByte', 'Bool', 'Short', 'UShort', 'Int', 'UInt', 'Long', 'ULong', 'Float', 'Double',
  'String', 'Json', 'DateTime', 'Binary',
];

/**
 * Verify a FlatGeobuf file completely: header, every spatial index node,
 * and (unless `quick`) every feature. Format problems are reported, not
 * thrown.
 *
 * @param connector - Connector to read through.
 * @param path - Connector-specific path of the file.
 * @param options - Scope and limits of the check.
 * @returns The report; `ok` is `false` if any error was found.
 * @throws {ConnectorError} If the file cannot be read at all.
 *
 * @example
 * ```typescript
 * import { checkFile, LocalConnector } from '@geozelot/fgb-vt';
 *
 * const report = await checkFile(new LocalConnector(), './buildings.fgb');
 * if (!report.ok) console.error(report.problems);
 * ```
 */
export async function checkFile(connector: Connector, path: string, options: CheckOptions = {}): Promise<CheckReport> {
  const { signal } = options;
  const readOptions: ReadOptions | undefined = signal ? { signal } : undefined;
  const report: CheckReport = {
    path, ok: false, version: null, size: null, etag: null, header: null, index: null, features: null, problems: [],
  };
  const problems = new ProblemLog(report.problems);

  const head = connector.readHead
    ? await connector.readHead(path, HEAD_BYTES, readOptions)
    : { bytes: await connector.read(path, 0, HEAD_BYTES, readOptions), size: null, etag: null };
  report.size = head.size;
  report.etag = head.etag;
  const versioned: ReadOptions | undefined = head.etag !== null ? { ...readOptions, ifMatch: head.etag } : readOptions;
  const read = (offset: number, length: number) => connector.read(path, offset, length, versioned);

  let header: FgbHeader;
  try {
    let bytes = head.bytes;
    if (bytes.length >= 8) report.version = `${bytes[3]}.0.${bytes[7]}`;
    const headerSize = headerByteSize(bytes);
    if (headerSize > bytes.length) bytes = concat(bytes, await read(bytes.length, headerSize - bytes.length));
    header = parseHeader(bytes);
  } catch (err) {
    if (!(err instanceof FgbVtError) || err.code === 'FGB_IO') throw err;
    problems.add('error', 'header', err.message, (err as { offset?: number }).offset);
    return finish(report, problems);
  }
  summarizeHeader(report, header, problems);
  if (head.size !== null && head.size < header.featuresOffset) {
    problems.add('error', 'size', `The file is truncated: ${head.size} bytes, but the index ends at ${header.featuresOffset}`);
    return finish(report, problems);
  }

  try {
    const leaves = header.indexSize > 0
      ? await checkIndex(report, header, read, problems, signal)
      : null;
    if (!options.quick) {
      await checkFeatures(report, header, read, leaves, problems, options.maxBytes ?? Infinity, signal);
    }
    await leaves?.finish();
  } catch (err) {
    if (!(err instanceof FgbVtError) || err.code === 'FGB_IO' || err.code === 'FGB_SOURCE_CHANGED') throw err;
    problems.add('error', 'fatal', err.message, (err as { offset?: number }).offset);
  }
  return finish(report, problems);
}

// == Header ==================================================================

function summarizeHeader(report: CheckReport, header: FgbHeader, problems: ProblemLog): void {
  const kind = classifyCrs(header.crs);
  const crs = header.crs ? (crsIdentifier(header.crs) ?? header.crs.name) : null;
  report.header = {
    name: header.name,
    title: header.title,
    description: header.description,
    geometryType: GEOMETRY_TYPES[header.geometryType] ?? `type ${header.geometryType}`,
    featuresCount: header.featuresCount,
    columns: header.columns.map(c => ({ name: c.name, type: COLUMN_TYPES[c.type] ?? `type ${c.type}` })),
    idColumn: header.idColumnIndex >= 0 ? header.columns[header.idColumnIndex].name : null,
    crs,
    crsSupport: kind === 'other' ? 'needs-projection' : kind,
    envelope: header.bbox,
  };
  if (kind === 'other') {
    problems.add('warning', 'crs',
      `The CRS ${crs ?? '(given as WKT only)'} is not longitude/latitude or Web Mercator: ` +
      'sources need a crs projection (Source.crs), or reproject the file to EPSG:4326 or EPSG:3857');
  }
  if (header.indexSize === 0) {
    problems.add('warning', 'no-index',
      'The file has no spatial index: every tile scans all features (up to maxScanBytes, 32 MiB by default). ' +
      'Rewrite it with an index, e.g. ogr2ogr -f FlatGeobuf out.fgb in.fgb');
  }
  if (header.columns.some(c => c.type === ColumnType.Binary)) {
    problems.add('warning', 'binary', 'Binary columns are never written to tiles (MVT has no binary values)');
  }
  if (header.geometryType === GeomType.Unknown) {
    problems.add('warning', 'mixed', 'The geometry type is Unknown (mixed): each feature carries its own type');
  }
}

// == Index ===================================================================

/** Sequential access to the leaf level, shared by the index and feature checks. */
interface LeafCursor {
  /** Number of leaves. */
  count: number;
  /** Load leaf `k` (in increasing `k`) and return its offset and box. */
  at(k: number): Promise<{ offset: number; minX: number; minY: number; maxX: number; maxY: number }>;
  /** Check the levels above the leaves (after every leaf was visited). */
  finish(): Promise<void>;
}

async function checkIndex(
  report: CheckReport,
  header: FgbHeader,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  problems: ProblemLog,
  signal: AbortSignal | undefined,
): Promise<LeafCursor | null> {
  const { featuresCount, indexNodeSize: nodeSize, indexOffset, indexSize } = header;
  let levels: Array<[number, number]>;
  try {
    levels = computeLevelBounds(featuresCount, nodeSize);
  } catch (err) {
    problems.add('error', 'index', (err as Error).message);
    return null;
  }
  report.index = { nodeSize, levels: levels.length, bytes: indexSize, overlap: null };

  const readNodes = async (start: number, count: number): Promise<DataView> => {
    signal?.throwIfAborted();
    const bytes = await read(indexOffset + start * NODE_BYTES, count * NODE_BYTES);
    if (bytes.length < count * NODE_BYTES) {
      throw new FgbVtError('FGB_FORMAT', `The spatial index is truncated at node ${start + Math.floor(bytes.length / NODE_BYTES)}`);
    }
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };

  const root = box(await readNodes(0, 1), 0);
  if (!isValidBBox(root)) {
    problems.add('error', 'root', `The index root box [${root.minX}, ${root.minY}, ${root.maxX}, ${root.maxY}] is empty: no query finds anything`);
  }

  // Unions of each level's nodes, grouped by parent, filled bottom-up
  const [leafStart, leafEnd] = levels[0];
  const parentCount = (levels[1][1] - levels[1][0]);
  let unions = emptyBoxes(parentCount);
  let previousOffset = -1;
  let chunk: DataView | null = null;
  let chunkStart = 0;

  const cursor: LeafCursor = {
    count: leafEnd - leafStart,
    async at(k) {
      const node = leafStart + k;
      if (!chunk || node >= chunkStart + chunk.byteLength / NODE_BYTES) {
        chunkStart = node;
        chunk = await readNodes(node, Math.min(NODE_CHUNK, leafEnd - node));
        // Check the leaves of the chunk as they arrive
        const n = chunk.byteLength / NODE_BYTES;
        for (let i = 0; i < n; i++) {
          const leaf = chunkStart - leafStart + i;
          const b = box(chunk, i);
          const offset = u64(chunk, i);
          if (leaf === 0 && offset !== 0) {
            problems.add('error', 'leaf-first', `The first feature in index order is at byte ${offset} of the data, not 0`);
          }
          if (offset <= previousOffset) {
            problems.add('error', 'leaf-order', `Index entry ${leaf} points to byte ${offset}, not after entry ${leaf - 1} (byte ${previousOffset})`);
          }
          previousOffset = offset;
          if (!isValidBBox(b)) {
            problems.add('error', 'leaf-box', `Index entry ${leaf} has an empty box: its feature can never be found`);
          }
          extend(unions, Math.floor(leaf / nodeSize), b);
        }
      }
      const i = node - chunkStart;
      return { offset: u64(chunk, i), ...box(chunk, i) };
    },
    async finish() {
      // Visit leaves not reached by the feature scan
      for (let k = chunk ? chunkStart - leafStart + chunk.byteLength / NODE_BYTES : 0; k < cursor.count; k += NODE_CHUNK) {
        await cursor.at(k);
      }
      // Each upper level: boxes must contain their children, child pointers follow the packed layout
      for (let level = 1; level < levels.length; level++) {
        const [start, end] = levels[level];
        const [childStart] = levels[level - 1];
        const next = level + 1 < levels.length ? emptyBoxes(levels[level + 1][1] - levels[level + 1][0]) : null;
        let area = 0;
        for (let s = start; s < end; s += NODE_CHUNK) {
          const n = Math.min(NODE_CHUNK, end - s);
          const view = await readNodes(s, n);
          for (let i = 0; i < n; i++) {
            const position = s - start + i;
            const b = box(view, i);
            const child = u64(view, i);
            if (child !== childStart + position * nodeSize) {
              problems.add('warning', 'layout',
                `Index node ${s + i} points to child ${child}, not ${childStart + position * nodeSize} as in the packed layout ` +
                '(queries work, but subtrees inside a tile are always descended)');
            }
            if (!contains(b, unions, position)) {
              problems.add('error', 'node-box', `Index node ${s + i} does not contain the boxes of its children: features below it can be missed`);
            }
            if (isValidBBox(b)) area += (b.maxX - b.minX) * (b.maxY - b.minY);
            if (next) extend(next, Math.floor(position / nodeSize), b);
          }
        }
        if (level === 1 && levels.length >= 3 && isValidBBox(root)) {
          const rootArea = (root.maxX - root.minX) * (root.maxY - root.minY);
          if (rootArea > 0) report.index!.overlap = area / rootArea;
        }
        if (next) unions = next;
      }
      const overlap = report.index!.overlap;
      if (overlap !== null && overlap > 16) {
        problems.add('warning', 'overlap',
          `Index nodes overlap a lot (total area ${overlap.toFixed(1)}x the extent): features are probably not sorted ` +
          'spatially, so tiles read many features they do not need. Rewrite the file with GDAL (ogr2ogr)');
      }
    },
  };
  return cursor;
}

// == Features ================================================================

async function checkFeatures(
  report: CheckReport,
  header: FgbHeader,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  leaves: LeafCursor | null,
  problems: ProblemLog,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const start = header.featuresOffset;
  const end = report.size !== null ? report.size : Infinity;
  const limit = Math.min(end, start + maxBytes);
  const stats = { checked: 0, withoutGeometry: 0, bytes: 0, complete: false, bbox: null as BBox | null };
  report.features = stats;

  let pos = start;
  let buffer: Uint8Array = new Uint8Array(0);
  let bufferStart = start;
  for (;;) {
    signal?.throwIfAborted();
    // Ensure the size prefix is loaded
    if (pos + 4 > bufferStart + buffer.length) {
      if (pos >= limit) break;
      buffer = await read(pos, Math.max(4, Math.min(FEATURE_CHUNK, limit - pos)));
      bufferStart = pos;
      stats.bytes += buffer.length;
      if (buffer.length < 4) {
        if (buffer.length > 0) problems.add('error', 'truncated', 'The file ends inside a feature size prefix', pos);
        stats.complete = true;
        break;
      }
    }
    const at = pos - bufferStart;
    const size = new DataView(buffer.buffer, buffer.byteOffset + at, 4).getUint32(0, true);
    if (size === 0) {
      stats.complete = true; // end-of-data marker
      break;
    }
    if (pos + 4 + size > bufferStart + buffer.length) {
      if (pos + 4 + size > end) {
        problems.add('error', 'truncated', `The file ends inside feature ${stats.checked} (${size} bytes)`, pos);
        stats.complete = true;
        break;
      }
      if (pos + 4 + size > limit) break; // beyond maxBytes
      buffer = await read(pos, Math.max(4 + size, Math.min(FEATURE_CHUNK, limit - pos)));
      bufferStart = pos;
      stats.bytes += buffer.length;
      if (buffer.length < 4 + size) {
        problems.add('error', 'truncated', `The file ends inside feature ${stats.checked} (${size} bytes)`, pos);
        stats.complete = true;
        break;
      }
    }

    const k = stats.checked++;
    const feature = buffer.subarray(pos - bufferStart, pos - bufferStart + 4 + size);
    let geometry: BBox | null = null;
    try {
      const { features, skipped } = decodeFeatureChunk(feature, header, { fileOffset: pos });
      if (skipped > 0) stats.withoutGeometry++;
      for (const f of features) geometry = extendBox(geometry, f.xy);
    } catch (err) {
      if (!(err instanceof FgbVtError)) throw err;
      problems.add('error', 'feature', `Feature ${k}: ${err.message}`, pos);
    }
    if (geometry) stats.bbox = union(stats.bbox, geometry);

    if (leaves) {
      if (k >= leaves.count) {
        problems.add('error', 'count', `The data holds more features than the index (${leaves.count})`, pos);
      } else {
        const leaf = await leaves.at(k);
        if (leaf.offset !== pos - start) {
          problems.add('error', 'offset',
            `Feature ${k} is at byte ${pos - start} of the data, but its index entry says ${leaf.offset}`, pos);
        }
        if (geometry && isValidBBox(leaf) && !inside(geometry, leaf)) {
          problems.add('error', 'feature-box', `Feature ${k} lies outside its index entry's box: tiles will miss it`, pos);
        }
      }
    }
    pos += 4 + size;
    if (pos >= end) {
      stats.complete = true;
      break;
    }
  }

  if (stats.complete) {
    if (header.featuresCount > 0 && stats.checked !== header.featuresCount) {
      problems.add('error', 'count', `The header lists ${header.featuresCount} features, the data holds ${stats.checked}`);
    }
    if (leaves && stats.checked < leaves.count) {
      problems.add('error', 'count', `The index lists ${leaves.count} features, the data holds ${stats.checked}`);
    }
  } else {
    problems.add('warning', 'partial', `Only the first ${stats.checked} features were checked (maxBytes)`);
  }
}

// == Helpers =================================================================

/** Collects problems, reporting at most a few of each kind individually. */
class ProblemLog {
  private readonly kinds = new Map<string, { n: number; severity: CheckProblem['severity']; last: CheckProblem }>();

  constructor(private readonly out: CheckProblem[]) {}

  add(severity: CheckProblem['severity'], kind: string, message: string, offset?: number): void {
    const entry = this.kinds.get(kind);
    if (entry && entry.n >= MAX_REPORTED) {
      entry.n++;
      return;
    }
    const problem: CheckProblem = { severity, message, ...(offset !== undefined ? { offset } : {}) };
    this.out.push(problem);
    if (entry) {
      entry.n++;
      entry.last = problem;
    } else {
      this.kinds.set(kind, { n: 1, severity, last: problem });
    }
  }

  /** Insert, after the last reported problem of each kind, how many more there were. */
  summarize(): void {
    for (const { n, severity, last } of this.kinds.values()) {
      if (n <= MAX_REPORTED) continue;
      this.out.splice(this.out.indexOf(last) + 1, 0, { severity, message: `… and ${n - MAX_REPORTED} more like the above` });
    }
  }
}

function finish(report: CheckReport, problems: ProblemLog): CheckReport {
  problems.summarize();
  // Errors first; the sort is stable, so a count follows its kind's problems
  report.problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  report.ok = !report.problems.some(p => p.severity === 'error');
  return report;
}

function box(view: DataView, i: number): BBox {
  const o = i * NODE_BYTES;
  return {
    minX: view.getFloat64(o, true), minY: view.getFloat64(o + 8, true),
    maxX: view.getFloat64(o + 16, true), maxY: view.getFloat64(o + 24, true),
  };
}

function u64(view: DataView, i: number): number {
  const o = i * NODE_BYTES + 32;
  return view.getUint32(o + 4, true) * 0x100000000 + view.getUint32(o, true);
}

/** `n` boxes (minX, minY, maxX, maxY) that contain nothing yet. */
function emptyBoxes(n: number): Float64Array {
  const boxes = new Float64Array(n * 4);
  for (let i = 0; i < n; i++) {
    boxes[i * 4] = Infinity;
    boxes[i * 4 + 1] = Infinity;
    boxes[i * 4 + 2] = -Infinity;
    boxes[i * 4 + 3] = -Infinity;
  }
  return boxes;
}

/** Grow box `i` of `boxes` by `b` (ignoring an empty `b`). */
function extend(boxes: Float64Array, i: number, b: BBox): void {
  if (!isValidBBox(b) || i * 4 >= boxes.length) return;
  boxes[i * 4] = Math.min(boxes[i * 4], b.minX);
  boxes[i * 4 + 1] = Math.min(boxes[i * 4 + 1], b.minY);
  boxes[i * 4 + 2] = Math.max(boxes[i * 4 + 2], b.maxX);
  boxes[i * 4 + 3] = Math.max(boxes[i * 4 + 3], b.maxY);
}

/** Whether `b` contains box `i` of `boxes` (an empty one always). */
function contains(b: BBox, boxes: Float64Array, i: number): boolean {
  if (boxes[i * 4] > boxes[i * 4 + 2]) return true;
  return inside({ minX: boxes[i * 4], minY: boxes[i * 4 + 1], maxX: boxes[i * 4 + 2], maxY: boxes[i * 4 + 3] }, b);
}

/** Whether `a` lies inside `b`, allowing for float rounding of stored boxes. */
function inside(a: BBox, b: BBox): boolean {
  const eps = 1e-9 * Math.max(1, Math.abs(b.minX), Math.abs(b.maxX), Math.abs(b.minY), Math.abs(b.maxY));
  return a.minX >= b.minX - eps && a.maxX <= b.maxX + eps && a.minY >= b.minY - eps && a.maxY <= b.maxY + eps;
}

function extendBox(b: BBox | null, xy: Float64Array): BBox | null {
  let out = b;
  for (let i = 0; i < xy.length; i += 2) {
    const x = xy[i], y = xy[i + 1];
    if (x - x !== 0 || y - y !== 0) continue; // NaN (e.g. empty points) or infinite
    if (!out) out = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      if (x < out.minX) out.minX = x;
      if (x > out.maxX) out.maxX = x;
      if (y < out.minY) out.minY = y;
      if (y > out.maxY) out.maxY = y;
    }
  }
  return out;
}

function union(a: BBox | null, b: BBox): BBox {
  if (!a) return { ...b };
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

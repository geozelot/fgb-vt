/**
 * @module fgb/reader
 *
 * Range-efficient access to one FlatGeobuf file through a {@link Connector}.
 *
 * An {@link FgbSource} reads only what a tile needs:
 *
 * 1. **First read** — one request of `prefetch` bytes from offset 0. It
 *    yields the header and, because the packed R-tree follows the header
 *    root-first, the top levels of the spatial index. Connectors that
 *    implement `readHead` also report the file size (exact length of the
 *    last feature) and a version tag (consistency checks, cache keys).
 * 2. **Index search** — top-down, one level at a time. Each level reads
 *    only the index pages holding the nodes the query reaches, coalesced
 *    into as few requests as possible. Subtrees whose bounding box lies
 *    entirely inside the query need no descent: their features form a
 *    contiguous run computable from the packed tree layout, and only the
 *    run's two boundary leaves are read for byte offsets.
 * 3. **Feature read** — contiguous feature runs become byte ranges, merged
 *    across small gaps, read with one batched call.
 *
 * Index pages are fixed-size blocks of whole nodes. With a
 * {@link ByteCache}, the header and every page read are cached under keys
 * that include the file's version tag, so later tiles — in the same
 * process or a warm serverless container — skip the index reads already
 * done. Reads carry the version tag (`ifMatch`); if the file changes, the
 * connector raises {@link SourceChangedError} and the pipeline reopens it.
 *
 * Files without a spatial index are scanned sequentially, bounded by
 * `maxScanBytes`.
 */

import type { Connector, ReadOptions } from '../connectors/connector.js';
import type { ByteCache } from '../cache.js';
import type { BBox, FgbHeader, RawFeature } from '../types.js';
import { headerByteSize, parseHeader } from './header.js';
import { computeLevelBounds } from './index.js';
import { decodeFeatureChunk } from './feature.js';
import { FormatError, LimitExceededError } from '../errors.js';

/** Byte size of one packed R-tree node (4 x f64 bbox + u64 offset). */
const NODE_BYTES = 40;

/** First read size when neither options nor connector hints specify one. */
const DEFAULT_PREFETCH = 64 * 1024;

/** Range merge gap when neither options nor connector hints specify one. */
const DEFAULT_COALESCE_GAP = 16 * 1024;

/** Merged reads are not grown beyond this size, so large reads stay parallel. */
const MAX_MERGED_RANGE = 8 * 1024 * 1024;

/** Default budget for scanning files without a spatial index. */
const DEFAULT_MAX_SCAN_BYTES = 32 * 1024 * 1024;

/** Chunk size for sequential scans. */
const SCAN_CHUNK = 4 * 1024 * 1024;

/** Initial guess for the length of the last feature when the file size is unknown. */
const LAST_FEATURE_GUESS = 64 * 1024;

/** Index page size bounds, in nodes. */
const MIN_PAGE_NODES = 64;
const MAX_PAGE_NODES = 1024;

/** Version of the cache entry layout; part of every key. */
const CACHE_PREFIX = 'fgb-vt:1';

// == Public options =========================================================

/**
 * I/O options for reading FlatGeobuf sources.
 *
 * Accepted wherever tiling options are (`tile()`, {@link TileClient},
 * {@link TileServer}) and applied to every source of the call or instance.
 */
export interface IoOptions {
  /**
   * Cache for file headers and spatial index pages.
   *
   * By default `tile()` shares one module-level {@link MemoryCache} (so warm
   * serverless containers reuse it) and every `TileClient` / `TileServer`
   * gets its own. Pass a custom {@link ByteCache} to size or back it
   * differently, or `false` to read everything per request.
   *
   * Entries are keyed by source path and version tag. With connectors that
   * report no version tag, files must not change while cached.
   */
  cache?: ByteCache | false;
  /**
   * Size of the first read of each file, covering the header and the top
   * of the spatial index. Defaults to the connector's hint (64 KiB local,
   * 256 KiB HTTP/S3 in Node.js, 16 KiB HTTP in browsers).
   */
  prefetch?: number;
  /**
   * Byte ranges separated by at most this many bytes are merged into one
   * read. Defaults to the connector's hint (4 KiB local, 64 KiB HTTP/S3).
   */
  coalesceGap?: number;
  /**
   * Largest feature section (in bytes) that may be scanned sequentially
   * for a file without a spatial index; larger files raise
   * {@link LimitExceededError}.
   *
   * @defaultValue 33554432 (32 MiB)
   */
  maxScanBytes?: number;
}

/**
 * Resolved I/O settings shared by the sources of one call or instance.
 */
export interface IoContext {
  /** Header and index page cache, or `null` for none. */
  cache: ByteCache | null;
  /** Memo of opened sources, or `null` to open per request. */
  registry: SourceRegistry | null;
  prefetch?: number;
  coalesceGap?: number;
  maxScanBytes?: number;
}

/**
 * A contiguous byte range within the file.
 */
export interface ByteRange {
  /** Absolute byte offset from the start of the file. */
  offset: number;
  /** Number of bytes. */
  length: number;
}

/**
 * Per-request settings for reading from an opened source.
 */
export interface QueryOptions {
  /** Range merge gap in bytes (defaults to the connector hint). */
  coalesceGap?: number;
  /** Scan budget for files without an index. */
  maxScanBytes?: number;
  /** Aborts the reads when signalled. */
  signal?: AbortSignal;
}

// == Source ==================================================================

/**
 * An opened FlatGeobuf file: parsed header plus range-efficient access to
 * its index and features.
 */
export class FgbSource {
  /** Parsed header. */
  readonly header: FgbHeader;
  /** File size in bytes, or `null` if the connector could not report it. */
  readonly size: number | null;
  /** Version tag reported by the connector, or `null`. */
  readonly etag: string | null;

  private readonly connector: Connector;
  private readonly path: string;
  private readonly context: IoContext;
  /** Per-level `[start, end)` node ranges; empty without an index. */
  private readonly levelBounds: Array<[number, number]>;
  /** Nodes per index page. */
  private readonly pageNodes: number;
  /** Index pages from the first read, kept when there is no cache. */
  private readonly seed = new Map<number, Uint8Array>();
  /** Page reads in progress, shared by concurrent queries. */
  private readonly inflight = new Map<number, Promise<Uint8Array>>();

  private constructor(
    connector: Connector,
    path: string,
    header: FgbHeader,
    size: number | null,
    etag: string | null,
    context: IoContext,
  ) {
    this.connector = connector;
    this.path = path;
    this.header = header;
    this.size = size;
    this.etag = etag;
    this.context = context;
    this.levelBounds = header.indexSize > 0
      ? computeLevelBounds(header.featuresCount, header.indexNodeSize)
      : [];
    const prefetch = this.prefetchSize();
    this.pageNodes = Math.max(MIN_PAGE_NODES, Math.min(MAX_PAGE_NODES, Math.floor(prefetch / NODE_BYTES / 4)));
  }

  /**
   * Open a FlatGeobuf file: take the header from the cache, or read it
   * (together with the top of the index) in one request.
   *
   * @param connector - Connector to read through.
   * @param path - Connector-specific path of the file.
   * @param context - Shared I/O settings and cache.
   * @param signal - Optional abort signal for the reads.
   * @returns The opened source.
   * @throws {FormatError} If the file is not valid FlatGeobuf or is truncated.
   * @throws {UnsupportedFormatError} If it uses an unsupported format version.
   */
  static async open(
    connector: Connector,
    path: string,
    context: IoContext,
    signal?: AbortSignal,
  ): Promise<FgbSource> {
    const { cache } = context;
    const headerKey = headerCacheKey(path);

    if (cache) {
      const cached = decodeHeaderEntry(await cache.get(headerKey));
      if (cached) {
        return new FgbSource(connector, path, parseHeader(cached.headerBytes), cached.size, cached.etag, context);
      }
    }

    const prefetch = prefetchFor(connector, context);
    const readOptions: ReadOptions | undefined = signal ? { signal } : undefined;
    const head = connector.readHead
      ? await connector.readHead(path, prefetch, readOptions)
      : { bytes: await connector.read(path, 0, prefetch, readOptions), size: null, etag: null };

    let bytes = head.bytes;
    const headerSize = headerByteSize(bytes);
    if (headerSize > bytes.length) {
      const rest = await connector.read(path, bytes.length, headerSize - bytes.length, {
        ...readOptions,
        ...(head.etag !== null ? { ifMatch: head.etag } : {}),
      });
      bytes = concat(bytes, rest);
    }

    const header = parseHeader(bytes);
    if (head.size !== null && head.size < header.featuresOffset) {
      throw new FormatError(
        `Truncated FlatGeobuf file: ${head.size} bytes, but the index ends at ${header.featuresOffset}`,
        { path, offset: head.size },
      );
    }

    const source = new FgbSource(connector, path, header, head.size, head.etag, context);
    if (cache) {
      await cache.set(headerKey, encodeHeaderEntry(head.size, head.etag, bytes.subarray(0, headerSize)));
    }
    await source.seedPages(bytes);
    return source;
  }

  /** Whether the file has a spatial index. */
  get hasIndex(): boolean {
    return this.levelBounds.length > 0;
  }

  /**
   * Read and decode the features whose index entries intersect `bbox`, or
   * all features of an unindexed file (bounded by `maxScanBytes`).
   *
   * @param bbox - Query box in the file's coordinate system.
   * @param options - Range merging, scan budget and abort signal.
   * @returns Decoded features (callers still clip to the exact tile).
   * @throws {LimitExceededError} If an unindexed file exceeds the scan budget.
   * @throws {SourceChangedError} If the file changed since it was opened.
   */
  async readFeatures(bbox: BBox, options: QueryOptions = {}): Promise<RawFeature[]> {
    const { signal } = options;
    if (!this.hasIndex) return this.scan(options);

    const runs = await this.searchRuns(bbox, options);
    if (runs.length === 0) return [];
    const ranges = coalesceRanges(runs, this.coalesceGap(options), MAX_MERGED_RANGE);

    const chunks = await this.connector.readRanges(this.path, ranges, this.readOptions(signal));
    const features: RawFeature[] = [];
    const rereads: Array<Promise<RawFeature[]>> = [];
    let run = 0;
    for (let c = 0; c < chunks.length; c++) {
      // Decode only features inside requested runs, not those read because
      // they sit in a gap between two runs. Offsets increase monotonically.
      const base = ranges[c].offset;
      const accept = (offset: number) => {
        const at = base + offset;
        while (run < runs.length && runs[run].offset + runs[run].length <= at) run++;
        return run < runs.length && at >= runs[run].offset;
      };
      const chunk = decodeFeatureChunk(chunks[c], this.header, accept);
      for (const f of chunk.features) features.push(f);
      if (chunk.truncatedAt >= 0) {
        // Only the last feature's length can be an estimate (unknown file size)
        rereads.push(this.readFeatureAt(ranges[c].offset + chunk.truncatedAt, signal));
      }
    }
    for (const more of await Promise.all(rereads)) {
      for (const f of more) features.push(f);
    }
    return features;
  }

  /**
   * Query the spatial index for the byte ranges of features intersecting
   * `bbox`, merged for reading.
   *
   * @param bbox - Query box in the file's coordinate system.
   * @param options - Range merging and abort signal.
   * @returns Sorted, merged byte ranges; empty when nothing intersects.
   * @throws {FormatError} If the index is truncated or inconsistent.
   */
  async featureRanges(bbox: BBox, options: QueryOptions = {}): Promise<ByteRange[]> {
    return coalesceRanges(await this.searchRuns(bbox, options), this.coalesceGap(options), MAX_MERGED_RANGE);
  }

  /**
   * Search the spatial index for the exact byte runs of features
   * intersecting `bbox` (consecutive matching features form one run).
   *
   * @param bbox - Query box in the file's coordinate system.
   * @param options - Range merging (for index pages) and abort signal.
   * @returns Sorted, non-overlapping feature byte runs.
   * @throws {FormatError} If the index is truncated or inconsistent.
   */
  private async searchRuns(bbox: BBox, options: QueryOptions): Promise<ByteRange[]> {
    if (!this.hasIndex) return [];
    const { featuresCount, indexNodeSize: nodeSize, featuresOffset } = this.header;
    const levels = this.levelBounds;
    const [leafStart, leafEnd] = levels[0];
    const nodes = new NodeReader(this.pageNodes);

    const runs: Array<[number, number]> = []; // feature index ranges [a, b)
    const boundaryLeaves = new Set<number>(); // leaf nodes needed only for offsets
    let frontier: Array<[number, number]> = [levels[levels.length - 1]];

    for (let level = levels.length - 1; level >= 0; level--) {
      const needed: Array<[number, number]> = [];
      for (const [a, b] of frontier) {
        // At the leaf level, also read the next leaf: its offset ends the feature
        needed.push([a, level === 0 ? Math.min(b + 1, leafEnd) : b]);
      }
      if (level === 0) {
        for (const leaf of boundaryLeaves) needed.push([leaf, leaf + 1]);
      }
      if (needed.length === 0) continue;
      await this.loadNodes(needed, nodes, options);

      const next: Array<[number, number]> = [];
      for (const [a, b] of frontier) {
        for (let i = a; i < b; i++) {
          const minX = nodes.f64(i, 0), minY = nodes.f64(i, 8);
          const maxX = nodes.f64(i, 16), maxY = nodes.f64(i, 24);
          if (maxX < bbox.minX || minX > bbox.maxX || maxY < bbox.minY || minY > bbox.maxY) continue;

          if (level === 0) {
            runs.push([i - leafStart, i - leafStart + 1]);
            continue;
          }

          const firstChild = nodes.u64(i, 32);
          const [childStart, childEnd] = levels[level - 1];
          if (firstChild < childStart || firstChild >= childEnd) {
            throw new FormatError(
              `Corrupt FlatGeobuf index: node ${i} points to child ${firstChild} outside its level`,
              { path: this.path },
            );
          }

          // Containment shortcut: every feature below a node that lies inside
          // the query matches. In the packed layout node p of a level covers
          // features [p * nodeSize^level, (p + 1) * nodeSize^level); verify the
          // layout through the node's child pointer before relying on it.
          const position = i - levels[level][0];
          if (minX >= bbox.minX && maxX <= bbox.maxX && minY >= bbox.minY && maxY <= bbox.maxY &&
              firstChild === childStart + position * nodeSize) {
            const span = nodeSize ** level;
            const first = position * span;
            const last = Math.min(first + span, featuresCount);
            runs.push([first, last]);
            boundaryLeaves.add(leafStart + first);
            if (last < featuresCount) boundaryLeaves.add(leafStart + last);
            continue;
          }

          next.push([firstChild, Math.min(firstChild + nodeSize, childEnd)]);
        }
      }
      frontier = mergeIntervals(next, 0);
    }

    if (runs.length === 0) return [];

    const ranges: ByteRange[] = [];
    for (const [a, b] of mergeIntervals(runs, 0)) {
      const start = featuresOffset + nodes.u64(leafStart + a, 32);
      let end: number;
      if (b < featuresCount) {
        end = featuresOffset + nodes.u64(leafStart + b, 32);
      } else if (this.size !== null) {
        end = this.size;
      } else {
        end = start + LAST_FEATURE_GUESS; // corrected via the size prefix if short
      }
      if (end <= start) {
        throw new FormatError(
          `Corrupt FlatGeobuf index: feature ${a} does not precede feature ${b} in the file`,
          { path: this.path },
        );
      }
      ranges.push({ offset: start, length: end - start });
    }

    return ranges;
  }

  /**
   * Read every index page above the leaf level (the "skeleton") in one
   * request, if it fits `maxBytes`, so later queries need at most one index
   * round trip. Pages already cached are not re-read.
   *
   * @param maxBytes - Skip warming when the internal levels are larger.
   * @param signal - Optional abort signal.
   * @returns `true` if the internal levels are now cached or seeded.
   */
  async warmIndex(maxBytes: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.hasIndex) return false;
    const internalNodes = this.levelBounds[0][0];
    if (internalNodes === 0 || internalNodes * NODE_BYTES > maxBytes) return false;
    await this.loadNodes([[0, internalNodes]], new NodeReader(this.pageNodes), { signal }, true);
    return true;
  }

  // == Internals =============================================================

  /**
   * Make the index pages covering the given node ranges available in
   * `nodes`, reading missing ones in as few coalesced requests as possible.
   *
   * @param ranges - Node index ranges `[start, end)`.
   * @param nodes - Page holder for the current query.
   * @param options - Range merging and abort signal.
   * @param retain - Keep pages even without a cache (used by warm-up).
   */
  private async loadNodes(
    ranges: Array<[number, number]>,
    nodes: NodeReader,
    options: QueryOptions,
    retain = false,
  ): Promise<void> {
    const wanted = new Set<number>();
    for (const [a, b] of ranges) {
      for (let p = Math.floor(a / this.pageNodes); p * this.pageNodes < b; p++) {
        if (!nodes.has(p)) wanted.add(p);
      }
    }
    if (wanted.size === 0) return;

    const { cache } = this.context;
    const pending: Array<Promise<void>> = [];
    const missing: number[] = [];
    const lookups = [...wanted].map(async (p) => {
      const seeded = this.seed.get(p);
      if (seeded) return nodes.add(p, seeded);
      const flying = this.inflight.get(p);
      if (flying) return void pending.push(flying.then(page => nodes.add(p, page)));
      if (cache) {
        const hit = await cache.get(this.pageKey(p));
        if (hit && hit.length === this.pageLength(p)) return nodes.add(p, hit);
      }
      missing.push(p);
    });
    await Promise.all(lookups);

    if (missing.length > 0) {
      missing.sort((x, y) => x - y);
      const pageBytes = this.pageNodes * NODE_BYTES;
      const groups = mergeIntervals(
        missing.map(p => [p, p + 1] as [number, number]),
        Math.floor(this.coalesceGap(options) / pageBytes),
      );
      const batch = this.connector.readRanges(
        this.path,
        groups.map(([a, b]) => ({
          offset: this.header.indexOffset + a * pageBytes,
          length: (b - 1 - a) * pageBytes + this.pageLength(b - 1),
        })),
        this.readOptions(options.signal),
      );
      groups.forEach(([a, b], g) => {
        for (let p = a; p < b; p++) {
          const page = batch.then(chunks => {
            const chunk = chunks[g];
            const start = (p - a) * pageBytes;
            const length = this.pageLength(p);
            if (chunk.length < start + length) {
              throw new FormatError(
                `Truncated FlatGeobuf index: page ${p} is incomplete`,
                { path: this.path, offset: this.header.indexOffset + p * pageBytes },
              );
            }
            return chunk.slice(start, start + length);
          });
          this.inflight.set(p, page);
          pending.push(page.then(async (bytes) => {
            nodes.add(p, bytes);
            if (cache) await cache.set(this.pageKey(p), bytes);
            else if (retain) this.seed.set(p, bytes);
          }).finally(() => {
            if (this.inflight.get(p) === page) this.inflight.delete(p);
          }));
        }
      });
    }

    await Promise.all(pending);
  }

  /**
   * Store the index pages contained entirely in the first read.
   *
   * @param prefix - Bytes from the start of the file.
   */
  private async seedPages(prefix: Uint8Array): Promise<void> {
    if (!this.hasIndex) return;
    const pageBytes = this.pageNodes * NODE_BYTES;
    const { cache } = this.context;
    for (let p = 0; ; p++) {
      const start = this.header.indexOffset + p * pageBytes;
      const length = this.pageLength(p);
      if (length <= 0 || start + length > prefix.length) break;
      // Copy so cached pages do not pin the whole prefix buffer
      const page = prefix.slice(start, start + length);
      if (cache) await cache.set(this.pageKey(p), page);
      else this.seed.set(p, page);
    }
  }

  /**
   * Scan all features of a file without a spatial index.
   *
   * @param options - Scan budget and abort signal.
   * @returns All decoded features.
   * @throws {LimitExceededError} If the feature data exceeds `maxScanBytes`.
   */
  private async scan(options: QueryOptions): Promise<RawFeature[]> {
    const { signal } = options;
    const budget = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
    const start = this.header.featuresOffset;
    const tooLarge = () => new LimitExceededError(
      `${this.path} has no spatial index and more than ${budget} bytes of features; ` +
      'raise maxScanBytes or add an index to the file',
      { path: this.path },
    );
    if (this.size !== null && this.size - start > budget) throw tooLarge();

    const features: RawFeature[] = [];
    let pos = start;
    for (;;) {
      if (pos - start >= budget) {
        // Only reachable with unknown file size: is there more data?
        const probe = await this.connector.read(this.path, pos, 4, this.readOptions(signal));
        if (probe.length >= 4 && new DataView(probe.buffer, probe.byteOffset, 4).getUint32(0, true) !== 0) {
          throw tooLarge();
        }
        break;
      }
      const want = Math.min(SCAN_CHUNK, start + budget - pos, this.size !== null ? this.size - pos : Infinity);
      if (want <= 0) break;
      const bytes = await this.connector.read(this.path, pos, want, this.readOptions(signal));
      if (bytes.length === 0) break;

      const chunk = decodeFeatureChunk(bytes, this.header);
      for (const f of chunk.features) features.push(f);

      if (chunk.truncatedAt > 0) {
        pos += chunk.truncatedAt; // continue from the cut feature
        continue;
      }
      if (chunk.truncatedAt === 0) {
        // A single feature larger than the chunk
        if (bytes.length < want) {
          throw new FormatError('Truncated FlatGeobuf feature', { path: this.path, offset: pos });
        }
        for (const f of await this.readFeatureAt(pos, signal)) features.push(f);
        pos += new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) + 4;
        continue;
      }
      pos += chunk.end;
      if (chunk.end < bytes.length || bytes.length < want) break; // end marker or end of file
    }
    return features;
  }

  /**
   * Read and decode the single feature starting at `offset`, using its
   * size prefix to read exactly its bytes.
   *
   * @param offset - Absolute file offset of the feature's size prefix.
   * @param signal - Optional abort signal.
   * @returns The decoded feature (empty if its geometry is unusable).
   * @throws {FormatError} If the file ends before the feature does.
   */
  private async readFeatureAt(offset: number, signal?: AbortSignal): Promise<RawFeature[]> {
    const options = this.readOptions(signal);
    const prefix = await this.connector.read(this.path, offset, 4, options);
    if (prefix.length < 4) {
      throw new FormatError('Truncated FlatGeobuf feature size prefix', { path: this.path, offset });
    }
    const length = 4 + new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, true);
    const bytes = await this.connector.read(this.path, offset, length, options);
    const { features, truncatedAt } = decodeFeatureChunk(bytes, this.header);
    if (truncatedAt >= 0 || bytes.length < length) {
      throw new FormatError(
        `Truncated FlatGeobuf feature: expected ${length} bytes, got ${bytes.length}`,
        { path: this.path, offset },
      );
    }
    return features;
  }

  /** Read options binding every read to this file version. */
  private readOptions(signal?: AbortSignal): ReadOptions | undefined {
    if (this.etag === null && !signal) return undefined;
    return {
      ...(this.etag !== null ? { ifMatch: this.etag } : {}),
      ...(signal ? { signal } : {}),
    };
  }

  private prefetchSize(): number {
    return prefetchFor(this.connector, this.context);
  }

  private coalesceGap(options: QueryOptions): number {
    return Math.max(0, options.coalesceGap ?? this.connector.hints?.coalesceGap ?? DEFAULT_COALESCE_GAP);
  }

  /** Byte length of index page `p` (the last page may be short). */
  private pageLength(p: number): number {
    const pageBytes = this.pageNodes * NODE_BYTES;
    return Math.min(pageBytes, this.header.indexSize - p * pageBytes);
  }

  private pageKey(p: number): string {
    return `${CACHE_PREFIX}:p:${this.pageNodes}:${this.etag ?? ''}:${this.path}:${p}`;
  }
}

// == Source registry =========================================================

/**
 * Bounded memo of opened {@link FgbSource}s, keyed by connector and path,
 * so concurrent and repeated requests share one open.
 */
export class SourceRegistry {
  private readonly maxEntries: number;
  private readonly entries = new Map<string, Promise<FgbSource>>();

  /**
   * @param maxEntries - Maximum number of sources kept open.
   */
  constructor(maxEntries = 256) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /**
   * Return the source for `path`, opening it once.
   *
   * @param connector - Connector the source is read through.
   * @param path - Source path.
   * @param open - Opens the source on a miss.
   * @returns The (possibly shared) source.
   */
  get(connector: Connector, path: string, open: () => Promise<FgbSource>): Promise<FgbSource> {
    const key = registryKey(connector, path);
    let entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry;
    }
    entry = open();
    this.entries.set(key, entry);
    // Failed opens are not memoized
    entry.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(k);
    }
    return entry;
  }

  /**
   * Forget the source for `path` (e.g. after it changed).
   *
   * @param connector - Connector the source is read through.
   * @param path - Source path.
   */
  invalidate(connector: Connector, path: string): void {
    this.entries.delete(registryKey(connector, path));
  }
}

/**
 * Open a source through the context's registry (if any).
 *
 * @param connector - Connector to read through.
 * @param path - Source path.
 * @param context - I/O settings.
 * @param signal - Optional abort signal (applies only to unshared opens).
 * @returns The opened source.
 */
export function getSource(
  connector: Connector,
  path: string,
  context: IoContext,
  signal?: AbortSignal,
): Promise<FgbSource> {
  if (!context.registry) return FgbSource.open(connector, path, context, signal);
  // A shared open must not be cancelled by one caller's signal
  return context.registry.get(connector, path, () => FgbSource.open(connector, path, context));
}

/** One registry per cache, so every user of a cache shares opened sources. */
const registries = new WeakMap<ByteCache, SourceRegistry>();

/**
 * Resolve public {@link IoOptions} into an {@link IoContext}.
 *
 * @param io - Caller options.
 * @param defaultCache - Cache to use unless the caller passes one or `false`.
 * @returns The context to pass through the pipeline.
 */
export function createIoContext(io: IoOptions | undefined, defaultCache: ByteCache): IoContext {
  const cache = io?.cache === false ? null : (io?.cache ?? defaultCache);
  let registry: SourceRegistry | null = null;
  if (cache) {
    registry = registries.get(cache) ?? null;
    if (!registry) {
      registry = new SourceRegistry();
      registries.set(cache, registry);
    }
  }
  return {
    cache,
    registry,
    prefetch: io?.prefetch,
    coalesceGap: io?.coalesceGap,
    maxScanBytes: io?.maxScanBytes,
  };
}

/**
 * Drop everything cached about `path`, so the next request reopens it.
 *
 * @param connector - Connector the source is read through.
 * @param path - Source path.
 * @param context - I/O settings.
 */
export async function invalidateSource(connector: Connector, path: string, context: IoContext): Promise<void> {
  context.registry?.invalidate(connector, path);
  await context.cache?.delete(headerCacheKey(path));
}

// == Helpers =================================================================

/**
 * Accessor for packed R-tree nodes spread over index pages.
 */
class NodeReader {
  private readonly pages = new Map<number, DataView>();

  constructor(private readonly pageNodes: number) {}

  has(page: number): boolean {
    return this.pages.has(page);
  }

  add(page: number, bytes: Uint8Array): void {
    this.pages.set(page, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  /** Read a float64 field of node `i` at byte offset `field`. */
  f64(i: number, field: number): number {
    const [view, offset] = this.locate(i);
    return view.getFloat64(offset + field, true);
  }

  /** Read the uint64 offset field of node `i` as a number. */
  u64(i: number, field: number): number {
    const [view, offset] = this.locate(i);
    return view.getUint32(offset + field + 4, true) * 0x100000000 + view.getUint32(offset + field, true);
  }

  private locate(i: number): [DataView, number] {
    const p = Math.floor(i / this.pageNodes);
    const view = this.pages.get(p);
    if (!view) throw new Error(`Index page ${p} not loaded`);
    return [view, (i - p * this.pageNodes) * NODE_BYTES];
  }
}

/** Identity numbers for connectors, used in registry keys. */
const connectorIds = new WeakMap<Connector, number>();
let nextConnectorId = 0;

function registryKey(connector: Connector, path: string): string {
  let id = connectorIds.get(connector);
  if (id === undefined) {
    id = nextConnectorId++;
    connectorIds.set(connector, id);
  }
  return `${id}\u0000${path}`;
}

function headerCacheKey(path: string): string {
  return `${CACHE_PREFIX}:h:${path}`;
}

function prefetchFor(connector: Connector, context: IoContext): number {
  // At least enough for the magic bytes and header size prefix
  return Math.max(12, Math.floor(context.prefetch ?? connector.hints?.prefetch ?? DEFAULT_PREFETCH));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Serialize a header cache entry: `[u32 metaLength][meta JSON][header bytes]`.
 */
function encodeHeaderEntry(size: number | null, etag: string | null, headerBytes: Uint8Array): Uint8Array {
  const meta = textEncoder.encode(JSON.stringify({ size, etag }));
  const out = new Uint8Array(4 + meta.length + headerBytes.length);
  new DataView(out.buffer).setUint32(0, meta.length, true);
  out.set(meta, 4);
  out.set(headerBytes, 4 + meta.length);
  return out;
}

/**
 * Parse a header cache entry; `null` for a missing or malformed entry.
 */
function decodeHeaderEntry(
  entry: Uint8Array | undefined,
): { size: number | null; etag: string | null; headerBytes: Uint8Array } | null {
  if (!entry || entry.length < 4) return null;
  try {
    const metaLength = new DataView(entry.buffer, entry.byteOffset, 4).getUint32(0, true);
    if (4 + metaLength > entry.length) return null;
    const meta = JSON.parse(textDecoder.decode(entry.subarray(4, 4 + metaLength)));
    return {
      size: typeof meta.size === 'number' ? meta.size : null,
      etag: typeof meta.etag === 'string' ? meta.etag : null,
      headerBytes: entry.subarray(4 + metaLength),
    };
  } catch {
    return null;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * Sort and merge integer intervals `[start, end)` that overlap or are at
 * most `gap` apart.
 */
function mergeIntervals(intervals: Array<[number, number]>, gap: number): Array<[number, number]> {
  if (intervals.length <= 1) return intervals.map(([a, b]) => [a, b]);
  const sorted = [...intervals].sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const [a, b] = sorted[i];
    if (a <= last[1] + gap) {
      if (b > last[1]) last[1] = b;
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

/**
 * Merge byte ranges separated by at most `gap` bytes, without growing a
 * merged range beyond `maxLength`.
 */
function coalesceRanges(ranges: ByteRange[], gap: number, maxLength: number): ByteRange[] {
  const sorted = [...ranges].sort((x, y) => x.offset - y.offset);
  const out: ByteRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const lastEnd = last.offset + last.length;
      const end = Math.max(lastEnd, r.offset + r.length);
      if (r.offset <= lastEnd + gap && end - last.offset <= maxLength) {
        last.length = end - last.offset;
        continue;
      }
    }
    out.push({ offset: r.offset, length: r.length });
  }
  return out;
}

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
import { guardCache, type ByteCache } from '../cache.js';
import type { BBox, FgbHeader, RawFeature } from '../types.js';
import { headerByteSize, isValidBBox, parseHeader } from './header.js';
import { computeLevelBounds } from './index.js';
import { decodeFeatureChunk } from './feature.js';
import type { FeatureSchema } from '../schema.js';
import { FormatError, IndexMismatchError, LimitExceededError, redactPath } from '../errors.js';
import { concatBytes } from '../util.js';

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

/** Default cap on the size of a single feature. */
const DEFAULT_MAX_FEATURE_BYTES = 256 * 1024 * 1024;

/** Chunk size for sequential scans. */
const SCAN_CHUNK = 4 * 1024 * 1024;

/** Initial guess for the length of the last feature when the file size is unknown. */
const LAST_FEATURE_GUESS = 64 * 1024;

/** Index page size bounds, in nodes. */
const MIN_PAGE_NODES = 64;
const MAX_PAGE_NODES = 1024;

/**
 * How long a confirmed file version is trusted by {@link FgbSource.revalidate}
 * before the file is asked again, in milliseconds.
 */
const REVALIDATE_MS = 1000;

/** Version of the cache entry layout; part of every key. */
const CACHE_PREFIX = 'fgb-vt:2';

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
  /**
   * Largest single feature (in bytes) that will be read. Guards against
   * corrupt size prefixes triggering huge reads; larger features raise
   * {@link LimitExceededError}.
   *
   * @defaultValue 268435456 (256 MiB)
   */
  maxFeatureBytes?: number;
}

/**
 * Resolved I/O settings shared by the sources of one call or instance.
 */
export interface IoContext {
  /** Header and index page cache, or `null` for none. */
  cache: ByteCache | null;
  /** Memo of opened sources, or `null` to open per request. */
  registry: SourceRegistry | null;
  /**
   * Cached headers written at or before this time (`Date.now()`) are not
   * used: the header is read from the file again (see {@link forgetHeaders}).
   */
  headersStaleUntil: number;
  prefetch?: number;
  coalesceGap?: number;
  maxScanBytes?: number;
  maxFeatureBytes?: number;
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
  /** Most features the query may return. */
  maxFeatures?: number;
  /** Most feature bytes the query may read. */
  maxReadBytes?: number;
  /** Largest single feature that may be read. */
  maxFeatureBytes?: number;
  /** Chord tolerance for circular arcs, in the file's coordinate units. */
  curveTolerance?: number;
  /** Property selection and id column for decoding. */
  schema?: FeatureSchema;
  /** `false` scans the features instead of searching the index. */
  useIndex?: boolean;
  /** Receives counts of the reads this query issues. */
  stats?: ReadStats;
  /** Aborts the reads when signalled. */
  signal?: AbortSignal;
}

/**
 * Reads issued by one query. Pages served from the cache, and reads another
 * concurrent query already started, are not counted.
 */
export interface ReadStats {
  /** Connector requests (one per byte range). */
  requests: number;
  /** Bytes received for index pages. */
  indexBytes: number;
  /** Bytes received for feature data. */
  featureBytes: number;
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
  /**
   * Identifies this file version in index page cache keys: the version
   * tag, or (without one) a token generated when the header was read from
   * the file, so pages cached before an invalidation are never reused.
   */
  private readonly versionKey: string;

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
  /** When the file last confirmed {@link etag} (`Date.now()`), or 0. */
  private checkedAt = 0;
  /** Version check in progress, shared by concurrent callers. */
  private checking: Promise<void> | null = null;

  private constructor(
    connector: Connector,
    path: string,
    header: FgbHeader,
    size: number | null,
    etag: string | null,
    token: string,
    context: IoContext,
  ) {
    this.connector = connector;
    this.path = path;
    this.header = header;
    this.size = size;
    this.etag = etag;
    this.versionKey = etag !== null ? `e${etag}` : `g${token}`;
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
    const headerKey = headerCacheKey(connector, path);

    if (cache) {
      const cached = decodeHeaderEntry(await cache.get(headerKey));
      if (cached && cached.time > context.headersStaleUntil) {
        return new FgbSource(
          connector, path, parseHeader(cached.headerBytes), cached.size, cached.etag, cached.token, context,
        );
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
      bytes = concatBytes(bytes, rest);
    }

    const header = parseHeader(bytes);
    if (head.size !== null && head.size < header.featuresOffset) {
      throw new FormatError(
        `Truncated FlatGeobuf file: ${head.size} bytes, but the index ends at ${header.featuresOffset}`,
        { path, offset: head.size },
      );
    }

    const token = randomToken();
    const source = new FgbSource(connector, path, header, head.size, head.etag, token, context);
    source.checkedAt = Date.now();
    if (cache) {
      await cache.set(headerKey, encodeHeaderEntry(head.size, head.etag, token, Date.now(), bytes.subarray(0, headerSize)));
    }
    await source.seedPages(bytes);
    return source;
  }

  /**
   * Confirm that the file still has the version this source was opened
   * with, by reading its first byte with {@link ReadOptions.ifMatch}.
   *
   * Reads of the index and features check the version anyway; this is for
   * callers that rely on {@link etag} without reading, such as tile ETags.
   * A version confirmed less than a second ago is trusted, and concurrent
   * callers share one check.
   *
   * @param signal - Optional abort signal.
   * @throws {SourceChangedError} If the file changed since it was opened.
   */
  async revalidate(signal?: AbortSignal): Promise<void> {
    if (this.etag === null) return;
    signal?.throwIfAborted();
    if (Date.now() - this.checkedAt < REVALIDATE_MS) return;
    if (!this.checking) {
      const check = this.connector.read(this.path, 0, 1, { ifMatch: this.etag }).then(() => {
        this.checkedAt = Date.now();
      });
      this.checking = check;
      const done = () => { if (this.checking === check) this.checking = null; };
      check.then(done, done);
    }
    const check = this.checking;
    if (!signal) return check;
    // The shared check runs on; only this caller stops waiting
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      check.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** Whether the file has a spatial index. */
  get hasIndex(): boolean {
    return this.levelBounds.length > 0;
  }

  /**
   * Extent of the data in the file's coordinate system: the header
   * envelope, or the bounding box of the index root when the envelope is
   * absent or invalid.
   *
   * @param signal - Optional abort signal for the index read.
   * @returns The extent, or `null` for an unindexed file without envelope
   *   (or an empty one).
   * @throws {FormatError} If the index is truncated.
   */
  async bounds(signal?: AbortSignal): Promise<BBox | null> {
    if (this.header.bbox) return this.header.bbox;
    if (!this.hasIndex) return null;
    const nodes = new NodeReader(this.pageNodes);
    await this.loadNodes([[0, 1]], nodes, { signal });
    const root = { minX: nodes.f64(0, 0), minY: nodes.f64(0, 8), maxX: nodes.f64(0, 16), maxY: nodes.f64(0, 24) };
    return isValidBBox(root) ? root : null;
  }

  /**
   * Read and decode the features whose index entries intersect `bbox`, or
   * all features of an unindexed file (bounded by `maxScanBytes`).
   *
   * Feature and byte budgets are checked against the spatial index before
   * any feature data is read.
   *
   * @param bbox - Query box in the file's coordinate system.
   * @param options - Range merging, budgets and abort signal.
   * @returns Decoded features (callers still clip to the exact tile).
   * @throws {LimitExceededError} If a budget is exceeded.
   * @throws {SourceChangedError} If the file changed since it was opened.
   */
  async readFeatures(bbox: BBox, options: QueryOptions = {}): Promise<RawFeature[]> {
    const features: RawFeature[] = [];
    await this.forEachFeatures(bbox, options, (chunk) => {
      for (const f of chunk) features.push(f);
    });
    return features;
  }

  /**
   * Like {@link readFeatures}, but hands the features over in file order,
   * one decoded read at a time, so a caller can process and release them
   * before the next read is decoded.
   *
   * @param bbox - Query box in the file's coordinate system.
   * @param options - Range merging, budgets and abort signal.
   * @param onFeatures - Receives each batch of decoded features, in file order.
   * @throws {LimitExceededError} If a budget is exceeded.
   * @throws {SourceChangedError} If the file changed since it was opened.
   */
  async forEachFeatures(
    bbox: BBox,
    options: QueryOptions,
    onFeatures: (features: RawFeature[]) => void,
  ): Promise<void> {
    const { signal } = options;
    if (!this.hasIndex || options.useIndex === false) return this.scan(options, onFeatures);

    const { runs, featureCount, lastGuessed } = await this.searchRuns(bbox, options);
    if (runs.length === 0) return;
    let bytes = 0;
    for (const r of runs) bytes += r.length;
    this.checkBudget('features', featureCount, options.maxFeatures);
    this.checkBudget('readBytes', bytes, options.maxReadBytes);
    signal?.throwIfAborted();
    const ranges = coalesceRanges(runs, this.coalesceGap(options), MAX_MERGED_RANGE);

    const chunks = await this.connector.readRanges(this.path, ranges, this.readOptions(signal));
    count(options.stats, 'featureBytes', chunks);
    let stored = 0;
    let run = 0;
    try {
      for (let c = 0; c < chunks.length; c++) {
        // Decode only features inside requested runs, not those read because
        // they sit in a gap between two runs. Offsets increase monotonically.
        const base = ranges[c].offset;
        const accept = (offset: number) => {
          const at = base + offset;
          while (run < runs.length && runs[run].offset + runs[run].length <= at) run++;
          return run < runs.length && at >= runs[run].offset;
        };
        const chunk = decodeFeatureChunk(chunks[c], this.header, {
          accept, fileOffset: base, curveTolerance: options.curveTolerance, schema: options.schema,
        });
        chunks[c] = EMPTY_BYTES; // release the read buffer
        stored += chunk.stored;
        onFeatures(chunk.features);
        if (chunk.truncatedAt >= 0) {
          // Only the file's last feature can be longer than its range, when
          // its length was guessed (unknown file size)
          if (!lastGuessed || c !== chunks.length - 1) {
            throw this.indexMismatch(
              `the feature at byte ${base + chunk.truncatedAt} is longer than its index entry allows`,
            );
          }
          const readSoFar = bytes - (ranges[c].length - chunk.truncatedAt);
          const more = await this.readFeatureAt(base + chunk.truncatedAt, options, readSoFar);
          stored += more.stored;
          onFeatures(more.features);
        }
      }
    } catch (err) {
      // Garbage at an indexed offset means corrupt features or a wrong index
      if (err instanceof FormatError && !(err instanceof IndexMismatchError)) {
        throw new FormatError(
          `${err.message} (read through the spatial index of ${redactPath(this.path)}; if the features themselves ` +
          'are intact, the index does not match them: set useIndex: false on the source to scan the file)',
          { path: this.path, offset: err.offset, cause: err },
        );
      }
      throw err;
    }
    if (stored !== featureCount) {
      throw this.indexMismatch(`the index lists ${featureCount} features in the requested area, the data holds ${stored}`);
    }
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
    const { runs } = await this.searchRuns(bbox, options);
    return coalesceRanges(runs, this.coalesceGap(options), MAX_MERGED_RANGE);
  }

  /**
   * Search the spatial index for the exact byte runs of features
   * intersecting `bbox` (consecutive matching features form one run).
   *
   * @param bbox - Query box in the file's coordinate system.
   * @param options - Range merging (for index pages) and abort signal.
   * @returns Sorted, non-overlapping feature byte runs, the number of
   *   features they contain, and whether the last run's length is a guess
   *   (it ends with the file's last feature and the file size is unknown).
   * @throws {FormatError} If the index is truncated or inconsistent.
   */
  private async searchRuns(
    bbox: BBox,
    options: QueryOptions,
  ): Promise<{ runs: ByteRange[]; featureCount: number; lastGuessed: boolean }> {
    // A NaN box (e.g. from a projection) would intersect every node
    if (!this.hasIndex || !(bbox.minX <= bbox.maxX && bbox.minY <= bbox.maxY)) {
      return { runs: [], featureCount: 0, lastGuessed: false };
    }
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
      if (level === levels.length - 1) this.checkRoot(nodes);
      if (level === 0) this.checkLeafOrder(needed, nodes, leafStart);

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
            // Without the file size, the last feature's own offset starts its guessed range
            else if (this.size === null) boundaryLeaves.add(leafStart + last - 1);
            continue;
          }

          next.push([firstChild, Math.min(firstChild + nodeSize, childEnd)]);
        }
      }
      frontier = mergeIntervals(next, 0);
    }

    if (runs.length === 0) return { runs: [], featureCount: 0, lastGuessed: false };

    const ranges: ByteRange[] = [];
    let featureCount = 0;
    let lastGuessed = false;
    for (const [a, b] of mergeIntervals(runs, 0)) {
      featureCount += b - a;
      const start = featuresOffset + nodes.u64(leafStart + a, 32);
      let end: number;
      if (b < featuresCount) {
        end = featuresOffset + nodes.u64(leafStart + b, 32);
      } else if (this.size !== null) {
        end = this.size;
      } else {
        // The last feature's length is unknown: guess from its own offset,
        // and re-read it via its size prefix if the guess is short
        const last = featuresOffset + nodes.u64(leafStart + b - 1, 32);
        if (last < start) throw this.indexMismatch(`feature ${b - 1} is stored before feature ${a}`);
        end = last + LAST_FEATURE_GUESS;
        lastGuessed = true;
      }
      if (end <= start) {
        throw this.indexMismatch(`feature ${a} is stored after feature ${b}`);
      }
      ranges.push({ offset: start, length: end - start });
    }

    return { runs: ranges, featureCount, lastGuessed };
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
    share = true,
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
    const retry: number[] = [];
    // Pages this query fetches; registered before any await, so concurrent
    // queries wait for them instead of fetching them again
    const owned = new Map<number, OwnedPage>();
    for (const p of wanted) {
      const seeded = this.seed.get(p);
      if (seeded) {
        nodes.add(p, seeded);
        continue;
      }
      const flying = share ? this.inflight.get(p) : undefined;
      let lookup: ReturnType<ByteCache['get']> = undefined;
      if (!flying && cache) {
        // A synchronous cache (the built-in MemoryCache) needs no promises
        lookup = cache.get(this.pageKey(p));
        if (lookup instanceof Uint8Array && lookup.length === this.pageLength(p)) {
          nodes.add(p, lookup);
          continue;
        }
      }
      if (flying) {
        // Another query's read may fail for reasons of its own (its signal):
        // then read the page ourselves
        pending.push(flying.then(page => nodes.add(p, page), () => void retry.push(p)));
        continue;
      }
      const page: OwnedPage = { ...deferred<Uint8Array>(), lookup };
      owned.set(p, page);
      this.inflight.set(p, page.promise);
      pending.push(page.promise.then(
        async (bytes) => {
          nodes.add(p, bytes);
          if (cache) await cache.set(this.pageKey(p), bytes);
          else if (retain) this.seed.set(p, bytes);
        },
      ).finally(() => {
        if (this.inflight.get(p) === page.promise) this.inflight.delete(p);
      }));
    }

    try {
      const missing: number[] = [];
      // Asynchronous cache lookups started above
      await Promise.all([...owned].map(async ([p, page]) => {
        const hit = await page.lookup;
        if (hit && hit.length === this.pageLength(p)) page.resolve(hit);
        else missing.push(p);
      }));

      if (missing.length > 0) {
        missing.sort((x, y) => x - y);
        const pageBytes = this.pageNodes * NODE_BYTES;
        const groups = mergeIntervals(
          missing.map(p => [p, p + 1] as [number, number]),
          Math.floor(this.coalesceGap(options) / pageBytes),
        );
        const chunks = await this.connector.readRanges(
          this.path,
          groups.map(([a, b]) => ({
            offset: this.header.indexOffset + a * pageBytes,
            length: (b - 1 - a) * pageBytes + this.pageLength(b - 1),
          })),
          this.readOptions(options.signal),
        );
        count(options.stats, 'indexBytes', chunks);
        groups.forEach(([a, b], g) => {
          const chunk = chunks[g];
          for (let p = a; p < b; p++) {
            // Groups span gaps between missing pages; those pages are handled elsewhere
            const page = owned.get(p);
            if (!page) continue;
            const start = (p - a) * pageBytes;
            const length = this.pageLength(p);
            if (chunk.length < start + length) {
              page.reject(new FormatError(
                `Truncated FlatGeobuf index: page ${p} is incomplete`,
                { path: this.path, offset: this.header.indexOffset + p * pageBytes },
              ));
            } else {
              page.resolve(chunk.slice(start, start + length));
            }
          }
        });
      }
    } catch (err) {
      for (const page of owned.values()) page.reject(err);
    }

    await Promise.all(pending);
    if (retry.length > 0) {
      options.signal?.throwIfAborted();
      await this.loadNodes(retry.map(p => [p * this.pageNodes, p * this.pageNodes + 1]), nodes, options, retain, false);
    }
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
   * @param options - Scan and read budgets, feature limit and abort signal.
   * @param onFeatures - Receives the decoded features, in file order.
   * @throws {LimitExceededError} If the feature data exceeds `maxScanBytes`
   *   or `maxReadBytes`, or the file holds more than `maxFeatures` features.
   */
  private async scan(options: QueryOptions, onFeatures: (features: RawFeature[]) => void): Promise<void> {
    const { signal } = options;
    const scanBudget = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
    const readBudget = options.maxReadBytes ?? Infinity;
    const budget = Math.min(scanBudget, readBudget);
    const start = this.header.featuresOffset;
    const tooLarge = (actual?: number) => scanBudget <= readBudget
      ? new LimitExceededError(
        `${redactPath(this.path)} has no spatial index and more than ${budget} bytes of features; ` +
        'raise maxScanBytes or add an index to the file',
        { path: this.path, limit: 'scanBytes', max: budget, actual },
      )
      : new LimitExceededError(
        `${redactPath(this.path)}: scanning more than ${budget} bytes of features exceeds maxReadBytes`,
        { path: this.path, limit: 'readBytes', max: budget, actual },
      );
    if (this.size !== null && this.size - start > budget) throw tooLarge(this.size - start);

    let decoded = 0;
    let pos = start;
    for (;;) {
      if (pos - start >= budget) {
        // Only reachable with unknown file size: is there more data?
        const probe = await this.connector.read(this.path, pos, 4, this.readOptions(signal));
        count(options.stats, 'featureBytes', [probe]);
        if (probe.length >= 4 && new DataView(probe.buffer, probe.byteOffset, 4).getUint32(0, true) !== 0) {
          throw tooLarge();
        }
        break;
      }
      const want = Math.min(SCAN_CHUNK, start + budget - pos, this.size !== null ? this.size - pos : Infinity);
      if (want <= 0) break;
      const bytes = await this.connector.read(this.path, pos, want, this.readOptions(signal));
      count(options.stats, 'featureBytes', [bytes]);
      if (bytes.length === 0) break;

      const chunk = decodeFeatureChunk(bytes, this.header, {
        fileOffset: pos, curveTolerance: options.curveTolerance, schema: options.schema,
      });
      decoded += chunk.features.length;
      this.checkBudget('features', decoded, options.maxFeatures);
      onFeatures(chunk.features);

      if (chunk.truncatedAt > 0) {
        pos += chunk.truncatedAt; // continue from the cut feature
        continue;
      }
      if (chunk.truncatedAt === 0) {
        // A single feature larger than the chunk
        if (bytes.length < want) {
          throw new FormatError('Truncated FlatGeobuf feature', { path: this.path, offset: pos });
        }
        const more = await this.readFeatureAt(pos, options);
        decoded += more.features.length;
        this.checkBudget('features', decoded, options.maxFeatures);
        onFeatures(more.features);
        pos += new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) + 4;
        continue;
      }
      pos += chunk.end;
      if (chunk.end < bytes.length || bytes.length < want) break; // end marker or end of file
    }
  }

  /**
   * Read and decode the single feature starting at `offset`, using its
   * size prefix to read exactly its bytes.
   *
   * @param offset - Absolute file offset of the feature's size prefix.
   * @param query - Feature size and read limits, and abort signal.
   * @param readSoFar - Feature bytes the query has already read, counted
   *   against `maxReadBytes`.
   * @returns The decoded features (none if its geometry is unusable) and
   *   the number of stored features decoded (1).
   * @throws {FormatError} If the file ends before the feature does.
   * @throws {LimitExceededError} If the feature exceeds `maxFeatureBytes`,
   *   or reading it exceeds `maxReadBytes`.
   */
  private async readFeatureAt(
    offset: number,
    query: QueryOptions,
    readSoFar = 0,
  ): Promise<{ features: RawFeature[]; stored: number }> {
    const options = this.readOptions(query.signal);
    const prefix = await this.connector.read(this.path, offset, 4, options);
    count(query.stats, 'featureBytes', [prefix]);
    if (prefix.length < 4) {
      throw new FormatError('Truncated FlatGeobuf feature size prefix', { path: this.path, offset });
    }
    const size = new DataView(prefix.buffer, prefix.byteOffset, 4).getUint32(0, true);
    const maxFeatureBytes = query.maxFeatureBytes ?? DEFAULT_MAX_FEATURE_BYTES;
    if (size > maxFeatureBytes) {
      throw new LimitExceededError(
        `${redactPath(this.path)}: feature at byte ${offset} is ${size} bytes, more than maxFeatureBytes (${maxFeatureBytes})`,
        { path: this.path, limit: 'featureBytes', max: maxFeatureBytes, actual: size },
      );
    }
    const length = 4 + size;
    this.checkBudget('readBytes', readSoFar + length, query.maxReadBytes);
    const bytes = await this.connector.read(this.path, offset, length, options);
    count(query.stats, 'featureBytes', [bytes]);
    const { features, truncatedAt, stored } = decodeFeatureChunk(bytes, this.header, {
      fileOffset: offset, curveTolerance: query.curveTolerance, schema: query.schema,
    });
    if (truncatedAt >= 0 || bytes.length < length) {
      throw new FormatError(
        `Truncated FlatGeobuf feature: expected ${length} bytes, got ${bytes.length}`,
        { path: this.path, offset },
      );
    }
    return { features, stored };
  }

  /**
   * Reject an index whose root box is not a valid box although the file
   * has features: every query would silently find nothing (e.g. a writer
   * that left feature boxes empty).
   */
  private checkRoot(nodes: NodeReader): void {
    const root = { minX: nodes.f64(0, 0), minY: nodes.f64(0, 8), maxX: nodes.f64(0, 16), maxY: nodes.f64(0, 24) };
    if (!isValidBBox(root)) {
      throw this.indexMismatch(`its root box [${root.minX}, ${root.minY}, ${root.maxX}, ${root.maxY}] is empty`);
    }
  }

  /**
   * Check that the leaf nodes read for a query point at features in index
   * order: offsets strictly increasing within each range, and the first
   * leaf at the start of the data. Readers rely on this to compute feature
   * lengths and byte runs.
   *
   * @param ranges - Leaf node ranges `[start, end)` loaded for the query.
   * @param nodes - Loaded pages.
   * @param leafStart - Index of the first leaf node.
   */
  private checkLeafOrder(ranges: Array<[number, number]>, nodes: NodeReader, leafStart: number): void {
    if (nodes.hasNode(leafStart) && nodes.u64(leafStart, 32) !== 0) {
      throw this.indexMismatch(`the first feature in index order is at byte ${nodes.u64(leafStart, 32)}, not 0`);
    }
    for (const [a, b] of ranges) {
      let prev = nodes.u64(a, 32);
      for (let i = a + 1; i < b; i++) {
        const offset = nodes.u64(i, 32);
        if (offset <= prev) {
          throw this.indexMismatch(`feature ${i - leafStart} is stored before feature ${i - leafStart - 1}`);
        }
        prev = offset;
      }
    }
  }

  /** Error for an index that does not describe the feature data. */
  private indexMismatch(detail: string): IndexMismatchError {
    return new IndexMismatchError(
      `The spatial index of ${redactPath(this.path)} does not match its feature data: ${detail}. ` +
      'The file was probably written by a faulty writer; rewrite it (e.g. ogr2ogr -f FlatGeobuf out.fgb in.fgb), ' +
      'or set useIndex: false on the source to scan it instead',
      { path: this.path },
    );
  }

  /**
   * Throw if `actual` exceeds the optional `max`.
   *
   * @param limit - Which limit is checked.
   * @param actual - Amount the query needs.
   * @param max - Configured maximum (unlimited when undefined).
   * @throws {LimitExceededError} If `actual > max`.
   */
  private checkBudget(limit: 'features' | 'readBytes', actual: number, max: number | undefined): void {
    if (max === undefined || actual <= max) return;
    const what = limit === 'features' ? `${actual} features` : `${actual} bytes of features`;
    const option = limit === 'features' ? 'maxFeatures' : 'maxReadBytes';
    throw new LimitExceededError(
      `${redactPath(this.path)}: the tile needs ${what}, more than ${option} (${max})`,
      { path: this.path, limit, max, actual },
    );
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
    return `${CACHE_PREFIX}:p:${this.pageNodes}:${this.versionKey}:${cacheScope(this.connector)}:${this.path}:${p}`;
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

  /** Forget every source. */
  clear(): void {
    this.entries.clear();
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
  // A shared open must not be cancelled by one caller's signal, but the
  // caller stops waiting for it
  const shared = context.registry.get(connector, path, () => FgbSource.open(connector, path, context));
  return signal ? abortable(shared, signal) : shared;
}

/**
 * Settle with `promise`, or reject with the signal's reason as soon as it
 * aborts (the underlying work continues for other waiters).
 *
 * @param promise - Promise to wait for.
 * @param signal - Abort signal.
 * @returns A promise that rejects on abort.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/** One registry per cache, so every user of a cache shares opened sources. */
const registries = new WeakMap<ByteCache, SourceRegistry>();

/**
 * Resolve public {@link IoOptions} into an {@link IoContext}.
 *
 * @param io - Caller options.
 * @param defaultCache - Cache to use unless the caller passes one or `false`.
 * @returns The context to pass through the pipeline.
 * @throws {RangeError} If a size option is negative or not a number.
 */
export function createIoContext(io: IoOptions | undefined, defaultCache: ByteCache): IoContext {
  for (const key of ['prefetch', 'coalesceGap'] as const) {
    const v = io?.[key];
    if (v !== undefined && !(v >= 0 && v !== Infinity)) throw new RangeError(`${key} must be a non-negative finite number, got ${v}`);
  }
  for (const key of ['maxScanBytes', 'maxFeatureBytes'] as const) {
    const v = io?.[key];
    if (v !== undefined && !(v >= 0)) throw new RangeError(`${key} must be a non-negative number, got ${v}`);
  }
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
    // Cache failures (a full disk, an unreachable store) are misses
    cache: cache ? guardCache(cache) : null,
    registry,
    headersStaleUntil: -Infinity,
    prefetch: io?.prefetch,
    coalesceGap: io?.coalesceGap,
    maxScanBytes: io?.maxScanBytes,
    maxFeatureBytes: io?.maxFeatureBytes,
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
  await context.cache?.delete(headerCacheKey(connector, path));
}

/**
 * Forget every source opened through `cache`, so each is reopened (and its
 * header re-read) on next use.
 *
 * @param cache - The cache whose source registry to clear.
 */
export function forgetSources(cache: ByteCache): void {
  registries.get(cache)?.clear();
}

/**
 * Stop using the headers `context` finds in its cache now: each source
 * opened through `context` re-reads its header (and, without a version
 * tag, its index) from the file. Entries stay in the cache for other
 * users until they are overwritten by the fresh reads.
 *
 * @param context - The I/O context whose cached headers to distrust.
 */
export function forgetHeaders(context: IoContext): void {
  context.headersStaleUntil = Date.now();
}

// == Helpers =================================================================

/** Add completed reads to optional query stats. */
function count(stats: ReadStats | undefined, kind: 'indexBytes' | 'featureBytes', chunks: Uint8Array[]): void {
  if (!stats) return;
  stats.requests += chunks.length;
  for (const c of chunks) stats[kind] += c.length;
}

/**
 * Accessor for packed R-tree nodes spread over index pages.
 */
class NodeReader {
  private readonly pages = new Map<number, DataView>();

  constructor(private readonly pageNodes: number) {}

  has(page: number): boolean {
    return this.pages.has(page);
  }

  /** Whether the page holding node `i` is loaded. */
  hasNode(i: number): boolean {
    return this.pages.has(Math.floor(i / this.pageNodes));
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

/**
 * Cache scope of a connector: its namespace, or (without one) a
 * process-local id, so connectors that may resolve a path to different
 * files never share entries.
 */
function cacheScope(connector: Connector): string {
  if (connector.cacheNamespace !== undefined) return `n${connector.cacheNamespace}`;
  let id = connectorIds.get(connector);
  if (id === undefined) {
    id = nextConnectorId++;
    connectorIds.set(connector, id);
  }
  return `i${id}`;
}

function headerCacheKey(connector: Connector, path: string): string {
  return `${CACHE_PREFIX}:h:${cacheScope(connector)}:${path}`;
}

function prefetchFor(connector: Connector, context: IoContext): number {
  // At least enough for the magic bytes and header size prefix
  return Math.max(12, Math.floor(context.prefetch ?? connector.hints?.prefetch ?? DEFAULT_PREFETCH));
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Placeholder for read buffers released after decoding. */
const EMPTY_BYTES = new Uint8Array(0);

/** An index page this query fetches, with its pending cache lookup. */
interface OwnedPage extends Deferred<Uint8Array> {
  lookup: ReturnType<ByteCache['get']>;
}

/** A promise with its settle functions. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Serialize a header cache entry: `[u32 metaLength][meta JSON][header bytes]`.
 */
function encodeHeaderEntry(
  size: number | null,
  etag: string | null,
  token: string,
  time: number,
  headerBytes: Uint8Array,
): Uint8Array {
  const meta = textEncoder.encode(JSON.stringify({ size, etag, token, time }));
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
): { size: number | null; etag: string | null; token: string; time: number; headerBytes: Uint8Array } | null {
  if (!entry || entry.length < 4) return null;
  try {
    const metaLength = new DataView(entry.buffer, entry.byteOffset, 4).getUint32(0, true);
    if (4 + metaLength > entry.length) return null;
    const meta = JSON.parse(textDecoder.decode(entry.subarray(4, 4 + metaLength)));
    if (typeof meta.token !== 'string') return null;
    return {
      size: typeof meta.size === 'number' ? meta.size : null,
      etag: typeof meta.etag === 'string' ? meta.etag : null,
      token: meta.token,
      time: typeof meta.time === 'number' ? meta.time : 0,
      headerBytes: entry.subarray(4 + metaLength),
    };
  } catch {
    return null;
  }
}

/** A random token identifying one read of a file's header. */
function randomToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
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

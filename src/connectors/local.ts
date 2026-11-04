/**
 * @module connectors/local
 *
 * Local filesystem {@link Connector} implementation.
 *
 * Uses Node.js `FileHandle` objects for byte-range reads with an LRU
 * eviction pool to limit the number of concurrently open file descriptors.
 * Reads within a single {@link LocalConnector.readRanges} call are issued
 * in parallel via `Promise.all`, leveraging OS-level I/O scheduling.
 */

import { open, stat, type FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { Connector, ConnectorHints, ReadHeadResult, ReadOptions } from './connector.js';
import { SourceChangedError } from '../errors.js';

/**
 * Maximum number of bytes per individual `FileHandle.read()` call.
 *
 * Node.js's native `fs.read` binding asserts that the `length` argument
 * fits in an `Int32` (< 2^31). For files larger than ~2 GB, merged byte
 * ranges from the spatial index can easily exceed this limit. Reads
 * larger than this threshold are transparently split into sequential
 * chunks and reassembled.
 *
 * Set to 1 GiB — comfortably under the Int32 ceiling while keeping the
 * number of chunked syscalls low.
 */
const MAX_READ_CHUNK = 1024 * 1024 * 1024; // 1 GiB

/**
 * Configuration options for {@link LocalConnector}.
 */
export interface LocalConnectorOptions {
  /**
   * Maximum number of file handles kept open in the LRU pool.
   *
   * When the pool exceeds this limit, the least-recently-used handle is
   * closed to make room. Higher values reduce open/close churn at the
   * cost of more file descriptors.
   *
   * @defaultValue 64
   */
  maxOpenFiles?: number;
}

/**
 * A pooled file handle.
 */
interface PoolEntry {
  /** Resolves to the open handle; shared by concurrent first readers. */
  handle: Promise<FileHandle>;
  /** Number of reads currently using the handle. */
  refs: number;
  /** Set once the entry has left the pool; the last release closes it. */
  retired: boolean;
}

/**
 * Local filesystem connector using Node.js `FileHandle` with LRU pooling.
 *
 * Opens FGB files on demand and caches the resulting `FileHandle` in an
 * LRU map. Subsequent reads against the same path reuse the cached handle,
 * avoiding repeated `open()` syscalls; concurrent first reads of a path
 * share a single `open()`. When the pool exceeds
 * {@link LocalConnectorOptions.maxOpenFiles}, least-recently-used handles
 * that no read is using are evicted and closed. Handles in use are never
 * closed underneath a read, so the limit is soft while every handle is busy.
 *
 * @example
 * ```typescript
 * import { LocalConnector } from 'fgb-vt';
 *
 * const connector = new LocalConnector({ maxOpenFiles: 128 });
 *
 * // Read 1024 bytes starting at offset 0
 * const bytes = await connector.read('./data/buildings.fgb', 0, 1024);
 *
 * // Clean up when done
 * await connector.close();
 * ```
 */
export class LocalConnector implements Connector {
  /** Local reads are cheap: merge only near-adjacent ranges, read a modest prefix. */
  readonly hints: ConnectorHints = { coalesceGap: 4 * 1024, prefetch: 64 * 1024 };

  private readonly maxOpenFiles: number;
  /** LRU pool: Map preserves insertion order; most recently used is moved to end */
  private readonly pool = new Map<string, PoolEntry>();

  /**
   * Create a new local filesystem connector.
   *
   * @param options - Optional configuration. See {@link LocalConnectorOptions}.
   */
  constructor(options?: LocalConnectorOptions) {
    this.maxOpenFiles = Math.max(1, options?.maxOpenFiles ?? 64);
  }

  /**
   * Read a contiguous byte range from a local file.
   *
   * The file handle is obtained from the LRU pool (or opened on first
   * access). The returned `Uint8Array` may be shorter than `length` if
   * the file is smaller than `offset + length`.
   *
   * With {@link ReadOptions.ifMatch}, the file's current version tag
   * (inode, size and modification time) is checked first.
   *
   * @param path - Absolute or relative filesystem path to the FGB file.
   * @param offset - Zero-based byte offset to begin reading from.
   * @param length - Number of bytes to read.
   * @param options - Optional version check and abort signal.
   * @returns The requested byte range.
   * @throws {Error} If the file cannot be opened or read (e.g. `ENOENT`,
   *   `EACCES`), or the read was aborted.
   * @throws {SourceChangedError} If `ifMatch` no longer matches the file.
   * @throws {RangeError} If `offset` or `length` is negative or not an integer.
   */
  async read(path: string, offset: number, length: number, options?: ReadOptions): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Invalid byte range for ${path}: offset ${offset}, length ${length}`);
    }
    options?.signal?.throwIfAborted();
    if (length === 0) return new Uint8Array(0);

    if (options?.ifMatch !== undefined) {
      const current = versionTag(await stat(path));
      if (current !== options.ifMatch) {
        this.evict(path);
        throw new SourceChangedError(`${path} changed since it was opened`, { path });
      }
    }

    const entry = this.acquire(path);
    try {
      return await readFromHandle(await entry.handle, offset, length);
    } finally {
      this.release(entry);
    }
  }

  /**
   * Read the first `length` bytes of a file together with its size and
   * version tag (inode, size and modification time).
   *
   * If the file at `path` was replaced since its handle was pooled, the
   * stale handle is dropped first, so bytes and metadata always describe
   * the same file.
   *
   * @param path - Absolute or relative filesystem path to the FGB file.
   * @param length - Number of leading bytes to read.
   * @param options - Optional abort signal.
   * @returns The leading bytes plus size and version tag.
   */
  async readHead(path: string, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Invalid read length for ${path}: ${length}`);
    }
    options?.signal?.throwIfAborted();

    for (let attempt = 0; ; attempt++) {
      const entry = this.acquire(path);
      try {
        const handle = await entry.handle;
        const [opened, current] = await Promise.all([handle.stat(), stat(path)]);
        if ((opened.ino !== current.ino || opened.dev !== current.dev) && attempt === 0) {
          this.evict(path); // pooled handle belongs to a replaced file
          continue;
        }
        const bytes = length === 0 ? new Uint8Array(0) : await readFromHandle(handle, 0, length);
        return { bytes, size: opened.size, etag: versionTag(opened) };
      } finally {
        this.release(entry);
      }
    }
  }

  /**
   * Read multiple byte ranges from the same local file in parallel.
   *
   * All ranges are dispatched concurrently via `Promise.all`, letting the
   * OS I/O scheduler optimize disk access order.
   *
   * @param path - Absolute or relative filesystem path to the FGB file.
   * @param ranges - Array of `{ offset, length }` byte-range descriptors.
   * @param options - Optional version check (performed once) and abort signal.
   * @returns Array of `Uint8Array` chunks in the same order as the input ranges.
   * @throws {Error} If the file cannot be opened or any individual read fails.
   * @throws {SourceChangedError} If `ifMatch` no longer matches the file.
   */
  async readRanges(
    path: string,
    ranges: ReadonlyArray<{ offset: number; length: number }>,
    options?: ReadOptions,
  ): Promise<Uint8Array[]> {
    // Check the version once for the whole batch, then read in parallel
    options?.signal?.throwIfAborted();
    if (options?.ifMatch !== undefined && ranges.length > 0) {
      const current = versionTag(await stat(path));
      if (current !== options.ifMatch) {
        this.evict(path);
        throw new SourceChangedError(`${path} changed since it was opened`, { path });
      }
    }
    const perRange = options?.signal ? { signal: options.signal } : undefined;
    return Promise.all(
      ranges.map(({ offset, length }) => this.read(path, offset, length, perRange)),
    );
  }

  /**
   * Close all pooled file handles and clear the LRU pool.
   *
   * Idle handles are closed immediately; handles still in use by in-flight
   * reads are closed as soon as those reads finish. A later read reopens
   * its file, so calling `close()` repeatedly is safe.
   *
   * @returns Resolves when every idle handle has been closed.
   */
  async close(): Promise<void> {
    const entries = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(entries.map(entry => retire(entry)));
  }

  // == Handle pool ====================================================

  /**
   * Take a reference on the pooled handle for `path`, opening it if needed.
   *
   * On cache hit the entry is promoted to the most-recently-used position.
   * On cache miss the open is started (and shared with concurrent callers)
   * and idle least-recently-used entries are evicted if the pool is over
   * capacity. Every call must be paired with {@link release}.
   *
   * @param path - Filesystem path to the FGB file.
   * @returns The pool entry, with its reference count incremented.
   */
  private acquire(path: string): PoolEntry {
    const existing = this.pool.get(path);
    if (existing) {
      // Move to end (most recently used)
      this.pool.delete(path);
      this.pool.set(path, existing);
      existing.refs++;
      return existing;
    }

    const entry: PoolEntry = { handle: open(path, 'r'), refs: 1, retired: false };
    // A failed open must not stay cached; the error reaches the caller via `await`.
    entry.handle.catch(() => {
      entry.retired = true;
      if (this.pool.get(path) === entry) this.pool.delete(path);
    });
    this.pool.set(path, entry);
    this.evictIdle();
    return entry;
  }

  /**
   * Drop a reference taken by {@link acquire}, closing the handle if it
   * was retired while in use.
   *
   * @param entry - Entry returned by `acquire`.
   */
  private release(entry: PoolEntry): void {
    entry.refs--;
    if (entry.retired) {
      if (entry.refs === 0) void closeEntry(entry);
    } else {
      this.evictIdle();
    }
  }

  /**
   * Remove the pool entry for `path`, closing its handle once idle.
   *
   * @param path - Filesystem path whose handle should be dropped.
   */
  private evict(path: string): void {
    const entry = this.pool.get(path);
    if (entry) {
      this.pool.delete(path);
      void retire(entry);
    }
  }

  /**
   * Evict idle least-recently-used entries until the pool is within
   * {@link LocalConnectorOptions.maxOpenFiles}.
   */
  private evictIdle(): void {
    for (const [path, entry] of this.pool) {
      if (this.pool.size <= this.maxOpenFiles) return;
      if (entry.refs === 0) {
        this.pool.delete(path);
        void retire(entry);
      }
    }
  }
}

/**
 * Read up to `length` bytes at `offset` from an open handle.
 *
 * @param handle - Open file handle.
 * @param offset - Zero-based byte offset.
 * @param length - Number of bytes to read (> 0).
 * @returns The bytes read; shorter than `length` at end of file.
 */
async function readFromHandle(handle: FileHandle, offset: number, length: number): Promise<Uint8Array> {
  const buf = Buffer.alloc(length);

  if (length <= MAX_READ_CHUNK) {
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  }

  // Chunked read for ranges exceeding the Node.js Int32 `length` limit
  let totalRead = 0;
  let remaining = length;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_READ_CHUNK);
    const { bytesRead } = await handle.read(buf, totalRead, chunk, offset + totalRead);
    totalRead += bytesRead;
    if (bytesRead < chunk) break; // EOF
    remaining -= bytesRead;
  }

  return new Uint8Array(buf.buffer, buf.byteOffset, totalRead);
}

/**
 * Version tag of a local file: identity (device, inode) plus size and
 * modification time, so both in-place edits and replacements change it.
 *
 * @param stats - File stats.
 * @returns Opaque tag string.
 */
function versionTag(stats: Stats): string {
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
}

/**
 * Mark an entry as retired and close its handle now if it is idle;
 * otherwise the last {@link LocalConnector.release} closes it.
 *
 * @param entry - Pool entry that has been removed from the pool.
 * @returns Resolves once an idle handle has been closed.
 */
function retire(entry: PoolEntry): Promise<void> {
  entry.retired = true;
  return entry.refs === 0 ? closeEntry(entry) : Promise.resolve();
}

/**
 * Close an entry's handle, ignoring failed opens and repeated closes.
 *
 * @param entry - Pool entry to close.
 */
async function closeEntry(entry: PoolEntry): Promise<void> {
  try {
    await (await entry.handle).close();
  } catch {
    // The open failed or the handle is already closed: nothing to release.
  }
}

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

import { open, type FileHandle } from 'node:fs/promises';
import type { Connector } from './connector.js';

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
 * Local filesystem connector using Node.js `FileHandle` with LRU pooling.
 *
 * Opens FGB files on demand and caches the resulting `FileHandle` in an
 * LRU map. Subsequent reads against the same path reuse the cached handle,
 * avoiding repeated `open()` syscalls. When the pool exceeds
 * {@link LocalConnectorOptions.maxOpenFiles}, the least-recently-used
 * handle is evicted and closed.
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
  private readonly maxOpenFiles: number;
  /** LRU pool: Map preserves insertion order; most recently used is moved to end */
  private readonly handles = new Map<string, FileHandle>();

  /**
   * Create a new local filesystem connector.
   *
   * @param options - Optional configuration. See {@link LocalConnectorOptions}.
   */
  constructor(options?: LocalConnectorOptions) {
    this.maxOpenFiles = options?.maxOpenFiles ?? 64;
  }

  /**
   * Read a contiguous byte range from a local file.
   *
   * The file handle is obtained from the LRU pool (or opened on first
   * access). The returned `Uint8Array` may be shorter than `length` if
   * the file is smaller than `offset + length`.
   *
   * @param path - Absolute or relative filesystem path to the FGB file.
   * @param offset - Zero-based byte offset to begin reading from.
   * @param length - Number of bytes to read.
   * @returns The requested byte range.
   * @throws {Error} If the file cannot be opened or read (e.g. `ENOENT`,
   *   `EACCES`).
   */
  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = await this.getHandle(path);
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
   * Read multiple byte ranges from the same local file in parallel.
   *
   * All ranges are dispatched concurrently via `Promise.all`, letting the
   * OS I/O scheduler optimize disk access order.
   *
   * @param path - Absolute or relative filesystem path to the FGB file.
   * @param ranges - Array of `{ offset, length }` byte-range descriptors.
   * @returns Array of `Uint8Array` chunks in the same order as the input ranges.
   * @throws {Error} If the file cannot be opened or any individual read fails.
   */
  async readRanges(
    path: string,
    ranges: ReadonlyArray<{ offset: number; length: number }>,
  ): Promise<Uint8Array[]> {
    // Delegate to read() which handles chunking transparently
    return Promise.all(
      ranges.map(({ offset, length }) => this.read(path, offset, length)),
    );
  }

  /**
   * Close all pooled file handles and clear the LRU pool.
   *
   * After calling this method, the connector must not be used for further
   * reads. Handles are closed concurrently via `Promise.all`.
   *
   * @returns Resolves when every open handle has been closed.
   */
  async close(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    await Promise.all(handles.map(h => h.close()));
  }

  // ─── Handle pool ────────────────────────────────────────────────────

  /**
   * Retrieve a cached file handle or open a new one.
   *
   * On cache hit the handle is promoted to the most-recently-used position.
   * On cache miss a new handle is opened and, if the pool is at capacity,
   * the least-recently-used handle is evicted and closed.
   *
   * @param path - Filesystem path to the FGB file.
   * @returns An open `FileHandle` for the given path.
   */
  private async getHandle(path: string): Promise<FileHandle> {
    const existing = this.handles.get(path);
    if (existing) {
      // Move to end (most recently used)
      this.handles.delete(path);
      this.handles.set(path, existing);
      return existing;
    }

    // Open new handle
    const handle = await open(path, 'r');
    this.handles.set(path, handle);

    // Evict LRU if over capacity
    if (this.handles.size > this.maxOpenFiles) {
      const [oldestPath, oldestHandle] = this.handles.entries().next().value!;
      this.handles.delete(oldestPath);
      await oldestHandle.close();
    }

    return handle;
  }
}

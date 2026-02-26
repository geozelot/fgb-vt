/**
 * @module connector
 *
 * Abstract byte-range access interface for FlatGeobuf files.
 *
 * A {@link Connector} encapsulates the transport and authentication details
 * of a specific storage backend (local filesystem, HTTP, S3, etc.) while
 * exposing a uniform byte-range read API. The pipeline modules consume
 * Connectors without knowledge of the underlying storage, enabling the
 * same FGB processing logic to operate transparently against any backend.
 *
 * Connectors are **path-agnostic** -- a single Connector instance can serve
 * reads against multiple FGB files, with paths interpreted in a
 * backend-specific format (filesystem paths, URLs, S3 URIs, etc.).
 *
 * Implementations are expected to manage their own resource lifecycle
 * (connection pools, file handles, SDK clients) and release them when
 * {@link Connector.close} is called.
 *
 * Built-in implementations:
 *
 * - {@link LocalConnector} -- Node.js filesystem with LRU file-handle pooling
 * - {@link HttpConnector} -- HTTP(S) with Range Requests, retry, and concurrency throttling
 * - {@link S3Connector} -- AWS S3 (and compatible stores) via `@aws-sdk/client-s3`
 */
export interface Connector {
  /**
   * Read a contiguous byte range from the resource at `path`.
   *
   * The path format is connector-specific (filesystem path, URL, S3 URI, etc.).
   *
   * @param path - Connector-specific resource identifier.
   * @param offset - Zero-based byte offset to begin reading from.
   * @param length - Number of bytes to read.
   * @returns The requested byte range as a `Uint8Array`. The returned array
   *   may be shorter than `length` if the resource is smaller than
   *   `offset + length`.
   * @throws {Error} If the resource cannot be read (file not found, network
   *   error, permission denied, etc.).
   */
  read(path: string, offset: number, length: number): Promise<Uint8Array>;

  /**
   * Read multiple byte ranges from the same resource.
   *
   * Implementations may batch, parallelize, or pipeline these reads to
   * optimize throughput for the underlying backend. The returned array
   * preserves the order of the input `ranges`.
   *
   * @param path - Connector-specific resource identifier.
   * @param ranges - Array of `{ offset, length }` byte-range descriptors.
   * @returns Array of `Uint8Array` chunks corresponding positionally to the
   *   input ranges.
   * @throws {Error} If any individual range read fails.
   */
  readRanges(
    path: string,
    ranges: ReadonlyArray<{ offset: number; length: number }>,
  ): Promise<Uint8Array[]>;

  /**
   * Release all resources held by this connector (pooled connections, open
   * file handles, SDK clients, etc.).
   *
   * After calling `close()`, the connector must not be used for further
   * reads. Calling `close()` on an already-closed connector should be a
   * safe no-op.
   *
   * @returns Resolves when all resources have been released.
   */
  close(): Promise<void>;
}

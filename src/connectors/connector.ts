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
 * Only {@link Connector.read}, {@link Connector.readRanges} and
 * {@link Connector.close} are required. The optional members let the
 * pipeline do better: {@link Connector.readHead} supplies the file size and
 * a version tag with the first read (exact last-feature lengths, safe
 * caching), {@link ReadOptions} carry version checks and cancellation, and
 * {@link Connector.hints} tune how reads are batched.
 *
 * Built-in implementations:
 *
 * - {@link LocalConnector} -- Node.js filesystem with LRU file-handle pooling
 * - {@link HttpConnector} -- HTTP(S) with Range Requests, retry, and concurrency throttling
 * - {@link S3Connector} -- AWS S3 (and compatible stores) via `@aws-sdk/client-s3`
 */

/**
 * Options for a single read.
 */
export interface ReadOptions {
  /**
   * Version tag the resource must still have, as returned in
   * {@link ReadHeadResult.etag}. Connectors that support it reject the
   * read with a `SourceChangedError` when the resource has changed, so a
   * cached header and index are never combined with newer data.
   */
  ifMatch?: string;
  /** Aborts the read when signalled. */
  signal?: AbortSignal;
}

/**
 * Result of {@link Connector.readHead}: the leading bytes of a resource
 * plus its metadata.
 */
export interface ReadHeadResult {
  /** The first bytes of the resource (fewer if the resource is shorter). */
  bytes: Uint8Array;
  /** Total size of the resource in bytes, or `null` if unknown. */
  size: number | null;
  /**
   * Opaque version tag (an ETag, or size and modification time for local
   * files), or `null` if the backend provides none. Passed back as
   * {@link ReadOptions.ifMatch} on later reads.
   */
  etag: string | null;
}

/**
 * Backend characteristics that tune how the pipeline issues reads.
 */
export interface ConnectorHints {
  /**
   * Byte ranges separated by at most this many bytes are merged into one
   * read. Large for high-latency backends (HTTP, S3), small for local disk.
   */
  coalesceGap?: number;
  /**
   * Size of the first read of a file. It covers the header and, because
   * the index follows the header root-first, the top levels of the
   * spatial index.
   */
  prefetch?: number;
}

export interface Connector {
  /**
   * Read a contiguous byte range from the resource at `path`.
   *
   * The path format is connector-specific (filesystem path, URL, S3 URI, etc.).
   *
   * @param path - Connector-specific resource identifier.
   * @param offset - Zero-based byte offset to begin reading from.
   * @param length - Number of bytes to read.
   * @param options - Optional version check and abort signal.
   * @returns The requested byte range as a `Uint8Array`. The returned array
   *   may be shorter than `length` if the resource is smaller than
   *   `offset + length`.
   * @throws {Error} If the resource cannot be read (file not found, network
   *   error, permission denied, etc.).
   */
  read(path: string, offset: number, length: number, options?: ReadOptions): Promise<Uint8Array>;

  /**
   * Read multiple byte ranges from the same resource.
   *
   * Implementations may batch, parallelize, or pipeline these reads to
   * optimize throughput for the underlying backend. The returned array
   * preserves the order of the input `ranges`.
   *
   * @param path - Connector-specific resource identifier.
   * @param ranges - Array of `{ offset, length }` byte-range descriptors.
   * @param options - Optional version check and abort signal, applied to every range.
   * @returns Array of `Uint8Array` chunks corresponding positionally to the
   *   input ranges.
   * @throws {Error} If any individual range read fails.
   */
  readRanges(
    path: string,
    ranges: ReadonlyArray<{ offset: number; length: number }>,
    options?: ReadOptions,
  ): Promise<Uint8Array[]>;

  /**
   * Optional: read the first `length` bytes of a resource together with
   * its total size and version tag.
   *
   * When absent, the pipeline falls back to {@link read} and treats size
   * and version as unknown.
   *
   * @param path - Connector-specific resource identifier.
   * @param length - Number of leading bytes to read.
   * @param options - Optional abort signal.
   * @returns The leading bytes and the resource metadata.
   */
  readHead?(path: string, length: number, options?: ReadOptions): Promise<ReadHeadResult>;

  /** Optional tuning hints for the pipeline. */
  readonly hints?: ConnectorHints;

  /**
   * Optional: identifies the storage this connector reads, so cached
   * headers and index pages are shared only between connectors that
   * resolve a path to the same file.
   *
   * Connectors with equal namespaces must map equal paths to the same
   * resource. Without a namespace, cache entries are private to the
   * connector instance (and a persistent cache cannot be reused by
   * another process). The built-in connectors set `local`, `http` and
   * `s3:<endpoint>`.
   */
  readonly cacheNamespace?: string;

  /**
   * Release all resources held by this connector (pooled connections, open
   * file handles, SDK clients, etc.).
   *
   * Calling `close()` on an already-closed connector should be a safe
   * no-op. The built-in connectors re-acquire resources if used again
   * afterwards.
   *
   * @returns Resolves when all resources have been released.
   */
  close(): Promise<void>;
}

/**
 * @module connectors/s3
 *
 * Amazon S3 {@link Connector} implementation using AWS SDK v3.
 *
 * Reads FlatGeobuf byte ranges via `GetObject` with the `Range` header.
 * The `@aws-sdk/client-s3` package is loaded lazily at first use so that
 * applications not using S3 pay no import cost; alternatively an existing
 * `S3Client` and/or the SDK module can be passed in. Requests are limited
 * to a configurable number in flight across all reads of the connector.
 *
 * Compatible with any S3-compatible object store (MinIO, Cloudflare R2,
 * Backblaze B2, etc.) via the `endpoint` and `forcePathStyle` options.
 */

import type { Connector, ConnectorHints, ReadHeadResult, ReadOptions } from './connector.js';
import { ConnectorError, RangeNotSupportedError, SourceChangedError } from '../errors.js';
import { RequestLimiter, readAll } from './limiter.js';

/** Largest `setTimeout` delay; longer timeouts mean no timeout. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Configuration options for {@link S3Connector}.
 */
/**
 * The parts of an `@aws-sdk/client-s3` `S3Client` the connector uses.
 */
export interface S3ClientLike {
  /** Send a command (here: `GetObjectCommand`). */
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any>;
  /** Release the client's connections. */
  destroy?(): void;
}

/**
 * The parts of the `@aws-sdk/client-s3` module the connector uses.
 */
export interface S3SdkModule {
  /** `S3Client` constructor. */
  S3Client: new (config: Record<string, unknown>) => S3ClientLike;
  /** `GetObjectCommand` constructor. */
  GetObjectCommand: new (input: Record<string, unknown>) => unknown;
}

/**
 * Configuration options for {@link S3Connector}.
 */
export interface S3ConnectorOptions {
  /**
   * AWS region for the S3 client (e.g. `"us-east-1"`). When omitted, the
   * SDK takes it from the environment (`AWS_REGION`). Ignored with `client`.
   */
  region?: string;
  /**
   * An existing `S3Client` to send requests with, e.g. one shared with the
   * rest of the application. The connector does not destroy it on
   * {@link S3Connector.close}. `region`, `credentials`, `endpoint` and
   * `forcePathStyle` are ignored.
   */
  client?: S3ClientLike;
  /**
   * The `@aws-sdk/client-s3` module, e.g. `import * as s3 from
   * '@aws-sdk/client-s3'`. Pass it when bundling the SDK into your
   * application; otherwise it is imported at runtime on first use.
   */
  sdk?: S3SdkModule;
  /**
   * Explicit AWS credentials.
   *
   * When omitted, the SDK falls back to the default credential provider
   * chain (environment variables, shared credentials file, EC2 instance
   * metadata, ECS container credentials, etc.).
   */
  credentials?: {
    /** AWS access key ID. */
    accessKeyId: string;
    /** AWS secret access key. */
    secretAccessKey: string;
    /** Optional session token for temporary credentials (STS). */
    sessionToken?: string;
  };
  /**
   * Custom endpoint URL for S3-compatible object stores.
   *
   * Set this when targeting MinIO, Cloudflare R2, Backblaze B2, or any
   * other store that exposes an S3-compatible API at a non-AWS endpoint.
   */
  endpoint?: string;
  /**
   * Force path-style addressing (`endpoint/bucket/key`) instead of the
   * default virtual-hosted style (`bucket.endpoint/key`).
   *
   * Required by some S3-compatible stores that do not support
   * virtual-hosted bucket addressing.
   */
  forcePathStyle?: boolean;
  /**
   * Most `GetObject` requests in flight at once across all reads through
   * this connector (every tile and source sharing it); further requests
   * wait in arrival order. Matches the SDK's default socket pool (50) so
   * that requests queue here, where they can be cancelled, rather than in
   * the HTTP agent. `Infinity` disables the limit.
   *
   * @defaultValue 50
   */
  maxConcurrency?: number;
  /**
   * Size of the first read of a file (header plus top of the index).
   *
   * @defaultValue 262144 (256 KiB)
   */
  prefetch?: number;
  /**
   * Merge byte ranges separated by at most this many bytes into one request.
   *
   * @defaultValue 65536 (64 KiB)
   */
  coalesceGap?: number;
  /**
   * Timeout per `GetObject` in milliseconds, covering the response and its
   * body, so a stalled connection cannot hold a request slot forever. The
   * SDK's own retries (`maxAttempts`) happen within it. `0` or `Infinity`
   * disable the timeout.
   *
   * @defaultValue 30000
   */
  timeout?: number;
  /**
   * Set to `'requester'` to read from Requester Pays buckets (the
   * requester is charged for the requests and transfer).
   */
  requestPayer?: 'requester';
  /**
   * Account id the bucket must belong to; requests to a bucket owned by
   * another account fail with 403 (`ExpectedBucketOwner`).
   */
  expectedBucketOwner?: string;
  /**
   * Further `GetObject` input sent with every request, e.g. server-side
   * encryption with customer keys: `{ SSECustomerAlgorithm: 'AES256',
   * SSECustomerKey, SSECustomerKeyMD5 }`. `Bucket`, `Key`, `Range`,
   * `IfMatch` and `VersionId` are set by the connector.
   */
  getObjectParams?: Record<string, unknown>;
  /**
   * Cache namespace (see {@link Connector.cacheNamespace}). Defaults to
   * `s3:<endpoint>` (`s3:aws` without an endpoint); with an injected
   * `client` whose endpoint is unknown, cache entries are private to this
   * connector unless a namespace is given.
   */
  cacheNamespace?: string;
}

/**
 * Parse an S3 path string into its constituent bucket name, object key and
 * optional object version.
 *
 * Accepts both the `s3://` URI scheme and bare `bucket/key` format, with
 * an optional `?versionId=` suffix for a specific version of a versioned
 * object:
 *
 * - `"s3://my-bucket/path/to/file.fgb"` -> `{ bucket: "my-bucket", key: "path/to/file.fgb" }`
 * - `"my-bucket/path/to/file.fgb?versionId=3HL4kq"` -> `{ ..., versionId: "3HL4kq" }`
 *
 * @param path - S3 path in either `s3://bucket/key` or `bucket/key` format.
 * @returns The parsed `bucket`, `key` and `versionId` (or `undefined`).
 * @throws {TypeError} If the bucket or key is missing.
 */
function parseS3Path(path: string): { bucket: string; key: string; versionId: string | undefined } {
  let normalized = path;
  if (normalized.startsWith('s3://')) {
    normalized = normalized.slice(5);
  }
  let versionId: string | undefined;
  const version = /\?versionId=([^&?]+)$/.exec(normalized);
  if (version) {
    versionId = decodeURIComponent(version[1]);
    normalized = normalized.slice(0, version.index);
  }
  const slashIdx = normalized.indexOf('/');
  if (slashIdx <= 0 || slashIdx === normalized.length - 1) {
    throw new TypeError(`Invalid S3 path (expected s3://bucket/key): ${path}`);
  }
  return {
    bucket: normalized.slice(0, slashIdx),
    key: normalized.slice(slashIdx + 1),
    versionId,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Module specifier of the AWS SDK. Held in a variable so that TypeScript
 * and bundlers leave the optional peer dependency unresolved.
 */
const SDK_MODULE = '@aws-sdk/client-s3';

/**
 * Load the `@aws-sdk/client-s3` module at runtime with a plain dynamic
 * `import()` (no `Function` constructor, so it works under a
 * Content-Security-Policy without `unsafe-eval`).
 *
 * @returns The resolved `@aws-sdk/client-s3` module namespace.
 * @throws {Error} If the package is not installed, with an actionable
 *   installation instruction in the error message.
 */
async function loadS3Sdk(): Promise<S3SdkModule> {
  try {
    return await import(SDK_MODULE);
  } catch (err) {
    throw new Error(
      'S3Connector requires @aws-sdk/client-s3 as a peer dependency. ' +
      'Install it with: npm install @aws-sdk/client-s3, or pass the module as the sdk option.',
      { cause: err },
    );
  }
}

/**
 * S3 connector using AWS SDK v3 (`@aws-sdk/client-s3`).
 *
 * The SDK is a **peer dependency** -- it is only required at runtime if
 * this connector is instantiated. Byte-range reads use `GetObject` with
 * an HTTP `Range` header, identical to how the AWS CLI performs partial
 * downloads.
 *
 * The S3 client is created lazily on the first read and reused for all
 * subsequent requests. Call {@link S3Connector.close} to destroy the
 * client and release its underlying HTTP connection pool.
 *
 * @example
 * ```typescript
 * import { S3Connector } from '@geozelot/fgb-vt';
 *
 * const connector = new S3Connector({
 *   region: 'us-east-1',
 *   maxConcurrency: 8,
 * });
 *
 * const bytes = await connector.read(
 *   's3://my-bucket/tiles/buildings.fgb',
 *   0,
 *   1024,
 * );
 *
 * await connector.close();
 * ```
 *
 * @example Reusing an application's client and bundled SDK
 * ```typescript
 * import * as s3 from '@aws-sdk/client-s3';
 *
 * const connector = new S3Connector({ client: new s3.S3Client({}), sdk: s3 });
 * ```
 *
 * @example Using with an S3-compatible store (MinIO)
 * ```typescript
 * const minio = new S3Connector({
 *   region: 'us-east-1',
 *   endpoint: 'http://localhost:9000',
 *   forcePathStyle: true,
 *   credentials: {
 *     accessKeyId: 'minioadmin',
 *     secretAccessKey: 'minioadmin',
 *   },
 * });
 * ```
 */
export class S3Connector implements Connector {
  readonly hints: ConnectorHints;
  readonly cacheNamespace?: string;

  private readonly limiter: RequestLimiter;
  /** Timeout per request in milliseconds, or `null` for none. */
  private readonly timeout: number | null;
  private client: S3ClientLike | null = null;
  private sdk: S3SdkModule | null = null;
  private clientPromise: Promise<{ client: S3ClientLike; sdk: S3SdkModule }> | null = null;
  private readonly clientOptions: S3ConnectorOptions;
  /** Whether {@link client} was created here (and is destroyed on close). */
  private ownsClient = false;

  /**
   * Create a new S3 connector.
   *
   * The underlying `S3Client` is **not** created until the first read
   * operation, so construction is synchronous.
   *
   * @param options - S3 client configuration. See {@link S3ConnectorOptions}.
   * @throws {RangeError} If `timeout` or `maxConcurrency` are invalid.
   */
  constructor(options: S3ConnectorOptions = {}) {
    const timeout = options.timeout ?? 30_000;
    if (!(timeout >= 0)) throw new RangeError(`timeout must be a non-negative number, got ${timeout}`);
    this.timeout = timeout === 0 || timeout > MAX_TIMER_MS ? null : timeout;
    this.limiter = new RequestLimiter(options.maxConcurrency ?? 50);
    this.hints = {
      prefetch: options.prefetch ?? 256 * 1024,
      coalesceGap: options.coalesceGap ?? 64 * 1024,
    };
    this.cacheNamespace = options.cacheNamespace ??
      (options.endpoint ? `s3:${options.endpoint}` : options.client ? undefined : 's3:aws');
    this.clientOptions = options;
  }

  /**
   * Read a contiguous byte range from an S3 object using a `GetObject`
   * request with a `Range: bytes=offset-(offset+length-1)` header.
   *
   * The S3 client is lazily initialized on the first call.
   *
   * @param path - S3 path in `s3://bucket/key` or `bucket/key` format.
   * @param offset - Zero-based byte offset to begin reading from.
   * @param length - Number of bytes to read.
   * @param options - Optional version check (`IfMatch`) and abort signal.
   * @returns The requested byte range.
   * @throws {ConnectorError} If the request fails (with the HTTP `status`
   *   of the S3 error, e.g. 404 for `NoSuchKey`, 403 for `AccessDenied`),
   *   times out, or returns fewer bytes than its `ContentRange` announces.
   * @throws {RangeNotSupportedError} If the store ignores `Range`.
   * @throws {SourceChangedError} If `ifMatch` no longer matches the object.
   * @throws {Error} If the `@aws-sdk/client-s3` peer dependency is not
   *   installed (on first call only).
   */
  async read(path: string, offset: number, length: number, options?: ReadOptions): Promise<Uint8Array> {
    return (await this.getRangeOrEmpty(path, offset, length, options)).bytes;
  }

  /**
   * Read the first `length` bytes of an object together with its size
   * (from `ContentRange`) and `ETag`.
   *
   * @param path - S3 path in `s3://bucket/key` or `bucket/key` format.
   * @param length - Number of leading bytes to read.
   * @param options - Optional abort signal.
   * @returns The leading bytes plus size and version tag.
   */
  async readHead(path: string, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    return this.getRangeOrEmpty(path, 0, length, options);
  }

  /**
   * Read multiple byte ranges from the same S3 object.
   *
   * Each range is fetched as a separate `GetObject` call with a `Range`
   * header, subject to the connector-wide
   * {@link S3ConnectorOptions.maxConcurrency} limit. When one range fails,
   * the others are cancelled.
   * Results are returned in the same order as the input ranges.
   *
   * @param path - S3 path in `s3://bucket/key` or `bucket/key` format.
   * @param ranges - Array of `{ offset, length }` byte-range descriptors.
   * @param options - Optional version check and abort signal, applied to every range.
   * @returns Array of `Uint8Array` chunks in the same order as the input ranges.
   *   Returns an empty array when `ranges` is empty.
   * @throws {Error} If any individual `GetObject` call fails after the
   *   request is issued.
   */
  async readRanges(
    path: string,
    ranges: ReadonlyArray<{ offset: number; length: number }>,
    options?: ReadOptions,
  ): Promise<Uint8Array[]> {
    if (ranges.length === 0) return [];
    if (ranges.length === 1) {
      const r = ranges[0];
      return [await this.read(path, r.offset, r.length, options)];
    }

    return readAll(
      ranges.length,
      (i, signal) => this.read(path, ranges[i].offset, ranges[i].length, { ...options, signal }),
      options?.signal,
    );
  }

  /**
   * Destroy the underlying `S3Client` and release its HTTP connection pool.
   *
   * After calling this method, the connector must not be used for further
   * reads. Calling `close()` on an already-closed connector is a safe no-op.
   *
   * @returns Resolves when the client has been destroyed.
   */
  async close(): Promise<void> {
    this.clientPromise = null;
    if (this.client && this.ownsClient) this.client.destroy?.();
    this.client = null;
    this.ownsClient = false;
  }

  // == Internal ==========================================================

  /**
   * {@link getRange}, with a range beyond the end of the object read as
   * empty (like reading past the end of a file).
   */
  private async getRangeOrEmpty(path: string, offset: number, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    try {
      return await this.getRange(path, offset, length, options);
    } catch (err) {
      if (err instanceof EmptyRange) return { bytes: new Uint8Array(0), size: err.size, etag: null };
      throw err;
    }
  }

  /**
   * Issue one ranged `GetObject` and return the body with the object size
   * and `ETag`.
   *
   * @param path - S3 path in `s3://bucket/key` or `bucket/key` format.
   * @param offset - Zero-based byte offset.
   * @param length - Number of bytes.
   * @param options - Optional version check and abort signal.
   * @returns Body bytes, total size (or `null`) and ETag (or `null`).
   * @throws {EmptyRange} If the range starts beyond the end of the object.
   */
  private async getRange(path: string, offset: number, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Invalid byte range for ${path}: offset ${offset}, length ${length}`);
    }
    const { bucket, key, versionId } = parseS3Path(path);
    options?.signal?.throwIfAborted();
    if (length === 0) return { bytes: new Uint8Array(0), size: null, etag: null };

    const { client, sdk } = await this.getClient();
    const end = offset + length - 1;
    const where = `${path} [${offset}-${end}]`;
    const { requestPayer, expectedBucketOwner, getObjectParams } = this.clientOptions;

    const command = new sdk.GetObjectCommand({
      ...getObjectParams,
      ...(requestPayer ? { RequestPayer: requestPayer } : {}),
      ...(expectedBucketOwner ? { ExpectedBucketOwner: expectedBucketOwner } : {}),
      Bucket: bucket,
      Key: key,
      Range: `bytes=${offset}-${end}`,
      ...(versionId !== undefined ? { VersionId: versionId } : {}),
      ...(options?.ifMatch !== undefined ? { IfMatch: options.ifMatch } : {}),
    });

    // The slot is held until the body is read: it occupies the connection
    return this.limiter.run(async () => {
      const deadline = new Deadline(options?.signal, this.timeout);
      try {
        let response: any;
        try {
          response = await client.send(command, { abortSignal: deadline.signal });
        } catch (err) {
          throw this.sdkError(err, path, where, deadline, options?.signal);
        }

        const etag = typeof response.ETag === 'string' ? response.ETag : null;
        if (options?.ifMatch !== undefined && etag !== null && etag !== options.ifMatch) {
          destroyBody(response.Body);
          throw new SourceChangedError(`${path} changed since it was opened`, { path, status: 412 });
        }
        if (!response.Body) {
          throw new ConnectorError(`Empty response body for ${where}`, { path, retryable: true });
        }

        // The store must answer with the requested range; one that ignores
        // Range sends the whole object, acceptable only if that was asked for
        const range = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(response.ContentRange ?? '').trim());
        let expected: number;
        let size: number | null;
        if (range) {
          if (Number(range[1]) !== offset || Number(range[2]) < offset) {
            destroyBody(response.Body);
            throw new ConnectorError(`Unexpected ContentRange "${response.ContentRange}" reading ${where}`, { path });
          }
          expected = Math.min(length, Number(range[2]) - offset + 1);
          size = range[3] === '*' ? null : Number(range[3]);
        } else {
          const declared = Number(response.ContentLength ?? NaN);
          if (offset !== 0 || !(declared <= length)) {
            destroyBody(response.Body);
            throw new RangeNotSupportedError(
              `Object store does not support byte-range requests (whole object for ${where})`,
              { path, status: 200 },
            );
          }
          expected = declared;
          size = declared;
        }

        const onAbort = () => destroyBody(response.Body, deadline.signal.reason);
        deadline.signal.addEventListener('abort', onAbort, { once: true });
        let bytes: Uint8Array;
        try {
          bytes = await streamToUint8Array(response.Body);
        } catch (err) {
          throw this.sdkError(err, path, where, deadline, options?.signal);
        } finally {
          deadline.signal.removeEventListener('abort', onAbort);
        }
        if (bytes.length < expected) {
          throw new ConnectorError(
            `Truncated response reading ${where}: ${bytes.length} of ${expected} bytes`,
            { path, retryable: true },
          );
        }
        return { bytes: bytes.length > length ? bytes.subarray(0, length) : bytes, size, etag };
      } finally {
        deadline.dispose();
      }
    }, options?.signal);
  }

  /**
   * Translate an error of a `GetObject` call (or of reading its body) into
   * the connector's terms.
   *
   * @returns The error to throw: the caller's abort reason, a timeout, an
   *   {@link EmptyRange} marker for a range beyond the object, a
   *   {@link SourceChangedError}, or a {@link ConnectorError} carrying the
   *   S3 status.
   */
  private sdkError(
    err: any,
    path: string,
    where: string,
    deadline: Deadline,
    callerSignal: AbortSignal | undefined,
  ): unknown {
    if (callerSignal?.aborted) return callerSignal.reason;
    if (deadline.timedOut) {
      return new ConnectorError(`Timed out after ${this.timeout} ms reading ${where}`, { path, retryable: true, cause: err });
    }
    if (isInvalidRange(err)) {
      const size = Number(err?.ActualObjectSize);
      return new EmptyRange(Number.isSafeInteger(size) && size >= 0 ? size : null);
    }
    if (isPreconditionFailed(err)) {
      return new SourceChangedError(`${path} changed since it was opened`, { path, status: 412 });
    }
    if (err instanceof ConnectorError) return err;
    const status: number | undefined = err?.$metadata?.httpStatusCode;
    const retryable = Boolean(err?.$retryable) || status === undefined || status >= 500 || status === 429 || status === 408;
    const name = typeof err?.name === 'string' && err.name !== 'Error' ? `${err.name}: ` : '';
    return new ConnectorError(`S3 GetObject failed for ${where}: ${name}${err?.message ?? String(err)}`, {
      path, retryable, cause: err, ...(status !== undefined ? { status } : {}),
    });
  }

  /**
   * Lazily initialize and return the `S3Client` and SDK module.
   *
   * On the first call, loads the SDK via {@link loadS3Sdk} and constructs
   * an `S3Client` from {@link S3ConnectorOptions}. Subsequent calls return
   * the cached client. Concurrent calls during initialization share the
   * same promise to avoid creating duplicate clients.
   *
   * @returns The SDK module and initialized S3 client.
   */
  private getClient(): Promise<{ client: S3ClientLike; sdk: S3SdkModule }> {
    if (this.client && this.sdk) return Promise.resolve({ client: this.client, sdk: this.sdk });

    if (!this.clientPromise) {
      this.clientPromise = this.initClient();
    }

    return this.clientPromise;
  }

  /**
   * Perform the actual S3 client initialization.
   *
   * Loads the SDK, constructs the client, and caches both on `this`.
   * If initialization fails, the pending promise is cleared so that
   * subsequent calls can retry.
   *
   * @returns The SDK module and initialized S3 client.
   */
  private async initClient(): Promise<{ client: S3ClientLike; sdk: S3SdkModule }> {
    try {
      const sdk = this.clientOptions.sdk ?? await loadS3Sdk();
      this.sdk = sdk;
      if (this.clientOptions.client) {
        this.client = this.clientOptions.client;
        this.ownsClient = false;
        return { client: this.client, sdk };
      }

      const config: Record<string, unknown> = {};
      if (this.clientOptions.region) {
        config.region = this.clientOptions.region;
      }

      if (this.clientOptions.credentials) {
        config.credentials = this.clientOptions.credentials;
      }

      if (this.clientOptions.endpoint) {
        config.endpoint = this.clientOptions.endpoint;
      }

      if (this.clientOptions.forcePathStyle) {
        config.forcePathStyle = true;
      }

      this.client = new sdk.S3Client(config);
      this.ownsClient = true;
      return { client: this.client, sdk };
    } catch (err) {
      this.clientPromise = null; // allow retry on failure
      throw err;
    }
  }
}

/**
 * Whether an SDK error means the requested range lies beyond the object
 * (HTTP 416 / `InvalidRange`).
 *
 * @param err - Error thrown by `S3Client.send`.
 * @returns `true` for range-not-satisfiable errors.
 */
function isInvalidRange(err: any): boolean {
  return err?.name === 'InvalidRange' || err?.Code === 'InvalidRange' ||
    err?.$metadata?.httpStatusCode === 416;
}

/**
 * Whether an SDK error means an `IfMatch` precondition failed (HTTP 412).
 *
 * @param err - Error thrown by `S3Client.send`.
 * @returns `true` for precondition failures.
 */
function isPreconditionFailed(err: any): boolean {
  return err?.name === 'PreconditionFailed' || err?.Code === 'PreconditionFailed' ||
    err?.$metadata?.httpStatusCode === 412;
}

/**
 * Collect a readable stream body into a single `Uint8Array`.
 *
 * Prefers the AWS SDK v3 convenience method `transformToByteArray()` when
 * available, falling back to manual async-iterable consumption for
 * environments where that method is absent.
 *
 * @param body - The response body from an S3 `GetObject` call.
 * @returns The complete body as a contiguous `Uint8Array`.
 */
async function streamToUint8Array(body: any): Promise<Uint8Array> {
  // AWS SDK v3 provides transformToByteArray convenience method
  if (typeof body.transformToByteArray === 'function') {
    return body.transformToByteArray();
  }

  // Fallback: async iterable stream
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Thrown internally for a range beyond the end of the object (416). */
class EmptyRange {
  constructor(readonly size: number | null) {}
}

/**
 * An abort signal that fires on the caller's signal or after a timeout.
 *
 * `AbortSignal.any` is not available in Node.js 18, so the two are joined
 * by hand; {@link Deadline.dispose} removes the listener and the timer.
 */
class Deadline {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | null;
  private readonly onAbort: () => void;
  /** Whether the timeout (not the caller) aborted the request. */
  timedOut = false;

  constructor(private readonly caller: AbortSignal | undefined, timeout: number | null) {
    this.onAbort = () => this.controller.abort(caller?.reason);
    if (caller?.aborted) this.controller.abort(caller.reason);
    else caller?.addEventListener('abort', this.onAbort, { once: true });
    this.timer = timeout === null ? null : setTimeout(() => {
      this.timedOut = true;
      this.controller.abort(new Error('timeout'));
    }, timeout);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.caller?.removeEventListener('abort', this.onAbort);
  }
}

/**
 * Stop a response body that will not be (fully) read, releasing its
 * connection: Node.js streams are destroyed, web streams cancelled.
 */
function destroyBody(body: any, reason?: unknown): void {
  try {
    if (typeof body?.destroy === 'function') body.destroy(reason instanceof Error ? reason : undefined);
    else if (typeof body?.cancel === 'function') void body.cancel(reason).catch(() => {});
  } catch {
    // Already closed
  }
}

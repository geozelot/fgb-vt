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
import { ConnectorError, SourceChangedError } from '../errors.js';
import { RequestLimiter, readAll } from './limiter.js';

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
}

/**
 * Parse an S3 path string into its constituent bucket name and object key.
 *
 * Accepts both the `s3://` URI scheme and bare `bucket/key` format:
 *
 * - `"s3://my-bucket/path/to/file.fgb"` -> `{ bucket: "my-bucket", key: "path/to/file.fgb" }`
 * - `"my-bucket/path/to/file.fgb"` -> `{ bucket: "my-bucket", key: "path/to/file.fgb" }`
 *
 * @param path - S3 path in either `s3://bucket/key` or `bucket/key` format.
 * @returns An object containing the parsed `bucket` and `key`.
 * @throws {Error} If the path contains no `/` separator after the bucket
 *   name (i.e. the key portion is missing).
 */
function parseS3Path(path: string): { bucket: string; key: string } {
  let normalized = path;
  if (normalized.startsWith('s3://')) {
    normalized = normalized.slice(5);
  }
  const slashIdx = normalized.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Invalid S3 path (no key): ${path}`);
  }
  return {
    bucket: normalized.slice(0, slashIdx),
    key: normalized.slice(slashIdx + 1),
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
 * import { S3Connector } from 'fgb-vt';
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

  private readonly limiter: RequestLimiter;
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
   * operation, so construction is synchronous and never throws.
   *
   * @param options - S3 client configuration. See {@link S3ConnectorOptions}.
   */
  constructor(options: S3ConnectorOptions = {}) {
    this.limiter = new RequestLimiter(options.maxConcurrency ?? 50);
    this.hints = {
      prefetch: options.prefetch ?? 256 * 1024,
      coalesceGap: options.coalesceGap ?? 64 * 1024,
    };
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
   * @throws {ConnectorError} If the S3 response body is empty.
   * @throws {SourceChangedError} If `ifMatch` no longer matches the object.
   * @throws {Error} If the `@aws-sdk/client-s3` peer dependency is not
   *   installed (on first call only).
   * @throws {Error} If the SDK `GetObject` call fails (permissions,
   *   invalid bucket/key, network errors, etc.).
   */
  async read(path: string, offset: number, length: number, options?: ReadOptions): Promise<Uint8Array> {
    return (await this.getRange(path, offset, length, options)).bytes;
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
    return this.getRange(path, 0, length, options);
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
   * Issue one ranged `GetObject` and return the body with the object size
   * and `ETag`.
   *
   * @param path - S3 path in `s3://bucket/key` or `bucket/key` format.
   * @param offset - Zero-based byte offset.
   * @param length - Number of bytes.
   * @param options - Optional version check and abort signal.
   * @returns Body bytes, total size (or `null`) and ETag (or `null`).
   */
  private async getRange(path: string, offset: number, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Invalid byte range for ${path}: offset ${offset}, length ${length}`);
    }
    options?.signal?.throwIfAborted();
    if (length === 0) return { bytes: new Uint8Array(0), size: null, etag: null };

    const { client, sdk } = await this.getClient();
    const { bucket, key } = parseS3Path(path);
    const end = offset + length - 1;

    const command = new sdk.GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${offset}-${end}`,
      ...(options?.ifMatch !== undefined ? { IfMatch: options.ifMatch } : {}),
    });

    // The slot is held until the body is read: it occupies the connection
    const result = await this.limiter.run(async () => {
      let response: any;
      try {
        response = await client.send(command, options?.signal ? { abortSignal: options.signal } : undefined);
      } catch (err) {
        // Range starting at or beyond the end of the object: nothing to read
        if (isInvalidRange(err)) return null;
        if (isPreconditionFailed(err)) {
          throw new SourceChangedError(`${path} changed since it was opened`, { path, status: 412 });
        }
        throw err;
      }
      if (!response.Body) {
        throw new ConnectorError(`Empty response body for ${path} [${offset}-${end}]`, { path });
      }
      return { response, bytes: await streamToUint8Array(response.Body) };
    }, options?.signal);
    if (!result) return { bytes: new Uint8Array(0), size: null, etag: null };

    const { response, bytes } = result;
    const total = /\/(\d+)\s*$/.exec(response.ContentRange ?? '');
    return {
      bytes: bytes.length > length ? bytes.subarray(0, length) : bytes,
      size: total ? Number(total[1]) : null,
      etag: typeof response.ETag === 'string' ? response.ETag : null,
    };
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

/**
 * @module connectors/s3
 *
 * Amazon S3 {@link Connector} implementation using AWS SDK v3.
 *
 * Reads FlatGeobuf byte ranges via `GetObject` with the `Range` header.
 * The `@aws-sdk/client-s3` package is loaded lazily at first use so that
 * applications not using S3 pay no import cost. Multi-range reads are
 * throttled to a configurable concurrency limit.
 *
 * Compatible with any S3-compatible object store (MinIO, Cloudflare R2,
 * Backblaze B2, etc.) via the `endpoint` and `forcePathStyle` options.
 */

import type { Connector } from './connector.js';

/**
 * Configuration options for {@link S3Connector}.
 */
export interface S3ConnectorOptions {
  /** AWS region for the S3 client (e.g. `"us-east-1"`). */
  region: string;
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
   * Maximum number of concurrent `GetObject` calls within a single
   * {@link S3Connector.readRanges} invocation.
   *
   * @defaultValue 10
   */
  maxConcurrency?: number;
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
 * Lazily load the `@aws-sdk/client-s3` module at runtime.
 *
 * Uses the `Function` constructor to create a dynamic `import()` expression
 * that is invisible to static analysis by TypeScript and bundlers. This
 * ensures the SDK is only loaded (and required to be installed) when
 * {@link S3Connector} is actually instantiated.
 *
 * @returns The resolved `@aws-sdk/client-s3` module namespace.
 * @throws {Error} If the package is not installed, with an actionable
 *   installation instruction in the error message.
 */
async function loadS3Sdk(): Promise<any> {
  try {
    return await (Function('return import("@aws-sdk/client-s3")')() as Promise<any>);
  } catch {
    throw new Error(
      'S3Connector requires @aws-sdk/client-s3 as a peer dependency. ' +
      'Install it with: npm install @aws-sdk/client-s3',
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
  private readonly maxConcurrency: number;
  private client: any = null;
  private sdk: any = null;
  private clientPromise: Promise<{ client: any; sdk: any }> | null = null;
  private readonly clientOptions: S3ConnectorOptions;

  /**
   * Create a new S3 connector.
   *
   * The underlying `S3Client` is **not** created until the first read
   * operation, so construction is synchronous and never throws.
   *
   * @param options - S3 client configuration. See {@link S3ConnectorOptions}.
   */
  constructor(options: S3ConnectorOptions) {
    this.maxConcurrency = options.maxConcurrency ?? 10;
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
   * @returns The requested byte range.
   * @throws {Error} If the S3 response body is empty.
   * @throws {Error} If the `@aws-sdk/client-s3` peer dependency is not
   *   installed (on first call only).
   * @throws {Error} If the SDK `GetObject` call fails (permissions,
   *   invalid bucket/key, network errors, etc.).
   */
  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    const { client, sdk } = await this.getClient();
    const { bucket, key } = parseS3Path(path);
    const end = offset + length - 1;

    const command = new sdk.GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${offset}-${end}`,
    });

    const response = await client.send(command);
    const body = response.Body;

    if (!body) {
      throw new Error(`Empty response body for ${path} [${offset}-${end}]`);
    }

    return streamToUint8Array(body);
  }

  /**
   * Read multiple byte ranges from the same S3 object.
   *
   * Each range is fetched as a separate `GetObject` call with a `Range`
   * header. Calls are dispatched through a worker pool limited to
   * {@link S3ConnectorOptions.maxConcurrency} concurrent requests.
   * Results are returned in the same order as the input ranges.
   *
   * @param path - S3 path in `s3://bucket/key` or `bucket/key` format.
   * @param ranges - Array of `{ offset, length }` byte-range descriptors.
   * @returns Array of `Uint8Array` chunks in the same order as the input ranges.
   *   Returns an empty array when `ranges` is empty.
   * @throws {Error} If any individual `GetObject` call fails after the
   *   request is issued.
   */
  async readRanges(
    path: string,
    ranges: ReadonlyArray<{ offset: number; length: number }>,
  ): Promise<Uint8Array[]> {
    if (ranges.length === 0) return [];
    if (ranges.length === 1) {
      const r = ranges[0];
      return [await this.read(path, r.offset, r.length)];
    }

    // Throttled parallel GetObject calls
    const results = new Array<Uint8Array>(ranges.length);
    const queue = ranges.map((r, i) => ({ ...r, index: i }));
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        const idx = cursor++;
        const item = queue[idx];
        results[item.index] = await this.read(path, item.offset, item.length);
      }
    };

    const workers = Array.from(
      { length: Math.min(this.maxConcurrency, queue.length) },
      () => worker(),
    );

    await Promise.all(workers);
    return results;
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
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────

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
  private getClient(): Promise<{ client: any; sdk: any }> {
    if (this.client) return Promise.resolve({ client: this.client, sdk: this.sdk });

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
  private async initClient(): Promise<{ client: any; sdk: any }> {
    try {
      const sdk = await loadS3Sdk();
      this.sdk = sdk;

      const config: Record<string, unknown> = {
        region: this.clientOptions.region,
      };

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
      return { client: this.client, sdk: this.sdk };
    } catch (err) {
      this.clientPromise = null; // allow retry on failure
      throw err;
    }
  }
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

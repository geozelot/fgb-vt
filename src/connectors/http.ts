/**
 * @module connectors/http
 *
 * HTTP(S) {@link Connector} implementation using Range Requests.
 *
 * Leverages the Node.js built-in `fetch` API (Node 18+) to issue
 * `Range: bytes=...` requests against any HTTP endpoint that supports
 * partial content responses (status 206). Includes configurable retry
 * with exponential backoff, per-request timeouts via `AbortController`,
 * and concurrency throttling for multi-range reads.
 *
 * Suitable for static file servers, CDNs, cloud storage with pre-signed
 * URLs, and any other HTTP-accessible FlatGeobuf hosting.
 */

import type { Connector, ConnectorHints, ReadHeadResult, ReadOptions } from './connector.js';
import { ConnectorError, RangeNotSupportedError, SourceChangedError } from '../errors.js';

/**
 * Configuration options for {@link HttpConnector}.
 */
export interface HttpConnectorOptions {
  /**
   * Default headers sent with every request.
   *
   * Useful for authorization tokens, custom user-agent strings, or
   * CDN-specific headers (e.g. `{ Authorization: 'Bearer ...' }`).
   */
  headers?: Record<string, string>;
  /**
   * Per-request timeout in milliseconds.
   *
   * If a single fetch does not complete within this window, the request
   * is aborted and (if retries remain) retried.
   *
   * @defaultValue 30000
   */
  timeout?: number;
  /**
   * Maximum number of concurrent HTTP Range Requests issued by a single
   * {@link HttpConnector.readRanges} call.
   *
   * Limits parallelism to avoid overwhelming the origin server or
   * exhausting local socket resources.
   *
   * @defaultValue 6
   */
  maxConcurrency?: number;
  /**
   * Retry configuration for transient failures.
   *
   * Retries are attempted on HTTP 5xx responses, HTTP 429 (Too Many
   * Requests), network errors, and timeouts. Backoff between attempts
   * follows an exponential schedule: `backoff * 2^attempt` ms.
   *
   * @defaultValue \{ attempts: 3, backoff: 200 \}
   */
  retry?: {
    /** Total number of attempts (including the initial request). */
    attempts: number;
    /** Base backoff delay in milliseconds before the first retry. */
    backoff: number;
  };
  /**
   * Size of the first read of a file (header plus top of the index).
   *
   * @defaultValue 262144 (256 KiB) in Node.js, 16384 (16 KiB) in browsers
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
 * HTTP(S) connector using the Node.js built-in `fetch` (Node 18+) with
 * HTTP Range Requests.
 *
 * Suitable for any HTTP endpoint that supports partial content responses:
 * static file servers, CDNs, cloud storage with pre-signed URLs, etc.
 * Multi-range reads are throttled to {@link HttpConnectorOptions.maxConcurrency}
 * concurrent requests to avoid overwhelming the origin.
 *
 * @example
 * ```typescript
 * import { HttpConnector } from 'fgb-vt';
 *
 * const connector = new HttpConnector({
 *   headers: { Authorization: 'Bearer my-token' },
 *   timeout: 15_000,
 *   maxConcurrency: 4,
 *   retry: { attempts: 5, backoff: 300 },
 * });
 *
 * const bytes = await connector.read(
 *   'https://cdn.example.com/data/buildings.fgb',
 *   0,
 *   1024,
 * );
 *
 * await connector.close();
 * ```
 */
export class HttpConnector implements Connector {
  readonly hints: ConnectorHints;

  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly maxConcurrency: number;
  private readonly retryAttempts: number;
  private readonly retryBackoff: number;

  /**
   * Create a new HTTP connector.
   *
   * @param options - Optional configuration. See {@link HttpConnectorOptions}.
   */
  constructor(options?: HttpConnectorOptions) {
    this.headers = options?.headers ?? {};
    this.timeout = options?.timeout ?? 30_000;
    this.maxConcurrency = options?.maxConcurrency ?? 6;
    this.retryAttempts = Math.max(1, options?.retry?.attempts ?? 3);
    this.retryBackoff = options?.retry?.backoff ?? 200;
    this.hints = {
      prefetch: options?.prefetch ?? (isNode() ? 256 * 1024 : 16 * 1024),
      coalesceGap: options?.coalesceGap ?? 64 * 1024,
    };
  }

  /**
   * Read a contiguous byte range from an HTTP(S) URL using a
   * `Range: bytes=offset-(offset+length-1)` request header.
   *
   * Expects HTTP 206 Partial Content starting at `offset` (checked against
   * `Content-Range` when present). Other outcomes:
   *
   * - **416 Range Not Satisfiable** (range starts at or beyond the end of
   *   the resource) → empty result, consistent with reading past EOF.
   * - **200 OK** (server ignored `Range`) → accepted only for reads from
   *   offset 0 whose full body fits within `length`; otherwise a
   *   {@link RangeNotSupportedError}, because every later read would
   *   silently download the whole file.
   * - **412 Precondition Failed** (with {@link ReadOptions.ifMatch}) →
   *   {@link SourceChangedError}.
   *
   * @param path - Fully qualified HTTP(S) URL to the FGB resource.
   * @param offset - Zero-based byte offset to begin reading from.
   * @param length - Number of bytes to read.
   * @param options - Optional version check and abort signal.
   * @returns The requested byte range; shorter than `length` if the
   *   resource ends first.
   * @throws {ConnectorError} On non-success status codes (after exhausting
   *   retries for transient ones) and mismatched `Content-Range` responses.
   * @throws {RangeNotSupportedError} If the server ignores `Range`.
   * @throws {SourceChangedError} If `ifMatch` no longer matches.
   */
  async read(path: string, offset: number, length: number, options?: ReadOptions): Promise<Uint8Array> {
    return (await this.request(path, offset, length, options)).bytes;
  }

  /**
   * Read the first `length` bytes together with the resource size (from
   * `Content-Range`) and version tag (`ETag`).
   *
   * @param path - Fully qualified HTTP(S) URL to the FGB resource.
   * @param length - Number of leading bytes to read.
   * @param options - Optional abort signal.
   * @returns The leading bytes plus size and version tag.
   */
  async readHead(path: string, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    return this.request(path, 0, length, options);
  }

  /**
   * Read multiple byte ranges from the same HTTP(S) URL.
   *
   * Each range is fetched as a separate HTTP Range Request. Requests are
   * dispatched through a worker pool limited to
   * {@link HttpConnectorOptions.maxConcurrency} concurrent fetches.
   * Results are returned in the same order as the input ranges.
   *
   * @param path - Fully qualified HTTP(S) URL to the FGB resource.
   * @param ranges - Array of `{ offset, length }` byte-range descriptors.
   * @param options - Optional version check and abort signal, applied to every range.
   * @returns Array of `Uint8Array` chunks in the same order as the input ranges.
   *   Returns an empty array when `ranges` is empty.
   * @throws {Error} If any individual range request fails after retries.
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

    // Throttled parallel fetches
    const results = new Array<Uint8Array>(ranges.length);
    const queue = ranges.map((r, i) => ({ ...r, index: i }));
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        const idx = cursor++;
        const item = queue[idx];
        results[item.index] = await this.read(path, item.offset, item.length, options);
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
   * No-op for the HTTP connector.
   *
   * The built-in `fetch` API does not maintain persistent connections
   * that require explicit cleanup. This method exists to satisfy the
   * {@link Connector} interface contract.
   *
   * @returns Resolves immediately.
   */
  async close(): Promise<void> {
    // No persistent connections to clean up with fetch
  }

  // == Internal ==========================================================

  /**
   * Perform one ranged GET (with retries) and return the body together
   * with the resource size and version tag reported by the server.
   *
   * @param path - URL to read.
   * @param offset - Zero-based byte offset.
   * @param length - Number of bytes.
   * @param options - Optional version check and abort signal.
   * @returns Body bytes, total size (or `null`) and ETag (or `null`).
   */
  private async request(path: string, offset: number, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Invalid byte range for ${path}: offset ${offset}, length ${length}`);
    }
    options?.signal?.throwIfAborted();
    if (length === 0) return { bytes: new Uint8Array(0), size: null, etag: null };

    const end = offset + length - 1;
    const where = `${path} [${offset}-${end}]`;
    const headers: Record<string, string> = { ...this.headers, Range: `bytes=${offset}-${end}` };
    // Weak validators cannot be used with If-Match (strong comparison)
    if (options?.ifMatch !== undefined && !options.ifMatch.startsWith('W/')) {
      headers['If-Match'] = options.ifMatch;
    }

    return this.withRetry(where, options?.signal, async (signal) => {
      const response = await fetch(path, { headers, signal });
      const { status } = response;
      const etag = response.headers.get('etag');

      if (status === 206) {
        const contentRange = response.headers.get('content-range');
        let size: number | null = null;
        if (contentRange !== null) {
          const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim());
          if (!m || Number(m[1]) !== offset) {
            await discard(response);
            throw new ConnectorError(`Unexpected Content-Range "${contentRange}" reading ${where}`, { path, status });
          }
          if (m[3] !== '*') size = Number(m[3]);
        }
        const body = new Uint8Array(await response.arrayBuffer());
        return { bytes: body.length > length ? body.subarray(0, length) : body, size, etag };
      }

      if (status === 416) {
        await discard(response);
        const m = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '');
        return { bytes: new Uint8Array(0), size: m ? Number(m[1]) : null, etag };
      }

      if (status === 412) {
        await discard(response);
        throw new SourceChangedError(`${path} changed since it was opened (HTTP 412)`, { path, status });
      }

      if (status === 200) {
        // The server ignored Range and is sending the whole resource.
        const declared = Number(response.headers.get('content-length') ?? NaN);
        if (offset === 0 && !(declared > length)) {
          const body = new Uint8Array(await response.arrayBuffer());
          if (body.length <= length) return { bytes: body, size: body.length, etag };
        } else {
          await discard(response);
        }
        throw new RangeNotSupportedError(
          `Server does not support byte-range requests (HTTP 200 for ${where}); ` +
          'FlatGeobuf access requires HTTP 206 Partial Content',
          { path, status },
        );
      }

      await discard(response);
      const retryable = status >= 500 || status === 429 || status === 408;
      throw new ConnectorError(`HTTP ${status} reading ${where}`, { path, status, retryable });
    });
  }

  /**
   * Run one complete request attempt — fetch plus body read — under a
   * per-attempt timeout, retrying transient failures with exponential
   * backoff.
   *
   * Retries are triggered by HTTP 5xx, 408 and 429, network errors, body
   * read failures, and timeouts. Errors marked non-retryable (client
   * errors, missing range support, changed source) and aborts requested
   * by the caller are thrown immediately. The backoff schedule is
   * `retryBackoff * 2^attempt` milliseconds.
   *
   * @param where - Request description used in error messages.
   * @param callerSignal - Optional caller abort signal.
   * @param attempt - Performs the request with the given abort signal.
   * @returns The attempt's result.
   * @throws {Error} The last encountered error if all attempts fail.
   */
  private async withRetry<T>(
    where: string,
    callerSignal: AbortSignal | undefined,
    attempt: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown = null;

    for (let i = 0; i < this.retryAttempts; i++) {
      callerSignal?.throwIfAborted();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      const onAbort = () => controller.abort(callerSignal?.reason);
      callerSignal?.addEventListener('abort', onAbort, { once: true });
      try {
        return await attempt(controller.signal);
      } catch (err) {
        if (callerSignal?.aborted) throw callerSignal.reason;
        if (err instanceof ConnectorError && !err.retryable) throw err;
        lastError = controller.signal.aborted
          ? new ConnectorError(`Timed out after ${this.timeout} ms reading ${where}`, { retryable: true, cause: err })
          : err;
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onAbort);
      }
      if (i < this.retryAttempts - 1) {
        await sleep(this.retryBackoff * Math.pow(2, i));
      }
    }

    throw lastError ?? new ConnectorError(`Failed to read ${where}`);
  }
}

/**
 * Release a response body that will not be read, so the underlying
 * connection can be reused instead of waiting for garbage collection.
 *
 * @param response - Response whose body should be discarded.
 */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed; nothing to release.
  }
}

/**
 * Whether the code runs under Node.js (as opposed to a browser).
 *
 * @returns `true` in Node.js.
 */
function isNode(): boolean {
  return typeof process !== 'undefined' && typeof process.versions?.node === 'string';
}

/**
 * Sleep for the specified duration.
 *
 * @param ms - Duration in milliseconds.
 * @returns Resolves after `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

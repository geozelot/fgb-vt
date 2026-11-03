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

import type { Connector } from './connector.js';

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
    this.retryAttempts = options?.retry?.attempts ?? 3;
    this.retryBackoff = options?.retry?.backoff ?? 200;
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
   *   offset 0 whose full body fits within `length`; otherwise an error,
   *   because every later read would silently download the whole file.
   *
   * @param path - Fully qualified HTTP(S) URL to the FGB resource.
   * @param offset - Zero-based byte offset to begin reading from.
   * @param length - Number of bytes to read.
   * @returns The requested byte range; shorter than `length` if the
   *   resource ends first.
   * @throws {Error} On non-success status codes (after exhausting retries
   *   for transient ones), servers without byte-range support, and
   *   mismatched `Content-Range` responses.
   */
  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Invalid byte range for ${path}: offset ${offset}, length ${length}`);
    }
    if (length === 0) return new Uint8Array(0);

    const end = offset + length - 1;
    const where = `${path} [${offset}-${end}]`;

    return this.withRetry(where, async (signal) => {
      const response = await fetch(path, {
        headers: { ...this.headers, Range: `bytes=${offset}-${end}` },
        signal,
      });
      const { status } = response;

      if (status === 206) {
        const contentRange = response.headers.get('content-range');
        if (contentRange !== null) {
          const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim());
          if (!m || Number(m[1]) !== offset) {
            await discard(response);
            throw new HttpReadError(`Unexpected Content-Range "${contentRange}" reading ${where}`, false);
          }
        }
        const body = new Uint8Array(await response.arrayBuffer());
        return body.length > length ? body.subarray(0, length) : body;
      }

      if (status === 416) {
        await discard(response);
        return new Uint8Array(0);
      }

      if (status === 200) {
        // The server ignored Range and is sending the whole resource.
        const declared = Number(response.headers.get('content-length') ?? NaN);
        if (offset === 0 && !(declared > length)) {
          const body = new Uint8Array(await response.arrayBuffer());
          if (body.length <= length) return body;
        } else {
          await discard(response);
        }
        throw new HttpReadError(
          `Server does not support byte-range requests (HTTP 200 for ${where}); ` +
          'FlatGeobuf access requires HTTP 206 Partial Content',
          false,
        );
      }

      await discard(response);
      const retryable = status >= 500 || status === 429 || status === 408;
      throw new HttpReadError(`HTTP ${status} reading ${where}`, retryable);
    });
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
   * @returns Array of `Uint8Array` chunks in the same order as the input ranges.
   *   Returns an empty array when `ranges` is empty.
   * @throws {Error} If any individual range request fails after retries.
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

    // Throttled parallel fetches
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
   * Run one complete request attempt — fetch plus body read — under a
   * per-attempt timeout, retrying transient failures with exponential
   * backoff.
   *
   * Retries are triggered by HTTP 5xx, 408 and 429, network errors, body
   * read failures, and timeouts. Errors marked non-retryable (client
   * errors, missing range support) are thrown immediately. The backoff
   * schedule is `retryBackoff * 2^attempt` milliseconds.
   *
   * @param where - Request description used in error messages.
   * @param attempt - Performs the request with the given abort signal.
   * @returns The attempt's result.
   * @throws {Error} The last encountered error if all attempts fail.
   */
  private async withRetry<T>(
    where: string,
    attempt: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown = null;

    for (let i = 0; i < this.retryAttempts; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        return await attempt(controller.signal);
      } catch (err) {
        if (err instanceof HttpReadError && !err.retryable) throw err;
        lastError = controller.signal.aborted
          ? new HttpReadError(`Timed out after ${this.timeout} ms reading ${where}`, true)
          : err;
      } finally {
        clearTimeout(timer);
      }
      if (i < this.retryAttempts - 1) {
        await sleep(this.retryBackoff * Math.pow(2, i));
      }
    }

    throw lastError ?? new Error(`Failed to read ${where}`);
  }
}

/**
 * Error raised by {@link HttpConnector} reads, flagged as transient or not.
 */
class HttpReadError extends Error {
  /** Whether retrying the same request may succeed. */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'HttpReadError';
    this.retryable = retryable;
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
 * Sleep for the specified duration.
 *
 * @param ms - Duration in milliseconds.
 * @returns Resolves after `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
   * Expects the server to respond with HTTP 206 Partial Content. Any
   * 2xx response is also accepted for compatibility with servers that
   * ignore Range headers and return the full body.
   *
   * @param path - Fully qualified HTTP(S) URL to the FGB resource.
   * @param offset - Zero-based byte offset to begin reading from.
   * @param length - Number of bytes to read.
   * @returns The requested byte range.
   * @throws {Error} If the server returns a non-success status code
   *   (after exhausting retries) with a message containing the HTTP
   *   status, path, and byte range.
   */
  async read(path: string, offset: number, length: number): Promise<Uint8Array> {
    const end = offset + length - 1;
    const response = await this.fetchWithRetry(path, {
      headers: {
        ...this.headers,
        Range: `bytes=${offset}-${end}`,
      },
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(
        `HTTP ${response.status} reading ${path} [${offset}-${end}]`,
      );
    }

    const buf = await response.arrayBuffer();
    return new Uint8Array(buf);
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

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Execute a `fetch` with timeout and exponential-backoff retry.
   *
   * Retries are triggered by HTTP 5xx, HTTP 429, network errors, and
   * `AbortController` timeout aborts. The backoff schedule is
   * `retryBackoff * 2^attempt` milliseconds.
   *
   * @param url - The URL to fetch.
   * @param init - Standard `RequestInit` options (headers, etc.).
   * @returns The HTTP `Response` on success.
   * @throws {Error} The last encountered error if all retry attempts
   *   are exhausted.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeout);

        const response = await fetch(url, {
          ...init,
          signal: controller.signal,
        });

        clearTimeout(timer);

        // Retry on 5xx or 429
        if (response.status >= 500 || response.status === 429) {
          lastError = new Error(`HTTP ${response.status}`);
          if (attempt < this.retryAttempts - 1) {
            await sleep(this.retryBackoff * Math.pow(2, attempt));
            continue;
          }
        }

        return response;
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.retryAttempts - 1) {
          await sleep(this.retryBackoff * Math.pow(2, attempt));
        }
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url}`);
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

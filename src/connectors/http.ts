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
import { ConnectorError, RangeNotSupportedError, SourceChangedError, redactPath } from '../errors.js';
import { RequestLimiter, readAll } from './limiter.js';

/** Longest backoff between two attempts, in milliseconds. */
const MAX_BACKOFF_MS = 30_000;

/** Largest `setTimeout` delay; longer timeouts mean no timeout. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Prefix of version tags derived from `Last-Modified` (no ETag). */
const LAST_MODIFIED_TAG = 'last-modified:';

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
   * Per-attempt timeout in milliseconds, covering the response and its
   * body.
   *
   * If an attempt does not complete within this window, it is aborted and
   * (if retries remain) retried. `0` or `Infinity` disable the timeout.
   *
   * @defaultValue 30000
   */
  timeout?: number;
  /**
   * Most HTTP requests in flight at once across all reads through this
   * connector (every tile and source sharing it); further requests wait
   * in arrival order. Waiting does not count towards `timeout`.
   *
   * Limits parallelism to avoid overwhelming the origin server or
   * exhausting local socket resources. `Infinity` disables the limit.
   *
   * @defaultValue 32 in Node.js, 6 in browsers (their per-host connection limit)
   */
  maxConcurrency?: number;
  /**
   * Retry configuration for transient failures.
   *
   * Retries are attempted on HTTP 5xx responses, HTTP 408 and 429, network
   * errors, truncated responses and timeouts. Backoff between attempts
   * grows exponentially (`backoff * 2^attempt` ms, at most 30 s) with
   * random jitter, so concurrent requests do not retry in lockstep. A
   * server's `Retry-After` is honoured; if it asks for more than 30 s, the
   * error is raised instead (with {@link ConnectorError.retryAfterMs}).
   *
   * @defaultValue \{ attempts: 3, backoff: 200 \}
   */
  retry?: {
    /** Total number of attempts (including the initial request); at least 1. */
    attempts: number;
    /** Base backoff delay in milliseconds before the first retry. */
    backoff: number;
  };
  /**
   * How reads are bound to the file version seen when the source was
   * opened (its `ETag`, or `Last-Modified` without one).
   *
   * By default every response's validator is compared with it, and a
   * mismatch raises {@link SourceChangedError}. With `true`, requests also
   * carry `If-Match` (or `If-Unmodified-Since`), so the server itself
   * refuses a changed file with 412. Conditional requests have costs:
   * per the Fetch standard they bypass HTTP caches, and in browsers they
   * need a CORS preflight per request.
   *
   * @defaultValue false
   */
  conditionalRequests?: boolean;
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
 * Requests are limited to {@link HttpConnectorOptions.maxConcurrency} in
 * flight across all reads of the connector, to avoid overwhelming the origin.
 *
 * @example
 * ```typescript
 * import { HttpConnector } from '@geozelot/fgb-vt';
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
  /** URLs identify resources globally. */
  readonly cacheNamespace = 'http';

  private readonly headers: Record<string, string>;
  /** Per-attempt timeout in milliseconds, or `null` for none. */
  private readonly timeout: number | null;
  private readonly limiter: RequestLimiter;
  private readonly retryAttempts: number;
  private readonly retryBackoff: number;
  private readonly conditional: boolean;

  /**
   * Create a new HTTP connector.
   *
   * @param options - Optional configuration. See {@link HttpConnectorOptions}.
   * @throws {RangeError} If `timeout`, `retry` or `maxConcurrency` are invalid.
   */
  constructor(options?: HttpConnectorOptions) {
    const timeout = options?.timeout ?? 30_000;
    if (!(timeout >= 0)) throw new RangeError(`timeout must be a non-negative number, got ${timeout}`);
    const attempts = options?.retry?.attempts ?? 3;
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new RangeError(`retry.attempts must be a positive integer, got ${attempts}`);
    }
    const backoff = options?.retry?.backoff ?? 200;
    if (!(backoff >= 0 && backoff !== Infinity)) {
      throw new RangeError(`retry.backoff must be a non-negative finite number, got ${backoff}`);
    }
    this.headers = options?.headers ?? {};
    this.timeout = timeout === 0 || timeout > MAX_TIMER_MS ? null : timeout;
    this.limiter = new RequestLimiter(options?.maxConcurrency ?? (isNode() ? 32 : 6));
    this.retryAttempts = attempts;
    this.retryBackoff = backoff;
    this.conditional = options?.conditionalRequests ?? false;
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
   * - A response whose `ETag` (or `Last-Modified`) differs from
   *   {@link ReadOptions.ifMatch}, or **412 Precondition Failed** (with
   *   `conditionalRequests`) → {@link SourceChangedError}.
   * - A response shorter than its `Content-Range` → retried; a server that
   *   returns less than requested (a cap on range sizes) is asked for the
   *   rest.
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
   * `Content-Range`, or a `HEAD` request when the server reports `*`) and
   * version tag (`ETag`, or `Last-Modified` without one).
   *
   * @param path - Fully qualified HTTP(S) URL to the FGB resource.
   * @param length - Number of leading bytes to read.
   * @param options - Optional abort signal.
   * @returns The leading bytes plus size and version tag.
   */
  async readHead(path: string, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    const head = await this.request(path, 0, length, options);
    if (head.size === null && head.bytes.length === length && length > 0) {
      const size = await this.contentLength(path, head.etag, options?.signal);
      if (size !== null) return { ...head, size };
    }
    return head;
  }

  /**
   * Read multiple byte ranges from the same HTTP(S) URL.
   *
   * Each range is fetched as a separate HTTP Range Request, subject to the
   * connector-wide {@link HttpConnectorOptions.maxConcurrency} limit. When
   * one range fails, the others are cancelled. Results are returned in the
   * same order as the input ranges.
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

    return readAll(
      ranges.length,
      (i, signal) => this.read(path, ranges[i].offset, ranges[i].length, { ...options, signal }),
      options?.signal,
    );
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
   * Read a byte range, continuing with further requests when the server
   * returns less than asked (some servers and CDNs cap range sizes).
   *
   * @param path - URL to read.
   * @param offset - Zero-based byte offset.
   * @param length - Number of bytes.
   * @param options - Optional version check and abort signal.
   * @returns Body bytes, total size (or `null`) and version tag (or `null`).
   */
  private async request(path: string, offset: number, length: number, options?: ReadOptions): Promise<ReadHeadResult> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new RangeError(`Invalid byte range for ${redactPath(path)}: offset ${offset}, length ${length}`);
    }
    checkUrl(path);
    options?.signal?.throwIfAborted();
    if (length === 0) return { bytes: new Uint8Array(0), size: null, etag: null };

    let result = await this.requestOnce(path, offset, length, options);
    let { bytes } = result;
    while (result.partial && bytes.length < length) {
      const end = result.size !== null ? Math.min(offset + length, result.size) : offset + length;
      const next = offset + bytes.length;
      if (next >= end) break;
      // The rest must come from the same version of the file
      const expected = options?.ifMatch ?? result.etag ?? undefined;
      const more = await this.requestOnce(path, next, offset + length - next, { ...options, ifMatch: expected });
      if (more.bytes.length === 0) break;
      bytes = concatBytes(bytes, more.bytes);
      result = { ...more, size: result.size ?? more.size, etag: result.etag ?? more.etag };
    }
    return { bytes, size: result.size, etag: result.etag };
  }

  /**
   * Perform one ranged GET (with retries) and return the body together
   * with the resource size and version tag reported by the server.
   *
   * @param path - URL to read.
   * @param offset - Zero-based byte offset.
   * @param length - Number of bytes.
   * @param options - Optional version check and abort signal.
   * @returns Body bytes, total size (or `null`), version tag (or `null`),
   *   and whether the server may hold more of the requested range.
   */
  private async requestOnce(
    path: string,
    offset: number,
    length: number,
    options?: ReadOptions,
  ): Promise<ReadHeadResult & { partial: boolean }> {
    const end = offset + length - 1;
    const where = `${redactPath(path)} [${offset}-${end}]`;
    const expected = options?.ifMatch;
    const headers: Record<string, string> = { ...this.headers, Range: `bytes=${offset}-${end}` };
    if (this.conditional && expected !== undefined) {
      if (expected.startsWith(LAST_MODIFIED_TAG)) {
        headers['If-Unmodified-Since'] = expected.slice(LAST_MODIFIED_TAG.length);
      } else if (!expected.startsWith('W/')) {
        // Weak validators cannot be used with If-Match (strong comparison)
        headers['If-Match'] = expected;
      }
    }

    return this.withRetry(where, options?.signal, async (signal) => {
      const response = await fetch(path, { headers, signal });
      const { status } = response;
      const etag = versionTag(response.headers);

      if ((status === 206 || status === 200) && expected !== undefined && etag !== null && !sameVersion(etag, expected)) {
        await discard(response);
        throw new SourceChangedError(`${redactPath(path)} changed since it was opened`, { path, status });
      }

      if (status === 206) {
        const contentRange = response.headers.get('content-range');
        let size: number | null = null;
        let wanted = length;
        let partial = false;
        if (contentRange !== null) {
          const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim());
          if (!m || Number(m[1]) !== offset || Number(m[2]) < Number(m[1])) {
            await discard(response);
            throw new ConnectorError(`Unexpected Content-Range "${contentRange}" reading ${where}`, { path, status });
          }
          if (m[3] !== '*') size = Number(m[3]);
          wanted = Math.min(length, Number(m[2]) - offset + 1);
          partial = wanted < length;
        }
        const bytes = await readBody(response, wanted);
        if (contentRange !== null && bytes.length < wanted) {
          throw new ConnectorError(
            `Truncated response reading ${where}: ${bytes.length} of ${wanted} bytes`,
            { path, status, retryable: true },
          );
        }
        return { bytes, size, etag, partial };
      }

      if (status === 416) {
        await discard(response);
        const m = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '');
        return { bytes: new Uint8Array(0), size: m ? Number(m[1]) : null, etag, partial: false };
      }

      if (status === 412) {
        await discard(response);
        throw new SourceChangedError(`${redactPath(path)} changed since it was opened (HTTP 412)`, { path, status });
      }

      if (status === 200) {
        // The server ignored Range and is sending the whole resource:
        // acceptable only if that is what was asked for. Never read more
        // than that, whatever the (possibly absent) Content-Length says.
        const declared = Number(response.headers.get('content-length') ?? NaN);
        if (offset === 0 && !(declared > length)) {
          const bytes = await readBody(response, length + 1);
          if (bytes.length <= length) return { bytes, size: bytes.length, etag, partial: false };
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
      const retryAfterMs = retryable ? parseRetryAfter(response.headers.get('retry-after')) : undefined;
      throw new ConnectorError(`HTTP ${status} reading ${where}`, {
        path, status, retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    });
  }

  /**
   * Ask for the size of a resource whose ranged responses report `*`.
   *
   * @param path - URL.
   * @param etag - Version tag of the ranged response, or `null`.
   * @param signal - Optional abort signal.
   * @returns The `Content-Length` of a `HEAD` response for the same
   *   version, or `null` if unavailable.
   */
  private async contentLength(path: string, etag: string | null, signal?: AbortSignal): Promise<number | null> {
    try {
      return await this.withRetry(`${redactPath(path)} [HEAD]`, signal, async (attemptSignal) => {
        const response = await fetch(path, { method: 'HEAD', headers: this.headers, signal: attemptSignal });
        const tag = versionTag(response.headers);
        if (!response.ok || (etag !== null && tag !== null && !sameVersion(tag, etag))) return null;
        const length = Number(response.headers.get('content-length') ?? NaN);
        return Number.isSafeInteger(length) && length >= 0 ? length : null;
      });
    } catch {
      signal?.throwIfAborted();
      // The size is an optimisation; reads work without it
      return null;
    }
  }

  /**
   * Run one complete request attempt — fetch plus body read — in a
   * connector slot and under a per-attempt timeout, retrying transient
   * failures with exponential backoff and jitter. The slot is taken before
   * the timeout starts and freed during backoff.
   *
   * Retries are triggered by HTTP 5xx, 408 and 429, network errors,
   * truncated bodies, and timeouts. Errors marked non-retryable (client
   * errors, missing range support, changed source) and aborts requested by
   * the caller are thrown immediately. Network errors that exhaust the
   * attempts are raised as a retryable {@link ConnectorError}.
   *
   * @param where - Request description used in error messages.
   * @param callerSignal - Optional caller abort signal.
   * @param attempt - Performs the request with the given abort signal.
   * @returns The attempt's result.
   * @throws {ConnectorError} The last encountered error if all attempts fail.
   */
  private async withRetry<T>(
    where: string,
    callerSignal: AbortSignal | undefined,
    attempt: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown = null;

    for (let i = 0; i < this.retryAttempts; i++) {
      callerSignal?.throwIfAborted();
      const release = await this.limiter.acquire(callerSignal);
      const controller = new AbortController();
      const timer = this.timeout === null ? null : setTimeout(() => controller.abort(), this.timeout);
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
        if (timer !== null) clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onAbort);
        release();
      }
      if (i < this.retryAttempts - 1) {
        const requested = lastError instanceof ConnectorError ? lastError.retryAfterMs : undefined;
        if (requested !== undefined && requested > MAX_BACKOFF_MS) break;
        await sleep(Math.max(requested ?? 0, this.backoff(i)), callerSignal);
      }
    }

    if (lastError instanceof ConnectorError) throw lastError;
    throw new ConnectorError(
      `Failed to read ${where}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
      { retryable: true, cause: lastError ?? undefined },
    );
  }

  /**
   * Delay before retry `i + 1`: exponential, capped, with "equal jitter"
   * (between half and all of the exponential delay).
   */
  private backoff(i: number): number {
    const delay = Math.min(MAX_BACKOFF_MS, this.retryBackoff * 2 ** i);
    return delay / 2 + Math.random() * (delay / 2);
  }
}

/**
 * Check that `path` is a URL fetch can request (absolute, or relative to
 * the page in browsers), so malformed paths fail at once instead of being
 * retried like network errors.
 *
 * @param path - URL to check.
 * @throws {TypeError} If `path` is not a valid URL.
 */
function checkUrl(path: string): void {
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    new URL(path, base);
  } catch {
    throw new TypeError(`Invalid URL: ${redactPath(path)}`);
  }
}

/**
 * Version tag of a response: its `ETag`, or its `Last-Modified` date
 * (prefixed) when it has no ETag.
 *
 * @param headers - Response headers.
 * @returns The tag, or `null` if the response has neither.
 */
function versionTag(headers: Headers): string | null {
  const etag = headers.get('etag');
  if (etag !== null) return etag;
  const modified = headers.get('last-modified');
  return modified !== null ? LAST_MODIFIED_TAG + modified : null;
}

/**
 * Whether two version tags denote the same version. ETags are compared
 * weakly (ignoring `W/`), as CDNs may weaken an origin's strong ETag.
 */
function sameVersion(a: string, b: string): boolean {
  return (a.startsWith('W/') ? a.slice(2) : a) === (b.startsWith('W/') ? b.slice(2) : b);
}

/**
 * Parse a `Retry-After` header (seconds or an HTTP date).
 *
 * @param value - Header value, or `null`.
 * @returns The delay in milliseconds, or `undefined` if absent or invalid.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * Read at most `max` bytes of a response body, then release the rest.
 *
 * @param response - Response whose body to read.
 * @param max - Most bytes to keep.
 * @returns The body bytes (fewer if the body is shorter).
 */
async function readBody(response: Response, max: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer()).subarray(0, max);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
  } finally {
    if (total >= max) {
      try {
        await reader.cancel();
      } catch {
        // The body may already be closed
      }
    }
    reader.releaseLock();
  }
  if (parts.length === 1) return parts[0].length > max ? parts[0].subarray(0, max) : parts[0];
  const out = new Uint8Array(Math.min(total, max));
  let pos = 0;
  for (const part of parts) {
    const n = Math.min(part.length, out.length - pos);
    out.set(n === part.length ? part : part.subarray(0, n), pos);
    pos += n;
    if (pos === out.length) break;
  }
  return out;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
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
 * Sleep for the specified duration, unless aborted first.
 *
 * @param ms - Duration in milliseconds.
 * @param signal - Ends the sleep early, rejecting with its reason.
 * @returns Resolves after `ms` milliseconds.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

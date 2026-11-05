/**
 * @module cache
 *
 * Byte caches for FlatGeobuf headers and spatial index pages.
 *
 * Reading a tile needs the file header and the parts of the spatial index
 * the query touches. Both are immutable for a given file version, so
 * caching them turns repeat requests — including requests served by a
 * warm serverless container — into a single read of feature data.
 *
 * The cache stores plain bytes under string keys, so any store can back
 * it: the built-in {@link MemoryCache} (an LRU bounded by total bytes), a
 * directory on disk such as Lambda's `/tmp`, or an external key-value
 * store. Keys embed the file path and its version tag (ETag), so entries
 * of a replaced file are never mixed with the new one.
 */

/**
 * A key-value store for immutable byte blocks.
 *
 * Implementations may be synchronous or asynchronous and may drop entries
 * at any time (e.g. on eviction); a missing entry is simply re-read.
 * Values handed to {@link ByteCache.set} and returned by
 * {@link ByteCache.get} are treated as read-only by fgb-vt.
 */
export interface ByteCache {
  /** Return the bytes stored under `key`, or `undefined` if absent. */
  get(key: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  /** Store `value` under `key`. */
  set(key: string, value: Uint8Array): void | Promise<void>;
  /** Remove the entry under `key`, if any. */
  delete(key: string): void | Promise<void>;
}

/**
 * Options for {@link MemoryCache}.
 */
export interface MemoryCacheOptions {
  /**
   * Upper bound on the total size of cached values, in bytes. When
   * exceeded, least-recently-used entries are evicted.
   *
   * @defaultValue 67108864 (64 MiB)
   */
  maxBytes?: number;
}

/**
 * In-memory {@link ByteCache} with least-recently-used eviction, bounded by
 * the total size of its values.
 *
 * @example
 * ```typescript
 * import { TileClient, S3Connector, MemoryCache } from '@geozelot/fgb-vt';
 *
 * // Module scope: survives warm invocations of a serverless function
 * const cache = new MemoryCache({ maxBytes: 128 * 1024 * 1024 });
 * const client = new TileClient(new S3Connector({ region: 'us-east-1' }), { cache });
 * ```
 */
export class MemoryCache implements ByteCache {
  private readonly maxBytes: number;
  /** Insertion order is recency order: least recently used first. */
  private readonly entries = new Map<string, Uint8Array>();
  private totalBytes = 0;

  /**
   * Create an empty cache.
   *
   * @param options - Optional size limit. See {@link MemoryCacheOptions}.
   */
  constructor(options?: MemoryCacheOptions) {
    this.maxBytes = Math.max(0, options?.maxBytes ?? 64 * 1024 * 1024);
  }

  /** Number of cached entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Total size of cached values in bytes. */
  get bytes(): number {
    return this.totalBytes;
  }

  /**
   * Look up `key`, marking it most recently used.
   *
   * @param key - Cache key.
   * @returns The cached bytes, or `undefined`.
   */
  get(key: string): Uint8Array | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  /**
   * Store `value` under `key`, evicting least-recently-used entries as
   * needed. Values larger than the whole cache are not stored.
   *
   * @param key - Cache key.
   * @param value - Bytes to store (not copied; must not be mutated afterwards).
   */
  set(key: string, value: Uint8Array): void {
    this.delete(key);
    if (value.byteLength > this.maxBytes) return;
    this.entries.set(key, value);
    this.totalBytes += value.byteLength;
    for (const [k, v] of this.entries) {
      if (this.totalBytes <= this.maxBytes) break;
      this.entries.delete(k);
      this.totalBytes -= v.byteLength;
    }
  }

  /**
   * Remove `key` if present.
   *
   * @param key - Cache key.
   */
  delete(key: string): void {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.totalBytes -= value.byteLength;
    }
  }

  /** Remove all entries. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }
}

/** Guarded wrappers, one per cache. */
const guarded = new WeakMap<ByteCache, ByteCache>();

/**
 * Wrap a cache so its failures never fail a tile: a `get` that throws or
 * rejects is a miss, and failed `set`/`delete` calls are ignored (e.g. a
 * full `/tmp` or an unreachable key-value store). The built-in
 * {@link MemoryCache} cannot fail and is returned as is.
 *
 * @param cache - Cache to guard.
 * @returns The guarded cache (the same wrapper for the same cache).
 */
export function guardCache(cache: ByteCache): ByteCache {
  if (cache instanceof MemoryCache) return cache;
  let wrapper = guarded.get(cache);
  if (!wrapper) {
    wrapper = {
      async get(key) {
        try {
          return await cache.get(key);
        } catch {
          return undefined;
        }
      },
      async set(key, value) {
        try {
          await cache.set(key, value);
        } catch {
          // Caching is best effort
        }
      },
      async delete(key) {
        try {
          await cache.delete(key);
        } catch {
          // Caching is best effort
        }
      },
    };
    guarded.set(cache, wrapper);
  }
  return wrapper;
}

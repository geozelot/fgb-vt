/**
 * @module connectors/limiter
 *
 * Concurrency limit shared by all requests of one connector.
 *
 * A tile server issues reads for many tiles and sources at once through the
 * same connector. Limiting each `readRanges` call alone would multiply the
 * limit by the number of concurrent tiles; the limiter bounds the requests
 * in flight across all of them, queueing the rest in arrival order.
 */

/** A waiting acquisition. */
interface Waiter {
  grant: () => void;
  cancel: () => void;
}

/**
 * First-in, first-out semaphore for requests.
 */
export class RequestLimiter {
  /** Most requests in flight at once. */
  readonly max: number;
  private active = 0;
  private readonly queue: Waiter[] = [];

  /**
   * @param max - Most requests in flight at once (`Infinity` for no limit).
   * @throws {RangeError} If `max` is not a positive integer or `Infinity`.
   */
  constructor(max: number) {
    if (!(max === Infinity || (Number.isInteger(max) && max >= 1))) {
      throw new RangeError(`maxConcurrency must be a positive integer or Infinity, got ${max}`);
    }
    this.max = max;
  }

  /** Requests currently in flight. */
  get running(): number {
    return this.active;
  }

  /** Requests waiting for a slot. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Wait for a free slot.
   *
   * @param signal - Aborts the wait; the promise then rejects with the
   *   signal's reason and no slot is taken.
   * @returns A function that frees the slot (calling it again is a no-op).
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.active < this.max && this.queue.length === 0) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => waiter.cancel();
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.releaser());
        },
        cancel: () => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          reject(signal!.reason);
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Run `task` in a slot.
   *
   * @param task - The request.
   * @param signal - Aborts waiting for the slot.
   * @returns The task's result.
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  /** A one-shot release function for a slot just taken. */
  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) {
        next.grant(); // the slot passes on directly
      } else {
        this.active--;
      }
    };
  }
}

/**
 * Read several ranges concurrently, abandoning the rest as soon as one
 * fails, so that failed tiles do not keep connector slots busy.
 *
 * @param count - Number of ranges.
 * @param read - Reads range `i` with the given abort signal.
 * @param signal - Caller abort signal.
 * @returns The results in range order.
 */
export async function readAll<T>(
  count: number,
  read: (i: number, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T[]> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal!.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.all(Array.from({ length: count }, (_, i) =>
      read(i, controller.signal).catch((err) => {
        controller.abort(err);
        throw err;
      }),
    ));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

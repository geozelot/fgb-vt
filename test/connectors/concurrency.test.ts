/**
 * Connector-wide concurrency limits: the limiter itself, and HTTP and S3
 * connectors shared by concurrent reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { RequestLimiter, readAll } from '../../src/connectors/limiter.js';
import { HttpConnector } from '../../src/connectors/http.js';
import { S3Connector } from '../../src/connectors/s3.js';
import { fixture } from '../helpers/tiles.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('RequestLimiter', () => {
  it('runs at most max tasks at once, in arrival order', async () => {
    const limiter = new RequestLimiter(2);
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const tasks = [0, 1, 2, 3, 4].map(i => limiter.run(() => new Promise<void>(resolve => {
      started.push(i);
      finish[i] = resolve;
    })));
    await tick();
    expect(started).toEqual([0, 1]);
    expect([limiter.running, limiter.pending]).toEqual([2, 3]);
    finish[1]();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    finish[0]();
    finish[2]();
    await tick();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    finish[3]();
    finish[4]();
    await Promise.all(tasks);
    expect([limiter.running, limiter.pending]).toEqual([0, 0]);
  });

  it('frees the slot when a task fails', async () => {
    const limiter = new RequestLimiter(1);
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await limiter.run(async () => 7)).toBe(7);
    expect(limiter.running).toBe(0);
  });

  it('lets a waiter give up without taking a slot', async () => {
    const limiter = new RequestLimiter(1);
    const release = await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    expect(limiter.pending).toBe(1);
    controller.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    expect(limiter.pending).toBe(0);
    release();
    release(); // a second call is a no-op
    expect(limiter.running).toBe(0);
    await expect(limiter.acquire(AbortSignal.abort(new Error('early')))).rejects.toThrow('early');
  });

  it('validates its limit', () => {
    expect(() => new RequestLimiter(0)).toThrow(RangeError);
    expect(() => new RequestLimiter(1.5)).toThrow(RangeError);
    expect(new RequestLimiter(Infinity).max).toBe(Infinity);
  });

  it('readAll cancels the remaining reads when one fails', async () => {
    const aborted: number[] = [];
    const err = await readAll(3, (i, signal) => new Promise((resolve, reject) => {
      if (i === 1) return reject(new Error('read 1 failed'));
      signal.addEventListener('abort', () => {
        aborted.push(i);
        reject(signal.reason);
      });
    })).catch(e => e);
    expect(err.message).toBe('read 1 failed');
    expect(aborted.sort()).toEqual([0, 2]);
  });
});

// == HTTP =====================================================================

const BODY = readFileSync(fixture('points.fgb'));
let server: Server;
let base = '';
let inFlight = 0;
let peak = 0;
let delay = 50;
let failStart: number | null = null;

function handler(req: IncomingMessage, res: ServerResponse): void {
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '')!;
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), BODY.length - 1);
  if (failStart !== null && start === failStart) {
    res.writeHead(404);
    res.end();
    return;
  }
  inFlight++;
  peak = Math.max(peak, inFlight);
  const done = () => { inFlight--; };
  res.on('close', done);
  setTimeout(() => {
    if (res.destroyed) return;
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${BODY.length}`, 'content-length': end - start + 1 });
    res.end(BODY.subarray(start, end + 1));
  }, delay).unref();
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address && typeof address === 'object') base = `http://127.0.0.1:${address.port}/points.fgb`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>(resolve => server.close(() => resolve()));
});

const ranges = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ offset: from + i * 100, length: 100 }));

describe('HttpConnector concurrency', () => {
  it('limits requests across concurrent readRanges calls', async () => {
    peak = 0;
    delay = 30;
    const http = new HttpConnector({ maxConcurrency: 3 });
    const results = await Promise.all([0, 1, 2, 3].map(k => http.readRanges(base, ranges(5, k * 1000))));
    expect(results.flat()).toHaveLength(20);
    expect(results[2][1]).toEqual(new Uint8Array(BODY.subarray(2100, 2200)));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('does not count waiting for a slot towards the timeout', async () => {
    delay = 120;
    const http = new HttpConnector({ maxConcurrency: 1, timeout: 200, retry: { attempts: 1, backoff: 1 } });
    // The third read waits about 240 ms for its slot
    const out = await Promise.all([0, 1, 2].map(i => http.read(base, i * 100, 100)));
    expect(out.map(b => b.length)).toEqual([100, 100, 100]);
  });

  it('cancels the other ranges of a call when one fails', async () => {
    delay = 3000;
    failStart = 300;
    const http = new HttpConnector({ maxConcurrency: 4, retry: { attempts: 1, backoff: 1 } });
    const started = Date.now();
    await expect(http.readRanges(base, ranges(4))).rejects.toMatchObject({ status: 404 });
    expect(Date.now() - started).toBeLessThan(1000);
    // The slow siblings were aborted, so their slots are free again
    delay = 10;
    failStart = null;
    const again = await http.readRanges(base, ranges(4));
    expect(again).toHaveLength(4);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops retry backoff on abort', async () => {
    const http = new HttpConnector({ retry: { attempts: 3, backoff: 5000 } });
    const started = Date.now();
    // Connection refused is retried after a 5 s backoff, which the deadline cuts short
    const closed = 'http://127.0.0.1:1/points.fgb';
    const err = await http.read(closed, 0, 10, { signal: AbortSignal.timeout(200) }).catch(e => e);
    expect(err?.name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// == S3 =======================================================================

describe('S3Connector concurrency', () => {
  function fakeSdk() {
    let active = 0;
    const state = { peak: 0 };
    class GetObjectCommand {
      constructor(readonly input: { Range: string }) {}
    }
    class S3Client {
      async send(command: GetObjectCommand) {
        active++;
        state.peak = Math.max(state.peak, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(command.input.Range)!;
        return {
          ContentRange: `bytes ${a}-${b}/${BODY.length}`,
          Body: {
            transformToByteArray: async () => {
              await new Promise(resolve => setTimeout(resolve, 5));
              active--;
              return new Uint8Array(BODY.subarray(Number(a), Number(b) + 1));
            },
          },
        };
      }
      destroy() {}
    }
    return { sdk: { S3Client, GetObjectCommand }, state };
  }

  it('limits requests across concurrent readRanges calls, including body reads', async () => {
    const { sdk, state } = fakeSdk();
    const s3 = new S3Connector({ sdk, maxConcurrency: 4 });
    const out = await Promise.all([0, 1, 2].map(k => s3.readRanges('s3://b/k.fgb', ranges(6, k * 1000))));
    expect(out.flat()).toHaveLength(18);
    expect(state.peak).toBeLessThanOrEqual(4);
    expect(state.peak).toBeGreaterThan(1);
    await s3.close();
  });
});

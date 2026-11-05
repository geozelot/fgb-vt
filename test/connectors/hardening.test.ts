/**
 * Regression tests for connector defects found in the 1.0.5 review:
 * timeouts, unbounded and short bodies, version checks, retries, error
 * typing, and cache scoping.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpConnector } from '../../src/connectors/http.js';
import { LocalConnector } from '../../src/connectors/local.js';
import { S3Connector, type S3SdkModule } from '../../src/connectors/s3.js';
import { MemoryCache, type ByteCache } from '../../src/cache.js';
import { tile } from '../../src/tile.js';
import type { Connector } from '../../src/connectors/connector.js';
import { ConnectorError, RangeNotSupportedError, SourceChangedError } from '../../src/errors.js';
import { fixture } from '../helpers/tiles.js';

const BODY = readFileSync(fixture('points.fgb'));

interface Behaviour {
  /** Status/headers/body override for a request; `undefined` serves the range normally. */
  respond?: (req: IncomingMessage, res: ServerResponse, n: number) => boolean;
  etag?: string | null;
  lastModified?: string | null;
  /** Largest range the server returns. */
  cap?: number;
  /** Report `*` as the total size. */
  unknownSize?: boolean;
}

let behaviour: Behaviour = {};
let requests: IncomingMessage[] = [];
let server: Server;
let origin = '';

function handler(req: IncomingMessage, res: ServerResponse): void {
  requests.push(req);
  if (behaviour.respond?.(req, res, requests.length)) return;
  const headers: Record<string, string | number> = {};
  if (behaviour.etag !== null) headers.etag = behaviour.etag ?? '"v1"';
  if (behaviour.lastModified) headers['last-modified'] = behaviour.lastModified;
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'content-length': BODY.length });
    res.end();
    return;
  }
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
  if (!m) {
    res.writeHead(200, { ...headers, 'content-length': BODY.length });
    res.end(BODY);
    return;
  }
  const start = Number(m[1]);
  if (start >= BODY.length) {
    res.writeHead(416, { 'content-range': `bytes */${BODY.length}` });
    res.end();
    return;
  }
  let end = Math.min(Number(m[2]), BODY.length - 1);
  if (behaviour.cap !== undefined) end = Math.min(end, start + behaviour.cap - 1);
  res.writeHead(206, {
    ...headers,
    'content-range': `bytes ${start}-${end}/${behaviour.unknownSize ? '*' : BODY.length}`,
    'content-length': end - start + 1,
  });
  res.end(BODY.subarray(start, end + 1));
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address && typeof address === 'object') origin = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(() => {
  behaviour = {};
  requests = [];
});

const url = () => `${origin}/points.fgb`;
const fast = (extra: object = {}) => new HttpConnector({ retry: { attempts: 3, backoff: 1 }, ...extra });

describe('HttpConnector options', () => {
  it('treats timeout 0, Infinity and values beyond the timer range as no timeout', async () => {
    for (const timeout of [0, Infinity, 2 ** 31]) {
      const bytes = await new HttpConnector({ timeout }).read(url(), 0, 100);
      expect(bytes.length).toBe(100);
    }
  });

  it('rejects invalid timeouts and retry settings', () => {
    expect(() => new HttpConnector({ timeout: -1 })).toThrow(RangeError);
    expect(() => new HttpConnector({ timeout: NaN })).toThrow(RangeError);
    expect(() => new HttpConnector({ retry: { attempts: 0, backoff: 1 } })).toThrow(RangeError);
    expect(() => new HttpConnector({ retry: { attempts: 2, backoff: Infinity } })).toThrow(RangeError);
  });

  it('fails at once for malformed URLs instead of retrying', async () => {
    const started = Date.now();
    await expect(new HttpConnector().read('not a url', 0, 10)).rejects.toThrow(TypeError);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('works where reading globalThis.location throws (Deno without --location)', async () => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      get() { throw new ReferenceError('Access to "location", run again with --location <href>'); },
    });
    try {
      expect((await fast().read(url(), 0, 10)).length).toBe(10);
    } finally {
      delete (globalThis as { location?: unknown }).location;
    }
  });

  it('scopes cache entries by request headers, without their values', () => {
    expect(new HttpConnector().cacheNamespace).toBe('http');
    const a = new HttpConnector({ headers: { Authorization: 'Bearer a' } }).cacheNamespace;
    expect(a).toMatch(/^http:[0-9a-z]+$/);
    expect(new HttpConnector({ headers: { authorization: 'Bearer a' } }).cacheNamespace).toBe(a);
    expect(new HttpConnector({ headers: { Authorization: 'Bearer b' } }).cacheNamespace).not.toBe(a);
    expect(new HttpConnector({ headers: { Authorization: 'Bearer b' }, cacheNamespace: 'cdn' }).cacheNamespace).toBe('cdn');
  });
});

describe('HttpConnector responses', () => {
  it('does not download a whole resource sent without Content-Length', async () => {
    let written = 0;
    let closed = false;
    behaviour.respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' }); // chunked
      const chunk = Buffer.alloc(1 << 20);
      const pump = () => {
        while (!closed && written < 64 << 20) {
          written += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      res.on('close', () => { closed = true; });
      pump();
      return true;
    };
    await expect(fast().read(url(), 0, 1000)).rejects.toThrow(RangeNotSupportedError);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(written).toBeLessThan(32 << 20);
  });

  it('asks for the rest when the server returns less than requested', async () => {
    behaviour.cap = 1000;
    const bytes = await fast().read(url(), 100, 5000);
    expect(Buffer.from(bytes).equals(BODY.subarray(100, 5100))).toBe(true);
    expect(requests.length).toBe(5);
  });

  it('retries a body shorter than its Content-Range', async () => {
    behaviour.respond = (_req, res, n) => {
      if (n > 1) return false;
      res.writeHead(206, { 'content-range': `bytes 0-4999/${BODY.length}`, 'content-length': 1000 });
      res.end(BODY.subarray(0, 1000));
      return true;
    };
    const bytes = await fast().read(url(), 0, 5000);
    expect(bytes.length).toBe(5000);
    expect(requests.length).toBe(2);
  });

  it('detects a changed resource from the response ETag without sending If-Match', async () => {
    const connector = fast();
    const head = await connector.readHead(url(), 100);
    expect(head.etag).toBe('"v1"');
    behaviour.etag = '"v2"';
    await expect(connector.read(url(), 0, 10, { ifMatch: head.etag! })).rejects.toThrow(SourceChangedError);
    expect(requests.every(r => r.headers['if-match'] === undefined)).toBe(true);
    // CDNs may weaken the ETag
    behaviour.etag = 'W/"v1"';
    expect((await connector.read(url(), 0, 10, { ifMatch: '"v1"' })).length).toBe(10);
  });

  it('does not take a response without ETag for a change of a file with one', async () => {
    const connector = fast();
    const head = await connector.readHead(url(), 100);
    behaviour.etag = null;
    behaviour.lastModified = 'Wed, 04 Nov 2026 10:00:00 GMT';
    expect((await connector.read(url(), 0, 10, { ifMatch: head.etag! })).length).toBe(10);
  });

  it('sends If-Match only with conditionalRequests', async () => {
    await fast({ conditionalRequests: true }).read(url(), 0, 10, { ifMatch: '"v1"' });
    expect(requests[0].headers['if-match']).toBe('"v1"');
  });

  it('falls back to Last-Modified as the version tag', async () => {
    behaviour.etag = null;
    behaviour.lastModified = 'Wed, 04 Nov 2026 10:00:00 GMT';
    const connector = fast();
    const head = await connector.readHead(url(), 100);
    expect(head.etag).toBe('last-modified:Wed, 04 Nov 2026 10:00:00 GMT');
    behaviour.lastModified = 'Thu, 05 Nov 2026 10:00:00 GMT';
    await expect(connector.read(url(), 0, 10, { ifMatch: head.etag! })).rejects.toThrow(SourceChangedError);
  });

  it('learns the size with HEAD when ranged responses report *', async () => {
    behaviour.unknownSize = true;
    const head = await fast().readHead(url(), 100);
    expect(head.size).toBe(BODY.length);
    expect(requests.map(r => r.method)).toEqual(['GET', 'HEAD']);
  });

  it('honours Retry-After, and gives up when it asks for too long', async () => {
    behaviour.respond = (_req, res, n) => {
      if (n > 1) return false;
      res.writeHead(503, { 'retry-after': '1' });
      res.end();
      return true;
    };
    const started = Date.now();
    await fast().read(url(), 0, 10);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);

    requests = [];
    behaviour.respond = (_req, res) => {
      res.writeHead(429, { 'retry-after': '120' });
      res.end();
      return true;
    };
    const err = await fast().read(url(), 0, 10).catch(e => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.retryAfterMs).toBe(120_000);
    expect(requests.length).toBe(1);
  });

  it('raises network failures as ConnectorError', async () => {
    const err = await fast().read('http://127.0.0.1:1/x.fgb', 0, 10).catch(e => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.retryable).toBe(true);
  });

  it('keeps credentials in URLs out of error messages', async () => {
    behaviour.respond = (_req, res) => {
      res.writeHead(403);
      res.end();
      return true;
    };
    const err = await fast().read(`${origin}/points.fgb?X-Amz-Signature=secret&token=abc`, 0, 10).catch(e => e);
    expect(err.message).not.toMatch(/secret|abc/);
    expect(err.message).toContain('points.fgb?…');
  });
});

// == S3 ==================================================================

function mockSdk(respond: (input: Record<string, any>) => any): S3SdkModule & { inputs: Record<string, any>[] } {
  const inputs: Record<string, any>[] = [];
  class GetObjectCommand { constructor(readonly input: Record<string, any>) { inputs.push(input); } }
  class S3Client {
    async send(command: GetObjectCommand, options?: { abortSignal?: AbortSignal }) {
      return respond({ ...command.input, abortSignal: options?.abortSignal });
    }
  }
  return { S3Client, GetObjectCommand, inputs } as unknown as S3SdkModule & { inputs: Record<string, any>[] };
}

const rangeOf = (input: Record<string, any>) => /bytes=(\d+)-(\d+)/.exec(input.Range)!.slice(1).map(Number);

describe('S3Connector', () => {
  it('rejects a store that ignores Range', async () => {
    const sdk = mockSdk(() => ({ ContentLength: BODY.length, Body: { transformToByteArray: async () => BODY } }));
    await expect(new S3Connector({ sdk }).read('s3://b/k.fgb', 100, 10)).rejects.toThrow(RangeNotSupportedError);
  });

  it('reports truncated bodies and wrong ranges', async () => {
    const short = mockSdk(() => ({ ContentRange: `bytes 0-99/${BODY.length}`, Body: { transformToByteArray: async () => BODY.subarray(0, 10) } }));
    await expect(new S3Connector({ sdk: short }).read('s3://b/k.fgb', 0, 100)).rejects.toThrow(/Truncated/);
    const shifted = mockSdk(() => ({ ContentRange: `bytes 0-9/${BODY.length}`, Body: { transformToByteArray: async () => BODY.subarray(0, 10) } }));
    await expect(new S3Connector({ sdk: shifted }).read('s3://b/k.fgb', 50, 10)).rejects.toThrow(/Unexpected ContentRange/);
  });

  it('wraps SDK errors with status and retryability', async () => {
    const denied = mockSdk(() => {
      throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    });
    const err = await new S3Connector({ sdk: denied }).read('s3://b/k.fgb', 0, 10).catch(e => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ status: 403, retryable: false, path: 's3://b/k.fgb' });
    expect(err.message).toMatch(/AccessDenied/);

    const throttled = mockSdk(() => {
      throw Object.assign(new Error('Slow Down'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } });
    });
    expect(await new S3Connector({ sdk: throttled }).read('s3://b/k.fgb', 0, 10).catch(e => e.retryable)).toBe(true);

    // Without an HTTP response: only network failures are worth a retry
    const unconfigured = mockSdk(() => { throw new Error('Region is missing'); });
    expect(await new S3Connector({ sdk: unconfigured }).read('s3://b/k.fgb', 0, 10).catch(e => e.retryable)).toBe(false);
    const reset = mockSdk(() => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); });
    expect(await new S3Connector({ sdk: reset }).read('s3://b/k.fgb', 0, 10).catch(e => e.retryable)).toBe(true);
  });

  it('reports an abort while reading a web stream body as the abort, not as truncation', async () => {
    const sdk = mockSdk(() => {
      let finish!: (bytes: Uint8Array) => void;
      const body = new Promise<Uint8Array>((resolve) => { finish = resolve; });
      return {
        ContentRange: `bytes 0-9/${BODY.length}`,
        // A cancelled web stream ends early instead of failing
        Body: { transformToByteArray: () => body, cancel: async () => finish(BODY.subarray(0, 3)) },
      };
    });
    await expect(new S3Connector({ sdk, timeout: 20 }).read('s3://b/k.fgb', 0, 10)).rejects.toThrow(/Timed out/);
    const controller = new AbortController();
    const reason = new Error('client went away');
    setTimeout(() => controller.abort(reason), 20);
    await expect(new S3Connector({ sdk }).read('s3://b/k.fgb', 0, 10, { signal: controller.signal })).rejects.toBe(reason);
  });

  it('times out a stalled body and frees its slot', async () => {
    const sdk = mockSdk((input) => ({
      ContentRange: `bytes 0-9/${BODY.length}`,
      Body: {
        transformToByteArray: () => new Promise((_resolve, reject) => {
          input.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      },
    }));
    const connector = new S3Connector({ sdk, timeout: 50, maxConcurrency: 1 });
    const err = await connector.read('s3://b/k.fgb', 0, 10).catch(e => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.message).toMatch(/Timed out/);
    // The slot is free again: the next read times out too, rather than waiting forever
    await expect(connector.read('s3://b/k.fgb', 0, 10)).rejects.toThrow(/Timed out/);
  });

  it('passes request options, the object version and the size of an empty range', async () => {
    const sdk = mockSdk((input) => {
      const [start, end] = rangeOf(input);
      if (start >= BODY.length) {
        throw Object.assign(new Error('not satisfiable'), { name: 'InvalidRange', ActualObjectSize: String(BODY.length) });
      }
      return { ContentRange: `bytes ${start}-${end}/${BODY.length}`, Body: { transformToByteArray: async () => BODY.subarray(start, end + 1) } };
    });
    const connector = new S3Connector({
      sdk,
      requestPayer: 'requester',
      expectedBucketOwner: '123456789012',
      getObjectParams: { SSECustomerAlgorithm: 'AES256' },
    });
    await connector.read('s3://bucket/dir/file.fgb?versionId=abc%2B1', 0, 10);
    expect(sdk.inputs[0]).toMatchObject({
      Bucket: 'bucket', Key: 'dir/file.fgb', VersionId: 'abc+1',
      RequestPayer: 'requester', ExpectedBucketOwner: '123456789012', SSECustomerAlgorithm: 'AES256',
    });
    const head = await connector.readHead('s3://bucket/file.fgb', 10);
    expect(head.size).toBe(BODY.length);
    expect((await connector.readHead('s3://bucket/file.fgb', 10).then(() => connector.read('s3://bucket/file.fgb', BODY.length + 5, 10))).length).toBe(0);
  });

  it('scopes cache entries by endpoint', () => {
    expect(new S3Connector().cacheNamespace).toBe('s3:aws');
    expect(new S3Connector({ endpoint: 'http://minio:9000' }).cacheNamespace).toBe('s3:http://minio:9000');
    expect(new S3Connector({ client: { send: async () => ({}) } }).cacheNamespace).toBeUndefined();
  });
});

// == Local ================================================================

describe('LocalConnector', () => {
  it('raises missing files as ConnectorError 404', async () => {
    const err = await new LocalConnector().read('/nonexistent/file.fgb', 0, 10).catch(e => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ status: 404, retryable: false, path: '/nonexistent/file.fgb' });
  });

  it('detects a file replaced at its path while its old handle stays pooled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fgbvt-'));
    try {
      const path = join(dir, 'f.fgb');
      copyFileSync(fixture('points.fgb'), path);
      const connector = new LocalConnector();
      const head = await connector.readHead(path, 10); // pools a handle on the original file
      copyFileSync(fixture('lines.fgb'), join(dir, 'next.fgb'));
      renameSync(join(dir, 'next.fgb'), path);
      await expect(connector.read(path, 0, 10, { ifMatch: head.etag! })).rejects.toThrow(SourceChangedError);
      const fresh = await connector.readHead(path, 10);
      expect(fresh.etag).not.toBe(head.etag);
      expect((await connector.read(path, 0, 10, { ifMatch: fresh.etag! })).length).toBe(10);
      await connector.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks the version of the file its pooled handle reads, not only the path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fgbvt-'));
    try {
      const path = join(dir, 'f.fgb');
      copyFileSync(fixture('points.fgb'), path);
      const reader = new LocalConnector();
      const opener = new LocalConnector();
      await reader.read(path, 0, 10); // pools a handle on the original file
      copyFileSync(fixture('lines.fgb'), join(dir, 'next.fgb'));
      renameSync(join(dir, 'next.fgb'), path);
      const fresh = await opener.readHead(path, 10); // version tag of the new file
      await expect(reader.read(path, 0, 10, { ifMatch: fresh.etag! })).rejects.toThrow(SourceChangedError);
      // After the eviction, reads go to the new file
      expect((await reader.read(path, 0, 10, { ifMatch: fresh.etag! })).length).toBe(10);
      await reader.close();
      await opener.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// == Cache ================================================================

describe('caching', () => {
  it('serves tiles when an external cache fails', async () => {
    const broken: ByteCache = {
      get: async () => { throw new Error('ECONNREFUSED'); },
      set: async () => { throw new Error('ENOSPC'); },
      delete: () => { throw new Error('nope'); },
    };
    const bytes = await tile(new LocalConnector(), 0, 0, 0, [{ name: 'p', path: fixture('points.fgb') }], { cache: broken });
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('never shares cached headers between connectors that may resolve a path differently', async () => {
    const files: Record<string, Buffer> = { a: readFileSync(fixture('points.fgb')), b: readFileSync(fixture('lines.fgb')) };
    const make = (name: string): Connector => ({
      read: async (_p, offset, length) => new Uint8Array(files[name].subarray(offset, offset + length)),
      readRanges: async (_p, ranges) => ranges.map(r => new Uint8Array(files[name].subarray(r.offset, r.offset + r.length))),
      close: async () => {},
    });
    const cache = new MemoryCache();
    const a = await tile(make('a'), 0, 0, 0, [{ name: 'l', path: 'same.fgb' }], { cache });
    const b = await tile(make('b'), 0, 0, 0, [{ name: 'l', path: 'same.fgb' }], { cache });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(Buffer.from(b).equals(Buffer.from(await tile(make('b'), 0, 0, 0, [{ name: 'l', path: 'same.fgb' }], { cache: false })))).toBe(true);
  });
});

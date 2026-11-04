import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { HttpConnector } from '../../src/connectors/http.js';
import { LocalConnector } from '../../src/connectors/local.js';
import { tile } from '../../src/tile.js';
import { fixture } from '../helpers/tiles.js';

const BODY = readFileSync(fixture('points.fgb'));

type Mode = 'range' | 'ignore-range' | 'wrong-range' | 'flaky' | 'not-found' | 'slow-body';
let mode: Mode = 'range';
let requests = 0;
let server: Server;
let base = '';

function handler(req: IncomingMessage, res: ServerResponse): void {
  requests++;
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
  if (mode === 'not-found') { res.writeHead(404); res.end(); return; }
  if (mode === 'flaky' && requests === 1) { res.writeHead(503); res.end('busy'); return; }
  if (mode === 'ignore-range' || !m) {
    res.writeHead(200, { 'content-length': BODY.length });
    res.end(BODY);
    return;
  }
  const start = Number(m[1]);
  if (start >= BODY.length) {
    res.writeHead(416, { 'content-range': `bytes */${BODY.length}` });
    res.end();
    return;
  }
  const end = Math.min(Number(m[2]), BODY.length - 1);
  const reported = mode === 'wrong-range' ? 0 : start;
  res.writeHead(206, {
    'content-range': `bytes ${reported}-${end}/${BODY.length}`,
    'content-length': end - start + 1,
  });
  if (mode === 'slow-body') {
    res.write(BODY.subarray(start, start + 1));
    setTimeout(() => res.end(BODY.subarray(start + 1, end + 1)), 500);
    return;
  }
  res.end(BODY.subarray(start, end + 1));
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address && typeof address === 'object') base = `http://127.0.0.1:${address.port}/points.fgb`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

function connector(timeout = 5000) {
  return new HttpConnector({ timeout, retry: { attempts: 3, backoff: 1 } });
}

describe('HttpConnector range semantics', () => {
  it('reads exact ranges from a compliant server', async () => {
    mode = 'range';
    const bytes = await connector().read(base, 100, 50);
    expect(Buffer.from(bytes).equals(BODY.subarray(100, 150))).toBe(true);
  });

  it('returns an empty result for ranges beyond the end (416)', async () => {
    mode = 'range';
    expect(await connector().read(base, BODY.length + 10, 10)).toHaveLength(0);
  });

  it('fails clearly when the server ignores Range', async () => {
    mode = 'ignore-range';
    requests = 0;
    await expect(connector().read(base, 100, 50)).rejects.toThrow('does not support byte-range requests');
    expect(requests).toBe(1); // not retried
  });

  it('accepts a full 200 response for a read from 0 that covers the whole file', async () => {
    mode = 'ignore-range';
    const bytes = await connector().read(base, 0, BODY.length + 1000);
    expect(bytes.length).toBe(BODY.length);
  });

  it('rejects a 206 whose Content-Range does not start at the requested offset', async () => {
    mode = 'wrong-range';
    await expect(connector().read(base, 100, 50)).rejects.toThrow('Unexpected Content-Range');
  });

  it('retries transient server errors', async () => {
    mode = 'flaky';
    requests = 0;
    const bytes = await connector().read(base, 0, 16);
    expect(bytes).toHaveLength(16);
    expect(requests).toBe(2);
  });

  it('does not retry client errors', async () => {
    mode = 'not-found';
    requests = 0;
    await expect(connector().read(base, 0, 16)).rejects.toThrow('HTTP 404');
    expect(requests).toBe(1);
  });

  it('applies the timeout to the response body, not just the headers', async () => {
    mode = 'slow-body';
    const c = new HttpConnector({ timeout: 100, retry: { attempts: 1, backoff: 0 } });
    await expect(c.read(base, 0, 64)).rejects.toThrow('Timed out after 100 ms');
  });

  it('produces the same tile as the local connector', async () => {
    mode = 'range';
    const local = new LocalConnector();
    const viaHttp = await tile(connector(), 2, 0, 1, { name: 'l', path: base });
    const viaFile = await tile(local, 2, 0, 1, { name: 'l', path: fixture('points.fgb') });
    await local.close();
    expect(Buffer.from(viaHttp).equals(Buffer.from(viaFile))).toBe(true);
  });
});

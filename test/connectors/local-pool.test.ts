import { describe, it, expect, vi, beforeEach } from 'vitest';
import { open, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalConnector } from '../../src/connectors/local.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

async function makeFiles(count: number): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'fgb-vt-pool-'));
  const paths: string[] = [];
  for (let i = 0; i < count; i++) {
    const p = join(dir, `f${i}.bin`);
    await writeFile(p, new Uint8Array(64).fill(i));
    paths.push(p);
  }
  return paths;
}

describe('LocalConnector handle pool', () => {
  beforeEach(() => {
    vi.mocked(open).mockClear();
  });

  it('opens a file once for concurrent cold reads', async () => {
    const [path] = await makeFiles(1);
    const c = new LocalConnector();
    const results = await Promise.all(Array.from({ length: 20 }, () => c.read(path, 0, 4)));
    expect(results.every(r => r[0] === 0 && r.length === 4)).toBe(true);
    expect(vi.mocked(open)).toHaveBeenCalledTimes(1);
    await c.close();
  });

  it('never closes a handle that a read is still using', async () => {
    const paths = await makeFiles(4);
    const c = new LocalConnector({ maxOpenFiles: 1 });
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) => c.read(paths[i % 4], 0, 8)),
    );
    const failed = results.filter(r => r.status === 'rejected');
    expect(failed).toEqual([]);
    for (let i = 0; i < 200; i++) {
      const r = results[i] as PromiseFulfilledResult<Uint8Array>;
      expect(r.value[0]).toBe(i % 4);
    }
    await c.close();
  });

  it('lets in-flight reads finish across close() and reopens afterwards', async () => {
    const [path] = await makeFiles(1);
    const c = new LocalConnector();
    const pending = c.read(path, 0, 8);
    await c.close();
    expect((await pending)[0]).toBe(0);
    expect((await c.read(path, 0, 8)).length).toBe(8);
    await c.close();
  });

  it('does not cache a failed open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fgb-vt-pool-'));
    const path = join(dir, 'late.bin');
    const c = new LocalConnector();
    await expect(c.read(path, 0, 4)).rejects.toThrow(/ENOENT/);
    await writeFile(path, new Uint8Array([9, 9, 9, 9]));
    expect([...(await c.read(path, 0, 4))]).toEqual([9, 9, 9, 9]);
    await c.close();
  });

  it('rejects invalid ranges', async () => {
    const [path] = await makeFiles(1);
    const c = new LocalConnector();
    await expect(c.read(path, -1, 4)).rejects.toThrow(RangeError);
    await expect(c.read(path, 0, 1.5)).rejects.toThrow(RangeError);
    expect(await c.read(path, 0, 0)).toHaveLength(0);
    await c.close();
  });
});

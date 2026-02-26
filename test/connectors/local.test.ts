import { describe, it, expect, afterEach } from 'vitest';
import { LocalConnector } from '../../src/connectors/local.js';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = join(tmpdir(), 'fgb-vt-test-' + Date.now());
const testFile = join(testDir, 'test.bin');

describe('LocalConnector', () => {
  let connector: LocalConnector;

  afterEach(async () => {
    if (connector) await connector.close();
    try { await unlink(testFile); } catch { /* ignore */ }
  });

  it('should read bytes from a file', async () => {
    await mkdir(testDir, { recursive: true });
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await writeFile(testFile, data);

    connector = new LocalConnector();
    const result = await connector.read(testFile, 3, 4);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(4);
    expect([...result]).toEqual([3, 4, 5, 6]);
  });

  it('should read multiple ranges', async () => {
    await mkdir(testDir, { recursive: true });
    const data = new Uint8Array(100);
    for (let i = 0; i < 100; i++) data[i] = i;
    await writeFile(testFile, data);

    connector = new LocalConnector();
    const ranges = [
      { offset: 0, length: 5 },
      { offset: 50, length: 10 },
      { offset: 90, length: 10 },
    ];
    const results = await connector.readRanges(testFile, ranges);

    expect(results.length).toBe(3);
    expect([...results[0]]).toEqual([0, 1, 2, 3, 4]);
    expect([...results[1]]).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
    expect(results[2].length).toBe(10);
  });

  it('should respect maxOpenFiles limit', async () => {
    await mkdir(testDir, { recursive: true });

    // Create multiple small files
    const files: string[] = [];
    for (let i = 0; i < 5; i++) {
      const f = join(testDir, `test-${i}.bin`);
      await writeFile(f, new Uint8Array([i]));
      files.push(f);
    }

    connector = new LocalConnector({ maxOpenFiles: 2 });

    // Read from all files
    for (const f of files) {
      const result = await connector.read(f, 0, 1);
      expect(result.length).toBe(1);
    }

    // Cleanup
    for (const f of files) {
      try { await unlink(f); } catch { /* ignore */ }
    }
  });

  it('should close all handles', async () => {
    await mkdir(testDir, { recursive: true });
    await writeFile(testFile, new Uint8Array([42]));

    connector = new LocalConnector();
    await connector.read(testFile, 0, 1);
    await connector.close();

    // After close, reading should work (reopens handle)
    const result = await connector.read(testFile, 0, 1);
    expect(result[0]).toBe(42);
  });
});

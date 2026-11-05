/**
 * `checkFile` and the `fgb-vt check` command.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkFile } from '../src/check.js';
import { LocalConnector } from '../src/connectors/local.js';
import type { Connector } from '../src/connectors/connector.js';
import { RangeNotSupportedError } from '../src/errors.js';
import { parseHeader } from '../src/fgb/header.js';
import { fixture } from './helpers/tiles.js';

const connector = new LocalConnector();
afterAll(() => connector.close());

/** Every fixture written by a correct writer. */
const VALID = readdirSync(fileURLToPath(new URL('./fixtures/', import.meta.url)))
  .filter(name => name.endsWith('.fgb') && !name.startsWith('gogama-indexdata'));

/** In-memory connector over (possibly modified) file bytes. */
function memory(bytes: Uint8Array): Connector {
  return {
    readHead: async (_p, length) => ({ bytes: bytes.slice(0, length), size: bytes.length, etag: null }),
    read: async (_p, offset, length) => bytes.slice(offset, offset + length),
    readRanges: async (_p, ranges) => ranges.map(r => bytes.slice(r.offset, r.offset + r.length)),
    close: async () => {},
  };
}

describe('checkFile', () => {
  it.each(VALID)('accepts %s', async (name) => {
    const report = await checkFile(connector, fixture(name));
    expect(report.problems.filter(p => p.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.features?.complete).toBe(true);
    if (report.header!.featuresCount > 0) expect(report.features!.checked).toBe(report.header!.featuresCount);
  });

  it('finds index offsets that miss the size prefixes, and features out of index order', async () => {
    const report = await checkFile(connector, fixture('gogama-indexdata-points.fgb'));
    expect(report.ok).toBe(false);
    const messages = report.problems.map(p => p.message).join('\n');
    expect(messages).toMatch(/first feature in index order is at byte \d+/);
    expect(messages).toMatch(/Feature 0 is at byte 0 of the data, but its index entry says/);
    expect(messages).toMatch(/lies outside its index entry's box/);
  });

  it('finds empty index boxes', async () => {
    const report = await checkFile(connector, fixture('gogama-indexdata-polygons.fgb'));
    expect(report.ok).toBe(false);
    expect(report.problems.map(p => p.message).join('\n')).toMatch(/root box .* is empty[\s\S]*has an empty box/);
  });

  it('reports a truncated file', async () => {
    const bytes = new Uint8Array(readFileSync(fixture('points.fgb')));
    const report = await checkFile(memory(bytes.subarray(0, bytes.length - 50)), 'p.fgb');
    expect(report.ok).toBe(false);
    expect(report.problems.map(p => p.message).join('\n')).toMatch(/ends inside feature 199|index lists 200 features/);
  });

  it('reports a corrupt feature with its offset', async () => {
    const bytes = new Uint8Array(readFileSync(fixture('lines.fgb')));
    const header = parseHeader(bytes);
    const view = new DataView(bytes.buffer);
    // Corrupt the root table offset of the first feature
    view.setUint32(header.featuresOffset + 4, 0xfffffff0, true);
    const report = await checkFile(memory(bytes), 'l.fgb');
    expect(report.ok).toBe(false);
    expect(report.problems[0]).toMatchObject({ severity: 'error', offset: header.featuresOffset });
  });

  it('checks only header and index with quick, and part of the features with maxBytes', async () => {
    const quick = await checkFile(connector, fixture('grid-5k.fgb'), { quick: true });
    expect(quick.ok).toBe(true);
    expect(quick.features).toBeNull();
    expect(quick.index).toMatchObject({ nodeSize: 16, levels: 5 }); // 5000 → 313 → 20 → 2 → 1

    const partial = await checkFile(connector, fixture('grid-5k.fgb'), { maxBytes: 10_000 });
    expect(partial.ok).toBe(true);
    expect(partial.features?.complete).toBe(false);
    expect(partial.problems.map(p => p.message)).toContain('Only the first 125 features were checked (maxBytes)');
  });

  it('warns about a CRS that needs a projection and about a missing index', async () => {
    expect((await checkFile(connector, fixture('points-4087.fgb'))).header?.crsSupport).toBe('needs-projection');
    const report = await checkFile(connector, fixture('no-index.fgb'));
    expect(report.index).toBeNull();
    expect(report.problems.some(p => /no spatial index/.test(p.message))).toBe(true);
  });
});

describe('read failures', () => {
  it('are thrown, not reported as problems of the file', async () => {
    const bytes = readFileSync(fixture('points.fgb'));
    const noRanges: Connector = {
      read: async (_path, offset, length) => {
        if (offset > 0) throw new RangeNotSupportedError('Server does not support byte-range requests');
        return new Uint8Array(bytes.subarray(0, length));
      },
      readRanges: async () => { throw new Error('unused'); },
      close: async () => {},
    };
    await expect(checkFile(noRanges, 'points.fgb')).rejects.toThrow(RangeNotSupportedError);
  });
});

describe('fgb-vt check', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const loader = pathToFileURL(fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url))).href;
  const run = (...args: string[]) => new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(process.execPath, ['--import', loader, cli, ...args], (err, stdout) => {
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stdout });
    });
  });

  it('exits 0 for valid files, 1 for files with errors, 2 for usage errors', async () => {
    const ok = await run('check', fixture('points.fgb'));
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/points\.fgb {2}OK/);
    expect((await run('check', '--quick', fixture('gogama-indexdata-points.fgb'))).code).toBe(1);
    expect((await run('nonsense')).code).toBe(2);
  }, 30_000);

  it('prints JSON reports', async () => {
    const { stdout } = await run('check', '--json', fixture('single.fgb'));
    expect(JSON.parse(stdout)[0]).toMatchObject({ ok: true, header: { geometryType: 'Polygon', featuresCount: 1 } });
  }, 30_000);

  it('lists files that cannot be read in the JSON output', async () => {
    const { code, stdout } = await run('check', '--json', fixture('single.fgb'), '/nonexistent/x.fgb');
    expect(code).toBe(1);
    const reports = JSON.parse(stdout);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toMatchObject({ path: '/nonexistent/x.fgb', ok: false });
    expect(reports[1].error).toMatch(/nonexistent/);
  }, 30_000);
});

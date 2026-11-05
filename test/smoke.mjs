/**
 * Runtime smoke test of the built package, without a test framework, for
 * Node.js versions the test tooling no longer supports (18, 20).
 *
 * Checks that the ESM and CommonJS builds load and render identical tiles,
 * that `checkFile` and the CLI work, and that HTTP range reads work against
 * a local server.
 *
 * Usage (after `npm run build`): node test/smoke.mjs
 */

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name) => `${root}test/fixtures/${name}`;
const require = createRequire(import.meta.url);

const esm = await import(`${root}dist/index.js`);
const cjs = require(`${root}dist/cjs/index.js`);

const source = { name: 'points', path: fixture('points.fgb') };
const [a, b] = await Promise.all([
  esm.tile(new esm.LocalConnector(), 4, 3, 6, source),
  cjs.tile(new cjs.LocalConnector(), 4, 3, 6, source),
]);
assert.ok(a.length > 0, 'ESM build renders a tile');
assert.deepEqual(Buffer.from(a), Buffer.from(b), 'ESM and CommonJS builds render the same tile');
assert.ok(new cjs.FormatError('x') instanceof cjs.FgbVtError, 'CommonJS error classes');

const report = await esm.checkFile(new esm.LocalConnector(), fixture('grid-5k.fgb'));
assert.equal(report.ok, true, 'checkFile accepts a valid file');

const out = execFileSync(process.execPath, [`${root}dist/cli.js`, 'check', '--quick', fixture('points.fgb')], { encoding: 'utf8' });
assert.match(out, /points\.fgb {2}OK/, 'CLI checks a file');

const body = readFileSync(fixture('points.fgb'));
const server = createServer((req, res) => {
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
  const start = Number(m[1]);
  const end = Math.min(Number(m[2]), body.length - 1);
  res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${body.length}`, etag: '"v1"' });
  res.end(body.subarray(start, end + 1));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}/points.fgb`;
  const remote = await esm.tile(new esm.HttpConnector(), 4, 3, 6, { name: 'points', path: url });
  assert.deepEqual(Buffer.from(remote), Buffer.from(a), 'HTTP reads render the same tile');
  assert.match(await esm.tileETag(new esm.HttpConnector(), 4, 3, 6, { name: 'points', path: url }), /^"[0-9a-z]+"$/);
} finally {
  server.close();
}

console.log(`smoke test passed on Node.js ${process.version}`);

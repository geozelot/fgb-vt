/**
 * Bundle build script (run after `tsc`).
 *
 * Produces two minified, single-file bundles from the browser entry point:
 *
 *   dist/fgb-vt.esm.min.js  — ES module for <script type="module"> or bundlers
 *   dist/fgb-vt.umd.min.js  — IIFE exposing window.fgbvt for <script> tags / CDNs
 *
 * Both include source maps and target ES2020 for broad browser compatibility.
 *
 * And a CommonJS build of the Node.js entry point for `require()`:
 *
 *   dist/cjs/index.js       — single-file CommonJS bundle (Node.js 18+), with
 *                             a source map into src/
 *   dist/cjs/**\/*.d.ts      — the declarations, typed as CommonJS by the
 *                             adjacent package.json ({"type": "commonjs"}),
 *                             with their declaration maps
 *
 * Usage:
 *   node scripts/bundle.mjs
 */

import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const banner = `/* @geozelot/fgb-vt v${pkg.version} | MIT License | https://github.com/geozelot/fgb-vt */`;

/** @type {import('esbuild').BuildOptions} */
const shared = {
  entryPoints: ['src/browser.ts'],
  bundle: true,
  minify: true,
  sourcemap: true,
  target: 'es2020',
  banner: { js: banner },
};

// ESM bundle — for <script type="module"> or as a bundler fallback
await build({
  ...shared,
  format: 'esm',
  outfile: 'dist/fgb-vt.esm.min.js',
});

// IIFE bundle — for <script> tags and CDN auto-serving (unpkg, jsdelivr)
await build({
  ...shared,
  format: 'iife',
  globalName: 'fgbvt',
  outfile: 'dist/fgb-vt.umd.min.js',
});

// CommonJS bundle — for require() (Node.js before require(esm), Jest, ts-node).
// The S3 SDK stays a runtime import.
rmSync('dist/cjs', { recursive: true, force: true });
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: 'dist/cjs/index.js',
  external: ['@aws-sdk/client-s3'],
  banner: { js: banner },
  // Like tsc's maps, point at the shipped src/ instead of embedding it
  sourcemap: true,
  sourcesContent: false,
});
mkdirSync('dist/cjs', { recursive: true });
writeFileSync('dist/cjs/package.json', '{\n  "type": "commonjs"\n}\n');
// The ESM declarations are valid CommonJS declarations under dist/cjs
(function copyDeclarations(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const src = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (src !== join('dist', 'cjs')) copyDeclarations(src);
      continue;
    }
    const dest = join('dist', 'cjs', relative('dist', src));
    if (entry.name.endsWith('.d.ts')) {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    } else if (entry.name.endsWith('.d.ts.map')) {
      // Re-point the declaration map at src/ from its new location
      const map = JSON.parse(readFileSync(src, 'utf8'));
      map.sources = map.sources.map((s) =>
        relative(dirname(dest), join(dirname(src), map.sourceRoot || '', s)).split(sep).join('/'));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, JSON.stringify(map));
    }
  }
})('dist');

// Report sizes
import { statSync } from 'node:fs';
for (const f of ['dist/fgb-vt.esm.min.js', 'dist/fgb-vt.umd.min.js', 'dist/cjs/index.js']) {
  const size = statSync(f).size;
  const kb = (size / 1024).toFixed(1);
  console.log(`  ${f}  ${kb} KB`);
}

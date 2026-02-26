/**
 * Browser bundle build script.
 *
 * Produces two minified, single-file bundles from the browser entry point:
 *
 *   dist/fgb-vt.esm.min.js  — ES module for <script type="module"> or bundlers
 *   dist/fgb-vt.umd.min.js  — IIFE exposing window.fgbvt for <script> tags / CDNs
 *
 * Both include source maps and target ES2020 for broad browser compatibility.
 *
 * Usage:
 *   node scripts/bundle.mjs
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

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

// Report sizes
import { statSync } from 'node:fs';
for (const f of ['dist/fgb-vt.esm.min.js', 'dist/fgb-vt.umd.min.js']) {
  const size = statSync(f).size;
  const kb = (size / 1024).toFixed(1);
  console.log(`  ${f}  ${kb} KB`);
}

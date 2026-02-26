/**
 * @module fgb-vt/browser
 *
 * Browser-optimized entry point for the fgb-vt library.
 *
 * Re-exports the full API surface **except** connectors that depend on
 * Node.js-specific APIs ({@link LocalConnector}, {@link S3Connector}).
 * Only the {@link HttpConnector} is included, which relies solely on the
 * standard `fetch` / `AbortController` APIs available in all modern browsers.
 *
 * This module is referenced by the `"browser"` condition in `package.json`
 * exports, so bundlers like Vite, webpack, and esbuild automatically resolve
 * to it when targeting browser environments. It is also the entry point for
 * the pre-built minified bundles (`fgb-vt.esm.min.js`, `fgb-vt.umd.min.js`).
 *
 * @example
 * ```html
 * <script type="module">
 *   import { tile, HttpConnector } from 'fgb-vt';
 *
 *   const connector = new HttpConnector();
 *   const source = { name: 'buildings', path: 'https://data.example.com/buildings.fgb' };
 *   const pbf = await tile(connector, 14, 8192, 5461, source);
 * </script>
 * ```
 */

// ─── API Tiers ──────────────────────────────────────────────────────────────

export { TileServer } from './server.js';
export { TileClient } from './client.js';
export { tile } from './tile.js';

// ─── Browser-compatible Connector ───────────────────────────────────────────

export { HttpConnector } from './connectors/http.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type { Connector } from './connectors/connector.js';
export type { HttpConnectorOptions } from './connectors/http.js';
export type { Source, SourceOptions, TileOptions } from './source.js';
export type { TileServerLayer } from './server.js';
export type { TileJSON, BBox } from './types.js';

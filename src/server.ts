/**
 * @module server
 *
 * Stateful tile server for high-throughput FlatGeobuf vector tile serving.
 *
 * The {@link TileServer} binds all {@link Connector | Connectors} and
 * {@link Source | Sources} at construction time. Tile requests accept only
 * coordinates, making the hot path as lean as possible. FGB headers and
 * spatial index metadata are lazily cached on first access and reused for
 * the lifetime of the server instance.
 *
 * This tier is designed for long-running tile server processes with a fixed
 * set of FGB sources. All per-source overhead (header parsing, index
 * location) is amortized after the first request, yielding maximum
 * throughput on subsequent calls.
 *
 * Multiple connectors are supported via the {@link TileServerLayer}
 * configuration interface, allowing a single server to combine local files,
 * HTTP-hosted files, and S3-backed files into one tile stack.
 *
 * @example
 * ```typescript
 * import { TileServer } from 'fgb-vt';
 * import { HttpConnector, LocalConnector } from 'fgb-vt/connectors';
 *
 * // Single connector with multiple sources
 * const server = new TileServer({
 *   connector: new LocalConnector(),
 *   sources: [
 *     { name: 'buildings', path: './data/buildings.fgb' },
 *     { name: 'roads', path: './data/roads.fgb' },
 *   ],
 * });
 *
 * const pbf = await server.tile(14, 8192, 5461);
 * const metadata = await server.tileJSON();
 *
 * await server.close();
 * ```
 */

import type { Connector } from './connectors/connector.js';
import type { Source, TileOptions } from './source.js';
import type { TileJSON } from './types.js';
import { TileBoundsCache } from './tiles.js';
import {
  processMultiConnectorTile,
  readHeader,
  type FgbCache,
  type ConnectorSourceGroup,
} from './pipeline.js';
import { resolveOptions } from './source.js';

/**
 * A layer configuration binding a {@link Connector} to one or more
 * {@link Source | Sources}.
 *
 * Each layer represents a distinct storage backend. Within a layer, all
 * sources share the same connector for byte-range reads.
 *
 * @example
 * ```typescript
 * // Single source per connector
 * const layer: TileServerLayer = {
 *   connector: new HttpConnector(),
 *   sources: { name: 'parcels', path: 'https://cdn.example.com/parcels.fgb' },
 * };
 *
 * // Multiple sources sharing one connector
 * const multiLayer: TileServerLayer = {
 *   connector: new LocalConnector(),
 *   sources: [
 *     { name: 'water', path: './data/water.fgb' },
 *     { name: 'land', path: './data/land.fgb' },
 *   ],
 * };
 * ```
 */
export interface TileServerLayer {
  /** Byte-range reader used to access all sources in this layer. */
  connector: Connector;
  /** One or more FGB source descriptors served through this connector. */
  sources: Source | Source[];
}

/**
 * Stateful tile server with lazy header caching and multi-connector support.
 *
 * All connectors and sources are bound at construction. Tile requests take only
 * coordinates. FGB headers and spatial indices are cached per source path on
 * first access, amortizing I/O overhead across the lifetime of the instance.
 *
 * Use case: long-running tile server process with a fixed set of FGB sources.
 * Maximum throughput -- all per-source overhead is amortized after the first
 * request.
 *
 * @example Single connector
 * ```typescript
 * const server = new TileServer({
 *   connector: new LocalConnector(),
 *   sources: [
 *     { name: 'buildings', path: './data/buildings.fgb' },
 *     { name: 'roads', path: './data/roads.fgb', options: { maxZoom: 16 } },
 *   ],
 * });
 *
 * const pbf = await server.tile(14, 8192, 5461);
 * await server.close();
 * ```
 *
 * @example Multi-connector (local + remote)
 * ```typescript
 * const server = new TileServer([
 *   {
 *     connector: new LocalConnector(),
 *     sources: { name: 'boundaries', path: './data/boundaries.fgb' },
 *   },
 *   {
 *     connector: new HttpConnector(),
 *     sources: { name: 'imagery-grid', path: 'https://tiles.example.com/grid.fgb' },
 *   },
 * ]);
 *
 * const metadata = await server.tileJSON();
 * const pbf = await server.tile(10, 512, 341);
 * await server.close();
 * ```
 */
export class TileServer {
  private readonly groups: ConnectorSourceGroup[];
  private readonly options: TileOptions | undefined;
  private readonly boundsCache = new TileBoundsCache();
  private readonly fgbCaches = new Map<string, FgbCache>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Create a new tile server with the given layer configuration.
   *
   * Accepts a single layer or an array of layers. Each layer binds a
   * connector to one or more sources. Sources across layers may use
   * different connectors (e.g. local files + HTTP endpoints).
   *
   * @param layers - One or more layer configurations binding connectors to
   *   sources. A single {@link TileServerLayer} is accepted for convenience.
   * @param options - Tile-level tiling option defaults applied to all sources
   *   unless overridden by per-source options.
   */
  constructor(
    layers: TileServerLayer | TileServerLayer[],
    options?: TileOptions,
  ) {
    this.options = options;

    const layerArray = Array.isArray(layers) ? layers : [layers];
    this.groups = layerArray.map(layer => ({
      connector: layer.connector,
      sources: Array.isArray(layer.sources) ? layer.sources : [layer.sources],
    }));
  }

  /**
   * Render a vector tile as a PBF-encoded MVT.
   *
   * Layers appear in the output in the order defined at construction time.
   * FGB headers and spatial indices are lazily cached on the first request
   * for each source and reused on subsequent calls.
   *
   * @param z - Tile zoom level.
   * @param x - Tile column.
   * @param y - Tile row.
   * @returns PBF-encoded Mapbox Vector Tile. Returns an empty tile if no
   *   features intersect the requested tile bounds.
   */
  async tile(z: number, x: number, y: number): Promise<Uint8Array> {
    // Ensure all headers are cached (lazy init)
    await this.ensureInitialized();

    return processMultiConnectorTile(
      this.groups,
      z, x, y,
      this.options,
      this.boundsCache,
      this.fgbCaches,
    );
  }

  /**
   * Generate TileJSON 3.0.0 metadata derived from all configured sources.
   *
   * Returns aggregated bounds, zoom range, and a `vector_layers` array
   * listing each source's layer name, field schema, and zoom range.
   * FGB headers are read lazily if not already cached.
   *
   * @returns TileJSON metadata object conforming to the 3.0.0 specification.
   */
  async tileJSON(): Promise<TileJSON> {
    await this.ensureInitialized();

    const vectorLayers: TileJSON['vector_layers'] = [];
    let globalBounds: [number, number, number, number] = [180, 90, -180, -90];
    let globalMinZoom = Infinity;
    let globalMaxZoom = 0;

    for (const group of this.groups) {
      for (const source of group.sources) {
        const cache = this.fgbCaches.get(source.path);
        const opts = resolveOptions(source.options, this.options);

        // Build field map from header columns
        const fields: Record<string, string> = {};
        if (cache) {
          for (const col of cache.header.columns) {
            fields[col.name] = columnTypeToString(col.type);
          }
        }

        vectorLayers.push({
          id: source.name,
          fields,
          minzoom: opts.minZoom,
          maxzoom: opts.maxZoom,
        });

        // Update global zoom range
        globalMinZoom = Math.min(globalMinZoom, opts.minZoom);
        globalMaxZoom = Math.max(globalMaxZoom, opts.maxZoom);

        // Update global bounds from header bbox
        if (cache?.header.bbox) {
          const b = cache.header.bbox;
          globalBounds = [
            Math.min(globalBounds[0], b.minX),
            Math.min(globalBounds[1], b.minY),
            Math.max(globalBounds[2], b.maxX),
            Math.max(globalBounds[3], b.maxY),
          ];
        }
      }
    }

    // If no source had a bbox, default to world
    if (globalBounds[0] > globalBounds[2]) {
      globalBounds = [-180, -85.0511, 180, 85.0511];
    }

    return {
      tilejson: '3.0.0',
      bounds: globalBounds,
      minzoom: globalMinZoom === Infinity ? 0 : globalMinZoom,
      maxzoom: globalMaxZoom === 0 ? 24 : globalMaxZoom,
      vector_layers: vectorLayers,
    };
  }

  /**
   * Release all connector resources and cached state.
   *
   * Clears FGB header caches, resets initialization state, and closes
   * every unique connector. After calling `close()`, this server instance
   * must not be used again.
   *
   * @returns Resolves when all connectors have been closed.
   */
  async close(): Promise<void> {
    this.fgbCaches.clear();
    this.initialized = false;
    this.initPromise = null;

    // Close all unique connectors
    const connectors = new Set(this.groups.map(g => g.connector));
    await Promise.all([...connectors].map(c => c.close()));
  }

  // ─── Internal ──────────────────────────────────────────────────────────

  /**
   * Guard that triggers lazy initialization on first access.
   *
   * Subsequent calls return immediately if already initialized, or
   * await the in-flight initialization promise if one is pending.
   *
   * @returns Resolves when all FGB headers have been read and cached.
   */
  private ensureInitialized(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.initialize().then(() => {
      this.initialized = true;
    }).catch(err => {
      this.initPromise = null; // allow retry on transient failure
      throw err;
    });

    return this.initPromise;
  }

  /**
   * Read and cache FGB headers and spatial index metadata for all sources.
   *
   * Sources that are already cached (e.g. duplicate paths across layers)
   * are skipped. All reads are issued concurrently.
   *
   * @returns Resolves when every source header has been cached.
   */
  private async initialize(): Promise<void> {
    const jobs: Promise<void>[] = [];

    for (const group of this.groups) {
      for (const source of group.sources) {
        if (this.fgbCaches.has(source.path)) continue;

        jobs.push(
          readHeader(group.connector, source.path).then(result => {
            this.fgbCaches.set(source.path, result);
          }),
        );
      }
    }

    await Promise.all(jobs);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Map a FlatGeobuf {@link ColumnType} numeric constant to a human-readable
 * type string for TileJSON `vector_layers.fields`.
 *
 * Numeric FGB types (Byte through Double) map to `"Number"`, Bool maps to
 * `"Boolean"`, and text-like types (String, Json, DateTime, Binary) map to
 * `"String"`. Unknown types default to `"String"`.
 *
 * @param type - FlatGeobuf column type constant (0-14).
 * @returns Human-readable type string: `"Number"`, `"Boolean"`, or `"String"`.
 */
function columnTypeToString(type: number): string {
  switch (type) {
    case 0: return 'Number';   // Byte
    case 1: return 'Number';   // UByte
    case 2: return 'Boolean';  // Bool
    case 3: return 'Number';   // Short
    case 4: return 'Number';   // UShort
    case 5: return 'Number';   // Int
    case 6: return 'Number';   // UInt
    case 7: return 'Number';   // Long
    case 8: return 'Number';   // ULong
    case 9: return 'Number';   // Float
    case 10: return 'Number';  // Double
    case 11: return 'String';  // String
    case 12: return 'String';  // Json
    case 13: return 'String';  // DateTime
    case 14: return 'String';  // Binary
    default: return 'String';
  }
}

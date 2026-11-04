/**
 * @module server
 *
 * Stateful tile server for high-throughput FlatGeobuf vector tile serving.
 *
 * The {@link TileServer} binds all {@link Connector | Connectors} and
 * {@link Source | Sources} at construction time. Tile requests accept only
 * coordinates, making the hot path as lean as possible. FGB headers and
 * spatial index pages are read on first access and kept in a bounded cache
 * (a 64 MiB {@link MemoryCache} by default); {@link TileServer.open}
 * preloads them, e.g. at start-up.
 *
 * This tier is designed for long-running tile server processes with a fixed
 * set of FGB sources. Per-source overhead (header parsing, index reads) is
 * amortized across requests. Sources are opened independently: one
 * unreadable source fails only the tiles that include it.
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
import {
  processMultiConnectorTile,
  type ConnectorSourceGroup,
  type RequestOptions,
} from './pipeline.js';
import { resolveOptions } from './source.js';
import { MemoryCache } from './cache.js';
import { createIoContext, getSource, type IoContext, type IoOptions } from './fgb/reader.js';
import { resolveFrame } from './geometry/crs.js';
import { openSources, type OpenOptions } from './client.js';
import { featureSchema, emittedColumns } from './schema.js';
import { withPath } from './errors.js';

/**
 * Options for {@link TileServer.tileJSON}.
 */
export interface TileJSONOptions {
  /**
   * Tile URL templates, e.g. `['https://example.com/tiles/{z}/{x}/{y}.mvt']`.
   * Required by the TileJSON spec for clients to fetch tiles.
   */
  tiles?: string[];
  /** Tileset name (defaults to the header title or name of a single source). */
  name?: string;
  /** Tileset description (defaults to the header description of a single source). */
  description?: string;
  /** Attribution (HTML) to display with the map. */
  attribution?: string;
  /** Tileset version (semver). */
  version?: string;
}

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
  private readonly context: IoContext;
  /** Cache created by this instance (cleared on close), if not caller-supplied. */
  private readonly ownCache: MemoryCache | null;
  private readonly onTile: RequestOptions['onTile'];
  private closed = false;

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
   *   unless overridden by per-source options, plus I/O options (cache,
   *   prefetch, range merging, scan budget) and a default `onTile` hook.
   */
  constructor(
    layers: TileServerLayer | TileServerLayer[],
    options?: TileOptions & IoOptions & Pick<RequestOptions, 'onTile'>,
  ) {
    this.options = options;
    this.onTile = options?.onTile;
    this.ownCache = options?.cache === undefined ? new MemoryCache() : null;
    this.context = createIoContext(options, this.ownCache ?? new MemoryCache());

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
   * Sources are opened on first use and their headers and index pages
   * cached for subsequent calls.
   *
   * @param z - Tile zoom level.
   * @param x - Tile column.
   * @param y - Tile row.
   * @param request - Optional abort `signal` and `onTile` hook (overrides the constructor's).
   * @returns PBF-encoded Mapbox Vector Tile. Returns an empty tile if no
   *   features intersect the requested tile bounds.
   * @throws {RangeError} If `z/x/y` is not a valid tile.
   * @throws {FgbVtError} If a source cannot be read (annotated with its path)
   *   or a budget is exceeded.
   */
  async tile(z: number, x: number, y: number, request?: RequestOptions): Promise<Uint8Array> {
    this.assertOpen();
    return processMultiConnectorTile(
      this.groups,
      z, x, y,
      this.options,
      this.context,
      { onTile: this.onTile, ...request },
    );
  }

  /**
   * Open every configured source ahead of the first tile request: read
   * headers and the top of each spatial index and, within the
   * {@link OpenOptions.warmIndex} budget, all upper index levels.
   *
   * Opening is otherwise lazy. Call this at start-up (or in the init phase
   * of a serverless function) to move that I/O out of the first requests.
   *
   * @param options - Index warm-up budget.
   * @returns Resolves when every source is open.
   * @throws {FgbVtError} If a source cannot be opened (annotated with its path).
   */
  async open(options?: OpenOptions): Promise<void> {
    this.assertOpen();
    await Promise.all(this.groups.map(group =>
      openSources(group.connector, group.sources, this.context, options),
    ));
  }

  /**
   * Generate TileJSON 3.0.0 metadata derived from all configured sources.
   *
   * Returns aggregated bounds, zoom range, and a `vector_layers` array
   * listing each source's layer name, field schema, and zoom range.
   * Sources are opened (headers read) if not already open.
   *
   * - **`tiles`**: the URL templates from `options` (required by the
   *   TileJSON spec; empty when not given).
   * - **`name` / `description`**: from `options`, or, for a single source,
   *   the file's header title (or name) and description.
   * - **`bounds`**: each file's header envelope or, when that is absent or
   *   invalid, the root of its spatial index, converted to WGS 84. Without
   *   either (an unindexed file without envelope) the world is assumed.
   * - **`minzoom` / `maxzoom`**: the lowest `minZoom` and highest `maxZoom`
   *   of the sources.
   * - **`fields`**: the columns actually written as properties, after the
   *   source's `properties` selection and without the id column (unless
   *   kept) and binary columns.
   *
   * @param options - Tile URLs and descriptive metadata.
   * @returns TileJSON metadata object conforming to the 3.0.0 specification.
   * @throws {FgbVtError} If a source cannot be opened (annotated with its path).
   */
  async tileJSON(options?: TileJSONOptions): Promise<TileJSON> {
    this.assertOpen();

    const sources = this.groups.flatMap(group => group.sources.map(source => ({ group, source })));
    const opened = await Promise.all(sources.map(async ({ group, source }) => {
      try {
        const fgb = await getSource(group.connector, source.path, this.context);
        const frame = resolveFrame(fgb.header.crs, source.crs, source.path);
        const extent = await fgb.bounds();
        return { header: fgb.header, bounds: extent ? frame.toWgs84BBox(extent) : null };
      } catch (err) {
        throw withPath(err, source.path);
      }
    }));

    const vectorLayers: TileJSON['vector_layers'] = [];
    let bounds: [number, number, number, number] = [180, 90, -180, -90];
    const defaults = resolveOptions(undefined, this.options);
    let minzoom = sources.length > 0 ? Infinity : defaults.minZoom;
    let maxzoom = sources.length > 0 ? -Infinity : defaults.maxZoom;

    sources.forEach(({ source }, i) => {
      const { header, bounds: b } = opened[i];
      const opts = resolveOptions(source.options, this.options);

      const fields: Record<string, string> = {};
      for (const col of emittedColumns(featureSchema(source), header)) {
        fields[col.name] = columnTypeToString(col.type);
      }
      const description = header.description ?? header.title;
      vectorLayers.push({
        id: source.name,
        ...(description ? { description } : {}),
        fields,
        minzoom: opts.minZoom,
        maxzoom: opts.maxZoom,
      });

      minzoom = Math.min(minzoom, opts.minZoom);
      maxzoom = Math.max(maxzoom, opts.maxZoom);
      if (b) {
        bounds = [
          Math.min(bounds[0], b.minX),
          Math.min(bounds[1], b.minY),
          Math.max(bounds[2], b.maxX),
          Math.max(bounds[3], b.maxY),
        ];
      }
    });

    // If no source had bounds, default to the Web Mercator world
    if (bounds[0] > bounds[2]) {
      bounds = [-180, -85.0511, 180, 85.0511];
    }

    const single = opened.length === 1 ? opened[0].header : null;
    const name = options?.name ?? single?.title ?? single?.name ?? undefined;
    const description = options?.description ?? single?.description ?? undefined;
    return {
      tilejson: '3.0.0',
      tiles: options?.tiles ?? [],
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(options?.attribution ? { attribution: options.attribution } : {}),
      ...(options?.version ? { version: options.version } : {}),
      bounds,
      minzoom,
      maxzoom,
      vector_layers: vectorLayers,
    };
  }

  /**
   * Release all connector resources and cached state.
   *
   * Clears the instance's own cache (a caller-supplied cache is left
   * untouched) and closes every unique connector. After calling `close()`,
   * this server instance must not be used again.
   *
   * @returns Resolves when all connectors have been closed.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.ownCache?.clear();

    // Close all unique connectors
    const connectors = new Set(this.groups.map(g => g.connector));
    await Promise.all([...connectors].map(c => c.close()));
  }

  // == Internal ==========================================================

  /**
   * Reject use after {@link close}.
   *
   * @throws {Error} If the server has been closed.
   */
  private assertOpen(): void {
    if (this.closed) {
      throw new Error('TileServer is closed');
    }
  }
}

// == Helpers ================================================================

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

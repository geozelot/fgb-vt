/**
 * Helpers for end-to-end tests: decode tiles with the reference MVT reader
 * and check geometry validity.
 */
import { fileURLToPath } from 'node:url';
import { VectorTile, type VectorTileLayer } from '@mapbox/vector-tile';
import Pbf from 'pbf';

/** Absolute path of a golden fixture in `test/fixtures`. */
export function fixture(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

/** Decode a PBF tile and return the named layer (undefined when empty). */
export function decodeLayer(pbf: Uint8Array, name: string): VectorTileLayer | undefined {
  return new VectorTile(new Pbf(pbf)).layers[name];
}

/** All features of a layer, in order. */
export function features(layer: VectorTileLayer | undefined) {
  const out = [];
  if (!layer) return out;
  for (let i = 0; i < layer.length; i++) out.push(layer.feature(i));
  return out;
}

/** Slippy tile containing a lon/lat at zoom `z`. */
export function tileAt(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
  };
}

/**
 * Count geometry defects that the MVT 2.1 spec forbids or renderers mishandle:
 * consecutive duplicate vertices (zero-length LineTo) and rings with fewer
 * than three distinct vertices.
 */
export function geometryDefects(layer: VectorTileLayer | undefined): { zeroLength: number; degenerateRings: number; vertices: number } {
  let zeroLength = 0, degenerateRings = 0, vertices = 0;
  for (const f of features(layer)) {
    for (const part of f.loadGeometry()) {
      vertices += part.length;
      for (let i = 1; i < part.length; i++) {
        if (part[i].x === part[i - 1].x && part[i].y === part[i - 1].y) zeroLength++;
      }
      if (f.type === 3 && new Set(part.map(p => `${p.x},${p.y}`)).size < 3) degenerateRings++;
    }
  }
  return { zeroLength, degenerateRings, vertices };
}

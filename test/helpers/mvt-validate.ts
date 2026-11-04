/**
 * Strict validator for Mapbox Vector Tiles (specification 2.1).
 *
 * Reads the protobuf directly instead of going through a renderer-oriented
 * decoder, which tolerates many violations. Checks:
 *
 * - layers: version 2, a non-empty name unique within the tile, an extent,
 *   no duplicate keys or values;
 * - values: exactly one typed field each;
 * - features: a known geometry type, tags in pairs that reference existing
 *   keys and values, no key twice in one feature;
 * - geometry commands per type: valid command ids and counts, parameter
 *   counts, no zero-length `LineTo`, polygon rings closed with `ClosePath`,
 *   non-zero ring areas, every polygon starting with an exterior ring
 *   (positive surveyor's area in tile coordinates);
 * - coordinates within a plausible window around the tile.
 */
import Pbf from 'pbf';

/** One problem found in a tile. */
export interface MvtIssue {
  layer: string;
  feature?: number;
  message: string;
}

interface Layer {
  version: number;
  name: string;
  extent: number;
  keys: string[];
  values: string[];
  features: Feature[];
}

interface Feature {
  type: number;
  tags: number[];
  geometry: number[];
}

/**
 * Validate an encoded tile.
 *
 * @param bytes - PBF-encoded tile.
 * @returns Problems found; empty for a valid tile.
 */
export function validateMvt(bytes: Uint8Array): MvtIssue[] {
  const issues: MvtIssue[] = [];
  const layers: Layer[] = [];
  const pbf = new Pbf(bytes);
  pbf.readFields((tag, _, p) => {
    if (tag === 3) layers.push(readLayer(p!));
  }, null);

  const names = new Set<string>();
  for (const layer of layers) {
    const at = (message: string, feature?: number) => issues.push({ layer: layer.name, feature, message });
    if (layer.version !== 2) at(`version ${layer.version}, expected 2`);
    if (!layer.name) at('layer without name');
    if (names.has(layer.name)) at('duplicate layer name');
    names.add(layer.name);
    if (!(layer.extent > 0)) at(`invalid extent ${layer.extent}`);
    if (new Set(layer.keys).size !== layer.keys.length) at('duplicate keys');
    if (new Set(layer.values).size !== layer.values.length) at('duplicate values');
    layer.values.forEach((v, i) => { if (v === 'invalid') at(`value ${i} sets no or several fields`); });

    layer.features.forEach((f, i) => {
      if (f.tags.length % 2 !== 0) at('odd number of tags', i);
      const seen = new Set<number>();
      for (let t = 0; t + 1 < f.tags.length; t += 2) {
        if (f.tags[t] >= layer.keys.length) at(`key index ${f.tags[t]} out of range`, i);
        if (f.tags[t + 1] >= layer.values.length) at(`value index ${f.tags[t + 1]} out of range`, i);
        if (seen.has(f.tags[t])) at(`key ${f.tags[t]} twice`, i);
        seen.add(f.tags[t]);
      }
      for (const message of geometryIssues(f.type, f.geometry, layer.extent)) at(message, i);
    });
  }
  return issues;
}

function readLayer(pbf: Pbf): Layer {
  const layer: Layer = { version: 1, name: '', extent: 4096, keys: [], values: [], features: [] };
  const end = pbf.readVarint() + pbf.pos;
  pbf.readFields((tag, l, p) => {
    if (tag === 15) l!.version = p!.readVarint();
    else if (tag === 1) l!.name = p!.readString();
    else if (tag === 2) l!.features.push(readFeature(p!));
    else if (tag === 3) l!.keys.push(p!.readString());
    else if (tag === 4) l!.values.push(readValue(p!));
    else if (tag === 5) l!.extent = p!.readVarint();
  }, layer, end);
  return layer;
}

function readFeature(pbf: Pbf): Feature {
  const feature: Feature = { type: 0, tags: [], geometry: [] };
  const end = pbf.readVarint() + pbf.pos;
  pbf.readFields((tag, f, p) => {
    if (tag === 2) p!.readPackedVarint(f!.tags);
    else if (tag === 3) f!.type = p!.readVarint();
    else if (tag === 4) p!.readPackedVarint(f!.geometry);
  }, feature, end);
  return feature;
}

/** A value's identity (`type:value`), or `'invalid'` unless exactly one field is set. */
function readValue(pbf: Pbf): string {
  const end = pbf.readVarint() + pbf.pos;
  const fields: string[] = [];
  pbf.readFields((tag, out, p) => {
    if (tag === 1) out!.push(`s:${p!.readString()}`);
    else if (tag === 2) out!.push(`f:${p!.readFloat()}`);
    else if (tag === 3) out!.push(`d:${p!.readDouble()}`);
    else if (tag === 4) out!.push(`i:${p!.readVarint(true)}`);
    else if (tag === 5) out!.push(`u:${p!.readVarint()}`);
    else if (tag === 6) out!.push(`z:${p!.readSVarint()}`);
    else if (tag === 7) out!.push(`b:${p!.readBoolean()}`);
  }, fields, end);
  return fields.length === 1 ? fields[0] : 'invalid';
}

const MOVE_TO = 1, LINE_TO = 2, CLOSE_PATH = 7;

/** Geometry problems of one feature. */
function geometryIssues(type: number, geom: number[], extent: number): string[] {
  const issues: string[] = [];
  if (type < 1 || type > 3) return [`geometry type ${type}`];
  if (geom.length === 0) return ['empty geometry'];

  let i = 0, x = 0, y = 0;
  const lo = -extent, hi = 2 * extent;
  const command = () => {
    if (i >= geom.length) return null;
    const c = geom[i++];
    return { id: c & 7, count: c >> 3 };
  };
  const vertex = (): [number, number] | null => {
    if (i + 2 > geom.length) {
      issues.push('missing parameters');
      return null;
    }
    const dx = (geom[i] >>> 1) ^ -(geom[i] & 1);
    const dy = (geom[i + 1] >>> 1) ^ -(geom[i + 1] & 1);
    i += 2;
    x += dx;
    y += dy;
    if (x < lo || x > hi || y < lo || y > hi) issues.push(`coordinate ${x},${y} far outside the tile`);
    return [dx, dy];
  };

  if (type === 1) {
    const c = command();
    if (!c || c.id !== MOVE_TO || c.count < 1) return ['points must be one MoveTo with count >= 1'];
    for (let k = 0; k < c.count; k++) if (!vertex()) return issues;
    if (i !== geom.length) issues.push('extra commands after point MoveTo');
    return issues;
  }

  let exteriorSeen = false;
  while (i < geom.length) {
    const move = command();
    if (!move || move.id !== MOVE_TO || move.count !== 1) {
      issues.push(`expected MoveTo(1), got command ${move?.id}(${move?.count})`);
      return issues;
    }
    const start = vertex();
    if (!start) return issues;
    const ring: Array<[number, number]> = [[x, y]];
    const line = command();
    const minLineTo = type === 3 ? 2 : 1;
    if (!line || line.id !== LINE_TO || line.count < minLineTo) {
      issues.push(`expected LineTo(>=${minLineTo}), got command ${line?.id}(${line?.count})`);
      return issues;
    }
    for (let k = 0; k < line.count; k++) {
      const d = vertex();
      if (!d) return issues;
      if (d[0] === 0 && d[1] === 0) issues.push('zero-length LineTo');
      ring.push([x, y]);
    }
    if (type === 3) {
      const close = command();
      if (!close || close.id !== CLOSE_PATH || close.count !== 1) {
        issues.push('ring not closed with ClosePath(1)');
        return issues;
      }
      // Shoelace formula: sum of x(i) * y(i+1) - x(i+1) * y(i), twice the area
      let area = 0;
      for (let a = 0; a < ring.length; a++) {
        const [x0, y0] = ring[a];
        const [x1, y1] = ring[(a + 1) % ring.length];
        area += x0 * y1 - x1 * y0;
      }
      if (area === 0) issues.push('ring with zero area');
      else if (!exteriorSeen && area < 0) issues.push('polygon starts with an interior ring');
      if (area > 0) exteriorSeen = true;
    }
  }
  return issues;
}

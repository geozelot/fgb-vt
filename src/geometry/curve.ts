/**
 * @module geometry/curve
 *
 * Linearisation of circular arcs (`CircularString`, ISO SQL/MM).
 *
 * A circular string is a sequence of arcs, each defined by three points:
 * start, a point anywhere on the arc, and end. Consecutive arcs share their
 * end/start point, so `n` arcs take `2n + 1` points. A full circle is an arc
 * whose start and end coincide; its middle point is then diametrically
 * opposite.
 *
 * Arcs are approximated by chords whose deviation from the true arc (the
 * sagitta) stays below a tolerance in the source coordinate units. The
 * pipeline derives that tolerance from the tile being rendered, so curves
 * get more vertices the further one zooms in.
 */

/** Smallest angle a single chord may subtend: at most 256 chords per full circle. */
const MIN_CHORD_ANGLE = (2 * Math.PI) / 256;

/** Most chords for a single arc. */
const MAX_ARC_SEGMENTS = 128;

/**
 * Upper bound on the vertices a circular string may expand to, relative to
 * its input: `GROWTH * points + SLACK`. Guards against files that pack
 * many arcs into a small feature; arcs are coarsened evenly when exceeded.
 */
const GROWTH = 16;
const SLACK = 256;

/** Relative threshold below which three points count as collinear. */
const COLLINEAR_EPSILON = 1e-9;

/**
 * Circle through an arc's three points, or `null` when they are collinear
 * or coincide.
 */
interface Arc {
  cx: number;
  cy: number;
  r: number;
  /** Angle of the start point. */
  start: number;
  /** Signed angle swept from start to end through the middle point. */
  sweep: number;
}

/**
 * Linearise a circular string into a line string.
 *
 * @param xy - Interleaved coordinates of the circular string (`2n + 1`
 *   points for `n` arcs).
 * @param tolerance - Largest allowed distance between an arc and its
 *   chords, in coordinate units. `0` uses the finest resolution.
 * @returns Interleaved coordinates of the approximating line string,
 *   starting and ending exactly at the input's first and last points. Input
 *   with an invalid point count (even, or fewer than 3) is returned as is,
 *   i.e. read as a line string.
 */
export function linearizeArcs(xy: Float64Array, tolerance: number): Float64Array {
  const points = xy.length / 2;
  if (points < 3 || points % 2 === 0) return xy;
  const arcs = (points - 1) / 2;

  // Pass 1: chords per arc
  const counts = new Uint32Array(arcs);
  let total = 0;
  for (let k = 0; k < arcs; k++) {
    const i = k * 4;
    const arc = circle(xy[i], xy[i + 1], xy[i + 2], xy[i + 3], xy[i + 4], xy[i + 5]);
    counts[k] = arc ? segments(arc, tolerance) : 2;
    total += counts[k];
  }
  const budget = GROWTH * points + SLACK;
  if (total > budget) {
    const scale = budget / total;
    total = 0;
    for (let k = 0; k < arcs; k++) {
      counts[k] = Math.max(2, Math.floor(counts[k] * scale));
      total += counts[k];
    }
  }

  // Pass 2: emit chord vertices
  const out = new Float64Array((total + 1) * 2);
  out[0] = xy[0];
  out[1] = xy[1];
  let w = 2;
  for (let k = 0; k < arcs; k++) {
    const i = k * 4;
    const n = counts[k];
    const arc = circle(xy[i], xy[i + 1], xy[i + 2], xy[i + 3], xy[i + 4], xy[i + 5]);
    if (!arc) {
      // Straight (always 2 chords): through the middle point to the end
      out[w++] = xy[i + 2];
      out[w++] = xy[i + 3];
    } else {
      for (let s = 1; s < n; s++) {
        const a = arc.start + (arc.sweep * s) / n;
        out[w++] = arc.cx + arc.r * Math.cos(a);
        out[w++] = arc.cy + arc.r * Math.sin(a);
      }
    }
    out[w++] = xy[i + 4];
    out[w++] = xy[i + 5];
  }
  return out;
}

/**
 * Number of chords for an arc so that no chord deviates from it by more
 * than `tolerance`.
 *
 * @param arc - The arc.
 * @param tolerance - Largest allowed deviation in coordinate units.
 * @returns Chord count in `[2, MAX_ARC_SEGMENTS]`.
 */
function segments(arc: Arc, tolerance: number): number {
  // A chord subtending angle θ deviates by r(1 - cos(θ/2)) from the arc
  if (tolerance >= arc.r) return 2;
  const theta = Math.max(MIN_CHORD_ANGLE, 2 * Math.acos(1 - tolerance / arc.r));
  return Math.min(MAX_ARC_SEGMENTS, Math.max(2, Math.ceil(Math.abs(arc.sweep) / theta)));
}

/**
 * Circle through three points, with the angle swept from the first to the
 * third through the second.
 *
 * @returns The arc, or `null` if the points are collinear or coincide.
 */
function circle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): Arc | null {
  if (x0 === x2 && y0 === y2) {
    // Full circle: the middle point is diametrically opposite the start
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const r = Math.hypot(x1 - x0, y1 - y0) / 2;
    if (!(r > 0)) return null;
    return { cx, cy, r, start: Math.atan2(y0 - cy, x0 - cx), sweep: 2 * Math.PI };
  }

  // Circumcentre, relative to the first point for precision
  const bx = x1 - x0, by = y1 - y0;
  const qx = x2 - x0, qy = y2 - y0;
  const d = 2 * (bx * qy - by * qx);
  const b2 = bx * bx + by * by, q2 = qx * qx + qy * qy;
  if (!(Math.abs(d) > 2 * COLLINEAR_EPSILON * Math.sqrt(b2 * q2))) return null;
  const ux = (qy * b2 - by * q2) / d;
  const uy = (bx * q2 - qx * b2) / d;
  const cx = x0 + ux, cy = y0 + uy;
  const r = Math.hypot(ux, uy);

  const start = Math.atan2(y0 - cy, x0 - cx);
  let sweep = Math.atan2(y2 - cy, x2 - cx) - start;
  if (d > 0) {
    // Counter-clockwise (in a y-up frame) through the middle point
    while (sweep <= 0) sweep += 2 * Math.PI;
  } else {
    while (sweep >= 0) sweep -= 2 * Math.PI;
  }
  return { cx, cy, r, start, sweep };
}

// Tileable Voronoi with the exact distance to the cell border (helper for cellular.js and speckle.js).
//
// node-lib's worley() gives F1/F2 and the nearest cell; F2 − F1 is no true distance (line widths vary with the
// angle between neighbours), and the nearest point itself is not returned. Here: pass 1 finds the nearest feature
// point, pass 2 looks at the cells around it (3×3 or 5×5) and takes the distance to each bisector between the two points
// (= distance to the Voronoi edge) and the distance to the closest neighbour point (→ inscribed circle).
import { float, vec2, floor, fract, dot, min, select, sqrt, normalize } from 'three/tsl';
import { wrap, hash22 } from '../node-lib.js';

/**
 * p in cells, period = cells per tile (number or vec2), jitter 0 = regular grid … 1 = fully random.
 * Returns TSL nodes:
 *   cell   – wrapped index of the nearest cell (vec2, feed hash2/hash22)
 *   rel    – vector from the pixel to the nearest feature point (cells)
 *   f1     – distance to the nearest feature point
 *   border – distance to the nearest cell border (0 on the edge, ~0.5 at the centre of a regular cell)
 *   radius – half the distance to the closest neighbour point = radius of the circle that fits into the cell
 */
export function voronoi(p, period, jitter = 0.9) {
    const i = floor(p).toVar();
    const f = fract(p).toVar();
    const point = o => {
        const id = wrap(i.add(o), period);
        return o.add(0.5).add(hash22(id).sub(0.5).mul(jitter)).sub(f);
    };
    // pass 1: nearest feature point
    let best = float(64), rel = vec2(0, 0), off = vec2(0, 0);
    for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
            const o = vec2(x, y);
            const r = point(o).toVar();
            const d = dot(r, r);
            const closer = d.lessThan(best);
            rel = select(closer, r, rel).toVar();
            off = select(closer, o, off).toVar();
            best = min(best, d).toVar();
        }
    }
    // pass 2: distance to the bisectors towards the neighbours of the nearest point (5×5 for a high jitter: the
    // neighbour that forms an edge can then be two cells away – 3×3 left arcs at the cell borders)
    const n = jitter > 0.75 ? 2 : 1;
    let border = float(8), nn = float(8);
    for (let y = -n; y <= n; y++) {
        for (let x = -n; x <= n; x++) {
            if (x === 0 && y === 0) continue;
            const o = off.add(vec2(x, y));
            const r = point(o);
            const dr = r.sub(rel).toVar();
            const l2 = dot(dr, dr);
            const e = dot(rel.add(r).mul(0.5), normalize(dr));
            border = min(border, e).toVar();
            nn = min(nn, l2).toVar();
        }
    }
    return { cell: wrap(i.add(off), period), rel, f1: sqrt(best), border, radius: sqrt(nn).mul(0.5) };
}

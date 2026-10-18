// Cellular: cell pattern from tileable Voronoi cells (stone cells, flagstones, pebbles).
// Modes: cells    – stones with soft division lines and rounded shoulders,
//        chips    – flat chips with sharp edges and a slight tilt each (crazy paving, flagstones),
//        circular – round/oval pebbles in the cells, the rest is filler (division colour).
// spread = cell size against the division (1 = cells fill everything), smoothing = softness of the transition,
// roughness = irregular edges (periodic noise warp; pebbles: lobed outline), fractal = more octaves: ragged edges,
// mottled colour and faint hairline cracks (chips) – or smaller pebbles in the gaps (circular).
// value = height (cells high, divisions low), random = per cell 0..1. Cell borders come from cellular-voronoi.js.
import { float, vec2, mix, max, min, abs, clamp, smoothstep, sqrt, dot, cos, sin, length, select } from 'three/tsl';
import { T, tsl, coord, input, hash2, hash22, periodicNoise, fbm, vary } from '../node-lib.js';
import { voronoi } from './cellular-voronoi.js';

/** periodic warp of p (in cells) for irregular edges; period = cells per tile; fractal adds finer, ragged detail */
function warp(p, s, amount, octaves) {
    if (!amount) return p;
    const q = p.mul(2), per = float(s * 2);
    let n = vec2(fbm(q, per, 3), fbm(q.add(vec2(17, 31)), per, 3)).sub(0.5).mul(amount * 0.6);
    for (let k = 1; k < octaves; k++) {
        const f = 4 * 2 ** k;
        const qk = p.mul(f), pk = float(s * f);
        n = n.add(vec2(fbm(qk, pk, 2), fbm(qk.add(vec2(5, 11)), pk, 2)).sub(0.5).mul(amount * 0.5 / f));
    }
    return p.add(n);
}

/** smooth minimum (rounded intersection of two signed distances, k = rounding) */
const smin = (a, b, k) => {
    const h = max(float(k).sub(abs(a.sub(b))), 0).div(k);
    return min(a, b).sub(h.mul(h).mul(k * 0.25));
};

/** one layer: { mask (1 = cell / pebble), height 0..1, cell } */
function layer(p, s, mode, spread, smoothing, seed, roughness = 0, jitter = mode === 'circular' ? 0.7 : 0.9) {
    // pebbles: less jitter → more even sizes; stones: more → irregular shapes
    const v = voronoi(p, s, jitter);
    const rnd = hash22(v.cell, seed);
    if (mode === 'circular') {
        // oval pebble around the feature point, cut by the (shrunk) cell so neighbours never overlap
        const a = rnd.x.mul(Math.PI * 2);
        const ca = cos(a), sa = sin(a);
        const q = vec2(v.rel.x.mul(ca).sub(v.rel.y.mul(sa)), v.rel.x.mul(sa).add(v.rel.y.mul(ca)));
        const qe = q.mul(vec2(1, float(1).add(rnd.y.mul(0.6))));
        let e = length(qe);
        if (roughness) {
            // irregular outline: 2- and 3-lobed wobble of the radius (cheaper than warping the cells)
            const c = qe.x.div(max(e, 1e-4)), sn = qe.y.div(max(e, 1e-4));
            const lobes = c.mul(c).sub(sn.mul(sn)).mul(rnd.y.sub(0.5)).add(c.mul(c.mul(c).mul(4).sub(3)).mul(rnd.x.sub(0.5)));
            e = e.mul(float(1).add(lobes.mul(roughness * 0.35)));
        }
        // (radius: half the distance to the closest neighbour plus a share of a cell, so a pebble with a close
        // neighbour still grows into the free side of its cell; the cell border flattens it where they meet)
        const rad = v.radius.mul(0.5 + 0.8 * spread).add(0.25 * spread).toVar();
        const sdCircle = rad.sub(e);
        const sdCell = v.border.sub((1 - spread) * 0.2 + 0.015);
        const sd = smin(sdCircle, sdCell, 0.3).toVar();
        const mask = smoothstep(float(0), float(0.012 + smoothing * 0.12), sd);
        // dome over the oval (smooth – a profile from `sd` would show creases along the medial axis),
        // rounded off where the cell border cuts it
        const er = e.div(rad);
        const dome = sqrt(max(float(1).sub(er.mul(er)), 0)).mul(smoothstep(float(0), float(0.15), sd));
        return { mask, height: dome.mul(mask), shade: dome, cell: v.cell, sd, rel: v.rel };
    }
    // division half-width in cells: spread 1 = hairline, 0 = mostly division
    // (varies a little along the joint so it does not look drawn with a ruler)
    const w = periodicNoise(p.mul(3), float(s * 3)).mul(1.2).add(0.4).mul((1 - spread) * 0.35).add(0.006).toVar();
    const soft = mode === 'chips' ? 0.006 + smoothing * 0.04 : 0.02 + smoothing * 0.3;
    const mask = smoothstep(w, w.add(soft), v.border);
    let height;
    if (mode === 'chips') {
        // flat chip, height and tilt per chip, sharp drop at the edge
        const tilt = rnd.sub(0.5).mul(0.25);
        const plate = float(0.75).add(hash2(v.cell, seed + 3).sub(0.5).mul(0.3)).add(dot(v.rel.negate(), tilt));
        height = clamp(plate, 0, 1).mul(mask);
        return { mask, height, shade: smoothstep(w, w.add(0.05), v.border), cell: v.cell };
    } else {
        // rounded stone: rises from the division towards the middle of the cell
        const shoulder = smoothstep(w, w.add(0.08 + smoothing * 0.35), v.border);
        height = shoulder.mul(float(0.8).add(hash2(v.cell, seed + 3).mul(0.2)));
        return { mask, height, shade: shoulder, cell: v.cell };
    }
}

export default {
    type: 'cellular',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
    outputs: [{ key: 'color', type: 'color' }, { key: 'value', type: 'float' }, { key: 'random', type: 'float' }],
    params: [
        { key: 'mode', kind: 'select', options: ['cells', 'chips', 'circular'], default: 'cells' },
        // cells per tile (integer → seamless)
        { key: 'scale', kind: 'number', min: 1, max: 100, step: 1, default: 6 },
        { key: 'spread', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.88 },
        { key: 'smoothing', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
        { key: 'roughness', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
        { key: 'fractal', kind: 'number', min: 1, max: 3, step: 1, default: 1 },
        { key: 'variation', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
        { key: 'a', kind: 'color', default: '#9a948a' },
        { key: 'b', kind: 'color', default: '#57524b' },
    ],
    evaluate(port, p, get) {
        const s = Math.max(1, Math.round(p.scale));
        const mode = ['cells', 'chips', 'circular'].includes(p.mode) ? p.mode : 'cells';
        const spread = Math.min(Math.max(p.spread, 0), 1), smoothing = Math.min(Math.max(p.smoothing, 0), 1);
        const octaves = Math.min(Math.max(Math.round(p.fractal), 1), 3);
        const uv = coord(get);
        const pebbles = (c, k) => layer(c.mul(s * 2 ** k), s * 2 ** k, mode, spread, smoothing, k * 5, p.roughness);
        const o1 = mode === 'circular' ? pebbles(uv, 0) : layer(warp(uv.mul(s), s, p.roughness, octaves), s, mode, spread, smoothing, 0);
        const rand = hash2(o1.cell, 11);

        let mask = o1.mask, height = o1.height, shade = o1.shade, cellRand = rand, mottle = float(0);
        const prev = [o1];
        for (let k = 1; k < octaves; k++) {
            const f = 2 ** k, sk = s * f;
            if (mode === 'circular') {
                // smaller pebbles fill the gaps between the larger ones: a small pebble is kept when its centre
                // lies outside the larger pebbles (the coarser layers evaluated there), and it lies below them
                const o = pebbles(uv, k);
                const centre = uv.add(o.rel.div(sk));
                let sdCentre = float(-8), sdHere = float(-8);
                for (let j = 0; j < k; j++) {
                    const sj = s * 2 ** j;
                    sdCentre = max(sdCentre, pebbles(centre, j).sd.div(sj));
                    sdHere = max(sdHere, prev[j].sd.div(sj));
                }
                const keep = select(sdCentre.mul(-sk).greaterThan(0.3), float(1), float(0));
                const m = o.mask.mul(keep).mul(smoothstep(float(0.01 / sk), float(0.04 / sk), sdHere.negate()));
                prev.push(o);
                height = max(height, o.height.mul(0.75 ** k).mul(m));
                cellRand = mix(cellRand, hash2(o.cell, 11 + k), m);
                shade = mix(shade, o.shade, m);
                mask = max(mask, m);
            } else {
                // finer detail inside each stone: soft mottled colour, faint hairline cracks on chips
                mottle = mottle.add(fbm(uv.mul(sk * 2), float(sk * 2), 2).sub(0.5).mul(0.8 / k));
                if (mode === 'chips') {
                    const o = layer(warp(uv.mul(sk), sk, p.roughness * 0.5, 1), sk, 'chips', 0.99, 0, k * 5, 0, 0.75);
                    const crack = mix(float(1), o.mask, 0.12 / k);
                    mask = mask.mul(crack);
                    height = height.mul(mix(float(1), o.mask, 0.1 / k));
                }
            }
        }
        if (port === 'random') return T(cellRand, 'float');
        // a little surface grain so the cells are not flat
        const grain = fbm(uv.mul(s * 8), float(s * 8), 3).sub(0.5);
        if (port === 'value') return T(clamp(height.add(grain.mul(0.06).mul(mask)), 0, 1), 'float');

        const a = input(get, 'a', 'color', p.a), b = input(get, 'b', 'color', p.b);
        // darker towards the joints (shoulders, pebble rims), grain on stones and joints
        const ca = vary(tsl(a), cellRand, p.variation).mul(float(1).add(grain.mul(0.25)).add(mottle.mul(p.variation)))
            .mul(mix(float(0.78), float(1), shade));
        const cb = tsl(b).mul(float(1).add(grain.mul(0.5)));
        return T(mix(cb, ca, mask), 'color');
    },
};

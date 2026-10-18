// Speckle: random spots of varying size in colour b on colour a (granite, terrazzo, exposed aggregate, gravel,
// sprinkled paint). Each layer is a jittered grid; a cell holds one spot with probability `density`. The spot is a
// random convex polygon (angular chips) blended into an oval by `roundness`; up to three layers (each twice as
// fine) mix several grain sizes. Spots may overlap their neighbours (3×3 search), the topmost wins.
import { float, vec2, vec3, floor, fract, dot, mix, max, clamp, smoothstep, sqrt, cos, sin, length, select } from 'three/tsl';
import { T, tsl, coord, input, wrap, hash33, vary } from '../node-lib.js';

const SIDES = 5;

/** one layer of spots on a grid of `s` cells per tile: { mask, height, rand, shade } (rand/shade of the topmost spot) */
function spots(uv, s, o, seed) {
    const p = uv.mul(s);
    const i = floor(p).toVar();
    const f = fract(p).toVar();
    let mask = float(0), height = float(0), rand = float(0), shade = float(1);
    for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
            const id = wrap(i.add(vec2(x, y)), s);
            const h0 = hash33(vec3(id, seed)).toVar();       // exists, centre x/y
            const h1 = hash33(vec3(id, seed + 1)).toVar();   // radius, rotation, aspect
            const h2 = hash33(vec3(id, seed + 2)).toVar();   // tone, corner jitter
            // radius in cells (diameter `size` of a cell), smaller ones by `variation`
            const r = float(o.size * 0.5).mul(float(1).sub(h1.x.mul(o.variation))).toVar();
            // centre anywhere in the cell: a spot (r ≤ 1) two cells away never reaches this one → 3×3 is enough
            const c = vec2(x, y).add(h0.yz).sub(f);
            const a = h1.y.mul(Math.PI * 2);
            const ca = cos(a), sa = sin(a);
            const d = vec2(c.x.mul(ca).add(c.y.mul(sa)), c.y.mul(ca).sub(c.x.mul(sa)))
                .mul(vec2(1, float(1).add(h1.z.mul(0.7 * o.elongation)))).negate().toVar();
            // convex polygon with jittered corners vs. ellipse
            let poly = float(-8);
            for (let k = 0; k < SIDES; k++) {
                const t = (k + 0.5) / SIDES * Math.PI * 2;
                const jit = fract(h2.y.add(k * 0.618)).sub(0.5).mul(0.9);
                const ang = jit.add(t);
                poly = max(poly, dot(d, vec2(cos(ang), sin(ang))));
            }
            const dist = mix(poly.div(Math.cos(Math.PI / SIDES) * 0.92 + 0.08), length(d), o.roundness);
            const sd = r.sub(dist);
            const soft = r.mul(o.softness * 0.8).add(0.015);
            const m = smoothstep(float(0), soft, sd).mul(select(h0.x.lessThan(o.density), float(1), float(0))).toVar();
            // dome: flat chips at roundness 0, round pebbles at 1
            const dome = sqrt(clamp(sd.div(r.mul(mix(0.25, 0.9, o.roundness))), 0, 1));
            const hgt = dome.mul(m);
            const top = m.greaterThan(mask.mul(0.5));
            rand = select(top, h2.x, rand).toVar();
            shade = select(top, dome, shade).toVar();
            height = max(height, hgt.mul(float(0.75).add(h1.x.mul(0.25)))).toVar();
            mask = max(mask, m).toVar();
        }
    }
    return { mask, height, rand, shade };
}

export default {
    type: 'speckle',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
    outputs: [{ key: 'color', type: 'color' }, { key: 'value', type: 'float' }, { key: 'random', type: 'float' }],
    params: [
        // grid cells per tile of the coarsest layer (integer → seamless)
        { key: 'scale', kind: 'number', min: 1, max: 200, step: 1, default: 24 },
        // spot diameter relative to a cell; with several layers the finer ones are smaller
        { key: 'size', kind: 'number', min: 0.05, max: 1.6, step: 0.01, default: 0.7 },
        { key: 'density', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
        // size variation: 0 = all spots equal, 1 = from tiny to `size`
        { key: 'variation', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
        { key: 'layers', kind: 'number', min: 1, max: 3, step: 1, default: 2 },
        // 0 = angular chips, 1 = round/oval spots
        { key: 'roundness', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
        { key: 'elongation', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
        { key: 'softness', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.1 },
        // per-spot colour variation
        { key: 'tone', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
        { key: 'a', kind: 'color', default: '#b9b4ab' },
        { key: 'b', kind: 'color', default: '#2b2927' },
    ],
    evaluate(port, p, get) {
        const s = Math.max(1, Math.round(p.scale));
        const layers = Math.min(Math.max(Math.round(p.layers), 1), 3);
        const o = {
            size: p.size, density: p.density, variation: Math.min(Math.max(p.variation, 0), 1),
            roundness: Math.min(Math.max(p.roundness, 0), 1), elongation: Math.min(Math.max(p.elongation, 0), 1),
            softness: Math.min(Math.max(p.softness, 0), 1),
        };
        const uv = coord(get);
        // finest layer first, coarser ones on top
        let mask = float(0), height = float(0), rand = float(0.5), shade = float(1);
        for (let k = layers - 1; k >= 0; k--) {
            const l = spots(uv, s * 2 ** k, o, 7 * k);
            rand = mix(rand, l.rand, l.mask);
            shade = mix(shade, l.shade, l.mask);
            height = max(height.mul(float(1).sub(l.mask)), l.height.mul(0.8 ** k));
            mask = max(mask, l.mask);
        }
        if (port === 'random') return T(rand, 'float');
        if (port === 'value') return T(clamp(height, 0, 1), 'float');
        const a = input(get, 'a', 'color', p.a), b = input(get, 'b', 'color', p.b);
        // round spots get darker towards the rim (pebbles), flat chips stay flat
        const spot = vary(tsl(b), rand, p.tone).mul(mix(float(1 - 0.2 * o.roundness), float(1), shade));
        return T(mix(tsl(a), spot, mask), 'color');
    },
};

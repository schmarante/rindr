// Seeded, tileable noise helpers for the marble node (gradient noise, fbm, Worley, Voronoi regions) – period =
// cells per tile.
// Gradient noise instead of node-lib's value noise: its zero crossings are smooth curves without the grid-aligned
// kinks of value noise, which matters because marble veins are drawn along those crossings.
import { Fn, Loop, int, float, vec2, vec3, vec4, floor, fract, dot, mix, cos, sin, sqrt, min, max, abs, step } from 'three/tsl';
import { wrap, hash2, hash22, hash33 } from '../node-lib.js';

const TAU = 6.283185307;

// Both noise functions are real WGSL functions (setLayout) – inlined they made the shader so large that the first
// compile took many seconds.

/** tileable gradient noise, signed (≈ −1..1); seed = independent stream */
export const gnoise = Fn(([p, period, seed]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
    const g = o => {
        const a = hash2(wrap(i.add(o), period), seed).mul(TAU);
        return dot(vec2(cos(a), sin(a)), f.sub(o));
    };
    const n = mix(mix(g(vec2(0, 0)), g(vec2(1, 0)), u.x), mix(g(vec2(0, 1)), g(vec2(1, 1)), u.x), u.y);
    return n.mul(1.4);
}).setLayout({ name: 'marbleNoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }, { name: 'period', type: 'vec2' }, { name: 'seed', type: 'float' }] });

/** two independent tileable gradient noises at once (shared lattice hashes), signed (≈ −1..1) */
export const gnoise2 = Fn(([p, period, seed]) => {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
    const g = o => {
        const h = hash33(vec3(wrap(i.add(o), period), seed)).xy.mul(TAU);
        const d = f.sub(o);
        return vec2(dot(vec2(cos(h.x), sin(h.x)), d), dot(vec2(cos(h.y), sin(h.y)), d));
    };
    const n = mix(mix(g(vec2(0, 0)), g(vec2(1, 0)), u.x), mix(g(vec2(0, 1)), g(vec2(1, 1)), u.x), u.y);
    return n.mul(1.4);
}).setLayout({ name: 'marbleNoise2', type: 'vec2', inputs: [{ name: 'p', type: 'vec2' }, { name: 'period', type: 'vec2' }, { name: 'seed', type: 'float' }] });

/** fractal sum of gradient noise, signed (≈ −1..1); period: vec2 node (cells per tile of the first octave) */
export function fbmS(p, period, octaves, seed, gain = 0.5) {
    let sum = float(0);
    let amp = 1, norm = 0;
    for (let o = 0; o < Math.max(1, octaves); o++) {
        const f = 2 ** o;
        sum = sum.add(gnoise(p.mul(f), period.mul(f), float(seed).add(o * 7)).mul(amp));
        norm += amp;
        amp *= gain;
    }
    return sum.div(norm);
}

/** like fbmS, two independent noises at once (vec2) */
export function fbm2S(p, period, octaves, seed, gain = 0.5) {
    let sum = vec2(0, 0);
    let amp = 1, norm = 0;
    for (let o = 0; o < Math.max(1, octaves); o++) {
        const f = 2 ** o;
        sum = sum.add(gnoise2(p.mul(f), period.mul(f), float(seed).add(o * 7)).mul(amp));
        norm += amp;
        amp *= gain;
    }
    return sum.div(norm);
}

/**
 * Tileable Worley noise with a seed: { f1, f2 } distances (cells) to the nearest / second nearest feature point and
 * { cell } the wrapped index of the nearest cell.
 */
export function worleyS(p, period, seed, jitter = 0.9) {
    const i = floor(p);
    const f = fract(p);
    let f1 = float(8), f2 = float(8), cell = vec2(0, 0);
    for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
            const o = vec2(x, y);
            const id = wrap(i.add(o), period);
            const pt = o.add(hash22(id, seed).sub(0.5).mul(jitter)).add(0.5);
            const d = sqrt(dot(pt.sub(f), pt.sub(f))).toVar();
            f2 = min(f2, max(f1, d)).toVar();
            cell = mix(cell, id, step(d, f1)).toVar();
            f1 = min(f1, d).toVar();
        }
    }
    return { f1, f2, cell };
}

/**
 * Voronoi regions: every cell gets two group codes; cells of one group form a region. cell(cellIndex) → vec4
 * (feature point offset 0..1 in xy, group codes in z and w). Returns a vec4: f1, f2 (distances in cells to the
 * nearest / second nearest feature point), and for both codes ≈ 2 × the distance to the nearest cell of another
 * group, i.e. to the region boundary – smooth distance fields along branching, cracked lines (reliable up to
 * about one cell). Runtime loops (two passes over the 3×3 neighbours): unrolled, the shader got so large that its
 * first compile took seconds.
 */
export function voronoiRegions(p, period, cell, jitter = 0.9) {
    return Fn(() => {
        const i = floor(p).toVar();
        const f = fract(p).toVar();
        const visit = body => Loop({ start: int(-1), end: int(1), type: 'int', condition: '<=', name: 'y' }, ({ y }) => {
            Loop({ start: int(-1), end: int(1), type: 'int', condition: '<=', name: 'x' }, ({ x }) => {
                const o = vec2(float(x), float(y));
                const ci = cell(wrap(i.add(o), period)).toVar();
                const pt = o.add(ci.xy.sub(0.5).mul(jitter)).add(0.5);
                const d = sqrt(dot(pt.sub(f), pt.sub(f))).toVar();
                body(d, ci);
            });
        });
        const f1 = float(8).toVar(), f2 = float(8).toVar(), k1 = vec2(0, 0).toVar();
        visit((d, ci) => {
            const lt = step(d, f1).toVar();
            k1.assign(mix(k1, ci.zw, lt));
            f2.assign(min(f2, max(f1, d)));
            f1.assign(min(f1, d));
        });
        // distance to the nearest cell of another group (d_j − f1 ≈ 2 × distance to the bisector)
        const edge = vec2(8, 8).toVar();
        visit((d, ci) => {
            edge.assign(min(edge, vec2(d.sub(f1)).add(step(abs(ci.zw.sub(k1)), vec2(0.5)).mul(8))));
        });
        return vec4(f1, f2, edge);
    })();
}

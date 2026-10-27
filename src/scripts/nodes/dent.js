// Dent: tileable dents and pits for bump maps – hammered metal, dented or pitted surfaces, rough cast.
// Every cell of a jittered grid may hold a round dent (paraboloid, random radius and depth); where dents overlap
// the deepest wins, so dense dents meet in sharp ridges (hammered facets) and sparse ones stay single pits.
// `detail` adds finer dent layers on top, `distort` bends the grid with noise so the dents lose their round shape.
// value: 1 = untouched surface, lower = deeper in a dent; color mixes a (deepest) and b (surface).
import { float, vec2, vec3, floor, fract, dot, max, mix, clamp, select } from 'three/tsl';
import { T, coord, input, tsl, wrap, hash33 } from '../node-lib.js';
import { gradientNoise } from './noise-gradient.js';

/** depth 0..1 of one dent layer at p (in cells); period = cells per tile */
function dentLayer(p, period, seed, size, density) {
    const i = floor(p);
    const f = fract(p);
    let depth = float(0);
    for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
            const o = vec2(x, y);
            const h = hash33(vec3(wrap(i.add(o), period), seed));
            const d = f.sub(o.add(h.xy));
            const r = mix(0.55, 1, h.z).mul(size);          // radius ≤ 1 cell: the 3×3 neighbourhood suffices
            let dent = max(float(1).sub(dot(d, d).div(r.mul(r))), 0).mul(mix(0.6, 1, h.z));
            if (density < 1) {
                const keep = hash33(vec3(wrap(i.add(o), period), seed + 1)).x.lessThan(density);
                dent = select(keep, dent, float(0));
            }
            depth = max(depth, dent);
        }
    }
    return depth;
}

export default {
    type: 'dent',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
    outputs: [{ key: 'value', type: 'float' }, { key: 'color', type: 'color' }],
    params: [
        { key: 'scale', kind: 'number', min: 1, max: 100, step: 1, default: 10 },          // dents per tile (largest layer)
        { key: 'size', kind: 'number', min: 0.2, max: 1, step: 0.05, default: 0.9 },       // dent radius in cells
        { key: 'density', kind: 'number', min: 0, max: 1, step: 0.05, default: 1 },        // share of cells with a dent
        { key: 'strength', kind: 'number', min: 0, max: 1, step: 0.05, default: 1 },       // dent depth
        { key: 'detail', kind: 'number', min: 1, max: 4, step: 1, default: 2 },            // dent layers, each twice as fine
        { key: 'distort', kind: 'number', min: 0, max: 1, step: 0.05, default: 0.3 },      // irregular dent shapes
        { key: 'seed', kind: 'number', min: 0, max: 100, step: 1, default: 0 },
        { key: 'a', kind: 'color', default: '#3a3a3a' },
        { key: 'b', kind: 'color', default: '#d0d0d0' },
    ],
    evaluate(port, p, get) {
        const s = Math.max(1, Math.round(p.scale));
        const seed = Math.round(p.seed) * 32;   // each layer uses seed + 0..15, the distortion seed + 16..31
        const size = Math.min(Math.max(p.size, 0.2), 1);
        const uv = coord(get);
        let sum = float(0);
        let w = 1, norm = 0;
        for (let o = 0; o < Math.max(1, Math.round(p.detail)); o++) {
            const n = s * 2 ** o;
            // finer dents would only alias in the bake: weight 0 – kept in the shader, so a changed scale does not
            // change the code (no new compile, material-graph.js uniformConstants)
            const on = !(o > 0 && n > 256);
            let q = uv.mul(n);
            if (p.distort > 0) {
                // bend the grid: two noise fields with cells about twice the dent size, offset ≤ distort × ½ cell
                const np = [Math.max(1, Math.round(n / 2)), Math.max(1, Math.round(n / 2))];
                const nq = uv.mul(vec2(...np));
                q = q.add(vec2(gradientNoise(nq, vec2(...np), float(seed + 16 + 2 * o)),
                    gradientNoise(nq.add(vec2(3.7, 1.3)), vec2(...np), float(seed + 17 + 2 * o))).mul(p.distort * 0.5 * n / np[0]));
            }
            sum = sum.add(dentLayer(q, vec2(n, n), seed + o * 2, size, p.density).mul(on ? w : 0));
            if (on) norm += w;
            w *= 0.5;
        }
        const v = clamp(float(1).sub(sum.mul(p.strength / norm)), 0, 1);
        if (port !== 'color') return T(v, 'float');
        return T(mix(tsl(input(get, 'a', 'color', p.a)), tsl(input(get, 'b', 'color', p.b)), v), 'color');
    },
};

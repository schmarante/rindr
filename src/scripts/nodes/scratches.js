// Scratches: fine straight micro scratches in random directions – swirl marks ("holograms") on polished paint and
// polished metal. The circles around every highlight are an illusion of thousands of short straight scratches: each
// stretches the reflection across itself, and around a light the scratches lying across the line to it light up.
// So the scratches drive anisotropy (output node: coat anisotropy + its direction), not a bump (that flickers).
//
// Each layer is a jittered grid with at most one scratch per cell (probability `density`): a segment through a random
// point, random angle, length `length` cells (shorter by `variation`), tapering at its ends. Always straight: the
// rings are the illusion – of a straight scratch that is smooth along and rough across (anisotropy 1) only one tiny
// spot reflects a light, where it lies across the line to it; thousands of them form the round rings (bent lines
// were tried and are wrong). A scratch thinner than a texel is baked one texel wide at full strength – a texel is
// scratched or not: the path tracer then mixes the smooth and the scratched lobe per sample (right on average); a
// weakened value would interpolate roughness and anisotropy instead – a much shorter streak. Where scratches cross,
// their directions are averaged as doubled angles (a direction repeats after 180°). How much shows overall: density
// and layers.
//
// The neighbour search reaches as far as the longest scratch (3×3 cells up to length 2, 5×5 up to 4, 7×7 up to 6) –
// runtime loops in one shader function per reach (unrolled, 7×7 × 8 layers made a huge shader); values as arguments
// (material-graph.js uniformConstants: a slider re-bakes without a new shader).
//
// value: coverage 0 (clean) … 1 (scratched) – coat anisotropy strength, extra roughness;
// direction: 0..1 = 0..180°, ACROSS the scratches (the way the reflection stretches – straight into the output's
// anisotropy direction), between them that of the nearest scratches (anisotropy over the whole surface possible);
// random: per scratch of the topmost.
import { Fn, Loop, int, float, vec2, vec3, vec4, floor, fract, dot, max, clamp, smoothstep, sqrt, cos, sin, atan, exp, select } from 'three/tsl';
import { T, coord, wrap, hash33 } from '../node-lib.js';

const MAX_LENGTH = 6;
const layerFns = new Map();

/** one layer of scratches (one shader function per neighbour reach): vec4(coverage, doubled-angle x, y, random) */
function layerFn(reach) {
    if (!layerFns.has(reach)) layerFns.set(reach, Fn(([uv, s, seed, density, length, thickness, variation, aa]) => {
        const p = uv.mul(s);
        const i = floor(p).toVar();
        const f = fract(p).toVar();
        const cov = float(0).toVar(), vx = float(0).toVar(), vy = float(0).toVar(), rand = float(0).toVar();
        Loop({ start: int(-reach), end: int(reach), type: 'int', condition: '<=', name: 'y' }, ({ y }) => {
            Loop({ start: int(-reach), end: int(reach), type: 'int', condition: '<=', name: 'x' }, ({ x }) => {
                const o = vec2(float(x), float(y));
                const id = wrap(i.add(o), s);
                const h0 = hash33(vec3(id, seed)).toVar();            // exists, centre x/y
                const h1 = hash33(vec3(id, seed.add(1))).toVar();     // angle, length, strength
                const exists = select(h0.x.lessThan(density), float(1), float(0));
                const half = length.mul(0.5).mul(float(1).sub(h1.y.mul(variation)));
                const v = f.sub(o.add(h0.yz));                         // this point relative to the scratch's centre
                const a = h1.x.mul(Math.PI);
                const dir = vec2(cos(a), sin(a));
                // along / across the straight segment
                const t = dot(v, dir);
                const d = v.sub(dir.mul(clamp(t, half.negate(), half))).length();
                // width: at least one texel (full strength – see above)
                const w = max(thickness.mul(0.5), aa);
                const edge = float(1).sub(smoothstep(w.mul(0.5), w, d));
                const taper = sqrt(clamp(float(1).sub(t.div(half.max(1e-4)).pow2()), 0, 1));   // fades at its ends
                const vis = float(1).sub(h1.z.mul(variation).mul(0.6));
                const m = edge.mul(taper).mul(vis).mul(exists).toVar();
                cov.addAssign(m);
                // direction weight: the scratch itself, and faintly its surroundings – between the scratches the
                // direction of the nearest ones
                const wd = m.add(exp(d.mul(-6)).mul(taper).mul(vis).mul(0.02).mul(exists));
                vx.addAssign(cos(a.mul(2)).mul(wd));
                vy.addAssign(sin(a.mul(2)).mul(wd));
                rand.assign(select(m.greaterThan(0.05), h1.y, rand));
            });
        });
        return vec4(cov, vx, vy, rand);
    }));
    return layerFns.get(reach);
}

export default {
    type: 'scratches',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }],
    outputs: [{ key: 'value', type: 'float' }, { key: 'direction', type: 'float' }, { key: 'random', type: 'float' }],
    params: [
        // grid cells per tile (integer → seamless); the scratch length is given in cells
        { key: 'scale', kind: 'number', min: 1, max: 200, step: 1, default: 40 },
        { key: 'density', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.7 },
        // scratches per cell (layers of the grid with their own random positions)
        { key: 'layers', kind: 'number', min: 1, max: 8, step: 1, default: 3 },
        // length in cells (the neighbour search grows with it – longer scratches bake slower)
        { key: 'length', kind: 'number', min: 0.1, max: MAX_LENGTH, step: 0.01, default: 1.6 },
        // width in cells (real scratches are finer than a texel – then one texel)
        { key: 'thickness', kind: 'number', min: 0.001, max: 0.2, step: 0.001, default: 0.005 },
        // shorter and fainter scratches mixed in
        { key: 'variation', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.6 },
        { key: 'seed', kind: 'number', min: 0, max: 100, step: 1, default: 0 },
    ],
    evaluate(port, p, get, ctx) {
        const s = Math.max(1, Math.round(p.scale));
        const layers = Math.min(Math.max(Math.round(p.layers), 1), 8);
        const length = Math.min(Math.max(p.length, 0.1), MAX_LENGTH);
        // cells a scratch reaches from its centre (the centre lies anywhere in its cell)
        const fn = layerFn(Math.max(1, Math.ceil(length * 0.5)));
        // one texel of the bake in cells
        const aa = float(0.75 * s / (ctx?.bakeSize || 1024));
        const uv = coord(get);
        let cov = float(0), vx = float(0), vy = float(0), rand = float(0.5);
        for (let k = 0; k < layers; k++) {
            const l = fn(uv, float(s), float(11 * k + 3 * Math.round(p.seed ?? 0)), float(p.density), float(length),
                float(Math.max(p.thickness, 0.0005)), float(Math.min(Math.max(p.variation, 0), 1)), aa).toVar();
            cov = cov.add(l.x);
            vx = vx.add(l.y);
            vy = vy.add(l.z);
            rand = select(l.x.greaterThan(0.05), l.w, rand);
        }
        if (port === 'random') return T(rand, 'float');
        if (port === 'direction') {
            // mean scratch angle (doubled-angle average), turned by 90°: across the scratches; 0..1 = 0..180°
            const angle = atan(vy, vx.add(1e-6)).mul(0.5);
            return T(fract(angle.div(Math.PI).add(0.5)), 'float');
        }
        return T(clamp(cov, 0, 1), 'float');
    },
};

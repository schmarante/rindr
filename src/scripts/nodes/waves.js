// Waves: parallel profiles and stripes (corrugated and trapezoidal sheet, standing seam, ribbed panels, lap siding,
// slats, wall covering stripes) and circular water ripples.
//
// Stripes: the coordinate along `axis` times `count` gives the stripe phase t (integer count → seamless); the profile
// is a function of the position inside one period (crest in the middle). Square / trapezoid / seam are a linear
// flank clamped to 0..1 with a polynomial soft clamp (`softness` rounds the bends); `width` is the share of the raised
// part at half height, `slope` the share of one flank (trapezoid, sawtooth; seam: a quarter). `distortion` shifts t by tileable
// noise (organic, wobbly stripes). Ripples: `count` × `count` cells per tile, each with `centres` drop centres that
// send out rings of the given `wavelength` (share of a cell); every ring fades out within one cell, so only the
// 3 × 3 neighbour cells contribute and the cell index wraps → seamless.
//
// value = height profile 0..1 (feed it into the output's height → normal map), color = mix(a, b, value) varied per
// stripe, random = per stripe (ripples: per cell), uv = input coordinate shifted per stripe (following nodes vary
// per stripe/slat and stay seamless).
import { Fn, Loop, vec2, vec3, float, fract, floor, abs, min, max, clamp, cos, sin, sqrt, exp, dot, select, fwidth, mix } from 'three/tsl';
import { T, coord, input, tsl, fbm, wrap, hash2, hash33, vary } from '../node-lib.js';

const TAU = Math.PI * 2;

/** polynomial smooth minimum / maximum (k = blend width in value units, > 0) */
const smin = (a, b, k) => {
    const h = max(float(k).sub(abs(a.sub(b))), 0).div(k);
    return min(a, b).sub(h.mul(h).mul(k * 0.25));
};
const smax = (a, b, k) => {
    const h = max(float(k).sub(abs(a.sub(b))), 0).div(k);
    return max(a, b).add(h.mul(h).mul(k * 0.25));
};
/** clamp to 0..1 with rounded corners */
const softClamp = (x, k) => smin(smax(x, float(0), k), float(1), k);
/** |x| with a parabolic bottom of half width k (equal to |x| outside) */
const softAbs = (x, k) => select(abs(x).lessThan(k), x.mul(x).div(2 * k).add(k / 2), abs(x));

/** stripe profile 0..1 over the phase t (one period per unit, crest at t = n + ½) */
function stripeProfile(t, p) {
    const q = fract(t).sub(0.5);              // −½..½, 0 = crest
    const r = abs(q);                          // distance to the crest
    const aa = fwidth(t).mul(0.75);            // ~1 px in period units (anti-aliased edges)
    const hw = Math.min(Math.max(p.width, 0.02), 0.98) * 0.5;        // half width of the raised part at half height
    const room = Math.min(hw, 0.5 - hw) * 2;                          // flank may not eat the plateaus
    const soft = Math.min(Math.max(p.softness, 0), 1);
    switch (p.profile) {
        case 'triangle': {
            const k = Math.max(soft * 0.2, 1e-4);
            const qv = fract(t.add(0.5)).sub(0.5);                     // signed distance to the valley
            const h = select(r.lessThan(0.25), float(1).sub(softAbs(q, k).mul(2)), softAbs(qv, k).mul(2));
            return h.sub(k).div(1 - 2 * k);
        }
        case 'square': {
            // soft edges: flank grows with softness and is fully rounded (S-curve)
            const fl = max(aa, float(soft * room * 0.35));
            return softClamp(float(hw).add(fl.mul(0.5)).sub(r).div(fl), soft > 0 ? 1 : 0.3);
        }
        case 'trapezoid': {
            const fl = max(aa, float(Math.min(Math.max(p.slope, 0), room * 0.95)));
            return softClamp(float(hw).add(fl.mul(0.5)).sub(r).div(fl), Math.max(soft, 0.05));
        }
        case 'seam': {
            // narrow raised seam on a flat pan: steep flanks, rounded (folded) top, small fillet at the foot
            const fl = max(aa, float(Math.min(Math.max(p.slope, 0) * 0.25, room * 0.95)));
            const body = softClamp(float(hw).add(fl.mul(0.5)).sub(r).div(fl), 0.35);
            const dome = sqrt(max(float(1).sub(r.div(hw).mul(r.div(hw))), 0));
            return body.mul(mix(float(1), float(0.8).add(dome.mul(0.2)), soft));
        }
        case 'sawtooth': {
            // board rises slowly over the period and drops at the lower edge (lap siding); softness rounds the edge
            const x = fract(t);
            const f = max(aa, float(Math.min(Math.max(p.slope, 0), 0.5)));
            const up = x.div(float(1).sub(f)), down = float(1).sub(x).div(f);
            return clamp(smin(up, down, Math.max(soft * 0.6, 1e-3)), 0, 1);
        }
        default:   // sine
            return float(0.5).add(cos(q.mul(TAU)).mul(0.5));
    }
}

/** circular water ripples, tileable; returns { h, cell } */
function ripples(c, p, n, warp) {
    const pc = c.mul(n).add(warp);
    const i = floor(pc), f = fract(pc);
    const centres = Math.min(Math.max(Math.round(p.centres), 1), 8);
    const lambda = Math.min(Math.max(p.wavelength, 0.01), 0.5);
    const seed = Math.round(p.seed) * 16;
    // runtime loop (3 × 3 neighbour cells × centres): unrolled, the shader took ~0.6 s to compile
    const h = Fn(() => {
        const sum = float(0).toVar();
        Loop({ start: 0, end: 9, type: 'int', name: 'k' }, { start: 0, end: centres, type: 'int', name: 'j' }, ({ k, j }) => {
            const o = vec2(float(k.mod(3)).sub(1), float(k.div(3)).sub(1));
            const id = wrap(i.add(o), n);
            const s = float(j).mul(2).add(seed);
            const h1 = hash33(vec3(id, s));
            const h2 = hash33(vec3(id, s.add(1)));
            const d = o.add(h1.xy).sub(f);
            const dist = sqrt(dot(d, d));
            // fades to zero (with slope) at one cell → only neighbours count, seams stay invisible
            const w = max(float(1).sub(dist.mul(dist)), 0);
            const front = h2.x.mul(0.6).add(0.2);                       // radius of the strongest ring (age)
            const band = dist.sub(front).div(0.18);
            const amp = w.mul(w).mul(exp(band.mul(band).negate()).mul(0.85).add(0.15)).mul(h1.z.mul(0.6).add(0.4));
            const wl = h2.y.mul(0.4).add(0.8).mul(lambda);
            sum.addAssign(sin(dist.div(wl).mul(TAU).sub(h2.z.mul(TAU))).mul(amp));
        });
        return clamp(sum.div(Math.sqrt(centres) * 1.1).mul(0.5).add(0.5), 0, 1);
    })();
    return { h, cell: wrap(i, n) };
}

export default {
    type: 'waves',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
    outputs: [
        { key: 'value', type: 'float' }, { key: 'color', type: 'color' },
        { key: 'random', type: 'float' }, { key: 'uv', type: 'vector' },
    ],
    params: [
        { key: 'profile', kind: 'select', options: ['sine', 'triangle', 'square', 'trapezoid', 'seam', 'sawtooth', 'ripples'], default: 'sine' },
        { key: 'count', kind: 'number', min: 1, max: 200, step: 1, default: 12 },
        { key: 'axis', kind: 'select', options: ['u', 'v'], default: 'u' },
        { key: 'width', kind: 'number', min: 0.02, max: 0.98, step: 0.01, default: 0.5 },       // raised share
        { key: 'slope', kind: 'number', min: 0, max: 0.5, step: 0.01, default: 0.15 },           // flank share
        { key: 'softness', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
        { key: 'distortion', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },
        { key: 'centres', kind: 'number', min: 1, max: 8, step: 1, default: 3 },                  // ripples per cell
        { key: 'wavelength', kind: 'number', min: 0.01, max: 0.5, step: 0.01, default: 0.1 },     // share of a cell
        { key: 'variation', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },             // colour per stripe
        { key: 'seed', kind: 'number', min: 0, max: 100, step: 1, default: 0 },
        { key: 'a', kind: 'color', default: '#7d848a' },
        { key: 'b', kind: 'color', default: '#c4c9cd' },
    ],
    evaluate(port, p, get) {
        const c = coord(get);
        const n = Math.max(1, Math.round(p.count));
        const seed = Math.round(p.seed);
        const dist = Math.min(Math.max(p.distortion, 0), 1);
        // tileable wobble: ± one stripe period at distortion 1
        const noise = s => fbm(c.mul(4).add(s), vec2(4, 4), 3).sub(0.5).mul(2 * dist);

        let h, cell;
        if (p.profile === 'ripples') {
            const warp = dist ? vec2(noise(seed * 0.37), noise(seed * 0.37 + 17.3)).mul(0.15) : vec2(0, 0);
            ({ h, cell } = ripples(c, p, n, warp));
        } else {
            const along = p.axis === 'v' ? c.y : c.x;
            let t = along.mul(n);
            if (dist) t = t.add(noise(seed * 0.37));
            h = clamp(stripeProfile(t, p), 0, 1);
            const idx = wrap(floor(t), n);
            cell = vec2(idx, 0);
        }

        if (port === 'value') return T(h, 'float');
        const rnd = hash2(cell, seed + 101);
        if (port === 'random') return T(rnd, 'float');
        if (port === 'uv') return T(c.add(vec2(rnd, hash2(cell, seed + 202)).mul(7.31)), 'vector');
        const a = tsl(input(get, 'a', 'color', p.a)), b = tsl(input(get, 'b', 'color', p.b));
        return T(vary(mix(a, b, h), rnd, Math.min(Math.max(p.variation, 0), 1)), 'color');
    },
};

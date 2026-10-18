// Wood: growth rings, cathedral figure and pores of sawn timber; the grain (fibre direction) runs along u.
//
// The rings are the contour lines of a ring phase (in rings) over the board:
//  - cut 'flat' (flat-sawn): the board face lies at distance D0 from the pith, radius R ≈ √(D0² + x²) with x = distance
//    from the board centre line (a superellipse, see Q). A sawtooth along u adds `arches` whole rings per tile – the
//    rings slide towards the centre line and close there into nested cathedral arches, all pointing the same way.
//    Because the sawtooth jumps by whole rings the pattern stays continuous. R is even in x: across v the tile repeats
//    mirrored at its edge (like book-matched veneer); the fold there is rounded, so it reads as a flat counter-arch,
//    not as a crease.
//  - cut 'quarter' (quarter-sawn / rift): phase = rings · v – straight, parallel stripes (rings per tile integer).
// Both get a periodic warp (irregularity), irregular ring widths and a varying late wood share. Within a ring the
// light early wood turns gradually into dark late wood and ends abruptly at the next ring. Pores are fine dark dashes
// along u, crowded into the early wood (ring-porous look) and sparse elsewhere; fibres and a slow colour drift add life.
import { Fn, float, vec2, vec3, floor, fract, abs, sqrt, pow, sin, mix, clamp, smoothstep, min, max } from 'three/tsl';
import { T, tsl, coord, input, periodicNoise } from '../node-lib.js';

const TAU = Math.PI * 2;
const D0 = 0.4;      // pith distance of the flat-sawn board face (tile widths)
const FOLD = 0.06;   // rounding of the mirror fold at the tile edge (tile widths)
const Q = 2.5;       // superellipse exponent of the ring radius (2 = circle)

// periodic noise as a real shader function (layout) instead of inlined code: the node uses it ~16 times; inlined,
// the shader got several times larger and its first compile took over a second
const pnoise = Fn(([p, period]) => periodicNoise(p, period), { p: 'vec2', period: 'vec2', return: 'float' });
function pfbm(p, period, octaves) {
    let sum = float(0), amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
        sum = sum.add(pnoise(p.mul(2 ** o), period.mul(2 ** o)).mul(amp));
        norm += amp;
        amp *= 0.5;
    }
    return sum.div(norm);
}

export default {
    type: 'wood',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
    outputs: [
        { key: 'color', type: 'color' },
        { key: 'value', type: 'float' },   // relief: late wood high, early wood and pores low
        { key: 'ring', type: 'float' },    // late wood share 0..1 (e.g. for roughness)
        { key: 'pores', type: 'float' },   // pore mask 0..1
    ],
    params: [
        { key: 'cut', kind: 'select', options: ['flat', 'quarter'], default: 'flat' },
        { key: 'rings', kind: 'number', min: 2, max: 150, step: 1, default: 36 },   // growth rings per tile (across v)
        { key: 'arches', kind: 'number', min: 0, max: 12, step: 1, default: 4 },    // cathedral arches per tile (flat cut)
        { key: 'irregularity', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
        { key: 'stretch', kind: 'number', min: 1, max: 10, step: 1, default: 4 },   // elongation of all features along u
        { key: 'latewood', kind: 'number', min: 0.05, max: 0.9, step: 0.01, default: 0.35 },   // late wood share per ring
        { key: 'contrast', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.8 },
        { key: 'pores', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
        { key: 'seed', kind: 'number', min: 0, max: 99, step: 1, default: 0 },
        { key: 'a', kind: 'color', default: '#d2a26a' },   // early wood
        { key: 'b', kind: 'color', default: '#8c5a30' },   // late wood
    ],
    evaluate(port, p, get) {
        const uvc = coord(get);
        const u = uvc.x, v = uvc.y;
        const rings = Math.max(2, Math.round(p.rings));
        const irr = p.irregularity;
        const st = Math.max(1, Math.round(p.stretch));
        const seed = Math.round(p.seed);
        const flat = p.cut !== 'quarter';
        // periodic noise over the tile (nu × nv cells); salt + seed shift by whole cells -> independent, still periodic
        const noise = (salt, nu, nv, oct = 1) => {
            const P = vec2(nu, nv);
            const q = vec2(u.mul(nu), v.mul(nv)).add(vec2(salt * 101 + seed * 17, salt * 53 + seed * 31));
            return pfbm(q, P, oct);
        };
        const cu = n => Math.max(1, Math.round(n / st));   // cells along u for a base count (stretch elongates)
        const noise1 = (x, period, salt) => pnoise(vec2(x.add(salt * 37 + seed * 7), 0), vec2(period, 1));

        // --- ring phase ---
        // warp in rings: slow bends + a little wobble
        const warp = noise(1, cu(8), 5, 2).sub(0.5).mul(irr * 1.4)
            .add(noise(2, cu(32), 21).sub(0.5).mul(irr * 0.3));
        let rad, P, sweep = null;   // P: period of the phase functions (quarter: rings per tile; flat: free)
        if (flat) {
            // radius as a superellipse (D0^q + x^q)^(1/q), q > 2: flatter than a circle near the centre line -> round
            // U-shaped arch tips instead of pointed ones
            const k = rings / (2 * ((D0 ** Q + 0.5 ** Q) ** (1 / Q) - D0));   // rings per tile width of radius
            // centre line wanders along u; rounded fold at the edge
            const x = abs(fract(v.add(noise(3, 2, 1).sub(0.5).mul(0.16))).sub(0.5));
            const e = float(0.5).sub(x);
            const ax = float(0.5 + FOLD).sub(sqrt(e.mul(e).add(FOLD * FOLD)));
            rad = pow(pow(ax, Q).add(D0 ** Q), 1 / Q).mul(k).add(warp);
            P = 64;
            const m = Math.max(0, Math.round(p.arches));
            // sawtooth: m whole rings per tile. Its speed varies strongly along u (s' = 1 ± 0.6 ± 0.25, stays positive):
            // the arch tips cluster into a cathedral and leave long calm stretches; the phase of that wave drifts across
            // v so the arches are skewed. Any jump of fract() is a whole number of rings -> no seam.
            if (m) {
                const ph = noise(4, 1, 2).add(seed * 0.37).mul(TAU);
                const s = u.add(sin(u.mul(TAU).add(ph)).mul(0.6 / TAU)).add(sin(u.mul(2 * TAU).add(ph.mul(1.7))).mul(0.25 / (2 * TAU)));
                sweep = fract(s).mul(m);
            }
        } else {
            rad = v.mul(rings).add(warp);
            P = rings;
        }
        // irregular ring widths (periodic in the phase with P -> stays seamless)
        // + fine streaks along u: ragged, fibrous ring boundaries
        const streak = noise(10, cu(32), 300).sub(0.5);
        const g0 = rad.add(noise1(rad, P, 1).sub(0.5).mul(irr * 1.2)).add(streak.mul(0.06 + irr * 0.08));
        const g = sweep ? g0.add(sweep) : g0;
        const t = fract(g);
        // ring identity (continuous across the sawtooth jump): per ring random late wood share and tone
        const id = sweep ? floor(g).sub(sweep) : floor(g);
        const yr = noise1(id.add(0.5), P, 2);
        const lw = clamp(float(p.latewood).mul(yr.sub(0.5).mul(irr * 1.2).add(1)), 0.03, 0.95);
        // early wood -> late wood gradual, abrupt back at the ring boundary (slightly softened against aliasing)
        // some rings show strongly, others faintly
        const strength = float(1).sub(noise1(id.add(0.5), P, 3).mul(irr * 0.85));
        const late = smoothstep(float(1).sub(lw.mul(1.25)), float(1).sub(lw.mul(0.7)), t)
            .mul(float(1).sub(smoothstep(0.975, 1, t))).mul(strength);
        if (port === 'ring') return T(late, 'float');

        // --- pores: fine dark dashes along u, crowded into the early wood ---
        const pn = noise(5, cu(64), 480).mul(0.6).add(noise(6, cu(140), 820).mul(0.4));
        const zone = float(1).sub(smoothstep(0.08, 0.4, t)).mul(0.8).add(0.2);
        const th = float(1 - p.pores * 0.5).add(float(1).sub(zone).mul(0.22));
        const pores = p.pores > 0 ? smoothstep(th, th.add(0.06), pn).mul(min(zone.add(0.1), 1)) : float(0);
        if (port === 'pores') return T(pores, 'float');

        // fibres: fine silky streaks along u (they also break the late wood into lines); slow colour drift
        const fine = noise(7, cu(70), 512).mul(0.6).add(noise(11, cu(150), 800).mul(0.4));
        const fib = smoothstep(0.3, 0.7, fine).sub(0.5).add(noise(12, cu(16), 120).sub(0.5).mul(0.6));
        const drift = noise(8, cu(4), 3, 2).sub(0.5);
        const lateS = clamp(late.mul(fib.mul(1.2).add(1)), 0, 1);
        if (port === 'value') {
            return T(clamp(float(0.55).add(lateS.mul(0.2)).add(fib.mul(0.08)).sub(pores.mul(0.5)), 0, 1), 'float');
        }

        const a = tsl(input(get, 'a', 'color', p.a)), b = tsl(input(get, 'b', 'color', p.b));
        let c = mix(a, b, lateS.mul(p.contrast));
        c = c.mul(float(1).add(yr.sub(0.5).mul(0.14 * irr)).add(drift.mul(0.25)).add(fib.mul(0.22)));
        c = mix(c, b.mul(0.55), pores.mul(0.65));
        return T(max(c, vec3(0)), 'color');
    },
};

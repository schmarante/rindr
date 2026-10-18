// Weave: textiles – woven fabric and carpet pile.
//
// Woven patterns: warp threads (colour a) run along v, weft threads (colour b) along u, `count` of each per tile.
// The pattern decides per crossing which thread lies on top. Each thread's centre line keeps its level over a
// crossing and bends over near the next one; a short float (over one thread only) is pulled lower than a long one,
// so warp-faced weaves (denim, satin) mostly show the warp. Threads have a round cross section, lie wider when on
// top and may spread over the cell border, so the own and the nearer neighbouring warp / weft are evaluated and the
// highest one is seen; where none is, the dark gap shows. Yarn twist stripes, fibre noise stretched along the thread
// (fuzz: also frays the edges, hazes the gaps and mixes a little of the other colour into the fibres) and per-thread
// and slub thickness / colour variation make it look like cloth.
// Pile patterns (carpet / upholstery): `loop` = berber, rows of round yarn loops (columns staggered), two twisted
// plies a / b → flecked melange; `cut` = velours, cellular tufts with fibre tips seen end-on.
// Count is rounded to a multiple of the pattern repeat and all noise is periodic, so everything tiles seamlessly.
import { float, vec2, vec3, floor, fract, abs, sqrt, max, min, mix, clamp, step, smoothstep, select, length, pow } from 'three/tsl';
import { T, tsl, coord, input, wrap, hash2, hash33, periodicNoise, worley, vary } from '../node-lib.js';

/** modulo of an integer-valued index (robust against inexact GPU division: wrap() at the cell centre) */
const imod = (i, period) => wrap(i.add(0.5), period).sub(0.5);

// pattern -> repeat (threads) and "warp on top" at crossing (i, j) (integer-valued TSL floats, 1 = warp up)
const PATTERNS = {
    plain: { rep: 2, up: (i, j) => float(1).sub(imod(i.add(j), 2)) },
    twill: { rep: 4, up: (i, j) => float(1).sub(step(1.5, imod(i.add(j), 4))) },                   // 2/2
    denim: { rep: 4, up: (i, j) => float(1).sub(step(2.5, imod(i.sub(j), 4))) },                   // 3/1, warp-faced
    satin: { rep: 5, up: (i, j) => step(0.5, imod(i.mul(2).add(j), 5)) },                         // 5-end, warp-faced
    basket: { rep: 4, up: (i, j) => float(1).sub(imod(floor(i.add(0.5).mul(0.5)).add(floor(j.add(0.5).mul(0.5))), 2)) },   // 2×2 hopsack
    herringbone: {                                                                                  // 2/2 twill, reversing every 6 warps
        rep: 12,
        up: (i, j) => {
            const dir = float(1).sub(imod(floor(i.add(0.5).div(6)), 2).mul(2));
            return float(1).sub(step(1.5, imod(i.mul(dir).add(j), 4)));
        },
    },
    loop: { rep: 2 },
    cut: { rep: 1 },
};

/**
 * weight 0..½ of the next crossing's state at the distance k (0..½) from a crossing centre: the thread keeps its
 * level over most of the crossing and bends over in the last stretch (slope continuous across the cell border)
 */
const bend = k => { const x = clamp(k.sub(0.1).div(0.4), 0, 1); return x.mul(x).mul(0.5); };
/** triangle wave 0..1 */
const tri = x => abs(fract(x).sub(0.5)).mul(2);

export default {
    type: 'weave',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
    outputs: [
        { key: 'color', type: 'color' },
        { key: 'value', type: 'float' },     // height 0..1 (bump)
        { key: 'mask', type: 'float' },      // 1 = warp on top (pile: yarn, 0 = backing)
        { key: 'random', type: 'float' },    // per visible thread / tuft 0..1
    ],
    params: [
        { key: 'pattern', kind: 'select', options: Object.keys(PATTERNS), default: 'plain' },
        { key: 'count', kind: 'number', min: 2, max: 200, step: 1, default: 24 },        // threads (loops, tufts) per tile
        { key: 'gap', kind: 'number', min: 0, max: 0.8, step: 0.01, default: 0.15 },     // space between threads
        { key: 'fuzz', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },       // fibre noise, frayed edges
        { key: 'variation', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },  // thickness / colour per thread
        { key: 'a', kind: 'color', default: '#e6dccb' },     // warp (pile: main yarn)
        { key: 'b', kind: 'color', default: '#cfc2a8' },     // weft (pile: second ply)
    ],
    evaluate(port, p, get) {
        const pat = PATTERNS[p.pattern] || PATTERNS.plain;
        const n = Math.max(pat.rep, Math.round(p.count / pat.rep) * pat.rep);
        const a = tsl(input(get, 'a', 'color', p.a)), b = tsl(input(get, 'b', 'color', p.b));
        const q = coord(get).mul(n);
        const opt = { n, q, a, b, gap: p.gap, fuzz: p.fuzz, variation: p.variation };
        const r = pat.up ? woven(pat.up, opt) : p.pattern === 'loop' ? loopPile(opt) : cutPile(opt);
        if (port === 'value') return T(clamp(r.height, 0, 1), 'float');
        if (port === 'mask') return T(r.mask, 'float');
        if (port === 'random') return T(r.random, 'float');
        return T(r.color, 'color');
    },
};

function woven(up, { n, q, a, b, gap, fuzz, variation }) {
    const N = vec2(n, n);
    const cell = floor(q), f = fract(q);
    const i = imod(cell.x, n), j = imod(cell.y, n);
    // the nearer neighbouring warp / weft is evaluated too: threads on top spread over the cell border
    const sx = select(f.x.lessThan(0.5), float(-1), float(1)), sy = select(f.y.lessThan(0.5), float(-1), float(1));
    const iX = imod(i.add(sx), n), jY = imod(j.add(sy), n);
    const kx = bend(abs(f.x.sub(0.5))), ky = bend(abs(f.y.sub(0.5)));
    const half = (1 - gap) * 0.5;
    const slubN = Math.max(1, Math.round(n / 3));   // slubs (thicker / thinner stretches) about 3 crossings long
    // fibre noise stretched along warp / weft (shared by both candidates of a direction)
    const fibW = periodicNoise(vec2(q.x.mul(9), q.y.mul(2)), vec2(n * 9, n * 2));
    const fibF = periodicNoise(vec2(q.x.mul(2), q.y.mul(9)), vec2(n * 2, n * 9));

    // one thread: across = offset from its axis (cells), along = coordinate along it, idx = thread index,
    // lift = centre line height 0 (under) .. 1 (over), seed = independent random stream; the brightest fibres take
    // on a little of the other colour (melange, light flecks in denim)
    const thread = (across, along, idx, lift, seed, color, other, fib) => {
        const rnd = hash2(vec2(idx, seed), 3);
        const slub = periodicNoise(vec2(along.mul(slubN / n), idx.add(seed * 17)), vec2(slubN, n * 2)).sub(0.5);
        // a thread on top is pressed flatter and wider, where it dives under it is squeezed
        const spread = mix(float(0.8), float(1.15), lift);
        const hw = clamp(float(half).mul(spread).mul(float(1).add(rnd.sub(0.5).mul(0.5 * variation)).add(slub.mul(0.7 * variation))), 0.04, 0.75);
        const rr = abs(across).div(hw).mul(float(1).add(fib.sub(0.5).mul(0.7 * fuzz)));
        const prof = sqrt(max(float(1).sub(rr.mul(rr)), 0));
        // yarn twist: slanted stripes, broken up by the fibre noise
        const twist = tri(along.mul(3).add(across.div(hw).mul(0.45)).add(fib.mul(0.7)));
        const detail = mix(twist, fib, 0.3 + 0.4 * fuzz);
        const h = float(0.1).add(lift.mul(0.45)).add(prof.mul(0.37)).add(detail.sub(0.5).mul(prof).mul(0.06 + 0.08 * fuzz));
        const shade = float(1).add(detail.sub(0.5).mul(0.25 + 0.3 * fuzz)).add(slub.mul(0.5 * variation));
        const col = mix(vary(color, rnd, variation * 0.6), other, smoothstep(0.6, 0.85, fib).mul(0.25 * fuzz))
            .mul(shade).mul(mix(float(0.5), float(1), prof)).mul(mix(float(0.62), float(1), lift));
        return { h: select(rr.lessThan(1), h, float(-1)), col, rnd, warp: float(0) };
    };
    // level of a thread at a crossing: 0 under, 1 over – a short float (over one thread only) is pulled lower by the
    // bends on both sides, so warp-faced weaves hide the weft and long floats lie on top
    const over = (s, s0, s1) => s.mul(float(0.55).add(s0.add(s1).mul(0.225)));
    const warpLvl = (c, r) => over(up(c, r), up(c, r.sub(1)), up(c, r.add(1)));
    const dn = (c, r) => float(1).sub(up(c, r));
    const weftLvl = (c, r) => over(dn(c, r), dn(c.sub(1), r), dn(c.add(1), r));
    const warpAt = (c, dx) => thread(dx, q.y, c, mix(warpLvl(c, j), warpLvl(c, jY), ky), 1, a, b, fibW);
    const weftAt = (r, dy) => thread(dy, q.x, r, mix(weftLvl(i, r), weftLvl(iX, r), kx), 2, b, a, fibF);
    const dx = f.x.sub(0.5), dy = f.y.sub(0.5);
    const cands = [
        { ...warpAt(i, dx), warp: float(1) },
        { ...warpAt(iX, dx.sub(sx)), warp: float(1) },
        weftAt(j, dy),
        weftAt(jY, dy.sub(sy)),
    ];
    // visible = highest thread
    let top = cands[0];
    for (const c of cands.slice(1)) {
        const above = c.h.greaterThan(top.h);
        top = { h: max(top.h, c.h), col: select(above, c.col, top.col), rnd: select(above, c.rnd, top.rnd), warp: select(above, c.warp, top.warp) };
    }
    const isGap = top.h.lessThan(0);
    // gaps: dark, hazed with stray fibres when fuzzy
    const haze = periodicNoise(q.mul(6), N.mul(6)).mul(fuzz);
    const gapCol = mix(a, b, 0.5).mul(mix(float(0.12), float(0.55), haze));
    return {
        color: select(isGap, gapCol, top.col),
        height: select(isGap, haze.mul(0.12), top.h),
        mask: select(isGap, float(0), top.warp),
        random: top.rnd,
    };
}

// loop pile (berber): yarn loops in rows along v (columns staggered by half a loop); from above each loop is the
// top of a yarn arc – a rounded bump, its two plies (a / b) twisted around each other. Loops are a little larger
// than their cell and jittered, so the 2 × 2 nearest loops are evaluated and the highest one is seen.
function loopPile({ n, q, a, b, gap, fuzz, variation }) {
    const fib = periodicNoise(q.mul(vec2(13, 9)), vec2(n * 13, n * 9));
    const size = 1.12 - gap * 0.8;
    const col0 = floor(q.x);
    const sx = select(fract(q.x).lessThan(0.5), float(-1), float(1));
    const loop = (col) => {
        const qy = q.y.add(imod(col, 2).mul(0.5));                 // stagger every second column
        const row0 = floor(qy);
        const sy = select(fract(qy).lessThan(0.5), float(-1), float(1));
        return [row0, row0.add(sy)].map(row => {
            const r3 = hash33(vec3(imod(col, n), imod(row, n), 7));
            const r4 = hash2(vec2(imod(col, n), imod(row, n)), 8);
            const centre = vec2(col.add(0.5), row.add(0.5)).add(r3.xy.sub(0.5).mul(vec2(0.12, 0.2).mul(variation)));
            const l = vec2(q.x, qy).sub(centre);
            const sz = float(size).mul(float(1).sub(r4.mul(0.3 * variation)));
            const e = l.div(vec2(sz.mul(0.5), sz.mul(0.6)));
            const d = length(e).mul(float(1).add(fib.sub(0.5).mul(0.5 * fuzz)));
            const prof = sqrt(max(float(1).sub(d.mul(d)), 0));
            const lvl = float(1).sub(r3.z.mul(0.35 * variation));     // loops vary in height
            // plies: slanted stripes along the yarn, alternating a / b
            const plyPhase = e.y.mul(1.6).add(e.x.mul(0.9)).add(r3.z.mul(4)).add(fib.mul(0.5));
            const groove = smoothstep(0.0, 0.6, tri(plyPhase));
            const plyMix = smoothstep(0.3, 0.7, tri(plyPhase.mul(0.5)));
            const h = select(d.lessThan(1), float(0.1).add(prof.mul(lvl).mul(0.75)).add(groove.sub(0.5).mul(prof).mul(0.1)), float(-1));
            const yarn = vary(mix(a, b, plyMix), r3.x, variation * 0.5)
                .mul(mix(0.82, 1.04, groove)).mul(mix(float(0.62), float(1), prof.mul(lvl)));
            return { h, col: yarn, rnd: r3.x };
        });
    };
    const cands = [...loop(col0), ...loop(col0.add(sx))];
    let top = cands[0];
    for (const c of cands.slice(1)) {
        const above = c.h.greaterThan(top.h);
        top = { h: max(top.h, c.h), col: select(above, c.col, top.col), rnd: select(above, c.rnd, top.rnd) };
    }
    const on = top.h.greaterThan(0);
    const deep = mix(a, b, 0.5).mul(mix(float(0.3), float(0.5), fib));
    const fibre = fib.sub(0.5).mul(fuzz);
    return {
        color: select(on, top.col, deep).mul(float(1).add(fibre.mul(0.35))),
        height: select(on, top.h, float(0.05)).add(fibre.mul(0.1)),
        mask: select(on, float(1), float(0)), random: top.rnd,
    };
}

// cut pile (velours): cellular tufts – bundles of fibre ends seen from above, dark between the tufts
function cutPile({ n, q, a, b, gap, fuzz, variation }) {
    const N = vec2(n, n);
    const w = worley(q, N, 0.85);
    const rnd = hash2(w.cell, 5);
    const dome = float(1).sub(smoothstep(0.1, 0.85 - gap * 0.5, w.f1.mul(float(1).add(rnd.sub(0.5).mul(0.5 * variation)))));
    // fibre tips: fine speckle, stronger with fuzz
    const tips = periodicNoise(q.mul(9), N.mul(9)).mul(0.6).add(periodicNoise(q.mul(19), N.mul(19)).mul(0.4));
    const fibre = mix(float(0.5), smoothstep(0.3, 0.75, tips), 0.4 + 0.6 * fuzz);
    // patches where the pile leans differently (lighter / darker), period = whole tile
    const patch = periodicNoise(q.mul(4 / n), vec2(4, 4)).sub(0.5);
    const height = float(0.1).add(dome.mul(0.55)).add(fibre.mul(dome.mul(0.6).add(0.4)).mul(0.35));
    const melange = smoothstep(0.4, 0.6, periodicNoise(q.mul(5), N.mul(5)));
    const col = vary(mix(a, b, melange), rnd, variation * 0.4)
        .mul(mix(float(0.35), float(1.1), min(height, 1)))
        .mul(float(1).add(patch.mul(0.35 * variation)));
    return { color: col, height, mask: dome, random: rnd };
}

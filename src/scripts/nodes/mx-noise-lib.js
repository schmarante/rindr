// Noise as MaterialX defines it (Nov. 2026 – own TSL implementation of the same algorithms, so the exported
// unifiednoise2d / flake2d / randomfloat nodes give the values RINDR shows): Bob Jenkins' lookup3 hash of the integer
// lattice, Perlin's improved gradient noise (2D: 8 gradient directions, 3D: cube edges; quintic fade; MaterialX's
// scale factors 0.6616 / 0.9820), cell noise (the hash as 0..1), Worley noise (3×3 cells, jittered feature points)
// and fractal sums. RINDR's bake tile has to repeat: the lattice indices are wrapped by `period` (cells per tile,
// 0 = not wrapped) – inside the tile the values are MaterialX's, only the cells at the tile's far edge differ.
import { Fn, float, int, uint, vec2, vec3, uvec3, floor, select, dot, sqrt } from 'three/tsl';
import { wrap } from '../node-lib.js';

const seed = len => (0xdeadbeef + (len << 2) + 13) >>> 0;
const rotl = (x, k) => x.shiftLeft(uint(k)).bitOr(x.shiftRight(uint(32 - k)));

// lookup3 final mix of three words → hash
const bjfinal = Fn(([a0, b0, c0]) => {
    const a = a0.toVar(), b = b0.toVar(), c = c0.toVar();
    c.assign(c.bitXor(b).sub(rotl(b, 14)));
    a.assign(a.bitXor(c).sub(rotl(c, 11)));
    b.assign(b.bitXor(a).sub(rotl(a, 25)));
    c.assign(c.bitXor(b).sub(rotl(b, 16)));
    a.assign(a.bitXor(c).sub(rotl(c, 4)));
    b.assign(b.bitXor(a).sub(rotl(a, 14)));
    c.assign(c.bitXor(b).sub(rotl(b, 24)));
    return c;
}).setLayout({ name: 'mxBjFinal', type: 'uint', inputs: [{ name: 'a', type: 'uint' }, { name: 'b', type: 'uint' }, { name: 'c', type: 'uint' }] });

// lookup3 mix (more than three words)
const bjmix = Fn(([abc]) => {
    const a = abc.x.toVar(), b = abc.y.toVar(), c = abc.z.toVar();
    a.subAssign(c); a.assign(a.bitXor(rotl(c, 4))); c.addAssign(b);
    b.subAssign(a); b.assign(b.bitXor(rotl(a, 6))); a.addAssign(c);
    c.subAssign(b); c.assign(c.bitXor(rotl(b, 8))); b.addAssign(a);
    a.subAssign(c); a.assign(a.bitXor(rotl(c, 16))); c.addAssign(b);
    b.subAssign(a); b.assign(b.bitXor(rotl(a, 19))); a.addAssign(c);
    c.subAssign(b); c.assign(c.bitXor(rotl(b, 4))); b.addAssign(a);
    return uvec3(a, b, c);
}).setLayout({ name: 'mxBjMix', type: 'uvec3', inputs: [{ name: 'abc', type: 'uvec3' }] });

/** hash of two / three / four lattice indices (int nodes) → uint */
export const hash2 = (x, y) => bjfinal(uint(seed(2)).add(uint(x)), uint(seed(2)).add(uint(y)), uint(seed(2)));
export const hash3 = (x, y, z) => bjfinal(uint(seed(3)).add(uint(x)), uint(seed(3)).add(uint(y)), uint(seed(3)).add(uint(z)));
export function hash4(x, y, z, w) {
    const m = bjmix(uvec3(uint(seed(4)).add(uint(x)), uint(seed(4)).add(uint(y)), uint(seed(4)).add(uint(z))));
    return bjfinal(m.x.add(uint(w)), m.y, m.z);
}
/** uint → 0..1 */
export const bits01 = h => float(h).div(4294967296);

/** three values 0..1 per 2D cell (MaterialX cell_noise_vec3(vec2): hash of (x, y, 0 / 1 / 2)) */
export const cellVec3of2 = (x, y) => vec3(bits01(hash3(x, y, int(0))), bits01(hash3(x, y, int(1))), bits01(hash3(x, y, int(2))));
/** three values 0..1 per 3D cell (cell_noise_vec3(vec3)) */
export function cellVec3of3(x, y, z) {
    const m = bjmix(uvec3(uint(seed(4)).add(uint(x)), uint(seed(4)).add(uint(y)), uint(seed(4)).add(uint(z))));
    return vec3(bits01(bjfinal(m.x, m.y, m.z)), bits01(bjfinal(m.x.add(uint(1)), m.y, m.z)), bits01(bjfinal(m.x.add(uint(2)), m.y, m.z)));
}
/** three values 0..1 per 4D cell (cell_noise_vec3(vec4)) */
export function cellVec3of4(x, y, z, w) {
    const m = bjmix(uvec3(uint(seed(5)).add(uint(x)), uint(seed(5)).add(uint(y)), uint(seed(5)).add(uint(z))));
    const a = m.x.add(uint(w));
    return vec3(bits01(bjfinal(a, m.y, m.z)), bits01(bjfinal(a, m.y.add(uint(1)), m.z)), bits01(bjfinal(a, m.y.add(uint(2)), m.z)));
}

/** lattice index (float, integral) wrapped by the period (0 = as it is) → int */
const cell = (i, period) => int(select(period.greaterThan(0), wrap(i, period), i));

const fade = t => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));
const flip = (v, bit) => select(bit.notEqual(uint(0)), v.negate(), v);

const grad2 = Fn(([h0, x, y]) => {
    const h = h0.bitAnd(uint(7));
    const low = h.lessThan(uint(4));
    const u = select(low, x, y), v = select(low, y, x).mul(2);
    return flip(u, h.bitAnd(uint(1))).add(flip(v, h.bitAnd(uint(2))));
}).setLayout({ name: 'mxGrad2', type: 'float', inputs: [{ name: 'h', type: 'uint' }, { name: 'x', type: 'float' }, { name: 'y', type: 'float' }] });

const grad3 = Fn(([h0, x, y, z]) => {
    const h = h0.bitAnd(uint(15));
    const u = select(h.lessThan(uint(8)), x, y);
    const v = select(h.lessThan(uint(4)), y, select(h.equal(uint(12)).or(h.equal(uint(14))), x, z));
    return flip(u, h.bitAnd(uint(1))).add(flip(v, h.bitAnd(uint(2))));
}).setLayout({ name: 'mxGrad3', type: 'float', inputs: [{ name: 'h', type: 'uint' }, { name: 'x', type: 'float' }, { name: 'y', type: 'float' }, { name: 'z', type: 'float' }] });

/** Perlin noise 2D, about −1..1 (period: lattice cells per tile, 0 = not wrapped) */
export const perlin2 = Fn(([p, period]) => {
    const i = floor(p), f = p.sub(i);
    const x0 = cell(i.x, period.x), x1 = cell(i.x.add(1), period.x), y0 = cell(i.y, period.y), y1 = cell(i.y.add(1), period.y);
    const u = fade(f.x), v = fade(f.y);
    const g00 = grad2(hash2(x0, y0), f.x, f.y), g10 = grad2(hash2(x1, y0), f.x.sub(1), f.y);
    const g01 = grad2(hash2(x0, y1), f.x, f.y.sub(1)), g11 = grad2(hash2(x1, y1), f.x.sub(1), f.y.sub(1));
    const s1 = float(1).sub(u);
    return float(1).sub(v).mul(g00.mul(s1).add(g10.mul(u))).add(v.mul(g01.mul(s1).add(g11.mul(u)))).mul(0.6616);
}).setLayout({ name: 'mxPerlin2', type: 'float', inputs: [{ name: 'p', type: 'vec2' }, { name: 'period', type: 'vec2' }] });

/** Perlin noise 3D (x and y wrapped by period, z not) */
export const perlin3 = Fn(([p, period]) => {
    const i = floor(p), f = p.sub(i);
    const x0 = cell(i.x, period.x), x1 = cell(i.x.add(1), period.x), y0 = cell(i.y, period.y), y1 = cell(i.y.add(1), period.y);
    const z0 = int(i.z), z1 = int(i.z.add(1));
    const u = fade(f.x), v = fade(f.y), w = fade(f.z);
    const fx1 = f.x.sub(1), fy1 = f.y.sub(1), fz1 = f.z.sub(1);
    const g = [
        grad3(hash3(x0, y0, z0), f.x, f.y, f.z), grad3(hash3(x1, y0, z0), fx1, f.y, f.z),
        grad3(hash3(x0, y1, z0), f.x, fy1, f.z), grad3(hash3(x1, y1, z0), fx1, fy1, f.z),
        grad3(hash3(x0, y0, z1), f.x, f.y, fz1), grad3(hash3(x1, y0, z1), fx1, f.y, fz1),
        grad3(hash3(x0, y1, z1), f.x, fy1, fz1), grad3(hash3(x1, y1, z1), fx1, fy1, fz1),
    ];
    const s1 = float(1).sub(u), t1 = float(1).sub(v), r1 = float(1).sub(w);
    const lo = t1.mul(g[0].mul(s1).add(g[1].mul(u))).add(v.mul(g[2].mul(s1).add(g[3].mul(u))));
    const hi = t1.mul(g[4].mul(s1).add(g[5].mul(u))).add(v.mul(g[6].mul(s1).add(g[7].mul(u))));
    return r1.mul(lo).add(w.mul(hi)).mul(0.9820);
}).setLayout({ name: 'mxPerlin3', type: 'float', inputs: [{ name: 'p', type: 'vec3' }, { name: 'period', type: 'vec2' }] });

/** cell noise 2D: 0..1 per lattice cell */
export const cell2 = (p, period) => bits01(hash2(cell(floor(p.x), period.x), cell(floor(p.y), period.y)));

/** fractal sum of 3D Perlin octaves (JS loop – octaves, lacunarity, diminish are fixed); periods follow the
 *  lacunarity while it keeps them whole */
export function fractal3(p, octaves, lacunarity, diminish, period) {
    let sum = float(0), amp = 1, q = p, per = period;
    for (let k = 0; k < octaves; k++) {
        sum = sum.add(perlin3(q, vec2(...per)).mul(amp));
        amp *= diminish;
        q = q.mul(lacunarity);
        per = per.map(v => (Number.isInteger(v * lacunarity) ? v * lacunarity : 0));
    }
    return sum;
}

/** Worley noise 2D: distance to the nearest feature point (style 'distance') or the nearest cell's value ('solid') */
export function worley2(p, jitter, style, period) {
    const i = floor(p), local = p.sub(i);
    let best = float(1e6), minpos = vec2(0, 0);
    for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
            const r = cellVec3of2(cell(i.x.add(x), period.x), cell(i.y.add(y), period.y));
            const pos = vec2(x, y).add(r.xy.sub(0.5).mul(jitter).add(0.5));
            const diff = pos.sub(local), d = dot(diff, diff);
            const closer = d.lessThan(best);
            minpos = select(closer, diff, minpos);
            best = select(closer, d, best);
        }
    }
    return style === 'solid' ? cell2(minpos.add(p), period) : sqrt(best);
}

// flake2d: "Fast Random Rotation Matrices" (Arvo) – rotate p by the random triple i
function rotateFlake(p, i) {
    const theta = i.x.mul(Math.PI * 2), phi = i.y.mul(Math.PI * 2), z = i.z.mul(2);
    const r = sqrt(z), vx = phi.sin().mul(r), vy = phi.cos().mul(r), vz = sqrt(float(2).sub(z));
    const st = theta.sin(), ct = theta.cos();
    const sx = vx.mul(ct).sub(vy.mul(st)), sy = vx.mul(st).add(vy.mul(ct));
    // GLSL mat3(...) is column-major: m * p = col0 * p.x + col1 * p.y + col2 * p.z
    const c0 = vec3(vx.mul(sx).sub(ct), vx.mul(sy).sub(st), vx.mul(vz));
    const c1 = vec3(vy.mul(sx).add(st), vy.mul(sy).sub(ct), vy.mul(vz));
    const c2 = vec3(vz.mul(sx), vz.mul(sy), float(1).sub(z));
    return c0.mul(p.x).add(c1.mul(p.y)).add(c2.mul(p.z));
}
const densityToProbability = x => {
    const xx = x * x;
    return (-26.19771808 * xx + 26.39663835 * x) / (85.53857017 * xx * x - 102.35069432 * xx - 101.42634862 * x + 118.45082288);
};
/**
 * flake2d at the 2D coordinate c: { rand, presence, normal (tangent space) } – the highest priority flake of the
 * 3×3×3 cells around; size, roughness, coverage fixed numbers; period = cells per tile in x and y (0 = not wrapped)
 */
export function flake2d(c, size, roughness, coverage, period) {
    const probability = densityToProbability(Math.min(Math.max(coverage, 0), 1));
    const D = 1.5 / Math.sqrt(3);
    const P = vec3(c.x, c.y, 0).div(size), base = floor(P);
    const per = vec2(...period);
    let priority = float(0), flakeCell = vec3(0, 0, 0);
    for (let i = -1; i < 2; i++) for (let j = -1; j < 2; j++) for (let k = -1; k < 2; k++) {
        const cp = base.add(vec3(i, j, k));
        const ix = cell(cp.x, per.x), iy = cell(cp.y, per.y), iz = int(cp.z);
        const pp0 = P.sub(cp).sub(0.5);
        const near = dot(pp0, pp0).lessThan(D * D * 3);
        const present = bits01(hash3(ix, iy, iz)).lessThanEqual(probability);
        const prio = bits01(hash4(ix, iy, iz, int(3)));
        const pp = rotateFlake(pp0, cellVec3of3(ix, iy, iz)).abs();
        const inside = pp.x.lessThanEqual(D).and(pp.y.lessThanEqual(D)).and(pp.z.lessThanEqual(D));
        const take = near.and(present).and(prio.greaterThanEqual(priority)).and(inside);
        priority = select(take, prio, priority);
        flakeCell = select(take, vec3(float(ix), float(iy), float(iz)), flakeCell);
    }
    const has = priority.greaterThan(0);
    const noise = cellVec3of4(int(flakeCell.x), int(flakeCell.y), int(flakeCell.z), int(2));
    const phi = noise.x.mul(Math.PI * 2);
    const tanT = sqrt(noise.y).div(sqrt(float(1).sub(noise.y))).mul(roughness * roughness);
    const sinT = tanT.div(sqrt(tanT.mul(tanT).add(1))), cosT = sqrt(float(1).sub(sinT.mul(sinT)));
    const n = vec3(phi.cos().mul(sinT), phi.sin().mul(sinT), cosT).normalize();
    return { rand: select(has, noise.z, float(0)), presence: priority, normal: select(has, n, vec3(0, 0, 1)) };
}

/** MaterialX randomfloat: 0..1 from a number and an integer seed (cell noise of (in × 4096, seed)) */
export const randomFloat = (v, seedValue) => bits01(hash2(int(floor(v.mul(4096))), int(seedValue)));

// --- the hash in JS (constant inputs of the random nodes) ---
const rotlJs = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
function bjfinalJs(a, b, c) {
    c = ((c ^ b) - rotlJs(b, 14)) >>> 0; a = ((a ^ c) - rotlJs(c, 11)) >>> 0; b = ((b ^ a) - rotlJs(a, 25)) >>> 0;
    c = ((c ^ b) - rotlJs(b, 16)) >>> 0; a = ((a ^ c) - rotlJs(c, 4)) >>> 0; b = ((b ^ a) - rotlJs(a, 14)) >>> 0;
    return ((c ^ b) - rotlJs(b, 24)) >>> 0;
}
/** randomFloat for numbers */
export function randomFloatJs(v, seedValue) {
    const s = seed(2);
    return Math.fround(bjfinalJs((s + Math.floor(v * 4096)) >>> 0, (s + Math.floor(seedValue)) >>> 0, s)) / 4294967296;
}


// Shared helpers of the noise and dent nodes: tileable gradient noise, fractal sums with an anti-alias cutoff and the
// threshold remap. No default export – the node registry ignores this module.
import { Fn, float, vec2, floor, fract, dot, mix, cos, sin, abs, clamp } from 'three/tsl';
import { hash2, wrap } from '../node-lib.js';

// gradient noise over the lattice cells of p; cellId(c) maps a cell to its representative inside one tile
function gradient(p, cellId, seed) {
    const i = floor(p);
    const f = fract(p);
    const u = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10));
    const g = o => {
        const a = hash2(cellId(i.add(o)), seed).mul(Math.PI * 2);
        return dot(vec2(cos(a), sin(a)), f.sub(o));
    };
    const n = mix(mix(g(vec2(0, 0)), g(vec2(1, 0)), u.x), mix(g(vec2(0, 1)), g(vec2(1, 1)), u.x), u.y);
    return n.mul(Math.SQRT2);
}

/**
 * Tileable gradient noise, about −1..1 (std ≈ 0.31). p in cells, period = cells per tile (vec2), seed = integer.
 * Random unit gradient per lattice point and a quintic fade – no blocky value-noise plateaus or grid creases.
 */
export const gradientNoise = Fn(([p, period, seed]) => gradient(p, c => wrap(c, period), seed));

/**
 * Gradient noise sampled at q = M·p with the integer matrix M = [[m.x, −m.y], [m.y, m.x]] (a turn plus a scale by
 * |m|), tileable in p with `period` cells per tile (float). The lattice repeats on P·M·ℤ² instead of an axis-aligned
 * square, so every cell is reduced to its representative k = floor(M⁻¹·c / P) (exact: integer numerator + ½) –
 * all |m|²·P² cells of the tile stay distinct (a plain axis wrap would repeat the octave |m|² times per tile).
 */
export const rotatedNoise = Fn(([q, period, m, seed]) => gradient(q, c => {
    const den = dot(m, m).mul(period);
    const k = floor(vec2(m.x.mul(c.x).add(m.y.mul(c.y)), m.x.mul(c.y).sub(m.y.mul(c.x))).add(0.5).div(den));
    return c.sub(vec2(m.x.mul(k.x).sub(m.y.mul(k.y)), m.y.mul(k.x).add(m.x.mul(k.y))).mul(period));
}, seed));

/** finest octave kept (cells per tile) for a 1024² bake: ≥ 4 px per cell – finer octaves would only alias; other
 *  bake sizes pass their own limit (bake size / 4) */
export const MAX_CELLS = 256;

/**
 * Noise 0..1 around 0.5. kind: 'regular' (one octave), 'fractal' (finer octaves, each half as strong) or
 * 'turbulence' (sum of |noise| – sharp dark creases). p in cells, period = [cellsU, cellsV] (JS numbers).
 * Square cells: each octave is the previous one turned by 26.6° and scaled by √5 (integer matrix [[2,−1],[1,2]] –
 * keeps the tile period and hides the lattice axes). Stretched cells: octaves twice as fine, unrotated (streaks
 * must stay along u). Octaves are shifted against each other (otherwise all lattices meet at the tile corners) and
 * dropped once finer than MAX_CELLS.
 */
export function noiseSum(p, period, octaves, kind, seed, maxCells = MAX_CELLS) {
    const n = kind === 'regular' ? 1 : Math.max(1, octaves);
    const square = period[0] === period[1];
    let sum = float(0);
    let amp = 1, a2 = 0;
    let ma = 1, mb = 0;   // octave matrix [[ma, −mb], [mb, ma]] = (2 + i)^o
    for (let o = 0; o < n; o++) {
        const f = square ? Math.hypot(ma, mb) : 2 ** o;
        if (o > 0 && Math.max(period[0], period[1]) * f > maxCells) break;
        const shift = vec2((o * 0.6180339) % 1 * 7, (o * 0.4142135) % 1 * 5);
        const v = square
            ? rotatedNoise(vec2(p.x.mul(ma).sub(p.y.mul(mb)), p.x.mul(mb).add(p.y.mul(ma))).add(shift), float(period[0]),
                vec2(ma, mb), float(seed * 16 + o))
            : gradientNoise(p.mul(f).add(shift), vec2(period[0] * f, period[1] * f), float(seed * 16 + o));
        sum = sum.add((kind === 'turbulence' ? abs(v).sub(0.25) : v).mul(amp));
        a2 += amp * amp;
        amp *= 0.5;
        [ma, mb] = [2 * ma - mb, ma + 2 * mb];
    }
    // normalise to a std of ≈ 0.17 independent of the octave count (0.5 ± 3σ ≈ 0..1)
    const gain = (kind === 'turbulence' ? 0.17 / 0.177 : 0.17 / 0.308) / Math.sqrt(a2);
    return clamp(sum.mul(gain).add(0.5), 0, 1);
}

/**
 * Thresholds: low..high → 0..1 (clamped). The narrower the range, the more the ramp is smoothed (smoothstep), so
 * tight thresholds give soft-edged patches instead of a hard kink; low 0 / high 1 leaves the value unchanged.
 */
export function thresholds(v, low, high) {
    const lo = Math.min(Math.max(low, 0), 1);
    const hi = Math.max(Math.min(high, 1), lo + 1e-3);
    if (lo === 0 && hi >= 1) return v;
    const t = clamp(v.sub(lo).div(hi - lo), 0, 1);
    const smooth = Math.min(1, 1 - (hi - lo));
    return smooth > 0 ? mix(t, t.mul(t).mul(float(3).sub(t.mul(2))), smooth) : t;
}

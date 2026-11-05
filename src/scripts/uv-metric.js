// Surface length of one unit of texture coordinates – a height picture's slopes are its height change over the true
// distance on the surface (relief of bump maps: mesh-importer.js, graph-apply.js via the viewer, pbrt import). Pure
// functions on plain arrays.
//
// Per triangle the length √(surface area / UV area); over all triangles of the meshes the median weighted by surface
// area – a ratio of the sums was thrown by a few meshes with broken UVs (NaN, 1e30, needle triangles in UV space: one
// material came out at 1e19 mm, another at 1e-35). Lengths are kept as a histogram over log2 (1/32 octave ≈ 2 %).

const STEPS = 32;                 // bins per octave
const LOW = -40, HIGH = 80;       // log2 range of lengths kept (in the geometry's own units)
const BINS = (HIGH - LOW) * STEPS;
// texture coordinates beyond this are no coordinates
const UV_SANE = 1e6;
const sane = x => x > -UV_SANE && x < UV_SANE;   // false for NaN
// a result outside this (mm per UV unit) is no measurement – the caller falls back to its default
const PLAUSIBLE = [1e-3, 1e8];

/**
 * Histogram of a triangle geometry's lengths per UV unit, weighted by surface area (its own units); triangles without
 * UV area or with broken coordinates left out. Null without UVs.
 */
export function uvLengthHistogram(positions, uvs, index = null) {
    if (!uvs) return null;
    const P = positions, T = uvs, I = index;
    const n = I ? I.length : P.length / 3;
    const hist = new Float64Array(BINS);
    for (let t = 0; t + 2 < n; t += 3) {
        const a = I ? I[t] : t, b = I ? I[t + 1] : t + 1, c = I ? I[t + 2] : t + 2;
        if (!(sane(T[2 * a]) && sane(T[2 * a + 1]) && sane(T[2 * b]) && sane(T[2 * b + 1]) && sane(T[2 * c]) && sane(T[2 * c + 1]))) continue;
        const uvArea = Math.abs((T[2 * b] - T[2 * a]) * (T[2 * c + 1] - T[2 * a + 1]) - (T[2 * c] - T[2 * a]) * (T[2 * b + 1] - T[2 * a + 1]));
        if (!(uvArea > 0)) continue;
        const e1x = P[3 * b] - P[3 * a], e1y = P[3 * b + 1] - P[3 * a + 1], e1z = P[3 * b + 2] - P[3 * a + 2];
        const e2x = P[3 * c] - P[3 * a], e2y = P[3 * c + 1] - P[3 * a + 1], e2z = P[3 * c + 2] - P[3 * a + 2];
        const area = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
        if (!(area > 0) || !Number.isFinite(area)) continue;
        const bin = Math.floor((0.5 * Math.log2(area / uvArea) - LOW) * STEPS);
        if (bin >= 0 && bin < BINS) hist[bin] += area;
    }
    return hist;
}

/** area factor of a placement (4×4, column-major): |det of the 3×3 part|^(2/3) – exact for uniform scale */
export function areaScale(m, o = 0) {
    const det = m[o] * (m[o + 5] * m[o + 10] - m[o + 9] * m[o + 6]) - m[o + 4] * (m[o + 1] * m[o + 10] - m[o + 9] * m[o + 2])
        + m[o + 8] * (m[o + 1] * m[o + 6] - m[o + 5] * m[o + 2]);
    return Math.abs(det) ** (2 / 3);
}

/** Accumulates placed geometries → surface length per UV unit (mm when the placements are in mm). */
export class UvMetric {
    constructor() { this.hist = new Float64Array(BINS); }
    /**
     * @param hist    uvLengthHistogram of the geometry (null: nothing)
     * @param matrix  its placement (4×4 column-major; null = as is)
     * @param count   copies (instances)
     */
    add(hist, matrix = null, count = 1) {
        if (!hist) return this;
        const s2 = matrix ? areaScale(matrix) : 1;
        if (!(s2 > 0) || !Number.isFinite(s2)) return this;
        return this._shifted(hist, Math.round(0.5 * Math.log2(s2) * STEPS), s2 * count);   // lengths × √s2, areas × s2
    }
    /**
     * As add for the copies of an InstancedMesh (model-instances.js): placement = matrix × copy k
     * @param copies  Float32Array, 16 per copy (column-major)
     */
    addCopies(hist, matrix, copies, count) {
        if (!hist) return this;
        const base = matrix ? areaScale(matrix) : 1;
        const weights = new Map();   // shift → summed area factor (copies of one size share a shift)
        for (let k = 0; k < count; k++) {
            const s2 = base * areaScale(copies, 16 * k);
            if (!(s2 > 0) || !Number.isFinite(s2)) continue;
            const shift = Math.round(0.5 * Math.log2(s2) * STEPS);
            weights.set(shift, (weights.get(shift) || 0) + s2);
        }
        for (const [shift, w] of weights) this._shifted(hist, shift, w);
        return this;
    }
    _shifted(hist, shift, w) {
        for (let i = 0; i < BINS; i++) {
            if (!hist[i]) continue;
            const j = i + shift;
            if (j >= 0 && j < BINS) this.hist[j] += hist[i] * w;
        }
        return this;
    }
    /** area-weighted median length; null without (plausible) data */
    get length() {
        let total = 0;
        for (let i = 0; i < BINS; i++) total += this.hist[i];
        if (!(total > 0)) return null;
        let acc = 0;
        for (let i = 0; i < BINS; i++) {
            acc += this.hist[i];
            if (acc >= total / 2) {
                const len = 2 ** (LOW + (i + 0.5) / STEPS);
                return len >= PLAUSIBLE[0] && len <= PLAUSIBLE[1] ? len : null;
            }
        }
        return null;
    }
}

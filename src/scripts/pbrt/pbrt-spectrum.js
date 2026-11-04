// Spectra → linear sRGB, and pbrt's measured materials (tabulated BRDFs) → colour + roughness. Pure functions.
//
// Colour matching: the multi-lobe Gaussian fits of the CIE 1931 2° functions (Wyman, Sloan & Shirley 2013, "Simple
// analytic approximations to the CIE XYZ color matching functions"); a reflectance spectrum under an equal-energy light,
// white-balanced per channel so that a flat spectrum of 1 gives (1, 1, 1).

const g = (l, mu, s1, s2) => { const t = (l - mu) / (l < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
const xBar = l => 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
const yBar = l => 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
const zBar = l => 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
const toRgb = (X, Y, Z) => [3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z];
const WHITE = (() => {
    let X = 0, Y = 0, Z = 0;
    for (let l = 380; l <= 780; l += 5) { X += xBar(l); Y += yBar(l); Z += zBar(l); }
    return toRgb(X / Y, 1, Z / Y);
})();

/** reflectance spectrum (value(λ) for λ in nm, 380–780) → linear sRGB */
export function spectrumToRgb(value) {
    let X = 0, Y = 0, Z = 0, N = 0;
    for (let l = 380; l <= 780; l += 5) {
        const v = value(l);
        X += v * xBar(l); Y += v * yBar(l); Z += v * zBar(l); N += yBar(l);
    }
    return toRgb(X / N, Y / N, Z / N).map((c, i) => Math.max(c / WHITE[i], 0));
}

/** piecewise linear pairs (λ, value, λ, value …) → value(λ) */
export function pairsFunction(pairs) {
    const n = pairs.length >> 1;
    return l => {
        if (!n) return 0;
        if (l <= pairs[0]) return pairs[1];
        for (let i = 1; i < n; i++) {
            if (l <= pairs[2 * i]) {
                const a = pairs[2 * i - 2], b = pairs[2 * i], w = b > a ? (l - a) / (b - a) : 0;
                return pairs[2 * i - 1] * (1 - w) + pairs[2 * i + 1] * w;
            }
        }
        return pairs[2 * n - 1];
    };
}

// --- measured materials: the "tensor file" container of the tabulated BRDFs (Dupuy & Jakob 2018) ---

const DTYPES = { 1: [1, 'getInt8'], 2: [1, 'getUint8'], 3: [2, 'getInt16'], 4: [2, 'getUint16'], 5: [4, 'getInt32'], 6: [4, 'getUint32'], 10: [4, 'getFloat32'], 11: [8, 'getFloat64'] };

function readTensorFile(buffer) {
    const dv = new DataView(buffer);
    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 11));
    if (magic !== 'tensor_file') throw new Error('not a tensor file');
    let o = 14;
    const count = dv.getUint32(o, true); o += 4;
    const fields = {};
    for (let f = 0; f < count; f++) {
        const len = dv.getUint16(o, true); o += 2;
        const name = String.fromCharCode(...new Uint8Array(buffer, o, len)); o += len;
        const ndim = dv.getUint16(o, true); o += 2;
        const dtype = dv.getUint8(o); o += 1;
        const offset = Number(dv.getBigUint64(o, true)); o += 8;
        const shape = [];
        for (let d = 0; d < ndim; d++) { shape.push(Number(dv.getBigUint64(o, true))); o += 8; }
        fields[name] = { dtype, offset, shape };
    }
    const read = (name, start = 0, n = null) => {
        const f = fields[name];
        if (!f || !DTYPES[f.dtype]) return null;
        const [size, method] = DTYPES[f.dtype];
        const total = f.shape.reduce((a, b) => a * b, 1);
        const count = n ?? total - start;
        const out = new Float64Array(count);
        for (let i = 0; i < count; i++) out[i] = dv[method](f.offset + (start + i) * size, true);
        return out;
    };
    return { fields, read };
}

/**
 * Measured BRDF → { color (linear rgb, albedo at normal incidence), roughness (RINDR, α = r²), metal, description }.
 * Albedo: the tabulated values are stored per cell of the VNDF-warped domain – their mean (× cos θo ≈ 1 for glossy
 * materials) is the reflectance at normal incidence. Roughness: GGX α whose NDF falls to half at the same angle as the
 * tabulated NDF (θ on the grid: θ = u² π/2).
 */
export function readMeasured(buffer, name = '') {
    const tf = readTensorFile(buffer);
    const description = (() => {
        const d = tf.read('description');
        return d ? String.fromCharCode(...Array.from(d).filter(c => c > 0)).trim() : '';
    })();
    const lambdas = tf.read('wavelengths');
    const spectra = tf.fields.spectra;
    let color = [0.5, 0.5, 0.5];
    if (lambdas && spectra?.shape.length === 5) {
        const [, , nl, nu, nv] = spectra.shape;
        const cell = nu * nv;
        const mean = new Float64Array(nl);
        const slice = tf.read('spectra', 0, nl * cell);   // first φi, first θi (= normal incidence)
        for (let l = 0; l < nl; l++) {
            let s = 0;
            for (let k = 0; k < cell; k++) s += Math.max(slice[l * cell + k], 0);
            mean[l] = s / cell;
        }
        const pairs = [];
        for (let l = 0; l < nl; l++) pairs.push(lambdas[l], mean[l]);
        color = spectrumToRgb(pairsFunction(pairs)).map(c => Math.min(c, 1));
    }
    let roughness = 0.4;
    const ndf = tf.fields.ndf;
    if (ndf?.shape.length === 2) {
        const nt = ndf.shape[1];
        const row = tf.read('ndf', 0, nt);   // first φ
        const d0 = row[0];
        if (d0 > 0) {
            let i = 1;
            while (i < nt && row[i] > 0.5 * d0) i++;
            if (i < nt) {
                const w = (row[i - 1] - 0.5 * d0) / Math.max(row[i - 1] - row[i], 1e-12);
                const u = (i - 1 + w) / (nt - 1), theta = u * u * Math.PI / 2;
                const t = Math.tan(theta), c2 = Math.cos(theta) ** 2;
                const alpha = t / Math.sqrt(Math.max(Math.SQRT2 / c2 - 1, 1e-9));
                roughness = Math.min(Math.max(Math.sqrt(alpha), 0), 1);
            } else roughness = 1;
        }
    }
    const text = `${name} ${description}`.toLowerCase();
    const metal = /gold|silver|copper|brass|alumin|chrome|steel/.test(text) && !/paint|lacquer|paper|fabric/.test(text);
    return { color, roughness, metal, description };
}

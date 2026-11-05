// Spectra → linear sRGB, and pbrt's measured materials (tabulated BRDFs) → colour + roughness (+ a thin film for
// colour-shift materials). Pure functions.
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

/** blackbody radiation at temperature T (K), normalised to its peak (as pbrt's BlackbodySpectrum) → linear sRGB */
export function blackbodyRgb(T) {
    const h = 6.62606957e-34, c = 299792458, k = 1.3806488e-23;
    const planck = l => { const m = l * 1e-9; return 2 * h * c * c / (m ** 5 * (Math.exp(h * c / (m * k * T)) - 1)); };
    const peak = planck(2.8977721e-3 / T * 1e9);
    return spectrumToRgb(l => planck(l) / peak);
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

// --- colour-shift materials (wrap films, interference paints): the specular colour runs through the spectrum with the
// angle. Fitted as a thin film on the dielectric specular – the path tracer's own model (three-gpu-pathtracer
// iridescentFresnel: Belcour & Barla 2017, Airy summation with two orders, Schlick at both interfaces), so the fit is
// what HQ renders ---

const SENS_VAL = [5.4856e-13, 4.4201e-13, 5.2481e-13], SENS_POS = [1.6810e+06, 1.7953e+06, 2.2084e+06], SENS_VAR = [4.3278e+09, 9.3046e+09, 6.6121e+09];
function sensitivity(opd, shift) {
    const phase = 2 * Math.PI * opd * 1e-9;
    const X = [0, 1, 2].map(k => SENS_VAL[k] * Math.sqrt(2 * Math.PI * SENS_VAR[k]) * Math.cos(SENS_POS[k] * phase + shift) * Math.exp(-phase * phase * SENS_VAR[k]));
    X[0] += 9.7470e-14 * Math.sqrt(2 * Math.PI * 4.5282e+09) * Math.cos(2.2399e+06 * phase + shift) * Math.exp(-4.5282e+09 * phase * phase);
    return toRgb(X[0] / 1.0685e-7, X[1] / 1.0685e-7, X[2] / 1.0685e-7);
}
const iorF0 = (n, o = 1) => ((n - o) / (n + o)) ** 2;
const schlick = (c, f0) => f0 + (1 - f0) * (1 - c) ** 5;
/** reflectance (linear rgb) of a thin film (index `ior`, thickness nm) on a base of reflectance baseF0, seen at cos θ */
export function thinFilmReflectance(cos1, baseF0, ior, thickness) {
    const c2sq = 1 - (1 - cos1 * cos1) / (ior * ior);
    if (c2sq < 0) return [1, 1, 1];
    const cos2 = Math.sqrt(c2sq);
    const R12 = schlick(cos1, iorF0(ior)), T121 = 1 - R12;
    const sq = Math.sqrt(Math.min(baseF0, 0.9999)), baseIor = (1 + sq) / (1 - sq);
    const R23 = schlick(cos2, iorF0(baseIor, ior));
    const phi = (ior < 1 ? 0 : Math.PI) + (baseIor < ior ? Math.PI : 0);
    const opd = 2 * ior * thickness * cos2;
    const R123 = Math.min(Math.max(R12 * R23, 1e-5), 0.9999), r123 = Math.sqrt(R123);
    const Rs = T121 * T121 * R23 / (1 - R123);
    const I = [R12 + Rs, R12 + Rs, R12 + Rs];
    let Cm = Rs - T121;
    for (let m = 1; m <= 2; m++) {
        Cm *= r123;
        const S = sensitivity(m * opd, m * phi);
        for (let k = 0; k < 3; k++) I[k] += Cm * 2 * S[k];
    }
    return I.map(x => Math.max(x, 0));
}
const chromaOf = c => { const s = c[0] + c[1] + c[2]; return s > 0 ? c.map(x => x / s) : [1 / 3, 1 / 3, 1 / 3]; };
const saturationOf = c => { const q = chromaOf(c); return Math.hypot(q[0] - 1 / 3, q[1] - 1 / 3, q[2] - 1 / 3); };
const hueOf = ([r, g, b]) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx - mn < 1e-9) return 0;
    const h = mx === r ? (g - b) / (mx - mn) : mx === g ? 2 + (b - r) / (mx - mn) : 4 + (r - g) / (mx - mn);
    return (h * 60 + 360) % 360;
};
// the hues of the clearly coloured specular peaks span at least this arc → colour-shift material (wrap films 69° and
// 200°, a blue silk only gets paler: 14°, white/metal materials 0°)
const SHIFT_SPAN = 60;
function hueSpan(colors) {
    const hs = colors.filter(c => saturationOf(c) > 0.08).map(hueOf).sort((a, b) => a - b);
    if (hs.length < 3) return 0;
    let gap = 0;
    for (let i = 0; i < hs.length; i++) gap = Math.max(gap, (hs[(i + 1) % hs.length] - hs[i] + 360) % 360);
    return 360 - gap;
}
// thickness, film index and base reflectance whose specular colours fit the measured peaks best (chromaticity,
// weighted by how coloured each peak is – near-grey peaks say little); RINDR's ranges (material-manager.js)
function fitThinFilm(peaks) {
    let best = null;
    for (const baseF0 of [0.04, 0.1, 0.2, 0.3]) {
        for (let d = 50; d <= 1200; d += 10) {
            for (let n = 1.05; n <= 2.5; n += 0.025) {
                let e = 0;
                for (const { cos, color } of peaks) {
                    const m = chromaOf(thinFilmReflectance(cos, baseF0, n, d)), q = chromaOf(color);
                    e += saturationOf(color) * ((m[0] - q[0]) ** 2 + (m[1] - q[1]) ** 2 + (m[2] - q[2]) ** 2);
                }
                if (!best || e < best.e) best = { e, thickness: d, ior: n, baseF0 };
            }
        }
    }
    const sq = Math.sqrt(best.baseF0);
    return { thickness: best.thickness, ior: Math.round(best.ior * 1000) / 1000, baseIor: Math.round((1 + sq) / (1 - sq) * 100) / 100, error: best.e };
}

/**
 * Measured BRDF → { color (linear rgb, albedo at normal incidence), roughness (RINDR, α = r²), metal, description,
 * film? }. Colour-shift materials (see SHIFT_SPAN): `film` = { thickness, ior, baseIor } and `color` = the part
 * outside the specular peak at normal incidence (the base under the film) – one colour cannot show a paint running
 * from blue through orange and green to cyan.
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
    const shift = !metal && colourShift(tf, lambdas, spectra);
    if (shift) return { color: shift.base, roughness, metal, description, film: shift.film };
    return { color, roughness, metal, description };
}

// per incidence angle the colour of the brightest 1/16 of the cells (the specular peak) → a thin film fitted when the
// peak colours span SHIFT_SPAN (null otherwise); base colour = the rest of the cells at normal incidence
function colourShift(tf, lambdas, spectra) {
    if (!lambdas || spectra?.shape.length !== 5) return null;
    const [nphi, nt, nl, nu, nv] = spectra.shape, cell = nu * nv;
    const thetas = tf.read('theta_i'), lum = tf.fields.luminance ? tf.read('luminance') : null;
    if (!thetas || nphi < 1) return null;
    const rgbOf = vals => spectrumToRgb(pairsFunction(Array.from(lambdas).flatMap((l, i) => [l, vals[i]])));
    const peaks = [];
    let base = null;
    for (let t = 0; t < nt; t++) {
        if (thetas[t] > 1.5) continue;   // the 90° row repeats the last measured one
        const slice = tf.read('spectra', t * nl * cell, nl * cell);   // first φi
        const L = new Float64Array(cell);
        for (let k = 0; k < cell; k++) {
            if (lum) L[k] = lum[t * cell + k];
            else for (let l = 0; l < nl; l++) L[k] += Math.max(slice[l * cell + k], 0);
        }
        const order = Array.from({ length: cell }, (_, k) => k).sort((a, b) => L[b] - L[a]);
        const meanOf = ks => {
            const m = new Float64Array(nl);
            for (const k of ks) for (let l = 0; l < nl; l++) m[l] += Math.max(slice[l * cell + k], 0);
            return rgbOf(m.map(x => x / ks.length));
        };
        peaks.push({ cos: Math.cos(thetas[t]), color: meanOf(order.slice(0, Math.max(1, cell >> 4))) });
        // base under the film: everything outside the peak – a wide azure lobe around the peak holds half of the cells and
        // makes the colour seen (the darker half alone came out violet)
        if (base === null) base = meanOf(order.slice(Math.max(1, cell >> 4))).map(c => Math.min(c, 1));
    }
    if (peaks.length < 3 || hueSpan(peaks.map(p => p.color)) < SHIFT_SPAN) return null;
    return { base, film: fitThinFilm(peaks) };
}

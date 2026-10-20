// Inverse of the renderer's tone curves – for splat-composite.js: the composited pixel (splats blended over the models
// in display space) is turned back into the linear value whose tone mapping in the output pass gives that pixel again.
// Per pixel after blending; per splat it failed (blending happens before the tone mapping – the large inverses of
// overlapping bright splats summed up to white).
//
// Inverse per curve as a 3D table (sRGB colour → log2 of the linear input, LUT_SIZE³, half floats; computed once per
// curve on the CPU in slices between frames, ~1 s): Levenberg–Marquardt in log2 space with a numeric Jacobian (ACES,
// AgX and Neutral mix the channels), starting from the colour and from the previous cell – the better one (a neighbour
// in a flat, clamped region alone led into wrong minima). Exposure only scales the input of every curve → divided in
// the shader. Reinhard and linear are inverted in closed form. ACES and AgX desaturate by design: saturated colours
// lie outside what they can produce at all (ACES: ~44 % of random sRGB colours > 3 levels off) – the table holds the
// closest reachable colour; Neutral and Cineon: about 1 level mean deviation (table + interpolation).
// The forward curves below must match three.js (src/nodes/display/ToneMappingFunctions.js, r186) – check on a three.js
// update. Careful: TSL mat3 with nine numbers is row-major (new Matrix3(...)), mat3 of three vec3 takes columns
// (WGSL constructor) – the ACES matrices are written the first way, AgX's the second. Test: Scratchpad mix/lut-test.mjs.
import * as THREE from 'three/webgpu';

export const LUT_SIZE = 33;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mat = c => v => [c[0] * v[0] + c[3] * v[1] + c[6] * v[2], c[1] * v[0] + c[4] * v[1] + c[7] * v[2], c[2] * v[0] + c[5] * v[1] + c[8] * v[2]];   // columns
const rows = c => v => [c[0] * v[0] + c[1] * v[1] + c[2] * v[2], c[3] * v[0] + c[4] * v[1] + c[5] * v[2], c[6] * v[0] + c[7] * v[1] + c[8] * v[2]];
const ACES_IN = rows([0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777]);
const ACES_OUT = rows([1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602]);
const fit = x => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081);
const TO_2020 = mat([0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956]);
const FROM_2020 = mat([1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187]);
const AGX_INSET = mat([0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859]);
const AGX_OUTSET = mat([1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405]);
const agxContrast = x => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; };

// forward curves at exposure 1: linear input → linear output (before the sRGB encoding of the output pass)
const FORWARD = {
    [THREE.ACESFilmicToneMapping]: c => ACES_OUT(ACES_IN(c.map(v => v / 0.6)).map(fit)).map(v => clamp(v)),
    [THREE.AgXToneMapping]: c => {
        const v = AGX_INSET(TO_2020(c)).map(x => clamp((Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393))).map(agxContrast);
        return FROM_2020(AGX_OUTSET(v).map(x => Math.max(0, x) ** 2.2)).map(x => clamp(x));
    },
    [THREE.NeutralToneMapping]: c0 => {
        const m = Math.min(...c0), off = m < 0.08 ? m - 6.25 * m * m : 0.04;
        let c = c0.map(v => v - off);
        const peak = Math.max(...c), start = 0.76, d = 1 - start;
        if (peak < start) return c;
        const np = 1 - d * d / (peak + d - start);
        c = c.map(v => v * np / peak);
        const g = 1 - 1 / (0.15 * (peak - np) + 1);
        return c.map(v => v * (1 - g) + np * g);
    },
    [THREE.CineonToneMapping]: c => c.map(x0 => { const x = Math.max(0, x0 - 0.004); return ((x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06)) ** 2.2; }),
};

/** does this curve need a table (otherwise closed form: none, linear, Reinhard)? */
export const needsTable = mapping => !!FORWARD[mapping];

const tables = new Map();   // tone mapping → Promise<Data3DTexture>

/** inverse table of a curve (cached; null for curves inverted in closed form). Computed in slices between frames */
export function inverseToneTable(mapping) {
    if (!FORWARD[mapping]) return null;
    if (!tables.has(mapping)) tables.set(mapping, buildTable(FORWARD[mapping]));
    return tables.get(mapping);
}

async function buildTable(F) {
    const N = LUT_SIZE;
    const data = new Uint16Array(N * N * N * 4);
    const decode = s => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    let guess = null, slice = performance.now();
    for (let b = 0; b < N; b++) {
        for (let g = 0; g < N; g++) {
            if (performance.now() - slice > 8) { await new Promise(r => setTimeout(r)); slice = performance.now(); }
            for (let r = 0; r < N; r++) {
                const target = [r, g, b].map(i => decode(i / (N - 1)));
                const own = solve(F, target, null);
                guess = r > 0 ? better(F, target, own, solve(F, target, guess)) : own;
                const o = ((b * N + g) * N + r) * 4;
                for (let k = 0; k < 3; k++) data[o + k] = THREE.DataUtils.toHalfFloat(guess[k]);
                data[o + 3] = THREE.DataUtils.toHalfFloat(1);
            }
        }
    }
    const tex = new THREE.Data3DTexture(data, N, N, N);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.HalfFloatType;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
}

// of two solutions (log2 inputs) the one whose output is closer to the target (log2 residuals)
function better(F, target, a, b) {
    const err = u => F(u.map(v => 2 ** v)).reduce((s, v, k) => s + (Math.log2(Math.max(v, 1e-6)) - Math.log2(Math.max(target[k], 1e-4))) ** 2, 0);
    return err(a) <= err(b) ? a : b;
}

// log2 of the input whose curve output is closest to `target` (log2 residuals – dark colours count as much as bright)
function solve(F, target, start) {
    const t = target.map(v => clamp(v, 1e-4, 0.97)), lt = t.map(Math.log2);
    const LF = u => F(u.map(v => 2 ** v)).map(v => Math.log2(Math.max(v, 1e-6)));
    let u = start ? start.slice() : lt.slice();
    const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let it = 0; it < 12; it++) {
        const f = LF(u), res = f.map((v, k) => v - lt[k]);
        if (Math.max(...res.map(Math.abs)) < 1e-4) break;
        for (let k = 0; k < 3; k++) {
            const up = u.slice();
            up[k] += 0.02;
            const fk = LF(up);
            for (let j = 0; j < 3; j++) J[j][k] = (fk[j] - f[j]) / 0.02;
        }
        // damping relative to the curve's slope: near the shoulder (white) the slope is tiny – an absolute damping held
        // the solution near its start there (white came out too dark)
        const A = [0, 1, 2].map(a => [0, 1, 2].map(b => J[0][a] * J[0][b] + J[1][a] * J[1][b] + J[2][a] * J[2][b]));
        const lambda = 1e-3 * Math.max(A[0][0], A[1][1], A[2][2]) + 1e-12;
        for (let k = 0; k < 3; k++) A[k][k] += lambda;
        const rhs = [0, 1, 2].map(a => J[0][a] * res[0] + J[1][a] * res[1] + J[2][a] * res[2]);
        const d = solve3(A, rhs);
        u = u.map((v, k) => clamp(v - clamp(d[k], -4, 4), -20, 12));
    }
    return u;
}

function solve3(A, b) {
    const [[a, bb, c], [d, e, f], [g, h, i]] = A;
    const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(det) < 1e-12) return [0, 0, 0];
    const inv = [[e * i - f * h, c * h - bb * i, bb * f - c * e], [f * g - d * i, a * i - c * g, c * d - a * f], [d * h - e * g, bb * g - a * h, a * e - bb * d]];
    return inv.map(r => (r[0] * b[0] + r[1] * b[1] + r[2] * b[2]) / det);
}

/** for tests */
export const _test = { FORWARD, solve };

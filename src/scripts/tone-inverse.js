// Background colours that look exactly as picked (environment.backdrop – docs/environment.md "Hintergrund"): the tone curves
// as three.js r187 renders them (nodes/display/ToneMappingFunctions.js) in JS, and their inverse – a colour on screen → the
// scene value that shows it after exposure and tone mapping. Checked against the rendered picture (tools/player-check
// backdrop.js) – on a three.js update compare the curves.
import * as THREE from 'three/webgpu';

// 3×3 matrices row by row; three.js mat3(9 numbers) is a Matrix3 (row by row), mat3(vec3, vec3, vec3) takes columns
const mul = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
const columns = (a, b, c) => [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
const clamp01 = v => v.map(x => Math.min(Math.max(x, 0), 1));

const ACES_IN = [0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777];
const ACES_OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];
const REC2020_TO_SRGB = columns([1.6605, -0.1246, -0.0182], [-0.5876, 1.1329, -0.1006], [-0.0728, -0.0083, 1.1187]);
const SRGB_TO_REC2020 = columns([0.6274, 0.0691, 0.0164], [0.3293, 0.9195, 0.0880], [0.0433, 0.0113, 0.8956]);
const AGX_INSET = columns([0.856627153315983, 0.137318972929847, 0.11189821299995], [0.0951212405381588, 0.761241990602591, 0.0767994186031903], [0.0482516061458583, 0.101439036467562, 0.811302368396859]);
const AGX_OUTSET = columns([1.1271005818144368, -0.1413297634984383, -0.14132976349843826], [-0.11060664309660323, 1.157823702216272, -0.11060664309660294], [-0.016493938717834573, -0.016493938717834257, 1.2519364065950405]);
const AGX_MIN_EV = -12.47393, AGX_MAX_EV = 4.026069;
const agxContrast = x => { const x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; };

// scene colour (linear sRGB) → displayed colour (linear sRGB, before the sRGB transfer of the output)
const CURVES = {
    [THREE.NoToneMapping]: c => c,
    [THREE.LinearToneMapping]: (c, e) => clamp01(c.map(x => x * e)),
    [THREE.ReinhardToneMapping]: (c, e) => clamp01(c.map(x => { const v = x * e; return v / (v + 1); })),
    [THREE.CineonToneMapping]: (c, e) => c.map(x => { const v = Math.max(x * e - 0.004, 0); return ((v * (6.2 * v + 0.5)) / (v * (6.2 * v + 1.7) + 0.06)) ** 2.2; }),
    [THREE.ACESFilmicToneMapping]: (c, e) => {
        const v = mul(ACES_IN, c.map(x => x * e / 0.6)).map(x => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
        return clamp01(mul(ACES_OUT, v));
    },
    [THREE.AgXToneMapping]: (c, e) => {
        let v = mul(AGX_INSET, mul(SRGB_TO_REC2020, c.map(x => x * e)));
        v = v.map(x => Math.min(Math.max((Math.log2(Math.max(x, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0), 1)).map(agxContrast);
        v = mul(AGX_OUTSET, v).map(x => Math.max(x, 0) ** 2.2);
        return clamp01(mul(REC2020_TO_SRGB, v));
    },
    [THREE.NeutralToneMapping]: (c, e) => {
        let v = c.map(x => x * e);
        const low = Math.min(...v);
        const offset = low < 0.08 ? low - 6.25 * low * low : 0.04;
        v = v.map(x => x - offset);
        const peak = Math.max(...v);
        if (peak < 0.76) return v;
        const d = 1 - 0.76;
        const newPeak = 1 - d * d / (peak + d - 0.76);
        v = v.map(x => x * newPeak / peak);
        const g = 1 - 1 / (0.15 * (peak - newPeak) + 1);
        return v.map(x => x + (newPeak - x) * g);
    },
};
export const toneCurve = curve => CURVES[curve] ?? CURVES[THREE.ACESFilmicToneMapping];

// 3×3 solve (Cramer); null when singular
function solve3(m, b) {
    const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    if (Math.abs(det) < 1e-14) return null;
    const col = (k, i) => (i % 3 === k ? b[Math.floor(i / 3)] : m[i]);
    return [0, 1, 2].map(k => {
        const r = Array.from({ length: 9 }, (_, i) => col(k, i));
        return (r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6])) / det;
    });
}

/**
 * The scene colour that is shown as `display` (linear sRGB 0…1) with this tone curve and exposure – Newton on all three
 * channels (the curves mix them), started from the grey that shows each channel's value. White and full colours sit at the
 * top of a curve: aimed a little below it (some curves never reach 1).
 */
export function sceneColorFor(display, curve, exposure) {
    const T = toneCurve(curve);
    const goal = display.map(v => Math.min(Math.max(v, 0), 0.996));
    const grey = g => {   // the grey whose shown value is g (bisection on a log scale)
        if (g <= 0) return 0;
        let lo = 1e-6, hi = 1e4;
        for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); const y = T([mid, mid, mid], exposure); if ((y[0] + y[1] + y[2]) / 3 < g) lo = mid; else hi = mid; }
        return Math.sqrt(lo * hi);
    };
    let x = goal.map(grey);
    for (let i = 0; i < 20; i++) {
        const y = T(x, exposure);
        const err = y.map((v, k) => v - goal[k]);
        if (Math.max(...err.map(Math.abs)) < 2e-5) break;
        // Jacobian J[j][k] = ∂y_j / ∂x_k (row by row)
        const J = new Array(9);
        for (let k = 0; k < 3; k++) {
            const h = Math.max(x[k] * 1e-4, 1e-7);
            const xp = x.slice();
            xp[k] += h;
            const yp = T(xp, exposure);
            for (let j = 0; j < 3; j++) J[j * 3 + k] = (yp[j] - y[j]) / h;
        }
        const step = solve3(J, err);
        if (!step) break;
        x = x.map((v, k) => Math.max(v - step[k], 0));
    }
    return x;
}

const toLinear = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * Scene colours along a background gradient (environment.js VignetteBackground): `steps` entries, each the colour shown at
 * that point – mixed in sRGB like a CSS gradient – turned into the scene value for the curve and exposure. Flat RGB array.
 */
export function backgroundRamp(colors, curve, exposure, steps = 256) {
    const [a, b = a] = colors.map(c => new THREE.Color(c));
    const ramp = new Float32Array(steps * 3);
    const n = colors.length > 1 && !a.equals(b) ? steps : 1;
    const srgb = [a.clone().convertLinearToSRGB(), b.clone().convertLinearToSRGB()];   // (THREE.Color holds linear values)
    for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0;
        const shown = ['r', 'g', 'b'].map(k => toLinear(srgb[0][k] + (srgb[1][k] - srgb[0][k]) * t));
        ramp.set(sceneColorFor(shown, curve, exposure), i * 3);
    }
    for (let i = n; i < steps; i++) ramp.copyWithin(i * 3, 0, 3);
    return ramp;
}

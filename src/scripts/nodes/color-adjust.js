// Colour adjustments like MaterialX's (Nov. 2026): HSV shift (hue added, saturation and value multiplied),
// saturation, contrast around a pivot and the combined colour correction (MaterialX colorcorrect: hue → saturation →
// gamma → lift → gain → contrast → exposure, in that order). HSV ↔ RGB after Foley & van Dam – the conversion
// MaterialX uses, so the exported nodes give the same colours.
import * as THREE from 'three/webgpu';
import { float, vec3, dot, min, max, abs, floor, pow, sign, mix, select } from 'three/tsl';
import { C, T, tsl, input, LUMA } from '../node-lib.js';

const COLOR = { category: 'color', color: 'bg-sky-700' };
const num = (key, def, lo, hi, step = 0.01) => ({ key, kind: 'number', min: lo, max: hi, step, default: def });
// MaterialX's default luma coefficients (ACEScg) – its colorcorrect saturates with them
const LUMA_ACESCG = [0.2722287, 0.6740818, 0.0536895];

// --- HSV (h, s, v in 0..1; hue wraps) ---
function rgbToHsvJs(r, g, b) {
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b), d = mx - mn;
    const s = mx > 0 ? d / mx : 0;
    let h = 0;
    if (s > 0) {
        h = (r >= mx ? (g - b) / d : g >= mx ? 2 + (b - r) / d : 4 + (r - g) / d) / 6;
        if (h < 0) h += 1;
    }
    return [h, s, mx];
}
export function hsvToRgbJs(h, s, v) {
    if (s < 0.0001) return [v, v, v];
    const h6 = 6 * (h - Math.floor(h)), hi = Math.trunc(h6), f = h6 - hi;
    const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][Math.min(hi, 5)];
}
function rgbToHsv(c) {
    const mn = min(c.x, min(c.y, c.z)), mx = max(c.x, max(c.y, c.z)), d = mx.sub(mn);
    const s = select(mx.greaterThan(0), d.div(mx), float(0));
    let h = select(c.x.greaterThanEqual(mx), c.y.sub(c.z).div(d),
        select(c.y.greaterThanEqual(mx), c.z.sub(c.x).div(d).add(2), c.x.sub(c.y).div(d).add(4))).div(6);
    h = select(h.lessThan(0), h.add(1), h);
    return vec3(select(s.lessThanEqual(0), float(0), h), s, mx);
}
export function hsvToRgb(hsv) {
    const h6 = hsv.x.sub(floor(hsv.x)).mul(6), hi = floor(h6), f = h6.sub(hi);
    const v = hsv.z, s = hsv.y;
    const p = v.mul(float(1).sub(s)), q = v.mul(float(1).sub(s.mul(f))), t = v.mul(float(1).sub(s.mul(float(1).sub(f))));
    const rgb = select(hi.equal(0), vec3(v, t, p), select(hi.equal(1), vec3(q, v, p), select(hi.equal(2), vec3(p, v, t),
        select(hi.equal(3), vec3(p, q, v), select(hi.equal(4), vec3(t, p, v), vec3(v, p, q))))));
    return select(s.lessThan(0.0001), vec3(v, v, v), rgb);
}

// --- the adjustments, as [JS on a THREE.Color, TSL on a vec3] ---
const hsvShiftJs = (c, dh, ks, kv) => {
    const [h, s, v] = rgbToHsvJs(c.r, c.g, c.b);
    return new THREE.Color(...hsvToRgbJs(h + dh, s * ks, v * kv));
};
const hsvShift = (c, dh, ks, kv) => {
    const hsv = rgbToHsv(c);
    return hsvToRgb(vec3(hsv.x.add(dh), hsv.y.mul(ks), hsv.z.mul(kv)));
};
const saturateJs = (c, amount, luma) => {
    const l = c.r * luma[0] + c.g * luma[1] + c.b * luma[2];
    return new THREE.Color(l + (c.r - l) * amount, l + (c.g - l) * amount, l + (c.b - l) * amount);
};
const saturate = (c, amount, luma) => mix(vec3(dot(c, vec3(...luma))), c, amount);
const contrastJs = (c, amount, pivot) => new THREE.Color((c.r - pivot) * amount + pivot, (c.g - pivot) * amount + pivot, (c.b - pivot) * amount + pivot);
const contrast = (c, amount, pivot) => c.sub(pivot).mul(amount).add(pivot);
const gammaJs = (x, g) => Math.sign(x) * Math.pow(Math.abs(x), 1 / g);

function colorCorrectJs(c, p) {
    let o = hsvShiftJs(c, p.hue, 1, 1);
    o = saturateJs(o, p.saturation, LUMA_ACESCG);
    o = new THREE.Color(gammaJs(o.r, p.gamma), gammaJs(o.g, p.gamma), gammaJs(o.b, p.gamma));
    const k = (1 - p.lift) * p.gain, add = p.lift * p.gain;
    o = new THREE.Color(o.r * k + add, o.g * k + add, o.b * k + add);
    o = contrastJs(o, p.contrast, p.contrastPivot);
    return o.multiplyScalar(2 ** p.exposure);
}
function colorCorrect(c, p) {
    let o = hsvShift(c, p.hue, 1, 1);
    o = saturate(o, p.saturation, LUMA_ACESCG);
    o = sign(o).mul(pow(abs(o), vec3(1 / p.gamma)));
    o = o.mul(1 - p.lift).add(p.lift).mul(p.gain);
    o = contrast(o, p.contrast, p.contrastPivot);
    return o.mul(2 ** p.exposure);
}

const colorIn = { key: 'color', type: 'color' };
const colorParam = { key: 'color', kind: 'color', default: '#808080' };
const out = [{ key: 'color', type: 'color' }];

export default [
    {
        type: 'hsvAdjust', ...COLOR, inputs: [colorIn], outputs: out,
        params: [colorParam, num('hue', 0, -1, 1), num('saturation', 1, 0, 4), num('value', 1, 0, 4)],
        evaluate(port, p, get) {
            const c = input(get, 'color', 'color', p.color);
            if (c.isConst) return C(hsvShiftJs(c.value, p.hue, p.saturation, p.value));
            return T(hsvShift(tsl(c), p.hue, p.saturation, p.value), 'color');
        },
        mtlx: { write: async x => x.mx.add('hsvadjust', 'color3', { in: await x.input('color', 'color'), amount: x.v.V3(x.p.hue, x.p.saturation, x.p.value) }) },
    },
    {
        type: 'saturate', ...COLOR, inputs: [colorIn], outputs: out,
        params: [colorParam, num('amount', 1, 0, 4)],
        evaluate(port, p, get) {
            const c = input(get, 'color', 'color', p.color);
            if (c.isConst) return C(saturateJs(c.value, p.amount, LUMA));
            return T(saturate(tsl(c), p.amount, LUMA), 'color');
        },
        mtlx: { write: async x => x.mx.add('saturate', 'color3', { in: await x.input('color', 'color'), amount: x.v.F(x.p.amount), lumacoeffs: x.v.LUMA }) },
    },
    {
        type: 'contrast', ...COLOR, inputs: [colorIn], outputs: out,
        params: [colorParam, num('amount', 1, 0, 4), num('pivot', 0.5, 0, 1)],
        evaluate(port, p, get) {
            const c = input(get, 'color', 'color', p.color);
            if (c.isConst) return C(contrastJs(c.value, p.amount, p.pivot));
            return T(contrast(tsl(c), p.amount, p.pivot), 'color');
        },
        mtlx: { write: async x => x.mx.add('contrast', 'color3', { in: await x.input('color', 'color'), amount: x.v.F(x.p.amount), pivot: x.v.F(x.p.pivot) }) },
    },
    {
        type: 'colorCorrect', ...COLOR, inputs: [colorIn], outputs: out,
        params: [colorParam, num('hue', 0, -1, 1), num('saturation', 1, 0, 4), num('gamma', 1, 0.05, 5), num('lift', 0, -1, 1),
            num('gain', 1, 0, 4), num('contrast', 1, 0, 4), num('contrastPivot', 0.5, 0, 1), num('exposure', 0, -5, 5, 0.05)],
        evaluate(port, p, get) {
            const c = input(get, 'color', 'color', p.color);
            if (c.isConst) return C(colorCorrectJs(c.value, p));
            return T(colorCorrect(tsl(c), p), 'color');
        },
        mtlx: {
            write: async x => x.mx.add('colorcorrect', 'color3', {
                in: await x.input('color', 'color'), hue: x.v.F(x.p.hue), saturation: x.v.F(x.p.saturation), gamma: x.v.F(x.p.gamma),
                lift: x.v.F(x.p.lift), gain: x.v.F(x.p.gain), contrast: x.v.F(x.p.contrast), contrastpivot: x.v.F(x.p.contrastPivot), exposure: x.v.F(x.p.exposure),
            }),
        },
    },
];

// Value operations like MaterialX's (Nov. 2026, alignment with MaterialX – graph-mtlx.js writes them as these nodes):
// clamp, smoothstep (0 at or below low, 1 at or above high, smooth in between) and range (remap from in-low..in-high
// to 0..1, gamma, onto out-low..out-high, optionally clamped).
import { float, min, max, abs, pow, sign, smoothstep, select } from 'three/tsl';
import { C, T, tsl, input } from '../node-lib.js';

const VALUE = { category: 'value', color: 'bg-violet-700' };
const num = (key, def, lo = 0, hi = 1, step = 0.01) => ({ key, kind: 'number', min: lo, max: hi, step, default: def });

// MaterialX smoothstep (mx_smoothstep_float): the edges first, then GLSL's smoothstep
const jsSmooth = (v, lo, hi) => {
    if (v >= hi) return 1;
    if (v <= lo) return 0;
    const t = Math.min(Math.max((v - lo) / (hi - lo), 0), 1);
    return t * t * (3 - 2 * t);
};
// MaterialX range: remap to 0..1, sign(x)·|x|^(1/gamma), onto out-low..out-high, clamp on request
const jsRange = (v, p) => {
    const r = (v - p.inLow) / (p.inHigh - p.inLow);
    const g = Math.sign(r) * Math.pow(Math.abs(r), 1 / p.gamma);
    const o = p.outLow + g * (p.outHigh - p.outLow);
    return p.clamp ? Math.min(Math.max(o, p.outLow), p.outHigh) : o;
};

export default [
    {
        type: 'clamp', ...VALUE,
        inputs: [{ key: 'value', type: 'float' }, { key: 'low', type: 'float' }, { key: 'high', type: 'float' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [num('value', 0.5), num('low', 0), num('high', 1)],
        evaluate(port, p, get) {
            const v = input(get, 'value', 'float', p.value), lo = input(get, 'low', 'float', p.low), hi = input(get, 'high', 'float', p.high);
            // GLSL's clamp = min(max(x, low), high)
            if (v.isConst && lo.isConst && hi.isConst) return C(Math.min(Math.max(v.value, lo.value), hi.value));
            return T(min(max(tsl(v), tsl(lo)), tsl(hi)), 'float');
        },
        mtlx: { write: async x => x.mx.add('clamp', 'float', { in: await x.input('value', 'float'), low: await x.input('low', 'float'), high: await x.input('high', 'float') }) },
    },
    {
        type: 'smoothstep', ...VALUE,
        inputs: [{ key: 'value', type: 'float' }, { key: 'low', type: 'float' }, { key: 'high', type: 'float' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [num('value', 0.5), num('low', 0), num('high', 1)],
        evaluate(port, p, get) {
            const v = input(get, 'value', 'float', p.value), lo = input(get, 'low', 'float', p.low), hi = input(get, 'high', 'float', p.high);
            if (v.isConst && lo.isConst && hi.isConst) return C(jsSmooth(v.value, lo.value, hi.value));
            const x = tsl(v), l = tsl(lo), h = tsl(hi);
            return T(select(x.greaterThanEqual(h), float(1), select(x.lessThanEqual(l), float(0), smoothstep(l, h, x))), 'float');
        },
        mtlx: { write: async x => x.mx.add('smoothstep', 'float', { in: await x.input('value', 'float'), low: await x.input('low', 'float'), high: await x.input('high', 'float') }) },
    },
    {
        type: 'range', ...VALUE,
        inputs: [{ key: 'value', type: 'float' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [num('value', 0.5), num('inLow', 0), num('inHigh', 1), num('gamma', 1, 0.01, 10), num('outLow', 0), num('outHigh', 1),
            { key: 'clamp', kind: 'bool', default: false }],
        evaluate(port, p, get) {
            const v = input(get, 'value', 'float', p.value);
            if (v.isConst) return C(jsRange(v.value, p));
            const r = tsl(v).sub(p.inLow).div(p.inHigh - p.inLow);
            const g = sign(r).mul(pow(abs(r), float(1 / p.gamma)));
            const o = g.mul(p.outHigh - p.outLow).add(p.outLow);
            return T(p.clamp ? min(max(o, p.outLow), p.outHigh) : o, 'float');
        },
        mtlx: {
            write: async x => x.mx.add('range', 'float', {
                in: await x.input('value', 'float'), inlow: x.v.F(x.p.inLow), inhigh: x.v.F(x.p.inHigh), gamma: x.v.F(x.p.gamma),
                outlow: x.v.F(x.p.outLow), outhigh: x.v.F(x.p.outHigh), doclamp: x.v.B(x.p.clamp),
            }),
        },
    },
];

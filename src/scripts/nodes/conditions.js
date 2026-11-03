// Conditions like MaterialX's (Nov. 2026): compare two values and pick one of two colours (ifgreater / ifgreatereq /
// ifequal), switch between up to five colours by a number (MaterialX switch: below 1 the first, below 2 the second …,
// from 5 on black) and logic on masks (true = above 0.5; result 1 or 0 – MaterialX's boolean and / or / xor / not).
import * as THREE from 'three/webgpu';
import { float, vec3, select } from 'three/tsl';
import { C, T, tsl, input, convert } from '../node-lib.js';

const num = (key, def, lo = 0, hi = 1, step = 0.01) => ({ key, kind: 'number', min: lo, max: hi, step, default: def });
const COMPARE = { greater: [(a, b) => a > b, (a, b) => a.greaterThan(b), 'ifgreater'], greaterEqual: [(a, b) => a >= b, (a, b) => a.greaterThanEqual(b), 'ifgreatereq'],
    equal: [(a, b) => a === b, (a, b) => a.equal(b), 'ifequal'] };
const LOGIC = { and: [(a, b) => a && b, (a, b) => a.and(b)], or: [(a, b) => a || b, (a, b) => a.or(b)], xor: [(a, b) => a !== b, (a, b) => a.notEqual(b)],
    not: [a => !a, a => a.not()] };
const SWITCH = 5;

// a colour result as the requested port: colour, or its luminance as value (a grey colour gives its value back)
const asPort = (port, r) => (port === 'value' ? convert(r, 'float') : r);

export default [
    {
        type: 'compare', category: 'value', color: 'bg-violet-700',
        inputs: [{ key: 'value1', type: 'float' }, { key: 'value2', type: 'float' }, { key: 'in1', type: 'color' }, { key: 'in2', type: 'color' }],
        outputs: [{ key: 'color', type: 'color' }, { key: 'value', type: 'float' }],
        params: [
            { key: 'op', kind: 'select', options: Object.keys(COMPARE), default: 'greater' },
            num('value1', 0.5), num('value2', 0.5),
            { key: 'in1', kind: 'color', default: '#ffffff' }, { key: 'in2', kind: 'color', default: '#000000' },
        ],
        evaluate(port, p, get) {
            const v1 = input(get, 'value1', 'float', p.value1), v2 = input(get, 'value2', 'float', p.value2);
            const i1 = input(get, 'in1', 'color', p.in1), i2 = input(get, 'in2', 'color', p.in2);
            const [js, gpu] = COMPARE[p.op] || COMPARE.greater;
            if (v1.isConst && v2.isConst) return asPort(port, js(v1.value, v2.value) ? i1 : i2);
            return asPort(port, T(select(gpu(tsl(v1), tsl(v2)), tsl(i1), tsl(i2)), 'color'));
        },
        mtlx: {
            write: async x => {
                const out = x.mx.add((COMPARE[x.p.op] || COMPARE.greater)[2], 'color3', {
                    value1: await x.input('value1', 'float'), value2: await x.input('value2', 'float'), in1: await x.input('in1', 'color'), in2: await x.input('in2', 'color'),
                });
                return x.port === 'value' ? x.as(out, 'float') : out;
            },
        },
    },
    {
        type: 'switch', category: 'value', color: 'bg-violet-700',
        inputs: [...Array.from({ length: SWITCH }, (_, i) => ({ key: `in${i + 1}`, type: 'color' })), { key: 'which', type: 'float' }],
        outputs: [{ key: 'color', type: 'color' }, { key: 'value', type: 'float' }],
        params: [num('which', 0, 0, SWITCH, 1), ...['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ffffff'].map((c, i) => ({ key: `in${i + 1}`, kind: 'color', default: c }))],
        evaluate(port, p, get) {
            const w = input(get, 'which', 'float', p.which);
            const ins = Array.from({ length: SWITCH }, (_, i) => input(get, `in${i + 1}`, 'color', p[`in${i + 1}`]));
            if (w.isConst) return asPort(port, w.value < SWITCH ? ins[Math.max(0, Math.floor(w.value))] : C(new THREE.Color(0, 0, 0)));
            // MaterialX: nested ifgreater from the last – which < k → in_k
            let r = vec3(0, 0, 0);
            for (let k = SWITCH; k >= 1; k--) r = select(float(k).greaterThan(tsl(w)), tsl(ins[k - 1]), r);
            return asPort(port, T(r, 'color'));
        },
        mtlx: {
            write: async x => {
                const inputs = { which: await x.input('which', 'float') };
                for (let i = 1; i <= SWITCH; i++) inputs[`in${i}`] = await x.input(`in${i}`, 'color');
                const out = x.mx.add('switch', 'color3', inputs);
                return x.port === 'value' ? x.as(out, 'float') : out;
            },
        },
    },
    {
        type: 'logic', category: 'value', color: 'bg-violet-700',
        inputs: [{ key: 'a', type: 'float' }, { key: 'b', type: 'float', when: p => p.op !== 'not' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [{ key: 'op', kind: 'select', options: Object.keys(LOGIC), default: 'and' }, num('a', 1), { ...num('b', 1), when: p => p.op !== 'not' }],
        evaluate(port, p, get) {
            const a = input(get, 'a', 'float', p.a), b = input(get, 'b', 'float', p.b);
            const [js, gpu] = LOGIC[p.op] || LOGIC.and;
            if (a.isConst && b.isConst) return C(js(a.value > 0.5, b.value > 0.5) ? 1 : 0);
            return T(select(gpu(tsl(a).greaterThan(0.5), tsl(b).greaterThan(0.5)), float(1), float(0)), 'float');
        },
        mtlx: {
            // masks → booleans (ifgreater 0.5), the logic node, back to 0/1 (convert)
            write: async x => {
                const bool = async key => x.mx.add('ifgreater', 'boolean', { value1: await x.input(key, 'float'), value2: x.v.F(0.5) }, `${key}_true`);
                const op = LOGIC[x.p.op] ? x.p.op : 'and';
                const b = op === 'not' ? x.mx.add('not', 'boolean', { in: await bool('a') }) : x.mx.add(op, 'boolean', { in1: await bool('a'), in2: await bool('b') });
                return x.mx.add('convert', 'float', { in: b });
            },
        },
    },
];

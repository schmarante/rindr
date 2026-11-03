// Blend modes like MaterialX's compositing nodes (Nov. 2026): b (foreground) over a (background) by factor –
// multiply, screen, overlay, difference, add, subtract, dodge, burn; each as MaterialX defines it (factor 0 = a).
// Multiply has no compositing node in MaterialX: written as mix(a, a × b, factor).
import * as THREE from 'three/webgpu';
import { float, vec3, abs, mix, select } from 'three/tsl';
import { C, T, tsl, input } from '../node-lib.js';

const EPS = 1e-8;   // MaterialX's M_FLOAT_EPS (dodge/burn)
// per channel: [JS (fg, bg, m), TSL (fg, bg, m)] – fg/bg one channel, m the factor
const OPS = {
    multiply: [(f, b, m) => b + (f * b - b) * m, (f, b, m) => mix(b, f.mul(b), m)],
    screen: [(f, b, m) => m * (1 - (1 - f) * (1 - b)) + (1 - m) * b, (f, b, m) => m.mul(float(1).sub(float(1).sub(f).mul(float(1).sub(b)))).add(float(1).sub(m).mul(b))],
    overlay: [
        (f, b, m) => b + ((b >= 0.5 ? 1 - 2 * (1 - b) * (1 - f) : 2 * f * b) - b) * m,
        (f, b, m) => mix(b, select(b.greaterThanEqual(0.5), float(1).sub(float(1).sub(b).mul(float(1).sub(f)).mul(2)), f.mul(b).mul(2)), m),
    ],
    difference: [(f, b, m) => m * Math.abs(b - f) + (1 - m) * b, (f, b, m) => m.mul(abs(b.sub(f))).add(float(1).sub(m).mul(b))],
    plus: [(f, b, m) => m * (b + f) + (1 - m) * b, (f, b, m) => m.mul(b.add(f)).add(float(1).sub(m).mul(b))],
    minus: [(f, b, m) => m * (b - f) + (1 - m) * b, (f, b, m) => m.mul(b.sub(f)).add(float(1).sub(m).mul(b))],
    dodge: [
        (f, b, m) => (Math.abs(1 - f) < EPS ? 0 : m * (b / (1 - f)) + (1 - m) * b),
        (f, b, m) => select(abs(float(1).sub(f)).lessThan(EPS), float(0), m.mul(b.div(float(1).sub(f))).add(float(1).sub(m).mul(b))),
    ],
    burn: [
        (f, b, m) => (Math.abs(f) < EPS ? 0 : m * (1 - (1 - b) / f) + (1 - m) * b),
        (f, b, m) => select(abs(f).lessThan(EPS), float(0), m.mul(float(1).sub(float(1).sub(b).div(f))).add(float(1).sub(m).mul(b))),
    ],
};

export default {
    type: 'blend', category: 'color', color: 'bg-sky-700',
    inputs: [{ key: 'a', type: 'color' }, { key: 'b', type: 'color' }, { key: 'factor', type: 'float' }],
    outputs: [{ key: 'color', type: 'color' }],
    params: [
        { key: 'op', kind: 'select', options: Object.keys(OPS), default: 'multiply' },
        { key: 'a', kind: 'color', default: '#808080' },
        { key: 'b', kind: 'color', default: '#ffffff' },
        { key: 'factor', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 },
    ],
    evaluate(port, p, get) {
        const a = input(get, 'a', 'color', p.a), b = input(get, 'b', 'color', p.b), f = input(get, 'factor', 'float', p.factor);
        const [js, gpu] = OPS[p.op] || OPS.multiply;
        if (a.isConst && b.isConst && f.isConst) {
            const ch = k => js(b.value[k], a.value[k], f.value);
            return C(new THREE.Color(ch('r'), ch('g'), ch('b')));
        }
        const fg = tsl(b), bg = tsl(a), m = tsl(f);
        return T(vec3(gpu(fg.x, bg.x, m), gpu(fg.y, bg.y, m), gpu(fg.z, bg.z, m)), 'color');
    },
    mtlx: {
        write: async x => {
            const bg = await x.input('a', 'color'), fg = await x.input('b', 'color'), m = await x.input('factor', 'float');
            if (x.p.op === 'multiply') return x.mx.add('mix', 'color3', { fg: x.mx.add('multiply', 'color3', { in1: bg, in2: fg }), bg, mix: m });
            return x.mx.add(OPS[x.p.op] ? x.p.op : 'multiply', 'color3', { fg, bg, mix: m });
        },
    },
};

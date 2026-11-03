// Channels and coordinates like MaterialX's (Nov. 2026): the texture coordinate (texcoord – the tile's 0..1 here, the
// MaterialX export writes texcoord, see graph-mtlx.js), separating a colour into R/G/B, combining three values into a
// colour, and the luminance of a colour (Rec.709 – RINDR's working space).
import * as THREE from 'three/webgpu';
import { vec3, dot } from 'three/tsl';
import { C, T, tsl, input, LUMA } from '../node-lib.js';

const num = (key, def) => ({ key, kind: 'number', min: 0, max: 1, step: 0.01, default: def });

export default [
    {
        type: 'texcoord', category: 'input', color: 'bg-slate-600',
        inputs: [],
        outputs: [{ key: 'uv', type: 'vector' }, { key: 'u', type: 'float' }, { key: 'v', type: 'float' }],
        params: [],
        evaluate(port, p, get, ctx) {
            if (port === 'uv') return T(ctx.base, 'vector');
            return T(port === 'v' ? ctx.base.y : ctx.base.x, 'float');
        },
        mtlx: {
            write: async x => (x.port === 'uv' ? x.texcoord()
                : x.mx.add('extract', 'float', { in: x.texcoord(), index: x.v.I(x.port === 'v' ? 1 : 0) })),
        },
    },
    {
        type: 'separate', category: 'color', color: 'bg-sky-700',
        inputs: [{ key: 'color', type: 'color' }],
        outputs: [{ key: 'r', type: 'float' }, { key: 'g', type: 'float' }, { key: 'b', type: 'float' }],
        params: [{ key: 'color', kind: 'color', default: '#808080' }],
        evaluate(port, p, get) {
            const c = input(get, 'color', 'color', p.color);
            if (c.isConst) return C(c.value[port]);
            return T(tsl(c)[port === 'r' ? 'x' : port === 'g' ? 'y' : 'z'], 'float');
        },
        mtlx: {
            write: async x => {
                const s = x.mx.add('separate3', 'multioutput', { in: await x.input('color', 'color') });
                return x.mx.out(s, 'out' + x.port, 'float');
            },
        },
    },
    {
        type: 'combine', category: 'color', color: 'bg-sky-700',
        inputs: [{ key: 'r', type: 'float' }, { key: 'g', type: 'float' }, { key: 'b', type: 'float' }],
        outputs: [{ key: 'color', type: 'color' }],
        params: [num('r', 0), num('g', 0), num('b', 0)],
        evaluate(port, p, get) {
            const r = input(get, 'r', 'float', p.r), g = input(get, 'g', 'float', p.g), b = input(get, 'b', 'float', p.b);
            if (r.isConst && g.isConst && b.isConst) return C(new THREE.Color(r.value, g.value, b.value));
            return T(vec3(tsl(r), tsl(g), tsl(b)), 'color');
        },
        mtlx: {
            write: async x => x.mx.add('combine3', 'color3', { in1: await x.input('r', 'float'), in2: await x.input('g', 'float'), in3: await x.input('b', 'float') }),
        },
    },
    {
        type: 'luminance', category: 'color', color: 'bg-sky-700',
        inputs: [{ key: 'color', type: 'color' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [{ key: 'color', kind: 'color', default: '#808080' }],
        evaluate(port, p, get) {
            const c = input(get, 'color', 'color', p.color);
            if (c.isConst) return C(c.value.r * LUMA[0] + c.value.g * LUMA[1] + c.value.b * LUMA[2]);
            return T(dot(tsl(c), vec3(...LUMA)), 'float');
        },
        mtlx: {
            write: async x => {
                const l = x.mx.add('luminance', 'color3', { in: await x.input('color', 'color'), lumacoeffs: x.v.LUMA });
                return x.mx.add('extract', 'float', { in: l, index: x.v.I(0) });
            },
        },
    },
];

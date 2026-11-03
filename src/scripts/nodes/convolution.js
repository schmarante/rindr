// Height → normal and blur (Nov. 2026, MaterialX's heighttonormal / blur):
// height → normal: MaterialX 1.39 takes the slope from the pixel derivatives of height and coordinate (Sobel scale
// 1/16) – the result is the slope per texture coordinate, the same at any resolution; an encoded normal (0.5 + 0.5 n,
// tangent space) for the normal input. Blur: the input sampled 3 × 3 around the point (box or Gaussian weights,
// `size` = distance in tiles) – everything before it is evaluated nine times, so it suits light blurring; MaterialX's
// own blur is a pass-through in its shader generators, so RINDR bakes it in the export instead of writing a blur node.
import { vec2, vec3, cross, dot, dFdx, dFdy, select } from 'three/tsl';
import { T, tsl, input, convert } from '../node-lib.js';

const BOX = [1, 1, 1, 1, 1, 1, 1, 1, 1].map(w => w / 9);
const GAUSS = [1, 2, 1, 2, 4, 2, 1, 2, 1].map(w => w / 16);

export default [
    {
        type: 'heightToNormal', category: 'value', color: 'bg-violet-700',
        inputs: [{ key: 'height', type: 'float' }],
        outputs: [{ key: 'normal', type: 'color' }],
        params: [{ key: 'height', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 }, { key: 'scale', kind: 'number', min: 0, max: 50, step: 0.1, default: 1 }],
        evaluate(port, p, get, ctx) {
            const h = tsl(input(get, 'height', 'float', p.height));
            const c = ctx.base;
            const dh = vec2(dFdx(h), dFdy(h)).mul(p.scale / 16);
            const t = vec3(dFdx(c.x), dFdx(c.y), dh.x), b = vec3(dFdy(c.x), dFdy(c.y), dh.y);
            const n = cross(t, b);
            const fixed = select(dot(n, n).lessThan(1e-16), vec3(0, 0, 1), select(n.z.lessThan(0), n.negate(), n));
            return T(fixed.normalize().mul(0.5).add(0.5), 'color');
        },
        mtlx: {
            // the derivatives are taken along the tile coordinate (texcoord) like here
            write: async x => {
                const n = x.mx.add('heighttonormal', 'vector3', { in: await x.input('height', 'float'), scale: x.v.F(x.p.scale), texcoord: x.texcoord() });
                return x.mx.add('convert', 'color3', { in: n });
            },
        },
    },
    {
        type: 'blur', category: 'color', color: 'bg-sky-700',
        inputs: [{ key: 'color', type: 'color' }],
        outputs: [{ key: 'color', type: 'color' }],
        params: [
            { key: 'color', kind: 'color', default: '#808080' },
            { key: 'size', kind: 'number', min: 0, max: 0.1, step: 0.001, default: 0.01 },
            { key: 'filter', kind: 'select', options: ['box', 'gaussian'], default: 'gaussian' },
        ],
        evaluate(port, p, get, ctx) {
            const c = input(get, 'color', 'color', p.color);
            if (c.isConst || !(p.size > 0) || !ctx.sample) return c;
            const w = p.filter === 'box' ? BOX : GAUSS;
            let sum = vec3(0, 0, 0);
            for (let j = -1, i = 0; j <= 1; j++) for (let k = -1; k <= 1; k++, i++) {
                const s = ctx.sample('color', vec2(k * p.size, j * p.size));
                sum = sum.add(tsl(convert(s, 'color')).mul(w[i]));
            }
            return T(sum, 'color');
        },
        // no mtlx writer: baked
    },
];

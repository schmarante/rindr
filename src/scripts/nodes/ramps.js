// Ramps like MaterialX's (Nov. 2026): a four-corner ramp over the tile (ramp4) and a split at a position across or
// along it (splitlr / splittb – the edge smoothed over about one texel, MaterialX's aastep). Texture nodes: the
// coordinate settings apply; the MaterialX export wraps the coordinate into the tile first (these are not periodic).
import { float, vec2, length, dFdx, dFdy, smoothstep, clamp, mix } from 'three/tsl';
import { T, tsl, input, coord } from '../node-lib.js';

const color = (key, def) => ({ key, kind: 'color', default: def });

// MaterialX aastep: a step at `threshold` smoothed over the pixel footprint of `value`
const aastep = (threshold, value) => {
    const w = length(vec2(dFdx(value), dFdy(value))).mul(0.70710678118654757);
    return smoothstep(float(threshold).sub(w), float(threshold).add(w), value);
};

export default [
    {
        type: 'ramp4', category: 'texture', color: 'bg-amber-700', texture: true,
        inputs: [{ key: 'uv', type: 'vector' }, { key: 'tl', type: 'color' }, { key: 'tr', type: 'color' }, { key: 'bl', type: 'color' }, { key: 'br', type: 'color' }],
        outputs: [{ key: 'color', type: 'color' }],
        params: [color('tl', '#ff4040'), color('tr', '#40ff40'), color('bl', '#4040ff'), color('br', '#ffffff')],
        evaluate(port, p, get) {
            const c = clamp(coord(get), 0, 1);
            const col = k => tsl(input(get, k, 'color', p[k]));
            return T(mix(mix(col('bl'), col('br'), c.x), mix(col('tl'), col('tr'), c.x), c.y), 'color');
        },
        mtlx: {
            write: async x => x.mx.add('ramp4', 'color3', {
                valuetl: await x.input('tl', 'color'), valuetr: await x.input('tr', 'color'), valuebl: await x.input('bl', 'color'), valuebr: await x.input('br', 'color'),
                texcoord: await x.coord({ tile: true }),
            }),
        },
    },
    {
        // a below / left of the split, b above / right
        type: 'split', category: 'texture', color: 'bg-amber-700', texture: true,
        inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
        outputs: [{ key: 'color', type: 'color' }],
        params: [
            { key: 'axis', kind: 'select', options: ['u', 'v'], default: 'u' },
            { key: 'center', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.5 },
            color('a', '#000000'), color('b', '#ffffff'),
        ],
        evaluate(port, p, get) {
            const c = coord(get);
            const a = tsl(input(get, 'a', 'color', p.a)), b = tsl(input(get, 'b', 'color', p.b));
            return T(mix(a, b, aastep(p.center, p.axis === 'v' ? c.y : c.x)), 'color');
        },
        mtlx: {
            write: async x => {
                const a = await x.input('a', 'color'), b = await x.input('b', 'color'), texcoord = await x.coord({ tile: true }), center = x.v.F(x.p.center);
                return x.p.axis === 'v'
                    ? x.mx.add('splittb', 'color3', { valuet: b, valueb: a, center, texcoord })
                    : x.mx.add('splitlr', 'color3', { valuel: a, valuer: b, center, texcoord });
            },
        },
    },
];

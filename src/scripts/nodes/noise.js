// Noise: tileable fractal value noise.
import { vec2 } from 'three/tsl';
import { T, coord, fbm } from '../node-lib.js';

export default {
    type: 'noise',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }],
    outputs: [{ key: 'value', type: 'float' }],
    params: [
        { key: 'scale', kind: 'number', min: 1, max: 200, step: 1, default: 20 },
        { key: 'detail', kind: 'number', min: 1, max: 6, step: 1, default: 4 },
        { key: 'stretch', kind: 'number', min: 1, max: 50, step: 1, default: 1 },
    ],
    evaluate(port, p, get) {
        const s = Math.max(1, Math.round(p.scale));
        const st = Math.max(1, Math.round(p.stretch));
        return T(fbm(coord(get).mul(vec2(s, s * st)), vec2(s, s * st), Math.round(p.detail)), 'float');
    },
};

// Noise: tileable gradient noise – regular (one octave), fractal or turbulence. `stretch` makes the cells finer
// across v than along u (streaks along u: brushed metal, grain). Thresholds low/high cut the value into patches
// (dirt, grease, mottling); `color` mixes a (value 0) and b (value 1).
import { vec2, mix } from 'three/tsl';
import { T, coord, input, tsl } from '../node-lib.js';
import { noiseSum, thresholds } from './noise-gradient.js';

export default {
    type: 'noise',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
    outputs: [{ key: 'value', type: 'float' }, { key: 'color', type: 'color' }],
    params: [
        { key: 'noiseType', kind: 'select', options: ['regular', 'fractal', 'turbulence'], default: 'fractal' },
        { key: 'scale', kind: 'number', min: 1, max: 200, step: 1, default: 20 },          // cells per tile along u
        { key: 'detail', kind: 'number', min: 1, max: 8, step: 1, default: 4 },            // octaves (fractal, turbulence)
        { key: 'stretch', kind: 'number', min: 1, max: 200, step: 1, default: 1 },         // cells across v = scale × stretch
        { key: 'low', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },
        { key: 'high', kind: 'number', min: 0, max: 1, step: 0.01, default: 1 },
        { key: 'seed', kind: 'number', min: 0, max: 100, step: 1, default: 0 },
        { key: 'a', kind: 'color', default: '#1a1a1a' },
        { key: 'b', kind: 'color', default: '#e6e6e6' },
    ],
    evaluate(port, p, get) {
        const s = Math.max(1, Math.round(p.scale));
        const period = [s, s * Math.max(1, Math.round(p.stretch))];
        const v = thresholds(noiseSum(coord(get).mul(vec2(...period)), period, Math.round(p.detail), p.noiseType,
            Math.round(p.seed)), p.low, p.high);
        if (port !== 'color') return T(v, 'float');
        return T(mix(tsl(input(get, 'a', 'color', p.a)), tsl(input(get, 'b', 'color', p.b)), v), 'color');
    },
};

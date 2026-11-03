// Noise nodes like MaterialX's (Nov. 2026): unified noise (Perlin / cell / Worley / fractal with output range),
// flakes (flake2d – random tilted flakes: value per flake, presence, flake normal for the normal input) and random
// value / colour from a number (randomfloat / randomcolor – e.g. per tile from Tiles' random output). The noise
// itself in mx-noise-lib.js; the lattice wraps with the tile where the frequency is whole (else the tile shows a seam).
import * as THREE from 'three/webgpu';
import { vec2, vec3, min, max } from 'three/tsl';
import { C, T, tsl, input, coord } from '../node-lib.js';
import { perlin2, cell2, worley2, fractal3, flake2d, randomFloat, randomFloatJs } from './mx-noise-lib.js';
import { hsvToRgb, hsvToRgbJs } from './color-adjust.js';

const num = (key, def, lo = 0, hi = 1, step = 0.01, extra = {}) => ({ key, kind: 'number', min: lo, max: hi, step, default: def, ...extra });
const TYPES = ['perlin', 'cell', 'worley', 'fractal'];
const whole = v => (Math.abs(v - Math.round(v)) < 1e-6 && Math.round(v) > 0 ? Math.round(v) : 0);
// lattice cells per tile (the node's own coordinate: tiling × frequency); none when turned or fed another coordinate
const latticePeriod = (p, fu, fv, ctx) => (p.angle || ctx.uvLinked ? [0, 0] : [whole(fu * (p.tilingU ?? 1)), whole(fv * (p.tilingV ?? 1))]);
// MaterialX rotate2d (amount in degrees, turning like RINDR's mapping)
const rotate = (p, deg) => {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return vec2(p.x.mul(c).add(p.y.mul(s)), p.y.mul(c).sub(p.x.mul(s)));
};

export default [
    {
        type: 'unifiedNoise', category: 'texture', color: 'bg-amber-700', texture: true,
        inputs: [{ key: 'uv', type: 'vector' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [
            { key: 'noiseType', kind: 'select', options: TYPES, default: 'perlin' },
            num('freqU', 8, 0.1, 64, 0.1), num('freqV', 8, 0.1, 64, 0.1), num('jitter', 1),
            { key: 'style', kind: 'select', options: ['distance', 'solid'], default: 'distance', when: p => p.noiseType === 'worley' },
            num('octaves', 3, 1, 8, 1, { when: p => p.noiseType === 'fractal' }), num('lacunarity', 2, 1, 4, 0.1, { when: p => p.noiseType === 'fractal' }),
            num('diminish', 0.5, 0, 1, 0.01, { when: p => p.noiseType === 'fractal' }),
            num('outMin', 0), num('outMax', 1), { key: 'clamp', kind: 'bool', default: true },
        ],
        evaluate(port, p, get, ctx) {
            const pos = coord(get).mul(vec2(p.freqU, p.freqV));
            const period = latticePeriod(p, p.freqU, p.freqV, ctx);
            const jitterTurn = (p.jitter - 1) * 90000;   // MaterialX turns Perlin / cell noise by this (degrees)
            let v;
            if (p.noiseType === 'cell' || p.noiseType === 'perlin') {
                const turned = p.jitter !== 1;
                const q = turned ? rotate(pos, jitterTurn) : pos, per = vec2(...(turned ? [0, 0] : period));
                v = p.noiseType === 'cell' ? cell2(q, per) : perlin2(q, per).mul(0.5).add(0.5);
            } else if (p.noiseType === 'worley') {
                v = worley2(pos, p.jitter, p.style, vec2(...period));
            } else {
                v = fractal3(vec3(pos, jitterTurn), Math.max(1, Math.round(p.octaves)), p.lacunarity, p.diminish, period);
            }
            // MaterialX range 0..1 → out-min..out-max
            v = v.mul(p.outMax - p.outMin).add(p.outMin);
            return T(p.clamp ? min(max(v, p.outMin), p.outMax) : v, 'float');
        },
        mtlx: {
            write: async x => x.mx.add('unifiednoise2d', 'float', {
                texcoord: await x.coord(), freq: x.v.V2(x.p.freqU, x.p.freqV), offset: x.v.V2(0, 0), jitter: x.v.F(x.p.jitter),
                outmin: x.v.F(x.p.outMin), outmax: x.v.F(x.p.outMax), clampoutput: x.v.B(x.p.clamp), octaves: x.v.I(Math.max(1, Math.round(x.p.octaves))),
                lacunarity: x.v.F(x.p.lacunarity), diminish: x.v.F(x.p.diminish), type: x.v.I(Math.max(0, TYPES.indexOf(x.p.noiseType))),
                style: x.v.I(x.p.style === 'solid' ? 1 : 0),
            }),
        },
    },
    {
        type: 'flakes', category: 'texture', color: 'bg-amber-700', texture: true,
        inputs: [{ key: 'uv', type: 'vector' }],
        outputs: [{ key: 'rand', type: 'float' }, { key: 'presence', type: 'float' }, { key: 'normal', type: 'color' }],
        params: [num('size', 0.02, 0.002, 0.2, 0.001), num('roughness', 0.1), num('coverage', 0.5)],
        evaluate(port, p, get, ctx) {
            const f = flake2d(coord(get), p.size, p.roughness, p.coverage, latticePeriod(p, 1 / p.size, 1 / p.size, ctx));
            if (port === 'normal') return T(f.normal.mul(0.5).add(0.5), 'color');   // tangent space, as a normal map
            return T(port === 'presence' ? f.presence : f.rand, 'float');
        },
        mtlx: {
            // the flake normal is a world-space vector in MaterialX – RINDR's normal input is baked (null: picture)
            write: async x => {
                if (x.port === 'normal') return null;
                const f = x.mx.add('flake2d', 'multioutput', { size: x.v.F(x.p.size), roughness: x.v.F(x.p.roughness), coverage: x.v.F(x.p.coverage), texcoord: await x.coord() });
                return x.mx.out(f, x.port, 'float');
            },
        },
    },
    {
        type: 'randomFloat', category: 'value', color: 'bg-violet-700',
        inputs: [{ key: 'in', type: 'float' }],
        outputs: [{ key: 'value', type: 'float' }],
        params: [num('in', 0.5), num('min', 0), num('max', 1), num('seed', 0, 0, 1000, 1)],
        evaluate(port, p, get) {
            const v = input(get, 'in', 'float', p.in), s = Math.round(p.seed);
            if (v.isConst) return C(Math.min(Math.max(p.min + randomFloatJs(v.value, s) * (p.max - p.min), p.min), p.max));
            const r = randomFloat(tsl(v), s).mul(p.max - p.min).add(p.min);
            return T(min(max(r, p.min), p.max), 'float');
        },
        mtlx: { write: async x => x.mx.add('randomfloat', 'float', { in: await x.input('in', 'float'), min: x.v.F(x.p.min), max: x.v.F(x.p.max), seed: x.v.I(x.p.seed) }) },
    },
    {
        type: 'randomColor', category: 'color', color: 'bg-sky-700',
        inputs: [{ key: 'in', type: 'float' }],
        outputs: [{ key: 'color', type: 'color' }],
        params: [num('in', 0.5), num('hueLow', 0), num('hueHigh', 1), num('saturationLow', 0.825), num('saturationHigh', 1),
            num('brightnessLow', 1), num('brightnessHigh', 1), num('seed', 0, 0, 1000, 1)],
        evaluate(port, p, get) {
            // MaterialX: one random value per channel (seeds ⌈seed + 413.3⌉ …), each onto its range, HSV → RGB
            const v = input(get, 'in', 'float', p.in), s = Math.round(p.seed);
            const seeds = [Math.ceil(s + 413.3), Math.ceil(s + 1522.4), Math.ceil(s + 1813.8)];
            const ranges = [[p.hueLow, p.hueHigh], [p.saturationLow, p.saturationHigh], [p.brightnessLow, p.brightnessHigh]];
            if (v.isConst) return C(new THREE.Color(...hsvToRgbJs(...seeds.map((k, i) => ranges[i][0] + randomFloatJs(v.value, k) * (ranges[i][1] - ranges[i][0])))));
            const ch = seeds.map((k, i) => randomFloat(tsl(v), k).mul(ranges[i][1] - ranges[i][0]).add(ranges[i][0]));
            return T(hsvToRgb(vec3(...ch)), 'color');
        },
        mtlx: {
            write: async x => x.mx.add('randomcolor', 'color3', {
                in: await x.input('in', 'float'), huelow: x.v.F(x.p.hueLow), huehigh: x.v.F(x.p.hueHigh), saturationlow: x.v.F(x.p.saturationLow),
                saturationhigh: x.v.F(x.p.saturationHigh), brightnesslow: x.v.F(x.p.brightnessLow), brightnesshigh: x.v.F(x.p.brightnessHigh), seed: x.v.I(x.p.seed),
            }),
        },
    },
];

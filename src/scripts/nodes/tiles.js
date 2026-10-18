// Tiles: bricks, wall/floor tiles, pavers, ceiling grids, floor boards and parquet.
//
// The layout (tiles-layout.js) finds the element under the point (local position, size, wrapped id). The
// distance to the element's rounded outline gives the joint (gap), the bevel slope and the edge erosion; the
// element id gives a random number per element for colour variation and for the `uv` output (local coordinate
// along the element's length + random offset – a noise/wood node fed with it looks different on every plank).
// Gap and bevel are relative to the smaller element side and physically equal in both directions.
import { float, vec2, vec3, abs, max, min, length, clamp, mix, sqrt, smoothstep, fwidth } from 'three/tsl';
import { T, tsl, coord, input, hash33, fbm, vary } from '../node-lib.js';
import { layout, PATTERNS } from './tiles-layout.js';

export default {
    type: 'tiles',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [
        { key: 'uv', type: 'vector' },
        { key: 'a', type: 'color' },
        { key: 'b', type: 'color' },
        { key: 'c', type: 'color' },
    ],
    outputs: [
        { key: 'color', type: 'color' },
        { key: 'value', type: 'float' },
        { key: 'mask', type: 'float' },
        { key: 'random', type: 'float' },
        { key: 'uv', type: 'vector' },
    ],
    params: [
        { key: 'pattern', kind: 'select', options: PATTERNS, default: 'running' },
        // elements per tile (rows: columns × rows; herringbone/basket/diamond: repeats per tile in countU)
        { key: 'countU', kind: 'number', min: 1, max: 64, step: 1, default: 3 },
        { key: 'countV', kind: 'number', min: 1, max: 128, step: 1, default: 10 },
        // plank length : width for herringbone and basket weave
        { key: 'ratio', kind: 'number', min: 2, max: 12, step: 1, default: 4 },
        // joint width / bevel width relative to the smaller element side
        { key: 'gap', kind: 'number', min: 0, max: 0.5, step: 0.005, default: 0.12 },
        { key: 'bevel', kind: 'number', min: 0, max: 0.5, step: 0.005, default: 0.06 },
        { key: 'profile', kind: 'select', options: ['round', 'chamfer'], default: 'round' },
        // worn, irregular edges and corners
        { key: 'edgeNoise', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
        // fine grain on face and joint (height and colour)
        { key: 'surface', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
        // per-element brightness variation and random blend towards colour c
        { key: 'variation', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
        { key: 'colorMix', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.4 },
        // rows: random row shift; planks: random plank lengths
        { key: 'jitter', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },
        { key: 'seed', kind: 'number', min: 0, max: 999, step: 1, default: 0 },
        { key: 'a', kind: 'color', default: '#8e3f2a' },
        { key: 'b', kind: 'color', default: '#b4aea3' },
        { key: 'c', kind: 'color', default: '#6a3426' },
    ],
    evaluate(port, p, get) {
        const uv = coord(get);
        const seed = Math.round(p.seed) * 7;
        const e = layout(uv, { ...p, seed });
        const rnd = hash33(vec3(e.id, e.kind.add(seed)));
        if (port === 'random') return T(rnd.x, 'float');
        if (port === 'uv') return T(e.local.add(rnd.yz.mul(16)), 'vector');

        const s = e.small;
        const gap = Math.max(0, p.gap) * s, bevel = Math.max(0, p.bevel) * s;
        // signed distance inside the rounded element outline (corner radius = half joint + bevel)
        const half = e.size.mul(0.5);
        const r = min(float(gap / 2 + bevel), min(half.x, half.y));
        const q = abs(e.local.sub(half)).sub(half).add(r);
        let depth = r.sub(length(max(q, 0))).sub(min(max(q.x, q.y), 0));
        if (p.edgeNoise > 0) {
            // worn edges: gentle wobble of the whole edge plus chips; own noise per element (an integer offset
            // per element keeps it periodic), so the two sides of a joint wear independently
            const off = rnd.yz.mul(64).floor();
            const f1 = Math.max(2, Math.round(2 / s)), f2 = Math.max(4, Math.round(7 / s));
            const wobble = fbm(uv.mul(f1).add(off), vec2(f1, f1), 2).sub(0.5);
            const chips = smoothstep(0.6, 0.85, fbm(uv.mul(f2).add(off), vec2(f2, f2), 3));
            depth = depth.add(wobble.mul(p.edgeNoise * s * 0.12)).sub(chips.mul(p.edgeNoise * s * 0.25));
        }
        const aa = max(fwidth(uv.x), fwidth(uv.y)).max(1e-5);
        const mask = smoothstep(aa.mul(-0.5), aa.mul(0.5), depth.sub(gap / 2));
        if (port === 'mask') return T(mask, 'float');
        // fine surface grain (sandy joint, rough face): lowers the height and mottles the colour
        // (10 cells per element side, but at least 96 / at most 256 per tile – fine on big tiles, no aliasing on small ones)
        const fg = Math.min(256, Math.max(96, Math.round(10 / s)));
        const grain = p.surface > 0 ? fbm(uv.mul(fg), vec2(fg, fg), 3) : null;
        if (port === 'value') {
            const t = clamp(depth.sub(gap / 2).add(aa.mul(0.5)).div(max(float(bevel), aa)), 0, 1);
            const h = p.profile === 'chamfer' ? t : sqrt(float(1).sub(float(1).sub(t).pow(2)));
            if (!grain) return T(h, 'float');
            const k = Math.min(p.surface, 1) * 0.3;
            return T(clamp(h.mul(1 - k).add(grain.mul(k)), 0, 1), 'float');
        }
        const a = tsl(input(get, 'a', 'color', p.a));
        const b = tsl(input(get, 'b', 'color', p.b));
        const c = tsl(input(get, 'c', 'color', p.c));
        let tile = p.colorMix > 0 ? mix(a, c, rnd.z.mul(p.colorMix)) : a;
        tile = vary(tile, rnd.x, p.variation);
        if (!grain) return T(mix(b, tile, mask), 'color');
        // fine grain on face and joint, plus a coarser mottling of the face that differs per element
        const k = Math.min(p.surface, 1);
        const fm = Math.max(2, Math.round(2 / s));
        const mottle = fbm(uv.mul(fm).add(rnd.zy.mul(64).floor()), vec2(fm, fm), 2);
        const g = grain.sub(0.5).mul(k * 0.35).add(1);
        return T(mix(b.mul(g), tile.mul(g.add(mottle.sub(0.5).mul(k * 0.4))), mask), 'color');
    },
};

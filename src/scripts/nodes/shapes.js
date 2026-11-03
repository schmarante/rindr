// Shapes and patterns like MaterialX's procedural 2D nodes (Nov. 2026) – a mask, 1 inside, 0 outside, hard edges
// as MaterialX defines them: circle, line (capsule), hexagon, cloverleaf around a centre in the tile; grid, crosshatch
// and tiled circles / hexagons / cloverleafs repeated `count` times per tile (staggered: every other row shifted by
// half a cell – the staggered circles / hexagons repeat every √3 rows, not after whole rows, so a tile of them only
// repeats seamlessly in V for counts that are multiples of 1.732…). The MaterialX export wraps the coordinate into the
// tile first for the single shapes (RINDR's bake tile repeats them).
import { float, vec2, dot, distance, min, max, abs, clamp, floor, select } from 'three/tsl';
import { T, coord } from '../node-lib.js';

const SHAPE = { category: 'texture', color: 'bg-amber-700', texture: true };
const num = (key, def, lo = 0, hi = 1, step = 0.01) => ({ key, kind: 'number', min: lo, max: hi, step, default: def });
const uvIn = [{ key: 'uv', type: 'vector' }];
const mask = [{ key: 'value', type: 'float' }];
const mod = (x, y) => x.sub(floor(x.div(y)).mul(y));   // MaterialX modulo (GLSL mod)

// --- the shapes (MaterialX's definitions; c = coordinate, centre/points vec2, values float) ---
const circle = (c, center, r) => {
    const d = c.sub(center);
    return select(dot(d, d).greaterThan(float(r).mul(r)), float(0), float(1));
};
const line = (c, center, r, p1, p2) => {
    const pa = c.sub(center).sub(p1), ba = p2.sub(p1);
    const h = clamp(dot(pa, ba).div(dot(ba, ba)), 0, 1);
    return select(distance(pa, ba.mul(h)).greaterThan(r), float(0), float(1));
};
const K = [-0.866025, 0.5, 0.57735];
const hexagon = (c, center, r) => {
    const d = abs(c.sub(center));
    let p = vec2(d.y, d.x);
    const k1 = vec2(K[0], K[1]), k2 = vec2(-K[0], K[1]);
    p = p.sub(k1.mul(min(dot(k1, p), 0)).mul(2));
    p = p.sub(k2.mul(min(dot(k2, p), 0)).mul(2));
    const rr = float(r);
    p = p.sub(vec2(clamp(p.x, rr.mul(-K[2]), rr.mul(K[2])), rr));
    // MaterialX: sqrt(p.x + p.y) > 0 → outside (a negative sum gives NaN there – inside)
    return select(p.x.add(p.y).greaterThan(0), float(0), float(1));
};
const cloverleaf = (c, center, r) => {
    const s = c.mul(2), cc = vec2(center).mul(2), rr = float(r);
    return max(max(circle(vec2(s.x.add(rr), s.y), cc, rr), circle(vec2(s.x.sub(rr), s.y), cc, rr)),
        max(circle(vec2(s.x, s.y.sub(rr)), cc, rr), circle(vec2(s.x, s.y.add(rr)), cc, rr)));
};

// grid and crosshatch: cell coordinate −1..1 (rows shifted when staggered)
const cells = (c, p) => {
    const t = c.mul(vec2(p.countU, p.countV));
    const shift = select(mod(t.y, 2).greaterThan(1), float(0.5), float(0));
    const x = p.staggered ? t.x.add(shift) : t.x;
    return vec2(mod(x, 1).mul(2).sub(1), mod(t.y, 1).mul(2).sub(1));
};
// tiled shapes: regular – one per cell (−1..1, size = radius), staggered – three per cell of a shifted lattice
const tiled = (c, p, shape, rowHeight) => {
    const t = c.mul(vec2(p.countU, p.countV));
    if (!p.staggered) return shape(mod(t, 1).mul(2).sub(1), vec2(0, 0), p.size);
    const shift = select(mod(t.y, rowHeight * 2).greaterThan(rowHeight), float(0.5), float(0));
    const mx = mod(t.x.add(shift), 1), my = mod(t.y, rowHeight);
    const half = p.size / 2, o = vec2(0, 0);
    return max(max(shape(vec2(mx, my), o, half), shape(vec2(float(1).sub(mx), my), o, half)), shape(vec2(mx.sub(0.5), float(rowHeight).sub(my)), o, half));
};

const center = [num('centerU', 0.5, -1, 2), num('centerV', 0.5, -1, 2)];
const lattice = [num('countU', 4, 1, 64, 1), num('countV', 4, 1, 64, 1)];
const staggered = { key: 'staggered', kind: 'bool', default: false };

// MaterialX writers: single shapes on the wrapped tile coordinate, patterns with uvtiling (offset 0 – RINDR's offset
// is the mapping's); color3 outputs → their first channel
const single = (category, extra = () => ({})) => async x => x.mx.add(category, 'float', {
    texcoord: await x.coord({ tile: true }), center: x.v.V2(x.p.centerU, x.p.centerV), radius: x.v.F(x.p.radius), ...extra(x),
});
const pattern = (category, size) => async x => {
    const out = x.mx.add(category, 'color3', {
        texcoord: await x.coord(), uvtiling: x.v.V2(x.p.countU, x.p.countV), uvoffset: x.v.V2(0, 0),
        [size]: x.v.F(x.p[size]), staggered: x.v.B(x.p.staggered),
    });
    return x.mx.add('extract', 'float', { in: out, index: x.v.I(0) });
};

export default [
    {
        type: 'circle', ...SHAPE, inputs: uvIn, outputs: mask, params: [...center, num('radius', 0.25)],
        evaluate: (port, p, get) => T(circle(coord(get), vec2(p.centerU, p.centerV), p.radius), 'float'),
        mtlx: { write: single('circle') },
    },
    {
        type: 'line', ...SHAPE, inputs: uvIn, outputs: mask,
        params: [num('centerU', 0, -1, 2), num('centerV', 0, -1, 2), num('radius', 0.05), num('x1', 0.25, -1, 2), num('y1', 0.25, -1, 2), num('x2', 0.75, -1, 2), num('y2', 0.75, -1, 2)],
        evaluate: (port, p, get) => T(line(coord(get), vec2(p.centerU, p.centerV), p.radius, vec2(p.x1, p.y1), vec2(p.x2, p.y2)), 'float'),
        mtlx: { write: single('line', x => ({ point1: x.v.V2(x.p.x1, x.p.y1), point2: x.v.V2(x.p.x2, x.p.y2) })) },
    },
    {
        type: 'hexagon', ...SHAPE, inputs: uvIn, outputs: mask, params: [...center, num('radius', 0.25)],
        evaluate: (port, p, get) => T(hexagon(coord(get), vec2(p.centerU, p.centerV), p.radius), 'float'),
        mtlx: { write: single('hexagon') },
    },
    {
        type: 'cloverleaf', ...SHAPE, inputs: uvIn, outputs: mask, params: [...center, num('radius', 0.25)],
        evaluate: (port, p, get) => T(cloverleaf(coord(get), vec2(p.centerU, p.centerV), p.radius), 'float'),
        mtlx: { write: single('cloverleaf') },
    },
    {
        type: 'grid', ...SHAPE, inputs: uvIn, outputs: mask, params: [...lattice, num('thickness', 0.05), staggered],
        evaluate(port, p, get) {
            const s = cells(coord(get), p), edge = 1 - p.thickness;
            const xd = select(abs(s.x).greaterThan(edge), float(0), float(1)), yd = select(abs(s.y).greaterThan(edge), float(0), float(1));
            return T(float(1).sub(min(xd, yd)), 'float');
        },
        mtlx: { write: pattern('grid', 'thickness') },
    },
    {
        type: 'crosshatch', ...SHAPE, inputs: uvIn, outputs: mask, params: [...lattice, num('thickness', 0.05), staggered],
        evaluate(port, p, get) {
            const s = cells(coord(get), p), o = vec2(0, 0);
            return T(max(line(s, o, p.thickness, vec2(1, 1), vec2(-1, -1)), line(s, o, p.thickness, vec2(-1, 1), vec2(1, -1))), 'float');
        },
        mtlx: { write: pattern('crosshatch', 'thickness') },
    },
    {
        type: 'tiledCircles', ...SHAPE, inputs: uvIn, outputs: mask, params: [...lattice, num('size', 0.5), staggered],
        evaluate: (port, p, get) => T(tiled(coord(get), p, circle, 0.866025), 'float'),
        mtlx: { write: pattern('tiledcircles', 'size') },
    },
    {
        type: 'tiledHexagons', ...SHAPE, inputs: uvIn, outputs: mask, params: [...lattice, num('size', 0.5), staggered],
        evaluate: (port, p, get) => T(tiled(coord(get), p, hexagon, 0.866025), 'float'),
        mtlx: { write: pattern('tiledhexagons', 'size') },
    },
    {
        type: 'tiledCloverleafs', ...SHAPE, inputs: uvIn, outputs: mask, params: [...lattice, num('size', 0.5), staggered],
        evaluate: (port, p, get) => T(tiled(coord(get), p, cloverleaf, 0.5), 'float'),
        mtlx: { write: pattern('tiledcloverleafs', 'size') },
    },
];

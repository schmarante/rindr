// Dots: regular hole and stud patterns – perforated sheet (round, square or slotted holes, straight or staggered
// rows), raised dots (prints, rubber studs), expanded metal mesh (diamond openings between twisted strands), diamond
// tread plate (raised lozenges at ±45°) and bar tread plate (groups of short bars alternating 90°).
//
// Every element is a signed distance function on an integer lattice (columns × rows per tile, staggered rows shift by
// half a column – rows are kept even then), so the pattern repeats seamlessly. The elements of the neighbouring
// cells are combined with min() (union). Edges are smoothed analytically over about one texel of the 1024² bake
// (no screen derivatives – the result is baked); an optional bevel gives a rounded shoulder for height.
//
// value: 1 = solid material / raised element, 0 = hole / base – usable directly as the output's `alpha` cutout
// (holes stay below 0.5, a bevelled rim starts at 0.5) and as height. color = mix(a, b, value), random = per element.
//
// Params: count = columns per tile; rows = rows per tile (0 = automatic: square cells, 60° for staggered rows,
// `length` times the columns for slots, diamond aspect for expanded metal, half a column for the tread plate);
// stagger = every other row shifted by half (perforated, dots; tread: woven layout, otherwise a checkerboard whose
// lozenge tips meet in rings); size = share of the space (holes/dots: width vs. the nearest neighbour; slots: width
// vs. the row distance; expanded metal: opening vs. diamond cell; tread plates: element length vs. the cell);
// length = length / width (slot rows, diamond opening, lozenge, bar); rounding = corner radius (square holes,
// diamond openings) or blunt instead of pointed tips (lozenges, bars); bevel = width of the rounded shoulder
// (0 = flat, sharp edge; expanded metal: tilt of the strands); bars = bars per group; rotation = whole pattern 90°.
import { vec2, float, floor, abs, max, min, clamp, sqrt, length, dot, smoothstep, select, mix } from 'three/tsl';
import { T, tsl, input, coord, wrap, hash2 } from '../node-lib.js';

// half width of the edge smoothing in tile units (≈ one texel of a 1024² bake across the whole edge)
const AA = 0.6 / 1024;
const SQRT_HALF = Math.SQRT1_2;
const HOLES = new Set(['perforated', 'expanded']);

// --- signed distance functions (p = local position in tile units, negative inside) ---

const sdCircle = (p, r) => length(p).sub(r);

/** box with half extents hx, hy and corner radius r */
function sdBox(p, hx, hy, r) {
    const q = abs(p).sub(vec2(hx - r, hy - r));
    return length(max(q, vec2(0, 0))).add(min(max(q.x, q.y), 0)).sub(r);
}

/** capsule along x: half length a (tip to tip), radius b */
const sdCapsule = (p, a, b) => length(vec2(p.x.sub(clamp(p.x, -(a - b), a - b)), p.y)).sub(b);

/** pointed lens along x (intersection of two circles): half length a, half width b */
function sdLens(p, a, b) {
    const r = (a * a + b * b) / (2 * b);
    const q = vec2(p.x, abs(p.y));
    return length(q.add(vec2(0, r - b))).sub(r);   // the farther circle bounds the near side
}

/** rhombus with half diagonals a (x) and b (y) – exact distance */
function sdRhombus(p, a, b) {
    const q = abs(p);
    const e = vec2(-a, b);
    const w = q.sub(vec2(a, 0));
    const h = clamp(dot(w, e).div(a * a + b * b), 0, 1);
    const d = length(w.sub(e.mul(h)));
    return select(q.x.mul(b).add(q.y.mul(a)).greaterThan(a * b), d, d.negate());
}

/** elongated element along x with blunt (rounding 1) or pointed (rounding 0) tips */
const sdBar = (p, a, b, rounding) => (rounding <= 0 ? sdLens(p, a, b)
    : rounding >= 1 ? sdCapsule(p, a, b) : mix(sdLens(p, a, b), sdCapsule(p, a, b), rounding));

/**
 * Union of the elements of a lattice (cols × rows per tile, optionally every other row shifted by half a column).
 * sdf(local, cell) -> distance; reach = neighbour cells to look at [x, y]. Returns { d, id, ly } (id = cell of the
 * nearest element, ly = local y in that element).
 */
function lattice(q, cols, rows, stagger, reach, sdf) {
    const p = q.mul(vec2(cols, rows));
    const pitch = vec2(1 / cols, 1 / rows);
    const j0 = floor(p.y);
    let d = float(1e3), id = vec2(0, 0), ly = float(0);
    for (let dj = -reach[1]; dj <= reach[1]; dj++) {
        const j = j0.add(dj);
        const off = stagger ? wrap(j, 2).mul(0.5) : float(0);
        const i0 = floor(p.x.sub(off));
        for (let di = -reach[0]; di <= reach[0]; di++) {
            const i = i0.add(di);
            const cell = vec2(i, j);
            const l = p.sub(vec2(i.add(0.5).add(off), j.add(0.5))).mul(pitch);
            const dc = sdf(l, cell);
            const near = dc.lessThan(d);
            id = select(near, cell, id);
            ly = select(near, l.y, ly);
            d = min(d, dc);
        }
    }
    return { d, id, ly };
}

/** lozenge at +45° (parity 0) or −45° (parity 1) */
function tilt(l, parity, a, b, rounding) {
    const r = select(parity.greaterThan(0.5), vec2(l.x.sub(l.y), l.x.add(l.y)), vec2(l.x.add(l.y), l.y.sub(l.x)));
    return sdBar(r.mul(SQRT_HALF), a, b, rounding);
}

const even = n => Math.max(2, 2 * Math.round(n / 2));

/** pattern -> { d: signed distance (negative inside the holes / raised elements), id, cols, rows, bw: bevel width } */
function pattern(p, q) {
    const cols0 = Math.max(1, Math.round(p.count));
    const rowsSet = Math.max(0, Math.round(p.rows || 0));
    const len = Math.max(1, p.length);
    const size = Math.min(Math.max(p.size, 0.02), 1);
    const rnd = Math.min(Math.max(p.rounding, 0), 1);
    const bevel = Math.min(Math.max(p.bevel, 0), 1);

    if (p.pattern === 'expanded') {
        // rhombic tiling: diamonds of cp × 2 rp, every other row shifted; the openings are the diamonds shrunk to `size`
        const cols = cols0;
        const rows = even(rowsSet || 2 * cols * Math.min(len, 6));
        const a = 0.5 / cols, b = 1 / rows;
        const A = a * size, B = b * size;
        const hyp = Math.hypot(A, B);
        const r = rnd * 0.95 * A * B / hyp;               // corner radius (at most the inner radius)
        const A2 = A - r * hyp / B, B2 = B - r * hyp / A;  // inset rhombus with the same angles
        const { d, id, ly } = lattice(q, cols, rows, true, [1, 1], l => sdRhombus(l, A2, B2).sub(r));
        // strands are twisted: across each strand the height rises from its lower to its upper edge
        const half = Math.max((1 - size) * a * b / Math.hypot(a, b), 1e-6);
        const s = clamp(d.div(half), 0, 1).mul(0.5);
        const slope = select(ly.greaterThan(0), s, float(1).sub(s));
        return { d, id, cols, rows, bw: bevel * half, slope: bevel > 0 ? slope : null };
    }
    if (p.pattern === 'tread' || p.pattern === 'bars') {
        if (p.pattern === 'tread' && p.stagger === 'half') {
            // woven layout: rows of equal lozenges half a column apart, orientation flips from row to row – every
            // tip points at the flank of a perpendicular neighbour
            const cols = cols0;
            const rows = even(rowsSet || 2 * cols0);
            const A = size * 0.7 / cols, B = A / len;
            const { d, id } = lattice(q, cols, rows, true, [1, 2], (l, cell) => tilt(l, wrap(cell.y, 2), A, B, rnd));
            return { d, id, cols, rows, bw: bevel * B };
        }
        // square cells in a checkerboard: orientation flips from cell to cell (counts even -> seamless)
        const cols = even(cols0);
        const rows = even(rowsSet || cols0);
        const c = Math.min(1 / cols, 1 / rows);
        if (p.pattern === 'tread') {
            // lozenges up to 1.3 cells long; the tips of four of them meet around each cell corner
            const A = size * 0.65 * c, B = A / len;
            const { d, id } = lattice(q, cols, rows, false, [1, 1], (l, cell) => tilt(l, wrap(cell.x.add(cell.y), 2), A, B, rnd));
            return { d, id, cols, rows, bw: bevel * B };
        }
        // bar groups: n parallel bars across the cell, the nearest one of the own cell counts
        const n = Math.max(1, Math.round(p.bars));
        const A = size * 0.48 * c, B = Math.min(A / len, 0.45 * c / n);
        const { d, id } = lattice(q, cols, rows, false, [0, 0], (l, cell) => {
            const r = select(wrap(cell.x.add(cell.y), 2).greaterThan(0.5), l.yx, l);
            const k = clamp(floor(r.y.div(c).add(0.5).mul(n)), 0, n - 1);
            const y = k.add(0.5).div(n).sub(0.5).mul(c);
            return sdBar(vec2(r.x, r.y.sub(y)), A, B, rnd);
        });
        return { d, id, cols, rows, bw: bevel * B };
    }

    // perforated sheet / dots
    const stagger = p.stagger === 'half';
    const slot = p.shape === 'slot';
    const cols = cols0;
    // automatic rows: square cells (straight), 60° (staggered); slots: rows `length` times closer than the columns
    const auto = slot ? cols * len : stagger ? cols * 2 / Math.sqrt(3) : cols;
    const rows = stagger ? even(rowsSet || auto) : Math.max(1, rowsSet || Math.round(auto));
    const cp = 1 / cols, rp = 1 / rows;
    const nn = stagger ? Math.min(cp, 2 * rp, Math.hypot(cp / 2, rp)) : Math.min(cp, rp);   // nearest neighbour
    let sdf, hx, web;
    if (slot) {
        // slot width = size of the row distance, the same web between the slot ends
        const w = size * rp;
        web = rp - w;
        hx = Math.max(w, cp - web) / 2;
        sdf = l => sdCapsule(l, hx, w / 2);
    } else {
        const w = size * nn;
        web = nn - w;
        hx = w / 2;
        sdf = p.shape === 'square' ? l => sdBox(l, hx, hx, rnd * hx) : l => sdCircle(l, hx);
    }
    const reachX = Math.min(4, Math.max(1, Math.ceil(hx / cp + 0.5)));
    const { d, id } = lattice(q, cols, rows, stagger, [reachX, 1], sdf);
    const bw = bevel * (p.pattern === 'dots' ? (slot ? size * rp : 2 * hx) : Math.max(web, nn * 0.1)) / 2;
    return { d, id, cols, rows, bw };
}

export default {
    type: 'dots',
    category: 'texture', color: 'bg-amber-700', texture: true,
    inputs: [{ key: 'uv', type: 'vector' }, { key: 'a', type: 'color' }, { key: 'b', type: 'color' }],
    outputs: [{ key: 'value', type: 'float' }, { key: 'color', type: 'color' }, { key: 'random', type: 'float' }],
    params: [
        { key: 'pattern', kind: 'select', options: ['perforated', 'dots', 'expanded', 'tread', 'bars'], default: 'perforated' },
        { key: 'shape', kind: 'select', options: ['circle', 'square', 'slot'], default: 'circle' },
        { key: 'stagger', kind: 'select', options: ['none', 'half'], default: 'half' },
        { key: 'count', kind: 'number', min: 1, max: 200, step: 1, default: 16 },
        { key: 'rows', kind: 'number', min: 0, max: 400, step: 1, default: 0 },
        { key: 'size', kind: 'number', min: 0.05, max: 1, step: 0.01, default: 0.6 },
        { key: 'length', kind: 'number', min: 1, max: 20, step: 0.1, default: 3 },
        { key: 'rounding', kind: 'number', min: 0, max: 1, step: 0.01, default: 0.3 },
        { key: 'bevel', kind: 'number', min: 0, max: 1, step: 0.01, default: 0 },
        { key: 'bars', kind: 'number', min: 1, max: 9, step: 1, default: 5 },
        { key: 'rotation', kind: 'select', options: ['0', '90'], default: '0' },
        { key: 'a', kind: 'color', default: '#141414' },
        { key: 'b', kind: 'color', default: '#b4b8bc' },
    ],
    evaluate(port, p, get) {
        const uv = coord(get);
        const q = p.rotation === '90' ? uv.yx : uv;
        const { d, id, cols, rows, bw, slope } = pattern(p, q);
        if (port === 'random') return T(hash2(wrap(id, vec2(cols, rows)), 7), 'float');

        // distance into the material (holes) or into the raised element (dots, tread plates)
        const hole = HOLES.has(p.pattern);
        const inner = hole ? d : d.negate();
        const edge = smoothstep(-AA, AA, inner);
        let value = edge;
        if (slope) {
            // expanded metal: twisted strands (bevel = how far the low edge drops), above 0.5 so the cutout keeps them
            value = edge.mul(float(1).sub(float(1).sub(slope).mul(Math.min(p.bevel, 1) * 0.45)));
        } else if (bw > 0) {
            // quarter-circle shoulder; around holes the rim starts half way up so the cutout stays at the edge
            const s = clamp(inner.div(bw), 0, 1);
            const shoulder = sqrt(s.mul(float(2).sub(s)));
            value = hole ? edge.mul(shoulder.mul(0.5).add(0.5)) : edge.mul(shoulder);
        }
        if (port === 'value') return T(value, 'float');
        const a = input(get, 'a', 'color', p.a), b = input(get, 'b', 'color', p.b);
        return T(mix(tsl(a), tsl(b), value), 'color');
    },
};

// Layouts of the tiles node: which element (brick, tile, plank) contains a point and where inside it the point lies.
//
// Every layout takes the coordinate `p` (TSL vec2, tile units – one bake tile = 0..1) and returns
//   local: position inside the element (tile units, origin at its corner, x along the element's length)
//   size:  element size (tile units, x = length)
//   id:    integer element index, wrapped so the same element gets the same id across the tile edge
//   kind:  0/1 to tell two element families apart (header vs. stretcher, the two plank directions …)
//   small: the smaller element side in tile units (JS number) – gap and bevel are relative to it
// All layouts repeat seamlessly with period 1 (integer element counts per tile).
import { float, vec2, floor, select } from 'three/tsl';
import { wrap, hash2 } from '../node-lib.js';

const int = (v, lo = 1) => Math.max(lo, Math.round(v));
/** round up to a multiple of m (row patterns whose offset repeats every m rows) */
const multiple = (v, m) => Math.ceil(int(v) / m) * m;
/** floored modulo for a TSL value and a JS number */
const fmod = (x, m) => x.sub(floor(x.div(m)).mul(m));

/**
 * Rows of equal elements; each row shifted by `step` element lengths (½ running, ⅓ third) plus a random shift.
 * The row count is rounded up so the offset repeats inside the tile.
 */
function rows(p, { countU, countV, jitter, seed }, step, rowMultiple) {
    const cu = int(countU), cv = multiple(countV, rowMultiple);
    const row = floor(p.y.mul(cv));
    const rowW = wrap(row, cv);
    let shift = rowW.mul(step);
    if (jitter > 0) shift = shift.add(hash2(vec2(rowW, 0), seed + 101).sub(0.5).mul(jitter));
    const x = p.x.mul(cu).sub(shift);
    const col = floor(x);
    return {
        local: vec2(x.sub(col).div(cu), p.y.mul(cv).sub(row).div(cv)),
        size: vec2(1 / cu, 1 / cv),
        id: vec2(wrap(col, cu), rowW),
        kind: float(0),
        small: Math.min(1 / cu, 1 / cv),
    };
}

/** English bond: stretcher rows (countU per row) alternate with header rows (twice as many, offset by ¼ stretcher) */
function english(p, { countU, countV }) {
    const cu = int(countU), cv = multiple(countV, 2);
    const row = floor(p.y.mul(cv));
    const rowW = wrap(row, cv);
    const header = fmod(rowW, 2);           // 1 in odd rows
    const n = header.mul(cu).add(cu);       // elements per row
    const x = p.x.mul(n).sub(header.mul(0.5));
    const col = floor(x);
    return {
        local: vec2(x.sub(col).div(n), p.y.mul(cv).sub(row).div(cv)),
        size: vec2(float(1).div(n), 1 / cv),
        id: vec2(wrap(col, n), rowW),
        kind: header,
        small: Math.min(1 / cu, 1 / cv),
    };
}

/**
 * Flemish bond: stretcher + header alternate in every row (countU pairs per row); odd rows are shifted so every
 * header sits centred on the stretcher below.
 */
function flemish(p, { countU, countV }) {
    const cu = int(countU), cv = multiple(countV, 2);
    const row = floor(p.y.mul(cv));
    const rowW = wrap(row, cv);
    const x = p.x.mul(cu).sub(fmod(rowW, 2).mul(0.5));
    const pair = floor(x);
    const f = x.sub(pair);                   // 0..1 within the pair: stretcher ⅔, header ⅓
    const header = select(f.lessThan(2 / 3), float(0), float(1));
    const lx = select(header.greaterThan(0.5), f.sub(2 / 3), f);
    return {
        local: vec2(lx.div(cu), p.y.mul(cv).sub(row).div(cv)),
        size: vec2(select(header.greaterThan(0.5), float(1 / 3), float(2 / 3)).div(cu), 1 / cv),
        id: vec2(wrap(pair, cu).mul(2).add(header), rowW),
        kind: header,
        small: Math.min(2 / 3 / cu, 1 / cv),
    };
}

/**
 * Herringbone at 45° (zig-zag columns). Planks ratio × 1. In a frame turned by −45° (units of plank width) the
 * planks form staircases: horizontal plank H(n) = [n, n+k) × [n, n+1), vertical V(n) = [n−1, n) × [n, n+k);
 * the staircases repeat by b = (k, −k). With countU zig-zag columns per tile there are n = countU·k steps per tile,
 * and the frame coordinate is simply q = n · (x + y, y − x) – one tile step in x = countU·b, in y = n·(1, 1).
 */
function herringbone(p, { countU, ratio }) {
    const m = int(countU), k = int(ratio, 2), n = m * k;
    const q = vec2(p.x.add(p.y), p.y.sub(p.x)).mul(n);
    // horizontal plank?
    const n0 = floor(q.y);
    const hx = q.x.sub(n0);
    const jh = floor(hx.div(2 * k));
    const rh = hx.sub(jh.mul(2 * k));        // 0..2k: < k = inside a horizontal plank
    const isV = rh.greaterThanEqual(k);
    // otherwise the vertical plank of the same staircase position
    const m0 = floor(q.x);
    const s = q.y.sub(m0).sub(1);
    const jv = floor(s.div(2 * k)).negate();
    const t = s.add(jv.mul(2 * k));          // 0..k along the vertical plank
    const kind = select(isV, float(1), float(0));
    const along = select(isV, t, rh);
    const across = select(isV, q.x.sub(m0), q.y.sub(n0));
    const j = select(isV, jv, jh);
    const step = select(isV, m0.add(1).sub(jv.mul(k)), n0.add(jh.mul(k)));
    const w = 1 / (n * Math.SQRT2);          // plank width in tile units
    return {
        local: vec2(along, across).mul(w),
        size: vec2(k * w, w),
        id: vec2(wrap(step, n), wrap(j, m)),
        kind,
        small: w,
    };
}

/** Basket weave: square blocks of `ratio` parallel planks, alternately horizontal and vertical (2·countU blocks per tile) */
function basket(p, { countU, ratio }) {
    const nb = 2 * int(countU), k = int(ratio, 2);
    const b = p.mul(nb);
    const block = floor(b);
    const f = b.sub(block);
    const vert = fmod(block.x.add(block.y), 2);
    const isV = vert.greaterThan(0.5);
    const along = select(isV, f.y, f.x);
    const acrossK = select(isV, f.x, f.y).mul(k);
    const idx = floor(acrossK);
    const B = 1 / nb;
    return {
        local: vec2(along.mul(B), acrossK.sub(idx).mul(B / k)),
        size: vec2(B, B / k),
        id: vec2(wrap(block.x, nb).mul(k).add(idx), wrap(block.y, nb)),
        kind: vert,
        small: B / k,
    };
}

/**
 * Diamond: square tiles turned by 45°, countU across. Grid coordinates u = (x+y)·N, v = (x−y)·N; one tile step
 * moves (u, v) by (N, ±N), so the index is reduced to i in 0..N−1 and j in 0..2N−1.
 */
function diamond(p, { countU }) {
    const N = int(countU);
    const g = vec2(p.x.add(p.y), p.x.sub(p.y)).mul(N);
    const c = floor(g);
    const turns = floor(c.x.div(N));
    const side = 1 / (N * Math.SQRT2);
    return {
        local: g.sub(c).mul(side),
        size: vec2(side, side),
        id: vec2(c.x.sub(turns.mul(N)), wrap(c.y.sub(turns.mul(N)), 2 * N)),
        kind: float(0),
        small: side,
    };
}

/**
 * Floor boards: countV rows, countU planks per row on average. Every row starts at a random offset; the joints
 * inside a row are moved randomly (jitter) so planks get different lengths.
 */
function planks(p, { countU, countV, jitter, seed }) {
    const cu = int(countU), cv = int(countV);
    const row = floor(p.y.mul(cv));
    const rowW = wrap(row, cv);
    const x = p.x.mul(cu).add(hash2(vec2(rowW, 1), seed + 102).mul(cu));
    const i = floor(x);
    const f = x.sub(i);
    const amount = Math.min(Math.max(jitter, 0), 1) * 0.9;
    // start of plank i (in plank units) = i + o(i), |o| < ½
    const o = d => (amount > 0 ? hash2(vec2(wrap(i.add(d), cu), rowW), seed + 103).sub(0.5).mul(amount) : float(0));
    const om = o(-1), o0 = o(0), o1 = o(1), o2 = o(2);
    const before = f.lessThan(o0), after = f.greaterThanEqual(o1.add(1));
    const d = select(before, float(-1), select(after, float(1), float(0)));
    const start = select(before, om.sub(1), select(after, o1.add(1), o0));
    const end = select(before, o0, select(after, o2.add(2), o1.add(1)));
    return {
        local: vec2(f.sub(start).div(cu), p.y.mul(cv).sub(row).div(cv)),
        size: vec2(end.sub(start).div(cu), 1 / cv),
        id: vec2(wrap(i.add(d), cu), rowW),
        kind: float(0),
        small: Math.min(1 / cu, 1 / cv),
    };
}

export const PATTERNS = ['stack', 'running', 'third', 'english', 'flemish', 'herringbone', 'basket', 'diamond', 'planks'];

/** element layout for the pattern in params `p` at coordinate `uv` */
export function layout(uv, p) {
    switch (p.pattern) {
        case 'stack': return rows(uv, p, 0, 1);
        case 'third': return rows(uv, p, 1 / 3, 3);
        case 'english': return english(uv, p);
        case 'flemish': return flemish(uv, p);
        case 'herringbone': return herringbone(uv, p);
        case 'basket': return basket(uv, p);
        case 'diamond': return diamond(uv, p);
        case 'planks': return planks(uv, p);
        default: return rows(uv, p, 0.5, 2);
    }
}

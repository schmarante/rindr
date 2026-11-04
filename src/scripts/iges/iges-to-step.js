// IGES → STEP (ISO 10303-21 text): the IGES entities are written as the STEP entities the own STEP kernel reads – the
// import then goes the STEP way (structure, workers, tessellation qualities, copies, streaming, colours).
//
// Mapping (IGES 5.3 entity numbers):
//   B-rep:  186 solid → MANIFOLD_SOLID_BREP / BREP_WITH_VOIDS, 514 shell → CLOSED_SHELL / OPEN_SHELL, 510 face →
//           ADVANCED_FACE (orientation from the shell), 508 loop → EDGE_LOOP of ORIENTED_EDGEs, 504 edge list →
//           EDGE_CURVE per edge (shared by the faces using it – watertight), 502 vertex list → VERTEX_POINTs
//   Trimmed surfaces: 144 (outer + inner boundaries, 142 curves on the surface) and 143 (141 boundaries) →
//           CURVE_BOUNDED_SURFACE (model-space curves; only parameter curves → PCURVE on B-spline surfaces);
//           untrimmed bounded surfaces standing alone (128, 118, 120, 122, 140) → the same over their whole domain
//   Curves: 100 arc → CIRCLE, 104 ellipse → ELLIPSE, 110 line → LINE (each trimmed by its end points), 126 → (rational)
//           B_SPLINE_CURVE_WITH_KNOTS, 102 → COMPOSITE_CURVE, 106 → POLYLINE, 112 cubic segments → B-spline
//   Surfaces: 128 → (rational) B_SPLINE_SURFACE_WITH_KNOTS, 108/190 → PLANE, 192/194/196/198 → cylinder / cone / sphere /
//           torus, 120 → SURFACE_OF_REVOLUTION, 122 → SURFACE_OF_LINEAR_EXTRUSION, 140 → OFFSET_SURFACE, 118 ruled
//           surface → B-spline surface (two lines or two compatible B-splines)
//   Structure: 308 subfigure definition → a product with its own representation, 408 instance → assembly occurrence
//           (NEXT_ASSEMBLY_USAGE_OCCURRENCE + placement; the same definition is tessellated once), independent
//           entities → the root product; colours (DE colour, 314 definitions) → STYLED_ITEMs on solids / faces;
//           124 transformations are applied to the coordinates (chains composed); lengths converted to mm.
// Not drawn: points, curves, annotation, blanked entities, unbounded planes / analytic surfaces standing alone.

import { IgesFile } from './iges-file.js';

const STANDARD_COLORS = { 1: [0, 0, 0], 2: [1, 0, 0], 3: [0, 1, 0], 4: [0, 0, 1], 5: [1, 1, 0], 6: [1, 0, 1], 7: [0, 1, 1], 8: [1, 1, 1] };
// independent entities drawn as parts / faces
const SOLID_TYPES = new Set([186, 514]);
const FACE_TYPES = new Set([144, 143, 510]);
const SURFACE_ALONE = new Set([128, 118, 120, 122, 140]);
// surfaces whose STEP normal is defined geometrically (kept by a mirror – see Converter.face)
const GEOMETRIC_NORMAL = new Set([108, 190, 192, 194, 196, 198]);
// 402 associativity forms that are groups of entities (1, 7 unordered; 14, 15 ordered)
const GROUP_FORMS = new Set([1, 7, 14, 15]);

/**
 * @param {Uint8Array} bytes the IGES file
 * @param {{ name?: string, onProgress?: (fraction: number) => void }} options
 * @returns {{ bytes: Uint8Array, stats: object }} STEP text (ASCII)
 */
export function igesToStep(bytes, { name = '', onProgress = null } = {}) {
    const f = new IgesFile(bytes);
    const c = new Converter(f, name, onProgress);
    c.run();
    return { bytes: c.w.finish(), stats: c.stats };
}

// --- STEP text ---

// real number in STEP form (always with a decimal point, exponent with E)
function num(x) {
    if (!Number.isFinite(x)) x = 0;
    const s = String(x);
    const e = s.indexOf('e');
    if (e >= 0) { const m = s.slice(0, e); return (m.includes('.') ? m : m + '.') + 'E' + s.slice(e + 1); }
    return s.includes('.') ? s : s + '.';
}
const colorKey = c => (c ? c.map(v => v.toFixed(4)).join(',') : '');
const str = s => `'${String(s ?? '').replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
const list = a => `(${a.join(',')})`;
const ref = id => `#${id}`;

class StepWriter {
    constructor() {
        this.id = 0;
        this.parts = [];
        this.pending = 0;
        this.buf = new Uint8Array(1 << 24);
        this.used = 0;
        this.enc = new TextEncoder();
    }
    add(body) {
        const id = ++this.id;
        this.text(`#${id}=${body};\n`);
        return id;
    }
    text(s) {
        this.parts.push(s);
        this.pending += s.length;
        if (this.pending > 1 << 20) this.flush();
    }
    flush() {
        const s = this.parts.join('');
        this.parts = [];
        this.pending = 0;
        if (this.used + s.length > this.buf.length) {
            let size = this.buf.length;
            while (size < this.used + s.length) size *= 2;
            const b = new Uint8Array(size);
            b.set(this.buf.subarray(0, this.used));
            this.buf = b;
        }
        this.used += this.enc.encodeInto(s, this.buf.subarray(this.used)).written;
    }
    finish() {
        this.text('ENDSEC;\nEND-ISO-10303-21;\n');
        this.flush();
        return this.buf.subarray(0, this.used);
    }
}

// --- 3 × 4 transformations [r00 r01 r02 t0 r10 r11 r12 t1 r20 r21 r22 t2] ---
const compose = (A, B) => {   // A ∘ B
    const M = new Array(12);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) M[r * 4 + c] = A[r * 4] * B[c] + A[r * 4 + 1] * B[4 + c] + A[r * 4 + 2] * B[8 + c];
        M[r * 4 + 3] = A[r * 4] * B[3] + A[r * 4 + 1] * B[7] + A[r * 4 + 2] * B[11] + A[r * 4 + 3];
    }
    return M;
};
const applyP = (M, p) => (M ? [M[0] * p[0] + M[1] * p[1] + M[2] * p[2] + M[3], M[4] * p[0] + M[5] * p[1] + M[6] * p[2] + M[7], M[8] * p[0] + M[9] * p[1] + M[10] * p[2] + M[11]] : p);
const applyD = (M, d) => (M ? [M[0] * d[0] + M[1] * d[1] + M[2] * d[2], M[4] * d[0] + M[5] * d[1] + M[6] * d[2], M[8] * d[0] + M[9] * d[1] + M[10] * d[2]] : d);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);
const det3 = M => M[0] * (M[5] * M[10] - M[6] * M[9]) - M[1] * (M[4] * M[10] - M[6] * M[8]) + M[2] * (M[4] * M[9] - M[5] * M[8]);
const normalize = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
// 3 × 3 row-major
const mul3 = (L, v) => [L[0] * v[0] + L[1] * v[1] + L[2] * v[2], L[3] * v[0] + L[4] * v[1] + L[5] * v[2], L[6] * v[0] + L[7] * v[1] + L[8] * v[2]];
const mul9 = (A, B) => { const C = new Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]; return C; };
const det9 = L => L[0] * (L[4] * L[8] - L[5] * L[7]) - L[1] * (L[3] * L[8] - L[5] * L[6]) + L[2] * (L[3] * L[7] - L[4] * L[6]);
// orthonormal with determinant +1 (a placement can carry it)
const isRotation = L => {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        const d = L[i] * L[j] + L[3 + i] * L[3 + j] + L[6 + i] * L[6 + j];
        if (Math.abs(d - (i === j ? 1 : 0)) > 1e-6) return false;
    }
    return det9(L) > 0;
};
// a unit vector perpendicular to n
const perpendicular = n => normalize(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));

// distinct knots + multiplicities of a full knot vector
function knotsOf(T) {
    const knots = [], mults = [];
    for (const k of T) {
        const last = knots.length ? knots[knots.length - 1] : null;
        if (last !== null && Math.abs(k - last) <= 1e-12 * Math.max(1, Math.abs(k))) mults[mults.length - 1]++;
        else { knots.push(k); mults.push(1); }
    }
    return { knots, mults };
}

class Converter {
    constructor(f, name, onProgress) {
        this.f = f;
        this.name = name;
        this.onProgress = onProgress;
        this.w = new StepWriter();
        this.u = f.unit;
        this.memo = new Map();
        this.paramCache = new Map();   // DE → parameters of entities read often (edge / vertex lists)
        this.xfMemo = new Map();
        this.colorStyle = new Map();
        this.setLinear(null);
        this.stats = { entities: f.count, unit: f.unit, solids: 0, faces: 0, trimmed: 0, surfaces: 0, products: 0, instances: 0, mirrored: 0, scaled: 0, skipped: {} };
    }

    skip(type, why = '') {
        const k = why ? `${type} ${why}` : String(type);
        this.stats.skipped[k] = (this.stats.skipped[k] || 0) + 1;
        return null;
    }
    once(key, make) {
        if (this.Lkey) key = this.Lkey + key;
        if (this.memo.has(key)) return this.memo.get(key);
        let id = null;
        try { id = make(); } catch (err) { id = this.skip('error', err.message.slice(0, 60)); }
        this.memo.set(key, id);
        // progress: converted entities (roughly one per IGES entity; vertices and edges count extra)
        if (this.onProgress && (this.memo.size & 8191) === 0) this.onProgress(Math.min(0.99, this.memo.size / this.f.count));
        return id;
    }
    params(de, cache = false) {
        if (!cache) return this.f.params(de);
        let p = this.paramCache.get(de);
        if (!p) { p = this.f.params(de); this.paramCache.set(de, p); }
        return p;
    }

    // transformation of an entity (its DE matrix field, the chain of 124s composed), in model units; null = identity
    matrixOf(de) {
        const k = this.f.index(de);
        return k < 0 ? null : this.xform(this.f.xform[k]);
    }
    xform(de) {
        if (!de || this.f.typeOf(de) !== 124) return null;
        if (this.xfMemo.has(de)) return this.xfMemo.get(de);
        this.xfMemo.set(de, null);   // (cycles)
        const p = this.f.params(de);
        let M = p.slice(1, 13).map(v => v ?? 0);
        const parent = this.f.xform[this.f.index(de)];
        if (parent && parent !== de) { const P = this.xform(parent); if (P) M = compose(P, M); }
        this.xfMemo.set(de, M);
        return M;
    }

    // model-space point / direction (transformed, mm); parameter space (dim 2): as written
    P(p, M, dim = 3) {
        if (dim === 2) { const q = applyP(M, [p[0], p[1], 0]); return [q[0], q[1]]; }
        let q = applyP(M, p);
        if (this.L) q = mul3(this.L, q);
        return [q[0] * this.u, q[1] * this.u, q[2] * this.u];
    }
    // direction: the entity's matrix, then the baked linear part of a scaled / mirrored instance (setLinear)
    D(d, M) {
        const q = applyD(M, d);
        return this.L ? mul3(this.L, q) : q;
    }
    // linear part baked into the geometry (a scaled or mirrored instance – no placement can carry it): coordinates and
    // directions go through it, lengths scale by its size, a mirror turns the sense of parametric faces; entities are
    // converted once per linear part (memo keys prefixed)
    setLinear(L) {
        this.L = L;
        this.Lkey = L ? `L${L.map(v => v.toFixed(9)).join(',')}|` : '';
        this.Lscale = L ? Math.cbrt(Math.abs(det9(L))) : 1;
        this.mirror = !!L && det9(L) < 0;
    }
    cp(p) { return this.w.add(`CARTESIAN_POINT('',${list(p.map(num))})`); }
    dir(d) { const n = d.length === 2 ? (() => { const l = Math.hypot(d[0], d[1]) || 1; return [d[0] / l, d[1] / l]; })() : normalize(d); return this.w.add(`DIRECTION('',${list(n.map(num))})`); }
    axis2(o, z, x) {
        z = normalize(z);
        let xx = sub(x, z.map(c => c * dot(x, z)));
        if (len(xx) < 1e-12) xx = perpendicular(z);
        return this.w.add(`AXIS2_PLACEMENT_3D('',#${this.cp(o)},#${this.dir(z)},#${this.dir(xx)})`);
    }
    axis2d(o, x) { return this.w.add(`AXIS2_PLACEMENT_2D('',#${this.cp(o)},#${this.dir(x)})`); }

    // --- curves: a bounded STEP curve (trimmed lines / conics, B-splines over their range, composite curves) ---
    curve(de, dim = 3) {
        return this.once(`c${dim}:${de}`, () => {
            const t = this.f.typeOf(de);
            switch (t) {
                case 100: return this.arc(de, dim);
                case 102: return this.composite(de, dim);
                case 104: return this.conic(de, dim);
                case 106: return this.polyline(de, dim);
                case 110: return this.line(de, dim);
                case 112: return this.splineCurve(de, dim);
                case 126: return this.bspline(de, dim);
                case 130: return this.offset(de, dim);
                case 142: { const p = this.params(de); return p[4] ? this.curve(p[4], dim) : this.skip(142, 'no model curve'); }
                default: return this.skip(t, 'curve');
            }
        });
    }
    trimmed(basis, a, b, dim) {
        return this.w.add(`TRIMMED_CURVE('',#${basis},(#${this.cp(a)}),(#${this.cp(b)}),.T.,.CARTESIAN.)`);
    }
    line(de, dim) {
        const p = this.params(de), M = this.matrixOf(de);
        const a = this.P([p[1] ?? 0, p[2] ?? 0, p[3] ?? 0], M, dim), b = this.P([p[4] ?? 0, p[5] ?? 0, p[6] ?? 0], M, dim);
        const d = dim === 2 ? [b[0] - a[0], b[1] - a[1]] : sub(b, a), L = dim === 2 ? Math.hypot(d[0], d[1]) : len(d);
        if (!(L > 0)) return this.skip(110, 'zero length');
        const line = this.w.add(`LINE('',#${this.cp(a)},#${this.w.add(`VECTOR('',#${this.dir(d)},${num(L)})`)})`);
        return this.trimmed(line, a, b, dim);
    }
    arc(de, dim) {
        // centre (X1, Y1), start (X2, Y2), end (X3, Y3) in the plane z = ZT, counter-clockwise
        const p = this.params(de), M = this.matrixOf(de), zt = p[1] ?? 0;
        const c = [p[2] ?? 0, p[3] ?? 0, zt], s = [p[4] ?? 0, p[5] ?? 0, zt], e = [p[6] ?? 0, p[7] ?? 0, zt];
        const C = this.P(c, M, dim), S = this.P(s, M, dim), E = this.P(e, M, dim);
        const r = dim === 2 ? Math.hypot(S[0] - C[0], S[1] - C[1]) : len(sub(S, C));
        if (!(r > 0)) return this.skip(100, 'zero radius');
        let circle;
        if (dim === 2) circle = this.w.add(`CIRCLE('',#${this.axis2d(C, [1, 0])},${num(r)})`);
        else {
            // frame of the definition plane after the transformation (a mirror keeps the arc's sense: z = x × y)
            const x = this.D([1, 0, 0], M), y = this.D([0, 1, 0], M);
            circle = this.w.add(`CIRCLE('',#${this.axis2(C, cross(x, y), x)},${num(r)})`);
        }
        return this.trimmed(circle, S, E, dim);
    }
    conic(de, dim) {
        // A x² + B xy + C y² + D x + E y + F = 0 in the plane z = ZT, start (X1, Y1), end (X2, Y2); turned by
        // θ = ½ atan2(B, A − C) the xy term vanishes: ellipse, hyperbola (STEP: the branch on +x) or parabola (opening
        // along +x: V + f t² x + 2 f t y)
        const p = this.params(de), M = this.matrixOf(de);
        const [A, B, C, D, E, F] = p.slice(1, 7).map(v => v ?? 0), zt = p[7] ?? 0;
        const th = 0.5 * Math.atan2(B, A - C), c = Math.cos(th), s = Math.sin(th);
        const A1 = A * c * c + B * c * s + C * s * s, C1 = A * s * s - B * c * s + C * c * c;
        const D1 = D * c + E * s, E1 = -D * s + E * c;
        const toDef = (x, y) => [x * c - y * s, x * s + y * c];   // turned → definition coordinates
        const big = Math.max(Math.abs(A1), Math.abs(C1));
        if (!(big > 0)) return this.skip(104, 'degenerate');
        const S = this.P([p[8] ?? 0, p[9] ?? 0, zt], M, dim), En = this.P([p[10] ?? 0, p[11] ?? 0, zt], M, dim);
        const sx = (p[8] ?? 0) * c + (p[9] ?? 0) * s, sy = -(p[8] ?? 0) * s + (p[9] ?? 0) * c;   // start, turned
        let kind, o, x, a = 0, b = 0;   // o: centre / vertex (turned), x: direction of the STEP x axis (turned)
        if (Math.abs(A1) < 1e-12 * big || Math.abs(C1) < 1e-12 * big) {
            // parabola: A1 x² + D1 x + E1 y + F = 0 (or with x, y swapped)
            kind = 'parabola';
            if (Math.abs(C1) < 1e-12 * big) {
                if (!E1) return this.skip(104, 'degenerate');
                const x0 = -D1 / (2 * A1);
                o = [x0, -(F - (D1 * D1) / (4 * A1)) / E1];
                x = [0, -A1 / E1 > 0 ? 1 : -1];
                a = Math.abs(E1) / (4 * Math.abs(A1));
            } else {
                if (!D1) return this.skip(104, 'degenerate');
                const y0 = -E1 / (2 * C1);
                o = [-(F - (E1 * E1) / (4 * C1)) / D1, y0];
                x = [-C1 / D1 > 0 ? 1 : -1, 0];
                a = Math.abs(D1) / (4 * Math.abs(C1));
            }
        } else {
            const x0 = -D1 / (2 * A1), y0 = -E1 / (2 * C1), F0 = F - A1 * x0 * x0 - C1 * y0 * y0;
            o = [x0, y0];
            if (A1 * C1 > 0) {
                // ellipse: semi-axes along the turned axes, the larger one is STEP's x
                const ax = Math.sqrt(-F0 / A1), ay = Math.sqrt(-F0 / C1);
                if (!(ax > 0 && ay > 0)) return this.skip(104, 'degenerate');
                kind = 'ellipse';
                [a, b, x] = ax >= ay ? [ax, ay, [1, 0]] : [ay, ax, [0, 1]];
            } else {
                // hyperbola: the transverse axis where −F0 / coefficient > 0, x towards the branch of the start point
                kind = 'hyperbola';
                if (-F0 / A1 > 0) { a = Math.sqrt(-F0 / A1); b = Math.sqrt(F0 / C1); x = [sx >= x0 ? 1 : -1, 0]; }
                else { a = Math.sqrt(-F0 / C1); b = Math.sqrt(F0 / A1); x = [0, sy >= y0 ? 1 : -1]; }
                if (!(a > 0 && b > 0)) return this.skip(104, 'degenerate');
            }
        }
        const O = this.P([...toDef(o[0], o[1]), zt], M, dim), X = toDef(x[0], x[1]);
        const k = dim === 2 ? 1 : this.u * len(this.D([1, 0, 0], M));
        let placement;
        if (dim === 2) placement = this.axis2d(O, X);
        else {
            const xx = this.D([1, 0, 0], M), yy = this.D([0, 1, 0], M);
            placement = this.axis2(O, cross(xx, yy), this.D([X[0], X[1], 0], M));
        }
        const id = kind === 'ellipse' ? this.w.add(`ELLIPSE('',#${placement},${num(a * k)},${num(b * k)})`)
            : kind === 'hyperbola' ? this.w.add(`HYPERBOLA('',#${placement},${num(a * k)},${num(b * k)})`)
            : this.w.add(`PARABOLA('',#${placement},${num(a * k)})`);
        return this.trimmed(id, S, En, dim);
    }
    // 130 offset curve: base curve moved by d along V × tangent (the kernel's OFFSET_CURVE_3D) – trimmed to the
    // parameters TT1..TT2 (base curves whose parameters are the STEP ones: lines, arcs, B-splines); a distance varying
    // linearly or by a function is drawn with its mean
    offset(de, dim) {
        if (dim !== 3) return this.skip(130, '2D');
        const p = this.params(de), M = this.matrixOf(de);
        const [, base, flag, , , , d1, , d2, , vx, vy, vz, t1, t2] = p;
        const bt = this.f.typeOf(base);
        if (![100, 110, 126].includes(bt)) return this.skip(130, `base ${bt}`);
        const c = this.curve(base);
        if (!c) return null;
        let d = d1 ?? 0;
        if (flag !== 1) { d = ((d1 ?? 0) + (d2 ?? d1 ?? 0)) / 2; this.stats.offsetVarying = (this.stats.offsetVarying || 0) + 1; }
        const v = this.D([vx ?? 0, vy ?? 0, vz ?? 1], M);
        const off = this.w.add(`OFFSET_CURVE_3D('',#${c},${num(d * this.u * this.Lscale)},.U.,#${this.dir(len(v) > 0 ? v : [0, 0, 1])})`);
        if (typeof t1 === 'number' && typeof t2 === 'number' && t2 !== t1) {
            return this.w.add(`TRIMMED_CURVE('',#${off},(PARAMETER_VALUE(${num(t1)})),(PARAMETER_VALUE(${num(t2)})),.T.,.PARAMETER.)`);
        }
        return off;
    }
    composite(de, dim) {
        const p = this.params(de), n = p[1] ?? 0;
        const segs = [];
        for (let i = 0; i < n; i++) {
            const c = this.curve(p[2 + i], dim);
            if (c) segs.push(this.w.add(`COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#${c})`));
        }
        if (!segs.length) return this.skip(102, 'empty');
        return this.w.add(`COMPOSITE_CURVE('',${list(segs.map(ref))},.U.)`);
    }
    polyline(de, dim) {
        const p = this.params(de), M = this.matrixOf(de), form = this.f.formOf(de);
        if (![1, 2, 3, 11, 12, 13, 63].includes(form)) return this.skip(106, `form ${form}`);
        const ip = p[1], n = p[2] ?? 0, pts = [];
        let i = 3, zt = 0;
        if (ip === 1) zt = p[i++] ?? 0;
        for (let k = 0; k < n; k++) {
            if (ip === 1) { pts.push([p[i] ?? 0, p[i + 1] ?? 0, zt]); i += 2; }
            else { pts.push([p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0]); i += ip === 3 ? 6 : 3; }
        }
        if (form === 63 && pts.length) pts.push(pts[0]);
        if (pts.length < 2) return this.skip(106, 'too short');
        return this.w.add(`POLYLINE('',${list(pts.map(q => ref(this.cp(this.P(q, M, dim)))))})`);
    }
    splineCurve(de, dim) {
        // cubic segments X(s) = AX + BX s + CX s² + DX s³, s = u − T(i) → Bézier pieces of one B-spline
        const p = this.params(de), M = this.matrixOf(de);
        const n = p[4] ?? 0, T = p.slice(5, 6 + n);
        if (!(n > 0)) return this.skip(112, 'empty');
        const ctrl = [], knots = [T[0], T[0], T[0], T[0]];
        for (let i = 0; i < n; i++) {
            const c = p.slice(6 + n + 12 * i, 6 + n + 12 * (i + 1)).map(v => v ?? 0), h = T[i + 1] - T[i];
            const piece = k => { const a0 = c[k * 4], a1 = c[k * 4 + 1] * h, a2 = c[k * 4 + 2] * h * h, a3 = c[k * 4 + 3] * h * h * h; return [a0, a0 + a1 / 3, a0 + (2 * a1 + a2) / 3, a0 + a1 + a2 + a3]; };
            const X = piece(0), Y = piece(1), Z = piece(2);
            for (let j = i ? 1 : 0; j < 4; j++) ctrl.push([X[j], Y[j], Z[j]]);
            knots.push(...(i < n - 1 ? [T[i + 1], T[i + 1], T[i + 1]] : [T[n], T[n], T[n], T[n]]));
        }
        return this.writeBSplineCurve(3, ctrl.map(q => this.P(q, M, dim)), null, knots, false);
    }
    bspline(de, dim) {
        const p = this.params(de), M = this.matrixOf(de);
        const K = p[1], deg = p[2];
        if (!(K >= 1 && deg >= 1)) return this.skip(126, 'degenerate');
        const nk = K + deg + 2;
        let i = 7;
        const T = p.slice(i, i + nk).map(v => v ?? 0); i += nk;
        const W = p.slice(i, i + K + 1).map(v => v ?? 1); i += K + 1;
        const ctrl = [];
        for (let k = 0; k <= K; k++, i += 3) ctrl.push(this.P([p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0], M, dim));
        const v0 = p[i], v1 = p[i + 1];
        const rational = W.some(w => Math.abs(w - W[0]) > 1e-12 * Math.abs(W[0]));
        const id = this.writeBSplineCurve(deg, ctrl, rational ? W : null, T, p[4] === 1);
        // parameter range narrower than the knots: trimmed
        const lo = T[deg], hi = T[K + 1], span = Math.abs(hi - lo) || 1;
        if (typeof v0 === 'number' && typeof v1 === 'number' && v1 > v0 && (v0 > lo + 1e-9 * span || v1 < hi - 1e-9 * span)) {
            return this.w.add(`TRIMMED_CURVE('',#${id},(PARAMETER_VALUE(${num(v0)})),(PARAMETER_VALUE(${num(v1)})),.T.,.PARAMETER.)`);
        }
        return id;
    }
    writeBSplineCurve(deg, ctrl, weights, T, closed) {
        const { knots, mults } = knotsOf(T);
        const pts = list(ctrl.map(q => ref(this.cp(q))));
        const flags = `.UNSPECIFIED.,${closed ? '.T.' : '.F.'},.F.`;
        if (!weights) return this.w.add(`B_SPLINE_CURVE_WITH_KNOTS('',${deg},${pts},${flags},${list(mults)},${list(knots.map(num))},.UNSPECIFIED.)`);
        return this.w.add(`(BOUNDED_CURVE()B_SPLINE_CURVE(${deg},${pts},${flags})B_SPLINE_CURVE_WITH_KNOTS(${list(mults)},${list(knots.map(num))},.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_CURVE(${list(weights.map(num))})REPRESENTATION_ITEM(''))`);
    }

    // start point of a curve (model space, mm) – for the tabulated cylinder's generatrix
    curveStart(de) {
        const t = this.f.typeOf(de), p = this.params(de), M = this.matrixOf(de);
        if (t === 110) return this.P([p[1], p[2], p[3]], M);
        if (t === 100) return this.P([p[4], p[5], p[1]], M);
        if (t === 104) return this.P([p[8], p[9], p[7]], M);
        if (t === 102) return this.curveStart(p[2]);
        if (t === 126) {
            const K = p[1], deg = p[2], nk = K + deg + 2, T = p.slice(7, 7 + nk), W = p.slice(7 + nk, 8 + nk + K);
            const C = [];
            for (let k = 0, i = 8 + nk + K; k <= K; k++, i += 3) C.push([p[i], p[i + 1], p[i + 2]]);
            const v0 = p[8 + nk + K + 3 * (K + 1)];
            return this.P(deBoor(deg, T, C, W, typeof v0 === 'number' ? v0 : T[deg]), M);
        }
        return null;
    }

    // --- surfaces ---
    surface(de) {
        return this.once(`s:${de}`, () => {
            const t = this.f.typeOf(de), p = this.params(de), M = this.matrixOf(de);
            // point / direction entities: their own matrix, then the surface's (and a baked instance part)
            const raw = r => this.params(r).slice(1, 4).map(v => v ?? 0);
            const loc = r => this.P(applyP(this.matrixOf(r), raw(r)), M);
            const direction = r => this.D(applyD(this.matrixOf(r), raw(r)), M);
            switch (t) {
                case 128: return this.bsplineSurface(de, p, M);
                case 108: {
                    const n = this.D([p[1] ?? 0, p[2] ?? 0, p[3] ?? 0], M), m = [p[1] ?? 0, p[2] ?? 0, p[3] ?? 0], l2 = dot(m, m);
                    if (!(l2 > 0)) return this.skip(108, 'no normal');
                    const o = this.P(m.map(c => (c * (p[4] ?? 0)) / l2), M);
                    return this.w.add(`PLANE('',#${this.axis2(o, n, perpendicular(n))})`);
                }
                case 190: {
                    const z = direction(p[2]), x = this.f.formOf(de) === 1 && p[3] ? direction(p[3]) : perpendicular(normalize(z));
                    return this.w.add(`PLANE('',#${this.axis2(loc(p[1]), z, x)})`);
                }
                case 192: case 194: case 196: case 198: {
                    // 192 cylinder (loc, axis, r, refdir), 194 cone (loc, axis, r, semi-angle°, refdir), 196 sphere (centre, r,
                    // axis, refdir), 198 torus (centre, axis, R, r, refdir); refdir only in form 1
                    const form1 = this.f.formOf(de) === 1, k = this.u * len(this.D([1, 0, 0], M));
                    const axisRef = t === 196 ? p[3] : p[2], refRef = { 192: p[4], 194: p[5], 196: p[4], 198: p[5] }[t];
                    const z = axisRef ? direction(axisRef) : this.D([0, 0, 1], M);
                    const x = form1 && refRef ? direction(refRef) : perpendicular(normalize(z));
                    const pl = this.axis2(loc(p[1]), z, x);
                    if (t === 192) return this.w.add(`CYLINDRICAL_SURFACE('',#${pl},${num((p[3] ?? 0) * k)})`);
                    if (t === 194) return this.w.add(`CONICAL_SURFACE('',#${pl},${num((p[3] ?? 0) * k)},${num(((p[4] ?? 0) * Math.PI) / 180)})`);
                    if (t === 196) return this.w.add(`SPHERICAL_SURFACE('',#${pl},${num((p[2] ?? 0) * k)})`);
                    return this.w.add(`TOROIDAL_SURFACE('',#${pl},${num((p[3] ?? 0) * k)},${num((p[4] ?? 0) * k)})`);
                }
                case 120: {
                    // axis line, generatrix, start and end angle (the faces bound the range)
                    const lp = this.params(p[1]), LM = this.matrixOf(p[1]);
                    const a = this.P(lp.slice(1, 4).map(v => v ?? 0), LM), b = this.P(lp.slice(4, 7).map(v => v ?? 0), LM);
                    const c = this.curve(p[2]);
                    if (!c || !(len(sub(b, a)) > 0)) return this.skip(120, 'axis or curve');
                    return this.w.add(`SURFACE_OF_REVOLUTION('',#${c},#${this.w.add(`AXIS1_PLACEMENT('',#${this.cp(a)},#${this.dir(sub(b, a))})`)})`);
                }
                case 122: {
                    const c = this.curve(p[1]), s = this.curveStart(p[1]);
                    if (!c || !s) return this.skip(122, 'directrix');
                    const e = this.P([p[2] ?? 0, p[3] ?? 0, p[4] ?? 0], M), v = sub(e, s);
                    if (!(len(v) > 0)) return this.skip(122, 'no generatrix');
                    return this.w.add(`SURFACE_OF_LINEAR_EXTRUSION('',#${c},#${this.w.add(`VECTOR('',#${this.dir(v)},${num(len(v))})`)})`);
                }
                case 140: {
                    const base = this.surface(p[5]);
                    return base ? this.w.add(`OFFSET_SURFACE('',#${base},${num((p[4] ?? 0) * this.u * this.Lscale)},.F.)`) : null;
                }
                case 118: return this.ruled(de, p);
                default: return this.skip(t, 'surface');
            }
        });
    }
    bsplineSurface(de, p, M) {
        const K1 = p[1], K2 = p[2], M1 = p[3], M2 = p[4];
        if (!(K1 >= 1 && K2 >= 1 && M1 >= 1 && M2 >= 1)) return this.skip(128, 'degenerate');
        let i = 10;
        const S = p.slice(i, i + K1 + M1 + 2).map(v => v ?? 0); i += K1 + M1 + 2;
        const T = p.slice(i, i + K2 + M2 + 2).map(v => v ?? 0); i += K2 + M2 + 2;
        const nw = (K1 + 1) * (K2 + 1);
        const W = p.slice(i, i + nw).map(v => v ?? 1); i += nw;
        const pts = [];
        for (let k = 0; k < nw; k++, i += 3) pts.push(this.P([p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0], M));
        // STEP rows: first index u (IGES: the first index runs fastest)
        const ids = pts.map(q => this.cp(q));
        const rows = [], wrows = [];
        for (let a = 0; a <= K1; a++) {
            const row = [], wr = [];
            for (let b = 0; b <= K2; b++) { row.push(ref(ids[a + b * (K1 + 1)])); wr.push(num(W[a + b * (K1 + 1)])); }
            rows.push(list(row)); wrows.push(list(wr));
        }
        const u = knotsOf(S), v = knotsOf(T);
        const rational = W.some(w => Math.abs(w - W[0]) > 1e-12 * Math.abs(W[0]));
        const flags = `.UNSPECIFIED.,${p[5] === 1 ? '.T.' : '.F.'},${p[6] === 1 ? '.T.' : '.F.'},.F.`;
        const knots = `${list(u.mults)},${list(v.mults)},${list(u.knots.map(num))},${list(v.knots.map(num))},.UNSPECIFIED.`;
        if (!rational) return this.w.add(`B_SPLINE_SURFACE_WITH_KNOTS('',${M1},${M2},${list(rows)},${flags},${knots})`);
        return this.w.add(`(BOUNDED_SURFACE()B_SPLINE_SURFACE(${M1},${M2},${list(rows)},${flags})B_SPLINE_SURFACE_WITH_KNOTS(${knots})GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(${list(wrows)})REPRESENTATION_ITEM('')SURFACE())`);
    }
    // IGES 128 forms 1–5 mark a NURBS as plane, cylinder, cone, sphere or torus (exporters write every analytic surface
    // as NURBS). Recognised from the control net – on-surface control points and arcs verified – and written as the
    // analytic STEP surface: the kernel tessellates those robustly (rational spline cylinders gave folded triangles and
    // flipped normals: a large brick assembly 8 657 vs 1 130 in its native STEP, which has the analytic surfaces). For
    // faces with edges in 3D only (any parametrisation – the boundary is projected). Returns { id, flip } – flip: the
    // analytic normal is opposite to the NURBS normal (the face's sense turns) – or null.
    analytic(de) {
        return this.once(`a:${de}`, () => {
            const form = this.f.formOf(de);
            if (this.f.typeOf(de) !== 128 || form < 1 || form > 5) return null;
            const net = this.net(de);
            if (!net) return null;
            const fit = form === 1 ? fitPlane(net) : form === 2 || form === 3 ? fitRevolved(net, form) : form === 4 ? fitSphere(net) : fitTorus(net);
            if (!fit) {
                const key = `form ${form} ${net.pu}x${net.pv}`, by = (this.stats.notAnalytic ??= {});
                by[key] = (by[key] || 0) + 1;
                return null;
            }
            const w = this.w, pl = this.axis2(fit.o, fit.z, fit.x);
            let id;
            if (fit.kind === 'plane') id = w.add(`PLANE('',#${pl})`);
            else if (fit.kind === 'cylinder') id = w.add(`CYLINDRICAL_SURFACE('',#${pl},${num(fit.r)})`);
            else if (fit.kind === 'cone') id = w.add(`CONICAL_SURFACE('',#${pl},${num(fit.r)},${num(fit.angle)})`);
            else if (fit.kind === 'sphere') id = w.add(`SPHERICAL_SURFACE('',#${pl},${num(fit.r)})`);
            else id = w.add(`TOROIDAL_SURFACE('',#${pl},${num(fit.R)},${num(fit.r)})`);
            this.stats.analytic = (this.stats.analytic || 0) + 1;
            // a STEP cylinder, cone, sphere or torus faces away from its axis / centre: compare with the NURBS normal
            const out = fit.kind === 'plane' ? fit.z : fit.outward(net.corner.p);
            return { id, flip: dot(out, net.corner.n) < 0 };
        });
    }
    // control net of a 128 in mm: rows P[i][j] (i along u), weights, knots, a corner with its NURBS normal
    net(de) {
        const p = this.params(de), M = this.matrixOf(de);
        const K1 = p[1], K2 = p[2], pu = p[3], pv = p[4];
        if (!(K1 >= 1 && K2 >= 1)) return null;
        let i = 10;
        const S = p.slice(i, i + K1 + pu + 2); i += K1 + pu + 2;
        const T = p.slice(i, i + K2 + pv + 2); i += K2 + pv + 2;
        const nw = (K1 + 1) * (K2 + 1), Wf = p.slice(i, i + nw); i += nw;
        const P = [], W = [];
        for (let a = 0; a <= K1; a++) { P.push([]); W.push([]); }
        for (let k = 0; k < nw; k++, i += 3) {
            const a = k % (K1 + 1), b = Math.floor(k / (K1 + 1));
            P[a][b] = this.P([p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0], M);
            W[a][b] = Wf[k] ?? 1;
        }
        // clamped knots only (the corners lie on the surface, the net's edges are tangents there)
        const clamped = (U, deg) => U.slice(0, deg + 1).every(x => x === U[0]) && U.slice(-deg - 1).every(x => x === U[U.length - 1]);
        if (!clamped(S, pu) || !clamped(T, pv)) return null;
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const row of P) for (const q of row) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], q[c]); hi[c] = Math.max(hi[c], q[c]); }
        const size = len(sub(hi, lo)) || 1;
        // normal at a corner whose two net edges are not degenerate (a pole has a zero edge)
        const nu = K1, nv = K2;
        let corner = null;
        for (const [a, b, da, db] of [[0, 0, 1, 1], [nu, 0, -1, 1], [0, nv, 1, -1], [nu, nv, -1, -1]]) {
            const eu = sub(P[a + da][b], P[a][b]), ev = sub(P[a][b + db], P[a][b]);
            const n = cross(eu.map(x => x * da), ev.map(x => x * db));   // +u × +v
            if (len(n) > 1e-9 * size * size) { corner = { p: P[a][b], n: normalize(n) }; break; }
        }
        if (!corner) return null;
        return { P, W, S, T, pu, pv, size, tol: 1e-5 * size, corner };
    }

    // ruled surface between two curves (lines, arcs, B-splines): both as NURBS made compatible – degree raised, knot
    // vectors joined – then one control row per curve, linear between them (parametric correspondence)
    ruled(de, p) {
        const a = this.nurbsOf(p[1]), b = this.nurbsOf(p[2]);
        if (!a || !b) return this.skip(118, 'curve type');
        if (p[3] === 1) reverseNurbs(b);
        const [A, B] = compatible(a, b);
        const rows = A.Pw.map((q, i) => list([ref(this.cp(q.slice(0, 3).map(x => x / q[3]))), ref(this.cp(B.Pw[i].slice(0, 3).map(x => x / B.Pw[i][3])))]));
        const u = knotsOf(A.U);
        const W = [...A.Pw, ...B.Pw].map(q => q[3]);
        const rational = W.some(w => Math.abs(w - W[0]) > 1e-12 * Math.abs(W[0]));
        const knots = `${list(u.mults)},(2,2),${list(u.knots.map(num))},(0.,1.),.UNSPECIFIED.`;
        if (!rational) return this.w.add(`B_SPLINE_SURFACE_WITH_KNOTS('',${A.p},1,${list(rows)},.UNSPECIFIED.,.F.,.F.,.F.,${knots})`);
        const wrows = A.Pw.map((q, i) => list([num(q[3]), num(B.Pw[i][3])]));
        return this.w.add(`(BOUNDED_SURFACE()B_SPLINE_SURFACE(${A.p},1,${list(rows)},.UNSPECIFIED.,.F.,.F.,.F.)B_SPLINE_SURFACE_WITH_KNOTS(${knots})GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE(${list(wrows)})REPRESENTATION_ITEM('')SURFACE())`);
    }
    // a curve as NURBS { p, U (normalised to 0..1), Pw (homogeneous x w, y w, z w, w), model space mm }
    nurbsOf(de) {
        const t = this.f.typeOf(de), q = this.params(de), M = this.matrixOf(de);
        const h = (pt, w = 1) => [pt[0] * w, pt[1] * w, pt[2] * w, w];
        if (t === 110) return { p: 1, U: [0, 0, 1, 1], Pw: [h(this.P(q.slice(1, 4).map(v => v ?? 0), M)), h(this.P(q.slice(4, 7).map(v => v ?? 0), M))] };
        if (t === 126) {
            const K = q[1], deg = q[2], nk = K + deg + 2;
            const T = q.slice(7, 7 + nk).map(v => v ?? 0), W = q.slice(7 + nk, 8 + nk + K).map(v => v ?? 1), Pw = [];
            for (let k = 0, i = 8 + nk + K; k <= K; k++, i += 3) Pw.push(h(this.P([q[i] ?? 0, q[i + 1] ?? 0, q[i + 2] ?? 0], M), W[k]));
            const lo = T[deg], hi = T[K + 1], span = hi - lo || 1;
            return { p: deg, U: T.map(x => (x - lo) / span), Pw };
        }
        if (t === 100) {
            // arc as rational quadratic Bézier pieces of at most 90°
            const zt = q[1] ?? 0, C = [q[2] ?? 0, q[3] ?? 0], S = [q[4] ?? 0, q[5] ?? 0], E = [q[6] ?? 0, q[7] ?? 0];
            const r = Math.hypot(S[0] - C[0], S[1] - C[1]);
            if (!(r > 0)) return null;
            const a0 = Math.atan2(S[1] - C[1], S[0] - C[0]);
            let a1 = Math.atan2(E[1] - C[1], E[0] - C[0]);
            while (a1 <= a0 + 1e-12) a1 += 2 * Math.PI;
            const n = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2) - 1e-9)), da = (a1 - a0) / n, w = Math.cos(da / 2);
            const at = (a, k = 1) => this.P([C[0] + r * k * Math.cos(a), C[1] + r * k * Math.sin(a), zt], M);
            const Pw = [h(at(a0))], U = [0, 0, 0];
            for (let i = 0; i < n; i++) {
                const m = a0 + da * (i + 0.5);
                Pw.push(h(at(m, 1 / w), w), h(at(a0 + da * (i + 1))));
                U.push(...(i < n - 1 ? [(i + 1) / n, (i + 1) / n] : [1, 1, 1]));
            }
            return { p: 2, U, Pw };
        }
        return null;
    }

    // --- B-rep ---
    vertex(listDe, idx) {
        return this.once(listDe * 2 ** 20 + idx, () => {
            const p = this.params(listDe, true), M = this.matrixOf(listDe), i = 2 + (idx - 1) * 3;
            if (idx < 1 || idx > (p[1] ?? 0)) return this.skip(502, 'index');
            return this.w.add(`VERTEX_POINT('',#${this.cp(this.P([p[i] ?? 0, p[i + 1] ?? 0, p[i + 2] ?? 0], M))})`);
        });
    }
    edge(listDe, idx) {
        return this.once(-(listDe * 2 ** 20 + idx), () => {
            const p = this.params(listDe, true), i = 2 + (idx - 1) * 5;
            if (idx < 1 || idx > (p[1] ?? 0)) return this.skip(504, 'index');
            const c = this.curve(p[i]), v1 = this.vertex(p[i + 1], p[i + 2]), v2 = this.vertex(p[i + 3], p[i + 4]);
            if (!c || !v1 || !v2) return this.skip(504, 'curve or vertex');
            return this.w.add(`EDGE_CURVE('',#${v1},#${v2},#${c},.T.)`);
        });
    }
    loop(de) {
        return this.once(`l:${de}`, () => {
            const p = this.params(de), n = p[1] ?? 0, oes = [];
            for (let k = 0, i = 2; k < n; k++) {
                const [type, list_, ndx, of, K] = p.slice(i, i + 5);
                i += 5 + 2 * (K ?? 0);
                if (type !== 0) continue;   // a vertex in the loop (degenerate): no edge
                const e = this.edge(list_, ndx);
                if (e) oes.push(this.w.add(`ORIENTED_EDGE('',*,*,#${e},${of === 0 ? '.F.' : '.T.'})`));
            }
            return oes.length ? this.w.add(`EDGE_LOOP('',${list(oes.map(ref))})`) : this.skip(508, 'no edges');
        });
    }
    face(de, sense) {
        return this.once(`f${sense ? 1 : 0}:${de}`, () => {
            const p = this.params(de), n = p[2] ?? 0, outerFirst = p[3] === 1;
            // the analytic surface a NURBS stands for (128 forms 1–5) – its normal may be the other way round
            const analytic = this.analytic(p[1]);
            const surf = analytic ? analytic.id : this.surface(p[1]);
            if (analytic?.flip) sense = !sense;
            // a mirrored instance: the normal of a parametric surface (du × dv) turns, a geometric one (plane normal,
            // outward cylinder …) does not
            if (this.mirror && !GEOMETRIC_NORMAL.has(this.f.typeOf(p[1]))) sense = !sense;
            if (!surf) return this.skip(510, 'surface');
            const bounds = [];
            for (let i = 0; i < n; i++) {
                const l = this.loop(p[4 + i]);
                if (l) bounds.push(this.w.add(`${i === 0 && outerFirst ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',#${l},.T.)`));
            }
            if (!bounds.length) return this.skip(510, 'no bounds');
            this.stats.faces++;
            return this.w.add(`ADVANCED_FACE('',${list(bounds.map(ref))},#${surf},${sense ? '.T.' : '.F.'})`);
        });
    }
    // solidColor: faces of that colour need no style of their own (the plan takes face > shell > solid)
    shell(de, flip = false, solidColor = null, override = null) {
        return this.once(`sh${flip ? 1 : 0}:${de}`, () => {
            const p = this.params(de), n = p[1] ?? 0, faces = [];
            for (let k = 0; k < n; k++) {
                const fde = p[2 + 2 * k], of = p[3 + 2 * k] !== 0;
                const id = this.face(fde, of !== flip);
                if (id) { faces.push(id); this.faceColor(id, fde, solidColor, override); }
            }
            if (!faces.length) return this.skip(514, 'no faces');
            return this.w.add(`${this.f.formOf(de) === 2 ? 'OPEN_SHELL' : 'CLOSED_SHELL'}('',${list(faces.map(ref))})`);
        });
    }
    // override: colour of the instance it is drawn in (a solid per colour – the shell and its faces are shared; the STEP
    // import tessellates the copies once, B-rep instancing)
    solid(de, override = null) {
        return this.once(`so:${de}|${colorKey(override)}`, () => {
            const p = this.params(de), color = this.colorOf(de) || this.colorOf(p[1]);
            const outer = this.shell(p[1], p[2] === 0, color, override), voids = [];
            if (!outer) return this.skip(186, 'shell');
            for (let k = 0; k < (p[3] ?? 0); k++) { const v = this.shell(p[4 + 2 * k], p[5 + 2 * k] === 0, color, override); if (v) voids.push(v); }
            this.stats.solids++;
            const name = str(this.nameOf(de, 4 + 2 * (p[3] ?? 0)));
            const id = voids.length ? this.w.add(`BREP_WITH_VOIDS(${name},#${outer},${list(voids.map(ref))})`) : this.w.add(`MANIFOLD_SOLID_BREP(${name},#${outer})`);
            this.style(id, override || color);
            return id;
        });
    }

    // --- trimmed and bounded surfaces → CURVE_BOUNDED_SURFACE ---
    // boundary from a 142 curve on surface: its model-space curve, else its parameter curve as PCURVE (B-spline surfaces)
    boundary(de, surfDe, surf, outer) {
        return this.once(`b${outer ? 1 : 0}:${de}`, () => this.boundaryOf(de, surfDe, surf, outer));
    }
    boundaryOf(de, surfDe, surf, outer) {
        const p = this.params(de), model = p[4], param = p[3];
        const segs = [];
        const segOf = c => this.w.add(`COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#${c})`);
        if (model && this.f.typeOf(model) === 102) {
            const q = this.params(model);
            for (let i = 0; i < (q[1] ?? 0); i++) { const c = this.curve(q[2 + i]); if (c) segs.push(segOf(c)); }
        } else if (model) {
            const c = this.curve(model);
            if (c) segs.push(segOf(c));
        }
        if (!segs.length && param && this.f.typeOf(surfDe) === 128) {
            const c2 = this.curve(param, 2);
            if (c2) {
                // always as a composite curve: its segments are bounded by their trims (a PCURVE over a trimmed arc
                // would be read over the whole circle)
                const comp = this.f.typeOf(param) === 102 ? c2 : this.w.add(`COMPOSITE_CURVE('',(#${segOf(c2)}),.U.)`);
                const rep = this.w.add(`DEFINITIONAL_REPRESENTATION('',(#${comp}),#${this.context2d()})`);
                segs.push(segOf(this.w.add(`PCURVE('',#${surf},#${rep})`)));
            }
        }
        if (!segs.length) return this.skip(142, 'no usable curve');
        return this.w.add(`${outer ? 'OUTER_BOUNDARY_CURVE' : 'BOUNDARY_CURVE'}('',${list(segs.map(ref))},.U.)`);
    }
    trimmedSurface(de, override = null) {
        return this.once(`t:${de}|${colorKey(override)}`, () => {
            const p = this.params(de), surf = this.surface(p[1]);
            if (!surf) return this.skip(144, 'surface');
            const implicit = (p[2] ?? 0) === 0, bounds = [];
            if (!implicit) {
                const b = this.boundary(p[4], p[1], surf, true);
                if (!b) return this.skip(144, 'outer boundary');
                bounds.push(b);
            }
            for (let k = 0; k < (p[3] ?? 0); k++) { const b = this.boundary(p[5 + k], p[1], surf, false); if (b) bounds.push(b); }
            this.stats.trimmed++;
            const id = this.w.add(`CURVE_BOUNDED_SURFACE('',#${surf},${list(bounds.map(ref))},${implicit ? '.T.' : '.F.'})`);
            this.style(id, override || this.colorOf(de) || this.colorOf(p[1]));
            return id;
        });
    }
    boundedSurface(de, override = null) {
        return this.once(`t:${de}|${colorKey(override)}`, () => {
            const p = this.params(de), surf = this.surface(p[2]);
            if (!surf) return this.skip(143, 'surface');
            const bounds = [];
            for (let k = 0; k < (p[3] ?? 0); k++) {
                // 141: type, preference, surface, n, then per curve: model curve, sense (1 agrees, 2 reversed), k, k param curves
                const q = this.params(p[4 + k]), n = q[4] ?? 0, segs = [];
                for (let j = 0, i = 5; j < n; j++) {
                    const [crv, sense, kk] = q.slice(i, i + 3);
                    i += 3 + (kk ?? 0);
                    const c = this.curve(crv);
                    if (c) segs.push(this.w.add(`COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,${sense === 2 ? '.F.' : '.T.'},#${c})`));
                }
                if (segs.length) bounds.push(this.w.add(`${k === 0 ? 'OUTER_BOUNDARY_CURVE' : 'BOUNDARY_CURVE'}('',${list(segs.map(ref))},.U.)`));
            }
            if (!bounds.length) return this.skip(143, 'no boundaries');
            this.stats.trimmed++;
            const id = this.w.add(`CURVE_BOUNDED_SURFACE('',#${surf},${list(bounds.map(ref))},.F.)`);
            this.style(id, override || this.colorOf(de) || this.colorOf(p[2]));
            return id;
        });
    }
    // a bounded surface without trimming: the whole surface as a face
    plainSurface(de, override = null) {
        return this.once(`t:${de}|${colorKey(override)}`, () => {
            const surf = this.surface(de);
            if (!surf) return null;
            this.stats.surfaces++;
            const id = this.w.add(`CURVE_BOUNDED_SURFACE('',#${surf},(),.T.)`);
            this.style(id, override || this.colorOf(de));
            return id;
        });
    }
    // a face standing alone (510 outside a shell): with the surface's orientation
    looseFace(de) {
        const id = this.face(de, true);
        if (id) this.faceColor(id, de);
        return id;
    }

    // --- colours ---
    colorOf(de) {
        const k = this.f.index(de);
        if (k < 0) return null;
        const c = this.f.color[k];
        if (c > 0) return STANDARD_COLORS[c] || null;
        if (c < 0 && this.f.typeOf(-c) === 314) {
            const p = this.params(-c);
            return [p[1], p[2], p[3]].map(v => Math.min(1, Math.max(0, (v ?? 0) / 100)));
        }
        return null;
    }
    // face colour: the face's own; its surface's only where neither the solid nor an instance has one (an export wrote one
    // blue on every surface, the part colours at the instances) – styled only where it differs from the solid's
    faceColor(id, faceDe, solidColor = null, override = null) {
        const own = this.colorOf(faceDe), c = own || (solidColor || override ? null : this.colorOf(this.params(faceDe)[1]));
        if (c && !(solidColor && c.every((v, i) => Math.abs(v - solidColor[i]) < 1e-4))) this.style(id, c);
    }
    style(item, rgb) {
        if (!rgb) return;
        const key = rgb.map(v => v.toFixed(4)).join(',');
        let psa = this.colorStyle.get(key);
        if (!psa) {
            const w = this.w;
            const col = w.add(`COLOUR_RGB('',${rgb.map(num).join(',')})`);
            const fill = w.add(`FILL_AREA_STYLE('',(#${w.add(`FILL_AREA_STYLE_COLOUR('',#${col})`)}))`);
            const side = w.add(`SURFACE_SIDE_STYLE('',(#${w.add(`SURFACE_STYLE_FILL_AREA(#${fill})`)}))`);
            psa = w.add(`PRESENTATION_STYLE_ASSIGNMENT((#${w.add(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`)}))`);
            this.colorStyle.set(key, psa);
        }
        this.w.add(`STYLED_ITEM('',(#${psa}),#${item})`);
    }

    // --- representation contexts ---
    context() {
        if (this.ctx) return this.ctx;
        const w = this.w;
        const mm = w.add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
        const rad = w.add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
        const sr = w.add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
        this.ctx = w.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#${mm},#${rad},#${sr}))REPRESENTATION_CONTEXT('',''))`);
        const app = w.add("APPLICATION_CONTEXT('automotive design')");
        this.productCtx = w.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
        this.pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
        return this.ctx;
    }
    context2d() {
        return this.ctx2 ??= this.w.add("(GEOMETRIC_REPRESENTATION_CONTEXT(2)PARAMETRIC_REPRESENTATION_CONTEXT()REPRESENTATION_CONTEXT('2D SPACE',''))");
    }

    // name of an entity: a name property (406 form 15) among the pointers after its defined parameters (end = their
    // count + 1), else the label of its directory entry
    nameOf(de, end) {
        const p = this.params(de), nv = p[end] ?? 0, np = p[end + 1 + nv] ?? 0;
        for (const q of p.slice(end + 2 + nv, end + 2 + nv + np)) {
            if (this.f.typeOf(q) === 406 && this.f.formOf(q) === 15) { const n = this.params(q)[2]; if (typeof n === 'string' && n.trim()) return n.trim(); }
        }
        return this.f.label(de);
    }

    // --- structure: products for the root, every instanced subfigure definition and every group ---
    // override: instance colour; L: linear part baked into the geometry (setLinear); owner: entity → group it belongs
    // to (an entity a group lists and that stands elsewhere as well goes to the group); self: the group this product is
    product(name, members, override = null, L = null, owner = new Map(), self = 0) {
        const saved = this.L;
        this.setLinear(L);
        try {
            const w = this.w, ctx = this.context();
            const seen = new Set();   // groups often list entities that stand on their own as well
            const solids = [], faces = [], children = [], groups = [];
            // groups of this level claim their members first
            for (const de of members) {
                if (!(de > 0) || this.f.typeOf(de) !== 402 || !GROUP_FORMS.has(this.f.formOf(de)) || owner.has(de)) continue;
                owner.set(de, self);
                const g = this.params(de), own = [];
                for (const m of g.slice(2, 2 + (g[1] ?? 0))) if (m > 0 && !owner.has(m)) { owner.set(m, de); own.push(m); }
                // only groups with something to draw (a layer of curves stays out – no empty node)
                if (own.some(m => this.drawable(m))) groups.push({ de, own, name: this.nameOf(de, 2 + (g[1] ?? 0)) });
            }
            for (const de of members) {
                if (!(de > 0) || this.f.blanked(de) || seen.has(de)) continue;
                if (owner.has(de) && owner.get(de) !== self) continue;   // in a group of its own
                seen.add(de);
                const t = this.f.typeOf(de);
                let id = null;
                if (t === 186) id = this.solid(de, override);
                else if (t === 514) { id = this.shell(de); if (id) this.style(id, override || this.colorOf(de)); }
                else if (t === 144) { const x = this.trimmedSurface(de, override); if (x) faces.push(x); }
                else if (t === 143) { const x = this.boundedSurface(de, override); if (x) faces.push(x); }
                else if (t === 510) { const x = this.looseFace(de); if (x) faces.push(x); }
                else if (SURFACE_ALONE.has(t)) { const x = this.plainSurface(de, override); if (x) faces.push(x); }
                else if (t === 408) children.push(de);
                if (id) solids.push(id);
            }
            const items = [...solids];
            if (faces.length) items.push(w.add(`GEOMETRIC_SET('',${list(faces.map(ref))})`));
            const rep = w.add(`SHAPE_REPRESENTATION(${str(name)},${list(items.map(ref))},#${ctx})`);
            const prod = w.add(`PRODUCT(${str(name)},${str(name)},'',(#${this.productCtx}))`);
            const form = w.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`);
            const pd = w.add(`PRODUCT_DEFINITION('design','',#${form},#${this.pdCtx})`);
            w.add(`SHAPE_DEFINITION_REPRESENTATION(#${w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)},#${rep})`);
            this.stats.products++;
            const me = { rep, pd };
            for (const inst of children) this.instance(inst, me, override, L);
            // a group: a node of its own in the same space (no placement)
            for (const g of groups) {
                const child = this.product(g.name, g.own, override, L, owner, g.de);
                this.occurrence(me, child, null, g.name);
                this.stats.groups = (this.stats.groups || 0) + 1;
            }
            return me;
        } finally {
            this.setLinear(saved);
        }
    }
    drawable(de) {
        const t = this.f.typeOf(de);
        return SOLID_TYPES.has(t) || FACE_TYPES.has(t) || SURFACE_ALONE.has(t) || t === 408 || (t === 402 && GROUP_FORMS.has(this.f.formOf(de)));
    }
    // a product per subfigure definition, instance colour and baked linear part
    definition(de, override = null, L = null) {
        const key = `${de}|${colorKey(override)}|${L ? L.map(v => v.toFixed(9)).join(',') : ''}`;
        if (this.defs.has(key)) return this.defs.get(key);
        this.defs.set(key, null);   // (cycles)
        const p = this.params(de), n = p[3] ?? 0;
        const def = this.product(typeof p[2] === 'string' ? p[2].trim() : this.f.label(de), p.slice(4, 4 + n), override, L);
        this.defs.set(key, def);
        return def;
    }
    // 408: the definition rotated by the instance's matrix, then moved by (X, Y, Z) – the translation lies in the parent's
    // space (checked against the native STEP export of an assembly: the other order put every sub-assembly elsewhere).
    // The instance's colour is the colour of its content (the innermost instance with one wins) – exporters write the
    // part colour there, the bodies inside carry another. Scale S and a mirror (det < 0) cannot be a placement: the
    // whole linear part (with the parent's baked one, Lp) is baked into a variant of the definition, the placement only
    // moves it; a proper rotation stays a placement
    instance(de, parent, outer = null, Lp = null) {
        const p = this.params(de);
        if (this.f.typeOf(p[1]) !== 308) return this.skip(408, 'no definition');
        const M = this.matrixOf(de) || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
        const s = p[5] ?? 1;
        let T = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]].map(v => v * s);
        if (Lp) T = mul9(Lp, T);
        let t = [M[3] + (p[2] ?? 0), M[7] + (p[3] ?? 0), M[11] + (p[4] ?? 0)];
        if (Lp) t = mul3(Lp, t);
        const rigid = isRotation(T);
        if (!rigid) { if (det9(T) < 0) this.stats.mirrored++; if (Math.abs(Math.abs(det9(T)) - 1) > 1e-6) this.stats.scaled++; }
        const child = this.definition(p[1], this.colorOf(de) || outer, rigid ? null : T);
        if (!child) return null;
        const o = t.map(v => v * this.u);
        const target = rigid ? this.axis2(o, [T[2], T[5], T[8]], [T[0], T[3], T[6]]) : this.axis2(o, [0, 0, 1], [1, 0, 0]);
        this.stats.instances++;
        return this.occurrence(parent, child, target, this.f.label(de));
    }
    // assembly occurrence of child in parent: NEXT_ASSEMBLY_USAGE_OCCURRENCE + placement (null = none)
    occurrence(parent, child, target, label) {
        const w = this.w;
        this.originPl ??= w.add(`AXIS2_PLACEMENT_3D('',#${this.cp([0, 0, 0])},#${this.dir([0, 0, 1])},#${this.dir([1, 0, 0])})`);
        const nauo = w.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE(${str(label)},${str(label)},'',#${parent.pd},#${child.pd},$)`);
        const op = w.add(`ITEM_DEFINED_TRANSFORMATION('','',#${this.originPl},#${target ?? this.originPl})`);
        const rel = w.add(`(REPRESENTATION_RELATIONSHIP('','',#${child.rep},#${parent.rep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${op})SHAPE_REPRESENTATION_RELATIONSHIP())`);
        w.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rel},#${w.add(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`)})`);
        return nauo;
    }

    run() {
        const f = this.f, w = this.w;
        const file = this.name || String(f.global[3] || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'IGES';
        w.text('ISO-10303-21;\nHEADER;\n');
        w.text(`FILE_DESCRIPTION(('converted from IGES'),'2;1');\n`);
        w.text(`FILE_NAME(${str(file)},'',(''),(''),'rindr IGES converter',${str(f.system)},'');\n`);
        w.text("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n");
        this.defs = new Map();
        // independent entities (subordinate 00), geometry (use 00), not blanked: the root product
        const top = [];
        for (let k = 0; k < f.count; k++) {
            const de = 2 * k + 1, t = f.type[k];
            if (f.subordinate(de) !== 0 || f.blanked(de)) continue;
            // groups also with use "other" / "logical" (layers are written so)
            if (t === 402 && GROUP_FORMS.has(f.form[k]) && [0, 3, 4].includes(f.use(de))) top.push(de);
            else if (f.use(de) === 0 && (SOLID_TYPES.has(t) || FACE_TYPES.has(t) || SURFACE_ALONE.has(t) || t === 408)) top.push(de);
        }
        this.product(file, top);
        this.stats.steps = w.id;
        this.stats.memo = this.memo.size;
    }
}

// point of a (rational) B-spline curve at t (de Boor; for the start of a directrix)
function deBoor(p, T, C, W, t) {
    const n = C.length - 1;
    let k = p;
    while (k < n && t >= T[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) { const i = k - p + j, w = W[i] ?? 1; d.push([C[i][0] * w, C[i][1] * w, C[i][2] * w, w]); }
    for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
            const i = k - p + j, a = (t - T[i]) / ((T[i + p - r + 1] - T[i]) || 1);
            for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
        }
    }
    const q = d[p];
    return [q[0] / q[3], q[1] / q[3], q[2] / q[3]];
}

// --- analytic surfaces from NURBS control nets (Converter.analytic) ---

// circular arc of a rational quadratic segment (ends A, B on the circle, middle control point M, weights): centre,
// radius, plane normal – or null if it is not a circular arc
function arcOf(A, M, B, wa, wm, wb, tol) {
    const w = wm / Math.sqrt(wa * wb);   // = cos(half angle)
    if (!(w > 1e-6 && w < 1)) return null;
    const mid = A.map((x, i) => (x + B[i]) / 2), h = len(sub(B, A)) / 2;
    if (!(h > tol)) return null;
    // M on the perpendicular bisector of AB, at h · tan(half angle) from the chord
    if (Math.abs(len(sub(M, A)) - len(sub(M, B))) > tol) return null;
    const sinH = Math.sqrt(1 - w * w), toM = sub(M, mid);
    if (Math.abs(len(toM) - (h * sinH) / w) > tol * 10) return null;
    const r = h / sinH, u = normalize(toM.map(x => -x));
    const c = mid.map((x, i) => x + u[i] * r * w);
    const n = cross(sub(A, c), sub(M, c));
    if (!(len(n) > 0)) return null;
    return { c, r, n: normalize(n) };
}
// circle of a row of a rational quadratic net (arcs between the on-circle points 0, 2, 4, …); a row shrunk to a point
// (cone apex, pole) → { point }
function ringOf(pts, ws, tol) {
    if (pts.every(q => len(sub(q, pts[0])) <= tol)) return { point: pts[0] };
    if (pts.length < 3 || pts.length % 2 === 0) return null;
    let ring = null;
    for (let k = 0; k + 2 < pts.length; k += 2) {
        const a = arcOf(pts[k], pts[k + 1], pts[k + 2], ws[k], ws[k + 1], ws[k + 2], tol);
        if (!a) return null;
        if (!ring) ring = a;
        else if (len(sub(a.c, ring.c)) > tol * 10 || Math.abs(a.r - ring.r) > tol * 10 || Math.abs(dot(a.n, ring.n)) < 1 - 1e-6) return null;
    }
    return ring;
}
// angle covered by a row of rational quadratic arcs (2 · acos of each middle weight, normalised)
function ringAngle(pts, ws) {
    let a = 0;
    for (let k = 0; k + 2 < pts.length; k += 2) a += 2 * Math.acos(Math.min(1, ws[k + 1] / Math.sqrt(ws[k] * ws[k + 2])));
    return a;
}
// reference direction of an analytic surface: a partial one centred at angle π – its boundary far from the seam at 0 / 2π
// (a boundary on the seam left folded triangles); a closed one with the seam where the NURBS has it (its seam edge)
function seamDir(net, z, centre, start, angle) {
    const radial = q => { const d = sub(q, centre), h = dot(d, z); return normalize(d.map((x, i) => x - z[i] * h)); };
    if (angle > 2 * Math.PI - 1e-6) return radial(start);
    const [u0, u1] = [net.S[net.pu], net.S[net.S.length - 1 - net.pu]], [v0, v1] = [net.T[net.pv], net.T[net.T.length - 1 - net.pv]];
    return radial(evalNet(net, (u0 + u1) / 2, (v0 + v1) / 2)).map(x => -x);
}
const rowU = (net, j) => ({ pts: net.P.map(r => r[j]), ws: net.W.map(r => r[j]) });
const rowV = (net, i) => ({ pts: net.P[i], ws: net.W[i] });

function fitPlane(net) {
    const n = net.corner.n, o = net.corner.p;
    for (const row of net.P) for (const q of row) if (Math.abs(dot(sub(q, o), n)) > net.tol) return null;
    const x = perpendicular(n);
    return { kind: 'plane', o, z: n, x };
}
// cylinder (form 2) / cone (form 3): circles in the quadratic direction, straight in the linear one
function fitRevolved(net, form) {
    let rows;
    if (net.pu === 2 && net.pv === 1) rows = net.P[0].map((_, j) => rowU(net, j));
    else if (net.pu === 1 && net.pv === 2) rows = net.P.map((_, i) => rowV(net, i));
    else return null;
    const first = ringOf(rows[0].pts, rows[0].ws, net.tol), last = ringOf(rows[rows.length - 1].pts, rows[rows.length - 1].ws, net.tol);
    if (!first || !last || (first.point && last.point)) return null;
    const circle = first.point ? last : first, other = first.point ? first : last;
    const c0 = circle.c, c1 = other.point || other.c, r0 = circle.r, r1 = other.point ? 0 : other.r;
    const d = sub(c1, c0);
    if (len(d) <= net.tol) return null;
    // axis: the circle's normal, pointing to the other end; the other centre on it (by distance – see fitTorus)
    const z = dot(circle.n, d) >= 0 ? circle.n : circle.n.map(x => -x);
    if (len(d.map((x, i) => x - z[i] * dot(d, z))) > net.tol * 10 || (!other.point && Math.abs(dot(z, other.n)) < 1 - 1e-6)) return null;
    const height = dot(d, z);
    const axisDist = q => { const d = sub(q, c0); const a = dot(d, z); return { along: a, r: len(d.map((x, i) => x - z[i] * a)) }; };
    const outward = q => { const d = sub(q, c0); const a = dot(d, z); return normalize(d.map((x, i) => x - z[i] * a)); };
    if (form === 2 || Math.abs(r1 - r0) <= net.tol) {
        if (Math.abs(r1 - r0) > net.tol) return null;
        // every on-surface control point (even index along the circle) at the radius
        for (const row of rows) for (let k = 0; k < row.pts.length; k += 2) if (Math.abs(axisDist(row.pts[k]).r - r0) > net.tol * 10) return null;
        const x = seamDir(net, z, c0, rows[0].pts[0], ringAngle(rows[0].pts, rows[0].ws));
        return { kind: 'cylinder', o: c0, z, x, r: r0, outward };
    }
    // cone: radius linear along the axis; placed at the larger circle, the axis pointing away from the apex (radius grows)
    const slope = (r1 - r0) / height;
    for (const row of rows) for (let k = 0; k < row.pts.length; k += 2) {
        const { along, r } = axisDist(row.pts[k]);
        if (Math.abs(r - (r0 + slope * along)) > net.tol * 10) return null;
    }
    const big = r1 > r0 ? { o: c1, r: r1 } : { o: c0, r: r0 };
    const zz = r1 > r0 ? z : z.map(x => -x);
    const ringRow = first.point ? rows[rows.length - 1] : rows[0];
    const x = seamDir(net, zz, big.o, ringRow.pts[0], ringAngle(ringRow.pts, ringRow.ws));
    const apexOut = q => { const d = sub(q, big.o); const a = dot(d, zz); return normalize(d.map((v, i) => v - zz[i] * a)); };
    return { kind: 'cone', o: big.o, z: zz, x, r: big.r, angle: Math.atan(Math.abs(slope)), outward: apexOut };
}
function fitSphere(net) {
    if (net.pu !== 2 || net.pv !== 2) return null;
    // points on the surface (a patch with a pole has too few distinct on-surface control points): 5 × 5 samples
    const on = [];
    const [u0, u1] = [net.S[net.pu], net.S[net.S.length - 1 - net.pu]], [v0, v1] = [net.T[net.pv], net.T[net.T.length - 1 - net.pv]];
    for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) on.push(evalNet(net, u0 + (u1 - u0) * a / 4, v0 + (v1 - v0) * b / 4));
    // centre: least squares of |q − c|² = r² (linear in c, r² − |c|²)
    const A = [], b = [];
    for (const q of on) { A.push([2 * q[0], 2 * q[1], 2 * q[2], 1]); b.push(dot(q, q)); }
    const sol = leastSquares(A, b);
    if (!sol) return null;
    const c = sol.slice(0, 3), r = Math.sqrt(sol[3] + dot(c, c));
    if (!(r > net.tol)) return null;
    for (const q of on) if (Math.abs(len(sub(q, c)) - r) > net.tol * 10) return null;
    // poles: where the NURBS has one (a row shrunk to a point), else away from the patch; seam opposite the patch centre
    const mid = normalize(sub(on[12], c));
    let z = null;
    for (const row of [rowU(net, 0), rowU(net, net.P[0].length - 1), rowV(net, 0), rowV(net, net.P.length - 1)]) {
        if (row.pts.every(q => len(sub(q, row.pts[0])) <= net.tol)) { z = normalize(sub(row.pts[0], c)); break; }
    }
    z ??= perpendicular(mid);
    const xm = mid.map((v, i) => v - z[i] * dot(mid, z));
    const x = len(xm) > 1e-6 ? normalize(xm).map(v => -v) : perpendicular(z);
    return { kind: 'sphere', o: c, z, x, r, outward: q => normalize(sub(q, c)) };
}
// point of the (rational) net at (u, v): de Boor along v per row, then along u
function evalNet(net, u, v) {
    const rows = net.P.map((row, i) => deBoorH(net.pv, net.T, row.map((q, j) => [q[0] * net.W[i][j], q[1] * net.W[i][j], q[2] * net.W[i][j], net.W[i][j]]), v));
    const h = deBoorH(net.pu, net.S, rows, u);
    return [h[0] / h[3], h[1] / h[3], h[2] / h[3]];
}
// de Boor on homogeneous points (x w, y w, z w, w)
function deBoorH(p, T, H, t) {
    const n = H.length - 1;
    let k = p;
    while (k < n && t >= T[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) d.push(H[k - p + j].slice());
    for (let r = 1; r <= p; r++) {
        for (let j = p; j >= r; j--) {
            const i = k - p + j, a = (t - T[i]) / ((T[i + p - r + 1] - T[i]) || 1);
            for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
        }
    }
    return d[p];
}
function fitTorus(net) {
    if (net.pu !== 2 || net.pv !== 2) return null;
    // the direction whose rows are coaxial circles (centres on one line along their normal) goes around the axis
    for (const around of ['u', 'v']) {
        const rows = around === 'u' ? net.P[0].map((_, j) => rowU(net, j)) : net.P.map((_, i) => rowV(net, i));
        const tubes = around === 'u' ? net.P.map((_, i) => rowV(net, i)) : net.P[0].map((_, j) => rowU(net, j));
        const a = ringOf(rows[0].pts, rows[0].ws, net.tol), b = ringOf(rows[2]?.pts || [], rows[2]?.ws || [], net.tol);
        const tube = ringOf(tubes[0].pts, tubes[0].ws, net.tol);
        if (!a || !b || !tube || a.point || b.point || tube.point) continue;
        const z = a.n;
        if (Math.abs(dot(z, b.n)) < 1 - 1e-6) continue;
        // centres on one line along the normal – by distance (rings close together with large radii: their direction
        // is rounding noise)
        const d = sub(b.c, a.c);
        if (len(d.map((x, i) => x - z[i] * dot(d, z))) > net.tol * 10) continue;
        // torus centre: the tube centre's foot on the axis
        const t = tube.c, along = dot(sub(t, a.c), z), o = a.c.map((x, i) => x + z[i] * along);
        const R = len(sub(t, o)), r = tube.r;
        if (!(R > net.tol && r > net.tol)) continue;
        const spine = q => { const dq = sub(q, o), h = dot(dq, z), radial = normalize(dq.map((x, i) => x - z[i] * h)); return o.map((x, i) => x + radial[i] * R); };
        let ok = true;
        for (let i = 0; i < net.P.length && ok; i += 2) for (let j = 0; j < net.P[0].length && ok; j += 2) {
            if (Math.abs(len(sub(net.P[i][j], spine(net.P[i][j]))) - r) > net.tol * 10) ok = false;
        }
        if (!ok) continue;
        return { kind: 'torus', o, z, x: seamDir(net, z, o, rows[0].pts[0], ringAngle(rows[0].pts, rows[0].ws)), R, r, outward: q => normalize(sub(q, spine(q))) };
    }
    return null;
}
// least squares A x = b (normal equations, small systems)
function leastSquares(A, b) {
    const n = A[0].length, N = Array.from({ length: n }, () => new Array(n + 1).fill(0));
    for (let r = 0; r < A.length; r++) for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) N[i][j] += A[r][i] * A[r][j]; N[i][n] += A[r][i] * b[r]; }
    for (let i = 0; i < n; i++) {
        let piv = i;
        for (let k = i + 1; k < n; k++) if (Math.abs(N[k][i]) > Math.abs(N[piv][i])) piv = k;
        if (Math.abs(N[piv][i]) < 1e-14) return null;
        [N[i], N[piv]] = [N[piv], N[i]];
        for (let k = 0; k < n; k++) if (k !== i) { const f = N[k][i] / N[i][i]; for (let j = i; j <= n; j++) N[k][j] -= f * N[i][j]; }
    }
    return N.map((row, i) => row[n] / row[i]);
}
// --- NURBS curves made compatible (ruled surfaces) ---
function reverseNurbs(c) {
    c.Pw.reverse();
    c.U = c.U.map(x => 1 - x).reverse();
}
// insert knot t once (Boehm, homogeneous points)
function insertKnot(c, t) {
    const { p, U, Pw } = c, n = Pw.length - 1;
    let k = p;
    while (k < n && t >= U[k + 1]) k++;
    const Q = [];
    for (let i = 0; i <= n + 1; i++) {
        if (i <= k - p) Q.push(Pw[i]);
        else if (i > k) Q.push(Pw[i - 1]);
        else {
            const a = (t - U[i]) / ((U[i + p] - U[i]) || 1);
            Q.push(Pw[i].map((v, j) => a * v + (1 - a) * Pw[i - 1][j]));
        }
    }
    c.U = [...U.slice(0, k + 1), t, ...U.slice(k + 1)];
    c.Pw = Q;
}
const multiplicity = (U, t) => U.filter(x => Math.abs(x - t) <= 1e-12).length;
// degree p → q: split into Bézier pieces (interior knots to multiplicity p), raise each, knots then of multiplicity q
function elevate(c, q) {
    if (c.p >= q) return c;
    const inner = [...new Set(c.U.filter(x => x > 1e-12 && x < 1 - 1e-12))];
    for (const t of inner) while (multiplicity(c.U, t) < c.p) insertKnot(c, t);
    const pieces = (c.Pw.length - 1) / c.p, Pw = [];
    for (let s = 0; s < pieces; s++) {
        let B = c.Pw.slice(s * c.p, s * c.p + c.p + 1);
        for (let d = c.p; d < q; d++) {
            const E = [B[0]];
            for (let i = 1; i <= d; i++) E.push(B[i].map((v, j) => (i / (d + 1)) * B[i - 1][j] + (1 - i / (d + 1)) * v));
            E.push(B[d]);
            B = E;
        }
        Pw.push(...(s ? B.slice(1) : B));
    }
    const U = new Array(q + 1).fill(0);
    for (const t of inner.sort((x, y) => x - y)) for (let k = 0; k < q; k++) U.push(t);
    U.push(...new Array(q + 1).fill(1));
    return { p: q, U, Pw };
}
// same degree, same knots (each knot with the larger multiplicity of the two)
function compatible(a, b) {
    const q = Math.max(a.p, b.p);
    a = elevate({ ...a, Pw: a.Pw.map(x => x.slice()) }, q);
    b = elevate({ ...b, Pw: b.Pw.map(x => x.slice()) }, q);
    for (const [x, y] of [[a, b], [b, a]]) {
        for (const t of [...new Set(y.U)]) {
            if (t <= 1e-12 || t >= 1 - 1e-12) continue;
            while (multiplicity(x.U, t) < multiplicity(y.U, t)) insertKnot(x, t);
        }
    }
    return [a, b];
}

export const fitsForTest = { fitPlane, fitRevolved, fitSphere, fitTorus, ringOf, arcOf, compatible, elevate, insertKnot, deBoorH };   // (Node tests)

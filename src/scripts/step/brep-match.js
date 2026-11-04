// Duplicate solids on the B-rep level (STEP import, before tessellating).
//
// Many STEP files store the same part several times as solids of their own (one per colour, flattened exports).
// The instancing after tessellating (instancer.js) found them only once both were tessellated and had a BVH – the
// copies were tessellated for nothing (a large model of construction bricks: 46 % of all faces). Here the copies are
// found from the exact data of the file: candidates have the same signature (analyzeSolids in structure.js: face count,
// per face orientation, surface type, radii, bounds and edges – the same in any position and rotation), then
// matchBrep proves the match:
//   1. points: all vertices plus the centres of circles and ellipses. The rotation comes from two anchor points (the
//      point farthest from the centroid, then the one farthest from that axis) and their candidates in the other
//      solid (same distances); every point of A must land on a point of B (within tol). Frames are built right-handed,
//      so only proper rotations – a mirrored part cannot match (unless it is symmetric, then it is the same shape).
//   2. faces: every face of A needs a face of B with the same description (orientation, type, radii, bounds with
//      their edge kinds, spline degrees/knots/weights) and the mapped anchor (mean of its points) – the face map.
//   3. surfaces: analytic ones with mapped origin and axis, splines with (up to 64) mapped control points, all other
//      kinds with mapped points of the surface at fixed parameters.
// Anything unreadable or unusual counts as "no match" – a missed copy is only tessellated, a wrong one would show.

import { Ref } from './parser.js';

const ANALYTIC = new Set(['PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE', 'SPHERICAL_SURFACE', 'TOROIDAL_SURFACE', 'DEGENERATE_TOROIDAL_SURFACE']);
const SPLINES = new Set(['B_SPLINE_SURFACE_WITH_KNOTS', 'BEZIER_SURFACE', 'UNIFORM_SURFACE', 'QUASI_UNIFORM_SURFACE', 'COMPLEX']);
const MAX_CONTROL = 16;      // control points compared per spline surface (plus degrees, knots, weights, all corners)
const MAX_TRIES = 1024;      // candidate rotations per pair (symmetric parts have several)
const MAX_ROOTS = 8;         // different shapes tried per signature group
// fixed parameters (fractions of the domain) for surfaces that are neither analytic nor splines
const PROBES = [[0.31, 0.27], [0.69, 0.52], [0.45, 0.83]];

const round = x => (typeof x === 'number' && isFinite(x) ? Number(x.toPrecision(9)) : x);
const plain = v => JSON.stringify(v, (k, x) => (x instanceof Ref ? '#' : typeof x === 'number' ? round(x) : x));

/**
 * B-rep data of a solid for matchBrep: points (flat xyz), per face { desc, anchor, pts, dirs }.
 * null if the solid has faces that are not read here (curve bounded surfaces, broken references …).
 */
export function brepData(step, geo, faces) {
    const points = [];
    const pointIndex = new Map();   // 'v' + vertex id / 'c' + curve id / 'p' + point id → index
    const addPoint = (key, p) => {
        let i = pointIndex.get(key);
        if (i === undefined) {
            if (!p.every(isFinite)) throw new Error('point');
            i = points.length / 3;
            pointIndex.set(key, i);
            points.push(p[0], p[1], p[2]);
        }
        return i;
    };
    const out = [];
    try {
        for (const fid of faces) {
            const f = step.get(Math.abs(fid));
            if (!f || !f.args || (f.type !== 'ADVANCED_FACE' && f.type !== 'FACE_SURFACE')) return null;
            const own = new Set(), loops = [];
            for (const bRef of f.args[1] || []) {
                const b = step.get(bRef), loop = b && step.get(b.args[1]);
                if (!loop) return null;
                const parts = [b.type, b.args[2]];
                if (loop.type === 'VERTEX_LOOP') {
                    own.add(addPoint('v' + loop.args[1].id, geo.point(loop.args[1])));
                    parts.push('V');
                } else if (loop.type === 'POLY_LOOP') {
                    for (const r of loop.args[1]) own.add(addPoint('p' + r.id, geo.point(r)));
                    parts.push('P' + loop.args[1].length);
                } else if (loop.type === 'EDGE_LOOP') {
                    const kinds = [];
                    for (const oeRef of loop.args[1]) {
                        const oe = step.get(oeRef), ec = oe && step.get(oe.args[3]);
                        if (!ec || ec.type !== 'EDGE_CURVE') return null;
                        own.add(addPoint('v' + ec.args[1].id, geo.point(ec.args[1])));
                        own.add(addPoint('v' + ec.args[2].id, geo.point(ec.args[2])));
                        const c = step.get(ec.args[3]), ct = c ? c.type : '?';
                        let kind = `${ct}:${oe.args[4]}:${ec.args[4]}`;
                        if (ct === 'CIRCLE' || ct === 'ELLIPSE') {
                            own.add(addPoint('c' + c.id, geo.placement(c.args[1]).o));
                            kind += ':' + c.args.slice(2).map(round).join(':');
                        }
                        kinds.push(kind);
                    }
                    parts.push(kinds.sort().join(','));
                } else return null;
                loops.push(parts.join('|'));
            }
            const sref = f.args[2], st = step.typeOf(sref);
            const desc = [fid < 0 ? '-' : '+', f.type, f.args[3], st, loops.sort().join('/')];
            let pts = [], dirs = [], on = null;
            if (ANALYTIC.has(st)) {
                // what fixes the surface: the plane / the axis (the origin may lie anywhere on it – exporters write
                // different ones for copies), the apex of a cone, the centre of a sphere or torus; and the axis direction
                const a = step.get(sref).args, pl = geo.placement(a[1]);
                desc.push(a.slice(2).map(round).join(':'));
                dirs = [pl.z];
                if (st === 'PLANE') on = { plane: true, o: pl.o, z: pl.z };
                else if (st === 'CYLINDRICAL_SURFACE') on = { line: true, o: pl.o, z: pl.z };
                else if (st === 'CONICAL_SURFACE') {
                    const tan = Math.tan(a[3] * geo.angleUnit);
                    if (Math.abs(tan) < 1e-12) on = { line: true, o: pl.o, z: pl.z };
                    else pts = [[0, 1, 2].map(c => pl.o[c] - pl.z[c] * a[2] / tan)];
                } else pts = [pl.o];
            } else if (SPLINES.has(st)) {
                const e = step.get(sref);
                let base = null, extra = null;
                if (e.type === 'COMPLEX') {
                    base = e.parts.B_SPLINE_SURFACE;
                    extra = [e.parts.B_SPLINE_SURFACE_WITH_KNOTS || null, e.parts.RATIONAL_B_SPLINE_SURFACE || null, Object.keys(e.parts).sort()];
                } else base = e.args.slice(1);
                if (!base || !Array.isArray(base[2]) || !Array.isArray(base[2][0])) return null;
                const grid = base[2], nu = grid.length, nv = grid[0].length;
                desc.push(e.type, nu, nv, plain(base.slice(0, 2)), plain(base.slice(3)), plain(extra));
                const total = nu * nv, stride = Math.max(1, Math.ceil(total / MAX_CONTROL));
                for (let k = 0; k < total; k += stride) pts.push(geo.point(grid[Math.floor(k / nv)][k % nv]));
                for (const [i, j] of [[0, nv - 1], [nu - 1, 0], [nu - 1, nv - 1], [nu >> 1, nv >> 1]]) pts.push(geo.point(grid[i][j]));
            } else {
                const s = geo.surface(sref), dom = s.domain?.();
                const at = (i, x) => (dom && isFinite(dom[i]) && isFinite(dom[i + 1]) ? dom[i] + (dom[i + 1] - dom[i]) * x : x);
                pts = PROBES.map(([u, v]) => s.eval(at(0, u), at(2, v)));
            }
            if (!pts.every(p => p.every(isFinite))) return null;
            let anchor;
            if (own.size) {
                anchor = [0, 0, 0];
                for (const i of own) for (let c = 0; c < 3; c++) anchor[c] += points[i * 3 + c] / own.size;
            } else anchor = pts[0];
            out.push({ desc: desc.join('#'), anchor, pts, dirs, on });
        }
    } catch {
        return null;
    }
    return { points: Float64Array.from(points), faces: out };
}

/**
 * Proves that solid B is solid A in another position: { R (row-major 3 × 3), cA, cB, faceMap (face of A → face of B) }
 * with B = R · (A − cA) + cB, or null. tol: distance in file units under which points count as the same.
 */
export function matchBrep(A, B, tol, diag = null) {
    const n = A.points.length / 3;
    const fail = reason => { if (diag) diag.reason = reason; return null; };
    if (n < 3 || B.points.length !== A.points.length || A.faces.length !== B.faces.length) return fail('count');
    const cA = centroid(A.points), cB = centroid(B.points);
    const P = A.points, Q = B.points;
    const dist = (X, i, c) => Math.hypot(X[i * 3] - c[0], X[i * 3 + 1] - c[1], X[i * 3 + 2] - c[2]);
    // anchors of A: farthest from the centroid, then farthest from that axis
    let a1 = 0, r1 = -1;
    for (let i = 0; i < n; i++) { const d = dist(P, i, cA); if (d > r1) { r1 = d; a1 = i; } }
    const u1 = sub(P, a1, cA);
    normalize(u1);
    let a2 = -1, off = -1;
    for (let i = 0; i < n; i++) {
        const v = sub(P, i, cA), along = dot(v, u1);
        const d = Math.hypot(v[0] - u1[0] * along, v[1] - u1[1] * along, v[2] - u1[2] * along);
        if (d > off) { off = d; a2 = i; }
    }
    if (!(r1 > 100 * tol) || !(off > 100 * tol)) return fail('collinear');   // (nearly) collinear points: rotation not decidable
    const r2 = dist(P, a2, cA), d12 = Math.hypot(P[a1 * 3] - P[a2 * 3], P[a1 * 3 + 1] - P[a2 * 3 + 1], P[a1 * 3 + 2] - P[a2 * 3 + 2]);
    const FA = frame(sub(P, a1, cA), sub(P, a2, cA));

    // points of B: sorted by distance to the centroid (candidates of the anchors) and in a grid (lookup)
    const radius = new Float64Array(n);
    for (let i = 0; i < n; i++) radius[i] = dist(Q, i, cB);
    const byRadius = Array.from({ length: n }, (_, i) => i).sort((a, b) => radius[a] - radius[b]);
    const near = r => {
        let lo = 0, hi = n;
        while (lo < hi) { const m = (lo + hi) >> 1; if (radius[byRadius[m]] < r - 2 * tol) lo = m + 1; else hi = m; }
        const list = [];
        for (let k = lo; k < n && radius[byRadius[k]] <= r + 2 * tol; k++) list.push(byRadius[k]);
        return list;
    };
    const grid = new PointGrid(Q, 4 * tol);
    // points of A in a scattered order: a wrong rotation fails after a few
    const order = new Int32Array(n);
    for (let i = 0, k = 0, step = scatterStep(n); i < n; i++, k = (k + step) % n) order[i] = k;
    const R = new Float64Array(9), q = [0, 0, 0];
    const map = (p, out) => {
        const x = p[0] - cA[0], y = p[1] - cA[1], z = p[2] - cA[2];
        out[0] = R[0] * x + R[1] * y + R[2] * z + cB[0];
        out[1] = R[3] * x + R[4] * y + R[5] * z + cB[1];
        out[2] = R[6] * x + R[7] * y + R[8] * z + cB[2];
        return out;
    };
    const pointsMatch = () => {
        const p = [0, 0, 0];
        for (let k = 0; k < n; k++) {
            const i = order[k];
            p[0] = P[i * 3]; p[1] = P[i * 3 + 1]; p[2] = P[i * 3 + 2];
            if (grid.find(map(p, q), 2 * tol) < 0) return false;
        }
        return true;
    };
    let tries = 0, pointsOk = false;
    for (const b1 of near(r1)) {
        for (const b2 of near(r2)) {
            if (b2 === b1) continue;
            const d = Math.hypot(Q[b1 * 3] - Q[b2 * 3], Q[b1 * 3 + 1] - Q[b2 * 3 + 1], Q[b1 * 3 + 2] - Q[b2 * 3 + 2]);
            if (Math.abs(d - d12) > 4 * tol) continue;
            if (++tries > MAX_TRIES) return fail('tries');
            const FB = frame(sub(Q, b1, cB), sub(Q, b2, cB));
            if (!FB) continue;
            // R = FB · FAᵀ (columns of F: the frame's axes)
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) R[r * 3 + c] = FB[r] * FA[c] + FB[3 + r] * FA[3 + c] + FB[6 + r] * FA[6 + c];
            if (!pointsMatch()) continue;
            const faceMap = matchFaces(A, B, map, R, tol, diag);
            if (faceMap) return { R: Float64Array.from(R), cA, cB, faceMap };
            pointsOk = true;
        }
    }
    return fail(pointsOk ? `faces: ${diag?.face || ''}` : tries ? 'points' : 'anchors');
}

// faces of A → faces of B under the rotation (description, anchor, surface data)
function matchFaces(A, B, map, R, tol, diag) {
    const byDesc = new Map();
    B.faces.forEach((f, i) => { if (!byDesc.has(f.desc)) byDesc.set(f.desc, []); byDesc.get(f.desc).push(i); });
    const used = new Uint8Array(B.faces.length), faceMap = new Int32Array(A.faces.length);
    const q = [0, 0, 0], ptol = 8 * tol;
    const close = (p, b) => Math.hypot(p[0] - b[0], p[1] - b[1], p[2] - b[2]) <= ptol;
    for (let fi = 0; fi < A.faces.length; fi++) {
        const fa = A.faces[fi];
        map(fa.anchor, q);
        let hit = -1, stage = 'anchor';
        for (const gi of byDesc.get(fa.desc) || []) {
            if (used[gi] || !close(q, B.faces[gi].anchor)) continue;
            const fb = B.faces[gi];
            stage = 'surface points';
            if (fa.pts.length !== fb.pts.length || fa.dirs.length !== fb.dirs.length || !fa.on !== !fb.on) continue;
            if (!fa.pts.every((p, k) => close(map(p, q), fb.pts[k]))) continue;
            if (fa.on) {
                // origin of A on the plane / axis of B
                map(fa.on.o, q);
                const { o, z } = fb.on, d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]], along = dot(d, z);
                const off = fa.on.plane ? Math.abs(along) : Math.hypot(d[0] - z[0] * along, d[1] - z[1] * along, d[2] - z[2] * along);
                if (off > ptol) continue;
            }
            stage = 'surface axis';
            if (!fa.dirs.every((d, k) => {
                const x = R[0] * d[0] + R[1] * d[1] + R[2] * d[2], y = R[3] * d[0] + R[4] * d[1] + R[5] * d[2], z = R[6] * d[0] + R[7] * d[1] + R[8] * d[2];
                const e = fb.dirs[k], same = Math.hypot(x - e[0], y - e[1], z - e[2]) < 1e-6;
                // a cylinder is the same surface (normals outward) with its axis the other way round
                return same || (fa.on?.line && fa.pts.length === 0 && Math.hypot(x + e[0], y + e[1], z + e[2]) < 1e-6);
            })) continue;
            hit = gi;
            break;
        }
        if (hit < 0) {
            if (diag) diag.face = !byDesc.has(fa.desc) ? 'description' : `${stage} ${fa.desc.split('#')[3]}`;
            return null;
        }
        used[hit] = 1;
        faceMap[fi] = hit;
    }
    return faceMap;
}

/**
 * Duplicates within groups of solids with the same signature: the first readable solid is the root, every other one
 * that matches it becomes its copy; the rest are tried against the next root (another shape with the same signature).
 * members: [{ index, faces, size }]. Returns [{ index, root, R, cA, cB, faceMap }] (only the copies).
 * tolRel: point tolerance relative to the solid size (file units).
 */
export function matchSolids(step, geo, members, tolRel) {
    const out = [];
    const data = new Map();
    const get = m => {
        if (!data.has(m.index)) data.set(m.index, brepData(step, geo, m.faces));
        return data.get(m.index);
    };
    let pending = members;
    for (let round = 0; pending.length > 1 && round < MAX_ROOTS; round++) {
        const root = pending[0], A = get(root);
        const rest = [];
        if (A) {
            for (const m of pending.slice(1)) {
                const B = get(m);
                if (!B) continue;   // unreadable: never a copy
                const res = matchBrep(A, B, tolRel * Math.max(root.size, m.size));
                if (res) { out.push({ index: m.index, root: root.index, ...res }); data.delete(m.index); }
                else rest.push(m);
            }
        } else rest.push(...pending.slice(1));
        data.delete(root.index);
        pending = rest;
    }
    return out;
}

/** Column-major 4 × 4 matrix (three.js order) of x_B = R · (x_A − cA) + cB, positions scaled by unit (file unit → mm) */
export function alignmentMatrix({ R, cA, cB }, unit = 1) {
    const t = [0, 1, 2].map(r => (cB[r] - (R[r * 3] * cA[0] + R[r * 3 + 1] * cA[1] + R[r * 3 + 2] * cA[2])) * unit);
    return [R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1];
}

// --- helpers ---
function centroid(X) {
    const c = [0, 0, 0], n = X.length / 3;
    for (let i = 0; i < X.length; i += 3) { c[0] += X[i]; c[1] += X[i + 1]; c[2] += X[i + 2]; }
    return [c[0] / n, c[1] / n, c[2] / n];
}
const sub = (X, i, c) => [X[i * 3] - c[0], X[i * 3 + 1] - c[1], X[i * 3 + 2] - c[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; }
// right-handed orthonormal frame from two directions, as columns (x, y, z) in a flat array; null if parallel
function frame(a, b) {
    const x = normalize(a.slice()), along = dot(b, x);
    const y = [b[0] - x[0] * along, b[1] - x[1] * along, b[2] - x[2] * along];
    if (Math.hypot(y[0], y[1], y[2]) < 1e-12 * (1 + Math.hypot(b[0], b[1], b[2]))) return null;
    normalize(y);
    const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    return [...x, ...y, ...z];
}
// a step coprime to n, roughly n × golden ratio – visits all points in a scattered order
function scatterStep(n) {
    let s = Math.max(1, Math.round(n * 0.618034));
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    while (gcd(s, n) !== 1) s++;
    return s % n || 1;
}

// points in a uniform grid (cell ≥ 2 × search radius): find(p, r) = index of a point within r, or −1
class PointGrid {
    constructor(X, cell) {
        this.X = X;
        this.cell = cell;
        this.map = new Map();
        for (let i = 0; i < X.length / 3; i++) {
            const k = this.key(Math.floor(X[i * 3] / cell), Math.floor(X[i * 3 + 1] / cell), Math.floor(X[i * 3 + 2] / cell));
            const list = this.map.get(k);
            if (list) list.push(i); else this.map.set(k, [i]);
        }
    }
    key(x, y, z) { return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0; }
    find(p, r) {
        const { X, cell } = this;
        const x0 = Math.floor((p[0] - r) / cell), x1 = Math.floor((p[0] + r) / cell);
        const y0 = Math.floor((p[1] - r) / cell), y1 = Math.floor((p[1] + r) / cell);
        const z0 = Math.floor((p[2] - r) / cell), z1 = Math.floor((p[2] + r) / cell);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
            for (const i of this.map.get(this.key(x, y, z)) || []) {
                if (Math.hypot(X[i * 3] - p[0], X[i * 3 + 1] - p[1], X[i * 3 + 2] - p[2]) <= r) return i;
            }
        }
        return -1;
    }
}

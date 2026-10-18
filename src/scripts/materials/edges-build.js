// Rounded edges (shading only, edges.js): the per-geometry data the shader needs – pure function, main thread and
// worker (edges-worker.js), no three.js.
//
// 1. Sharp edges = mesh edges where the shading normal jumps (the two triangles' normals at a shared position differ
//    by more than SHARP_ANGLE) – B-rep edges of CAD models, creases of meshes; smooth facets (a tessellated cylinder)
//    are not sharp. Positions are welded first (CAD faces have their own vertices).
// 2. Per sharp edge: both end points, the normals of both sides at both ends (curved neighbours), convex or concave,
//    and a cut plane at each end. Consecutive segments of one curved edge (a hole, a cylinder rim) share a bisector
//    plane at their joint – every point belongs to exactly one segment, no double tilt on the inside of the polyline
//    and no gap on the outside. Free ends (a corner where other edges meet) are cut square.
// 3. Per triangle: the sharp edges whose band can reach it (flood fill from the edge's two triangles over smooth
//    neighbours, exact segment–triangle distance) – works on coarse CAD meshes where a box face is two triangles.
// 4. The fragment shader / path tracer only knows its triangle through the provoking (first) vertex: each triangle's
//    list goes to its first vertex, lists of triangles sharing one first vertex are merged. On the first build the
//    triangles' corners are rotated (winding kept) so that the lists spread over many vertices – otherwise the
//    centre of a triangle fan collected every edge of the face.
//
// Block layout (vec4 units, relative to the block start, see EDGE_WGSL in edges.js):
//   [vertex table: (list start, count) per vertex, 2 floats each] [list entries: record index] [records: 6 vec4]
//   record: (p0, c0.x) (p1, c0.y) (c0.z, c1) (na0, nb1.x) (na1, nb1.y) (nb0, nb1.z); c0/c1 = cut plane normals
//   pointing into the segment, length 2 = concave edge (the shader only tests their sign). The first three vec4
//   decide whether the point is in reach – the normals are only read then.

export const EDGE_SHAPE = {
    sharpAngle: 10,     // normal jump (degrees) from which an edge counts as sharp
    jointAngle: 60,     // consecutive segments turning less than this share a bisector cut (one curved edge)
    tanMax: 2,          // band width = radius × tan(half turning angle), at most radius × tanMax (acute wedges)
    slack: 1.2,         // lists reach a bit further – a bisector domain can extend past the segment's end
    maxScalars: 1 << 24,   // block size limit (list offsets are stored as floats)
    perTriangle: 24,       // nearest segments kept per triangle
    perEdge: 4096,         // triangles one segment may reach (fine meshes with a large radius)
    budget: [4e6, 30],     // distance tests per geometry (minimum, per triangle) – beyond that the remaining (shortest)
                           // edges are skipped: meshes full of tiny junk edges stay bounded
};
export const RECORD_VEC4 = 6;

/**
 * @param {{ positions: Float32Array, normals: Float32Array|null, index: Uint32Array|Uint16Array|null,
 *           radius: number, rotate: boolean }} input  positions/normals xyz per vertex; radius in geometry units
 *   (the lists cover bands up to this radius); rotate = may rotate triangle corners (first build)
 * @returns {{ data: Float32Array|null, index: Uint32Array|Uint16Array|null, stats: object }}  data = block (null:
 *   no sharp edges or too big), index = rotated index (null: unchanged)
 */
export function buildEdgeData({ positions, normals, index, radius, rotate }) {
    const t0 = Date.now();
    const nv = positions.length / 3;
    const nt = index ? index.length / 3 : nv / 3;
    const corner = index ? (t, k) => index[t * 3 + k] : (t, k) => t * 3 + k;
    const sharpDot = Math.cos(EDGE_SHAPE.sharpAngle * Math.PI / 180);
    const jointDot = Math.cos(EDGE_SHAPE.jointAngle * Math.PI / 180);

    // face normals (fallback without vertex normals, convexity)
    const fn = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
        const a = corner(t, 0) * 3, b = corner(t, 1) * 3, c = corner(t, 2) * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
        const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx;
        const l = Math.hypot(x, y, z) || 1;
        fn[t * 3] = x / l; fn[t * 3 + 1] = y / l; fn[t * 3 + 2] = z / l;
    }
    // shading normal of triangle t at its corner k
    const cn = new Float32Array(3);
    const cornerNormal = (t, k, out) => {
        if (normals) {
            const v = corner(t, k) * 3;
            const x = normals[v], y = normals[v + 1], z = normals[v + 2], l = Math.hypot(x, y, z) || 1;
            out[0] = x / l; out[1] = y / l; out[2] = z / l;
        } else {
            out[0] = fn[t * 3]; out[1] = fn[t * 3 + 1]; out[2] = fn[t * 3 + 2];
        }
        return out;
    };

    // weld positions (grid relative to the model size, like crease-normals.js)
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < positions.length; i++) { const v = positions[i]; if (v < min) min = v; if (v > max) max = v; }
    const inv = 1 / Math.max((max - min) * 1e-7, 1e-12);
    const weld = new Int32Array(nv), q = new Int32Array(nv * 3);
    let size = 1;
    while (size < nv * 2) size <<= 1;
    const table = new Int32Array(size);
    let nw = 0;
    for (let v = 0; v < nv; v++) {
        const x = Math.round((positions[v * 3] - min) * inv), y = Math.round((positions[v * 3 + 1] - min) * inv), z = Math.round((positions[v * 3 + 2] - min) * inv);
        let slot = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
        for (;;) {
            const e = table[slot];
            if (e === 0) { q[nw * 3] = x; q[nw * 3 + 1] = y; q[nw * 3 + 2] = z; table[slot] = ++nw; weld[v] = nw - 1; break; }
            if (q[(e - 1) * 3] === x && q[(e - 1) * 3 + 1] === y && q[(e - 1) * 3 + 2] === z) { weld[v] = e - 1; break; }
            slot = (slot + 1) & (size - 1);
        }
    }

    // mesh edges between welded positions: half-edge h = t * 3 + k (corner k → k + 1); partner[h] = other half-edge,
    // -1 = open, -2 = more than two triangles
    const partner = new Int32Array(nt * 3).fill(-1);
    const edgeMap = new Map();
    for (let t = 0; t < nt; t++) {
        for (let k = 0; k < 3; k++) {
            const a = weld[corner(t, k)], b = weld[corner(t, (k + 1) % 3)];
            if (a === b) { partner[t * 3 + k] = -2; continue; }
            const key = a < b ? a * nw + b : b * nw + a;
            const h = t * 3 + k, other = edgeMap.get(key);
            if (other === undefined) edgeMap.set(key, h);
            else if (other >= 0 && partner[other] === -1) { partner[other] = h; partner[h] = other; }
            else { if (other >= 0) { const o = partner[other]; if (o >= 0) partner[o] = -2; partner[other] = -2; } partner[h] = -2; edgeMap.set(key, -1); }
        }
    }

    // sharp edges (one per pair of half-edges, stored from the lower half-edge)
    const sharpOf = new Int32Array(nt * 3).fill(-1);   // half-edge → sharp edge id
    const E = [];   // { h, g, w0, w1, p0, p1, na0, na1, nb0, nb1, convex }
    const nA0 = new Float32Array(3), nA1 = new Float32Array(3), nB0 = new Float32Array(3), nB1 = new Float32Array(3);
    for (let h = 0; h < nt * 3; h++) {
        const g = partner[h];
        if (g < h) continue;   // open, non-manifold or already seen
        const tA = (h / 3) | 0, kA = h % 3, tB = (g / 3) | 0, kB = g % 3;
        // A runs w0 → w1, B runs w1 → w0
        cornerNormal(tA, kA, nA0); cornerNormal(tA, (kA + 1) % 3, nA1);
        cornerNormal(tB, (kB + 1) % 3, nB0); cornerNormal(tB, kB, nB1);
        const d0 = nA0[0] * nB0[0] + nA0[1] * nB0[1] + nA0[2] * nB0[2];
        const d1 = nA1[0] * nB1[0] + nA1[1] * nB1[1] + nA1[2] * nB1[2];
        if (d0 > sharpDot && d1 > sharpDot) continue;
        const v0 = corner(tA, kA) * 3, v1 = corner(tA, (kA + 1) % 3) * 3;
        const p0 = [positions[v0], positions[v0 + 1], positions[v0 + 2]], p1 = [positions[v1], positions[v1 + 1], positions[v1 + 2]];
        // convex: the other triangle lies below this side's surface
        const c = corner(tB, (kB + 2) % 3) * 3;
        const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2, mz = (p0[2] + p1[2]) / 2;
        const below = (positions[c] - mx) * (nA0[0] + nA1[0]) + (positions[c + 1] - my) * (nA0[1] + nA1[1]) + (positions[c + 2] - mz) * (nA0[2] + nA1[2]);
        const id = E.length;
        E.push({ h, g, w0: weld[corner(tA, kA)], w1: weld[corner(tA, (kA + 1) % 3)], p0, p1,
            na0: [...nA0], na1: [...nA1], nb0: [...nB0], nb1: [...nB1], convex: below < 0,
            minDot: Math.min(d0, d1), c0: null, c1: null });
        sharpOf[h] = id; sharpOf[g] = id;
    }
    const stats = { triangles: nt, vertices: nv, welded: nw, sharpEdges: E.length };
    if (!E.length) return { data: null, index: null, stats: { ...stats, ms: Date.now() - t0 } };

    // joints: a welded position with exactly two sharp edges that continue each other (same pair of side normals,
    // small turn) → bisector cut; everything else square
    const incident = new Map();
    E.forEach((e, i) => {
        for (const w of [e.w0, e.w1]) { const l = incident.get(w); if (l) l.push(i); else incident.set(w, [i]); }
    });
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const sideAt = (e, w) => (w === e.w0 ? [e.na0, e.nb0] : [e.na1, e.nb1]);
    const away = (e, w) => norm(w === e.w0 ? sub(e.p1, e.p0) : sub(e.p0, e.p1));   // direction from w along the edge
    for (const [w, list] of incident) {
        if (list.length !== 2) continue;
        const [e1, e2] = list.map(i => E[i]);
        if (e1 === e2) continue;
        const [a1, b1] = sideAt(e1, w), [a2, b2] = sideAt(e2, w);
        const same = (dot(a1, a2) > 0.98 && dot(b1, b2) > 0.98) || (dot(a1, b2) > 0.98 && dot(b1, a2) > 0.98);
        const d1 = away(e1, w), d2 = away(e2, w);
        if (!same || -dot(d1, d2) < jointDot || e1.convex !== e2.convex) continue;
        // continuing direction through the joint: −d1 → d2; the bisector normal = −d1 + d2 (points along the chain)
        const bis = norm([d2[0] - d1[0], d2[1] - d1[1], d2[2] - d1[2]]);
        // cut normal points into each segment: into e2 = bis, into e1 = −bis
        const setCut = (e, n) => { if (w === e.w0) e.c0 = n; else e.c1 = n; };
        setCut(e1, [-bis[0], -bis[1], -bis[2]]);
        setCut(e2, bis);
    }
    for (const e of E) {
        const u = norm(sub(e.p1, e.p0));
        if (!e.c0) e.c0 = u;
        if (!e.c1) e.c1 = [-u[0], -u[1], -u[2]];
    }

    // triangle neighbours over smooth manifold edges (the flood fill stays on the edge's own surfaces)
    const near = (t, k) => { const g = partner[t * 3 + k]; return g >= 0 && sharpOf[t * 3 + k] < 0 ? (g / 3) | 0 : -1; };

    // per sharp edge: the triangles its band can reach (with their distance – the nearest ones are kept)
    let pairsT = new Int32Array(1024), pairsE = new Int32Array(1024), pairsD = new Float32Array(1024), np = 0;
    const push = (t, e, d) => {
        if (np === pairsT.length) {
            const grow = (a, T) => { const b = new T(a.length * 2); b.set(a); return b; };
            pairsT = grow(pairsT, Int32Array); pairsE = grow(pairsE, Int32Array); pairsD = grow(pairsD, Float32Array);
        }
        pairsT[np] = t; pairsE[np] = e; pairsD[np++] = d;
    };
    const stamp = new Int32Array(nt).fill(-1);
    const stack = [];
    let tests = 0, skipped = 0;
    const budget = Math.max(EDGE_SHAPE.budget[0], EDGE_SHAPE.budget[1] * nt);
    const byLength = E.map((e, id) => id).sort((a, b) => dist2(E[b].p0, E[b].p1) - dist2(E[a].p0, E[a].p1));
    byLength.forEach(id => {
        const e = E[id];
        if (tests > budget) { skipped++; return; }
        const half = 0.5 * Math.acos(Math.max(-1, Math.min(1, e.minDot)));
        const reach = radius * Math.min(Math.tan(half), EDGE_SHAPE.tanMax) * EDGE_SHAPE.slack;
        const sA = (e.h / 3) | 0, sB = (e.g / 3) | 0;
        for (const s of [sA, sB]) if (stamp[s] !== id) { stamp[s] = id; stack.push(s); }
        let count = 0;
        while (stack.length) {
            const t = stack.pop();
            let d = 0;
            if (t !== sA && t !== sB) {
                tests++;
                d = segmentTriangleDistance(e.p0, e.p1, positions, corner(t, 0) * 3, corner(t, 1) * 3, corner(t, 2) * 3, reach);
                if (d > reach) continue;
            }
            push(t, id, d);
            if (++count >= EDGE_SHAPE.perEdge) { stack.length = 0; break; }
            for (let k = 0; k < 3; k++) {
                const n = near(t, k);
                if (n >= 0 && stamp[n] !== id) { stamp[n] = id; stack.push(n); }
            }
        }
    });
    stats.tests = tests;
    if (skipped) stats.skippedEdges = skipped;

    // per triangle lists (CSR), the nearest perTriangle segments
    const tStart = new Int32Array(nt + 1);
    for (let i = 0; i < np; i++) tStart[pairsT[i] + 1]++;
    for (let t = 0; t < nt; t++) tStart[t + 1] += tStart[t];
    const tCur = tStart.slice(0, nt), order = new Int32Array(np);
    for (let i = 0; i < np; i++) order[tCur[pairsT[i]]++] = i;
    const tList = new Int32Array(np);
    const kept = new Int32Array(nt + 1);
    let w = 0;
    for (let t = 0; t < nt; t++) {
        let a = tStart[t], b = tStart[t + 1];
        if (b - a > EDGE_SHAPE.perTriangle) {
            const sorted = Array.from(order.subarray(a, b)).sort((x, y) => pairsD[x] - pairsD[y]);
            order.set(sorted, a);
            b = a + EDGE_SHAPE.perTriangle;
        }
        for (let i = a; i < b; i++) tList[w++] = pairsE[order[i]];
        kept[t + 1] = w;
    }
    tStart.set(kept);

    // provoking vertex per triangle: rotate corners so lists spread over the vertices (indexed geometry only)
    let outIndex = null;
    if (index && rotate) {
        const load = new Int32Array(nv);
        let changed = false;
        const rotated = index.slice();
        for (let t = 0; t < nt; t++) {
            const n = tStart[t + 1] - tStart[t];
            if (!n) continue;
            let best = 0;
            for (let k = 1; k < 3; k++) if (load[index[t * 3 + k]] < load[index[t * 3 + best]]) best = k;
            load[index[t * 3 + best]] += n;
            if (best) {
                rotated[t * 3] = index[t * 3 + best];
                rotated[t * 3 + 1] = index[t * 3 + (best + 1) % 3];
                rotated[t * 3 + 2] = index[t * 3 + (best + 2) % 3];
                changed = true;
            }
        }
        if (changed) { outIndex = rotated; index = rotated; }
    }
    const first = index ? t => index[t * 3] : t => t * 3;

    // per vertex: merged lists of the triangles it is the first vertex of
    const vStart = new Int32Array(nv + 1);
    for (let t = 0; t < nt; t++) if (tStart[t + 1] > tStart[t]) vStart[first(t) + 1]++;
    for (let v = 0; v < nv; v++) vStart[v + 1] += vStart[v];
    const vCur = vStart.slice(0, nv), vTris = new Int32Array(vStart[nv]);
    for (let t = 0; t < nt; t++) if (tStart[t + 1] > tStart[t]) vTris[vCur[first(t)]++] = t;
    const seen = new Int32Array(E.length).fill(-1);
    const used = new Int32Array(E.length).fill(-1);   // edge → record number
    let records = 0;
    const listOf = new Int32Array(nv * 2);   // per vertex: start in `entries`, count
    const entries = [];
    let maxList = 0;
    for (let v = 0; v < nv; v++) {
        const start = entries.length;
        for (let i = vStart[v]; i < vStart[v + 1]; i++) {
            const t = vTris[i];
            for (let j = tStart[t]; j < tStart[t + 1]; j++) {
                const e = tList[j];
                if (seen[e] === v) continue;
                seen[e] = v;
                if (used[e] < 0) used[e] = records++;
                entries.push(used[e]);
            }
        }
        listOf[v * 2] = start;
        listOf[v * 2 + 1] = entries.length - start;
        maxList = Math.max(maxList, entries.length - start);
    }

    // block
    const tableVec4 = Math.ceil(nv / 2);
    const listStart = tableVec4 * 4;
    const recStart = Math.ceil((listStart + entries.length) / 4);
    const total = (recStart + records * RECORD_VEC4) * 4;
    Object.assign(stats, { entries: entries.length, records, maxList, vec4: total / 4 });
    if (total > EDGE_SHAPE.maxScalars) return { data: null, index: outIndex, stats: { ...stats, tooBig: true, ms: Date.now() - t0 } };
    const data = new Float32Array(total);
    for (let v = 0; v < nv; v++) {
        if (!listOf[v * 2 + 1]) continue;
        data[v * 2] = listStart + listOf[v * 2];
        data[v * 2 + 1] = listOf[v * 2 + 1];
    }
    for (let i = 0; i < entries.length; i++) data[listStart + i] = recStart + entries[i] * RECORD_VEC4;
    E.forEach((e, id) => {
        const r = used[id];
        if (r < 0) return;
        const o = (recStart + r * RECORD_VEC4) * 4;
        const s = e.convex ? 1 : 2;
        const put = (k, v, w) => { data[o + k * 4] = v[0]; data[o + k * 4 + 1] = v[1]; data[o + k * 4 + 2] = v[2]; data[o + k * 4 + 3] = w; };
        put(0, e.p0, e.c0[0] * s); put(1, e.p1, e.c0[1] * s);
        data[o + 8] = e.c0[2] * s; data[o + 9] = e.c1[0] * s; data[o + 10] = e.c1[1] * s; data[o + 11] = e.c1[2] * s;
        put(3, e.na0, e.nb1[0]); put(4, e.na1, e.nb1[1]); put(5, e.nb0, e.nb1[2]);
    });
    stats.ms = Date.now() - t0;
    return { data, index: outIndex, stats };
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// --- geometry helpers (allocation free – called millions of times on big meshes) ---

const T = new Float64Array(9);   // triangle corners

// shortest distance between segment p0–p1 and the triangle at positions[a|b|c] (segments piercing the inside are not
// expected – a sharp edge lies on the surface); early out when even the bounding boxes are further apart than `limit`
function segmentTriangleDistance(p0, p1, positions, a, b, c, limit) {
    for (let k = 0; k < 3; k++) { T[k] = positions[a + k]; T[3 + k] = positions[b + k]; T[6 + k] = positions[c + k]; }
    for (let k = 0; k < 3; k++) {
        const lo = Math.min(T[k], T[3 + k], T[6 + k]), hi = Math.max(T[k], T[3 + k], T[6 + k]);
        if (Math.min(p0[k], p1[k]) - hi > limit || lo - Math.max(p0[k], p1[k]) > limit) return Infinity;
    }
    let d = Math.min(pointTriangleDistance(p0[0], p0[1], p0[2]), pointTriangleDistance(p1[0], p1[1], p1[2]));
    for (let k = 0; k < 3; k++) {
        const i = k * 3, j = ((k + 1) % 3) * 3;
        d = Math.min(d, segmentSegmentDistance(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], T[i], T[i + 1], T[i + 2], T[j], T[j + 1], T[j + 2]));
    }
    return d;
}

// closest point on the triangle T (Ericson, Real-Time Collision Detection 5.1.5)
function pointTriangleDistance(px, py, pz) {
    const ax = T[0], ay = T[1], az = T[2];
    const abx = T[3] - ax, aby = T[4] - ay, abz = T[5] - az, acx = T[6] - ax, acy = T[7] - ay, acz = T[8] - az;
    const at = (s, t) => Math.hypot(ax + abx * s + acx * t - px, ay + aby * s + acy * t - py, az + abz * s + acz * t - pz);
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return at(0, 0);
    const bpx = px - T[3], bpy = py - T[4], bpz = pz - T[5];
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return at(1, 0);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
    const cpx = px - T[6], cpy = py - T[7], cpz = pz - T[8];
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return at(0, 1);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return at(1 - w, w); }
    const den = 1 / (va + vb + vc);
    return at(vb * den, vc * den);
}

// closest distance between segments p–q and r–s (Ericson 5.1.9)
function segmentSegmentDistance(px, py, pz, qx, qy, qz, rx, ry, rz, sx, sy, sz) {
    const d1x = qx - px, d1y = qy - py, d1z = qz - pz, d2x = sx - rx, d2y = sy - ry, d2z = sz - rz;
    const ox = px - rx, oy = py - ry, oz = pz - rz;
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * ox + d2y * oy + d2z * oz;
    const clamp = x => (x < 0 ? 0 : x > 1 ? 1 : x);
    let s, t;
    if (a <= 1e-30 && e <= 1e-30) { s = t = 0; }
    else if (a <= 1e-30) { s = 0; t = clamp(f / e); }
    else {
        const c = d1x * ox + d1y * oy + d1z * oz;
        if (e <= 1e-30) { t = 0; s = clamp(-c / a); }
        else {
            const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
            s = den > 1e-30 ? clamp((b * f - c * e) / den) : 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = clamp(-c / a); } else if (t > 1) { t = 1; s = clamp((b - c) / a); }
        }
    }
    return Math.hypot(ox + d1x * s - d2x * t, oy + d1y * s - d2y * t, oz + d1z * s - d2z * t);
}

// Catmull–Clark subdivision of polygon meshes – MAX TurboSmooth / MeshSmooth (max/max-modifiers.js) and USD meshes with
// subdivisionScheme "catmullClark" (usd-importer.js); `subdivideCorners` below: the same on typed corner arrays for
// large meshes (Blender's subdivision modifier, blend/blend-parse.js – creases, limit surface). Mesh = { P: [x, y, z, …], faces: [{ v: [vertex …], uv?: [uv
// index …], mat?, root? }], uvs?: [u, v, …] }. Faces of the result: per input face its children in corner order (child
// k starts at the parent's corner k), each with `root` = the input face it came from.

/**
 * Catmull–Clark subdivision, `iterations` times (at most 4); open borders stay borders (curve rule). UVs per corner (f.uv into
 * mesh.uvs) are subdivided linearly: face and edge points get the mean of their corners' UVs, a corner keeps its UV;
 * an edge point is shared only where both faces have the same UVs at the edge (seams stay seams).
 */
export function catmullClark(mesh, iterations = 1) {
    let { P, faces } = mesh;
    let UV = mesh.uvs && faces.every(f => f.uv) ? mesh.uvs : null;
    for (let it = 0; it < Math.max(0, Math.min(iterations | 0, 4)); it++) {
        const nv = P.length / 3;
        const NP = [];
        const add = p => NP.push(p[0], p[1], p[2]) / 3 - 1;
        const pt = i => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
        // face points
        const fp = faces.map(f => { const c = [0, 0, 0]; for (const v of f.v) { const p = pt(v); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return c.map(x => x / f.v.length); });
        // edges
        const edges = new Map();
        const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
        faces.forEach((f, fi) => f.v.forEach((a, k) => {
            const b = f.v[(k + 1) % f.v.length], key = ek(a, b);
            let e = edges.get(key);
            if (!e) edges.set(key, e = { a, b, faces: [] });
            e.faces.push(fi);
        }));
        // vertex neighbourhoods
        const vFaces = Array.from({ length: nv }, () => []), vEdges = Array.from({ length: nv }, () => []);
        faces.forEach((f, fi) => f.v.forEach(v => vFaces[v].push(fi)));
        for (const e of edges.values()) { vEdges[e.a].push(e); vEdges[e.b].push(e); }
        // new vertex positions (indices 0..nv-1 keep their numbers)
        for (let v = 0; v < nv; v++) {
            const p = pt(v), border = vEdges[v].filter(e => e.faces.length === 1);
            let q;
            if (border.length >= 2) {
                const o1 = pt(border[0].a === v ? border[0].b : border[0].a), o2 = pt(border[1].a === v ? border[1].b : border[1].a);
                q = [0, 1, 2].map(k => (o1[k] + o2[k] + 6 * p[k]) / 8);
            } else if (vFaces[v].length) {
                const n = vFaces[v].length;
                const F = [0, 0, 0], R = [0, 0, 0];
                for (const fi of vFaces[v]) for (let k = 0; k < 3; k++) F[k] += fp[fi][k] / n;
                const ne = vEdges[v].length || 1;
                for (const e of vEdges[v]) { const a = pt(e.a), b = pt(e.b); for (let k = 0; k < 3; k++) R[k] += (a[k] + b[k]) / 2 / ne; }
                q = [0, 1, 2].map(k => (F[k] + 2 * R[k] + (n - 3) * p[k]) / n);
            } else q = p;
            add(q);
        }
        const fIndex = fp.map(p => add(p));
        for (const e of edges.values()) {
            const a = pt(e.a), b = pt(e.b);
            e.index = add(e.faces.length === 2
                ? [0, 1, 2].map(k => (a[k] + b[k] + fp[e.faces[0]][k] + fp[e.faces[1]][k]) / 4)
                : [0, 1, 2].map(k => (a[k] + b[k]) / 2));
        }
        // UVs: the old ones stay (corners), new ones for face points and edge points (per edge and pair of UVs)
        let NU = null, fUv = null, eUv = null;
        if (UV) {
            NU = UV.slice();
            const addUv = (a, b) => NU.push(a, b) / 2 - 1;
            fUv = faces.map(f => { let u = 0, w = 0; for (const t of f.uv) { u += UV[t * 2]; w += UV[t * 2 + 1]; } return addUv(u / f.uv.length, w / f.uv.length); });
            eUv = new Map();
        }
        const edgeUv = (f, k) => {
            const n = f.v.length, a = f.uv[k], b = f.uv[(k + 1) % n];
            const key = `${ek(f.v[k], f.v[(k + 1) % n])}|${a < b ? a : b},${a < b ? b : a}`;
            let i = eUv.get(key);
            if (i === undefined) eUv.set(key, i = NU.push((UV[a * 2] + UV[b * 2]) / 2, (UV[a * 2 + 1] + UV[b * 2 + 1]) / 2) / 2 - 1);
            return i;
        };
        const next = [];
        faces.forEach((f, fi) => {
            const n = f.v.length;
            for (let k = 0; k < n; k++) {
                const v = f.v[k], prev = f.v[(k - 1 + n) % n], nxt = f.v[(k + 1) % n];
                // corner 0 of child k is the parent's corner k (callers rely on it: USD GeomSubsets, cage UVs)
                const face = { v: [v, edges.get(ek(v, nxt)).index, fIndex[fi], edges.get(ek(prev, v)).index], sg: 1, mat: f.mat || 0, root: f.root ?? fi };
                if (UV) face.uv = [f.uv[k], edgeUv(f, k), fUv[fi], edgeUv(f, (k - 1 + n) % n)];
                next.push(face);
            }
        });
        P = NP; faces = next;
        if (UV) UV = NU;
    }
    return UV ? { P, faces, uvs: UV } : { P, faces };
}

/**
 * Catmull–Clark on a corner mesh in typed arrays (large meshes – Blender's subdivision modifier, blend-parse.js). Faces are
 * corner ranges `offsets` (faces + 1); per corner its vertex `cv` and the edge to the next corner `ce` (edges 0…ne−1);
 * optional per corner `uv` (subdivided linearly – seams stay seams), per edge `sharp` (carried to both halves – for the
 * normals afterwards) and `crease` (0…1: semi-sharp, sharpness = crease² · 10 as Blender hands it to its subdivision,
 * one less per level, blended below 1). Rules: smooth interior, borders as curves (all border vertices smooth), creased
 * vertices with two creased edges as curves, more = corners. Result: quads, face c = the child of input corner c, `root`
 * per face = the input face. `limit`: the final points moved onto the limit surface (Blender's default "limit surface").
 */
export function subdivideCorners({ pos, offsets, cv, ce, ne = 0, uv = null, sharp = null, crease = null }, levels, { limit = false } = {}) {
    let nf = offsets.length - 1, nc = cv.length, nv = pos.length / 3;
    for (let c = 0; c < nc; c++) if (ce[c] >= ne) ne = ce[c] + 1;
    let root = null;
    let sharpness = crease ? Float32Array.from(crease, x => x * x * 10) : null;
    // per level: the face of each corner, edge ends / face counts / sums of face points
    const topology = () => {
        const faceOf = new Int32Array(nc);
        for (let f = 0; f < nf; f++) for (let c = offsets[f]; c < offsets[f + 1]; c++) faceOf[c] = f;
        const next = c => (c + 1 < offsets[faceOf[c] + 1] ? c + 1 : offsets[faceOf[c]]);
        const ea = new Int32Array(ne).fill(-1), eb = new Int32Array(ne), en = new Int32Array(ne);
        for (let c = 0; c < nc; c++) { const e = ce[c]; ea[e] = cv[c]; eb[e] = cv[next(c)]; en[e]++; }
        return { faceOf, next, ea, eb, en };
    };
    for (let it = 0; it < levels; it++) {
        const { faceOf, next, ea, eb, en } = topology();
        const prev = c => (c > offsets[faceOf[c]] ? c - 1 : offsets[faceOf[c] + 1] - 1);
        const P = new Float32Array((nv + nf + ne) * 3);
        const F0 = nv, E0 = nv + nf;
        // face points
        for (let f = 0; f < nf; f++) {
            const s = offsets[f], e = offsets[f + 1], o = (F0 + f) * 3;
            for (let c = s; c < e; c++) { const p = cv[c] * 3; P[o] += pos[p]; P[o + 1] += pos[p + 1]; P[o + 2] += pos[p + 2]; }
            const k = 1 / Math.max(e - s, 1); P[o] *= k; P[o + 1] *= k; P[o + 2] *= k;
        }
        // edge points: two faces – mean of ends and face points (towards the midpoint by the sharpness), else the midpoint
        const fsum = new Float32Array(ne * 3);
        for (let c = 0; c < nc; c++) { const e = ce[c] * 3, f = (F0 + faceOf[c]) * 3; fsum[e] += P[f]; fsum[e + 1] += P[f + 1]; fsum[e + 2] += P[f + 2]; }
        for (let e = 0; e < ne; e++) {
            if (ea[e] < 0) continue;
            const a = ea[e] * 3, b = eb[e] * 3, o = (E0 + e) * 3;
            const w = en[e] === 2 ? Math.min(sharpness ? sharpness[e] : 0, 1) : 1;
            for (let k = 0; k < 3; k++) {
                const mid = (pos[a + k] + pos[b + k]) / 2;
                P[o + k] = en[e] === 2 ? (pos[a + k] + pos[b + k] + fsum[e * 3 + k]) / 4 * (1 - w) + mid * w : mid;
            }
        }
        // vertex points
        const nE = new Int32Array(nv), nF = new Int32Array(nv), nB = new Int32Array(nv), nC = new Int32Array(nv);
        const R = new Float32Array(nv * 3), Fs = new Float32Array(nv * 3), B = new Float32Array(nv * 3), C = new Float32Array(nv * 3), Cs = new Float32Array(nv);
        for (let e = 0; e < ne; e++) {
            if (ea[e] < 0 || ea[e] === eb[e]) continue;
            const a = ea[e], b = eb[e];
            const creased = en[e] === 2 && sharpness && sharpness[e] > 0;
            for (const [v, o] of [[a, b], [b, a]]) {
                nE[v]++;
                for (let k = 0; k < 3; k++) R[v * 3 + k] += (pos[a * 3 + k] + pos[b * 3 + k]) / 2;
                if (en[e] !== 2) { nB[v]++; for (let k = 0; k < 3; k++) B[v * 3 + k] += pos[o * 3 + k]; }
                else if (creased) { nC[v]++; Cs[v] += sharpness[e]; for (let k = 0; k < 3; k++) C[v * 3 + k] += pos[o * 3 + k]; }
            }
        }
        for (let c = 0; c < nc; c++) { const v = cv[c] * 3, f = (F0 + faceOf[c]) * 3; nF[cv[c]]++; Fs[v] += P[f]; Fs[v + 1] += P[f + 1]; Fs[v + 2] += P[f + 2]; }
        for (let v = 0; v < nv; v++) {
            const o = v * 3;
            for (let k = 0; k < 3; k++) {
                const p = pos[o + k];
                let q;
                if (!nF[v] || !nE[v]) q = p;
                else if (nB[v]) q = nB[v] === 2 ? (B[o + k] + 6 * p) / 8 : p;
                else {
                    const n = nE[v];
                    q = (Fs[o + k] / nF[v] + 2 * R[o + k] / n + (n - 3) * p) / n;
                    if (nC[v] >= 2) { const hard = nC[v] === 2 ? (C[o + k] + 6 * p) / 8 : p, w = Math.min(Cs[v] / nC[v], 1); q = q * (1 - w) + hard * w; }
                }
                P[o + k] = q;
            }
        }
        // children: face c of the result = corner c of the input (corner 0 of the child is the parent's corner)
        const half = (e, v) => 2 * e + (v === ea[e] ? 0 : 1);
        const cv2 = new Int32Array(nc * 4), ce2 = new Int32Array(nc * 4), root2 = new Int32Array(nc), off2 = new Int32Array(nc + 1);
        const uv2 = uv ? new Float32Array(nc * 8) : null;
        let fuv = null;
        if (uv) {
            fuv = new Float32Array(nf * 2);
            for (let f = 0; f < nf; f++) {
                const s = offsets[f], e = offsets[f + 1];
                for (let c = s; c < e; c++) { fuv[f * 2] += uv[c * 2]; fuv[f * 2 + 1] += uv[c * 2 + 1]; }
                fuv[f * 2] /= Math.max(e - s, 1); fuv[f * 2 + 1] /= Math.max(e - s, 1);
            }
        }
        for (let c = 0; c < nc; c++) {
            const f = faceOf[c], p = prev(c), n = next(c), o = c * 4;
            off2[c + 1] = o + 4;
            cv2[o] = cv[c]; cv2[o + 1] = E0 + ce[c]; cv2[o + 2] = F0 + f; cv2[o + 3] = E0 + ce[p];
            ce2[o] = half(ce[c], cv[c]); ce2[o + 1] = 2 * ne + c; ce2[o + 2] = 2 * ne + p; ce2[o + 3] = half(ce[p], cv[c]);
            root2[c] = root ? root[f] : f;
            if (uv2) {
                const u = o * 2;
                uv2[u] = uv[c * 2]; uv2[u + 1] = uv[c * 2 + 1];
                uv2[u + 2] = (uv[c * 2] + uv[n * 2]) / 2; uv2[u + 3] = (uv[c * 2 + 1] + uv[n * 2 + 1]) / 2;
                uv2[u + 4] = fuv[f * 2]; uv2[u + 5] = fuv[f * 2 + 1];
                uv2[u + 6] = (uv[p * 2] + uv[c * 2]) / 2; uv2[u + 7] = (uv[p * 2 + 1] + uv[c * 2 + 1]) / 2;
            }
        }
        const ne2 = 2 * ne + nc;
        if (sharp) { const s2 = new Uint8Array(ne2); for (let e = 0; e < ne; e++) s2[2 * e] = s2[2 * e + 1] = sharp[e] ? 1 : 0; sharp = s2; }
        if (sharpness) { const s2 = new Float32Array(ne2); for (let e = 0; e < ne; e++) s2[2 * e] = s2[2 * e + 1] = Math.max(0, sharpness[e] - 1); sharpness = s2; }
        pos = P; cv = cv2; ce = ce2; offsets = off2; uv = uv2; root = root2;
        nv += nf + ne; nf = nc; nc *= 4; ne = ne2;
    }
    // limit surface: interior (n² p + 4 Σ edge neighbours + Σ diagonal corners) / (n (n + 5)), curves (a + 4 p + b) / 6
    if (limit && levels > 0) {
        const { ea, eb, en } = topology();
        const nE = new Int32Array(nv), nB = new Int32Array(nv), nC = new Int32Array(nv), Cs = new Float32Array(nv);
        const E = new Float32Array(nv * 3), D = new Float32Array(nv * 3), B = new Float32Array(nv * 3), C = new Float32Array(nv * 3);
        for (let e = 0; e < ne; e++) {
            if (ea[e] < 0 || ea[e] === eb[e]) continue;
            for (const [v, o] of [[ea[e], eb[e]], [eb[e], ea[e]]]) {
                nE[v]++;
                for (let k = 0; k < 3; k++) E[v * 3 + k] += pos[o * 3 + k];
                if (en[e] !== 2) { nB[v]++; for (let k = 0; k < 3; k++) B[v * 3 + k] += pos[o * 3 + k]; }
                else if (sharpness && sharpness[e] > 0) { nC[v]++; Cs[v] += sharpness[e]; for (let k = 0; k < 3; k++) C[v * 3 + k] += pos[o * 3 + k]; }
            }
        }
        for (let c = 0; c < nc; c++) { const o = c & ~3, d = cv[o + ((c - o + 2) & 3)] * 3, v = cv[c] * 3; D[v] += pos[d]; D[v + 1] += pos[d + 1]; D[v + 2] += pos[d + 2]; }
        const L = new Float32Array(nv * 3);
        for (let v = 0; v < nv; v++) {
            const o = v * 3, n = nE[v];
            for (let k = 0; k < 3; k++) {
                const p = pos[o + k];
                let q;
                if (!n) q = p;
                else if (nB[v]) q = nB[v] === 2 ? (B[o + k] + 4 * p) / 6 : p;
                else {
                    q = (n * n * p + 4 * E[o + k] + D[o + k]) / (n * (n + 5));
                    if (nC[v] >= 2) { const hard = nC[v] === 2 ? (C[o + k] + 4 * p) / 6 : p, w = Math.min(Cs[v] / nC[v], 1); q = q * (1 - w) + hard * w; }
                }
                L[o + k] = q;
            }
        }
        pos = L;
    }
    return { pos, offsets, cv, ce, ne, uv, sharp, root };
}

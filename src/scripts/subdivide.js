// Catmull–Clark subdivision of polygon meshes – MAX TurboSmooth / MeshSmooth (max/max-modifiers.js) and USD meshes with
// subdivisionScheme "catmullClark" (usd-importer.js). Mesh = { P: [x, y, z, …], faces: [{ v: [vertex …], uv?: [uv
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

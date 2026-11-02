// Displacement of a geometry by a height map (displacement.js; pure – runs in a worker and in Node for tests).
//
// 1. Subdivide `levels` times uniformly (every triangle into four, edge midpoints shared between the triangles of an
//    edge – no T-junctions, no cracks); positions, normals, UVs and colours linear.
// 2. Height per vertex: bilinear from the map (rows: row r ↔ v = (r + ½) / n, like the baked textures), the mesh UV
//    through the material's tile transform (repeat / offset; wrap: repeat, or clamp for decals).
// 3. Vertices at the same position (UV seams of box projections, hard edges) get the mean height and the mean normal →
//    they move together, the surface stays closed. On a hard edge (normals of the copies further apart than the crease
//    angle) the vertex stays where it is and the displacement fades in over a band of 2 × amount beside the edge
//    (distance along the mesh, smoothstep): moved along the averaged diagonal the edge overtook its neighbours –
//    triangles turned over (dark slivers along the edges of a box with deep stone relief); held without the band the
//    edge stood as a frame with steep walls, which the path tracer shaded black (shading and geometric normal far
//    apart). Now the relief ramps down to a clean edge.
// 4. Move along that normal: (height − mid) × amount (amount in the geometry's units).
// 5. New normals from the moved triangles: per vertex the faces at its position whose original normal lies within the
//    crease angle of its own – hard edges stay hard, the relief shades smooth.
//
// In:  { positions, normals, uvs, index, colors?, levels, height: { data: Float32Array (n²), n, repeat: [u, v],
//        offset: [u, v], clamp }, amount, mid, crease (cos) }
// Out: { positions, normals, uvs, index, colors }

export function displace({ positions, normals, uvs, index, colors = null, levels = 0, height, amount, mid = 0.5, crease = 0.5 }) {
    let P = positions, N = normals, U = uvs, C = colors, I = index;
    for (let l = 0; l < levels; l++) ({ P, N, U, C, I } = subdivide(P, N, U, C, I));
    const nv = P.length / 3, nt = I.length / 3;

    // height per vertex
    const { data, n, repeat = [1, 1], offset = [0, 0], clamp = false } = height;
    const sample = (u, v) => {
        let x = (u * repeat[0] + offset[0]) * n - 0.5, y = (v * repeat[1] + offset[1]) * n - 0.5;
        if (clamp) { x = Math.min(Math.max(x, 0), n - 1); y = Math.min(Math.max(y, 0), n - 1); }
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        const wrap = k => ((k % n) + n) % n;
        const ax = clamp ? Math.min(x0, n - 1) : wrap(x0), bx = clamp ? Math.min(x0 + 1, n - 1) : wrap(x0 + 1);
        const ay = clamp ? Math.min(y0, n - 1) : wrap(y0), by = clamp ? Math.min(y0 + 1, n - 1) : wrap(y0 + 1);
        const top = data[ay * n + ax] * (1 - fx) + data[ay * n + bx] * fx;
        const bottom = data[by * n + ax] * (1 - fx) + data[by * n + bx] * fx;
        return top * (1 - fy) + bottom * fy;
    };
    const h = new Float32Array(nv);
    for (let v = 0; v < nv; v++) h[v] = U ? sample(U[v * 2], U[v * 2 + 1]) : mid;

    // vertices at one position: groups (hash of the quantised position)
    const group = positionGroups(P);
    const G = group.count;
    const gh = new Float64Array(G), gn = new Float64Array(G * 3), gc = new Uint32Array(G);
    for (let v = 0; v < nv; v++) {
        const g = group.of[v];
        gh[g] += h[v]; gc[g]++;
        gn[g * 3] += N[v * 3]; gn[g * 3 + 1] += N[v * 3 + 1]; gn[g * 3 + 2] += N[v * 3 + 2];
    }
    // hard edges: a copy's normal further from the group's mean than the crease angle
    const hard = new Uint8Array(G);
    for (let v = 0; v < nv; v++) {
        const g = group.of[v];
        if (hard[g] || gc[g] < 2) continue;
        const mx = gn[g * 3], my = gn[g * 3 + 1], mz = gn[g * 3 + 2], ml = Math.hypot(mx, my, mz) || 1;
        const nl = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1;
        if ((N[v * 3] * mx + N[v * 3 + 1] * my + N[v * 3 + 2] * mz) / (ml * nl) < Math.sqrt((1 + crease) / 2)) hard[g] = 1;
    }
    const fade = edgeFade(P, I, group, hard, 2 * Math.abs(amount));
    const out = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
        const g = group.of[v];
        let x = gn[g * 3], y = gn[g * 3 + 1], z = gn[g * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        const d = (gh[g] / gc[g] - mid) * amount * fade[g] / len;
        out[v * 3] = P[v * 3] + x * d; out[v * 3 + 1] = P[v * 3 + 1] + y * d; out[v * 3 + 2] = P[v * 3 + 2] + z * d;
    }

    // normals: face normals (moved, area-weighted) per position group, only faces within the crease angle of the
    // vertex's original normal
    const faceN = new Float32Array(nt * 3);
    const faceBase = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        cross(out, a, b, c, faceN, t * 3);
        cross(P, a, b, c, faceBase, t * 3);
        const l = Math.hypot(faceBase[t * 3], faceBase[t * 3 + 1], faceBase[t * 3 + 2]) || 1;
        faceBase[t * 3] /= l; faceBase[t * 3 + 1] /= l; faceBase[t * 3 + 2] /= l;
    }
    // faces per position group (CSR)
    const start = new Uint32Array(G + 1);
    for (let i = 0; i < I.length; i++) start[group.of[I[i]] + 1]++;
    for (let g = 0; g < G; g++) start[g + 1] += start[g];
    const fill = start.slice(0, G), faces = new Uint32Array(I.length);
    for (let i = 0; i < I.length; i++) faces[fill[group.of[I[i]]]++] = (i / 3) | 0;
    const NN = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
        const g = group.of[v];
        const bx = N[v * 3], by = N[v * 3 + 1], bz = N[v * 3 + 2];
        const bl = Math.hypot(bx, by, bz) || 1;
        let x = 0, y = 0, z = 0;
        for (let k = start[g]; k < start[g + 1]; k++) {
            const f = faces[k];
            if ((faceBase[f * 3] * bx + faceBase[f * 3 + 1] * by + faceBase[f * 3 + 2] * bz) / bl < crease) continue;
            x += faceN[f * 3]; y += faceN[f * 3 + 1]; z += faceN[f * 3 + 2];
        }
        const l = Math.hypot(x, y, z);
        if (l > 0) { NN[v * 3] = x / l; NN[v * 3 + 1] = y / l; NN[v * 3 + 2] = z / l; }
        else { NN[v * 3] = bx / bl; NN[v * 3 + 1] = by / bl; NN[v * 3 + 2] = bz / bl; }
    }
    return { positions: out, normals: NN, uvs: U, index: I, colors: C };
}

/**
 * Weight per position group: 0 on a hard edge, smoothstep up to 1 at `radius` along the mesh (shortest paths over its
 * edges from all hard groups – Dijkstra, stopped at the radius); 1 everywhere without hard edges.
 */
function edgeFade(P, I, group, hard, radius) {
    const G = group.count, fade = new Float32Array(G).fill(1);
    if (!(radius > 0) || !hard.some(Boolean)) return fade;
    // adjacency of the groups (CSR over the triangle edges; duplicates harmless)
    const deg = new Uint32Array(G + 1);
    for (let i = 0; i < I.length; i += 3) for (let k = 0; k < 3; k++) { deg[group.of[I[i + k]] + 1] += 2; }
    for (let g = 0; g < G; g++) deg[g + 1] += deg[g];
    const fill = deg.slice(0, G), adj = new Uint32Array(deg[G]);
    const rep = new Uint32Array(G);   // one vertex per group (its position)
    for (let v = 0; v < P.length / 3; v++) rep[group.of[v]] = v;
    for (let i = 0; i < I.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const a = group.of[I[i + k]], b = group.of[I[i + (k + 1) % 3]];
            adj[fill[a]++] = b; adj[fill[b]++] = a;
        }
    }
    const dist = new Float32Array(G).fill(Infinity);
    const heap = new MinHeap();
    for (let g = 0; g < G; g++) if (hard[g]) { dist[g] = 0; heap.push(0, g); }
    while (heap.size) {
        const [d, g] = heap.pop();
        if (d > dist[g] || d > radius) continue;
        const pa = rep[g] * 3;
        for (let k = deg[g]; k < deg[g + 1]; k++) {
            const h = adj[k], pb = rep[h] * 3;
            const nd = d + Math.hypot(P[pa] - P[pb], P[pa + 1] - P[pb + 1], P[pa + 2] - P[pb + 2]);
            if (nd < dist[h] && nd <= radius) { dist[h] = nd; heap.push(nd, h); }
        }
    }
    for (let g = 0; g < G; g++) {
        if (dist[g] < radius) { const t = dist[g] / radius; fade[g] = t * t * (3 - 2 * t); }
    }
    return fade;
}

class MinHeap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, value) {
        const k = this.k, v = this.v;
        let i = k.length;
        k.push(key); v.push(value);
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (k[p] <= key) break;
            k[i] = k[p]; v[i] = v[p]; i = p;
        }
        k[i] = key; v[i] = value;
    }
    pop() {
        const k = this.k, v = this.v, top = [k[0], v[0]];
        const lk = k.pop(), lv = v.pop();
        if (k.length) {
            let i = 0;
            for (;;) {
                const l = i * 2 + 1, r = l + 1;
                let m = i, mk = lk;
                if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
                if (r < k.length && k[r] < mk) { m = r; mk = k[r]; }
                if (m === i) break;
                k[i] = k[m]; v[i] = v[m]; i = m;
            }
            k[i] = lk; v[i] = lv;
        }
        return top;
    }
}

function cross(P, a, b, c, out, o) {
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    out[o] = uy * vz - uz * vy; out[o + 1] = uz * vx - ux * vz; out[o + 2] = ux * vy - uy * vx;
}

/** groups of vertices at the same position (quantised to 1e-6 of the bounding box) → { of: Uint32Array, count } */
export function positionGroups(P) {
    const nv = P.length / 3;
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) { const x = P[v * 3 + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
    const q = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-12) * 1e-6;
    const map = new Map(), of = new Uint32Array(nv);
    for (let v = 0; v < nv; v++) {
        const key = `${Math.round((P[v * 3] - min[0]) / q)},${Math.round((P[v * 3 + 1] - min[1]) / q)},${Math.round((P[v * 3 + 2] - min[2]) / q)}`;
        let g = map.get(key);
        if (g === undefined) map.set(key, g = map.size);
        of[v] = g;
    }
    return { of, count: map.size };
}

/** one step: every triangle into four, edge midpoints shared (edge key = the two vertex numbers) */
export function subdivide(P, N, U, C, I) {
    const nv = P.length / 3, nt = I.length / 3;
    const edges = new Map();
    let count = nv;
    const mids = new Uint32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
        for (let k = 0; k < 3; k++) {
            const a = I[t * 3 + k], b = I[t * 3 + (k + 1) % 3];
            const key = a < b ? a * nv + b : b * nv + a;
            let m = edges.get(key);
            if (m === undefined) edges.set(key, m = count++);
            mids[t * 3 + k] = m;
        }
    }
    const P2 = new Float32Array(count * 3), N2 = new Float32Array(count * 3), U2 = U ? new Float32Array(count * 2) : null, C2 = C ? new Float32Array(count * 3) : null;
    P2.set(P); N2.set(N); U2?.set(U); C2?.set(C);
    for (const [key, m] of edges) {
        const a = Math.floor(key / nv), b = key - a * nv;
        for (let k = 0; k < 3; k++) {
            P2[m * 3 + k] = (P[a * 3 + k] + P[b * 3 + k]) / 2;
            N2[m * 3 + k] = N[a * 3 + k] + N[b * 3 + k];
            if (C2) C2[m * 3 + k] = (C[a * 3 + k] + C[b * 3 + k]) / 2;
        }
        const l = Math.hypot(N2[m * 3], N2[m * 3 + 1], N2[m * 3 + 2]) || 1;
        N2[m * 3] /= l; N2[m * 3 + 1] /= l; N2[m * 3 + 2] /= l;
        if (U2) { U2[m * 2] = (U[a * 2] + U[b * 2]) / 2; U2[m * 2 + 1] = (U[a * 2 + 1] + U[b * 2 + 1]) / 2; }
    }
    const I2 = new Uint32Array(nt * 12);
    for (let t = 0; t < nt; t++) {
        const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2], ab = mids[t * 3], bc = mids[t * 3 + 1], ca = mids[t * 3 + 2];
        I2.set([a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca], t * 12);
    }
    return { P: P2, N: N2, U: U2, C: C2, I: I2 };
}

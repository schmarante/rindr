// Rounded edges as real geometry ("rolling ball"), per body. Pure function – runs in round-edges-worker.js.
//
// Pass 1 – concave edges (fillet): a ball of radius r rolled outside the body; pass 2 – convex edges on the result:
// the ball rolled inside. Every surface point near a sharp edge of the pass's kind moves onto the ball touching it
// (edge → cylinder, corner → sphere, inner corner → fillet). Concave first: the fillets remove inner corners from the
// outlines of end faces, so the rounding of those outlines has no corner to run into.
// Ball centre for a point v with start normal n: start at v ± r·n, then project onto "r away from the surface"
// (move along closest point → centre until the distance is r; on the surface itself along the smoothed normal).
// Points are evaluated per side of a sharp edge (smoothing group = corner normal) and nudged a hair into their
// triangle (on an edge the projection had to pick one of several equally near faces). Where the two sides of an edge
// end up in different places (a rounding running into a corner – two cylinders meet in a crease) a thin bridge strip
// closes the gap; elsewhere the copies are welded again. Triangles are split near edges until the chords follow the
// arc (tolerance), crack free (decided per edge).
// Every triangle carries a tag (the mesh it came from): a body of several meshes (one per colour) is rounded as
// one and split up again afterwards.
import * as THREE from 'three';   // core only (worker; three-mesh-bvh uses it too)
import { MeshBVH } from 'three-mesh-bvh';
import { creaseCornerNormals } from './crease-normals.js';

const SHARP_DEG = 20, SHARP = SHARP_DEG * Math.PI / 180;   // edges turning more than this are rounded
const SHADE_DEG = 30;                                       // normals of the result: like computeNormals elsewhere
const MAX_ROUNDS = 12;

/**
 * @param {Float32Array} positions  xyz
 * @param {Uint32Array} index
 * @param {Uint32Array} tags  one per triangle
 * @param {{ radius: number, fillet?: boolean, tolerance?: number, maxTriangles?: number, onProgress?: (f: number) => void }} opts
 * @returns {{ parts: Map<number, { positions: Float32Array, normals: Float32Array, index: Uint32Array }>, triangles: number }}
 */
// tolerance: chord to arc – 2 % of the radius (≈ 6 segments per quarter circle; the normals are smooth anyway)
export function roundEdges(positions, index, tags, { radius, fillet = true, tolerance = radius * 0.02, maxTriangles = 4e6, onProgress = () => {} }) {
    let mesh = weld(positions, index, Array.from(tags), radius * 1e-4);
    const passes = fillet ? [1, -1] : [-1];
    passes.forEach((side, i) => {
        const edges = sharpEdges(mesh.pos, mesh.idx, faceNormals(mesh.pos, mesh.idx), side);
        if (edges.length) mesh = roundPass(mesh, side, radius, tolerance, maxTriangles, edges, f => onProgress((i + f) / passes.length));
        mesh = weld(mesh.pos, mesh.idx, mesh.tag, radius * 1e-4);
    });
    return { parts: split(mesh), triangles: mesh.idx.length / 3 };
}

function roundPass({ pos, idx, tag }, side, r, tol, maxTriangles, edges, onProgress) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    const bvh = new MeshBVH(geom, { indirect: true });   // keeps the triangle order (faceIndex = our triangle)
    const cn = creaseCornerNormals(pos, idx, SHARP_DEG);   // smoothed normal per corner (sharp edges split)
    const grid = segmentGrid(edges, r);
    const eps = r * 1e-3;
    const p = new THREE.Vector3(), hit = {};
    const closest = (x, y, z) => { p.set(x, y, z); return bvh.closestPointToPoint(p, hit); };
    // smoothed normal at a point of input triangle f (barycentric over its corner normals)
    const normalAt = (x, y, z, f) => {
        const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + 2] * 3;
        const v0 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]], v1 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
        const v2 = [x - pos[a], y - pos[a + 1], z - pos[a + 2]];
        const d00 = dot3(v0, v0), d01 = dot3(v0, v1), d11 = dot3(v1, v1), d20 = dot3(v2, v0), d21 = dot3(v2, v1), den = d00 * d11 - d01 * d01 || 1;
        const w1 = clamp01((d11 * d20 - d01 * d21) / den), w2 = clamp01((d00 * d21 - d01 * d20) / den), w0 = Math.max(0, 1 - w1 - w2);
        const n = [0, 0, 0];
        [w0, w1, w2].forEach((w, k) => { for (let i = 0; i < 3; i++) n[i] += cn[(f * 3 + k) * 3 + i] * w; });
        return norm3(n);
    };
    // rounded position of surface point v (start normal n, nudged towards c – inside its triangle), or null
    const rounded = (x, y, z, n, c) => {
        if (!grid.near(x, y, z)) return null;
        const dl = Math.hypot(c[0] - x, c[1] - y, c[2] - z) || 1, k = r * 1e-4 / dl;
        let cx = x + (c[0] - x) * k + side * r * n[0], cy = y + (c[1] - y) * k + side * r * n[1], cz = z + (c[2] - z) * k + side * r * n[2];
        let moved = false;
        for (let it = 0; it < 64; it++) {
            const h = closest(cx, cy, cz);
            if (h.distance >= r - eps) break;
            const d = h.distance;
            if (d > r * 0.05) { cx = h.point.x + (cx - h.point.x) / d * r; cy = h.point.y + (cy - h.point.y) / d * r; cz = h.point.z + (cz - h.point.z) / d * r; }
            else { const m = normalAt(h.point.x, h.point.y, h.point.z, h.faceIndex); cx = h.point.x + side * r * m[0]; cy = h.point.y + side * r * m[1]; cz = h.point.z + side * r * m[2]; }
            moved = true;
        }
        if (!moved || closest(cx, cy, cz).distance < r * 0.9) return null;   // flat here, or no room for the ball
        const dx = x - cx, dy = y - cy, dz = z - cz, l = Math.hypot(dx, dy, dz) || 1;
        return [cx + dx / l * r, cy + dy / l * r, cz + dz / l * r];
    };

    // working mesh: geometric vertices on the input surface; triangle corners carry their start normal; images
    // per (vertex, normal) – one per smoothing group at a vertex
    const vpos = Array.from(pos);
    let tv = Array.from(idx), tn = Array.from(cn), tt = Array.from(tag);
    const images = new Map();
    const nkey = n => `${Math.round(n[0] * 1e4)},${Math.round(n[1] * 1e4)},${Math.round(n[2] * 1e4)}`;
    const centroid = t => [0, 1, 2].map(i => (vpos[tv[t * 3] * 3 + i] + vpos[tv[t * 3 + 1] * 3 + i] + vpos[tv[t * 3 + 2] * 3 + i]) / 3);
    const image = (v, n, t) => {
        const k = v + '|' + nkey(n);
        let q = images.get(k);
        if (!q) { q = rounded(vpos[v * 3], vpos[v * 3 + 1], vpos[v * 3 + 2], n, centroid(t)) || [vpos[v * 3], vpos[v * 3 + 1], vpos[v * 3 + 2]]; images.set(k, q); }
        return q;
    };
    const ekey = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
    const cnorm = c => [tn[c * 3], tn[c * 3 + 1], tn[c * 3 + 2]];

    for (let round = 0; round < MAX_ROUNDS; round++) {
        onProgress(round / MAX_ROUNDS);
        const split = new Map();
        const nt = tv.length / 3;
        for (let t = 0; t < nt; t++) {
            const ct = centroid(t);
            for (let k = 0; k < 3; k++) {
                const ca = t * 3 + k, cb = t * 3 + (k + 1) % 3, a = tv[ca], b = tv[cb], kk = ekey(a, b);
                if (split.has(kk)) continue;
                const na = cnorm(ca), nb = cnorm(cb), ia = image(a, na, t), ib = image(b, nb, t);
                for (const s of [0.5, 0.25, 0.75]) {
                    const o = [0, 1, 2].map(i => vpos[a * 3 + i] + (vpos[b * 3 + i] - vpos[a * 3 + i]) * s);
                    const q = rounded(o[0], o[1], o[2], norm3([0, 1, 2].map(i => na[i] * (1 - s) + nb[i] * s)), ct) || o;
                    const l = [0, 1, 2].map(i => ia[i] + (ib[i] - ia[i]) * s);
                    if (Math.hypot(q[0] - l[0], q[1] - l[1], q[2] - l[2]) > tol) { split.set(kk, -1); break; }
                }
            }
        }
        if (!split.size || nt * 2 > maxTriangles) break;
        for (const kk of split.keys()) {
            const a = Math.floor(kk / 4294967296), b = kk % 4294967296;
            split.set(kk, vpos.length / 3);
            vpos.push((vpos[a * 3] + vpos[b * 3]) / 2, (vpos[a * 3 + 1] + vpos[b * 3 + 1]) / 2, (vpos[a * 3 + 2] + vpos[b * 3 + 2]) / 2);
        }
        const ntv = [], ntn = [], ntt = [];
        const add = (g, ...cs) => { for (const [v, n] of cs) { ntv.push(v); ntn.push(...n); } ntt.push(g); };
        for (let t = 0; t < nt; t++) {
            const V = [0, 1, 2].map(k => tv[t * 3 + k]), N = [0, 1, 2].map(k => cnorm(t * 3 + k)), g = tt[t];
            const C = [0, 1, 2].map(k => [V[k], N[k]]);
            const M = [0, 1, 2].map(k => { const m = split.get(ekey(V[k], V[(k + 1) % 3])); return m === undefined ? null : [m, norm3([0, 1, 2].map(i => N[k][i] + N[(k + 1) % 3][i]))]; });
            const n = M.filter(Boolean).length;
            if (n === 0) add(g, C[0], C[1], C[2]);
            else if (n === 3) { add(g, C[0], M[0], M[2]); add(g, M[0], C[1], M[1]); add(g, M[2], M[1], C[2]); add(g, M[0], M[1], M[2]); }
            else if (n === 1) { const k = M.findIndex(Boolean); add(g, C[k], M[k], C[(k + 2) % 3]); add(g, M[k], C[(k + 1) % 3], C[(k + 2) % 3]); }
            else { const k = M.findIndex(m => !m); add(g, M[(k + 1) % 3], C[(k + 2) % 3], M[(k + 2) % 3]); add(g, C[k], C[(k + 1) % 3], M[(k + 1) % 3]); add(g, C[k], M[(k + 1) % 3], M[(k + 2) % 3]); }
        }
        tv = ntv; tn = ntn; tt = ntt;
    }

    // output: one vertex per image (welded by position); bridges where an edge's two sides got different images
    const outPos = [], outIdx = [], outTag = [], at = new Map();
    const vertexOf = q => {
        const k = q.map(x => Math.round(x / (r * 1e-4))).join(',');
        let i = at.get(k);
        if (i === undefined) { i = outPos.length / 3; outPos.push(q[0], q[1], q[2]); at.set(k, i); }
        return i;
    };
    const cornerOut = new Array(tv.length);
    for (let c = 0; c < tv.length; c++) cornerOut[c] = vertexOf(image(tv[c], cnorm(c), Math.floor(c / 3)));
    const edgeSide = new Map();   // directed geometric edge → [out a, out b, tag]
    for (let t = 0; t < tv.length / 3; t++) {
        const o = [cornerOut[t * 3], cornerOut[t * 3 + 1], cornerOut[t * 3 + 2]];
        if (o[0] !== o[1] && o[1] !== o[2] && o[0] !== o[2]) { outIdx.push(o[0], o[1], o[2]); outTag.push(tt[t]); }
        for (let k = 0; k < 3; k++) edgeSide.set(tv[t * 3 + k] + ',' + tv[t * 3 + (k + 1) % 3], [o[k], o[(k + 1) % 3], tt[t]]);
    }
    for (const [key, [aA, bA, g]] of edgeSide) {
        const [a, b] = key.split(',').map(Number);
        if (a > b) continue;   // each undirected edge once
        const other = edgeSide.get(b + ',' + a);
        if (!other) continue;   // open edge
        const [bB, aB] = other;
        // quad bA → aA → aB → bB (winding matches both neighbours)
        if (aA !== aB && bA !== aA && bA !== aB) { outIdx.push(bA, aA, aB); outTag.push(g); }
        if (bA !== bB && bA !== aB && aB !== bB) { outIdx.push(bA, aB, bB); outTag.push(g); }
    }
    onProgress(1);
    return { pos: outPos, idx: outIdx, tag: outTag };
}

// split by tag; vertices split where the shading normal (30° crease) differs
function split({ pos, idx, tag }) {
    const corners = creaseCornerNormals(pos, idx, SHADE_DEG);
    const parts = new Map();
    for (let t = 0; t < idx.length / 3; t++) {
        let part = parts.get(tag[t]);
        if (!part) parts.set(tag[t], part = { pos: [], nrm: [], idx: [], at: new Map() });
        for (let k = 0; k < 3; k++) {
            const c = t * 3 + k, v = idx[c];
            const key = `${v}|${Math.round(corners[c * 3] * 1e3)},${Math.round(corners[c * 3 + 1] * 1e3)},${Math.round(corners[c * 3 + 2] * 1e3)}`;
            let i = part.at.get(key);
            if (i === undefined) {
                i = part.pos.length / 3;
                part.pos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
                part.nrm.push(corners[c * 3], corners[c * 3 + 1], corners[c * 3 + 2]);
                part.at.set(key, i);
            }
            part.idx.push(i);
        }
    }
    const out = new Map();
    for (const [g, p] of parts) out.set(g, { positions: new Float32Array(p.pos), normals: new Float32Array(p.nrm), index: new Uint32Array(p.idx) });
    return out;
}

// sharp edges (dihedral > SHARP) of one kind as segments [ax, ay, az, bx, by, bz, angle]; convex for side −1
function sharpEdges(pos, idx, fn, side) {
    const owner = new Map(), out = [];
    const key = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
    for (let f = 0; f < idx.length / 3; f++) {
        for (let k = 0; k < 3; k++) {
            const a = idx[f * 3 + k], b = idx[f * 3 + (k + 1) % 3], kk = key(a, b);
            const g = owner.get(kk);
            if (g === undefined) { owner.set(kk, f); continue; }
            const angle = Math.acos(Math.max(-1, Math.min(1, fn[f * 3] * fn[g * 3] + fn[f * 3 + 1] * fn[g * 3 + 1] + fn[f * 3 + 2] * fn[g * 3 + 2])));
            if (angle < SHARP) continue;
            const c = idx[g * 3] + idx[g * 3 + 1] + idx[g * 3 + 2] - a - b;   // third vertex of g: behind f's plane = convex
            const d = (pos[c * 3] - pos[a * 3]) * fn[f * 3] + (pos[c * 3 + 1] - pos[a * 3 + 1]) * fn[f * 3 + 1] + (pos[c * 3 + 2] - pos[a * 3 + 2]) * fn[f * 3 + 2];
            if ((d < 0) === (side < 0)) out.push(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2], angle);
        }
    }
    return out;
}

// uniform grid of segments: near(p) = p inside the band of a segment (r·tan(angle/2), capped)
function segmentGrid(edges, r) {
    const cell = r * 2, cells = new Map();
    const ck = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let i = 0; i < edges.length; i += 7) {
        const band = r * Math.min(Math.tan(edges[i + 6] / 2), 4) * 1.05 + r * 0.01;
        const s = { ax: edges[i], ay: edges[i + 1], az: edges[i + 2], bx: edges[i + 3], by: edges[i + 4], bz: edges[i + 5], band };
        const lo = [Math.min(s.ax, s.bx), Math.min(s.ay, s.by), Math.min(s.az, s.bz)].map(v => Math.floor((v - band) / cell));
        const hi = [Math.max(s.ax, s.bx), Math.max(s.ay, s.by), Math.max(s.az, s.bz)].map(v => Math.floor((v + band) / cell));
        for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
            const k = `${x},${y},${z}`;
            if (!cells.has(k)) cells.set(k, []);
            cells.get(k).push(s);
        }
    }
    const near = (x, y, z) => {
        const list = cells.get(ck(x, y, z));
        if (!list) return false;
        for (const s of list) {
            const ux = s.bx - s.ax, uy = s.by - s.ay, uz = s.bz - s.az, l2 = ux * ux + uy * uy + uz * uz || 1;
            const t = Math.max(0, Math.min(1, ((x - s.ax) * ux + (y - s.ay) * uy + (z - s.az) * uz) / l2));
            const dx = s.ax + ux * t - x, dy = s.ay + uy * t - y, dz = s.az + uz * t - z;
            if (dx * dx + dy * dy + dz * dz <= s.band * s.band) return true;
        }
        return false;
    };
    return { near };
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const clamp01 = v => Math.min(1, Math.max(0, v));
const norm3 = n => { const l = Math.hypot(n[0], n[1], n[2]) || 1; return [n[0] / l, n[1] / l, n[2] / l]; };

function faceNormals(pos, idx) {
    const n = new Float64Array(idx.length);
    for (let f = 0; f < idx.length / 3; f++) {
        const a = idx[f * 3] * 3, b = idx[f * 3 + 1] * 3, c = idx[f * 3 + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z) || 1;
        n[f * 3] = x / l; n[f * 3 + 1] = y / l; n[f * 3 + 2] = z / l;
    }
    return n;
}

// weld vertices at the same position (grid), drop degenerate triangles; tags follow their triangles
function weld(positions, index, tags, grid) {
    const map = new Map(), pos = [], remap = [];
    for (let v = 0; v < positions.length / 3; v++) {
        const k = `${Math.round(positions[v * 3] / grid)},${Math.round(positions[v * 3 + 1] / grid)},${Math.round(positions[v * 3 + 2] / grid)}`;
        let w = map.get(k);
        if (w === undefined) { w = pos.length / 3; map.set(k, w); pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); }
        remap.push(w);
    }
    const idx = [], tag = [];
    for (let i = 0; i < index.length; i += 3) {
        const a = remap[index[i]], b = remap[index[i + 1]], c = remap[index[i + 2]];
        if (a !== b && b !== c && a !== c) { idx.push(a, b, c); tag.push(tags[i / 3]); }
    }
    return { pos, idx, tag };
}

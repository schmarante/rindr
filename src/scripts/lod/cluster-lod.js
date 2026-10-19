// Cluster LOD: a mesh → clusters of ≤ 128 triangles in a hierarchy of simplification levels (built per geometry in
// lod-worker.js by lod-store.js).
//
// Level 0 = the original triangles in clusters. Each further level: neighbouring clusters (shared vertices) are
// put into groups of ~8, every group is simplified to half its triangles with its outer border locked (so it still
// fits its neighbours, no cracks) and split into new clusters again. Simplification never creates vertices – all
// levels index the original vertex buffer.
//
// Selection (lod-store.js cuts): a cluster is drawn if its own error is small enough but the error
// of the coarser version made from its group is not. All clusters of a group share the group's sphere + error, so
// they decide the same way, and errors/spheres only grow towards coarser levels – the cut is consistent.
//
// Own implementation of the published idea (cluster DAG with locked group borders); uses meshoptimizer (MIT) for
// clustering and simplification.
import { MeshoptClusterizer as Clusterizer } from 'three/examples/jsm/libs/meshopt_clusterizer.module.js';
import { MeshoptSimplifier as Simplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';

const MAX_VERTICES = 128;
const MAX_TRIANGLES = 128;
const GROUP_SIZE = 8;
const SIBLING_WEIGHT = 0.01;   // adjacency weight of clusters made from the same group (see partition)
const STUCK_RATIO = 0.85;     // a group that keeps more than this share of its triangles is not simplified further
const GENTLE_ERROR = 0.01;    // first try: error limit as share of the group's radius
const MAX_ERROR = 3.4e38;
// normals take part in the error: a normal turned by Δ (length of the difference of unit normals) counts like a shift of
// NORMAL_WEIGHT × the group's size. Geometry alone missed details seen by their shading – embossed lettering a few
// tenths of a millimetre high fell apart at 2 px (and Permissive collapsed the seams around it)
const NORMAL_WEIGHT = 0.15;

/**
 * @param {{ positions: Float32Array, indices: Uint32Array, normals?: Float32Array }} mesh  positions (and normals) xyz per
 *   vertex, triangle list
 * @param {(stage: string, info?: object) => void} [progress]
 * @returns {Promise<object>} flat arrays, see pack()
 */
export async function buildClusterLod({ positions, indices, normals: sourceNormals = null, weld = 'auto' }, progress = () => {}) {
    await Promise.all([Clusterizer.ready, Simplifier.ready]);
    const vertexCount = positions.length / 3;
    // same position = same vertex for the adjacency (split vertices at seams of normals/UVs)
    const remap = Simplifier.generatePositionRemap(positions, 3);
    // triangle soups (STL: three own vertices per triangle, also when indexed) – every edge would be an open border
    // that stays locked; welded by position, with smooth normals instead of the facet normals. Detected by almost
    // every triangle corner having a vertex of its own (CAD meshes share vertices within a face and split them only
    // at hard edges – a cube: 24 vertices for 36 corners – those keep their vertices and normals)
    let unique = 0;
    for (let i = 0; i < vertexCount; i++) if (remap[i] === i) unique++;
    let normals = null;
    if (weld === 'auto') weld = vertexCount >= indices.length * 0.9 && unique < vertexCount / 2;
    if (weld) {
        indices = indices.map(v => remap[v]);
        normals = smoothNormals(positions, indices);
    }
    const ctx = { positions, normals: normals || sourceNormals, remap, vertexCount, stamp: new Int32Array(vertexCount).fill(-1), local: new Int32Array(vertexCount), stampId: 0 };

    const clusters = [];   // { indices: Uint32Array, sphere, lod: { sphere, error }, parent: { sphere, error }, level }
    let pending = splitClusters(ctx, indices, 0, null, clusters);
    const levels = [{ clusters: pending.length, triangles: indices.length / 3 }];
    progress('level', { level: 0, clusters: pending.length });

    for (let level = 1; pending.length > 1; level++) {
        const groups = partition(ctx, clusters, pending);
        const next = [];
        let triangles = 0;
        for (const group of groups) {
            const merged = concat(group.map(id => clusters[id].indices));
            const sphere = mergeSpheres(group.map(id => clusters[id].lod.sphere));
            const childError = Math.max(...group.map(id => clusters[id].lod.error));
            const res = simplifyGroup(ctx, merged, Math.floor(merged.length / 6) * 3, sphere[3]);
            if (!res || res.indices.length > merged.length * STUCK_RATIO) continue;   // stays a root
            // monotonic: never smaller than the children's (max – the sum was far too cautious, coarse levels
            // were only drawn from very far)
            const lod = { sphere, error: Math.max(childError, res.error) };
            for (const id of group) clusters[id].parent = lod;
            const made = splitClusters(ctx, res.indices, level, lod, clusters);
            for (const id of made) next.push(id);
            triangles += res.indices.length / 3;
        }
        if (!next.length) break;
        levels.push({ clusters: next.length, triangles, groups: groups.length });
        progress('level', { level, clusters: next.length });
        pending = next;
    }
    const res = pack(clusters, levels);
    if (normals) res.normals = normals;
    res.welded = !!weld;
    res.uniquePositions = unique;
    return res;
}

// triangles → clusters (global vertex indices); lod = the group they were simplified from (null: level 0)
function splitClusters(ctx, indices, level, lod, clusters) {
    const { verts, local, positions } = compact(ctx, indices);
    const res = Clusterizer.buildMeshlets(local, positions, 3, MAX_VERTICES, MAX_TRIANGLES, 0);
    const ids = [];
    for (let m = 0; m < res.meshletCount; m++) {
        const vo = res.meshlets[m * 4], to = res.meshlets[m * 4 + 1], tc = res.meshlets[m * 4 + 3];
        const out = new Uint32Array(tc * 3);
        for (let i = 0; i < tc * 3; i++) out[i] = verts[res.vertices[vo + res.triangles[to + i]]];
        const sphere = boundingSphere(ctx.positions, out);
        clusters.push({ indices: out, sphere, lod: lod || { sphere, error: 0 }, parent: null, level });
        ids.push(clusters.length - 1);
    }
    return ids;
}

// only the vertices used by `indices` (meshoptimizer copies the whole vertex buffer per call)
function compact(ctx, indices) {
    const id = ++ctx.stampId;
    const verts = [];
    const local = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
        const v = indices[i];
        if (ctx.stamp[v] !== id) { ctx.stamp[v] = id; ctx.local[v] = verts.length; verts.push(v); }
        local[i] = ctx.local[v];
    }
    const positions = new Float32Array(verts.length * 3);
    const normals = ctx.normals ? new Float32Array(verts.length * 3) : null;
    for (let i = 0; i < verts.length; i++) {
        const v = verts[i] * 3;
        positions[i * 3] = ctx.positions[v]; positions[i * 3 + 1] = ctx.positions[v + 1]; positions[i * 3 + 2] = ctx.positions[v + 2];
        if (normals) { normals[i * 3] = ctx.normals[v]; normals[i * 3 + 1] = ctx.normals[v + 1]; normals[i * 3 + 2] = ctx.normals[v + 2]; }
    }
    return { verts: Uint32Array.from(verts), local, positions, normals };
}

// halve a group; its open border (edges with one triangle inside the group) stays where it is
function simplifyGroup(ctx, indices, target, radius) {
    const { verts, local, positions, normals } = compact(ctx, indices);
    const enough = n => n <= indices.length * STUCK_RATIO;
    // meshoptimizer scales the positions to a unit box: attribute weights are relative to the group's extent
    const run = (limit, flags) => (normals
        ? Simplifier.simplifyWithAttributes(local, positions, 3, normals, 3, [NORMAL_WEIGHT, NORMAL_WEIGHT, NORMAL_WEIGHT], null, target, limit, flags)
        : Simplifier.simplify(local, positions, 3, target, limit, flags));
    // first only as far as a small error allows (a share of the group's size): forced to half right away, single
    // groups made errors 60× the median and kept their clusters fine until far away
    let [out, error] = run(radius * GENTLE_ERROR, ['LockBorder', 'ErrorAbsolute']);
    if (!enough(out.length)) [out, error] = run(MAX_ERROR, ['LockBorder', 'ErrorAbsolute']);
    // stuck: CAD tessellation splits the vertices at every face edge – seams everywhere, whose corners stay put (a
    // detailed brick stopped at 16 % of its triangles). Permissive may collapse across seams – the normals make that
    // expensive where the shading changes, so it happens further away
    if (!enough(out.length)) [out, error] = run(MAX_ERROR, ['LockBorder', 'ErrorAbsolute', 'Permissive']);
    if (!out.length) return null;
    const global = new Uint32Array(out.length);
    for (let i = 0; i < out.length; i++) global[i] = verts[out[i]];
    return { indices: global, error };
}

// groups of ~GROUP_SIZE clusters that share the most vertices (greedy, seeds in spatial order);
// clusters without neighbours (separate parts) are grouped with their spatial neighbours
function partition(ctx, clusters, ids) {
    const { remap } = ctx;
    // vertex (by position) → clusters using it
    const owners = new Map();
    for (const id of ids) {
        const stampId = ++ctx.stampId;
        for (const v0 of clusters[id].indices) {
            const v = remap[v0];
            if (ctx.stamp[v] === stampId) continue;
            ctx.stamp[v] = stampId;
            const o = owners.get(v);
            if (o === undefined) owners.set(v, id);
            else if (typeof o === 'number') owners.set(v, [o, id]);
            else o.push(id);
        }
    }
    // shared vertex counts per cluster pair
    const adj = new Map(ids.map(id => [id, new Map()]));
    for (const o of owners.values()) {
        if (typeof o === 'number') continue;
        for (let i = 0; i < o.length; i++) {
            const a = adj.get(o[i]), ci = clusters[o[i]];
            for (let j = 0; j < o.length; j++) {
                if (i === j) continue;
                // siblings (made from the same group) share its whole inside – grouped again they would keep that
                // group's locked border forever (simplification got stuck after a few levels); they join only if
                // nothing else is left
                const w = ci.level > 0 && clusters[o[j]].lod === ci.lod ? SIBLING_WEIGHT : 1;
                a.set(o[j], (a.get(o[j]) || 0) + w);
            }
        }
    }
    const order = spatialOrder(clusters, ids);
    const assigned = new Set();
    const groups = [];
    const loners = [];
    for (const seed of order) {
        if (assigned.has(seed)) continue;
        assigned.add(seed);
        const group = [seed];
        const cand = new Map();
        const addNeighbours = id => { for (const [n, w] of adj.get(id)) if (!assigned.has(n)) cand.set(n, (cand.get(n) || 0) + w); };
        addNeighbours(seed);
        while (group.length < GROUP_SIZE && cand.size) {
            let best = -1, bestW = -1;
            for (const [n, w] of cand) if (w > bestW) { best = n; bestW = w; }
            cand.delete(best);
            assigned.add(best);
            group.push(best);
            addNeighbours(best);
        }
        if (group.length === 1) loners.push(seed); else groups.push(group);
    }
    for (let i = 0; i < loners.length; i += GROUP_SIZE) groups.push(loners.slice(i, i + GROUP_SIZE));
    return groups;
}

// cluster IDs sorted along a Morton curve of their centres
function spatialOrder(clusters, ids) {
    let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) {
        const c = clusters[id].sphere;
        for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], c[k]); max[k] = Math.max(max[k], c[k]); }
    }
    const spread = v => { v &= 0x3ff; v = (v | (v << 16)) & 0x30000ff; v = (v | (v << 8)) & 0x300f00f; v = (v | (v << 4)) & 0x30c30c3; return (v | (v << 2)) & 0x9249249; };
    const code = id => {
        const c = clusters[id].sphere;
        const q = k => Math.min(1023, Math.max(0, Math.floor((c[k] - min[k]) / ((max[k] - min[k]) || 1) * 1023)));
        return spread(q(0)) | (spread(q(1)) << 1) | (spread(q(2)) << 2);
    };
    const codes = new Map(ids.map(id => [id, code(id)]));
    return [...ids].sort((a, b) => codes.get(a) - codes.get(b));
}

// [x, y, z, r] around the vertices of `indices` (centre of the box, radius to the farthest vertex)
function boundingSphere(positions, indices) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const v of indices) for (let k = 0; k < 3; k++) { const p = positions[v * 3 + k]; if (p < min[k]) min[k] = p; if (p > max[k]) max[k] = p; }
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    let r = 0;
    for (const v of indices) r = Math.max(r, Math.hypot(positions[v * 3] - c[0], positions[v * 3 + 1] - c[1], positions[v * 3 + 2] - c[2]));
    return [c[0], c[1], c[2], r];
}

// sphere containing all given spheres
function mergeSpheres(spheres) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const s of spheres) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], s[k] - s[3]); max[k] = Math.max(max[k], s[k] + s[3]); }
    const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    let r = 0;
    for (const s of spheres) r = Math.max(r, Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) + s[3]);
    return [c[0], c[1], c[2], r];
}

// area-weighted vertex normals
function smoothNormals(positions, indices) {
    const n = new Float32Array(positions.length);
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const v of [a, b, c]) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
    }
    for (let v = 0; v < n.length; v += 3) {
        const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1;
        n[v] /= l; n[v + 1] /= l; n[v + 2] /= l;
    }
    return n;
}

function concat(arrays) {
    const out = new Uint32Array(arrays.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrays) { out.set(a, o); o += a.length; }
    return out;
}

// flat arrays for the GPU + the selection: per cluster triangle offset/count, culling sphere, own LOD sphere + error,
// parent LOD sphere + error (Infinity = root)
function pack(clusters, levels) {
    const n = clusters.length;
    const offsets = new Uint32Array(n * 2), spheres = new Float32Array(n * 4);
    const lod = new Float32Array(n * 5), parent = new Float32Array(n * 5), level = new Uint8Array(n);
    let tris = 0;
    for (let i = 0; i < n; i++) {
        const c = clusters[i];
        offsets[i * 2] = tris; offsets[i * 2 + 1] = c.indices.length / 3;
        tris += c.indices.length / 3;
        spheres.set(c.sphere, i * 4);
        lod.set(c.lod.sphere, i * 5); lod[i * 5 + 4] = c.lod.error;
        if (c.parent) { parent.set(c.parent.sphere, i * 5); parent[i * 5 + 4] = c.parent.error; } else parent[i * 5 + 4] = Infinity;
        level[i] = c.level;
    }
    const indices = new Uint32Array(tris * 3);
    for (let i = 0; i < n; i++) indices.set(clusters[i].indices, offsets[i * 2] * 3);
    return { count: n, offsets, spheres, lod, parent, level, indices, levels };
}

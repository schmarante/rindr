// Box-projected texture coordinates for meshes without UVs (STEP, STL, FBX/glTF/OBJ … without UVs). Pure function:
// main thread (step-importer.js re-exports it) and workers (STL parts, stl/stl-core.js).

// Texture coordinates via box projection (CAD geometry has no UVs): every triangle takes the plane perpendicular to
// the dominant axis of its face normal, 1 UV unit = UV_TILE model units (mm). Shared by the raster view and the path
// tracer (material textures).
// Per triangle, not per vertex: with the axis chosen per (smoothed) vertex normal, the triangles along the border of
// two planes had corners from both projections – the texture was squeezed into a zigzag band there (rounded bodies).
// Vertices shared by triangles of different planes are duplicated instead → a clean, straight seam. Duplicates keep
// position and normal (sharp-edge and slicer passes weld by position) and their source vertex (animation).
export const UV_TILE = 100;
export function boxProject({ positions, normals, index, sourceVertex = null, colors = null }, tile = UV_TILE) {
    const nv = positions.length / 3;
    const nt = index ? index.length / 3 : nv / 3;
    const corner = index ? i => index[i] : i => i;
    // projection axis per triangle (geometric normal; degenerate triangles: the vertex normals)
    const axis = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) {
        const a = corner(t * 3) * 3, b = corner(t * 3 + 1) * 3, c = corner(t * 3 + 2) * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nx === 0 && ny === 0 && nz === 0) {
            nx = normals[a] + normals[b] + normals[c];
            ny = normals[a + 1] + normals[b + 1] + normals[c + 1];
            nz = normals[a + 2] + normals[b + 2] + normals[c + 2];
        }
        nx = Math.abs(nx); ny = Math.abs(ny); nz = Math.abs(nz);
        axis[t] = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
    }
    // vertex per (vertex, axis): the first axis keeps the vertex, every further one gets a copy
    const own = new Int8Array(nv).fill(-1);
    let copies = null, extra = 0;
    const slot = new Int32Array(nt * 3);
    for (let i = 0; i < nt * 3; i++) {
        const v = corner(i), a = axis[(i / 3) | 0];
        if (own[v] < 0) own[v] = a;
        if (own[v] === a) { slot[i] = v; continue; }
        copies ??= new Int32Array(nv * 3).fill(-1);
        const key = v * 3 + a;
        if (copies[key] < 0) copies[key] = nv + extra++;
        slot[i] = copies[key];
    }
    const k = 1 / tile;
    const project = (uv, o, p, a) => {
        const x = positions[p * 3], y = positions[p * 3 + 1], z = positions[p * 3 + 2];
        if (a === 0) { uv[o * 2] = y * k; uv[o * 2 + 1] = z * k; }
        else if (a === 1) { uv[o * 2] = x * k; uv[o * 2 + 1] = z * k; }
        else { uv[o * 2] = x * k; uv[o * 2 + 1] = y * k; }
    };
    const total = nv + extra;
    const uvs = new Float32Array(total * 2);
    for (let v = 0; v < nv; v++) project(uvs, v, v, own[v] < 0 ? 0 : own[v]);
    if (!extra) return { positions, normals, index, uvs, sourceVertex, colors };
    // non-indexed geometry never shares vertices – copies only come with an index
    const P = new Float32Array(total * 3), N = new Float32Array(total * 3);
    P.set(positions);
    N.set(normals);
    const S = sourceVertex ? new Int32Array(total) : null;
    S?.set(sourceVertex);
    const C = colors ? new Float32Array(total * 3) : null;   // colours per vertex go with the copies
    C?.set(colors);
    for (let key = 0; key < copies.length; key++) {
        const o = copies[key];
        if (o < 0) continue;
        const v = (key / 3) | 0;
        for (let c = 0; c < 3; c++) { P[o * 3 + c] = positions[v * 3 + c]; N[o * 3 + c] = normals[v * 3 + c]; }
        if (S) S[o] = sourceVertex[v];
        if (C) for (let c = 0; c < 3; c++) C[o * 3 + c] = colors[v * 3 + c];
        project(uvs, o, v, key % 3);
    }
    const I = total > 65535 && !(index instanceof Uint32Array) ? new Uint32Array(slot.length) : new index.constructor(slot.length);
    I.set(slot);
    return { positions: P, normals: N, index: I, uvs, sourceVertex: S, colors: C };
}

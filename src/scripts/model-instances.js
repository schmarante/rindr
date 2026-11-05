// Model meshes that stand for many copies: one InstancedMesh per part of an object a file places very often (pbrt
// object instances – an outdoor scene had 30 000 plants of 7–21 parts each, 407 000 meshes: three.js' per-object work made
// loading, every frame and HQ crawl). The importer hands such a part over with `instances` (column-major 4×4 per
// copy, in the model's mm); the InstancedMesh is the part for everything else – Scene Graph row, selection, gizmo,
// explosion and materials act on all copies at once. The path tracer and picking expand the copies themselves.
//
// Every box of a placed part goes through localBox: geometry.boundingBox alone is the box of one copy.
import * as THREE from 'three/webgpu';
import { IMPORT } from './config.js';

/** Copies from which an importer makes one InstancedMesh per part (IMPORT.instancedCopies; test: ?instanced=0 = never) */
export const minCopies = () => (new URLSearchParams(globalThis.location?.search).get('instanced') === '0' ? Infinity : IMPORT.instancedCopies);

/**
 * Instance matrices as a storage buffer on WebGPU: a runtime-sized array in the shader → one shader per material.
 * three.js' default (a uniform array up to maxUniformBufferBindingSize) writes the count into the shader – every count
 * its own shader, compiled synchronously. WebGL2 has no storage buffers: capacity rounded up to a power of two (few
 * sizes); `count` says how many are used.
 */
export function instanceMatrixAttribute(storage, count, source = null) {
    const capacity = storage ? Math.max(count, 1) : 2 ** Math.ceil(Math.log2(Math.max(count, 1)));
    const array = new Float32Array(capacity * 16);
    if (source) array.set(source.subarray(0, count * 16));
    if (storage) return new THREE.StorageInstancedBufferAttribute(array, 16);
    const attr = new THREE.InstancedBufferAttribute(array, 16);
    attr.setUsage(THREE.DynamicDrawUsage);
    return attr;
}

/** An InstancedMesh with the given copies (matrices: Float32Array, 16 per copy) */
export function instancedModelMesh(geometry, material, matrices, storage) {
    const count = matrices.length / 16;
    const mesh = new THREE.InstancedMesh(geometry, material, 0);
    mesh.instanceMatrix = instanceMatrixAttribute(storage, count, matrices);
    mesh.count = count;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    return mesh;
}

/** A copy of a model InstancedMesh (duplicate.js) – same copies, own buffer */
export function cloneInstanced(src, geometry = src.geometry, material = src.material) {
    return instancedModelMesh(geometry, material, src.instanceMatrix.array.subarray(0, src.count * 16), !!src.instanceMatrix.isStorageInstancedBufferAttribute);
}

/** Box of a mesh in its own space: the geometry's, for an InstancedMesh the box around all its copies */
export function localBox(mesh) {
    if (mesh.isInstancedMesh) {
        if (!mesh.boundingBox) mesh.computeBoundingBox();
        return mesh.boundingBox;
    }
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    return g.boundingBox;
}

/** How many copies a mesh draws */
export const copiesOf = mesh => (mesh.isInstancedMesh ? mesh.count : 1);

// Points of a geometry that decide its lowest point under a placement: the extreme vertices along 26 directions
// (faces, edges and corners of a cube) – exact for turns about the vertical, a hair low for tilted copies
const DIRS = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) DIRS.push([x, y, z]);
function supportPoints(geometry) {
    if (geometry.userData.supportPoints) return geometry.userData.supportPoints;
    const p = geometry.getAttribute('position');
    const best = DIRS.map(() => -Infinity), at = DIRS.map(() => -1);
    for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        for (let d = 0; d < DIRS.length; d++) {
            const v = DIRS[d][0] * x + DIRS[d][1] * y + DIRS[d][2] * z;
            if (v > best[d]) { best[d] = v; at[d] = i; }
        }
    }
    const out = [];
    for (const i of new Set(at)) if (i >= 0) out.push(p.getX(i), p.getY(i), p.getZ(i));
    return (geometry.userData.supportPoints = new Float32Array(out));
}

/** Lowest y of an InstancedMesh's copies under placement e (its matrix in the model root, column-major elements) */
export function lowestInstanced(mesh, e) {
    const pts = supportPoints(mesh.geometry), a = mesh.instanceMatrix.array;
    // y row of e × instance: y = Σ_j e[1 + 4j] · (instance column j)
    let min = Infinity;
    for (let k = 0; k < mesh.count; k++) {
        const o = k * 16;
        const r0 = e[1] * a[o] + e[5] * a[o + 1] + e[9] * a[o + 2] + e[13] * a[o + 3];
        const r1 = e[1] * a[o + 4] + e[5] * a[o + 5] + e[9] * a[o + 6] + e[13] * a[o + 7];
        const r2 = e[1] * a[o + 8] + e[5] * a[o + 9] + e[9] * a[o + 10] + e[13] * a[o + 11];
        const r3 = e[1] * a[o + 12] + e[5] * a[o + 13] + e[9] * a[o + 14] + e[13] * a[o + 15];
        for (let i = 0; i < pts.length; i += 3) {
            const y = r0 * pts[i] + r1 * pts[i + 1] + r2 * pts[i + 2] + r3;
            if (y < min) min = y;
        }
    }
    return min;
}

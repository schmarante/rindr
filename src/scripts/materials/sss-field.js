// Signed distance fields for subsurface scattering (toon.js): the raster approximation knew no thickness – light
// shone through a 1.5 mm fin as much as through the middle of a sphere, while the path tracer took the real distance
// inside. Per geometry with an SSS material a field over its box (FIELD_RES³, distances in geometry units, negative
// inside), generated on the GPU from its BVH (sss-sdf.js, three-mesh-bvh closest-point query – loaded on demand) into
// one slot of an atlas (SLOTS fields stacked along z, least recently requested one replaced). The lighting model reads
// the thickness along the light by sphere tracing the field (fieldThickness) → exp(−thickness / scatter radius).
// The slot of the drawn object comes from a per-object uniform (onObjectUpdate) – SSS meshes are never batched
// (toon.js sets noBatch), the field lives in the geometry's own space (positionLocal, modelWorldMatrixInverse).
import * as THREE from 'three/webgpu';
import { uniform, texture3D, vec3, Fn, Loop, int, max, min, clamp, length, If, Break, positionLocal, positionWorld, cameraPosition, modelWorldMatrixInverse, vec4, normalize, select } from 'three/tsl';

export const FIELD_RES = 64;
export const FIELD_SLOTS = 8;

const atlas = new THREE.Storage3DTexture(FIELD_RES, FIELD_RES, FIELD_RES * FIELD_SLOTS);
atlas.type = THREE.HalfFloatType;   // rgba16float: writable from a compute shader and filterable
atlas.minFilter = atlas.magFilter = THREE.LinearFilter;
atlas.wrapS = atlas.wrapT = atlas.wrapR = THREE.ClampToEdgeWrapping;
export const SSS_ATLAS = atlas;

const fields = new Map();   // source geometry → { slot, min: Vector3, size: Vector3, ready, used }
let useCounter = 0;
const sourceOf = geometry => geometry?.userData?.lodSource ?? geometry;   // LOD cuts share the source's space

// per object: (box min, slot) and (box size, 1 = field ready) – read before each draw
const fieldA = uniform(new THREE.Vector4(0, 0, 0, -1)).onObjectUpdate(({ object }) => {
    const f = fields.get(sourceOf(object.geometry));
    return f?.ready ? fieldA.value.set(f.min.x, f.min.y, f.min.z, f.slot) : fieldA.value.set(0, 0, 0, -1);
});
const fieldB = uniform(new THREE.Vector4(1, 1, 1, 0)).onObjectUpdate(({ object }) => {
    const f = fields.get(sourceOf(object.geometry));
    return f?.ready ? fieldB.value.set(f.size.x, f.size.y, f.size.z, 1) : fieldB.value.set(1, 1, 1, 0);
});

/** this object's field is ready (1) or not (0) – the lighting model falls back to the constant approximation */
export const fieldReady = fieldB.w;

const atlasNode = texture3D(atlas);
// signed distance (geometry units) at a point of the geometry's space; far outside the box: its distance to the box
export const fieldDistance = Fn(([p]) => {
    const h = 0.5 / FIELD_RES;
    const local = p.sub(fieldA.xyz).div(fieldB.xyz).toVar();
    const inBox = clamp(local, h, 1 - h);
    const w = inBox.z.add(fieldA.w).div(FIELD_SLOTS);
    const d = atlasNode.sample(vec3(inBox.x, inBox.y, w)).level(0).r;
    return d.add(length(local.sub(inBox).mul(fieldB.xyz)));
});

/**
 * Distance travelled inside the object from point p (on the surface, geometry space) along dir (normalised) until it
 * is left – sphere tracing through the field: inside, |distance| is a safe step. At most `maxDistance`.
 */
export function fieldThickness(p, dir, maxDistance, steps = 12) {
    return Fn(() => {
        const voxel = max(max(fieldB.x, fieldB.y), fieldB.z).div(FIELD_RES).toVar();
        const t = voxel.mul(0.75).toVar();   // start just inside (the surface lies within a voxel)
        Loop({ start: int(0), end: int(steps) }, () => {
            const d = fieldDistance(p.add(dir.mul(t)));
            If(d.greaterThan(voxel.mul(-0.25)).or(t.greaterThan(maxDistance)), () => { Break(); });
            t.addAssign(max(d.negate(), voxel.mul(0.5)));
        });
        return min(t, maxDistance);
    })();
}

/**
 * Field wanted for this mesh's geometry (an SSS material is on it). Returns true when a new field has to be built –
 * the caller then runs build() (sss-sdf.js) on the returned job.
 */
export function requestField(mesh) {
    const geometry = sourceOf(mesh.geometry);
    if (!geometry?.attributes?.position) return null;
    let f = fields.get(geometry);
    if (f) { f.used = ++useCounter; return null; }
    // a free slot or the least recently used one
    const taken = new Map([...fields.values()].map(e => [e.slot, e]));
    let slot = [...Array(FIELD_SLOTS).keys()].find(s => !taken.has(s));
    if (slot === undefined) {
        const oldest = [...fields.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        slot = oldest[1].slot;
        fields.delete(oldest[0]);
    }
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox.clone();
    const size = box.getSize(new THREE.Vector3());
    const pad = Math.max(size.x, size.y, size.z) * 0.04 + 1e-6;
    box.expandByScalar(pad);
    f = { slot, min: box.min.clone(), size: box.getSize(new THREE.Vector3()), ready: false, used: ++useCounter };
    fields.set(geometry, f);
    return { geometry, field: f };
}

/** forget all fields (model replaced) */
export function clearFields() {
    fields.clear();
}

/** the per-object uniforms (sss-sdf.js writes no uniforms – exported for tests) */
export const FIELD_UNIFORMS = { fieldA, fieldB };

/** ?debug view (viewer.sssThicknessView): thickness along the view ray through the object / max, red = no field */
export function debugThicknessNode(max) {
    const dirWorld = normalize(positionWorld.sub(cameraPosition));
    const dir = normalize(modelWorldMatrixInverse.mul(vec4(dirWorld, 0)).xyz);
    const t = fieldThickness(positionLocal, dir, max, 24).div(max);
    return select(fieldReady.greaterThan(0.5), vec3(t), vec3(1, 0, 0));
}

// Hair and fur in the scene (curve-build.js makes the geometry): one mesh of stand-in triangles for the path tracer
// (layer 31 – the raster camera and picking skip it, the path tracer ignores layers) and a child of line pieces for the
// raster, shaded like a hair (normal across the fibre, facing the viewer) in the colour and roughness of the mesh's
// material – drag & drop of a material onto the hair works on the mesh, the lines follow it.
//  - path tracer: the object flag rindrCurve (transform struct, astro.config.mjs rindr-curves) makes the ray test take
//    each triangle (a, b, a) as a cylinder from a to b with the radius in uv.x (curve-pt.js); the BVH boxes grow by
//    the radius (growCurveBounds)
//  - memory: curvePieceBudget() – pieces this device may hold (GPU vertex record 80 B per point, BVH, raster index)
import * as THREE from 'three/webgpu';
import { attribute, normalize, dot, vec3, vec4, float, max, sqrt, pow, uniform, positionWorld, cameraPosition, modelWorldMatrix } from 'three/tsl';
import { memoryBudget } from '../memory-budget.js';

export const CURVE_LAYER = 31;
const BYTES_PER_PIECE = 260;          // ~1.5 points × 80 B GPU record + BVH + raster line index + CPU copies

/** pieces of hair the device may hold: 30 % of the memory budget (hair scenes are mostly hair; 15 % thinned a large hair
 *  model on a 32 GB machine), at least half a million */
export const curvePieceBudget = () => Math.max(5e5, Math.floor(memoryBudget() * 0.3 / BYTES_PER_PIECE));

/**
 * Turn an imported mesh of curve pieces into hair: path tracer only, plus raster lines in its material's look.
 * @param {THREE.Mesh} mesh  geometry from curve-build.js (position, tangent, uv = radius, index a, b, a per piece)
 */
export function setupCurveMesh(mesh) {
    const geometry = mesh.geometry;
    mesh.layers.set(CURVE_LAYER);
    mesh.userData.ptCurves = true;
    mesh.castShadow = mesh.receiveShadow = false;
    if (geometry.boundsTree && !geometry.boundsTree._rindrCurves) growCurveBounds(geometry.boundsTree);
    // raster: the same points, two per piece
    const tri = geometry.index.array, pieces = tri.length / 3;
    const lineIndex = new Uint32Array(pieces * 2);
    for (let i = 0; i < pieces; i++) { lineIndex[2 * i] = tri[3 * i]; lineIndex[2 * i + 1] = tri[3 * i + 1]; }
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', geometry.getAttribute('position'));
    lineGeometry.setAttribute('tangent', geometry.getAttribute('tangent'));
    lineGeometry.setAttribute('uv', geometry.getAttribute('uv'));
    lineGeometry.setIndex(new THREE.BufferAttribute(lineIndex, 1));
    lineGeometry.boundingBox = geometry.boundingBox?.clone() ?? null;
    lineGeometry.boundingSphere = geometry.boundingSphere?.clone() ?? null;
    const look = hairRasterMaterial();
    const lines = new THREE.LineSegments(lineGeometry, look.material);
    lines.name = 'hair lines';
    lines.userData.ptHidden = true;          // the path tracer has the mesh
    lines.userData.curveLines = true;
    lines.raycast = () => {};                // millions of pieces: no picking through the lines
    lines.frustumCulled = mesh.frustumCulled;
    lines.onBeforeRender = () => look.sync(mesh.material);
    mesh.add(lines);
    return lines;
}

// raster light of the hair lines (viewer: the key light and ambient the grid volumes' preview uses – gridVolumeLight)
const HAIR_LIGHT = { ambient: uniform(new THREE.Color(0.4, 0.4, 0.4)), dir: uniform(new THREE.Vector3(0.3, 1, 0.2).normalize()), color: uniform(new THREE.Color(1, 1, 1)) };
/** every frame while hair is shown: { ambient (radiance), dir (towards the light, world), color (irradiance) } */
export function updateHairLight(light) {
    HAIR_LIGHT.ambient.value.copy(light.ambient);
    HAIR_LIGHT.dir.value.copy(light.dir);
    HAIR_LIGHT.color.value.copy(light.color);
}

// raster look of hair lines (a preview – HQ traces the real fibres): Kajiya-Kay – diffuse after the angle between fibre
// and light, a highlight band where the half vector stands across the fibre (width from the roughness), the ambient
// part, both dimmed for the hairs shading each other (the lines know no neighbours – fully lit they glowed); each hair
// lighter or darker (uv.y). Unlit line material: the lit standard material gave a flat sheet
function hairRasterMaterial() {
    const color = uniform(new THREE.Color(0.5, 0.5, 0.5)), roughness = uniform(0.5);
    const material = new THREE.LineBasicNodeMaterial();
    const T = normalize(modelWorldMatrix.mul(vec4(attribute('tangent').xyz, 0)).xyz);
    const V = normalize(cameraPosition.sub(positionWorld));
    const L = HAIR_LIGHT.dir;
    const across = t => sqrt(max(float(1).sub(t.mul(t)), 0));
    const H = normalize(L.add(V));
    const exponent = float(2).div(max(roughness.mul(roughness), 0.002));
    const strand = attribute('uv').y.mul(0.6).add(0.4);
    const SELF_SHADOW = 0.8;
    // the hair colour is what light shows after many passes through fibres; the lines see it once – brighter for the
    // preview (HQ of blond hair came out about the square root of its colour)
    const base = pow(color, vec3(0.5)).mul(strand);
    const diffuse = base.mul(HAIR_LIGHT.color).mul(across(dot(T, L))).mul(1 / Math.PI);
    const specular = HAIR_LIGHT.color.mul(pow(across(dot(T, H)), exponent)).mul(exponent.add(2).div(8 * Math.PI)).mul(0.04);
    material.colorNode = diffuse.add(base.mul(HAIR_LIGHT.ambient)).mul(SELF_SHADOW).add(specular);
    material.userData.noBatch = true;
    return {
        material,
        sync(src) {
            if (!src) return;
            if (src.color) color.value.copy(src.color);
            if (typeof src.roughness === 'number') roughness.value = Math.min(Math.max(src.roughness, 0.05), 1);
        },
    };
}

/**
 * BVH boxes of a curve geometry grown by the radius of their pieces (uv.x of both ends) – the BVH holds the axes only,
 * the ray test hits the cylinders around them. Same node layout as wool-bounds.js (post-order over the packed roots).
 */
export function growCurveBounds(bvh) {
    const geometry = bvh.geometry;
    const pos = geometry.attributes.position, uv = geometry.attributes.uv, index = geometry.index;
    if (!pos || !uv || !index || !bvh._roots) return;
    const indirect = bvh._indirectBuffer ?? null;
    const box = new Float64Array(6);
    for (const root of bvh._roots) {
        const f32 = new Float32Array(root), u32 = new Uint32Array(root), u16 = new Uint16Array(root);
        const visit = n32 => {
            if (u16[n32 * 2 + 15] === 0xffff) {
                box.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
                const offset = u32[n32 + 6], count = u16[n32 * 2 + 14];
                for (let t = offset; t < offset + count; t++) {
                    const tri = indirect ? indirect[t] : t;
                    const a = index.getX(tri * 3), b = index.getX(tri * 3 + 1);
                    const r = Math.max(uv.getX(a), uv.getX(b));
                    for (const v of [a, b]) {
                        const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
                        box[0] = Math.min(box[0], x - r); box[1] = Math.min(box[1], y - r); box[2] = Math.min(box[2], z - r);
                        box[3] = Math.max(box[3], x + r); box[4] = Math.max(box[4], y + r); box[5] = Math.max(box[5], z + r);
                    }
                }
                for (let i = 0; i < 6; i++) f32[n32 + i] = box[i];
                return;
            }
            const left = n32 + 8, right = n32 + u32[n32 + 6] * 8;
            visit(left);
            visit(right);
            for (let i = 0; i < 3; i++) {
                f32[n32 + i] = Math.min(f32[left + i], f32[right + i]);
                f32[n32 + 3 + i] = Math.max(f32[left + 3 + i], f32[right + 3 + i]);
            }
        };
        visit(0);
    }
    bvh._rindrCurves = true;
}

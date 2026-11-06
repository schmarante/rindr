// The scene as one GLB file (glTF 2.0 binary – user, Nov. 2026: a GLB package of the current scene, model and materials
// in one file): the visible models with their node tree and names, materials as glTF PBR with the extensions three.js
// writes (clearcoat, transmission, volume, IOR, specular, sheen, iridescence, anisotropy, dispersion, emissive strength),
// textures (the baked node graphs too), repeated parts as instances (EXT_mesh_gpu_instancing), optionally the camera.
// In metres (glTF) – the scene is in mm: the scale sits on each model's top node, the meshes keep their buffers.
// three.js' GLTFExporter does the writing; it reads only the classic materials, so every material is turned into a
// MeshPhysicalMaterial here, and pictures it can draw (8-bit data → canvas).
//
// The tree as glTF tools expect it (and as RINDR reads it back: the same part paths): a part with one surface = one node
// with its mesh, a part with several surfaces = one mesh with a primitive per surface (merged – the surfaces of a part
// share their transform), the file's unnamed root node folded into the top node. Tangents only for normal maps and
// anisotropy (zero vectors on degenerate triangles replaced – invalid in glTF), normals of unit length.
//
// What glTF cannot hold comes back as warnings (codes, material/part names): special materials (cloud, wool, grass,
// hair, soap film, marble, toon) as plain ones, subsurface scattering, rounded edges, hair fibres, Gaussian splats, grid
// volumes, animation (the pose shown), textures it cannot read (compressed, float). Not part of the file: lights (a
// viewer lights a glTF itself – the studio's default lights would light it twice), the environment, the section plane
// and the render settings.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MM_TO_M = 0.001;
// geometry attributes glTF knows (the rest – our own helper attributes – stays out)
const ATTRIBUTES = ['position', 'normal', 'uv', 'uv1', 'color'];   // (+ tangent where a material needs it)
// plain values and colours carried over to the MeshPhysicalMaterial (same names on RindrMaterial)
const VALUES = ['metalness', 'roughness', 'emissiveIntensity', 'opacity', 'transparent', 'alphaTest', 'side', 'clearcoat', 'clearcoatRoughness',
    'transmission', 'ior', 'sheen', 'sheenRoughness', 'iridescence', 'iridescenceIOR', 'iridescenceThicknessMinimum', 'iridescenceThicknessMaximum',
    'specularIntensity', 'anisotropy', 'anisotropyRotation', 'dispersion', 'aoMapIntensity', 'vertexColors', 'flatShading'];
const COLORS = ['color', 'emissive', 'attenuationColor', 'sheenColor', 'specularColor'];
const MAPS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'clearcoatMap', 'clearcoatRoughnessMap',
    'clearcoatNormalMap', 'transmissionMap', 'thicknessMap', 'sheenColorMap', 'sheenRoughnessMap', 'iridescenceMap', 'iridescenceThicknessMap',
    'specularIntensityMap', 'specularColorMap', 'anisotropyMap'];
const SPECIAL = [['cloud', m => m.userData.cloud], ['wool', m => m.userData.wool], ['grass', m => m.userData.grass], ['hair', m => m.userData.hair],
    ['soap', m => m.soap], ['marble', m => m.marble], ['toon', m => m.toon || m.flat]];

/**
 * @param {object} input
 *   models: [{ root, name, volumes, splats, animated }] – the loaded models (viewer.js runtimeModels: root, file name;
 *     how many grid volumes, whether splats / animation clips belong to it), camera: a THREE camera to add (null: none)
 * @returns {Promise<{ file: Blob, warnings: { code: string, names?: string[] }[] }>}
 */
export async function exportGlb({ models, camera = null }) {
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const warn = new Map();   // code → Set of names
    const note = (code, n) => { if (!warn.has(code)) warn.set(code, new Set()); if (n) warn.get(code).add(n); };
    const ctx = { materials: new Map(), pictures: new Map(), normals: new Map(), note };
    const scene = new THREE.Scene();
    const toMetres = new THREE.Matrix4().makeScale(MM_TO_M, MM_TO_M, MM_TO_M);
    for (const { root, name, volumes = 0, splats = false, animated = false } of models) {
        if (!root || !isShown(root)) continue;
        if (volumes) note('volumes', name);
        if (splats) note('splats', name);
        if (animated) note('animation', name);
        root.updateWorldMatrix(true, true);
        // the model's place in metres; the file's unnamed root node(s) folded in
        const placed = toMetres.clone().multiply(root.matrixWorld);
        let from = root;
        for (let c = from.children[0]; from.children.length === 1 && c.visible && !c.isMesh && !c.name && c.children.length; c = from.children[0]) {
            from = c;
            placed.multiply(c.matrix);
        }
        const kids = from.children.map(c => copyTree(c, ctx)).filter(Boolean);
        if (!kids.length) continue;
        let top;
        if (kids.length === 1) {
            top = kids[0];
            place(top, placed.multiply(top.matrix));
        } else {
            top = new THREE.Group();
            top.name = name || 'model';
            place(top, placed);
            top.add(...kids);
        }
        scene.add(top);
    }
    // the camera in metres (glTF: no scale on a camera's node; near/far in its units)
    if (camera) {
        camera.updateWorldMatrix(true, false);
        const cam = camera.clone(false);
        cam.name = 'camera';
        camera.matrixWorld.decompose(cam.position, cam.quaternion, new THREE.Vector3());
        cam.position.multiplyScalar(MM_TO_M);
        cam.scale.set(1, 1, 1);
        cam.near *= MM_TO_M;
        cam.far *= MM_TO_M;
        if (cam.isOrthographicCamera) for (const k of ['left', 'right', 'top', 'bottom']) cam[k] *= MM_TO_M;
        cam.updateProjectionMatrix();
        scene.add(cam);
    }
    scene.updateMatrixWorld(true);
    let data;
    try {
        data = await new GLTFExporter().parseAsync(scene, { binary: true, trs: true, onlyVisible: true, maxTextureSize: 4096 });
    } finally {
        for (const m of ctx.materials.values()) m.dispose();
        for (const [t, out] of ctx.pictures) if (out && out !== t) out.dispose();   // the canvas copies (the material's own textures stay)
    }
    const warnings = [...warn].map(([code, names]) => ({ code, ...(names.size ? { names: [...names] } : {}) }));
    return { file: new Blob([data], { type: 'model/gltf-binary' }), warnings };
}

// an object of the model and what lies below it, as plain three.js objects for the exporter (null: left out)
function copyTree(o, ctx) {
    // hidden / deleted parts (Scene Graph); while an animation plays, its puppet stands in for our meshes (animation.js)
    // – they keep the pose of the last stop
    if (o.userData.animationPuppet) return null;
    if (!o.visible && o.userData.liveHidden !== 'shown') return null;
    if (o.isLine || o.isLineSegments || o.isPoints || o.isSprite || o.isLight || o.isCamera) return null;
    if (o.userData.ptCurves || o.userData.curveLines) { ctx.note('hair'); return null; }
    if (o.isSplat) { ctx.note('splats'); return null; }
    if (o.userData.gridVolumeProxy) return null;
    if (o.isMesh && o.geometry?.attributes?.position) {
        const out = copyMesh(o, ctx);
        for (const c of o.children) { const k = copyTree(c, ctx); if (k) out.add(k); }
        return out;
    }
    // a node of the model (RINDR's tree: nodes are groups; the meshes directly below a node are its surfaces, groups
    // below it its sub-parts)
    const surfaces = [], parts = [];
    for (const c of o.children) {
        const k = copyTree(c, ctx);
        if (k) (c.isMesh && !k.children.length ? surfaces : parts).push(k);
    }
    if (!surfaces.length && !parts.length) return null;   // only helpers or hidden parts below it
    // the node carries its surfaces: one mesh (several merged into one with a primitive each), its sub-parts below it –
    // placed relative to the mesh's own transform
    const mesh = surfaces.length === 1 ? surfaces[0] : surfaces.length > 1 ? mergeSurfaces(surfaces) : null;
    if (mesh && (!parts.length || Math.abs(mesh.matrix.determinant()) > 1e-20)) {
        if (parts.length) {
            const inverse = mesh.matrix.clone().invert();
            for (const k of parts) place(k, k.matrix.clone().premultiply(inverse));
            mesh.add(...parts);
        }
        place(mesh, mesh.matrix.clone().premultiply(o.matrix));
        // copies: without the count RINDR adds to the name (import.mesh.instancedObject – a reader counts again)
        mesh.name = (mesh.isInstancedMesh ? o.name.replace(/ \([\d.,\s\u00a0\u202f]+×\)$/, '') : o.name) || mesh.name;
        return mesh;
    }
    const out = new THREE.Group();
    out.add(...(mesh ? [mesh] : surfaces), ...parts);   // (surfaces that could not be merged: nodes of their own)
    out.name = o.name;
    place(out, o.matrix);
    return out;
}

function copyMesh(o, ctx) {
    const sources = [o.material].flat();
    // mm per unit of the mesh: glTF's volume thickness is given in the mesh's own units (the scene is in mm)
    o.updateWorldMatrix(true, false);
    const unit = o.matrixWorld.getMaxScaleOnAxis() || 1;
    const material = Array.isArray(o.material) ? o.material.map(m => physical(m, unit, ctx)) : physical(o.material, unit, ctx);
    // tangents only where a material needs them (normal maps, anisotropy)
    const tangents = sources.some(m => m?.normalMap || m?.clearcoatNormalMap || m?.anisotropy > 0);
    const geometry = plainGeometry(o.geometry, ctx, tangents);
    let out;
    if (o.isInstancedMesh) {
        out = new THREE.InstancedMesh(geometry, material, o.count);
        out.instanceMatrix.array.set(o.instanceMatrix.array.subarray(0, o.count * 16));
        if (o.instanceColor) out.instanceColor = o.instanceColor.clone();
    } else {
        out = new THREE.Mesh(geometry, material);
        if (o.morphTargetInfluences && geometry.morphAttributes.position) {
            out.morphTargetInfluences = [...o.morphTargetInfluences];
            out.morphTargetDictionary = { ...o.morphTargetDictionary };
        }
    }
    out.name = o.name;
    place(out, o.matrix);
    return out;
}

// the surfaces of one part as one mesh with a primitive each – when they lie alike and carry the same attributes
// (otherwise null: they stay nodes of their own)
function mergeSurfaces(meshes) {
    const [first] = meshes;
    const g0 = first.geometry;
    const names = Object.keys(g0.attributes).sort().join();
    const compatible = meshes.every(m => {
        const g = m.geometry;
        if (m.isInstancedMesh || !m.matrix.equals(first.matrix) || Array.isArray(m.material) || g.groups.length || Object.keys(g.morphAttributes).length) return false;
        if (Object.keys(g.attributes).sort().join() !== names || !!g.index !== !!g0.index) return false;
        return Object.entries(g.attributes).every(([k, a]) => {
            const b = g0.attributes[k];
            return !a.isInterleavedBufferAttribute && !b.isInterleavedBufferAttribute && a.itemSize === b.itemSize && a.normalized === b.normalized && a.array.constructor === b.array.constructor;
        });
    });
    if (!compatible) return null;
    const geometry = mergeGeometries(meshes.map(m => m.geometry), true);
    if (!geometry) return null;
    const out = new THREE.Mesh(geometry, meshes.map(m => m.material));
    place(out, first.matrix);
    return out;
}

// the transform of `matrix` as position / rotation / scale (the exporter writes TRS)
function place(object, matrix) {
    matrix.decompose(object.position, object.quaternion, object.scale);
    object.updateMatrix();
}

// the geometry with the attributes glTF knows (the buffers are shared – only normals/tangents glTF would not accept are
// copied)
function plainGeometry(g, ctx, tangents) {
    const out = new THREE.BufferGeometry();
    for (const name of ATTRIBUTES) if (g.attributes[name]) out.setAttribute(name, name === 'normal' ? unitNormals(g.attributes.normal, ctx) : g.attributes[name]);
    if (tangents && g.attributes.tangent?.itemSize === 4 && out.attributes.normal) out.setAttribute('tangent', validTangents(g.attributes.tangent, out.attributes.normal, ctx));
    if (g.index) out.setIndex(g.index);
    for (const name of ['position', 'normal']) if (g.morphAttributes?.[name]?.length) out.morphAttributes[name] = g.morphAttributes[name];
    out.morphTargetsRelative = g.morphTargetsRelative;
    out.groups = g.groups.map(x => ({ ...x }));
    out.name = g.name;
    return out;
}

// glTF wants normals of unit length (floats): quantized or not quite normalized ones as a float copy (once per attribute
// – the exporter would copy them as well, with a warning each)
function unitNormals(a, ctx) {
    if (ctx.normals.has(a)) return ctx.normals.get(a);
    const v = new THREE.Vector3();
    let ok = a.array instanceof Float32Array && !a.isInterleavedBufferAttribute;
    for (let i = 0; ok && i < a.count; i++) if (Math.abs(v.fromBufferAttribute(a, i).length() - 1) > 0.0005) ok = false;
    let out = a;
    if (!ok) {
        const arr = new Float32Array(a.count * 3);
        for (let i = 0; i < a.count; i++) {
            v.fromBufferAttribute(a, i);
            if (v.lengthSq() > 0) v.normalize(); else v.set(0, 0, 1);
            v.toArray(arr, i * 3);
        }
        out = new THREE.BufferAttribute(arr, 3);
    }
    ctx.normals.set(a, out);
    return out;
}

// tangents as glTF wants them (unit length, w = ±1): degenerate ones (zero vectors where the UVs collapse) replaced by
// any direction across the normal – a float copy only when needed
function validTangents(a, normals, ctx) {
    if (ctx.normals.has(a)) return ctx.normals.get(a);
    const t = new THREE.Vector3(), n = new THREE.Vector3();
    const good = i => Math.abs(t.fromBufferAttribute(a, i).length() - 1) <= 0.0005 && Math.abs(Math.abs(a.getW(i)) - 1) <= 0.0005;
    let ok = a.array instanceof Float32Array && !a.isInterleavedBufferAttribute;
    for (let i = 0; ok && i < a.count; i++) if (!good(i)) ok = false;
    let out = a;
    if (!ok) {
        const arr = new Float32Array(a.count * 4);
        for (let i = 0; i < a.count; i++) {
            t.fromBufferAttribute(a, i);
            if (t.lengthSq() > 1e-12) t.normalize();
            else {
                n.fromBufferAttribute(normals, i);
                t.set(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0).cross(n).normalize();
                if (t.lengthSq() === 0) t.set(1, 0, 0);
            }
            t.toArray(arr, i * 4);
            arr[i * 4 + 3] = a.getW(i) < 0 ? -1 : 1;
        }
        out = new THREE.BufferAttribute(arr, 4);
    }
    ctx.normals.set(a, out);
    return out;
}

// a RINDR material → MeshPhysicalMaterial (once per material – lengths for the units of its first mesh)
function physical(m, unit, ctx) {
    if (!m) {
        if (!ctx.materials.has(null)) ctx.materials.set(null, new THREE.MeshPhysicalMaterial());
        return ctx.materials.get(null);
    }
    let p = ctx.materials.get(m);
    if (p) return p;
    p = new THREE.MeshPhysicalMaterial();
    p.name = m.name || '';
    for (const k of VALUES) if (m[k] !== undefined && typeof m[k] !== 'object') p[k] = m[k];
    for (const k of COLORS) if (m[k]?.isColor) p[k].copy(m[k]);
    // lengths: RINDR in mm; glTF: the thickness in the mesh's units, the attenuation distance in world units (m)
    if (m.thickness > 0) p.thickness = m.thickness / unit;
    if (Number.isFinite(m.attenuationDistance)) p.attenuationDistance = m.attenuationDistance * MM_TO_M;
    if (m.normalScale?.isVector2) p.normalScale.copy(m.normalScale);
    if (m.clearcoatNormalScale?.isVector2) p.clearcoatNormalScale.copy(m.clearcoatNormalScale);
    for (const k of MAPS) {
        if (!m[k]?.isTexture) continue;
        const t = picture(m[k], ctx);
        if (t) p[k] = t; else ctx.note('texture', m.name);
    }
    // what glTF cannot hold
    if (SPECIAL.some(([, test]) => test(m))) ctx.note('special', m.name);
    if (m.subsurface) ctx.note('subsurface', m.name);
    if (m.edges) ctx.note('edges', m.name);
    ctx.materials.set(m, p);
    return p;
}

// a texture the exporter can read: images as they are, 8-bit data as a canvas (the exporter draws metalness/roughness
// and normal maps with drawImage – no raw data there); compressed or float data: null
function picture(t, ctx) {
    if (ctx.pictures.has(t)) return ctx.pictures.get(t);
    const img = t.image;
    let out = null;
    if (t.isCompressedTexture || t.isVideoTexture || !img) out = null;
    else if (img.data) {
        if ((img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) && t.format === THREE.RGBAFormat && img.width > 0 && img.height > 0) {
            const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1);
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4).slice(), img.width, img.height), 0, 0);
            out = t.clone();
            out.source = new THREE.TextureSource(canvas);
        }
    } else if (img.width > 0 || img.naturalWidth > 0) out = t;
    ctx.pictures.set(t, out);
    return out;
}

function isShown(o) {
    for (let c = o; c; c = c.parent) if (!c.visible) return false;
    return true;
}

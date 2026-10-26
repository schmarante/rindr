// C4D scene (c4d-parse.js, from the worker) → a three.js object tree like the loaders give it: groups, bones, (skinned)
// meshes and an animation clip – mesh-importer.js converts it like FBX/glTF (animation puppet, skeleton view, play bar).
//
// Coordinates: C4D is left-handed with Y up – mirrored on Z (points (x, y, −z), matrices F·M·F). The local matrix of an
// object is T(position) · Ry(−H) · Rx(−P) · Rz(−B) · S(scale) in C4D's coordinates (found against the joints' bind
// matrices of the weight tag: all joints that do not move match exactly) – mirrored (F·R·F turns the rotations about
// Y and X around, the one about Z stays): Euler(P, H, −B, 'YXZ') with the position (x, y, −z).
// Units: the project unit (metres per unit from the document) → mm.
// Skinning: C4D deforms a point as Σ w · joint (global) · bind⁻¹ · mesh at binding · point – three.js' attached skinning
// computes the same with boneInverses = bind⁻¹ and bindMatrix = the mesh at binding (both from the weight tag). The
// weight tag stores a joint in C4D's bone convention: Z along the bone, pointing away from the first child joint, Y = the
// joint's own Y made perpendicular (mirrored space) – a joint whose children lie along its X (a rig from another
// program) differs from it by 90°; skinned with the object matrix that turned every part about its bone. bind · A⁻¹
// (A = that alignment, from the child's local position) is the joint's matrix at binding: checked on the test rig – all
// 88 joints of the stored pose exactly on it, edge lengths of the skinned mesh 1 ± 0.003 (99 %).
import * as THREE from 'three/webgpu';

const T_POLYGON = 5100, T_CAMERA = 5103, T_JOINT = 1019362, T_SKIN = 1019363;
const P_POSITION = 903, P_ROTATION = 904, P_SCALE = 905;
const _e = new THREE.Euler(), _q = new THREE.Quaternion();

// C4D matrix (offset, v1, v2, v3) → three.js (mirrored on Z)
const F = new THREE.Matrix4().makeScale(1, 1, -1);
function fromC4d(m) {
    return new THREE.Matrix4().set(m[3], m[6], m[9], m[0], m[4], m[7], m[10], m[1], m[5], m[8], m[11], m[2], 0, 0, 0, 1)
        .premultiply(F).multiply(F);
}
// Rotation orders (last value of the transform chunk): 6 HPB – the vector is (H, P, B); 0…5 the global orders YXZ, YZX,
// ZYX, ZXY, XZY, XYZ – the vector is (x, y, z), rotated about the world axes in that order (a scene from another program
// had XYZ: read as HPB a group turned about Y instead of X, the phones lay flat). An axis turns by −angle in C4D's
// coordinates (HPB: Ry(−H)·Rx(−P)·Rz(−B)); mirrored the rotations about Y and X change sign, the one about Z not →
// Euler(x, y, −z) with the order reversed for the global orders (three.js applies its order's last axis first).
const GLOBAL_ORDERS = ['ZXY', 'XZY', 'XYZ', 'YXZ', 'YZX', 'ZYX'];   // three.js orders of C4D's 0…5
function rotationQuaternion(r, order = 6, out = new THREE.Quaternion()) {
    if (order === 6 || !GLOBAL_ORDERS[order]) return out.setFromEuler(_e.set(r[1], r[0], -r[2], 'YXZ'));
    return out.setFromEuler(_e.set(r[0], r[1], -r[2], GLOBAL_ORDERS[order]));
}

function applyLocal(obj, t) {
    if (!t) return;
    obj.position.set(t.position[0], t.position[1], -t.position[2]);
    rotationQuaternion(t.rotation, t.order, obj.quaternion);
    obj.scale.set(...t.scale);
}

/**
 * @param {object} scene  parseC4d() result
 * @param {THREE.LoadingManager} manager  resolves texture file names (dropped files / next to the model)
 * @returns {{ object: THREE.Group, cameras: { name, object, target, fov }[], unsupported: object[] }}
 */
export function buildC4d(scene, manager, name = '') {
    const root = new THREE.Group();
    root.name = name;
    const loader = new THREE.TextureLoader(manager);
    const textures = new Map();
    // C4D looks for textures in "tex" next to the scene; dropped files are found by their name anyway
    const texture = (file, srgb) => {
        if (!file) return null;
        const key = file + (srgb ? '|s' : '');
        if (!textures.has(key)) {
            const path = /[\\/]/.test(file) ? file.replace(/\\/g, '/') : `tex/${file}`;
            const tex = loader.load(path);
            if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            textures.set(key, tex);
        }
        return textures.get(key);
    };
    // the program's own materials and those of render plugins (kind: diffuse, glossy, specular = glass, metallic,
    // universal – c4d-parse.js): colour, texture, normal map, roughness, metal, transmission, emission
    const materials = scene.materials.map(m => {
        const glass = m.kind === 'specular';
        const mat = glass ? new THREE.MeshPhysicalMaterial({ name: m.name, transmission: 1, thickness: 0, ior: Math.min(Math.max(m.ior ?? 1.5, 1), 2.333) })
            : new THREE.MeshStandardMaterial({ name: m.name });
        mat.metalness = m.kind === 'metallic' ? 1 : 0;
        mat.roughness = Math.min(Math.max(m.roughness ?? (m.kind === 'diffuse' ? 0.8 : m.kind ? 0.3 : 0.6), 0), 1);
        if (m.color) mat.color.setRGB(...m.color, THREE.SRGBColorSpace);
        const map = texture(m.colorMap, true);
        if (map) { mat.map = map; mat.color.set(0xffffff); }
        const normal = texture(m.normalMap, false);
        if (normal) mat.normalMap = normal;
        const bump = texture(m.bumpMap, false);
        if (bump) mat.bumpMap = bump;
        const glow = texture(m.emissionMap, true);
        if (glow) { mat.emissiveMap = glow; mat.emissive.set(0xffffff); }
        return mat;
    });
    const fallback = new THREE.MeshStandardMaterial({ name: 'Standard', color: 0xb0b0b0, roughness: 0.5 });

    // objects in file order (parents before children)
    const nodes = new Array(scene.objects.length).fill(null);
    const cameras = [];
    for (const o of scene.objects) {
        if (o.typeId === T_SKIN) continue;   // the deformer: the weights of its mesh do the work
        let node;
        if (o.typeId === T_JOINT) node = new THREE.Bone();
        else if (o.typeId === T_POLYGON) node = buildMesh(o, scene, materials, fallback);
        else if (o.typeId === T_CAMERA) {
            node = new THREE.Group();
            const fov = THREE.MathUtils.radToDeg(2 * Math.atan(o.camera.aperture / 2 / Math.max(o.camera.focal, 1e-6)));
            cameras.push({ name: o.name, object: node, target: o.tags.find(t => t.kind === 'target')?.target ?? -1, fov });
        } else node = new THREE.Group();
        node.name = o.name;
        applyLocal(node, o.transform);
        // switched off for rendering (or in the editor while rendering follows it): not shown – children neither
        const t = o.transform;
        if (t && (t.render === 1 || (t.render === 2 && t.editor === 1))) node.visible = false;
        node.userData.c4dType = o.typeName;
        nodes[o.index] = node;
        let parent = o.parent;
        while (parent >= 0 && !nodes[parent]) parent = scene.objects[parent].parent;
        (parent >= 0 ? nodes[parent] : root).add(node);
    }
    for (const c of cameras) c.target = c.target >= 0 ? nodes[c.target] : null;

    // skinning: bones = the weight tag's joints in its order
    for (const o of scene.objects) {
        const mesh = nodes[o.index];
        if (!mesh?.isSkinnedMesh) continue;
        const w = o.tags.find(t => t.kind === 'weights');
        const bones = w.joints.map(j => (nodes[j.object]?.isBone ? nodes[j.object] : new THREE.Bone()));
        const inverses = w.joints.map(j => fromC4d(j.bind).multiply(boneAlignment(scene, j.object).invert()).invert());
        mesh.bind(new THREE.Skeleton(bones, inverses), w.geomMatrix ? fromC4d(w.geomMatrix) : new THREE.Matrix4());
    }
    root.animations = buildClip(scene, nodes);
    return { object: root, cameras, unsupported: scene.unsupported, scale: (scene.unitMeters || 0.01) * 1000 };
}

// C4D's bone frame of a joint relative to its own: Z' = −(direction to the first child joint), Y' = its Y made
// perpendicular, X' = Y' × Z' (mirrored space); a joint without child joints: its own frame
function boneAlignment(scene, index) {
    const child = scene.objects.find(o => o.parent === index && o.typeId === T_JOINT && o.transform);
    if (!child) return new THREE.Matrix4();
    const p = child.transform.position;
    const z = new THREE.Vector3(p[0], p[1], -p[2]);
    if (z.lengthSq() < 1e-12) return new THREE.Matrix4();
    z.normalize().negate();
    let y = new THREE.Vector3(0, 1, 0).addScaledVector(z, -z.y);
    if (y.lengthSq() < 1e-8) y = new THREE.Vector3(1, 0, 0).addScaledVector(z, -z.x);
    y.normalize();
    return new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, z), y, z);
}

// polygon object → Mesh / SkinnedMesh: quads split into two triangles, corners with the same point, UV and normal welded
function buildMesh(o, scene, materials, fallback) {
    const tag = kind => o.tags.find(t => t.kind === kind);
    const pts = tag('points'), polys = tag('polygons'), uvw = tag('uvw'), phong = tag('phong'), weights = tag('weights');
    const stored = tag('normals')?.normals ?? null;   // normal tag: per polygon corner, before phong
    const geometry = new THREE.BufferGeometry();
    if (!pts || !polys) return new THREE.Group();
    const P = pts.points, Q = polys.polys, UV = uvw?.uvs;
    // triangles: corner = [point, polygon, corner slot 0…3]; mirrored on Z → reversed winding
    const tri = [];
    for (let i = 0; i < polys.count; i++) {
        const a = Q[i * 4], b = Q[i * 4 + 1], c = Q[i * 4 + 2], d = Q[i * 4 + 3];
        tri.push(i, 0, a, i, 2, c, i, 1, b);
        if (c !== d) tri.push(i, 0, a, i, 3, d, i, 2, c);
    }
    const nTri = tri.length / 9;
    // positions mirrored
    const pos = new Float32Array(pts.count * 3);
    for (let i = 0; i < pts.count; i++) { pos[i * 3] = P[i * 3]; pos[i * 3 + 1] = P[i * 3 + 1]; pos[i * 3 + 2] = -P[i * 3 + 2]; }
    // normals: phong without angle limit → smooth per point; with a limit → by the angle; no phong tag → flat
    const faceN = new Float32Array(nTri * 3);
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), n = new THREE.Vector3();
    for (let t = 0; t < nTri; t++) {
        va.fromArray(pos, tri[t * 9 + 2] * 3); vb.fromArray(pos, tri[t * 9 + 5] * 3); vc.fromArray(pos, tri[t * 9 + 8] * 3);
        n.subVectors(vb, va).cross(vc.sub(va));   // area-weighted
        n.toArray(faceN, t * 3);
    }
    const pointN = new Float32Array(pts.count * 3);
    if (phong && !phong.limit) {
        for (let t = 0; t < nTri; t++) for (let k = 0; k < 3; k++) {
            const p = tri[t * 9 + k * 3 + 2] * 3;
            pointN[p] += faceN[t * 3]; pointN[p + 1] += faceN[t * 3 + 1]; pointN[p + 2] += faceN[t * 3 + 2];
        }
        for (let i = 0; i < pts.count; i++) { n.fromArray(pointN, i * 3).normalize().toArray(pointN, i * 3); }
    }
    const limitCos = phong?.limit ? Math.cos(phong.angle) : 1;
    const cornerNormal = (t, p, out, poly, slot) => {
        if (stored) {
            const k = (poly * 4 + slot) * 3;
            out.set(stored[k], stored[k + 1], -stored[k + 2]);
            if (out.lengthSq() > 1e-12) return out.normalize();
        }
        if (phong && !phong.limit) return out.fromArray(pointN, p * 3);
        const own = out.fromArray(faceN, t * 3).clone().normalize();
        if (!phong) return out.copy(own);
        // angle limit: faces at this point within the angle (O(faces at the point) via a point → triangles list)
        out.set(0, 0, 0);
        for (const u of trisAt[p]) {
            n.fromArray(faceN, u * 3);
            const m = n.clone().normalize();
            if (m.dot(own) >= limitCos) out.add(n);
        }
        return out.normalize();
    };
    const trisAt = phong?.limit ? Array.from({ length: pts.count }, () => []) : null;
    if (trisAt) for (let t = 0; t < nTri; t++) for (let k = 0; k < 3; k++) { const p = tri[t * 9 + k * 3 + 2]; if (trisAt[p].at(-1) !== t) trisAt[p].push(t); }

    // welded vertices: (point, uv, normal)
    const keyOf = new Map();
    const vPos = [], vNor = [], vUv = [], vPoint = [], index = new Uint32Array(nTri * 3);
    const cn = new THREE.Vector3();
    for (let t = 0; t < nTri; t++) {
        for (let k = 0; k < 3; k++) {
            const poly = tri[t * 9 + k * 3], slot = tri[t * 9 + k * 3 + 1], p = tri[t * 9 + k * 3 + 2];
            cornerNormal(t, p, cn, poly, slot);
            const u = UV ? UV[poly * 8 + slot * 2] : 0, v = UV ? 1 - UV[poly * 8 + slot * 2 + 1] : 0;
            const key = `${p}|${u}|${v}|${cn.x.toFixed(4)}|${cn.y.toFixed(4)}|${cn.z.toFixed(4)}`;
            let vi = keyOf.get(key);
            if (vi === undefined) {
                vi = vPoint.length;
                keyOf.set(key, vi);
                vPoint.push(p);
                vPos.push(pos[p * 3], pos[p * 3 + 1], pos[p * 3 + 2]);
                vNor.push(cn.x, cn.y, cn.z);
                vUv.push(u, v);
            }
            index[t * 3 + k] = vi;
        }
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vPos, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(vNor, 3));
    if (UV) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(vUv, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    // material: the object's texture tag, else one of a parent (C4D inherits them down the hierarchy)
    let material = null;
    for (let x = o; x && !material; x = x.parent >= 0 ? scene.objects[x.parent] : null) {
        const tex = x.tags.find(tg => tg.kind === 'texture' && tg.material >= 0);
        if (tex) material = materials[tex.material];
    }
    material ??= fallback;
    if (!weights?.joints.length) return new THREE.Mesh(geometry, material);

    // skin: per point the 4 strongest joints, renormalised
    const influences = Array.from({ length: pts.count }, () => []);
    weights.joints.forEach((j, ji) => { if (j.points) j.points.forEach((p, i) => { if (p < pts.count && j.weights[i] > 0) influences[p].push(ji, j.weights[i]); }); });
    const nv = vPoint.length;
    const skinIndex = new Uint16Array(nv * 4), skinWeight = new Float32Array(nv * 4);
    for (let vi = 0; vi < nv; vi++) {
        const list = influences[vPoint[vi]];
        const pairs = [];
        for (let k = 0; k < list.length; k += 2) pairs.push([list[k], list[k + 1]]);
        pairs.sort((a, b) => b[1] - a[1]);
        const top = pairs.slice(0, 4);
        const sum = top.reduce((s, x) => s + x[1], 0) || 1;
        top.forEach(([ji, wv], k) => { skinIndex[vi * 4 + k] = ji; skinWeight[vi * 4 + k] = wv / sum; });
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
    return new THREE.SkinnedMesh(geometry, material);
}

// tracks of all objects → one clip: position / rotation (HPB) / scale per object, sampled at the keys of its tracks
// (components without a track keep the object's own value), linear between keys; times from the earliest key on
function buildClip(scene, nodes) {
    const tracks = [];
    let start = Infinity;
    for (const o of scene.objects) for (const t of o.tracks) if (t.times.length) start = Math.min(start, t.times[0]);
    for (const o of scene.objects) {
        const node = nodes[o.index];
        if (!node || !o.tracks.length) continue;
        const tr = o.transform ?? { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
        const by = (param, component) => o.tracks.find(t => t.param === param && t.component === 1000 + component) ?? null;
        for (const [param, rest] of [[P_POSITION, tr.position], [P_ROTATION, tr.rotation], [P_SCALE, tr.scale]]) {
            const comps = [0, 1, 2].map(c => by(param, c));
            if (!comps.some(Boolean)) continue;
            const times = [...new Set(comps.filter(Boolean).flatMap(c => [...c.times]))].sort((a, b) => a - b);
            const value = (c, t) => (comps[c] ? sample(comps[c], t) : rest[c]);
            const kt = new Float32Array(times.length);
            const kv = new Float32Array(times.length * (param === P_ROTATION ? 4 : 3));
            times.forEach((t, i) => {
                kt[i] = t - start;
                const x = value(0, t), y = value(1, t), z = value(2, t);
                if (param === P_POSITION) kv.set([x, y, -z], i * 3);
                else if (param === P_SCALE) kv.set([x, y, z], i * 3);
                else { rotationQuaternion([x, y, z], tr.order, _q); kv.set([_q.x, _q.y, _q.z, _q.w], i * 4); }
            });
            const property = param === P_POSITION ? 'position' : param === P_SCALE ? 'scale' : 'quaternion';
            const Track = param === P_ROTATION ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
            tracks.push(new Track(`${node.uuid}.${property}`, kt, kv));
        }
    }
    return tracks.length ? [new THREE.AnimationClip('Animation', -1, tracks)] : [];
}

// value of a track at a time: linear between its keys, held before the first / after the last
function sample({ times, values }, t) {
    if (t <= times[0]) return values[0];
    const last = times.length - 1;
    if (t >= times[last]) return values[last];
    let lo = 0, hi = last;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    const f = (t - times[lo]) / (times[hi] - times[lo] || 1);
    return values[lo] + (values[hi] - values[lo]) * f;
}

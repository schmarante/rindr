// Transform state of scene objects (xf in userData: pivot, offset, rotation, scale, explode) – undo states, apply,
// world boxes; used by the core (explode, scene files, instances) without the gizmo (transform.js comes with the
// 'transform' feature – docs/player.md "schlank").
import * as THREE from 'three/webgpu';
import { localBox } from './model-instances.js';

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _box = new THREE.Box3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);

// State for undo: model nodes via xf, lights/section plane via position + rotation
export function captureTransform(object, kind) {
    if (kind === 'selection') return object.members.map(m => captureTransform(m, 'node'));
    if (kind === 'light' || kind === 'slicer') return { position: object.position.clone(), quaternion: object.quaternion.clone() };
    const xf = object.userData.xf;
    return xf ? { offset: xf.offset.clone(), rotation: xf.rotation.clone(), scale: xf.scale.clone() } : null;
}

export function restoreTransform(object, kind, state) {
    if (!object || !state) return;
    if (kind === 'selection') {
        object.members.forEach((m, i) => restoreTransform(m, 'node', state[i]));
        return;
    }
    if (kind === 'light' || kind === 'slicer') {
        object.position.copy(state.position);
        object.quaternion.copy(state.quaternion);
        object.updateMatrixWorld();
        return;
    }
    ensureTransform(object);
    object.userData.xf.offset.copy(state.offset);
    object.userData.xf.rotation.copy(state.rotation);
    object.userData.xf.scale.copy(state.scale || _one);
    applyTransform(object);
}

export function sameTransform(a, b) {
    if (!a || !b) return a === b;
    if (Array.isArray(a)) return a.length === b.length && a.every((s, i) => sameTransform(s, b[i]));
    return a.position
        ? a.position.equals(b.position) && a.quaternion.equals(b.quaternion)
        : a.offset.equals(b.offset) && a.rotation.equals(b.rotation) && a.scale.equals(b.scale);
}

// World box of the meshes below objects (matrices up to date) – without stray objects (userData.stray, outliers.js:
// an assembly with kilometres of helper geometry would turn around a point far away); only stray ones: those. Grid
// volumes count too (userData.volumeBox of their model root, its own space – a VDB file has nothing else)
export function meshBox(objects, box) {
    for (const all of [false, true]) {
        for (const o of objects) o.traverse(c => {
            if (c.userData.volumeBox) box.union(new THREE.Box3().copy(c.userData.volumeBox).applyMatrix4(c.matrixWorld));
            if (!c.isMesh || (c.userData.stray && !all)) return;
            box.union(new THREE.Box3().copy(localBox(c)).applyMatrix4(c.matrixWorld));
        });
        if (!box.isEmpty()) break;
    }
    return box;
}

// Determine the pivot (bounding-box centre in parent space) the first time
export function ensureTransform(object) {
    if (object.userData.xf) return;
    object.updateMatrixWorld(true);
    meshBox([object], _box.makeEmpty());
    const center = _box.isEmpty() ? new THREE.Vector3() : _box.getCenter(new THREE.Vector3());
    // world -> parent space
    const pivot = center.applyMatrix4(_inv.copy(object.parent.matrixWorld).invert());
    // previous transform as initial value (groups start with identity)
    object.updateMatrix();
    _m.copy(object.matrix).decompose(_p, _q, _s);
    object.userData.xf = {
        pivot,
        offset: _p.clone().sub(pivot).add(pivot.clone().multiply(_s).applyQuaternion(_q)),
        rotation: new THREE.Euler().setFromQuaternion(_q),
        scale: _s.clone(),
        explode: new THREE.Vector3(),
        rest: object.matrix.clone(),   // matrix before any move (UV mapping projects at rest – uv-mapping.js)
    };
}

export function applyTransform(object) {
    const xf = object.userData.xf;
    xf.scale ??= new THREE.Vector3(1, 1, 1);   // older states without scale
    xf.explode ??= new THREE.Vector3();
    const { pivot, offset, rotation, scale, explode } = xf;
    _m.makeTranslation(-pivot.x, -pivot.y, -pivot.z)
        .premultiply(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z))
        .premultiply(new THREE.Matrix4().makeRotationFromEuler(rotation))
        .premultiply(new THREE.Matrix4().makeTranslation(offset.x + pivot.x + explode.x, offset.y + pivot.y + explode.y, offset.z + pivot.z + explode.z));
    object.matrixAutoUpdate = false;
    object.matrix.copy(_m);
    object.updateMatrixWorld(true);
}

// common bounding box of several objects (world)
export function worldBox(objects) {
    for (const o of objects) o.updateMatrixWorld(true);
    const box = meshBox(objects, new THREE.Box3());
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3());
    return box;
}

/**
 * three.js' TransformControls drag on an invisible plane of 100 000 units (100 m in RINDR's mm). The gizmo keeps its
 * size on screen, so in the world it grows with the camera distance: with a model of several hundred metres (an OBJ
 * read as metres although written in another unit) the camera stood ~3 km away, the arrows lay hundreds of metres from
 * the centre and the pointer's ray missed the plane – no drag started, the axis line jumped (user: "springt die weiße
 * Linie der ausgewählten Achse kurz … kann das Objekt nicht verschieben"; scaled to 0.1 it worked). 1000 km instead.
 */
export function widenDragPlane(controls) {
    const plane = controls._plane;
    if (!plane?.geometry) { console.warn('[Transform] TransformControls has no drag plane any more (three.js changed?)'); return; }
    plane.geometry.dispose();
    plane.geometry = new THREE.PlaneGeometry(1e9, 1e9, 2, 2);
}

// Skeleton of an animated/skinned model (animation.js puppet): bones as lines, joints as dots on top of everything
// (overlay scene of the gizmo – not in the path tracer, not in picking). A click on a joint (pick, in screen space)
// selects it; its own gizmo rotates it (local axes) or moves it – the skinned meshes follow (the viewer shows the
// puppet live while dragging and bakes the pose on release, like scrubbing the timeline).
//
// Bones live in the puppet below its container (scale → mm). Live the container hangs below the model root, otherwise
// it is detached – ModelAnimation.sceneMatrix gives the scene matrix in both cases. The gizmo drives a handle at the
// joint's position and orientation (without the scale); its world pose is turned back into the bone's local transform
// (parent's scene matrix⁻¹ · new pose), the bone keeps its scale.
import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const JOINT_PX = 4;          // joint radius on screen (px), the selected one larger
const PICK_PX = 10;          // a click this close to a joint selects it
const COLOR = new THREE.Color(0x38bdf8), COLOR_SELECTED = new THREE.Color(0xfbbf24);
const _m = new THREE.Matrix4(), _parent = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _v = new THREE.Vector3(), _c = new THREE.Vector3();

export class SkeletonView extends EventTarget {
    /**
     * Events: 'dragstart', 'dragend' (detail: { anim, bone }), 'edit' (detail: { anim, bone, before, after } – undo),
     * 'change' (the pose changed while dragging)
     */
    constructor(camera, domElement, overlayScene) {
        super();
        this.camera = camera;
        this.domElement = domElement;
        this.anim = null;
        this.bones = [];
        this.selected = -1;
        this.group = new THREE.Group();
        this.group.name = 'SkeletonView';
        this.group.visible = false;
        overlayScene.add(this.group);
        this.handle = new THREE.Object3D();
        overlayScene.add(this.handle);
        this.controls = new TransformControls(camera, domElement);
        this.controls.size = 0.7;
        this.controls.setMode('rotate');
        this.controls.setSpace('local');
        overlayScene.add(this.controls.getHelper());
        this._scale = new THREE.Vector3(1, 1, 1);
        this.controls.addEventListener('dragging-changed', e => {
            const bone = this.bones[this.selected];
            if (!bone) return;
            if (e.value) {
                this._before = boneState(bone);
                this.dispatchEvent(new CustomEvent('dragstart', { detail: { anim: this.anim, bone } }));
            } else {
                this.dispatchEvent(new CustomEvent('dragend', { detail: { anim: this.anim, bone } }));
                const after = boneState(bone);
                if (this._before && after.some((v, i) => v !== this._before[i])) {
                    this.dispatchEvent(new CustomEvent('edit', { detail: { anim: this.anim, bone, before: this._before, after } }));
                }
                this._before = null;
            }
        });
        this.controls.addEventListener('objectChange', () => this._fromHandle());
    }

    get visible() {
        return !!this.anim;
    }

    /** true while the mouse is over a gizmo axis or dragging */
    get busy() {
        return this.selected >= 0 && (this.controls.dragging || this.controls.axis !== null);
    }

    get dragging() {
        return this.controls.dragging;
    }

    get selectedBone() {
        return this.bones[this.selected] ?? null;
    }

    /** Show the skeleton of a ModelAnimation (null: hide) */
    show(anim) {
        if (anim === this.anim) return;
        this.hide();
        if (!anim?.bones.length) return;
        this.anim = anim;
        this.bones = anim.bones;
        const index = new Map(this.bones.map((b, i) => [b, i]));
        // one line per bone to its parent bone
        this.pairs = [];
        this.bones.forEach((b, i) => { if (index.has(b.parent)) this.pairs.push(index.get(b.parent), i); });
        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pairs.length * 3), 3));
        this.lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicNodeMaterial({ color: COLOR, depthTest: false, depthWrite: false, transparent: true, opacity: 0.8 }));
        this.lines.frustumCulled = false;
        this.lines.renderOrder = 10;
        this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }), this.bones.length);
        this.joints.frustumCulled = false;
        this.joints.renderOrder = 11;
        for (let i = 0; i < this.bones.length; i++) this.joints.setColorAt(i, COLOR);
        this.world = new Float32Array(this.bones.length * 3);
        this.group.add(this.lines, this.joints);
        this.group.visible = true;
        this.update();
    }

    hide() {
        if (!this.anim) return;
        this.select(-1);
        this.group.remove(this.lines, this.joints);
        this.lines.geometry.dispose();
        this.lines.material.dispose();
        this.joints.geometry.dispose();
        this.joints.material.dispose();
        this.joints.dispose();
        this.lines = this.joints = null;
        this.group.visible = false;
        this.anim = null;
        this.bones = [];
    }

    /** Select a joint by its index (-1: none) – the gizmo goes there */
    select(index) {
        if (this.joints && this.selected >= 0) this.joints.setColorAt(this.selected, COLOR);
        this.selected = index >= 0 && index < this.bones.length ? index : -1;
        if (this.selected < 0) { this.controls.detach(); return; }
        this.joints.setColorAt(this.selected, COLOR_SELECTED);
        this.joints.instanceColor.needsUpdate = true;
        this._toHandle();
        this.controls.attach(this.handle);
    }

    setMode(mode) {
        this.controls.setMode(mode === 'translate' ? 'translate' : 'rotate');
        this.controls.setSpace(mode === 'translate' ? 'world' : 'local');
    }

    get mode() {
        return this.controls.mode;
    }

    /** Joint under the pointer (screen distance, the nearest to the camera among close ones) or -1 */
    pick(clientX, clientY) {
        if (!this.anim) return -1;
        const rect = this.domElement.getBoundingClientRect();
        let best = -1, bestDepth = Infinity;
        for (let i = 0; i < this.bones.length; i++) {
            _v.fromArray(this.world, i * 3).project(this.camera);
            if (_v.z < -1 || _v.z > 1) continue;
            const x = rect.left + (_v.x + 1) / 2 * rect.width, y = rect.top + (1 - _v.y) / 2 * rect.height;
            if (Math.hypot(x - clientX, y - clientY) > PICK_PX) continue;
            if (_v.z < bestDepth) { bestDepth = _v.z; best = i; }
        }
        return best;
    }

    /** Per frame: joint positions, line ends, dot sizes (constant on screen), gizmo at the selected joint */
    update() {
        if (!this.anim) return;
        this.anim.updatePuppetMatrices();
        for (let i = 0; i < this.bones.length; i++) {
            _v.setFromMatrixPosition(this.anim.sceneMatrix(this.bones[i], _m));
            _v.toArray(this.world, i * 3);
        }
        const pos = this.lines.geometry.getAttribute('position');
        for (let k = 0; k < this.pairs.length; k++) pos.array.set(this.world.subarray(this.pairs[k] * 3, this.pairs[k] * 3 + 3), k * 3);
        pos.needsUpdate = true;
        // world size of a pixel at a distance: 2·tan(fov/2)·distance / height (perspective), else the view height
        const height = this.domElement.clientHeight || 1;
        this.camera.getWorldPosition(_c);
        const perPixel = this.camera.isPerspectiveCamera ? 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) / height
            : (this.camera.top - this.camera.bottom) / this.camera.zoom / height;
        for (let i = 0; i < this.bones.length; i++) {
            _v.fromArray(this.world, i * 3);
            const r = (i === this.selected ? JOINT_PX * 1.6 : JOINT_PX) * perPixel * (this.camera.isPerspectiveCamera ? _v.distanceTo(_c) : 1);
            _m.makeScale(r, r, r).setPosition(_v);
            this.joints.setMatrixAt(i, _m);
        }
        this.joints.instanceMatrix.needsUpdate = true;
        if (this.joints.instanceColor) this.joints.instanceColor.needsUpdate = true;
        if (this.selected >= 0 && !this.controls.dragging) this._toHandle();
    }

    // handle = the joint's scene pose without its scale
    _toHandle() {
        const bone = this.bones[this.selected];
        this.anim.updatePuppetMatrices();
        this.anim.sceneMatrix(bone, _m).decompose(this.handle.position, this.handle.quaternion, this._scale);
        this.handle.updateMatrixWorld(true);
    }

    // gizmo moved: the handle's pose (with the joint's scale) into the bone's local transform
    _fromHandle() {
        const bone = this.bones[this.selected];
        if (!bone) return;
        this.anim.updatePuppetMatrices();
        this.anim.sceneMatrix(bone.parent, _parent).invert();
        _m.compose(this.handle.position, this.handle.quaternion, this._scale).premultiply(_parent);
        _m.decompose(_p, _q, _s);
        bone.position.copy(_p);
        bone.quaternion.copy(_q);
        bone.updateMatrixWorld(true);
        this.dispatchEvent(new Event('change'));
    }
}

/** Local transform of a bone: [px, py, pz, qx, qy, qz, qw] */
export function boneState(bone) {
    return [...bone.position.toArray(), ...bone.quaternion.toArray()];
}

export function setBoneState(bone, state) {
    bone.position.fromArray(state, 0);
    bone.quaternion.fromArray(state, 3);
}

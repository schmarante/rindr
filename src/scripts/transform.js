// Move, rotate and scale objects: gizmo (TransformControls) + values for the properties panel.
//
// Model nodes (groups) are rotated and scaled about the centre of their bounding box:
//   matrix = T(offset + pivot) · R(rotation) · S(scale) · T(-pivot)
// offset/rotation/scale are the values shown in the panel (translation in model units, rotation in
// degrees, scale as a factor per local axis); pivot is determined once on first selection (in
// parent space). Scaling only for model nodes (not lights/section plane).
// Exploded view (explode.js): additional offset xf.explode (parent space), separate from offset –
// gizmo, panel values, undo and scene state only see offset/rotation/scale.
// Lights are moved directly via their position, the section plane via position + rotation.
// Multi-selection (kind 'selection', object.members = part groups): gizmo at the centre of the
// common bounding box; its motion since the drag started (delta in world coordinates) is applied to
// every part and converted back into its xf – i.e. rotation/scale about the common centre. Scaling
// there only uniformly (otherwise rotated parts would shear).
//
// The gizmo lives in its own overlay scene (drawn after the image) – so it shows up neither in
// the path tracer nor in picking.
import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { captureTransform, restoreTransform, ensureTransform, applyTransform, sameTransform, meshBox, worldBox, widenDragPlane } from './transform-state.js';
// the object state functions live in transform-state.js (core); kept importable from here
export { captureTransform, restoreTransform, ensureTransform, applyTransform, widenDragPlane };

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _box = new THREE.Box3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);

export class ObjectTransformer extends EventTarget {
    /**
     * Events: 'dragstart', 'dragend' (detail: { object }), 'change' (detail: { object }),
     *         'edit' (completed change, detail: { object, kind, before, after } – for undo)
     */
    // overlayScene: the overlay drawn over the picture (the viewer's – section plane handle, light helper … share it)
    constructor(camera, domElement, overlayScene = new THREE.Scene()) {
        super();
        this.overlayScene = overlayScene;
        this.handle = new THREE.Object3D();          // gizmo anchor (world coordinates)
        this.overlayScene.add(this.handle);
        this.controls = new TransformControls(camera, domElement);
        this.controls.size = 0.8;
        widenDragPlane(this.controls);
        this.overlayScene.add(this.controls.getHelper());
        this.object = null;
        this.kind = null;

        this.controls.addEventListener('dragging-changed', e => {
            // drag start: the viewer may hand in another object to drag (Shift: an instance of it – duplicate.js); the
            // original stays where it is
            if (e.value && this.object) {
                const other = this.onBeforeDrag?.(this.object, this.kind);
                if (other) this.object = other;
            }
            const { object, kind } = this;
            if (e.value) this._before = object && captureTransform(object, kind);
            if (e.value && kind === 'selection') {
                // baseline for the delta: gizmo and world matrices of the parts at drag start
                this.handle.updateMatrixWorld(true);
                this._start = { handleInv: this.handle.matrixWorld.clone().invert(), worlds: object.members.map(m => m.matrixWorld.clone()) };
            }
            this.dispatchEvent(new CustomEvent(e.value ? 'dragstart' : 'dragend', { detail: { object, kind } }));
            if (!e.value && object && this._before) this._emitEdit(this._before);
        });
        this.controls.addEventListener('objectChange', () => this._fromHandle());
    }

    /** true while the mouse is over a gizmo axis or dragging */
    get busy() {
        return this.controls.dragging || this.controls.axis !== null;
    }

    setMode(mode) {
        if (this.kind === 'light' || (this.kind === 'slicer' && mode === 'scale')) mode = 'translate';
        this.controls.setMode(mode);
    }

    get mode() {
        return this.controls.mode;
    }

    /**
     * @param {THREE.Object3D|null} object
     * @param {'node'|'model'|'light'|'slicer'|null} kind
     */
    attach(object, kind) {
        this.object = object;
        this.kind = object ? kind : null;
        if (!object || !(kind === 'node' || kind === 'model' || kind === 'light' || kind === 'slicer' || kind === 'selection')) {
            this.object = null;
            this.kind = null;
            this.controls.detach();
            return;
        }
        if (kind === 'light') this.controls.setMode('translate');
        else if (kind === 'selection') object.members.forEach(ensureTransform);
        else if (kind !== 'slicer') ensureTransform(object);
        this._toHandle();
        this.controls.attach(this.handle);
    }

    /** Current values for the panel: { position: [x,y,z], rotation: [x,y,z] in degrees, scale: [x,y,z] | null } */
    getValues() {
        const o = this.object;
        if (!o || this.kind === 'selection') return null;   // multi-selection: no individual values
        if (this.kind === 'light') return { position: o.position.toArray(), rotation: null, scale: null };
        if (this.kind === 'slicer') {
            return { position: o.position.toArray(), rotation: [o.rotation.x, o.rotation.y, o.rotation.z].map(THREE.MathUtils.radToDeg), scale: null };
        }
        const xf = o.userData.xf;
        return {
            position: xf.offset.toArray(),
            rotation: [xf.rotation.x, xf.rotation.y, xf.rotation.z].map(THREE.MathUtils.radToDeg),
            scale: xf.scale.toArray(),
        };
    }

    /** Apply values from the panel (missing components stay unchanged) */
    setValues({ position, rotation, scale }, { merge = false } = {}) {
        const o = this.object;
        if (!o) return;
        const before = captureTransform(o, this.kind);
        if (this.kind === 'selection') {
            // only "Reset": all parts to the same values
            for (const m of o.members) {
                if (position) m.userData.xf.offset.fromArray(position);
                if (rotation) m.userData.xf.rotation.set(...rotation.map(THREE.MathUtils.degToRad));
                if (scale) m.userData.xf.scale.fromArray(scale);
                applyTransform(m);
            }
        } else if (this.kind === 'light' || this.kind === 'slicer') {
            if (position) o.position.fromArray(position);
            if (rotation && this.kind === 'slicer') o.rotation.set(...rotation.map(THREE.MathUtils.degToRad));
            o.updateMatrixWorld();
        } else {
            const xf = o.userData.xf;
            if (position) xf.offset.fromArray(position);
            if (rotation) xf.rotation.set(...rotation.map(THREE.MathUtils.degToRad));
            if (scale) xf.scale.fromArray(scale.map(v => (Math.abs(v) < 1e-6 ? 1e-6 : v)));
            applyTransform(o);
        }
        this._toHandle();
        this.dispatchEvent(new CustomEvent('change', { detail: { object: o, kind: this.kind } }));
        if (!merge) this._emitEdit(before);   // merge: part of a field drag – recorded once at its end
    }

    /** Dragging a number field of the panel: one undo step from the start to the end of the drag */
    beginFieldEdit() { this._fieldBefore = this.object ? captureTransform(this.object, this.kind) : null; }
    endFieldEdit() {
        if (this._fieldBefore && this.object) this._emitEdit(this._fieldBefore);
        this._fieldBefore = null;
    }

    _emitEdit(before) {
        const { object, kind } = this;
        const after = captureTransform(object, kind);
        if (sameTransform(before, after)) return;
        this.dispatchEvent(new CustomEvent('edit', { detail: { object, kind, before, after } }));
    }

    /** Re-align the gizmo to the object after an external change (undo) */
    sync() {
        if (this.object) this._toHandle();
    }

    reset() {
        this.setValues({ position: [0, 0, 0], rotation: [0, 0, 0], scale: this.kind === 'light' || this.kind === 'slicer' ? undefined : [1, 1, 1] });
    }

    // object -> gizmo anchor
    _toHandle() {
        const o = this.object;
        if (this.kind === 'selection') {
            this.handle.position.copy(worldBox(o.members).getCenter(_p));
            this.handle.quaternion.identity();
            this.handle.scale.set(1, 1, 1);
            this.handle.updateMatrixWorld(true);
            return;
        }
        o.parent?.updateMatrixWorld(true);
        if (this.kind === 'light' || this.kind === 'slicer') {
            o.getWorldPosition(this.handle.position);
            if (this.kind === 'slicer') o.getWorldQuaternion(this.handle.quaternion);
            else this.handle.quaternion.identity();
            this.handle.scale.set(1, 1, 1);
        } else {
            const xf = o.userData.xf;
            _m.compose(_p.copy(xf.offset).add(xf.pivot).add(xf.explode), _q.setFromEuler(xf.rotation), xf.scale);
            _m.premultiply(o.parent.matrixWorld);
            _m.decompose(this.handle.position, this.handle.quaternion, this.handle.scale);
        }
        this.handle.updateMatrixWorld(true);
    }

    // gizmo anchor -> object
    _fromHandle() {
        const o = this.object;
        if (!o) return;
        this.handle.updateMatrixWorld(true);
        if (this.kind === 'selection') {
            if (!this._start) return;
            // uniform scaling only: the most changed axis applies to all
            const hs = this.handle.scale;
            if (hs.x !== hs.y || hs.y !== hs.z) {
                const u = [hs.x, hs.y, hs.z].reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a));
                hs.setScalar(u);
                this.handle.updateMatrixWorld(true);
            }
            _d.multiplyMatrices(this.handle.matrixWorld, this._start.handleInv);   // delta since drag start
            o.members.forEach((m, i) => {
                // new local matrix L = parent⁻¹ · delta · world₀ = T(t)·R·S  ->  offset = t − pivot + R·S·pivot
                _m.multiplyMatrices(_d, this._start.worlds[i]).premultiply(_inv.copy(m.parent.matrixWorld).invert());
                _m.decompose(_p, _q, _s);
                const xf = m.userData.xf;
                xf.offset.copy(_p).sub(xf.pivot).add(xf.pivot.clone().multiply(_s).applyQuaternion(_q)).sub(xf.explode);
                xf.rotation.setFromQuaternion(_q);
                xf.scale.copy(_s);
                applyTransform(m);
            });
            this.dispatchEvent(new CustomEvent('change', { detail: { object: o, kind: this.kind } }));
            return;
        }
        _inv.copy(o.parent.matrixWorld).invert();
        _m.multiplyMatrices(_inv, this.handle.matrixWorld);
        _m.decompose(_p, _q, _s);
        if (this.kind === 'light' || this.kind === 'slicer') {
            o.position.copy(_p);
            if (this.kind === 'slicer') o.quaternion.copy(_q);
            o.updateMatrixWorld();
        } else {
            const xf = o.userData.xf;
            xf.offset.copy(_p).sub(xf.pivot).sub(xf.explode);
            xf.rotation.setFromQuaternion(_q);
            xf.scale.copy(_s);
            applyTransform(o);
        }
        this.dispatchEvent(new CustomEvent('change', { detail: { object: o, kind: this.kind } }));
    }
}

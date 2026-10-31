// Helper of the selected directional light (viewer.js, the gizmo's overlay scene – drawn over everything): where the
// light stands and how its parallel rays cross the scene (user: "draw the light's cone when it is selected – to judge
// how it lies in the room"). A directional light has no cone: a ring at the light (a quarter of its distance to the
// target – fitShadows places it at twice the model size, so about the model's radius), parallel rays through to beyond
// the target, a ring where they cross the target, a centre line with an arrow head. In the light's colour.
// Point light: three rings around it (a tenth of the scene size, `size`). Spot: its cone up to the target (ring of the
// outer angle there, dimmer ring of the inner one), centre line. Area light: its outline (rectangle / ellipse) and an
// arrow along the light's direction up to the target.
import * as THREE from 'three/webgpu';

const RAYS = 8;
const RING = 48;

export class LightHelper {
    constructor() {
        this.object = new THREE.Group();
        this.object.name = 'Light helper';
        this.object.visible = false;
        const lines = opacity => new THREE.LineSegments(new THREE.BufferGeometry(),
            new THREE.LineBasicNodeMaterial({ depthTest: false, depthWrite: false, transparent: true, opacity }));
        this.axis = lines(0.95);    // centre line + arrow head + ring at the light
        this.beam = lines(0.4);     // parallel rays + ring at the target
        this.object.add(this.axis, this.beam);
        this._sig = '';
    }

    /** light: the selected light (null or ambient: hidden), size: scene size – call every frame, rebuilds only on change */
    update(light, size = 1) {
        const show = !!light && !light.isAmbientLight && (light.isDirectionalLight || light.isPointLight || light.isSpotLight || light.isRectAreaLight);
        this.object.visible = show;
        if (!show) return;
        light.updateMatrixWorld();
        light.target?.updateMatrixWorld();
        const p = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
        const q = light.target ? new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld)
            : light.isRectAreaLight ? new THREE.Vector3().fromArray(light.userData.rindr?.target ?? [0, 0, 0]) : p.clone();
        const sig = `${p.toArray()}|${q.toArray()}|${light.color.getHex()}|${light.angle}|${light.penumbra}|${light.width}|${light.height}|${light.quaternion.toArray()}|${size}`;
        if (sig === this._sig) return;
        this._sig = sig;
        if (!light.isDirectionalLight) { this._local(light, p, q, size); return; }
        const dir = q.clone().sub(p);
        const length = dir.length();
        if (!(length > 0)) { this.object.visible = false; return; }
        dir.divideScalar(length);
        const radius = length * 0.25;
        const helper = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const u = new THREE.Vector3().crossVectors(dir, helper).normalize();
        const v = new THREE.Vector3().crossVectors(dir, u);
        const at = (base, angle, r) => base.clone().addScaledVector(u, Math.cos(angle) * r).addScaledVector(v, Math.sin(angle) * r);
        const ring = (base, out) => {
            for (let i = 0; i < RING; i++) out.push(at(base, i / RING * Math.PI * 2, radius), at(base, (i + 1) / RING * Math.PI * 2, radius));
        };
        const beyond = q.clone().addScaledVector(dir, radius * 1.5);
        // centre line to the target, arrow head there, ring at the light
        const axis = [p, q];
        const head = radius * 0.25;
        for (let i = 0; i < 4; i++) axis.push(q, at(q.clone().addScaledVector(dir, -head), i * Math.PI / 2, head * 0.45));
        ring(p, axis);
        // parallel rays from the ring through to beyond the target, ring where they cross the target
        const beam = [];
        for (let i = 0; i < RAYS; i++) {
            const angle = i / RAYS * Math.PI * 2;
            beam.push(at(p, angle, radius), at(beyond, angle, radius));
        }
        ring(q, beam);
        this._set(light, axis, beam);
    }

    _set(light, axis, beam) {
        // another number of points (other kind of light): new geometries – setFromPoints only refills the old size
        for (const [line, points] of [[this.axis, axis], [this.beam, beam]]) {
            if (line.geometry.attributes.position && line.geometry.attributes.position.count !== points.length) {
                line.geometry.dispose();
                line.geometry = new THREE.BufferGeometry();
            }
            line.geometry.setFromPoints(points);
        }
        // the light's colour, at least mid bright (a dim light stays visible over a dark scene)
        const color = light.color.clone();
        const max = Math.max(color.r, color.g, color.b) || 1;
        color.multiplyScalar(Math.max(1 / max, 1));
        this.axis.material.color.copy(color);
        this.beam.material.color.copy(color);
    }

    // point, spot and area lights
    _local(light, p, q, size) {
        const axis = [], beam = [];
        const circle = (centre, u, v, ru, rv, out) => {
            for (let i = 0; i < RING; i++) {
                const a0 = i / RING * Math.PI * 2, a1 = (i + 1) / RING * Math.PI * 2;
                out.push(centre.clone().addScaledVector(u, Math.cos(a0) * ru).addScaledVector(v, Math.sin(a0) * rv),
                    centre.clone().addScaledVector(u, Math.cos(a1) * ru).addScaledVector(v, Math.sin(a1) * rv));
            }
        };
        const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
        if (light.isPointLight && !light.isSpotLight) {
            const r = size * 0.1;
            circle(p, X, Y, r, r, axis);
            circle(p, X, Z, r, r, axis);
            circle(p, Y, Z, r, r, beam);
            this._set(light, axis, beam);
            return;
        }
        const dir = q.clone().sub(p);
        const length = dir.length() || size;
        dir.normalize();
        if (light.isRectAreaLight) {
            // outline in the light's plane, arrow along its direction (−z) to the target
            const u = X.clone().applyQuaternion(light.quaternion), v = Y.clone().applyQuaternion(light.quaternion);
            const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(light.quaternion);
            const hw = light.width / 2, hh = light.height / 2;
            if (light.isCircular) circle(p, u, v, hw, hh, axis);
            else {
                const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => p.clone().addScaledVector(u, a * hw).addScaledVector(v, b * hh));
                for (let i = 0; i < 4; i++) axis.push(c[i], c[(i + 1) % 4]);
            }
            const end = p.clone().addScaledVector(facing, length);
            beam.push(p, end);
            const head = Math.min(length, size) * 0.06;
            const side = Math.abs(facing.y) < 0.9 ? Y : X;
            const w = new THREE.Vector3().crossVectors(facing, side).normalize(), w2 = new THREE.Vector3().crossVectors(facing, w);
            for (const o of [w, w.clone().negate(), w2, w2.clone().negate()]) axis.push(end, end.clone().addScaledVector(facing, -head).addScaledVector(o, head * 0.45));
            this._set(light, axis, beam);
            return;
        }
        // spot: cone to the target – outer ring, lines from the light to it, dimmer inner ring, centre line
        const side = Math.abs(dir.y) < 0.9 ? Y : X;
        const u = new THREE.Vector3().crossVectors(dir, side).normalize(), v = new THREE.Vector3().crossVectors(dir, u);
        const outer = Math.tan(light.angle) * length, inner = Math.tan(light.angle * (1 - light.penumbra)) * length;
        circle(q, u, v, outer, outer, axis);
        for (let i = 0; i < RAYS; i++) {
            const a = i / RAYS * Math.PI * 2;
            axis.push(p, q.clone().addScaledVector(u, Math.cos(a) * outer).addScaledVector(v, Math.sin(a) * outer));
        }
        if (light.penumbra > 0.01) circle(q, u, v, inner, inner, beam);
        beam.push(p, q);
        this._set(light, axis, beam);
    }
}

// Own cameras (viewer.js cameraViews) other than the active one, in the gizmo's overlay while the camera or a camera
// is selected: a pyramid from the camera position along its view (its field of view and the window's aspect, an
// eighth of the scene size long) with a small triangle on the upper edge – where each camera stands and looks.
export class CameraMarkers {
    constructor() {
        this.lines = new THREE.LineSegments(new THREE.BufferGeometry(),
            new THREE.LineBasicNodeMaterial({ color: 0x7dd3fc, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 }));
        this.object = this.lines;
        this.object.name = 'Camera markers';
        this.object.visible = false;
        this._sig = '';
    }

    /** views: cameras to mark ({ position, target, fov, roll }); call every frame, rebuilds only on change */
    update(views, { aspect = 1, size = 1 } = {}) {
        this.object.visible = views.length > 0;
        if (!views.length) return;
        const sig = views.map(v => [v.position, v.target, v.fov, v.roll || 0].flat().join()).join('|') + `|${aspect}|${size}`;
        if (sig === this._sig) return;
        this._sig = sig;
        const points = [];
        for (const v of views) {
            const p = new THREE.Vector3().fromArray(v.position);
            const forward = new THREE.Vector3().fromArray(v.target).sub(p);
            if (!(forward.lengthSq() > 0)) continue;
            forward.normalize();
            const worldUp = Math.abs(forward.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
            const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
            const up = new THREE.Vector3().crossVectors(right, forward);
            if (v.roll) {   // Dutch angle (degrees, about the view axis)
                const q = new THREE.Quaternion().setFromAxisAngle(forward, THREE.MathUtils.degToRad(-v.roll));
                right.applyQuaternion(q);
                up.applyQuaternion(q);
            }
            const d = size * 0.125;
            const h = Math.tan(THREE.MathUtils.degToRad(Math.min(v.fov ?? 50, 150)) / 2) * d, w = h * aspect;
            const c = p.clone().addScaledVector(forward, d);
            const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => c.clone().addScaledVector(right, x * w).addScaledVector(up, y * h));
            for (let i = 0; i < 4; i++) points.push(p, corners[i], corners[i], corners[(i + 1) % 4]);
            const top = c.clone().addScaledVector(up, h * 1.35);
            points.push(corners[2].clone().lerp(corners[3], 0.3), top, top, corners[2].clone().lerp(corners[3], 0.7));
        }
        this.lines.geometry.dispose();
        this.lines.geometry = new THREE.BufferGeometry().setFromPoints(points);
    }
}

// Helper of the selected directional light (viewer.js, the gizmo's overlay scene – drawn over everything): where the
// light stands and how its parallel rays cross the scene (user: "draw the light's cone when it is selected – to judge
// how it lies in the room"). A directional light has no cone: a ring at the light (a quarter of its distance to the
// target – fitShadows places it at twice the model size, so about the model's radius), parallel rays through to beyond
// the target, a ring where they cross the target, a centre line with an arrow head. In the light's colour.
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

    /** light: the selected light (null or not directional: hidden) – call every frame, rebuilds only on change */
    update(light) {
        const show = !!light?.isDirectionalLight;
        this.object.visible = show;
        if (!show) return;
        light.updateMatrixWorld();
        light.target.updateMatrixWorld();
        const p = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
        const q = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld);
        const sig = `${p.toArray()}|${q.toArray()}|${light.color.getHex()}`;
        if (sig === this._sig) return;
        this._sig = sig;
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
        this.axis.geometry.setFromPoints(axis);
        this.beam.geometry.setFromPoints(beam);
        // the light's colour, at least mid bright (a dim light stays visible over a dark scene)
        const color = light.color.clone();
        const max = Math.max(color.r, color.g, color.b) || 1;
        color.multiplyScalar(Math.max(1 / max, 1));
        this.axis.material.color.copy(color);
        this.beam.material.color.copy(color);
    }
}

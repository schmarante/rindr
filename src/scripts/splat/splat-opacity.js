// Shadow of Gaussian splats (a scanned tree, an object splat) on PBR models – and the own shadow of relit splats
// (splat-mesh.js setLook). Splats are semi-transparent blobs: a depth map would cut them at a threshold, so an opacity
// map instead (opacity shadow map): every splat is drawn once from the main light (orthographic camera), its optical
// depth −ln(1 − α) added into each of 8 depth slices that end behind it (two RGBA half-float targets, MRT, additive).
// A receiver at light depth t interpolates the optical depth between the slice ends → transmittance exp(−od).
// Deep opacity map (user: stripes across a relit skull under a light from above): a front pass first keeps per texel
// the light depth of the nearest clearly covering splat; the slices are measured from there (relative depth), so they
// follow the first surface – with fixed slices a surface lay anywhere inside a slice and the linear ramp gave it a
// share of its own slice's optical depth depending on where: bands across the light. The slices span 1/8 each of the
// receivers' depth range behind the front (the last one everything further), splats in front of it count fully.
// Models: transmittanceNode() on the main light's shadow (viewer.js: dirLight1.shadow.shadowNode = shadow × it).
// Drawn only when something changed (markDirty: light, models, splats moved/relit) and after the frame.
import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, vec2, vec4, float, step, clamp, exp, positionWorld, select, max, abs, smoothstep, shadow, mrt } from 'three/tsl';

const SLICES = 8;
const _box = new THREE.Box3(), _v = new THREE.Vector3(), _c = new THREE.Vector3(), _dir = new THREE.Vector3();

export class SplatOpacity {
    constructor(size = 1024) {
        this.size = size;
        this.target = new THREE.RenderTarget(size, size, { count: 2, type: THREE.HalfFloatType, depthBuffer: false });
        this.target.textures[0].name = 'output';
        this.target.textures[1].name = 'slices';
        for (const tex of this.target.textures) tex.minFilter = tex.magFilter = THREE.LinearFilter;
        // the front: light depth of the nearest clearly covering splat (1 = none) – nearest filtering (blending depths
        // across a silhouette would put the front in the air)
        this.front = new THREE.RenderTarget(size, size, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: true });
        this.front.texture.minFilter = this.front.texture.magFilter = THREE.NearestFilter;
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
        this.enabled = uniform(0);
        this.matrix = uniform(new THREE.Matrix4());      // world → light clip space (WebGPU depth 0…1)
        this.slices = { b0: uniform(new THREE.Vector4()), b1: uniform(new THREE.Vector4()) };   // slice ends (light depth behind the front)
        this.map = { ...this.slices, front: this.front.texture };   // what the splats' light materials read (splat-mesh.js)
        this.bias = uniform(0);                           // receivers sample this much nearer (light depth)
        this.active = false;
        this.dirty = true;
        this.drawnAt = 0;   // performance.now() of the last update (the viewer throttles while dragging)
        // three.js r186 clears every MRT attachment but the first to (0, 0, 0, 1) – in `clear()` and in render's
        // autoClear: the last slice (alpha of the second target) started at optical depth 1 everywhere, the map was a
        // dark rectangle. Zeros written by a full-screen pass after the clear instead.
        this.zero = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.zero.material.fragmentNode = mrt({ output: vec4(0), slices: vec4(0) });
        this.zero.material.depthTest = this.zero.material.depthWrite = false;
    }

    markDirty() {
        this.dirty = true;
    }

    /**
     * Transmittance of the splats towards the main light at a world position (1 = lit). vertex: sampled with an
     * explicit level (vertex stage – the relit splats); otherwise for the models' fragments.
     */
    transmittance(world, { vertex = false } = {}) {
        return Fn(() => {
            const lp = this.matrix.mul(vec4(world, 1)).toVar();
            const uv = vec2(lp.x.mul(0.5).add(0.5), lp.y.mul(-0.5).add(0.5)).toVar();
            // fades out towards the map's border (a hard edge drew the map as a dark rectangle on the ground)
            const edge = vec2(0.5).sub(abs(uv.sub(0.5)));
            const inside = smoothstep(0, 0.04, edge.x).mul(smoothstep(0, 0.04, edge.y));
            const sample = tex => (vertex ? texture(tex, uv).level(0) : texture(tex, uv));
            const c0 = sample(this.target.textures[0]).toVar(), c1 = sample(this.target.textures[1]).toVar();
            const t = lp.z.sub(this.bias).sub(sample(this.front.texture).r).toVar();   // behind the front
            // piecewise linear through (0, 0), (b_k, c_k): ramp of every slice clamped to 0…1
            const ends = [this.slices.b0.x, this.slices.b0.y, this.slices.b0.z, this.slices.b0.w, this.slices.b1.x, this.slices.b1.y, this.slices.b1.z, this.slices.b1.w];
            const values = [c0.x, c0.y, c0.z, c0.w, c1.x, c1.y, c1.z, c1.w];
            let od = float(0), prevEnd = float(0), prevValue = float(0);
            for (let k = 0; k < SLICES; k++) {
                const w = clamp(t.sub(prevEnd).div(max(ends[k].sub(prevEnd), 1e-6)), 0, 1);
                od = od.add(values[k].sub(prevValue).mul(w));
                prevEnd = ends[k];
                prevValue = values[k];
            }
            return select(this.enabled.greaterThan(0.5), exp(od.mul(inside).negate()), float(1));
        })();
    }

    /**
     * The models receive it through the light's shadow: its shadow node × the transmittance (one shared node for all
     * materials – set once at startup, `enabled` switches it without rebuilding shaders)
     */
    attachTo(light) {
        light.shadow.shadowNode = shadow(light).mul(this.transmittance(positionWorld));
    }

    /**
     * Draw the opacity map if needed.
     * @param {{ renderer, scene, splat, light: THREE.DirectionalLight, receivers: THREE.Object3D[], splatReceives: boolean,
     *   groundY: ?number, keep: THREE.Object3D[], hide: THREE.Object3D[] }} o  receivers = model roots; splatReceives = the
     *   splats are relit (their own shadow); groundY = height of the ground shadow (null: none) – the splats' shadow
     *   thrown onto it along the light is inside the map; receiverBox = further receiving space (world box); keep = top-level
     *   scene children that stay visible (they hold the splats), hide = objects below them to hide (the models)
     * @returns {boolean} active
     */
    update({ renderer, scene, splat, light, receivers, splatReceives, groundY = null, receiverBox = null, keep, hide }) {
        if (!this.dirty) return this.active;
        this.dirty = false;
        const box = new THREE.Box3();
        for (const r of receivers) if (r?.visible) box.union(_box.setFromObject(r, true));
        splat.updateWorldMatrix(true, false);
        const splatBox = splat.geometry.boundingBox.clone().applyMatrix4(splat.matrixWorld);
        // casters: all splats, not only the robust core – a faint haze around it (smoke, dust) shadows too, and cut at
        // the core's box its shadow ended in a straight edge; far floaters capped at 3× the core
        const core = splat.geometry.boundingBox, coreCenter = core.getCenter(new THREE.Vector3()), coreHalf = core.getSize(new THREE.Vector3()).multiplyScalar(1.5);
        const casterBox = splat.fullBox.clone().intersect(new THREE.Box3(coreCenter.clone().sub(coreHalf), coreCenter.clone().add(coreHalf))).applyMatrix4(splat.matrixWorld);
        if (splatReceives) box.union(splatBox);
        if (receiverBox) box.union(receiverBox);   // e.g. the air of the light shafts (volume-shafts.js)
        light?.updateWorldMatrix(true, false);
        light?.target.updateWorldMatrix(true, false);
        if (light) _dir.setFromMatrixPosition(light.target.matrixWorld).sub(_v.setFromMatrixPosition(light.matrixWorld)).normalize();
        // the ground below receives too: the splats' box thrown onto it along the light (sideways only – it lies behind
        // everything, so it gets the optical depth of all splats in its column)
        const footprint = new THREE.Box3();
        if (groundY !== null && light && _dir.y < -0.05) {
            const reach = casterBox.getSize(_v).length() * 4;
            for (let i = 0; i < 8; i++) {
                const c = new THREE.Vector3(i & 1 ? casterBox.max.x : casterBox.min.x, i & 2 ? casterBox.max.y : casterBox.min.y, i & 4 ? casterBox.max.z : casterBox.min.z);
                footprint.expandByPoint(c.clone().addScaledVector(_dir, Math.min(Math.max((c.y - groundY) / -_dir.y, 0), reach)));
            }
        }
        const depthBox = box.isEmpty() ? splatBox.clone() : box.clone();   // slices: over the receivers (or the splats)
        box.union(footprint);
        if (groundY !== null || splatReceives) box.union(casterBox);   // the haze's own area
        this.active = !box.isEmpty() && !!light?.visible && !!splat.visible && !splat.loading;
        this.enabled.value = this.active ? 1 : 0;
        if (!this.active) return false;
        box.getCenter(_c);
        const radius = Math.max(box.getSize(_v).length(), casterBox.getSize(new THREE.Vector3()).length()) || 1;
        const cam = this.camera;
        cam.up.set(0, 1, 0);
        if (Math.abs(_dir.y) > 0.99) cam.up.set(1, 0, 0);
        cam.position.copy(_c).addScaledVector(_dir, -radius * 2);
        cam.lookAt(_c);
        cam.updateMatrixWorld(true);
        // side extent: the receivers (+ ground footprint); depth: from the nearest splat to behind the receivers and
        // the splats (all of them in the map); slices over the receivers' depth
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, near = Infinity, far = -Infinity, splatNear = Infinity, splatFar = -Infinity;
        const corner = (b, i) => _v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(cam.matrixWorldInverse);
        for (let i = 0; i < 8; i++) {
            corner(box, i);
            minX = Math.min(minX, _v.x); maxX = Math.max(maxX, _v.x); minY = Math.min(minY, _v.y); maxY = Math.max(maxY, _v.y);
            corner(depthBox, i);
            near = Math.min(near, -_v.z); far = Math.max(far, -_v.z);
            corner(casterBox, i);
            splatNear = Math.min(splatNear, -_v.z); splatFar = Math.max(splatFar, -_v.z);
        }
        const pad = Math.max(maxX - minX, maxY - minY) * 0.04;
        cam.left = minX - pad; cam.right = maxX + pad; cam.bottom = minY - pad; cam.top = maxY + pad;
        cam.near = Math.min(splatNear, near) - pad;   // may lie behind the camera position (orthographic)
        cam.far = Math.max(far, splatFar) + pad;
        cam.updateProjectionMatrix();
        // slice ends behind the front: 1/8 of the receivers' depth range each (light depth 0…1); the last one everything
        const span = cam.far - cam.near;
        const start = (near - pad - cam.near) / span, end = Math.min((far + pad - cam.near) / span, 1);
        const ends = Array.from({ length: SLICES }, (_, k) => (k === SLICES - 1 ? 2 : (end - start) * (k + 1) / SLICES));
        this.slices.b0.value.set(ends[0], ends[1], ends[2], ends[3]);
        this.slices.b1.value.set(ends[4], ends[5], ends[6], ends[7]);
        this.bias.value = (end - start) / SLICES * 0.35;
        // only the splats, every one once (light-pass variant, buffer order)
        const hidden = [];
        for (const o of scene.children) if (o.visible && !keep.includes(o)) { o.visible = false; hidden.push(o); }
        for (const o of hide) if (o?.visible) { o.visible = false; hidden.push(o); }
        const variants = splat.lightMaterials(this.map);
        let restore = splat.useVariant(variants.front, splat.count);
        const saved = { background: scene.background, backgroundNode: scene.backgroundNode, target: renderer.getRenderTarget(),
            clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), mask: cam.layers.mask, autoClear: renderer.autoClear };
        scene.background = null;
        scene.backgroundNode = null;
        cam.layers.mask = splat.layers.mask;
        try {
            // the front (nearest covering splat, depth test), then the optical depths relative to it
            renderer.setRenderTarget(this.front);
            renderer.setClearColor(0xffffff, 1);
            renderer.clear();
            renderer.autoClear = false;
            renderer.render(scene, cam);
            restore();
            restore = splat.useVariant(variants.light, splat.count);
            renderer.setRenderTarget(this.target);
            renderer.setClearColor(0x000000, 0);
            renderer.clear();
            this.zero.render(renderer);
            renderer.render(scene, cam);
        } finally {
            restore();
            renderer.autoClear = saved.autoClear;
            renderer.setRenderTarget(saved.target);
            renderer.setClearColor(saved.clear, saved.alpha);
            scene.background = saved.background;
            scene.backgroundNode = saved.backgroundNode;
            cam.layers.mask = saved.mask;
            for (const o of hidden) o.visible = true;
        }
        this.matrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        return true;
    }

    dispose() {
        this.target.dispose();
        this.front.dispose();
        this.zero.material.dispose();
    }
}

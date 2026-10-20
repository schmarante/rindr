// Shadow of PBR models on a Gaussian splat scene (a CAD model placed into a scan): the splats' lighting is baked into
// their colours, so they cannot receive light – instead they are darkened where a model blocks the main light.
//
// Own depth map, independent of three.js' shadow nodes (the splat vertex shader reads it directly): an orthographic
// camera along the main directional light, its side extent fitted to the casting models (a shadow lies behind its
// caster along the light – same footprint in light space), depth from the models' near side to beyond the splats.
// Depth written as a float colour (r32float, cleared to 1 = far): a depth texture read in the vertex shader got a
// multisampled binding from three.js → validation errors. Drawn over the scene with everything but the models hidden
// (splats, ground, dome …);
// only when something changed (models moved, light turned, models added: markDirty – the viewer calls it with its
// shadow-map invalidation). Splat side: splat-mesh.js (setShadow, 3×3 depth taps at the splat centre).
import * as THREE from 'three/webgpu';
import { depth, vec4 } from 'three/tsl';

const _box = new THREE.Box3(), _v = new THREE.Vector3(), _c = new THREE.Vector3(), _dir = new THREE.Vector3();

export class SplatShadow {
    constructor(size = 2048) {
        this.size = size;
        this.target = new THREE.RenderTarget(size, size, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: true });
        this.target.texture.minFilter = this.target.texture.magFilter = THREE.NearestFilter;
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
        this.material = new THREE.MeshBasicNodeMaterial();
        this.material.fragmentNode = vec4(depth, 0, 0, 1);
        this.material.blending = THREE.NoBlending;   // single red channel – normal blending reads alpha
        this.material.name = 'SplatShadowDepth';
        this.matrix = new THREE.Matrix4();   // world → light clip space (after the render: WebGPU depth range)
        this.receiverMatrix = new THREE.Matrix4();   // the splats' world matrix of the last check (viewer: moved → dirty)
        this.active = false;
        this.dirty = true;
    }

    markDirty() {
        this.dirty = true;
    }

    /**
     * Draw the depth map if needed.
     * @param {{ renderer, scene, light: THREE.DirectionalLight, casters: THREE.Object3D[], keep: THREE.Object3D[],
     *   hide: THREE.Object3D[], receiverBox: THREE.Box3 }} o  casters = model roots (their bounds fit the camera);
     *   keep = top-level scene children that stay visible (they hold the casters), hide = objects below them to hide
     *   (the splats); receiverBox = world bounds of the splats (depth range)
     * @returns {boolean} active (there is something casting)
     */
    update({ renderer, scene, light, casters, keep, hide, receiverBox }) {
        if (!this.dirty) return this.active;
        this.dirty = false;
        const box = new THREE.Box3();
        for (const c of casters) if (c?.visible) box.union(_box.setFromObject(c, true));
        this.active = !box.isEmpty() && !!light?.visible;
        if (!this.active) return false;
        // camera along the light, looking at the casters
        light.updateWorldMatrix(true, false);
        light.target.updateWorldMatrix(true, false);
        _dir.setFromMatrixPosition(light.target.matrixWorld).sub(_v.setFromMatrixPosition(light.matrixWorld)).normalize();
        box.getCenter(_c);
        const radius = box.getSize(_v).length() / 2 || 1;
        const cam = this.camera;
        cam.up.set(0, 1, 0);
        if (Math.abs(_dir.y) > 0.99) cam.up.set(1, 0, 0);
        cam.position.copy(_c).addScaledVector(_dir, -radius * 2);
        cam.lookAt(_c);
        cam.updateMatrixWorld(true);
        // side extent: the casters; depth: from the casters to beyond the splats
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, near = Infinity, far = -Infinity;
        const corner = (b, i, sides) => {
            _v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(cam.matrixWorldInverse);
            if (sides) { minX = Math.min(minX, _v.x); maxX = Math.max(maxX, _v.x); minY = Math.min(minY, _v.y); maxY = Math.max(maxY, _v.y); }
            near = Math.min(near, -_v.z);
            far = Math.max(far, -_v.z);
        };
        for (let i = 0; i < 8; i++) corner(box, i, true);
        if (receiverBox && !receiverBox.isEmpty()) for (let i = 0; i < 8; i++) corner(receiverBox, i, false);
        const pad = Math.max(maxX - minX, maxY - minY) * 0.04;
        cam.left = minX - pad; cam.right = maxX + pad; cam.bottom = minY - pad; cam.top = maxY + pad;
        cam.near = Math.max(near - pad, 1e-3);
        cam.far = far + pad;
        cam.updateProjectionMatrix();
        // only the models: everything else hidden, depth-only material
        const hidden = [];
        for (const o of scene.children) if (o.visible && !keep.includes(o)) { o.visible = false; hidden.push(o); }
        for (const o of hide) if (o?.visible) { o.visible = false; hidden.push(o); }
        const saved = { override: scene.overrideMaterial, background: scene.background, backgroundNode: scene.backgroundNode, target: renderer.getRenderTarget(),
            clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() };
        scene.overrideMaterial = this.material;
        scene.background = null;
        scene.backgroundNode = null;
        try {
            renderer.setRenderTarget(this.target);
            renderer.setClearColor(0xffffff, 1);   // nothing there = far
            renderer.clear();
            renderer.render(scene, cam);
        } finally {
            renderer.setRenderTarget(saved.target);
            renderer.setClearColor(saved.clear, saved.alpha);
            scene.overrideMaterial = saved.override;
            scene.background = saved.background;
            scene.backgroundNode = saved.backgroundNode;
            for (const o of hidden) o.visible = true;
        }
        // the renderer set the camera to its coordinate system (WebGPU: depth 0…1) – the matrix the depth map was made with
        this.matrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        return true;
    }

    dispose() {
        this.target.dispose();
        this.material.dispose();
    }
}

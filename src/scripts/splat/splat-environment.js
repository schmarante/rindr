// Scan as the environment of PBR models (reflections + image-based light): a glossy car in a scanned garage has to
// mirror the garage, not the HDRI. The splats are seen from the models' centre into a cube map – per face through a
// SplatComposite of fixed size (frame = the HDRI background, which fills the holes of the scan; splats composited
// over it, back to linear with sRGB only – the inverse tone curve gave far too bright, too saturated light; a mirror
// shows the scan slightly darker, like an HDRI made from a photo) – and three.js
// makes the PMREM from it (scene.environment, viewer.js; needsPMREMUpdate after the sixth face).
// Steps, after the frame: once the models have rested ~0.3 s after a change (markDirty), a distance sort from the probe
// (splat-mesh.js sortEnv – the camera's sort keeps its own order), then one face per frame (six draws of all splats
// at once froze large scans for a moment). The cube cameras are turned by the environment rotation: the models look
// the environment up rotated back by it (three.js materialEnvRotation), so the face content must be turned the same way.
import * as THREE from 'three/webgpu';
import { texture, vec4 } from 'three/tsl';
import { SplatComposite } from './splat-composite.js';

export class SplatEnvironment {
    constructor(renderer, size = 256) {
        this.renderer = renderer;
        this.size = size;
        this.composite = new SplatComposite(renderer, { size, linear: true });
        this.cube = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: false });
        this.cubeCamera = new THREE.CubeCamera(1, 1000, this.cube);
        this.copy = new THREE.QuadMesh(new THREE.NodeMaterial());
        this.copy.material.fragmentNode = vec4(texture(this.composite.result.texture).rgb, 1);
        this.probe = new THREE.Vector3();
        this.ready = false;   // the cube map holds a complete capture
        this.dirty = true;
        this.dirtyAt = 0;
        this.phase = -1;      // next face 0…5, -1 = idle
        this.busy = false;    // sorting
        this.signature = '';  // what the capture shows (viewer: tone curve, exposure, HDRI …) – changed → captured again
    }

    get texture() {
        return this.cube.texture;
    }

    markDirty() {
        this.dirty = true;
        this.dirtyAt = performance.now();
    }

    /** not in use any more (no models, no scan): start over next time */
    reset() {
        this.ready = false;
        this.phase = -1;
        this.markDirty();
    }

    /**
     * After a frame: the next step of a capture.
     * @param {{ scene, splat, layer: number, keep: THREE.Object3D, hide: THREE.Object3D[], probe: () => THREE.Vector3,
     *   radius: number, rotation: THREE.Euler, background: ?THREE.Texture, backgroundIntensity: number }} o
     *   keep = scene child holding the splats (everything else hidden), hide = below it (the models); probe = where the
     *   models are; radius = scene size (near/far); rotation = environment rotation; background = the HDRI
     * @returns {boolean} a face was drawn (another frame is wanted)
     */
    update(o) {
        if (this.busy) return false;
        if (this.phase < 0) {
            if (!this.dirty || performance.now() - this.dirtyAt < 300) return false;
            this.dirty = false;
            this.busy = true;
            this.probe.copy(o.probe());
            o.splat.sortEnv(this.probe).then(ok => {
                this.busy = false;
                if (ok) this.phase = 0;
                else this.markDirty();
            }, err => { this.busy = false; console.error('[Splats] environment sort failed', err); });
            return false;
        }
        this._face(this.phase, o);
        this.phase++;
        if (this.phase === 6) {
            this.phase = -1;
            this.cube.texture.needsPMREMUpdate = true;
            this.ready = true;
        }
        return true;
    }

    _face(face, { scene, splat, layer, keep, hide, radius, rotation, background, backgroundIntensity }) {
        const r = this.renderer, cc = this.cubeCamera, comp = this.composite;
        if (cc.coordinateSystem !== r.coordinateSystem) {
            cc.coordinateSystem = r.coordinateSystem;
            cc.updateCoordinateSystem();
        }
        cc.position.copy(this.probe);
        cc.rotation.copy(rotation);
        for (const cam of cc.children) {
            cam.near = radius * 1e-4;
            cam.far = radius * 20;
            cam.updateProjectionMatrix();
        }
        cc.updateMatrixWorld(true);
        const cam = cc.children[face];
        const saved = {
            target: r.getRenderTarget(), face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(), autoClear: r.autoClear,
            background: scene.background, backgroundNode: scene.backgroundNode, backgroundIntensity: scene.backgroundIntensity,
            backgroundRotation: scene.backgroundRotation.clone(), backgroundBlurriness: scene.backgroundBlurriness,
            layers: splat.layers.mask, dof: splat.dof.enabled.value, line: splat.dof.line.value,
        };
        const hidden = [];
        for (const c of scene.children) if (c.visible) { c.visible = false; hidden.push(c); }
        splat.layers.set(layer);
        splat.dof.enabled.value = 0;   // no blur, no focus line in the reflection
        splat.dof.line.value = 0;
        try {
            // frame: only the background (the HDRI, as the models would see it without the scan)
            scene.background = background;
            scene.backgroundNode = null;
            scene.backgroundIntensity = backgroundIntensity;
            scene.backgroundRotation.copy(rotation);
            scene.backgroundBlurriness = 0;
            comp.begin({ models: false });
            r.autoClear = true;
            r.render(scene, cam);
            for (const c of hidden) c.visible = true;
            hidden.length = 0;
            comp.drawSplats(scene, cam, { layer, keep, hide, splat, material: splat.envMaterial, instances: splat.envCount });
            comp.compose(comp.frame.texture);
            r.setRenderTarget(this.cube, face);
            this.copy.render(r);
        } finally {
            for (const c of hidden) c.visible = true;
            Object.assign(scene, { background: saved.background, backgroundNode: saved.backgroundNode, backgroundIntensity: saved.backgroundIntensity,
                backgroundBlurriness: saved.backgroundBlurriness });
            scene.backgroundRotation.copy(saved.backgroundRotation);
            splat.layers.mask = saved.layers;
            splat.dof.enabled.value = saved.dof;
            splat.dof.line.value = saved.line;
            r.autoClear = saved.autoClear;
            r.setRenderTarget(saved.target, saved.face, saved.mip);
        }
    }

    dispose() {
        this.composite.dispose();
        this.cube.dispose();
        this.copy.material.dispose();
    }
}

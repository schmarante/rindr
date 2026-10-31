// Occlusion culling for the raster view of large models (render-batcher.js decides what is drawn, docs/rendering.md).
//
// Of a large assembly most parts in view are hidden behind others (engine internals behind the body); drawing them
// costs draw calls and triangles for nothing. Every few frames while the view changes:
//   1. depth image: what is drawn right now (batches, LOD cuts, culled parts left out – the visible ones are the
//      occluders), small (OCCLUSION.width), 1 / view depth per texel (background 0); transparent and transmissive
//      surfaces are discarded – glass hides nothing
//   2. level 1: the minimum of every 8 × 8 texels (for large parts)
//   3. per part (its bounding box as placed – the geometry's box turned with the part –, one GPU thread each): the
//      screen rectangle of its 8 corners, one texel wider on every side (silhouettes are approximate in a small
//      image), the farthest occluder in it – visible if anything there is not in front of the part's nearest corner;
//      outside the view = not drawn either. (Bounding spheres hid half as many: long thin CAD parts – frames, pipes,
//      panels – have huge spheres that stick out everywhere.)
//   4. read back (a few frames later) – the batcher leaves the hidden parts out until the next result
// Parts that become visible appear with that delay (only those behind others – parts inside stay inside when the view
// turns). Everything that changes the scene (moving, hiding, materials, regrouping) drops the result: the batcher
// draws everything until a result for the new state is there. Shadow maps, the fisheye's faces, section plane and
// splats see the whole model (the batcher does not cull then, see allowed()).
import * as THREE from 'three/webgpu';
import { Fn, If, Loop, Return, float, int, uint, vec2, vec4, uniform, storage, instanceIndex, textureLoad, ivec2, positionView,
    Discard, min, max, floor, select } from 'three/tsl';
import { OCCLUSION } from './config.js';

const BLOCK = 8;               // level 1: minimum of BLOCK × BLOCK texels
const DIRECT_TEXELS = 1024;    // rectangles up to this many texels are tested texel by texel, larger ones on level 1
const NEAR_FAR = 1e30;

const occlusionParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('occlusion') : null;

export class OcclusionCuller {
    /** @param {THREE.WebGPURenderer} renderer */
    constructor(renderer) {
        this.renderer = renderer;
        this.enabled = occlusionParam !== null ? occlusionParam !== '0' : OCCLUSION.enabled;
        this.supported = !!renderer.backend?.isWebGPUBackend;   // compute + readback
        this.depth = new THREE.RenderTarget(1, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        this.material = new THREE.NodeMaterial();
        this.material.fragmentNode = Fn(builder => {
            if (builder.material.transparent) Discard();
            return vec4(float(1).div(positionView.z.negate().max(1e-9)), 0, 0, 1);
        })();
        this.material.blending = THREE.NoBlending;
        this.material.toneMapped = false;
        this.view = uniform(new THREE.Matrix4());
        this.projection = uniform(new THREE.Matrix4());
        this.near = uniform(0);
        this.size = uniform(new THREE.Vector2(1, 1));
        this.blocks = uniform(new THREE.Vector2(1, 1));
        this.count = uniform(0, 'uint');
        this.capacity = 0;
        this.blockCapacity = 0;
        this.list = [];                 // the parts tested, in buffer order
        this.index = new Map();         // part → its slot
        this.generation = 0;            // +1 whenever the parts or their placement change (results of before are dropped)
        this.valid = false;             // list + boxes match the scene
        this.result = null;             // Uint32Array per slot: 1 drawn, 0 hidden (for `generation`)
        this.busy = false;              // a test is on its way back
        this.lastFrame = -Infinity;
        this.viewKey = '';
        this.stats = { parts: 0, hidden: 0, captureMs: 0, results: 0 };
        this._clear = new THREE.Color();
        this._size = new THREE.Vector2();
        this._ensureBlocks(64);   // level 1 buffer first – the test kernel reads it
    }

    /** May the batcher use it for this model? */
    get usable() {
        return this.enabled && this.supported;
    }

    /** Scene changed: results of before are no longer valid */
    invalidate() {
        if (!this.valid && !this.result) return;
        this.valid = false;
        this.result = null;
        this.generation++;
        this.stats.hidden = 0;
    }

    /** The parts to test from now on (their bounding boxes as they are placed now) */
    build(meshes) {
        this.generation++;
        this.result = null;
        this.list = meshes;
        this.index = new Map();
        this._ensure(meshes.length);
        // per part 4 × vec4: centre, then the three half axes of its box in world space (a hair larger – rounding)
        const a = this.boxes.array, c = new THREE.Vector3(), h = new THREE.Vector3(), axis = new THREE.Vector3();
        meshes.forEach((m, i) => {
            this.index.set(m, i);
            const g = m.geometry;
            if (!g.boundingBox) g.computeBoundingBox();
            g.boundingBox.getCenter(c).applyMatrix4(m.matrixWorld);
            g.boundingBox.getSize(h).multiplyScalar(0.5 * 1.002).addScalar(1e-6);
            const e = m.matrixWorld.elements, o = i * 16;
            a[o] = c.x; a[o + 1] = c.y; a[o + 2] = c.z; a[o + 3] = 0;
            for (let k = 0; k < 3; k++) {
                axis.set(e[k * 4], e[k * 4 + 1], e[k * 4 + 2]).multiplyScalar(h.getComponent(k));
                a[o + 4 + k * 4] = axis.x; a[o + 5 + k * 4] = axis.y; a[o + 6 + k * 4] = axis.z; a[o + 7 + k * 4] = 0;
            }
        });
        this.boxes.needsUpdate = true;
        this.count.value = meshes.length;
        this.valid = true;
        this.stats.parts = meshes.length;
        this.stats.hidden = 0;
    }

    /** Hidden in the last result? */
    hidden(mesh) {
        if (!this.result) return false;
        const i = this.index.get(mesh);
        return i !== undefined && this.result[i] === 0;
    }

    /** A new depth image now? (view changed since the last one, none on its way, not too often) */
    due(camera, frame) {
        if (!this.valid || this.busy || frame - this.lastFrame < OCCLUSION.interval) return false;
        const key = `${camera.matrixWorld.elements.join()},${camera.projectionMatrix.elements.join()},${this.generation}`;
        return key !== this.viewKey;
    }

    /**
     * Depth image of what this render draws + the test (called from inside the render, batches attached – before it
     * draws). Restores the renderer and scene state.
     * @param {{ scene: THREE.Scene, camera: THREE.Camera, keep: THREE.Object3D, frame: number }} opts  keep: the models' parent
     */
    capture({ scene, camera, keep, frame }) {
        const t0 = performance.now();
        const r = this.renderer;
        this.lastFrame = frame;
        this.viewKey = `${camera.matrixWorld.elements.join()},${camera.projectionMatrix.elements.join()},${this.generation}`;
        r.getDrawingBufferSize(this._size);
        const w = Math.max(16, Math.round(OCCLUSION.width)), h = Math.max(8, Math.round(w * this._size.y / Math.max(this._size.x, 1)));
        if (this.depth.width !== w || this.depth.height !== h) this.depth.setSize(w, h);
        const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK);
        this._ensureBlocks(bw * bh);
        this.size.value.set(w, h);
        this.blocks.value.set(bw, bh);
        camera.updateMatrixWorld();
        this.view.value.copy(camera.matrixWorldInverse);
        this.projection.value.copy(camera.projectionMatrix);
        this.near.value = camera.isPerspectiveCamera ? camera.near : -NEAR_FAR;

        const prev = {
            target: r.getRenderTarget(), face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(), autoClear: r.autoClear,
            background: scene.background, backgroundNode: scene.backgroundNode, override: scene.overrideMaterial,
            clearAlpha: r.getClearAlpha(), toneMapping: r.toneMapping, mrt: r.getMRT(),
        };
        r.getClearColor(this._clear);
        const hidden = [];
        for (const o of scene.children) if (o.visible && o !== keep) { o.visible = false; hidden.push(o); }
        try {
            scene.background = null;
            scene.backgroundNode = null;
            scene.overrideMaterial = this.material;
            r.setClearColor(0x000000, 0);
            r.toneMapping = THREE.NoToneMapping;
            r.setMRT(null);
            r.autoClear = true;
            r.setRenderTarget(this.depth);
            r.render(scene, camera);
        } finally {
            for (const o of hidden) o.visible = true;
            scene.overrideMaterial = prev.override;
            scene.background = prev.background;
            scene.backgroundNode = prev.backgroundNode;
            r.setClearColor(this._clear, prev.clearAlpha);
            r.toneMapping = prev.toneMapping;
            r.setMRT(prev.mrt);
            r.autoClear = prev.autoClear;
            r.setRenderTarget(prev.target, prev.face, prev.mip);
        }
        r.compute(this.levelKernel);
        r.compute(this.testKernel);
        const gen = this.generation, n = this.list.length;
        this.busy = true;
        r.getArrayBufferAsync(this.visible).then(buffer => {
            if (gen !== this.generation) return;
            this.result = new Uint32Array(buffer, 0, n);
            let hiddenCount = 0;
            for (let i = 0; i < n; i++) if (this.result[i] === 0) hiddenCount++;
            this.stats.hidden = hiddenCount;
            this.stats.results++;
        }).catch(err => console.warn('[Occlusion] readback failed:', err)).finally(() => { this.busy = false; });
        this.stats.captureMs = performance.now() - t0;
    }

    // buffers for n parts (doubling) + the test kernel for them
    _ensure(n) {
        if (n <= this.capacity && this.testKernel) return;
        const cap = this.capacity = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(n, 1))));
        this.boxes?.dispose();
        this.visible?.dispose();
        this.boxes = new THREE.StorageBufferAttribute(new Float32Array(cap * 16), 4);
        this.visible = new THREE.StorageBufferAttribute(new Uint32Array(cap), 1);
        this.testKernel?.dispose?.();
        this.testKernel = this._testKernel(cap);
    }

    _ensureBlocks(n) {
        if (n <= this.blockCapacity && this.levelKernel) return;
        const cap = this.blockCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(n)));
        this.blockMin?.dispose();
        this.blockMin = new THREE.StorageBufferAttribute(new Float32Array(cap), 1);
        this.levelKernel?.dispose?.();
        this.levelKernel = this._levelKernel(cap);
        // the test reads level 1 too
        this.testKernel?.dispose?.();
        this.testKernel = this.capacity ? this._testKernel(this.capacity) : null;
    }

    // level 1: minimum of 1 / depth over each block (the farthest occluder in it)
    _levelKernel(cap) {
        const out = storage(this.blockMin, 'float', cap);
        const depth = this.depth.texture;
        return Fn(() => {
            const i = int(instanceIndex);
            const bw = int(this.blocks.x), bh = int(this.blocks.y);
            If(i.greaterThanEqual(bw.mul(bh)), () => { Return(); });
            const w = int(this.size.x), h = int(this.size.y);
            const bx = i.mod(bw), by = i.div(bw);
            const m = float(NEAR_FAR).toVar();
            Loop({ start: int(0), end: int(BLOCK), type: 'int', name: 'ly' }, ({ ly }) => {
                Loop({ start: int(0), end: int(BLOCK), type: 'int', name: 'lx' }, ({ lx }) => {
                    const x = min(bx.mul(BLOCK).add(lx), w.sub(1)), y = min(by.mul(BLOCK).add(ly), h.sub(1));
                    m.assign(min(m, textureLoad(depth, ivec2(x, y)).r));
                });
            });
            out.element(i).assign(m);
        })().compute(cap);
    }

    // per part: drawn (1) if the farthest occluder in its screen rectangle is not in front of its nearest point
    _testKernel(cap) {
        const boxes = storage(this.boxes, 'vec4', cap * 4).toReadOnly();
        const visible = storage(this.visible, 'uint', cap);
        const blocks = storage(this.blockMin, 'float', this.blockCapacity).toReadOnly();
        const depth = this.depth.texture;
        return Fn(() => {
            const i = instanceIndex;
            If(i.greaterThanEqual(this.count), () => { Return(); });
            const o = i.mul(4);
            const c = this.view.mul(vec4(boxes.element(o).xyz, 1)).xyz;
            const ax = this.view.mul(vec4(boxes.element(o.add(1)).xyz, 0)).xyz;
            const ay = this.view.mul(vec4(boxes.element(o.add(2)).xyz, 0)).xyz;
            const az = this.view.mul(vec4(boxes.element(o.add(3)).xyz, 0)).xyz;
            // nearest corner: the box's depth extent along the view axis
            const nearest = c.z.negate().sub(ax.z.abs().add(ay.z.abs()).add(az.z.abs()));
            // reaches the camera plane: drawn
            If(nearest.lessThanEqual(this.near), () => { visible.element(i).assign(uint(1)); Return(); });
            const lo = vec2(NEAR_FAR).toVar(), hi = vec2(-NEAR_FAR).toVar();
            for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
                const p = this.projection.mul(vec4(c.add(ax.mul(dx)).add(ay.mul(dy)).add(az.mul(dz)), 1));
                const ndc = p.xy.div(p.w);
                lo.assign(min(lo, ndc));
                hi.assign(max(hi, ndc));
            }
            // outside the view: not drawn either (the batcher only culls when no other view – shadow maps, fisheye – draws)
            If(hi.x.lessThan(-1).or(lo.x.greaterThan(1)).or(hi.y.lessThan(-1)).or(lo.y.greaterThan(1)), () => {
                visible.element(i).assign(uint(0));
                Return();
            });
            const W = this.size.x, H = this.size.y;
            const wi = int(W), hi_ = int(H);
            // texel rectangle (rows top down), one texel wider on every side
            const x0 = max(int(floor(lo.x.mul(0.5).add(0.5).mul(W))).sub(1), int(0));
            const x1 = min(int(floor(hi.x.mul(0.5).add(0.5).mul(W))).add(1), wi.sub(1));
            const y0 = max(int(floor(float(0.5).sub(hi.y.mul(0.5)).mul(H))).sub(1), int(0));
            const y1 = min(int(floor(float(0.5).sub(lo.y.mul(0.5)).mul(H))).add(1), hi_.sub(1));
            const far = float(NEAR_FAR).toVar();
            If(x1.sub(x0).add(1).mul(y1.sub(y0).add(1)).lessThanEqual(DIRECT_TEXELS), () => {
                Loop({ start: y0, end: y1.add(1), type: 'int', name: 'ty' }, ({ ty }) => {
                    Loop({ start: x0, end: x1.add(1), type: 'int', name: 'tx' }, ({ tx }) => {
                        far.assign(min(far, textureLoad(depth, ivec2(tx, ty)).r));
                    });
                });
            }).Else(() => {
                const bw = int(this.blocks.x);
                Loop({ start: y0.div(BLOCK), end: y1.div(BLOCK).add(1), type: 'int', name: 'by' }, ({ by }) => {
                    Loop({ start: x0.div(BLOCK), end: x1.div(BLOCK).add(1), type: 'int', name: 'bx' }, ({ bx }) => {
                        far.assign(min(far, blocks.element(by.mul(bw).add(bx))));
                    });
                });
            });
            // 1 / depth: the farthest occluder (smallest value) not in front of the part's nearest corner (+ rounding)
            visible.element(i).assign(select(far.lessThanEqual(float(1).div(nearest).mul(1.002)), uint(1), uint(0)));
        })().compute(cap);
    }

    dispose() {
        this.depth.dispose();
        this.material.dispose();
        this.boxes?.dispose();
        this.visible?.dispose();
        this.blockMin?.dispose();
    }
}

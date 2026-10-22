// Ambient occlusion for the raster view (Default; the raster preview of HQ while the camera moves). Screen space
// at reduced resolution, applied INSIDE the materials' lighting – it only darkens the indirect light (environment,
// ambient light) and the indirect reflections, never direct light, emission or the finished picture. So lens
// effects, light shafts, contours and the fisheye work on the picture exactly as before.
//
// 1. pre-pass (inside the main render, render-batcher.js `beforeDraw` – the same batches, LOD cuts and section
//    plane as the picture): normals (view space) + linear depth of the opaque models; transparent and transmissive
//    meshes are discarded (glass must not occlude what is seen through it), everything else in the scene hidden
// 2. occlusion per pixel: samples on a disc around it (radius in world units, projected), each counting how far it
//    rises above the pixel's tangent plane within the radius (own implementation of the usual normal-oriented
//    obscurance estimate); the disc is rotated in a 4×4 pattern
// 3. depth-aware 4×4 blur (removes the pattern) → occlusion + depth
// 4. materials: `renderer.contextNode` with `getAO` (three.js' hook into NodeMaterial.setupAmbientOcclusion) –
//    set once at the start, so there is one shader per material as before; a uniform switches it on only for the
//    main render of a frame (cube faces of the fisheye, shadow maps, capture passes see 1 = no change). Receivers:
//    lit standard/physical materials that are opaque – not transparent, transmissive, toon, flat or soap (all part
//    of the material cache key).
//
// The pre-pass draws the whole model a second time – on large assemblies as much CPU as the picture itself. So it
// only runs when the view or the scene changed (`markDirty`, camera, size), and then at most in proportion to its
// cost (`costRatio`); meanwhile the materials reproject the last result: world position → that snapshot's camera
// → its texels, depth-aware from the four nearest (no halos at silhouettes). Where the snapshot saw another surface
// (disocclusion while orbiting, a surface not in the pre-pass) the depth does not match → no occlusion.
import * as THREE from 'three/webgpu';
import { Fn, context, float, vec2, vec4, ivec2, uniform, textureLoad, screenUV, normalView, positionView, positionWorld,
    Discard, min, sqrt, select, If } from 'three/tsl';
import { RASTER } from './config.js';
import { memoryBudget } from './memory-budget.js';

const BLUR = [[-2, 0.5], [-1, 1], [0, 1], [1, 1], [2, 0.5]];   // per axis: an even 4-wide box centred on the texel
// resolution steps (share of the picture per side): the base (settings.resolution) and finer ones when zoomed out
const STEPS = [0.71, 1];
const BYTES_PER_TEXEL = 3 * 8 + 4;   // three RGBA half float targets + the pre-pass depth

export class RasterAO {
    /**
     * @param {THREE.WebGPURenderer} renderer
     */
    constructor(renderer) {
        this.renderer = renderer;
        this.settings = RASTER.ao;
        this.enabled = this.settings.enabled;
        // ?ao=0: not even hooked into the materials (comparison with the shaders as they were)
        this.supported = !!renderer.backend?.isWebGPUBackend && new URLSearchParams(location.search).get('ao') !== '0';
        this.active = uniform(0);                        // 1 only during the main render (materials)
        this.size = uniform(new THREE.Vector2(1, 1));    // AO target size (texels)
        this.depthScale = uniform(1);                    // depth stored ÷ this (half float range for any scene size)
        this.radius = uniform(1);                        // world units
        this.strength = uniform(this.settings.strength);
        this.maxPx = uniform(64);                        // projected radius at most (AO texels)
        // view position = O + D · depth, both affine in the NDC xy (perspective and orthographic, lens shift included)
        this.rayO = [uniform(new THREE.Vector3()), uniform(new THREE.Vector3()), uniform(new THREE.Vector3())];
        this.rayD = [uniform(new THREE.Vector3()), uniform(new THREE.Vector3()), uniform(new THREE.Vector3())];
        // camera of the snapshot (materials reproject into it)
        this.view = uniform(new THREE.Matrix4());
        this.projection = uniform(new THREE.Matrix4());
        this._full = new THREE.Vector2();
        this._clear = new THREE.Color();
        // schedule: valid snapshot, its view signature, scene changed since, cost of the last pre-pass (ms, smoothed)
        this.valid = false;
        this.dirty = true;
        this._signature = '';
        this._cost = 0;
        this._ranAt = -Infinity;
        this._scale = this.settings.resolution;   // current resolution step (hysteresis)

        const rt = () => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
        this.geo = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
        this.raw = rt();    // r = occlusion (1 = open), g = depth
        this.blur = rt();   // same, blurred – read by the materials

        // 1. normals + depth; the override material takes `transparent` from the scene material (Renderer.renderObject,
        // also for transmission) – part of its cache key, so that variant can discard
        this.geoMaterial = new THREE.NodeMaterial();
        this.geoMaterial.fragmentNode = Fn(builder => {
            if (builder.material.transparent) Discard();
            return vec4(normalView, positionView.z.negate().div(this.depthScale));
        })();
        this.geoMaterial.blending = THREE.NoBlending;   // see contour.js: a surface drawn twice must not blend
        this.geoMaterial.toneMapped = false;

        // 2. occlusion
        const geoTex = this.geo.texture;
        const load = (tex, p) => textureLoad(tex, ivec2(p.clamp(vec2(0), this.size.sub(1))));
        const viewPos = (ndc, depth) => this.rayO[0].add(this.rayO[1].mul(ndc.x)).add(this.rayO[2].mul(ndc.y))
            .add(this.rayD[0].add(this.rayD[1].mul(ndc.x)).add(this.rayD[2].mul(ndc.y)).mul(depth));
        const toNdc = p => vec2(p.x.add(0.5).div(this.size.x).mul(2).sub(1), float(1).sub(p.y.add(0.5).div(this.size.y).mul(2)));
        const samples = this.settings.samples;
        const occlusion = Fn(() => {
            const pix = screenUV.mul(this.size).floor();
            const c = load(geoTex, pix);
            const depth = c.a.mul(this.depthScale);
            const result = vec4(1, 0, 0, 1).toVar();
            If(c.a.greaterThan(0), () => {
                const n = c.rgb.normalize();
                const p = viewPos(toNdc(pix), depth);
                // world units per NDC unit at this depth → radius in texels
                const perNdc = this.rayO[1].x.add(this.rayD[1].x.mul(depth)).abs().max(1e-12);
                const rPx = min(this.radius.mul(this.size.x).mul(0.5).div(perNdc), this.maxPx);
                const sum = float(0).toVar();
                If(rPx.greaterThan(1), () => {
                    // 4×4 rotation pattern (removed by the 4×4 blur)
                    const ix = pix.x.mod(4), iy = pix.y.mod(4);
                    const rot = ix.mul(4).add(iy).mul(7).mod(16).add(0.5).mul(Math.PI * 2 / 16);
                    const r2 = this.radius.mul(this.radius);
                    for (let i = 0; i < samples; i++) {
                        const angle = rot.add(i * 2.399963);   // golden angle spiral
                        const dist = rPx.mul(Math.sqrt((i + 0.5) / samples)).max(1);   // not on the pixel itself
                        const q = pix.add(vec2(angle.cos(), angle.sin()).mul(dist)).floor();
                        const s = load(geoTex, q);
                        const v = viewPos(toNdc(q), s.a.mul(this.depthScale)).sub(p);
                        const vv = v.dot(v);
                        const rise = v.dot(n).div(sqrt(vv).max(1e-12)).sub(this.settings.bias).max(0);
                        const falloff = float(1).sub(vv.div(r2)).max(0);
                        sum.addAssign(select(s.a.greaterThan(0), rise.mul(falloff), float(0)));
                    }
                });
                const ao = float(1).sub(sum.mul(this.strength.mul(2 / samples))).clamp(0, 1);
                result.assign(vec4(ao, c.a, 0, 1));
            });
            return result;
        })();
        this.aoMaterial = new THREE.NodeMaterial();
        this.aoMaterial.fragmentNode = occlusion;
        this.aoMaterial.toneMapped = false;

        // 3. depth-aware blur
        const rawTex = this.raw.texture;
        this.blurMaterial = new THREE.NodeMaterial();
        this.blurMaterial.fragmentNode = Fn(() => {
            const pix = screenUV.mul(this.size).floor();
            const c = load(rawTex, pix);
            const sum = float(0).toVar(), weight = float(0).toVar();
            for (const [dx, wx] of BLUR) {
                for (const [dy, wy] of BLUR) {
                    const s = load(rawTex, pix.add(vec2(dx, dy)));
                    const w = float(wx * wy).mul(float(1).sub(s.g.sub(c.g).abs().div(c.g.mul(0.04).max(1e-6))).max(0));
                    sum.addAssign(s.r.mul(w));
                    weight.addAssign(w);
                }
            }
            return vec4(select(weight.greaterThan(1e-4), sum.div(weight), c.r), c.g, 0, 1);
        })();
        this.blurMaterial.toneMapped = false;
        this.quad = new THREE.QuadMesh(this.aoMaterial);

        // 4. value for the materials: this fragment in the snapshot's camera, the four nearest texels weighted
        // bilinearly and by matching depth; none matching or outside the snapshot → 1
        const blurTex = this.blur.texture;
        this.value = Fn(() => {
            const result = float(1).toVar();
            If(this.active.greaterThan(0), () => {
                const pv = this.view.mul(vec4(positionWorld, 1));
                const clip = this.projection.mul(pv);
                const ndc = clip.xy.div(clip.w);
                const depth = pv.z.negate().div(this.depthScale);
                const f = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5))).mul(this.size).sub(0.5);
                const base = f.floor(), t = f.sub(base);
                const inside = base.x.greaterThanEqual(-1).and(base.y.greaterThanEqual(-1)).and(base.x.lessThan(this.size.x)).and(base.y.lessThan(this.size.y));
                const sum = float(0).toVar(), weight = float(0.002).toVar();   // the fallback 1 weighs 0.002
                for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                    const s = load(blurTex, base.add(vec2(ox, oy)));
                    const bilinear = (ox ? t.x : t.x.oneMinus()).mul(oy ? t.y : t.y.oneMinus()).add(1e-3);
                    const w = bilinear.mul(float(1).sub(s.g.sub(depth).abs().div(depth.mul(0.03).max(1e-6))).max(0));
                    sum.addAssign(s.r.mul(w));
                    weight.addAssign(w);
                }
                result.assign(select(inside, sum.add(0.002).div(weight), float(1)));
            });
            return result;
        })();
    }

    /** renderer.contextNode for the whole session (call once, before any material is built) */
    install() {
        if (!this.supported) return;
        const value = this.value;
        this.renderer.contextNode = context({
            getAO: (input, { material }) => {
                if (!receives(material)) return input;
                return input !== null ? input.mul(value) : value;
            },
        });
    }

    /** Wanted at all? (setting, backend) */
    get on() {
        return this.supported && this.enabled;
    }

    /** The scene changed (geometry, transforms, visibility, materials, section plane): the snapshot is outdated */
    markDirty() {
        this.dirty = true;
    }

    /**
     * Pre-pass due for `camera` this frame? Not when nothing changed since the snapshot; after a change at most in
     * proportion to its cost (large assemblies: the materials reproject the last snapshot meanwhile).
     * @param {THREE.Camera} camera
     * @param {boolean} [always] scene changes are not reported (batcher off) – treat as changed
     */
    due(camera, always = false) {
        camera.updateMatrixWorld();
        const size = this.renderer.getDrawingBufferSize(this._full);
        const signature = `${camera.matrixWorld.elements.join()}|${camera.projectionMatrix.elements.join()}|${size.x}x${size.y}`;
        if (this.valid && !this.dirty && !always && signature === this._signature) return false;
        if (!this.valid) return true;
        return performance.now() - this._ranAt >= this._cost * this.settings.costRatio;
    }

    /** A snapshot to show this frame (without a pre-pass): switch the materials' AO on */
    reuse() {
        if (this.valid) this.active.value = 1;
    }

    /**
     * Pre-pass + occlusion for `camera` – called from inside the main render (batches attached), then switches the
     * materials' AO on. Restores the render target, cube face, clear colour and scene state.
     * @param {{ scene: THREE.Scene, camera: THREE.Camera, keep: THREE.Object3D, radius: number, depthScale: number }} opts
     */
    prepare({ scene, camera, keep, radius, depthScale }) {
        const t0 = performance.now();
        const { renderer } = this;
        const current = renderer.getRenderTarget();
        if (current) this._full.set(current.width, current.height);
        else renderer.getDrawingBufferSize(this._full);
        this._rays(camera);
        const scale = this._resolution(radius, depthScale);
        const w = Math.max(1, Math.round(this._full.x * scale)), h = Math.max(1, Math.round(this._full.y * scale));
        if (this.geo.width !== w || this.geo.height !== h) {
            this.geo.setSize(w, h);
            this.raw.setSize(w, h);
            this.blur.setSize(w, h);
        }
        this.size.value.set(w, h);
        this.radius.value = radius;
        this.depthScale.value = Math.max(depthScale, 1e-9);
        this.maxPx.value = Math.max(2, h * this.settings.maxScreen);
        this.view.value.copy(camera.matrixWorldInverse);
        this.projection.value.copy(camera.projectionMatrix);

        const restore = this._enter(scene, keep);
        try {
            renderer.setRenderTarget(this.geo);
            renderer.render(scene, camera);
            restore.scene();
            renderer.setRenderTarget(this.raw);
            this.quad.material = this.aoMaterial;
            this.quad.render(renderer);
            renderer.setRenderTarget(this.blur);
            this.quad.material = this.blurMaterial;
            this.quad.render(renderer);
            this.valid = true;
            this.dirty = false;
            this._signature = `${camera.matrixWorld.elements.join()}|${camera.projectionMatrix.elements.join()}|${renderer.getDrawingBufferSize(this._full).toArray().join('x')}`;
            this.active.value = 1;
        } finally {
            restore.all();
        }
        const cost = performance.now() - t0;
        this._cost = this._cost ? this._cost * 0.7 + cost * 0.3 : cost;
        this._ranAt = performance.now();
    }

    /**
     * Shader variants of the pre-pass for what `compile` collects (render-batcher.js compilePasses: staged batches)
     * @param {THREE.Scene} scene
     * @param {THREE.Object3D} keep
     * @param {() => Promise} compile
     */
    compile(scene, keep, compile) {
        // also while switched off: switching on later must not build every batch at once
        if (!this.supported) return Promise.resolve();
        const restore = this._enter(scene, keep);
        try {
            this.renderer.setRenderTarget(this.geo);
            return compile();
        } finally {
            restore.all();
        }
    }

    // Resolution of the AO targets (share of the picture per side). The radius is fixed in world units (share of the
    // scene size), so zoomed out it covers only a few texels at the base resolution – the samples fell onto the pixel
    // itself and the 4×4 blur averaged thin creases away, the occlusion faded out. Then finer steps, chosen so that the
    // radius at the orbit centre spans at least `minTexels` (one step back only with a margin – resizing reallocates).
    // At most the memory share of the budget (memory-budget.js); the base also at most `maxPixels`.
    _resolution(radius, depth) {
        const { settings } = this;
        const pixels = Math.max(this._full.x * this._full.y, 1);
        const perNdc = Math.max(Math.abs(this.rayO[1].value.x + this.rayD[1].value.x * depth), 1e-12);
        const radiusPx = radius * this._full.x * 0.5 / perNdc;   // at full resolution
        const steps = [settings.resolution, ...STEPS.filter(s => s > settings.resolution)];
        const index = steps.indexOf(this._scale);
        let want = steps.findIndex(s => s * radiusPx >= settings.minTexels);
        if (want < 0) want = steps.length - 1;
        if (want < index && steps[index - 1] * radiusPx < settings.minTexels * 1.25) want = index;   // hysteresis
        this._scale = steps[want];
        const budget = memoryBudget() * settings.memoryShare / BYTES_PER_TEXEL;
        const cap = Math.min(budget, want === 0 ? settings.maxPixels : Infinity);
        return Math.min(this._scale, Math.sqrt(cap / pixels));
    }

    /** After the main render: materials back to no occlusion */
    finish() {
        this.active.value = 0;
    }

    // renderer + scene state of the pre-pass (only `keep` of the scene's children, no background, override material);
    // returns restore functions: scene() = scene state only, all() = everything
    _enter(scene, keep) {
        const { renderer } = this;
        const prev = {
            target: renderer.getRenderTarget(), face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(), autoClear: renderer.autoClear,
            background: scene.background, backgroundNode: scene.backgroundNode, override: scene.overrideMaterial,
            clearAlpha: renderer.getClearAlpha(), toneMapping: renderer.toneMapping, mrt: renderer.getMRT(),
        };
        renderer.getClearColor(this._clear);
        const hidden = [];
        for (const o of scene.children) if (o.visible && o !== keep) { o.visible = false; hidden.push(o); }
        scene.background = null;
        scene.backgroundNode = null;
        scene.overrideMaterial = this.geoMaterial;
        renderer.setClearColor(0x000000, 0);
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.setMRT(null);
        renderer.autoClear = true;
        const restoreScene = () => {
            for (const o of hidden) o.visible = true;
            hidden.length = 0;
            scene.overrideMaterial = prev.override;
            scene.background = prev.background;
            scene.backgroundNode = prev.backgroundNode;
        };
        return {
            scene: restoreScene,
            all: () => {
                restoreScene();
                renderer.setClearColor(this._clear, prev.clearAlpha);
                renderer.toneMapping = prev.toneMapping;
                renderer.setMRT(prev.mrt);
                renderer.autoClear = prev.autoClear;
                renderer.setRenderTarget(prev.target, prev.face, prev.mip);
            },
        };
    }

    // view position as an affine function of the NDC xy: O(ndc) + D(ndc) · depth (D.z = −1)
    _rays(camera) {
        const inv = camera.projectionMatrixInverse;
        const at = (x, y) => {
            const a = new THREE.Vector3(x, y, 0.25).applyMatrix4(inv), b = new THREE.Vector3(x, y, 0.75).applyMatrix4(inv);
            const dir = b.clone().sub(a);
            const d = dir.clone().divideScalar(-dir.z);           // per unit of depth
            const o = a.clone().addScaledVector(d, a.z);          // where depth would be 0
            return { o, d };
        };
        const c = at(0, 0), x = at(1, 0), y = at(0, 1);
        this.rayO[0].value.copy(c.o);
        this.rayO[1].value.copy(x.o).sub(c.o);
        this.rayO[2].value.copy(y.o).sub(c.o);
        this.rayD[0].value.copy(c.d);
        this.rayD[1].value.copy(x.d).sub(c.d);
        this.rayD[2].value.copy(y.d).sub(c.d);
    }

    dispose() {
        this.geo.dispose();
        this.raw.dispose();
        this.blur.dispose();
    }
}

// opaque lit standard/physical materials; every property checked here is part of three's material cache key
function receives(material) {
    if (!material?.isMeshStandardNodeMaterial) return false;
    if (material.transparent || material.transmission > 0) return false;
    if (material.toon || material.flat || material.soap) return false;
    return true;
}

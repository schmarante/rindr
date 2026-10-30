// Upscaling with history for the path tracer while orbiting (pathtracer.js, filter 'denoise'): instead of a purely
// spatial upscale (FSR) of the reduced image, every frame is traced with another known offset within the pixel
// (PT_MOTION.jitter, Halton sequence – the same for every pixel) and accumulated into a history at the size of the
// screen. After a few frames each screen pixel holds samples of its own: sharp edges and textures instead of the
// reduced image's steps. Own implementation after
//   - Karis 2014, "High Quality Temporal Supersampling" (neighbourhood clamp, Catmull-Rom history)
//   - Yang et al. 2009, "Amortized Supersampling" (samples weighted by their distance to the screen pixel)
// three.js' TAAUNode works the same way but expects depth and velocity of a raster pass and jitters the camera
// itself; here the reprojection comes from the path tracer's own guides (pt-guides.js: position through mirrors and
// glass, fisheye), like the denoiser's history (motion-denoise.js).
//
// Passes (screen size):
//   1. resolve: the 3 × 3 denoised samples around the pixel, each weighted by a Gaussian of its distance in screen
//      pixels (jittered position); the history reprojected by the motion of the closest sample around (world position →
//      previous camera, direction for the background), checked against the distance stored for the previous frame,
//      clamped to mean ± γ·σ of the samples' neighbourhood; both blended by their weights (history capped)
//   2. aux: distance to the camera of the closest sample around (next frame's check)
//   3. present: the history with alpha 1 (its alpha is the accumulated weight – shown as is, the picture turned dark
//      wherever the history had been rejected)
//   4. blend (after orbiting): the history fades over the image that refines – shown only, never part of the
//      accumulation (the final image stays exactly as before)
import * as THREE from 'three/webgpu';
import { compileAsync } from './shader-compile.js';
import { previousUv } from './motion-denoise.js';
import { Fn, texture, uniform, screenUV, vec2, vec3, vec4, float, dot, max, min, abs, exp, sqrt, floor, select, mix,
    clamp, length, saturate, If } from 'three/tsl';

// 2.29: Gaussian fit of the Blackman-Harris window over ±1.5 pixels (Karis 2014)
const SHARPNESS = 2.29;

/** Halton sequence (base b), index ≥ 1 */
function halton(index, base) {
    let f = 1, r = 0;
    for (let i = index; i > 0; i = Math.floor(i / base)) { f /= base; r += f * (i % base); }
    return r;
}

export class MotionUpscaler {
    /**
     * @param {THREE.WebGPURenderer} renderer
     * @param {{ frames?: number, clampGamma?: number, seedSamples?: number }} options (PATHTRACING.motionUpscale)
     */
    constructor(renderer, { frames = 16, clampGamma = 1.25, seedSamples = 16 } = {}) {
        this.renderer = renderer;
        this.frames = frames;
        this.seedSamples = seedSamples;
        const rt = (filter = THREE.LinearFilter) => new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType,
            depthBuffer: false, minFilter: filter, magFilter: filter });
        this._hist = rt();
        this._histPrev = rt();
        this._aux = rt(THREE.NearestFilter);
        this._auxPrev = rt(THREE.NearestFilter);
        this._output = rt();
        this._hist.texture.name = 'MotionUpscale';
        this._output.texture.name = 'MotionUpscale output';
        this._targets = [this._hist, this._histPrev, this._aux, this._auxPrev, this._output];
        this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));   // see motion-denoise.js (no QuadMesh)
        this._quad.name = 'MotionUpscale';
        this._quad.frustumCulled = false;
        this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this._jitterIndex = 0;
        this.jitter = new THREE.Vector2(0.5, 0.5);
        this.hasHistory = false;           // _hist holds an image of the view below (blend)
        this._historyOk = false;           // _histPrev/_auxPrev belong to the previous frame
        this._prev = { view: new THREE.Matrix4(), proj: new THREE.Matrix4(), pos: new THREE.Vector3(), k: 1, aspect: 1 };
        this._view = new THREE.Matrix4();  // camera of the history (blend: still the same view?)
        this._proj = new THREE.Matrix4();

        const u = this.u = {
            srcSize: uniform(new THREE.Vector2(1, 1)),
            ratio: uniform(new THREE.Vector2(1, 1)),     // screen pixels per source pixel
            histSize: uniform(new THREE.Vector2(1, 1)),
            jitter: uniform(new THREE.Vector2(0.5, 0.5)),
            prevView: uniform(new THREE.Matrix4()),
            prevProj: uniform(new THREE.Matrix4()),
            prevCamPos: uniform(new THREE.Vector3()),
            camPos: uniform(new THREE.Vector3()),
            prevK: uniform(1),
            prevAspect: uniform(1),
            tanLimit: uniform(1),
            historyOk: uniform(0),
            capWeight: uniform(1),     // history weight limit (frames × sample weight per frame)
            seed: uniform(0),          // blend: share of the history at full confidence
        };
        const src = this._src = texture(null);
        const gPos = this._gPos = texture(null), gNormal = this._gNormal = texture(null);
        const histPrev = texture(this._histPrev.texture), auxPrev = texture(this._auxPrev.texture);
        const texelOf = i => i.add(0.5).div(u.srcSize);
        // nearest sample: its index (sample of texel i lies at i + jitter)
        const nearest = f => floor(f.add(0.5));
        // the closest surface among the 3 × 3 samples around (Karis 2014: dilated motion) – at silhouettes the nearest
        // sample is the object in one frame and the background in the next (other offset): with it the history was
        // rejected there every other frame and the edges stayed stepped
        const closest = i0 => {
            const best = i0.toVar(), dist = float(1e30).toVar();
            for (let y = -1; y <= 1; y++) {
                for (let x = -1; x <= 1; x++) {
                    const i = i0.add(vec2(x, y));
                    const g = gPos.sample(texelOf(i));
                    const d = select(g.w.greaterThan(0), length(g.xyz.sub(u.camPos)), float(1e30));
                    If(d.lessThan(dist), () => { dist.assign(d); best.assign(i); });
                }
            }
            return best;
        };

        // history, Catmull-Rom (5 taps over bilinear lookups) – bilinear alone blurs a little more with every frame
        const catmullRom = uv => {
            const size = u.histSize;
            const pos = uv.mul(size);
            const t1 = floor(pos.sub(0.5)).add(0.5);
            const f = pos.sub(t1);
            const w0 = f.mul(f.mul(f.mul(-0.5).add(1)).sub(0.5));
            const w1 = f.mul(f).mul(f.mul(1.5).sub(2.5)).add(1);
            const w2 = f.mul(f.mul(f.mul(-1.5).add(2)).add(0.5));
            const w3 = f.mul(f).mul(f.mul(0.5).sub(0.5));
            const w12 = w1.add(w2);
            const t0 = t1.sub(1).div(size), t3 = t1.add(2).div(size), t12 = t1.add(w2.div(w12)).div(size);
            const c = histPrev.sample(vec2(t12.x, t0.y)).rgb.mul(w12.x.mul(w0.y))
                .add(histPrev.sample(vec2(t0.x, t12.y)).rgb.mul(w0.x.mul(w12.y)))
                .add(histPrev.sample(t12).rgb.mul(w12.x.mul(w12.y)))
                .add(histPrev.sample(vec2(t3.x, t12.y)).rgb.mul(w3.x.mul(w12.y)))
                .add(histPrev.sample(vec2(t12.x, t3.y)).rgb.mul(w12.x.mul(w3.y)));
            const w = w12.x.mul(w0.y).add(w0.x.mul(w12.y)).add(w12.x.mul(w12.y)).add(w3.x.mul(w12.y)).add(w12.x.mul(w3.y));
            return max(c.div(w), vec3(0));
        };

        // 1. resolve
        this._resolveMaterial = new THREE.NodeMaterial();
        this._resolveMaterial.fragmentNode = Fn(() => {
            const p = screenUV;
            const f = p.mul(u.srcSize).sub(u.jitter).toVar();
            const i0 = nearest(f).toVar();
            const sum = vec3(0).toVar(), wsum = float(0).toVar(), m1 = vec3(0).toVar(), m2 = vec3(0).toVar();
            for (let y = -1; y <= 1; y++) {
                for (let x = -1; x <= 1; x++) {
                    const i = i0.add(vec2(x, y));
                    const c = src.sample(texelOf(i)).rgb;
                    const d = f.sub(i).mul(u.ratio);
                    const inside = i.x.greaterThanEqual(0).and(i.y.greaterThanEqual(0)).and(i.x.lessThan(u.srcSize.x)).and(i.y.lessThan(u.srcSize.y));
                    const w = select(inside, exp(dot(d, d).mul(-SHARPNESS)), float(0));
                    sum.addAssign(c.mul(w));
                    wsum.addAssign(w);
                    m1.addAssign(c);
                    m2.addAssign(c.mul(c));
                }
            }
            // smooth stand-in where the history is missing: bilinear at the samples' real positions
            const fill = src.sample(f.add(0.5).div(u.srcSize)).rgb;
            const current = select(wsum.greaterThan(1e-3), sum.div(max(wsum, 1e-6)), fill);
            const out = vec4(fill, wsum).toVar();

            const ic = closest(i0);
            const tc = texelOf(ic);
            const g = gPos.sample(tc), n = gNormal.sample(tc).xyz;
            const surface = g.w.greaterThan(0);
            // motion of that sample (its uv now: texel + offset) applied to this pixel – reprojecting the sample's
            // position itself sent every pixel around it to the same point (blocks, washed-out textures)
            const motion = select(surface, previousUv(u, g.xyz), previousUv(u, n, 0)).sub(ic.add(u.jitter).div(u.srcSize));
            const puv = p.add(motion).toVar();
            const inView = motion.x.greaterThan(-1).and(puv.x.greaterThan(0).and(puv.x.lessThan(1)).and(puv.y.greaterThan(0)).and(puv.y.lessThan(1)));
            If(u.historyOk.greaterThan(0).and(inView), () => {
                const aux = auxPrev.sample(puv);
                const dist = length(g.xyz.sub(u.prevCamPos));
                // distance only: the sample is another point each frame (other offset) – with normal maps its normal
                // differs from the previous one's (a normal test rejected half of a fabric's pixels every frame)
                const sameSurface = aux.w.greaterThan(0).and(abs(aux.w.sub(dist)).lessThan(dist.mul(0.04)));
                const ok = select(surface, sameSurface, aux.w.lessThan(0));
                If(ok, () => {
                    const mean = m1.div(9);
                    const sigma = sqrt(max(m2.div(9).sub(mean.mul(mean)), vec3(0))).mul(clampGamma);
                    const hist = clamp(catmullRom(puv), mean.sub(sigma), mean.add(sigma));
                    const hw = min(histPrev.sample(puv).a, u.capWeight);
                    out.assign(vec4(hist.mul(hw).add(current.mul(wsum)).div(max(hw.add(wsum), 1e-6)), hw.add(wsum)));
                });
            });
            return out;
        })();

        // 2. aux: distance of the closest sample around (background: −1)
        this._auxMaterial = new THREE.NodeMaterial();
        this._auxMaterial.fragmentNode = Fn(() => {
            const g = gPos.sample(texelOf(closest(nearest(screenUV.mul(u.srcSize).sub(u.jitter)))));
            return vec4(0, 0, 0, select(g.w.greaterThan(0), length(g.xyz.sub(u.camPos)), float(-1)));
        })();

        // 3. present
        const hist = texture(this._hist.texture);
        this._presentMaterial = new THREE.NodeMaterial();
        this._presentMaterial.fragmentNode = vec4(hist.sample(screenUV).rgb, 1);

        // 4. blend: history over the refining image, by its confidence (accumulated weight)
        const input = this._input = texture(null);
        this._blendMaterial = new THREE.NodeMaterial();
        this._blendMaterial.fragmentNode = Fn(() => {
            const c = input.sample(screenUV), h = hist.sample(screenUV);
            const k = saturate(h.a.div(u.capWeight)).mul(u.seed);
            return vec4(mix(c.rgb, h.rgb, k), c.a);
        })();

        this._passes = [this._resolveMaterial, this._auxMaterial, this._presentMaterial, this._blendMaterial];
        for (const m of this._passes) { m.depthTest = m.depthWrite = false; m.toneMapped = false; }
        this._passTargets = new Map([[this._resolveMaterial, this._hist], [this._auxMaterial, this._aux], [this._presentMaterial, this._output],
            [this._blendMaterial, this._output]]);
    }

    /** next offset within the pixel (Halton 2, 3 – 0..1 per axis), for the path tracer and the guides of this frame */
    nextJitter() {
        const i = (this._jitterIndex++ % 64) + 1;
        return this.jitter.set(halton(i, 2), halton(i, 3));
    }

    _setInputs(source, guides) {
        this._src.value = source;
        this._input.value = source;
        this._gPos.value = guides.position;
        this._gNormal.value = guides.normal;
    }

    /** compile the passes asynchronously (see MotionDenoiser.compile) */
    compile(source, guides) {
        const r = this.renderer, jobs = [];
        const target = r.getRenderTarget();
        try {
            this._setInputs(source, guides);
            for (const [material, t] of this._passTargets) {
                r.setRenderTarget(t);
                this._quad.material = material;
                jobs.push(compileAsync(r, this._quad, this._quadCamera));
            }
        } finally {
            r.setRenderTarget(target);
        }
        return Promise.all(jobs);
    }

    /** forget the history (other picture: materials, scene, light …) */
    dropHistory() {
        this._historyOk = false;
        this.hasHistory = false;
    }

    /** the history shows this view (blend) */
    sameView(camera) {
        return this.hasHistory && this._view.equals(camera.matrixWorld) && this._proj.equals(camera.projectionMatrix);
    }

    _draw(t, material) {
        const r = this.renderer;
        r.setRenderTarget(t);
        this._quad.material = material;
        r.render(this._quad, this._quadCamera);
    }

    _withState(fn) {
        const r = this.renderer;
        const target = r.getRenderTarget(), autoClear = r.autoClear, mrt = r.getMRT();
        r.autoClear = true;
        r.setMRT(null);
        try {
            return fn();
        } finally {
            r.setMRT(mrt);
            r.setRenderTarget(target);
            r.autoClear = autoClear;
        }
    }

    /**
     * Accumulate the denoised image `source` (traced with offset `jitter`) into the history at screen size.
     * @param {THREE.Texture} source
     * @param {{ guides: { position, normal }, camera: THREE.Camera, lens: { k, aspect, tanLimit }, jitter: THREE.Vector2 }} opts
     * @returns {THREE.Texture} the history with alpha 1 (screen size)
     */
    accumulate(source, { guides, camera, lens, jitter }) {
        const r = this.renderer;
        const size = r.getDrawingBufferSize(new THREE.Vector2());
        const W = Math.max(size.x, 1), H = Math.max(size.y, 1);
        const w = source.image?.width ?? source.width, h = source.image?.height ?? source.height;
        let resized = false;
        for (const t of this._targets) {
            if (t.width !== W || t.height !== H) { t.setSize(W, H); resized = true; }
        }
        if (resized) {
            this._historyOk = false;
            for (const t of this._targets) r.initRenderTarget(t);   // copy targets need their GPU texture now
        }
        const u = this.u, p = this._prev;
        u.srcSize.value.set(w, h);
        u.ratio.value.set(W / w, H / h);
        u.histSize.value.set(W, H);
        // in the passes' uv the rows run the other way: row 0 of the path traced image is the bottom of the view (ndc −1),
        // uv y 0 the top – the offset in y mirrored (taken as is, the samples sat up to a pixel off: fine horizontal
        // stripes washed out)
        u.jitter.value.set(jitter.x, 1 - jitter.y);
        u.prevView.value.copy(p.view);
        u.prevProj.value.copy(p.proj);
        u.prevCamPos.value.copy(p.pos);
        u.prevK.value = p.k;
        u.prevAspect.value = p.aspect;
        u.tanLimit.value = lens.tanLimit;
        u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
        u.historyOk.value = this._historyOk ? 1 : 0;
        // sample weight per screen pixel and frame ≈ (source pixels / screen pixels) · π / sharpness
        u.capWeight.value = this.frames * (w * h) / (W * H) * Math.PI / SHARPNESS;
        this._setInputs(source, guides);
        this._withState(() => {
            this._draw(this._hist, this._resolveMaterial);
            this._draw(this._aux, this._auxMaterial);
            r.copyTextureToTexture(this._hist.texture, this._histPrev.texture);
            r.copyTextureToTexture(this._aux.texture, this._auxPrev.texture);
            this._draw(this._output, this._presentMaterial);
        });
        p.view.copy(camera.matrixWorldInverse);
        p.proj.copy(camera.projectionMatrix);
        p.pos.copy(u.camPos.value);
        p.k = lens.k;
        p.aspect = lens.aspect;
        this._view.copy(camera.matrixWorld);
        this._proj.copy(camera.projectionMatrix);
        this._historyOk = this.hasHistory = true;
        return this._output.texture;
    }

    /**
     * The history over `input` (any size, the refining image), share `seed` at full confidence.
     * @returns {THREE.Texture}
     */
    blend(input, seed) {
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        if (!this.hasHistory || this._hist.width !== size.x || this._hist.height !== size.y) { this.dropHistory(); return input; }
        this.u.seed.value = seed;
        this._input.value = input;
        this._withState(() => this._draw(this._output, this._blendMaterial));
        return this._output.texture;
    }

    dispose() {
        for (const t of this._targets) t.dispose();
        this._quad.geometry.dispose();
        for (const m of this._passes) m.dispose();
    }
}

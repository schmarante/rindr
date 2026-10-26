// Light passes of a render on the GPU (docs/pathtracer.md "Licht-Passes", light-passes.js): assembled from the buckets,
// denoised one by one, their sum (the source passes) shown as the path tracer's picture (pathtracer.js swaps it into
// its image chain – the layers add up to what is seen), read back for the layered export (EXR, PSD). One rgba16float texture per pass with light (rgb = the pass, premultiplied) – created with
// the first bucket that has light in it (empty light slots, emission, refraction without glass cost nothing; until
// then the mix samples a black 1 × 1 texture).
import * as THREE from 'three/webgpu';
import { texture as textureNode, uniform, uv, vec3, vec4 } from 'three/tsl';
import { PASS, SOURCE_PASSES, KIND_PASSES } from './light-passes.js';
import { t } from './i18n.js';

/** label of a pass (light slots: the scene's light names) */
export function passLabel(index, lights = []) {
    if (index < 4) return lights[index] || t('lightMix.light', { n: index + 1 });
    const key = { [PASS.ENVIRONMENT]: 'environment', [PASS.BACKGROUND]: 'background', [PASS.EMISSION]: 'emission',
        [PASS.DIFFUSE]: 'diffuse', [PASS.REFLECTION]: 'reflection', [PASS.REFRACTION]: 'refraction',
        [PASS.DIRECT_EMISSION]: 'directEmission', [PASS.DIRECT_BACKGROUND]: 'directBackground', [PASS.SHADOW]: 'shadow',
        [PASS.TRANSPARENCY]: 'alpha' }[index];
    return t(`lightMix.pass.${key}`);
}

const USAGE = () => GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.STORAGE_BINDING;

// float → half float bits (round to nearest; overflow → inf, tiny → 0)
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function toHalf(value) {
    f32[0] = value;
    const x = u32[0], sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 127 + 15;
    const m = x & 0x7fffff;
    if (e >= 31) return sign | (((x >>> 23) & 0xff) === 0xff && m ? 0x7e00 : 0x7c00);
    if (e <= 0) {
        if (e < -10) return sign;
        const mm = (m | 0x800000) >> (1 - e);
        return sign | ((mm + 0x1000) >> 13);
    }
    const h = sign | (e << 10) | (m >> 13);
    return h + ((m >> 12) & 1);   // rounding may carry into the exponent – still correct
}
const HALF_TABLE = (() => {
    const t = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
        const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
        t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
    }
    return t;
})();
export const fromHalf = h => HALF_TABLE[h];

/**
 * Rows y0 … y0 + rows of a GPU texture (rgba16float or rgba32float) as float RGBA – row 0 is the top (storage textures
 * written top down, render targets)
 */
export async function readTexture(renderer, gpuTexture, format, width, y0, rows) {
    const device = renderer.backend.device;
    const bytes = format === 'rgba32float' ? 16 : 8;
    const bytesPerRow = Math.ceil(width * bytes / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * rows, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: gpuTexture, origin: { x: 0, y: y0 } }, { buffer, bytesPerRow }, { width, height: rows });
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(width * rows * 4);
    if (bytes === 16) {
        const src = new Float32Array(buffer.getMappedRange());
        const stride = bytesPerRow / 4;
        for (let y = 0; y < rows; y++) out.set(src.subarray(y * stride, y * stride + width * 4), y * width * 4);
    } else {
        const half = new Uint16Array(buffer.getMappedRange());
        const stride = bytesPerRow / 2;
        for (let y = 0; y < rows; y++) {
            for (let i = 0, s = y * stride, d = y * width * 4; i < width * 4; i++) out[d + i] = HALF_TABLE[half[s + i]];
        }
    }
    buffer.unmap();
    buffer.destroy();
    return out;
}

export class LightMix {
    constructor(renderer) {
        this.renderer = renderer;
        this.width = 0;
        this.height = 0;
        this.textures = [];       // GPUTexture per pass (null: no light so far)
        this.external = [];       // three ExternalTexture per pass (sampling; the black one while empty)
        this._black = null;       // 1 × 1 black texture for empty passes
        this.peak = new Float32Array(PASS.COUNT);   // largest value per pass (empty passes: 0)
        this.denoised = new Array(PASS.COUNT).fill(false);
        this.lights = [];         // names of the light slots used (path tracer order)
        this._target = null;
        this._quad = null;
        this._dirty = true;
        this._held = 0;           // saves reading the passes (hold) – disposeTextures waits for them
        this._freeLater = false;
        this.layout = null;       // pass indices a bucket brings, in its order (begin)
        this._grey = uniform(0);  // background added through the transparency pass (setBackground)
    }

    /** keep the passes until the returned release() – a restart (camera moved) ends the mix while a file is written */
    hold() {
        this._held++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--this._held === 0 && this._freeLater) this._free();
        };
    }

    /**
     * new render w × h; lights: names of the path tracer's lights in its order; layout: the pass indices a bucket
     * brings (default all – a transparent PNG: MATTE_PASSES)
     */
    begin(width, height, lights = [], { layout = null } = {}) {
        this._free();
        this.width = width;
        this.height = height;
        this.lights = lights;
        this.layout = layout ?? Array.from({ length: PASS.COUNT }, (_, i) => i);
        this.matte = !!layout && !layout.some(i => i > 0 && i !== PASS.TRANSPARENCY);   // transparent PNG (MATTE_PASSES)
        this._grey.value = 0;
        if (!this._black) {
            const t = this.renderer.backend.device.createTexture({ size: [1, 1], format: 'rgba16float', usage: USAGE(), label: 'Light pass (empty)' });
            this._black = new THREE.ExternalTexture(t);
            this._black.image = { width: 1, height: 1 };
        }
        this.textures = new Array(PASS.COUNT).fill(null);
        this.external = new Array(PASS.COUNT).fill(this._black);
        this.peak.fill(0);
        this.denoised.fill(false);
        this._buildQuad();
        this._dirty = true;
    }

    /** bytes the passes take on the GPU now (and with all of them) */
    bytes(all = false) {
        const n = all ? PASS.COUNT : this.textures.filter(Boolean).length;
        return n * this.width * this.height * 8;
    }

    // the texture of a pass – created when it first gets light (zero-initialised: buckets without light stay black)
    _texture(index) {
        if (!this.textures[index]) {
            const t = this.renderer.backend.device.createTexture({ size: [this.width, this.height], format: 'rgba16float', usage: USAGE(), label: `Light pass ${index}` });
            this.textures[index] = t;
            this.external[index] = this._wrap(t);
            if (this._nodes) this._nodes[index].value = this.external[index];
        }
        return this.textures[index];
    }

    _wrap(gpuTexture) {
        const t = new THREE.ExternalTexture(gpuTexture);
        t.image = { width: this.width, height: this.height };
        t.minFilter = t.magFilter = THREE.NearestFilter;
        return t;
    }

    /** a bucket: passes = means pixel-major (w·h·layout·rgb, rows top down) */
    put(bucket, passes) {
        const { x, y, w, h } = bucket;
        const device = this.renderer.backend.device;
        const half = new Uint16Array(w * h * 4);
        const ONE = toHalf(1);
        const count = this.layout.length;
        for (let k = 0; k < count; k++) {
            const p = this.layout[k];
            let peak = 0, any = false;
            for (let i = 0; i < w * h; i++) {
                const o = (i * count + k) * 3;
                const r = passes[o], g = passes[o + 1], b = passes[o + 2];
                if (r || g || b) { any = true; peak = Math.max(peak, r, g, b); }
                half[i * 4] = toHalf(r);
                half[i * 4 + 1] = toHalf(g);
                half[i * 4 + 2] = toHalf(b);
                half[i * 4 + 3] = ONE;
            }
            this.peak[p] = Math.max(this.peak[p], peak);
            if (!any && !this.textures[p]) continue;   // still no light in this pass
            device.queue.writeTexture({ texture: this._texture(p), origin: { x, y } }, half, { bytesPerRow: w * 8, rowsPerImage: h }, { width: w, height: h });
        }
        this._dirty = true;
    }

    /** every pass with light denoised */
    get complete() {
        return this.layout.every(i => !this.has(i) || this.denoised[i]);
    }

    /** label of a pass for the status (transparent PNG: its first slot is the picture without background) */
    label(index) {
        return this.matte && index === 0 ? t('lightMix.pass.picture') : passLabel(index, this.lights);
    }

    /** the pass has light (> a trace of float noise) */
    has(index) {
        return this.peak[index] > 1e-6;
    }

    // ---- denoising ----

    /**
     * Each pass with light through OIDN with the same guides (albedo, normal: three textures) – sources first (they make
     * up the mixed picture), then kinds and shadow. unet: oidn-web network (aux); onProgress(0…1, done, total, pass);
     * signal: AbortSignal. Replaced passes show at once.
     */
    async denoise(unet, albedo, normal, { onProgress, signal } = {}) {
        const backend = this.renderer.backend;
        this.renderer.initTexture(albedo);
        this.renderer.initTexture(normal);
        const order = [...SOURCE_PASSES, PASS.TRANSPARENCY, ...KIND_PASSES, PASS.SHADOW].filter(i => this.has(i) && !this.denoised[i]);
        const { width, height } = this;
        for (let n = 0; n < order.length; n++) {
            if (signal?.aborted) throw new DOMException('Denoise aborted', 'AbortError');
            const index = order[n];
            onProgress?.(n / order.length, n, order.length, index);
            const output = await new Promise((resolve, reject) => {
                const abort = unet.tileExecute({
                    color: { data: this.textures[index], width, height },
                    albedo: { data: backend.get(albedo).texture, width, height },
                    normal: { data: backend.get(normal).texture, width, height },
                    done: resolve,
                });
                signal?.addEventListener('abort', () => { abort?.(); reject(new DOMException('Denoise aborted', 'AbortError')); }, { once: true });
            });
            if (signal?.aborted) throw new DOMException('Denoise aborted', 'AbortError');
            this._replace(index, output);
            this.denoised[index] = true;
        }
        onProgress?.(1, order.length, order.length);
    }

    // the denoiser's packed output (vec4f per pixel) into a new texture of the pass – the alpha stays the image's
    _replace(index, output) {
        const device = this.renderer.backend.device;
        if (!this._copyPipeline) {
            const module = device.createShaderModule({ code: /* wgsl */`
                @group( 0 ) @binding( 0 ) var<storage, read> src : array<vec4f>;
                @group( 0 ) @binding( 1 ) var old : texture_2d<f32>;
                @group( 0 ) @binding( 2 ) var dst : texture_storage_2d<rgba16float, write>;
                @compute @workgroup_size( 8, 8 )
                fn main( @builtin( global_invocation_id ) gid : vec3u ) {
                    let dims = textureDimensions( dst );
                    if ( gid.x >= dims.x || gid.y >= dims.y ) { return; }
                    let alpha = textureLoad( old, gid.xy, 0 ).a;
                    textureStore( dst, gid.xy, vec4f( max( src[ gid.y * dims.x + gid.x ].rgb, vec3f( 0.0 ) ), alpha ) );
                }
            ` });
            this._copyPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
        }
        const old = this.textures[index];
        const t = device.createTexture({ size: [this.width, this.height], format: 'rgba16float', usage: USAGE(), label: `Light pass ${index} denoised` });
        const bind = device.createBindGroup({ layout: this._copyPipeline.getBindGroupLayout(0), entries: [
            { binding: 0, resource: { buffer: output.data } },
            { binding: 1, resource: old.createView() },
            { binding: 2, resource: t.createView() },
        ] });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this._copyPipeline);
        pass.setBindGroup(0, bind);
        pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
        pass.end();
        device.queue.submit([encoder.finish()]);
        this.textures[index] = t;
        const ext = this._wrap(t);
        this._nodes[index].value = ext;
        if (this.external[index] !== this._black) this.external[index].dispose();
        this.external[index] = ext;
        device.queue.onSubmittedWorkDone().then(() => old.destroy());
        this._dirty = true;
    }

    // ---- the picture ----

    _buildQuad() {
        if (this._quad) return;
        this._nodes = this.external.map(t => textureNode(t, uv()));
        let sum = vec3(0);
        for (const i of SOURCE_PASSES) sum = sum.add(this._nodes[i].rgb);
        // a plain background behind the picture: its colour times the share that comes through (transparent PNG)
        sum = sum.add(this._nodes[PASS.TRANSPARENCY].rgb.mul(this._grey));
        const material = new THREE.NodeMaterial();
        material.fragmentNode = vec4(sum, 1);
        this._quad = new THREE.QuadMesh(material);
        this._quad.name = 'LightMix';
    }

    /**
     * Plain grey background (scene units) behind the picture through the transparency pass – the transparent PNG's
     * second shot without a second render (0 = none). The sum is the picture in front of that background.
     */
    setBackground(grey) {
        if (this._grey.value === grey) return;
        this._grey.value = grey;
        this._dirty = true;
    }

    /** the sum of the source passes (rendered again when a pass changed) */
    texture() {
        if (!this.width) return null;
        if (!this._target || this._target.width !== this.width || this._target.height !== this.height) {
            this._target?.dispose();
            this._target = new THREE.RenderTarget(this.width, this.height, { type: THREE.HalfFloatType, depthBuffer: false });
            this._target.texture.minFilter = this._target.texture.magFilter = THREE.LinearFilter;
            this._dirty = true;
        }
        if (this._dirty) {
            this._dirty = false;
            const r = this.renderer, before = r.getRenderTarget(), autoClear = r.autoClear;
            r.setRenderTarget(this._target);
            r.autoClear = true;
            this._quad.render(r);
            r.setRenderTarget(before);
            r.autoClear = autoClear;
        }
        return this._target.texture;
    }

    // ---- export ----

    /** One pass as float RGBA (rows top down) – rows y0 … y0 + rows. index 'sum' = the picture (sum of the sources). */
    async read(index, { y0 = 0, rows = this.height } = {}) {
        const source = index === 'sum' ? this.renderer.backend.get(this.texture()).texture : this.textures[index];
        if (!source) return new Float32Array(this.width * rows * 4);   // no light: black
        return readTexture(this.renderer, source, 'rgba16float', this.width, y0, rows);
    }

    disposeTextures() {
        if (this._held) { this._freeLater = true; return; }
        this._free();
    }

    _free() {
        this._freeLater = false;
        for (const t of this.textures) t?.destroy();
        for (const t of this.external) if (t !== this._black) t.dispose();
        this.textures = [];
        this.external = [];
        this.width = this.height = 0;
        this._quad?.material.dispose();
        this._quad = null;
    }

    dispose() {
        this.disposeTextures();
        this._target?.dispose();
        this._target = null;
    }
}

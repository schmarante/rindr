// Adaptive sampling of the path tracer (docs/pathtracer.md "Adaptives Sampling", Vite plugin rindr-adaptive in
// astro.config.mjs). Every pixel gets samples until its noise is below the threshold instead of all pixels the same
// number: a plain background or a matte wall is clean after a few, glass, caustics, soft shadows or depth of field
// keep the rest of the budget.
//
// Noise estimate: the megakernel keeps per pixel the running means of t and t² of its samples, t = L / (1 + L) of the
// sample's luminance (compressed like a tone curve: a firefly counts as bright, not as infinitely far off) – in the
// bucket buffer behind its header (WebGPU guarantees 8 storage buffers per shader stage, the megakernel uses all of
// them; the light passes live there only while buckets render, adaptive sampling is off then). Error of a pixel =
// standard error of its mean / √mean (dark noise shows more after the tone curve and sRGB).
//
// Decision per block of 8 × 8 pixels, after every full sample from `minSamples` on (two small kernels):
//   1. per block the largest error of its pixels (pixels below minSamples: always active)
//   2. a block stays active while it or one of its 8 neighbours is above the threshold (no hard seams between
//      finished and refined blocks); a finished block marks its pixels as done – the top bit of the sample count, the
//      megakernel returns for them at once (a whole workgroup of done pixels costs next to nothing)
// Counters (active blocks, sum of samples) come back asynchronously – no active block left: the image is finished
// (pathtracer.js _adaptiveCycle). Noise map: per pixel finished blocks blue → green by their share of the maximum
// samples, active ones orange; shown over the picture (overlay()). With the map on it is computed from the second sample
// on (nothing marked done before minSamples – the early estimate is coarse, but shows at once where it is noisy).
import * as THREE from 'three/webgpu';
import { uniform, globalId, textureStore, storage, texture, screenUV, mix, vec3, vec4, dot, float } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { BUCKET_DATA, BUCKET_FLOATS, bucketBuffer } from './distributed/bucket.js';
import { LIGHT_PASSES } from './light-passes.js';
import { compileAsync } from './shader-compile.js';

export const DONE_FLAG = 0x80000000;
const BLOCK = 8;

export const ADAPTIVE = {
    on: uniform(0, 'uint'),         // the megakernel records the moments
    capacity: uniform(0, 'uint'),   // pixels the bucket buffer holds moments for
};

const B = BUCKET_DATA;

/** megakernel, before a sample is stored: the pixel's running means of t and t² (n = its samples before this one) */
export const AD_MOMENTS_WGSL = wgslTagFn/* wgsl */`
    fn rindrAdaptiveMoments( pixel: u32, n: u32, color: vec3f ) -> void {

        if ( ${ ADAPTIVE.on } == 0u || ${ LIGHT_PASSES.enabled } != 0u || pixel >= ${ ADAPTIVE.capacity } ) {

            return;

        }
        let l = max( dot( color, vec3f( 0.2126, 0.7152, 0.0722 ) ), 0.0 );
        let t = l / ( 1.0 + l );
        let i = ${ BUCKET_FLOATS }u + pixel * 2u;
        if ( n == 0u ) {

            ${ B }[ i ] = t;
            ${ B }[ i + 1u ] = t * t;
            return;

        }
        let w = 1.0 / f32( n + 1u );
        ${ B }[ i ] = mix( ${ B }[ i ], t, w );
        ${ B }[ i + 1u ] = mix( ${ B }[ i + 1u ], t * t, w );

    }
`;

const kernelOf = fn => {
    const node = fn.context({});
    node.parameters = fn.parameters;
    return node.computeKernel([8, 8, 1]);
};

export class AdaptiveSampler {
    constructor(renderer) {
        this.renderer = renderer;
        this._blocks = new THREE.Vector2();
        this._blockErr = new THREE.StorageBufferAttribute(new Float32Array(1), 1);
        this._blockErrNode = storage(this._blockErr, 'float');
        this._counters = new THREE.StorageBufferAttribute(new Uint32Array(2), 1);
        this._countersNode = storage(this._counters, 'uint', 2).toAtomic();
        this.heat = new THREE.StorageTexture(1, 1);
        this.heat.type = THREE.HalfFloatType;
        this.heat.name = 'Adaptive noise map';
        this.hasHeat = false;   // the map shows the current image (set by run, cleared on a restart)

        const E = this._blockErrNode, C = this._countersNode;
        const common = {
            globalId,
            blocks: uniform(new THREE.Vector2()),
            minSamples: uniform(16, 'uint'),
            maxSamples: uniform(32, 'uint'),
        };
        // 1. largest error per block
        const pe = this._errParams = { ...common, sampleCountTarget: textureStore(new THREE.StorageTexture(1, 1)).toReadOnly() };
        this._errKernel = kernelOf(wgslTagFn/* wgsl */`
            fn compute( globalId: vec3u, blocks: vec2u, minSamples: u32, maxSamples: u32 ) -> void {

                if ( globalId.x == 0u && globalId.y == 0u ) {

                    atomicStore( &${ C }[ 0 ], 0u );
                    atomicStore( &${ C }[ 1 ], 0u );

                }
                if ( globalId.x >= blocks.x || globalId.y >= blocks.y ) {

                    return;

                }
                let dims = textureDimensions( ${ pe.sampleCountTarget } );
                var worst = 0.0;
                for ( var y = 0u; y < ${ BLOCK }u; y ++ ) {

                    for ( var x = 0u; x < ${ BLOCK }u; x ++ ) {

                        let p = globalId.xy * ${ BLOCK }u + vec2u( x, y );
                        if ( p.x >= dims.x || p.y >= dims.y ) {

                            continue;

                        }
                        let c = textureLoad( ${ pe.sampleCountTarget }, p ).r;
                        if ( ( c & ${ DONE_FLAG }u ) != 0u || c >= maxSamples ) {

                            continue;

                        }
                        if ( c < minSamples ) {

                            worst = 1e9;
                            continue;

                        }
                        let i = ${ BUCKET_FLOATS }u + ( p.y * dims.x + p.x ) * 2u;
                        let m = ${ B }[ i ];
                        let n = f32( c );
                        let variance = max( ${ B }[ i + 1u ] - m * m, 0.0 ) * n / ( n - 1.0 );
                        worst = max( worst, sqrt( variance / n ) / sqrt( max( m, 0.0025 ) ) );

                    }

                }
                ${ E }[ globalId.y * blocks.x + globalId.x ] = worst;

            }
        `(pe));
        // 2. active or done (3 × 3 blocks), counters, noise map
        const pa = this._markParams = {
            ...common,
            threshold: uniform(0.02),
            mark: uniform(1, 'uint'),   // 0: noise map only (early preview – nothing is marked done)
            sampleCountTarget: textureStore(new THREE.StorageTexture(1, 1)).toReadWrite(),
            heatTarget: textureStore(this.heat).toWriteOnly(),
        };
        this._markKernel = kernelOf(wgslTagFn/* wgsl */`
            fn compute( globalId: vec3u, blocks: vec2u, minSamples: u32, maxSamples: u32, threshold: f32, mark: u32 ) -> void {

                if ( globalId.x >= blocks.x || globalId.y >= blocks.y ) {

                    return;

                }
                var worst = 0.0;
                for ( var dy = - 1; dy <= 1; dy ++ ) {

                    for ( var dx = - 1; dx <= 1; dx ++ ) {

                        let b = vec2i( globalId.xy ) + vec2i( dx, dy );
                        if ( b.x < 0 || b.y < 0 || b.x >= i32( blocks.x ) || b.y >= i32( blocks.y ) ) {

                            continue;

                        }
                        worst = max( worst, ${ E }[ u32( b.y ) * blocks.x + u32( b.x ) ] );

                    }

                }
                let own = ${ E }[ globalId.y * blocks.x + globalId.x ];
                let refine = worst > threshold;
                let dims = textureDimensions( ${ pa.sampleCountTarget } );
                var sum = 0u;
                for ( var y = 0u; y < ${ BLOCK }u; y ++ ) {

                    for ( var x = 0u; x < ${ BLOCK }u; x ++ ) {

                        let p = globalId.xy * ${ BLOCK }u + vec2u( x, y );
                        if ( p.x >= dims.x || p.y >= dims.y ) {

                            continue;

                        }
                        var c = textureLoad( ${ pa.sampleCountTarget }, p ).r;
                        if ( mark != 0u && ! refine && ( c & ${ DONE_FLAG }u ) == 0u && c < maxSamples ) {

                            c = c | ${ DONE_FLAG }u;
                            textureStore( ${ pa.sampleCountTarget }, p, vec4u( c ) );

                        }
                        let n = c & ${ DONE_FLAG - 1 >>> 0 }u;
                        sum += n;
                        // finished: blue (few samples) → green (the maximum); still refining: orange, brighter the
                        // noisier the block itself
                        let share = saturate( f32( n ) / f32( max( maxSamples, 1u ) ) );
                        var colour = mix( vec3f( 0.08, 0.2, 0.85 ), vec3f( 0.1, 0.85, 0.35 ), share );
                        if ( refine ) {

                            colour = mix( vec3f( 0.85, 0.45, 0.1 ), vec3f( 1.0, 0.15, 0.05 ), saturate( own / threshold - 1.0 ) );

                        }
                        // rows top down like the path tracer's output
                        textureStore( ${ pa.heatTarget }, vec2u( p.x, dims.y - 1u - p.y ), vec4f( colour, 1.0 ) );

                    }

                }
                if ( refine ) {

                    atomicAdd( &${ C }[ 0 ], 1u );

                }
                atomicAdd( &${ C }[ 1 ], sum );

            }
        `(pa));

        // noise map over the picture: its brightness in grey, the map coloured on top
        this._overlayInput = texture(null);
        this._heatInput = texture(this.heat);
        this._overlayTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
        this._overlayTarget.texture.name = 'Adaptive overlay';
        const image = this._overlayInput.sample(screenUV);
        const grey = dot(image.rgb, vec3(0.2126, 0.7152, 0.0722)).mul(0.6);
        const m = this._overlayMaterial = new THREE.NodeMaterial();
        m.fragmentNode = vec4(mix(vec3(grey), this._heatInput.sample(screenUV).rgb, float(0.6)), 1);
        m.depthTest = m.depthWrite = false;
        m.toneMapped = false;
        this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
        this._quad.frustumCulled = false;
        this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }

    /** room for the moments of `pixels` (the megakernel records them from the first sample on) */
    ensure(pixels) {
        if (ADAPTIVE.capacity.value >= pixels) return;
        bucketBuffer(pixels * 2);
        ADAPTIVE.capacity.value = pixels;
    }

    /**
     * After a full sample: blocks below the threshold are marked done. `sampleCount` = the backend's sample count
     * target, `size` its size.
     */
    run(sampleCount, size, { threshold, minSamples, maxSamples, mark = true }) {
        const r = this.renderer;
        const bx = Math.ceil(size.x / BLOCK), by = Math.ceil(size.y / BLOCK);
        if (this._blocks.x !== bx || this._blocks.y !== by) {
            this._blocks.set(bx, by);
            const old = this._blockErr;
            this._blockErr = new THREE.StorageBufferAttribute(new Float32Array(bx * by), 1);
            this._blockErrNode.value = this._blockErr;
            old.dispose();   // its GPU buffer (three.js r187 frees attributes on 'dispose')
        }
        if (this.heat.image.width !== size.x || this.heat.image.height !== size.y) {
            const old = this.heat;
            this.heat = old.clone();
            old.dispose();
            this.heat.setSize(size.x, size.y);
            this._markParams.heatTarget.value = this.heat;
            this._heatInput.value = this.heat;
        }
        for (const p of [this._errParams, this._markParams]) {
            p.blocks.value.set(bx, by);
            p.minSamples.value = minSamples;
            p.maxSamples.value = maxSamples;
            p.sampleCountTarget.value = sampleCount;
        }
        this._markParams.threshold.value = threshold;
        this._markParams.mark.value = mark ? 1 : 0;
        const dispatch = [Math.ceil(bx / 8), Math.ceil(by / 8), 1];
        r.compute(this._errKernel, dispatch);
        r.compute(this._markKernel, dispatch);
        this.hasHeat = true;
    }

    /** counters of the last run: { active blocks, blocks, samples (sum over the pixels) } */
    async readCounts() {
        const raw = new Uint32Array(await this.renderer.getArrayBufferAsync(this._counters));
        return { active: raw[0], blocks: this._blocks.x * this._blocks.y, samples: raw[1] };
    }

    /** the noise map over `source` (any size) */
    overlay(source) {
        const r = this.renderer, w = source.image?.width ?? source.width, h = source.image?.height ?? source.height;
        if (this._overlayTarget.width !== w || this._overlayTarget.height !== h) this._overlayTarget.setSize(w, h);
        this._overlayInput.value = source;
        this.prepare();   // usually done when the map was switched on
        if (!this._ready) return source;
        const target = r.getRenderTarget();
        try {
            r.setRenderTarget(this._overlayTarget);
            r.render(this._quad, this._camera);
        } finally {
            r.setRenderTarget(target);
        }
        return this._overlayTarget.texture;
    }

    /** compile the overlay asynchronously (when the map is switched on – the picture as it is meanwhile) */
    prepare() {
        if (this._compiled) return;
        const r = this.renderer, target = r.getRenderTarget();
        // a stand-in until the first picture – its own texture: with the map itself as stand-in three shared one binding
        // for both inputs, and the picture later covered the map (no colours)
        if (!this._overlayInput.value) {
            this._standIn ??= Object.assign(new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType), { needsUpdate: true });
            this._overlayInput.value = this._standIn;
        }
        r.setRenderTarget(this._overlayTarget);
        try {
            this._compiled = compileAsync(r, this._quad, this._camera).then(() => { this._ready = true; })
                .catch(err => console.warn('[Adaptive] overlay compile failed:', err));
        } finally {
            r.setRenderTarget(target);
        }
    }

    dispose() {
        this._blockErr.dispose();
        this._counters.dispose();
        this.heat.dispose();
        this._overlayTarget.dispose();
        this._overlayMaterial.dispose();
        this._standIn?.dispose();
        this._quad.geometry.dispose();
    }
}

// the render task's hook after every full sample (Vite patch rindr-adaptive in MegaKernelPathTracer.js) – handled by
// the path tracer (pathtracer.js _adaptiveCycle): returns the samples to continue from (the maximum = finished)
let cycleHandler = null;
export function setAdaptiveHandler(fn) {
    cycleHandler = fn;
}
export function adaptiveCycle(backend, completed, task) {
    return cycleHandler ? cycleHandler(backend, completed, task) : completed;
}

// Light passes of the path tracer (Vite plugin rindr-light-passes in astro.config.mjs, docs/pathtracer.md "Licht-Passes").
//
// Every bit of light the megakernel adds to a sample is known where it is added: which light it comes from (one of the
// analytic lights, the environment, the background, emission) and – once the path has scattered for the first time –
// which part of the first surface's material it went through (diffuse, reflection, refraction; before that: emission or
// background seen directly). Each contribution goes into the pass of its source and into the pass of its kind; both
// sets add up to the image (light mix: weighted sum of the source passes, live after the render). Plus the shadow pass:
// direct light lost to occlusion at the first surface and the ground's lost background (shadow catcher) – not part of
// the sums (image + shadow = without shadows).
//
// Kind of a path after its first scatter: bsdfSample evaluates every lobe for the sampled direction (bsdfEvalPdf) –
// the lobes' shares of that value (bsdfLobes, a copy of bsdfEval keeping them apart – rindr-light-passes) split the
// path's later light per colour channel (unbiased: the throughput is the sum of the lobes over the pdf). Direct light
// at the first surface splits by the lobes for its direction.
//
// Only while a bucket renders with passes (renderRegion, enabled = 1). Everything per pixel lives in the buffer, not
// in the kernel's registers: with this sample's passes as a local array the kernel was ~8 % slower even with the
// passes off (register pressure) – now off costs one branch per contribution. Structure of arrays (neighbouring
// pixels side by side: float `offset + slot · capacity + pixel`), slots per pixel:
//   SUM   COUNT × rgb   sums over the samples (premultiplied by each sample's alpha; rows top down)
//   CUR   COUNT × rgb   this sample
//   W     3 × rgb       kind weights of the path after its first scatter (diffuse, reflection, refraction)
//   MW    3 × rgb       kind weights of a ground reflection counted ahead (shadow catcher)
//   SW    2 × 3 × rgb   kind weights of the glass split's stacked reflection paths
//   MSRC  1             source pass of that ground reflection
//   MT    rgb           its share of the background (transparency pass)
import { uniform } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { BUCKET_DATA, BUCKET_FLOATS, bucketBuffer } from './distributed/bucket.js';

// light slots: the path tracer's lights in its order (scene.traverseVisible) – a light beyond the last slot shares it
export const LIGHT_SLOTS = 4;
export const PASS = {
    ENVIRONMENT: 4,        // light of the environment (HDRI) – directly and through every bounce
    BACKGROUND: 5,         // the background seen (camera, through glass, in reflections – also the shadow catcher's ground)
    EMISSION: 6,           // emitting materials (also splats with baked colours)
    DIFFUSE: 7,            // light kinds: what the first surface passes on diffusely
    REFLECTION: 8,         // … reflects (specular, clearcoat, metal, glass reflection)
    REFRACTION: 9,         // … lets through (glass, transmission)
    DIRECT_EMISSION: 10,   // emission seen directly
    DIRECT_BACKGROUND: 11, // background seen directly (incl. the shadow catcher's ground)
    SHADOW: 12,            // light lost to shadows at the first surface (not part of the sums)
    TRANSPARENCY: 13,      // how much of the background comes through (per channel): 1 seen directly, the share through
                           // glass, the ground's share left by its shadow – alpha = 1 − it (not part of the sums)
    COUNT: 14,
};
export const SOURCE_PASSES = [0, 1, 2, 3, PASS.ENVIRONMENT, PASS.BACKGROUND, PASS.EMISSION];
export const KIND_PASSES = [PASS.DIFFUSE, PASS.REFLECTION, PASS.REFRACTION, PASS.DIRECT_EMISSION, PASS.DIRECT_BACKGROUND];
// transparent PNG (buckets with passes 'matte'): only the picture without its background (the source passes but the
// background – kept in the first source slot, so the shown sum is exactly it) and the transparency
export const MATTE_PASSES = [0, PASS.TRANSPARENCY];

const SPLIT_STACK = 2;   // GLASS_SPLIT_MAX in astro.config.mjs
const SLOT = { SUM: 0, CUR: PASS.COUNT * 3, W: PASS.COUNT * 6, MW: PASS.COUNT * 6 + 9, SW: PASS.COUNT * 6 + 18 };
SLOT.MSRC = SLOT.SW + SPLIT_STACK * 9;
SLOT.MT = SLOT.MSRC + 1;
const STRIDE = SLOT.MT + 3;   // slots per pixel
export const PASS_BYTES_PER_PIXEL = STRIDE * 4;   // the kernel's pass buffer per pixel of a bucket

export const LIGHT_PASSES = {
    enabled: uniform(0, 'uint'),
    capacity: uniform(0, 'uint'),   // pixels the buffer holds
    SLOT,
};

const B = BUCKET_DATA;
/** float index of a pixel's slot (pixel: row-major, rows top down) */
const AT = wgslTagFn/* wgsl */`
    fn lpAt( pixel: u32, slot: u32 ) -> u32 {

        return ${ BUCKET_FLOATS }u + slot * ${ LIGHT_PASSES.capacity } + pixel;

    }
`;
/** this sample's pass += v */
export const LP_ADD_WGSL = wgslTagFn/* wgsl */`
    fn lpAdd( pixel: u32, index: u32, v: vec3f ) -> void {

        let i = ${ SLOT.CUR }u + index * 3u;
        ${ B }[ ${ AT }( pixel, i ) ] += v.x;
        ${ B }[ ${ AT }( pixel, i + 1u ) ] += v.y;
        ${ B }[ ${ AT }( pixel, i + 2u ) ] += v.z;

    }
`;
/** three kind weights stored at a slot */
export const LP_GET_W_WGSL = wgslTagFn/* wgsl */`
    fn lpGetW( pixel: u32, slot: u32 ) -> array<vec3f, 3> {

        var w: array<vec3f, 3>;
        for ( var k = 0u; k < 3u; k ++ ) {

            let i = slot + k * 3u;
            w[ k ] = vec3f( ${ B }[ ${ AT }( pixel, i ) ], ${ B }[ ${ AT }( pixel, i + 1u ) ], ${ B }[ ${ AT }( pixel, i + 2u ) ] );

        }
        return w;

    }
`;
export const LP_SET_W_WGSL = wgslTagFn/* wgsl */`
    fn lpSetW( pixel: u32, slot: u32, w: array<vec3f, 3> ) -> void {

        for ( var k = 0u; k < 3u; k ++ ) {

            let i = slot + k * 3u;
            ${ B }[ ${ AT }( pixel, i ) ] = w[ k ].x;
            ${ B }[ ${ AT }( pixel, i + 1u ) ] = w[ k ].y;
            ${ B }[ ${ AT }( pixel, i + 2u ) ] = w[ k ].z;

        }

    }
`;
/** v into the three kinds by weights */
export const LP_ADD_KINDS_WGSL = wgslTagFn/* wgsl */`
    fn lpAddKinds( pixel: u32, w: array<vec3f, 3>, v: vec3f ) -> void {

        ${ LP_ADD_WGSL }( pixel, ${ PASS.DIFFUSE }u, v * w[ 0 ] );
        ${ LP_ADD_WGSL }( pixel, ${ PASS.REFLECTION }u, v * w[ 1 ] );
        ${ LP_ADD_WGSL }( pixel, ${ PASS.REFRACTION }u, v * w[ 2 ] );

    }
`;
/** this sample's passes to 0 (start of the sample; the library overwrites the colour on some background hits) */
export const LP_CLEAR_WGSL = wgslTagFn/* wgsl */`
    fn lpClear( pixel: u32 ) -> void {

        for ( var i = 0u; i < ${ PASS.COUNT * 3 }u; i ++ ) {

            ${ B }[ ${ AT }( pixel, ${ SLOT.CUR }u + i ) ] = 0.0;

        }

    }
`;
/**
 * end of the sample: into the sums – premultiplied by its alpha; an invalid sample (inf/NaN in the colour or a pass)
 * adds the mean so far (like the NaN guard)
 */
export const LP_END_WGSL = wgslTagFn/* wgsl */`
    fn lpEnd( pixel: u32, alpha: f32, count: f32, badColor: bool ) -> void {

        var bad = badColor;
        for ( var i = 0u; i < ${ PASS.COUNT * 3 }u; i ++ ) {

            bad = bad || ( bitcast<u32>( ${ B }[ ${ AT }( pixel, ${ SLOT.CUR }u + i ) ] ) & 0x7f800000u ) == 0x7f800000u;

        }
        for ( var i = 0u; i < ${ PASS.COUNT * 3 }u; i ++ ) {

            let sum = ${ AT }( pixel, i );
            let prev = select( ${ B }[ sum ], 0.0, count == 0.0 );
            ${ B }[ sum ] = prev + select( ${ B }[ ${ AT }( pixel, ${ SLOT.CUR }u + i ) ] * alpha, prev / max( count, 1.0 ), bad );

        }

    }
`;
/** shares of the three lobe kinds (bsdfLobes) per colour channel (0 where the sum is 0) */
export const LOBE_RATIO_WGSL = wgslTagFn/* wgsl */`
    fn lpRatio( lobes: array<vec3f, 3> ) -> array<vec3f, 3> {

        let d = lobes[ 0 ];
        let r = lobes[ 1 ];
        let t = lobes[ 2 ];
        let sum = d + r + t;
        let inv = select( vec3f( 1.0 ) / max( sum, vec3f( 1e-30 ) ), vec3f( 0.0 ), sum <= vec3f( 0.0 ) );
        return array<vec3f, 3>( d * inv, r * inv, t * inv );

    }
`;
/** rgb at a slot */
export const LP_GET3_WGSL = wgslTagFn/* wgsl */`
    fn lpGet3( pixel: u32, slot: u32 ) -> vec3f {

        return vec3f( ${ B }[ ${ AT }( pixel, slot ) ], ${ B }[ ${ AT }( pixel, slot + 1u ) ], ${ B }[ ${ AT }( pixel, slot + 2u ) ] );

    }
`;
export const LP_SET3_WGSL = wgslTagFn/* wgsl */`
    fn lpSet3( pixel: u32, slot: u32, v: vec3f ) -> void {

        ${ B }[ ${ AT }( pixel, slot ) ] = v.x;
        ${ B }[ ${ AT }( pixel, slot + 1u ) ] = v.y;
        ${ B }[ ${ AT }( pixel, slot + 2u ) ] = v.z;

    }
`;
/** source pass of a ground reflection counted ahead */
export const LP_MSRC_WGSL = wgslTagFn/* wgsl */`
    fn lpMirrorSource( pixel: u32 ) -> u32 {

        return u32( ${ B }[ ${ AT }( pixel, ${ SLOT.MSRC }u ) ] );

    }
`;
export const LP_SET_MSRC_WGSL = wgslTagFn/* wgsl */`
    fn lpSetMirrorSource( pixel: u32, index: u32 ) -> void {

        ${ B }[ ${ AT }( pixel, ${ SLOT.MSRC }u ) ] = f32( index );

    }
`;

let attribute = null;

/** room for a bucket of `pixels` (the buffer is kept when it is large enough) */
export function preparePassBuffer(pixels) {
    LIGHT_PASSES.capacity.value = Math.max(LIGHT_PASSES.capacity.value, pixels);
    attribute = bucketBuffer(LIGHT_PASSES.capacity.value * STRIDE);
}

export function setPassesEnabled(on) {
    LIGHT_PASSES.enabled.value = on ? 1 : 0;
}

/**
 * Means of the passes of a w × h bucket after `samples` samples (rows top down): Float32Array w·h·COUNT·3 –
 * pixel-major (all passes of a pixel together). matte: only MATTE_PASSES (w·h·2·3 – a seventh over the network)
 */
export async function readPasses(renderer, w, h, samples, matte = false) {
    const n = w * h, cap = LIGHT_PASSES.capacity.value, slots = PASS.COUNT * 3;
    // only the sums (the first slots – the rest of a pixel's slots is the kernel's scratch space: two thirds less)
    const raw = new Float32Array(await renderer.getArrayBufferAsync(attribute, null, BUCKET_FLOATS * 4, slots * cap * 4));
    const inv = 1 / Math.max(samples, 1);
    if (matte) {
        const out = new Float32Array(n * 6);
        const colour = SOURCE_PASSES.filter(i => i !== PASS.BACKGROUND);
        for (let c = 0; c < 3; c++) {
            for (const i of colour) {
                const s = (i * 3 + c) * cap;
                for (let p = 0; p < n; p++) out[p * 6 + c] += raw[s + p];
            }
            const s = (PASS.TRANSPARENCY * 3 + c) * cap;
            for (let p = 0; p < n; p++) { out[p * 6 + c] *= inv; out[p * 6 + 3 + c] = raw[s + p] * inv; }
        }
        return out;
    }
    const out = new Float32Array(n * slots);
    for (let i = 0; i < slots; i++) {
        const s = i * cap;
        for (let p = 0; p < n; p++) out[p * slots + i] = raw[s + p] * inv;
    }
    return out;
}

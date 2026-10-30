// Bucket rendering (distributed rendering, docs/distributed.md): the path tracer renders one rectangle of a larger
// image as an image of its own – the camera's view offset narrows the projection to the bucket, the kernel sees
// the bucket's size. Two things in the kernel still think in bucket pixels and get the bucket's place in the full
// image here (Vite patch rindr-bucket in astro.config.mjs):
//   - the noise: the sampler is seeded per pixel – every bucket would repeat the same pattern (a visible grid);
//     with the full image's pixel the samples are exactly those a full-frame render takes at that pixel
//   - the fisheye camera ray (fisheye.js) maps image coordinates itself, not through the projection matrix
// Data: one storage buffer (f32): x, y (top left, pixels), w, h | full width, full height, active, 0 – behind it the light
// passes of the bucket (light-passes.js; one buffer for both: WebGPU guarantees only 8 storage buffers per shader stage,
// the megakernel uses all of them).
import * as THREE from 'three/webgpu';
import { storage } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';

export const BUCKET_FLOATS = 8;   // the header; the light passes start behind it
let data = new Float32Array(BUCKET_FLOATS);
let attribute = new THREE.StorageBufferAttribute(data, 1);
export const BUCKET_DATA = storage(attribute, 'float').setName('rindr_bucket');

const header = wgslTagFn/* wgsl */`
    fn rindrBucketHeader( i: u32 ) -> vec4f {

        return vec4f( ${ BUCKET_DATA }[ i ], ${ BUCKET_DATA }[ i + 1u ], ${ BUCKET_DATA }[ i + 2u ], ${ BUCKET_DATA }[ i + 3u ] );

    }
`;

/** pixel of the full image (bottom-up like the kernel's index) for a pixel of the bucket */
export const BUCKET_PIXEL_WGSL = wgslTagFn/* wgsl */`
    fn rindrBucketPixel( p: vec2u ) -> vec2u {

        let r = ${ header }( 0u );
        let f = ${ header }( 4u );
        if ( f.z == 0.0 ) {

            return p;

        }
        return p + vec2u( u32( r.x ), u32( f.y - r.y - r.w ) );

    }
`;

/** image coordinate (0…1, bottom-up) of the full image for one of the bucket */
export const BUCKET_UV_WGSL = wgslTagFn/* wgsl */`
    fn rindrBucketUv( uv: vec2f ) -> vec2f {

        let r = ${ header }( 0u );
        let f = ${ header }( 4u );
        if ( f.z == 0.0 ) {

            return uv;

        }
        return ( uv * r.zw + vec2f( r.x, f.y - r.y - r.w ) ) / f.xy;

    }
`;

/** region { x, y, w, h, fullW, fullH } (pixels, y from the top) – or null: the normal full image */
export function setBucketRegion(region) {
    data.fill(0, 0, BUCKET_FLOATS);
    if (region) data.set([region.x, region.y, region.w, region.h, region.fullW, region.fullH, 1, 0]);
    attribute.addUpdateRange(0, BUCKET_FLOATS);   // the passes behind it stay as the GPU has them
    attribute.needsUpdate = true;
}

/** the buffer with room for `floats` behind the header (grown when needed, the header kept) – the attribute */
export function bucketBuffer(floats) {
    if (data.length < BUCKET_FLOATS + floats) {
        const grown = new Float32Array(BUCKET_FLOATS + floats);
        grown.set(data.subarray(0, BUCKET_FLOATS));
        data = grown;
        const old = attribute;
        attribute = new THREE.StorageBufferAttribute(data, 1);
        BUCKET_DATA.value = attribute;
        old.dispose();   // its GPU buffer (three.js r187 frees attributes on 'dispose')
    }
    return attribute;
}

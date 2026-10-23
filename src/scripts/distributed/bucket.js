// Bucket rendering (distributed rendering, docs/distributed.md): the path tracer renders one rectangle of a larger
// image as an image of its own – the camera's view offset narrows the projection to the bucket, the kernel sees
// the bucket's size. Two things in the kernel still think in bucket pixels and get the bucket's place in the full
// image here (Vite patch rindr-bucket in astro.config.mjs):
//   - the noise: the sampler is seeded per pixel – every bucket would repeat the same pattern (a visible grid);
//     with the full image's pixel the samples are exactly those a full-frame render takes at that pixel
//   - the fisheye camera ray (fisheye.js) maps image coordinates itself, not through the projection matrix
// Data: one storage block (vec4 ×2): x, y (top left, pixels), w, h | full width, full height, active, 0.
import * as THREE from 'three/webgpu';
import { storage } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';

const data = new Float32Array(8);
const attribute = new THREE.StorageBufferAttribute(data, 4);
export const BUCKET_DATA = storage(attribute, 'vec4').toReadOnly().setName('rindr_bucket');

/** pixel of the full image (bottom-up like the kernel's index) for a pixel of the bucket */
export const BUCKET_PIXEL_WGSL = wgslTagFn/* wgsl */`
    fn rindrBucketPixel( p: vec2u ) -> vec2u {

        let r = ${ BUCKET_DATA }[ 0 ];
        let f = ${ BUCKET_DATA }[ 1 ];
        if ( f.z == 0.0 ) {

            return p;

        }
        return p + vec2u( u32( r.x ), u32( f.y - r.y - r.w ) );

    }
`;

/** image coordinate (0…1, bottom-up) of the full image for one of the bucket */
export const BUCKET_UV_WGSL = wgslTagFn/* wgsl */`
    fn rindrBucketUv( uv: vec2f ) -> vec2f {

        let r = ${ BUCKET_DATA }[ 0 ];
        let f = ${ BUCKET_DATA }[ 1 ];
        if ( f.z == 0.0 ) {

            return uv;

        }
        return ( uv * r.zw + vec2f( r.x, f.y - r.y - r.w ) ) / f.xy;

    }
`;

/** region { x, y, w, h, fullW, fullH } (pixels, y from the top) – or null: the normal full image */
export function setBucketRegion(region) {
    data.fill(0);
    if (region) data.set([region.x, region.y, region.w, region.h, region.fullW, region.fullH, 1, 0]);
    attribute.needsUpdate = true;
}

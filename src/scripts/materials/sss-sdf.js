// GPU generation of the subsurface scattering distance fields (sss-field.js) – loaded on demand (three-mesh-bvh's WebGPU
// part stays out of the start bundle). Per voxel of the field's box the closest point on the geometry (three-mesh-bvh
// closest-point query over the geometry's BVH, compute shader) → distance, sign from the side of the closest
// triangle's face (outward winding); written into the field's slot of the atlas.
import { textureStore, globalId, uniform } from 'three/tsl';
import { BVHComputeData, wgslTagFn, pointQueryResultStruct } from 'three-mesh-bvh/webgpu';
import { SSS_ATLAS, FIELD_RES } from './sss-field.js';

const WORKGROUP = 4;

/**
 * Build one field (job from requestField) on the GPU; marks it ready once the commands are queued.
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @param {{ geometry: object, field: { slot: number, min: object, size: object, ready: boolean } }} job  from requestField
 */
export function buildField(renderer, { geometry, field }) {
    const data = new BVHComputeData(geometry);
    data.update();
    const params = {
        globalId,
        target: textureStore(SSS_ATLAS).toWriteOnly(),
        boxMin: uniform(field.min.clone()),
        voxel: uniform(field.size.clone().divideScalar(FIELD_RES)),
        slotZ: uniform(field.slot * FIELD_RES, 'uint'),
    };
    const fn = wgslTagFn/* wgsl */`
        fn compute( globalId: vec3u ) -> void {

            if ( globalId.x >= ${ FIELD_RES }u || globalId.y >= ${ FIELD_RES }u || globalId.z >= ${ FIELD_RES }u ) {

                return;

            }
            let p = ${ params.boxMin } + ( vec3f( globalId ) + vec3f( 0.5 ) ) * ${ params.voxel };
            var result: ${ pointQueryResultStruct };
            result.found = false;
            result.distanceSq = 1e30;
            ${ data.fns.closestPointToPoint }( p, &result );
            var d = 1e4;
            if ( result.found ) {

                d = sqrt( result.distanceSq ) * select( - 1.0, 1.0, result.side >= 0.0 );

            }
            textureStore( ${ params.target }, vec3u( globalId.x, globalId.y, globalId.z + ${ params.slotZ } ), vec4f( d, 0.0, 0.0, 1.0 ) );

        }
    `;
    const kernel = fn(params).computeKernel([WORKGROUP, WORKGROUP, WORKGROUP]);
    const groups = Math.ceil(FIELD_RES / WORKGROUP);
    renderer.compute(kernel, [groups, groups, groups]);
    field.ready = true;
    setTimeout(() => data.dispose(), 2000);   // its buffers are bound by the queued compute pass
}

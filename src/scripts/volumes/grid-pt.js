// Path tracer side of the grid volumes (grid-volumes.js): WGSL lookups for the shared volume walk (volume-pt.js). Own
// module: only the lazily loaded path tracer imports it. Unit-box coordinates lo ∈ −0.5…0.5 per volume, directions
// ld per world unit (the box's inverse matrix applied).
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { texture, texture3D, sampler } from 'three/tsl';
import { GRID_TEXTURES, GRID_ATLAS, GRID_BLOCK, GRID_EMISSION_STEPS } from './grid-volumes.js';

const f = v => (Number.isInteger(v) ? `${v}.0` : String(v));
const atlasNode = texture3D(GRID_TEXTURES.atlas);
const blocksNode = texture3D(GRID_TEXTURES.blocks);
const emissionNode = texture(GRID_TEXTURES.emission);

// density / maximum (x – stored as its square root, vdb-import.js quantize) and temperature / maximum (y) at lo;
// dims = sample counts, z0 = the volume's first atlas layer
const SAMPLE = wgslTagFn/* wgsl */`
    fn rindrGridSample( lo: vec3f, dims: vec3f, z0: f32 ) -> vec2f {

        let atlas = ${ GRID_ATLAS };
        let u = ( lo.x + 0.5 ) * dims.x / atlas.x;
        let v = ( lo.y + 0.5 ) * dims.y / atlas.y;
        let w = ( clamp( ( lo.z + 0.5 ) * dims.z, 0.5, dims.z - 0.5 ) + z0 ) / atlas.z;
        let s = textureSampleLevel( ${ atlasNode }, ${ sampler(atlasNode) }, vec3f( u, v, w ), 0.0 ).rg;
        return vec2f( s.x * s.x, s.y );

    }
`;

// largest density / maximum in the block of lo (blocks of ${GRID_BLOCK}³ samples, grown by their neighbours)
const BLOCK = wgslTagFn/* wgsl */`
    fn rindrGridBlock( lo: vec3f, dims: vec3f, blockDims: vec3f, bz0: f32 ) -> f32 {

        let b = clamp( floor( ( lo + vec3f( 0.5 ) ) * dims / ${ f(GRID_BLOCK) } ), vec3f( 0.0 ), blockDims - vec3f( 1.0 ) );
        let m = textureLoad( ${ blocksNode }, vec3i( i32( b.x ), i32( b.y ), i32( b.z + bz0 ) ), 0 ).r;
        return m * m;

    }
`;

// distance (world units) along ld until the block of lo is left
const BLOCK_EXIT = wgslTagFn/* wgsl */`
    fn rindrGridBlockExit( lo: vec3f, ld: vec3f, dims: vec3f ) -> f32 {

        let bu = ( lo + vec3f( 0.5 ) ) * dims / ${ f(GRID_BLOCK) };
        let bd = ld * dims / ${ f(GRID_BLOCK) };
        var t = 1e30;
        for ( var i = 0; i < 3; i ++ ) {

            if ( bd[ i ] > 1e-12 ) {

                t = min( t, ( floor( bu[ i ] ) + 1.0 - bu[ i ] ) / bd[ i ] );

            } else if ( bd[ i ] < - 1e-12 ) {

                t = min( t, ( bu[ i ] - ( ceil( bu[ i ] ) - 1.0 ) ) / ( - bd[ i ] ) );

            }

        }
        return t;

    }
`;

// emitted radiance (σa share applied by the caller) at stored temperature t (0…1) of volume k – table lerp
const EMISSION = wgslTagFn/* wgsl */`
    fn rindrGridEmission( k: u32, t: f32 ) -> vec3f {

        let x = clamp( t, 0.0, 1.0 ) * ${ f(GRID_EMISSION_STEPS - 1) };
        let i = i32( floor( x ) );
        let a = textureLoad( ${ emissionNode }, vec2i( i, i32( k ) ), 0 ).rgb;
        let b = textureLoad( ${ emissionNode }, vec2i( min( i + 1, ${ GRID_EMISSION_STEPS - 1 } ), i32( k ) ), 0 ).rgb;
        return mix( a, b, fract( x ) );

    }
`;

export const GRID_PT = { sample: SAMPLE, block: BLOCK, blockExit: BLOCK_EXIT, emission: EMISSION };

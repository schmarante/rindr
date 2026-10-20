// Path tracer side of the splat volume (splat-volume.js): WGSL helpers for the shared volume walk (volume-pt.js,
// volume-walk.patch.wgsl) and the shadow rays (glass-shadow.patch.wgsl). Own
// module: only the lazily loaded path tracer imports it. Lookups in the proxy box's local space (−0.5…0.5).
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { texture3D, sampler } from 'three/tsl';
import { SPLAT_TEXTURES, SPLAT_GRID, SPLAT_BLOCK, SPLAT_UNIFORMS } from './splat-volume.js';

const f = v => (Number.isInteger(v) ? `${v}.0` : String(v));
const BLOCKS = Math.ceil(SPLAT_GRID / SPLAT_BLOCK);

const densityNode = texture3D(SPLAT_TEXTURES.density);
const colorNode = texture3D(SPLAT_TEXTURES.color);
const majorantNode = texture3D(SPLAT_TEXTURES.majorant);

// density 0…1 (× the material's σ), trilinear
const DENSITY = wgslTagFn/* wgsl */`
    fn rindrSplatDensity( local: vec3f ) -> f32 {

        return textureSampleLevel( ${ densityNode }, ${ sampler(densityNode) }, local + vec3f( 0.5 ), 0.0 ).r;

    }
`;

// linear colour (stored as sRGB bytes)
const COLOR = wgslTagFn/* wgsl */`
    fn rindrSplatColor( local: vec3f ) -> vec3f {

        let c = textureSampleLevel( ${ colorNode }, ${ sampler(colorNode) }, local + vec3f( 0.5 ), 0.0 ).rgb;
        return select( pow( ( c + vec3f( 0.055 ) ) / 1.055, vec3f( 2.4 ) ), c / 12.92, c <= vec3f( 0.04045 ) );

    }
`;

// largest density in the block around `local` (0…1)
const MAJORANT = wgslTagFn/* wgsl */`
    fn rindrSplatMajorant( local: vec3f ) -> f32 {

        let cell = clamp( vec3i( floor( ( local + vec3f( 0.5 ) ) * ${ f(BLOCKS) } ) ), vec3i( 0 ), vec3i( ${ BLOCKS - 1 } ) );
        return textureLoad( ${ majorantNode }, cell, 0 ).r;

    }
`;

// distance along ld (world units: ld = local change per world unit) until the block around `local` is left
const BLOCK_EXIT = wgslTagFn/* wgsl */`
    fn rindrSplatBlockExit( local: vec3f, ld: vec3f ) -> f32 {

        let g = ( local + vec3f( 0.5 ) ) * ${ f(BLOCKS) };
        let cell = floor( g );
        let inv = 1.0 / ( ld * ${ f(BLOCKS) } + vec3f( 1e-12 ) );
        let t0 = ( cell - g ) * inv;
        let t1 = ( cell + vec3f( 1.0 ) - g ) * inv;
        return max( min( min( max( t0.x, t1.x ), max( t0.y, t1.y ) ), max( t0.z, t1.z ) ), 0.0 );

    }
`;

// distance along ld (world units) until the unit box (−0.5…0.5) is entered from outside; 1e30 if the ray misses it
const BOX_ENTRY = wgslTagFn/* wgsl */`
    fn rindrSplatBoxEntry( lo: vec3f, ld: vec3f ) -> f32 {

        let inv = 1.0 / ( ld + vec3f( 1e-12 ) );
        let t0 = ( vec3f( - 0.5 ) - lo ) * inv;
        let t1 = ( vec3f( 0.5 ) - lo ) * inv;
        let tNear = max( max( min( t0.x, t1.x ), min( t0.y, t1.y ) ), min( t0.z, t1.z ) );
        let tFar = min( min( max( t0.x, t1.x ), max( t0.y, t1.y ) ), max( t0.z, t1.z ) );
        return select( 1e30, max( tNear, 0.0 ), tFar >= max( tNear, 0.0 ) );

    }
`;

export const SPLAT_PT = { density: DENSITY, color: COLOR, majorant: MAJORANT, blockExit: BLOCK_EXIT, boxEntry: BOX_ENTRY, ...SPLAT_UNIFORMS };

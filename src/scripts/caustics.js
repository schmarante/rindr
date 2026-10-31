// Caustics of glass in the path tracer (Settings → Path tracing → glass shadows → caustics) – light focused by glass
// onto the surfaces behind it: bright lines and spots inside the shadow, rainbow edges with dispersion.
//
// Path tracing alone cannot find them: a path from a surface would have to pass the glass and hit the light exactly –
// the viewer's directional lights are points in direction space (never hit), the sun of an HDRI rarely (noise).
// Instead photons from the lights and the HDRI's sun (caustics-kernel.js, own compute pass before the path tracer's
// frames): parallel rays aimed only at the glass objects, refracted / reflected through them (Fresnel, IOR per
// wavelength with dispersion, tint, absorption), deposited on the first other surface they hit – a hash grid of small
// cubes in space (cell side `cell.w`, 6 bins by the side the surface faces, u32 atomics in fixed point). The megakernel
// looks it up wherever a path hits a surface (and the shadow catcher) and adds that irradiance; the light of these
// sources through glass is then not counted by the glass shadow (next event estimation through glass → 0: directional
// lamps entirely, the environment inside the sun's cone), no light twice. The rest of the HDRI keeps the transparent
// glass shadow (soft light, no sharp caustics anyway).
//
// The grid is kept across camera moves (it depends on the scene only) and cleared when glass, lights, HDRI or materials
// change. Lookup with a random offset of ± half a cell along the surface per sample → smooth (tent filter) over the
// samples. A plane crosses (|n.x| + |n.y| + |n.z|) / side² cells per area on average – the irradiance of a cell is its
// flux over that share of a cell's face.
//
// Uniforms (set by caustics-kernel.js):
//   on      – 1 while caustics are active (mode and the grid exist)
//   cell    – xyz: grid origin (world), w: cell side
//   table   – x: irradiance per grid unit and cell face (normalisation by the photons so far)
//   mask    – slots of the hash table − 1 (a power of two)
//   sun     – xyz: direction to the HDRI's sun (world), w: cos of its cone (2 = no sun)
import * as THREE from 'three/webgpu';
import { uniform, storage } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';

export const CAUSTICS = {
    on: uniform(0, 'uint'),
    cell: uniform(new THREE.Vector4(0, 0, 0, 1)),
    table: uniform(new THREE.Vector4(0, 0, 0, 0)),
    mask: uniform(0, 'uint'),
    sun: uniform(new THREE.Vector4(0, 1, 0, 2)),
    // the hash table (key + rgb u32 per slot) – a placeholder until caustics are switched on (caustics-kernel.js swaps
    // the value)
    grid: storage(new THREE.StorageBufferAttribute(new Uint32Array(4), 1), 'uint').toReadOnly().setName('rindr_caustics'),
};

export const CAUSTICS_PROBES = 32;   // slots tried per key (insert and lookup)

// hash of a cell: slot (h) and key (k, never 0 = empty) from independent mixes of its coordinates and side bin –
// cells mix only if both agree. Shared by the photon kernel (insert) and the megakernel (lookup).
export const CAUSTICS_HASH = wgslTagFn/* wgsl */`
    fn causticHash( p: vec3f, n: vec3f ) -> vec2u {

        let cell = ${ CAUSTICS.cell };
        let c = vec3i( floor( ( p - cell.xyz ) / cell.w ) );
        let a = abs( n );
        var bin = select( select( 4u, 2u, a.y >= a.z ), 0u, a.x >= a.y && a.x >= a.z );
        let side = select( select( n.z, n.y, a.y >= a.z ), n.x, a.x >= a.y && a.x >= a.z );
        bin += select( 0u, 1u, side < 0.0 );
        let u = bitcast<vec3u>( c );
        var h = bin * 2654435761u + 0x9e3779b9u;
        h = ( h ^ u.x ) * 0x85ebca6bu; h ^= ( h >> 13u );
        h = ( h ^ u.y ) * 0xc2b2ae35u; h ^= ( h >> 16u );
        h = ( h ^ u.z ) * 0x27d4eb2fu; h ^= ( h >> 15u );
        var k = ( u.x * 73856093u ) ^ ( u.y * 19349663u ) ^ ( u.z * 83492791u ) ^ ( bin * 2246822519u );
        k = ( k ^ ( k >> 16u ) ) * 0x7feb352du;
        k = ( k ^ ( k >> 15u ) ) * 0x846ca68bu;
        k ^= ( k >> 16u );
        return vec2u( h, k | 1u );

    }
`;

/** irradiance of the caustics at a surface point (0 without photons there); n: geometric normal facing the viewer,
 *  jitter: 2 random numbers (offset along the surface) */
export const CAUSTICS_IRRADIANCE = wgslTagFn/* wgsl */`
    fn causticIrradiance( p: vec3f, n: vec3f, jitter: vec2f ) -> vec3f {

        if ( ${ CAUSTICS.on } == 0u ) {

            return vec3f( 0.0 );

        }
        let t = normalize( select( cross( n, vec3f( 0.0, 1.0, 0.0 ) ), cross( n, vec3f( 1.0, 0.0, 0.0 ) ), abs( n.y ) > 0.9 ) );
        let b = cross( n, t );
        let q = p + ( t * ( jitter.x - 0.5 ) + b * ( jitter.y - 0.5 ) ) * ${ CAUSTICS.cell }.w;
        let hk = ${ CAUSTICS_HASH }( q, n );
        let mask = ${ CAUSTICS.mask };
        for ( var i = 0u; i < ${ CAUSTICS_PROBES }u; i ++ ) {

            let e = ( ( hk.x + i ) & mask ) * 4u;
            let key = ${ CAUSTICS.grid }[ e ];
            if ( key == hk.y ) {

                let a = abs( n );
                return vec3f( f32( ${ CAUSTICS.grid }[ e + 1u ] ), f32( ${ CAUSTICS.grid }[ e + 2u ] ), f32( ${ CAUSTICS.grid }[ e + 3u ] ) )
                    * ${ CAUSTICS.table }.x * ( a.x + a.y + a.z );

            }
            if ( key == 0u ) {

                break;

            }

        }
        return vec3f( 0.0 );

    }
`;

/** this light sample's light through glass comes from the photons: a directional lamp, or the environment inside the
 *  sun's cone */
export const CAUSTICS_COVERS = wgslTagFn/* wgsl */`
    fn causticCovers( directional: bool, environment: bool, direction: vec3f ) -> bool {

        let sun = ${ CAUSTICS.sun };
        return ${ CAUSTICS.on } != 0u && ( directional || ( environment && dot( direction, sun.xyz ) > sun.w ) );

    }
`;

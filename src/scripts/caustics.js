// Caustics in the path tracer (Settings → Path tracing → glass shadows → caustics) – light focused by glass and
// mirroring metal onto the surfaces behind / beside them: bright lines and spots inside the shadow, rainbow edges with
// dispersion, the ring of light a polished bowl throws.
//
// Path tracing alone cannot find them: a path from a surface would have to pass the glass / mirror and hit the light
// exactly – directional, point, spot and IES lamps are points (never hit), small bright parts of an HDRI rarely (noise).
// Instead photons from every light source (caustics-kernel.js, own compute pass before the path tracer's frames): all
// lamps (directional, point, spot, IES, rectangle, disc), glowing meshes and the whole HDRI (importance-sampled by its
// luminance), aimed
// at the casters – each glass / mirror object's own bounding sphere (mixture density, overlaps counted) –, refracted /
// reflected through them (Fresnel, IOR per wavelength with dispersion, tint, absorption; metal with its colour),
// deposited on the first other surface they hit – a hash grid of small cubes in space (cell side `cell.w`, 6 bins by the
// side the surface faces, u32 atomics in fixed point). The megakernel looks it up wherever a path hits a surface (and
// the shadow catcher) and adds that irradiance; the light through glass / off mirrors is then not counted by the path
// tracer: next event estimation through glass → 0, light / environment hits of caustic paths (a refraction or a mirror
// reflection after a rough bounce) and next event estimation at a mirror after a rough bounce → 0. No light twice.
// Mirror = metalness ≥ MIRROR.metalness and roughness ≤ MIRROR.roughness (the material's values, before maps and the
// glossy filter – the photon kernel and the megakernel decide alike).
//
// The grid is kept across camera moves (it depends on the scene only) and cleared when casters, lights, HDRI or
// materials change. Lookup with a random offset of ± half a cell along the surface per sample → smooth (tent filter)
// over the samples. A plane crosses (|n.x| + |n.y| + |n.z|) / side² cells per area on average – the irradiance of a
// cell is its flux over that share of a cell's face.
//
// Uniforms (set by caustics-kernel.js):
//   on      – 1 while caustics are active (mode and the grid exist)
//   cell    – xyz: grid origin (world), w: cell side
//   table   – x: irradiance per grid unit and cell face (normalisation by the photons so far)
//   mask    – slots of the hash table − 1 (a power of two)
//   env     – 1 while the environment sends photons (its light through casters comes from them)
//   emitters – 1 while glowing meshes send photons (their light through casters comes from them)
import * as THREE from 'three/webgpu';
import { uniform, storage } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { MIRROR } from './kernel-features.js';

export const CAUSTICS = {
    on: uniform(0, 'uint'),
    cell: uniform(new THREE.Vector4(0, 0, 0, 1)),
    table: uniform(new THREE.Vector4(0, 0, 0, 0)),
    mask: uniform(0, 'uint'),
    env: uniform(0, 'uint'),
    emitters: uniform(0, 'uint'),
    // the hash table (key + rgb u32 per slot) – a placeholder until caustics are switched on (caustics-kernel.js swaps
    // the value)
    grid: storage(new THREE.StorageBufferAttribute(new Uint32Array(4), 1), 'uint').toReadOnly().setName('rindr_caustics'),
};

export const CAUSTICS_PROBES = 32;   // slots tried per key (insert and lookup)

/** a mirroring metal surface – a caster (photon kernel: reflects the photon; megakernel: its light after a rough bounce
 *  comes from the photons) */
export const CAUSTICS_MIRROR = wgslTagFn/* wgsl */`
    fn causticMirror( metalness: f32, roughness: f32, transmission: f32, matte: bool ) -> bool {

        return ${ CAUSTICS.on } != 0u && ! matte && transmission <= 0.5 && metalness >= ${ MIRROR.metalness } && roughness <= ${ MIRROR.roughness };

    }
`;

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

/** the light of a glowing mesh reached over a caustic path comes from the photons (megakernel: its emission there 0) */
export const CAUSTICS_EMITTER = wgslTagFn/* wgsl */`
    fn causticEmitter() -> bool {

        return ${ CAUSTICS.on } != 0u && ${ CAUSTICS.emitters } != 0u;

    }
`;

/** caustics are on: a reflection off glass after a rough bounce is a caustic path as well (the photons reflect there) */
export const CAUSTICS_ACTIVE = wgslTagFn/* wgsl */`
    fn causticActive() -> bool {

        return ${ CAUSTICS.on } != 0u;

    }
`;

/** this light sample's light through casters comes from the photons: every lamp (the path tracer's light types 0–4 –
 *  rectangle, disc, spot/IES, directional, point), the environment while it sends photons */
export const CAUSTICS_COVERS = wgslTagFn/* wgsl */`
    fn causticCovers( lamp: bool, environment: bool ) -> bool {

        return ${ CAUSTICS.on } != 0u && ( lamp || ( environment && ${ CAUSTICS.env } != 0u ) );

    }
`;

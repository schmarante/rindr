// Radiance cache (user: "Weg 2 … und wir resetten den Radiance-Cache, sobald sich etwas bewegt oder eine Animation
// abgespielt wird"): the light that diffuse surfaces send on, kept in a world-space hash grid across camera moves –
// after turning the camera the picture converges much faster, because most paths take the indirect light from the
// grid instead of tracing it again.
//
// Megakernel (Vite plugin `rindr-radiance-cache`, kernel feature 'radiance'): the first surface a path reaches after a
// rough bounce (gsRough – e.g. camera → floor → wall: the wall), if it is diffuse (roughness ≥ ½, metalness < ½, no
// glass, no shadow catcher, no volume):
//   - the cell (position + the side the surface faces, ± ½ cell jitter along it) holds at least `minCount` samples and
//     the path is not one of the training share → the path ends there: + throughput × the cell's radiance;
//   - otherwise the path goes on and, at its end, writes what this vertex sent back: (light gathered after it) ÷ its
//     throughput – the outgoing radiance towards the path, averaged per cell.
// Glossy surfaces (user: the sample scene's car paint never showed up in the cache – "ganz komisch"): after a rough bounce
// the glossy filter has already softened them (roughness and coat roughness ≥ blurRoughness, ~0.4–0.5 with factor 1),
// so they are cached too, with the direction towards the path as part of the key – DIR_N × DIR_N octahedral buckets in
// world space (jittered by up to a bucket on lookup, like the position), as long as the sharpest lobe there (base or coat)
// is at least GLOSSY_MIN rough; sharper ones (glossy filter off, mirrors) and glass are never cached. Diffuse surfaces
// keep one value for all directions (bucket 0).
// Fixed point (× SCALE, u32 atomics), each sample clamped to MAX_SAMPLE (fireflies would stay in a cell), at most CAP
// samples per cell (the sum then stays as it is, a full cell is not written any more). 6 bins by side.
// Cell size by the distance to the camera (user: "wenn ich reinzoome, sollte der Radiance-Cache entsprechend
// detaillierter werden"): a cell is about `pixels` pixels on screen where it lies – power-of-two sizes (the level is part
// of the key), so turning at the same distance keeps the cells, zooming in makes finer ones near the camera; surfaces far
// away or behind the camera get coarse cells. The number of cells follows the picture's size, not the scene's (first a
// fixed size across the scene: a room of 40 m² took 73 % of the table).

// Cleared whenever anything but the camera changes (pathtracer.js _updateRadianceCache: scene data, transforms – also
// every frame of an animation –, materials, lights, environment, glass shadows, bounces, glossy filter); off while
// light passes render (their kinds and sources would not see the cached light).
//
// While the camera moves the paths run with fewer bounces (pt-motion.js): the cache is read then, not written.
//
// Uniforms: on, write, cell (origin xyz, smallest side w), camera (position xyz, size of a pixel at distance 1 w – 0 for an
// orthographic camera: then ortho.x = a pixel's size), pixels, maxSide, mask (slots − 1), train (share of the paths that
// always go on), minCount.
import * as THREE from 'three/webgpu';
import { uniform, storage, globalId } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';

export const RADIANCE_SLOTS = 2 ** 20;   // 36 MB (user: "doppelt so viel Speicher"; was 2^19)
export const RADIANCE_STRIDE = 9;        // u32 per slot: key, r, g, b, count, cell x, y, z, level + 128 | kind << 16 | bucket << 20
const SCALE = 256;
const CAP = 1024;
export const RADIANCE_PROBES = 16;
// one u32 after the table: slots taken since the last clear (pathtracer.js reads these 4 bytes and clears at ~70 %)
export const RADIANCE_COUNTER = RADIANCE_SLOTS * RADIANCE_STRIDE;
// finer cells where other geometry is near (corners, contact): the harmonic mean distance a cell's rays travel to their
// next hit, relative to its coarse side – cell side ≈ DETAIL_A × that distance, at most `refine` levels finer
// (settings: min rate = the coarse size, 2^−min pixels; max rate = the finest, refine = max − min)
const DETAIL_A = 0.5;
const KIND_DETAIL = 1;
// glossy surfaces: direction buckets per side (octahedral, world space) and the roughness they need
export const RADIANCE_DIR_N = 4;
const GLOSSY_MIN = 0.3;

export const RADIANCE_GRID = new THREE.StorageBufferAttribute(new Uint32Array(RADIANCE_COUNTER + 4), 1);
const gridAttribute = RADIANCE_GRID;

export const RADIANCE_CACHE = {
    on: uniform(0, 'uint'),
    write: uniform(1, 'uint'),   // 0 while the camera moves: those paths run with fewer bounces (would darken the cells)
    cell: uniform(new THREE.Vector4(0, 0, 0, 1)),
    camera: uniform(new THREE.Vector4(0, 0, 0, 0.001)),
    ortho: uniform(0),
    pixels: uniform(16),
    refine: uniform(3, 'int'),
    maxSide: uniform(1e9),
    mask: uniform(RADIANCE_SLOTS - 1, 'uint'),
    train: uniform(0.25),
    minCount: uniform(16, 'uint'),
    maxSample: uniform(64),
    glossy: uniform(1, 'uint'),   // glossy surfaces cached too (direction buckets) – PATHTRACING.radianceCache.glossy
    grid: storage(gridAttribute, 'uint', RADIANCE_COUNTER + 4).toAtomic().setName('rindr_radiance'),
};

// coarse level of the cell at p: log2 of its side – `pixels` pixels at its distance from the camera, within cell.w … maxSide
const baseLevel = wgslTagFn/* wgsl */`
    fn radianceBaseLevel( p: vec3f ) -> i32 {

        let cam = ${ RADIANCE_CACHE.camera };
        let pixel = select( distance( p, cam.xyz ) * cam.w, ${ RADIANCE_CACHE.ortho }, ${ RADIANCE_CACHE.ortho } > 0.0 );
        let side = clamp( pixel * ${ RADIANCE_CACHE.pixels }, ${ RADIANCE_CACHE.cell }.w, ${ RADIANCE_CACHE.maxSide } );
        return i32( round( log2( side ) ) );

    }
`;

// cell coordinates of p at a level
const coords = wgslTagFn/* wgsl */`
    fn radianceCoords( p: vec3f, level: i32 ) -> vec3i {

        return vec3i( floor( ( p - ${ RADIANCE_CACHE.cell }.xyz ) / exp2( f32( level ) ) ) );

    }
`;

// slot (x) and key (y, never 0) of the cell at p on the side n faces, at a level, of a kind (0 light, 1 distance), for a
// direction bucket (0: all directions)
const hash = wgslTagFn/* wgsl */`
    fn radianceHash( p: vec3f, n: vec3f, level: i32, kind: u32, dir: u32 ) -> vec2u {

        let c = bitcast<vec3u>( ${ coords }( p, level ) );
        let a = abs( n );
        var bin = select( select( 4u, 2u, a.y >= a.z ), 0u, a.x >= a.y && a.x >= a.z );
        let side = select( select( n.z, n.y, a.y >= a.z ), n.x, a.x >= a.y && a.x >= a.z );
        bin += select( 0u, 1u, side < 0.0 );
        bin += bitcast<u32>( level + 128 ) * 8u + kind * 4096u + dir * 8192u;
        var h = bin * 2654435761u + 0x9e3779b9u;
        h = ( h ^ c.x ) * 0x85ebca6bu; h ^= ( h >> 13u );
        h = ( h ^ c.y ) * 0xc2b2ae35u; h ^= ( h >> 16u );
        h = ( h ^ c.z ) * 0x27d4eb2fu; h ^= ( h >> 15u );
        var k = ( c.x * 73856093u ) ^ ( c.y * 19349663u ) ^ ( c.z * 83492791u ) ^ ( bin * 2246822519u );
        k = ( k ^ ( k >> 16u ) ) * 0x7feb352du;
        k = ( k ^ ( k >> 15u ) ) * 0x846ca68bu;
        k ^= ( k >> 16u );
        return vec2u( h, k | 1u );

    }
`;

// the slot holding key hk (its first u32), or 0xffffffff
const find = wgslTagFn/* wgsl */`
    fn radianceFind( hk: vec2u ) -> u32 {

        let mask = ${ RADIANCE_CACHE.mask };
        for ( var i = 0u; i < ${ RADIANCE_PROBES }u; i ++ ) {

            let e = ( ( hk.x + i ) & mask ) * ${ RADIANCE_STRIDE }u;
            let key = atomicLoad( &${ RADIANCE_CACHE.grid }[ e ] );
            if ( key == hk.y ) {

                return e;

            }
            if ( key == 0u ) {

                return 0xffffffffu;

            }

        }
        return 0xffffffffu;

    }
`;

// the slot for key hk, taken if free (compare-exchange, linear probing; the cell's coordinates, level and kind stored for
// the debug view, the counter of taken slots raised) – or 0xffffffff when the probes found no place
const claim = wgslTagFn/* wgsl */`
    fn radianceClaim( hk: vec2u, p: vec3f, level: i32, kind: u32, dir: u32 ) -> u32 {

        let mask = ${ RADIANCE_CACHE.mask };
        for ( var i = 0u; i < ${ RADIANCE_PROBES }u; i ++ ) {

            let e = ( ( hk.x + i ) & mask ) * ${ RADIANCE_STRIDE }u;
            var key = atomicLoad( &${ RADIANCE_CACHE.grid }[ e ] );
            for ( var t = 0u; key == 0u && t < 8u; t ++ ) {

                let x = atomicCompareExchangeWeak( &${ RADIANCE_CACHE.grid }[ e ], 0u, hk.y );
                key = select( x.old_value, hk.y, x.exchanged );
                if ( x.exchanged ) {

                    let c = ${ coords }( p, level );
                    atomicStore( &${ RADIANCE_CACHE.grid }[ e + 5u ], bitcast<u32>( c.x ) );
                    atomicStore( &${ RADIANCE_CACHE.grid }[ e + 6u ], bitcast<u32>( c.y ) );
                    atomicStore( &${ RADIANCE_CACHE.grid }[ e + 7u ], bitcast<u32>( c.z ) );
                    atomicStore( &${ RADIANCE_CACHE.grid }[ e + 8u ], bitcast<u32>( level + 128 ) | ( kind << 16u ) | ( dir << 20u ) );
                    atomicAdd( &${ RADIANCE_CACHE.grid }[ ${ RADIANCE_COUNTER }u ], 1u );

                }

            }
            if ( key == hk.y ) {

                return e;

            }

        }
        return 0xffffffffu;

    }
`;

/** level of the light cell at p: the coarse level by the camera, up to `refine` finer where the cell's rays meet other
 *  geometry close by (harmonic mean distance from the distance cell at the coarse level, ≥ 4 samples) */
export const RADIANCE_LEVEL = wgslTagFn/* wgsl */`
    fn radianceLevel( p: vec3f, n: vec3f ) -> i32 {

        let base = ${ baseLevel }( p );
        let e = ${ find }( ${ hash }( p, n, base, ${ KIND_DETAIL }u, 0u ) );
        if ( e == 0xffffffffu ) {

            return base;

        }
        let count = atomicLoad( &${ RADIANCE_CACHE.grid }[ e + 4u ] );
        if ( count < 4u ) {

            return base;

        }
        // mean of side / distance = side / harmonic mean distance
        let s = f32( atomicLoad( &${ RADIANCE_CACHE.grid }[ e + 1u ] ) ) / ( ${ SCALE }.0 * f32( min( count, ${ CAP }u ) ) );
        let refine = clamp( i32( round( log2( max( s, 1e-6 ) / ${ DETAIL_A } ) ) ), 0, ${ RADIANCE_CACHE.refine } );
        return base - refine;

    }
`;

const offset = wgslTagFn/* wgsl */`
    fn radianceJitter( p: vec3f, n: vec3f, jitter: vec2f, side: f32 ) -> vec3f {

        let t = normalize( select( cross( n, vec3f( 0.0, 1.0, 0.0 ) ), cross( n, vec3f( 1.0, 0.0, 0.0 ) ), abs( n.y ) > 0.9 ) );
        let b = cross( n, t );
        return p + ( t * ( jitter.x - 0.5 ) + b * ( jitter.y - 0.5 ) ) * side;

    }
`;

/** direction bucket of the surface for the path coming from direction v (towards the path): 0 = diffuse (one value for
 *  all directions), 1 + octahedral bucket = glossy but soft enough, 0xffffffff = not cached. jitter: (0.5, 0.5) for writing,
 *  2 random numbers for reading (up to ± half a bucket – blends neighbouring buckets like the position jitter) */
export const RADIANCE_BUCKET = wgslTagFn/* wgsl */`
    fn radianceBucket( v: vec3f, roughness: f32, metalness: f32, coat: f32, coatRoughness: f32, jitter: vec2f ) -> u32 {

        let coatR = select( 1.0, coatRoughness, coat > 0.0 );
        if ( roughness >= 0.5 && metalness < 0.5 && coatR >= 0.5 ) {

            return 0u;

        }
        if ( ${ RADIANCE_CACHE.glossy } == 0u || min( roughness, coatR ) < ${ GLOSSY_MIN } ) {

            return 0xffffffffu;

        }
        // octahedral map of v to [0, 1]²
        let a = v / ( abs( v.x ) + abs( v.y ) + abs( v.z ) );
        var o = a.xz;
        if ( a.y < 0.0 ) {

            o = ( 1.0 - abs( a.zx ) ) * select( vec2f( - 1.0 ), vec2f( 1.0 ), a.xz >= vec2f( 0.0 ) );

        }
        let uv = clamp( o * 0.5 + 0.5 + ( jitter - 0.5 ) / ${ RADIANCE_DIR_N }.0, vec2f( 0.0 ), vec2f( 0.9999 ) );
        let b = vec2u( uv * ${ RADIANCE_DIR_N }.0 );
        return 1u + b.x + b.y * ${ RADIANCE_DIR_N }u;

    }
`;

/** the light cell's radiance at p, level from radianceLevel (n: geometric normal facing the path; jitter: 2 random
 *  numbers) – w 1 when it holds enough samples, else 0 */
export const RADIANCE_LOOKUP = wgslTagFn/* wgsl */`
    fn radianceLookup( p: vec3f, n: vec3f, jitter: vec2f, level: i32, dir: u32 ) -> vec4f {

        let e = ${ find }( ${ hash }( ${ offset }( p, n, jitter, exp2( f32( level ) ) ), n, level, 0u, dir ) );
        if ( e == 0xffffffffu ) {

            return vec4f( 0.0 );

        }
        let count = atomicLoad( &${ RADIANCE_CACHE.grid }[ e + 4u ] );
        if ( count < ${ RADIANCE_CACHE.minCount } ) {

            return vec4f( 0.0 );

        }
        let rgb = vec3f( f32( atomicLoad( &${ RADIANCE_CACHE.grid }[ e + 1u ] ) ), f32( atomicLoad( &${ RADIANCE_CACHE.grid }[ e + 2u ] ) ), f32( atomicLoad( &${ RADIANCE_CACHE.grid }[ e + 3u ] ) ) );
        return vec4f( rgb / ( f32( min( count, ${ CAP }u ) ) * ${ SCALE }.0 ), 1.0 );

    }
`;

// Writing in two steps (fewer values carried along the path – the megakernel ran ~40 % slower with the cache compiled in
// but switched off, its registers took the room): the surface claims its light cell and distance cell when it is
// recorded (radianceSlot, radianceDistSlot – only the slots are kept), the path adds its sample at the end
// (radianceAdd) and the distance its next ray travelled at the next hit (radianceAddDist). Full cells are not touched
// again: coarse cells (far away, behind the camera) are hit by very many paths – their atomics queued up.

/** the light cell at p for a level and direction bucket, claimed – or 0xffffffff (not writing, no place, full) */
export const RADIANCE_SLOT = wgslTagFn/* wgsl */`
    fn radianceSlot( p: vec3f, n: vec3f, level: i32, dir: u32 ) -> u32 {

        if ( ${ RADIANCE_CACHE.write } == 0u ) {

            return 0xffffffffu;

        }
        let e = ${ claim }( ${ hash }( p, n, level, 0u, dir ), p, level, 0u, dir );
        if ( e == 0xffffffffu || atomicLoad( &${ RADIANCE_CACHE.grid }[ e + 4u ] ) >= ${ CAP }u ) {

            return 0xffffffffu;

        }
        return e;

    }
`;

/** the distance cell at p (coarse level), claimed – or 0xffffffff */
export const RADIANCE_DIST_SLOT = wgslTagFn/* wgsl */`
    fn radianceDistSlot( p: vec3f, n: vec3f ) -> u32 {

        if ( ${ RADIANCE_CACHE.write } == 0u ) {

            return 0xffffffffu;

        }
        let base = ${ baseLevel }( p );
        let e = ${ claim }( ${ hash }( p, n, base, ${ KIND_DETAIL }u, 0u ), p, base, ${ KIND_DETAIL }u, 0u );
        if ( e == 0xffffffffu || atomicLoad( &${ RADIANCE_CACHE.grid }[ e + 4u ] ) >= ${ CAP }u ) {

            return 0xffffffffu;

        }
        return e;

    }
`;

/** one sample of outgoing radiance L into the light cell at slot e */
export const RADIANCE_ADD = wgslTagFn/* wgsl */`
    fn radianceAdd( e: u32, L: vec3f ) -> void {

        if ( any( L != L ) || any( L < vec3f( 0.0 ) ) ) {

            return;

        }
        let lum = dot( L, vec3f( 0.2126, 0.7152, 0.0722 ) );
        let v = L * min( 1.0, ${ RADIANCE_CACHE.maxSample } / max( lum, 1e-8 ) );
        let count = atomicAdd( &${ RADIANCE_CACHE.grid }[ e + 4u ], 1u );
        if ( count < ${ CAP }u ) {

            let q = vec3u( v * ${ SCALE }.0 + vec3f( 0.5 ) );
            atomicAdd( &${ RADIANCE_CACHE.grid }[ e + 1u ], q.x );
            atomicAdd( &${ RADIANCE_CACHE.grid }[ e + 2u ], q.y );
            atomicAdd( &${ RADIANCE_CACHE.grid }[ e + 3u ], q.z );

        }

    }
`;

/** the distance the ray after the recorded surface travelled (dist ≤ 0: escaped – counts as 0) into the distance cell at
 *  slot e: side / dist (≤ 16), the side from the cell's level */
export const RADIANCE_ADD_DIST = wgslTagFn/* wgsl */`
    fn radianceAddDist( e: u32, dist: f32 ) -> void {

        let dc = atomicAdd( &${ RADIANCE_CACHE.grid }[ e + 4u ], 1u );
        if ( dc < ${ CAP }u && dist > 0.0 ) {

            let level = i32( atomicLoad( &${ RADIANCE_CACHE.grid }[ e + 8u ] ) & 0xffffu ) - 128;
            atomicAdd( &${ RADIANCE_CACHE.grid }[ e + 1u ], u32( min( exp2( f32( level ) ) / dist, 16.0 ) * ${ SCALE }.0 + 0.5 ) );

        }

    }
`;

/** the cache is on in this frame */
export const RADIANCE_ON = wgslTagFn/* wgsl */`
    fn radianceOn() -> bool {

        return ${ RADIANCE_CACHE.on } != 0u;

    }
`;

/** clearing: a compute kernel over the grid (built on first use) */
let clearKernel = null;
export function clearRadianceCache(renderer) {
    if (!clearKernel) {
        const total = RADIANCE_COUNTER + 4;
        const grid = storage(gridAttribute, 'uint', total);
        clearKernel = wgslTagFn/* wgsl */`
            fn compute( globalId: vec3u ) -> void {

                let start = globalId.x * 64u;
                for ( var i = 0u; i < 64u; i ++ ) {

                    if ( start + i < ${ total }u ) {

                        ${ grid }[ start + i ] = 0u;

                    }

                }

            }
        `({ globalId }).computeKernel([64, 1, 1]);
    }
    renderer.compute(clearKernel, [Math.ceil((RADIANCE_COUNTER + 4) / 64 / 64), 1, 1]);
    clearRadianceCache.count = (clearRadianceCache.count ?? 0) + 1;   // the debug view starts over
}

/** slots taken since the last clear (the counter after the table – 4 bytes copied straight from the GPU buffer), or null
 *  while a read is pending / the buffer is not on the GPU yet */
let staging = null, reading = false;
export async function readRadianceOccupancy(renderer) {
    const backend = renderer.backend, device = backend?.device, src = backend?.get?.(gridAttribute)?.buffer;
    if (!device || !src || reading) return null;
    reading = true;
    try {
        staging ??= device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(src, RADIANCE_COUNTER * 4, staging, 0, 4);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const taken = new Uint32Array(staging.getMappedRange())[0];
        staging.unmap();
        return taken;
    } catch {
        return null;
    } finally {
        reading = false;
    }
}

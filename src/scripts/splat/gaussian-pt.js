// Gaussian splats traced exactly in the path tracer (docs/splats.md "Gaussian Ray Tracing"; data: gaussian-data.js,
// built by gaussian-bvh-worker.js). A ray meets each Gaussian where its response along the ray peaks:
//   local = M (p − μ) (M: rows = rotation axes / scales), t* = −⟨M(o−μ), Md⟩ / |Md|², response α · exp(−½ |M(o + t*d − μ)|²).
// Camera and path rays: the K nearest peaks of a stretch per traversal of the BVH (K-buffer, the far bound shrinks to
// the K-th one), blended front to back, again from the last one on until little light passes (rounds). Shadow rays:
// the product of (1 − response) of every Gaussian on the way – no order needed. Own module: only the lazily loaded path
// tracer imports it. Peaks behind the start of a stretch are left out (a ray starting inside a Gaussian).
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { GAUSS } from './gaussian-data.js';
import { SPLAT_UNIFORMS as S } from './splat-volume.js';

export const GAUSS_K = 16;
const ROUNDS = 8;          // K per round: at most 128 Gaussians blended per stretch
const STACK = 24;          // ≤ BVH depth + 1 (the worker builds at most 22 levels) – a larger one lived in slow local memory: 13.7 s → 7.6 s (smoke)
const MIN_ALPHA = '0.00392156863';   // 1/255

const D = GAUSS.data;

// slab test of node ni (data space): (entry, exit)
const BOX = wgslTagFn/* wgsl */`
    fn rindrGxBox( ni: u32, o: vec3f, invD: vec3f ) -> vec2f {

        let n0 = ${ D }[ 2u + ni * 2u ];
        let n1 = ${ D }[ 3u + ni * 2u ];
        let t0 = ( n0.xyz - o ) * invD;
        let t1 = ( vec3f( n0.w, n1.x, n1.y ) - o ) * invD;
        let tn = max( max( min( t0.x, t1.x ), min( t0.y, t1.y ) ), min( t0.z, t1.z ) );
        let tf = min( min( max( t0.x, t1.x ), max( t0.y, t1.y ) ), max( t0.z, t1.z ) );
        return vec2f( tn, tf );

    }
`;

// Gaussian j (leaf order): (t of the peak, response there)
const EVAL = wgslTagFn/* wgsl */`
    fn rindrGxEval( first: u32, j: u32, o: vec3f, d: vec3f ) -> vec2f {

        let b = first + j * 4u;
        let c = ${ D }[ b ];
        let r0 = ${ D }[ b + 1u ];
        let r1 = ${ D }[ b + 2u ];
        let r2 = ${ D }[ b + 3u ];
        let p = o - c.xyz;
        let lo = vec3f( dot( r0.xyz, p ), dot( r1.xyz, p ), dot( r2.xyz, p ) );
        let ld = vec3f( dot( r0.xyz, d ), dot( r1.xyz, d ), dot( r2.xyz, d ) );
        let t = - dot( lo, ld ) / max( dot( ld, ld ), 1e-30 );
        let m = lo + ld * t;
        return vec2f( t, c.w * exp( - 0.5 * dot( m, m ) ) );

    }
`;

const SRGB = wgslTagFn/* wgsl */`
    fn rindrGxLinear( c: vec3f ) -> vec3f {

        return select( pow( ( c + vec3f( 0.055 ) ) / 1.055, vec3f( 2.4 ) ), c / 12.92, c <= vec3f( 0.04045 ) );

    }
`;

// base colour of Gaussian j (display values as in the file)
const BASE = wgslTagFn/* wgsl */`
    fn rindrGxBase( first: u32, j: u32 ) -> vec3f {

        return unpack4x8unorm( bitcast<u32>( ${ D }[ first + j * 4u + 1u ].w ) ).rgb;

    }
`;

// linear base colour (albedo, guides)
const COLOR = wgslTagFn/* wgsl */`
    fn rindrGxColor( first: u32, j: u32 ) -> vec3f {

        return ${ SRGB }( ${ BASE }( first, j ) );

    }
`;

// view-dependent part (higher SH bands) for the viewing direction d (data space, normalised) – as the raster
// (splat-mesh.js: snorm8 × shRange, coefficient-major r, g, b; 3DGS basis)
const SH = wgslTagFn/* wgsl */`
    fn rindrGxSh( first: u32, j: u32, d: vec3f ) -> vec3f {

        let info = bitcast<vec4u>( ${ D }[ 0u ] ).w;
        let words = info & 0xffu;
        let coeffs = info >> 8u;
        if ( coeffs == 0u ) {

            return vec3f( 0.0 );

        }
        let x = d.x;
        let y = d.y;
        let z = d.z;
        let xx = x * x;
        let yy = y * y;
        let zz = z * z;
        var basis = array<f32, 15>(
            - 0.4886025119029199 * y, 0.4886025119029199 * z, - 0.4886025119029199 * x,
            1.0925484305920792 * x * y, - 1.0925484305920792 * y * z, 0.31539156525252005 * ( 2.0 * zz - xx - yy ),
            - 1.0925484305920792 * x * z, 0.5462742152960396 * ( xx - yy ),
            - 0.5900435899266435 * y * ( 3.0 * xx - yy ), 2.890611442640554 * x * y * z, - 0.4570457994644658 * y * ( 4.0 * zz - xx - yy ),
            0.3731763325901154 * z * ( 2.0 * zz - 3.0 * xx - 3.0 * yy ), - 0.4570457994644658 * x * ( 4.0 * zz - xx - yy ),
            1.445305721320277 * z * ( xx - yy ), - 0.5900435899266435 * x * ( xx - 3.0 * yy ) );
        // the words of Gaussian j (leaf order) after the splats – u32 index → vec4 element and lane
        let base = bitcast<vec4u>( ${ D }[ 1u ] ).x + j * words;
        var sum = vec3f( 0.0 );
        for ( var b = 0u; b < coeffs * 3u; b ++ ) {

            let w = base + b / 4u;
            let v = unpack4x8snorm( bitcast<u32>( ${ D }[ w / 4u ][ w % 4u ] ) )[ b % 4u ];
            sum[ b % 3u ] += v * basis[ b / 3u ];

        }
        return sum * ${ GAUSS.shRange };

    }
`;

// linear colour seen along d (data space, normalised): base + view-dependent bands (baked light)
const COLOR_VIEW = wgslTagFn/* wgsl */`
    fn rindrGxColorView( first: u32, j: u32, d: vec3f ) -> vec3f {

        return ${ SRGB }( max( ${ BASE }( first, j ) + ${ SH }( first, j, d ), vec3f( 0.0 ) ) );

    }
`;

const INV_DIR = wgslTagFn/* wgsl */`
    fn rindrGxInvDir( d: vec3f ) -> vec3f {

        return 1.0 / select( d, vec3f( 1e-30 ), abs( d ) < vec3f( 1e-30 ) );

    }
`;

// a random number 0…1 per Gaussian and path (PCG hash)
const HASH = wgslTagFn/* wgsl */`
    fn rindrGxHash( x: u32 ) -> f32 {

        let v = x * 747796405u + 2891336453u;
        let w = ( ( v >> ( ( v >> 28u ) + 4u ) ) ^ v ) * 277803737u;
        return f32( ( w >> 22u ) ^ w ) / 4294967296.0;

    }
`;

/**
 * The nearest Gaussian that catches the ray along o + t·d (data space), tMin < t ≤ tMax: each one catches with the
 * probability of its response, independently (random per Gaussian and `seed`) – so the first catch in order is the
 * nearest catching one: one traversal keeping only the nearest candidate (near child first, farther nodes skipped).
 * x = t (−1: none), y = its bits.
 */
const CATCH = wgslTagFn/* wgsl */`
    fn rindrGxCatch( first: u32, o: vec3f, d: vec3f, invD: vec3f, tMin: f32, tMax: f32, seed: u32 ) -> vec2f {

        var best = - 1.0;
        var bestJ = 0u;
        var far = tMax;
        var stack: array<u32, ${ STACK }>;
        var sp = 1u;
        stack[ 0 ] = 0u;
        while ( sp > 0u ) {

            sp --;
            let ni = stack[ sp ];
            let span = ${ BOX }( ni, o, invD );
            if ( span.y < max( span.x, tMin ) || span.x > far ) {

                continue;

            }
            let n1 = ${ D }[ 3u + ni * 2u ];
            let w6 = bitcast<u32>( n1.z );
            let w7 = bitcast<u32>( n1.w );
            if ( ( w7 >> 16u ) == 0xffffu ) {

                let count = w7 & 0xffffu;
                for ( var k = 0u; k < count; k ++ ) {

                    let j = w6 + k;
                    let e = ${ EVAL }( first, j, o, d );
                    if ( e.y >= ${ MIN_ALPHA } && e.x > tMin && e.x <= far && ${ HASH }( j ^ seed ) < min( e.y, 0.99 ) ) {

                        best = e.x;
                        bestJ = j;
                        far = e.x;

                    }

                }

            } else if ( sp + 2u <= ${ STACK }u ) {

                let left = ni + 1u;
                let right = ni + w6;
                if ( d[ w7 & 3u ] >= 0.0 ) {

                    stack[ sp ] = right;
                    stack[ sp + 1u ] = left;

                } else {

                    stack[ sp ] = left;
                    stack[ sp + 1u ] = right;

                }
                sp += 2u;

            }

        }
        return vec2f( best, bitcast<f32>( bestJ ) );

    }
`;

/**
 * Gaussians along o + t·d, 0 < t ≤ tMax (world), front to back, starting with the transmittance `transIn`:
 *   mode 0 (baked splats): rgb = their light, a = transmittance after them – the first K blended exactly, the rest
 *          by the one that catches the ray (rindrGxCatch; expected value = the blending); stops below 1 % transmittance
 *   mode 1 (where they count as a surface – helper passes, denoiser guides): x = t where the transmittance falls to ½
 *          (−1: not on this stretch), y = that Gaussian (bits of its index), z = transmittance after the stretch
 *   mode 3 (guides' albedo): like mode 0, every Gaussian exact (what the catches average to)
 *   mode 2 (relit splats): the first Gaussian that catches the ray – each one with the probability of its response
 *          (random per Gaussian and `seed`; the expected value is the blending): x = t (−1: none), y = its bits
 */
const MARCH = wgslTagFn/* wgsl */`
    fn rindrGxMarch( worldO: vec3f, worldD: vec3f, tMax: f32, mode: u32, transIn: f32, seed: u32 ) -> vec4f {

        let hdr = bitcast<vec4u>( ${ D }[ 0u ] );
        if ( hdr.x == 0u ) {

            return select( vec4f( 0.0, 0.0, 0.0, transIn ), vec4f( - 1.0, 0.0, transIn, 0.0 ), mode == 1u );

        }
        let first = hdr.y;
        // data space: the same t as in the world (a linear map)
        let o = ( ${ GAUSS.inverse } * vec4f( worldO, 1.0 ) ).xyz;
        let d = ( ${ GAUSS.inverse } * vec4f( worldD, 0.0 ) ).xyz;
        let invD = ${ INV_DIR }( d );
        let view = normalize( d );
        if ( mode == 2u ) {

            let c = ${ CATCH }( first, o, d, invD, 0.0, tMax, seed );
            return vec4f( c.x, c.y, 0.0, select( 0.0, 1.0, c.x >= 0.0 ) );

        }
        var color = vec3f( 0.0 );
        var trans = transIn;
        var tMin = 0.0;
        for ( var round = 0u; round < ${ ROUNDS }u; round ++ ) {

            // the K nearest peaks after tMin
            var ht: array<f32, ${ GAUSS_K }>;
            var hj: array<u32, ${ GAUSS_K }>;
            var ha: array<f32, ${ GAUSS_K }>;
            var hn = 0u;
            var far = tMax;
            var stack: array<u32, ${ STACK }>;
            var sp = 1u;
            stack[ 0 ] = 0u;
            while ( sp > 0u ) {

                sp --;
                let ni = stack[ sp ];
                let span = ${ BOX }( ni, o, invD );
                if ( span.y < max( span.x, tMin ) || span.x > far ) {

                    continue;

                }
                let n1 = ${ D }[ 3u + ni * 2u ];
                let w6 = bitcast<u32>( n1.z );
                let w7 = bitcast<u32>( n1.w );
                if ( ( w7 >> 16u ) == 0xffffu ) {

                    let count = w7 & 0xffffu;
                    for ( var k = 0u; k < count; k ++ ) {

                        let j = w6 + k;
                        let e = ${ EVAL }( first, j, o, d );
                        if ( e.y < ${ MIN_ALPHA } || e.x <= tMin || e.x > far ) {

                            continue;

                        }
                        // insert sorted (the last one drops out when full)
                        var i = select( ${ GAUSS_K - 1 }u, hn, hn < ${ GAUSS_K }u );
                        while ( i > 0u && ht[ i - 1u ] > e.x ) {

                            ht[ i ] = ht[ i - 1u ];
                            hj[ i ] = hj[ i - 1u ];
                            ha[ i ] = ha[ i - 1u ];
                            i --;

                        }
                        ht[ i ] = e.x;
                        hj[ i ] = j;
                        ha[ i ] = e.y;
                        hn = min( hn + 1u, ${ GAUSS_K }u );
                        if ( hn == ${ GAUSS_K }u ) {

                            far = ht[ ${ GAUSS_K - 1 }u ];

                        }

                    }

                } else if ( sp + 2u <= ${ STACK }u ) {

                    // near child on top
                    let left = ni + 1u;
                    let right = ni + w6;
                    if ( d[ w7 & 3u ] >= 0.0 ) {

                        stack[ sp ] = right;
                        stack[ sp + 1u ] = left;

                    } else {

                        stack[ sp ] = left;
                        stack[ sp + 1u ] = right;

                    }
                    sp += 2u;

                }

            }
            for ( var i = 0u; i < hn; i ++ ) {

                let a = min( ha[ i ], 0.99 );
                if ( mode == 1u && trans * ( 1.0 - a ) <= 0.5 ) {

                    return vec4f( ht[ i ], bitcast<f32>( hj[ i ] ), trans * ( 1.0 - a ), 0.0 );

                }
                if ( mode == 0u ) {

                    color += trans * a * ${ COLOR_VIEW }( first, hj[ i ], view );
                    trans *= 1.0 - a;
                    continue;

                }
                if ( mode == 3u ) {

                    color += trans * a * ${ COLOR_VIEW }( first, hj[ i ], view );

                }
                trans *= 1.0 - a;

            }
            if ( hn < ${ GAUSS_K }u || trans < 0.01 ) {

                break;

            }
            tMin = ht[ ${ GAUSS_K - 1 }u ];
            if ( mode == 0u ) {

                // after the first K: the Gaussian that catches the ray brings the rest (expected value = the blending –
                // dense smoke needed many rounds)
                let c = ${ CATCH }( first, o, d, invD, tMin, tMax, seed );
                if ( c.x >= 0.0 ) {

                    color += trans * ${ COLOR_VIEW }( first, bitcast<u32>( c.y ), view );
                    trans = 0.0;

                }
                break;

            }

        }
        return select( vec4f( color, trans ), vec4f( - 1.0, 0.0, trans, 0.0 ), mode == 1u || mode == 2u );

    }
`;

/** world normal of Gaussian j (bits from rindrGxMarch): its shortest axis, facing against worldD */
const NORMAL = wgslTagFn/* wgsl */`
    fn rindrGxNormal( jBits: f32, worldD: vec3f ) -> vec3f {

        let first = bitcast<vec4u>( ${ D }[ 0u ] ).y;
        let b = first + bitcast<u32>( jBits ) * 4u;
        // rows = axis / scale: the longest row is the shortest axis
        let r0 = ${ D }[ b + 1u ].xyz;
        let r1 = ${ D }[ b + 2u ].xyz;
        let r2 = ${ D }[ b + 3u ].xyz;
        var axis = r0;
        if ( dot( r1, r1 ) > dot( axis, axis ) ) {

            axis = r1;

        }
        if ( dot( r2, r2 ) > dot( axis, axis ) ) {

            axis = r2;

        }
        // data → world for a normal: transpose of world → data
        let m = ${ GAUSS.inverse };
        var n = normalize( transpose( mat3x3f( m[ 0 ].xyz, m[ 1 ].xyz, m[ 2 ].xyz ) ) * axis );
        return select( n, - n, dot( n, worldD ) > 0.0 );

    }
`;

/** colour of Gaussian j (bits from rindrGxMarch) */
const COLOR_OF = wgslTagFn/* wgsl */`
    fn rindrGxColorOf( jBits: f32 ) -> vec3f {

        return ${ COLOR }( bitcast<vec4u>( ${ D }[ 0u ] ).y, bitcast<u32>( jBits ) );

    }
`;

/**
 * light passing the splats along o + t·d, 0 < t ≤ tMax (world; tMax 0 = unbounded) – shadow rays. Stochastic: each
 * Gaussian blocks with the probability of its response (random per Gaussian and `seed`), the first one ends the test –
 * 0 or 1, the expected value is the product of (1 − response); in dense smoke far fewer Gaussians are visited.
 */
const TRANSMITTANCE = wgslTagFn/* wgsl */`
    fn rindrGxTransmittance( worldO: vec3f, worldD: vec3f, maxDist: f32, seed: u32 ) -> f32 {

        let hdr = bitcast<vec4u>( ${ D }[ 0u ] );
        if ( hdr.x == 0u ) {

            return 1.0;

        }
        let first = hdr.y;
        let tMax = select( maxDist, 1e30, maxDist <= 0.0 );
        let o = ( ${ GAUSS.inverse } * vec4f( worldO, 1.0 ) ).xyz;
        let d = ( ${ GAUSS.inverse } * vec4f( worldD, 0.0 ) ).xyz;
        let invD = ${ INV_DIR }( d );
        var stack: array<u32, ${ STACK }>;
        var sp = 1u;
        stack[ 0 ] = 0u;
        while ( sp > 0u ) {

            sp --;
            let ni = stack[ sp ];
            let span = ${ BOX }( ni, o, invD );
            if ( span.y < max( span.x, 0.0 ) || span.x > tMax ) {

                continue;

            }
            let n1 = ${ D }[ 3u + ni * 2u ];
            let w6 = bitcast<u32>( n1.z );
            let w7 = bitcast<u32>( n1.w );
            if ( ( w7 >> 16u ) == 0xffffu ) {

                let count = w7 & 0xffffu;
                for ( var k = 0u; k < count; k ++ ) {

                    let e = ${ EVAL }( first, w6 + k, o, d );
                    if ( e.y >= ${ MIN_ALPHA } && e.x > 0.0 && e.x <= tMax && ${ HASH }( ( w6 + k ) ^ seed ) < min( e.y, 0.99 ) ) {

                        return 0.0;

                    }

                }

            } else if ( sp + 2u <= ${ STACK }u ) {

                // near child first: a blocking Gaussian is found sooner
                if ( d[ w7 & 3u ] >= 0.0 ) {

                    stack[ sp ] = ni + w6;
                    stack[ sp + 1u ] = ni + 1u;

                } else {

                    stack[ sp ] = ni + 1u;
                    stack[ sp + 1u ] = ni + w6;

                }
                sp += 2u;

            }

        }
        return 1.0;

    }
`;

/**
 * albedo of Gaussian j for relit splats seen along worldD: its colour with the view-dependent bands (as the raster's
 * relit splats – many Gaussians of a scan have a dark base colour that only the bands brighten: dark speckles without),
 * or the override material's colour × its structure (as the grid)
 */
const ALBEDO = wgslTagFn/* wgsl */`
    fn rindrGxAlbedo( jBits: f32, worldD: vec3f ) -> vec3f {

        let view = normalize( ( ${ GAUSS.inverse } * vec4f( worldD, 0.0 ) ).xyz );
        let c = ${ COLOR_VIEW }( bitcast<vec4u>( ${ D }[ 0u ] ).y, bitcast<u32>( jBits ), view );
        if ( ${ S.override } > 0.5 ) {

            return ${ S.tint } * pow( clamp( dot( c, vec3f( 0.2126, 0.7152, 0.0722 ) ) / max( ${ S.mean }, 1e-4 ), 0.0, 4.0 ), ${ S.detail } );

        }
        return c;

    }
`;

/** uniform direction on the sphere (volume look: isotropic) */
const SPHERE = wgslTagFn/* wgsl */`
    fn rindrGxSphere( u: vec2f ) -> vec3f {

        let z = 1.0 - 2.0 * u.x;
        let r = sqrt( max( 1.0 - z * z, 0.0 ) );
        let phi = 6.2831853 * u.y;
        return vec3f( r * cos( phi ), r * sin( phi ), z );

    }
`;

/** cosine-weighted direction around n (surface look: diffuse) */
const COSINE = wgslTagFn/* wgsl */`
    fn rindrGxCosine( n: vec3f, u: vec2f ) -> vec3f {

        let helper = select( vec3f( 1.0, 0.0, 0.0 ), vec3f( 0.0, 1.0, 0.0 ), abs( n.x ) > 0.9 );
        let tx = normalize( cross( helper, n ) );
        let ty = cross( n, tx );
        let r = sqrt( u.x );
        let phi = 6.2831853 * u.y;
        return normalize( tx * ( r * cos( phi ) ) + ty * ( r * sin( phi ) ) + n * sqrt( max( 1.0 - u.x, 0.0 ) ) );

    }
`;

/** linear light of Gaussian j (bits from rindrGxMarch) seen along worldD – baked splats, with the view-dependent bands */
const LIGHT = wgslTagFn/* wgsl */`
    fn rindrGxLight( jBits: f32, worldD: vec3f ) -> vec3f {

        let view = normalize( ( ${ GAUSS.inverse } * vec4f( worldD, 0.0 ) ).xyz );
        return ${ COLOR_VIEW }( bitcast<vec4u>( ${ D }[ 0u ] ).y, bitcast<u32>( jBits ), view );

    }
`;

export const GAUSS_PT = { march: MARCH, light: LIGHT, transmittance: TRANSMITTANCE, normal: NORMAL, color: COLOR_OF, albedo: ALBEDO, sphere: SPHERE,
    cosine: COSINE, on: GAUSS.on, mode: GAUSS.mode, primary: GAUSS.primary, glow: S.glow };

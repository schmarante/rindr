// Hair scattering for the path tracer (curves/, Vite patch rindr-hair in astro.config.mjs) – own implementation after
// the published model: d'Eon et al. 2011 (longitudinal scattering Mp with the modified Bessel function), Chiang et al.
// 2016 (logistic azimuthal distribution Np, the fits for the variances from β_m / β_n, colour ↔ absorption). Lobes p =
// 0 R (reflection at the surface), 1 TT (through the fibre), 2 TRT (reflected inside – the second, coloured highlight),
// 3 the rest (uniform in azimuth); scales tilted by α (cuticle).
//
// Local frame of a hit (megakernel, rindr-hair): x along the fibre, z across it towards the viewer, y = z × x; h = the
// offset of the hit across the fibre (−1…1, the cylinder normal's y). θ from the plane across the fibre (sin θ = x),
// φ = atan2(z, y). Values as the path tracer takes them: f · cos (the model's own longitudinal term holds the cosine)
// and the pdf in solid angle.
import { wgslTagFn } from 'three-mesh-bvh/webgpu';

const PI = '3.14159265358979';

// modified Bessel function of the first kind, order 0 – series (arguments of hair stay small enough), and its log
const I0 = wgslTagFn/* wgsl */`
    fn rindrHairI0( x: f32 ) -> f32 {

        var val = 0.0;
        var x2i = 1.0;
        var ifact = 1.0;
        var i4 = 1.0;
        for ( var i = 0; i < 10; i ++ ) {

            if ( i > 1 ) {

                ifact *= f32( i );

            }
            val += x2i / ( i4 * ifact * ifact );
            x2i *= x * x;
            i4 *= 4.0;

        }
        return val;

    }
`;
const LOG_I0 = wgslTagFn/* wgsl */`
    fn rindrHairLogI0( x: f32 ) -> f32 {

        if ( x > 12.0 ) {

            return x + 0.5 * ( - log( 2.0 * ${ PI } ) + log( 1.0 / x ) + 1.0 / ( 8.0 * x ) );

        }
        return log( ${ I0 }( x ) );

    }
`;

// longitudinal scattering of variance v
const MP = wgslTagFn/* wgsl */`
    fn rindrHairMp( cosThetaI: f32, cosThetaO: f32, sinThetaI: f32, sinThetaO: f32, v: f32 ) -> f32 {

        let a = cosThetaI * cosThetaO / v;
        let b = sinThetaI * sinThetaO / v;
        if ( v <= 0.1 ) {

            return exp( ${ LOG_I0 }( a ) - b - 1.0 / v + 0.6931 + log( 1.0 / ( 2.0 * v ) ) );

        }
        return exp( - b ) * ${ I0 }( a ) / ( sinh( 1.0 / v ) * 2.0 * v );

    }
`;

// logistic distribution of scale s, trimmed to [−π, π]: density, and sampling from u
const LOGISTIC = wgslTagFn/* wgsl */`
    fn rindrHairLogistic( x: f32, s: f32 ) -> f32 {

        let e = exp( - abs( x ) / s );
        return e / ( s * ( 1.0 + e ) * ( 1.0 + e ) );

    }
`;
const LOGISTIC_CDF = wgslTagFn/* wgsl */`
    fn rindrHairLogisticCdf( x: f32, s: f32 ) -> f32 {

        return 1.0 / ( 1.0 + exp( - x / s ) );

    }
`;
const TRIMMED = wgslTagFn/* wgsl */`
    fn rindrHairTrimmedLogistic( x: f32, s: f32 ) -> f32 {

        return ${ LOGISTIC }( x, s ) / ( ${ LOGISTIC_CDF }( ${ PI }, s ) - ${ LOGISTIC_CDF }( - ${ PI }, s ) );

    }
`;
const SAMPLE_TRIMMED = wgslTagFn/* wgsl */`
    fn rindrHairSampleTrimmedLogistic( u: f32, s: f32 ) -> f32 {

        let lo = ${ LOGISTIC_CDF }( - ${ PI }, s );
        let k = ${ LOGISTIC_CDF }( ${ PI }, s ) - lo;
        let x = - s * log( 1.0 / max( u * k + lo, 1e-12 ) - 1.0 );
        return clamp( x, - ${ PI }, ${ PI } );

    }
`;

// azimuthal distribution of lobe p: around the exit angle Φ(p) = 2p γt − 2γo + pπ
const NP = wgslTagFn/* wgsl */`
    fn rindrHairNp( phi: f32, p: f32, s: f32, gammaO: f32, gammaT: f32 ) -> f32 {

        var dphi = phi - ( 2.0 * p * gammaT - 2.0 * gammaO + p * ${ PI } );
        dphi -= 2.0 * ${ PI } * round( dphi / ( 2.0 * ${ PI } ) );
        return ${ TRIMMED }( dphi, s );

    }
`;

// unpolarised Fresnel reflectance of a dielectric (η = inside / outside)
const FRESNEL = wgslTagFn/* wgsl */`
    fn rindrHairFresnel( cosThetaIn: f32, etaIn: f32 ) -> f32 {

        var cosI = clamp( cosThetaIn, - 1.0, 1.0 );
        var eta = etaIn;
        if ( cosI < 0.0 ) {

            eta = 1.0 / eta;
            cosI = - cosI;

        }
        let sin2T = ( 1.0 - cosI * cosI ) / ( eta * eta );
        if ( sin2T >= 1.0 ) {

            return 1.0;

        }
        let cosT = sqrt( max( 1.0 - sin2T, 0.0 ) );
        let rParallel = ( eta * cosI - cosT ) / ( eta * cosI + cosT );
        let rPerp = ( cosI - eta * cosT ) / ( cosI + eta * cosT );
        return 0.5 * ( rParallel * rParallel + rPerp * rPerp );

    }
`;

// everything that depends on the view only, packed: [0…3] per lobe the attenuation A (rgb) and its share for sampling
// (w); [4…7] per lobe the tilted sin θo, cos θo and the variance; [8] the logistic scale s, γo, γt, φo
const SETUP = wgslTagFn/* wgsl */`
    fn rindrHairSetup( wo: vec3f, h: f32, sigmaA: vec3f, betaM: f32, betaN: f32, alpha: f32, eta: f32 ) -> array<vec4f, 9> {

        var r: array<vec4f, 9>;
        let sinThetaO = clamp( wo.x, - 1.0, 1.0 );
        let cosThetaO = sqrt( max( 1.0 - sinThetaO * sinThetaO, 0.0 ) );
        let phiO = atan2( wo.z, wo.y );
        let gammaO = asin( clamp( h, - 1.0, 1.0 ) );
        // refracted ray: its longitudinal angle and its azimuthal offset (Bravais' modified index)
        let sinThetaT = sinThetaO / eta;
        let cosThetaT = sqrt( max( 1.0 - sinThetaT * sinThetaT, 0.0 ) );
        let etaP = sqrt( max( eta * eta - sinThetaO * sinThetaO, 0.0 ) ) / max( cosThetaO, 1e-6 );
        let sinGammaT = clamp( h / etaP, - 1.0, 1.0 );
        let cosGammaT = sqrt( max( 1.0 - sinGammaT * sinGammaT, 0.0 ) );
        let gammaT = asin( sinGammaT );
        let T = exp( - sigmaA * ( 2.0 * cosGammaT / max( cosThetaT, 1e-6 ) ) );
        // attenuation per lobe
        let f = ${ FRESNEL }( cosThetaO * sqrt( max( 1.0 - h * h, 0.0 ) ), eta );
        let a0 = vec3f( f );
        let a1 = ( 1.0 - f ) * ( 1.0 - f ) * T;
        let a2 = a1 * f * T;
        let a3 = a2 * f * T / max( vec3f( 1.0 ) - f * T, vec3f( 1e-6 ) );
        let y = vec4f( dot( a0, vec3f( 1.0 / 3.0 ) ), dot( a1, vec3f( 1.0 / 3.0 ) ), dot( a2, vec3f( 1.0 / 3.0 ) ), dot( a3, vec3f( 1.0 / 3.0 ) ) );
        let total = max( y.x + y.y + y.z + y.w, 1e-12 );
        r[ 0 ] = vec4f( a0, y.x / total );
        r[ 1 ] = vec4f( a1, y.y / total );
        r[ 2 ] = vec4f( a2, y.z / total );
        r[ 3 ] = vec4f( a3, y.w / total );
        // longitudinal variances (fit of Chiang et al.) and the azimuthal logistic scale
        let bm = clamp( betaM, 0.01, 1.0 );
        let bn = clamp( betaN, 0.01, 1.0 );
        let v0 = pow( 0.726 * bm + 0.812 * bm * bm + 3.7 * pow( bm, 20.0 ), 2.0 );
        let s = 0.626657069 * ( 0.265 * bn + 1.194 * bn * bn + 5.372 * pow( bn, 22.0 ) );
        // scale tilt: ±2α, α, 4α for R, TT, TRT
        let s0 = sin( alpha );
        let c0 = sqrt( max( 1.0 - s0 * s0, 0.0 ) );
        let s1 = 2.0 * c0 * s0;
        let c1 = c0 * c0 - s0 * s0;
        let s2 = 2.0 * c1 * s1;
        let c2 = c1 * c1 - s1 * s1;
        r[ 4 ] = vec4f( sinThetaO * c1 - cosThetaO * s1, abs( cosThetaO * c1 + sinThetaO * s1 ), v0, 0.0 );
        r[ 5 ] = vec4f( sinThetaO * c0 + cosThetaO * s0, abs( cosThetaO * c0 - sinThetaO * s0 ), 0.25 * v0, 0.0 );
        r[ 6 ] = vec4f( sinThetaO * c2 + cosThetaO * s2, abs( cosThetaO * c2 - sinThetaO * s2 ), 4.0 * v0, 0.0 );
        r[ 7 ] = vec4f( sinThetaO, cosThetaO, 4.0 * v0, 0.0 );
        r[ 8 ] = vec4f( s, gammaO, gammaT, phiO );
        return r;

    }
`;

// value (f · cos, rgb) and pdf (a) for wi
const EVAL = wgslTagFn/* wgsl */`
    fn rindrHairEvalSetup( r: array<vec4f, 9>, wi: vec3f ) -> vec4f {

        let sinThetaI = clamp( wi.x, - 1.0, 1.0 );
        let cosThetaI = sqrt( max( 1.0 - sinThetaI * sinThetaI, 0.0 ) );
        let misc = r[ 8 ];
        let phi = atan2( wi.z, wi.y ) - misc.w;
        var value = vec3f( 0.0 );
        var pdf = 0.0;
        for ( var p = 0; p < 3; p ++ ) {

            let t = r[ 4 + p ];
            let m = ${ MP }( cosThetaI, t.y, sinThetaI, t.x, t.z ) * ${ NP }( phi, f32( p ), misc.x, misc.y, misc.z );
            value += m * r[ p ].xyz;
            pdf += m * r[ p ].w;

        }
        let t3 = r[ 7 ];
        let m3 = ${ MP }( cosThetaI, t3.y, sinThetaI, t3.x, t3.z ) / ( 2.0 * ${ PI } );
        value += m3 * r[ 3 ].xyz;
        pdf += m3 * r[ 3 ].w;
        return vec4f( value, pdf );

    }
`;

const HAIR_EVAL = wgslTagFn/* wgsl */`
    fn rindrHairEval( wo: vec3f, wi: vec3f, h: f32, sigmaA: vec3f, betaM: f32, betaN: f32, alpha: f32, eta: f32 ) -> vec4f {

        return ${ EVAL }( ${ SETUP }( wo, h, sigmaA, betaM, betaN, alpha, eta ), wi );

    }
`;

// sampled direction (xyz, local) + pdf (w); value (rgb) in the second vector. uc picks the lobe (then reused for the
// azimuth), u for the longitudinal angle
const HAIR_SAMPLE = wgslTagFn/* wgsl */`
    fn rindrHairSample( wo: vec3f, h: f32, sigmaA: vec3f, betaM: f32, betaN: f32, alpha: f32, eta: f32, ucIn: f32, u: vec2f ) -> array<vec4f, 2> {

        let r = ${ SETUP }( wo, h, sigmaA, betaM, betaN, alpha, eta );
        // lobe by its share, uc remapped into it
        var uc = ucIn;
        var p = 3;
        for ( var k = 0; k < 3; k ++ ) {

            if ( uc < r[ k ].w ) {

                p = k;
                break;

            }
            uc -= r[ k ].w;

        }
        uc = clamp( uc / max( r[ p ].w, 1e-12 ), 0.0, 0.999999 );
        let t = r[ 4 + p ];
        let misc = r[ 8 ];
        // longitudinal angle from Mp
        let u0 = max( u.x, 1e-5 );
        let cosTheta = 1.0 + t.z * log( u0 + ( 1.0 - u0 ) * exp( - 2.0 / t.z ) );
        let sinTheta = sqrt( max( 1.0 - cosTheta * cosTheta, 0.0 ) );
        let cosPhi = cos( 2.0 * ${ PI } * u.y );
        let sinThetaI = clamp( - cosTheta * t.x + sinTheta * cosPhi * t.y, - 1.0, 1.0 );
        let cosThetaI = sqrt( max( 1.0 - sinThetaI * sinThetaI, 0.0 ) );
        // azimuth from Np (the rest: uniform)
        var dphi = 2.0 * ${ PI } * uc;
        if ( p < 3 ) {

            dphi = 2.0 * f32( p ) * misc.z - 2.0 * misc.y + f32( p ) * ${ PI } + ${ SAMPLE_TRIMMED }( uc, misc.x );

        }
        let phiI = misc.w + dphi;
        let wi = vec3f( sinThetaI, cosThetaI * cos( phiI ), cosThetaI * sin( phiI ) );
        let e = ${ EVAL }( r, wi );
        return array<vec4f, 2>( vec4f( wi, e.w ), vec4f( e.xyz, 0.0 ) );

    }
`;

// scale tilt of the cuticle: 2° (the usual value; pbrt's default)
export const HAIR_PT = { eval: HAIR_EVAL, sample: HAIR_SAMPLE, alpha: '0.0349066' };

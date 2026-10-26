// Guide buffers of the motion denoiser (motion-denoise.js) from the path tracer's own scene data: one ray per pixel
// with the path tracer's camera (perspective or fisheye – FISHEYE_RAY), the same BVH, transforms and material
// records (incl. textures, normal maps, per-object colours, stand-in materials). Raster guides (the first version)
// did not match the fisheye, nor what mirrors and glass show.
//
// Mirrors and clear glass (smooth metal / transmission): the ray follows the reflection / refraction to the first
// rough surface ("primary surface replacement") – the guides then describe what the pixel shows, not the glass or
// mirror itself: reflections and things behind glass keep their edges. Position = virtual position along the
// camera ray at the travelled distance (for a planar mirror the mirror image – it reprojects correctly), normal
// mirrored along, albedo × tint of the chain (metal colour, glass colour).
//
// Outputs (storage textures, rows top-down like the path tracer's output):
//   position: rgba32float – xyz world position, w = 1 surface / 0 background (incl. matte = shadow catcher)
//   normal:   rgba16float – xyz world normal (background: direction it is seen in), w = circle of confusion of the
//             first surface (pixels, depth of field)
//   albedo:   rgba16float – rgb reflectance of the surface (demodulation: textures stay sharp), a = 1
//
// Second use: the auxiliary buffers of the final denoiser (OIDN, `samples` > 0). The library rasterized them with the
// perspective camera – with fisheye they did not fit the image (OIDN kept the noise and drew ghost edges), nor with
// depth of field (sharp guides, blurred image) or mirrors/glass. Here `samples` rays per pixel with jittered pixel
// position and aperture (disc; like the path tracer's camera incl. fisheye focus), averaged – antialiased and
// defocused like the image (OIDN's guideline for the feature buffers). Then:
//   normal: rgb view-space normal mapped to [0, 1] (as oidn-web takes it; background: facing the camera), a = 1
//   albedo: rgb as above, background 1, a = 1
//   position: not written (stays 1 × 1)
//
// Third use (`aov`): the helper passes of a render with light passes (light-mix.js) – the first surface itself (no
// chain through mirrors/glass), `samples` rays per pixel like the OIDN guides:
//   position: x depth (as the depth of field measures it), y coverage (alpha: share of rays on a surface – background
//             and shadow catcher 0), z/w red and green of the material id colour
//   normal:   xyz world normal (mean over the rays on a surface), w blue of the material id colour
//   albedo:   rgb reflectance × coverage (premultiplied), a coverage
//   ids:      rgb object id colour, a coverage
// The id colours (idColor) are averaged over the rays like the image – edges antialiased and defocused (an id number
// cannot be averaged: from the first ray alone the edges were hard). A fourth storage texture only here (WebGPU
// guarantees 4 per shader stage).
// Gaussian splats (splat-volume.js: a density grid, no surface) – for the helper passes the ray marches the density
// between its hits: where half the light is gone (optical depth ln 2) counts as the surface – depth there, normal
// against the density gradient, the splats' colour as albedo, an id colour of their own (index 0). The other guides
// keep looking through the volume (the denoiser).
import { StorageTexture, FloatType, HalfFloatType, RGBAFormat, NearestFilter, Matrix4, Vector2 } from 'three/webgpu';
import { uniform, globalId, textureStore } from 'three/tsl';
import { proxy, proxyFn, wgslTagFn, rayStruct, ndcToCameraRay } from 'three-mesh-bvh/webgpu';
import { offsetRayOriginFunc } from 'three-gpu-pathtracer/src/webgpu/nodes/utils.wgsl.js';
import { FISHEYE_RAY } from './fisheye.js';
import { EDGE_WGSL } from './materials/edges.js';
import { WOOL_PT } from './materials/wool-pt.js';
import { SPLAT_PT } from './splat/splat-pt.js';

const S = SPLAT_PT;

// splat volume along a stretch of the ray (o + d·t, t < segment), optical depth `tau` so far: x = distance where it
// reaches ln 2 (−1: not on this stretch), y = optical depth at the end of the stretch. Steps of 1/256 of the box.
const splatMarch = wgslTagFn/* wgsl */`
    fn guideSplatMarch( o: vec3f, d: vec3f, segment: f32, tau: f32, jitter: f32 ) -> vec2f {

        let lo = ( ${ S.inverse } * vec4f( o, 1.0 ) ).xyz;
        let ld = ( ${ S.inverse } * vec4f( d, 0.0 ) ).xyz;
        let inv = 1.0 / ( ld + vec3f( 1e-12 ) );
        let a = ( vec3f( - 0.5 ) - lo ) * inv;
        let b = ( vec3f( 0.5 ) - lo ) * inv;
        let t0 = max( max( max( min( a.x, b.x ), min( a.y, b.y ) ), min( a.z, b.z ) ), 0.0 );
        let t1 = min( min( min( max( a.x, b.x ), max( a.y, b.y ) ), max( a.z, b.z ) ), segment );
        if ( t1 <= t0 ) {

            return vec2f( - 1.0, tau );

        }
        let n = clamp( u32( ceil( ( t1 - t0 ) * length( ld ) * 256.0 ) ), 1u, 1024u );
        let step = ( t1 - t0 ) / f32( n );
        var depth = tau;
        for ( var i = 0u; i < n; i ++ ) {

            let t = t0 + ( f32( i ) + jitter ) * step;
            depth += ${ S.density }( lo + ld * t ) * ${ S.sigma } * step;
            if ( depth >= 0.6931472 ) {

                return vec2f( t, depth );

            }

        }
        return vec2f( - 1.0, depth );

    }
`;

// world normal of the splats at a local point: against the density gradient (not normalized; 0 inside a flat region)
const splatNormal = wgslTagFn/* wgsl */`
    fn guideSplatNormal( lo: vec3f ) -> vec3f {

        let h = 1.0 / 160.0;
        let g = vec3f(
            ${ S.density }( lo + vec3f( h, 0.0, 0.0 ) ) - ${ S.density }( lo - vec3f( h, 0.0, 0.0 ) ),
            ${ S.density }( lo + vec3f( 0.0, h, 0.0 ) ) - ${ S.density }( lo - vec3f( 0.0, h, 0.0 ) ),
            ${ S.density }( lo + vec3f( 0.0, 0.0, h ) ) - ${ S.density }( lo - vec3f( 0.0, 0.0, h ) ) );
        let inv = ${ S.inverse };
        return - ( transpose( mat3x3f( inv[ 0 ].xyz, inv[ 1 ].xyz, inv[ 2 ].xyz ) ) * g );

    }
`;

// albedo of the splats: their colour, or the override material's like the volume walk (volume-walk.patch.wgsl)
const splatAlbedo = wgslTagFn/* wgsl */`
    fn guideSplatAlbedo( lo: vec3f ) -> vec3f {

        let c = ${ S.color }( lo );
        if ( ${ S.override } > 0.5 ) {

            return ${ S.tint } * pow( clamp( dot( c, vec3f( 0.2126, 0.7152, 0.0722 ) ) / max( ${ S.mean }, 1e-4 ), 0.0, 4.0 ), ${ S.detail } );

        }
        return c;

    }
`;

// 4 uniform random numbers per pixel (pcg4d, Jarzynski & Olano 2020) – rotation of the sample sequence
const guideRandom = wgslTagFn/* wgsl */`
    fn guideRandom( p: vec2u ) -> vec4f {

        var v = vec4u( p, p.x ^ p.y, p.x + p.y ) * 1664525u + 1013904223u;
        v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
        v ^= v >> vec4u( 16u );
        v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
        return vec4f( v ) / 4294967296.0;

    }
`;

// colour of an id (object or material index + 1): hue by the golden angle, bright and saturated
const idColor = wgslTagFn/* wgsl */`
    fn idColor( id: f32 ) -> vec3f {

        let h = fract( id * 0.618033988749895 ) * 6.0;
        let k = ( vec3f( 5.0, 3.0, 1.0 ) + h ) % 6.0;
        return 0.9 - 0.9 * 0.75 * clamp( min( k, 4.0 - k ), vec3f( 0.0 ), vec3f( 1.0 ) );

    }
`;

const storage = type => {
    const t = new StorageTexture(1, 1);
    t.type = type;
    t.format = RGBAFormat;
    t.generateMipmaps = false;
    t.minFilter = t.magFilter = NearestFilter;
    return t;
};

export class GuideKernel {
    /** @param {{ maxChain?: number, specularRoughness?: number, samples?: number, aov?: boolean }} options – samples > 0: OIDN
     *  guides, aov: helper passes (see above) */
    constructor({ maxChain = 4, specularRoughness = 0.1, samples = 0, aov = false } = {}) {
        this.samples = samples;
        this.aov = aov;
        if (aov) maxChain = 1;
        this.position = storage(FloatType);
        this.normal = storage(HalfFloatType);
        this.albedo = storage(HalfFloatType);
        this.position.name = 'Guide position';
        this.ids = storage(HalfFloatType);   // helper passes only (aov)
        this.ids.name = 'Guide ids';
        this.normal.name = 'Guide normal';
        this.albedo.name = 'Guide albedo';
        this._size = new Vector2();
        this._bvhData = null;

        const p = this.params = {
            bvhData: { value: null },
            globalIdBand: globalId,
            positionTarget: textureStore(this.position).toWriteOnly(),
            idsTarget: textureStore(this.ids).toWriteOnly(),
            normalTarget: textureStore(this.normal).toWriteOnly(),
            albedoTarget: textureStore(this.albedo).toWriteOnly(),
            size: uniform(new Vector2()),
            rowOffset: uniform(0, 'uint'),   // first row of this band (dispatches in bands, see update())
            invViewProj: uniform(new Matrix4()),
            cameraWorld: uniform(new Matrix4()),
            cocScale: uniform(0),           // aperture radius · focal length in pixels (0 = no depth of field)
            invFocus: uniform(0),           // 1 / focus distance
            maxChain: uniform(maxChain, 'uint'),
            specularRoughness: uniform(specularRoughness),
            samples: uniform(samples, 'uint'),
            viewMatrix: uniform(new Matrix4()),   // world → view (OIDN normals)
            aperture: uniform(new Vector2()),     // x radius (world units, 0 = sharp), y focus distance
            aov: uniform(aov ? 1 : 0, 'uint'),
        };
        const raycastOutput = proxy('bvhData.value.fns.raycastFirstHit.outputType', p);
        const raycastFirstHit = proxyFn('bvhData.value.fns.raycastFirstHit', p);
        const sampleTrianglePoint = proxyFn('bvhData.value.fns.sampleTrianglePoint', p);
        const getSurfaceRecord = proxyFn('bvhData.value.fns.getSurfaceRecord', p);

        // same vertex/surface setup as the megakernel (PathTracerMegaKernel.js)
        const shader = wgslTagFn/* wgsl */`
            fn compute( globalIdBand: vec3u, size: vec2u, rowOffset: u32, maxChain: u32, specularRoughness: f32, cocScale: f32, invFocus: f32, samples: u32, aov: u32 ) -> void {

                let globalId = vec3u( globalIdBand.x, globalIdBand.y + rowOffset, globalIdBand.z );
                if ( globalId.x >= size.x || globalId.y >= size.y ) {

                    return;

                }

                let transforms = &${ proxy('bvhData.value.storage.transforms', p) };
                let materials = &${ proxy('bvhData.value.storage.materials', p) };

                let camPos = ( ${ p.cameraWorld } * vec4f( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
                let forward = normalize( ( ${ p.cameraWorld } * vec4f( 0.0, 0.0, - 1.0, 0.0 ) ).xyz );
                let rotation = ${ guideRandom }( globalId.xy );
                var sumNormal = vec3f( 0.0 );
                var sumAlbedo = vec3f( 0.0 );
                let count = max( samples, 1u );
                // helper passes (aov)
                var sumCover = 0.0;
                var sumDepth = 0.0;
                var sumWorldNormal = vec3f( 0.0 );
                var sumCoverAlbedo = vec3f( 0.0 );
                var sumObject = vec3f( 0.0 );
                var sumMaterial = vec3f( 0.0 );

                for ( var s = 0u; s < count; s ++ ) {

                    // pixel centre (OIDN guides: a jittered point in the pixel, R2 sequence), ndc like the path tracer (row 0 = bottom)
                    var jitter = vec4f( 0.5 );
                    if ( samples > 0u ) {

                        jitter = fract( rotation + f32( s ) * vec4f( 0.7548776662, 0.5698402910, 0.6180339887, 0.4142135624 ) );

                    }
                    let uv = ( vec2f( globalId.xy ) + jitter.xy ) / vec2f( size );
                    let ndc = uv * 2.0 - vec2f( 1.0 );
                    var ray: ${ rayStruct };
                    let isFisheye = ${ FISHEYE_RAY }( ndc, ${ p.cameraWorld }, &ray );
                    if ( ! isFisheye ) {

                        ray = ${ ndcToCameraRay }( ndc, ${ p.invViewProj } );

                    }
                    ray.direction = normalize( ray.direction );

                    // depth of field (OIDN guides): a point on the aperture disc aimed through the focus – like the path
                    // tracer's camera (flat focal plane; fisheye: distance along the ray, aperture across the ray)
                    let apertureRadius = ${ p.aperture }.x;
                    if ( samples > 0u && apertureRadius > 0.0 ) {

                        let angle = 6.2831853 * jitter.z;
                        let lens = vec2f( cos( angle ), sin( angle ) ) * sqrt( jitter.w ) * apertureRadius;
                        let focusDistance = ${ p.aperture }.y;
                        if ( isFisheye ) {

                            let focus = ray.origin + ray.direction * focusDistance;
                            let up = normalize( ( ${ p.cameraWorld } * vec4f( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
                            let helper = select( up, normalize( ( ${ p.cameraWorld } * vec4f( 1.0, 0.0, 0.0, 0.0 ) ).xyz ), abs( dot( up, ray.direction ) ) > 0.99 );
                            let axisX = normalize( cross( ray.direction, helper ) );
                            let axisY = cross( axisX, ray.direction );
                            ray.origin += axisX * lens.x + axisY * lens.y;
                            ray.direction = normalize( focus - ray.origin );

                        } else {

                            let focalPoint = camPos + ray.direction * ( focusDistance / dot( ray.direction, forward ) );
                            let nearDistance = dot( ray.origin - camPos, forward );
                            ray.origin = camPos + ( ${ p.cameraWorld } * vec4f( lens, 0.0, 0.0 ) ).xyz;
                            ray.direction = normalize( focalPoint - ray.origin );
                            ray.origin += ray.direction * ( nearDistance / dot( ray.direction, forward ) );

                        }

                    }

                    let primaryDir = ray.direction;
                    var travelled = length( ray.origin - camPos );   // perspective rays start on the near plane
                    var mirror = mat3x3f( 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0 );
                    var tint = vec3f( 1.0 );
                    var position = vec4f( 0.0 );
                    var normal = vec4f( 0.0 );
                    var albedo = vec4f( 1.0 );
                    var firstDepth = - 1.0;
                    var surfaceDepth = 0.0;
                    var ids = vec2f( 0.0 );   // object, material index + 1 (0: the splats)
                    var chain = 0u;
                    var splatTau = 0.0;       // helper passes: optical depth of the splats so far

                    for ( var i = 0u; i < 16u; i ++ ) {

                        var hit: ${ raycastOutput };
                        if ( ! ${ raycastFirstHit }( ray, &hit ) ) {

                            break;

                        }

                        // helper passes: the splats up to this hit – half the light gone = their surface
                        if ( aov != 0u && ${ S.active } > 0.5 ) {

                            let march = ${ splatMarch }( ray.origin, ray.direction, hit.dist, splatTau, jitter.w );
                            splatTau = march.y;
                            if ( march.x >= 0.0 ) {

                                let sp = ray.origin + ray.direction * march.x;
                                let lo = ( ${ S.inverse } * vec4f( sp, 1.0 ) ).xyz;
                                var sn = ${ splatNormal }( lo );
                                sn = select( - ray.direction, normalize( sn ), dot( sn, sn ) > 1e-12 );
                                sn = select( sn, - sn, dot( sn, ray.direction ) > 0.0 );   // facing the camera
                                travelled += march.x;
                                position = vec4f( sp, 1.0 );
                                normal = vec4f( sn, 0.0 );
                                albedo = vec4f( ${ splatAlbedo }( lo ), 1.0 );
                                surfaceDepth = select( dot( sp - camPos, forward ), travelled, isFisheye );
                                if ( firstDepth < 0.0 ) {

                                    firstDepth = surfaceDepth;

                                }
                                break;

                            }

                        }

                        travelled += hit.dist;
                        let objectInfo = transforms[ hit.objectIndex ];
                        var materialInfo = ( *materials )[ objectInfo.materialIndex ];

                        // matte (shadow catcher) seen directly: the path tracer shows the background there
                        if ( materialInfo.matte != 0 && chain == 0u ) {

                            break;

                        }

                        // cloud volume box (clouds.js) / splat volume (splat-volume.js): no surface – the guides show what
                        // lies behind (the box's faces made the denoiser draw a bright rectangle)
                        if ( materialInfo.fogVolume == 3 || materialInfo.fogVolume == 6 ) {

                            ray.origin = ${ offsetRayOriginFunc }( ray.origin + ray.direction * hit.dist, ray.direction, hit.normal );
                            continue;

                        }

                        materialInfo.color *= objectInfo.color.rgb;
                        materialInfo.opacity *= objectInfo.color.a;

                        var vertexData = ${ sampleTrianglePoint }( hit.barycoord, hit.indices.xyz );
                        // rounded edges (edges.js): the same bent normal as the megakernel (rindr-edges)
                        if ( materialInfo.anisotropyRotation != 0.0 && materialInfo.anisotropy == 0.0 ) {

                            let edScale = ( length( objectInfo.matrixWorld[ 0 ].xyz ) + length( objectInfo.matrixWorld[ 1 ].xyz ) + length( objectInfo.matrixWorld[ 2 ].xyz ) ) / 3.0;
                            vertexData.normal = vec4f( ${ EDGE_WGSL }( vertexData.position.xyz, vertexData.normal.xyz, hit.indices.x - objectInfo._alignment1, objectInfo._alignment0, materialInfo.anisotropyRotation / max( edScale, 1e-30 ) ), 0.0 );
                            materialInfo.anisotropyRotation = 0.0;

                        }
                        vertexData.normal = normalize( transpose( objectInfo.inverseMatrixWorld ) * vertexData.normal );
                        vertexData.tangent = vec4f( ( objectInfo.matrixWorld * vec4f( vertexData.tangent.xyz, 0.0 ) ).xyz, vertexData.tangent.w );
                        vertexData.position = objectInfo.matrixWorld * vertexData.position;
                        // wool (wool-pt.js): fibre hits at the fibre, coloured like the path tracer shades them – the
                        // denoiser keeps the fibres (with the surface's normal and colour it smeared them)
                        if ( materialInfo.fogVolume == 4 ) {

                            let woolHit = ray.origin + ray.direction * hit.dist;
                            let woolShade = ${ WOOL_PT.shade }( woolHit, vertexData.position.xyz, objectInfo.inverseMatrixWorld, ray.direction, max( materialInfo.iridescenceThicknessMinimum, 1e-9 ) );
                            if ( woolShade.x > 0.0 ) {

                                vertexData.position = vec4f( woolHit, 1.0 );
                                vertexData.normal = vec4f( hit.normal, 0.0 );

                            }
                            materialInfo.color *= woolShade.y;

                        }
                        let surface = ${ getSurfaceRecord }( materialInfo, vertexData, hit.side, hit.normal, - ray.direction, 0.0 );

                        if ( firstDepth < 0.0 ) {

                            // depth of field: along the view direction (perspective), along the ray (fisheye: spherical focus)
                            firstDepth = select( dot( vertexData.position.xyz - camPos, forward ), travelled, isFisheye );

                        }

                        // mostly see-through (alpha): what lies behind is what the pixel shows
                        if ( surface.opacity < 0.5 ) {

                            ray.origin = ${ offsetRayOriginFunc }( vertexData.position.xyz, ray.direction, hit.normal );
                            continue;

                        }

                        // smooth mirror or clear glass: follow the ray
                        let smoothSurface = surface.roughness < specularRoughness;
                        let isMirror = smoothSurface && surface.metalness > 0.9;
                        let isGlass = smoothSurface && surface.transmission > 0.9;
                        if ( ( isMirror || isGlass ) && chain + 1u < maxChain ) {

                            chain ++;
                            tint *= surface.color;
                            let n = surface.normal;
                            if ( isMirror ) {

                                // vectors after the reflection → mirror space: Householder matrix I − 2·n·nᵀ
                                mirror = mirror * ( mat3x3f( 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0 ) - 2.0 * mat3x3f( n * n.x, n * n.y, n * n.z ) );
                                ray.direction = reflect( ray.direction, n );

                            } else if ( ! surface.thinWall ) {

                                let refracted = refract( ray.direction, n, surface.eta );
                                ray.direction = select( reflect( ray.direction, n ), normalize( refracted ), dot( refracted, refracted ) > 0.0 );

                            }
                            ray.origin = ${ offsetRayOriginFunc }( vertexData.position.xyz, ray.direction, hit.normal );
                            continue;

                        }

                        position = vec4f( camPos + primaryDir * travelled, 1.0 );
                        normal = vec4f( normalize( mirror * surface.normal ), 0.0 );
                        albedo = vec4f( tint * surface.color, 1.0 );
                        surfaceDepth = select( dot( vertexData.position.xyz - camPos, forward ), travelled, isFisheye );
                        ids = vec2f( f32( hit.objectIndex ), f32( objectInfo.materialIndex ) ) + 1.0;
                        break;

                    }

                    // background – seen directly or in a mirror / through glass: the direction it is seen in (the filter
                    // only mixes background with background of a similar direction – a chrome part's reflection does not
                    // blur into the backdrop next to it, curved reflections keep their detail)
                    if ( position.w == 0.0 ) {

                        normal = vec4f( ray.direction, 0.0 );

                    }

                    // circle of confusion of the first surface in pixels (background: at infinity)
                    normal.w = select( cocScale * invFocus, cocScale * abs( invFocus - 1.0 / max( firstDepth, 1e-6 ) ), firstDepth > 0.0 );

                    // OIDN guides: view space, background facing the camera
                    let guideNormal = select( normal.xyz, - ray.direction, position.w == 0.0 );
                    sumNormal += ( ${ p.viewMatrix } * vec4f( guideNormal, 0.0 ) ).xyz;
                    sumAlbedo += albedo.rgb;
                    sumCover += position.w;
                    sumDepth += surfaceDepth * position.w;
                    sumWorldNormal += normal.xyz * position.w;
                    sumCoverAlbedo += albedo.rgb * position.w;
                    if ( aov != 0u && position.w > 0.0 ) {

                        sumObject += ${ idColor }( ids.x );
                        sumMaterial += ${ idColor }( ids.y );

                    }

                    if ( samples == 0u ) {

                        let texel = vec2u( globalId.x, size.y - 1u - globalId.y );
                        textureStore( ${ p.positionTarget }, texel, position );
                        textureStore( ${ p.normalTarget }, texel, normal );
                        textureStore( ${ p.albedoTarget }, texel, albedo );
                        return;

                    }

                }

                let texel = vec2u( globalId.x, size.y - 1u - globalId.y );
                if ( aov != 0u ) {

                    let cover = sumCover / f32( count );
                    let onSurface = max( sumCover, 1e-6 );
                    let material = sumMaterial / f32( count );
                    textureStore( ${ p.positionTarget }, texel, vec4f( sumDepth / onSurface, cover, material.rg ) );
                    textureStore( ${ p.normalTarget }, texel, vec4f( sumWorldNormal / onSurface, material.b ) );
                    textureStore( ${ p.albedoTarget }, texel, vec4f( sumCoverAlbedo / f32( count ), cover ) );
                    textureStore( ${ p.idsTarget }, texel, vec4f( sumObject / f32( count ), cover ) );
                    return;

                }
                // averaged (not normalized – OIDN takes averaged normals as they are)
                textureStore( ${ p.normalTarget }, texel, vec4f( sumNormal / f32( count ) * 0.5 + 0.5, 1.0 ) );
                textureStore( ${ p.albedoTarget }, texel, vec4f( min( sumAlbedo / f32( count ), vec3f( 1.0 ) ), 1.0 ) );

            }
        `;
        this._fn = shader(p);
        this.kernel = null;
    }

    /** Shader source changes (new scene data): build a new compute node */
    _build() {
        const node = this._fn.context({});
        node.parameters = this._fn.parameters;
        this.kernel = node.computeKernel([8, 8, 1]);
    }

    /**
     * Trace the guides of the whole image: in bands of at most `bandPixels` – one dispatch over a 4K image of a large
     * scene (rays through mirrors/glass) could take longer than the GPU watchdog allows (Windows TDR ~2 s:
     * DXGI_ERROR_DEVICE_HUNG, the WebGPU device is lost). Each band is its own dispatch.
     */
    trace(renderer, bvhData, width, height, camera, bandPixels = 262_144) {
        const { kernel } = this.update(bvhData, width, height, camera);
        bandPixels /= Math.max(this.samples / 4, 1);   // OIDN guides: several rays per pixel (cheap first hits)
        const rows = Math.max(8, Math.floor(bandPixels / Math.max(width, 1) / 8) * 8);
        for (let y = 0; y < height; y += rows) {
            this.params.rowOffset.value = y;
            renderer.compute(kernel, [Math.ceil(width / 8), Math.ceil(Math.min(rows, height - y) / 8), 1]);
        }
    }

    /**
     * Prepare the kernel for the path tracer's current scene data + size + camera. Returns the compute node to
     * dispatch and its dispatch size (one band from row 0 – trace() covers the whole image).
     * @param {object} bvhData path tracer scene data (megakernel's bvhData)
     */
    update(bvhData, width, height, camera) {
        const p = this.params;
        // new scene data, or its ray test built anew (kernel features: wool added or removed – pathtracer.js)
        if (bvhData !== this._bvhData || bvhData.fns.raycastFirstHit !== this._raycast) {
            this._bvhData = bvhData;
            this._raycast = bvhData.fns.raycastFirstHit;
            p.bvhData.value = bvhData;
            this._build();
        }
        if (this._size.x !== width || this._size.y !== height) {
            this._size.set(width, height);
            for (const key of this.aov ? ['position', 'normal', 'albedo', 'ids'] : this.samples ? ['normal', 'albedo'] : ['position', 'normal', 'albedo']) {
                const old = this[key];
                const t = this[key] = old.clone();
                old.dispose();
                t.setSize(width, height);
                p[`${key}Target`].value = t;
            }
        }
        p.size.value.set(width, height);
        camera.updateMatrixWorld();
        p.invViewProj.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
        p.cameraWorld.value.copy(camera.matrixWorld);
        // depth of field (PhysicalCamera: aperture radius bokehSize · 0.5e-3, as in the library's camera shim)
        const radius = (camera.bokehSize ?? 0) * 0.5e-3;
        const focalPx = height / 2 / Math.tan((camera.fov ?? 50) * Math.PI / 360);
        p.cocScale.value = radius > 0 && camera.focusDistance > 0 ? radius * focalPx : 0;
        p.invFocus.value = camera.focusDistance > 0 ? 1 / camera.focusDistance : 0;
        p.viewMatrix.value.copy(camera.matrixWorldInverse);
        p.aperture.value.set(camera.focusDistance > 0 ? radius : 0, camera.focusDistance || 1);
        this.params.rowOffset.value = 0;
        return { kernel: this.kernel, dispatch: [Math.ceil(width / 8), Math.ceil(Math.min(height, 64) / 8), 1] };
    }

    dispose() {
        this.position.dispose();
        this.ids.dispose();
        this.normal.dispose();
        this.albedo.dispose();
    }
}

// Photon pass of the caustics (caustics.js): one photon per invocation from a light source – the directional lamps, the
// HDRI's sun (findSun) and the local lamps (point, spot, IES) – aimed at the glass objects' bounding sphere (directional:
// parallel rays from a disc across it, the sun's spread over its disc; local: from the lamp's position into the cone
// around the sphere, weighted by the spot's cone or the IES profile – no photon wasted on the open floor), traced
// through the glass with the path tracer's scene
// data (BVH, transforms, material records incl. textures – like pt-guides.js) and deposited into the hash grid where it
// lands on another surface after passing glass.
//
// At glass (transmission > ½): smooth dielectric with the surface record's IOR (per wavelength with dispersion: a
// uniformly sampled wavelength per photon, colour weight of the library – rainbow edges), Fresnel picks reflection or
// refraction, total internal reflection reflects; rough glass tilts the normal by roughness²; colour on entry,
// absorption over the distance inside (attenuation colour/distance) on exit; thin walls pass straight (× colour).
// Anything else ends the photon: after at least one glass face it is deposited – flux as fixed point (× FIXED) into the
// cell's slot (key claimed by compare-exchange, linear probing, CAUSTICS_PROBES slots; a full table drops the photon).
import { Vector3, Vector4, Matrix3, Matrix4, Quaternion, StorageBufferAttribute, Box3, Sphere, DataUtils, HalfFloatType } from 'three/webgpu';
import { uniform, globalId, storage } from 'three/tsl';
import { proxy, proxyFn, wgslTagFn, rayStruct } from 'three-mesh-bvh/webgpu';
import { offsetRayOriginFunc } from 'three-gpu-pathtracer/src/webgpu/nodes/utils.wgsl.js';
import { applyDispersionFunc, dispersionColorWeightFunc, transmissionAttenuationFunc, DISPERSION_MIN_WAVELENGTH, DISPERSION_MAX_WAVELENGTH } from 'three-gpu-pathtracer/src/webgpu/nodes/material.wgsl.js';
import { CAUSTICS, CAUSTICS_HASH, CAUSTICS_PROBES } from './caustics.js';

const FIXED = 32;          // grid units per photon of weight 1 (stochastic rounding – a cell overflows after ~1e8 photons)
const WORKGROUP = 64;
const MAX_SOURCES = 16;    // lamps + the sun (more lamps: the dimmest ones get no photons)
const SOURCE_VEC4 = 5;     // vec4 per source (see prepare)
// IES profiles of the sources as tables: 180 angles from the axis (0…180°, like the profile textures' columns) × 72
// directions around it (5° steps, −180…180° like their rows; one row repeated for symmetric profiles)
const PROFILE_THETA = 180, PROFILE_PHI = 72;
const SOURCE_KIND = { directional: 0, point: 1, spot: 2, ies: 3 };
const luminance = c => 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;

// pcg hash → uniform [0, 1)
const random = wgslTagFn/* wgsl */`
    fn causticRandom( state: ptr<function, u32> ) -> f32 {

        *state = *state * 747796405u + 2891336453u;
        var w = ( ( *state >> ( ( *state >> 28u ) + 4u ) ) ^ *state ) * 277803737u;
        w = ( w >> 22u ) ^ w;
        return f32( w >> 8u ) / 16777216.0;

    }
`;

// half float → float (table: the HDRI is scanned once per map)
let halfTable = null;
const halfToFloat = () => halfTable ??= Float32Array.from({ length: 65536 }, (_, i) => DataUtils.fromHalfFloat(i));
const UP = new Vector3(0, 1, 0);

/**
 * An IES lamp's profile texture (x: angle from the axis over its width, y: around it over its rows, red channel – half
 * or full float) → the photon kernel's table at `offset`: PROFILE_PHI rows of PROFILE_THETA values, sampled bilinearly
 * where the path tracer samples the texture (column x ↔ x / (width − 1) · 180°, row y ↔ y / height · 360° − 180°).
 */
function profileTable(texture, out, offset) {
    const { data, width, height } = texture.image;
    const half = texture.type === HalfFloatType || data instanceof Uint16Array;
    const table = half ? halfToFloat() : null;
    const channels = Math.max(1, Math.round(data.length / (width * height)));
    const at = (x, y) => { const v = data[(y * width + x) * channels]; return half ? table[v] : v; };
    for (let p = 0; p < PROFILE_PHI; p++) {
        const y = p / PROFILE_PHI * height, y0 = Math.floor(y) % height, y1 = (y0 + 1) % height, fy = y - Math.floor(y);
        for (let t = 0; t < PROFILE_THETA; t++) {
            const x = t / (PROFILE_THETA - 1) * (width - 1), x0 = Math.floor(x), x1 = Math.min(x0 + 1, width - 1), fx = x - x0;
            const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx, bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
            out[offset + p * PROFILE_THETA + t] = Math.max(0, top * (1 - fy) + bottom * fy);
        }
    }
}

/**
 * The sun of an HDRI (the path tracer's preprocessed map: half float RGBA, rows bottom-up) – a small, very bright spot:
 * peak ≥ 50 × the mean radiance, all pixels above the threshold (2 % of the peak, ≥ 20 × the mean) within 9° of the
 * peak, and ≥ 2 % of the environment's light. Softboxes / studio pins are larger → no sun (they keep the transparent
 * glass shadow). Returns the direction in map space (unrotated), its irradiance (Σ radiance × solid angle over the
 * cone, rgb, intensity 1), the cone (cos; it decides which environment samples the photons replace) and the angular
 * radius of the disc (photons spread over it – soft caustics like a real sun), or null.
 */
export function findSun(map) {
    const { width: w, height: h, data } = map?.image ?? {};
    if (!(data instanceof Uint16Array) || w < 8 || h < 4) return null;
    const half = halfToFloat();
    const lum = i => 0.2126 * half[data[i]] + 0.7152 * half[data[i + 1]] + 0.0722 * half[data[i + 2]];
    // row y: uv.y = (y + ½) / h, polar angle π (1 − uv.y) (equirectUvToDirection of the library)
    const polar = y => Math.PI * (1 - (y + 0.5) / h);
    const direction = (x, y, out) => {
        const theta = ((x + 0.5) / w - 0.5) * 2 * Math.PI, phi = polar(y), sp = Math.sin(phi);
        return out.set(sp * Math.cos(theta), Math.cos(phi), sp * Math.sin(theta));
    };
    let peak = 0, peakIndex = 0, sum = 0, area = 0;
    for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
            const l = lum(i);
            row += l;
            if (l > peak) { peak = l; peakIndex = y * w + x; }
        }
        const sp = Math.sin(polar(y));
        sum += row * sp;
        area += w * sp;
    }
    const mean = sum / area;
    if (!(peak > 50 * mean)) return null;
    const p = direction(peakIndex % w, Math.floor(peakIndex / w), new Vector3());
    const threshold = Math.max(peak * 0.02, mean * 20);
    const band = 10 * Math.PI / 180, cosBand = Math.cos(band), phiP = polar(Math.floor(peakIndex / w));
    const y0 = Math.max(0, Math.floor(h * (1 - (phiP + band) / Math.PI) - 1)), y1 = Math.min(h - 1, Math.ceil(h * (1 - (phiP - band) / Math.PI)));
    const dOmega = (2 * Math.PI / w) * (Math.PI / h);
    const d = new Vector3();
    const each = fn => {
        for (let y = y0; y <= y1; y++) {
            const solid = dOmega * Math.sin(polar(y));
            for (let x = 0; x < w; x++) {
                const c = direction(x, y, d).dot(p);
                if (c >= cosBand) fn((y * w + x) * 4, Math.acos(Math.min(c, 1)), solid);
            }
        }
    };
    let extent = 0;
    each((i, angle) => { if (lum(i) > threshold) extent = Math.max(extent, angle); });
    if (extent > 9 * Math.PI / 180) return null;
    const pixel = Math.PI / h;
    const cone = Math.max(extent + 1.5 * pixel, 0.25 * Math.PI / 180);
    const e = new Vector3(), centre = new Vector3();
    let flux = 0, moment = 0;
    each((i, angle, solid) => {
        if (angle > cone) return;
        const l = lum(i) * solid;
        e.x += half[data[i]] * solid; e.y += half[data[i + 1]] * solid; e.z += half[data[i + 2]] * solid;
        centre.addScaledVector(d, l);
        flux += l;
        moment += l * angle * angle;
    });
    if (!(flux > 0.02 * sum * dOmega)) return null;
    // uniform disc of radius ρ: mean squared angle ρ² / 2
    return { dir: centre.normalize(), e, cos: Math.cos(cone), radius: Math.min(Math.sqrt(2 * moment / flux), cone) };
}

export class CausticsKernel {
    constructor({ hashBits = 21, occupancy = 0.3, batch = 262144, minBatch = 65536, maxBatch = 4e6 } = {}) {
        this.slots = 2 ** hashBits;
        this.occupancy = occupancy;
        this._batchRange = [minBatch, maxBatch];
        this.buffer = new StorageBufferAttribute(new Uint32Array(this.slots * 4), 1);
        this.photons = 0;      // photons emitted since the last clear
        this.batch = batch;    // photons per dispatch (adapt: by its GPU time)
        this.signature = '';
        this._bvhData = null;
        this._kernel = null;
        this._clearKernel = null;
        this._sunMap = null;   // HDRI data the sun was searched in (findSun once per map – the library works on clones)
        this._sun = null;
        this.ready = false;    // pipelines compiled

        // light sources: SOURCE_VEC4 vec4 per source (see prepare); IES tables per source
        this._sources = new StorageBufferAttribute(new Float32Array(MAX_SOURCES * SOURCE_VEC4 * 4), 4);
        this._profiles = new StorageBufferAttribute(new Float32Array(MAX_SOURCES * PROFILE_THETA * PROFILE_PHI), 1);
        const p = this.params = {
            bvhData: { value: null },
            globalId,
            count: uniform(0, 'uint'),
            seed: uniform(0, 'uint'),
            sourceCount: uniform(0, 'uint'),
            sphere: uniform(new Vector4()),    // glass bounds: centre, radius
        };
        const sources = storage(this._sources, 'vec4', MAX_SOURCES * SOURCE_VEC4).toReadOnly();
        const profiles = storage(this._profiles, 'float', MAX_SOURCES * PROFILE_THETA * PROFILE_PHI).toReadOnly();
        const V = SOURCE_VEC4;
        // emission of a local lamp towards `d` (unit, away from the lamp) relative to its intensity: 1 (point), the
        // spot's cone (smoothstep like the path tracer), the IES table (angles in the path tracer's frame: tilt from the
        // axis, twist from atan2 of the direction to the lamp along v and u)
        const emission = wgslTagFn/* wgsl */`
            fn causticEmission( source: u32, d: vec3f ) -> f32 {

                let axis = ${ sources }[ source * ${ V }u + 2u ];
                let su = ${ sources }[ source * ${ V }u + 3u ];
                let sv = ${ sources }[ source * ${ V }u + 4u ];
                let kind = u32( axis.w );
                let cosT = dot( d, axis.xyz );
                if ( kind == ${ SOURCE_KIND.spot }u ) {

                    return smoothstep( su.w, sv.w, cosT );

                }
                if ( kind != ${ SOURCE_KIND.ies }u ) {

                    return 1.0;

                }
                let x = acos( clamp( cosT, - 1.0, 1.0 ) ) / 3.14159265 * ${ PROFILE_THETA - 1 }.0;
                let y = ( atan2( dot( - d, sv.xyz ), dot( - d, su.xyz ) ) + 3.14159265 ) / 6.28318531 * ${ PROFILE_PHI }.0;
                let x0 = u32( floor( x ) );
                let x1 = min( x0 + 1u, ${ PROFILE_THETA - 1 }u );
                let y0 = u32( floor( y ) ) % ${ PROFILE_PHI }u;
                let y1 = ( y0 + 1u ) % ${ PROFILE_PHI }u;
                let fx = fract( x );
                let fy = fract( y );
                let base = source * ${ PROFILE_THETA * PROFILE_PHI }u;
                let a = mix( ${ profiles }[ base + y0 * ${ PROFILE_THETA }u + x0 ], ${ profiles }[ base + y0 * ${ PROFILE_THETA }u + x1 ], fx );
                let b = mix( ${ profiles }[ base + y1 * ${ PROFILE_THETA }u + x0 ], ${ profiles }[ base + y1 * ${ PROFILE_THETA }u + x1 ], fx );
                return mix( a, b, fy );

            }
        `;
        const grid = storage(this.buffer, 'uint', this.slots * 4).toAtomic();
        const raycastOutput = proxy('bvhData.value.fns.raycastFirstHit.outputType', p);
        const raycastFirstHit = proxyFn('bvhData.value.fns.raycastFirstHit', p);
        const sampleTrianglePoint = proxyFn('bvhData.value.fns.sampleTrianglePoint', p);
        const getSurfaceRecord = proxyFn('bvhData.value.fns.getSurfaceRecord', p);

        const shader = wgslTagFn/* wgsl */`
            fn compute( globalId: vec3u, count: u32, seed: u32, sourceCount: u32 ) -> void {

                if ( globalId.x >= count || sourceCount == 0u ) {

                    return;

                }
                let transforms = &${ proxy('bvhData.value.storage.transforms', p) };
                let materials = &${ proxy('bvhData.value.storage.materials', p) };
                var rng = ( globalId.x * 1973u ) ^ ( seed * 9277u + 26699u );
                _ = ${ random }( &rng );

                // source by its share (cdf), direction spread over its disc, point on the disc across the glass bounds
                let pick = ${ random }( &rng );
                var source = 0u;
                for ( var i = 0u; i + 1u < sourceCount; i ++ ) {

                    if ( pick < ${ sources }[ i * ${ V }u + 1u ].w ) {

                        break;

                    }
                    source = i + 1u;

                }
                let lightDir = ${ sources }[ source * ${ V }u ];
                var throughput = ${ sources }[ source * ${ V }u + 1u ].xyz;
                let kind = u32( ${ sources }[ source * ${ V }u + 2u ].w );
                let sphere = ${ p.sphere };
                var ray: ${ rayStruct };
                ray.maxDist = 0.0;
                if ( kind == ${ SOURCE_KIND.directional }u ) {

                    let helper = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( lightDir.y ) > 0.9 );
                    var toLight = lightDir.xyz;
                    if ( lightDir.w > 0.0 ) {

                        let sx = normalize( cross( helper, toLight ) );
                        let sy = cross( toLight, sx );
                        let sr = sqrt( ${ random }( &rng ) ) * lightDir.w;
                        let sa = 6.283185307 * ${ random }( &rng );
                        toLight = normalize( toLight + ( sx * cos( sa ) + sy * sin( sa ) ) * sr );

                    }
                    let tx = normalize( cross( helper, toLight ) );
                    let ty = cross( toLight, tx );
                    let r = sqrt( ${ random }( &rng ) ) * sphere.w;
                    let phi = 6.283185307 * ${ random }( &rng );
                    ray.origin = sphere.xyz + toLight * ( 2.0 * sphere.w ) + ( tx * cos( phi ) + ty * sin( phi ) ) * r;
                    ray.direction = - toLight;

                } else {

                    // local lamp: uniform over the cone around the glass bounds (cos of its half angle in w; −1 = the
                    // lamp is inside them: the whole sphere of directions) – the weight carries the cone's solid angle
                    let toSphere = sphere.xyz - lightDir.xyz;
                    let dist = length( toSphere );
                    let axis = select( vec3f( 0.0, - 1.0, 0.0 ), toSphere / dist, dist > 0.0 );
                    let helper = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( axis.y ) > 0.9 );
                    let tx = normalize( cross( helper, axis ) );
                    let ty = cross( axis, tx );
                    let cosT = 1.0 - ${ random }( &rng ) * ( 1.0 - lightDir.w );
                    let sinT = sqrt( max( 0.0, 1.0 - cosT * cosT ) );
                    let phi = 6.283185307 * ${ random }( &rng );
                    let d = normalize( axis * cosT + ( tx * cos( phi ) + ty * sin( phi ) ) * sinT );
                    throughput *= ${ emission }( source, d );
                    if ( max( max( throughput.r, throughput.g ), throughput.b ) <= 0.0 ) {

                        return;

                    }
                    ray.origin = lightDir.xyz;
                    ray.direction = d;

                }

                let wavelength = mix( ${ DISPERSION_MIN_WAVELENGTH }.0, ${ DISPERSION_MAX_WAVELENGTH }.0, ${ random }( &rng ) );
                var dispersed = false;
                var glassFaces = 0u;

                for ( var bounce = 0u; bounce < 16u; bounce ++ ) {

                    var hit: ${ raycastOutput };
                    if ( ! ${ raycastFirstHit }( ray, &hit ) ) {

                        break;

                    }
                    let objectInfo = transforms[ hit.objectIndex ];
                    var materialInfo = ( *materials )[ objectInfo.materialIndex ];
                    var vertexData = ${ sampleTrianglePoint }( hit.barycoord, hit.indices.xyz );
                    vertexData.normal = normalize( transpose( objectInfo.inverseMatrixWorld ) * vertexData.normal );
                    vertexData.tangent = vec4f( ( objectInfo.matrixWorld * vec4f( vertexData.tangent.xyz, 0.0 ) ).xyz, vertexData.tangent.w );
                    vertexData.position = objectInfo.matrixWorld * vertexData.position;
                    let position = vertexData.position.xyz;

                    // volumes (clouds, splats): their box is stepped over
                    if ( materialInfo.fogVolume == 3 || materialInfo.fogVolume == 6 ) {

                        ray.origin = ${ offsetRayOriginFunc }( position, ray.direction, hit.normal );
                        continue;

                    }
                    materialInfo.color *= objectInfo.color.rgb;
                    materialInfo.opacity *= objectInfo.color.a;
                    var surface = ${ getSurfaceRecord }( materialInfo, vertexData, hit.side, hit.normal, - ray.direction, 0.0 );
                    if ( ${ random }( &rng ) > surface.opacity ) {

                        ray.origin = ${ offsetRayOriginFunc }( position, ray.direction, hit.normal );
                        continue;

                    }

                    if ( materialInfo.matte != 0 || surface.transmission <= 0.5 ) {

                        // landed after glass → into the cell of this point and side (hit.normal faces the photon)
                        if ( glassFaces > 0u ) {

                            let hk = ${ CAUSTICS_HASH }( position, hit.normal );
                            let fx = throughput * ${ FIXED }.0 + vec3f( ${ random }( &rng ), ${ random }( &rng ), ${ random }( &rng ) );
                            let q = vec3u( min( fx, vec3f( 65536.0 ) ) );
                            let mask = ${ CAUSTICS.mask };
                            for ( var i = 0u; i < ${ CAUSTICS_PROBES }u; i ++ ) {

                                let e = ( ( hk.x + i ) & mask ) * 4u;
                                var key = atomicLoad( &${ grid }[ e ] );
                                // empty: claim it (a spurious failure of the weak exchange is tried again – an empty
                                // slot left in the chain would end the lookups before this key)
                                for ( var t = 0u; key == 0u && t < 8u; t ++ ) {

                                    let x = atomicCompareExchangeWeak( &${ grid }[ e ], 0u, hk.y );
                                    key = select( x.old_value, hk.y, x.exchanged );

                                }
                                if ( key == hk.y ) {

                                    if ( q.r > 0u ) { atomicAdd( &${ grid }[ e + 1u ], q.r ); }
                                    if ( q.g > 0u ) { atomicAdd( &${ grid }[ e + 2u ], q.g ); }
                                    if ( q.b > 0u ) { atomicAdd( &${ grid }[ e + 3u ], q.b ); }
                                    break;

                                }

                            }

                        }
                        break;

                    }

                    // glass
                    glassFaces ++;
                    if ( materialInfo.dispersion > 0.0 && surface.ior > 1.0 && ! surface.thinWall ) {

                        ${ applyDispersionFunc }( &surface, materialInfo.dispersion, wavelength );
                        if ( ! dispersed ) {

                            dispersed = true;
                            throughput *= ${ dispersionColorWeightFunc }( wavelength );

                        }

                    }
                    // leaving the volume: absorbed over the way inside
                    if ( hit.side < 0.0 && ! surface.thinWall ) {

                        throughput *= ${ transmissionAttenuationFunc }( hit.dist, surface.attenuationColor, surface.attenuationDistance );

                    }

                    var n = surface.normal;
                    if ( dot( n, ray.direction ) > 0.0 ) {

                        n = - n;

                    }
                    let rough = surface.roughness * surface.roughness;
                    if ( rough > 1e-4 ) {

                        let z = 1.0 - 2.0 * ${ random }( &rng );
                        let rr = sqrt( max( 0.0, 1.0 - z * z ) );
                        let a = 6.283185307 * ${ random }( &rng );
                        let tilted = normalize( n + vec3f( rr * cos( a ), rr * sin( a ), z ) * rough );
                        n = select( n, tilted, dot( tilted, ray.direction ) < 0.0 );

                    }

                    var direction = ray.direction;
                    if ( surface.thinWall ) {

                        // thin wall: through unbent (or reflected by Fresnel)
                        let cosI = clamp( - dot( ray.direction, n ), 0.0, 1.0 );
                        let f0 = pow( ( surface.ior - 1.0 ) / ( surface.ior + 1.0 ), 2.0 );
                        let fresnel = f0 + ( 1.0 - f0 ) * pow( 1.0 - cosI, 5.0 );
                        if ( ${ random }( &rng ) < fresnel ) {

                            direction = reflect( ray.direction, n );

                        } else {

                            throughput *= surface.color;

                        }

                    } else {

                        // eta = n1 / n2 across this face
                        let eta = select( max( surface.ior, 1.0 ), 1.0 / max( surface.ior, 1.0 ), hit.side > 0.0 );
                        let cosI = clamp( - dot( ray.direction, n ), 0.0, 1.0 );
                        let sin2T = eta * eta * ( 1.0 - cosI * cosI );
                        var fresnel = 1.0;
                        if ( sin2T < 1.0 ) {

                            let cosT = sqrt( 1.0 - sin2T );
                            let rs = ( eta * cosI - cosT ) / ( eta * cosI + cosT );
                            let rp = ( cosI - eta * cosT ) / ( cosI + eta * cosT );
                            fresnel = 0.5 * ( rs * rs + rp * rp );

                        }
                        if ( ${ random }( &rng ) < fresnel ) {

                            direction = reflect( ray.direction, n );

                        } else {

                            direction = normalize( eta * ray.direction + ( eta * cosI - sqrt( 1.0 - sin2T ) ) * n );
                            if ( hit.side > 0.0 ) {

                                throughput *= surface.color;

                            }

                        }

                    }
                    if ( max( max( throughput.r, throughput.g ), throughput.b ) < 1e-3 ) {

                        break;

                    }
                    ray.origin = ${ offsetRayOriginFunc }( position, direction, hit.normal );
                    ray.direction = direction;

                }

            }
        `;
        this._fn = shader(p);

        const clear = storage(this.buffer, 'uint', this.slots * 4);
        const cleared = this.slots * 4;
        this._clearFn = wgslTagFn/* wgsl */`
            fn compute( globalId: vec3u ) -> void {

                let start = globalId.x * 64u;
                for ( var i = 0u; i < 64u; i ++ ) {

                    if ( start + i < ${ cleared }u ) {

                        ${ clear }[ start + i ] = 0u;

                    }

                }

            }
        `({ globalId });
    }

    // scene data changed (or its ray test): build the photon kernel anew
    _build(bvhData) {
        this._bvhData = bvhData;
        this._raycast = bvhData.fns.raycastFirstHit;
        this.params.bvhData.value = bvhData;
        const node = this._fn.context({});
        node.parameters = this._fn.parameters;
        this._kernel = node.computeKernel([WORKGROUP, 1, 1]);
        this._clearKernel ??= this._clearFn.computeKernel([WORKGROUP, 1, 1]);
    }

    /**
     * Set up for this frame: glass bounds, sources (directional lamps, the HDRI's sun, point / spot / IES lamps), cell
     * size; a change clears the grid. Returns false when there is nothing to trace (no glass, no light).
     * Per source SOURCE_VEC4 vec4:
     *   0: directional: direction to the light, tan of the disc's angular radius – local: position, cos of the half angle
     *      of the cone around the glass bounds (−1: all directions)
     *   1: photon weight (rgb), cdf of the pick
     *   2: axis of a spot / IES lamp (towards its target), kind (SOURCE_KIND)
     *   3: u of the lamp's frame (like the path tracer's light record), cos of the spot's cone
     *   4: v of the lamp's frame, cos of the spot's inner cone (penumbra)
     * Flux of a source (what its photons carry together): directional E × the disc across the glass bounds; local the
     * intensity × the cone's solid angle (the spot's cone / IES profile per photon on top – at most 1).
     * @param {object} o { bvhData, scene (the path tracer's), env (the library's EquirectHdrInfoNode or null), version
     *   (scene data / materials) }
     */
    prepare({ bvhData, scene, env, version }) {
        if (bvhData !== this._bvhData || bvhData.fns.raycastFirstHit !== this._raycast) this._build(bvhData);
        // glass objects (visible, transmissive) and the lamps
        const box = new Box3(), part = new Box3();
        const sources = [], lamps = [];
        scene.updateMatrixWorld();
        scene.traverseVisible(o => {
            if (o.isLight && o.intensity > 0 && (o.isDirectionalLight || o.isPointLight || o.isSpotLight)) lamps.push(o);
            if (!o.isMesh) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            if (!mats.some(m => (m?.transmission ?? 0) > 0.5)) return;
            if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
            box.union(part.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
        });
        if (box.isEmpty()) return false;
        const sphere = box.getBoundingSphere(new Sphere());
        const area = Math.PI * sphere.radius * sphere.radius;
        for (const o of lamps) {
            const color = new Vector3(o.color.r, o.color.g, o.color.b).multiplyScalar(o.intensity);
            const position = new Vector3().setFromMatrixPosition(o.matrixWorld);
            if (o.isDirectionalLight) {
                o.target.updateMatrixWorld();
                const dir = position.sub(new Vector3().setFromMatrixPosition(o.target.matrixWorld)).normalize();
                sources.push({ kind: SOURCE_KIND.directional, dir, flux: color.multiplyScalar(area), w: 0, radius: 0 });
                continue;
            }
            // cone from the lamp around the glass bounds
            const dist = position.distanceTo(sphere.center);
            const cosHalf = dist > sphere.radius * 1.0001 ? Math.sqrt(1 - (sphere.radius / dist) ** 2) : -1;
            const source = { kind: SOURCE_KIND.point, dir: position, flux: color.multiplyScalar(2 * Math.PI * (1 - cosHalf)), w: cosHalf,
                axis: new Vector3(0, -1, 0), u: new Vector3(1, 0, 0), v: new Vector3(0, 1, 0), cone: 0, penumbra: 0, ies: null };
            if (o.isSpotLight) {
                // the lamp's frame like the path tracer's light record (lookAt from the lamp to its target, world up)
                o.target.updateMatrixWorld();
                const target = new Vector3().setFromMatrixPosition(o.target.matrixWorld);
                const q = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(position, target, UP));
                source.u.set(1, 0, 0).applyQuaternion(q);
                source.v.set(0, 1, 0).applyQuaternion(q);
                source.axis.copy(target).sub(position).normalize();
                if (o.iesMap?.image?.data) { source.kind = SOURCE_KIND.ies; source.ies = o.iesMap; }
                else { source.kind = SOURCE_KIND.spot; source.cone = Math.cos(o.angle); source.penumbra = Math.cos(o.angle * (1 - o.penumbra)); }
            }
            sources.push(source);
        }
        // the HDRI's sun (searched once per map), turned and scaled like the environment
        let sun = null;
        if (env?.map && env.totalSum > 0 && env.intensityNode.value > 0) {
            if (this._sunMap !== env.map.image.data) { this._sunMap = env.map.image.data; this._sun = findSun(env.map); }
            if (this._sun) {
                const toWorld = new Matrix3().copy(env.rotationNode.value).transpose();
                sun = { kind: SOURCE_KIND.directional, dir: this._sun.dir.clone().applyMatrix3(toWorld).normalize(),
                    flux: this._sun.e.clone().multiplyScalar(env.intensityNode.value * area), radius: this._sun.radius, cos: this._sun.cos, w: 0 };
                sources.push(sun);
            }
        }
        CAUSTICS.sun.value.set(sun?.dir.x ?? 0, sun?.dir.y ?? 1, sun?.dir.z ?? 0, sun ? sun.cos : 2);
        sources.sort((a, b) => luminance(b.flux) - luminance(a.flux));
        sources.length = Math.min(sources.length, MAX_SOURCES);
        // pick ∝ luminance of the flux; weight = flux / (p · Σ luminance) – every photon carries about 1 (FIXED units)
        const sum = sources.reduce((s, l) => s + luminance(l.flux), 0);
        if (!(sum > 0)) return false;
        const a = this._sources.array, V = SOURCE_VEC4 * 4;
        let cdf = 0;
        sources.forEach((l, i) => {
            const pick = luminance(l.flux) / sum;
            cdf += pick;
            const local = l.kind !== SOURCE_KIND.directional;
            a.set([l.dir.x, l.dir.y, l.dir.z, local ? l.w : Math.tan(l.radius)], i * V);
            a.set([l.flux.x / (pick * sum), l.flux.y / (pick * sum), l.flux.z / (pick * sum), i === sources.length - 1 ? 2 : cdf], i * V + 4);
            const axis = l.axis ?? UP, u = l.u ?? UP, v = l.v ?? UP;
            a.set([axis.x, axis.y, axis.z, l.kind], i * V + 8);
            a.set([u.x, u.y, u.z, l.cone ?? 0], i * V + 12);
            a.set([v.x, v.y, v.z, l.penumbra ?? 0], i * V + 16);
        });
        const p = this.params;
        p.sourceCount.value = sources.length;
        p.sphere.value.set(sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius);
        // cell side: the lit area behind the glass (~3 × its cross-section) at the table's occupancy
        const side = Math.sqrt(3 * Math.PI * sphere.radius ** 2 / (this.slots * this.occupancy));
        const sig = [version, box.min.toArray(), box.max.toArray(), sources.map(l => [l.kind, l.dir.toArray(), l.flux.toArray(), l.radius ?? 0,
            l.axis?.toArray() ?? 0, l.u?.toArray() ?? 0, l.cone ?? 0, l.penumbra ?? 0, l.ies ? `${l.ies.uuid}:${l.ies.version}` : 0])].flat(3).join(',');
        if (sig !== this.signature) {
            this.signature = sig;
            this.photons = 0;
            this._needsClear = true;
            this._sources.needsUpdate = true;
            sources.forEach((l, i) => { if (l.ies) profileTable(l.ies, this._profiles.array, i * PROFILE_THETA * PROFILE_PHI); });
            if (sources.some(l => l.ies)) this._profiles.needsUpdate = true;
        }
        this._sum = sum;
        this._cellArea = side * side;
        CAUSTICS.cell.value.set(sphere.center.x, sphere.center.y, sphere.center.z, side);
        CAUSTICS.mask.value = this.slots - 1;
        CAUSTICS.grid.value = this.buffer;
        return true;
    }

    /** GPU time of the last photon dispatch → batch size for `budgetMs` (pathtracer.js) */
    adapt(ms, budgetMs) {
        const f = Math.min(Math.max(budgetMs / ms, 0.5), 2);
        this.batch = Math.round(Math.min(Math.max(this.batch * f, this._batchRange[0]), this._batchRange[1]));
    }

    /** trace `count` photons (one dispatch; first clears the grid if needed) and update the normalisation */
    trace(renderer, count) {
        if (this._needsClear) {
            this._needsClear = false;
            renderer.compute(this._clearKernel, [Math.ceil(this.slots * 4 / 64 / WORKGROUP), 1, 1]);
        }
        const p = this.params;
        p.count.value = count;
        p.seed.value = (p.seed.value + 1) >>> 0;
        renderer.compute(this._kernel, [Math.ceil(count / WORKGROUP), 1, 1]);
        this.photons += count;
        // irradiance per grid unit: flux per photon (Σ luminance of the sources' flux / photons) / FIXED / cell face
        CAUSTICS.table.value.x = this._sum / (this.photons * FIXED * this._cellArea);
    }

    /** the two compute nodes – for compiling them asynchronously before the first trace */
    get kernels() {
        return [this._clearKernel, this._kernel];
    }

    dispose() {
        this.buffer.dispose?.();
        this._sources.dispose?.();
        this._profiles.dispose?.();
        CAUSTICS.on.value = 0;
    }
}

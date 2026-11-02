// Photon pass of the caustics (caustics.js): one photon per invocation from a light source – every lamp (directional,
// point, spot, IES, rectangle, disc) and the HDRI (importance-sampled by its luminance: an inverse CDF over a copy of
// at most ENV_W × ENV_H cells, colour as rgb / luminance per cell) – aimed at the casters: the bounding spheres of the
// glass and mirror objects, each its own (more than MAX_CASTERS: merged in a grid). Directional light and the HDRI:
// parallel rays from the disc across a caster picked by its area, started outside the scene; local lamps: from the lamp
// (rectangle / disc: a point on it) into the cone around a caster picked by its solid angle. The density is the
// mixture of all casters whose disc / cone contains the ray (overlaps counted – photon weight × Σ area / k resp.
// Σ solid angle / k), so no photon is wasted on the open floor and casters far apart keep fine cells. Traced through the
// casters with the path tracer's scene data (BVH, transforms, material records incl. textures – like pt-guides.js) and
// deposited into the hash grid where it lands on another surface after passing a caster.
//
// At glass (transmission > ½): smooth dielectric with the surface record's IOR (per wavelength with dispersion: a
// uniformly sampled wavelength per photon, colour weight of the library – rainbow edges), Fresnel picks reflection or
// refraction, total internal reflection reflects; rough glass tilts the normal by roughness²; colour on entry,
// absorption over the distance inside (attenuation colour/distance) on exit; thin walls pass straight (× colour).
// At a mirror (causticMirror – metal, smooth; the material's values like the megakernel): reflected, × Schlick's
// Fresnel with the metal's colour, rough ones tilted like glass.
// Anything else ends the photon: after at least one caster face it is deposited – flux as fixed point (× FIXED) into the
// cell's slot (key claimed by compare-exchange, linear probing, CAUSTICS_PROBES slots; a full table drops the photon).
import { Vector3, Vector4, Matrix3, Matrix4, Quaternion, StorageBufferAttribute, Box3, Sphere, DataUtils, HalfFloatType, SRGBColorSpace, DoubleSide, BackSide } from 'three/webgpu';
import { uniform, globalId, storage } from 'three/tsl';
import { proxy, proxyFn, wgslTagFn, rayStruct } from 'three-mesh-bvh/webgpu';
import { offsetRayOriginFunc } from 'three-gpu-pathtracer/src/webgpu/nodes/utils.wgsl.js';
import { applyDispersionFunc, dispersionColorWeightFunc, transmissionAttenuationFunc, DISPERSION_MIN_WAVELENGTH, DISPERSION_MAX_WAVELENGTH } from 'three-gpu-pathtracer/src/webgpu/nodes/material.wgsl.js';
import { CAUSTICS, CAUSTICS_HASH, CAUSTICS_PROBES, CAUSTICS_MIRROR } from './caustics.js';
import { isMirror } from './kernel-features.js';

const FIXED = 32;          // grid units per photon of weight 1 (stochastic rounding – a cell overflows after ~1e8 photons)
const WORKGROUP = 64;
const MAX_SOURCES = 16;    // lamps + the HDRI (more lamps: the dimmest ones get no photons)
const SOURCE_VEC4 = 5;     // vec4 per source (see prepare)
const MAX_CASTERS = 64;    // bounding spheres the photons aim at (more objects: merged)
const ENV_W = 1024, ENV_H = 512;   // the HDRI's copy for sampling (at most; a sun of 0.5° stays about one cell)
const MAX_EMITTERS = 65536;        // triangles of glowing meshes (more: drawn by their power – see collectEmitters)
// IES profiles of the sources as tables: 180 angles from the axis (0…180°, like the profile textures' columns) × 72
// directions around it (5° steps, −180…180° like their rows; one row repeated for symmetric profiles)
const PROFILE_THETA = 180, PROFILE_PHI = 72;
const SOURCE_KIND = { directional: 0, point: 1, spot: 2, ies: 3, environment: 4, rect: 5, disc: 6, mesh: 7 };
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
 * The HDRI (the path tracer's preprocessed map: half float RGBA, rows bottom-up – row y at uv.y = (y + ½) / h, polar
 * angle π (1 − uv.y), equirectUvToDirection of the library) → a sampling table of W × H cells (box-filtered): cdf of
 * the rows (∝ Σ luminance × sin of the polar angle), cdf within each row (∝ luminance), colour / luminance per cell as
 * two packed half pairs. Returns { W, H, total } (Σ luminance × solid angle – the HDRI's luminance integral) or null
 * (dark map). Picking cells so has the solid angle density luminance / total – a photon carries colour / luminance ×
 * total.
 */
function envTable(map, cdf, colour) {
    const { width: w, height: h, data } = map?.image ?? {};
    if (!(data instanceof Uint16Array) || w < 8 || h < 4) return null;
    const half = halfToFloat();
    const W = Math.min(ENV_W, w), H = Math.max(2, Math.min(ENV_H, Math.round(W * h / w)));
    const rows = new Float64Array(H);
    let total = 0;
    for (let y = 0; y < H; y++) {
        const sy0 = Math.floor(y * h / H), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / H));
        const sin = Math.sin(Math.PI * (1 - (y + 0.5) / H));
        let row = 0;
        for (let x = 0; x < W; x++) {
            const sx0 = Math.floor(x * w / W), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / W));
            let r = 0, g = 0, b = 0;
            for (let sy = sy0; sy < sy1; sy++) {
                for (let sx = sx0, i = (sy * w + sx0) * 4; sx < sx1; sx++, i += 4) { r += half[data[i]]; g += half[data[i + 1]]; b += half[data[i + 2]]; }
            }
            const n = (sy1 - sy0) * (sx1 - sx0);
            r /= n; g /= n; b /= n;
            const lum = Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * b);
            const k = y * W + x;
            colour[k * 2] = packHalf2(lum > 0 ? r / lum : 0, lum > 0 ? g / lum : 0);
            colour[k * 2 + 1] = packHalf2(lum > 0 ? b / lum : 0, 0);
            row += lum;
            cdf[H + k] = row;
        }
        for (let x = 0; x < W; x++) cdf[H + y * W + x] = row > 0 ? cdf[H + y * W + x] / row : (x + 1) / W;
        rows[y] = row * sin;
        total += rows[y];
    }
    if (!(total > 0)) return null;
    let acc = 0;
    for (let y = 0; y < H; y++) { acc += rows[y]; cdf[y] = acc / total; }
    cdf[H - 1] = 1;
    return { W, H, total: total * (2 * Math.PI / W) * (Math.PI / H) };
}
const packHalf2 = (a, b) => DataUtils.toHalfFloat(Math.min(a, 65504)) | (DataUtils.toHalfFloat(Math.min(b, 65504)) << 16);

// mean colour of a texture (linear) – the emission of a glowing mesh with an emissive map: the photons carry the map's
// mean (per texture version); unreadable → 1
const textureMeans = new Map();
function textureMean(tex) {
    const key = `${tex.uuid}:${tex.version}`;
    if (textureMeans.has(key)) return textureMeans.get(key);
    let mean = [1, 1, 1];
    const lin = v => tex.colorSpace === SRGBColorSpace ? (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) : v;
    try {
        const img = tex.image;
        if (img?.data && img.width && img.height) {
            const { data, width, height } = img, ch = Math.max(1, Math.round(data.length / (width * height)));
            const half = data instanceof Uint16Array ? halfToFloat() : null, scale = data instanceof Uint8Array || data instanceof Uint8ClampedArray ? 1 / 255 : 1;
            const sum = [0, 0, 0], step = Math.max(1, Math.floor(Math.sqrt(width * height / 4096)));
            let n = 0;
            for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) {
                const i = (y * width + x) * ch;
                for (let c = 0; c < 3; c++) { const v = data[i + Math.min(c, ch - 1)]; sum[c] += lin(half ? half[v] : v * scale); }
                n++;
            }
            if (n) mean = sum.map(v => v / n);
        } else if (img && typeof OffscreenCanvas !== 'undefined' && (img.width || img.videoWidth)) {
            const ctx = new OffscreenCanvas(32, 32).getContext('2d');
            ctx.drawImage(img, 0, 0, 32, 32);
            const d = ctx.getImageData(0, 0, 32, 32).data, sum = [0, 0, 0];
            for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += lin(d[i + c] / 255);
            mean = sum.map(v => v / 1024);
        }
    } catch { /* tainted / unreadable: 1 */ }
    textureMeans.set(key, mean);
    return mean;
}

/** emission of a material like the path tracer (emissive × intensity × emissive map – here its mean), linear rgb, or
 *  null when it does not glow */
function emissionOf(m) {
    if (!m?.emissive || m.matte) return null;
    const k = m.emissiveIntensity ?? 1;
    const e = [m.emissive.r * k, m.emissive.g * k, m.emissive.b * k];
    if (m.emissiveMap) { const t = textureMean(m.emissiveMap); for (let c = 0; c < 3; c++) e[c] *= t[c]; }
    return e[0] + e[1] + e[2] > 1e-6 ? e : null;
}

/**
 * Triangles of the glowing meshes (world space) → the photon kernel's emitter table (4 vec4 each: corner + sides that
 * glow (0 front, 1 back, 2 both – the material's side), edge 1, edge 2, weight rgb + cdf). Picked ∝ power (luminance × area); weight = colour / luminance × total power (what a
 * triangle sends ÷ its pick probability). More than `max`: `max` triangles drawn ∝ power (with repetition), picked
 * uniformly – the same distribution, fixed for the scene version. Returns { count, power, meshes: [{ center, power }] }
 * (meshes: for the source's flux estimate) or null.
 */
function collectEmitters(scene, out, max) {
    const tris = [], power = [], colour = [], sides = [], meshes = [];
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), m4 = new Matrix4(), inst = new Matrix4();
    scene.traverseVisible(o => {
        if (!o.isMesh || !o.geometry?.attributes?.position) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const glow = mats.map(emissionOf);
        if (!glow.some(Boolean)) return;
        const pos = o.geometry.attributes.position, index = o.geometry.index;
        const triCount = (index ? index.count : pos.count) / 3;
        const groups = Array.isArray(o.material) && o.geometry.groups.length ? o.geometry.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
        const copies = o.isInstancedMesh ? o.count : 1;
        let meshPower = 0;
        const box = new Box3();
        for (let k = 0; k < copies; k++) {
            m4.copy(o.matrixWorld);
            if (o.isInstancedMesh) { o.getMatrixAt(k, inst); m4.multiply(inst); }
            for (const g of groups) {
                const e = glow[g.materialIndex ?? 0];
                if (!e) continue;
                // sides that glow: 0 front, 1 back, 2 both; a mirrored placement turns the winding around
                const mat = mats[g.materialIndex ?? 0];
                let side = mat.side === DoubleSide ? 2 : mat.side === BackSide ? 1 : 0;
                if (side < 2 && m4.determinant() < 0) side = 1 - side;
                const lum = luminance({ x: e[0], y: e[1], z: e[2] });
                if (!(lum > 0)) continue;
                const end = Math.min(g.start + g.count, triCount * 3);
                for (let i = g.start; i + 2 < end; i += 3) {
                    const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
                    a.fromBufferAttribute(pos, ia).applyMatrix4(m4);
                    b.fromBufferAttribute(pos, ib).applyMatrix4(m4).sub(a);
                    c.fromBufferAttribute(pos, ic).applyMatrix4(m4).sub(a);
                    const area = 0.5 * b.clone().cross(c).length();
                    if (!(area > 0)) continue;
                    tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
                    power.push(lum * area);
                    sides.push(side);
                    colour.push(e[0] / lum, e[1] / lum, e[2] / lum);
                    meshPower += lum * area;
                    box.expandByPoint(a);
                }
            }
        }
        if (meshPower > 0) meshes.push({ center: box.getCenter(new Vector3()), power: meshPower });
    });
    const n = power.length;
    if (!n) return null;
    const cum = new Float64Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) { total += power[i]; cum[i] = total; }
    const write = (j, i, cdf) => {
        out.set([tris[i * 9], tris[i * 9 + 1], tris[i * 9 + 2], sides[i], tris[i * 9 + 3], tris[i * 9 + 4], tris[i * 9 + 5], 0,
            tris[i * 9 + 6], tris[i * 9 + 7], tris[i * 9 + 8], 0, colour[i * 3] * total, colour[i * 3 + 1] * total, colour[i * 3 + 2] * total, cdf], j * 16);
    };
    if (n <= max) {
        for (let i = 0; i < n; i++) write(i, i, i === n - 1 ? 2 : cum[i] / total);
        return { count: n, power: total, meshes };
    }
    for (let j = 0; j < max; j++) {
        const r = Math.random() * total;
        let lo = 0, hi = n - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
        write(j, lo, j === max - 1 ? 2 : (j + 1) / max);
    }
    return { count: max, power: total, meshes };
}

/** caster spheres → at most `max`: merged by a grid over their centres, coarser until few enough cells are taken */
function clusterSpheres(spheres, max) {
    if (spheres.length <= max) return spheres;
    const box = new Box3();
    for (const s of spheres) box.expandByPoint(s.center);
    let cell = Math.max(box.getSize(new Vector3()).length() / max, 1e-6);
    for (;;) {
        const groups = new Map();
        for (const s of spheres) {
            const key = ['x', 'y', 'z'].map(a => Math.floor((s.center[a] - box.min[a]) / cell)).join(',');
            const g = groups.get(key);
            if (g) g.union(s); else groups.set(key, s.clone());
        }
        if (groups.size <= max) return [...groups.values()];
        cell *= 1.1;
    }
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
        this._envMap = null;   // HDRI data the sampling table was built from (once per map – the library works on clones)
        this._env = null;      // { W, H, total } of that table, or null
        this._envId = 0;
        this._casterKey = null;   // scene version the casters were collected for
        this.ready = false;    // pipelines compiled

        // light sources: SOURCE_VEC4 vec4 per source (see prepare); IES tables per source; casters (centre, radius) and
        // the cdf of their areas; the HDRI's sampling table (cdf: rows, then each row; colour: 2 u32 per cell)
        this._sources = new StorageBufferAttribute(new Float32Array(MAX_SOURCES * SOURCE_VEC4 * 4), 4);
        this._profiles = new StorageBufferAttribute(new Float32Array(MAX_SOURCES * PROFILE_THETA * PROFILE_PHI), 1);
        this._casters = new StorageBufferAttribute(new Float32Array(MAX_CASTERS * 4), 4);
        this._casterCdf = new StorageBufferAttribute(new Float32Array(MAX_CASTERS), 1);
        this._envCdf = new StorageBufferAttribute(new Float32Array(ENV_H + ENV_W * ENV_H), 1);
        this._envColour = new StorageBufferAttribute(new Uint32Array(ENV_W * ENV_H * 2), 1);
        // glowing triangles: 4 vec4 each – corner, edge 1, edge 2 (xyz), weight rgb + cdf of the pick (see collectEmitters)
        this._emitters = new StorageBufferAttribute(new Float32Array(MAX_EMITTERS * 16), 4);
        const p = this.params = {
            bvhData: { value: null },
            globalId,
            count: uniform(0, 'uint'),
            seed: uniform(0, 'uint'),
            sourceCount: uniform(0, 'uint'),
            casterCount: uniform(0, 'uint'),
            casterArea: uniform(0),                // Σ π r² of the casters
            bounds: uniform(new Vector4()),        // the scene's bounding sphere (parallel photons start outside it)
        };
        const sources = storage(this._sources, 'vec4', MAX_SOURCES * SOURCE_VEC4).toReadOnly();
        const profiles = storage(this._profiles, 'float', MAX_SOURCES * PROFILE_THETA * PROFILE_PHI).toReadOnly();
        const casters = storage(this._casters, 'vec4', MAX_CASTERS).toReadOnly();
        const casterCdf = storage(this._casterCdf, 'float', MAX_CASTERS).toReadOnly();
        const envCdf = storage(this._envCdf, 'float', ENV_H + ENV_W * ENV_H).toReadOnly();
        const envColour = storage(this._envColour, 'uint', ENV_W * ENV_H * 2).toReadOnly();
        const emitters = storage(this._emitters, 'vec4', MAX_EMITTERS * 4).toReadOnly();
        // cone from x around caster j: cos of its half angle (−1: x inside), 0 solid angle when it lies behind the
        // emitting side `side` (area lights; zero vector: all around)
        const cone = wgslTagFn/* wgsl */`
            fn causticCone( j: u32, x: vec3f, side: vec3f ) -> vec4f {

                let c = ${ casters }[ j ];
                let dv = c.xyz - x;
                let d2 = dot( dv, dv );
                let r2 = c.w * c.w;
                if ( dot( dv, side ) < - c.w ) {

                    return vec4f( 0.0, 0.0, 1.0, 1.0 );

                }
                if ( d2 <= r2 * 1.0001 ) {

                    return vec4f( 0.0, 0.0, 1.0, - 1.0 );

                }
                return vec4f( dv / sqrt( d2 ), sqrt( max( 0.0, 1.0 - r2 / d2 ) ) );

            }
        `;
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

                // source by its share (cdf)
                let pick = ${ random }( &rng );
                var source = 0u;
                for ( var i = 0u; i + 1u < sourceCount; i ++ ) {

                    if ( pick < ${ sources }[ i * ${ V }u + 1u ].w ) {

                        break;

                    }
                    source = i + 1u;

                }
                let s0 = ${ sources }[ source * ${ V }u ];
                var throughput = ${ sources }[ source * ${ V }u + 1u ].xyz;
                let s2 = ${ sources }[ source * ${ V }u + 2u ];
                let s3 = ${ sources }[ source * ${ V }u + 3u ];
                let s4 = ${ sources }[ source * ${ V }u + 4u ];
                let kind = u32( s2.w );
                let casterCount = ${ p.casterCount };
                var ray: ${ rayStruct };
                ray.maxDist = 0.0;
                if ( kind == ${ SOURCE_KIND.directional }u || kind == ${ SOURCE_KIND.environment }u ) {

                    // parallel light: direction to it (a lamp's, spread over its disc; the HDRI: a cell by its luminance)
                    var toLight = s0.xyz;
                    if ( kind == ${ SOURCE_KIND.environment }u ) {

                        let W = u32( s3.w );
                        let H = u32( s4.w );
                        let r1 = ${ random }( &rng );
                        var lo = 0u;
                        var hi = H - 1u;
                        while ( lo < hi ) {

                            let mid = ( lo + hi ) / 2u;
                            if ( ${ envCdf }[ mid ] < r1 ) { lo = mid + 1u; } else { hi = mid; }

                        }
                        let row = lo;
                        let r2 = ${ random }( &rng );
                        lo = 0u;
                        hi = W - 1u;
                        while ( lo < hi ) {

                            let mid = ( lo + hi ) / 2u;
                            if ( ${ envCdf }[ H + row * W + mid ] < r2 ) { lo = mid + 1u; } else { hi = mid; }

                        }
                        let cell = row * W + lo;
                        let theta = ( ( f32( lo ) + ${ random }( &rng ) ) / f32( W ) - 0.5 ) * 6.283185307;
                        let polar = 3.14159265 * ( 1.0 - ( f32( row ) + ${ random }( &rng ) ) / f32( H ) );
                        let local = vec3f( sin( polar ) * cos( theta ), cos( polar ), sin( polar ) * sin( theta ) );
                        toLight = normalize( mat3x3f( s2.xyz, s3.xyz, s4.xyz ) * local );
                        let rg = unpack2x16float( ${ envColour }[ cell * 2u ] );
                        let b = unpack2x16float( ${ envColour }[ cell * 2u + 1u ] ).x;
                        throughput *= vec3f( rg, b );

                    } else if ( s0.w > 0.0 ) {

                        let helper = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( toLight.y ) > 0.9 );
                        let sx = normalize( cross( helper, toLight ) );
                        let sy = cross( toLight, sx );
                        let sr = sqrt( ${ random }( &rng ) ) * s0.w;
                        let sa = 6.283185307 * ${ random }( &rng );
                        toLight = normalize( toLight + ( sx * cos( sa ) + sy * sin( sa ) ) * sr );

                    }
                    // a caster by its area, a point on its disc across the light
                    let ra = ${ random }( &rng );
                    var ci = 0u;
                    for ( var j = 0u; j + 1u < casterCount; j ++ ) {

                        if ( ra < ${ casterCdf }[ j ] ) {

                            break;

                        }
                        ci = j + 1u;

                    }
                    let cs = ${ casters }[ ci ];
                    let helper = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( toLight.y ) > 0.9 );
                    let tx = normalize( cross( helper, toLight ) );
                    let ty = cross( toLight, tx );
                    let r = sqrt( ${ random }( &rng ) ) * cs.w;
                    let phi = 6.283185307 * ${ random }( &rng );
                    let start = cs.xyz + ( tx * cos( phi ) + ty * sin( phi ) ) * r;
                    // density: every caster whose disc the ray crosses
                    var k = 0.0;
                    for ( var j = 0u; j < casterCount; j ++ ) {

                        let o = ${ casters }[ j ];
                        let dv = o.xyz - start;
                        let along = dot( dv, toLight );
                        if ( dot( dv, dv ) - along * along <= o.w * o.w * 1.0001 ) {

                            k += 1.0;

                        }

                    }
                    throughput *= ${ p.casterArea } / max( k, 1.0 );
                    let bounds = ${ p.bounds };
                    ray.origin = start + toLight * ( dot( bounds.xyz - start, toLight ) + bounds.w * 1.01 );
                    ray.direction = - toLight;

                } else {

                    // local lamp: from its position (rectangle / disc: a point on it, emitting along − its normal;
                    // glowing meshes: a triangle by its power, a point on it, emitting to the sides its material has)
                    var x = s0.xyz;
                    var side = vec3f( 0.0 );
                    var meshNormal = vec3f( 0.0 );
                    var meshSide = 0.0;
                    let area = kind == ${ SOURCE_KIND.rect }u || kind == ${ SOURCE_KIND.disc }u;
                    if ( kind == ${ SOURCE_KIND.mesh }u ) {

                        let re = ${ random }( &rng );
                        var lo = 0u;
                        var hi = u32( s3.w ) - 1u;
                        while ( lo < hi ) {

                            let mid = ( lo + hi ) / 2u;
                            if ( ${ emitters }[ mid * 4u + 3u ].w < re ) { lo = mid + 1u; } else { hi = mid; }

                        }
                        let e1 = ${ emitters }[ lo * 4u + 1u ].xyz;
                        let e2 = ${ emitters }[ lo * 4u + 2u ].xyz;
                        var bu = ${ random }( &rng );
                        var bv = ${ random }( &rng );
                        if ( bu + bv > 1.0 ) {

                            bu = 1.0 - bu;
                            bv = 1.0 - bv;

                        }
                        x = ${ emitters }[ lo * 4u ].xyz + e1 * bu + e2 * bv;
                        meshNormal = normalize( cross( e1, e2 ) );
                        meshSide = ${ emitters }[ lo * 4u ].w;
                        throughput *= ${ emitters }[ lo * 4u + 3u ].xyz;

                    }
                    if ( area ) {

                        let ru = ${ random }( &rng );
                        let rv = ${ random }( &rng );
                        if ( kind == ${ SOURCE_KIND.rect }u ) {

                            x += s2.xyz * ( ru - 0.5 ) + s3.xyz * ( rv - 0.5 );

                        } else {

                            let rr = 0.5 * sqrt( ru );
                            let ra = 6.283185307 * rv;
                            x += s2.xyz * ( rr * cos( ra ) ) + s3.xyz * ( rr * sin( ra ) );

                        }
                        side = - normalize( cross( s2.xyz, s3.xyz ) );

                    }
                    // into the cone around a caster picked by its solid angle from x
                    var total = 0.0;
                    for ( var j = 0u; j < casterCount; j ++ ) {

                        let cj = ${ cone }( j, x, side );
                        total += 1.0 - cj.w;

                    }
                    if ( total <= 0.0 ) {

                        return;

                    }
                    let rc = ${ random }( &rng ) * total;
                    var acc = 0.0;
                    var c = vec4f( 0.0, 0.0, 1.0, 1.0 );
                    for ( var j = 0u; j < casterCount; j ++ ) {

                        c = ${ cone }( j, x, side );
                        acc += 1.0 - c.w;
                        if ( rc < acc ) {

                            break;

                        }

                    }
                    let axis = c.xyz;
                    let helper = select( vec3f( 0.0, 1.0, 0.0 ), vec3f( 1.0, 0.0, 0.0 ), abs( axis.y ) > 0.9 );
                    let tx = normalize( cross( helper, axis ) );
                    let ty = cross( axis, tx );
                    let cosT = 1.0 - ${ random }( &rng ) * ( 1.0 - c.w );
                    let sinT = sqrt( max( 0.0, 1.0 - cosT * cosT ) );
                    let phi = 6.283185307 * ${ random }( &rng );
                    let d = normalize( axis * cosT + ( tx * cos( phi ) + ty * sin( phi ) ) * sinT );
                    // density: every cone that contains d (solid angle 2π (1 − cos) each – the 2π is in the weight)
                    var k = 0.0;
                    for ( var j = 0u; j < casterCount; j ++ ) {

                        let cj = ${ cone }( j, x, side );
                        if ( cj.w < 1.0 && dot( d, cj.xyz ) >= cj.w ) {

                            k += 1.0;

                        }

                    }
                    throughput *= 6.283185307 * total / max( k, 1.0 );
                    if ( area ) {

                        throughput *= max( 0.0, dot( d, side ) );

                    } else if ( kind == ${ SOURCE_KIND.mesh }u ) {

                        // the sides the material has (like the path tracer: a one-sided face is not hit from behind –
                        // its back neither glows nor stops the photon)
                        let mc = dot( d, meshNormal );
                        throughput *= select( select( max( 0.0, mc ), max( 0.0, - mc ), meshSide == 1.0 ), abs( mc ), meshSide == 2.0 );

                    } else {

                        throughput *= ${ emission }( source, d );

                    }
                    if ( max( max( throughput.r, throughput.g ), throughput.b ) <= 0.0 ) {

                        return;

                    }
                    ray.origin = x;
                    if ( kind == ${ SOURCE_KIND.mesh }u ) {

                        // off its own triangle
                        ray.origin = ${ offsetRayOriginFunc }( x, d, select( - meshNormal, meshNormal, dot( d, meshNormal ) > 0.0 ) );

                    }
                    ray.direction = d;

                }

                let wavelength = mix( ${ DISPERSION_MIN_WAVELENGTH }.0, ${ DISPERSION_MAX_WAVELENGTH }.0, ${ random }( &rng ) );
                var dispersed = false;
                var casterFaces = 0u;

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

                    // mirror: reflected (Schlick with the metal's colour; rough ones tilted like glass)
                    if ( ${ CAUSTICS_MIRROR }( materialInfo.metalness, materialInfo.roughness, materialInfo.transmission, materialInfo.matte != 0 ) ) {

                        casterFaces ++;
                        var mn = surface.normal;
                        if ( dot( mn, ray.direction ) > 0.0 ) {

                            mn = - mn;

                        }
                        let mr = surface.roughness * surface.roughness;
                        if ( mr > 1e-4 ) {

                            let z = 1.0 - 2.0 * ${ random }( &rng );
                            let rr = sqrt( max( 0.0, 1.0 - z * z ) );
                            let a = 6.283185307 * ${ random }( &rng );
                            let tilted = normalize( mn + vec3f( rr * cos( a ), rr * sin( a ), z ) * mr );
                            mn = select( mn, tilted, dot( tilted, ray.direction ) < 0.0 );

                        }
                        let cosI = clamp( - dot( ray.direction, mn ), 0.0, 1.0 );
                        throughput *= surface.color + ( vec3f( 1.0 ) - surface.color ) * pow( 1.0 - cosI, 5.0 );
                        let reflected = reflect( ray.direction, mn );
                        if ( max( max( throughput.r, throughput.g ), throughput.b ) < 1e-3 || dot( reflected, hit.normal ) <= 0.0 ) {

                            break;

                        }
                        ray.origin = ${ offsetRayOriginFunc }( position, reflected, hit.normal );
                        ray.direction = reflected;
                        continue;

                    }
                    if ( materialInfo.matte != 0 || surface.transmission <= 0.5 ) {

                        // landed after a caster → into the cell of this point and side (hit.normal faces the photon)
                        if ( casterFaces > 0u ) {

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
                    casterFaces ++;
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
     * Set up for this frame: casters (bounding spheres of the glass / mirror objects, per scene version), sources (all
     * lamps, the HDRI), cell size; a change clears the grid. Returns false when there is nothing to trace (no caster,
     * no light).
     * Per source SOURCE_VEC4 vec4:
     *   0: directional: direction to the light, tan of the disc's angular radius – point / spot / IES / rectangle / disc:
     *      position (centre)
     *   1: photon weight (rgb), cdf of the pick
     *   2: spot / IES: axis (towards its target) – rectangle / disc: u (full width) – HDRI: 1st column of map → world;
     *      kind (SOURCE_KIND)
     *   3: spot / IES: u of the lamp's frame (like the path tracer's light record), cos of the spot's cone – rectangle /
     *      disc: v (full height) – HDRI: 2nd column, table width
     *   4: spot / IES: v of the lamp's frame, cos of the inner cone (penumbra) – HDRI: 3rd column, table height
     * Photon weight = what the source sends per unit of the kernel's geometry, ÷ (pick · Σ estimated flux): directional
     * E, HDRI intensity × its luminance integral (× colour / luminance of the cell in the kernel) – both × Σ caster area
     * / k there; point / spot / IES the intensity, rectangle / disc radiance × area – × 2π Σ (1 − cos) / k and the
     * emission towards the photon (cone, profile, cos at the light) there. The estimated flux only steers the picking.
     * @param {object} o { bvhData, scene (the path tracer's), env (the library's EquirectHdrInfoNode or null), version
     *   (scene data / materials / transforms) }
     */
    prepare({ bvhData, scene, env, version }) {
        if (bvhData !== this._bvhData || bvhData.fns.raycastFirstHit !== this._raycast) this._build(bvhData);
        scene.updateMatrixWorld();
        // casters and the scene's bounds: once per scene version
        if (this._casterKey !== version || version < 0) {
            this._casterKey = version;
            const all = new Box3(), part = new Box3(), spheres = [];
            scene.traverseVisible(o => {
                if (!o.isMesh || !o.geometry) return;
                if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
                const bounds = (o.isInstancedMesh || o.isBatchedMesh) ? (o.boundingBox ?? (o.computeBoundingBox(), o.boundingBox)) : o.geometry.boundingBox;
                part.copy(bounds).applyMatrix4(o.matrixWorld);
                all.union(part);
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                if (mats.some(m => m && ((m.transmission ?? 0) > 0.5 || isMirror(m)))) spheres.push(part.getBoundingSphere(new Sphere()));
            });
            this._spheres = clusterSpheres(spheres.filter(s => s.radius > 0), MAX_CASTERS);
            this._bounds = all.isEmpty() ? null : all.getBoundingSphere(new Sphere());
            const a = this._casters.array, cdf = this._casterCdf.array;
            const areaSum = this._spheres.reduce((t, s) => t + Math.PI * s.radius ** 2, 0);
            let acc = 0;
            this._spheres.forEach((s, i) => {
                a.set([s.center.x, s.center.y, s.center.z, s.radius], i * 4);
                acc += Math.PI * s.radius ** 2;
                cdf[i] = i === this._spheres.length - 1 ? 2 : acc / areaSum;
            });
            this._areaSum = areaSum;
            this._casters.needsUpdate = this._casterCdf.needsUpdate = true;
            this._glow = this._spheres.length ? collectEmitters(scene, this._emitters.array, MAX_EMITTERS) : null;
            if (this._glow) this._emitters.needsUpdate = true;
            this._glowId = (this._glowId ?? 0) + 1;
        }
        const spheres = this._spheres;
        if (!spheres.length || !this._bounds) return false;
        const areaSum = this._areaSum;
        // solid angle 2π Σ (1 − cos) of the cones from x around the casters; facing: only the side a surface emits to
        const coneSum = (x, facing = null) => spheres.reduce((t, s) => {
            const dv = s.center.clone().sub(x), d = dv.length();
            if (d <= s.radius * 1.0001) return t + 4 * Math.PI;
            const omega = 2 * Math.PI * (1 - Math.sqrt(1 - (s.radius / d) ** 2));
            return t + omega * (facing ? Math.min(1, Math.max(0, dv.dot(facing) / d + s.radius / d)) : 1);
        }, 0);

        const sources = [];
        const lamps = [];
        scene.traverseVisible(o => {
            if (o.isLight && o.intensity > 0 && (o.isDirectionalLight || o.isPointLight || o.isSpotLight || o.isRectAreaLight)) lamps.push(o);
        });
        for (const o of lamps) {
            const color = new Vector3(o.color.r, o.color.g, o.color.b).multiplyScalar(o.intensity);
            const position = new Vector3().setFromMatrixPosition(o.matrixWorld);
            if (o.isDirectionalLight) {
                o.target.updateMatrixWorld();
                const dir = position.sub(new Vector3().setFromMatrixPosition(o.target.matrixWorld)).normalize();
                sources.push({ kind: SOURCE_KIND.directional, dir, weight: color, flux: luminance(color) * areaSum, radius: 0 });
                continue;
            }
            if (o.isRectAreaLight) {
                // like the path tracer's light record: u, v = width, height along the lamp's x, y; emits along − (u × v)
                const q = o.getWorldQuaternion(new Quaternion());
                const u = new Vector3(o.width, 0, 0).applyQuaternion(q), v = new Vector3(0, o.height, 0).applyQuaternion(q);
                const area = u.clone().cross(v).length() * (o.isCircular ? Math.PI / 4 : 1);
                if (!(area > 0)) continue;
                const facing = u.clone().cross(v).normalize().negate();
                sources.push({ kind: o.isCircular ? SOURCE_KIND.disc : SOURCE_KIND.rect, dir: position, weight: color.clone().multiplyScalar(area),
                    flux: luminance(color) * area * coneSum(position, facing), axis: u, u: v, cone: 0, penumbra: 0 });
                continue;
            }
            const source = { kind: SOURCE_KIND.point, dir: position, weight: color, flux: luminance(color) * coneSum(position),
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
        // the glowing meshes: one source over all their triangles (flux estimate per mesh: power × the casters' solid
        // angle from its centre × ½ – the mean |cos| towards them)
        let glowing = null;
        if (this._glow) {
            const flux = this._glow.meshes.reduce((t, m) => t + m.power * coneSum(m.center), 0) * 0.5;
            glowing = { kind: SOURCE_KIND.mesh, dir: new Vector3(), weight: new Vector3(1, 1, 1), flux, u: new Vector3(), penumbra: 0,
                cone: this._glow.count, glowId: this._glowId };
            if (flux > 0) sources.push(glowing);
        }
        // the HDRI (sampling table once per map), turned and scaled like the environment
        let environment = null;
        if (env?.map && env.totalSum > 0 && env.intensityNode.value > 0) {
            if (this._envMap !== env.map.image.data) {
                this._envMap = env.map.image.data;
                this._env = envTable(env.map, this._envCdf.array, this._envColour.array);
                this._envId++;
                this._envCdf.needsUpdate = this._envColour.needsUpdate = true;
            }
            if (this._env) {
                const toWorld = new Matrix3().copy(env.rotationNode.value).transpose().elements;
                const k = env.intensityNode.value * this._env.total;
                environment = { kind: SOURCE_KIND.environment, dir: new Vector3(), weight: new Vector3(k, k, k), flux: k * areaSum,
                    axis: new Vector3().fromArray(toWorld, 0), u: new Vector3().fromArray(toWorld, 3), v: new Vector3().fromArray(toWorld, 6),
                    cone: this._env.W, penumbra: this._env.H, envId: this._envId };
                sources.push(environment);
            }
        }
        sources.sort((a, b) => b.flux - a.flux);
        sources.length = Math.min(sources.length, MAX_SOURCES);
        CAUSTICS.env.value = environment && sources.includes(environment) ? 1 : 0;
        CAUSTICS.emitters.value = glowing && sources.includes(glowing) ? 1 : 0;
        // pick ∝ estimated flux; weight ÷ (pick · Σ) – every photon carries about 1 (FIXED units)
        const sum = sources.reduce((t, l) => t + l.flux, 0);
        if (!(sum > 0)) return false;
        const a = this._sources.array, V = SOURCE_VEC4 * 4;
        let cdf = 0;
        sources.forEach((l, i) => {
            const pick = l.flux / sum, w = l.weight.clone().divideScalar(pick * sum);
            cdf += pick;
            a.set([l.dir.x, l.dir.y, l.dir.z, l.kind === SOURCE_KIND.directional ? Math.tan(l.radius) : 0], i * V);
            a.set([w.x, w.y, w.z, i === sources.length - 1 ? 2 : cdf], i * V + 4);
            const axis = l.axis ?? UP, u = l.u ?? UP, v = l.v ?? UP;
            a.set([axis.x, axis.y, axis.z, l.kind], i * V + 8);
            a.set([u.x, u.y, u.z, l.cone ?? 0], i * V + 12);
            a.set([v.x, v.y, v.z, l.penumbra ?? 0], i * V + 16);
        });
        const p = this.params;
        p.sourceCount.value = sources.length;
        p.casterCount.value = spheres.length;
        p.casterArea.value = areaSum;
        p.bounds.value.set(this._bounds.center.x, this._bounds.center.y, this._bounds.center.z, this._bounds.radius);
        // cell side: the lit area behind the casters (~3 × their cross-sections) at the table's occupancy
        const side = Math.sqrt(3 * areaSum / (this.slots * this.occupancy));
        const sig = [version, spheres.map(s => [s.center.toArray(), s.radius]), sources.map(l => [l.kind, l.dir.toArray(), l.weight.toArray(), l.flux,
            l.radius ?? 0, l.axis?.toArray() ?? 0, l.u?.toArray() ?? 0, l.v?.toArray() ?? 0, l.cone ?? 0, l.penumbra ?? 0,
            l.ies ? `${l.ies.uuid}:${l.ies.version}` : 0, l.envId ?? 0, l.glowId ?? 0])].flat(4).join(',');
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
        const c = spheres[0].center;
        CAUSTICS.cell.value.set(c.x, c.y, c.z, side);
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
        for (const b of [this.buffer, this._sources, this._profiles, this._casters, this._casterCdf, this._envCdf, this._envColour, this._emitters]) b.dispose?.();
        CAUSTICS.on.value = 0;
    }
}

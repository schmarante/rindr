// Glowing meshes as light sources (user: "leuchtende Meshes … direkt abtasten"): a table of the triangles of all visible
// meshes whose material glows, in world space, shared by
//   - the megakernel (Vite plugin `rindr-emitters`, kernel feature 'emitters'): next event estimation – at every surface
//     one point on a glowing triangle (picked ∝ power), a shadow ray through the glass shadows like the lamps' ones,
//     MIS-weighted against a path that hits the glowing surface (power heuristic of the library) – small glowing parts
//     (neon tubes, LEDs, screens) no longer only found by chance (noise, blotches after denoising);
//   - the caustics' photons (caustics-kernel.js: source kind `mesh`).
//
// Picking ∝ luminance of the material's emission (emissive × intensity, no map) × area → the area density at a point is
// luminance(emissive × intensity) / total, the same on the GPU from the material record alone (emitterAreaPdf – no
// triangle lookup when a path hits a glowing surface). The radiance a sample carries: emission × the mean of the
// emissive map (textureMean – a textured emitter lights its surroundings with its mean colour; the path that hits it
// sees the texel). Sides like the material (a one-sided face is not hit from behind by the path tracer: its back
// neither glows nor stops a ray).
//
// More than MAX triangles: MAX drawn ∝ power for the photons; next event estimation off (`nee` 0 – the MIS weight of a
// hit assumes every glowing triangle in the table).
//
// Table: 4 vec4 per triangle – corner + sides (0 front, 1 back, 2 both), edge 1 + luminance of the picked emission,
// edge 2 + cdf, radiance (rgb, with the map's mean).
// Uniforms: count (triangles in the table), total (Σ luminance × area), nee (1: next event estimation on).
import * as THREE from 'three/webgpu';
import { uniform, storage } from 'three/tsl';
import { wgslTagFn } from 'three-mesh-bvh/webgpu';
import { DataUtils } from 'three/webgpu';

export const MAX_EMITTERS = 65536;
// test: ?emitterNee=0 – glowing meshes found by the paths only (the reference of the next event estimation)
const NEE_OFF = new URLSearchParams(globalThis.location?.search).get('emitterNee') === '0';
// the table – one buffer for the whole page (fixed, on the GPU only once a kernel uses it); the photon kernel binds it
// through a storage node of its own
export const EMITTER_TABLE = new THREE.StorageBufferAttribute(new Float32Array(MAX_EMITTERS * 16), 4);
const tableAttribute = EMITTER_TABLE;

export const EMITTERS = {
    count: uniform(0, 'uint'),
    total: uniform(0),
    nee: uniform(0, 'uint'),
    table: storage(tableAttribute, 'vec4', MAX_EMITTERS * 4).toReadOnly().setName('rindr_emitters'),
};

/** area density of picking a point on a glowing surface with this material emission (emissive × intensity) */
export const EMITTER_AREA_PDF = wgslTagFn/* wgsl */`
    fn emitterAreaPdf( emission: vec3f ) -> f32 {

        return dot( emission, vec3f( 0.2126, 0.7152, 0.0722 ) ) / max( ${ EMITTERS.total }, 1e-30 );

    }
`;

/** next event estimation towards the glowing meshes is on */
export const EMITTER_NEE = wgslTagFn/* wgsl */`
    fn emitterNee() -> bool {

        return ${ EMITTERS.nee } != 0u && ${ EMITTERS.count } > 0u;

    }
`;

/** a glowing triangle by power (r.x), a point on it (r.yz) → xyz point, w: index into the table (as float) */
export const EMITTER_PICK = wgslTagFn/* wgsl */`
    fn emitterPick( r: vec3f ) -> u32 {

        var lo = 0u;
        var hi = ${ EMITTERS.count } - 1u;
        while ( lo < hi ) {

            let mid = ( lo + hi ) / 2u;
            if ( ${ EMITTERS.table }[ mid * 4u + 2u ].w < r.x ) { lo = mid + 1u; } else { hi = mid; }

        }
        return lo;

    }
`;

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
let halfTable = null;
const halfToFloat = () => halfTable ??= Float32Array.from({ length: 65536 }, (_, i) => DataUtils.fromHalfFloat(i));

// mean colour of a texture (linear, per texture version) – unreadable → 1
const textureMeans = new Map();
function textureMean(tex) {
    const key = `${tex.uuid}:${tex.version}`;
    if (textureMeans.has(key)) return textureMeans.get(key);
    let mean = [1, 1, 1];
    const lin = v => tex.colorSpace === THREE.SRGBColorSpace ? (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) : v;
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

/** does a material glow (as the path tracer sees it)? – kernel-features.js and the table */
export const glows = m => !!m?.emissive && !m.matte && !m.ptVolume && (m.emissiveIntensity ?? 1) * Math.max(m.emissive.r, m.emissive.g, m.emissive.b) > 1e-6;

export class EmitterTable {
    constructor(max = MAX_EMITTERS) {
        this.max = Math.min(max, MAX_EMITTERS);
        this.attribute = tableAttribute;
        this.info = null;   // { count, total, sampled, meshes: [{ center, power }] } or null (nothing glows)
        this.id = 0;        // changes with every rebuild (caustics: the photons start over)
    }

    /** collect the glowing triangles of the path tracer's scene (call once per scene version) */
    update(scene) {
        const tris = [], select = [], radiance = [], sides = [], meshes = [];
        const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), m4 = new THREE.Matrix4(), inst = new THREE.Matrix4();
        scene.updateMatrixWorld();
        scene.traverseVisible(o => {
            if (!o.isMesh || !o.geometry?.attributes?.position) return;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            if (!mats.some(glows)) return;
            const pos = o.geometry.attributes.position, index = o.geometry.index;
            const triCount = Math.floor((index ? index.count : pos.count) / 3);
            const groups = Array.isArray(o.material) && o.geometry.groups.length ? o.geometry.groups : [{ start: 0, count: triCount * 3, materialIndex: 0 }];
            const copies = o.isInstancedMesh ? o.count : 1;
            let meshPower = 0;
            const box = new THREE.Box3();
            for (let k = 0; k < copies; k++) {
                m4.copy(o.matrixWorld);
                if (o.isInstancedMesh) { o.getMatrixAt(k, inst); m4.multiply(inst); }
                for (const g of groups) {
                    const mat = mats[g.materialIndex ?? 0];
                    if (!glows(mat)) continue;
                    const k0 = mat.emissiveIntensity ?? 1;
                    const e = [mat.emissive.r * k0, mat.emissive.g * k0, mat.emissive.b * k0];
                    const lum = luminance(...e);
                    const mean = mat.emissiveMap ? textureMean(mat.emissiveMap) : [1, 1, 1];
                    const rad = [e[0] * mean[0], e[1] * mean[1], e[2] * mean[2]];
                    // sides that glow; a mirrored placement turns the winding around
                    let side = mat.side === THREE.DoubleSide ? 2 : mat.side === THREE.BackSide ? 1 : 0;
                    if (side < 2 && m4.determinant() < 0) side = 1 - side;
                    const end = Math.min(g.start + g.count, triCount * 3);
                    for (let i = g.start; i + 2 < end; i += 3) {
                        const ia = index ? index.getX(i) : i, ib = index ? index.getX(i + 1) : i + 1, ic = index ? index.getX(i + 2) : i + 2;
                        a.fromBufferAttribute(pos, ia).applyMatrix4(m4);
                        b.fromBufferAttribute(pos, ib).applyMatrix4(m4).sub(a);
                        c.fromBufferAttribute(pos, ic).applyMatrix4(m4).sub(a);
                        const area = 0.5 * b.clone().cross(c).length();
                        if (!(area > 1e-12)) continue;
                        tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
                        select.push(lum, lum * area);
                        radiance.push(...rad);
                        sides.push(side);
                        meshPower += luminance(...rad) * area;
                        box.expandByPoint(a);
                    }
                }
            }
            if (meshPower > 0) meshes.push({ center: box.getCenter(new THREE.Vector3()), power: meshPower });
        });
        const n = sides.length;
        this.id++;
        if (!n) {
            this.info = null;
            EMITTERS.count.value = 0;
            EMITTERS.nee.value = 0;
            return null;
        }
        const cum = new Float64Array(n);
        let total = 0;
        for (let i = 0; i < n; i++) { total += select[i * 2 + 1]; cum[i] = total; }
        const out = this.attribute.array;
        const write = (j, i, cdf) => {
            out.set([tris[i * 9], tris[i * 9 + 1], tris[i * 9 + 2], sides[i], tris[i * 9 + 3], tris[i * 9 + 4], tris[i * 9 + 5], select[i * 2],
                tris[i * 9 + 6], tris[i * 9 + 7], tris[i * 9 + 8], cdf, radiance[i * 3], radiance[i * 3 + 1], radiance[i * 3 + 2], 0], j * 16);
        };
        const sampled = n > this.max;
        if (!sampled) {
            for (let i = 0; i < n; i++) write(i, i, i === n - 1 ? 2 : cum[i] / total);
        } else {
            for (let j = 0; j < this.max; j++) {
                const r = Math.random() * total;
                let lo = 0, hi = n - 1;
                while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
                write(j, lo, j === this.max - 1 ? 2 : (j + 1) / this.max);
            }
        }
        this.attribute.needsUpdate = true;
        const count = sampled ? this.max : n;
        this.info = { count, total, sampled, meshes };
        EMITTERS.count.value = count;
        EMITTERS.total.value = total;
        EMITTERS.nee.value = sampled || NEE_OFF ? 0 : 1;
        return this.info;
    }

    dispose() {
        EMITTERS.count.value = 0;
        EMITTERS.nee.value = 0;
    }
}

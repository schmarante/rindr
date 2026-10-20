// Gaussian splats in the path tracer (HQ): the splats as a participating medium, like the cloud volumes. A worker bakes
// them into a density + colour grid (splat-volume-worker.js, SPLAT_GRID³ over the splats' box in their data space) and
// a coarse majorant grid (max density per SPLAT_BLOCK³ block – empty space is jumped over). A proxy box (child of the
// SplatMesh, so it follows moves; layer 31 – no raster camera draws it) carries the path tracer stand-in (ptVolume 6,
// splat-pt.js, traced by the shared volume walk volume-pt.js / volume-walk.patch.wgsl):
//  - baked (as captured): an emitting + absorbing medium – a collision adds the grid's colour and ends the path, the
//    expected value is the raster's front-to-back blending of the splats' colours
//  - relit (surface / volume, override material): a scattering medium with the colour (or the material's colour ×
//    structure) as albedo, light samples and environment like the clouds – shadows of the splats on themselves, on the
//    ground and on models come from the shadow rays through the grid (glass-shadow.patch.wgsl)
// Scans of rooms / outdoor captures (userData.environment): 160³ voxels over tens of metres are far too coarse to be
// seen – camera rays pass the grid (iridescence = 1) and the raster draws the scan over the path traced image as in
// Default (viewer.js); the grid still lights the models, shadows them and the ground and is reflected. Object splats
// (smoke, a figure) are seen as the volume.
// Fields of the stand-in (no other use on this material): color = override colour (white without), sheen = override
// on, sheenColor = glow, metalness = 1 relit / 0 baked, roughness = σ of density 1 (per world unit), clearcoat = mean
// brightness, ior = structure, anisotropy = phase g, iridescence = 1 hidden from camera rays.
import * as THREE from 'three/webgpu';
import { MeshBVH } from 'three-mesh-bvh';
import { uniform } from 'three/tsl';
import { debugLog } from '../log.js';

export const SPLAT_GRID = 160;
export const SPLAT_BLOCK = 8;
const BLOCKS = Math.ceil(SPLAT_GRID / SPLAT_BLOCK);

function grid(n, format, type, data, filter) {
    const tex = new THREE.Data3DTexture(data, n, n, n);
    tex.format = format;
    tex.type = type;
    tex.minFilter = tex.magFilter = filter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
}
// one set for the scene (one splat scene at a time) – the path tracer's kernel binds these objects (splat-pt.js)
export const SPLAT_TEXTURES = {
    density: grid(SPLAT_GRID, THREE.RedFormat, THREE.HalfFloatType, new Uint16Array(SPLAT_GRID ** 3), THREE.LinearFilter),
    color: grid(SPLAT_GRID, THREE.RGBAFormat, THREE.UnsignedByteType, new Uint8Array(SPLAT_GRID ** 3 * 4), THREE.LinearFilter),
    majorant: grid(BLOCKS, THREE.RedFormat, THREE.HalfFloatType, new Uint16Array(BLOCKS ** 3), THREE.NearestFilter),
};

// the scene's splat volume for the path tracer's shared volume walk (volume-pt.js, with the cloud volumes): world → box
// matrix, σ, look; primary = seen by camera rays (object splats; scans are drawn by the raster). Set by
// sync()/updateUniforms() – active only while the splats are shown (hidden ones stayed inside cloud boxes before).
export const SPLAT_UNIFORMS = {
    active: uniform(0), inverse: uniform(new THREE.Matrix4()), sigma: uniform(0), relit: uniform(0), override: uniform(0),
    tint: uniform(new THREE.Color(1, 1, 1)), glow: uniform(new THREE.Color(0, 0, 0)), mean: uniform(0.2), detail: uniform(1),
    primary: uniform(1),
};

const BOX = new THREE.BoxGeometry(1, 1, 1);
BOX.boundsTree = new MeshBVH(BOX);   // the path tracer needs it before setScene

export class SplatVolume {
    constructor() {
        this.material = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
        this.material.name = 'Gaussian Splats (path tracer)';
        this.material.allowOverride = false;
        this.proxy = new THREE.Mesh(BOX, this.material);
        this.proxy.name = 'Gaussian splat volume';
        this.proxy.layers.set(31);   // the path tracer only (it ignores layers); no raster camera, no picking
        this.proxy.frustumCulled = false;
        this.proxy.visible = false;  // until baked
        this.splat = null;
        this.sigma = 0;              // per data unit
        this.ready = false;
        this.baking = null;          // Promise while the worker runs
        this._standIn({});
    }

    /** the splats of the scene (null: none) – the volume is baked again on the next ensure() */
    attach(splat) {
        SPLAT_UNIFORMS.active.value = 0;
        this.proxy.removeFromParent();
        this.splat = splat;
        this.ready = false;
        this.proxy.visible = false;
        this.baking = null;
        if (splat) splat.add(this.proxy);
    }

    /**
     * Bake if not done yet (first HQ frame). Resolves true once the volume is ready.
     * @param {THREE.WebGPURenderer} renderer  reads the splats' shape data back from the GPU (the CPU copy is dropped
     *   after the first frames)
     * @param {(fraction: number) => void} [onProgress]  share done 0…1 (worker)
     */
    ensure(renderer, onProgress) {
        if (this.ready) return Promise.resolve(true);
        if (!this.splat || this.splat.loading) return Promise.resolve(false);
        this.onProgress = onProgress ?? null;
        return (this.baking ??= this._bake(renderer).catch(err => { console.error('[Splats] volume bake failed', err); this.baking = null; return false; }));
    }

    async _bake(renderer) {
        const splat = this.splat;
        const t0 = performance.now();
        const b = splat.data.b ?? new Uint32Array(await renderer.getArrayBufferAsync(splat.attrs.b));
        if (splat !== this.splat) return false;
        // grid box: all splats, far floaters capped at 5× the robust core (data space)
        const core = splat.geometry.boundingBox, center = core.getCenter(new THREE.Vector3()), half = core.getSize(new THREE.Vector3()).multiplyScalar(2.5);
        const box = splat.fullBox.clone().intersect(new THREE.Box3(center.clone().sub(half), center.clone().add(half)));
        const result = await new Promise((resolve, reject) => {
            const worker = new Worker(new URL('./splat-volume-worker.js', import.meta.url), { type: 'module' });
            worker.onmessage = e => {
                if (e.data.progress !== undefined) { this.onProgress?.(e.data.progress); return; }
                worker.terminate();
                resolve(e.data);
            };
            worker.onerror = e => { worker.terminate(); reject(e.error ?? new Error(e.message)); };
            worker.postMessage({ a: splat.data.a, b, count: splat.count, min: box.min.toArray(), max: box.max.toArray(), n: SPLAT_GRID, block: SPLAT_BLOCK });
        });
        if (splat !== this.splat) return false;
        SPLAT_TEXTURES.density.image.data = result.density;
        SPLAT_TEXTURES.color.image.data = result.color;
        SPLAT_TEXTURES.majorant.image.data = result.majorant;
        for (const tex of Object.values(SPLAT_TEXTURES)) tex.needsUpdate = true;
        this.sigma = result.sigma;
        box.min.fromArray(result.min);   // narrowed to where the splats' mass is (worker)
        box.max.fromArray(result.max);
        box.getCenter(this.proxy.position);
        box.getSize(this.proxy.scale);
        this.proxy.updateMatrixWorld(true);
        this.proxy.visible = true;
        this.ready = true;
        this.sync();
        debugLog(`[Splats] path tracer volume ${SPLAT_GRID}³ baked in ${Math.round(performance.now() - t0)} ms (σ max ${result.sigma.toPrecision(3)} per data unit)`);
        return true;
    }

    /** stand-in values from the splats' look and scale (call before the path tracer packs its materials) */
    sync() {
        const splat = this.splat;
        if (!splat) return;
        splat.updateWorldMatrix(true, false);
        const scale = new THREE.Vector3().setFromMatrixScale(splat.matrixWorld);
        const worldPerData = (Math.abs(scale.x) + Math.abs(scale.y) + Math.abs(scale.z)) / 3 || 1;
        const look = splat.look;
        this._standIn({ relit: look.mode !== 'baked', material: look.material, meanLuma: look.meanLuma.value, sigma: this.sigma / worldPerData,
            primary: this.primary });
        const pt = this.material.userData.ptStandIn, u = SPLAT_UNIFORMS;
        u.sigma.value = pt.roughness;
        u.relit.value = pt.metalness;
        u.override.value = pt.sheen;
        u.tint.value.setRGB(pt.color.r, pt.color.g, pt.color.b);
        u.glow.value.setRGB(pt.sheenColor.r, pt.sheenColor.g, pt.sheenColor.b);
        u.mean.value = pt.clearcoat;
        u.detail.value = pt.ior;
        u.primary.value = this.primary ? 1 : 0;
        this.updateUniforms();
    }

    /** per frame in HQ: where the volume is and whether it is shown (the volume walk reads it through uniforms) */
    updateUniforms() {
        const u = SPLAT_UNIFORMS;
        let shown = this.ready && this.proxy.visible;
        for (let o = this.splat; o && shown; o = o.parent) shown = o.visible;   // hidden in the Scene Graph: a parent
        u.active.value = shown ? 1 : 0;
        if (!u.active.value) return;
        this.proxy.updateWorldMatrix(true, false);
        u.inverse.value.copy(this.proxy.matrixWorld).invert();
    }

    /** the grid is seen by the camera (object splats); scans are drawn by the raster over the path traced image */
    get primary() {
        return !this.splat?.userData.environment;
    }

    _standIn({ relit = false, material = null, meanLuma = 0.2, sigma = 0, primary = true }) {
        const tint = new THREE.Color(material?.color ?? '#ffffff');
        const glow = new THREE.Color(material?.emissive ?? '#000000').multiplyScalar(material?.emissiveIntensity ?? 1);
        this.material.userData.ptStandIn = {
            ptVolume: 6, color: { r: tint.r, g: tint.g, b: tint.b }, sheen: material ? 1 : 0, sheenColor: { r: glow.r, g: glow.g, b: glow.b },
            metalness: relit ? 1 : 0, roughness: sigma, clearcoat: Math.max(meanLuma, 1e-3), ior: material?.detail ?? 1, anisotropy: 0,
            iridescence: primary ? 0 : 1, transmission: 0, side: THREE.DoubleSide,
        };
    }
}

// Grid volumes: participating media from voxel grids – smoke, clouds, fire (pbrt "nanovdb" / "uniformgrid" media; the
// OpenVDB family). Built for the path tracer's shared volume walk (volume-pt.js, volume-walk.patch.wgsl) like the cloud
// material's volumes:
//  - data: per volume a dense 8-bit grid (density / its maximum, temperature / its maximum for fire) in one 3D texture
//    atlas (volumes stacked along z, RG), and per block of 8³ samples the largest density (majorant atlas, R) – the walk
//    jumps empty blocks and samples dense ones with their own bound instead of the whole volume's
//  - proxy: a unit box per volume (matrix: unit box → model space, mm), placed under its model root every frame; the
//    path tracer sees it as a volume box (stand-in ptVolume 3) and tracks the medium inside from GRID_MEDIA
//  - medium: grey extinction (σt at the grid's maximum, per world unit), RGB single-scattering albedo, Henyey-Greenstein
//    g, emission from temperature (pbrt: σa · Lescale · blackbody, table over the stored temperature – GRID_EMISSION)
//  - raster: ray march through the box (density, emission, an ambient and one key light with a short shadow march) –
//    a preview; HQ is the real thing
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, texture3D, vec2, vec3, vec4, float, If, Loop, Break, max, min, exp, clamp, dot, normalize, mix, floor, fract,
    positionWorld, cameraPosition, modelWorldMatrixInverse, screenCoordinate } from 'three/tsl';
import { MeshBVH } from 'three-mesh-bvh';
import { DataUtils } from 'three/webgpu';
import { hideInOverridePasses } from '../materials/override-hide.js';

export const GRID_SLOTS = 2;                 // grid volumes at the same time
export const GRID_BLOCK = 8;                 // samples per majorant block (volumes/nanovdb.js BLOCK)
export const GRID_EMISSION_STEPS = 32;       // entries of the emission table over the stored temperature
const RASTER_STEPS = 96, RASTER_LIGHT_STEPS = 4;

function texture3DOf(data, w, h, d, format) {
    const t = new THREE.Data3DTexture(data, w, h, d);
    t.format = format;
    t.type = THREE.UnsignedByteType;
    t.minFilter = t.magFilter = format === THREE.RedFormat ? THREE.NearestFilter : THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    return t;
}
function emissionTexture(data) {
    const t = new THREE.DataTexture(data, GRID_EMISSION_STEPS, GRID_SLOTS, THREE.RGBAFormat, THREE.HalfFloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
}

// shared textures (raster materials and the path tracer's kernel read the same objects); set() replaces their images
// – the objects stay, nodes built on them keep working
export const GRID_TEXTURES = {
    atlas: texture3DOf(new Uint8Array(2), 1, 1, 1, THREE.RGFormat),
    blocks: texture3DOf(new Uint8Array(1), 1, 1, 1, THREE.RedFormat),
    emission: emissionTexture(new Uint16Array(GRID_EMISSION_STEPS * GRID_SLOTS * 4)),
};
function replaceImage(tex, data, width, height, depth = undefined) {
    tex.dispose();   // the GPU copy has the old size
    tex.image = depth === undefined ? { data, width, height } : { data, width, height, depth };
    tex.needsUpdate = true;
}
export const GRID_ATLAS = uniform(new THREE.Vector4(1, 1, 1, 0));   // atlas texels W, H, D
// per volume: world → unit box; (σt per world unit at the grid's maximum, g, emissive 0/1, shown 0/1); albedo;
// sample dims; atlas (z offset, block z offset, –, –); block dims
export const GRID_MEDIA = Array.from({ length: GRID_SLOTS }, () => ({
    inverse: uniform(new THREE.Matrix4()), params: uniform(new THREE.Vector4()), albedo: uniform(new THREE.Vector4(1, 1, 1, 0)),
    dims: uniform(new THREE.Vector3(1, 1, 1)), offset: uniform(new THREE.Vector4()), blockDims: uniform(new THREE.Vector3(1, 1, 1)),
}));

// --- raster (TSL): density and temperature in a volume's box ---
function sampleGrid(m, local) {
    const u = local.x.add(0.5).mul(m.dims.x).div(GRID_ATLAS.x);
    const v = local.y.add(0.5).mul(m.dims.y).div(GRID_ATLAS.y);
    const w = clamp(local.z.add(0.5).mul(m.dims.z), 0.5, m.dims.z.sub(0.5)).add(m.offset.x).div(GRID_ATLAS.z);
    return texture3D(GRID_TEXTURES.atlas, vec3(u, v, w)).rg;
}
function emissionAt(slot, t) {
    const x = t.mul(GRID_EMISSION_STEPS - 1);
    const i = floor(x), f = fract(x);
    const row = (slot + 0.5) / GRID_SLOTS;
    const a = texture(GRID_TEXTURES.emission, vec2(i.add(0.5).div(GRID_EMISSION_STEPS), row)).rgb;
    const b = texture(GRID_TEXTURES.emission, vec2(min(i.add(1.5), GRID_EMISSION_STEPS - 0.5).div(GRID_EMISSION_STEPS), row)).rgb;
    return mix(a, b, f);
}
// light for the raster preview: ambient radiance, key light (direction towards it, irradiance)
const rasterLight = { ambient: uniform(new THREE.Color(0.5, 0.5, 0.5)), dir: uniform(new THREE.Vector3(0.3, 1, 0.2).normalize()), color: uniform(new THREE.Color(1, 1, 1)) };

function gridNode(slot) {
    const m = GRID_MEDIA[slot];
    return Fn(() => {
        const ro = cameraPosition, rd = normalize(positionWorld.sub(cameraPosition));
        const lo = modelWorldMatrixInverse.mul(vec4(ro, 1)).xyz;
        const ld = modelWorldMatrixInverse.mul(vec4(rd, 0)).xyz;
        const inv = vec3(1).div(ld.add(1e-12));
        const t0 = vec3(-0.5).sub(lo).mul(inv), t1 = vec3(0.5).sub(lo).mul(inv);
        const tNear = max(max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z)), 0).toVar();
        const tFar = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z)).toVar();
        const dt = max(tFar.sub(tNear), 0).div(RASTER_STEPS).toVar();
        const sigma = m.params.x.toVar(), albedo = m.albedo.xyz.toVar();
        const jitter = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189));
        const t = tNear.add(dt.mul(jitter)).toVar();
        const transmittance = float(1).toVar(), color = vec3(0).toVar();
        const L = rasterLight.dir, lightLocal = modelWorldMatrixInverse.mul(vec4(L, 0)).xyz.toVar();
        const upLocal = modelWorldMatrixInverse.mul(vec4(0, 1, 0, 0)).xyz.toVar();
        Loop(RASTER_STEPS, () => {
            If(t.greaterThanEqual(tFar).or(transmittance.lessThan(0.005)), () => { Break(); });
            const local = lo.add(ld.mul(t)).toVar();
            const s = sampleGrid(m, local).toVar();
            If(s.x.greaterThan(0.0005), () => {
                const absorb = exp(s.x.mul(sigma).mul(dt).negate());
                // key light: optical depth towards it through the box (doubling steps)
                const tau = float(0).toVar();
                const reach = float(0.02).toVar(), from = float(0).toVar();
                Loop(RASTER_LIGHT_STEPS, () => {
                    const pl = local.add(lightLocal.mul(from.add(reach.mul(0.5)).div(max(dot(lightLocal, lightLocal), 1e-12).sqrt())));
                    tau.addAssign(sampleGrid(m, pl).x.mul(reach));
                    from.addAssign(reach);
                    reach.mulAssign(2);
                });
                // tau in box units → world: the box's size along the light ≈ 1 / |lightLocal|
                // light scattered many times seen as octaves of ever weaker extinction (as the cloud material's preview):
                // bright soft insides of white clouds, dark smoke stays dark (weights × albedo)
                const tauKey = tau.mul(sigma).div(max(dot(lightLocal, lightLocal), 1e-12).sqrt()).toVar();
                const a = albedo.x;
                const key = rasterLight.color.mul(exp(tauKey.negate()).add(exp(tauKey.mul(-0.25)).mul(a.mul(0.6))).add(exp(tauKey.mul(-0.06)).mul(a.mul(a).mul(0.4)))).mul(1 / (4 * Math.PI));
                // ambient from the sky: dimmed by the medium above (the same doubling steps upwards) and by the albedo's
                // multiple scattering – dark smoke stays dark, a white cloud's core light (HQ: many scatterings)
                const tauUp = float(0).toVar();
                const reachUp = float(0.02).toVar(), fromUp = float(0).toVar();
                Loop(RASTER_LIGHT_STEPS, () => {
                    const pu = local.add(upLocal.mul(fromUp.add(reachUp.mul(0.5)).div(max(dot(upLocal, upLocal), 1e-12).sqrt())));
                    tauUp.addAssign(sampleGrid(m, pu).x.mul(reachUp));
                    fromUp.addAssign(reachUp);
                    reachUp.mulAssign(2);
                });
                const tauAmb = tauUp.mul(sigma).div(max(dot(upLocal, upLocal), 1e-12).sqrt()).mul(float(1).sub(albedo.x.mul(0.9))).toVar();
                // plus a soft share (ground bounce, light scattered round the cloud – HQ lights undersides too)
                const ambient = rasterLight.ambient.mul(exp(tauAmb.negate()).mul(0.7).add(exp(tauAmb.mul(-0.12)).mul(0.3)));
                const scattered = key.add(ambient).mul(albedo);
                const emitted = m.params.z.greaterThan(0.5).select(emissionAt(slot, s.y).mul(vec3(1).sub(albedo)), vec3(0));
                color.addAssign(scattered.add(emitted).mul(float(1).sub(absorb)).mul(transmittance));
                transmittance.mulAssign(absorb);
            });
            t.addAssign(dt);
        });
        return vec4(color, transmittance.oneMinus());
    })();
}

function gridMaterial(slot) {
    const material = new THREE.MeshBasicNodeMaterial({ side: THREE.FrontSide, transparent: true, depthWrite: false, depthTest: true });
    const result = gridNode(slot);
    material.colorNode = result.rgb.div(max(result.a, 1e-4));
    material.opacityNode = result.a;
    material.userData.noBatch = true;
    material.allowOverride = false;
    // path tracer: the box marks a volume (volume walk); the medium comes from GRID_MEDIA
    material.userData.ptStandIn = { ptVolume: 3, transmission: 0, side: THREE.DoubleSide, color: { r: 1, g: 1, b: 1 } };
    return material;
}

/**
 * The grid volumes of the loaded models. set(volumes, root): volumes as the importer delivers them (see pbrt-import.js
 * `result.volumes`), placed in `root`'s space.
 */
export class GridVolumeSystem {
    constructor(scene, renderer) {
        this.group = new THREE.Group();
        this.group.name = 'grid volumes';
        scene.add(this.group);
        const box = new THREE.BoxGeometry(1, 1, 1);
        box.boundsTree = new MeshBVH(box);   // the path tracer needs it before setScene
        this.slots = Array.from({ length: GRID_SLOTS }, (_, k) => {
            const mesh = new THREE.Mesh(box, gridMaterial(k));
            mesh.visible = false;
            mesh.renderOrder = 10;
            mesh.frustumCulled = false;
            mesh.matrixAutoUpdate = false;
            mesh.userData.gridVolumeProxy = true;
            this.group.add(mesh);
            return { mesh, volume: null, root: null, local: new THREE.Matrix4() };
        });
        hideInOverridePasses(renderer, this.group, { keepPlain: true });
        this.onChange = null;   // proxies appeared/disappeared (path tracer: scene, materials)
    }

    get active() { return this.slots.some(s => s.volume); }

    /** the volumes of a model (replaces those of the same root; null/[] removes them) */
    set(volumes, root) {
        for (const s of this.slots) if (s.root === root || !root) { s.volume = null; s.root = null; }
        for (const v of volumes || []) {
            const s = this.slots.find(x => !x.volume);
            if (!s) { console.warn(`Grid volumes: only ${GRID_SLOTS} at a time`); break; }
            s.volume = v;
            s.root = root;
            s.local.fromArray(v.matrix);
        }
        this._upload();
        this.onChange?.();
    }

    clear() { this.set([], null); }

    // atlas: the volumes stacked along z (RG: density, temperature), the majorant blocks likewise (R)
    _upload() {
        const used = this.slots.filter(s => s.volume);
        const W = Math.max(1, ...used.map(s => s.volume.dims[0])), H = Math.max(1, ...used.map(s => s.volume.dims[1]));
        const D = Math.max(1, used.reduce((a, s) => a + s.volume.dims[2], 0));
        const BW = Math.max(1, ...used.map(s => s.volume.blockDims[0])), BH = Math.max(1, ...used.map(s => s.volume.blockDims[1]));
        const BD = Math.max(1, used.reduce((a, s) => a + s.volume.blockDims[2], 0));
        const atlas = new Uint8Array(W * H * D * 2), blocks = new Uint8Array(BW * BH * BD);
        const emission = new Uint16Array(GRID_EMISSION_STEPS * GRID_SLOTS * 4);
        let z = 0, bz = 0;
        this.slots.forEach((s, k) => {
            const m = GRID_MEDIA[k], v = s.volume;
            if (!v) { m.albedo.value.w = 0; m.params.value.w = 0; s.mesh.visible = false; return; }
            const [nx, ny, nz] = v.dims;
            for (let zz = 0; zz < nz; zz++) for (let y = 0; y < ny; y++) {
                const src = (zz * ny + y) * nx, dst = ((z + zz) * H + y) * W;
                for (let x = 0; x < nx; x++) {
                    atlas[2 * (dst + x)] = v.density[src + x];
                    if (v.temperature) atlas[2 * (dst + x) + 1] = v.temperature[src + x];
                }
            }
            const [bx, by, bzn] = v.blockDims;
            for (let zz = 0; zz < bzn; zz++) for (let y = 0; y < by; y++) blocks.set(v.blocks.subarray((zz * by + y) * bx, (zz * by + y + 1) * bx), ((bz + zz) * BH + y) * BW);
            m.dims.value.set(nx, ny, nz);
            m.blockDims.value.set(bx, by, bzn);
            m.offset.value.set(z, bz, 0, 0);
            m.params.value.set(v.sigma, v.g, v.emission ? 1 : 0, 1);
            m.albedo.value.set(v.albedo[0], v.albedo[1], v.albedo[2], 1);
            if (v.emission) for (let i = 0; i < GRID_EMISSION_STEPS; i++) for (let c = 0; c < 3; c++) emission[(k * GRID_EMISSION_STEPS + i) * 4 + c] = DataUtils.toHalfFloat(v.emission[3 * i + c]);
            z += nz;
            bz += bzn;
            s.mesh.visible = true;
        });
        replaceImage(GRID_TEXTURES.atlas, atlas, W, H, D);
        replaceImage(GRID_TEXTURES.blocks, blocks, BW, BH, BD);
        replaceImage(GRID_TEXTURES.emission, emission, GRID_EMISSION_STEPS, GRID_SLOTS);
        GRID_ATLAS.value.set(W, H, D, 0);
    }

    /** every frame: proxies under their model roots (moved, hidden), the uniforms of the volume walk */
    update(light = null) {
        if (light) {
            rasterLight.ambient.value.copy(light.ambient);
            rasterLight.dir.value.copy(light.dir);
            rasterLight.color.value.copy(light.color);
        }
        this.slots.forEach((s, k) => {
            const m = GRID_MEDIA[k];
            if (!s.volume) return;
            let shown = !!s.root?.parent;
            for (let o = s.root; o && shown; o = o.parent) shown = o.visible;
            if (shown !== s.mesh.visible) { s.mesh.visible = shown; this.onChange?.(); }
            m.params.value.w = shown ? 1 : 0;
            m.albedo.value.w = shown ? 1 : 0;
            if (!shown) return;
            s.root.updateWorldMatrix(true, false);
            s.mesh.matrix.multiplyMatrices(s.root.matrixWorld, s.local);
            s.mesh.matrixWorld.copy(s.mesh.matrix);
            m.inverse.value.copy(s.mesh.matrixWorld).invert();
            // camera inside the box: back faces (the front ones are behind it)
            if (light?.camera) {
                const local = _p.copy(light.camera.position).applyMatrix4(m.inverse.value);
                const inside = Math.max(Math.abs(local.x), Math.abs(local.y), Math.abs(local.z)) < 0.5 + 1e-3;
                const side = inside ? THREE.BackSide : THREE.FrontSide;
                if (s.mesh.material.side !== side) { s.mesh.material.side = side; s.mesh.material.depthTest = !inside; s.mesh.material.needsUpdate = true; }
            }
        });
    }
}
const _p = new THREE.Vector3();

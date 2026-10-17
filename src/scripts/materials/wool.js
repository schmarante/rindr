// Wool material (wish of the user: "so richtig flauschige Wolle"). Raster: shell fur – every mesh with a wool material
// gets WOOL_SHELLS copies of itself pushed out along its normals (one InstancedMesh, the instance index is the layer);
// each layer shows only the cross-sections of the fibres there: object-space cells (strand per cell, random place,
// height and tint), the fibres taper towards their tips, bend a little and are darker at the roots (light hardly
// reaches between them); coverage dithered per pixel (soft edges, fuzzy fringe); far away the fibres' mean coverage
// instead of single sub-pixel fibres (flicker). Lit like the material (sheen for the fabric shimmer).
// Path tracer: the same shells and fibres, intersected inside the BVH traversal (wool-pt.js, Vite plugin rindr-wool) –
// the material carries ptVolume 4 and the fibre length (world units) in its stand-in; the raster's shell meshes are
// left out there (userData.ptHidden). Fibre length = woolLength × scene size (the same look for mm and m models).
// Shells only in the normal colour image (override-hide.js).
import * as THREE from 'three/webgpu';
import { Fn, uniform, float, vec3, uvec3, ivec3, uint, varying, instanceIndex, positionLocal, normalLocal, positionGeometry, modelScale, smoothstep, length, max, mix, select, fwidth, clamp, fract, dot, vec2, screenCoordinate } from 'three/tsl';
import { hideInOverridePasses } from './override-hide.js';

export const WOOL_SHELLS = 24;
// perLength: fibre cells per fibre length (thin, dense fibres); curl: sideways bend of a fibre over its length (cells)
// – crimped, tangled; radius: fibre radius at the root (cells). Shared with the path tracer (wool-pt.js)
export const WOOL_FIBRE = { perLength: 7, curl: 2.2, radius: 0.62 };
// colour of the fibres from root to tip (× material colour; light hardly reaches the roots) and their sheen colour
// (× fibre colour) – the surface below has the roots' colour (toon.js), the same in the path tracer (wool-pt.js)
// path tracer: fibre colour × through (real fibres let light through, the opaque ones of the path tracer shadowed the
// fur much darker than the colour chosen)
export const WOOL_SHADE = { root: 0.82, tip: 1.05, sheen: 1.2, through: 1.6 };
// geometry → fibre length in its own units (with headroom) that its BVH bounds hold for the path tracer (wool-bounds.js)
export const WOOL_GEOMETRIES = new Map();
const BOUNDS_HEADROOM = 1.25;   // scaling the object a little does not rebuild the path tracer's scene

// wool parameters of a material (RindrMaterial.setWool) or null
const woolOf = material => (material && !Array.isArray(material) ? material.userData?.wool ?? null : null);

// integer hash of a cell (pcg3d, Jarzynski & Olano 2020) → 0…1 – the same as rindrWoolHash in wool-pt.js (soap.js too)
export const woolHash = Fn(([c]) => {
    const v = uvec3(ivec3(c)).toVar();
    v.assign(v.mul(uint(1664525)).add(uint(1013904223)));
    v.x.addAssign(v.y.mul(v.z));
    v.y.addAssign(v.z.mul(v.x));
    v.z.addAssign(v.x.mul(v.y));
    v.assign(v.bitXor(v.shiftRight(uvec3(16))));
    v.x.addAssign(v.y.mul(v.z));
    v.y.addAssign(v.z.mul(v.x));
    v.z.addAssign(v.x.mul(v.y));
    return vec3(v).mul(1 / 4294967296);
});

// value noise from the hash, −1…1 per channel – the same as rindrWoolNoise in wool-pt.js (soap.js too)
export const woolNoise = Fn(([p]) => {
    const i = p.floor().toVar();
    const t = p.sub(i);
    const s = t.mul(t).mul(t.mul(-2).add(3));
    const corner = (x, y, z) => woolHash(i.add(vec3(x, y, z)));
    const x0 = mix(corner(0, 0, 0), corner(1, 0, 0), s.x);
    const x1 = mix(corner(0, 1, 0), corner(1, 1, 0), s.x);
    const x2 = mix(corner(0, 0, 1), corner(1, 0, 1), s.x);
    const x3 = mix(corner(0, 1, 1), corner(1, 1, 1), s.x);
    return mix(mix(x0, x1, s.y), mix(x2, x3, s.y), s.z).mul(2).sub(1);
});

/** Shell material of a wool material: its colour/sheen, fibre length (world units) as uniforms */
function shellMaterial() {
    const u = { length: uniform(1), color: uniform(new THREE.Color(1, 1, 1)) };
    const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 1, metalness: 0, sheen: 1, sheenRoughness: 0.6 });
    // layer 1…N / N, the same for the whole layer
    const layer = varying(float(instanceIndex).add(1).div(WOOL_SHELLS));
    m.positionNode = positionLocal.add(normalLocal.mul(u.length.mul(layer).div(max(modelScale.x, 1e-6))));
    const strand = Fn(() => {
        const cellSize = u.length.div(WOOL_FIBRE.perLength).div(max(modelScale.x, 1e-6));
        // base position (the same in every layer → straight fibres), bent a little with the height
        const bend = woolNoise(positionGeometry.div(cellSize.mul(3)).add(layer.mul(1.7))).mul(layer.mul(WOOL_FIBRE.curl));
        const p = positionGeometry.div(cellSize).add(bend);
        const cell = p.floor();
        const rnd = woolHash(cell);
        const centre = rnd.mul(0.5).add(0.25);
        const height = rnd.x.mul(0.5).add(0.5);                  // fibres of different length
        const radius = float(WOOL_FIBRE.radius).mul(float(1).sub(layer.div(height)).max(1e-6).pow(0.8));   // tapering towards the tip
        const d = length(p.sub(cell).sub(centre));
        const fibre = smoothstep(radius, radius.mul(0.6), d).mul(select(layer.lessThanEqual(height), 1, 0));
        // fibres thinner than about a pixel: their average coverage instead (single fibres flickered as noise) –
        // area of the mean cross-section (fibre heights 0.5…1)
        const lod = smoothstep(0.55, 1.4, length(fwidth(p))).mul(0.7);
        const mean = float(WOOL_FIBRE.radius).mul(clamp(float(1).sub(layer.div(0.75)), 0, 1).pow(0.8));
        const coverage = clamp(mean.mul(mean).mul(Math.PI), 0, 1);
        return vec3(mix(fibre, coverage, lod), rnd.y, rnd.z);
    })();
    // coverage as a dither per pixel, the pattern shifted per layer (interleaved gradient noise): soft fibre edges and
    // a fuzzy fringe – alpha to coverage did not blend here (everything above the alpha test was solid: felt)
    const dither = fract(fract(dot(screenCoordinate.xy.add(vec2(layer.mul(37.1), layer.mul(17.3))), vec2(0.06711056, 0.00583715))).mul(52.9829189));
    m.maskNode = strand.x.greaterThan(dither);
    // darker at the roots, a little tint per fibre
    m.colorNode = u.color.mul(mix(float(WOOL_SHADE.root), float(WOOL_SHADE.tip), layer)).mul(strand.y.mul(0.16).add(0.92));
    m.sheenNode = m.colorNode.mul(WOOL_SHADE.sheen);
    m.userData.woolUniforms = u;
    return m;
}

export class WoolSystem {
    /**
     * @param {THREE.Scene} scene
     * @param {() => THREE.Object3D[]} getRoots  model roots (meshes with wool materials)
     * @param {() => number} getScale  scene size (fibre length = woolLength × it)
     */
    constructor(scene, getRoots, getScale) {
        this.getRoots = getRoots;
        this.getScale = getScale;
        this.group = new THREE.Group();
        this.group.name = 'wool';
        scene.add(this.group);
        this.shells = new Map();      // source mesh → shell InstancedMesh
        this.woolMeshes = new Map();  // every mesh with a wool material → smallest scale of its instances
        this.materials = new Map();   // wool material → shell material
        this._scan = true;
    }

    attach(renderer) {
        hideInOverridePasses(renderer, this.group);
    }

    /** materials or assignments changed – search again on the next update */
    invalidate() {
        this._scan = true;
    }

    /**
     * every frame: shells follow their meshes (transform, visibility), colour/length from the material; the path
     * tracer's stand-in (fibre length) kept up to date – onChange() when it changed (material data), onBounds() when
     * its BVH bounds must grow or shrink (scene rebuild)
     */
    update() {
        if (this._scan) this._rescan();
        const scale = this.getScale();
        let changed = false;
        for (const [material, shell] of this.materials) {
            const wool = woolOf(material);
            if (!wool) continue;
            const length = wool.length * scale;
            shell.userData.woolUniforms.length.value = length;
            shell.userData.woolUniforms.color.value.copy(material.color);
            changed = setStandIn(material, length) || changed;
        }
        if (changed) this.onChange?.();
        for (const [mesh, shell] of this.shells) {
            shell.visible = isShown(mesh);
            if (shell.visible) shell.matrix.copy(mesh.matrixWorld);
        }
        if (this._updateBounds(scale)) this.onBounds?.();
    }

    // fibre length each wool geometry needs in its own units (the most of its meshes; the smallest scale axis) –
    // true when the path tracer's BVH bounds no longer fit (onBounds: rebuild its scene)
    _updateBounds(scale) {
        const need = new Map();
        for (const [mesh, instanceScale] of this.woolMeshes) {
            const wool = woolOf(mesh.material);
            if (!wool) continue;
            const local = wool.length * scale / Math.max(minScale(mesh.matrixWorld) * instanceScale, 1e-9);
            need.set(mesh.geometry, Math.max(need.get(mesh.geometry) ?? 0, local));
        }
        let stale = need.size !== WOOL_GEOMETRIES.size;
        for (const [geometry, local] of need) {
            const have = WOOL_GEOMETRIES.get(geometry);
            if (have === undefined || local > have || local < have / (BOUNDS_HEADROOM * BOUNDS_HEADROOM)) stale = true;
        }
        if (!stale) return false;
        WOOL_GEOMETRIES.clear();
        for (const [geometry, local] of need) WOOL_GEOMETRIES.set(geometry, local * BOUNDS_HEADROOM);
        return true;
    }

    _rescan() {
        this._scan = false;
        const found = new Set();
        // every wool mesh with the smallest scale of its instances (path tracer bounds); instanced meshes (repeated
        // parts) get no raster shells yet – the path tracer shows their fibres
        this.woolMeshes = new Map();
        for (const root of this.getRoots()) {
            root?.traverse(o => {
                if (!o.isMesh || o.isBatchedMesh || o.userData.animationPuppet || !woolOf(o.material)) return;
                this.woolMeshes.set(o, o.isInstancedMesh ? instanceMinScale(o) : 1);
                if (o.isInstancedMesh) return;
                found.add(o);
                const existing = this.shells.get(o);
                const shellMat = this._shellMaterial(o.material);
                if (existing) { existing.material = shellMat; return; }
                const shell = new THREE.InstancedMesh(o.geometry, shellMat, WOOL_SHELLS);
                shell.matrixAutoUpdate = false;
                shell.frustumCulled = o.frustumCulled;
                shell.castShadow = false;
                shell.receiveShadow = true;
                shell.raycast = () => {};          // picking: the mesh itself
                shell.userData.ptHidden = true;    // path tracer: no shells
                this.group.add(shell);
                this.shells.set(o, shell);
            });
        }
        for (const [mesh, shell] of this.shells) {
            if (found.has(mesh)) continue;
            this.group.remove(shell);
            shell.dispose();
            this.shells.delete(mesh);
        }
        for (const [material, shellMat] of this.materials) {
            if ([...this.shells.values()].some(s => s.material === shellMat)) continue;
            shellMat.dispose();
            this.materials.delete(material);
        }
    }

    _shellMaterial(material) {
        let m = this.materials.get(material);
        if (!m) {
            m = shellMaterial();
            this.materials.set(material, m);
        }
        return m;
    }

    /**
     * Material preview (material-thumbs.js): the sphere with its wool, or null. Fibre length relative to the sphere;
     * dispose with userData.dispose()
     */
    previewFor(material, radius) {
        const wool = woolOf(material);
        if (!wool) return null;
        const group = new THREE.Group();
        const geometry = new THREE.SphereGeometry(radius * 0.88, 96, 64);
        const base = new THREE.Mesh(geometry, material);
        const shellMat = shellMaterial();
        shellMat.userData.woolUniforms.length.value = radius * 0.12;
        shellMat.userData.woolUniforms.color.value.copy(material.color);
        const shell = new THREE.InstancedMesh(geometry, shellMat, WOOL_SHELLS);
        group.add(base, shell);
        group.userData.dispose = () => { geometry.dispose(); shellMat.dispose(); shell.dispose(); };
        return group;
    }
}

// path tracer: ptVolume 4 = wool (wool-pt.js), the fibre length (world units) in the iridescence thickness (iridescence
// off for wool) – true when something changed. Other stand-in fields (subsurface …) stay.
function setStandIn(material, length) {
    const pt = material.userData.ptStandIn;
    if (pt?.ptVolume === 4 && pt.iridescenceThicknessRange?.[0] === length) return false;
    material.userData.ptStandIn = Object.assign(pt ?? {}, { ptVolume: 4, iridescence: 0, iridescenceThicknessRange: [length, 0] });
    return true;
}

const _m = new THREE.Matrix4();
function minScale(m) {
    const e = m.elements;
    return Math.min(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
}
function instanceMinScale(mesh) {
    let s = Infinity;
    for (let i = 0; i < mesh.count; i++) s = Math.min(s, minScale(mesh.getMatrixAt(i, _m)));
    return Number.isFinite(s) ? s : 1;
}

function isShown(o) {
    for (let c = o; c; c = c.parent) if (!c.visible) return false;
    return true;
}

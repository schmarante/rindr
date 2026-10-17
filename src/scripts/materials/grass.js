// Grass material (wish of the user: grass "dieses Mal mit Geometrie" – real blades, not shells like the wool). Every
// mesh with a grass material gets a mesh of blades (grass-field.js; built with its BVH in grass-worker.js) that follows
// it (transform, visibility, instances of repeated parts). The raster draws it like any mesh, the path tracer traces
// it like any mesh – one look for both. The surface below takes a dark shade of the grass colour (soil between the
// blades, toon.js setGrass; path tracer: stand-in colour).
// Blade height = grassHeight × scene size; the number of blades follows the device's memory budget (memory-budget.js),
// shared out over the grass surfaces by area – above it fewer, wider blades.
import * as THREE from 'three/webgpu';
import { uniform, fract, dot, vec2, screenCoordinate, select } from 'three/tsl';
import { MeshBVH } from 'three-mesh-bvh';
import { grassBlades, surfaceArea, bladesFor, GRASS_SHADE } from './grass-field.js';
import { memoryBudget } from '../memory-budget.js';
import { debugLog } from '../log.js';
import { hideInOverridePasses } from './override-hide.js';

// memory per blade: geometry (7 vertices: position, normal, colour; 15 indices), BVH, the path tracer's packed copy
const BYTES_PER_BLADE = 1100;
const BUDGET_SHARE = 0.08;                       // share of the tab's memory budget for all blades
const BLADES_MIN = 30_000, BLADES_MAX = 400_000;
const PREVIEW_BLADES = 6000;
const FADE_MS = 700;                             // new blades fade in (old ones out at the same time, complementary)

// fade of a blade mesh (userData.grassFade): 0…1 = fading in (pixels with dither < value shown), −1…−2 = fading out
// (dither ≥ −value − 1 shown – exactly the pixels the new blades do not cover yet); dither as the model fade-in
// (material-manager.js FADE_MASK)
const fade = uniform(1).onObjectUpdate(({ object }) => object.userData.grassFade ?? 1);
const dither = fract(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))).mul(52.9829189));
const FADE = select(fade.greaterThanEqual(0), dither.lessThan(fade), dither.greaterThanEqual(fade.negate().sub(1)));

// grass parameters of a material (RindrMaterial.setGrass) or null
const grassOf = material => (material && !Array.isArray(material) ? material.userData?.grass ?? null : null);

/** Blades the whole scene may have on this device */
export function grassBudget() {
    return Math.max(BLADES_MIN, Math.min(BLADES_MAX, Math.floor(memoryBudget() * BUDGET_SHARE / BYTES_PER_BLADE)));
}

function bladeMaterial() {
    const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, vertexColors: true, roughness: 0.6, metalness: 0 });
    m.maskNode = FADE;
    return m;
}

export class GrassSystem {
    /**
     * @param {THREE.Scene} scene
     * @param {() => THREE.Object3D[]} getRoots  model roots (meshes with grass materials)
     * @param {() => number} getScale  scene size (blade height = grassHeight × it)
     */
    constructor(scene, getRoots, getScale) {
        this.getRoots = getRoots;
        this.getScale = getScale;
        this.group = new THREE.Group();
        this.group.name = 'grass';
        scene.add(this.group);
        this.items = new Map();       // source mesh → { key, mesh, old, fadeStart, job }
        this._building = new Map();   // item → { weight, done } – progress of the running builds (onProgress)
        this.materials = new Map();   // grass material → blade material
        this.areas = new WeakMap();   // geometry → { version of its positions, surface area (own units) }
        this._scan = true;
        this._seq = 0;
        this._jobs = new Map();
    }

    /**
     * Passes with an override material (contours, UV/wireframe views …) leave the blades out – millions of thin
     * triangles as outlines or wireframe; those `keep` returns draw them (Basic's clay, the light shafts' depth).
     * override-hide.js
     */
    attach(renderer, keep = () => null) {
        hideInOverridePasses(renderer, this.group, { keep });
    }

    /** materials or assignments changed – search again on the next update */
    invalidate() {
        this._scan = true;
    }

    /**
     * every frame: blades follow their meshes; colours and the path tracer's stand-in from the material. Callbacks:
     * onChange (material data), onMove (transforms/visibility – the path tracer's transforms), onGeometry (blades
     * added/replaced/removed – the path tracer's scene), onProgress(fraction | null) (blades being built – display).
     * `fading`: blades fading in/out (the raster needs frames)
     */
    update() {
        const scale = this.getScale();
        if (scale !== this._scale) { this._scale = scale; this._scan = true; }   // blade height follows the scene size
        if (this._scan) this._rescan();
        let changed = false, moved = false;
        for (const [material, blades] of this.materials) {
            if (!grassOf(material)) continue;
            if (!blades.color.equals(material.color)) {
                blades.color.copy(material.color);
                changed = true;
            }
            changed = setStandIn(material) || changed;
        }
        const now = performance.now();
        this.fading = false;
        for (const [source, item] of this.items) {
            if (item.fadeStart !== undefined) {
                const t = Math.min((now - item.fadeStart) / FADE_MS, 1);
                if (item.mesh) item.mesh.userData.grassFade = t;
                if (item.old) item.old.userData.grassFade = -1 - t;
                if (t >= 1) {
                    if (item.old) this._dispose(item.old);   // already left out of the path tracer (ptHidden)
                    item.old = null;
                    item.fadeStart = undefined;
                } else {
                    this.fading = true;
                }
            }
            const visible = isShown(source);
            if (!visible && !inScene(source)) this._scan = true;   // model removed: its blades go on the next update
            for (const mesh of [item.mesh, item.old]) {
                if (!mesh) continue;
                if (mesh.visible !== visible) { mesh.visible = visible; moved = true; }
                if (visible && !mesh.matrix.equals(source.matrixWorld)) {
                    mesh.matrix.copy(source.matrixWorld);
                    mesh.matrixWorld.copy(source.matrixWorld);
                    moved = true;
                }
            }
        }
        if (changed) this.onChange?.();
        if (moved) this.onMove?.();
    }

    _rescan() {
        this._scan = false;
        const scale = this.getScale();
        const found = [];
        for (const root of this.getRoots()) {
            root?.traverse(o => {
                if (o.isMesh && !o.isBatchedMesh && !o.userData.animationPuppet && grassOf(o.material) && o.geometry?.attributes.position) found.push(o);
            });
        }
        // the budget shared out by surface area (world units) – the blades each surface wants, at most its share
        const wanted = found.map(o => {
            const g = grassOf(o.material);
            const s = minScale(o.matrixWorld) * (o.isInstancedMesh ? instanceMinScale(o) : 1);
            const height = g.height * scale / Math.max(s, 1e-9);
            const area = this._area(o.geometry);
            return { o, g, height, blades: bladesFor(area, height, g.density) };
        });
        const total = wanted.reduce((sum, w) => sum + w.blades, 0);
        const budget = grassBudget();
        const keep = new Set();
        let removed = false;
        for (const w of wanted) {
            const maxBlades = Math.floor(total > budget ? budget * w.blades / total : w.blades) + 1;
            // key: geometry and its pose (animation.js writes the paused pose into the positions), height in 2 % steps
            // (scaling a little keeps the blades), density, dry share, budget
            const shape = `${w.o.geometry.uuid}@${w.o.geometry.attributes.position.version}`;
            const key = [shape, Math.round(Math.log(w.height) / Math.log(1.02)), w.g.density, w.g.dry, maxBlades].join('|');
            keep.add(w.o);
            const item = this.items.get(w.o) ?? { key: null, shape: null, mesh: null, old: null, fadeStart: undefined, job: 0 };
            this.items.set(w.o, item);
            const material = this._bladeMaterial(w.o.material);
            if (item.mesh) item.mesh.material = material;
            if (item.key === key) continue;
            // new pose (animation paused): the blades so far stand on the old shape – gone at once instead of fading
            // over to the new ones (the soil shade shows until the new blades fade in)
            if (item.shape && item.shape !== shape) {
                for (const mesh of [item.mesh, item.old]) if (mesh) { this._dispose(mesh); removed = true; }
                item.mesh = item.old = null;
                item.fadeStart = undefined;
            }
            item.key = key;
            item.shape = shape;
            this._build(w.o, item, { height: w.height, density: w.g.density, dry: w.g.dry, maxBlades }, Math.min(w.blades, maxBlades));
        }
        for (const [source, item] of this.items) {
            if (keep.has(source)) continue;
            item.job++;   // a running build is dropped
            this._setProgress(item, null);
            for (const mesh of [item.mesh, item.old]) if (mesh) { this._dispose(mesh); removed = true; }
            this.items.delete(source);
        }
        for (const [material, blades] of this.materials) {
            if ([...this.items.values()].some(i => i.mesh?.material === blades) || found.some(o => o.material === material)) continue;
            blades.dispose();
            this.materials.delete(material);
            if (material.userData.ptStandIn?.rindrGrass) clearStandIn(material);
        }
        if (removed) this.onGeometry?.();
    }

    async _build(source, item, params, weight) {
        const job = ++item.job;
        this._setProgress(item, 0, weight);
        const geometry = source.geometry;
        const position = geometry.attributes.position;
        const copy = attr => {
            if (!attr) return null;
            if (!attr.isInterleavedBufferAttribute && attr.itemSize === 3) return new Float32Array(attr.array);
            const out = new Float32Array(attr.count * 3);
            for (let i = 0; i < attr.count; i++) { out[i * 3] = attr.getX(i); out[i * 3 + 1] = attr.getY(i); out[i * 3 + 2] = attr.getZ(i); }
            return out;
        };
        const positions = copy(position);
        // world up in the mesh's own units (blades on slopes bend towards it)
        const up = new THREE.Vector3(0, 1, 0).transformDirection(_m.copy(source.matrixWorld).invert()).toArray();
        const index = geometry.index ? new Uint32Array(geometry.index.array) : null;
        const t0 = performance.now();
        const grass = await this._run({ positions, index, up, ...params }, [positions.buffer, index?.buffer].filter(Boolean),
            f => { if (job === item.job) this._setProgress(item, f); }).catch(err => { console.warn('Grass failed:', err); return null; });
        if (job !== item.job || this.items.get(source) !== item) return;
        this._setProgress(item, 1);
        if (!grass) return;
        debugLog(`[Grass] ${grass.blades} blades (${grass.index.length / 3} triangles) in ${(performance.now() - t0).toFixed(0)} ms`);
        // the blades so far fade out while the new ones fade in; out of the path tracer at once
        if (item.old) this._dispose(item.old);
        item.old = item.mesh;
        if (item.old) item.old.userData.ptHidden = true;
        item.mesh = null;
        item.fadeStart = performance.now();
        if (grass.blades > 0) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(grass.positions, 3));
            g.setAttribute('normal', new THREE.BufferAttribute(grass.normals, 3));
            g.setAttribute('color', new THREE.BufferAttribute(grass.colors, 3));
            g.setIndex(new THREE.BufferAttribute(grass.index, 1));
            g.boundsTree = MeshBVH.deserialize({ version: 1, roots: grass.roots, index: grass.index, indirectBuffer: null }, g, { setIndex: false });
            g.computeBoundingSphere();
            g.computeBoundingBox();
            const material = this._bladeMaterial(source.material);
            let mesh;
            if (source.isInstancedMesh) {
                mesh = new THREE.InstancedMesh(g, material, source.count);
                mesh.instanceMatrix.array.set(source.instanceMatrix.array.subarray(0, source.count * 16));
                mesh.instanceMatrix.needsUpdate = true;
                mesh.computeBoundingSphere();
            } else {
                mesh = new THREE.Mesh(g, material);
            }
            mesh.name = 'grass';
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(source.matrixWorld);
            mesh.matrixWorld.copy(source.matrixWorld);
            mesh.visible = isShown(source);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            mesh.raycast = () => {};          // picking: the object itself
            mesh.userData.grassOf = source;
            mesh.userData.grassFade = 0;
            this.group.add(mesh);
            item.mesh = mesh;
        }
        this.onGeometry?.();
    }

    // progress of one build (fraction, 1 = finished; null = dropped), all builds of a round weighted by their blades –
    // finished ones count until the last is done (the bar does not run back)
    _setProgress(item, fraction, weight) {
        if (fraction === null) this._building.delete(item);
        else this._building.set(item, { weight: weight ?? this._building.get(item)?.weight ?? 1, done: fraction });
        if ([...this._building.values()].every(b => b.done >= 1)) this._building.clear();
        if (!this._building.size) { this.onProgress?.(null); return; }
        let sum = 0, done = 0;
        for (const b of this._building.values()) { sum += b.weight; done += b.weight * b.done; }
        this.onProgress?.(done / Math.max(sum, 1e-9));
    }

    _dispose(mesh) {
        this.group.remove(mesh);
        mesh.geometry.boundsTree = null;
        mesh.geometry.dispose();
        mesh.dispatchEvent({ type: 'dispose' });   // three keeps its render objects until then (CLAUDE.md)
    }

    _area(geometry) {
        const p = geometry.attributes.position;
        let cached = this.areas.get(geometry);
        if (cached?.version !== p.version) {
            const positions = p.isInterleavedBufferAttribute || p.itemSize !== 3 ? Float32Array.from({ length: p.count * 3 }, (_, i) => p.getComponent(Math.floor(i / 3), i % 3)) : p.array;
            cached = { version: p.version, area: surfaceArea(positions, geometry.index?.array ?? null) };
            this.areas.set(geometry, cached);
        }
        return cached.area;
    }

    _bladeMaterial(material) {
        let m = this.materials.get(material);
        if (!m) {
            m = bladeMaterial();
            m.color.copy(material.color);
            this.materials.set(material, m);
        }
        return m;
    }

    _run(msg, transfer, onProgress) {
        this._worker ??= this._createWorker();
        const id = ++this._seq;
        return new Promise((resolve, reject) => {
            this._jobs.set(id, { resolve, reject, onProgress });
            this._worker.postMessage({ id, ...msg }, transfer);
        });
    }

    _createWorker() {
        const w = new Worker(new URL('./grass-worker.js', import.meta.url), { type: 'module', name: 'grass' });
        w.onmessage = ({ data }) => {
            const job = this._jobs.get(data.id);
            if (!job) return;
            if (data.progress !== undefined) { job.onProgress?.(data.progress); return; }
            this._jobs.delete(data.id);
            if (data.error) job.reject(new Error(data.error)); else job.resolve(data.grass);
        };
        w.onerror = e => {
            for (const job of this._jobs.values()) job.reject(new Error(e.message || 'grass worker failed'));
            this._jobs.clear();
        };
        return w;
    }

    /**
     * Material preview (material-thumbs.js): the sphere with blades, or null – few blades, built here (small).
     * Dispose with userData.dispose()
     */
    previewFor(material, radius) {
        const grass = grassOf(material);
        if (!grass) return null;
        const group = new THREE.Group();
        const sphere = new THREE.SphereGeometry(radius * 0.82, 64, 48);
        const base = new THREE.Mesh(sphere, material);
        const g = grassBlades({
            positions: sphere.attributes.position.array, index: sphere.index.array,
            height: radius * 0.2, density: grass.density, dry: grass.dry, maxBlades: PREVIEW_BLADES,
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
        geometry.setIndex(new THREE.BufferAttribute(g.index, 1));
        const blades = bladeMaterial();
        blades.color.copy(material.color);
        group.add(base, new THREE.Mesh(geometry, blades));
        group.userData.dispose = () => { sphere.dispose(); geometry.dispose(); blades.dispose(); };
        return group;
    }
}

// path tracer: the surface below the blades in the dark shade of the grass colour (raster: toon.js setGrass) – true
// when something changed
function setStandIn(material) {
    const pt = material.userData.ptStandIn;
    const c = material.color, k = GRASS_SHADE.ground;
    if (pt?.rindrGrass && pt.color?.r === c.r * k && pt.color.g === c.g * k && pt.color.b === c.b * k) return false;
    material.userData.ptStandIn = Object.assign(pt ?? {}, { rindrGrass: true, color: { r: c.r * k, g: c.g * k, b: c.b * k } });
    return true;
}

export function clearStandIn(material) {
    const pt = material.userData.ptStandIn;
    if (!pt?.rindrGrass) return;
    delete pt.rindrGrass;
    delete pt.color;
    if (!Object.keys(pt).length) delete material.userData.ptStandIn;
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

function inScene(o) {
    let c = o;
    while (c.parent) c = c.parent;
    return !!c.isScene;
}

function isShown(o) {
    for (let c = o; c; c = c.parent) if (!c.visible) return false;
    return inScene(o);
}

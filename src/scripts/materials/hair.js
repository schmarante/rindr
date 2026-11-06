// Hair material (hair-field.js; user, Nov. 2026: a cylinder filled with thousands of hairs, a shaving brush – "Wolle geht
// hier nicht"): every mesh with a hair material gets real fibres in the format of imported hair (curves/curve-mesh.js) –
// the path tracer traces them as cylinders with the hair scattering model, the raster draws them as shaded lines.
//  - mode fill: the mesh is only the shape – it is hidden (raster: the material's visible, toon.js setHair; path tracer:
//    userData.ptHidden), the fibres fill it along world up; mode grow: fibres stand on the surface, which stays
//  - lengths in scene units (millimetres – imports are scaled to mm), turned into the mesh's own units by its scale
//  - fibres built in hair-worker.js with their BVH; their number follows the device's memory budget (curve-mesh.js
//    curvePieceBudget, half of it for material hair), shared out over the meshes – above it fewer, thicker fibres
//  - colours root → tip in the vertex colours (the fibre material is white – the path tracer multiplies, its hair model
//    takes the absorption from the result); a new colour recolours the fibres without building them again
import * as THREE from 'three/webgpu';
import { MeshBVH } from 'three-mesh-bvh';
import { hairFibres, hairArea, fibresFor, pointsPerFibre, recolor } from './hair-field.js';
import { setupCurveMesh, curvePieceBudget } from '../curves/curve-mesh.js';
import { hideInOverridePasses } from './override-hide.js';
import { debugLog } from '../log.js';

const BUDGET_SHARE = 0.5;        // of the hair pieces the device may hold (imported hair has the rest)
const PREVIEW_FIBRES = 2500;
const hairOf = material => (material && !Array.isArray(material) ? material.userData?.hair ?? null : null);
const linear = c => [c.r, c.g, c.b];

export class HairSystem {
    /**
     * @param {THREE.Object3D} slot  where the fibre meshes go (in the scene)
     * @param {() => THREE.Object3D[]} getRoots  model roots (meshes with hair materials)
     */
    constructor(slot, getRoots) {
        this.getRoots = getRoots;
        this.group = new THREE.Group();
        this.group.name = 'hair';
        slot.add(this.group);
        this.items = new Map();       // source mesh → { key, mesh, job, root, tip, hidden }
        this.materials = new Map();   // hair material → fibre material
        this._building = new Map();
        this._scan = true;
        this._seq = 0;
        this._jobs = new Map();
    }

    /** passes with an override material (contours, UV/wireframe …) leave the fibres out – those `keep` returns draw them */
    attach(renderer, keep = () => null) {
        hideInOverridePasses(renderer, this.group, { keep, keepPlain: true });
    }

    invalidate() {
        this._scan = true;
    }

    /**
     * every frame: fibres follow their meshes, colours and roughness from the material. Callbacks: onChange (roughness –
     * the path tracer's materials), onMove (transforms, visibility), onGeometry (fibres added/replaced/removed/recoloured –
     * the path tracer's scene), onMesh(mesh) (a new fibre mesh – the viewer's hair light), onProgress(fraction | null)
     */
    update() {
        if (this._scan) this._rescan();
        let moved = false, geometry = false, changed = false;
        for (const [material, fibres] of this.materials) {
            if (typeof material.roughness === 'number' && fibres.roughness !== material.roughness) { fibres.roughness = material.roughness; changed = true; }
        }
        for (const [source, item] of this.items) {
            const visible = isShown(source);
            if (!visible && !inScene(source)) this._scan = true;
            const mesh = item.mesh;
            if (mesh) {
                if (mesh.visible !== visible) { mesh.visible = visible; moved = true; }
                if (visible && !mesh.matrix.equals(source.matrixWorld)) {
                    mesh.matrix.copy(source.matrixWorld);
                    mesh.matrixWorld.copy(source.matrixWorld);
                    moved = true;
                }
                // a new colour: the fibres recoloured (root = the material's colour, tip = its tip colour)
                const hair = hairOf(source.material);
                const root = linear(source.material.color), tip = linear(new THREE.Color(hair?.tipColor ?? source.material.color));
                if (hair && (root.some((c, k) => c !== item.root[k]) || tip.some((c, k) => c !== item.tip[k]))) {
                    item.root = root;
                    item.tip = tip;
                    const colors = mesh.geometry.getAttribute('color');
                    recolor(colors.array, item.weights, root, tip);
                    colors.needsUpdate = true;
                    geometry = true;
                }
            }
        }
        if (changed) this.onChange?.();
        if (moved) this.onMove?.();
        if (geometry) this.onGeometry?.();
    }

    _rescan() {
        this._scan = false;
        const found = [];
        for (const root of this.getRoots()) {
            root?.traverse(o => {
                if (o.isMesh && !o.isBatchedMesh && !o.isInstancedMesh && !o.userData.animationPuppet && hairOf(o.material) && o.geometry?.attributes.position) found.push(o);
            });
        }
        // the budget (pieces) shared out by the fibres each mesh wants
        const wanted = found.map(o => {
            const h = hairOf(o.material);
            const s = minScale(o.matrixWorld);
            // the fibres' direction in the mesh's own units: fill – the chosen axis of the scene (as seen) or the shape's
            // longest extent; grow – world up (the droop pulls the other way)
            const up = (h.mode === 'fill' ? fillAxis(o, h.axis) : new THREE.Vector3(0, 1, 0).transformDirection(new THREE.Matrix4().copy(o.matrixWorld).invert())).toArray();
            const thickness = h.thickness / Math.max(s, 1e-9);
            const area = hairArea(positionsOf(o.geometry), o.geometry.index?.array ?? null, h.mode, up);
            const fibres = fibresFor(area, thickness, h.density);
            return { o, h, s, up, thickness, fibres, pieces: fibres * (pointsPerFibre(h.curl) - 1) };
        });
        const total = wanted.reduce((sum, w) => sum + w.pieces, 0);
        const budget = curvePieceBudget() * BUDGET_SHARE;
        const keep = new Set();
        let removed = false;
        for (const w of wanted) {
            const share = total > budget ? budget * w.pieces / total : w.pieces;
            const maxFibres = Math.max(1, Math.floor(share / (pointsPerFibre(w.h.curl) - 1)) + 1);
            const shape = `${w.o.geometry.uuid}@${w.o.geometry.attributes.position.version}`;
            const { tipColor, ...form } = w.h;   // (colours recolour – no new fibres)
            const key = [shape, JSON.stringify(form), w.s.toPrecision(4), w.up.map(x => x.toFixed(3)).join(','), maxFibres].join('|');
            keep.add(w.o);
            const item = this.items.get(w.o) ?? { key: null, mesh: null, job: 0, root: [], tip: [], weights: null, hidden: false };
            this.items.set(w.o, item);
            // fill: the mesh is only the shape – out of the path tracer (the raster hides it through its material)
            const hide = w.h.mode === 'fill';
            if (hide !== item.hidden) { item.hidden = hide; setHidden(w.o, hide); removed = true; }
            if (item.mesh) item.mesh.material = this._fibreMaterial(w.o.material);
            if (item.key === key) continue;
            item.key = key;
            this._build(w.o, item, { ...form, thickness: w.thickness, length: w.h.length / Math.max(w.s, 1e-9), up: w.up, maxFibres }, Math.min(w.pieces, share));
        }
        for (const [source, item] of this.items) {
            if (keep.has(source)) continue;
            item.job++;
            this._setProgress(item, null);
            if (item.mesh) { this._dispose(item.mesh); removed = true; }
            if (item.hidden) setHidden(source, false);
            this.items.delete(source);
        }
        for (const [material, fibres] of this.materials) {
            if ([...this.items.values()].some(i => i.mesh?.material === fibres) || found.some(o => o.material === material)) continue;
            fibres.dispose();
            this.materials.delete(material);
        }
        if (removed) this.onGeometry?.();
    }

    async _build(source, item, params, weight) {
        const job = ++item.job;
        this._setProgress(item, 0, weight);
        const positions = new Float32Array(positionsOf(source.geometry));
        const index = source.geometry.index ? new Uint32Array(source.geometry.index.array) : null;
        const root = linear(source.material.color), tip = linear(new THREE.Color(hairOf(source.material)?.tipColor ?? source.material.color));
        const t0 = performance.now();
        const hair = await this._run({ positions, index, root, tip, ...params }, [positions.buffer, index?.buffer].filter(Boolean),
            f => { if (job === item.job) this._setProgress(item, f); }).catch(err => { console.warn('Hair failed:', err); return null; });
        if (job !== item.job || this.items.get(source) !== item) return;
        this._setProgress(item, 1);
        if (!hair) return;
        debugLog(`[Hair] ${hair.fibres} fibres (${hair.pieces} pieces) in ${(performance.now() - t0).toFixed(0)} ms`);
        if (item.mesh) this._dispose(item.mesh);
        item.mesh = null;
        item.root = root;
        item.tip = tip;
        item.weights = hair.weights;
        if (hair.pieces > 0) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(hair.positions, 3));
            g.setAttribute('normal', new THREE.BufferAttribute(hair.normals, 3));
            g.setAttribute('tangent', new THREE.BufferAttribute(hair.tangents, 4));
            g.setAttribute('uv', new THREE.BufferAttribute(hair.uvs, 2));
            g.setAttribute('color', new THREE.BufferAttribute(hair.colors, 3));
            g.setIndex(new THREE.BufferAttribute(hair.index, 1));
            g.boundsTree = MeshBVH.deserialize({ version: 1, roots: hair.roots, index: hair.index, indirectBuffer: null }, g, { setIndex: false });
            g.computeBoundingBox();
            g.boundingBox.expandByScalar(hair.maxRadius);
            g.computeBoundingSphere();
            g.curves = true;   // (step-importer.js buildBVH: no tangents rebuilt for these)
            const mesh = new THREE.Mesh(g, this._fibreMaterial(source.material));
            mesh.name = 'hair';
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(source.matrixWorld);
            mesh.matrixWorld.copy(source.matrixWorld);
            mesh.visible = isShown(source);
            mesh.userData.hairOf = source;
            setupCurveMesh(mesh);
            this.group.add(mesh);
            item.mesh = mesh;
            this.onMesh?.(mesh);
        }
        this.onGeometry?.();
    }

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
        for (const child of mesh.children) { child.geometry?.dispose(); child.material?.dispose(); child.dispatchEvent({ type: 'dispose' }); }
        mesh.geometry.boundsTree = null;
        mesh.geometry.dispose();
        mesh.dispatchEvent({ type: 'dispose' });   // three keeps its render objects until then (CLAUDE.md)
    }

    // the fibres' material: white × the vertex colours; roughness = the hair model's β_m, sheen roughness its β_n
    _fibreMaterial(material) {
        let m = this.materials.get(material);
        if (!m) {
            m = new THREE.MeshPhysicalNodeMaterial({ color: 0xffffff, vertexColors: true, metalness: 0, roughness: material.roughness ?? 0.35, sheenRoughness: 0.3, ior: 1.55 });
            m.userData.noBatch = true;
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
        const w = new Worker(new URL('./hair-worker.js', import.meta.url), { type: 'module', name: 'hair' });
        w.onmessage = ({ data }) => {
            const job = this._jobs.get(data.id);
            if (!job) return;
            if (data.progress !== undefined) { job.onProgress?.(data.progress); return; }
            this._jobs.delete(data.id);
            if (data.error) job.reject(new Error(data.error)); else job.resolve(data.hair);
        };
        w.onerror = e => {
            for (const job of this._jobs.values()) job.reject(new Error(e.message || 'hair worker failed'));
            this._jobs.clear();
            this._worker = null;
        };
        return w;
    }

    /** a material preview (material-thumbs.js): a ball of fibres (fill) or a sphere with fibres on it (grow) */
    previewFor(material, radius) {
        const hair = hairOf(material);
        if (!hair) return null;
        const group = new THREE.Group();
        const sphere = new THREE.SphereGeometry(radius * (hair.mode === 'fill' ? 0.85 : 0.7), 48, 32);
        const root = linear(material.color), tip = linear(new THREE.Color(hair.tipColor ?? material.color));
        const raycastAll = hair.mode === 'fill' ? sphereRays(radius * 0.85) : null;
        const area = hairArea(sphere.attributes.position.array, sphere.index.array, hair.mode);
        // as dense as the material says, the fibres made thicker to keep the preview light
        const thickness = Math.sqrt(area * Math.max(hair.density, 0.05) / (Math.PI * PREVIEW_FIBRES)) * 2;
        const h = hairFibres({
            positions: sphere.attributes.position.array, index: sphere.index.array, mode: hair.mode, thickness, taper: hair.taper,
            density: Math.max(hair.density, 0.05), length: radius * 0.35, spread: hair.spread, curl: hair.curl, clump: hair.clump,
            variation: hair.variation, droop: hair.droop, root, tip, maxFibres: PREVIEW_FIBRES, raycastAll,
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(h.positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(h.normals, 3));
        geometry.setAttribute('tangent', new THREE.BufferAttribute(h.tangents, 4));
        geometry.setAttribute('uv', new THREE.BufferAttribute(h.uvs, 2));
        geometry.setAttribute('color', new THREE.BufferAttribute(h.colors, 3));
        geometry.setIndex(new THREE.BufferAttribute(h.index, 1));
        geometry.computeBoundingSphere();
        const fibres = new THREE.Mesh(geometry, this._fibreMaterial(material));
        setupCurveMesh(fibres);
        if (hair.mode !== 'fill') group.add(new THREE.Mesh(sphere, material));
        group.add(fibres);
        group.userData.dispose = () => { sphere.dispose(); geometry.dispose(); for (const c of fibres.children) { c.geometry?.dispose(); c.material?.dispose(); } };
        return group;
    }
}

// the ray test of the fill mode for the preview sphere (no BVH needed): both hits of a ray through a sphere at the origin
function sphereRays(r) {
    return (o, d) => {
        const b = o[0] * d[0] + o[1] * d[1] + o[2] * d[2], c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - r * r;
        const disc = b * b - c;
        if (disc <= 0) return [];
        const s = Math.sqrt(disc);
        return [-b - s, -b + s].filter(t => t > 0);
    };
}

// fill direction (mesh units): a scene axis turned into the mesh's frame, or the longest side of its own box
const AXES = { up: [0, 1, 0], down: [0, -1, 0], x: [1, 0, 0], '-x': [-1, 0, 0], z: [0, 0, 1], '-z': [0, 0, -1] };
function fillAxis(mesh, axis) {
    if (axis === 'long') {
        mesh.geometry.computeBoundingBox();
        const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
        // measured in the scene (a mesh scaled unevenly): the box's sides through the mesh's scale
        const e = mesh.matrixWorld.elements;
        const world = [size.x * Math.hypot(e[0], e[1], e[2]), size.y * Math.hypot(e[4], e[5], e[6]), size.z * Math.hypot(e[8], e[9], e[10])];
        const k = world.indexOf(Math.max(...world));
        return new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
    }
    return new THREE.Vector3(...(AXES[axis] ?? AXES.up)).transformDirection(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
}

// the shape's own mesh: out of the path tracer while it is only the outline of fill hair
function setHidden(mesh, hidden) {
    if (hidden) mesh.userData.ptHidden = true;
    else delete mesh.userData.ptHidden;
}

function positionsOf(geometry) {
    const p = geometry.attributes.position;
    if (!p.isInterleavedBufferAttribute && p.itemSize === 3) return p.array;
    return Float32Array.from({ length: p.count * 3 }, (_, i) => p.getComponent(Math.floor(i / 3), i % 3));
}
function minScale(m) {
    const e = m.elements;
    return Math.min(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
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

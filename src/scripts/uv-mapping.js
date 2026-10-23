// UV mapping per object (properties panel "Mapping", user's wish: like a UVW modifier, but simple): a scene graph
// node (model or assembly/part group) gets { type, axis, rotation, scale }; every mesh below it without a nearer
// mapping takes it (inherited). Types:
//   standard  the UVs of the import (box projection per triangle, or the file's own UVs) – only scaled
//   box       box projection per triangle in the node's frame (continuous across its parts)
//   planar    projection along the axis
//   cylinder  around the axis; faces looking along the axis (caps) planar
//   sphere    longitude/latitude around the centre
// scale = factor on the material's tile size (material size stays the base: one material, differently sized parts).
// Cylinder and sphere: the repeats around are rounded to a whole number for the material on the mesh (its tile
// size × scale) → the seam where the circle closes matches exactly.
//
// Frame: the model space at rest (mesh matrices of the import are absolute, groups have none of their own; user moves
// and rotations – xf – are left out, so the projection stays when a part is moved later and is the same after
// reloading the scene). Axis = world axis at rest (models are imported upright). Centre and radius from the meshes
// the mapping applies to.
//
// UVs in UV_TILE units like the import (the material repeats UV_TILE / size). A vertex shared by triangles that need
// different UVs (box planes, the wrap of cylinder/sphere, caps, poles) is duplicated (projectUVs) – otherwise those
// triangles squeeze the texture into a band. The new geometry shares the BVH of the import geometry (same triangle
// order and positions); the import geometry stays (mesh.userData.uvBase) – back to it when no mapping applies.
// Speed (Oct. 2026, user: "in MAX the UV gizmo is quick – what is the difference?"): a slider follows the mouse at
// the speed of one projection with a frame drawn in between (no waiting for it to rest); no worker round trip (BVH
// shared, tangents only for normal maps); the path tracer rebuilds its scene once the slider is released (viewer.js)
// – the kernel stays compiled (astro.config.mjs rindr-stable-kernel).
import * as THREE from 'three/webgpu';
import { UV_TILE } from './step-importer.js';

export const MAPPING_TYPES = ['standard', 'box', 'planar', 'cylinder', 'sphere'];
export const MAPPING_AXES = ['y', 'x', 'z'];
export const DEFAULT_MAPPING = { type: 'standard', axis: 'y', rotation: 0, scale: 1 };
const CAP = 0.7;   // cylinder: |normal · axis| above this = cap (planar)

/** frame of a mapping: centre, axis and two perpendicular directions (rotated about the axis) */
export function mappingFrame(mapping, center) {
    const a = new THREE.Vector3(mapping.axis === 'x' ? 1 : 0, mapping.axis === 'y' || !mapping.axis ? 1 : 0, mapping.axis === 'z' ? 1 : 0);
    const ref = Math.abs(a.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    // y axis: x reference → u runs along x, v along z seen from above; z axis: x/y like a front view
    if (mapping.axis === 'z') ref.set(1, 0, 0);
    const e1 = ref.sub(a.clone().multiplyScalar(a.dot(ref))).normalize();
    const e2 = new THREE.Vector3().crossVectors(a, e1);
    const r = THREE.MathUtils.degToRad(mapping.rotation || 0);
    const c = Math.cos(r), s = Math.sin(r);
    const f1 = e1.clone().multiplyScalar(c).addScaledVector(e2, s), f2 = e2.clone().multiplyScalar(c).addScaledVector(e1, -s);
    return { center: center.clone(), axis: a, e1: f1, e2: f2 };
}

/**
 * New UVs for one geometry. g = { positions, normals, index, uvs } (geometry space); matrix (Float64 column-major,
 * geometry → model space); frame from mappingFrame; tile = material tile size in mm; radius = reference radius for
 * cylinder/sphere. Returns { positions, normals, index, uvs } with duplicated vertices where needed.
 */
export function projectUVs(g, matrix, mapping, frame, tile, radius) {
    const { positions, normals, index } = g;
    const nv = positions.length / 3;
    const nt = index ? index.length / 3 : nv / 3;
    const corner = index ? i => index[i] : i => i;
    const s = mapping.scale > 0 ? mapping.scale : 1;
    const k = 1 / (UV_TILE * s);
    const m = matrix;
    // model space positions relative to the centre, in frame coordinates (x along e1, y along e2, h along the axis)
    const F = new Float64Array(nv * 3);
    const { center: C, axis: A, e1: E1, e2: E2 } = frame;
    for (let v = 0; v < nv; v++) {
        const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
        const px = m[0] * x + m[4] * y + m[8] * z + m[12] - C.x;
        const py = m[1] * x + m[5] * y + m[9] * z + m[13] - C.y;
        const pz = m[2] * x + m[6] * y + m[10] * z + m[14] - C.z;
        F[v * 3] = px * E1.x + py * E1.y + pz * E1.z;
        F[v * 3 + 1] = px * E2.x + py * E2.y + pz * E2.z;
        F[v * 3 + 2] = px * A.x + py * A.y + pz * A.z;
    }
    // whole number of material tiles around (cylinder/sphere): u over the full circle
    const around = Math.max(1, Math.round((2 * Math.PI * radius) / (tile * s)));
    const uTurn = around * tile / UV_TILE;
    const tri = new Float64Array(6);   // u, v of the three corners
    const angle = v => Math.atan2(F[v * 3 + 1], F[v * 3]) / (2 * Math.PI) + 0.5;
    const project = t => {
        const a = corner(t * 3), b = corner(t * 3 + 1), c = corner(t * 3 + 2);
        // face normal in frame coordinates
        const ux = F[b * 3] - F[a * 3], uy = F[b * 3 + 1] - F[a * 3 + 1], uz = F[b * 3 + 2] - F[a * 3 + 2];
        const vx = F[c * 3] - F[a * 3], vy = F[c * 3 + 1] - F[a * 3 + 1], vz = F[c * 3 + 2] - F[a * 3 + 2];
        let nx = Math.abs(uy * vz - uz * vy), ny = Math.abs(uz * vx - ux * vz), nz = Math.abs(ux * vy - uy * vx);
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        const ids = [a, b, c];
        const type = mapping.type;
        if (type === 'planar' || (type === 'cylinder' && nz > CAP)) {
            for (let i = 0; i < 3; i++) { tri[i * 2] = F[ids[i] * 3] * k; tri[i * 2 + 1] = F[ids[i] * 3 + 1] * k; }
        } else if (type === 'box') {
            // dominant frame axis: e1 → (y, h), e2 → (x, h), axis → (x, y)
            const p = nx >= ny && nx >= nz ? [1, 2] : ny >= nz ? [0, 2] : [0, 1];
            for (let i = 0; i < 3; i++) { tri[i * 2] = F[ids[i] * 3 + p[0]] * k; tri[i * 2 + 1] = F[ids[i] * 3 + p[1]] * k; }
        } else {
            // cylinder side / sphere: angle around the axis; corners on the axis (poles) take the others' mean
            const f = ids.map(v => (Math.hypot(F[v * 3], F[v * 3 + 1]) < 1e-9 * (radius || 1) ? NaN : angle(v)));
            const known = () => f.filter(x => !Number.isNaN(x));
            // the wrap: a triangle spanning more than half a turn lies across the seam → lift the small ones
            const k0 = known();
            if (k0.length && Math.max(...k0) - Math.min(...k0) > 0.5) for (let i = 0; i < 3; i++) if (f[i] < 0.5) f[i] += 1;
            const k1 = known();
            const mean = k1.length ? k1.reduce((x, y) => x + y, 0) / k1.length : 0;
            for (let i = 0; i < 3; i++) {
                const v = ids[i];
                tri[i * 2] = (Number.isNaN(f[i]) ? mean : f[i]) * uTurn;
                if (type === 'cylinder') tri[i * 2 + 1] = F[v * 3 + 2] * k;
                else {
                    const r = Math.hypot(F[v * 3], F[v * 3 + 1], F[v * 3 + 2]);
                    const theta = r > 0 ? Math.acos(Math.max(-1, Math.min(1, F[v * 3 + 2] / r))) : 0;
                    tri[i * 2 + 1] = (Math.PI - theta) * radius * k;   // from the bottom pole upwards
                }
            }
        }
    };
    // per corner: the vertex with exactly these UVs (first variant in place, further ones as copies)
    const U = new Float64Array(nv).fill(NaN), V = new Float64Array(nv);
    const extra = new Map();   // vertex → [[u, v, id], …]
    const copies = [];         // source vertex of each copy
    const out = [];            // uv of each copy
    const slot = new Uint32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
        project(t);
        for (let i = 0; i < 3; i++) {
            const v = corner(t * 3 + i), u = tri[i * 2], w = tri[i * 2 + 1];
            if (Number.isNaN(U[v])) { U[v] = u; V[v] = w; slot[t * 3 + i] = v; continue; }
            if (U[v] === u && V[v] === w) { slot[t * 3 + i] = v; continue; }
            let list = extra.get(v);
            const hit = list?.find(e => e[0] === u && e[1] === w);
            if (hit) { slot[t * 3 + i] = hit[2]; continue; }
            const id = nv + copies.length;
            copies.push(v);
            out.push(u, w);
            (list ??= []).push([u, w, id]);
            extra.set(v, list);
            slot[t * 3 + i] = id;
        }
    }
    const total = nv + copies.length;
    const P = new Float32Array(total * 3), N = new Float32Array(total * 3), UV = new Float32Array(total * 2);
    P.set(positions);
    N.set(normals);
    for (let v = 0; v < nv; v++) { UV[v * 2] = Number.isNaN(U[v]) ? 0 : U[v]; UV[v * 2 + 1] = V[v]; }
    copies.forEach((v, j) => {
        const o = nv + j;
        P[o * 3] = positions[v * 3]; P[o * 3 + 1] = positions[v * 3 + 1]; P[o * 3 + 2] = positions[v * 3 + 2];
        N[o * 3] = normals[v * 3]; N[o * 3 + 1] = normals[v * 3 + 1]; N[o * 3 + 2] = normals[v * 3 + 2];
        UV[o * 2] = out[j * 2]; UV[o * 2 + 1] = out[j * 2 + 1];
    });
    return { positions: P, normals: N, index: slot, uvs: UV };
}

/** rest matrix of a mesh in model space (without the user's moves – see the frame above) */
const restMatrix = mesh => mesh.userData.xf?.rest ?? mesh.matrix;

export class UvMapper {
    /**
     * @param {{ tileOf: (material) => number, build: (geometries) => Promise<void>, makeGeometry: (g) => THREE.BufferGeometry,
     *   onApplied: (meshes) => void }} hooks
     *   tileOf = material tile size in mm; build = BVH + tangents in the workers (fills bvh/tangents, may reorder);
     *   makeGeometry = viewer's geometry from those arrays; onApplied = geometries swapped (path tracer, edges …)
     */
    constructor(hooks) {
        this.hooks = hooks;
        this._queue = Promise.resolve();
        this._dirty = new Set();   // nodes waiting for a projection
        this._pumping = false;
        this._tiled = new Set();   // meshes with cylinder/sphere – their repeats depend on the material
    }

    /** own mapping of a node (null = none) */
    get(object) {
        return object?.userData.mapping || null;
    }

    /** mapping that applies to object (its own or the nearest ancestor's) and the node it comes from */
    effective(object) {
        for (let o = object; o; o = o.parent) {
            if (o.userData.mapping) return { mapping: o.userData.mapping, owner: o };
            if (o.userData.modelRoot || o.isScene) break;
        }
        return { mapping: null, owner: null };
    }

    /** meshes of the model the mapping can change (no splats, no skinned/morphed meshes – their UVs stay) */
    static meshesBelow(object) {
        const list = [];
        object.traverse(o => {
            if (o.isMesh && !o.isSplat && o.userData.key !== undefined && !o.isSkinnedMesh && !o.morphTargetInfluences) list.push(o);
        });
        return list;
    }

    /**
     * Set or remove (null) the mapping of a node and re-project its meshes. The change passes down: own mappings of
     * nodes below are replaced (user's wish – changing the parent overrides the parts changed before; undo brings
     * them back through snapshot/restore)
     */
    set(object, mapping) {
        object.traverse(o => { if (o !== object) delete o.userData.mapping; });
        if (mapping) object.userData.mapping = { ...DEFAULT_MAPPING, ...mapping };
        else delete object.userData.mapping;
        this.schedule(object);
    }

    /** number of nodes below object with an own mapping (a change of object replaces them) */
    ownBelow(object) {
        let n = 0;
        object.traverse(o => { if (o !== object && o.userData.mapping) n++; });
        return n;
    }

    /** mappings of object and the nodes below (child index paths) – for undo */
    snapshot(object) {
        const list = [];
        const walk = (o, path) => {
            if (o.userData.mapping) list.push([path, { ...o.userData.mapping }]);
            o.children.forEach((c, i) => walk(c, [...path, i]));
        };
        walk(object, []);
        return list;
    }

    /** put a snapshot back (mappings not in it are removed) and re-project */
    restore(object, list) {
        object.traverse(o => { delete o.userData.mapping; });
        for (const [path, mapping] of list) {
            let o = object;
            for (const i of path) o = o?.children[i];
            if (o) o.userData.mapping = { ...DEFAULT_MAPPING, ...mapping };
        }
        this.schedule(object);
    }

    /**
     * Re-project now, or – while a projection runs – once it is done, with the newest values. Live while a slider is
     * dragged, like every other slider (user's wish: the same everywhere); a frame is drawn between two projections,
     * so slider and view keep moving (back to back they made the drag stutter)
     */
    schedule(object) {
        this._dirty.add(object);
        if (this._pumping) return;
        this._pumping = true;
        const pump = async () => {
            while (this._dirty.size) {
                const objects = [...this._dirty];
                this._dirty.clear();
                for (const o of objects) await this.apply(o);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            }
            this._pumping = false;
        };
        pump();
    }

    /** re-project all meshes below object (one after another – one worker run at a time) */
    apply(object) {
        const run = this._queue.then(() => this._apply(UvMapper.meshesBelow(object)));
        this._queue = run.catch(err => console.error('[UV mapping]', err));
        return run;
    }

    /** meshes whose cylinder/sphere repeats depend on the material: again when material or tile size changed */
    refreshMaterials() {
        const stale = [];
        for (const mesh of this._tiled) {
            if (!mesh.parent) { this._tiled.delete(mesh); continue; }   // model removed
            if (mesh.userData.uvMapTile !== this.hooks.tileOf(mesh.material)) stale.push(mesh);
        }
        if (!stale.length) return;
        const run = this._queue.then(() => this._apply(stale));
        this._queue = run.catch(err => console.error('[UV mapping]', err));
    }

    /** base geometry changed (re-tessellated part): forget the old base, map again */
    rebased(meshes) {
        const mapped = meshes.filter(m => this.effective(m).mapping);
        for (const m of meshes) { delete m.userData.uvBase; delete m.userData.uvMapTile; this._tiled.delete(m); }
        if (!mapped.length) return;
        const run = this._queue.then(() => this._apply(mapped));
        this._queue = run.catch(err => console.error('[UV mapping]', err));
    }

    async _apply(meshes) {
        if (!meshes.length) return;
        // group by the owner of the mapping that applies – the frame (centre, radius) comes from all of its meshes
        const groups = new Map();
        const restore = [];
        for (const mesh of meshes) {
            const { mapping, owner } = this.effective(mesh);
            const plain = !mapping || (mapping.type === 'standard' && (mapping.scale ?? 1) === 1);
            if (plain) { restore.push(mesh); continue; }
            if (!groups.has(owner)) groups.set(owner, { mapping, meshes: [] });
            groups.get(owner).meshes.push(mesh);
        }
        const jobs = [];
        for (const [owner, { mapping }] of groups) {
            const all = UvMapper.meshesBelow(owner).filter(m => this.effective(m).owner === owner);
            const frame = mapping.type === 'standard' ? null : this._frame(all, mapping);
            for (const mesh of groups.get(owner).meshes) jobs.push({ mesh, mapping, frame });
        }
        const geometries = [];
        for (const job of jobs) {
            const { mesh, mapping, frame } = job;
            const base = mesh.userData.uvBase ?? mesh.geometry;
            const g = arraysOf(base);
            if (!g) continue;
            const tile = this.hooks.tileOf(mesh.material);
            if (mapping.type === 'standard') {
                const s = 1 / (mapping.scale > 0 ? mapping.scale : 1);
                job.g = { positions: g.positions.slice(), normals: g.normals.slice(), index: g.index.slice(), uvs: g.uvs.map(x => x * s) };
            } else {
                job.g = projectUVs(g, restMatrix(mesh).elements, mapping, frame.frame, tile, frame.radius);
            }
            job.tile = tile;
            job.base = base;
            geometries.push(job.g);
        }
        // BVH: the triangles keep the order of the import geometry (whose index the BVH sorted) and their positions –
        // its BVH fits the new geometry as it is (vertex copies only change which vertex a corner names). Tangents
        // only where a normal map needs them. Without a BVH to share: the import workers (BVH + tangents).
        const slow = [];
        for (const job of jobs) {
            if (!job.g) continue;
            const bvh = job.base.boundsTree;
            if (bvh && !bvh._indirectBuffer) job.g.bvh = bvh._roots;
            else slow.push(job.g);
        }
        if (slow.length) await this.hooks.build(slow);
        const changed = [];
        for (const job of jobs) {
            if (!job.g) continue;
            const { mesh } = job;
            const old = mesh.geometry;
            mesh.userData.uvBase = job.base;
            mesh.geometry = this.hooks.makeGeometry(job.g);
            if (!job.g.tangents && mesh.material?.normalMap) mesh.geometry.computeTangents();
            const tiled = ['cylinder', 'sphere'].includes(job.mapping.type);
            mesh.userData.uvMapTile = tiled ? job.tile : -1;
            if (tiled) this._tiled.add(mesh); else this._tiled.delete(mesh);
            if (old !== job.base) disposeGeometry(old);
            changed.push(mesh);
        }
        for (const mesh of restore) {
            const base = mesh.userData.uvBase;
            delete mesh.userData.uvMapTile;
            this._tiled.delete(mesh);
            if (!base || mesh.geometry === base) continue;
            disposeGeometry(mesh.geometry);
            mesh.geometry = base;
            delete mesh.userData.uvBase;
            changed.push(mesh);
        }
        if (changed.length) this.hooks.onApplied(changed);
    }

    /** centre (bounding box of the meshes, model space) and reference radius around the axis / centre */
    _frame(meshes, mapping) {
        const box = new THREE.Box3(), p = new THREE.Vector3();
        const each = fn => {
            for (const mesh of meshes) {
                const g = mesh.userData.uvBase ?? mesh.geometry, pos = g.getAttribute('position'), m = restMatrix(mesh);
                const step = Math.max(1, Math.floor(pos.count / 20000));   // large meshes: a sample is enough
                for (let i = 0; i < pos.count; i += step) fn(p.fromBufferAttribute(pos, i).applyMatrix4(m));
            }
        };
        each(q => box.expandByPoint(q));
        const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
        const frame = mappingFrame(mapping, center);
        let sum = 0, n = 0;
        const d = new THREE.Vector3();
        each(q => {
            d.subVectors(q, center);
            sum += mapping.type === 'sphere' ? d.length() : Math.hypot(d.dot(frame.e1), d.dot(frame.e2));
            n++;
        });
        return { frame, radius: n ? sum / n : 1 };
    }
}

function arraysOf(geometry) {
    const pos = geometry.getAttribute('position'), nor = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
    if (!pos || !nor || pos.isInterleavedBufferAttribute) return null;
    const index = geometry.index ? geometry.index.array : Uint32Array.from({ length: pos.count }, (_, i) => i);
    return { positions: pos.array, normals: nor.array, index, uvs: uv ? uv.array : new Float32Array(pos.count * 2) };
}

function disposeGeometry(geometry) {
    geometry.boundsTree = null;
    geometry.dispose();
}

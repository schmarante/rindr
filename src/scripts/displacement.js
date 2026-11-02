// Displacement (user: "Displacement (Höhen-Maps)"): a material whose relief (height input of the node graph – also
// imported bump/height maps) has a displacement height (output node: displacement mm, midlevel) moves the surface of
// its meshes – real geometry, so raster and path tracer show the same silhouette, shadows and contact.
// Per mesh: its geometry (after the UV mapping, uv-mapping.js) is subdivided uniformly and moved along the normals in a
// worker (displace.js); the result replaces mesh.geometry, the original stays in mesh.userData.dispBase (back to it
// when the displacement is switched off or the material changes). Meshes with the same original geometry, material
// values and scale share the result (instances).
// Subdivision: as many triangles as the surface needs at the height map's resolution (two texels per edge), at most
// MAX_TRIANGLES per mesh and IMPORT.triangleBudget for all displaced meshes together (shared out by that need);
// uniform per mesh (every level × 4 – no cracks between finer and coarser parts of one mesh). Height in mm → geometry units through the mesh's world scale.
import * as THREE from 'three/webgpu';
import { IMPORT } from './config.js';
import { debugLog } from './log.js';

const MAX_TRIANGLES = 2e6;      // per displaced geometry
const MAX_LEVELS = 10;   // a large flat part of two triangles needs many (the triangle budget limits them)
const CREASE = Math.cos(50 * Math.PI / 180);   // normals: faces beyond this angle stay apart (hard edges)

export class Displacer {
    /**
     * @param {object} hooks { meshes: () => Mesh[] (the scene's), makeGeometry(g) → BufferGeometry, build(geometries)
     *   → Promise (BVH + tangents in the import workers), onApplied(meshes) }
     */
    constructor(hooks) {
        this.hooks = hooks;
        this._shared = new Map();   // key → { geometry, users }
        this._running = null;
        this._again = false;
        this._worker = null;
        this._jobs = new Map();
        this._seq = 0;
    }

    /** the geometry before displacement (UV mapping and others work on it) */
    baseOf(mesh) {
        return mesh.userData.dispBase ?? mesh.geometry;
    }

    /** back to the original geometry at once (before another system replaces it) – refresh() moves it again */
    release(mesh) {
        const base = mesh.userData.dispBase;
        if (!base) return;
        this._drop(mesh);
        mesh.geometry = base;
        delete mesh.userData.dispBase;
        delete mesh.userData.dispKey;
    }

    /** check all meshes (after material, mapping or model changes) – runs after the current pass if one is busy */
    refresh() {
        if (this._running) { this._again = true; return this._running; }
        this._running = this._run().catch(err => console.warn('[Displacement]', err?.message || err)).finally(() => {
            this._running = null;
            if (this._again) { this._again = false; this.refresh(); }
        });
        return this._running;
    }

    async _run() {
        const changed = new Set();
        const wanted = [];   // { mesh, d, base, scale, key }
        for (const mesh of this.hooks.meshes()) {
            if (!mesh.isMesh || mesh.isBatchedMesh) continue;
            // replaced by someone else meanwhile (re-tessellated part …): the new geometry is the original now
            if (mesh.userData.dispBase && mesh.geometry !== this._shared.get(mesh.userData.dispKey)?.geometry) {
                delete mesh.userData.dispBase;
                delete mesh.userData.dispKey;
            }
            const material = Array.isArray(mesh.material) ? null : mesh.material;
            const d = material?.userData?.displacement;
            const base = this.baseOf(mesh);
            if (!d || !(d.amount > 0) || !base.getAttribute('uv') || !base.getAttribute('normal') || !base.index) {
                if (mesh.userData.dispBase) { this.release(mesh); changed.add(mesh); }
                continue;
            }
            mesh.updateWorldMatrix(true, false);
            const scale = mesh.matrixWorld.getMaxScaleOnAxis() || 1;
            const key = `${d.sig}|${d.amount}|${d.mid}|${base.uuid}|${scale.toPrecision(6)}`;
            if (mesh.userData.dispKey === key && mesh.geometry !== base) continue;
            wanted.push({ mesh, d, base, scale, key });
        }
        // one job per key (instances share it); the budget shared out by triangle count
        const jobs = new Map();
        for (const w of wanted) if (!jobs.has(w.key)) jobs.set(w.key, w);
        // triangles each needs for its area at the height map's resolution (two texels per edge); all together within
        // the budget (shared out by that need – a large plane of two triangles needs as many as a fine curved part)
        const budget = IMPORT.triangleBudget ?? 1e7;
        let need = 0;
        for (const j of jobs.values()) {
            const texel = (j.d.tile ?? 100) / j.d.n * 2;
            j.need = Math.min(MAX_TRIANGLES, Math.max(j.base.index.count / 3, 2 * surfaceArea(j.base, j.scale) / (texel * texel)));
            need += j.need;
        }
        const share = need > budget ? budget / need : 1;
        for (const [key, j] of jobs) {
            const shared = this._shared.get(key);
            let geometry = shared?.geometry;
            if (!geometry) {
                const tris = j.base.index.count / 3;
                const cap = Math.max(tris, j.need * share);
                const levels = this._levels(tris, cap);
                const g = await this._displace(j.base, j.d, j.scale, levels);
                if (!g) continue;
                await this.hooks.build([g]);
                geometry = this.hooks.makeGeometry(g);
                this._shared.set(key, { geometry, users: 0 });
                debugLog(`[Displacement] ${j.mesh.name || '?'}: ${tris} → ${g.index.length / 3} triangles (${levels} levels)`);
            }
            for (const w of wanted) {
                if (w.key !== key) continue;
                // the material or the original may have changed meanwhile – only the current state counts
                if (w.mesh.material?.userData?.displacement !== w.d && w.mesh.material?.userData?.displacement?.sig !== w.d.sig) continue;
                this._drop(w.mesh);
                w.mesh.userData.dispBase = w.base;
                w.mesh.userData.dispKey = key;
                w.mesh.geometry = geometry;
                if (w.mesh.material?.normalMap && !geometry.getAttribute('tangent')) geometry.computeTangents();
                this._shared.get(key).users++;
                changed.add(w.mesh);
            }
        }
        if (changed.size) this.hooks.onApplied([...changed]);
    }

    // subdivision levels: every level × 4 triangles, as many as fit the triangles it may have
    _levels(tris, cap) {
        let levels = 0;
        while (levels < MAX_LEVELS && tris * 4 ** (levels + 1) <= cap * 1.5) levels++;
        return levels;
    }

    _displace(base, d, scale, levels) {
        const attr = name => base.getAttribute(name)?.array;
        const job = {
            positions: Float32Array.from(attr('position')), normals: Float32Array.from(attr('normal')), uvs: Float32Array.from(attr('uv')),
            index: Uint32Array.from(base.index.array), colors: attr('color') && base.getAttribute('color').itemSize === 3 ? Float32Array.from(attr('color')) : null,
            levels, height: { data: d.data, n: d.n, repeat: d.repeat, offset: d.offset, clamp: d.clamp },
            amount: d.amount / scale, mid: d.mid, crease: CREASE,
        };
        this._worker ??= new Worker(new URL('./displace-worker.js', import.meta.url), { type: 'module' });
        if (!this._worker.onmessage) {
            this._worker.onmessage = e => {
                const p = this._jobs.get(e.data.id);
                this._jobs.delete(e.data.id);
                if (e.data.error) p?.reject(new Error(e.data.error)); else p?.resolve(e.data.result);
            };
        }
        const id = ++this._seq;
        const transfer = [job.positions.buffer, job.normals.buffer, job.uvs.buffer, job.index.buffer];
        if (job.colors) transfer.push(job.colors.buffer);
        return new Promise((resolve, reject) => {
            this._jobs.set(id, { resolve, reject });
            this._worker.postMessage({ id, job }, transfer);
        });
    }

    // a mesh leaves its displaced geometry: free it when nobody uses it any more
    _drop(mesh) {
        const key = mesh.userData.dispKey;
        const shared = key && this._shared.get(key);
        if (!shared || mesh.geometry !== shared.geometry) return;
        if (--shared.users <= 0) {
            this._shared.delete(key);
            shared.geometry.dispose();
        }
    }

    dispose() {
        this._worker?.terminate();
        this._worker = null;
        for (const { geometry } of this._shared.values()) geometry.dispose();
        this._shared.clear();
    }
}

/** surface area of a geometry in mm² (positions × scale) */
function surfaceArea(geometry, scale) {
    const P = geometry.getAttribute('position').array, I = geometry.index.array;
    let area = 0;
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    return area * scale * scale;
}
